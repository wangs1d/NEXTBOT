import "dart:async";
import "dart:convert";
import "dart:io" show Platform;

import "package:flutter/foundation.dart" show kIsWeb;
import "package:flutter/material.dart";
import "package:webview_flutter/webview_flutter.dart";

import "../../core/config/api_config.dart";
import "../../core/config/media_url.dart";
import "../../core/utils/coord_transform.dart";

/// 叫车卡内 3D 地图（WebView + 高德 JS API 2.0，2026-11-23）。
///
/// 服务端 /ride-map/picker 页面在 viewMode:"3D" 下渲染（真 3D 建筑 + 俯仰视角，
/// 对齐滴滴选点页）。坐标契约：本组件的输入/回调一律 **WGS-84**（服务端基准），
/// 只在进页面前转 GCJ、出页面后转回 WGS——高德 JS 全部是 GCJ-02。
///
/// 桥协议（页面 → Flutter，window.RideMapBridge）：
///   {type:"ready"}                                  页面地图首帧完成
///   {type:"select",lat,lng,index,name,address}      选点变化（拖图/点候选/回定位）
///   {type:"error",message}                          地图不可用
/// Flutter → 页面：window.__rideMap.setData(...) / focusCandidate(index)
///
/// 失败语义：非移动平台、页面 13s 未 ready、页面报错 → onFailed（父组件回退
/// flutter_map 平面地图），绝不把灰屏/空图留在卡上。
class RideMapCandidate {
  const RideMapCandidate({
    required this.name,
    required this.lat,
    required this.lng,
    this.address = "",
    this.distM,
  });

  final String name;
  final String address;
  final double lat;
  final double lng;
  final int? distM;
}

class RideMapPick {
  const RideMapPick({
    required this.lat,
    required this.lng,
    this.index = -1,
    this.name = "",
    this.address = "",
    this.reason = "",
  });

  final double lat;
  final double lng;
  final int index;
  final String name;
  final String address;
  final String reason;
}

/// 外部命令句柄（候选行点击等场景聚焦到某个候选）。
class RideMap3dController {
  _RideMap3dViewState? _state;

  void _attach(_RideMap3dViewState state) => _state = state;

  void _detach(_RideMap3dViewState state) {
    if (identical(_state, state)) _state = null;
  }

  void focusCandidate(int index) => _state?._focusCandidate(index);
}

class RideMap3dView extends StatefulWidget {
  const RideMap3dView({
    super.key,
    this.controller,
    required this.mode,
    this.origin,
    this.candidates = const <RideMapCandidate>[],
    this.routePoints = const <({double lat, double lng})>[],
    this.onSelect,
    this.onFailed,
  });

  /// "pickup" = 选上车点（中心图钉 + 候选 + 回定位）；"route" = 驾车路线展示
  final String mode;
  final RideMap3dController? controller;
  final ({double lat, double lng, String label})? origin;
  final List<RideMapCandidate> candidates;
  final List<({double lat, double lng})> routePoints;
  final void Function(RideMapPick pick)? onSelect;
  final VoidCallback? onFailed;

  @override
  State<RideMap3dView> createState() => _RideMap3dViewState();
}

class _RideMap3dViewState extends State<RideMap3dView> {
  static const Duration _readyTimeout = Duration(seconds: 13);

  WebViewController? _web;
  Timer? _watchdog;
  bool _ready = false;
  bool _failed = false;

  bool get _supported =>
      !kIsWeb && (Platform.isAndroid || Platform.isIOS);

  @override
  void initState() {
    super.initState();
    widget.controller?._attach(this);
    if (!_supported) {
      // 桌面/测试环境没有 webview_flutter 实现：直接走 2D 回退
      WidgetsBinding.instance.addPostFrameCallback((_) => _fail());
      return;
    }
    _start();
  }

  @override
  void didUpdateWidget(covariant RideMap3dView oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (!identical(oldWidget.controller, widget.controller)) {
      oldWidget.controller?._detach(this);
      widget.controller?._attach(this);
    }
    if (_ready && (oldWidget.candidates != widget.candidates ||
        oldWidget.origin != widget.origin ||
        oldWidget.routePoints != widget.routePoints ||
        oldWidget.mode != widget.mode)) {
      _pushData();
    }
  }

  @override
  void dispose() {
    _watchdog?.cancel();
    widget.controller?._detach(this);
    super.dispose();
  }

  void _fail() {
    if (_failed || !mounted) return;
    _failed = true;
    _watchdog?.cancel();
    widget.onFailed?.call();
  }

  void _start() {
    _watchdog = Timer(_readyTimeout, () {
      if (!_ready) _fail();
    });
    final String url = MediaUrl.webViewPageUrl(
      "${ApiConfig.httpBase}/ride-map/picker",
      query: <String, String>{"mode": widget.mode},
    );
    final WebViewController web = WebViewController()
      ..setJavaScriptMode(JavaScriptMode.unrestricted)
      ..setBackgroundColor(const Color(0xFFF2F0EB))
      ..addJavaScriptChannel(
        "RideMapBridge",
        onMessageReceived: (JavaScriptMessage message) => _onBridge(message.message),
      )
      ..setNavigationDelegate(
        NavigationDelegate(
          onNavigationRequest: (NavigationRequest request) =>
              _allowNavigation(request.url)
                  ? NavigationDecision.navigate
                  : NavigationDecision.prevent,
        ),
      )
      ..loadRequest(Uri.parse(url));
    _web = web;
  }

