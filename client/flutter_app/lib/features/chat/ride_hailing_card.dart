import "dart:async";
import "dart:math" as math;

import "package:flutter/material.dart";
import "package:flutter_map/flutter_map.dart";
import "package:latlong2/latlong.dart";

import "../../core/services/ride_pickup_api.dart";
import "../../core/utils/agent_result_parser.dart";
import "../../core/utils/coord_transform.dart";
import "ride_car_art.dart";
import "ride_map_3d_view.dart";
import "ride_pickup_fullscreen_page.dart";
import "shopping/shopping_shared.dart";

/// 叫车卡（单卡双阶段，2026-11-24）。
///
/// 一张卡走完「选上车点 → 选车型」：确认上车点后不换卡、不新建 WebView，
/// 地图原地从「选点」切到「路线」，车型列表替换掉候选列表。这是滴滴选车页的
/// 真实交互——用户不该看到两张卡，也不该等地图重新加载一次。
///
/// 两种服务端卡型都落到本组件（ride_pickup / ride_quote），靠 extra 里的
/// stage 区分。**必须保持同一 runtimeType**：否则 card.update 换卡时 Flutter
/// 会销毁 State，WebView 重开、地图重新加载（这正是改造前的观感来源）。
///
/// 载荷：
///   pickup：{ map3d, dropoff, city?, scheduleAt?, origin?, candidates[] }
///   quote ：{ map3d, pickup, dropoff, options[], route?, providerLabel? }
class RideHailingCard extends StatefulWidget {
  const RideHailingCard({
    super.key,
    required this.cs,
    required this.payload,
    this.onUserAction,
    this.cardData,
  });

  final ColorScheme cs;
  final Map<String, dynamic> payload;
  final void Function(AgentResultAction, {required AgentResultData cardData})? onUserAction;
  final AgentResultData? cardData;

  @override
  State<RideHailingCard> createState() => _RideHailingCardState();
}

class _SelectedPickup {
  const _SelectedPickup(this.label, this.sub, this.lat, this.lng, {this.snapped = false});

  final String label;
  final String sub;
  final double lat;
  final double lng;

  /// true = 命中候选上车点；false = 用户自己拖出来的点
  final bool snapped;
}

class _RideHailingCardState extends State<RideHailingCard> {
  // ── 地图（整卡唯一实例，跨阶段复用）──
  final MapController _mapController = MapController();
  final RideMap3dController _map3d = RideMap3dController();
  final RidePickupApi _api = RidePickupApi();
  bool _use3d = false;

  // ── 阶段一：选上车点 ──
  bool _quoteStage = false;
  List<Map<String, dynamic>> _candidates = const <Map<String, dynamic>>[];
  List<RideMapCandidate> _candidates3d = const <RideMapCandidate>[];
  _SelectedPickup? _selected;
  bool _pickupSent = false;
  /// 等报价的兜底：服务端报错时 card.update 不带卡，卡片会一直停在 loading。
  /// 超时后解锁，让用户能再点一次（不做假成功、不假装在叫车）。
  Timer? _sendWatchdog;
  Timer? _reloadTimer;
  Timer? _regeoDebounce;
  double _anchorLat = 0;
  double _anchorLng = 0;
  bool _reloading = false;
  /// 逆地理回包的序号：拖动很快时只认最后一次，避免旧名字盖住新位置。
  int _regeoToken = 0;

  // ── 阶段二：选车型 ──
  List<Map<String, dynamic>> _options = const <Map<String, dynamic>>[];
  Map<String, dynamic> _route = const <String, dynamic>{};
  List<({double lat, double lng})> _routeWgs = const <({double lat, double lng})>[];
  ({double lat, double lng})? _routeFrom;
  ({double lat, double lng})? _routeTo;
  List<LatLng> _routeGcj = const <LatLng>[];
  String _routeSig = "";
  String _pickedOptionId = "";
  bool _didFitRoute = false;

  /// 拖动吸附半径（米）：滴滴的吸附是「图钉压到可上车点才吸」，不是把 150m
  /// 外的停车场也算命中。150m 会让用户每次拖图都跳回预选候选，感觉像「只能
  /// 选它给的点」（2026-11-24 反馈）。
  static const double _dragSnapRadiusM = 35;
  static const double _dragSnapRadiusDeg = _dragSnapRadiusM / 111000;
  /// 候选重推的位移阈值：≈60m（横跨一条街就该换一批候选了）。
  static const double _reloadMoveThresholdDeg = 0.00055;

  ColorScheme get cs => widget.cs;

  @override
  void initState() {
    super.initState();
    _use3d = shopBool(widget.payload["map3d"]);
    _quoteStage = _detectQuote(widget.payload);
    _initPickup();
    _syncQuote();
  }

