import "dart:async";

import "package:flutter/material.dart";
import "package:url_launcher/url_launcher.dart";
import "package:webview_windows/webview_windows.dart";

import "../../core/theme/app_theme.dart";
import "../../core/utils/agent_result_parser.dart";
import "intelligent_route_planner.dart";
import "travel_map_controller.dart";
import "travel_plan_models.dart";
import "travel_web_panel_controller.dart";
import "travel_web_panel_host.dart";

// ═══════════════════════════════════════════════════════════════════
// 行程规划界面（整页 WebView 面板）。
//
// 整页 WebView 承载面板（地图 + 天数栏 + 详情卡 + 路线卡同一网页，
// 经 TravelWebPanelController 桥接）。行程规划的完整界面已迁移至
// server 的 /travel-map 浏览器页面；此处仅为应用内兜底壳。
// ═══════════════════════════════════════════════════════════════════


/// 行程规划面板入口。
///
/// [plan] 为渲染数据（`TravelPlanData`）；聊天卡片等持有 AgentResultData
/// 的调用方经 [TravelPlanFullscreenPage]（内部转换）进入，
/// 行程归档等已有 TravelPlanData 的调用方直接传 [plan]。
class TravelPlanPanel extends StatefulWidget {
  const TravelPlanPanel({
    super.key,
    required this.plan,
    this.fullscreen = false,
    this.onClose,
    this.onWindowAction,
  });

  final TravelPlanData plan;

  /// 是否为全屏模式（全屏页时隐藏内部全屏入口）。
  final bool fullscreen;

  /// 关闭回调（宿主容器需要内部关闭按钮时传入；全屏页自身有返回键）。
  final VoidCallback? onClose;

  /// 页面自绘标题栏的窗口动作回调（'windowDrag' | 'minimize' | 'maximize'）。
  ///
  /// 只有行程独立窗口（无边框窗口）会传：页面标题栏就是窗口标题栏，
  /// 拖动/最小化/最大化都经桥回宿主执行。应用内兜底面板不传 → 静默忽略。
  final void Function(String action)? onWindowAction;

  @override
  State<TravelPlanPanel> createState() => _TravelPlanPanelState();
}

class _TravelPlanPanelState extends State<TravelPlanPanel> {
  @override
  Widget build(BuildContext context) {
    return _WebTravelPanel(
      plan: widget.plan,
      fullscreen: widget.fullscreen,
      onClose: widget.onClose,
      onWindowAction: widget.onWindowAction,
    );
  }
}

// ═══════════════════════════════════════════════════════════════════
// WebView 整页面板（Windows）
// ═══════════════════════════════════════════════════════════════════

class _WebTravelPanel extends StatefulWidget {
  const _WebTravelPanel({
    required this.plan,
    this.fullscreen = false,
    this.onClose,
    this.onWindowAction,
  });

  final TravelPlanData plan;
  final bool fullscreen;
  final VoidCallback? onClose;
  final void Function(String action)? onWindowAction;

  @override
  State<_WebTravelPanel> createState() => _WebTravelPanelState();
}

class _WebTravelPanelState extends State<_WebTravelPanel> {
  late final TravelPlanData _plan = widget.plan;

  /// 面板与全屏页共用进程级 WebView 宿主（单例，App 启动即预加载）：
  /// 打开面板 / 进出全屏复用同一纹理，地图不再重新加载。
  TravelWebPanelController get _controller => TravelWebPanelHost.instance.controller;

  /// 全屏路由打开期间置真：卸载本挂载点的 Webview，让全屏页独占渲染同一纹理
  ///（同一控制器的 Webview 多处同时挂载会导致输入事件双发）。
  bool _fullscreenOpen = false;

  // 智能路线规划仍在 Dart 侧（单一事实源），结果经桥接下发网页渲染
  final IntelligentRoutePlanner _planner = IntelligentRoutePlanner();
  TravelPreferences _prefs = const TravelPreferences();
  List<RouteWaypoint> _lastWaypoints = const <RouteWaypoint>[];

  @override
  void initState() {
    super.initState();
    // 主题对齐：同步当前变体并监听热切换（网页令牌组 + 地图底图明暗）
    AppThemeController.instance.addListener(_onThemeChanged);
    unawaited(TravelWebPanelHost.instance.ensureStarted().then((_) {
      if (!mounted) return;
      _bindController();
      _syncTheme();
      _pushPlan();
    }));
  }

  @override
  void dispose() {
    AppThemeController.instance.removeListener(_onThemeChanged);
    _unbindController(); // 共享宿主不 detach（生命周期 = App）
    super.dispose();
  }

  void _onThemeChanged() {
    if (!mounted) return;
    _syncTheme();
  }

  void _syncTheme() {
    _controller.setTheme(AppThemeController.instance.value.name);
  }

