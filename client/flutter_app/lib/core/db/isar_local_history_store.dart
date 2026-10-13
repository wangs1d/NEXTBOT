import "dart:convert";
import "dart:io";

import "package:crypto/crypto.dart";
import "package:flutter/foundation.dart" show debugPrint, kIsWeb;
import "package:path_provider/path_provider.dart";

import "../models/agent_relay_models.dart";
import "../models/chat_models.dart";
import "../models/schedule_models.dart";
import "../utils/assistant_text_sanitizer.dart";
import "local_history_store.dart";

class IsarLocalHistoryStore implements LocalHistoryStore {
  IsarLocalHistoryStore({required String userPin}) : _userPin = userPin;

  static const String _assistantTimestampMigrationPreferenceKey =
      "assistantTimestampFramesSanitizedV1";

  String _userPin;

  /// 当前本地加密口令（与聊天、入站中继 XOR 密钥同源）。
  String get userPin => _userPin;
  final List<ChatSession> _sessions = <ChatSession>[];
  final Map<String, List<ChatMessage>> _messages = <String, List<ChatMessage>>{};
  /// 入站中继：按本机 `sessionId`（收件人）分桶；正文与主题经与聊天相同的 XOR 混淆后写入。
  final Map<String, List<Map<String, dynamic>>> _relayInbound =
      <String, List<Map<String, dynamic>>>{};
  File? _storageFile;
  /// 扩展偏好（明文；不走聊天 XOR）。
  Map<String, dynamic> _preferences = <String, dynamic>{};
  /// 日程事项（明文 JSON；按条存储）。
  final List<Map<String, dynamic>> _scheduleEvents =
      <Map<String, dynamic>>[];

  /// 写盘串行链。_flush 是「全量重写整个 JSON」，而 saveMessage 是
  /// fire-and-forget：分泡定稿一帧内多条 _persist 并发时，两次
  /// writeAsString 会在同一文件上交错截断 → 半截 JSON → 下次启动命中
  /// 「JSON parse error」→ 整库被判损坏重建为空（外在表现就是
  /// 「手机端对话历史没保存」）。这里把写盘排成链，且 JSON 快照在链内
  /// 依次取（先取快照再排队会丢最后一次状态的时序保证）。
  Future<void>? _flushQueue;

  /// 解析一个可写的存储文件位置。
  ///
  /// 优先 Documents；若该目录被 OneDrive 重定向 / 权限保护而不可写，
  /// 则回退到应用支持目录（AppData，保证可写），再不行回退系统临时目录。
  /// 全部失败返回 null（调用方降级为内存存储）。
  static Future<File?> _resolveWritableStorageFile() async {
    final List<Future<Directory> Function()> providers =
        <Future<Directory> Function()>[
      getApplicationDocumentsDirectory,
      getApplicationSupportDirectory,
    ];
    for (final Future<Directory> Function() provider in providers) {
      try {
        final Directory dir = await provider();
        final File? writable = await _probeWritableFile(dir);
        if (writable != null) return writable;
        debugPrint('[IsarLocalHistoryStore] 目录不可写，尝试备用存储目录: ${dir.path}');
      } catch (_) {
        // 该 provider 失败，尝试下一个
      }
    }
    // 最后兜底系统临时目录
    try {
      return await _probeWritableFile(Directory.systemTemp);
    } catch (_) {
      return null;
    }
  }

  /// 在 [dir] 下验证可写性（写入并删除探针文件），可写则返回真实存储文件。
  static Future<File?> _probeWritableFile(Directory dir) async {
    final File probe = File("${dir.path}${Platform.pathSeparator}.pai_write_probe");
    await probe.writeAsString("probe");
    await probe.delete();
    return File("${dir.path}${Platform.pathSeparator}private_ai_agent_store.json");
  }

  /// 并发安全的初始化：共享同一个 in-flight future。旧的
  /// 「if (_storageFile != null) return」闸存在竞态窗口——首个 init 已解析出
  /// 存储文件但 readAsString 仍未完成时，并发调用会 early-return 拿到
  /// 未装载的空偏好表（首启向导完成标记读不回的真因）。
  Future<void>? _initPromise;

  @override
  Future<void> init() {
    return _initPromise ??= _doInit();
  }