  @override
  void didUpdateWidget(covariant RideHailingCard oldWidget) {
    super.didUpdateWidget(oldWidget);
    final bool nextQuote = _detectQuote(widget.payload);
    if (nextQuote != _quoteStage) {
      // 同一张卡换阶段：State 与 WebView 都留着，只换下方内容 + 让地图画线
      _quoteStage = nextQuote;
      _pickupSent = false;
      _pickedOptionId = "";
      _sendWatchdog?.cancel();
      _reloadTimer?.cancel();
      _regeoDebounce?.cancel();
      if (nextQuote) {
        _syncQuote();
        _fitRouteSoon();
      }
      return;
    }
    if (nextQuote) _syncQuote();
  }

  @override
  void dispose() {
    _reloadTimer?.cancel();
    _regeoDebounce?.cancel();
    _sendWatchdog?.cancel();
    super.dispose();
  }

  // ─────────────────────────── 数据 ───────────────────────────

  static bool _detectQuote(Map<String, dynamic> p) {
    final String stage = shopStr(p["stage"]);
    if (stage.isNotEmpty) return stage == "quote";
    return p["options"] is List;
  }

  void _initPickup() {
    final List<dynamic> raw =
        widget.payload["candidates"] as List<dynamic>? ?? const <dynamic>[];
    _candidates = raw.whereType<Map>().map(_toMap).toList(growable: false);
    _candidates3d = _buildCandidates3d(_candidates);

    if (_candidates.isNotEmpty) {
      // 滴滴口径：默认选最近的可停靠点（列表已按距离排好）
      _selected = _fromCandidate(_candidates.first);
    } else {
      final Map<Object?, Object?>? origin = _origin;
      if (origin != null) {
        _selected = _SelectedPickup(
          shopStr(origin["label"]).isEmpty ? "我的位置附近" : shopStr(origin["label"]),
          "可拖动地图微调",
          shopNum(origin["lat"])?.toDouble() ?? 0,
          shopNum(origin["lng"])?.toDouble() ?? 0,
          snapped: true,
        );
      }
    }
    final Map<Object?, Object?>? anchor = _origin;
    if (anchor != null) {
      _anchorLat = shopNum(anchor["lat"])?.toDouble() ?? 0;
      _anchorLng = shopNum(anchor["lng"])?.toDouble() ?? 0;
    }
  }

  /// 轨迹只在**内容真变了**时替换：parent 每次 rebuild 都换新 List 会让
  /// RideMap3dView 误判数据变化，重复 setData 把地图弹回起点。
  void _syncQuote() {
    final Map<String, dynamic> route = _asMap(widget.payload["route"]);
    final List<({double lat, double lng})> points = _extractRouteWgs(route["points"]);
    final ({double lat, double lng})? from = _point(route["from"]);
    final ({double lat, double lng})? to = _point(route["to"]);
    final String sig =
        "${route["distanceText"]}|${route["durationText"]}|${points.length}|"
        "${points.isEmpty ? "" : "${points.first.lat},${points.first.lng}"}|"
        "${points.isEmpty ? "" : "${points.last.lat},${points.last.lng}"}|"
        "${from?.lat},${from?.lng}|${to?.lat},${to?.lng}";
    if (sig != _routeSig) {
      _routeSig = sig;
      _route = route;
      _routeWgs = points;
      _routeFrom = from;
      _routeTo = to;
      final List<({double lat, double lng})> line = points.isNotEmpty
          ? points
          : <({double lat, double lng})>[
              if (from != null) from,
              if (to != null) to,
            ];
      _routeGcj = <LatLng>[
        for (final ({double lat, double lng}) p in line)
          LatLng(
            wgs84ToGcj02(p.lat, p.lng).lat,
            wgs84ToGcj02(p.lat, p.lng).lng,
          ),
      ];
      _didFitRoute = false;
    }
    final List<Map<String, dynamic>> opts = shopMaps(widget.payload["options"]);
    if (opts.isNotEmpty) _options = opts;
  }

  ({double lat, double lng})? _point(Object? raw) {
    if (raw is! Map) return null;
    final num? lat = shopNum(raw["lat"]);
    final num? lng = shopNum(raw["lng"]);
    if (lat == null || lng == null) return null;
    return (lat: lat.toDouble(), lng: lng.toDouble());
  }

  List<({double lat, double lng})> _extractRouteWgs(Object? raw) {
    final List<dynamic> list = raw is List ? raw : const <dynamic>[];
    final List<({double lat, double lng})> out = <({double lat, double lng})>[];
    for (final dynamic item in list) {
      if (item is List && item.length >= 2) {
        final num? lat = shopNum(item[0]);
        final num? lng = shopNum(item[1]);
        if (lat != null && lng != null) out.add((lat: lat.toDouble(), lng: lng.toDouble()));
      }
    }
    return out;
  }

