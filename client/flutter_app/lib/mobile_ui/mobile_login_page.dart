import "dart:async";

import "package:flutter/material.dart";
import "package:flutter/services.dart";

import "../core/services/email_login_api.dart";

/// 登录 / 注册两种界面形态。
enum _AuthMode {
  /// 老用户：邮箱 + 验证码 → POST /accounts/login（只登录，不建档）。
  login,

  /// 新用户：名称 + 邮箱 + 验证码 → POST /accounts/register（mode=register）。
  register,
}

/// 手机端登录页：黑白极简落地页 + 弹出小卡片完成邮箱验证。
///
/// 视觉（方案 C2 设计稿）：纯黑背景、顶部双层白色光晕、左上角 NEXTBOT
/// 品牌位（下缀白色呼吸短线）、中段大字「欢迎回来 / 登录以继续」、
/// 白色胶囊主按钮沉底；整页无彩色元素（错误提示除外）。
///
/// 交互（2026-11 拆分登录/注册）：落地页主按钮进**登录**，「没有账号？注册」
/// 进**注册**。同一个卡片按模式渲染不同字段：
///  - 登录：邮箱 + 验证码（不再要求填名称，注册过的用户直接登录）
///  - 注册：名称 + 邮箱 + 验证码（名称落账号 displayName，开场白用它称呼）
///
/// 两界面不是各走各的死路，而是互相兜底：
///  - 登录时该邮箱没注册过 → 自动切到注册（验证码仍然有效，补个名称即可）
///  - 注册时该邮箱已注册 → 自动切到登录（服务端 409 ACCOUNT_EXISTS）
/// 点「获取验证码」时先探一次账号是否已存在，能把走错门的人提前送对地方，
/// 不浪费一封验证码邮件。
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

  /// 打开认证卡片（登录 / 注册）。
  void _openAuthCard(_AuthMode mode) {
    showDialog<void>(
      context: context,
      barrierDismissible: true,
      barrierColor: const Color(0xAE000000),
      builder: (_) => _AuthCard(
        api: _api,
        initialMode: mode,
        onLoggedIn: widget.onLoggedIn,
      ),
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
                  // 白色胶囊主按钮沉底：老用户登录
                  SizedBox(
                    width: double.infinity,
                    height: 46,
                    child: FilledButton(
                      onPressed: () => _openAuthCard(_AuthMode.login),
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
                  const SizedBox(height: 10),
                  // 新用户入口：独立注册界面
                  Center(
                    child: TextButton(
                      onPressed: () => _openAuthCard(_AuthMode.register),
                      style: TextButton.styleFrom(
                        foregroundColor: _textSecondary,
                        padding: const EdgeInsets.symmetric(
                            horizontal: 16, vertical: 8),
                      ),
                      child: const Text(
                        "没有账号？创建账号",
                        style: TextStyle(fontSize: 13),
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

/// 邮箱认证小卡片：登录 / 注册两种模式共用一套壳，只换字段与提交接口。
class _AuthCard extends StatefulWidget {
  const _AuthCard({
    required this.api,
    required this.initialMode,
    required this.onLoggedIn,
  });

  final EmailLoginApi api;
  final _AuthMode initialMode;
  final ValueChanged<String> onLoggedIn;

  @override
  State<_AuthCard> createState() => _AuthCardState();
}

class _AuthCardState extends State<_AuthCard> {
  // ── 卡片黑白配色（对齐方案 C2 设计稿）──
  static const Color _textPrimary = Color(0xFFF2F2F2);
  static const Color _textSecondary = Color(0xFF9B9B9B);
  static const Color _textMuted = Color(0xFF6A6A6A);
  static const Color _fieldBg = Color(0xFF0D0D0D);
  static const Color _fieldBorder = Color(0xFF484848);
  static const Color _fieldBorderFocus = Color(0xFFEDEDED);
  static const Color _cardBorder = Color(0xFF303030);
  static const Color _errorRed = Color(0xFFF2604E);

  late _AuthMode _mode = widget.initialMode;

  final TextEditingController _email = TextEditingController();
  final TextEditingController _name = TextEditingController();
  final TextEditingController _code = TextEditingController();
  final FocusNode _codeFocus = FocusNode();

  /// 正在请求（发码/提交）。
  bool _busy = false;

  /// 验证码重发倒计时（秒；>0 时按钮禁用）。
  int _countdown = 0;
  Timer? _countdownTimer;

  /// 服务端 OTP 闸关闭：免验证码直登。
  bool _otpDisabled = false;

  String? _message;
  bool _messageError = false;

  bool get _isLogin => _mode == _AuthMode.login;

  @override
  void dispose() {
    _countdownTimer?.cancel();
    _email.dispose();
    _name.dispose();
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

  /// 切换登录/注册，保留已输入的邮箱与验证码（同一个邮箱的验证码两种模式通用）。
  void _switchMode(_AuthMode mode, String note) {
    if (_mode == mode) {
      _showMessage(note, error: false);
      return;
    }
    setState(() {
      _mode = mode;
      _message = note;
      _messageError = false;
    });
  }

  /// 步骤 1：获取验证码。发码前先探一次账号是否存在，把走错门的人送到对的地方。
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
    // 探测失败（null）不拦人：照常发码，走到提交那一步服务端还会给准话
    final bool? registered = await widget.api.checkRegistered(email);
    if (!mounted) return;
    String? switchNote;
    if (registered == false && _isLogin) {
      _switchMode(_AuthMode.register, "这个邮箱还没有账号，验证后填个名称就能创建");
      switchNote = _message;
    } else if (registered == true && !_isLogin) {
      _switchMode(_AuthMode.login, "这个邮箱已注册，验证后直接登录");
      switchNote = _message;
    }
    final EmailLoginResult r = await widget.api.startOtp(email);
    if (!mounted) return;
    setState(() => _busy = false);
    if (r.ok) {
      _startCountdown(r.retryAfterSeconds ?? 60);
      _codeFocus.requestFocus();
      _showMessage(
        switchNote ?? "验证码已发送到 $email，请查收（可能在垃圾箱）",
        error: false,
      );
      return;
    }
    if (r.otpChannelDisabled) {
      // 服务端未开 OTP 闸：免验证码，直接点主按钮即可
      setState(() => _otpDisabled = true);
      _showMessage("邮件验证通道未开启，可直接点击「${_primaryLabel()}」", error: false);
      return;
    }
    if (r.retryAfterSeconds != null && r.retryAfterSeconds! > 0) {
      _startCountdown(r.retryAfterSeconds!);
    }
    _showMessage(r.error ?? "验证码发送失败，请稍后重试", error: true);
  }

  String _primaryLabel() => _isLogin ? "登录" : "创建账号";

  /// 步骤 2：提交。登录走 /accounts/login（不建档），注册走 /accounts/register。
  Future<void> _submit() async {
    final String email = _email.text.trim().toLowerCase();
    if (!EmailLoginApi.isValidEmail(email)) {
      _showMessage("请输入有效的邮箱地址", error: true);
      return;
    }
    final String name = _name.text.trim();
    if (!_isLogin && name.isEmpty) {
      _showMessage("请填写你的名称", error: true);
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
    final EmailLoginResult r = _isLogin
        ? await widget.api.login(email, code: code.isEmpty ? null : code)
        : await widget.api
            .register(email, code: code.isEmpty ? null : code, name: name);
    if (!mounted) return;

    if (r.ok) {
      // 先关卡片再落登录态（根组件负责 runtimeUserId 覆盖与进主壳）
      Navigator.of(context).pop();
      widget.onLoggedIn(email);
      return;
    }
    setState(() => _busy = false);

    // 走错门：服务端说了准话，就地换到另一个界面，验证码仍然可用
    if (r.accountNotFound) {
      _switchMode(_AuthMode.register, "这个邮箱还没有账号，已切到注册：填个名称即可创建");
      return;
    }
    if (r.accountExists) {
      _switchMode(_AuthMode.login, "这个邮箱已经注册过，已切到登录：验证码填好直接登录");
      return;
    }
    _showMessage(r.error ?? "操作失败，请稍后重试", error: true);
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
                  Text(
                    _isLogin ? "登录" : "创建账号",
                    style: const TextStyle(
                      color: _textPrimary,
                      fontSize: 15,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      _isLogin ? "用注册过的邮箱登录" : "新账号，一分钟搞定",
                      style: const TextStyle(color: _textMuted, fontSize: 11),
                      overflow: TextOverflow.ellipsis,
                    ),
                  ),
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
              // ── 邮箱（两种模式共用，放最前：先认人）──
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
              // ── 名称（仅注册：落账号 displayName，开场白用它称呼用户）──
              if (!_isLogin) ...<Widget>[
                const SizedBox(height: 12),
                const Text(
                  "你的名称",
                  style: TextStyle(
                    color: Color(0xFFC9C9C9),
                    fontSize: 11,
                    fontWeight: FontWeight.w600,
                  ),
                ),
                const SizedBox(height: 8),
                _buildField(
                  controller: _name,
                  hint: "怎么称呼你，如：阿哲",
                  enabled: !_busy,
                ),
              ],
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
              // ── 主按钮（白底胶囊）──
              SizedBox(
                width: double.infinity,
                height: 44,
                child: FilledButton(
                  onPressed: _busy ? null : _submit,
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
                      : Text(
                          _primaryLabel(),
                          style: const TextStyle(
                            fontSize: 14,
                            fontWeight: FontWeight.w600,
                          ),
                        ),
                ),
              ),
              const SizedBox(height: 4),
              // ── 模式切换（登录⇄注册）──
              Center(
                child: TextButton(
                  onPressed: _busy
                      ? null
                      : () => _switchMode(
                            _isLogin ? _AuthMode.register : _AuthMode.login,
                            _isLogin
                                ? "切到注册：填个名称就能创建账号"
                                : "切到登录：注册过的邮箱直接验证登录",
                          ),
                  style: TextButton.styleFrom(
                    foregroundColor: _textSecondary,
                    padding: const EdgeInsets.symmetric(
                        horizontal: 12, vertical: 6),
                    minimumSize: const Size(0, 32),
                  ),
                  child: Text(
                    _isLogin ? "还没有账号？创建账号" : "已有账号？去登录",
                    style: const TextStyle(fontSize: 12),
                  ),
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