  Future<void> _doInit() async {

    // Web 平台不支持文件系统，使用内存存储
    if (kIsWeb) {
      debugPrint('[IsarLocalHistoryStore] Web 平台 detected, using memory storage');
      _storageFile = null; // Web 平台不使用文件
      // 初始化空数据结构
      _preferences = <String, dynamic>{};
      return;
    }

    // 非 Web 平台使用文件系统（带容错处理）
    _storageFile = await _resolveWritableStorageFile();
    if (_storageFile == null) {
      debugPrint('[IsarLocalHistoryStore] 未找到可写存储目录，使用内存存储');
      return;
    }

    try {
      if (!await _storageFile!.exists()) {
        await _storageFile!.writeAsString(
          jsonEncode(<String, dynamic>{
            "sessions": <Map<String, dynamic>>[],
            "messages": <String, List<Map<String, dynamic>>>{},
            "relayInbound": <String, List<Map<String, dynamic>>>{},
            "preferences": <String, dynamic>{},
            "scheduleEvents": <Map<String, dynamic>>[],
          }),
        );
        return;
      }
      final String raw = await _storageFile!.readAsString();
      if (raw.trim().isEmpty) return;

      // 安全解析 JSON（处理损坏的存储文件）
      final Map<String, dynamic> decoded;
      try {
        decoded = jsonDecode(raw) as Map<String, dynamic>;
      } catch (e) {
        debugPrint('[IsarLocalHistoryStore] JSON parse error: $e');
        debugPrint('[IsarLocalHistoryStore] Backing up corrupted file...');
        try {
          final backupFile = File("${_storageFile!.path}.backup.${DateTime.now().millisecondsSinceEpoch}");
          await _storageFile!.copy(backupFile.path);
          debugPrint('[IsarLocalHistoryStore] Backup created: ${backupFile.path}');
        } catch (backupError) {
          debugPrint('[IsarLocalHistoryStore] Backup failed: $backupError');
        }
        // 重建空的存储文件
        await _storageFile!.writeAsString(
          jsonEncode(<String, dynamic>{
            "sessions": <Map<String, dynamic>>[],
            "messages": <String, List<Map<String, dynamic>>>{},
            "relayInbound": <String, List<Map<String, dynamic>>>{},
            "preferences": <String, dynamic>{},
            "scheduleEvents": <Map<String, dynamic>>[],
          }),
        );
        return;
      }

      // 解析 sessions
      final List<dynamic> sessionRaw = decoded["sessions"] as List<dynamic>? ?? <dynamic>[];
      _sessions
        ..clear()
        ..addAll(
          sessionRaw.map((dynamic s) {
            final Map<String, dynamic> map = s as Map<String, dynamic>;
            return ChatSession(
              sessionId: map["sessionId"] as String,
              title: map["title"] as String,
              createdAt: DateTime.parse(map["createdAt"] as String),
            );
          }),
        );

      // 解析 messages
      final Map<String, dynamic> messagesRaw =
          decoded["messages"] as Map<String, dynamic>? ?? <String, dynamic>{};
      _messages.clear();
      for (final MapEntry<String, dynamic> entry in messagesRaw.entries) {
        final List<dynamic> list = entry.value as List<dynamic>;
        _messages[entry.key] = list.map((dynamic m) {
          final Map<String, dynamic> map = m as Map<String, dynamic>;
          return ChatMessage(
            messageId: map["messageId"] as String,
            sessionId: map["sessionId"] as String,
            role: map["role"] as String,
            text: map["text"] as String,
            timestamp: DateTime.parse(map["timestamp"] as String),
            attachmentImageCount: (map["attachmentImageCount"] as num?)?.toInt() ?? 0,
            playUrl: map["playUrl"] as String?,
            pendingDelivery: map["pendingDelivery"] == true,
            mediaCards: _decryptMediaCards(map["mediaCards"]),
            summaryCard: _decryptSummaryCard(map["summaryCard"]),
            renderBlocks: _decryptRenderBlocks(map["renderBlocks"]),
          );
        }).toList();
      }

      // 解析 relay inbound
      final Map<String, dynamic> relayRaw =
          decoded["relayInbound"] as Map<String, dynamic>? ?? <String, dynamic>{};
      _relayInbound.clear();
      for (final MapEntry<String, dynamic> entry in relayRaw.entries) {
        final List<dynamic> list = entry.value as List<dynamic>? ?? <dynamic>[];
        _relayInbound[entry.key] = list
            .map((dynamic m) => Map<String, dynamic>.from(m as Map))
            .toList();
      }

      // 解析 preferences
      _preferences = Map<String, dynamic>.from(
        decoded["preferences"] as Map<String, dynamic>? ?? <String, dynamic>{},
      );

      // 解析 schedule events
      final List<dynamic> schedRaw =
          decoded["scheduleEvents"] as List<dynamic>? ?? <dynamic>[];
      _scheduleEvents
        ..clear()
        ..addAll(
          schedRaw.map(
            (dynamic e) => Map<String, dynamic>.from(e as Map),
          ),
        );
    } catch (e) {
      debugPrint('[IsarLocalHistoryStore] Init error: $e');
      // 不抛出异常，让应用继续运行
    }
  }