  /// 绑定网页 → Dart 事件回调（WebView 挂载点切换后需重新绑定）。
  void _bindController() {
    final TravelWebPanelController c = _controller;
    c.onReady = _onWebReady;
    c.onPlanRoute = _planRoute;
    c.onSwitchRouteMode = _switchTransportMode;
    c.onHideRouteCard = _clearRoute;
    c.onOpenUrl = _launchExternal;
    c.onClose = () => widget.onClose?.call();
    c.onFullscreen = _openFullscreen;
    c.onWindowAction = widget.onWindowAction;
  }

  /// 仅解绑属于自己的回调（不同 State 实例的方法 tearoff 不相等，互不误伤）。
  /// onClose 闭包无法比较，交由下一个挂载点绑定时覆盖。
  void _unbindController() {
    final TravelWebPanelController c = _controller;
    if (c.onReady == _onWebReady) c.onReady = null;
    if (c.onPlanRoute == _planRoute) c.onPlanRoute = null;
    if (c.onSwitchRouteMode == _switchTransportMode) c.onSwitchRouteMode = null;
    if (c.onHideRouteCard == _clearRoute) c.onHideRouteCard = null;
    if (c.onOpenUrl == _launchExternal) c.onOpenUrl = null;
    if (c.onFullscreen == _openFullscreen) c.onFullscreen = null;
    // onWindowAction 来自宿主（tearoff 由下一个挂载点覆盖），此处不动
  }

  /// 下发当前行程载荷（共享 WebView 未就绪时由控制器排队，就绪后自动送达）。
  void _pushPlan() {
    _controller.loadPlan(TravelWebPanelPayload.build(
      _plan,
      fullscreen: widget.fullscreen,
      closable: widget.onClose != null,
    ));
  }

  void _onWebReady() {
    _pushPlan();
  }

  // ── 全屏 / 外链 ──────────────────────────────────────────────────
  Future<void> _openFullscreen() async {
    // 全屏页复用同一共享 WebView 纹理（不重新加载地图）；
    // 先卸载本挂载点避免同一控制器被双份转发输入事件
    setState(() => _fullscreenOpen = true);
    await Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (BuildContext context) => TravelPlanFullscreenPage.fromPlan(
          plan: widget.plan,
        ),
      ),
    );
    if (!mounted) return;
    _bindController(); // 全屏页挂载点曾覆盖回调，返回后夺回
    _pushPlan();       // 恢复面板态载荷（隐藏网页内全屏按钮等）
    setState(() => _fullscreenOpen = false);
  }

  Future<void> _launchExternal(String url) async {
    if (url.isEmpty) return;
    final Uri? uri = Uri.tryParse(url);
    if (uri == null) return;
    try {
      await launchUrl(uri, mode: LaunchMode.externalApplication);
    } catch (_) {
      _toast("无法打开外部链接", error: true);
    }
  }

  void _toast(String msg, {bool error = false}) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(msg, style: const TextStyle(fontSize: 12)),
        backgroundColor: error ? Theme.of(context).colorScheme.error : null,
        duration: const Duration(seconds: 2),
        behavior: SnackBarBehavior.floating,
      ),
    );
  }

  // ═════════════════════════════════════════════════════════════════
  // 智能路线规划（Dart 计算 → 网页渲染）
  // ═════════════════════════════════════════════════════════════════

  void _planRoute(int dayIndex) {
    final int d = dayIndex.clamp(0, _plan.days.length - 1);
    final List<RouteWaypoint> waypoints = <RouteWaypoint>[
      for (final TravelDayEntry e in _plan.days[d].entries)
        if (e.latitude != null && e.longitude != null && e.kind != TravelEntryKind.transport)
          RouteWaypoint(
              name: e.title,
              latitude: e.latitude!,
              longitude: e.longitude!,
              type: e.type),
    ];
    if (waypoints.length < 2) {
      _toast("当天可规划路线的地点不足（至少 2 个带坐标的行程点）", error: true);
      return;
    }
    _lastWaypoints = waypoints;
    _applyRoute(_planner.planIntelligentRoute(waypoints, _prefs));
  }

  void _switchTransportMode(String mode) {
    _prefs = TravelPreferences(
      sceneryPreference: _prefs.sceneryPreference,
      transportMode: mode,
      departureTime: _prefs.departureTime,
      budgetLevel: _prefs.budgetLevel,
      physicalEffort: _prefs.physicalEffort,
      avoidCrowds: _prefs.avoidCrowds,
      prioritizeSpeed: _prefs.prioritizeSpeed,
    );
    if (_lastWaypoints.length >= 2) {
      _applyRoute(_planner.planIntelligentRoute(_lastWaypoints, _prefs));
    }
  }

  void _applyRoute(SmartRouteResult result) {
    _controller.drawRoute(<TravelRouteSegment>[
      for (final SmartRouteSegment seg in result.segments)
        TravelRouteSegment(
          mode: _mapModeOf(seg.transportMode),
          points: <TravelMapPoint>[
            TravelMapPoint(latitude: seg.fromLatitude, longitude: seg.fromLongitude),
            TravelMapPoint(latitude: seg.toLatitude, longitude: seg.toLongitude),
          ],
          fromName: seg.fromName,
          toName: seg.toName,
        ),
    ]);
    _controller.showRouteCard(_routeCardPayload(result));
  }

  void _clearRoute() {
    _lastWaypoints = const <RouteWaypoint>[];
    _controller.clearRoute();
  }

  static String _mapModeOf(String mode) {
    switch (mode) {
      case "public_transit":
        return "transit";
      case "walking":
        return "walking";
      case "cycling":
        return "cycling";
      case "taxi":
        return "taxi";
      default:
        return "driving"; // driving / rental_car
    }
  }

  static String _modeName(String mode) {
    const Map<String, String> names = <String, String>{
      "driving": "驾车",
      "rental_car": "租车",
      "taxi": "网约车",
      "public_transit": "公交",
      "cycling": "骑行",
      "walking": "步行",
    };
    return names[mode] ?? mode;
  }

  Map<String, dynamic> _routeCardPayload(SmartRouteResult route) {
    return TravelWebPanelPayload.routeCard(
      totalDistanceText: route.totalDistanceText,
      totalDurationText: route.totalDurationText,
      averageCrowdIndex: route.averageCrowdIndex,
      optimizationScore: route.optimizationScore,
      assessment: route.assessment,
      segments: <Map<String, dynamic>>[
        for (final SmartRouteSegment seg in route.segments)
          <String, dynamic>{
            "instruction": seg.instruction,
            "distanceText": "${(seg.distanceMeters / 1000).toStringAsFixed(1)}km",
            "durationMinutes": seg.durationMinutes,
          },
      ],
      warnings: <Map<String, dynamic>>[
        for (final SmartRouteWarning w in route.warnings)
          <String, dynamic>{"message": w.message, "severity": w.severity},
      ],
      alternatives: <Map<String, dynamic>>[
        for (final TransportRecommendation alt
            in route.segments.firstOrNull?.alternatives ?? const <TransportRecommendation>[])
          <String, dynamic>{
            "mode": alt.mode,
            "label": _modeName(alt.mode),
            "reason": alt.reason,
          },
      ],
      links: route.serviceLinks(),
    );
  }

  @override
  Widget build(BuildContext context) {
    // 全屏覆盖期间以深色占位（本挂载点的 Webview 已卸载，共享纹理由全屏页渲染）
    if (_fullscreenOpen) {
      return const ColoredBox(color: Color(0xFF0B1220));
    }
    return const _WebPanelView();
  }
}

