import "dart:async";
import "dart:convert";
import "dart:io";

import "package:flutter/material.dart";
import "package:flutter/services.dart";
import "package:webview_windows/webview_windows.dart";
import "package:window_manager/window_manager.dart";

import "../../core/services/access_auth_api.dart";
import "../../core/services/account_profile_api.dart";
import "../../core/services/daily_briefing_card_render.dart";
import "../../core/services/windows_webview_bootstrap.dart";

// ═══════════════════════════════════════════════════════════════════
// 今日简报独立系统窗口（WebView 版；版式见 design/daily-briefing-card-
// variants.html 的「V2 分组面板 + V4 摘要置顶」结合版）。
//
// 与行程规划窗口（travel_plan_window.dart）同款「独立进程」方案：主应用
// 把简报数据写到临时文件后 spawn 自己的 exe，并经环境变量传递文件路径；
// 子进程 main() 检测到该环境变量即走本文件的窗口分支。
//
// 为什么用独立进程 + WebView：设计稿是玻璃拟态 + CSS 动画，GDI 自绘还原
// 度不足；而 webview_windows 插件需要完整插件注册的 Flutter 引擎，独立
// 进程天然具备（行程地图 WebView 同理）。
//
// 交互契约（HTML JS bridge → Dart）：
//   postMessage {action:"close"}  → 销毁窗口退出进程
//   postMessage {action:"drag"}   → startDragging（整卡拖动）
//   postMessage {action:"height"} → 按页面真实内容高校正窗口高度（setSize）
//
// 2026-09-24 结构化行卡改版：卡面全部直出结构化字段（日程·待办·笔记·
// 热搜·重要日子全量行）；无「展开详情」第二跳——私人管家简报一眼看全。
// 2026-10-16 天气/穿衣迁出简报卡面（搬往睡前提醒 evening.digest）。
// 2026-10-20 TTS 播报断线（合成成本高，待定）：移除自动播报 / 点击播报 /
// 底部播报状态行及全部 JS↔Dart 播报驱动；服务端 /api/morning-briefing/tts
// 与 BriefingTtsApi 保留（纯语音模式仍复用），之后要用再把连线接回。
// 2026-10-20 版式重排（用户拍板：摘要置顶 + 分组面板结合）：口播稿回到卡面
// 置顶当「今日一句话」；各板块改为浅色面板，无数据的板块整块不出现、不留
// 空位；行标题两行内自适应；补上桌面卡原先缺失的「今日行程」块。
// ═══════════════════════════════════════════════════════════════════

/// 子进程窗口模式的环境变量名（值为载荷 JSON 文件路径）。
const String kDailyBriefingWindowEnv = "PAI_DAILY_BRIEFING_WINDOW";

/// 简报窗口载荷：口播稿 + 结构化简报 + 用户称呼。
class DailyBriefingWindowPayload {
  const DailyBriefingWindowPayload({
    required this.narrationText,
    required this.briefing,
    this.appellation = "",
  });

  final String narrationText;
  final Map<String, dynamic> briefing;

  /// 用户称呼（账号注册 displayName，如「王先生」）；空表示无称呼。
  final String appellation;

  String encode() => jsonEncode(<String, dynamic>{
        "version": 2,
        "narrationText": narrationText,
        "briefing": briefing,
        "appellation": appellation,
      });

  /// 解码失败（文件损坏/版本不符）时返回 null，宿主展示错误兜底。
  static DailyBriefingWindowPayload? tryDecode(String raw) {
    try {
      final Object? decoded = jsonDecode(raw);
      if (decoded is! Map<String, dynamic>) return null;
      final Object? rawBriefing = decoded["briefing"];
      if (rawBriefing is! Map) return null;
      return DailyBriefingWindowPayload(
        narrationText: decoded["narrationText"]?.toString() ?? "",
        briefing: rawBriefing.cast<String, dynamic>(),
        appellation: decoded["appellation"]?.toString() ?? "",
      );
    } catch (_) {
      return null;
    }
  }
}

