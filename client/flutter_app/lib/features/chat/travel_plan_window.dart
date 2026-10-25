import "dart:async";
import "dart:convert";
import "dart:io";

import "package:flutter/material.dart";
import "package:window_manager/window_manager.dart";

import "../../core/services/access_auth_api.dart";
import "../../core/services/windows_webview_bootstrap.dart";
import "../../core/theme/app_theme.dart";
import "../../core/utils/agent_result_parser.dart";
import "travel_plan_models.dart";
import "travel_plan_panel.dart";
import "travel_web_panel_host.dart";

// ═══════════════════════════════════════════════════════════════════
// 行程规划独立系统窗口（常驻进程 + 信箱轮询）
//
// 与桌宠（sphere-overlay-py 子进程）同款「独立进程」方案：主应用 spawn 自己
// 的 exe 并经环境变量传递信箱目录；子进程的 main() 检测到该环境变量即走本
// 文件的窗口分支，不再启动完整应用。
//
// 为什么不用同进程第二引擎（desktop_multi_window）：其子窗口引擎不执行
// 插件注册，webview_windows（地图 WebView）不可用；而 runner 内链接第二
// 套 WebView2 与 webview_windows 冲突会崩溃（见 sphere_overlay_window.cpp
// 顶部注释）。独立进程天然规避这两条限制，地图/路线规划全功能可用。
//
// 预加载/零等待（2026-09 大优化）：
// - 子进程启动即预热共享 WebView（本机 server 行程页常驻），
//   与窗口创建并行，首次打开也不再白等地图；
// - 进程常驻：关闭窗口 = 隐藏，进程与 WebView 保活；再次打开行程时主应用
//   只往信箱写一条指针，子进程 500ms 内换载数据并前置窗口——零重载；
// - 父进程守护：主应用退出（含崩溃）后 5s 内子进程自毁，不留孤儿窗口。
// ═══════════════════════════════════════════════════════════════════

/// 行程窗口模式的环境变量名（值为信箱目录路径）。
const String kTravelPlanWindowEnv = "PAI_TRAVEL_PLAN_MAILBOX";

/// 预热模式环境变量（值"1"=以隐藏态拉起，等首个 reveal 载荷再显窗）。
const String kTravelPlanWindowHiddenEnv = "PAI_TRAVEL_PLAN_HIDDEN";

/// 主应用进程 PID 的环境变量名（子进程守护用）。
const String kTravelPlanParentPidEnv = "PAI_TRAVEL_PLAN_PARENT_PID";

/// 行程规划独立窗口默认尺寸。
///
/// 与页面设计稿（`server/web/travel-map/desktop.html`）的版面尺寸一致：
/// 1:1 呈现的前提是窗口就是设计稿那扇窗（1140×740），最大化留给用户自己按。
const Size kTravelPlanWindowSize = Size(1140, 740);

/// 行程窗口载荷：卡片数据（或服务端行程 JSON）+ 打开时刻的主题变体。
///
/// [reveal]=false 的载荷是预热注入（窗口保持隐藏）；true 才驱动显窗。
/// [card] 与 [planJson] 二选一：聊天卡片走 [card]（AgentResultData），
/// 行程归档等已有服务端行程 JSON 的调用方走 [planJson]（GET /travel/plans/:id
/// 的 plan 字段原样透传，避免 AgentResultData 往返转换丢字段）。
class TravelPlanWindowPayload {
  const TravelPlanWindowPayload({
    this.card,
    this.planJson,
    required this.theme,
    this.reveal = true,
  }) : assert(
          (card == null) != (planJson == null),
          "card 与 planJson 必须二选一",
        );

  final AgentResultData? card;

  /// 服务端行程 JSON（TravelPlanData.fromPlanJson 直接吃）。
  final Map<String, dynamic>? planJson;

  final AppThemeVariant theme;

  /// 是否随载荷显窗（预热载荷为 false）。
  final bool reveal;

  String encode() => jsonEncode(<String, dynamic>{
        "version": 1,
        "theme": theme.name,
        "reveal": reveal,
        if (card != null) "card": card!.toJson(),
        if (planJson != null) "plan": planJson,
      });