/// 共享 WebView 宿主的挂载点：等待初始化完成后渲染同一纹理。
class _WebPanelView extends StatelessWidget {
  const _WebPanelView();

  @override
  Widget build(BuildContext context) {
    final TravelWebPanelHost host = TravelWebPanelHost.instance;
    return FutureBuilder<void>(
      future: host.ensureStarted(),
      builder: (BuildContext context, AsyncSnapshot<void> snapshot) {
        if (host.error != null) {
          return Container(
            color: const Color(0xFF0B1220),
            alignment: Alignment.center,
            padding: const EdgeInsets.all(16),
            child: Text(
              host.error!,
              textAlign: TextAlign.center,
              style: const TextStyle(fontSize: 12, color: Color(0xFF8FA3BF)),
            ),
          );
        }
        if (snapshot.connectionState != ConnectionState.done ||
            !host.isInitialized) {
          return Container(
            color: const Color(0xFF0B1220),
            alignment: Alignment.center,
            child: const Column(
              mainAxisSize: MainAxisSize.min,
              children: <Widget>[
                SizedBox(
                  width: 22,
                  height: 22,
                  child: CircularProgressIndicator(strokeWidth: 2),
                ),
                SizedBox(height: 10),
                Text(
                  "行程面板加载中…",
                  style: TextStyle(fontSize: 12, color: Color(0xFF8FA3BF)),
                ),
              ],
            ),
          );
        }
        return Webview(host.webviewController!);
      },
    );
  }
}

/// 行程规划独立界面：全屏路由，沉浸式浏览行程地图。
/// 不套 AppBar——网页版自带的玻璃拟态顶栏（目的地标题 + 关闭按钮）即页面顶栏，
/// 关闭按钮经 [TravelPlanPanel.onClose] 弹出路由；原生兜底版同样渲染关闭按钮。
class TravelPlanFullscreenPage extends StatelessWidget {
  const TravelPlanFullscreenPage({super.key, required this.data})
      : plan = null;

  /// 行程归档等已有渲染数据的入口：直接吃 TravelPlanData（零解析开销）。
  const TravelPlanFullscreenPage.fromPlan({super.key, required this.plan})
      : data = null;

  final AgentResultData? data;
  final TravelPlanData? plan;

  @override
  Widget build(BuildContext context) {
    final ColorScheme cs = Theme.of(context).colorScheme;
    return Scaffold(
      backgroundColor: cs.surface,
      body: TravelPlanPanel(
        plan: plan ?? TravelPlanData.from(data!),
        fullscreen: true,
        onClose: () => Navigator.of(context).pop(),
      ),
    );
  }
}
