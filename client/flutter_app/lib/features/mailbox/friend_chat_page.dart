import "dart:async";

import "package:flutter/material.dart";

import "../../core/services/world_api_client.dart";
import "../../core/services/ws_chat_service.dart";

/// 好友聊天面板（内嵌右侧面板，不再全屏路由）。
///
/// 2026-10-15 闭环：历史加载与直连发送走 hub platform=friend 会话的 HTTP 面
/// （GET/POST /friends/messages），与 world.link.send_message 同一投递内核；
/// 打开面板即标读（POST /friends/messages/read），重连补投随之停止。
///
/// 2026-10-17 增量同步 + 已读回执：
/// - 服务端为会话内消息分配单调 seq，面板持有 _maxSeq 游标；收到
///   agent.peer_message 推送（含重连补投 replayed）时按 sinceSeq 增量追平，
///   离线攒多条不再只展示最后一条；
/// - 对端标读后服务端推 agent.peer_read_receipt（读取进度已翻译到本端
///   会话空间），面板把自己的 seq ≤ lastReadSeq 的气泡标「已读」。
class FriendChatPage extends StatefulWidget {
  const FriendChatPage({
    super.key,
    required this.api,
    required this.ws,
    required this.friendActorId,
    required this.friendName,
    this.onBack,
  });

  final WorldApiClient api;
  final WsChatService ws;
  final String friendActorId;
  final String friendName;

  /// 面板内返回好友列表（由 MailboxPage 注入；不传则不显示返回键）。
  final VoidCallback? onBack;

  @override
  State<FriendChatPage> createState() => _FriendChatPageState();
}

class _FriendChatPageState extends State<FriendChatPage> {
  final TextEditingController _controller = TextEditingController();
  final ScrollController _scrollController = ScrollController();

  final List<Map<String, dynamic>> _messages = [];
  bool _loading = false;
  bool _sending = false;
  String? _error;

  /// 增量拉取游标：本地已加载的最大会话内 seq（null=旧服务端无 seq，退化为整列重载）
  int? _maxSeq;
  /// 已加载消息的去重键（seq 优先，缺 seq 退化为 messageId），防重推/补拉重复上屏
  final Set<String> _knownKeys = {};
  /// 对端已读到的序号（agent.peer_read_receipt；null=尚无回执）
  int? _peerLastReadSeq;
  StreamSubscription<Map<String, dynamic>>? _wsSub;

  @override
  void initState() {
    super.initState();
    _loadHistory();
    _wsSub = widget.ws.events.listen(_onWsEvent);
  }

  @override
  void dispose() {
    _wsSub?.cancel();
    _controller.dispose();
    _scrollController.dispose();
    super.dispose();
  }

  /// hub 消息 → 本地气泡；seq 用于增量游标与已读判定
  Map<String, dynamic> _bubbleFrom(Map<String, dynamic> m) {
    final seq = (m["seq"] as num?)?.toInt();
    return <String, dynamic>{
      "text": (m["text"] ?? "").toString(),
      "isMe": m["direction"] == "outbound",
      "timestamp": (m["createdAt"] ?? "").toString(),
      if (seq != null) "seq": seq,
    };
  }

  String _keyOf(Map<String, dynamic> m) {
    final seq = (m["seq"] as num?)?.toInt();
    if (seq != null) return "s:$seq";
    return "id:${(m["externalMessageId"] ?? m["messageId"] ?? "").toString()}";
  }