  /// 某自然日内的日程（按开始时间升序）。
  Future<List<ScheduleEvent>> listScheduleEventsForDay(DateTime day) async {
    await init();
    final DateTime start =
        DateTime(day.year, day.month, day.day);
    final DateTime end = start.add(const Duration(days: 1));
    final List<ScheduleEvent> out = _scheduleEvents
        .map(_scheduleEventFromMap)
        .where(
          (ScheduleEvent e) =>
              !e.startAt.isBefore(start) && e.startAt.isBefore(end),
        )
        .toList();
    out.sort(
      (ScheduleEvent a, ScheduleEvent b) => a.startAt.compareTo(b.startAt),
    );
    return out;
  }

  /// 左闭右开区间 [startInclusive, endExclusive) 内的日程，按开始时间升序。
  Future<List<ScheduleEvent>> listScheduleEventsInRange(
    DateTime startInclusive,
    DateTime endExclusive,
  ) async {
    await init();
    final List<ScheduleEvent> out = _scheduleEvents
        .map(_scheduleEventFromMap)
        .where(
          (ScheduleEvent e) =>
              !e.startAt.isBefore(startInclusive) &&
              e.startAt.isBefore(endExclusive),
        )
        .toList();
    out.sort(
      (ScheduleEvent a, ScheduleEvent b) => a.startAt.compareTo(b.startAt),
    );
    return out;
  }

  /// 全部本地日程（按开始时间升序），供「事项管理」列表使用。
  Future<List<ScheduleEvent>> listAllScheduleEvents() async {
    await init();
    final List<ScheduleEvent> out =
        _scheduleEvents.map(_scheduleEventFromMap).toList();
    out.sort(
      (ScheduleEvent a, ScheduleEvent b) => a.startAt.compareTo(b.startAt),
    );
    return out;
  }

  Future<void> saveScheduleEvent(ScheduleEvent event) async {
    await init();
    final Map<String, dynamic> map = _scheduleEventToMap(event);
    final int idx =
        _scheduleEvents.indexWhere((Map<String, dynamic> m) => m["id"] == event.id);
    if (idx >= 0) {
      _scheduleEvents[idx] = map;
    } else {
      _scheduleEvents.add(map);
    }
    await _flush();
  }

  Future<void> deleteScheduleEvent(String id) async {
    await init();
    _scheduleEvents.removeWhere((Map<String, dynamic> m) => m["id"] == id);
    await _flush();
  }

  /// 删除同一服务端任务展开出的全部本地事项（id 为 `taskId` 或 `taskId@…`）。
  Future<void> deleteScheduleEventsForTask(String taskId) async {
    await init();
    _scheduleEvents.removeWhere((Map<String, dynamic> m) {
      final String id = m["id"] as String;
      return id == taskId || id.startsWith("$taskId@");
    });
    await _flush();
  }

  /// 清理本地「裸 taskId」格式的孤儿日程事项。
  /// 历史原因：`schedule.tasks_changed` WS 块曾直接用 taskId 作为 id
  /// 写入 `ScheduleEvent`，与 `tool.result` → `upsertLocalScheduleFromToolResult`
  /// 写入的 `taskId@<iso>` occurrence 事件并存，导致日程页出现重复条目。
  /// 修复后该 WS 块不再写入；此处一次性清掉历史孤儿。
  /// - 保留：id 含 `@` 的 occurrence 事件（如 `taskId@2026-06-08T10:01:00.000Z`）
  /// - 保留：以 `se-` 开头的纯本地事项
  /// - 删除：其余裸 taskId（无 `@` 且不以 `se-` 开头）
  /// 返回被清理的条数。
  Future<int> cleanOrphanScheduleEvents() async {
    await init();
    final int before = _scheduleEvents.length;
    _scheduleEvents.removeWhere((Map<String, dynamic> m) {
      final String id = (m["id"] as String?)?.trim() ?? "";
      if (id.isEmpty) return true;
      if (id.startsWith("se-")) return false;
      if (id.contains("@")) return false;
      return true;
    });
    final int removed = before - _scheduleEvents.length;
    if (removed > 0) await _flush();
    return removed;
  }

  Future<void> clearAllScheduleEvents() async {
    await init();
    _scheduleEvents.clear();
    await _flush();
  }

