import "dart:async";

import "package:flutter/material.dart";
import "package:url_launcher/url_launcher.dart";

import "../core/services/call_log_access_service.dart";
import "../core/services/model_api_tester.dart";
import "../core/services/sms_access_service.dart";
import "mobile_theme.dart";

/// 手机端「能力连接」页。
///
/// 三个连接器统一成独立卡片（不拼成大列表），每张卡片带一圈向内收的呼吸光：
/// - 短信 / 通话记录：点「连接」弹 Android 系统授权框，授权后转「已连接」。
///   这两项是系统权限，断开只能去系统设置，所以页脚写明。
/// - QQ 邮箱：当前走 IMAP 授权码，点「连接」在卡片内就地展开授权面板；
///   后续接 OAuth 的邮箱只需把展开面板换成拉起系统浏览器授权，卡片结构不变。
///
/// 已连接状态回显依赖 [SmsAccessService] / [CallLogAccessService] 与
/// [MailWatchApi.status]；从系统设置或浏览器返回时由生命周期回调重查。
class MobileCapabilitiesPage extends StatefulWidget {
  const MobileCapabilitiesPage({super.key});

  @override
  State<MobileCapabilitiesPage> createState() => _MobileCapabilitiesPageState();
}

class _MobileCapabilitiesPageState extends State<MobileCapabilitiesPage>
    with WidgetsBindingObserver, SingleTickerProviderStateMixin {
  /// 呼吸灯节拍：所有卡片共用一条动画，节流且视觉统一。
  late final AnimationController _breath = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 2600),
  )..repeat(reverse: true);

  final TextEditingController _mailPass = TextEditingController();

  bool _ready = false;
  bool _smsGranted = false;
  bool _smsForever = false;
  bool _callGranted = false;
  bool _callForever = false;
  bool _smsBusy = false;
  bool _callBusy = false;

  Map<String, dynamic> _mailStatus = <String, dynamic>{};
  bool _mailExpanded = false;
  bool _mailSaving = false;
  bool _mailObscure = true;
  String? _mailMessage;
  bool _mailMessageError = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    unawaited(_refresh());
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _breath.dispose();
    _mailPass.dispose();
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    // 从系统权限设置页 / 浏览器授权页返回后重查，状态自愈。
    if (state == AppLifecycleState.resumed) unawaited(_refresh());
  }

  Future<void> _refresh() async {
    final bool sms = await SmsAccessService.instance.isGranted();
    final bool smsForever = await SmsAccessService.instance.isPermanentlyDenied();
    final bool call = await CallLogAccessService.instance.isGranted();
    final bool callForever =
        await CallLogAccessService.instance.isPermanentlyDenied();
    final Map<String, dynamic> mail = await MailWatchApi.status();
    if (!mounted) return;
    setState(() {
      _smsGranted = sms;
      _smsForever = smsForever;
      _callGranted = call;
      _callForever = callForever;
      _mailStatus = mail;
      _ready = true;
    });
  }

  Future<void> _connectSms() async {
    if (_smsBusy) return;
    setState(() => _smsBusy = true);
    final bool ok = await SmsAccessService.instance.ensureGranted();
    final bool forever = await SmsAccessService.instance.isPermanentlyDenied();
    if (!mounted) return;
    setState(() {
      _smsBusy = false;
      _smsGranted = ok;
      _smsForever = forever;
    });
    // 永久拒绝后再弹窗无效，只能去系统设置
    if (!ok && forever) await SmsAccessService.instance.openSettings();
  }

  Future<void> _connectCallLog() async {
    if (_callBusy) return;
    setState(() => _callBusy = true);
    final bool ok = await CallLogAccessService.instance.ensureGranted();
    final bool forever =
        await CallLogAccessService.instance.isPermanentlyDenied();
    if (!mounted) return;
    setState(() {
      _callBusy = false;
      _callGranted = ok;
      _callForever = forever;
    });
    if (!ok && forever) await CallLogAccessService.instance.openSettings();
  }

  Future<void> _saveMailPass() async {
    final String pass = _mailPass.text.trim();
    if (pass.isEmpty) {
      setState(() {
        _mailMessage = "授权码不能为空";
        _mailMessageError = true;
      });
      return;
    }
    if (_mailSaving) return;
    setState(() {
      _mailSaving = true;
      _mailMessage = null;
    });
    final Map<String, dynamic> saved = await MailWatchApi.savePass(pass);
    final Map<String, dynamic> status = await MailWatchApi.status();
    if (!mounted) return;
    final bool ok = saved["ok"] != false;
    setState(() {
      _mailSaving = false;
      _mailStatus = status;
      _mailMessageError = !ok;
      _mailMessage = ok
          ? (status["running"] == true ? "已接通，正在盯邮箱" : "授权码已保存，等待接通")
          : (saved["error"]?.toString() ?? "保存失败");
      if (ok) _mailPass.clear();
    });
  }

  String get _mailUser => (_mailStatus["user"] ?? "").toString();

  bool get _mailRunning => _mailStatus["running"] == true;

  @override
  Widget build(BuildContext context) {
    final MobilePalette p = MobileTheme.of(context);
    return Scaffold(
      backgroundColor: p.background,
      appBar: AppBar(
        title: const Text("能力连接"),
        centerTitle: true,
        leading: IconButton(
          tooltip: "返回",
          icon: const Icon(Icons.arrow_back_ios_new_rounded, size: 20),
          onPressed: () => unawaited(Navigator.of(context).maybePop()),
        ),
      ),
      body: ListView(
        padding: EdgeInsets.fromLTRB(
          16,
          8,
          16,
          16 + MediaQuery.paddingOf(context).bottom,
        ),
        children: <Widget>[
          Text(
            "连接后 Agent 才能读取对应内容，随时可断开。",
            style: TextStyle(
              fontSize: 12.5,
              height: 1.45,
              color: p.textSecondary,
            ),
          ),
          const SizedBox(height: 16),
          _connectorCard(
            p: p,
            icon: Icons.sms_outlined,
            iconColor: p.online,
            title: "短信",
            desc: _smsGranted
                ? "Agent 可按需读取本机短信，识别账单与快递通知"
                : _smsForever
                    ? "已在系统中被拒绝，请到系统设置开启「短信」权限"
                    : "整理短信内容，提醒你关注重要信息",
            trailing: _trailing(
              p,
              granted: _smsGranted,
              busy: _smsBusy,
              onTap: _connectSms,
            ),
          ),
          const SizedBox(height: 12),
          _connectorCard(
            p: p,
            icon: Icons.call_outlined,
            iconColor: p.online,
            title: "通话记录",
            desc: _callGranted
                ? "Agent 可按需读取本机通话记录"
                : _callForever
                    ? "已在系统中被拒绝，请到系统设置开启「通话记录」权限"
                    : "查看你的通话记录",
            trailing: _trailing(
              p,
              granted: _callGranted,
              busy: _callBusy,
              onTap: _connectCallLog,
            ),
          ),
          const SizedBox(height: 12),
          _connectorCard(
            p: p,
            icon: Icons.mail_outline,
            iconColor: p.link,
            title: "邮箱",
            desc: _mailRunning && _mailUser.isNotEmpty
                ? _mailUser
                : "连接邮箱，帮你盯重要邮件",
            trailing: _trailing(
              p,
              granted: _mailRunning,
              busy: false,
              onTap: () => setState(() => _mailExpanded = !_mailExpanded),
              onGrantedTap: () => setState(() => _mailExpanded = !_mailExpanded),
            ),
            body: _mailExpanded ? _mailPanel(p) : null,
          ),
          const SizedBox(height: 16),
          Text(
            "短信、通话记录为系统权限，断开需前往系统设置。",
            style: TextStyle(
              fontSize: 12,
              height: 1.45,
              color: p.textMuted,
            ),
          ),
        ],
      ),
    );
  }

  /// 右侧状态区：未就绪转圈，已连接显示绿色对勾，否则是「连接」。
  /// [onGrantedTap] 用于已连接后仍可操作（邮箱换授权码），未传则已连接时不可点。
  Widget _trailing(
    MobilePalette p, {
    required bool granted,
    required bool busy,
    required VoidCallback onTap,
    VoidCallback? onGrantedTap,
  }) {
    if (!_ready) {
      return SizedBox(
        width: 16,
        height: 16,
        child: CircularProgressIndicator(strokeWidth: 2, color: p.textMuted),
      );
    }
    if (granted) {
      final Widget chip = Row(
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          Icon(Icons.check_circle, size: 15, color: p.online),
          const SizedBox(width: 4),
          Text(
            "已连接",
            style: TextStyle(
              fontSize: 12.5,
              fontWeight: FontWeight.w500,
              color: p.online,
            ),
          ),
        ],
      );
      if (onGrantedTap == null) return chip;
      return InkWell(
        onTap: onGrantedTap,
        borderRadius: BorderRadius.circular(MobileTheme.bubbleRadius),
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 6),
          child: chip,
        ),
      );
    }
    return TextButton(
      onPressed: busy ? null : onTap,
      style: TextButton.styleFrom(
        minimumSize: const Size(0, 32),
        padding: const EdgeInsets.symmetric(horizontal: 8),
        foregroundColor: p.link,
        tapTargetSize: MaterialTapTargetSize.shrinkWrap,
      ),
      child: busy
          ? SizedBox(
              width: 14,
              height: 14,
              child: CircularProgressIndicator(strokeWidth: 2, color: p.link),
            )
          : const Text(
              "连接",
              style: TextStyle(fontSize: 13.5, fontWeight: FontWeight.w500),
            ),
    );
  }

  /// 单张连接器卡片：独立圆角卡片 + 向内呼吸光。
  Widget _connectorCard({
    required MobilePalette p,
    required IconData icon,
    required Color iconColor,
    required String title,
    required String desc,
    required Widget trailing,
    Widget? body,
  }) {
    return _BreathingCard(
      palette: p,
      animation: _breath,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Padding(
            padding: const EdgeInsets.all(16),
            child: Row(
              children: <Widget>[
                Container(
                  width: 40,
                  height: 40,
                  decoration: BoxDecoration(
                    color: iconColor.withValues(alpha: 0.12),
                    borderRadius: BorderRadius.circular(12),
                  ),
                  child: Icon(icon, size: 21, color: iconColor),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: <Widget>[
                      Text(
                        title,
                        style: TextStyle(
                          fontSize: 15,
                          fontWeight: FontWeight.w600,
                          color: p.textPrimary,
                        ),
                      ),
                      const SizedBox(height: 2),
                      Text(
                        desc,
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(
                          fontSize: 12.5,
                          height: 1.35,
                          color: p.textSecondary,
                        ),
                      ),
                    ],
                  ),
                ),
                const SizedBox(width: 8),
                trailing,
              ],
            ),
          ),
          if (body != null) body,
        ],
      ),
    );
  }

  /// 邮箱授权面板：就地展开，先跑通 IMAP 授权码；接 OAuth 时换掉这一块即可。
  Widget _mailPanel(MobilePalette p) {
    final String user = _mailUser;
    final String? guideUrl = mailGuideUrl(user);
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Divider(height: 1, color: p.divider),
          const SizedBox(height: 12),
          Text(
            mailGuideSteps(user),
            style: TextStyle(
              fontSize: 12,
              height: 1.55,
              color: p.textSecondary,
            ),
          ),
          if (guideUrl != null) ...<Widget>[
            const SizedBox(height: 6),
            InkWell(
              onTap: () => unawaited(
                launchUrl(
                  Uri.parse(guideUrl),
                  mode: LaunchMode.externalApplication,
                ),
              ),
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: <Widget>[
                  Icon(Icons.open_in_new, size: 13, color: p.link),
                  const SizedBox(width: 4),
                  Text(
                    "打开邮箱设置页",
                    style: TextStyle(
                      fontSize: 12,
                      color: p.link,
                      decoration: TextDecoration.underline,
                    ),
                  ),
                ],
              ),
            ),
          ],
          const SizedBox(height: 12),
          TextField(
            controller: _mailPass,
            obscureText: _mailObscure,
            style: const TextStyle(fontSize: 13.5),
            decoration: InputDecoration(
              labelText: "IMAP 授权码",
              hintText: "邮箱设置里生成的授权码",
              isDense: true,
              filled: true,
              fillColor: p.innerFieldBackground,
              border: OutlineInputBorder(
                borderRadius: BorderRadius.circular(12),
                borderSide: BorderSide(color: p.divider),
              ),
              enabledBorder: OutlineInputBorder(
                borderRadius: BorderRadius.circular(12),
                borderSide: BorderSide(color: p.divider),
              ),
              suffixIcon: IconButton(
                icon: Icon(
                  _mailObscure
                      ? Icons.visibility_off_outlined
                      : Icons.visibility_outlined,
                  size: 18,
                ),
                onPressed: () => setState(() => _mailObscure = !_mailObscure),
              ),
            ),
          ),
          const SizedBox(height: 12),
          Row(
            children: <Widget>[
              FilledButton(
                onPressed: _mailSaving ? null : () => unawaited(_saveMailPass()),
                style: FilledButton.styleFrom(
                  minimumSize: const Size(0, 40),
                  padding: const EdgeInsets.symmetric(horizontal: 16),
                ),
                child: _mailSaving
                    ? const SizedBox(
                        width: 14,
                        height: 14,
                        child: CircularProgressIndicator(strokeWidth: 2),
                      )
                    : const Text("保存并接通", style: TextStyle(fontSize: 13.5)),
              ),
              if (_mailMessage != null) ...<Widget>[
                const SizedBox(width: 12),
                Expanded(
                  child: Text(
                    _mailMessage!,
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      fontSize: 12,
                      color: _mailMessageError
                          ? Theme.of(context).colorScheme.error
                          : p.online,
                    ),
                  ),
                ),
              ],
            ],
          ),
        ],
      ),
    );
  }
}