  Map<String, dynamic> _toMap(Map raw) => <String, dynamic>{
        for (final MapEntry<Object?, Object?> e in raw.entries) e.key.toString(): e.value,
      };

  Map<String, dynamic> _asMap(Object? raw) {
    if (raw is Map) return _toMap(raw);
    return const <String, dynamic>{};
  }

  Map<Object?, Object?>? get _origin {
    final Object? raw = widget.payload["origin"];
    return raw is Map ? raw : null;
  }

  /// origin 是 WGS-84（手机 GPS / 服务端基准）；高德底图是 GCJ-02，
  /// 渲染前必须转一次，否则定位点会整体偏移 300~700m。
  ({double lat, double lng})? get _originGcj {
    final Map<Object?, Object?>? origin = _origin;
    if (origin == null) return null;
    final num? lat = shopNum(origin["lat"]);
    final num? lng = shopNum(origin["lng"]);
    if (lat == null || lng == null) return null;
    return wgs84ToGcj02(lat.toDouble(), lng.toDouble());
  }

  ({double lat, double lng, String label})? get _originWgs {
    final Map<Object?, Object?>? origin = _origin;
    if (origin == null) return null;
    final num? lat = shopNum(origin["lat"]);
    final num? lng = shopNum(origin["lng"]);
    if (lat == null || lng == null) return null;
    return (lat: lat.toDouble(), lng: lng.toDouble(), label: shopStr(origin["label"]));
  }

  List<RideMapCandidate> _buildCandidates3d(List<Map<String, dynamic>> src) {
    final List<RideMapCandidate> out = <RideMapCandidate>[];
    for (final Map<String, dynamic> c in src) {
      final num? lat = shopNum(c["lat"]);
      final num? lng = shopNum(c["lng"]);
      if (lat == null || lng == null) continue;
      out.add(RideMapCandidate(
        name: shopStr(c["name"]).isEmpty ? "候选上车点" : shopStr(c["name"]),
        address: shopStr(c["address"]),
        lat: lat.toDouble(),
        lng: lng.toDouble(),
        distM: shopNum(c["distM"])?.toInt(),
      ));
    }
    return out;
  }

  _SelectedPickup _fromCandidate(Map<String, dynamic> c) => _SelectedPickup(
        shopStr(c["name"]).isEmpty ? "候选上车点" : shopStr(c["name"]),
        shopStr(c["address"]),
        shopNum(c["lat"])?.toDouble() ?? 0,
        shopNum(c["lng"])?.toDouble() ?? 0,
        snapped: true,
      );

  // ─────────────────────── 选点交互 ───────────────────────

  void _on3dSelect(RideMapPick pick) {
    if (!mounted || _pickupSent || _quoteStage) return;
    final bool snapped = pick.index >= 0;
    _applySelection(
      _SelectedPickup(
        snapped ? (pick.name.isEmpty ? "候选上车点" : pick.name) : "地图上的点",
        snapped ? pick.address : "正在识别位置…",
        pick.lat,
        pick.lng,
        snapped: snapped,
      ),
    );
    if (!snapped) {
      // 自定义点：先逆地理拿真实地名（像滴滴一样直接显示所处 POI），
      // 再按新位置刷新周边候选——两条线互不阻塞。
      _regeoName(pick.lat, pick.lng);
      _scheduleReload(pick.lat, pick.lng);
    }
  }

  /// 只在「标签/坐标真的变了」时 setState：拖动过程 moveend 很密，
  /// 每次都重建整卡会让 WebView 掉帧（流畅度）。
  void _applySelection(_SelectedPickup next) {
    final _SelectedPickup? cur = _selected;
    if (cur != null &&
        cur.label == next.label &&
        cur.snapped == next.snapped &&
        (cur.lat - next.lat).abs() < 1e-6 &&
        (cur.lng - next.lng).abs() < 1e-6) {
      return;
    }
    setState(() => _selected = next);
  }

  void _regeoName(double lat, double lng) {
    final int token = ++_regeoToken;
    _regeoDebounce?.cancel();
    _regeoDebounce = Timer(const Duration(milliseconds: 220), () async {
      final RidePickupSuggestion? res = await _api.around(
        lng: lng,
        lat: lat,
        withCandidates: false,
      );
      if (!mounted || token != _regeoToken || _pickupSent || _quoteStage) return;
      final _SelectedPickup? cur = _selected;
      if (cur == null || cur.snapped) return;
      if ((cur.lat - lat).abs() > 1e-6 || (cur.lng - lng).abs() > 1e-6) return;
      final String name = (res?.label ?? "").trim();
      if (name.isEmpty) return;
      setState(() => _selected = _SelectedPickup(name, "自定义上车点", lat, lng));
    });
  }

