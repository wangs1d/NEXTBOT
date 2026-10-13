import "dart:async";
import "dart:convert";

import "package:flutter/foundation.dart";
import "package:http/http.dart" as http;

import "../app/ambient_feeds_controller.dart";
import "../core/config/api_config.dart";
import "../core/db/isar_local_history_store.dart";
import "../core/db/local_history_store.dart";
import "../core/models/chat_models.dart";
import "../core/services/access_auth_api.dart";
import "../core/services/client_location_service.dart";
import "../core/services/ws_chat_service.dart";
import "../core/utils/agent_result_parser.dart";
import "../core/utils/assistant_text_sanitizer.dart";
import "../core/utils/link_utils.dart";
import "../core/vision/vision_wire_frame.dart";
import "../features/chat/media_disk_cache.dart";
import "../features/chat/travel_plan_launcher.dart";

// ===== 真·分绿泡（2026-09-28）：气泡拆分消息 id 工具（与桌面端 main.dart 同构）=====
final RegExp _bubbleIdPattern = RegExp(r"^assistant-(.+)-b(\d+)$");

/// 是否为分泡消息 id（assistant-<traceId>-bN，服务端 BubbleTracker 分配）。
bool _isBubbleId(String messageId) => _bubbleIdPattern.hasMatch(messageId);

/// 从分泡消息 id 提取轮次 traceId；非分泡 id 返回 null。
String? _bubbleTraceOf(String messageId) =>
    _bubbleIdPattern.firstMatch(messageId)?.group(1);

/// 手机端对话控制器：复用 [WsChatService] 连接与桌面端同一后端，数据/会话自动同步。
///
/// 协议(与桌面端一致)：
/// - 连接成功 → `session.init`(携带 userId/sessionId,后端按 userId 绑定 actor,两端同步)
/// - 发送 → `chat.user_message`(messageId/text/timestamp/userId/agentAccessMode)
/// - 接收 → `chat.turn_started/interim`(思考态)、`chat.assistant_chunk`(流式正文)、
///   `chat.media_ready`(边说边出图临时照片)、`chat.assistant_done`(收尾最终文本,
///   含结构化 mediaCards/renderBlocks 字段,与桌面端一致)
class MobileChatController extends ChangeNotifier {
  MobileChatController({String? wsBaseUrl, LocalHistoryStore? historyStore}) {
    _service = WsChatService(url: wsBaseUrl ?? ApiConfig.wsUrl);
    _service.onConnected = _sendSessionInit;
    _subscription = _service.events.listen(_onWsEvent);
    _service.connect();
    _store = historyStore ?? IsarLocalHistoryStore(userPin: ApiConfig.localPin);
    unawaited(_bootstrapHistory());
  }

  late final WsChatService _service;
  StreamSubscription? _subscription;

  /// 本地历史存储（聊天气泡落盘，重启后恢复；测试可注入内存实现）。
  late final LocalHistoryStore _store;

  /// 服务端线程历史拉取去重闸（每次控制器生命周期只拉一次）。
  bool _serverHistoryPulled = false;

  /// 对话历史(含正在流式生成的助手消息)。
  final List<ChatMessage> messages = <ChatMessage>[];

  /// Agent 是否正在思考 / 生成中。
  bool isProcessing = false;

  /// 连接状态文案(用于顶栏状态点)。
  bool isConnected = false;

  /// 连接状态通知器(「我的」页账号卡监听展示在线/离线)。
  final ValueNotifier<bool> connection = ValueNotifier<bool>(false);

  /// 底层 WS 服务(邮箱页等同源复用,避免双连接)。
  WsChatService get service => _service;

  /// 错误提示(轻提示用)。
  String? errorMessage;

  /// 当前流式助手消息 id。
  String? _streamingMessageId;

  /// 当前正在调用的工具名（`tool.call` 置位、`tool.result`/收尾清空）。
  /// 输入框左上角据此展示「球形图标 + 正在调用:xxx」。
  String? currentToolName;

  /// 离线补发进行中闸（防 ws_connected 风暴期间并发 flush 乱序重复发送）。
  bool _flushingPending = false;

  /// 打开一个新会话：仅清空本地内存，仍连接同一后端。
  void reset() {
    messages.clear();
    _streamingMessageId = null;
    currentToolName = null;
    isProcessing = false;
    notifyListeners();
  }

  // ===== 聊天历史持久化（2026-10-08）：本地落盘 + 服务端线程漫游回填 =====

  /// 启动加载：本地 store 恢复历史 → 再拉服务端线程回填跨端消息。
  /// 全程静默容错（存储不可写/网络不可达都只降级为内存态，不阻塞聊天）。
  Future<void> _bootstrapHistory() async {
    try {
      await _store.init();
      try {
        await _store.saveSession(ChatSession(
          sessionId: ApiConfig.effectiveActorId,
          title: "默认会话",
          createdAt: DateTime.now(),
        ));
      } catch (_) {
        // 会话头写失败不影响消息恢复
      }
      final List<ChatMessage> loaded =
          await _store.listMessages(ApiConfig.effectiveActorId);
      // recap 回显过滤（2026-10-12）：本地库已落盘的「摘要整块复述」气泡在加载层
      // 剔除（非破坏性——store 数据不动，仅不再显示）。与服务端 isRecapEchoText 同判据。
      final List<ChatMessage> visible = loaded
          .where((m) => m.role != "assistant" ||
              stripRecapEchoBlocks(m.text).trim().isNotEmpty)
          .toList();
      if (visible.isNotEmpty) {
        _mergeLoadedMessages(visible);
        notifyListeners();
        // 冷启动媒体预热（2026-10-12 预缓存）：历史照片提前并发落盘到磁盘
        // 缓存，滚到对应消息直接命中秒出——这是「重开后照片要重新缓存一段
        // 时间」问题的根治半边（渲染端已统一走 CachedMediaImage）。
        _warmHistoryMedia(visible);
      }
    } catch (e) {
      debugPrint("[MobileChatController] 本地历史加载失败(降级内存态): $e");
    }
    unawaited(_pullServerHistory());
  }

