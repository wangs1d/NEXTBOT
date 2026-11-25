import "dart:async";

import "dart:math" as math;
import "dart:ui" as ui;

import "package:flutter/material.dart";

import "../core/config/api_config.dart";
import "../core/presentation/user_avatar.dart";
import "../core/services/side_chat_api.dart";
import "../core/services/user_avatar_api.dart";
import "mobile_line_icons.dart";
import "mobile_theme.dart";

/// 左侧抽屉：只保留「旁聊」列表（无「选项卡」分组），设置迁到左下角。
///
/// 设计稿 2026-11-26：
/// - 288px 宽玻璃抽屉，打开时主界面整体右移、右侧留 32px 缝
/// - 头部：账号卡（头像 + 名字 + 外观/充值/反馈/设置四个入口），
///   右上角关闭键已移除，关闭走点遮罩 / 左滑
/// - 旁聊列表：标题 + 预览 + 相对时间；长按重命名 / 右侧按钮删除
/// - 列表末尾虚线「新建旁聊」卡
/// - 底部 dock：搜索旁聊输入框 · 新建旁聊
///
/// 所有操作都落到真实接口 `/api/side-chats`，无本地假数据。
class MobileSidebar extends StatefulWidget {
  const MobileSidebar({
    super.key,
    required this.onOpenChat,
    required this.onOpenSettings,
    required this.onOpenAppearance,
    required this.onOpenRecharge,
    required this.onOpenFeedback,
    this.activeSessionId,
    this.onDeleted,
  });

  /// 点某条旁聊：主壳负责切会话 + 关抽屉。
  final ValueChanged<SideChatSummary> onOpenChat;

  /// 账号卡「设置」：打开原「我的」页。
  final VoidCallback onOpenSettings;

  /// 账号卡「外观」：弹出亮色 / 暗色 / 跟随系统三选一。
  final VoidCallback onOpenAppearance;

  /// 账号卡「充值」：打开额度充值页。
  final VoidCallback onOpenRecharge;

  /// 账号卡「反馈」：弹出反馈弹窗。
  final VoidCallback onOpenFeedback;

  /// 当前激活的旁聊线程键（高亮选中项）。
  final String? activeSessionId;

  /// 删除成功回调（主壳若删的是当前旁聊则回主会话）。
  final ValueChanged<String>? onDeleted;

  @override
  State<MobileSidebar> createState() => MobileSidebarState();
}

class MobileSidebarState extends State<MobileSidebar> {
  final SideChatApi _api = SideChatApi(baseUrl: ApiConfig.httpBase);
  final UserAvatarApi _avatarApi = UserAvatarApi();
  final TextEditingController _searchInput = TextEditingController();

  List<SideChatSummary> _chats = const <SideChatSummary>[];
  bool _loading = true;
  String _query = "";
  Timer? _debounce;
  int _requestSeq = 0;

  /// 用户头像相对路径（null=未设置，渲染首字母球）；每次打开抽屉刷新，
  /// 以便在「我的」页换过头像后回来能立刻同步。
  String? _avatarPath;

  @override
  void initState() {
    super.initState();
    unawaited(reload());
  }

  @override
  void dispose() {
    _debounce?.cancel();
    _searchInput.dispose();
    super.dispose();
  }

  /// 重新拉取列表（每次打开抽屉 / 增删改后调用）。
  Future<void> reload() async {
    final int seq = ++_requestSeq;
    unawaited(_loadAvatar());
    if (mounted) setState(() => _loading = true);
    final List<SideChatSummary> list = await _api.list(query: _query);
    if (!mounted || seq != _requestSeq) return;
    setState(() {
      _chats = list;
      _loading = false;
    });
  }

  Future<void> _loadAvatar() async {
    final String? path = await _avatarApi.fetchAvatarPath();
    if (!mounted) return;
    setState(() => _avatarPath = path);
  }

  void _onSearchChanged(String value) {
    setState(() => _query = value);
    _debounce?.cancel();
    _debounce = Timer(const Duration(milliseconds: 260), () {
      unawaited(reload());
    });
  }

  Future<void> _createChat() async {
    final SideChatSummary? created = await _api.create();
    if (!mounted) return;
    if (created == null) {
      _toast("新建旁聊失败，请稍后再试");
      return;
    }
    await reload();
    if (!mounted) return;
    widget.onOpenChat(created);
  }

