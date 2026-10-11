import "dart:async";
import "dart:convert";

import "travel_map_controller.dart" show TravelRouteSegment;
import "travel_plan_models.dart";

/// 整页 WebView 行程面板（本机 server /travel-map?host=1 页面）的桥接控制器。
///
/// 桥协议：
/// - Dart → JS：`window.__travelPanel.xxx(...)` 经 executeScript 调用；
/// - JS → Dart：`window.chrome.webview.postMessage(JSON)` 流回，
///   由 [handleWebMessage] 分发为回调（规划路线/切换交通方式/开外链/全屏/关闭）。
///
/// 未 attach / 未就绪时出站方法入队或静默 no-op，不会抛异常。
class TravelWebPanelController {
  /// JS 页面就绪（地图源加载成功或进入离线兜底）。
  void Function()? onReady;

  /// 用户点击「规划路线」（携带当前选中的天下标）。
  void Function(int dayIndex)? onPlanRoute;

  /// 用户点击路线卡的备选交通方式。
  void Function(String mode)? onSwitchRouteMode;

  /// 用户关闭路线结果卡（Dart 侧同步清空路线状态）。
  void Function()? onHideRouteCard;

  /// 打开外部链接（导航/叫车/视频播放页）。
  void Function(String url)? onOpenUrl;

  /// 用户点击网页顶栏「关闭」。
  void Function()? onClose;

  /// 用户点击网页顶栏「全屏」。
  void Function()? onFullscreen;

  /// 页面自绘标题栏的窗口动作（'windowDrag' | 'minimize' | 'maximize'）。
  ///
  /// 行程独立窗口宿主把页面设为无边框窗口（setAsFrameless），窗口的拖动/最小化/
  /// 最大化就交给页面标题栏（1:1 设计稿的自绘标题栏），经这里回调到宿主执行。
  /// 应用内兜底面板不注册 → 这些动作静默忽略（主窗口不该被行程页最小化）。
  void Function(String action)? onWindowAction;

  Future<void> Function(String script)? _executeScript;
  bool _ready = false;
  final List<String> _pendingScripts = <String>[];

  /// WebView 是否已就绪（收到 JS 的 ready 事件）。
  bool get isReady => _ready;

  /// 由视图在 WebView 加载完成后调用：注入脚本执行器。
  Future<void> attach(Future<void> Function(String script) executeScript) async {
    _executeScript = executeScript;
    _ready = false;
    _pendingScripts.clear();
  }

  /// 视图 dispose 时调用：释放引用，方法回归静默 no-op。
  void detach() {
    _executeScript = null;
    _ready = false;
    _pendingScripts.clear();
    onReady = null;
    onPlanRoute = null;
    onSwitchRouteMode = null;
    onHideRouteCard = null;
    onOpenUrl = null;
    onClose = null;
    onFullscreen = null;
    onWindowAction = null;
  }

  /// JS → Dart 事件入口：由视图把 webMessage 原样转发进来。
  void handleWebMessage(Object? message) {
    Map<String, dynamic>? data;
    if (message is Map) {
      data = <String, dynamic>{
        for (final MapEntry<Object?, Object?> e in message.entries)
          e.key.toString(): e.value,
      };
    } else if (message is String) {
      try {
        final Object? decoded = jsonDecode(message);
        if (decoded is Map) {
          data = <String, dynamic>{
            for (final MapEntry<Object?, Object?> e in decoded.entries)
              e.key.toString(): e.value,
          };
        }
      } catch (_) {
        return;
      }
    }
    if (data == null) return;
    switch (data["event"]) {
      case "ready":
        _ready = true;
        _flushPending();
        onReady?.call();
        break;
      case "planRoute":
        onPlanRoute?.call(int.tryParse("${data["dayIndex"]}") ?? 0);
        break;
      case "switchRouteMode":
        onSwitchRouteMode?.call(data["mode"]?.toString() ?? "");
        break;
      case "hideRouteCard":
        onHideRouteCard?.call();
        break;
      case "openUrl":
        onOpenUrl?.call(data["url"]?.toString() ?? "");
        break;
      case "close":
        onClose?.call();
        break;
      case "fullscreen":
        onFullscreen?.call();
        break;
      case "windowDrag":
      case "minimize":
      case "maximize":
        onWindowAction?.call("${data["event"]}");
        break;
      default:
        break;
    }
  }

  // ── 出站：Dart → JS（未 attach / 未就绪时入队或 no-op）──────────────

  /// 注入本机 server 瓦片代理基址：WebView(about:blank) 无 origin，行程页
  /// 的相对路径代理不可用，必须给绝对地址。底图资源随后走 server 本地缓存
  /// （首次拉取落盘、规划完成预热），弱网/离线也秒开。空串=不可用走 CDN。
  void setTileProxy(String base) {
    _send("setTileProxy", base);
  }