  /// 把本地加载的历史并入内存：无内存消息直接铺入；已有消息（加载期间
  /// 用户已发消息的竞态窗口）按 messageId 去重后前置旧消息，保序不覆盖。
  void _mergeLoadedMessages(List<ChatMessage> loaded) {
    if (messages.isEmpty) {
      messages.addAll(loaded);
      return;
    }
    final Set<String> memoryIds = messages.map((m) => m.messageId).toSet();
    final List<ChatMessage> older =
        loaded.where((m) => !memoryIds.contains(m.messageId)).toList();
    if (older.isEmpty) return;
    messages.insertAll(0, older);
  }

  /// 冷启动媒体预热：收集历史消息里全部媒体卡地址（mediaCards / renderBlocks
  /// 媒体块 / 瞬态 pendingMediaCards），归一为绝对 URL 后交给磁盘缓存有界
  /// 并发预热。全程静默，不阻塞聊天恢复。
  void _warmHistoryMedia(List<ChatMessage> msgs) {
    void collectCard(Map<String, dynamic> card) {
      final Object? thumb = card["thumbnailUrl"] ?? card["mediaUrl"];
      final String url = thumb?.toString() ?? "";
      if (url.isEmpty) return;
      MediaDiskCache.instance.warm(<String>[LinkUtils.resolveMediaUrl(url)]);
    }

    for (final ChatMessage m in msgs) {
      m.mediaCards?.forEach(collectCard);
      m.pendingMediaCards?.forEach(collectCard);
      final List<Map<String, dynamic>>? blocks = m.renderBlocks;
      if (blocks == null) continue;
      for (final Map<String, dynamic> block in blocks) {
        if ((block["type"]?.toString() ?? "") != "media") continue;
        final List<dynamic>? cards = block["cards"] as List<dynamic>?;
        cards
            ?.whereType<Map<String, dynamic>>()
            .forEach(collectCard);
      }
    }
  }

  /// 消息落盘（fire-and-forget；失败静默，聊天主链路绝不因存储阻塞）。
  void _persist(ChatMessage message) {
    unawaited(
      _store.saveMessage(message).catchError((Object e) {
        debugPrint("[MobileChatController] 消息落盘失败: $e");
      }),
    );
  }

  /// 服务端全量转史拉取（GET /api/chat-data/history?full=1）：从服务端 turn WAL
  /// 反解完整聊天转史（2026-10-12 P1）——线程口径只有滑动窗口十几条，清数据/
  /// 换机后旧对话回不来；WAL 是聊天记录的权威源。按 user 锚去重后落本地。
  Future<void> _pullServerHistory() async {
    if (_serverHistoryPulled) return;
    _serverHistoryPulled = true;
    try {
      final Uri uri = Uri.parse("${ApiConfig.httpBase}/api/chat-data/history")
          .replace(queryParameters: <String, String>{
        "userId": ApiConfig.effectiveActorId,
        "limit": "200",
        "full": "1",
      });
      final http.Response res = await http
          .get(uri, headers: AccessCredentialStore.instance.authHeaders)
          .timeout(const Duration(seconds: 15));
      if (res.statusCode != 200) return;
      final Map<String, dynamic> body =
          jsonDecode(res.body) as Map<String, dynamic>;
      final List<dynamic> raw = body["messages"] as List<dynamic>? ?? const [];
      final List<ChatMessage> incoming = <ChatMessage>[];
      int fallbackSeq = 0;
      for (final dynamic item in raw) {
        if (item is! Map<String, dynamic>) continue;
        final String role = item["role"]?.toString() ?? "";
        final String text = stripAssistantProtocolFrames(
          item["text"]?.toString() ?? "",
        ).trim();
        if ((role != "user" && role != "assistant") || text.isEmpty) continue;
        final int? tsMs = item["ts"] is int ? item["ts"] as int : null;
        final DateTime ts =
            tsMs != null ? DateTime.fromMillisecondsSinceEpoch(tsMs) : DateTime.now();
        final String? clientMessageId = item["clientMessageId"]?.toString();
        final String messageId = role == "user" && (clientMessageId?.isNotEmpty ?? false)
            ? clientMessageId!
            : "hist-$role-${ts.millisecondsSinceEpoch}-${fallbackSeq++}";
        incoming.add(ChatMessage(
          messageId: messageId,
          sessionId: ApiConfig.effectiveActorId,
          role: role,
          text: text,
          timestamp: ts,
        ));
      }
      if (incoming.isEmpty) return;
      _mergeServerTurns(incoming);
    } catch (e) {
      debugPrint("[MobileChatController] 服务端历史拉取失败(跳过回填): $e");
    }
  }

