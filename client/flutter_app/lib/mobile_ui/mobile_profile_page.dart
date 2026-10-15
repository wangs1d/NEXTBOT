import "dart:async";
import "dart:typed_data";

import "package:flutter/material.dart";
import "package:image_picker/image_picker.dart";

import "../core/config/api_config.dart";
import "../core/presentation/user_avatar.dart";
import "../core/services/user_avatar_api.dart";
import "../features/help/feedback_dialog.dart";
import "mobile_chat_controller.dart";
import "mobile_model_catalog_page.dart";
import "mobile_service_access_page.dart";
import "mobile_theme.dart";

/// 手机端「我的」页:全功能二级菜单聚合。
///
/// - 顶部账号卡片：头像(点击可设置) + 名称(与桌面端同源：邮箱前缀) + 实时连接状态
/// - 功能：模型目录(只读) / 服务接入(内测 byok:模型+TTS 密钥)
/// - 设置：主题(亮 / 暗 / 跟随系统)、帮助与反馈
/// - 账号：退出登录
/// （邮箱/消息中心入口已删除（2026-10-14）：消息统一后台扫描，agent 判定
///   有价值后才主动推送，不再提供前端陈列入口）
/// （每日简报/设备/审批/购物目录已按内测范围裁撤，功能面保留在桌面端）
class MobileProfilePage extends StatefulWidget {
  const MobileProfilePage({
    super.key,
    required this.chatController,
    this.themeMode,
    this.onThemeModeChanged,
    this.onLogout,
  });

  /// 共享对话控制器(连接状态展示 + WS 服务复用)。
  final MobileChatController chatController;

  /// 当前主题模式(null 时隐藏主题设置行,如嵌入测试)。
  final ThemeMode? themeMode;

  /// 切换主题模式。
  final ValueChanged<ThemeMode>? onThemeModeChanged;

  /// 退出登录。
  final VoidCallback? onLogout;

  @override
  State<MobileProfilePage> createState() => _MobileProfilePageState();
}

class _MobileProfilePageState extends State<MobileProfilePage> {
  final UserAvatarApi _avatarApi = UserAvatarApi();
  final ImagePicker _imagePicker = ImagePicker();

  /// 用户头像相对路径（服务端 /agent/avatars/...；null=未设置）。
  String? _userAvatarPath;

  @override
  void initState() {
    super.initState();
    unawaited(_loadAvatar());
    widget.chatController.addListener(_onChatChanged);
  }

  @override
  void didUpdateWidget(MobileProfilePage oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (widget.chatController != oldWidget.chatController) {
      oldWidget.chatController.removeListener(_onChatChanged);
      widget.chatController.addListener(_onChatChanged);
    }
  }

  @override
  void dispose() {
    widget.chatController.removeListener(_onChatChanged);
    super.dispose();
  }

  void _onChatChanged() {
    if (mounted) setState(() {});
  }

  /// 拉取当前账号头像（非关键链路：失败静默，账号卡回退首字母球）。
  Future<void> _loadAvatar() async {
    final String? path = await _avatarApi.fetchAvatarPath();
    if (!mounted || path == _userAvatarPath) return;
    setState(() => _userAvatarPath = path);
  }

  /// 点击账号卡头像：拉起系统相册选择器选图 → 上传 → 即时刷新。
  ///
  /// 必须走系统相册（Photo Picker）而非 SAF 文件选择器：后者按文件树浏览，
  /// 相册里大部分照片（云端、第三方应用目录等）找不到。
  Future<void> _setAvatar() async {
    final XFile? picked;
    try {
      picked = await _imagePicker.pickImage(source: ImageSource.gallery);
    } on Exception {
      // 极少数机型选择器拉起失败（如后台被杀），不影响页面其余功能。
      if (!mounted) return;
      _toast("无法打开相册，请稍后再试");
      return;
    }
    if (picked == null) return;
    Uint8List? bytes;
    try {
      bytes = await picked.readAsBytes();
    } on Exception {
      // 系统缓存文件被清理等小概率场景。
    }
    if (bytes == null || bytes.isEmpty) {
      if (!mounted) return;
      _toast("读取图片失败，请换一张试试");
      return;
    }
    final String? path = await _avatarApi.uploadAvatar(bytes, picked.name);
    if (!mounted) return;
    if (path == null) {
      _toast("头像上传失败，请稍后再试");
      return;
    }
    setState(() => _userAvatarPath = path);
    _toast("头像已更新");
  }

