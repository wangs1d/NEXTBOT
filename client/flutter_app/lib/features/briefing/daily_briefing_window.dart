import "dart:async";
import "dart:convert";
import "dart:io";
import "dart:math";

import "package:flutter/material.dart";
import "package:flutter/services.dart";
import "package:webview_windows/webview_windows.dart";
import "package:window_manager/window_manager.dart";

import "../../core/services/access_auth_api.dart";
import "../../core/services/account_profile_api.dart";
import "../../core/services/briefing_tts_api.dart";
import "../../core/services/daily_briefing_card_model.dart";
import "../../core/services/tts_player.dart";
import "../../core/services/windows_webview_bootstrap.dart";

// ═══════════════════════════════════════════════════════════════════
// 今日简报独立系统窗口（WebView 版，一比一还原 design/daily-briefing-
// floating.html「优化版 · 黑 · 简洁」设计稿）。
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
//   postMessage {action:"drag"}   → startDragging（顶部问候区拖动）
//   postMessage {action:"click"}  → 播报中=打断 / 空闲=重播
// Dart → JS：executeScript 调 window.__setPlaying(posMs, durMs) /
//   window.__setIdle(label) 驱动播报行形态。
//
// 2026-09-24 结构化行卡改版：卡面全部直出结构化字段（日程·待办·笔记·
// 热搜·重要日子全量行），不再印口播稿（口播稿只进耳朵，点击卡片即 TTS）；
// 无「展开详情」第二跳——私人管家简报一眼看全。
// 2026-10-16 天气/穿衣迁出简报卡面（搬往睡前提醒 evening.digest），
// 温度大字/天气副行/穿衣行与对应高度常量一并删除。
// ═══════════════════════════════════════════════════════════════════

/// 子进程窗口模式的环境变量名（值为载荷 JSON 文件路径）。
const String kDailyBriefingWindowEnv = "PAI_DAILY_BRIEFING_WINDOW";

/// 卡片逻辑宽（= 设计稿宽，Flutter 逻辑像素与 CSS 像素 1:1）。
const double kCardWidth = 400;

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
    size: Size(kCardWidth, briefingWindowHeight(payload)),
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

/// 窗口高（逻辑像素）：与 buildBriefingHtml 的 CSS 布局 1:1 对应。
///
/// 2026-09-24 结构化行卡改版后所有行高在 CSS 里钉死（单行省略，不换行），
/// 本函数按同一组常量精确累加——口播稿不再印上卡面，高度与文字长短无关；
/// 唯一可变项是全空兜底时的口播稿块（按 25 字/行估算）。
double briefingWindowHeight(DailyBriefingWindowPayload? payload) {
  const double padTop = 20, padBottom = 18;
  const double greetH = 24, metaGap = 5, metaH = 17;
  const double secGap = 14, secLabelH = 15, rowH = 30;
  const double doneGap = 4, doneH = 18;
  const double statusGap = 14, statusPadTop = 12, statusH = 22;
  const double scriptGap = 15, scriptLineH = 25;

  final Map<String, dynamic>? briefing = payload?.briefing;
  final _BriefingLayout layout = _BriefingLayout.of(briefing);

  double h = padTop + greetH + metaGap + metaH;
  // markdown 文档流（与 .md CSS 一一对应）：板块标题 + 行列表
  int rowsOf(String key) {
    final Object? raw = briefing?[key];
    return raw is List ? raw.length : 0;
  }

  int todoPendingRows() => layout.todoPending.length;
  // 今日日程 / 待办跟进 / 待复习笔记 / 兴趣热搜 / 近期重要日子（全量直出，无展开）
  h += rowsOf("todaySchedule") > 0 ? secGap + secLabelH + rowsOf("todaySchedule") * rowH : 0;
  h += todoPendingRows() > 0 ? secGap + secLabelH + todoPendingRows() * rowH : 0;
  if (todoPendingRows() > 0 && layout.doneTodayCount > 0) h += doneGap + doneH;
  h += rowsOf("pendingNotes") > 0 ? secGap + secLabelH + rowsOf("pendingNotes") * rowH : 0;
  h += rowsOf("interestHits") > 0 ? secGap + secLabelH + rowsOf("interestHits") * rowH : 0;
  h += rowsOf("upcomingImportantDays") > 0
      ? secGap + secLabelH + rowsOf("upcomingImportantDays") * rowH
      : 0;
  // 全空兜底：口播稿印上卡面（正常版式下口播稿只进耳朵不进眼睛）
  final String narration = payload?.narrationText.trim() ?? "";
  final bool scriptFallback =
      briefing != null && !layout.hasAnySection && narration.isNotEmpty;
  if (scriptFallback) {
    final int lines = max(1, (narration.length / 25).ceil());
    h += scriptGap + lines * scriptLineH;
  }
  h += statusGap + statusPadTop + statusH + padBottom;
  return h;
}