  /// 跨端回填合并（turn 级锚定去重）：
  /// - 锚 = 用户消息。服务端轮与本机重复的判定：clientMessageId 命中本地 id、
  ///   用户原文精确命中、纯图占位（服务端「（用户发送了…」↔ 本地「（见图）」）。
  /// - 助手消息随锚走：锚轮已存在 → 整轮跳过（分泡/塌缩形态差异不再制造双份）；
  ///   无锚的孤儿助手消息按正文包含关系去重后插入。
  /// - 插入位置按时间戳落位，回填后逐条写进本地 store（下次启动直接命中）。
  void _mergeServerTurns(List<ChatMessage> incoming) {
    // 按 user 锚切轮（开头没有锚的孤儿助手消息自成一轮）
    final List<List<ChatMessage>> turns = <List<ChatMessage>>[];
    for (final ChatMessage m in incoming) {
      if (m.role == "user" || turns.isEmpty) {
        turns.add(<ChatMessage>[m]);
      } else {
        turns.last.add(m);
      }
    }

    final Set<String> localUserIds = <String>{};
    final Set<String> localUserTexts = <String>{};
    final List<ChatMessage> localAssistants = <ChatMessage>[];
    for (final ChatMessage m in messages) {
      if (m.role == "user") {
        localUserIds.add(m.messageId);
        localUserTexts.add(m.text.trim());
      } else if (m.role == "assistant" && m.text.trim().isNotEmpty) {
        localAssistants.add(m);
      }
    }
    final Set<String> backfilledAssistantTexts = <String>{};

    bool turnExistsLocally(List<ChatMessage> turn) {
      final ChatMessage anchor = turn.first;
      if (anchor.role != "user") return false;
      final String anchorText = anchor.text.trim();
      if (localUserIds.contains(anchor.messageId)) return true;
      if (localUserTexts.contains(anchorText)) return true;
      // 纯图轮：本地气泡文案与服务端视觉占位文案不同，视为同一轮
      if (anchorText == "（见图）" &&
          localUserTexts.any((t) => t == "（见图）")) {
        return true;
      }
      return false;
    }

    bool assistantKnown(ChatMessage m) {
      final String text = m.text.trim();
      if (backfilledAssistantTexts.contains(text)) return true;
      if (localUserTexts.contains(text)) return true;
      for (final ChatMessage local in localAssistants) {
        final String lt = local.text.trim();
        // 包含关系去重：服务端合并正文 ↔ 本地分泡互为片段时视为同一条回复
        if (lt.length >= 8 && text.contains(lt)) return true;
        if (text.length >= 8 && lt.contains(text)) return true;
      }
      return false;
    }

    void insertByTimestamp(ChatMessage m) {
      int idx = messages.indexWhere((local) => local.timestamp.isAfter(m.timestamp));
      if (idx < 0) idx = messages.length;
      messages.insert(idx, m);
      _persist(m);
    }

    bool mutated = false;
    for (final List<ChatMessage> turn in turns) {
      if (turnExistsLocally(turn)) continue;
      for (final ChatMessage m in turn) {
        if (m.role == "assistant" && assistantKnown(m)) continue;
        if (m.role == "assistant") backfilledAssistantTexts.add(m.text.trim());
        insertByTimestamp(m);
        mutated = true;
        if (m.role == "user") {
          localUserIds.add(m.messageId);
          localUserTexts.add(m.text.trim());
        } else {
          localAssistants.add(m);
        }
      }
    }
    if (mutated) notifyListeners();
  }

  void _sendSessionInit() {
    final Map<String, dynamic> init = <String, dynamic>{
      "sessionId": ApiConfig.sessionId,
      "deviceId": "mobile-${defaultTargetPlatform.name}",
      "userAlias": "owner",
      // 登录邮箱覆盖（未登录回落 USER_ID/sessionId），服务端按 userId 绑定 actor
      "userId": ApiConfig.effectiveActorId,
    };
    _service.sendEvent("session.init", init);
  }

  /// 发送一条用户消息(空文本+无图忽略)。携带 [visionFrames] 时与桌面端
  /// 同协议走 `chat.user_message.visionFrames`(base64,服务端视觉管线)。
  /// 返回落库的用户消息 id(未发送返回 null),供调用方挂气泡缩略图。
  ///
  /// 离线可发（2026-10-12）：断网时消息照常落气泡并持久化，同时把完整
  /// `chat.user_message` 载荷存进本地待发队列；联网后由
  /// [_flushPendingUserMessages] 按序补发。服务端按 messageId 幂等去重，
  /// 补发重复无害。
  Future<String?> send(String raw, {List<VisionWireFrame>? visionFrames}) async {
    final String text = raw.trim();
    final bool hasFrames = visionFrames != null && visionFrames.isNotEmpty;
    if (text.isEmpty && !hasFrames) return null;
    final bool offline = !_service.isConnected;
    final ChatMessage userMsg = ChatMessage(
      messageId: "msg-${DateTime.now().microsecondsSinceEpoch}",
      sessionId: ApiConfig.effectiveActorId,
      role: "user",
      // 纯图无文字时气泡显示「（见图）」,与桌面端一致
      text: text.isEmpty && hasFrames ? "（见图）" : text,
      timestamp: DateTime.now(),
      attachmentImageCount: hasFrames ? visionFrames.length : 0,
      pendingDelivery: offline,
    );
    final Map<String, dynamic> payload = <String, dynamic>{
      "sessionId": ApiConfig.sessionId,
      "messageId": userMsg.messageId,
      // 纯图轮 text 置空(服务端按 visionFrames 走视觉分档),与桌面端一致
      "text": text,
      "timestamp": DateTime.now().toIso8601String(),
      "agentAccessMode": "full",
      // 与 session.init 同源：登录邮箱优先，保证消息落在本账号车道
      "userId": ApiConfig.effectiveActorId,
    };
    if (hasFrames) {
      payload["visionFrames"] =
          visionFrames.map((VisionWireFrame f) => f.toJson()).toList();
    }
    messages.add(userMsg);
    _persist(userMsg);
    notifyListeners();

    if (offline) {
      // 离线：入队（fire-and-forget，存储失败只丢补发不丢气泡）+ 触发重连
      unawaited(
        _store.enqueuePendingUserMessage(payload).catchError((Object e) {
          debugPrint("[MobileChatController] 离线消息入队失败: $e");
        }),
      );
      _service.retryConnect();
      errorMessage = "当前离线,消息已存入待发队列,联网后自动发送";
      notifyListeners();
      return userMsg.messageId;
    }
    isProcessing = true;
    errorMessage = null;
    notifyListeners();
    _service.sendEvent("chat.user_message", payload);
    return userMsg.messageId;
  }