  void _toast(String message) {
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(message)));
  }

  /// 二级页统一包装:顶栏带返回键(被复用的桌面面板页自身无返回出口,
  /// 手机端依赖系统返回手势不够直观)。自带 AppBar 的页面(模型目录/
  /// 服务接入)直接 push,避免出现双层顶栏+双返回按钮。
  Future<void> _push(Widget page, String title, {bool wrapped = true}) async {
    await Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (BuildContext ctx) => wrapped
            ? Scaffold(
                backgroundColor: MobileTheme.of(ctx).background,
                appBar: AppBar(title: Text(title)),
                body: page,
              )
            : page,
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final MobilePalette p = MobileTheme.of(context);
    final bool connected = widget.chatController.isConnected;
    return Scaffold(
      backgroundColor: p.background,
      appBar: AppBar(
        title: const Text("我的"),
        automaticallyImplyLeading: false,
      ),
      body: ListView(
        padding: const EdgeInsets.symmetric(vertical: 8),
        children: [
          _AccountCard(
            actorId: ApiConfig.effectiveActorId,
            connected: connected,
            avatarUrl: UserAvatarApi.resolveUrl(_userAvatarPath),
            onChangeAvatar: _setAvatar,
          ),
          const SizedBox(height: 16),
          _GroupLabel(label: "功能"),
          _SectionCard(
            children: [
              _ListRow(
                leading: Icon(Icons.tune_outlined, color: p.textSecondary, size: 22),
                title: "服务接入",
                trailing: Icon(Icons.chevron_right, color: p.textMuted, size: 20),
                onTap: () => _push(
                    const MobileServiceAccessPage(), "服务接入", wrapped: false),
              ),
              _divider(context),
              _ListRow(
                leading: Icon(Icons.memory_outlined, color: p.textSecondary, size: 22),
                title: "模型目录",
                trailing: Icon(Icons.chevron_right, color: p.textMuted, size: 20),
                onTap: () => _push(const MobileModelCatalogPage(), "模型目录", wrapped: false),
              ),
            ],
          ),
          const SizedBox(height: 16),
          _GroupLabel(label: "设置"),
          _SectionCard(
            children: [
              if (widget.themeMode != null && widget.onThemeModeChanged != null) ...<Widget>[
                _ThemeModeRow(
                  themeMode: widget.themeMode!,
                  onChanged: widget.onThemeModeChanged!,
                ),
                _divider(context),
              ],
              _ListRow(
                leading: Icon(Icons.help_outline, color: p.textSecondary, size: 22),
                title: "帮助与反馈",
                trailing: Icon(Icons.chevron_right, color: p.textMuted, size: 20),
                onTap: _showFeedback,
              ),
            ],
          ),
          const SizedBox(height: 16),
          _GroupLabel(label: "关于"),
          _SectionCard(
            children: [
              _ListRow(
                leading: Icon(Icons.info_outline, color: p.textSecondary, size: 22),
                title: "版本",
                trailing: Text(
                  "1.0.0",
                  style: TextStyle(color: p.textMuted, fontSize: 14),
                ),
                onTap: () {},
              ),
              if (widget.onLogout != null) ...<Widget>[
                _divider(context),
                _ListRow(
                  leading: Icon(Icons.logout, color: Theme.of(context).colorScheme.error, size: 22),
                  title: "退出登录",
                  titleColor: Theme.of(context).colorScheme.error,
                  onTap: () => _confirmLogout(context),
                ),
              ],
            ],
          ),
          const SizedBox(height: 24),
          Center(
            child: Text(
              "NEXTBOT · 手机端",
              style: TextStyle(color: p.textMuted, fontSize: 12),
            ),
          ),
        ],
      ),
    );
  }

  Widget _divider(BuildContext context) {
    return Divider(height: 1, indent: 52, color: MobileTheme.of(context).divider);
  }

  void _showFeedback() {
    showDialog<void>(
      context: context,
      builder: (BuildContext ctx) => const FeedbackDialog(),
    );
  }

  void _confirmLogout(BuildContext context) {
    showDialog<void>(
      context: context,
      builder: (BuildContext ctx) {
        return AlertDialog(
          title: const Text("退出登录"),
          content: const Text(
            "退出后会断开连接并返回登录页。\n\n"
            "同一邮箱重新登录即可同步该账号的全部数据。",
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.of(ctx).pop(),
              child: const Text("取消"),
            ),
            TextButton(
              onPressed: () {
                Navigator.of(ctx).pop();
                widget.onLogout!();
                ScaffoldMessenger.of(context).showSnackBar(
                  const SnackBar(content: Text("已退出登录,会话已清空")),
                );
              },
              child: const Text("退出"),
            ),
          ],
        );
      },
    );
  }
}

