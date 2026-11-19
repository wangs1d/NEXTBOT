import "dart:async";
import "dart:io" show Platform;
import "dart:typed_data";

import "package:flutter/foundation.dart" show kIsWeb;
import "package:flutter/material.dart";
import "package:image_picker/image_picker.dart";
import "package:permission_handler/permission_handler.dart";

import "../core/config/api_config.dart";
import "../core/db/isar_local_history_store.dart";
import "../core/presentation/user_avatar.dart";
import "../core/services/keep_alive_service.dart";
import "../core/services/user_avatar_api.dart";
import "../features/help/feedback_dialog.dart";
import "mobile_chat_controller.dart";
import "mobile_recharge_page.dart";
import "mobile_service_access_page.dart";
import "mobile_theme.dart";

/// 手机端「我的」页:全功能二级菜单聚合。
///
/// - 顶部账号卡片：头像(点击可设置) + 名称(与桌面端同源：邮箱前缀) + 实时连接状态
/// - 功能：服务接入(内测 byok:模型+TTS 密钥)
/// （模型目录入口已删除（2026-11-04）：模型配置统一走服务接入页）
/// - 设置：外观(二级页:亮 / 暗 / 跟随系统)、帮助与反馈
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

class _MobileProfilePageState extends State<MobileProfilePage>
    with WidgetsBindingObserver {
  final UserAvatarApi _avatarApi = UserAvatarApi();
  final ImagePicker _imagePicker = ImagePicker();

  /// 用户头像相对路径（服务端 /agent/avatars/...；null=未设置）。
  String? _userAvatarPath;

  /// 后台保活真实状态（2026-11-18「老是重连」治理）：前台服务 + 电池优化豁免。
  /// 只在移动端查询；桌面/Web 保持空转，不显示相关行。
  bool _fgsRunning = false;
  bool _batteryExempt = false;
  bool _keepAliveLoading = true;

  /// 保活提示条只提醒一次；关掉后不再常驻，状态仍留在「后台保活」设置行。
  bool _keepAliveHintDismissed = false;
  static const String _keepAliveHintDismissedKey = "keepAliveHintDismissed";

  bool get _isMobile =>
      !kIsWeb && (Platform.isAndroid || Platform.isIOS);

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    unawaited(_loadAvatar());
    unawaited(_refreshKeepAlive());
    unawaited(_loadKeepAliveHintDismissed());
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
    WidgetsBinding.instance.removeObserver(this);
    widget.chatController.removeListener(_onChatChanged);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    // 从系统「电池优化/应用信息」设置页返回后，状态会变——回前台重查一次。
    if (state == AppLifecycleState.resumed) {
      unawaited(_refreshKeepAlive());
    }
  }

  /// 读取原生侧真实运行态（不把「请求过启动」当成「正在运行」）。
  Future<void> _refreshKeepAlive() async {
    if (!_isMobile) return;
    final bool running = await KeepAliveService.isRunning();
    final bool exempt = await KeepAliveService.isBatteryExempt();
    if (!mounted) return;
    setState(() {
      _fgsRunning = running;
      _batteryExempt = exempt;
      _keepAliveLoading = false;
    });
  }

  /// 提示条关闭状态落本地偏好：关过就不再每次进「我的」页弹出来。
  Future<void> _loadKeepAliveHintDismissed() async {
    final dynamic saved = await IsarLocalHistoryStore(
      userPin: ApiConfig.localPin,
    ).getPreference(_keepAliveHintDismissedKey);
    if (!mounted) return;
    setState(() => _keepAliveHintDismissed = saved == true);
  }

  Future<void> _dismissKeepAliveHint() async {
    setState(() => _keepAliveHintDismissed = true);
    await IsarLocalHistoryStore(
      userPin: ApiConfig.localPin,
    ).savePreference(_keepAliveHintDismissedKey, true);
  }

  /// 「后台保活」详情：展示真实状态 + 一键开启入口。
  ///
  /// 只把状态藏进设置还不够——用户看到「老是重连」时第一反应是网络或服务器，
  /// 不会想到是系统把进程冻结了。这里把两个关键开关（前台服务 / 电池优化豁免）
  /// 和厂商白名单的说明放在同一处，并提供跳系统设置的出口。
  Future<void> _showKeepAliveDialog() async {
    await showDialog<void>(
      context: context,
      builder: (BuildContext ctx) {
        return StatefulBuilder(
          builder: (BuildContext ctx, StateSetter setLocal) {
            Future<void> refresh() async {
              await _refreshKeepAlive();
              setLocal(() {});
            }

            return AlertDialog(
              title: const Text("后台保活"),
              content: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  _KeepAliveStatusLine(
                    label: "前台服务",
                    okText: "运行中",
                    badText: "未运行",
                    ok: _fgsRunning,
                  ),
                  const SizedBox(height: 8),
                  _KeepAliveStatusLine(
                    label: "电池优化",
                    okText: "已豁免",
                    badText: "未豁免",
                    ok: _batteryExempt,
                  ),
                  const SizedBox(height: 14),
                  const Text(
                    "任一项未开启，切到后台后系统都可能冻结进程，表现就是聊天连接时断时续。"
                    "华为/小米/OPPO/vivo 还需要在系统设置里允许「自启动」和「后台运行」，"
                    "并把电池策略设为「不限制」。",
                    style: TextStyle(fontSize: 13, height: 1.5),
                  ),
                ],
              ),
              actions: [
                if (!_batteryExempt)
                  TextButton(
                    onPressed: () async {
                      await KeepAliveService.ensureBatteryExemption();
                      // 系统确认框返回有延迟，稍等再回读状态。
                      await Future<void>.delayed(
                          const Duration(milliseconds: 800));
                      await refresh();
                    },
                    child: const Text("开启电池优化"),
                  ),
                if (!_fgsRunning)
                  TextButton(
                    onPressed: () async {
                      await KeepAliveService.start();
                      await Future<void>.delayed(
                          const Duration(milliseconds: 600));
                      await refresh();
                    },
                    child: const Text("启动前台服务"),
                  ),
                TextButton(
                  onPressed: () => unawaited(openAppSettings()),
                  child: const Text("系统设置"),
                ),
                TextButton(
                  onPressed: () => Navigator.of(ctx).pop(),
                  child: const Text("关闭"),
                ),
              ],
            );
          },
        );
      },
    );
    await _refreshKeepAlive();
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
    ScaffoldMessenger.of(context)
        .showSnackBar(SnackBar(content: Text(message)));
  }

  /// 「额度充值」chip：进入 App 内充值页。
  ///
  /// 身份直接用本机登录 access token（`/api/recharge/app/*`），不再跳官网网页、
  /// 不再重复邮箱验证码；只有最后一步支付宝付款交给系统浏览器/支付宝 App，
  /// 下单与记账仍复用官网同一套 webpay 服务。
  Future<void> _openRecharge() {
    return _push(const MobileRechargePage(), "额度充值");
  }

  /// 二级页统一包装:顶栏带返回键(被复用的桌面面板页自身无返回出口,
  /// 手机端依赖系统返回手势不够直观)。自带 AppBar 的页面(服务接入)
  /// 直接 push,避免出现双层顶栏+双返回按钮。
  ///
  /// 边缘横滑返回由系统手势导航（左/右边缘）直接作用于路由栈，无需重复拦截。
  Future<void> _push(Widget page, String title, {bool wrapped = true}) async {
    await Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (BuildContext ctx) => wrapped
            ? Scaffold(
                backgroundColor: MobileTheme.of(ctx).background,
                appBar: AppBar(
                  title: Text(title),
                  centerTitle: true,
                  leading: IconButton(
                    tooltip: "返回",
                    icon: const Icon(
                      Icons.arrow_back_ios_new_rounded,
                      size: 20,
                    ),
                    onPressed: () => unawaited(Navigator.of(ctx).maybePop()),
                  ),
                ),
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
        centerTitle: true,
        // 设置页从抽屉齿轮 push 进入：必须留显式返回键。
        leading: IconButton(
          tooltip: "返回",
          icon: const Icon(Icons.arrow_back_ios_new_rounded, size: 20),
          onPressed: () => unawaited(Navigator.of(context).maybePop()),
        ),
      ),
      body: ListView(
        // edge-to-edge 后底部手势条 inset 由列表滚动余量吃掉，最后一条不被压住
        padding: EdgeInsets.fromLTRB(
          0,
          8,
          0,
          8 + MediaQuery.paddingOf(context).bottom,
        ),
        children: [
          _AccountCard(
            actorId: ApiConfig.effectiveActorId,
            connected: connected,
            avatarUrl: UserAvatarApi.resolveUrl(_userAvatarPath),
            onChangeAvatar: _setAvatar,
          ),
          // 保活异常常驻提示（2026-11-18）：这是「手机端老是重连」最常见的
          // 根因，藏在二级页里用户找不到，所以状态不对时直接顶在账号卡下面。
          if (_isMobile &&
              !_keepAliveLoading &&
              !_keepAliveHintDismissed &&
              (!_batteryExempt || !_fgsRunning)) ...<Widget>[
            const SizedBox(height: 12),
            _KeepAliveHint(
              batteryExempt: _batteryExempt,
              fgsRunning: _fgsRunning,
              onTap: _showKeepAliveDialog,
              onDismiss: _dismissKeepAliveHint,
            ),
          ],
          const SizedBox(height: 16),
          _GroupLabel(label: "功能"),
          _SectionCard(
            children: [
              _ListRow(
                leading: Icon(Icons.account_balance_wallet_outlined,
                    color: p.textSecondary, size: 22),
                title: "额度充值",
                trailing:
                    Icon(Icons.chevron_right, color: p.textMuted, size: 20),
                onTap: _openRecharge,
              ),
              _divider(context),
              _ListRow(
                leading:
                    Icon(Icons.tune_outlined, color: p.textSecondary, size: 22),
                title: "服务接入",
                trailing:
                    Icon(Icons.chevron_right, color: p.textMuted, size: 20),
                onTap: () => _push(const MobileServiceAccessPage(), "服务接入",
                    wrapped: false),
              ),
            ],
          ),
          const SizedBox(height: 16),
          _GroupLabel(label: "设置"),
          _SectionCard(
            children: [
              if (_isMobile) ...<Widget>[
                _ListRow(
                  leading: Icon(Icons.shield_outlined,
                      color: p.textSecondary, size: 22),
                  title: "后台保活",
                  trailing: Text(
                    _keepAliveLoading
                        ? "检查中"
                        : (_batteryExempt && _fgsRunning ? "正常" : "待优化"),
                    style: TextStyle(
                      color: _batteryExempt && _fgsRunning
                          ? const Color(0xFF34C759)
                          : Theme.of(context).colorScheme.error,
                      fontSize: 14,
                    ),
                  ),
                  onTap: _showKeepAliveDialog,
                ),
                _divider(context),
              ],
              if (widget.themeMode != null &&
                  widget.onThemeModeChanged != null) ...<Widget>[
                _ListRow(
                  leading:
                      Icon(Icons.contrast, color: p.textSecondary, size: 22),
                  title: "外观",
                  trailing: Text(
                    _themeModeLabel(widget.themeMode!),
                    style: TextStyle(color: p.textMuted, fontSize: 14),
                  ),
                  onTap: () => _push(
                    _ThemeSettingsPage(
                      themeMode: widget.themeMode!,
                      onChanged: widget.onThemeModeChanged!,
                    ),
                    "外观",
                  ),
                ),
                _divider(context),
              ],
              _ListRow(
                leading:
                    Icon(Icons.help_outline, color: p.textSecondary, size: 22),
                title: "帮助与反馈",
                trailing:
                    Icon(Icons.chevron_right, color: p.textMuted, size: 20),
                onTap: _showFeedback,
              ),
            ],
          ),
          const SizedBox(height: 16),
          _GroupLabel(label: "关于"),
          _SectionCard(
            children: [
              _ListRow(
                leading:
                    Icon(Icons.info_outline, color: p.textSecondary, size: 22),
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
                  leading: Icon(Icons.logout,
                      color: Theme.of(context).colorScheme.error, size: 22),
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
    return Divider(
        height: 1, indent: 52, color: MobileTheme.of(context).divider);
  }

  /// 主题模式的展示名（「外观」行 trailing 摘要）。
  static String _themeModeLabel(ThemeMode mode) {
    switch (mode) {
      case ThemeMode.light:
        return "亮色";
      case ThemeMode.dark:
        return "暗色";
      case ThemeMode.system:
        return "跟随系统";
    }
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
              child: UserAvatar(
                  url: avatarUrl, size: 52, fallback: avatarFallback),
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
                      decoration: BoxDecoration(
                          color: statusColor, shape: BoxShape.circle),
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

/// 保活异常提示条：只在用户首次看到时出现，点 × 关掉后长期不再常驻。
class _KeepAliveHint extends StatelessWidget {
  const _KeepAliveHint({
    required this.batteryExempt,
    required this.fgsRunning,
    required this.onTap,
    required this.onDismiss,
  });

  final bool batteryExempt;
  final bool fgsRunning;
  final VoidCallback onTap;
  final VoidCallback onDismiss;

  @override
  Widget build(BuildContext context) {
    final MobilePalette p = MobileTheme.of(context);
    final Color err = Theme.of(context).colorScheme.error;
    final String reason = !batteryExempt && !fgsRunning
        ? "前台服务与电池优化都未开启"
        : (!batteryExempt ? "电池优化未豁免" : "前台服务未运行");
    return Container(
      margin: const EdgeInsets.symmetric(horizontal: 16),
      decoration: BoxDecoration(
        color: err.withValues(alpha: 0.08),
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: err.withValues(alpha: 0.35)),
      ),
      child: InkWell(
        borderRadius: BorderRadius.circular(16),
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
          child: Row(
            children: [
              Icon(Icons.battery_alert_outlined, color: err, size: 22),
              const SizedBox(width: 10),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      "后台连接可能被系统中断",
                      style: TextStyle(
                        color: p.textPrimary,
                        fontSize: 14,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                    const SizedBox(height: 2),
                    Text(
                      "$reason，切后台后消息可能收不到",
                      style: TextStyle(color: p.textSecondary, fontSize: 12),
                    ),
                  ],
                ),
              ),
              IconButton(
                icon: Icon(Icons.close, size: 18, color: p.textMuted),
                tooltip: "不再提示",
                onPressed: onDismiss,
                padding: EdgeInsets.zero,
                constraints: const BoxConstraints.tightFor(width: 32, height: 32),
                visualDensity: VisualDensity.compact,
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// 「后台保活」弹窗里的单行状态（绿点=正常，红点=异常）。
class _KeepAliveStatusLine extends StatelessWidget {
  const _KeepAliveStatusLine({
    required this.label,
    required this.okText,
    required this.badText,
    required this.ok,
  });

  final String label;
  final String okText;
  final String badText;
  final bool ok;

  @override
  Widget build(BuildContext context) {
    final MobilePalette p = MobileTheme.of(context);
    final Color color = ok ? const Color(0xFF34C759) : p.textMuted;
    return Row(
      children: [
        Container(
          width: 7,
          height: 7,
          decoration: BoxDecoration(color: color, shape: BoxShape.circle),
        ),
        const SizedBox(width: 8),
        Text("$label：", style: TextStyle(color: p.textSecondary, fontSize: 14)),
        Text(
          ok ? okText : badText,
          style: TextStyle(
            color: ok ? color : Theme.of(context).colorScheme.error,
            fontSize: 14,
            fontWeight: FontWeight.w600,
          ),
        ),
      ],
    );
  }
}

/// 「外观」二级页：三选一设置屏幕主题（亮 / 暗 / 跟随系统）。
///
/// 由 [_MobileProfilePageState._push] 统一包装顶栏，本体只渲染选项卡片；
/// 选中即生效并回写根组件的主题状态，返回后「外观」行的 trailing 摘要同步刷新。
class _ThemeSettingsPage extends StatefulWidget {
  const _ThemeSettingsPage({required this.themeMode, required this.onChanged});

  final ThemeMode themeMode;
  final ValueChanged<ThemeMode> onChanged;

  @override
  State<_ThemeSettingsPage> createState() => _ThemeSettingsPageState();
}

class _ThemeSettingsPageState extends State<_ThemeSettingsPage> {
  late ThemeMode _mode = widget.themeMode;

  @override
  Widget build(BuildContext context) {
    final MobilePalette p = MobileTheme.of(context);
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 8),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          _GroupLabel(label: "屏幕主题"),
          _SectionCard(
            children: [
              _ThemeModeRow(
                themeMode: _mode,
                onChanged: (ThemeMode mode) {
                  setState(() => _mode = mode);
                  widget.onChanged(mode);
                },
              ),
            ],
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(20, 12, 20, 0),
            child: Text(
              "暗色主题下界面自动切换为深色配色",
              style: TextStyle(color: p.textMuted, fontSize: 12),
            ),
          ),
        ],
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
            if (selected) Icon(Icons.check, size: 20, color: cs.primary),
          ],
        ),
      ),
    );
  }
}