  /// 联网补发离线待发消息（`ws_connected` 后触发；此时 `session.init` 已由
  /// onConnected 同步先行发出，载荷落在已绑定的账号车道上）。
  ///
  /// 按队列顺序逐条补发；发送成功才出队并翻转气泡「离线待发送」状态。
  /// 中途断线/发送失败立即停手，剩余留队等下次 ws_connected。
  Future<void> _flushPendingUserMessages() async {
    if (_flushingPending) return;
    _flushingPending = true;
    try {
      final List<Map<String, dynamic>> pending =
          await _store.listPendingUserMessages();
      if (pending.isEmpty) return;
      for (final Map<String, dynamic> payload in pending) {
        if (!_service.isConnected) return;
        final String messageId = payload["messageId"]?.toString() ?? "";
        if (messageId.isEmpty) continue;
        if (!_send("chat.user_message", payload)) return;
        await _store.dequeuePendingUserMessage(messageId);
        final int idx =
            messages.indexWhere((m) => m.messageId == messageId);
        if (idx >= 0 && messages[idx].pendingDelivery) {
          final ChatMessage settled =
              messages[idx].copyWith(pendingDelivery: false);
          messages[idx] = settled;
          _persist(settled);
        }
        notifyListeners();
      }
      errorMessage = null;
    } catch (e) {
      debugPrint("[MobileChatController] 离线消息补发失败(留队重试): $e");
    } finally {
      _flushingPending = false;
      notifyListeners();
    }
  }

  /// 测试入口：直接驱动 WS 事件（生产路径走 [_subscription] → 本方法）。
  @visibleForTesting
  void debugHandleWsEvent(Map<String, dynamic> event) => _onWsEvent(event);

  /// 测试注入点：定位解析器（生产为 null → 走 ClientLocationService 实时定位）。
  @visibleForTesting
  static Future<ClientLocationPayload?> Function()? debugLocationResolver;

  /// 测试开关：置 true 时 [_send] 把发出的事件记录进 [debugSentEvents]。
  @visibleForTesting
  bool debugCaptureSentEvents = false;

  /// 测试观测点：经 [_send] 发出的事件（type, payload）按序记录。
  @visibleForTesting
  final List<MapEntry<String, Map<String, dynamic>>> debugSentEvents =
      <MapEntry<String, Map<String, dynamic>>>[];

  /// 出站统一入口：生产直发；测试开启 [debugCaptureSentEvents] 时留观测记录。
  bool _send(String type, Map<String, dynamic> payload) {
    if (debugCaptureSentEvents) {
      debugSentEvents.add(MapEntry<String, Map<String, dynamic>>(type, payload));
    }
    return _service.sendEvent(type, payload);
  }

  /// 服务端按需定位应答（与桌面端 main.dart 同协议）：Agent 需要位置时
  /// （天气/时钟等工具）下发 `agent.location_request`，本端拉纯坐标秒回
  /// `client.location_report`（服务端拿到坐标后自行逆地理）。
  ///
  /// 手机端此前没有这条应答链——服务端 locationCoordinator 绑定的是该 actor
  /// 最后一条完成 session.init 的连接，手机聊天 WS 与桌面根 WS 同 actor 竞绑
  /// （聊天 WS 后建常胜出），请求落在无人应答的聊天 WS 上就恒超时，agent
  /// 便「不知道用户的地址」。本端补齐后无论绑定落在哪条连接都能闭环。
  Future<void> _handleLocationRequest(Map<String, dynamic> payload) async {
    final String jobId = payload["jobId"]?.toString() ?? "";
    ClientLocationPayload? loc;
    try {
      loc = await _resolveLocation();
    } catch (_) {
      loc = null;
    }
    debugPrint(
      "[MobileChatController] 按需定位回包 jobId=$jobId lat=${loc?.latitude ?? "无"}",
    );
    // 拿不到坐标也回 jobId 空包：让服务端立即结算（resolve null），不白等超时。
    _send("client.location_report", <String, dynamic>{
      if (jobId.isNotEmpty) "jobId": jobId,
      ...?loc?.toJson(),
    });
  }

  /// 连接就绪即静默上报一次定位（无 jobId 纯上报，与桌面端启动上报同语义）：
  /// 填充服务端 actor 位置缓存，首条消息的 prompt 注入才有位置背景可用。
  /// 登录后 actor 身份才落定，桌面根 WS 的启动上报可能落在匿名 actor 上，
  /// 本连接（登录后创建）的上报正好补上登录身份的缓存。
  Future<void> _reportStartupLocation() async {
    try {
      final ClientLocationPayload? loc = await _resolveLocation();
      if (loc == null) return;
      debugPrint(
        "[MobileChatController] 启动定位上报 lat=${loc.latitude} city=${loc.city ?? "-"}",
      );
      _send("client.location_report", loc.toJson());
    } catch (_) {
      // 定位失败静默：Agent 运行中需要位置时会走 agent.location_request 按需再拉
    }
  }