/// 带向内呼吸光的圆角卡片。
///
/// 光不是外发光：外层 `RadialGradient` 从中心透明到边缘着色，被圆角裁切后
/// 呈现「四周向内渗光」的效果；外框用同色细描边收边，呼吸只改透明度与
/// 模糊半径，不做布局动画。
class _BreathingCard extends StatelessWidget {
  const _BreathingCard({
    required this.palette,
    required this.animation,
    required this.child,
  });

  final MobilePalette palette;
  final Animation<double> animation;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    final BorderRadius radius =
        BorderRadius.circular(MobileTheme.bubbleRadius);
    return AnimatedBuilder(
      animation: animation,
      builder: (BuildContext context, _) {
        final double t = Curves.easeInOut.transform(animation.value);
        return Container(
          decoration: BoxDecoration(
            color: palette.surface,
            borderRadius: radius,
            border: Border.all(
              color: palette.accent.withValues(alpha: 0.05 + 0.07 * t),
            ),
            boxShadow: <BoxShadow>[
              BoxShadow(
                color: palette.accent.withValues(alpha: 0.035 + 0.05 * t),
                blurRadius: 18 + 8 * t,
                spreadRadius: -2,
              ),
            ],
          ),
          child: ClipRRect(
            borderRadius: radius,
            child: Stack(
              children: <Widget>[
                Positioned.fill(
                  child: IgnorePointer(
                    child: DecoratedBox(
                      decoration: BoxDecoration(
                        gradient: RadialGradient(
                          radius: 1.02,
                          colors: <Color>[
                            palette.accent.withValues(alpha: 0),
                            palette.accent.withValues(alpha: 0.03 + 0.05 * t),
                          ],
                        ),
                      ),
                    ),
                  ),
                ),
                child,
              ],
            ),
          ),
        );
      },
      child: child,
    );
  }
}
