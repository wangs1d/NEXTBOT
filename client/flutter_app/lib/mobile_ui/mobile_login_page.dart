import "dart:async";

import "package:flutter/material.dart";
import "package:flutter/services.dart";

import "../core/services/email_login_api.dart";

/// 手机端登录页：黑白极简落地页 + 弹出小卡片完成邮箱验证。
///
/// 视觉（方案 C2 设计稿）：纯黑背景、顶部双层白色光晕、左上角 NEXTBOT
/// 品牌位（下缀白色呼吸短线）、中段大字「欢迎回来 / 登录以继续」、
/// 白色胶囊主按钮沉底；整页无彩色元素（错误提示除外）。
///
/// 交互：点击「登录」原地弹出居中小卡片，卡片内完成两步式邮箱登录
/// （与桌面端 /accounts/web 网页登录完全同协议）：
///  1. 输入邮箱 → 「获取验证码」→ 服务端发 6 位验证码（OTP 闸关闭时提示免码直登）
///  2. 输入验证码 → 「登录」→ 新邮箱即注册、已注册即登录（幂等）
///
/// 登录成功后邮箱作为 userId 落到 [ApiConfig.runtimeUserId]，与桌面端
/// 「登录邮箱=运行时身份覆盖」同源：聊天/记忆/画像等数据按同一账号共享。
class MobileLoginPage extends StatefulWidget {
  const MobileLoginPage(
      {super.key, required this.onLoggedIn, this.onDebugSkip});

  /// 登录成功回调（参数=已归一化邮箱）。
  final ValueChanged<String> onLoggedIn;

  /// 调试跳过登录（仅 debug 构建由根组件注入；不落盘会话，重启即回登录页）。
  final VoidCallback? onDebugSkip;

  @override
  State<MobileLoginPage> createState() => _MobileLoginPageState();
}