  /// 解码失败（文件损坏/版本不符）时返回 null，宿主展示错误页。
  static TravelPlanWindowPayload? tryDecode(String raw) {
    try {
      final Object? decoded = jsonDecode(raw);
      if (decoded is! Map<String, dynamic>) return null;
      final Object? rawCard = decoded["card"];
      final Object? rawPlan = decoded["plan"];
      if ((rawCard is! Map<String, dynamic>) &&
          (rawPlan is! Map<String, dynamic>)) {
        return null;
      }
      final Object? rawTheme = decoded["theme"];
      final AppThemeVariant theme = AppThemeVariant.values.firstWhere(
        (AppThemeVariant v) => v.name == rawTheme,
        orElse: () => AppThemeVariant.dark,
      );
      final Object? rawReveal = decoded["reveal"];
      return TravelPlanWindowPayload(
        card: rawCard is Map<String, dynamic>
            ? AgentResultData.fromJson(rawCard)
            : null,
        planJson: rawPlan is Map<String, dynamic> ? rawPlan : null,
        theme: theme,
        reveal: rawReveal is bool ? rawReveal : true,
      );
    } catch (_) {
      return null;
    }
  }
}

/// 行程规划独立窗口启动器（主应用侧调用）。
///
/// 进程常驻：首次 open 时 spawn 子进程；此后再 open 复用同一进程——只把新
/// 载荷写进信箱（载荷文件 + latest.json 指针），子进程轮询指针毫秒级换载。
class TravelPlanWindowLauncher {
  TravelPlanWindowLauncher._();

  static Process? _current;

  /// 信箱目录（%TEMP%\pai_travel_plan_mailbox）。
  static Directory mailboxDir() {
    final String tempDir = Platform.environment["TEMP"] ??
        Platform.environment["TMP"] ??
        Directory.systemTemp.path;
    return Directory("$tempDir${Platform.pathSeparator}pai_travel_plan_mailbox");
  }

  /// 尝试在独立系统窗口中打开行程规划；成功返回 true。
  /// 失败（非 Windows / spawn 失败）时由调用方退回窗口内展示。
  static Future<bool> open(AgentResultData data) => _deliver(
        TravelPlanWindowPayload(
          card: data,
          theme: AppThemeController.instance.value,
        ),
      );

  /// 行程归档入口：直接透传服务端行程 JSON（GET /travel/plans/:id 的 plan），
  /// 子进程侧 TravelPlanData.fromPlanJson 直读，不经 AgentResultData 往返。
  static Future<bool> openPlanJson(Map<String, dynamic> planJson) => _deliver(
        TravelPlanWindowPayload(
          planJson: planJson,
          theme: AppThemeController.instance.value,
        ),
      );

  /// 预热（2026-09-25）：把行程载荷提前注入规划窗口，但不下发显示指令——
  /// 常驻进程存活时只换载数据；未拉起时以隐藏态 spawn（WebView/页面/地图
  /// 照常就绪）。用户随后点「打开行程规划」时零等待直接前置。
  static Future<bool> warm(AgentResultData data) => _deliver(
        TravelPlanWindowPayload(
          card: data,
          theme: AppThemeController.instance.value,
          reveal: false,
        ),
      );