  /// 删除单条消息（按 messageId）
  @override
  Future<void> deleteMessage(String messageId) async {
    await init();
    bool changed = false;
    for (final List<ChatMessage> list in _messages.values) {
      final int before = list.length;
      list.removeWhere((ChatMessage m) => m.messageId == messageId);
      if (list.length != before) changed = true;
    }
    if (changed) await _flush();
  }

  /// 删除某个会话下的全部消息
  @override
  Future<void> deleteMessagesForSession(String sessionId) async {
    await init();
    if (_messages.remove(sessionId) != null) await _flush();
  }

  /// 清除所有会话的全部消息
  @override
  Future<void> clearAllMessages() async {
    await init();
    _messages.clear();
    await _flush();
  }

  /// 用户已删除的服务端 taskId（同步时跳过，防止被重新拉回）。
  Future<Set<String>> getHiddenScheduleTaskIds() async {
    await init();
    final Object? raw = _preferences["hiddenScheduleTaskIds"];
    if (raw is! List) return <String>{};
    final Set<String> out = <String>{};
    for (final Object? item in raw) {
      final String s = item?.toString().trim() ?? "";
      if (s.isNotEmpty) out.add(s);
    }
    return out;
  }

  Future<void> hideScheduleTask(String taskId) async {
    final String id = taskId.trim();
    if (id.isEmpty) return;
    await init();
    final Set<String> hidden = await getHiddenScheduleTaskIds();
    hidden.add(id);
    _preferences["hiddenScheduleTaskIds"] = hidden.toList();
    await _flush();
  }

  /// 待补删的服务端 taskId（主服务离线时入队，恢复后自动重试）。
  Future<Set<String>> getPendingScheduleDeleteTaskIds() async {
    await init();
    final Object? raw = _preferences["pendingScheduleDeleteTaskIds"];
    if (raw is! List) return <String>{};
    final Set<String> out = <String>{};
    for (final Object? item in raw) {
      final String s = item?.toString().trim() ?? "";
      if (s.isNotEmpty) out.add(s);
    }
    return out;
  }

  Future<void> enqueuePendingScheduleDelete(String taskId) async {
    final String id = taskId.trim();
    if (id.isEmpty) return;
    await init();
    final Set<String> pending = await getPendingScheduleDeleteTaskIds();
    pending.add(id);
    _preferences["pendingScheduleDeleteTaskIds"] = pending.toList();
    await _flush();
  }

  Future<void> dequeuePendingScheduleDelete(String taskId) async {
    final String id = taskId.trim();
    if (id.isEmpty) return;
    await init();
    final Set<String> pending = await getPendingScheduleDeleteTaskIds();
    if (!pending.remove(id)) return;
    _preferences["pendingScheduleDeleteTaskIds"] = pending.toList();
    await _flush();
  }

  // ===== 离线待发用户消息队列（2026-10-12）=====
  //
  // 断网时 MobileChatController 把 `chat.user_message` 的完整 WS 载荷（含
  // visionFrames）挂进 _preferences 持久化；联网补发成功才出队。上限保护：
  // 超出丢最旧（对应气泡仍保留，只是不再补发，避免存储文件无限膨胀）。

  static const int _maxPendingUserMessages = 50;

  List<Map<String, dynamic>> _pendingUserMessageList() {
    final Object? raw = _preferences["pendingUserMessages"];
    if (raw is! List) return <Map<String, dynamic>>[];
    return raw
        .whereType<Map>()
        .map((Map e) => Map<String, dynamic>.from(e))
        .toList();
  }

  @override
  Future<List<Map<String, dynamic>>> listPendingUserMessages() async {
    await init();
    return _pendingUserMessageList();
  }

  @override
  Future<void> enqueuePendingUserMessage(Map<String, dynamic> payload) async {
    final String messageId = payload["messageId"]?.toString() ?? "";
    if (messageId.isEmpty) return;
    await init();
    final List<Map<String, dynamic>> list = _pendingUserMessageList()
      ..removeWhere((Map<String, dynamic> m) => m["messageId"] == messageId)
      ..add(payload);
    while (list.length > _maxPendingUserMessages) {
      list.removeAt(0);
    }
    _preferences["pendingUserMessages"] = list;
    await _flush();
  }

  @override
  Future<void> dequeuePendingUserMessage(String messageId) async {
    final String id = messageId.trim();
    if (id.isEmpty) return;
    await init();
    final List<Map<String, dynamic>> list = _pendingUserMessageList();
    final int before = list.length;
    list.removeWhere((Map<String, dynamic> m) => m["messageId"] == id);
    if (list.length == before) return;
    _preferences["pendingUserMessages"] = list;
    await _flush();
  }