  /// 地图页只允许本站页面与高德资源（脚本/瓦片/图标）；其余导航一律拦掉，
  /// 避免用户在地图里误触跳走。
  bool _allowNavigation(String raw) {
    if (raw == "about:blank" || raw.isEmpty) return true;
    final Uri? uri = Uri.tryParse(raw);
    if (uri == null) return false;
    if (uri.scheme == "data" || uri.scheme == "blob") return true;
    final String host = uri.host;
    if (host.endsWith("amap.com") || host.endsWith("autonavi.com")) return true;
    final Uri? base = Uri.tryParse(ApiConfig.httpBase);
    return base != null && uri.host == base.host;
  }

  void _onBridge(String raw) {
    if (!mounted) return;
    Map<String, dynamic> msg;
    try {
      final Object? decoded = jsonDecode(raw);
      if (decoded is! Map) return;
      msg = <String, dynamic>{
        for (final MapEntry<Object?, Object?> e in decoded.entries)
          e.key.toString(): e.value,
      };
    } catch (_) {
      return;
    }
    switch (msg["type"]) {
      case "ready":
        _ready = true;
        _watchdog?.cancel();
        _pushData();
        break;
      case "select":
        _onSelect(msg);
        break;
      case "error":
        _fail();
        break;
    }
  }

  void _onSelect(Map<String, dynamic> msg) {
    final double? lat = _num(msg["lat"]);
    final double? lng = _num(msg["lng"]);
    if (lat == null || lng == null) return;
    // 页面坐标是 GCJ-02 → 服务端基准 WGS-84
    final ({double lat, double lng}) wgs = gcj02ToWgs84(lat, lng);
    widget.onSelect?.call(
      RideMapPick(
        lat: wgs.lat,
        lng: wgs.lng,
        index: (msg["index"] is num) ? (msg["index"] as num).toInt() : -1,
        name: msg["name"] is String ? msg["name"] as String : "",
        address: msg["address"] is String ? msg["address"] as String : "",
        reason: msg["reason"] is String ? msg["reason"] as String : "",
      ),
    );
  }

  double? _num(Object? v) => v is num
      ? v.toDouble()
      : (v is String ? double.tryParse(v) : null);

  void _pushData() {
    final WebViewController? web = _web;
    if (web == null || !_ready) return;
    final Map<String, dynamic> payload = <String, dynamic>{"mode": widget.mode};

    final ({double lat, double lng, String label})? origin = widget.origin;
    ({double lat, double lng})? originGcj;
    if (origin != null) {
      final ({double lat, double lng}) gcj = wgs84ToGcj02(origin.lat, origin.lng);
      originGcj = gcj;
      payload["origin"] = <String, dynamic>{"lat": gcj.lat, "lng": gcj.lng};
    }

    final List<Map<String, dynamic>> candidates = <Map<String, dynamic>>[];
    for (final RideMapCandidate c in widget.candidates) {
      final ({double lat, double lng}) gcj = wgs84ToGcj02(c.lat, c.lng);
      candidates.add(<String, dynamic>{
        "name": c.name,
        "address": c.address,
        "lat": gcj.lat,
        "lng": gcj.lng,
        if (c.distM != null) "distM": c.distM,
      });
    }
    if (candidates.isNotEmpty) payload["candidates"] = candidates;

    // 地图中心：实时定位优先，其次最近候选（与卡片初始预选同口径）
    ({double lat, double lng})? centerGcj = originGcj;
    if (centerGcj == null && candidates.isNotEmpty) {
      centerGcj = (
        lat: (candidates.first["lat"] as num).toDouble(),
        lng: (candidates.first["lng"] as num).toDouble(),
      );
    }

    final List<List<double>> route = <List<double>>[];
    for (final ({double lat, double lng}) p in widget.routePoints) {
      final ({double lat, double lng}) gcj = wgs84ToGcj02(p.lat, p.lng);
      route.add(<double>[gcj.lat, gcj.lng]);
    }
    if (route.isNotEmpty) {
      payload["route"] = route;
      centerGcj ??= (lat: route.first[0], lng: route.first[1]);
    }

    if (centerGcj != null) {
      payload["center"] = <String, dynamic>{
        "lat": centerGcj.lat,
        "lng": centerGcj.lng,
      };
    }
    final String script =
        "window.__rideMap && window.__rideMap.setData(${jsonEncode(payload)})";
    unawaited(web.runJavaScript(script));
  }

  void _focusCandidate(int index) {
    final WebViewController? web = _web;
    if (web == null || !_ready) return;
    unawaited(web.runJavaScript(
      "window.__rideMap && window.__rideMap.focusCandidate($index)",
    ));
  }

  @override
  Widget build(BuildContext context) {
    final WebViewController? web = _web;
    if (web == null || _failed) {
      // 父组件会在 onFailed 后切回平面地图；这里只占位一帧
      return const ColoredBox(color: Color(0xFFF2F0EB));
    }
    return WebViewWidget(controller: web);
  }
}