  static Future<bool> _deliver(TravelPlanWindowPayload payload) async {
    if (!Platform.isWindows) return false;
    try {
      final Directory dir = mailboxDir();
      await dir.create(recursive: true);

      // 1. 写载荷文件（每次一个新文件，消费后由子进程删除）
      final int ts = DateTime.now().microsecondsSinceEpoch;
      final File payloadFile =
          File("${dir.path}${Platform.pathSeparator}plan-$ts.json");
      await payloadFile.writeAsString(payload.encode(), flush: true);

      // 2. 原子更新指针（写临时文件后 rename 覆盖，子进程不会读到半截 JSON）
      final File pointer = File("${dir.path}${Platform.pathSeparator}latest.json");
      final File pointerTmp =
          File("${dir.path}${Platform.pathSeparator}latest.json.tmp");
      await pointerTmp.writeAsString(
        jsonEncode(<String, dynamic>{"file": payloadFile.path, "ts": ts}),
        flush: true,
      );
      try {
        await pointerTmp.rename(pointer.path);
      } catch (_) {
        // rename 失败（目标被占用等）退回直写：内容小，半读风险可接受
        await pointer.writeAsString(
          jsonEncode(<String, dynamic>{"file": payloadFile.path, "ts": ts}),
          flush: true,
        );
      }

      // 3. 常驻进程存活 → 直接复用（子进程自行换载；reveal 载荷顺带前置窗口）
      if (await _isCurrentAlive()) return true;

      // 4. 无存活进程 → spawn。预热载荷以隐藏态拉起（窗口不抢焦点不弹屏）。
      //    父 PID 一并下发供守护自毁。
      final Process process = await Process.start(
        Platform.resolvedExecutable,
        const <String>[],
        environment: <String, String>{
          ...Platform.environment,
          kTravelPlanWindowEnv: dir.path,
          kTravelPlanParentPidEnv: pid.toString(),
          if (!payload.reveal) kTravelPlanWindowHiddenEnv: "1",
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

  /// 常驻子进程是否仍在运行（exitCode 已完成 = 已退出）。
  static Future<bool> _isCurrentAlive() async {
    final Process? p = _current;
    if (p == null) return false;
    try {
      await p.exitCode.timeout(Duration.zero);
      return false;
    } on TimeoutException {
      return true;
    }
  }
}

// ═══════════════════════════════════════════════════════════════════
// 子进程窗口分支（main() 检测到环境变量后进入）
// ═══════════════════════════════════════════════════════════════════

/// 行程规划独立窗口的子进程入口：预热 WebView → 信箱轮询 → 配置窗口 → runApp。
///
/// 窗口形态（2026-10-11 收敛）：**无边框**。页面是「行迹 · 桌面端」设计稿的
/// 1:1 呈现，自带标题栏（三色按钮 + 拖动区），系统标题栏会与之重复；因此窗口
/// 去边框，窗口控制经页面 → 桥 → [_handleWindowAction]。打开尺寸即设计稿尺寸
/// [kTravelPlanWindowSize]（不再默认最大化）。
///
/// 由 main() 在启动最早期调用（不 bootstrap 完整应用）。
Future<void> runTravelPlanWindow(String mailboxDirPath) async {
  WidgetsFlutterBinding.ensureInitialized();

  // WebView2 环境预热后预热共享 WebView：环境初始化是轻量 COM 调用（毫秒级），
  // await 住再 preload，避免 preload 的控制器初始化与环境兜底竞争；首次显示
  // 即有热地图，不再「打开后看转圈」。优先加入主应用的浏览器进程（省一份
  // 实例内存）；失败退回 _travel 专属目录自建（见 ensureChildWebViewEnvironment）。
  await ensureChildWebViewEnvironment("_travel");
  unawaited(AccessCredentialStore.instance.load());
  TravelWebPanelHost.preload();

  final TravelPlanWindowCoordinator coordinator = TravelPlanWindowCoordinator();
  coordinator.start(mailboxDirPath);
  _startParentWatchdog();

  await windowManager.ensureInitialized();
  // 无边框窗口（2026-10-11）：页面（行迹桌面页）自带设计稿的自绘标题栏
  // （三色按钮 + 标题 + 拖拽区），系统标题栏再叠一条 = 双标题栏。
  // 因此窗口去掉系统边框，拖动/最小化/最大化/关闭全部经页面标题栏 → 桥 →
  // _handleWindowAction 落到 windowManager。
  await windowManager.setAsFrameless();
  // 系统标题栏 X 不结束进程：拦截为隐藏，进程与 WebView 保活实现重开零等待
  await windowManager.setPreventClose(true);
  windowManager.addListener(_TravelPlanWindowListener());
  // 尺寸/位置由原生层在窗口创建那一刻一次定死（main.cpp 的
  // PAI_TRAVEL_PLAN_MAILBOX 分支按主屏工作区居中），Dart 侧不再 setAlignment
  // 居中——否则窗口创建后会被二次挪动，而二次挪动正是「幽灵窗」的成因
  // （且 window_manager 的居中按鼠标所在显示器算，与原生侧主屏不一定是同一块）。
  // 此处 size 保留为幂等校准：frameless 切换后触发重排，让 Flutter 视图与客户区同步。
  final WindowOptions options = WindowOptions(
    size: kTravelPlanWindowSize,
    title: "行程规划",
    backgroundColor: Colors.transparent,
    titleBarStyle: TitleBarStyle.hidden,
  );
  await windowManager.waitUntilReadyToShow(options, () async {
    // 预热拉起：窗口保持隐藏（进程与共享 WebView 照常就绪），等首个
    // reveal 载荷经 _revealIfNeeded 显窗——用户点卡片按钮时零等待前置。
    if (Platform.environment[kTravelPlanWindowHiddenEnv] == "1") return;
    await windowManager.show();
    await windowManager.focus();
  });
  runApp(TravelPlanWindowApp(coordinator: coordinator));
}

/// 页面自绘标题栏的窗口动作（无边框窗口）：拖拽 / 最小化 / 最大化还原。
Future<void> _handleWindowAction(String action) async {
  try {
    switch (action) {
      case "windowDrag":
        await windowManager.startDragging();
      case "minimize":
        await windowManager.minimize();
      case "maximize":
        if (await windowManager.isMaximized()) {
          await windowManager.unmaximize();
        } else {
          await windowManager.maximize();
        }
      default:
        break;
    }
  } catch (_) {
    // 窗口尚未就绪等：静默忽略，不传染页面
  }
}

/// 行程信箱协调器（子进程内）：轮询 latest.json 指针，装载新载荷并通知 UI。
///
/// 关闭语义：[hide] 只隐藏窗口（进程常驻）；主应用退出后由父进程守护自毁。
class TravelPlanWindowCoordinator extends ChangeNotifier {
  TravelPlanWindowPayload? _payload;
  bool _failed = false;
  Timer? _pollTimer;
  DateTime _lastPointerMtime = DateTime.fromMillisecondsSinceEpoch(0);
  String _mailboxDir = "";

  /// 当前行程载荷（尚未收到数据时为 null，宿主展示等待/错误页）。
  TravelPlanWindowPayload? get payload => _payload;

  /// 初始装载确已失败（指针/载荷损坏）：区分「装载中」与「读取失败」。
  bool get hasFailed => _failed;

  void start(String mailboxDirPath) {
    _mailboxDir = mailboxDirPath;
    // 初始装载（主应用保证 spawn 前已写好指针），并把基线 mtime 定在当前值，
    // 避免首轮 poll 重复装载同一份
    try {
      _lastPointerMtime = File(_pointerPath()).statSync().modified;
    } catch (_) {/* 指针尚未就绪，poll 兜底 */}
    // 初始装载完成后仍无有效载荷 → 落错误页（避免永远停在装载中）
    unawaited(_loadFromPointer().then((_) {
      if (_payload == null && !_failed) {
        _failed = true;
        notifyListeners();
      }
    }));
    _pollTimer = Timer.periodic(
      const Duration(milliseconds: 500),
      (_) => unawaited(_poll()),
    );
  }

  String _pointerPath() =>
      "$_mailboxDir${Platform.pathSeparator}latest.json";

  Future<void> _poll() async {
    try {
      final DateTime mtime = File(_pointerPath()).statSync().modified;
      if (!mtime.isAfter(_lastPointerMtime)) return;
      _lastPointerMtime = mtime;
      await _loadFromPointer();
    } catch (_) {
      // 指针文件暂时不可读（主应用正在覆写等）：下轮再试
    }
  }

  Future<void> _loadFromPointer() async {
    try {
      final Object? pointer = jsonDecode(await File(_pointerPath()).readAsString());
      if (pointer is! Map<String, dynamic>) return;
      final Object? rawPath = pointer["file"];
      if (rawPath is! String || rawPath.isEmpty) return;
      final File payloadFile = File(rawPath);
      final String raw = await payloadFile.readAsString();
      try {
        await payloadFile.delete(); // 消费即删，信箱不留垃圾
      } catch (_) {/* 删除失败无害 */}
      final TravelPlanWindowPayload? payload = TravelPlanWindowPayload.tryDecode(raw);
      if (payload == null) {
        // 尚无有效载荷时标记失败（驱动错误页）；已有好数据则忽略坏指针
        if (_payload == null && !_failed) {
          _failed = true;
          notifyListeners();
        }
        return;
      }
      _payload = payload;
      notifyListeners();
      await _revealIfNeeded();
    } catch (_) {
      // 载荷读取失败（文件还没写完等）：等下一次指针变更
    }
  }

  /// 窗口处于隐藏态（上次被"关闭"/预热拉起）时收到 reveal 载荷 → 前置窗口。
  /// 预热载荷（reveal=false）只换载数据，不打扰用户当前屏幕。
  Future<void> _revealIfNeeded() async {
    try {
      if (_payload != null && !_payload!.reveal) return;
      if (!await windowManager.isVisible()) {
        await windowManager.show();
        await windowManager.focus();
      }
    } catch (_) {/* 窗口尚未初始化时忽略：初始 show 流程负责 */}
  }

  /// 「关闭」= 隐藏窗口保活进程（重开零等待）。
  Future<void> hide() async {
    try {
      await windowManager.hide();
    } catch (_) {
      // hide 失败（窗口未就绪）时兜底退出，避免不可关闭的幽灵窗口
      exit(0);
    }
  }

  @override
  void dispose() {
    _pollTimer?.cancel();
    super.dispose();
  }
}

/// 系统标题栏关闭拦截：X = 隐藏（进程常驻）。
class _TravelPlanWindowListener extends WindowListener {
  @override
  void onWindowClose() async {
    await windowManager.hide();
  }
}

/// 父进程守护：主应用退出（含崩溃）后子进程自毁，不留孤儿窗口。
///
/// 每 5s 用 tasklist 探测父 PID；找不到即退出。手动调试（无父 PID 环境变量）
/// 时不启用，方便单独拉起窗口开发。
void _startParentWatchdog() {
  final int? ppid = int.tryParse(
    Platform.environment[kTravelPlanParentPidEnv] ?? "",
  );
  if (ppid == null || ppid <= 0) return;
  Timer.periodic(const Duration(seconds: 5), (Timer t) async {
    try {
      final ProcessResult res = await Process.run(
        "tasklist",
        <String>["/FI", "PID eq $ppid", "/FO", "CSV", "/NH"],
      );
      final String out = res.stdout?.toString() ?? "";
      // CSV 输出中 PID 以带引号的字段出现；带引号匹配避免误命中更长 PID
      if (!out.contains('"$ppid"')) {
        t.cancel();
        exit(0);
      }
    } catch (_) {
      // 探测失败（tasklist 不可用等）：保守起见保活
    }
  });
}

/// 独立行程窗口根组件：与主应用一致的主题 + 沉浸式规划界面。
///
/// 载荷经 [TravelPlanWindowCoordinator] 动态更换（进程常驻复用）；更换时以
/// 载荷对象为 Key 重挂面板，保证面板内的行程状态整体重建。
class TravelPlanWindowApp extends StatefulWidget {
  const TravelPlanWindowApp({super.key, required this.coordinator});

  final TravelPlanWindowCoordinator coordinator;

  @override
  State<TravelPlanWindowApp> createState() => _TravelPlanWindowState();
}

class _TravelPlanWindowState extends State<TravelPlanWindowApp> {
  @override
  void initState() {
    super.initState();
    widget.coordinator.addListener(_onPayloadChanged);
  }

  @override
  void didUpdateWidget(covariant TravelPlanWindowApp oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (!identical(oldWidget.coordinator, widget.coordinator)) {
      oldWidget.coordinator.removeListener(_onPayloadChanged);
      widget.coordinator.addListener(_onPayloadChanged);
    }
  }

  @override
  void dispose() {
    widget.coordinator.removeListener(_onPayloadChanged);
    super.dispose();
  }

  void _onPayloadChanged() {
    if (mounted) setState(() {});
  }

  @override
  Widget build(BuildContext context) {
    final TravelPlanWindowPayload? p = widget.coordinator.payload;
    return MaterialApp(
      debugShowCheckedModeBanner: false,
      theme: AppTheme.of(p?.theme ?? AppThemeVariant.dark),
      home: p != null
          ? _buildPlanPage(p)
          : widget.coordinator.hasFailed
              ? _buildErrorPage()
              : _buildLoadingPage(),
    );
  }

  Widget _buildPlanPage(TravelPlanWindowPayload p) {
    // 以载荷对象为 Key：换载时面板（含其行程状态）整体重建，
    // 共享 WebView 纹理仍复用，地图不重载
    return Scaffold(
      body: TravelPlanPanel(
        key: ValueKey<TravelPlanWindowPayload>(p),
        plan: p.planJson != null
            ? TravelPlanData.fromPlanJson(p.planJson!)
            : TravelPlanData.from(p.card!),
        fullscreen: true,
        onClose: () => unawaited(widget.coordinator.hide()),
        // 无边框窗口：页面自绘标题栏的拖动/最小化/最大化回宿主执行
        onWindowAction: (String action) => unawaited(_handleWindowAction(action)),
      ),
    );
  }

  /// 装载中占位（首帧到指针载荷就绪之间的短暂状态）。
  Widget _buildLoadingPage() {
    return const Scaffold(
      body: Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            SizedBox(
              width: 26,
              height: 26,
              child: CircularProgressIndicator(strokeWidth: 2.4),
            ),
            SizedBox(height: 14),
            Text("行程装载中…"),
          ],
        ),
      ),
    );
  }

  /// 载荷损坏兜底页：给出明确原因 + 手动退出，避免静默无响应。
  Widget _buildErrorPage() {
    void close() async {
      try {
        await windowManager.destroy();
      } catch (_) {
        exit(0); // destroy 失败（如窗口未就绪）时兜底退出
      }
    }

    return Scaffold(
      body: Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            const Icon(Icons.error_outline, size: 40),
            const SizedBox(height: 12),
            const Text("行程数据读取失败，请在主窗口重新打开行程规划。"),
            const SizedBox(height: 16),
            FilledButton(onPressed: close, child: const Text("关闭")),
          ],
        ),
      ),
    );
  }
}
