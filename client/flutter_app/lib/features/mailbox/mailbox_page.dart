import "dart:async";

import "package:flutter/material.dart";

import "../../core/config/api_config.dart";
import "../../core/presentation/emotion_ball_ids.dart";
import "../../core/services/inbox_api.dart";
import "../../core/services/world_api_client.dart";
import "../../core/services/ws_chat_service.dart";
import "../chat/emotion_ball_view.dart";
import "friend_chat_page.dart";

/// 邮箱Tab主页面：包含好友列表、好友请求、聊天功能
class MailboxPage extends StatefulWidget {
  const MailboxPage({super.key, required this.api, required this.ws});

  final WorldApiClient api;
  final WsChatService ws;

  @override
  State<MailboxPage> createState() => _MailboxPageState();
}

class _MailboxPageState extends State<MailboxPage> with SingleTickerProviderStateMixin {
  late TabController _tabController;
  StreamSubscription<Map<String, dynamic>>? _wsSub;

  bool _loading = false;
  bool _serverOffline = false;
  List<Map<String, dynamic>> _friends = [];
  List<Map<String, dynamic>> _allRequests = [];
  // 当前选中的好友（双面板形态：选中后面板内切换到聊天视图，不再全屏路由）
  Map<String, dynamic>? _selectedFriend;
  // 站内信（平台→用户收件箱；服务端 InboxService 落盘，在线时经 WS 实时提醒）
  final InboxApi _inboxApi = InboxApi();
  List<InboxMessageItem> _inboxMessages = [];
  int _inboxUnread = 0;

  // 预定义常量
  static const EdgeInsets _cardMargin = EdgeInsets.symmetric(horizontal: 12, vertical: 4);
  static const EdgeInsets _cardPadding = EdgeInsets.all(12);

  @override
  void initState() {
    super.initState();
    _tabController = TabController(length: 3, vsync: this);
    _wsSub = widget.ws.events.listen(_onWsEvent);
    _loadData();
  }

  @override
  void dispose() {
    _wsSub?.cancel();
    _tabController.dispose();
    super.dispose();
  }

  void _onWsEvent(Map<String, dynamic> event) {
    final String type = event["type"] as String? ?? "";
    // WebSocket 重连成功时自动刷新好友数据
    if (type == "session.init" && _serverOffline) {
      _loadData();
    }
    // 收到新站内信：刷新列表（全局提醒由 main.dart 的 inbox.message 处理）
    if (type == "inbox.message") {
      _loadInbox();
    }
    // 收到好友的站内消息（agent.peer_message）：若在列表里则直接切到该聊天
    if (type == "agent.peer_message") {
      final payload = event["payload"] as Map<String, dynamic>? ?? const {};
      final fromSessionId = payload["fromSessionId"] as String? ?? "";
      final friend = _friends.firstWhere(
        (f) => (f["friendActorId"] as String? ?? "") == fromSessionId,
        orElse: () => const {},
      );
      if (friend.isNotEmpty && mounted) {
        setState(() => _selectedFriend = friend);
      }
      if (friend.isNotEmpty) _loadData();
    }
  }

