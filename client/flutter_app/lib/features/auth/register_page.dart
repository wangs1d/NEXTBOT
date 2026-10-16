import "dart:async";
import "dart:convert";
import "dart:developer" as developer;
import "dart:io";
import "dart:math" as math;
import "dart:ui" show ImageFilter;

import "package:flutter/foundation.dart";
import "package:flutter/material.dart";
import "package:flutter/services.dart";
import "package:http/http.dart" as http;
import "package:url_launcher/url_launcher.dart";
import "package:window_manager/window_manager.dart";

import "../../core/config/api_config.dart";
import "../../core/theme/app_theme.dart";
import "../../widgets/app_window_titlebar.dart";

/// 登录界面（NEXTBOT 桌面端）。
///
/// 左列按扣子桌面端版式：大标题在顶、底部问候 + 「立即登录」按钮，
/// 不再放表单——点击按钮后跳系统浏览器到控制面登录页（/accounts/web），
/// 网页完成注册/登录后经本机回环地址把邮箱回连给本页（见 [_startWebAuth]）。
/// 右侧为展示面板（C 案定稿：织物侧光背景图 + 真实对话样例玻璃卡）。
///
/// 集成约定：页面自身不依赖任何全局服务，登录结果通过
/// [RegisterPage.onAuthenticated] 回调外抛（null 时走 1.2s 模拟延迟，
/// 供预览/验收）。
///
/// 预览入口：环境变量 `PAI_REGISTER_PREVIEW=1` 启动独立预览窗口
/// （不 bootstrap 主应用任何服务），见 [runRegisterPreviewWindow]。

/// 独立预览窗口模式的环境变量开关（在 main.dart 最早期检查）。
const String kRegisterPreviewEnv = "PAI_REGISTER_PREVIEW";

/// 独立预览窗口入口：以设计稿同比例（16:10）的窗口只渲染注册页。
Future<void> runRegisterPreviewWindow() async {
  WidgetsFlutterBinding.ensureInitialized();
  await windowManager.ensureInitialized();
  const WindowOptions options = WindowOptions(
    // 与设计稿 1600x1000 同比例（16:10），小屏自动按内容自适应
    size: Size(1440, 900),
    minimumSize: Size(980, 680),
    center: true,
    title: "NEXTBOT — 创建账号",
    backgroundColor: Colors.transparent,
    // 无系统标题栏：整页沉浸还原设计稿，顶部留透明拖拽条
    titleBarStyle: TitleBarStyle.hidden,
  );
  await windowManager.waitUntilReadyToShow(options, () async {
    await windowManager.show();
    // 后台脚本/服务上下文拉起时窗口可能带最小化态启动，恢复正常显示
    if (await windowManager.isMinimized()) {
      await windowManager.restore();
    }
    await windowManager.focus();
  });
  runApp(const _RegisterPreviewApp());
}

/// 真实注册：名单落后台账号服务（`POST /accounts/register`，email 已透传）。
/// 开发/单机形态 [ApiConfig.controlPlaneBase] 回落 httpBase（127.0.0.1:3000
/// 本地 server，与管理后台同库）；发版形态烤入 CONTROL_PLANE_URL 指云端后台。
/// 幂等：后台报「已存在」同样视为成功（退出登录后同一邮箱重新注册/重装重进）。
/// 抛错时调用方捕获展示。
///
/// 网页登录流程里这一步由 /accounts/web 页面自己完成；本函数保留给
/// 预览窗口与调试直调通道直接驱动真实注册用。
Future<void> registerAccountToControlPlane(
  String email, {
  bool freshCreated = false,
}) async {
  // 邮箱即账号主键，统一小写（与 /accounts/web 页面、服务端同规则）
  final String mail = email.trim().toLowerCase();
  final http.Client client = http.Client();
  try {
    final http.Response res = await client
        .post(
          Uri.parse("${ApiConfig.controlPlaneBase}/accounts/register"),
          headers: const <String, String>{
            "Content-Type": "application/json",
          },
          body: jsonEncode(<String, String>{
            // 名单主键用邮箱：后台用户列表 userId/email 同值，一眼可辨
            "userId": mail,
            "displayName": mail.split("@").first,
            "email": mail,
          }),
        )
        .timeout(const Duration(seconds: 10));
    final Map<String, dynamic> data =
        jsonDecode(res.body) as Map<String, dynamic>;
    if (res.statusCode == 200 && data["ok"] == true) return;
    if ((data["message"]?.toString() ?? "").contains("已存在")) return;
    final String message =
        data["message"]?.toString() ?? "注册失败（HTTP ${res.statusCode}）";
    throw Exception(message);
  } finally {
    client.close();
  }
}