/// 顶部账号卡片。名称与桌面端侧栏同源：登录邮箱取 `@` 前缀。
class _AccountCard extends StatelessWidget {
  const _AccountCard({
    required this.actorId,
    required this.connected,
    this.avatarUrl,
    this.onChangeAvatar,
  });

  final String actorId;
  final bool connected;

  /// 用户头像绝对 URL（null=未设置，渲染首字母球）。
  final String? avatarUrl;

  /// 点击头像更换头像（null 时不可点）。
  final VoidCallback? onChangeAvatar;

  @override
  Widget build(BuildContext context) {
    final MobilePalette p = MobileTheme.of(context);
    // 与桌面端侧栏同名规则：邮箱取 @ 前缀（桌面 main.dart userName 同源）。
    final String displayName =
        actorId.contains("@") ? actorId.split("@").first : actorId;
    final String initial =
        displayName.isEmpty ? "U" : displayName.characters.first.toUpperCase();
    final Widget avatarFallback = Container(
      width: 52,
      height: 52,
      decoration: BoxDecoration(
        color: p.accent,
        shape: BoxShape.circle,
      ),
      alignment: Alignment.center,
      child: Text(
        initial,
        style: TextStyle(
          color: p.onAccent,
          fontSize: 20,
          fontWeight: FontWeight.w600,
        ),
      ),
    );
    final Widget avatar = onChangeAvatar == null
        ? UserAvatar(url: avatarUrl, size: 52, fallback: avatarFallback)
        : GestureDetector(
            onTap: onChangeAvatar,
            child: Tooltip(
              message: "点击设置头像",
              child: UserAvatar(url: avatarUrl, size: 52, fallback: avatarFallback),
            ),
          );
    final Color statusColor = connected ? const Color(0xFF34C759) : p.textMuted;
    return Container(
      margin: const EdgeInsets.symmetric(horizontal: 16),
      padding: const EdgeInsets.all(18),
      decoration: BoxDecoration(
        color: p.surface,
        borderRadius: BorderRadius.circular(20),
      ),
      child: Row(
        children: [
          avatar,
          const SizedBox(width: 14),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  displayName,
                  style: TextStyle(
                    color: p.textPrimary,
                    fontSize: 16,
                    fontWeight: FontWeight.w600,
                  ),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
                const SizedBox(height: 6),
                Row(
                  children: [
                    Container(
                      width: 7,
                      height: 7,
                      decoration: BoxDecoration(color: statusColor, shape: BoxShape.circle),
                    ),
                    const SizedBox(width: 6),
                    Text(
                      connected ? "已连接" : "未连接",
                      style: TextStyle(color: p.textSecondary, fontSize: 12),
                    ),
                  ],
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _GroupLabel extends StatelessWidget {
  const _GroupLabel({required this.label});

  final String label;

  @override
  Widget build(BuildContext context) {
    final MobilePalette p = MobileTheme.of(context);
    return Padding(
      padding: const EdgeInsets.fromLTRB(20, 4, 20, 8),
      child: Text(
        label,
        style: TextStyle(
          color: p.textSecondary,
          fontSize: 13,
          fontWeight: FontWeight.w500,
        ),
      ),
    );
  }
}

class _SectionCard extends StatelessWidget {
  const _SectionCard({required this.children});

  final List<Widget> children;

  @override
  Widget build(BuildContext context) {
    final MobilePalette p = MobileTheme.of(context);
    return Container(
      margin: const EdgeInsets.symmetric(horizontal: 16),
      decoration: BoxDecoration(
        color: p.surface,
        borderRadius: BorderRadius.circular(18),
      ),
      clipBehavior: Clip.antiAlias,
      child: Column(
        children: children,
      ),
    );
  }
}

class _ListRow extends StatelessWidget {
  const _ListRow({
    required this.leading,
    required this.title,
    this.trailing,
    this.titleColor,
    required this.onTap,
  });

  final Widget leading;
  final String title;
  final Widget? trailing;
  final Color? titleColor;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final MobilePalette p = MobileTheme.of(context);
    return InkWell(
      onTap: onTap,
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
        child: Row(
          children: [
            SizedBox(width: 28, child: leading),
            const SizedBox(width: 12),
            Expanded(
              child: Text(
                title,
                style: TextStyle(
                  color: titleColor ?? p.textPrimary,
                  fontSize: 15,
                  fontWeight: FontWeight.w500,
                ),
              ),
            ),
            if (trailing != null) trailing!,
          ],
        ),
      ),
    );
  }
}

/// 主题三选一行组。
class _ThemeModeRow extends StatelessWidget {
  const _ThemeModeRow({required this.themeMode, required this.onChanged});

  final ThemeMode themeMode;
  final ValueChanged<ThemeMode> onChanged;

  @override
  Widget build(BuildContext context) {
    final MobilePalette p = MobileTheme.of(context);
    const List<(ThemeMode, IconData, String)> modes = [
      (ThemeMode.light, Icons.light_mode_outlined, "亮色"),
      (ThemeMode.dark, Icons.dark_mode_outlined, "暗色"),
      (ThemeMode.system, Icons.brightness_auto_outlined, "跟随系统"),
    ];
    return Column(
      children: [
        for (int i = 0; i < modes.length; i++) ...<Widget>[
          if (i > 0) Divider(height: 1, indent: 52, color: p.divider),
          _ThemeModeOption(
            icon: modes[i].$2,
            label: modes[i].$3,
            selected: themeMode == modes[i].$1,
            onTap: () => onChanged(modes[i].$1),
          ),
        ],
      ],
    );
  }
}

class _ThemeModeOption extends StatelessWidget {
  const _ThemeModeOption({
    required this.icon,
    required this.label,
    required this.selected,
    required this.onTap,
  });

  final IconData icon;
  final String label;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final MobilePalette p = MobileTheme.of(context);
    final ColorScheme cs = Theme.of(context).colorScheme;
    final Color fg = selected ? cs.primary : p.textPrimary;
    return InkWell(
      onTap: onTap,
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
        child: Row(
          children: [
            SizedBox(
              width: 28,
              child: Icon(icon, size: 22, color: p.textSecondary),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Text(
                label,
                style: TextStyle(
                  color: fg,
                  fontSize: 15,
                  fontWeight: selected ? FontWeight.w600 : FontWeight.w500,
                ),
              ),
            ),
            if (selected)
              Icon(Icons.check, size: 20, color: cs.primary),
          ],
        ),
      ),
    );
  }
}
