import "dart:async";

import "package:flutter/material.dart";

import "../../core/services/inbox_api.dart";
import "../../core/services/ws_chat_service.dart";

/// 站内信（平台/运营 → 用户的消息）收件箱页面。
///
/// 2026-11-23 好友功能整体下线：本页原是「好友 / 新朋友 / 消息」三 Tab，
/// 好友与新朋友 Tab、好友聊天页、好友 API 全部删除，只保留站内信列表
/// （InboxService 落盘，在线时经 WS inbox.message 实时提醒）。
/// 类名与构造签名保持不变，供右面板「消息」入口复用。
class MailboxPage extends StatefulWidget {
  const MailboxPage({super.key, required this.api, required this.ws});

  /// 兼容旧构造签名；站内信页不再使用 worldApi，保留参数避免调用点改动。
  final Object? api;
  final WsChatService ws;

  @override
  State<MailboxPage> createState() => _MailboxPageState();
}

class _MailboxPageState extends State<MailboxPage> {
  StreamSubscription<Map<String, dynamic>>? _wsSub;
  final InboxApi _inboxApi = InboxApi();
  List<InboxMessageItem> _inboxMessages = [];
  int _inboxUnread = 0;

  @override
  void initState() {
    super.initState();
    _wsSub = widget.ws.events.listen(_onWsEvent);
    _loadInbox();
  }

  @override
  void dispose() {
    _wsSub?.cancel();
    super.dispose();
  }

  void _onWsEvent(Map<String, dynamic> event) {
    final String type = event["type"] as String? ?? "";
    // 收到新站内信：刷新列表（即时提醒由 main.dart 的 inbox.message 处理）。
    if (type == "inbox.message" || type == "session.init") {
      _loadInbox();
    }
  }

  Future<void> _loadInbox() async {
    try {
      final result = await _inboxApi.list();
      if (!mounted) return;
      if (result.ok && result.value != null) {
        setState(() {
          _inboxMessages = result.value!.messages;
          _inboxUnread = result.value!.unreadCount;
        });
      }
    } catch (_) {
      // 站内信拉取失败不打断页面
    }
  }

  /// 打开一条站内信：详情浮层 + 标记已读
  Future<void> _openInboxMessage(InboxMessageItem message) async {
    if (!message.read) {
      unawaited(_inboxApi.markRead(ids: [message.messageId]).then((_) {
        if (mounted) _loadInbox();
      }));
    }
    if (!mounted) return;
    final theme = Theme.of(context);
    await showDialog<void>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: Text(message.title),
        content: SingleChildScrollView(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: [
              if (message.createdAt != null)
                Text(
                  message.createdAt.toString().substring(0, 19),
                  style: theme.textTheme.bodySmall?.copyWith(
                    color: theme.colorScheme.onSurfaceVariant,
                  ),
                ),
              const SizedBox(height: 12),
              SelectableText(message.body),
            ],
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(),
            child: const Text("关闭"),
          ),
        ],
      ),
    );
  }

  Widget _buildInboxList(ThemeData theme) {
    if (_inboxMessages.isEmpty) {
      return Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(Icons.mail_outline, size: 64, color: theme.colorScheme.onSurfaceVariant),
            const SizedBox(height: 16),
            Text(
              "暂无消息",
              style: theme.textTheme.titleMedium?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
              ),
            ),
          ],
        ),
      );
    }

    return RefreshIndicator(
      onRefresh: _loadInbox,
      child: ListView.builder(
        itemCount: _inboxMessages.length,
        itemBuilder: (context, index) {
          final message = _inboxMessages[index];
          final created = message.createdAt?.toString().substring(0, 19) ?? "";
          return ListTile(
            leading: CircleAvatar(
              backgroundColor: message.read
                  ? theme.colorScheme.surfaceContainerHighest
                  : theme.colorScheme.primaryContainer,
              child: Icon(
                message.kind == "announcement" ? Icons.campaign_outlined : Icons.mail_outline,
                color: message.read
                    ? theme.colorScheme.onSurfaceVariant
                    : theme.colorScheme.onPrimaryContainer,
              ),
            ),
            title: Row(
              children: [
                if (!message.read) ...[
                  Container(
                    width: 8,
                    height: 8,
                    decoration: BoxDecoration(
                      color: theme.colorScheme.primary,
                      shape: BoxShape.circle,
                    ),
                  ),
                  const SizedBox(width: 6),
                ],
                Expanded(
                  child: Text(
                    message.title,
                    style: theme.textTheme.titleSmall?.copyWith(
                      fontWeight: message.read ? FontWeight.w400 : FontWeight.w600,
                    ),
                    overflow: TextOverflow.ellipsis,
                  ),
                ),
              ],
            ),
            subtitle: Text(
              created.isNotEmpty ? "$created · ${message.body}" : message.body,
              style: theme.textTheme.bodySmall,
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
            ),
            onTap: () => _openInboxMessage(message),
          );
        },
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Container(
      color: theme.colorScheme.surface,
      child: Column(
        children: [
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
            child: Row(
              children: [
                Icon(Icons.mail_outline, size: 18, color: theme.colorScheme.onSurfaceVariant),
                const SizedBox(width: 8),
                Text(
                  _inboxUnread > 0 ? "消息 ($_inboxUnread 条未读)" : "消息",
                  style: theme.textTheme.titleSmall?.copyWith(
                    color: theme.colorScheme.onSurfaceVariant,
                  ),
                ),
              ],
            ),
          ),
          Expanded(child: _buildInboxList(theme)),
        ],
      ),
    );
  }
}