class _RegisterPreviewApp extends StatelessWidget {
  const _RegisterPreviewApp();

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      debugShowCheckedModeBanner: false,
      theme: AppTheme.of(AppThemeVariant.dark).copyWith(
        scaffoldBackgroundColor: Colors.black,
      ),
      home: RegisterPage(onAuthenticated: registerAccountToControlPlane),
    );
  }
}

/// 登录回调载荷：网页回连成功后携带邮箱；[freshCreated] 仅当本次回连
/// 真正新建了账号时为 true（服务端注册幂等，已存在走「已存在」400），
/// 宿主据此决定是否跑首启向导——已注册邮箱在任意机器登录直达主界面。
typedef OnWebAuth = Future<void> Function(String email, {bool freshCreated});

/// debug 直调扩展只注册一次（门禁会反复挂载注册页）。
bool _debugFillExtensionRegistered = false;

/// 注册界面整页。
///
/// 布局：黑色页底 + 居中大圆角卡片；卡片左半是表单列，右半是机器人面板。
/// 窄窗口（宽 < 900）时隐藏机器人面板，只保留表单列。
class RegisterPage extends StatefulWidget {
  const RegisterPage({
    super.key,
    this.onAuthenticated,
  });

  /// 网页登录回连成功后的回调（null = 模拟延迟，预览用）。
  final OnWebAuth? onAuthenticated;

  @override
  State<RegisterPage> createState() => _RegisterPageState();
}

class _RegisterPageState extends State<RegisterPage> {
  // ── 配色（按设计稿取色，深色独占，不随主题切换）──
  static const Color pageBg = Color(0xFF000000);
  static const Color cardBg = Color(0xFF141414);
  static const Color cardBorder = Color(0xFF232323);
  static const Color panelBg = Color(0xFF0D0D0D);
  static const Color textPrimary = Color(0xFFF2F2F2);
  static const Color textSecondary = Color(0xFF9B9B9B);
  static const Color textMuted = Color(0xFF6B6B6B);
  static const Color errorRed = Color(0xFFF2604E);

  static final RegExp _emailRe = RegExp(r"^[^\s@]+@[^\s@]+\.[^\s@]+$");

  // ── 网页登录状态机：拉起浏览器 → 等回环回调 → 交回调进主界面 ──
  bool _authBusy = false;
  bool _done = false;
  String? _authError;
  HttpServer? _loopbackServer;
  Uri? _webAuthUrl;
  Completer<({String email, bool freshCreated})>? _callbackCompleter;

  @override
  void initState() {
    super.initState();
    // debug 的 VM service 直调通道：脚本无法往被遮挡的窗口注入键盘/鼠标
    // （全屏游戏等前景遮挡时 SendKeys/点击会落 elsewhere），debug 构建统一
    // 注册，经 VM service websocket 直接驱动登录流程做真机取证（启动门禁与
    // 独立预览窗口共用本页，故不再限定 PAI_REGISTER_PREVIEW=1）。
    // 门禁会在「登录↔主界面」间反复挂载本页，扩展只允许注册一次。
    // 兼容旧取证脚本：password/confirm 参数收下但忽略（网页登录形态无表单）。
    if (kDebugMode && !_debugFillExtensionRegistered) {
      _debugFillExtensionRegistered = true;
      developer.registerExtension("ext.pai.debug.registerFill", (
        String method,
        Map<String, String> parameters,
      ) async {
        Future<void>.sync(() {
          final String email = (parameters["email"] ?? "").trim();
          if (parameters["submit"] != "1" || email.isEmpty) return;
          unawaited(_debugComplete(email));
        });
        return developer.ServiceExtensionResponse.result(
          jsonEncode(<String, dynamic>{"ok": true}),
        );
      });
    }
  }

  @override
  void dispose() {
    _closeLoopback();
    super.dispose();
  }