  /// 同步 App 主题变体（'dark' | 'warm'）：网页切换深/浅色令牌组，
  /// 并把地图底图明暗对齐到当前主题（卫星为显式选择不受影响）。
  void setTheme(String mode) {
    _send("setTheme", mode);
  }

  /// 下发完整行程载荷（面板据此渲染顶栏/天数栏/POI/默认中心）。
  void loadPlan(Map<String, dynamic> payload) {
    _send("loadPlan", payload);
  }

  /// 下发路线规划结果（路线结果卡渲染数据）。
  void showRouteCard(Map<String, dynamic> payload) {
    _send("showRouteCard", payload);
  }

  /// 绘制行程路线（分段按交通方式配色 + 流光动画 + 途经点徽标）。
  void drawRoute(List<TravelRouteSegment> segments) {
    _send(
      "drawRoute",
      <Map<String, dynamic>>[for (final TravelRouteSegment s in segments) s.toJson()],
    );
  }

  /// 清除地图上的路线与途经点徽标。
  void clearRoute() {
    _send("clearRoute");
  }

  // ── 内部：脚本派发 ────────────────────────────────────────────────

  void _send(String method, [Object? args]) {
    final String argList = args == null ? "" : jsonEncode(args);
    _sendRaw("window.__travelPanel && window.__travelPanel.$method($argList);");
  }

  void _sendRaw(String script) {
    if (_executeScript == null) return; // 未 attach / 已 detach，静默 no-op
    if (!_ready) {
      _pendingScripts.add(script);
      return;
    }
    _runNow(script);
  }

  void _flushPending() {
    final List<String> scripts = List<String>.of(_pendingScripts);
    _pendingScripts.clear();
    for (final String script in scripts) {
      _runNow(script);
    }
  }

  Future<void> _runNow(String script) async {
    final Future<void> Function(String)? exec = _executeScript;
    if (exec == null) return;
    try {
      await exec(script);
    } catch (_) {
      // executeScript 失败（页面未就绪/已销毁等）静默吞掉，不传染面板
    }
  }
}

/// 整页 WebView 面板的载荷构建：把 [TravelPlanData] 转成行程桌面页
/// `loadPlan` 需要的 JSON（媒体地址已解析为服务端绝对地址）。
abstract final class TravelWebPanelPayload {
  static Map<String, dynamic> build(
    TravelPlanData plan, {
    required bool fullscreen,
    required bool closable,
  }) {
    return <String, dynamic>{
      "fullscreen": fullscreen,
      "closable": closable,
      "destination": plan.destination,
      "dataQuality": plan.dataQuality,
      "title": plan.title.isNotEmpty ? plan.title : "${plan.destination} 行程",
      if (plan.centerLatitude != null && plan.centerLongitude != null)
        "center": <String, double>{
          "latitude": plan.centerLatitude!,
          "longitude": plan.centerLongitude!,
        },
      "days": <Map<String, dynamic>>[
        for (final TravelPlanDay day in plan.days)
          <String, dynamic>{
            "label": day.label,
            "subtitle": day.subtitle,
            "entries": <Map<String, dynamic>>[
              for (final TravelDayEntry e in day.entries)
                <String, dynamic>{
                  "name": e.title,
                  "type": e.type,
                  "time": e.time,
                  "priceInfo": e.priceInfo,
                  "description": e.description,
                  "tips": e.tips,
                  "address": e.address,
                  "images": e.images,
                  "splatUrl": resolveTravelMediaUrl(e.splatUrl),
                  "reviews": <Map<String, dynamic>>[
                    for (final TravelEntryReview r in e.reviews)
                      <String, dynamic>{
                        "author": r.author,
                        "rating": r.rating,
                        "text": r.text,
                      },
                  ],
                  "videos": <Map<String, dynamic>>[
                    for (final TravelEntryVideo v in e.videos)
                      <String, dynamic>{
                        "platform": v.platform,
                        "title": v.title,
                        "playPageUrl": v.playPageUrl,
                      },
                  ],
                  if (e.latitude != null && e.longitude != null)
                    "latitude": e.latitude,
                  if (e.latitude != null && e.longitude != null)
                    "longitude": e.longitude,
                },
            ],
          },
      ],
    };
  }

  /// 路线结果卡载荷（行程页 `showRouteCard` 渲染数据；行迹桌面页暂不消费，留作兼容）。
  static Map<String, dynamic> routeCard({
    required String totalDistanceText,
    required String totalDurationText,
    required String averageCrowdIndex,
    required int optimizationScore,
    required String assessment,
    required List<Map<String, dynamic>> segments,
    required List<Map<String, dynamic>> warnings,
    required List<Map<String, dynamic>> alternatives,
    required Map<String, String> links,
  }) {
    return <String, dynamic>{
      "totalDistanceText": totalDistanceText,
      "totalDurationText": totalDurationText,
      "averageCrowdIndex": averageCrowdIndex,
      "optimizationScore": optimizationScore,
      "assessment": assessment,
      "segments": segments,
      "warnings": warnings,
      "alternatives": alternatives,
      "links": links,
    };
  }
}
