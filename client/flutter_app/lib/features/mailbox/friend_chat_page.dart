import "dart:async";

import "package:flutter/material.dart";

import "../../core/services/world_api_client.dart";

/// 好友聊天面板（内嵌右侧面板，不再全屏路由）。
///
/// 2026-10-15 闭环：历史加载与直连发送走 hub platform=friend 会话的 HTTP 面
/// （GET/POST /friends/messages），与 world.link.send_message 同一投递内核；
/// 打开面板即标读（POST /friends/messages/read），重连补投随之停止。
/// 收到 agent.peer_message 推送时的展示由 MailboxPage 的选中联动负责。
class FriendChatPage extends StatefulWidget {
  const FriendChatPage({
    super.key,
    required this.api,
    required this.friendActorId,
    required this.friendName,
    this.onBack,
  });

  final WorldApiClient api;
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

  @override
  void initState() {
    super.initState();
    _loadHistory();
  }

  @override
  void dispose() {
    _controller.dispose();
    _scrollController.dispose();
    super.dispose();
  }

  Future<void> _loadHistory() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final result = await widget.api.getFriendMessages(widget.friendActorId, limit: 100);
      final List<dynamic> raw = (result["messages"] as List<dynamic>? ?? <dynamic>[]);
      final List<Map<String, dynamic>> loaded = raw
          .whereType<Map<String, dynamic>>()
          .map((m) => <String, dynamic>{
                "text": (m["text"] ?? "").toString(),
                "isMe": m["direction"] == "outbound",
                "timestamp": (m["createdAt"] ?? "").toString(),
              })
          .toList();
      if (!mounted) return;
      setState(() {
        _messages
          ..clear()
          ..addAll(loaded);
      });
      _scrollToBottom();
      // 打开面板即读：清服务端未读，重连补投不再重推
      unawaited(widget.api.markFriendMessagesRead(widget.friendActorId));
    } catch (e) {
      if (!mounted) return;
      setState(() => _error = "历史加载失败：$e");
    } finally {
      if (mounted) setState(() => _loading = false);
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
      if (!mounted) return;
      setState(() {
        _messages.add({
          "text": text,
          "isMe": true,
          "timestamp": DateTime.now().toUtc().toIso8601String(),
        });
        _error = null;
      });
      _controller.clear();
      _scrollToBottom();
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
                  if (timestamp != null && timestamp.isNotEmpty)
                    Padding(
                      padding: const EdgeInsets.only(top: 2),
                      child: Text(
                        _formatTime(timestamp),
                        style: theme.textTheme.bodySmall?.copyWith(
                          color: theme.colorScheme.onSurfaceVariant,
                          fontSize: 9,
                        ),
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