  // ═══════════════════════════════════════════════════════════
  // 网页登录：本机回环握手
  // ═══════════════════════════════════════════════════════════

  /// 点「立即登录」：起本机回环监听 → 开系统浏览器到控制面登录页
  /// （/accounts/web?cb=…&state=…），网页完成注册/登录后携带邮箱回连。
  Future<void> _startWebAuth() async {
    if (_authBusy || _done) return;
    setState(() {
      _authBusy = true;
      _authError = null;
    });
    try {
      final HttpServer server =
          await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
      _loopbackServer = server;
      final String state = _randomState();
      final String cb = "http://127.0.0.1:${server.port}/callback";
      _webAuthUrl = Uri.parse(
        "${ApiConfig.controlPlaneBase}/accounts/web"
        "?cb=${Uri.encodeComponent(cb)}&state=$state",
      );
      unawaited(launchUrl(
        _webAuthUrl!,
        mode: LaunchMode.externalApplication,
      ));
      final (:email, freshCreated: bool fresh) = await _waitLoopbackCallback(server, state);
      if (!mounted) return;
      await _completeAuth(email, freshCreated: fresh);
    } catch (e) {
      if (mounted && e is! _WebAuthCancelled) {
        setState(() => _authError = _friendlyAuthError(e));
      }
    } finally {
      await _closeLoopback();
      _callbackCompleter = null;
      if (mounted) setState(() => _authBusy = false);
    }
  }

  /// 等待网页回连：只认 path=/callback 且 state 匹配的请求，取邮箱与
  /// 新建标记（fresh=1，仅本次真正新建账号时由网页附加）交给完成态。
  /// 5 分钟未回连视为超时；取消由 [_cancelWebAuth] 注入 [_WebAuthCancelled]。
  Future<({String email, bool freshCreated})> _waitLoopbackCallback(
    HttpServer server,
    String state,
  ) {
    final Completer<({String email, bool freshCreated})> completer =
        Completer<({String email, bool freshCreated})>();
    _callbackCompleter = completer;
    server.listen((HttpRequest req) async {
      if (req.uri.path != "/callback") {
        req.response.statusCode = 404;
        await req.response.close();
        return;
      }
      if (completer.isCompleted) return;
      if (req.uri.queryParameters["state"] != state) {
        req.response.statusCode = 400;
        await req.response.close();
        return;
      }
      final String email = (req.uri.queryParameters["email"] ?? "").trim();
      final bool freshCreated = req.uri.queryParameters["fresh"] == "1";
      // 浏览器停留在回连页：给一句终态提示，窗口可自行关闭
      req.response.headers.contentType = ContentType.html;
      req.response.write(_loopbackAckHtml());
      await req.response.close();
      if (email.isEmpty || !_emailRe.hasMatch(email)) {
        completer.completeError(Exception("回连参数缺少有效邮箱"));
        return;
      }
      completer.complete((email: email, freshCreated: freshCreated));
    });
    return completer.future.timeout(const Duration(minutes: 5));
  }

  /// 登录成功（真实回连或 debug 直调）后的收尾：交调用方落会话并切主界面。
  Future<void> _completeAuth(String email, {bool freshCreated = false}) async {
    if (widget.onAuthenticated != null) {
      await widget.onAuthenticated!(email, freshCreated: freshCreated);
    } else {
      // 预览/验收：模拟一次真实回连的往返延迟
      await Future<void>.delayed(const Duration(milliseconds: 1200));
    }
    if (!mounted) return;
    setState(() => _done = true);
  }

  /// debug 直调通道的完成路径（跳过浏览器，直接走回调）。
  Future<void> _debugComplete(String email) async {
    if (_authBusy || _done) return;
    setState(() {
      _authBusy = true;
      _authError = null;
    });
    try {
      await _completeAuth(email);
    } catch (e) {
      if (mounted) setState(() => _authError = e.toString());
    } finally {
      if (mounted) setState(() => _authBusy = false);
    }
  }

  void _cancelWebAuth() {
    final Completer<({String email, bool freshCreated})>? completer =
        _callbackCompleter;
    if (completer != null && !completer.isCompleted) {
      completer.completeError(const _WebAuthCancelled());
    }
    _closeLoopback();
  }

  Future<void> _closeLoopback() async {
    final HttpServer? server = _loopbackServer;
    _loopbackServer = null;
    await server?.close(force: true);
  }