/// 简报独立窗口启动器（主应用侧调用）。
///
/// spawn 本应用 exe 并以环境变量传递载荷文件；同一时刻至多保留一个简报
/// 窗口——再次打开时结束旧进程，新简报取而代之。
class DailyBriefingWindowLauncher {
  DailyBriefingWindowLauncher._();

  static Process? _current;

  /// 尝试在独立系统窗口中展示简报；成功返回 true。
  /// 失败（非 Windows / spawn 失败）时由调用方退回通知/对话框路径。
  ///
  /// [appellation]：服务端简报已解析的用户称呼（记忆 user_profile）；
  /// 缺失时回退到账号 displayName（resolveAppellation）。
  static Future<bool> open({
    required String narrationText,
    required Map<String, dynamic> briefing,
    String? appellation,
  }) async {
    if (!Platform.isWindows) return false;
    try {
      final String resolvedAppellation =
          (appellation != null && appellation.trim().isNotEmpty)
              ? appellation.trim()
              : await AccountProfileApi.resolveAppellation();
      final File payloadFile = await _writePayloadFile(
        DailyBriefingWindowPayload(
          narrationText: narrationText,
          briefing: briefing,
          appellation: resolvedAppellation,
        ),
      );
      // 旧窗口仍在 → 结束旧进程后重开，保证"最新简报在前"
      _current?.kill();
      final Process process = await Process.start(
        Platform.resolvedExecutable,
        const <String>[],
        environment: <String, String>{
          ...Platform.environment,
          kDailyBriefingWindowEnv: payloadFile.path,
        },
      );
      // 排空子进程 stdout/stderr：debug 构建日志量大，管道塞满会卡死子进程
      unawaited(process.stdout.drain<void>());
      unawaited(process.stderr.drain<void>());
      unawaited(process.exitCode.then((_) {
        if (identical(_current, process)) _current = null;
      }));
      _current = process;
      return true;
    } catch (_) {
      return false;
    }
  }

  /// 载荷写入 %TEMP%（子进程读取后自行删除）。
  static Future<File> _writePayloadFile(DailyBriefingWindowPayload payload) async {
    final String tempDir = Platform.environment["TEMP"] ??
        Platform.environment["TMP"] ??
        Directory.systemTemp.path;
    final String path = "$tempDir${Platform.pathSeparator}pai_daily_briefing_"
        "${DateTime.now().microsecondsSinceEpoch}.json";
    return File(path).writeAsString(payload.encode(), flush: true);
  }
}

// ═══════════════════════════════════════════════════════════════════
// 子进程窗口分支（main() 检测到环境变量后进入）
// ═══════════════════════════════════════════════════════════════════

/// 独立简报窗口的子进程入口：读载荷 → 配置窗口 → runApp。
///
/// 由 main() 在启动最早期调用（不 bootstrap 完整应用）。
Future<void> runDailyBriefingWindow(String payloadPath) async {
  DailyBriefingWindowPayload? payload;
  try {
    final String raw = await File(payloadPath).readAsString();
    unawaited(_deleteQuietly(payloadPath));
    payload = DailyBriefingWindowPayload.tryDecode(raw);
  } catch (_) {
    payload = null;
  }

  // WebView2 环境与访问凭据与主应用同款预热（TTS / 简报数据走 httpBase 直连）。
  // 环境初始化必须先于下方 WebviewController.initialize() 完成——
  // await 而非 unawaited，否则存在初始化竞争导致控制器创建失败。
  await bootstrapWindowsWebView();
  unawaited(AccessCredentialStore.instance.load());

  await windowManager.ensureInitialized();
  // 窗口用不透明深底 + 原生 DWM 系统圆角（runner 侧对简报子进程窗口生效）：
  // Flutter Windows 不支持逐像素透明窗口，此前 transparent 底色会在
  // 左侧圆角外留一条不透明残留带。
  const Color windowBg = Color(0xFF0A0B0E);
  final WindowOptions options = WindowOptions(
    size: Size(
      kCardWidth,
      briefingWindowHeight(
        briefing: payload?.briefing,
        narrationText: payload?.narrationText ?? "",
      ),
    ),
    titleBarStyle: TitleBarStyle.hidden,
    backgroundColor: windowBg,
    title: "今日简报",
  );
  await windowManager.waitUntilReadyToShow(options, () async {
    await windowManager.setAlwaysOnTop(true);
    await windowManager.setBackgroundColor(windowBg);
    await _positionRightCenter();
    // 关键：inactive 显示——开机播报绝不抢走用户正在使用的窗口焦点
    await windowManager.show(inactive: true);
  });
  runApp(DailyBriefingWindowApp(payload: payload));
}