  Future<void> _loadHistory() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final result = await widget.api.getFriendMessages(widget.friendActorId, limit: 100);
      final List<dynamic> raw = (result["messages"] as List<dynamic>? ?? <dynamic>[]);
      if (!mounted) return;
      setState(() {
        _messages
          ..clear()
          ..addAll(raw.whereType<Map<String, dynamic>>().map(_bubbleFrom));
        _knownKeys
          ..clear()
          ..addAll(raw.whereType<Map<String, dynamic>>().map(_keyOf));
        _maxSeq = _latestSeq(raw.whereType<Map<String, dynamic>>());
      });
      _scrollToBottom();
      // 打开面板即读：清服务端未读，重连补投不再重推；服务端随之向对端推已读回执
      unawaited(widget.api.markFriendMessagesRead(widget.friendActorId));
    } catch (e) {
      if (!mounted) return;
      setState(() => _error = "历史加载失败：$e");
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  /// 增量追平：按 sinceSeq 游标只拉新增，替代旧「收到推送就整列重载」。
  /// 重连补投（replayed=true）也走这里——离线攒的多条未读被一并补回。
  Future<void> _syncNewMessages() async {
    if (_maxSeq == null) {
      // 无游标（服务端无 seq 或游标未建立）：退化为整列重载
      await _loadHistory();
      return;
    }
    try {
      final result = await widget.api.getFriendMessages(
        widget.friendActorId,
        limit: 100,
        sinceSeq: _maxSeq,
      );
      if (!mounted) return;
      final List<dynamic> raw = (result["messages"] as List<dynamic>? ?? <dynamic>[]);
      final fresh = <Map<String, dynamic>>[];
      for (final m in raw.whereType<Map<String, dynamic>>()) {
        final key = _keyOf(m);
        if (_knownKeys.contains(key)) continue;
        _knownKeys.add(key);
        fresh.add(_bubbleFrom(m));
        final seq = (m["seq"] as num?)?.toInt();
        if (seq != null && (_maxSeq == null || seq > _maxSeq!)) _maxSeq = seq;
      }
      if (fresh.isEmpty) return;
      setState(() => _messages.addAll(fresh));
      _scrollToBottom();
      // 面板打开即视读：清未读 + 触发对端已读回执
      unawaited(widget.api.markFriendMessagesRead(widget.friendActorId));
    } catch (_) {
      // 增量同步失败静默：下次推送/手动刷新再试
    }
  }

  int? _latestSeq(Iterable<Map<String, dynamic>> raw) {
    int? max;
    for (final m in raw) {
      final seq = (m["seq"] as num?)?.toInt();
      if (seq != null && (max == null || seq > max)) max = seq;
    }
    return max ?? _maxSeq;
  }

  void _onWsEvent(Map<String, dynamic> event) {
    final String type = event["type"] as String? ?? "";
    final Map<String, dynamic> payload =
        event["payload"] as Map<String, dynamic>? ?? const {};
    if (type == "agent.peer_message") {
      // 只关心当前会话对象的推送（含重连补投 replayed）
      if ((payload["fromSessionId"] as String? ?? "") != widget.friendActorId) return;
      unawaited(_syncNewMessages());
    } else if (type == "agent.peer_read_receipt") {
      if ((payload["readerActorId"] as String? ?? "") != widget.friendActorId) return;
      final seq = (payload["lastReadSeq"] as num?)?.toInt();
      if (seq == null || !mounted) return;
      setState(() => _peerLastReadSeq = seq);
    }
  }

  void _scrollToBottom() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!_scrollController.hasClients) return;
      _scrollController.jumpTo(_scrollController.position.maxScrollExtent);
    });
  }

  Future<void> _sendMessage() async {
    final text = _controller.text.trim();
    if (text.isEmpty || _sending) return;

    setState(() => _sending = true);
    try {
      final result = await widget.api.sendFriendMessage(widget.friendActorId, text);
      if (result["ok"] != true) {
        throw Exception((result["message"] ?? result["error"] ?? "发送失败").toString());
      }
      // 服务端返回本会话内真 seq：本地气泡直接对齐服务端序号，
      // 后续增量拉取按 seq 去重不重复上屏
      final seq = (result["seq"] as num?)?.toInt();
      if (!mounted) return;
      setState(() {
        _messages.add({
          "text": text,
          "isMe": true,
          "timestamp": DateTime.now().toUtc().toIso8601String(),
          if (seq != null) "seq": seq,
        });
        if (seq != null) _knownKeys.add("s:$seq");
        _error = null;
      });
      _controller.clear();
      _scrollToBottom();
      // 游标不动，随后增量同步兜底补拉发送间隙可能漏掉的对方消息
      unawaited(_syncNewMessages());
    } catch (e) {
      if (!mounted) return;
      setState(() => _error = "发送失败：$e");
    } finally {
      if (mounted) setState(() => _sending = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);

    return Column(
      children: [
        // 面板内细头：返回 + 好友名（替代原全屏 AppBar）
        SizedBox(
          height: 40,
          child: Row(
            children: [
              if (widget.onBack != null)
                IconButton(
                  icon: const Icon(Icons.arrow_back, size: 18),
                  tooltip: "返回好友列表",
                  visualDensity: VisualDensity.compact,
                  onPressed: widget.onBack,
                ),
              Expanded(
                child: Text(
                  widget.friendName,
                  style: theme.textTheme.titleSmall,
                  overflow: TextOverflow.ellipsis,
                ),
              ),
              IconButton(
                icon: _loading
                    ? const SizedBox(
                        width: 14,
                        height: 14,
                        child: CircularProgressIndicator(strokeWidth: 2),
                      )
                    : const Icon(Icons.refresh, size: 18),
                tooltip: "刷新",
                visualDensity: VisualDensity.compact,
                onPressed: _loading ? null : _loadHistory,
              ),
            ],
          ),
        ),
        if (_error != null)
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
            child: Text(
              _error!,
              style: theme.textTheme.bodySmall?.copyWith(
                color: theme.colorScheme.error,
              ),
            ),
          ),
        // 消息列表
        Expanded(
          child: _messages.isEmpty && !_loading
              ? Center(
                  child: Column(
                    mainAxisAlignment: MainAxisAlignment.center,
                    children: [
                      Icon(
                        Icons.chat_bubble_outline,
                        size: 48,
                        color: theme.colorScheme.onSurfaceVariant,
                      ),
                      const SizedBox(height: 12),
                      Text(
                        "开始聊天吧",
                        style: theme.textTheme.bodyMedium?.copyWith(
                          color: theme.colorScheme.onSurfaceVariant,
                        ),
                      ),
                      const SizedBox(height: 4),
                      Padding(
                        padding: const EdgeInsets.symmetric(horizontal: 16),
                        child: Text(
                          "直接输入发送，或对 agent 说「给 TA 发消息」",
                          textAlign: TextAlign.center,
                          style: theme.textTheme.bodySmall?.copyWith(
                            color: theme.colorScheme.onSurfaceVariant,
                          ),
                        ),
                      ),
                    ],
                  ),
                )
              : ListView.builder(
                  controller: _scrollController,
                  padding: const EdgeInsets.all(8),
                  itemCount: _messages.length,
                  itemBuilder: (context, index) {
                    final message = _messages[index];
                    final isMe = message["isMe"] as bool? ?? false;

                    return _buildMessageBubble(message, isMe, theme);
                  },
                ),
        ),
        // 输入行（面板窄幅：仅输入框 + 发送键）
        Container(
          padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 6),
          decoration: BoxDecoration(
            color: theme.colorScheme.surface,
            border: Border(top: BorderSide(color: theme.colorScheme.outline)),
          ),
          child: Row(
            children: [
              Expanded(
                child: TextField(
                  controller: _controller,
                  style: theme.textTheme.bodySmall,
                  decoration: InputDecoration(
                    hintText: "输入消息...",
                    border: OutlineInputBorder(
                      borderRadius: BorderRadius.circular(20),
                    ),
                    contentPadding: const EdgeInsets.symmetric(
                      horizontal: 12,
                      vertical: 6,
                    ),
                  ),
                  maxLines: null,
                  textInputAction: TextInputAction.send,
                  onSubmitted: (_) => _sendMessage(),
                ),
              ),
              const SizedBox(width: 4),
              IconButton(
                icon: _sending
                    ? const SizedBox(
                        width: 18,
                        height: 18,
                        child: CircularProgressIndicator(strokeWidth: 2),
                      )
                    : const Icon(Icons.send, size: 20),
                onPressed: _sending ? null : _sendMessage,
                color: theme.colorScheme.primary,
                visualDensity: VisualDensity.compact,
              ),
            ],
          ),
        ),
      ],
    );
  }

  Widget _buildMessageBubble(
    Map<String, dynamic> message,
    bool isMe,
    ThemeData theme,
  ) {
    final text = message["text"] as String? ?? "";
    final timestamp = message["timestamp"] as String?;
    // 已读判定：对端回执的 lastReadSeq 已翻译到本端会话空间，
    // 自己的气泡 seq ≤ lastReadSeq 即对端已读
    final seq = (message["seq"] as num?)?.toInt();
    final isRead = isMe &&
        seq != null &&
        _peerLastReadSeq != null &&
        seq <= _peerLastReadSeq!;

    return Padding(
      padding: const EdgeInsets.only(bottom: 6),
      child: Row(
        mainAxisAlignment:
            isMe ? MainAxisAlignment.end : MainAxisAlignment.start,
        children: [
          if (!isMe) ...[
            CircleAvatar(
              radius: 12,
              backgroundColor: theme.colorScheme.secondaryContainer,
              child: Text(
                widget.friendName.isNotEmpty
                    ? widget.friendName[0].toUpperCase()
                    : "?",
                style: TextStyle(
                  color: theme.colorScheme.onSecondaryContainer,
                  fontSize: 10,
                ),
              ),
            ),
            const SizedBox(width: 6),
          ],
          Flexible(
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
              decoration: BoxDecoration(
                color: isMe
                    ? theme.colorScheme.primaryContainer
                    : theme.colorScheme.surfaceContainerHighest,
                borderRadius: BorderRadius.circular(10),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  if (text.isNotEmpty)
                    Text(
                      text,
                      style: theme.textTheme.bodySmall?.copyWith(
                        color: isMe
                            ? theme.colorScheme.onPrimaryContainer
                            : theme.colorScheme.onSurface,
                      ),
                    ),
                  Padding(
                    padding: const EdgeInsets.only(top: 2),
                    child: Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        if (timestamp != null && timestamp.isNotEmpty)
                          Text(
                            _formatTime(timestamp),
                            style: theme.textTheme.bodySmall?.copyWith(
                              color: theme.colorScheme.onSurfaceVariant,
                              fontSize: 9,
                            ),
                          ),
                        if (isRead) ...[
                          const SizedBox(width: 4),
                          Text(
                            "已读",
                            style: theme.textTheme.bodySmall?.copyWith(
                              color: theme.colorScheme.primary,
                              fontSize: 9,
                              fontWeight: FontWeight.w600,
                            ),
                          ),
                        ],
                      ],
                    ),
                  ),
                ],
              ),
            ),
          ),
          if (isMe) const SizedBox(width: 6),
        ],
      ),
    );
  }

  /// ISO 时间转本地 HH:mm；解析失败回退原串切片。
  String _formatTime(String iso) {
    try {
      final dt = DateTime.parse(iso).toLocal();
      return "${dt.hour.toString().padLeft(2, "0")}:${dt.minute.toString().padLeft(2, "0")}";
    } catch (_) {
      return iso.length >= 16 ? iso.substring(11, 16) : iso;
    }
  }
}