  /// 重新打开浏览器（等待回连期间浏览器被误关时的兜底）。
  Future<void> _relaunchBrowser() async {
    final Uri? url = _webAuthUrl;
    if (url == null) return;
    await launchUrl(url, mode: LaunchMode.externalApplication);
  }

  String _randomState() {
    final math.Random random = math.Random.secure();
    return List<String>.generate(
      16,
      (_) => random.nextInt(256).toRadixString(16).padLeft(2, "0"),
    ).join();
  }

  String _friendlyAuthError(Object e) {
    if (e is TimeoutException) return "登录超时，请重试。";
    return "登录失败：$e";
  }

  /// 回连成功页：浏览器窗口停留在这一页，提示用户回到桌面应用。
  String _loopbackAckHtml() {
    return "<!DOCTYPE html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\">"
        "<title>NEXTBOT — 登录完成</title><style>"
        "body{background:#000;color:#F2F2F2;text-align:center;margin:0;"
        "font-family:'Noto Sans SC','Microsoft YaHei UI',sans-serif;"
        "display:flex;align-items:center;justify-content:center;height:100vh;}"
        "h1{font-size:22px;font-weight:700;margin:0 0 10px;}"
        "p{color:#9B9B9B;font-size:14px;margin:0;}</style></head>"
        "<body><div><h1>登录完成</h1><p>已回连桌面端，本页可以关闭。</p></div></body></html>";
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: pageBg,
      body: CallbackShortcuts(
        bindings: <ShortcutActivator, VoidCallback>{
          const SingleActivator(LogicalKeyboardKey.escape): () {
            windowManager.close();
          },
        },
        child: Focus(
          autofocus: true,
          child: Column(
            children: <Widget>[
              // 自绘标题栏：与主窗口同款（拖拽/双击最大化 + 最小化/最大化/关闭）
              const AppWindowTitleBar(),
              Expanded(
                child: LayoutBuilder(
                  builder: (BuildContext context, BoxConstraints c) {
                    final double w = c.maxWidth;
                    final double h = c.maxHeight;
                    final bool compact = w < 900;
                    // 卡片外边距：随窗口缩放，黑边留白与设计稿比例一致
                    final double mx = (w * 0.085).clamp(36.0, 150.0);
                    final double my = (h * 0.065).clamp(28.0, 72.0);
                    return Padding(
                      padding: EdgeInsets.symmetric(horizontal: mx, vertical: my),
                      child: Container(
                        decoration: BoxDecoration(
                          color: cardBg,
                          borderRadius: BorderRadius.circular(24),
                          border: Border.all(color: cardBorder),
                        ),
                        child: compact
                            ? _buildFormColumn()
                            : Row(
                                crossAxisAlignment: CrossAxisAlignment.stretch,
                                children: <Widget>[
                                  Expanded(flex: 47, child: _buildFormColumn()),
                                  Expanded(flex: 53, child: _buildShowcasePanel()),
                                ],
                              ),
                      ),
                    );
                  },
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  // ═══════════════════════════════════════════════════════════
  // 左列（扣子桌面端版式：大标题在顶，问候与登录按钮沉底）
  // ═══════════════════════════════════════════════════════════

  Widget _buildFormColumn() {
    return Padding(
      padding: const EdgeInsets.fromLTRB(56, 52, 56, 44),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          const Text(
            "欢迎来到\nNEXTBOT 桌面端",
            style: TextStyle(
              fontFamily: AppTheme.appFontFamily,
              fontSize: 34,
              height: 1.35,
              fontWeight: FontWeight.w700,
              color: textPrimary,
            ),
          ),
          // 中段整块留白：标题独占上部，问候与按钮沉底（与扣子桌面端同构）
          const Spacer(),
          const _DelayedAppear(
            delay: Duration(milliseconds: 300),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Text(
                  "Hi，朋友",
                  style: TextStyle(
                    fontFamily: AppTheme.appFontFamily,
                    fontSize: 20,
                    height: 1.3,
                    fontWeight: FontWeight.w600,
                    color: textPrimary,
                  ),
                ),
                SizedBox(height: 10),
                Text(
                  "登录后，就可以开启我们的旅程了。",
                  style: TextStyle(
                    fontFamily: AppTheme.appFontFamily,
                    fontSize: 14,
                    height: 1.5,
                    color: textSecondary,
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(height: 28),
          _DelayedAppear(
            delay: const Duration(milliseconds: 550),
            child: _buildLoginButton(),
          ),
          const SizedBox(height: 12),
          _buildAuthStatus(),
        ],
      ),
    );
  }

  /// 「立即登录」：白底胶囊，跳系统浏览器到控制面登录页。
  Widget _buildLoginButton() {
    final bool busy = _authBusy;
    final bool done = _done;
    return MouseRegion(
      cursor: (busy || done) ? SystemMouseCursors.basic : SystemMouseCursors.click,
      child: AnimatedContainer(
        duration: const Duration(milliseconds: 160),
        width: double.infinity,
        height: 48,
        decoration: BoxDecoration(
          color: done ? const Color(0xFF2E2E2E) : Colors.white,
          borderRadius: BorderRadius.circular(24),
        ),
        child: TextButton(
          onPressed: busy || done ? null : () => unawaited(_startWebAuth()),
          style: TextButton.styleFrom(
            foregroundColor: done ? textSecondary : const Color(0xFF0A0A0A),
            shape: RoundedRectangleBorder(
              borderRadius: BorderRadius.circular(24),
            ),
          ),
          child: busy
              ? const SizedBox(
                  width: 20,
                  height: 20,
                  child: CircularProgressIndicator(
                    strokeWidth: 2.2,
                    valueColor: AlwaysStoppedAnimation<Color>(Color(0xFF0A0A0A)),
                  ),
                )
              : Text(
                  done ? "登录完成" : "立即登录",
                  style: TextStyle(
                    fontFamily: AppTheme.appFontFamily,
                    fontSize: 15,
                    fontWeight: FontWeight.w600,
                    color: done ? textSecondary : const Color(0xFF0A0A0A),
                  ),
                ),
        ),
      ),
    );
  }

  /// 按钮下的状态区：等待回连提示（取消 / 重开浏览器）或错误信息。
  Widget _buildAuthStatus() {
    if (_authBusy && !_done) {
      return Column(
        crossAxisAlignment: CrossAxisAlignment.center,
        children: <Widget>[
          const SizedBox(height: 18),
          const Text(
            "已打开浏览器完成登录，成功后会自动回到这里。",
            textAlign: TextAlign.center,
            style: TextStyle(
              fontFamily: AppTheme.appFontFamily,
              fontSize: 12,
              height: 1.5,
              color: textMuted,
            ),
          ),
          const SizedBox(height: 4),
          Row(
            mainAxisAlignment: MainAxisAlignment.center,
            children: <Widget>[
              TextButton(
                onPressed: _cancelWebAuth,
                style: TextButton.styleFrom(foregroundColor: textMuted),
                child: const Text(
                  "取消",
                  style: TextStyle(fontFamily: AppTheme.appFontFamily, fontSize: 13),
                ),
              ),
              TextButton(
                onPressed: () => unawaited(_relaunchBrowser()),
                style: TextButton.styleFrom(foregroundColor: textPrimary),
                child: const Text(
                  "重新打开浏览器",
                  style: TextStyle(
                    fontFamily: AppTheme.appFontFamily,
                    fontSize: 13,
                    fontWeight: FontWeight.w600,
                  ),
                ),
              ),
            ],
          ),
        ],
      );
    }
    if (_authError != null) {
      return Padding(
        padding: const EdgeInsets.only(top: 4),
        child: Text(
          _authError!,
          style: const TextStyle(
            fontFamily: AppTheme.appFontFamily,
            fontSize: 12,
            height: 1.4,
            color: errorRed,
          ),
        ),
      );
    }
    return const SizedBox.shrink();
  }

  // ═══════════════════════════════════════════════════════════
  // 右侧展示面板（C 案：织物侧光背景 + 对话样例玻璃卡）
  // ═══════════════════════════════════════════════════════════

  Widget _buildShowcasePanel() {
    return Padding(
      padding: const EdgeInsets.all(20),
      child: ClipRRect(
        borderRadius: BorderRadius.circular(16),
        child: Stack(
          fit: StackFit.expand,
          children: <Widget>[
            // 图片加载前的兜底底色
            const ColoredBox(color: panelBg),
            // 背景图 cover + 轻降饱和与亮度（对齐 preview.html grayscale(.2) brightness(.96)）
            ColorFiltered(
              colorFilter: const ColorFilter.matrix(<double>[
                0.809, 0.137, 0.014, 0, 0, //
                0.041, 0.905, 0.014, 0, 0, //
                0.041, 0.137, 0.782, 0, 0, //
                0, 0, 0, 1, 0,
              ]),
              child: Image.asset(
                "assets/register/register_bg_fabric.jpg",
                fit: BoxFit.cover,
              ),
            ),
            // 纵向压暗托住卡内文字对比（preview .shade 渐变）
            const DecoratedBox(
              decoration: BoxDecoration(
                gradient: LinearGradient(
                  begin: Alignment.topCenter,
                  end: Alignment.bottomCenter,
                  colors: <Color>[
                    Color(0x14000000),
                    Color(0x00000000),
                    Color(0x5E000000),
                  ],
                  stops: <double>[0, 0.42, 1],
                ),
              ),
            ),
            // 对话样例玻璃卡（面板内居中，宽 78% 对齐设计稿 76%）
            Center(
              child: FractionallySizedBox(
                widthFactor: 0.78,
                child: const _ShowcaseChatCard(),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// 用户在等待回连时主动取消（内部信号，不作为错误展示）。
class _WebAuthCancelled implements Exception {
  const _WebAuthCancelled();
}

// ═══════════════════════════════════════════════════════════
// 入场动画
// ═══════════════════════════════════════════════════════════

/// 延迟入场：透明度 + 轻微上浮，用于机器人台词先后出现。
class _DelayedAppear extends StatefulWidget {
  final Duration delay;
  final Widget child;

  const _DelayedAppear({required this.delay, required this.child});

  @override
  State<_DelayedAppear> createState() => _DelayedAppearState();
}

class _DelayedAppearState extends State<_DelayedAppear> {
  bool _visible = false;

  @override
  void initState() {
    super.initState();
    Timer(widget.delay, () {
      if (mounted) setState(() => _visible = true);
    });
  }

  @override
  Widget build(BuildContext context) {
    return AnimatedOpacity(
      opacity: _visible ? 1 : 0,
      duration: const Duration(milliseconds: 420),
      curve: Curves.easeOut,
      child: AnimatedSlide(
        offset: _visible ? Offset.zero : const Offset(0, 0.25),
        duration: const Duration(milliseconds: 420),
        curve: Curves.easeOut,
        child: widget.child,
      ),
    );
  }
}
// ═══════════════════════════════════════════════════════════
// 对话样例玻璃卡（C 案：磨砂玻璃 + 四条真实感消息 + 呼吸状态药丸）
// 样例文案与 preview.html 定稿一致：展示「管家真的在替你做事」。
// ═══════════════════════════════════════════════════════════

class _ShowcaseChatCard extends StatefulWidget {
  const _ShowcaseChatCard();

  @override
  State<_ShowcaseChatCard> createState() => _ShowcaseChatCardState();
}

class _ShowcaseChatCardState extends State<_ShowcaseChatCard>
    with SingleTickerProviderStateMixin {
  late final AnimationController _pulse = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 2200),
  )..repeat(reverse: true);

  @override
  void dispose() {
    _pulse.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return ClipRRect(
      borderRadius: BorderRadius.circular(18),
      child: BackdropFilter(
        filter: ImageFilter.blur(sigmaX: 18, sigmaY: 18),
        child: Container(
          padding: const EdgeInsets.fromLTRB(20, 20, 20, 16),
          decoration: BoxDecoration(
            color: const Color(0xB80E0E0E),
            borderRadius: BorderRadius.circular(18),
            border: Border.all(color: Colors.white.withValues(alpha: 0.09)),
            boxShadow: <BoxShadow>[
              BoxShadow(
                color: Colors.black.withValues(alpha: 0.45),
                blurRadius: 44,
                offset: const Offset(0, 18),
              ),
            ],
          ),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: <Widget>[
              const _DelayedAppear(
                delay: Duration(milliseconds: 350),
                child: _ShowcaseBubble(
                  fromUser: true,
                  text: "明早 7 点叫我起床，顺便把今天的安排过一遍。",
                ),
              ),
              const _DelayedAppear(
                delay: Duration(milliseconds: 650),
                child: _ShowcaseBubble(
                  fromUser: false,
                  text: "已设好 7:00 提醒。今天有 3 件事：9:30 项目评审、14:00 牙医、20:00 健身。评审要用的资料，我昨晚已经帮你整理好了。",
                ),
              ),
              const _DelayedAppear(
                delay: Duration(milliseconds: 1000),
                child: _ShowcaseBubble(
                  fromUser: true,
                  text: "盯着那台空气炸锅，降到 300 以内就告诉我。",
                ),
              ),
              const _DelayedAppear(
                delay: Duration(milliseconds: 1300),
                child: _ShowcaseBubble(
                  fromUser: false,
                  text: "在盯。现价 349，近 30 天最低 289，降到 300 以内我会第一时间提醒你。",
                ),
              ),
              const SizedBox(height: 14),
              _DelayedAppear(
                delay: const Duration(milliseconds: 1750),
                child: _buildPulsePill(),
              ),
            ],
          ),
        ),
      ),
    );
  }

  /// 状态药丸：呼吸脉冲圆点 + 「正在后台盯价格…」。
  Widget _buildPulsePill() {
    return AnimatedBuilder(
      animation: _pulse,
      builder: (BuildContext context, Widget? _) {
        final double t = Curves.easeInOut.transform(_pulse.value);
        return Container(
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 7),
          decoration: BoxDecoration(
            color: Colors.white.withValues(alpha: 0.05),
            borderRadius: BorderRadius.circular(999),
            border: Border.all(color: Colors.white.withValues(alpha: 0.08)),
          ),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: <Widget>[
              Container(
                width: 7,
                height: 7,
                decoration: BoxDecoration(
                  shape: BoxShape.circle,
                  color: Color.lerp(
                      const Color(0xFF57C89A), const Color(0xFF8CF2C6), t)!,
                  boxShadow: <BoxShadow>[
                    BoxShadow(
                      color: Color.lerp(
                          const Color(0x3357C89A), const Color(0x668CF2C6), t)!,
                      blurRadius: 3 + 6 * t,
                    ),
                  ],
                ),
              ),
              const SizedBox(width: 8),
              const Text(
                "正在后台盯价格…",
                style: TextStyle(
                  fontFamily: AppTheme.appFontFamily,
                  fontSize: 12,
                  color: _RegisterPageState.textSecondary,
                ),
              ),
            ],
          ),
        );
      },
    );
  }
}

/// 单条样例消息：AI 在左（白球头像 + 半透白泡），
/// 用户在右（深灰头像 + 白底泡）。
class _ShowcaseBubble extends StatelessWidget {
  final bool fromUser;
  final String text;

  const _ShowcaseBubble({required this.fromUser, required this.text});

  @override
  Widget build(BuildContext context) {
    final Widget avatar = Container(
      width: 26,
      height: 26,
      decoration: BoxDecoration(
        shape: BoxShape.circle,
        color: fromUser ? const Color(0xFF353535) : Colors.white,
        boxShadow: fromUser
            ? null
            : <BoxShadow>[
                BoxShadow(
                  color: Colors.white.withValues(alpha: 0.32),
                  blurRadius: 10,
                  spreadRadius: 1,
                ),
              ],
      ),
    );
    final Widget bubble = Container(
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
      constraints: const BoxConstraints(maxWidth: 320),
      decoration: BoxDecoration(
        color: fromUser
            ? const Color(0xFFF2F2F2)
            : Colors.white.withValues(alpha: 0.07),
        borderRadius: BorderRadius.circular(12),
      ),
      child: Text(
        text,
        style: TextStyle(
          fontFamily: AppTheme.appFontFamily,
          fontSize: 12.5,
          height: 1.45,
          color: fromUser ? const Color(0xFF0A0A0A) : const Color(0xFFF2F2F2),
        ),
      ),
    );
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 5),
      child: Row(
        mainAxisAlignment:
            fromUser ? MainAxisAlignment.end : MainAxisAlignment.start,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: fromUser
            ? <Widget>[
                Flexible(child: bubble),
                const SizedBox(width: 10),
                avatar,
              ]
            : <Widget>[
                avatar,
                const SizedBox(width: 10),
                Flexible(child: bubble),
              ],
      ),
    );
  }
}