  Future<ClientLocationPayload?> _resolveLocation() {
    final resolver = debugLocationResolver;
    if (resolver != null) return resolver();
    return ClientLocationService.getCurrentLocationForAgentReply();
  }

  void _onWsEvent(Map<String, dynamic> event) {
    final String type = event["type"]?.toString() ?? "";
    final Map<String, dynamic> payload =
        event["payload"] is Map ? event["payload"] as Map<String, dynamic> : const {};
    switch (type) {
      case "ws_connected":
        isConnected = true;
        connection.value = true;
        notifyListeners();
        // 连接就绪即静默上报一次定位（无 jobId）：填充服务端位置缓存，
        // 首条消息的 prompt 注入才有位置背景。与桌面端启动上报同语义。
        unawaited(_reportStartupLocation());
        // 离线待发消息补发（session.init 已由 onConnected 同步先行发出）
        unawaited(_flushPendingUserMessages());
      case "agent.location_request":
        unawaited(_handleLocationRequest(payload));
      case "schedule.reminder_fired":
        // 到点提醒（2026-10-12 接通）：编排层按前后台分流——后台系统通知，
        // 前台应用内横幅。此前手机端不监听本事件，到点无任何触达。
        unawaited(AmbientFeedsController.instance.onScheduleReminderFired(payload));
      case "schedule.tasks_changed":
        // 日程变更同步（创建/更新/删除）→ 编排层刷新日程页本地镜像。
        unawaited(AmbientFeedsController.instance.onScheduleTasksChanged(payload));
      case "ws_disconnected":
      case "connection_error":
        isConnected = false;
        connection.value = false;
        notifyListeners();
      case "chat.turn_started":
      case "chat.assistant_interim":
        _openStreamingMessage(payload);
        isProcessing = true;
        notifyListeners();
      case "chat.assistant_chunk":
        _appendChunk(payload);
      case "chat.stream_reset":
        _handleStreamReset(payload);
      case "chat.media_ready":
        _handleMediaReady(payload);
      case "tool.call":
        currentToolName = payload["toolName"]?.toString().trim() ?? "";
        isProcessing = true;
        notifyListeners();
      case "tool.result":
        // 当前这把工具结束，让位给下一把（若链式调用，紧随的 tool.call 会重新置位）
        currentToolName = null;
        notifyListeners();
      case "chat.assistant_done":
        _finalizeReply(payload);
        _maybeAutoOpenTravelCard(payload);
      case "chat.error":
        isProcessing = false;
        errorMessage = payload["message"]?.toString() ?? "出错了,请重试";
        notifyListeners();
    }
  }

  /// 思考态或流式开始时,确保有一条等待中的助手消息。
  void _openStreamingMessage(Map<String, dynamic> payload) {
    if (_streamingMessageId != null) return;
    final String? traceId = payload["traceId"]?.toString();
    final String id =
        payload["messageId"]?.toString() ??
        (traceId != null && traceId.isNotEmpty ? "assistant-$traceId" : "assistant-streaming");
    messages.add(ChatMessage(
      messageId: id,
      sessionId: ApiConfig.effectiveActorId,
      role: "assistant",
      text: "",
      timestamp: DateTime.now(),
      streaming: true,
    ));
    _streamingMessageId = id;
  }

  void _appendChunk(Map<String, dynamic> payload) {
    // 2026-10-08：手机端此前是「服务端给什么就画什么」，连桌面端已有的
    // [ts:] / DSML 清洗都没接（[上一轮回复中断…[不可信内容围栏…] 事故气泡
    // 因此直透）。这里统一过一次协议帧清洗；服务端出口已净化，此层为兜底。
    final String chunk =
        stripAssistantProtocolFrames(payload["chunk"]?.toString() ?? "");
    final String? traceId = payload["traceId"]?.toString();
    final String id = payload["messageId"]?.toString() ??
        (traceId != null && traceId.isNotEmpty
            ? "assistant-$traceId"
            : "assistant-streaming");
    // 真·分绿泡：chunk 自带独立泡 id（assistant-<trace>-bN）→ 走分泡追加
    if (_isBubbleId(id)) {
      _appendBubbleChunk(id, traceId, chunk);
      return;
    }
    _openStreamingMessage(payload);
    if (chunk.isEmpty) return;
    final int idx = messages.indexWhere(
      (m) => m.messageId == _streamingMessageId,
    );
    if (idx < 0) return;
    final ChatMessage prev = messages[idx];
    messages[idx] = ChatMessage(
      messageId: prev.messageId,
      sessionId: prev.sessionId,
      role: prev.role,
      text: prev.text + chunk,
      timestamp: prev.timestamp,
      streaming: true,
      // 保留已挂上的「边说边出图」临时照片，避免后续 chunk 覆盖丢失。
      pendingMediaCards: prev.pendingMediaCards,
    );
    isProcessing = true;
    notifyListeners();
  }