  /// 拖到新位置后重推候选。500ms 去抖 + 60m 位移阈值；失败静默保留原候选。
  void _scheduleReload(double lat, double lng) {
    if (_pickupSent || _quoteStage) return;
    if (_anchorLat != 0 &&
        (lat - _anchorLat).abs() + (lng - _anchorLng).abs() < _reloadMoveThresholdDeg) {
      return;
    }
    _reloadTimer?.cancel();
    _reloadTimer = Timer(const Duration(milliseconds: 500), () => _reloadAround(lat, lng));
  }

  Future<void> _reloadAround(double lat, double lng) async {
    if (_reloading || !mounted || _pickupSent) return;
    _reloading = true;
    _anchorLat = lat;
    _anchorLng = lng;
    final RidePickupSuggestion? res = await _api.around(lng: lng, lat: lat);
    _reloading = false;
    if (!mounted || _pickupSent || res == null) return;
    final List<Map<String, dynamic>> next =
        res.candidates.map((RidePickupCandidate c) => c.toPayload()).toList(growable: false);
    setState(() {
      _candidates = next;
      _candidates3d = _buildCandidates3d(next);
      // 不把选中态抢到最近的候选上：用户拖到哪就选哪（这是「自由选点」的关键）
      final _SelectedPickup? cur = _selected;
      if (cur == null || !cur.snapped) {
        final String name = res.label.trim();
        if (name.isNotEmpty) {
          _selected = _SelectedPickup(name, "自定义上车点", cur?.lat ?? lat, cur?.lng ?? lng);
        }
      }
    });
  }

  void _syncFromCenter() {
    if (!mounted || _quoteStage) return;
    final LatLng center = _mapController.camera.center;
    final ({double lat, double lng}) wgs = gcj02ToWgs84(center.latitude, center.longitude);
    Map<String, dynamic>? best;
    double bestD = double.infinity;
    for (final Map<String, dynamic> c in _candidates) {
      final num? lat = shopNum(c["lat"]);
      final num? lng = shopNum(c["lng"]);
      if (lat == null || lng == null) continue;
      final double d = math.sqrt(
        math.pow(wgs.lat - lat.toDouble(), 2) + math.pow(wgs.lng - lng.toDouble(), 2),
      );
      if (d < bestD) {
        bestD = d;
        best = c;
      }
    }
    if (best != null && bestD < _dragSnapRadiusDeg) {
      _applySelection(_fromCandidate(best));
      return;
    }
    _applySelection(_SelectedPickup("地图上的点", "正在识别位置…", wgs.lat, wgs.lng));
    _regeoName(wgs.lat, wgs.lng);
    _scheduleReload(wgs.lat, wgs.lng);
  }

  void _pickCandidate(Map<String, dynamic> c) {
    _applySelection(_fromCandidate(c));
    final num? lat = shopNum(c["lat"]);
    final num? lng = shopNum(c["lng"]);
    if (lat != null && lng != null && !_use3d) {
      final ({double lat, double lng}) gcj =
          wgs84ToGcj02(lat.toDouble(), lng.toDouble());
      _mapController.move(LatLng(gcj.lat, gcj.lng), 16.5);
    }
  }

  void _recenter() {
    final ({double lat, double lng})? gcj = _originGcj;
    if (gcj == null) return;
    _mapController.move(LatLng(gcj.lat, gcj.lng), 16);
    Future<void>.delayed(const Duration(milliseconds: 40), _syncFromCenter);
  }

  void _fallbackTo2d() {
    if (!mounted || !_use3d) return;
    setState(() => _use3d = false);
  }

  Future<void> _openFullscreen() async {
    if (_quoteStage) return;
    final ({double lat, double lng, String label})? o = _originWgs;
    final double initLat = _selected?.lat ?? o?.lat ?? 25.0;
    final double initLng = _selected?.lng ?? o?.lng ?? 104.9;
    final RidePickupPoint? pick = await Navigator.of(context).push<RidePickupPoint>(
      MaterialPageRoute<RidePickupPoint>(
        builder: (BuildContext ctx) => RidePickupFullscreenPage(
          cs: cs,
          title: "选择上车点",
          initialLat: initLat,
          initialLng: initLng,
          candidates: _candidates,
          origin: o == null ? null : (lat: o.lat, lng: o.lng),
          use3d: _use3d,
        ),
      ),
    );
    if (pick != null && mounted) {
      _applySelection(_SelectedPickup(pick.label, pick.sub, pick.lat, pick.lng,
          snapped: pick.snapped));
    }
  }

  // ─────────────────────── 动作回传 ───────────────────────