/// 右侧垂直居中定位（贴右缘留 24px）：工作区经同款 runner 的
/// pai/daily_briefing getWorkArea 查询（子进程与主应用运行同一 runner，
/// 通道可用），返回逻辑像素，与 window_manager.setPosition 的坐标系一致。
Future<void> _positionRightCenter() async {
  try {
    const MethodChannel channel = MethodChannel("pai/daily_briefing");
    final Map<dynamic, dynamic>? work =
        await channel.invokeMethod<Map<dynamic, dynamic>>("getWorkArea");
    if (work == null) return;
    final Size size = await windowManager.getSize();
    final double right = (work["right"] as num?)?.toDouble() ?? 0;
    final double left = (work["left"] as num?)?.toDouble() ?? 0;
    final double top = (work["top"] as num?)?.toDouble() ?? 0;
    final double bottom = (work["bottom"] as num?)?.toDouble() ?? 0;
    double x = right - size.width - 24;
    double y = top + ((bottom - top) - size.height) / 2;
    if (x < left) x = left;
    if (y < top) y = top;
    await windowManager.setPosition(Offset(x, y));
  } catch (_) {
    // 查询失败保持默认位置，不影响展示
  }
}

Future<void> _deleteQuietly(String path) async {
  try {
    await File(path).delete();
  } catch (_) {
    // 清理失败无害：文件在 %TEMP%，系统会回收
  }
}

// ═══════════════════════════════════════════════════════════════════
// 子进程窗口宿主：WebView 渲染设计稿
// ═══════════════════════════════════════════════════════════════════

class DailyBriefingWindowApp extends StatefulWidget {
  const DailyBriefingWindowApp({super.key, required this.payload});

  /// 解码失败时为 null，展示错误兜底。
  final DailyBriefingWindowPayload? payload;

  @override
  State<DailyBriefingWindowApp> createState() => _DailyBriefingWindowAppState();
}

class _DailyBriefingWindowAppState extends State<DailyBriefingWindowApp> {
  final WebviewController _controller = WebviewController();
  bool _webReady = false;
  bool _webFailed = false;
  Timer? _autoHideTimer;

  DailyBriefingWindowPayload? get _payload => widget.payload;

  @override
  void initState() {
    super.initState();
    _bootstrap();
  }

  @override
  void dispose() {
    _autoHideTimer?.cancel();
    super.dispose();
  }

  Future<void> _bootstrap() async {
    try {
      // 双保险：入口处已 await 过，这里兜底（幂等）
      await bootstrapWindowsWebView();
      await _controller.initialize();
      // 与窗口底色一致（不透明深底），避免圆角/边缘露出白底或残留
      await _controller.setBackgroundColor(const Color(0xFF0A0B0E));
      // 注意：setPopupWindowPolicy 内部断言 isInitialized，必须在 initialize 之后
      await _controller.setPopupWindowPolicy(WebviewPopupWindowPolicy.deny);
      _controller.webMessage.listen(_onWebMessage);
      final File htmlFile = await _writeHtmlFile();
      await _controller.loadUrl(htmlFile.uri.toString());
      if (mounted) setState(() => _webReady = true);
      _armAutoHide();
    } catch (e) {
      // WebView 初始化失败：展示兜底文案（而不是隐身退出），自动淡出兜底
      debugPrint("[DailyBriefingWindow] webview bootstrap failed: $e");
      if (mounted) setState(() => _webFailed = true);
      _autoHideTimer = Timer(const Duration(seconds: 30), () {
        unawaited(_close());
      });
    }
  }

