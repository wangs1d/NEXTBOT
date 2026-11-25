import "dart:async";
import "dart:math" as math;

import "package:flutter/material.dart";
import "package:flutter_map/flutter_map.dart";
import "package:latlong2/latlong.dart";

import "../../core/services/ride_pickup_api.dart";
import "../../core/utils/coord_transform.dart";
import "ride_map_3d_view.dart";
import "shopping/shopping_shared.dart";

/// 全屏选点结果（坐标 WGS-84，直接可回传服务端）。
class RidePickupPoint {
  const RidePickupPoint({
    required this.label,
    required this.sub,
    required this.lat,
    required this.lng,
    this.snapped = false,
  });

  final String label;
  final String sub;
  final double lat;
  final double lng;

  /// true = 命中候选上车点；false = 用户自己拖出来的点
  final bool snapped;
}

/// 全屏选点页（2026-11-24）。
///
/// 为什么要有这一页：卡片里的地图夹在聊天滚动列表里，垂直拖动天然和列表
/// 滚动抢手势（FlutterMap 尤其明显）。滴滴/高德的做法都是「点小地图 → 全屏
/// 选点」，全屏后没有父级滚动，拖动/缩放完全归地图。
///
/// 候选吸附与卡片内同口径（150m）：拖到候选附近自动吸过去，底部条显示名字，
/// 确认后把 WGS 坐标回给卡片（卡片再走 ride.pickup.select 续报价）。
class RidePickupFullscreenPage extends StatefulWidget {
  const RidePickupFullscreenPage({
    super.key,
    required this.cs,
    required this.title,
    required this.initialLat,
    required this.initialLng,
    this.candidates = const <Map<String, dynamic>>[],
    this.origin,
    this.use3d = false,
  });

  final ColorScheme cs;
  final String title;

  /// 初始中心（WGS-84）
  final double initialLat;
  final double initialLng;

  /// 候选（card payload 同构的 map：name/address/lat/lng/distM，WGS-84）
  final List<Map<String, dynamic>> candidates;

  /// 实时定位点（WGS-84），画蓝点用
  final ({double lat, double lng})? origin;

  /// 优先用卡内高德 3D 页（与卡片同一套 WebView 页面）；失败回退 FlutterMap。
  /// 全屏下没有父级滚动，3D 手势不再被抢，拖动/缩放是完整体验。
  final bool use3d;

  @override
  State<RidePickupFullscreenPage> createState() => _RidePickupFullscreenPageState();
}

class _RidePickupFullscreenPageState extends State<RidePickupFullscreenPage> {
  /// 吸附半径与卡片同口径（35m）：图钉压到候选才吸，拖到别处就是别处。
  static const double _snapRadiusDeg = 35 / 111000;
  static const double _reloadMoveThresholdDeg = 0.00055;

  final MapController _map = MapController();
  final RidePickupApi _api = RidePickupApi();
  RidePickupPoint? _picked;
  late bool _use3d;
  late List<Map<String, dynamic>> _candidatesPayload;
  late List<RideMapCandidate> _candidates3d;
  Timer? _reloadTimer;
  Timer? _regeoDebounce;
  double _anchorLat = 0;
  double _anchorLng = 0;
  bool _reloading = false;
  int _regeoToken = 0;

  @override
  void initState() {
    super.initState();
    _use3d = widget.use3d;
    _candidatesPayload = List<Map<String, dynamic>>.of(widget.candidates);
    _rebuildCandidates3d();
    _picked = _snap(_initialWgs());
  }

  @override
  void dispose() {
    _reloadTimer?.cancel();
    _regeoDebounce?.cancel();
    super.dispose();
  }

  void _rebuildCandidates3d() {
    _candidates3d = <RideMapCandidate>[
      for (final Map<String, dynamic> c in _candidatesPayload)
        if (shopNum(c["lat"]) != null && shopNum(c["lng"]) != null)
          RideMapCandidate(
            name: shopStr(c["name"]).isEmpty ? "候选上车点" : shopStr(c["name"]),
            address: shopStr(c["address"]),
            lat: shopNum(c["lat"])!.toDouble(),
            lng: shopNum(c["lng"])!.toDouble(),
            distM: shopNum(c["distM"])?.toInt(),
          ),
    ];
  }

  /// 拖到没有候选的地方 → 按新位置重推（与卡片同口径：500ms 去抖 + 60m 阈值）
  void _scheduleReload(double lat, double lng) {
    if (_anchorLat != 0 &&
        (lat - _anchorLat).abs() + (lng - _anchorLng).abs() < _reloadMoveThresholdDeg) {
      return;
    }
    _reloadTimer?.cancel();
    _reloadTimer = Timer(
      const Duration(milliseconds: 500),
      () => _reload(lat, lng),
    );
  }