  void _confirmPickup() {
    if (_pickupSent || _selected == null || _quoteStage) return;
    final AgentResultData? data = widget.cardData;
    final void Function(AgentResultAction, {required AgentResultData cardData})? cb =
        widget.onUserAction;
    if (data == null || cb == null) return;
    final _SelectedPickup sel = _selected!;
    setState(() => _pickupSent = true);
    _armWatchdog(() {
      if (!mounted || !_pickupSent) return;
      setState(() => _pickupSent = false);
    });
    cb(
      AgentResultAction(
        id: "ride_pickup_confirm_${DateTime.now().millisecondsSinceEpoch}",
        label: "从这里上车",
        variant: "primary",
        payload: <String, dynamic>{
          "cardAction": "ride.pickup.select",
          "lat": sel.lat,
          "lng": sel.lng,
          "pickup": sel.label,
          "dropoff": shopStr(widget.payload["dropoff"]),
          if (shopStr(widget.payload["city"]).isNotEmpty)
            "city": shopStr(widget.payload["city"]),
          if (shopStr(widget.payload["scheduleAt"]).isNotEmpty)
            "scheduleAt": shopStr(widget.payload["scheduleAt"]),
        },
      ),
      cardData: data,
    );
  }

  /// 等回包的兜底闸门：服务端失败时不会推新卡，卡片必须自己解锁，
  /// 否则用户点了没反应、也点不了第二次。
  void _armWatchdog(VoidCallback unlock) {
    _sendWatchdog?.cancel();
    _sendWatchdog = Timer(const Duration(seconds: 18), () {
      if (!mounted) return;
      unlock();
    });
  }

  void _emitOption(Map<String, dynamic> option) {    if (_pickedOptionId.isNotEmpty) return;
    final AgentResultData? data = widget.cardData;
    final void Function(AgentResultAction, {required AgentResultData cardData})? cb =
        widget.onUserAction;
    if (data == null || cb == null) return;
    final Map<String, dynamic> action = _asMap(option["action"]);
    final String cardAction = shopStr(action["cardAction"]);
    if (cardAction.isEmpty) return;
    final String optionId = shopStr(option["optionId"]);
    setState(() => _pickedOptionId = optionId);
    _armWatchdog(() {
      if (!mounted || _pickedOptionId.isEmpty) return;
      setState(() => _pickedOptionId = "");
    });
    cb(
      AgentResultAction(
        id: shopStr(action["id"]).isEmpty
            ? "ride_pick_${DateTime.now().millisecondsSinceEpoch}"
            : shopStr(action["id"]),
        label: "就选这个",
        variant: "primary",
        payload: <String, dynamic>{
          ..._asMap(action["payload"]),
          "cardAction": cardAction,
        },
      ),
      cardData: data,
    );
  }

  // ─────────────────────── 地图 ───────────────────────

  LatLng get _mapCenter {
    // 有推荐上车点时以它为中心（与「图钉所指即所选」一致），否则退回定位点
    final _SelectedPickup? sel = _selected;
    if (sel != null && !_quoteStage && (sel.lat != 0 || sel.lng != 0)) {
      final ({double lat, double lng}) gcj = wgs84ToGcj02(sel.lat, sel.lng);
      return LatLng(gcj.lat, gcj.lng);
    }
    final ({double lat, double lng})? gcj = _originGcj;
    if (gcj != null) return LatLng(gcj.lat, gcj.lng);
    return const LatLng(32.5, 108.0);
  }

  double get _initialZoom => _origin != null ? 16 : 4.2;