  Future<void> _renameChat(SideChatSummary chat) async {
    final TextEditingController name = TextEditingController(text: chat.title);
    final String? next = await showDialog<String>(
      context: context,
      builder: (BuildContext dialogContext) => AlertDialog(
        title: const Text("重命名旁聊"),
        content: TextField(
          controller: name,
          autofocus: true,
          maxLength: 40,
          decoration: const InputDecoration(hintText: "给这个旁聊起个名字"),
        ),
        actions: <Widget>[
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(),
            child: const Text("取消"),
          ),
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(name.text.trim()),
            child: const Text("保存"),
          ),
        ],
      ),
    );
    name.dispose();
    if (next == null || next.isEmpty) return;
    final SideChatSummary? updated = await _api.rename(chat.id, next);
    if (!mounted) return;
    if (updated == null) {
      _toast("重命名失败，请稍后再试");
      return;
    }
    await reload();
  }

  Future<void> _deleteChat(SideChatSummary chat) async {
    final bool? confirmed = await showDialog<bool>(
      context: context,
      builder: (BuildContext dialogContext) => AlertDialog(
        title: const Text("删除旁聊"),
        content: const Text("删除后该旁聊的独立历史会被清空，主会话不受影响。"),
        actions: <Widget>[
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(false),
            child: const Text("取消"),
          ),
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(true),
            child: const Text("删除"),
          ),
        ],
      ),
    );
    if (confirmed != true) return;
    final bool ok = await _api.delete(chat.id);
    if (!mounted) return;
    if (!ok) {
      _toast("删除失败，请稍后再试");
      return;
    }
    widget.onDeleted?.call(chat.sessionId);
    await reload();
  }

  Future<void> _showChatMenu(SideChatSummary chat) async {
    await showModalBottomSheet<void>(
      context: context,
      showDragHandle: true,
      backgroundColor: MobileTheme.of(context).surface,
      builder: (BuildContext sheetContext) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            ListTile(
              leading: const Icon(Icons.edit_outlined),
              title: const Text("重命名旁聊"),
              onTap: () {
                Navigator.of(sheetContext).pop();
                unawaited(_renameChat(chat));
              },
            ),
            ListTile(
              leading: const Icon(Icons.delete_outline_rounded),
              title: const Text("删除旁聊"),
              onTap: () {
                Navigator.of(sheetContext).pop();
                unawaited(_deleteChat(chat));
              },
            ),
          ],
        ),
      ),
    );
  }

  void _toast(String message) {
    ScaffoldMessenger.of(context)
        .showSnackBar(SnackBar(content: Text(message)));
  }

  @override
  Widget build(BuildContext context) {
    final MobilePalette p = MobileTheme.of(context);
    final bool dark = Theme.of(context).brightness == Brightness.dark;
    final Widget panel = Container(
      decoration: BoxDecoration(
        // 侧边栏用单一实底纯灰（R=G=B），不叠任何渐变/玻璃采样：
        // 渐变在深色下会被 GPU/压缩量化出色带（绿/蓝/紫色块），
        // 实底最稳，也彻底杜绝背后主界面颜色透上来。
        color: dark ? const Color(0xFF121212) : p.background,
        border: Border(
          right: BorderSide(
            color: dark
                ? Colors.white.withValues(alpha: 0.08)
                : p.divider.withValues(alpha: 0.8),
          ),
        ),
        boxShadow: dark
            ? <BoxShadow>[
                BoxShadow(
                  color: Colors.black.withValues(alpha: 0.34),
                  blurRadius: 32,
                  offset: const Offset(12, 0),
                ),
              ]
            : null,
      ),
      child: SafeArea(
        right: false,
        child: Padding(
          padding: const EdgeInsets.only(bottom: 12),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: <Widget>[
              _buildAccountCard(p),
              _buildSectionLabel(p),
              Expanded(child: _buildList(p)),
              _buildDock(p),
            ],
          ),
        ),
      ),
    );
    return panel;
  }

  /// 顶部账号卡：头像 + 名字一行，下方四个功能入口。
  Widget _buildAccountCard(MobilePalette p) {
    final bool dark = Theme.of(context).brightness == Brightness.dark;
    final String actorId = ApiConfig.effectiveActorId;
    // 与「我的」页同名规则：邮箱取 @ 前缀。
    final String displayName =
        actorId.contains("@") ? actorId.split("@").first : actorId;
    final String initial =
        displayName.isEmpty ? "U" : displayName.characters.first.toUpperCase();
    final Color fg = dark ? const Color(0xFFE8E9EE) : p.textPrimary;
    final Widget avatarFallback = Container(
      width: 48,
      height: 48,
      decoration: BoxDecoration(color: p.accent, shape: BoxShape.circle),
      alignment: Alignment.center,
      child: Text(
        initial,
        style: TextStyle(
          color: p.onAccent,
          fontSize: 18,
          fontWeight: FontWeight.w600,
        ),
      ),
    );
    return Container(
      margin: const EdgeInsets.fromLTRB(12, 12, 12, 4),
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        // 深色卡底比抽屉底(#121212)亮一档，卡片才能浮起来。
        color: dark ? const Color(0xFF1F2025) : p.surface,
        borderRadius: BorderRadius.circular(20),
        border: Border.all(
          color: dark ? Colors.white.withValues(alpha: 0.06) : p.divider,
        ),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[
          Row(
            children: <Widget>[
              UserAvatar(
                url: UserAvatarApi.resolveUrl(_avatarPath),
                size: 48,
                fallback: avatarFallback,
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Text(
                  displayName,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    fontFamily: "HarmonyOS Sans SC",
                    fontSize: 16,
                    fontWeight: FontWeight.w600,
                    color: fg,
                  ),
                ),
              ),
            ],
          ),
          const SizedBox(height: 18),
          Row(
            children: <Widget>[
              Expanded(
                child: _QuickAction(
                  // 主流做法：外观 / 显示与亮度统一用太阳，22px 下辨识度最高。
                  icon: Icons.light_mode_outlined,
                  label: "外观",
                  color: fg,
                  onTap: widget.onOpenAppearance,
                ),
              ),
              Expanded(
                child: _QuickAction(
                  icon: Icons.account_balance_wallet_outlined,
                  label: "充值",
                  color: fg,
                  onTap: widget.onOpenRecharge,
                ),
              ),
              Expanded(
                child: _QuickAction(
                  icon: Icons.feedback_outlined,
                  label: "反馈",
                  color: fg,
                  onTap: widget.onOpenFeedback,
                ),
              ),
              Expanded(
                child: _QuickAction(
                  icon: Icons.settings_outlined,
                  label: "设置",
                  color: fg,
                  onTap: widget.onOpenSettings,
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }

  Widget _buildSectionLabel(MobilePalette p) {
    final bool dark = Theme.of(context).brightness == Brightness.dark;
    final Color hintColor = dark ? const Color(0xFF5F636C) : p.textMuted;
    final Color labelColor =
        dark ? const Color(0xFF7C808B) : p.textMuted;
    return Padding(
      padding: const EdgeInsets.fromLTRB(18, 14, 18, 8),
      child: Row(
        children: <Widget>[
          Text(
            "旁聊",
            style: TextStyle(
              fontFamily: "HarmonyOS Sans SC",
              fontSize: 13,
              fontWeight: FontWeight.w500,
              letterSpacing: 0.4,
              color: labelColor,
            ),
          ),
          const Spacer(),
          Text(
            _loading ? "…" : "${_chats.length} 个",
            style: TextStyle(
              fontFamily: "HarmonyOS Sans SC",
              fontSize: 11.5,
              color: hintColor,
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildList(MobilePalette p) {
    if (_loading && _chats.isEmpty) {
      return Center(
        child: SizedBox(
          width: 18,
          height: 18,
          child: CircularProgressIndicator(strokeWidth: 2, color: p.textMuted),
        ),
      );
    }
    final List<Widget> children = <Widget>[];
    if (_chats.isEmpty) {
      children.add(
        Padding(
          padding: const EdgeInsets.fromLTRB(6, 16, 6, 4),
          child: Text(
            _query.isEmpty ? "还没有旁聊" : "没有匹配的旁聊",
            style: TextStyle(
              fontFamily: "HarmonyOS Sans SC",
              fontSize: 12.5,
              color: p.textMuted,
            ),
          ),
        ),
      );
    } else {
      // 2026-11-07 反馈：卡片不再显示「几分钟前」，改为按
      // 今天 / 最近一周 / 更早 分组（参考图第二屏的分组列表）。
      String? bucket;
      for (final SideChatSummary chat in _chats) {
        final String current = _bucketOf(chat.updatedAt);
        if (current != bucket) {
          bucket = current;
          children.add(_buildGroupLabel(p, current));
        }
        // 没有活跃旁聊时退化为高亮「最近一条」：抽屉只能从主会话打开，
        // 若严格按活跃态判断，用户在主会话里看到的将永远没有高亮（参考图 03
        // 明确要有一条高亮）。最近一条即列表第一条。
        children.add(
          _buildChatItem(
            p,
            chat,
            chat.sessionId == widget.activeSessionId ||
                (widget.activeSessionId == null && chat == _chats.first),
          ),
        );
      }
    }
    // 设计稿结构：列表末尾紧跟虚线「新建旁聊」卡（随列表滚动，不吸底）。
    children.add(const SizedBox(height: 8));
    children.add(_buildNewChatCard(p));
    return ListView(
      padding: const EdgeInsets.symmetric(horizontal: 10),
      children: children,
    );
  }

  /// 列表分组标签：今天 / 最近一周 / 更早。
  Widget _buildGroupLabel(MobilePalette p, String label) {
    final bool dark = Theme.of(context).brightness == Brightness.dark;
    return Padding(
      padding: const EdgeInsets.fromLTRB(8, 12, 8, 6),
      child: Text(
        label,
        style: TextStyle(
          fontFamily: "HarmonyOS Sans SC",
          fontSize: 13,
          fontWeight: FontWeight.w500,
          letterSpacing: 0.4,
          color: dark ? const Color(0xFF7C808B) : p.textMuted,
        ),
      ),
    );
  }

  /// 按自然日归档：今天 / 最近一周（1-6 天前）/ 更早。
  String _bucketOf(DateTime time) {
    final DateTime now = DateTime.now();
    final int days = DateTime(now.year, now.month, now.day)
        .difference(DateTime(time.year, time.month, time.day))
        .inDays;
    if (days <= 0) return "今天";
    if (days < 7) return "最近一周";
    return "更早";
  }

  Widget _buildChatItem(MobilePalette p, SideChatSummary chat, bool active) {
    final String preview = chat.preview.isEmpty ? "暂无消息" : chat.preview;
    final bool dark = Theme.of(context).brightness == Brightness.dark;
    final Color titleColor = dark ? const Color(0xFFEDEEF2) : p.textPrimary;
    final Color previewColor = dark ? const Color(0xFF8A8E98) : p.textSecondary;
    final Color iconColor = active
        ? (dark ? const Color(0xFFE9EAEF) : p.textPrimary)
        : (dark ? const Color(0xFF9A9EA8) : p.textMuted);
    return GestureDetector(
      behavior: HitTestBehavior.opaque,
      onTap: () => widget.onOpenChat(chat),
      onLongPress: () => unawaited(_showChatMenu(chat)),
      child: Container(
        margin: const EdgeInsets.only(top: 2, bottom: 2),
        padding: const EdgeInsets.fromLTRB(12, 11, 12, 12),
        decoration: BoxDecoration(
          // 选中旁聊：白 5.5% 叠层圆角卡片 + 极细白描边（参考图 03 的高亮态）。
          color: active
              ? (dark
                  ? Colors.white.withValues(alpha: 0.055)
                  : p.surface.withValues(alpha: 0.92))
              : Colors.transparent,
          borderRadius: BorderRadius.circular(14),
          border: Border.all(
            width: 1,
            color: active
                ? (dark ? Colors.white.withValues(alpha: 0.07) : p.divider)
                : Colors.transparent,
          ),
        ),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Container(
              width: 24,
              height: 24,
              alignment: Alignment.center,
              child: MobileLineIcon(
                kind: MobileLineIconKind.chat,
                size: 20,
                color: iconColor,
              ),
            ),
            const SizedBox(width: 10),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  Row(
                    children: <Widget>[
                      Flexible(
                        child: Text(
                          chat.title,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(
                            fontFamily: "HarmonyOS Sans SC",
                            fontSize: 16,
                            height: 22 / 16,
                            fontWeight: FontWeight.w700,
                            letterSpacing: 0.2,
                            color: titleColor,
                          ),
                        ),
                      ),
                      if (active) ...<Widget>[
                        const SizedBox(width: 7),
                        Container(
                          width: 6,
                          height: 6,
                          decoration: BoxDecoration(
                            shape: BoxShape.circle,
                            color: p.online,
                            boxShadow: <BoxShadow>[
                              BoxShadow(
                                color: p.online.withValues(alpha: 0.55),
                                blurRadius: 6,
                              ),
                            ],
                          ),
                        ),
                      ],
                    ],
                  ),
                  const SizedBox(height: 5),
                  Text(
                    preview,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      fontFamily: "HarmonyOS Sans SC",
                      fontSize: 13,
                      height: 18 / 13,
                      fontWeight: FontWeight.w500,
                      color: previewColor,
                    ),
                  ),
                ],
              ),
            ),
            const SizedBox(width: 8),
            // 右侧只保留可点击的删除键：卡片不再展示「几分钟前」相对时间，
            // 时间维度改由上方「今天 / 最近一周 / 更早」分组承担。
            GestureDetector(
              behavior: HitTestBehavior.opaque,
              onTap: () => unawaited(_deleteChat(chat)),
              child: Container(
                width: 28,
                height: 28,
                alignment: Alignment.center,
                decoration: BoxDecoration(
                  shape: BoxShape.circle,
                  color: dark
                      ? Colors.white.withValues(alpha: 0.05)
                      : p.surface.withValues(alpha: 0.5),
                  border: Border.all(
                    color: dark
                        ? Colors.white.withValues(alpha: 0.06)
                        : p.divider.withValues(alpha: 0.5),
                  ),
                ),
                child: Icon(
                  Icons.delete_outline_rounded,
                  size: 15,
                  color: dark ? const Color(0xFF8A8E98) : p.textMuted,
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildNewChatCard(MobilePalette p) {
    final bool dark = Theme.of(context).brightness == Brightness.dark;
    final Color dashColor = dark
        ? Colors.white.withValues(alpha: 0.13)
        : p.divider.withValues(alpha: 0.7);
    return GestureDetector(
      behavior: HitTestBehavior.opaque,
      onTap: () => unawaited(_createChat()),
      child: CustomPaint(
        painter: _DashedRRectPainter(radius: 14, color: dashColor),
        child: Container(
          margin: const EdgeInsets.only(top: 2),
          padding: const EdgeInsets.fromLTRB(12, 11, 12, 12),
          decoration: BoxDecoration(
            color: dark
                ? Colors.white.withValues(alpha: 0.025)
                : p.surface.withValues(alpha: 0.22),
            borderRadius: BorderRadius.circular(14),
          ),
          child: Row(
            children: <Widget>[
              Container(
                width: 30,
                height: 30,
                decoration: BoxDecoration(
                  shape: BoxShape.circle,
                  color: dark
                      ? Colors.white.withValues(alpha: 0.07)
                      : p.surface.withValues(alpha: 0.5),
                  border: Border.all(
                    color:
                        dark ? Colors.white.withValues(alpha: 0.08) : dashColor,
                  ),
                ),
                child: Icon(
                  Icons.add_rounded,
                  size: 15,
                  color: dark ? const Color(0xFFB7BBC5) : p.textPrimary,
                ),
              ),
              const SizedBox(width: 10),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    Text(
                      "新建旁聊",
                      style: TextStyle(
                        fontFamily: "HarmonyOS Sans SC",
                        fontSize: 15,
                        fontWeight: FontWeight.w700,
                        color: dark ? const Color(0xFFCFD2DA) : p.textPrimary,
                      ),
                    ),
                    const SizedBox(height: 3),
                    Text(
                      "独立上下文，不打断主会话",
                      style: TextStyle(
                        fontFamily: "HarmonyOS Sans SC",
                        fontSize: 12,
                        color: dark ? const Color(0xFF6A6E78) : p.textMuted,
                      ),
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _buildDock(MobilePalette p) {
    final bool dark = Theme.of(context).brightness == Brightness.dark;
    final Color fill = dark
        ? Colors.white.withValues(alpha: 0.07)
        : p.surface.withValues(alpha: 0.32);
    final Color line = dark
        ? Colors.white.withValues(alpha: 0.10)
        : p.divider.withValues(alpha: 0.65);
    final Color searchText = dark ? const Color(0xFF8B8F99) : p.textSecondary;
    return Padding(
      padding: const EdgeInsets.fromLTRB(12, 10, 12, 0),
      child: SizedBox(
        height: 42,
        child: Row(
          children: <Widget>[
            Expanded(
              child: Container(
                height: 40,
                padding: const EdgeInsets.symmetric(horizontal: 13),
                decoration: BoxDecoration(
                  color: fill.withValues(alpha: 0.06),
                  borderRadius: BorderRadius.circular(20),
                  border: Border.all(color: line.withValues(alpha: 0.08)),
                  boxShadow: dark
                      ? <BoxShadow>[
                          BoxShadow(
                            color: Colors.white.withValues(alpha: 0.05),
                            offset: const Offset(0, 1),
                            blurRadius: 0,
                          ),
                        ]
                      : null,
                ),
                child: Row(
                  children: <Widget>[
                    Icon(Icons.search_rounded, size: 16, color: searchText),
                    const SizedBox(width: 7),
                    Expanded(
                      child: TextField(
                        controller: _searchInput,
                        onChanged: _onSearchChanged,
                        style: TextStyle(
                          fontFamily: "HarmonyOS Sans SC",
                          fontSize: 12.5,
                          color: p.textPrimary,
                        ),
                        decoration: InputDecoration(
                          isCollapsed: true,
                          border: InputBorder.none,
                          hintText: "搜索旁聊",
                          hintStyle: TextStyle(
                            fontFamily: "HarmonyOS Sans SC",
                            fontSize: 12.5,
                            color: searchText,
                          ),
                        ),
                      ),
                    ),
                    if (_query.isNotEmpty)
                      GestureDetector(
                        onTap: () {
                          _searchInput.clear();
                          setState(() => _query = "");
                          unawaited(reload());
                        },
                        child: Padding(
                          padding: const EdgeInsets.only(left: 7),
                          child: Icon(
                            Icons.close_rounded,
                            size: 15,
                            color: searchText,
                          ),
                        ),
                      ),
                  ],
                ),
              ),
            ),
            const SizedBox(width: 8),
            _dockButton(
              p,
              icon: Icons.edit_outlined,
              tooltip: "新建旁聊",
              onTap: () => unawaited(_createChat()),
            ),
          ],
        ),
      ),
    );
  }

  Widget _dockButton(
    MobilePalette p, {
    required IconData icon,
    required String tooltip,
    required VoidCallback onTap,
  }) {
    final bool dark = Theme.of(context).brightness == Brightness.dark;
    return Tooltip(
      message: tooltip,
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: onTap,
        child: Container(
          width: 42,
          height: 42,
          decoration: BoxDecoration(
            color: dark
                ? Colors.white.withValues(alpha: 0.07)
                : p.surface.withValues(alpha: 0.32),
            borderRadius: BorderRadius.circular(21),
            border: Border.all(
              color: dark
                  ? Colors.white.withValues(alpha: 0.10)
                  : p.divider.withValues(alpha: 0.65),
            ),
            boxShadow: dark
                ? <BoxShadow>[
                    BoxShadow(
                      color: Colors.white.withValues(alpha: 0.09),
                      offset: const Offset(0, 1),
                      blurRadius: 0,
                    ),
                  ]
                : null,
          ),
          child: Icon(
            icon,
            size: 18,
            color: dark ? const Color(0xFFD7DAE2) : p.textPrimary,
          ),
        ),
      ),
    );
  }
}

/// 账号卡里的单个功能入口：图标在上、文案在下，四等分排布。
class _QuickAction extends StatelessWidget {
  const _QuickAction({
    required this.icon,
    required this.label,
    required this.color,
    required this.onTap,
  });

  final IconData icon;
  final String label;
  final Color color;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      behavior: HitTestBehavior.opaque,
      onTap: onTap,
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          Icon(icon, size: 22, color: color),
          const SizedBox(height: 8),
          Text(
            label,
            style: TextStyle(
              fontFamily: "HarmonyOS Sans SC",
              fontSize: 12,
              color: color,
            ),
          ),
        ],
      ),
    );
  }
}

/// 设计稿「新建旁聊」卡的 1px 虚线描边（Flutter 无内置虚线边框）。
class _DashedRRectPainter extends CustomPainter {
  const _DashedRRectPainter({required this.radius, required this.color});

  final double radius;
  final Color color;

  /// 虚线 5px、间隔 3px（与设计稿的虚线卡一致）。
  static const double dash = 5;
  static const double gap = 3;

  @override
  void paint(Canvas canvas, Size size) {
    final RRect rrect = RRect.fromRectAndRadius(
      Offset.zero & size,
      Radius.circular(radius),
    );
    final Path path = Path()..addRRect(rrect);
    final Paint paint = Paint()
      ..color = color
      ..style = PaintingStyle.stroke
      ..strokeWidth = 1;
    for (final ui.PathMetric metric in path.computeMetrics()) {
      double distance = 0;
      while (distance < metric.length) {
        final double next = math.min(distance + dash, metric.length);
        canvas.drawPath(
          metric.extractPath(distance, next),
          paint,
        );
        distance = next + gap;
      }
    }
  }

  @override
  bool shouldRepaint(covariant _DashedRRectPainter oldDelegate) {
    return oldDelegate.color != color || oldDelegate.radius != radius;
  }
}