  /// 图钉压到哪就显示哪的 POI 名（滴滴同款：地图上有名字，而不是「自定义上车点」）。
  void _regeoName(double lat, double lng) {
    final int token = ++_regeoToken;
    _regeoDebounce?.cancel();
    _regeoDebounce = Timer(const Duration(milliseconds: 220), () async {
      final RidePickupSuggestion? res =
          await _api.around(lng: lng, lat: lat, withCandidates: false);
      if (!mounted || token != _regeoToken) return;
      final RidePickupPoint? cur = _picked;
      if (cur == null || cur.snapped) return;
      if ((cur.lat - lat).abs() > 1e-6 || (cur.lng - lng).abs() > 1e-6) return;
      final String name = (res?.label ?? "").trim();
      if (name.isEmpty) return;
      setState(() => _picked = RidePickupPoint(
            label: name,
            sub: "自定义上车点",
            lat: lat,
            lng: lng,
          ));
    });
  }

  Future<void> _reload(double lat, double lng) async {
    if (_reloading || !mounted) return;
    _reloading = true;
    _anchorLat = lat;
    _anchorLng = lng;
    final RidePickupSuggestion? res = await _api.around(lng: lng, lat: lat);
    _reloading = false;
    if (!mounted || res == null) return;
    setState(() {
      _candidatesPayload =
          res.candidates.map((RidePickupCandidate c) => c.toPayload()).toList();
      _rebuildCandidates3d();
      // 用户自己拖出来的点就留在原地，不抢到最近的候选上
      final RidePickupPoint? cur = _picked;
      if (cur == null || !cur.snapped) {
        final String name = res.label.trim();
        _picked = RidePickupPoint(
          label: name.isEmpty ? (cur?.label ?? "地图上的点") : name,
          sub: "自定义上车点",
          lat: cur?.lat ?? lat,
          lng: cur?.lng ?? lng,
        );
      }
    });
  }

  /// 3D 页面拖完/点候选后回传（坐标已转回 WGS）。
  void _on3dSelect(RideMapPick pick) {
    if (!mounted) return;
    final bool snapped = pick.index >= 0;
    setState(() {
      _picked = RidePickupPoint(
        label: snapped ? (pick.name.isEmpty ? "候选上车点" : pick.name) : "地图上的点",
        sub: snapped ? pick.address : "正在识别位置…",
        lat: pick.lat,
        lng: pick.lng,
        snapped: snapped,
      );
    });
    if (!snapped) {
      _regeoName(pick.lat, pick.lng);
      _scheduleReload(pick.lat, pick.lng);
    }
  }

  ({double lat, double lng}) _initialWgs() =>
      (lat: widget.initialLat, lng: widget.initialLng);

  /// 就近吸附：中心 150m 内有候选就吸到候选，否则用中心点本身。
  RidePickupPoint _snap(({double lat, double lng}) p) {
    Map<String, dynamic>? best;
    double bestD = double.infinity;
    for (final Map<String, dynamic> c in _candidatesPayload) {
      final num? lat = shopNum(c["lat"]);
      final num? lng = shopNum(c["lng"]);
      if (lat == null || lng == null) continue;
      final double d = math.sqrt(
        math.pow(p.lat - lat.toDouble(), 2) + math.pow(p.lng - lng.toDouble(), 2),
      );
      if (d < bestD) {
        bestD = d;
        best = c;
      }
    }
    if (best != null && bestD < _snapRadiusDeg) {
      final String name = shopStr(best["name"]);
      return RidePickupPoint(
        label: name.isEmpty ? "候选上车点" : name,
        sub: shopStr(best["address"]),
        lat: shopNum(best["lat"])?.toDouble() ?? p.lat,
        lng: shopNum(best["lng"])?.toDouble() ?? p.lng,
        snapped: true,
      );
    }
    return RidePickupPoint(
      label: "地图上的点",
      sub: "正在识别位置…",
      lat: p.lat,
      lng: p.lng,
    );
  }

  void _onCameraIdle() {
    final LatLng c = _map.camera.center;
    final ({double lat, double lng}) wgs = gcj02ToWgs84(c.latitude, c.longitude);
    final RidePickupPoint point = _snap(wgs);
    setState(() => _picked = point);
    if (!point.snapped) {
      _regeoName(wgs.lat, wgs.lng);
      _scheduleReload(wgs.lat, wgs.lng);
    }
  }