  Future<void> _loadData() async {
    setState(() => _loading = true);
    try {
      await Future.wait([
        _loadFriends(),
        _loadAllRequests(),
        _loadInbox(),
      ]);
    } catch (_) {
    } finally {
      if (mounted) {
        setState(() => _loading = false);
      }
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
          _serverOffline = false;
        });
      }
    } catch (_) {
      // 站内信拉取失败不打断好友列表展示（未设 _serverOffline）
    }
  }

  Future<void> _loadFriends() async {
    try {
      final result = await widget.api.getFriendsList();
      if (!mounted) return;
      if (result["ok"] == true) {
        setState(() {
          _friends = List<Map<String, dynamic>>.from(result["friends"] ?? []);
          _serverOffline = false;
        });
      }
    } catch (e) {
      if (!mounted) return;
      if (_isNetworkError(e)) {
        setState(() => _serverOffline = true);
      }
    }
  }

  Future<void> _loadAllRequests() async {
    try {
      final result = await widget.api.getAllFriendRequests();
      if (!mounted) return;
      if (result["ok"] == true) {
        setState(() {
          _allRequests = List<Map<String, dynamic>>.from(result["requests"] ?? []);
          _serverOffline = false;
        });
      }
    } catch (e) {
      if (!mounted) return;
      if (_isNetworkError(e)) {
        setState(() => _serverOffline = true);
      }
    }
  }

  bool _isNetworkError(Object error) {
    final String msg = error.toString();
    return msg.contains("Failed to fetch") ||
        msg.contains("ClientException") ||
        msg.contains("SocketException") ||
        msg.contains("Connection refused");
  }

  /// 发好友申请：凭证是对方注册即得的身份号码（QQ 式数字短号），不靠邮箱。
  Future<void> _showAddFriendDialog() async {
    final idController = TextEditingController();
    final msgController = TextEditingController();
    final ok = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: const Text("添加好友"),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            TextField(
              controller: idController,
              autofocus: true,
              keyboardType: TextInputType.number,
              decoration: const InputDecoration(
                labelText: "对方身份号码",
                hintText: "6–8 位数字短号，在对方主页名字下方复制",
              ),
            ),
            const SizedBox(height: 12),
            TextField(
              controller: msgController,
              decoration: const InputDecoration(
                labelText: "验证留言（可选）",
                hintText: "一句话说明你是谁",
              ),
            ),
          ],
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(false),
            child: const Text("取消"),
          ),
          FilledButton(
            onPressed: () => Navigator.of(dialogContext).pop(true),
            child: const Text("发送申请"),
          ),
        ],
      ),
    );
    if (ok != true || !mounted) return;

    final toActorId = idController.text.trim();
    if (!RegExp(r"^[1-9]\d{5,7}$").hasMatch(toActorId)) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text("请填对方 6–8 位的数字身份号码（好友凭证是号码，不是邮箱）")),
      );
      return;
    }
    final message = msgController.text.trim();
    try {
      final result = await widget.api.sendFriendRequest(
        toActorId,
        message: message.isEmpty ? null : message,
      );
      if (!mounted) return;
      if (result["ok"] == true) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text("好友申请已发出")),
        );
        await _loadData();
      } else {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text(result["message"] ?? "发送失败")),
        );
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text("发送失败: $e")),
        );
      }
    }
  }

  Future<void> _acceptRequest(String requestId) async {
    try {
      final result = await widget.api.respondToFriendRequest(requestId, true);
      if (result["ok"] == true) {
        if (mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(content: Text("已接受好友请求")),
          );
          await _loadData();
        }
      } else {
        if (mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(content: Text(result["message"] ?? "操作失败")),
          );
        }
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text("操作失败: $e")),
        );
      }
    }
  }

  Future<void> _rejectRequest(String requestId) async {
    try {
      final result = await widget.api.respondToFriendRequest(requestId, false);
      if (result["ok"] == true) {
        if (mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(content: Text("已拒绝好友请求")),
          );
          await _loadData();
        }
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text("操作失败: $e")),
        );
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);

    // 双面板形态：选中好友后面板内切换到聊天视图（返回键回列表），不再全屏路由
    final selected = _selectedFriend;
    if (selected != null) {
      final displayName =
          selected["displayName"] as String? ?? selected["friendActorId"] as String;
      return Container(
        color: theme.colorScheme.surface,
        child: FriendChatPage(
          api: widget.api,
          ws: widget.ws,
          friendActorId: selected["friendActorId"] as String,
          friendName: displayName,
          onBack: () => setState(() => _selectedFriend = null),
        ),
      );
    }

    return Container(
      color: theme.colorScheme.surface,
      child: Column(
        children: [
          // 右上角「添加好友」入口（空态文案指向的 + 就在这里）
          SizedBox(
            height: 34,
            child: Row(
              mainAxisAlignment: MainAxisAlignment.end,
              children: [
                IconButton(
                  tooltip: "添加好友",
                  icon: const Icon(Icons.person_add_alt_outlined, size: 18),
                  color: theme.colorScheme.onSurfaceVariant,
                  onPressed: _showAddFriendDialog,
                ),
                const SizedBox(width: 6),
              ],
            ),
          ),
          TabBar(
            controller: _tabController,
            tabs: [
              const Tab(text: "好友"),
              const Tab(text: "新朋友"),
              Tab(text: _inboxUnread > 0 ? "消息 ($_inboxUnread)" : "消息"),
            ],
          ),
          Expanded(
            child: TabBarView(
              controller: _tabController,
              children: [
                _buildFriendsList(theme),
                _buildNewFriendsList(theme),
                _buildInboxList(theme),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildFriendsList(ThemeData theme) {
    if (_loading && _friends.isEmpty) {
      return const Center(child: CircularProgressIndicator());
    }

    if (_serverOffline) {
      return _buildOfflineHint(theme);
    }

    if (_friends.isEmpty) {
      return Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(Icons.people_outline, size: 64, color: theme.colorScheme.onSurfaceVariant),
            const SizedBox(height: 16),
            Text(
              "暂无好友",
              style: theme.textTheme.titleMedium?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
              ),
            ),
            const SizedBox(height: 8),
            Text(
              "点击右上角 + 添加好友",
              style: theme.textTheme.bodySmall?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
              ),
            ),
          ],
        ),
      );
    }

    return RefreshIndicator(
      onRefresh: _loadData,
      child: ListView.builder(
        itemCount: _friends.length,
        itemBuilder: (context, index) {
          final friend = _friends[index];
          final displayName = friend["displayName"] as String? ?? friend["friendActorId"] as String;
          final agentNumber = (friend["agentNumber"] as String?)?.trim();

          return ListTile(
            selected: _selectedFriend?["friendActorId"] == friend["friendActorId"],
            leading: CircleAvatar(
              backgroundColor: theme.colorScheme.primaryContainer,
              child: Text(
                displayName.isNotEmpty ? displayName[0].toUpperCase() : "?",
                style: TextStyle(color: theme.colorScheme.onPrimaryContainer),
              ),
            ),
            title: Text(displayName),
            // 副行显示对方身份号码（添加好友的凭证）；标题已是号码时不重复，也不再直出邮箱
            subtitle: agentNumber != null && agentNumber.isNotEmpty && agentNumber != displayName
                ? Text("身份号码 $agentNumber", style: theme.textTheme.bodySmall)
                : null,
            // 整行即点选目标：面板内切到该好友的聊天视图
            onTap: () => setState(() => _selectedFriend = friend),
          );
        },
      ),
    );
  }

  Widget _buildNewFriendsList(ThemeData theme) {
    if (_loading && _allRequests.isEmpty) {
      return const Center(child: CircularProgressIndicator());
    }

    if (_serverOffline) {
      return _buildOfflineHint(theme);
    }

    if (_allRequests.isEmpty) {
      return Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(Icons.people_outline, size: 64, color: theme.colorScheme.onSurfaceVariant),
            const SizedBox(height: 16),
            Text(
              "暂无新朋友",
              style: theme.textTheme.titleMedium?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
              ),
            ),
            const SizedBox(height: 8),
            Text(
              "点击右上角 + 添加好友",
              style: theme.textTheme.bodySmall?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
              ),
            ),
          ],
        ),
      );
    }

    return RefreshIndicator(
      onRefresh: _loadAllRequests,
      child: ListView.builder(
        itemCount: _allRequests.length,
        itemBuilder: (context, index) {
          final request = _allRequests[index];
          final fromActorId = request["fromActorId"] as String;
          final toActorId = request["toActorId"] as String;
          final status = request["status"] as String?;
          final message = request["message"] as String?;
          final createdAt = request["createdAt"] as String?;
          
          // 判断是收到的还是发出的请求
          final bool isIncoming = fromActorId != ApiConfig.effectiveActorId;
          final String otherActorId = isIncoming ? fromActorId : toActorId;
          // 对方名字：服务端已解析成昵称（按身份短号添加时 actorId 是邮箱，不能当名字显示）
          final String otherName =
              (request["displayName"] as String?)?.trim().isNotEmpty == true
                  ? (request["displayName"] as String).trim()
                  : otherActorId;
          final String? otherNumber = (request["agentNumber"] as String?)?.trim();

          return Card(
            margin: _cardMargin,
            child: Padding(
              padding: _cardPadding,
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      CircleAvatar(
                        backgroundColor: isIncoming 
                            ? theme.colorScheme.secondaryContainer
                            : theme.colorScheme.tertiaryContainer,
                        child: Text(
                          otherName.isNotEmpty ? otherName[0].toUpperCase() : "?",
                          style: TextStyle(
                            color: isIncoming 
                                ? theme.colorScheme.onSecondaryContainer
                                : theme.colorScheme.onTertiaryContainer,
                          ),
                        ),
                      ),
                      const SizedBox(width: 12),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Row(
                              children: [
                                Expanded(
                                  child: Text(
                                    otherName,
                                    style: theme.textTheme.titleSmall,
                                    overflow: TextOverflow.ellipsis,
                                  ),
                                ),
                                const SizedBox(width: 8),
                                Container(
                                  padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                                  decoration: BoxDecoration(
                                    color: isIncoming
                                        ? theme.colorScheme.secondaryContainer
                                        : theme.colorScheme.tertiaryContainer,
                                    borderRadius: BorderRadius.circular(4),
                                  ),
                                  child: Text(
                                    isIncoming ? "收到" : "发出",
                                    style: theme.textTheme.bodySmall?.copyWith(
                                      fontSize: 10,
                                      color: isIncoming
                                          ? theme.colorScheme.onSecondaryContainer
                                          : theme.colorScheme.onTertiaryContainer,
                                    ),
                                  ),
                                ),
                              ],
                            ),
                            if (otherNumber != null && otherNumber.isNotEmpty && otherNumber != otherName)
                              Text(
                                "身份号码 $otherNumber",
                                style: theme.textTheme.bodySmall?.copyWith(
                                  color: theme.colorScheme.onSurfaceVariant,
                                ),
                              ),
                            if (createdAt != null)
                              Text(
                                DateTime.parse(createdAt).toString().substring(0, 19),
                                style: theme.textTheme.bodySmall?.copyWith(
                                  color: theme.colorScheme.onSurfaceVariant,
                                ),
                              ),
                          ],
                        ),
                      ),
                    ],
                  ),
                  if (message != null && message.isNotEmpty) ...[
                    const SizedBox(height: 8),
                    Container(
                      padding: const EdgeInsets.all(8),
                      decoration: BoxDecoration(
                        color: theme.colorScheme.surfaceContainerHighest,
                        borderRadius: BorderRadius.circular(8),
                      ),
                      child: Text(
                        message,
                        style: theme.textTheme.bodySmall,
                      ),
                    ),
                  ],
                  // 状态显示
                  if (!isIncoming || status != "pending") ...[
                    const SizedBox(height: 8),
                    _buildStatusChip(status, theme),
                  ],
                  // 操作按钮（仅对收到的待处理请求显示）
                  if (isIncoming && status == "pending") ...[
                    const SizedBox(height: 12),
                    Row(
                      mainAxisAlignment: MainAxisAlignment.end,
                      children: [
                        TextButton(
                          onPressed: () => _rejectRequest(request["requestId"] as String),
                          child: const Text("拒绝"),
                        ),
                        const SizedBox(width: 8),
                        FilledButton(
                          onPressed: () => _acceptRequest(request["requestId"] as String),
                          child: const Text("接受"),
                        ),
                      ],
                    ),
                  ],
                ],
              ),
            ),
          );
        },
      ),
    );
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
    if (_loading && _inboxMessages.isEmpty) {
      return const Center(child: CircularProgressIndicator());
    }

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
      onRefresh: _loadData,
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

  Widget _buildOfflineHint(ThemeData theme) {
    return Center(
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          // 出错表情小球替代静态云朵图标(体色随 error 色)。
          EmotionBallView(
            emotion: EmotionBallIds.error,
            size: 96,
            bodyColor: theme.colorScheme.error,
          ),
          const SizedBox(height: 16),
          Text(
            "无法连接服务器",
            style: theme.textTheme.titleMedium?.copyWith(
              color: theme.colorScheme.error,
            ),
          ),
          const SizedBox(height: 8),
          Text(
            "请先启动 server：npm run dev:server",
            style: theme.textTheme.bodySmall?.copyWith(
              color: theme.colorScheme.onSurfaceVariant,
            ),
          ),
          const SizedBox(height: 16),
          FilledButton.tonal(
            onPressed: _loadData,
            child: const Text("重试"),
          ),
        ],
      ),
    );
  }

  Widget _buildStatusChip(String? status, ThemeData theme) {
    String statusText = "";
    Color statusColor = theme.colorScheme.onSurfaceVariant;
    Color containerColor = theme.colorScheme.surfaceContainerHighest;
    
    switch (status) {
      case "pending":
        statusText = "等待对方回应";
        statusColor = theme.colorScheme.primary;
        containerColor = theme.colorScheme.primaryContainer;
        break;
      case "accepted":
        statusText = "已接受";
        statusColor = theme.colorScheme.tertiary;
        containerColor = theme.colorScheme.tertiaryContainer;
        break;
      case "rejected":
        statusText = "已拒绝";
        statusColor = theme.colorScheme.error;
        containerColor = theme.colorScheme.errorContainer;
        break;
      case "cancelled":
        statusText = "已取消";
        statusColor = theme.colorScheme.onSurfaceVariant;
        containerColor = theme.colorScheme.surfaceContainerHighest;
        break;
    }

    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
      decoration: BoxDecoration(
        color: containerColor,
        borderRadius: BorderRadius.circular(12),
      ),
      child: Text(
        statusText,
        style: theme.textTheme.bodySmall?.copyWith(
          color: statusColor,
          fontWeight: FontWeight.w500,
        ),
      ),
    );
  }
}