  ScheduleEvent _scheduleEventFromMap(Map<String, dynamic> m) {
    return ScheduleEvent(
      id: m["id"] as String,
      startAt: DateTime.parse(m["startAt"] as String),
      title: m["title"] as String,
      shortTitle: m["shortTitle"] as String?,
      notes: m["notes"] as String?,
      isTrivia: m["isTrivia"] == true,
    );
  }

  Map<String, dynamic> _scheduleEventToMap(ScheduleEvent e) {
    return <String, dynamic>{
      "id": e.id,
      "startAt": e.startAt.toIso8601String(),
      "title": e.title,
      "shortTitle": e.shortTitle,
      "notes": e.notes,
      "isTrivia": e.isTrivia,
    };
  }

  /// `null`：尚未询问；`true`/`false`：用户已选择。
  Future<bool?> getVisionCameraConsent() async {
    await init();
    final Object? v = _preferences["visionCameraConsent"];
    if (v == null) {
      return null;
    }
    return v == true;
  }

  Future<void> setVisionCameraConsent(bool allowed) async {
    await init();
    _preferences["visionCameraConsent"] = allowed;
    await _flush();
  }

  /// 解密后的入站中继，按接收时间降序。
  Future<List<AgentRelayMessage>> listRelayInbound(String ownerSessionId) async {
    await init();
    final List<Map<String, dynamic>> raw =
        _relayInbound[ownerSessionId] ?? <Map<String, dynamic>>[];
    final List<AgentRelayMessage> out = raw.map(_mapToRelayPlain).toList();
    out.sort((AgentRelayMessage a, AgentRelayMessage b) =>
        b.receivedAt.compareTo(a.receivedAt));
    return out;
  }

  Future<void> upsertRelayMessage(String ownerSessionId, AgentRelayMessage m) async {
    await init();
    if (m.toSessionId != ownerSessionId) return;
    final List<Map<String, dynamic>> list =
        _relayInbound.putIfAbsent(ownerSessionId, () => <Map<String, dynamic>>[]);
    final Map<String, dynamic> encoded = _relayToMapEncrypted(m);
    final int idx = list.indexWhere(
      (Map<String, dynamic> r) => r["messageId"] == m.messageId,
    );
    if (idx >= 0) {
      list[idx] = encoded;
    } else {
      list.add(encoded);
    }
    list.sort((Map<String, dynamic> a, Map<String, dynamic> b) {
      final DateTime ta = DateTime.parse(a["receivedAt"] as String);
      final DateTime tb = DateTime.parse(b["receivedAt"] as String);
      return tb.compareTo(ta);
    });
    await _flush();
  }

  Future<void> replaceRelayInbound(
    String ownerSessionId,
    List<AgentRelayMessage> messages,
  ) async {
    await init();
    final List<Map<String, dynamic>> next = messages
        .where((AgentRelayMessage m) => m.toSessionId == ownerSessionId)
        .map(_relayToMapEncrypted)
        .toList();
    next.sort((Map<String, dynamic> a, Map<String, dynamic> b) {
      final DateTime ta = DateTime.parse(a["receivedAt"] as String);
      final DateTime tb = DateTime.parse(b["receivedAt"] as String);
      return tb.compareTo(ta);
    });
    _relayInbound[ownerSessionId] = next;
    await _flush();
  }

  Map<String, dynamic> _relayToMapEncrypted(AgentRelayMessage m) {
    return _relayToMapEncryptedFor(m, _userPin);
  }

  Map<String, dynamic> _relayToMapEncryptedFor(AgentRelayMessage m, String pin) {
    return <String, dynamic>{
      "messageId": m.messageId,
      "fromSessionId": m.fromSessionId,
      "toSessionId": m.toSessionId,
      "text": _encryptFor(m.text, pin),
      "subject": m.subject == null ? null : _encryptFor(m.subject!, pin),
      "receivedAt": m.receivedAt.toIso8601String(),
    };
  }

  AgentRelayMessage _mapToRelayPlain(Map<String, dynamic> map) {
    return _mapToRelayPlainFor(map, _userPin);
  }

  AgentRelayMessage _mapToRelayPlainFor(Map<String, dynamic> map, String pin) {
    final String? subCipher = map["subject"] as String?;
    return AgentRelayMessage(
      messageId: map["messageId"] as String,
      fromSessionId: map["fromSessionId"] as String,
      toSessionId: map["toSessionId"] as String,
      text: _decryptFor(map["text"] as String, pin),
      subject: subCipher == null || subCipher.isEmpty
          ? null
          : _decryptFor(subCipher, pin),
      receivedAt: DateTime.parse(map["receivedAt"] as String),
    );
  }