  /// 真·分绿泡：分泡 chunk 追加。新泡开=旧泡完；turn_started 建的空占位
  /// （assistant-$traceId，非泡 id 且无正文）让位给第一个真泡。
  void _appendBubbleChunk(String id, String? traceId, String rawChunk) {
    final String chunk = stripAssistantProtocolFrames(rawChunk);
    if (_streamingMessageId != null &&
        _streamingMessageId != id &&
        !_isBubbleId(_streamingMessageId!)) {
      final int phIdx = messages.indexWhere(
        (m) => m.messageId == _streamingMessageId,
      );
      if (phIdx >= 0 && messages[phIdx].text.trim().isEmpty) {
        messages.removeAt(phIdx);
      }
    }
    if (chunk.isNotEmpty) {
      // 同 trace 的其他流式泡定稿（打字机收尾），新泡从头逐字
      for (int i = 0; i < messages.length; i++) {
        final ChatMessage m = messages[i];
        if (!m.streaming || m.messageId == id) continue;
        if (!_isBubbleId(m.messageId)) continue;
        if (traceId != null && traceId.isNotEmpty && _bubbleTraceOf(m.messageId) != traceId) {
          continue;
        }
        messages[i] = ChatMessage(
          messageId: m.messageId,
          sessionId: m.sessionId,
          role: m.role,
          text: m.text,
          timestamp: m.timestamp,
          pendingMediaCards: m.pendingMediaCards,
          // streaming 不带 → false：定稿
        );
      }
      final int idx = messages.indexWhere((m) => m.messageId == id);
      if (idx < 0) {
        messages.add(ChatMessage(
          messageId: id,
          sessionId: ApiConfig.effectiveActorId,
          role: "assistant",
          text: chunk,
          timestamp: DateTime.now(),
          streaming: true,
        ));
      } else {
        final ChatMessage prev = messages[idx];
        messages[idx] = ChatMessage(
          messageId: prev.messageId,
          sessionId: prev.sessionId,
          role: prev.role,
          text: prev.text + chunk,
          timestamp: prev.timestamp,
          streaming: true,
          pendingMediaCards: prev.pendingMediaCards,
        );
      }
      _streamingMessageId = id;
    }
    isProcessing = true;
    notifyListeners();
  }

  /// 会出卡片的轮次不流式（2026-10-08）：服务端确认本轮将携带结构化卡片
  /// （工具附卡/识图照片/模型自产标记）后，先撤回该 trace 已流出的正文并转
  /// 静默，最终内容由 `chat.assistant_done` 一次性结构化下发。这里清空本轮
  /// 所有流式泡的正文（保留占位泡与已挂照片），回到「生成中」观感，杜绝
  /// 「文字打一半 → done 整条重排成卡片」的跳变。
  void _handleStreamReset(Map<String, dynamic> payload) {
    final String? traceId = payload["traceId"]?.toString();
    final String mainId = (traceId != null && traceId.isNotEmpty)
        ? "assistant-$traceId"
        : (_streamingMessageId ?? "");
    if (mainId.isEmpty) return;
    bool changed = false;
    for (int i = 0; i < messages.length; i++) {
      final ChatMessage m = messages[i];
      if (!m.streaming || m.text.isEmpty) continue;
      final bool sameTrace = (m.messageId == mainId) ||
          (traceId != null && traceId.isNotEmpty && _bubbleTraceOf(m.messageId) == traceId);
      if (!sameTrace) continue;
      messages[i] = ChatMessage(
        messageId: m.messageId,
        sessionId: m.sessionId,
        role: m.role,
        text: "",
        timestamp: m.timestamp,
        streaming: true,
        mediaCards: m.mediaCards,
        renderBlocks: m.renderBlocks,
        replyBlocks: m.replyBlocks,
        pendingMediaCards: m.pendingMediaCards,
      );
      changed = true;
    }
    if (changed) notifyListeners();
  }

  /// 边说边出图：`chat.media_ready` 到达时把已搜到的照片先挂到当前流式消息上，
  /// 前端插到正在打字的正文下方实时展示；`chat.assistant_done` 后以
  /// renderBlocks 的最终顺序渲染（pendingMediaCards 被清空由最终消息接管）。
  void _handleMediaReady(Map<String, dynamic> payload) {
    final List<dynamic>? rawCards = payload["cards"] as List<dynamic>?;
    if (rawCards == null || rawCards.isEmpty) return;
    final List<Map<String, dynamic>> cards = rawCards
        .whereType<Map<String, dynamic>>()
        .toList(growable: false);
    if (cards.isEmpty) return;
    // 真·分绿泡：分泡轮次媒体照片挂到当前流式泡上（media_ready 的 messageId
    // 恒为 assistant-$traceId 基础 id，不能据此开占位消息，防幻影空泡）
    if (_streamingMessageId != null && _isBubbleId(_streamingMessageId!)) {
      final int bIdx = messages.indexWhere(
        (m) => m.messageId == _streamingMessageId,
      );
      if (bIdx >= 0) {
        final ChatMessage prev = messages[bIdx];
        messages[bIdx] = ChatMessage(
          messageId: prev.messageId,
          sessionId: prev.sessionId,
          role: prev.role,
          text: prev.text,
          timestamp: prev.timestamp,
          streaming: prev.streaming,
          pendingMediaCards: cards,
        );
        notifyListeners();
        return;
      }
    }
    _openStreamingMessage(payload);
    final int idx = messages.indexWhere(
      (m) => m.messageId == _streamingMessageId,
    );
    if (idx < 0) return;
    final ChatMessage prev = messages[idx];
    messages[idx] = ChatMessage(
      messageId: prev.messageId,
      sessionId: prev.sessionId,
      role: prev.role,
      text: prev.text,
      timestamp: prev.timestamp,
      streaming: true,
      pendingMediaCards: cards,
    );
    notifyListeners();
  }

  /// 从 `chat.assistant_done` 载荷解析结构化媒体卡片/交错渲染块。
  /// 与桌面端一致：无字段时返回 null（前端回退纯文本渲染）。
  List<Map<String, dynamic>>? _parseStructuredList(
    Map<String, dynamic> payload,
    String key,
  ) {
    final List<dynamic>? raw = payload[key] as List<dynamic>?;
    if (raw == null || raw.isEmpty) return null;
    final List<Map<String, dynamic>> out =
        raw.whereType<Map<String, dynamic>>().toList(growable: false);
    return out.isEmpty ? null : out;
  }