  void _fitRouteSoon() {
    if (_didFitRoute || _routeGcj.length < 2) return;
    _didFitRoute = true;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted || _use3d) return;
      _mapController.fitCamera(
        CameraFit.coordinates(
          coordinates: _routeGcj,
          padding: const EdgeInsets.all(30),
        ),
      );
    });
  }

  Widget _buildMap() {
    return Stack(
      children: <Widget>[
        // 3D（高德 JS）：同一实例贯穿两个阶段；页面内部 setData 切模式，
        // 不重新 loadRequest —— 这就是「不重新加载地图」的落点。
        if (_use3d)
          Positioned.fill(
            child: RideMap3dView(
              controller: _map3d,
              mode: _quoteStage ? "route" : "pickup",
              origin: _quoteStage ? null : _originWgs,
              candidates: _quoteStage ? const <RideMapCandidate>[] : _candidates3d,
              routePoints: _quoteStage ? _routeWgs : const <({double lat, double lng})>[],
              routeFrom: _quoteStage ? _routeFrom : null,
              routeTo: _quoteStage ? _routeTo : null,
              snapRadiusM: _dragSnapRadiusM,
              onSelect: _on3dSelect,
              onFailed: _fallbackTo2d,
            ),
          )
        else
          Positioned.fill(
            child: FlutterMap(
              mapController: _mapController,
              options: MapOptions(
                initialCenter: _mapCenter,
                initialZoom: _initialZoom,
                interactionOptions: const InteractionOptions(
                  flags: InteractiveFlag.all & ~InteractiveFlag.rotate,
                ),
                onTap: (_, LatLng tapped) {
                  _mapController.move(tapped, _mapController.camera.zoom);
                  Future<void>.delayed(const Duration(milliseconds: 40), _syncFromCenter);
                },
                onMapEvent: (MapEvent event) {
                  if (event is MapEventMoveEnd ||
                      event is MapEventFlingAnimationEnd ||
                      event is MapEventDoubleTapZoomEnd) {
                    _syncFromCenter();
                  }
                },
              ),
              children: <Widget>[
                TileLayer(
                  // flutter_map 只认 {s} 占位符 + subdomains（{1-4} 区间语法会拼出非法域名）
                  urlTemplate:
                      "https://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}",
                  subdomains: const <String>["1", "2", "3", "4"],
                  userAgentPackageName: "app.nextbot.client",
                ),
                if (_quoteStage && _routeWgs.length >= 2)
                  PolylineLayer(
                    polylines: <Polyline>[
                      Polyline(
                        points: _routeGcj,
                        strokeWidth: 4.5,
                        color: cs.onSurface,
                        borderColor: cs.surface,
                        borderStrokeWidth: 1.5,
                      ),
                    ],
                  ),
                if (!_quoteStage) MarkerLayer(markers: _mapMarkers()),
                if (_quoteStage && _routeGcj.isNotEmpty)
                  MarkerLayer(
                    markers: <Marker>[
                      Marker(
                        point: _routeGcj.first,
                        width: 12,
                        height: 12,
                        child: Container(
                          decoration: BoxDecoration(
                            shape: BoxShape.circle,
                            color: cs.surface,
                            border: Border.all(color: cs.onSurface, width: 2),
                          ),
                        ),
                      ),
                      Marker(
                        point: _routeGcj.last,
                        width: 12,
                        height: 12,
                        child: Container(
                          decoration: BoxDecoration(
                            shape: BoxShape.circle,
                            color: cs.onSurface,
                          ),
                        ),
                      ),
                    ],
                  ),
              ],
            ),
          ),
        // 中心图钉：2D 选点阶段专用（3D 页面自带）
        if (!_use3d && !_quoteStage)
          const Positioned.fill(
            child: IgnorePointer(
              child: Center(
                child: Icon(Icons.location_on, size: 34, color: Colors.black),
              ),
            ),
          ),
        // 右上角控件：回定位（仅 2D 选点）+ 全屏（仅选点）
        if (!_quoteStage)
          Positioned(
            top: 8,
            right: 8,
            child: Column(
              children: <Widget>[
                if (!_use3d && _origin != null)
                  _mapChip(icon: Icons.my_location, onTap: _recenter),
                if (!_use3d && _origin != null) const SizedBox(height: 8),
                _mapChip(icon: Icons.open_in_full, onTap: _openFullscreen),
              ],
            ),
          ),
        if (!_use3d)
          Positioned(
            left: 6,
            bottom: 4,
            child: Text(
              "© 高德地图",
              style: TextStyle(fontSize: 8, color: Colors.black.withValues(alpha: 0.45)),
            ),
          ),
        // 等报价时给地图一块轻遮罩：地图不动、不白，用户知道在等车
        if (_pickupSent && !_quoteStage)
          Positioned.fill(
            child: AbsorbPointer(
              child: ColoredBox(
                color: cs.surface.withValues(alpha: 0.55),
                child: Center(
                  child: Container(
                    padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 7),
                    decoration: BoxDecoration(
                      color: cs.surface,
                      borderRadius: BorderRadius.circular(99),
                      boxShadow: <BoxShadow>[
                        BoxShadow(
                          color: Colors.black.withValues(alpha: 0.12),
                          blurRadius: 8,
                        ),
                      ],
                    ),
                    child: Row(
                      mainAxisSize: MainAxisSize.min,
                      children: <Widget>[
                        SizedBox(
                          width: 11,
                          height: 11,
                          child: CircularProgressIndicator(
                            strokeWidth: 1.6,
                            color: cs.onSurface,
                          ),
                        ),
                        const SizedBox(width: 7),
                        Text(
                          "正在为你找车…",
                          style: TextStyle(fontSize: 10.5, color: cs.onSurface),
                        ),
                      ],
                    ),
                  ),
                ),
              ),
            ),
          ),
      ],
    );
  }

  Widget _mapChip({required IconData icon, required VoidCallback onTap}) {
    return GestureDetector(
      onTap: onTap,
      child: Container(
        padding: const EdgeInsets.all(6),
        decoration: BoxDecoration(
          color: cs.surface,
          shape: BoxShape.circle,
          boxShadow: <BoxShadow>[
            BoxShadow(color: Colors.black.withValues(alpha: 0.12), blurRadius: 4),
          ],
        ),
        child: Icon(icon, size: 16, color: cs.onSurface),
      ),
    );
  }

  List<Marker> _mapMarkers() {
    final List<Marker> markers = <Marker>[];
    for (final Map<String, dynamic> c in _candidates) {
      final num? lat = shopNum(c["lat"]);
      final num? lng = shopNum(c["lng"]);
      if (lat == null || lng == null) continue;
      final ({double lat, double lng}) gcj =
          wgs84ToGcj02(lat.toDouble(), lng.toDouble());
      markers.add(
        Marker(
          point: LatLng(gcj.lat, gcj.lng),
          width: 14,
          height: 14,
          child: Container(
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              color: cs.surface,
              border: Border.all(color: cs.onSurface, width: 1.5),
            ),
          ),
        ),
      );
    }
    final ({double lat, double lng})? origin = _originGcj;
    if (origin != null) {
      markers.add(
        Marker(
          point: LatLng(origin.lat, origin.lng),
          width: 18,
          height: 18,
          child: Container(
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              color: const Color(0xFF2F6BFF),
              border: Border.all(color: Colors.white, width: 2.5),
              boxShadow: <BoxShadow>[
                BoxShadow(
                  color: const Color(0xFF2F6BFF).withValues(alpha: 0.35),
                  blurRadius: 6,
                  spreadRadius: 2,
                ),
              ],
            ),
          ),
        ),
      );
    }
    return markers;
  }

  // ─────────────────────── 构建 ───────────────────────

  @override
  Widget build(BuildContext context) {
    final String dropoff = shopStr(widget.payload["dropoff"]);
    final String pickup = shopStr(widget.payload["pickup"]);

    return ShopCardShell(
      cs: cs,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          ShopCardHeader(
            cs: cs,
            icon: Icons.local_taxi_outlined,
            iconColor: cs.onSurface,
            title: _quoteStage ? "选车型" : "选上车点",
            subtitle: _quoteStage
                ? (pickup.isEmpty ? null : "$pickup → ${dropoff.isEmpty ? "目的地" : dropoff}")
                : (dropoff.isEmpty ? null : "去 $dropoff"),
          ),
          ShopDivider(cs: cs),
          Padding(
            padding: const EdgeInsets.fromLTRB(13, 10, 13, 0),
            child: ClipRRect(
              borderRadius: BorderRadius.circular(10),
              child: RepaintBoundary(
                child: SizedBox(height: 190, child: _buildMap()),
              ),
            ),
          ),
          if (_quoteStage) ..._quoteSection() else ..._pickupSection(),
        ],
      ),
    );
  }

  List<Widget> _pickupSection() {
    final _SelectedPickup? sel = _selected;
    return <Widget>[
      // 选中点：只留一行地名（地址/精度/操作提示都是多余文案）
      Container(
        margin: const EdgeInsets.fromLTRB(13, 10, 13, 0),
        padding: const EdgeInsets.fromLTRB(11, 10, 11, 10),
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(10),
          border: Border.all(color: cs.outline.withValues(alpha: 0.35)),
        ),
        child: Row(
          children: <Widget>[
            Icon(Icons.trip_origin, size: 14, color: cs.onSurface),
            const SizedBox(width: 8),
            Expanded(
              child: Text(
                sel?.label ?? "拖动地图选上车点",
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(
                  fontSize: 12.5,
                  fontWeight: FontWeight.w600,
                  color: cs.onSurface,
                ),
              ),
            ),
          ],
        ),
      ),
      for (int i = 0; i < _candidates.length; i++) _candidateRow(i),
      Padding(
        padding: const EdgeInsets.fromLTRB(13, 12, 13, 13),
        child: ShopButton(
          cs: cs,
          height: 40,
          label: sel == null
              ? "选上车点"
              : _pickupSent
                  ? "正在叫车…"
                  : "从这里上车",
          onTap: sel == null || _pickupSent ? null : _confirmPickup,
        ),
      ),
    ];
  }

  List<Widget> _quoteSection() {
    if (_options.isEmpty) {
      return <Widget>[
        Padding(
          padding: const EdgeInsets.fromLTRB(13, 12, 13, 13),
          child: Text(
            "这次没拿到可用车型，换个说法再报一次",
            style: TextStyle(fontSize: 12, color: cs.onSurfaceVariant),
          ),
        ),
      ];
    }
    final String distance = shopStr(_route["distanceText"]);
    final String duration = shopStr(_route["durationText"]);
    return <Widget>[
      if (distance.isNotEmpty || duration.isNotEmpty)
        Padding(
          padding: const EdgeInsets.fromLTRB(13, 8, 13, 0),
          child: Row(
            children: <Widget>[
              Icon(Icons.route_outlined, size: 12, color: cs.onSurfaceVariant),
              const SizedBox(width: 5),
              Text(
                <String>[
                  if (distance.isNotEmpty) distance,
                  if (duration.isNotEmpty) duration,
                ].join(" · "),
                style: TextStyle(fontSize: 10.5, color: cs.onSurfaceVariant),
              ),
            ],
          ),
        ),
      for (final Map<String, dynamic> option in _options) _optionRow(option),
    ];
  }

  Widget _candidateRow(int index) {
    final Map<String, dynamic> c = _candidates[index];
    final _SelectedPickup? sel = _selected;
    final bool on = sel != null &&
        sel.snapped &&
        shopStr(sel.label) == shopStr(c["name"]);
    final num? dist = shopNum(c["distM"]);
    return Padding(
      padding: const EdgeInsets.fromLTRB(13, 6, 13, 0),
      child: ShopTap(
        onTap: _pickupSent
            ? null
            : () {
                if (_use3d) {
                  _map3d.focusCandidate(index);
                } else {
                  _pickCandidate(c);
                }
              },
        child: Container(
          padding: const EdgeInsets.fromLTRB(11, 9, 11, 9),
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(10),
            border: Border.all(
              color: on ? cs.onSurface : cs.outline.withValues(alpha: 0.2),
              width: on ? 1.4 : 1,
            ),
          ),
          child: Row(
            children: <Widget>[
              Icon(
                on ? Icons.radio_button_checked : Icons.radio_button_off,
                size: 14,
                color: on ? cs.onSurface : cs.onSurfaceVariant,
              ),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  shopStr(c["name"]).isEmpty ? "候选上车点" : shopStr(c["name"]),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    fontSize: 12,
                    fontWeight: FontWeight.w600,
                    color: cs.onSurface,
                  ),
                ),
              ),
              if (dist != null)
                Text(
                  _walkText(dist),
                  style: TextStyle(fontSize: 9.5, color: cs.onSurfaceVariant),
                ),
            ],
          ),
        ),
      ),
    );
  }

  /// 候选行的步行文案（滴滴口径：上车点必须告诉用户「要走多远」）。
  String _walkText(num distM) {
    final int m = distM.round();
    final int min = math.max(1, (m / 70).ceil());
    return m >= 1000 ? "${(m / 1000).toStringAsFixed(1)}km · $min 分钟" : "${m}m · $min 分钟";
  }

  Widget _optionRow(Map<String, dynamic> option) {
    final String optionId = shopStr(option["optionId"]);
    final String name = shopStr(option["name"]);
    final String price = shopStr(option["price"]);
    final bool simulated = shopBool(option["simulated"]);
    final bool picked = _pickedOptionId == optionId && optionId.isNotEmpty;
    final bool locked = _pickedOptionId.isNotEmpty;
    final num? eta = shopNum(option["etaMinutes"]);

    return Padding(
      padding: const EdgeInsets.fromLTRB(13, 8, 13, 0),
      child: ShopTap(
        onTap: locked ? null : () => _emitOption(option),
        child: AnimatedContainer(
          duration: const Duration(milliseconds: 140),
          padding: const EdgeInsets.fromLTRB(9, 8, 10, 8),
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(12),
            color: picked ? cs.onSurface.withValues(alpha: 0.05) : null,
            border: Border.all(
              color: picked ? cs.onSurface : cs.outline.withValues(alpha: 0.22),
              width: picked ? 1.4 : 1,
            ),
          ),
          child: Row(
            children: <Widget>[
              RideCarArt(
                style: rideCarStyleFor(name),
                color: cs.onSurface,
                width: 74,
                active: picked,
              ),
              const SizedBox(width: 8),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisSize: MainAxisSize.min,
                  children: <Widget>[
                    Row(
                      children: <Widget>[
                        Flexible(
                          child: Text(
                            name.isEmpty ? "车型" : name,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: TextStyle(
                              fontSize: 13,
                              fontWeight: FontWeight.w600,
                              color: cs.onSurface,
                            ),
                          ),
                        ),
                        if (simulated) ...<Widget>[
                          const SizedBox(width: 5),
                          ShopBadge(cs: cs, label: "模拟", tone: ShopBadgeTone.warn),
                        ],
                      ],
                    ),
                    if (eta != null && eta > 0)
                      Padding(
                        padding: const EdgeInsets.only(top: 2),
                        child: Text(
                          "约 ${eta.toInt()} 分钟接驾",
                          style: TextStyle(fontSize: 10, color: cs.onSurfaceVariant),
                        ),
                      ),
                  ],
                ),
              ),
              const SizedBox(width: 6),
              Text(
                price.isEmpty ? "—" : price,
                style: TextStyle(
                  fontSize: 16.5,
                  fontWeight: FontWeight.w700,
                  letterSpacing: -0.4,
                  color: cs.onSurface,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