  /// 将本地数据用旧 PIN 解密后再用新 PIN 加密并落盘（聊天 + 入站中继）。
  Future<void> rekey(String newPin) async {
    await init();
    final String trimmed = newPin.trim();
    if (trimmed.length < 4) {
      throw ArgumentError("新 PIN 至少 4 个字符");
    }
    if (trimmed == _userPin) return;
    final String oldPin = _userPin;

    for (final String sid in _messages.keys.toList()) {
      final List<ChatMessage> list = _messages[sid]!;
      for (int i = 0; i < list.length; i++) {
        final ChatMessage m = list[i];
        final String plain = _decryptFor(m.text, oldPin);
        final String enc = _encryptFor(plain, trimmed);
        list[i] = ChatMessage(
          messageId: m.messageId,
          sessionId: m.sessionId,
          role: m.role,
          text: enc,
          timestamp: m.timestamp,
          attachmentImageCount: m.attachmentImageCount,
          playUrl: m.playUrl,
          mediaCards: m.mediaCards,
          renderBlocks: m.renderBlocks,
        );
      }
    }

    for (final String owner in _relayInbound.keys.toList()) {
      final List<Map<String, dynamic>> list = _relayInbound[owner]!;
      for (int i = 0; i < list.length; i++) {
        final AgentRelayMessage plain = _mapToRelayPlainFor(list[i], oldPin);
        list[i] = _relayToMapEncryptedFor(plain, trimmed);
      }
    }

    _userPin = trimmed;
    await _flush();
  }

  @override
  Future<List<ChatMessage>> listMessages(String sessionId) async {
    await init();
    final List<ChatMessage> encrypted = _messages[sessionId] ?? <ChatMessage>[];
    // 按 messageId 去重（保留后写入的一条）：清理历史上 saveMessage 多次追加
    // 同一条消息产生的脏数据，避免重启/刷新后出现重复气泡。
    final Map<String, ChatMessage> unique = <String, ChatMessage>{};
    for (final ChatMessage m in encrypted) {
      unique[m.messageId] = m;
    }
    final List<ChatMessage> deduped = unique.values.toList()
      ..sort((ChatMessage a, ChatMessage b) => a.timestamp.compareTo(b.timestamp));
    // 逐条容错解密：单条消息损坏（截断/base64 坏/异源 PIN）只跳过那一条，
    // 绝不让整段历史因一条脏数据静默清零（此前 listMessages 一抛，
    // _bootstrapHistory 整个 catch 掉 → 用户看到的就是「历史没保存」）。
    final List<ChatMessage> out = <ChatMessage>[];
    for (final ChatMessage message in deduped) {
      try {
        out.add(ChatMessage(
          messageId: message.messageId,
          sessionId: message.sessionId,
          role: message.role,
          text: _decryptFor(message.text, _userPin),
          timestamp: message.timestamp,
          attachmentImageCount: message.attachmentImageCount,
          playUrl: message.playUrl,
          pendingDelivery: message.pendingDelivery,
          mediaCards: message.mediaCards,
          summaryCard: message.summaryCard,
          renderBlocks: message.renderBlocks,
        ));
      } catch (e) {
        debugPrint(
          '[IsarLocalHistoryStore] 跳过损坏消息 ${message.messageId}: $e',
        );
      }
    }
    return out;
  }

  @override
  Future<int> migrateAssistantTimestampFrames() async {
    await init();
    if (_preferences[_assistantTimestampMigrationPreferenceKey] == true) {
      return 0;
    }

    int changed = 0;
    for (final String sessionId in _messages.keys.toList()) {
      final List<ChatMessage> encryptedMessages =
          _messages[sessionId] ?? <ChatMessage>[];
      for (int index = 0; index < encryptedMessages.length; index++) {
        final ChatMessage message = encryptedMessages[index];
        if (message.role != "assistant") continue;

        final String plainText = _decryptFor(message.text, _userPin);
        final String sanitizedText = stripAllTimestampFrameLines(plainText);
        if (sanitizedText == plainText) continue;

        encryptedMessages[index] = ChatMessage(
          messageId: message.messageId,
          sessionId: message.sessionId,
          role: message.role,
          text: _encryptFor(sanitizedText, _userPin),
          timestamp: message.timestamp,
          attachmentImageCount: message.attachmentImageCount,
          playUrl: message.playUrl,
          mediaCards: message.mediaCards,
          renderBlocks: message.renderBlocks,
        );
        changed++;
      }
    }

    _preferences[_assistantTimestampMigrationPreferenceKey] = true;
    await _flush();
    return changed;
  }