  void _finalizeReply(Map<String, dynamic> payload) {
    // 真·分绿泡：带 bubbles 对账数组的轮次按泡收口（不走单泡 finalText 替换）
    final List<Map<String, dynamic>>? bubbles =
        _parseStructuredList(payload, "bubbles");
    if (bubbles != null && bubbles.isNotEmpty) {
      _finalizeBubbles(payload, bubbles);
      return;
    }
    final String? traceId = payload["traceId"]?.toString();
    final String? messageId = payload["messageId"]?.toString();
    // 优先用已经打开的流式消息;否则尝试按 trace 对齐
    int idx;
    if (_streamingMessageId != null) {
      idx = messages.indexWhere((m) => m.messageId == _streamingMessageId);
    } else {
      final String traceKey =
          traceId != null && traceId.isNotEmpty ? "assistant-$traceId" : "assistant-final";
      idx = messages.indexWhere(
        (m) => m.messageId == traceKey || (messageId != null && m.messageId == messageId),
      );
    }
    final String finalText =
        stripAssistantProtocolFrames(payload["finalText"]?.toString() ?? "");
    // 结构化媒体卡片 / 交错渲染块 / 回复信封块：与桌面端一致，前端据此渲染
    // 卡片与图文交错，不再把 `[AGENT_RESULT_CARD_START]` 等标记当纯文本展示。
    final List<Map<String, dynamic>>? mediaCards =
        _parseStructuredList(payload, "mediaCards");
    // 结构化摘要卡（CONTENT_SUMMARY 通道迁移）：随 done 下发的折叠卡载荷。
    final Map<String, dynamic>? summaryCard =
        payload["summaryCard"] is Map<String, dynamic>
            ? payload["summaryCard"] as Map<String, dynamic>
            : null;
    final List<Map<String, dynamic>>? renderBlocks =
        _parseStructuredList(payload, "renderBlocks");
    final List<Map<String, dynamic>>? replyBlocks =
        _parseStructuredList(payload, "blocks");
    if (idx < 0) {
      // 没有流式占位:直接落一条最终消息（整轮只剩内部帧 → 不落空白泡）
      if (finalText.trim().isEmpty &&
          mediaCards == null &&
          summaryCard == null &&
          renderBlocks == null &&
          replyBlocks == null) {
        _streamingMessageId = null;
        currentToolName = null;
        isProcessing = false;
        notifyListeners();
        return;
      }
      messages.add(ChatMessage(
        messageId: messageId ?? "assistant-final",
        sessionId: ApiConfig.effectiveActorId,
        role: "assistant",
        text: finalText,
        timestamp: DateTime.now(),
        mediaCards: mediaCards,
        summaryCard: summaryCard,
        renderBlocks: renderBlocks,
        replyBlocks: replyBlocks,
      ));
      _persist(messages.last);
    } else {
      final ChatMessage prev = messages[idx];
      // 整轮只剩系统内部帧（服务端已判为不可见 / 本地清洗后为空）且无任何
      // 结构化产出 → 撤掉空占位泡，不留一条空白助手气泡（2026-10-08）。
      final bool nothingToShow = finalText.trim().isEmpty &&
          prev.text.trim().isEmpty &&
          mediaCards == null &&
          summaryCard == null &&
          renderBlocks == null &&
          replyBlocks == null;
      if (nothingToShow) {
        messages.removeAt(idx);
        _streamingMessageId = null;
        currentToolName = null;
        isProcessing = false;
        notifyListeners();
        return;
      }
      messages[idx] = ChatMessage(
        messageId: messageId ?? prev.messageId,
        sessionId: prev.sessionId,
        role: prev.role,
        text: finalText.isNotEmpty ? finalText : prev.text,
        timestamp: prev.timestamp,
        streaming: false,
        mediaCards: mediaCards ?? prev.mediaCards,
        summaryCard: summaryCard ?? prev.summaryCard,
        renderBlocks: renderBlocks ?? prev.renderBlocks,
        replyBlocks: replyBlocks ?? prev.replyBlocks,
      );
      _persist(messages[idx]);
    }
    _streamingMessageId = null;
    currentToolName = null;
    isProcessing = false;
    notifyListeners();
  }