/// 版式要素抽取（HTML 生成与高度计算共用同一份判定，防两端不一致）。
class _BriefingLayout {
  const _BriefingLayout({
    required this.todoPending,
    required this.doneTodayCount,
    required this.hasAnySection,
  });

  final List<String> todoPending;
  final int doneTodayCount;
  final bool hasAnySection;

  static _BriefingLayout of(Map<String, dynamic>? briefing) {
    final List<String> pending = <String>[];
    int doneCount = 0;
    final Object? rawTodo = briefing?["todoFollowups"];
    if (rawTodo is Map) {
      final Object? rawPending = rawTodo["pending"];
      if (rawPending is List) {
        pending.addAll(rawPending
            .map((Object? e) => e?.toString() ?? "")
            .where((String s) => s.isNotEmpty));
      }
      final Object? rawDone = rawTodo["doneTodayCount"];
      if (rawDone is num) doneCount = rawDone.round();
    }

    bool hasAnySection() {
      bool nonEmpty(String key) {
        final Object? raw = briefing?[key];
        return raw is List && raw.isNotEmpty;
      }

      return nonEmpty("todaySchedule") ||
          pending.isNotEmpty ||
          nonEmpty("pendingNotes") ||
          nonEmpty("interestHits") ||
          nonEmpty("upcomingImportantDays");
    }

    return _BriefingLayout(
      todoPending: pending,
      doneTodayCount: doneCount,
      hasAnySection: hasAnySection(),
    );
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
// 子进程窗口宿主：WebView 渲染设计稿 + TTS 播报编排
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
  StreamSubscription<TtsPlaybackProgress>? _progressSub;
  bool _stopRequested = false;
  String? _audioBase64;
  DateTime _lastProgressPush = DateTime.fromMillisecondsSinceEpoch(0);

  DailyBriefingWindowPayload? get _payload => widget.payload;

  @override
  void initState() {
    super.initState();
    TtsPlayer.instance.addOnCompleted(_onPlaybackCompleted);
    _bootstrap();
  }

  @override
  void dispose() {
    _autoHideTimer?.cancel();
    _progressSub?.cancel();
    TtsPlayer.instance.removeOnCompleted(_onPlaybackCompleted);
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
      if (_payload != null) {
        unawaited(_speak(_payload!.narrationText.trim()));
      }
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
    await file.writeAsString(buildBriefingHtml(_payload), flush: true);
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
        case "click":
          _onCardClicked();
          break;
      }
    } catch (_) {
      // ignore malformed messages
    }
  }

  // ---- 语音播报 ----

  Future<void> _speak(String script) async {
    if (script.isEmpty) {
      await _pushIdle("语音暂不可用");
      return;
    }
    final String? base64Audio = await BriefingTtsApi.fetchSpeech(script);
    if (base64Audio == null) {
      await _pushIdle("语音暂不可用 · 点击重试");
      return;
    }
    _audioBase64 = base64Audio;
    await _playCached();
  }

  Future<void> _playCached() async {
    final String? audio = _audioBase64;
    if (audio == null) return;
    await _progressSub?.cancel();
    _progressSub = TtsPlayer.instance.onProgress.listen(
      _onPlaybackProgress,
      onError: (_) {},
    );
    final bool ok = await TtsPlayer.instance.playFromBase64(audio);
    if (!ok) await _pushIdle("语音暂不可用 · 点击重试");
  }

  void _onPlaybackProgress(TtsPlaybackProgress progress) {
    // executeScript 有往返成本，节流到 ≥300ms 一次
    final DateTime now = DateTime.now();
    if (now.difference(_lastProgressPush) < const Duration(milliseconds: 300)) {
      return;
    }
    _lastProgressPush = now;
    unawaited(_runJs(
      "window.__setPlaying(${progress.position.inMilliseconds}, "
      "${progress.duration?.inMilliseconds ?? 0});",
    ));
  }

  void _onPlaybackCompleted() {
    final bool stopped = _stopRequested;
    _stopRequested = false;
    final DateTime now = DateTime.now();
    final String label = stopped
        ? "已停止播报 · 点击重播"
        : "已播报 · ${now.hour}:${now.minute.toString().padLeft(2, "0")}";
    unawaited(_pushIdle(label));
  }

  void _onCardClicked() {
    if (TtsPlayer.instance.isPlaying) {
      _stopRequested = true;
      unawaited(TtsPlayer.instance.stop());
      return;
    }
    // 空闲点击 = 重播
    if (_audioBase64 != null) {
      unawaited(_playCached());
    } else if (_payload != null) {
      unawaited(_speak(_payload!.narrationText.trim()));
    }
  }

  Future<void> _pushIdle(String label) async {
    await _runJs("window.__setIdle(${jsonEncode(label)});");
  }

  Future<void> _runJs(String script) async {
    try {
      if (_webReady) await _controller.executeScript(script);
    } catch (e) {
      debugPrint("[DailyBriefingWindow] executeScript failed: $e");
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

// ═══════════════════════════════════════════════════════════════════
// 设计稿 HTML（一比一还原 design/daily-briefing-floating.html）
// ═══════════════════════════════════════════════════════════════════

String _esc(String text) => text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;");

/// 口播稿时间高亮：HH:MM → 白色加粗（设计稿 .hl）。
String _highlightScript(String plainEscaped) {
  return plainEscaped.replaceAllMapped(
    RegExp(r"(\d{1,2}:\d{2})"),
    (Match m) => "<b class=\"hl\">${m.group(1)}</b>",
  );
}

/// 兴趣热搜行文案：「标题 · 平台」。
String _interestHitText(Map<String, dynamic> item) {
  final String title = item["title"]?.toString() ?? "";
  final String platform = item["platform"]?.toString() ?? "";
  return platform.isEmpty ? "**$title**" : "**$title** · $platform";
}

/// 重要日子行文案：「name的生日 · 还有 3 天」。
String _importantDayText(Map<String, dynamic> item) {
  final String name = item["name"]?.toString() ?? "";
  final String type = item["type"]?.toString() ?? "";
  final String typeLabel =
      type == "anniversary" ? "纪念日" : type == "custom" ? "特殊日子" : "生日";
  final Object? rawDays = item["daysUntil"];
  final String when = rawDays is int
      ? (rawDays == 0 ? "就是今天" : rawDays == 1 ? "明天" : "还有 $rawDays 天")
      : "";
  return "$name的$typeLabel${when.isEmpty ? "" : " · **$when**"}";
}

/// 把结构化简报组装成 markdown 文档（2026-09-25：卡面内容层 = markdown，
/// 调内容只动这里，不碰 HTML/CSS）。固定顺序：五板块（## 标题 + - 列表 +
/// 完成数纯文本行）；2026-10-16 天气/穿衣迁往睡前提醒，不再上卡面。
String _composeBriefingMarkdown(
    Map<String, dynamic>? briefing, _BriefingLayout layout) {
  final StringBuffer buf = StringBuffer();
  if (briefing == null) return buf.toString();

  List<Map<String, dynamic>> listOf(String key) {
    final Object? raw = briefing[key];
    if (raw is! List) return const <Map<String, dynamic>>[];
    return raw
        .whereType<Map>()
        .map((Map e) => e.cast<String, dynamic>())
        .toList();
  }

  final List<Map<String, dynamic>> schedule = listOf("todaySchedule");
  if (schedule.isNotEmpty) {
    buf.writeln("## 📅 今日日程");
    for (final Map<String, dynamic> s in schedule) {
      final String time = s["time"]?.toString() ?? "";
      final String title = (s["title"] ?? "").toString();
      buf.writeln(time.isEmpty ? "- $title" : "- **$time** $title");
    }
  }

  if (layout.todoPending.isNotEmpty) {
    buf.writeln("## ✅ 待办跟进");
    for (final String pending in layout.todoPending) {
      buf.writeln("- $pending");
    }
    if (layout.doneTodayCount > 0) {
      buf.writeln("今天已完成 ${layout.doneTodayCount} 件");
    }
  }

  final List<Map<String, dynamic>> notes = listOf("pendingNotes");
  if (notes.isNotEmpty) {
    buf.writeln("## 📝 待复习笔记");
    for (final Map<String, dynamic> n in notes) {
      buf.writeln("- ${(n["title"] ?? "").toString()}");
    }
  }

  final List<Map<String, dynamic>> hits = listOf("interestHits");
  if (hits.isNotEmpty) {
    buf.writeln("## 🔥 兴趣热搜");
    for (final Map<String, dynamic> h in hits) {
      buf.writeln("- ${_interestHitText(h)}");
    }
  }

  final List<Map<String, dynamic>> days = listOf("upcomingImportantDays");
  if (days.isNotEmpty) {
    buf.writeln("## 🎉 近期重要日子");
    for (final Map<String, dynamic> d in days) {
      buf.writeln("- ${_importantDayText(d)}");
    }
  }

  return buf.toString();
}

/// 极小 markdown 渲染器（卡面内容子集，零依赖）：
/// `##` 标题、`- ` 列表、`**加粗**`、空行分隔；其余行为纯文本段落。
/// 先整体 HTML 转义再施加行内标记，杜绝内容注入。
String _markdownToHtml(String md) {
  final StringBuffer html = StringBuffer();
  final List<String> listItems = <String>[];
  // 行首加粗且为 HH:mm = 时间列（tm 蓝色定宽）；其余加粗 = 普通强调（白色），
  // 如热搜标题、重要日子倒计时。
  String renderLi(String item) {
    final Match? m = RegExp(r"^<strong>(.*?)</strong>").firstMatch(item);
    if (m == null) return item;
    final String text = m.group(1) ?? "";
    // 行首加粗且内容为 HH:mm 才算时间列（tm 蓝色定宽）；其余加粗按普通强调
    final bool isTime = RegExp(r"^\d{1,2}:\d{2}$").hasMatch(text);
    return isTime
        ? "<strong class=\"tm\">$text</strong>${item.substring(m.end)}"
        : item;
  }

  void flushList() {
    if (listItems.isEmpty) return;
    html.write("<ul>");
    for (final String item in listItems) {
      html.write("<li>${renderLi(item)}</li>");
    }
    html.write("</ul>");
    listItems.clear();
  }

  for (final String rawLine in md.split("\n")) {
    final String line = rawLine.trim();
    if (line.isEmpty) {
      flushList();
    } else if (line.startsWith("## ")) {
      flushList();
      html.write("<h2>${_inlineMarkdown(_esc(line.substring(3).trim()))}</h2>");
    } else if (line.startsWith("- ")) {
      listItems.add(_inlineMarkdown(_esc(line.substring(2).trim())));
    } else {
      flushList();
      html.write("<p>${_inlineMarkdown(_esc(line))}</p>");
    }
  }
  flushList();
  return html.toString();
}

/// 行内标记：`**bold**` → strong（转义后的文本上做，安全）。
String _inlineMarkdown(String escaped) {
  return escaped.replaceAllMapped(
    RegExp(r"\*\*(.+?)\*\*"),
    (Match m) => "<strong>${m.group(1)}</strong>",
  );
}

/// 生成简报卡片页面（与窗口同尺寸，透明背景 + 圆角卡片）。
///
/// 2026-09-24 结构化行卡版式：无「展开详情」，一眼看全；2026-09-25 起
/// 卡面内容由 markdown 文档驱动（_composeBriefingMarkdown → _markdownToHtml），
/// 口播稿只在全空兜底时上卡（正常路径口播稿只进 TTS 不进眼睛）。
String buildBriefingHtml(DailyBriefingWindowPayload? payload) {
  final DailyBriefingCardContent content = payload == null
      ? const DailyBriefingCardContent(
          greeting: "", meta: "", script: "", stats: <DailyBriefingStat>[])
      : buildDailyBriefingCard(
          briefing: payload.briefing,
          narrationText: payload.narrationText,
          appellation: payload.appellation,
        );
  final Map<String, dynamic>? briefing = payload?.briefing;
  final _BriefingLayout layout = _BriefingLayout.of(briefing);

  // meta 只放日期
  final String metaLine = dailyBriefingDateLabel(DateTime.now());

  final String narration = payload?.narrationText.trim() ?? "";
  final bool scriptFallback =
      payload != null && !layout.hasAnySection && narration.isNotEmpty;
  final String scriptHtml = scriptFallback
      ? "<div class=\"script\">${_highlightScript(_esc(narration))}</div>"
      : "";

  final String mdHtml =
      _markdownToHtml(_composeBriefingMarkdown(briefing, layout));

  return """
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body {
    width: 100%; height: 100%;
    /* 不透明深底：与窗口/WebView 底色一致，圆角残留由原生 DWM 圆角裁掉 */
    background: rgb(10, 11, 14);
    font-family: "Segoe UI", "Microsoft YaHei", "PingFang SC", sans-serif;
    user-select: none; overflow: hidden;
    color: #eceff4;
  }
  .widget {
    position: relative;
    width: ${kCardWidth}px;
    min-height: 100%;
    background: rgba(10, 11, 14, 0.86);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 16px;
    box-shadow: 0 24px 70px rgba(0, 0, 0, 0.5), inset 1px 0 0 rgba(255, 255, 255, 0.05);
    padding: 20px 22px 18px;
    overflow: hidden;
    cursor: pointer;
  }
  .close {
    position: absolute; top: 8px; right: 8px; z-index: 5;
    width: 34px; height: 34px; border-radius: 10px;
    display: flex; align-items: center; justify-content: center;
    color: rgba(255,255,255,0.45); cursor: pointer; transition: all .15s;
  }
  .close:hover { background: rgba(255,255,255,0.12); color: #eceff4; }
  .close svg { width: 16px; height: 16px; }

  /* ── 行高钉死区（briefingWindowHeight 按同一组常量累加，改这里必须同步改 Dart）── */
  .greet .name { font-size: 17px; font-weight: 600; line-height: 24px; letter-spacing: .3px; }
  .greet .meta { margin-top: 5px; font-size: 12px; line-height: 17px; color: #8f97a3; letter-spacing: .2px; }

  /* ── markdown 内容层样式 ── */
  .md p { margin: 12px 0 0; height: 20px; line-height: 20px; font-size: 12.5px; color: #8f97a3; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .md p strong { color: #ccd2db; font-weight: 600; margin-right: 6px; }
  .md h2 { margin: 14px 0 0; height: 15px; line-height: 15px; display: flex; align-items: center; gap: 8px; font-size: 10.5px; color: #8f97a3; letter-spacing: 2px; font-weight: 600; }
  .md h2::after { content: ""; flex: 1; height: 1px; background: rgba(255,255,255,.06); }
  .md ul { margin: 0; padding: 0; list-style: none; }
  .md li { height: 30px; line-height: 30px; padding: 0 6px; border-radius: 10px; font-size: 13px; color: #eceff4; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .md li:hover { background: rgba(255,255,255,.04); }
  .md li strong { color: #eceff4; font-weight: 600; }
  .md li strong.tm { color: #a8c8ff; display: inline-block; width: 42px; font-variant-numeric: tabular-nums; }
  .md ul + p { margin: 4px 0 0; height: 18px; line-height: 18px; padding: 0 6px; font-size: 11.5px; color: #5c6370; }

  .script { margin-top: 15px; font-size: 14px; line-height: 25px; color: #ccd2db; letter-spacing: .2px; }
  .script .hl { color: #eceff4; font-weight: 600; }

  /* 播报状态行：wave/idle 同盒同高（34 = 12 padding + 22），切换不跳动 */
  .status {
    margin-top: 14px; padding-top: 12px; height: 34px;
    border-top: 1px solid rgba(255,255,255,.07);
    display: flex; align-items: center; gap: 8px;
    font-size: 11px; color: #8f97a3; letter-spacing: 2px;
  }
  #row-idle { display: none; }
  .status .ok { width: 5px; height: 5px; border-radius: 50%; background: #88bbff; box-shadow: 0 0 6px rgba(136,187,255,.8); flex-shrink: 0; }
  .status .time { margin-left: auto; font-variant-numeric: tabular-nums; letter-spacing: 0; }
  .wave { display: flex; align-items: center; gap: 3px; height: 16px; }
  .wave i { width: 3px; border-radius: 2px; background: #88bbff; animation: bar 1s ease-in-out infinite; }
  .wave i:nth-child(1) { height: 6px; animation-delay: 0s; }
  .wave i:nth-child(2) { height: 12px; animation-delay: .15s; }
  .wave i:nth-child(3) { height: 16px; animation-delay: .3s; }
  .wave i:nth-child(4) { height: 10px; animation-delay: .45s; }
  .wave i:nth-child(5) { height: 13px; animation-delay: .6s; }
  .wave i:nth-child(6) { height: 7px; animation-delay: .75s; }
  .wave i:nth-child(7) { height: 11px; animation-delay: .9s; }
  @keyframes bar { 0%,100% { transform: scaleY(.4); opacity: .5; } 50% { transform: scaleY(1); opacity: 1; } }
</style>
</head>
<body>
<div class="widget" id="card">
  <div class="close" id="close" title="关闭">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
  </div>

  <div class="greet" id="dragzone">
    <div>
      <div class="name">${_esc(content.greeting)}</div>
      <div class="meta">${_esc(metaLine)}</div>
    </div>
  </div>

  <div class="md">$mdHtml</div>
  $scriptHtml

  <div class="status" id="row-wave">
    <div class="wave"><i></i><i></i><i></i><i></i><i></i><i></i><i></i></div>
    <div>语音播报中</div>
    <div class="time" id="tprog">00:00 / 00:00</div>
  </div>
  <div class="status" id="row-idle"><span class="ok"></span><span id="idle-label">已播报</span></div>
</div>

<script>
  var pai = function (m) { try { window.chrome.webview.postMessage(m); } catch (e) {} };
  function fmt(ms) {
    var t = Math.max(0, Math.floor(ms / 1000));
    var m = Math.floor(t / 60), s = t % 60;
    var p = function (n) { return n < 10 ? "0" + n : "" + n; };
    return p(m) + ":" + p(s);
  }
  document.getElementById("close").addEventListener("click", function (e) {
    e.stopPropagation(); pai({ action: "close" });
  });
  // 整卡点击/拖拽判定（此前只绑 greet 区 pointerdown 直接进原生拖拽，
  // 拖拽循环吞掉 click，导致顶部点击不播报）：
  //   按下后位移 ≤6px 松开 = 点击 → 播报/停止/重播；
  //   位移超阈值 = 拖拽 → startDragging（原生接管，不再回吐 click）。
  var card = document.getElementById("card");
  var downX = 0, downY = 0, pressed = false, dragSent = false;
  function onControl(t) { return !!(t && t.closest && t.closest("#close")); }
  card.addEventListener("pointerdown", function (e) {
    if (e.button !== 0 || onControl(e.target)) return;
    pressed = true; dragSent = false; downX = e.clientX; downY = e.clientY;
  });
  card.addEventListener("pointermove", function (e) {
    if (!pressed || dragSent) return;
    if (Math.abs(e.clientX - downX) > 6 || Math.abs(e.clientY - downY) > 6) {
      dragSent = true;
      pai({ action: "drag" });
    }
  });
  card.addEventListener("pointerup", function (e) {
    if (!pressed) return;
    var wasDrag = dragSent;
    pressed = false; dragSent = false;
    if (!wasDrag && e.button === 0 && !onControl(e.target)) pai({ action: "click" });
  });
  card.addEventListener("pointercancel", function () {
    pressed = false; dragSent = false;
  });
  window.__setPlaying = function (posMs, durMs) {
    document.getElementById("row-wave").style.display = "flex";
    document.getElementById("row-idle").style.display = "none";
    document.getElementById("tprog").textContent = fmt(posMs) + " / " + fmt(durMs || 0);
  };
  window.__setIdle = function (label) {
    document.getElementById("row-wave").style.display = "none";
    document.getElementById("row-idle").style.display = "flex";
    document.getElementById("idle-label").textContent = label;
  };
</script>
</body>
</html>
""";
}