  Future<File> _writeHtmlFile() async {
    final String tempDir = Platform.environment["TEMP"] ??
        Platform.environment["TMP"] ??
        Directory.systemTemp.path;
    final String path = "$tempDir${Platform.pathSeparator}"
        "pai_daily_briefing_${DateTime.now().microsecondsSinceEpoch}.html";
    final File file = File(path);
    await file.writeAsString(
      buildBriefingHtml(
        briefing: _payload?.briefing,
        narrationText: _payload?.narrationText ?? "",
        appellation: _payload?.appellation ?? "",
      ),
      flush: true,
    );
    // 窗口关闭后由 %TEMP% 系统回收，不主动删（WebView2 可能仍持有句柄）
    return file;
  }

  void _armAutoHide() {
    _autoHideTimer?.cancel();
    _autoHideTimer = Timer(const Duration(minutes: 5), () {
      unawaited(_close());
    });
  }

  Future<void> _close() async {
    try {
      await windowManager.destroy();
    } catch (_) {
      // destroy 失败（如窗口未就绪）也继续退出
    }
    // Flutter 进程在最后一个窗口销毁后不会自动退出，显式结束
    exit(0);
  }

  // ---- JS bridge ----

  Future<void> _onWebMessage(dynamic message) async {
    try {
      if (message is! Map) return;
      final Map<dynamic, dynamic> msg = message;
      switch (msg["action"]) {
        case "close":
          await _close();
          break;
        case "drag":
          await windowManager.startDragging();
          break;
        case "height":
          await _fitWindowHeight((msg["value"] as num?)?.toDouble() ?? 0);
          break;
      }
    } catch (_) {
      // ignore malformed messages
    }
  }

  /// 按页面上报的内容高校正窗口高度（并重新贴右居中）。
  /// 与当前高度差 ≤2px 不动，避免抖动；上限 = 工作区高 - 48（超出时卡内滚动）。
  Future<void> _fitWindowHeight(double contentH) async {
    if (!contentH.isFinite) return;
    final double maxH = await _maxWindowHeight();
    final double target = contentH.clamp(120.0, maxH).toDouble();
    try {
      final Size size = await windowManager.getSize();
      if ((size.height - target).abs() <= 2) return;
      await windowManager.setSize(Size(kCardWidth, target));
      await _positionRightCenter();
    } catch (e) {
      debugPrint("[DailyBriefingWindow] fit height failed: $e");
    }
  }

  /// 窗口高度上限：工作区高 - 48（上下各留 24，绝不超出屏幕）。
  Future<double> _maxWindowHeight() async {
    try {
      const MethodChannel channel = MethodChannel("pai/daily_briefing");
      final Map<dynamic, dynamic>? work =
          await channel.invokeMethod<Map<dynamic, dynamic>>("getWorkArea");
      final double top = (work?["top"] as num?)?.toDouble() ?? 0;
      final double bottom = (work?["bottom"] as num?)?.toDouble() ?? 0;
      final double h = bottom - top - 48;
      return h > 240 ? h : 240;
    } catch (_) {
      return 900;
    }
  }

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      debugShowCheckedModeBanner: false,
      theme: ThemeData(
        useMaterial3: true,
        scaffoldBackgroundColor: const Color(0xFF0A0B0E),
      ),
      home: Scaffold(
        backgroundColor: const Color(0xFF0A0B0E),
        body: _webReady
            ? Webview(_controller)
            : Container(
                width: kCardWidth,
                padding: const EdgeInsets.all(20),
                alignment: Alignment.centerLeft,
                child: Text(
                  _webFailed ? "简报显示组件加载失败" : "正在加载今日简报…",
                  style: const TextStyle(color: Color(0xFF8F97A3), fontSize: 12),
                ),
              ),
      ),
    );
  }
}

// 卡面 HTML / 高度估算 / 内容拼装见 core/services/daily_briefing_card_render.dart
// （纯 Dart 模块，窗口宿主与 tool/preview_briefing.dart 共用同一份，避免两头维护）。