class _MobileLoginPageState extends State<MobileLoginPage>
    with SingleTickerProviderStateMixin {
  final EmailLoginApi _api = EmailLoginApi();

  // ── 品牌登录面固定黑白（对齐方案 C2 设计稿，与 App 主题解耦）──
  static const Color _textPrimary = Color(0xFFF2F2F2);
  static const Color _textSecondary = Color(0xFF9B9B9B);
  static const Color _textMuted = Color(0xFF5C5C5C);

  /// 品牌位白色短线的呼吸动画（0.35 ↔ 0.9 透明度循环）。
  late final AnimationController _breath = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 2600),
  )..repeat(reverse: true);

  @override
  void dispose() {
    _breath.dispose();
    super.dispose();
  }

  /// 点击「登录」：弹出邮箱登录小卡片。
  void _openLoginCard() {
    showDialog<void>(
      context: context,
      barrierDismissible: true,
      barrierColor: const Color(0xAE000000),
      builder: (_) => _LoginCard(api: _api, onLoggedIn: widget.onLoggedIn),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Colors.black,
      body: Stack(
        children: <Widget>[
          // 双层白色光晕：顶部主光 + 右上补光（黑底上清晰可感）
          Positioned.fill(
            child: DecoratedBox(
              decoration: BoxDecoration(
                gradient: RadialGradient(
                  center: const Alignment(0, -1.15),
                  radius: 1.1,
                  colors: const <Color>[Color(0x42FFFFFF), Colors.transparent],
                ),
              ),
            ),
          ),
          Positioned.fill(
            child: DecoratedBox(
              decoration: BoxDecoration(
                gradient: RadialGradient(
                  center: const Alignment(0.9, -0.9),
                  radius: 0.6,
                  colors: const <Color>[Color(0x1FFFFFFF), Colors.transparent],
                ),
              ),
            ),
          ),
          SafeArea(
            child: Padding(
              padding: const EdgeInsets.fromLTRB(24, 20, 24, 20),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  // 左上角品牌位：NEXTBOT + 白色呼吸短线
                  const Text(
                    "NEXTBOT",
                    style: TextStyle(
                      color: _textPrimary,
                      fontSize: 13,
                      fontWeight: FontWeight.w700,
                      letterSpacing: 2.6,
                    ),
                  ),
                  const SizedBox(height: 8),
                  FadeTransition(
                    opacity:
                        Tween<double>(begin: 0.35, end: 0.9).animate(_breath),
                    child: Container(
                      width: 22,
                      height: 2,
                      decoration: BoxDecoration(
                        color: Colors.white,
                        borderRadius: BorderRadius.circular(999),
                      ),
                    ),
                  ),
                  // 中段大字口号（视觉锚点）
                  const Spacer(flex: 5),
                  const Text(
                    "欢迎回来",
                    style: TextStyle(
                      color: _textPrimary,
                      fontSize: 32,
                      height: 1.25,
                      fontWeight: FontWeight.w700,
                      letterSpacing: 0.3,
                    ),
                  ),
                  const SizedBox(height: 12),
                  const Text(
                    "登录以继续",
                    style: TextStyle(color: _textSecondary, fontSize: 13),
                  ),
                  const Spacer(flex: 6),
                  // 白色胶囊主按钮沉底
                  SizedBox(
                    width: double.infinity,
                    height: 46,
                    child: FilledButton(
                      onPressed: _openLoginCard,
                      style: FilledButton.styleFrom(
                        backgroundColor: Colors.white,
                        foregroundColor: const Color(0xFF0A0A0A),
                        shape: RoundedRectangleBorder(
                          borderRadius: BorderRadius.circular(999),
                        ),
                      ),
                      child: const Row(
                        mainAxisSize: MainAxisSize.min,
                        children: <Widget>[
                          Text(
                            "登录",
                            style: TextStyle(
                              fontSize: 15,
                              fontWeight: FontWeight.w600,
                            ),
                          ),
                          SizedBox(width: 6),
                          Icon(Icons.arrow_forward_rounded, size: 16),
                        ],
                      ),
                    ),
                  ),
                  // 调试预览直进（仅 debug 构建显示；release 无此回调自动隐藏）
                  if (widget.onDebugSkip != null)
                    Center(
                      child: TextButton(
                        onPressed: widget.onDebugSkip,
                        style: TextButton.styleFrom(
                          foregroundColor: _textMuted,
                          padding: const EdgeInsets.symmetric(
                              horizontal: 16, vertical: 8),
                        ),
                        child: const Text(
                          "跳过登录，先随便看看（调试）",
                          style: TextStyle(fontSize: 12),
                        ),
                      ),
                    ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}

/// 邮箱登录小卡片：弹出式两步验证（邮箱 → 验证码），协议与桌面端一致。
class _LoginCard extends StatefulWidget {
  const _LoginCard({required this.api, required this.onLoggedIn});

  final EmailLoginApi api;
  final ValueChanged<String> onLoggedIn;

  @override
  State<_LoginCard> createState() => _LoginCardState();
}

class _LoginCardState extends State<_LoginCard> {
  // ── 卡片黑白配色（对齐方案 C2 设计稿）──
  static const Color _textPrimary = Color(0xFFF2F2F2);
  static const Color _textSecondary = Color(0xFF9B9B9B);
  static const Color _textMuted = Color(0xFF6A6A6A);
  static const Color _fieldBg = Color(0xFF0D0D0D);
  static const Color _fieldBorder = Color(0xFF484848);
  static const Color _fieldBorderFocus = Color(0xFFEDEDED);
  static const Color _cardBorder = Color(0xFF303030);
  static const Color _errorRed = Color(0xFFF2604E);

  final TextEditingController _email = TextEditingController();
  final TextEditingController _code = TextEditingController();
  final FocusNode _codeFocus = FocusNode();

  /// 正在请求（发码/登录）。
  bool _busy = false;

  /// 验证码重发倒计时（秒；>0 时按钮禁用）。
  int _countdown = 0;
  Timer? _countdownTimer;

  /// 服务端 OTP 闸关闭：免验证码直登。
  bool _otpDisabled = false;

  String? _message;
  bool _messageError = false;

  @override
  void dispose() {
    _countdownTimer?.cancel();
    _email.dispose();
    _code.dispose();
    _codeFocus.dispose();
    super.dispose();
  }

  void _showMessage(String text, {required bool error}) {
    setState(() {
      _message = text;
      _messageError = error;
    });
  }

  void _startCountdown(int seconds) {
    _countdownTimer?.cancel();
    setState(() => _countdown = seconds);
    _countdownTimer = Timer.periodic(const Duration(seconds: 1), (Timer t) {
      if (!mounted) {
        t.cancel();
        return;
      }
      setState(() => _countdown -= 1);
      if (_countdown <= 0) t.cancel();
    });
  }

  /// 步骤 1：获取验证码。
  Future<void> _requestOtp() async {
    final String email = _email.text.trim().toLowerCase();
    if (!EmailLoginApi.isValidEmail(email)) {
      _showMessage("请输入有效的邮箱地址", error: true);
      return;
    }
    setState(() {
      _busy = true;
      _message = null;
    });
    final EmailLoginResult r = await widget.api.startOtp(email);
    if (!mounted) return;
    setState(() => _busy = false);
    if (r.ok) {
      _startCountdown(r.retryAfterSeconds ?? 60);
      _codeFocus.requestFocus();
      _showMessage("验证码已发送到 $email，请查收（可能在垃圾箱）", error: false);
      return;
    }
    if (r.otpChannelDisabled) {
      // 服务端未开 OTP 闸：免验证码，直接点「登录」即可
      setState(() => _otpDisabled = true);
      _showMessage("邮件验证通道未开启，可直接点击「登录」", error: false);
      return;
    }
    if (r.retryAfterSeconds != null && r.retryAfterSeconds! > 0) {
      _startCountdown(r.retryAfterSeconds!);
    }
    _showMessage(r.error ?? "验证码发送失败，请稍后重试", error: true);
  }

  /// 步骤 2：登录（新邮箱即注册，幂等）。
  Future<void> _login() async {
    final String email = _email.text.trim().toLowerCase();
    if (!EmailLoginApi.isValidEmail(email)) {
      _showMessage("请输入有效的邮箱地址", error: true);
      return;
    }
    final String code = _code.text.trim();
    if (!_otpDisabled && code.isEmpty) {
      _showMessage("请先获取验证码并输入 6 位验证码", error: true);
      return;
    }
    setState(() {
      _busy = true;
      _message = null;
    });
    final EmailLoginResult r = await widget.api
        .registerOrLogin(email, code: code.isEmpty ? null : code);
    if (!mounted) return;
    if (r.ok) {
      // 先关卡片再落登录态（根组件负责 runtimeUserId 覆盖与进主壳）
      Navigator.of(context).pop();
      widget.onLoggedIn(email);
      return;
    }
    setState(() {
      _busy = false;
      _message = r.error;
      _messageError = true;
    });
  }

  @override
  Widget build(BuildContext context) {
    return Dialog(
      backgroundColor: Colors.transparent,
      insetPadding: const EdgeInsets.symmetric(horizontal: 24, vertical: 24),
      child: Container(
        decoration: BoxDecoration(
          color: const Color(0xFF131313),
          borderRadius: BorderRadius.circular(16),
          border: Border.all(color: _cardBorder),
        ),
        padding: const EdgeInsets.all(16),
        child: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              // 卡片头：标题 + 关闭
              Row(
                children: <Widget>[
                  const Text(
                    "邮箱登录",
                    style: TextStyle(
                      color: _textPrimary,
                      fontSize: 15,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                  const Spacer(),
                  IconButton(
                    onPressed: () => Navigator.of(context).pop(),
                    icon: const Icon(Icons.close_rounded, size: 15),
                    color: _textSecondary,
                    style: IconButton.styleFrom(
                      backgroundColor: const Color(0xFF222222),
                      minimumSize: const Size(26, 26),
                      padding: EdgeInsets.zero,
                      shape: const CircleBorder(),
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 16),
              // ── 邮箱 ──
              const Text(
                "邮箱",
                style: TextStyle(
                  color: Color(0xFFC9C9C9),
                  fontSize: 11,
                  fontWeight: FontWeight.w600,
                ),
              ),
              const SizedBox(height: 8),
              _buildField(
                controller: _email,
                hint: "you@example.com",
                keyboardType: TextInputType.emailAddress,
                enabled: !_busy,
              ),
              // ── 验证码（OTP 闸关闭时隐藏）──
              if (!_otpDisabled) ...<Widget>[
                const SizedBox(height: 12),
                const Text(
                  "验证码",
                  style: TextStyle(
                    color: Color(0xFFC9C9C9),
                    fontSize: 11,
                    fontWeight: FontWeight.w600,
                  ),
                ),
                const SizedBox(height: 8),
                _buildField(
                  controller: _code,
                  hint: "6 位数字",
                  keyboardType: TextInputType.number,
                  inputFormatters: <TextInputFormatter>[
                    FilteringTextInputFormatter.digitsOnly,
                    LengthLimitingTextInputFormatter(6),
                  ],
                  enabled: !_busy,
                  focusNode: _codeFocus,
                  suffix: _buildOtpSuffix(),
                ),
              ],
              // 状态提示：成功=白点+浅灰文案，错误=红字
              if (_message != null) ...<Widget>[
                const SizedBox(height: 12),
                Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    if (!_messageError) ...<Widget>[
                      Container(
                        width: 6,
                        height: 6,
                        margin: const EdgeInsets.only(top: 5),
                        decoration: const BoxDecoration(
                          color: Colors.white,
                          shape: BoxShape.circle,
                        ),
                      ),
                      const SizedBox(width: 6),
                    ],
                    Expanded(
                      child: Text(
                        _message!,
                        style: TextStyle(
                          color: _messageError
                              ? _errorRed
                              : const Color(0xFFD6D6D6),
                          fontSize: 13,
                          height: 1.5,
                        ),
                      ),
                    ),
                  ],
                ),
              ],
              const SizedBox(height: 16),
              // ── 登录主按钮（白底胶囊）──
              SizedBox(
                width: double.infinity,
                height: 44,
                child: FilledButton(
                  onPressed: _busy ? null : _login,
                  style: FilledButton.styleFrom(
                    backgroundColor: Colors.white,
                    disabledBackgroundColor: const Color(0xFF2E2E2E),
                    foregroundColor: const Color(0xFF0A0A0A),
                    disabledForegroundColor: _textSecondary,
                    shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(999),
                    ),
                  ),
                  child: _busy
                      ? const SizedBox(
                          width: 20,
                          height: 20,
                          child: CircularProgressIndicator(
                            strokeWidth: 2.2,
                            valueColor: AlwaysStoppedAnimation<Color>(
                                Color(0xFF0A0A0A)),
                          ),
                        )
                      : const Text(
                          "登录",
                          style: TextStyle(
                            fontSize: 14,
                            fontWeight: FontWeight.w600,
                          ),
                        ),
                ),
              ),
              const SizedBox(height: 12),
              const Center(
                child: Text(
                  "新邮箱自动注册，已注册直接登录",
                  style: TextStyle(color: _textMuted, fontSize: 11),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _buildField({
    required TextEditingController controller,
    required String hint,
    TextInputType? keyboardType,
    List<TextInputFormatter>? inputFormatters,
    bool enabled = true,
    FocusNode? focusNode,
    Widget? suffix,
  }) {
    return TextField(
      controller: controller,
      focusNode: focusNode,
      enabled: enabled,
      keyboardType: keyboardType,
      inputFormatters: inputFormatters,
      style: const TextStyle(color: _textPrimary, fontSize: 14),
      decoration: InputDecoration(
        hintText: hint,
        hintStyle: const TextStyle(color: _textMuted, fontSize: 14),
        filled: true,
        fillColor: _fieldBg,
        isDense: true,
        contentPadding:
            const EdgeInsets.symmetric(horizontal: 12, vertical: 13),
        border: OutlineInputBorder(
          borderRadius: BorderRadius.circular(12),
          borderSide: const BorderSide(color: _fieldBorder),
        ),
        enabledBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(12),
          borderSide: const BorderSide(color: _fieldBorder),
        ),
        focusedBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(12),
          borderSide: const BorderSide(color: _fieldBorderFocus),
        ),
        suffixIcon: suffix,
        suffixIconConstraints: const BoxConstraints(minWidth: 0, minHeight: 0),
      ),
    );
  }

  /// 内嵌在验证码输入框右侧的「获取验证码 / 重新发送」小胶囊。
  Widget _buildOtpSuffix() {
    final bool cooling = _countdown > 0;
    return Padding(
      padding: const EdgeInsets.only(left: 4, right: 8),
      child: OutlinedButton(
        onPressed: (_busy || cooling) ? null : _requestOtp,
        style: OutlinedButton.styleFrom(
          foregroundColor: _textPrimary,
          side: BorderSide(
            color: cooling ? const Color(0xFF3A3A3A) : const Color(0xFF5A5A5A),
          ),
          shape:
              RoundedRectangleBorder(borderRadius: BorderRadius.circular(999)),
          minimumSize: const Size(0, 28),
          padding: const EdgeInsets.symmetric(horizontal: 10),
          textStyle: const TextStyle(fontSize: 11, fontWeight: FontWeight.w600),
        ),
        child: Text(cooling ? "重新发送($_countdown s)" : "获取验证码"),
      ),
    );
  }
}