  @override
  Future<List<ChatSession>> listSessions() async {
    await init();
    final List<ChatSession> sessions = List<ChatSession>.from(_sessions);
    sessions.sort((ChatSession a, ChatSession b) => a.createdAt.compareTo(b.createdAt));
    return sessions;
  }

  @override
  Future<void> saveMessage(ChatMessage message) async {
    await init();
    final String encrypted = _encryptFor(message.text, _userPin);
    final ChatMessage masked = ChatMessage(
      messageId: message.messageId,
      sessionId: message.sessionId,
      role: message.role,
      text: encrypted,
      timestamp: message.timestamp,
      attachmentImageCount: message.attachmentImageCount,
      playUrl: message.playUrl,
      pendingDelivery: message.pendingDelivery,
      mediaCards: message.mediaCards,
      summaryCard: message.summaryCard,
      renderBlocks: message.renderBlocks,
    );
    // 按 (sessionId, messageId) upsert：同一条消息（如流式期间先存部分文本、
    // done 后再存完整文本）只保留一条记录，避免本地历史出现重复气泡。
    final List<ChatMessage> list =
        _messages.putIfAbsent(masked.sessionId, () => <ChatMessage>[]);
    final int existingIndex =
        list.indexWhere((ChatMessage m) => m.messageId == message.messageId);
    if (existingIndex >= 0) {
      list[existingIndex] = masked;
    } else {
      list.add(masked);
    }
    await _flush();
  }

  @override
  Future<void> saveSession(ChatSession session) async {
    await init();
    final bool exists = _sessions.any((ChatSession s) => s.sessionId == session.sessionId);
    if (exists) return;
    _sessions.add(session);
    await _flush();
  }

  String _encryptFor(String plainText, String pin) {
    final Digest key = sha256.convert(utf8.encode(pin));
    final List<int> source = utf8.encode(plainText);
    final List<int> output = <int>[];
    for (int i = 0; i < source.length; i++) {
      output.add(source[i] ^ key.bytes[i % key.bytes.length]);
    }
    return base64Encode(output);
  }

  String _decryptFor(String cipherText, String pin) {
    final Digest key = sha256.convert(utf8.encode(pin));
    final List<int> source = base64Decode(cipherText);
    final List<int> output = <int>[];
    for (int i = 0; i < source.length; i++) {
      output.add(source[i] ^ key.bytes[i % key.bytes.length]);
    }
    return utf8.decode(output);
  }

  /// 把结构化媒体卡片加密为存储字符串（null/空 → null）。
  String? _encryptMediaCards(List<Map<String, dynamic>>? cards) {
    if (cards == null || cards.isEmpty) return null;
    return _encryptFor(jsonEncode(cards), _userPin);
  }

  /// 解密存储字符串为媒体卡片；损坏时不抛异常，返回 null（历史兼容）。
  List<Map<String, dynamic>>? _decryptMediaCards(Object? stored) {
    if (stored is! String || stored.isEmpty) return null;
    try {
      final Object? decoded = jsonDecode(_decryptFor(stored, _userPin));
      if (decoded is! List) return null;
      return decoded
          .map((dynamic e) => Map<String, dynamic>.from(e as Map))
          .toList();
    } catch (_) {
      return null;
    }
  }

  /// 把结构化摘要卡加密为存储字符串（null → null）。
  String? _encryptSummaryCard(Map<String, dynamic>? card) {
    if (card == null || card.isEmpty) return null;
    return _encryptFor(jsonEncode(card), _userPin);
  }

  /// 解密存储字符串为摘要卡；损坏时不抛异常，返回 null（历史兼容）。
  Map<String, dynamic>? _decryptSummaryCard(Object? stored) {
    if (stored is! String || stored.isEmpty) return null;
    try {
      final Object? decoded = jsonDecode(_decryptFor(stored, _userPin));
      if (decoded is! Map) return null;
      return Map<String, dynamic>.from(decoded);
    } catch (_) {
      return null;
    }
  }

  /// 加密交错渲染块（renderBlocks）为存储字符串（结构同 mediaCards 的列表）。
  String? _encryptRenderBlocks(List<Map<String, dynamic>>? blocks) {
    if (blocks == null || blocks.isEmpty) return null;
    return _encryptFor(jsonEncode(blocks), _userPin);
  }