  /// 真·分绿泡 done 收口：逐泡以服务端对账数组定稿；
  /// finalTextReplacesStream=true 时整轮塌缩成单泡（删除全部分泡）。
  void _finalizeBubbles(
    Map<String, dynamic> payload,
    List<Map<String, dynamic>> bubbles,
  ) {
    final String? traceId = payload["traceId"]?.toString();
    final String finalText =
        stripAssistantProtocolFrames(payload["finalText"]?.toString() ?? "");
    final String traceKey = traceId != null && traceId.isNotEmpty
        ? "assistant-$traceId"
        : "assistant-final";
    final List<Map<String, dynamic>>? mediaCards =
        _parseStructuredList(payload, "mediaCards");
    final Map<String, dynamic>? summaryCard =
        payload["summaryCard"] is Map<String, dynamic>
            ? payload["summaryCard"] as Map<String, dynamic>
            : null;
    final List<Map<String, dynamic>>? renderBlocks =
        _parseStructuredList(payload, "renderBlocks");
    final List<Map<String, dynamic>>? replyBlocks =
        _parseStructuredList(payload, "blocks");
    if (payload["finalTextReplacesStream"] == true) {
      // 塌缩：删除本轮所有分泡（含 id 对账与同 trace 兜底），落单泡 finalText
      messages.removeWhere((m) {
        final bool hit = bubbles.any((b) => b["id"]?.toString() == m.messageId) ||
            (traceId != null &&
                traceId.isNotEmpty &&
                _bubbleTraceOf(m.messageId) == traceId);
        return hit;
      });
      if (finalText.trim().isEmpty &&
          mediaCards == null &&
          summaryCard == null &&
          renderBlocks == null &&
          replyBlocks == null) {
        // 整轮只剩系统内部帧 → 塌缩后也不留空白泡
        _streamingMessageId = null;
        currentToolName = null;
        isProcessing = false;
        notifyListeners();
        return;
      }
      messages.add(ChatMessage(
        messageId: traceKey,
        sessionId: ApiConfig.effectiveActorId,
        role: "assistant",
        text: finalText,
        timestamp: DateTime.now(),
        mediaCards: mediaCards,
        summaryCard: summaryCard,
        renderBlocks: renderBlocks,
        replyBlocks: replyBlocks,
      ));
      _persist(messages.last);
      _streamingMessageId = null;
      currentToolName = null;
      isProcessing = false;
      notifyListeners();
      return;
    }
    // 正常收口：空占位让位，逐泡定稿（服务端文本为准），卡片挂末泡。
    // 多泡时块序列只留非 text 块（text 块按全文切分，挂末泡会整段复读）。
    messages.removeWhere((m) =>
        m.streaming && m.text.trim().isEmpty && !_isBubbleId(m.messageId));
    List<Map<String, dynamic>>? replyBlocksForLast = replyBlocks;
    List<Map<String, dynamic>>? renderBlocksForLast = renderBlocks;
    if (bubbles.length > 1) {
      if (replyBlocks != null) {
        final List<Map<String, dynamic>> cardOnly = replyBlocks
            .where((b) => b["type"]?.toString() != "text")
            .toList(growable: false);
        replyBlocksForLast = cardOnly.isEmpty ? null : cardOnly;
      }
      if (renderBlocks != null) {
        final List<Map<String, dynamic>> mediaOnly = renderBlocks
            .where((b) => b["type"]?.toString() != "text")
            .toList(growable: false);
        renderBlocksForLast = mediaOnly.isEmpty ? null : mediaOnly;
      }
    }
    for (int i = 0; i < bubbles.length; i++) {
      final Map<String, dynamic> b = bubbles[i];
      final String id = b["id"]?.toString() ?? "";
      if (id.isEmpty) continue;
      final bool isLast = i == bubbles.length - 1;
      final String text =
          stripAssistantProtocolFrames(b["text"]?.toString() ?? "");
      final int idx = messages.indexWhere((m) => m.messageId == id);
      if (idx < 0) {
        // 客户端漏收该泡 chunk：按对账补建（整泡只剩内部帧时不补建空泡）
        if (text.trim().isEmpty) continue;
        messages.add(ChatMessage(
          messageId: id,
          sessionId: ApiConfig.effectiveActorId,
          role: "assistant",
          text: text,
          timestamp: DateTime.now(),
          mediaCards: isLast ? mediaCards : null,
          summaryCard: isLast ? summaryCard : null,
          renderBlocks: isLast ? renderBlocksForLast : null,
          replyBlocks: isLast ? replyBlocksForLast : null,
        ));
        _persist(messages.last);
      } else {
        final ChatMessage prev = messages[idx];
        // 该泡只剩内部帧（清洗后为空）且此前也没流到正文 → 撤泡，不留空白
        if (text.trim().isEmpty && prev.text.trim().isEmpty) {
          messages.removeAt(idx);
          continue;
        }
        messages[idx] = ChatMessage(
          messageId: prev.messageId,
          sessionId: prev.sessionId,
          role: prev.role,
          text: text.isNotEmpty ? text : prev.text,
          timestamp: prev.timestamp,
          mediaCards: isLast ? (mediaCards ?? prev.mediaCards) : prev.mediaCards,
          summaryCard: isLast ? (summaryCard ?? prev.summaryCard) : prev.summaryCard,
          renderBlocks:
              isLast ? (renderBlocksForLast ?? prev.renderBlocks) : prev.renderBlocks,
          replyBlocks:
              isLast ? (replyBlocksForLast ?? prev.replyBlocks) : prev.replyBlocks,
          pendingMediaCards: isLast ? null : prev.pendingMediaCards,
          // streaming 不带 → false：定稿
        );
        _persist(messages[idx]);
      }
    }
    _streamingMessageId = null;
    currentToolName = null;
    isProcessing = false;
    notifyListeners();
  }

  /// 行程卡 autoOpen 自动展开（2026-10-12 与桌面端对齐，桌面见 main.dart
  /// done 收口的同名逻辑）：本轮产出带 autoOpen 的 travel_itinerary 卡时，
  /// 经 TravelPlanLauncher 直接打开行程规划页（handler 由 MobileHomePage
  /// 注册）。非 autoOpen 卡只展示卡面，用户点「打开行程规划」再进。
  void _maybeAutoOpenTravelCard(Map<String, dynamic> payload) {
    if (ApiConfig.isOssEdition) return;
    final String finalText =
        stripAssistantProtocolFrames(payload["finalText"]?.toString() ?? "");
    final AgentResultData? card = AgentResultParser.parse(finalText).data;
    if (card != null &&
        card.cardType == "travel_itinerary" &&
        card.autoOpen) {
      TravelPlanLauncher.open(card);
    }
  }

  @override
  void dispose() {
    unawaited(_subscription?.cancel());
    _service.close();
    connection.dispose();
    super.dispose();
  }
}