  @override
  Widget build(BuildContext context) {
    final ColorScheme cs = widget.cs;
    final RidePickupPoint? pick = _picked;
    final ({double lat, double lng}) gcjInitial = wgs84ToGcj02(
      widget.initialLat,
      widget.initialLng,
    );

    return Scaffold(
      backgroundColor: cs.surface,
      appBar: AppBar(
        backgroundColor: cs.surface,
        surfaceTintColor: Colors.transparent,
        foregroundColor: cs.onSurface,
        title: Text(widget.title, style: const TextStyle(fontSize: 15)),
      ),
      body: Stack(
        children: <Widget>[
          if (_use3d)
            Positioned.fill(
              child: RideMap3dView(
                mode: "pickup",
                // origin 只用于画「我的位置」蓝点；居中点用 center 单独给，
                // 否则一进全屏就跳回定位点，用户之前选的位置会丢。
                origin: widget.origin == null
                    ? null
                    : (
                        lat: widget.origin!.lat,
                        lng: widget.origin!.lng,
                        label: "我的位置",
                      ),
                center: (lat: widget.initialLat, lng: widget.initialLng),
                candidates: _candidates3d,
                snapRadiusM: 35,
                onSelect: _on3dSelect,
                onFailed: () {
                  if (mounted) setState(() => _use3d = false);
                },
              ),
            )
          else
            FlutterMap(
            mapController: _map,
            options: MapOptions(
              initialCenter: LatLng(gcjInitial.lat, gcjInitial.lng),
              initialZoom: 17,
              interactionOptions: const InteractionOptions(
                flags: InteractiveFlag.all & ~InteractiveFlag.rotate,
              ),
              onMapEvent: (MapEvent e) {
                if (e is MapEventMoveEnd ||
                    e is MapEventFlingAnimationEnd ||
                    e is MapEventDoubleTapZoomEnd) {
                  _onCameraIdle();
                }
              },
            ),
            children: <Widget>[
              TileLayer(
                urlTemplate:
                    "https://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}",
                subdomains: const <String>["1", "2", "3", "4"],
                userAgentPackageName: "app.nextbot.client",
              ),
              // 候选点（重推后会跟着变）
              MarkerLayer(
                markers: <Marker>[
                  for (final Map<String, dynamic> c in _candidatesPayload)
                    if (shopNum(c["lat"]) != null && shopNum(c["lng"]) != null)
                      Marker(
                        point: _gcj(
                          shopNum(c["lat"])!.toDouble(),
                          shopNum(c["lng"])!.toDouble(),
                        ),
                        width: 14,
                        height: 14,
                        child: Container(
                          decoration: BoxDecoration(
                            shape: BoxShape.circle,
                            color: cs.surface,
                            border: Border.all(color: cs.outline, width: 1.5),
                          ),
                        ),
                      ),
                ],
              ),
              if (widget.origin != null)
                MarkerLayer(
                  markers: <Marker>[
                    Marker(
                      point: _gcj(widget.origin!.lat, widget.origin!.lng),
                      width: 18,
                      height: 18,
                      child: Container(
                        decoration: BoxDecoration(
                          shape: BoxShape.circle,
                          color: const Color(0xFF2F6BFF),
                          border: Border.all(color: Colors.white, width: 2.5),
                        ),
                      ),
                    ),
                  ],
                ),
            ],
          ),
          // 中心图钉：2D 用 IgnorePointer 让拖动穿透；3D 页面自带图钉与胶囊
          if (!_use3d)
            const IgnorePointer(
              child: Center(
                child: Icon(Icons.location_on, size: 40, color: Colors.black),
              ),
            ),
          Positioned(
            left: 12,
            right: 12,
            bottom: 16,
            child: Container(
              padding: const EdgeInsets.fromLTRB(14, 12, 14, 12),
              decoration: BoxDecoration(
                color: cs.surface,
                borderRadius: BorderRadius.circular(14),
                boxShadow: <BoxShadow>[
                  BoxShadow(
                    color: Colors.black.withValues(alpha: 0.12),
                    blurRadius: 12,
                    offset: const Offset(0, 4),
                  ),
                ],
              ),
              child: Row(
                children: <Widget>[
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      mainAxisSize: MainAxisSize.min,
                      children: <Widget>[
                        Text(
                          pick?.label ?? "选择一个上车点",
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(
                            fontSize: 13.5,
                            fontWeight: FontWeight.w600,
                            color: cs.onSurface,
                          ),
                        ),
                        const SizedBox(height: 2),
                        Text(
                          pick?.sub ?? "",
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(fontSize: 10.5, color: cs.onSurfaceVariant),
                        ),
                      ],
                    ),
                  ),
                  const SizedBox(width: 10),
                  ShopButton(
                    cs: cs,
                    height: 38,
                    label: "就这里",
                    onTap: pick == null
                        ? null
                        : () => Navigator.of(context).pop(pick),
                  ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }

  LatLng _gcj(double lat, double lng) {
    final ({double lat, double lng}) g = wgs84ToGcj02(lat, lng);
    return LatLng(g.lat, g.lng);
  }
}