  /// 解密存储字符串为交错渲染块；损坏时不抛异常，返回 null（历史兼容）。
  List<Map<String, dynamic>>? _decryptRenderBlocks(Object? stored) {
    if (stored is! String || stored.isEmpty) return null;
    try {
      final Object? decoded = jsonDecode(_decryptFor(stored, _userPin));
      if (decoded is! List) return null;
      return decoded
          .map((dynamic e) => Map<String, dynamic>.from(e as Map))
          .toList();
    } catch (_) {
      return null;
    }
  }

  /// 排队一次写盘。快照（jsonEncode）在链内取，保证每次快照看到的都是
  /// 前一次写盘完成后的最新状态；链条本身不带错误中断（_doFlush 内部吞），
  /// 再加一层 catchError 兜底防链条被毒化（一旦链上 future 带错，后续
  /// then 回调不再执行 = 后续所有消息永远不落盘）。
  Future<void> _flush() {
    final Future<void> prev = _flushQueue ?? Future<void>.value();
    final Future<void> task = prev.then((_) => _doFlush());
    _flushQueue = task.catchError((Object e) {
      debugPrint('[IsarLocalHistoryStore] 写盘链异常（已续链）: $e');
    });
    return task;
  }

  Future<void> _doFlush() async {
    // Web 平台不支持文件系统，跳过写入
    if (kIsWeb || _storageFile == null) {
      debugPrint('[IsarLocalHistoryStore] Web 平台，跳过文件写入');
      return;
    }

    final File file = _storageFile!;
    final Map<String, dynamic> encoded = <String, dynamic>{
      "sessions": _sessions
          .map(
            (ChatSession s) => <String, dynamic>{
              "sessionId": s.sessionId,
              "title": s.title,
              "createdAt": s.createdAt.toIso8601String(),
            },
          )
          .toList(),
      "messages": _messages.map(
        (String key, List<ChatMessage> list) => MapEntry<String, dynamic>(
          key,
          list
              .map(
                (ChatMessage m) => <String, dynamic>{
                  "messageId": m.messageId,
                  "sessionId": m.sessionId,
                  "role": m.role,
                  "text": m.text,
                  "timestamp": m.timestamp.toIso8601String(),
                  "attachmentImageCount": m.attachmentImageCount,
                  if (m.playUrl != null) "playUrl": m.playUrl,
                  if (m.pendingDelivery) "pendingDelivery": true,
                  if (m.mediaCards != null)
                    "mediaCards": _encryptMediaCards(m.mediaCards),
                  if (m.summaryCard != null)
                    "summaryCard": _encryptSummaryCard(m.summaryCard),
                  if (m.renderBlocks != null)
                    "renderBlocks": _encryptRenderBlocks(m.renderBlocks),
                },
              )
              .toList(),
        ),
      ),
      "relayInbound": _relayInbound,
      "preferences": _preferences,
      "scheduleEvents": _scheduleEvents,
    };
    try {
      // 原子落盘：先写临时文件再改名。直写 writeAsString 中途进程被杀
      // （手机上滑清后台很常见）会留下半截 JSON，下次启动整库判损坏被
      // 重建为空——这是「对话历史没保存」的主凶。rename 在 POSIX
      // （Android/iOS）上是原子替换；rename 覆盖失败的个别场景退回直写。
      final File tmp = File("${file.path}.tmp");
      await tmp.writeAsString(jsonEncode(encoded), flush: true);
      try {
        await tmp.rename(file.path);
      } catch (_) {
        await file.writeAsString(jsonEncode(encoded), flush: true);
        try {
          if (await tmp.exists()) await tmp.delete();
        } catch (_) {
          // 残留 .tmp 无害，下次写盘会覆盖
        }
      }
    } catch (e) {
      // 写入失败不抛异常，避免影响调用链（如定位缓存上报）；仅记日志。
      debugPrint('[IsarLocalHistoryStore] 存储写入失败（已忽略）: $e');
    }
  }

  @override
  Future<dynamic> getPreference(String key) async {
    // 数据已在 init 时加载
    return _preferences[key];
  }

  @override
  Future<void> savePreference(String key, dynamic value) async {
    _preferences[key] = value;
    await _flush();
  }

  @override
  Future<bool> getBiometricRegistrationStatus() async {
    // 数据已在 init 时加载
    return _preferences['biometricRegistered'] == true;
  }

  @override
  Future<void> saveBiometricRegistrationStatus(bool isRegistered) async {
    _preferences['biometricRegistered'] = isRegistered;
    await _flush();
  }
}
