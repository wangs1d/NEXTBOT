import "dart:math" as math;

import "package:flutter/material.dart";
import "package:flutter_map/flutter_map.dart";
import "package:latlong2/latlong.dart";

import "../../core/utils/agent_result_parser.dart";
import "../../core/utils/coord_transform.dart";
import "ride_map_3d_view.dart";
import "shopping/shopping_shared.dart";

/// 上车点选择卡（cardType = "ride_pickup"，2026-11-20）。
///
/// 起点没着落时服务端确定性推卡（shopping_login 同通道），用户点候选
/// 或拖地图选好点后经 card.action（ride.pickup.select）直接续报价——
/// 全程零模型轮次、零文字追问。与滴滴/高德 App 选点同范式：图钉固定
/// 卡片中心，地图随手拖，拖到哪选到哪。
///
/// 数据面只用滴滴 MCP：候选走滴图 maps_place_around（停车场/可停车点，
/// 按距离排），报价/下单走 taxi_*。卡内地图仅做选点渲染。
/// 载荷（extra.ridePickup）：{ dropoff, city?, scheduleAt?, origin?, candidates[] }
/// - origin 有值（有定位但粒度不够）→ 地图居中定位点 + 周边候选快捷选；
/// - 无 origin（纯无定位，桌面端常见）→ 无候选，全国视野起步拖到目的地附近。
class RidePickupCard extends StatefulWidget {
  const RidePickupCard({
    super.key,
    required this.cs,
    required this.payload,
    this.onUserAction,
    this.cardData,
  });

  final ColorScheme cs;
  final Map<String, dynamic> payload;
  final void Function(AgentResultAction,
      {required AgentResultData cardData})? onUserAction;
  final AgentResultData? cardData;

  @override
  State<RidePickupCard> createState() => _RidePickupCardState();
}

class _SelectedPickup {
  const _SelectedPickup(this.label, this.sub, this.lat, this.lng, {this.snapped = false});
  final String label;
  final String sub;
  final double lat;
  final double lng;
  /// true = 命中候选；false = 地图自选点
  final bool snapped;
}

class _RidePickupCardState extends State<RidePickupCard> {
  final MapController _mapController = MapController();
  final RideMap3dController _map3d = RideMap3dController();
  bool _sent = false;
  _SelectedPickup? _selected;

  /// 服务端配了 AMAP_JS_KEY 时走卡内高德 JS 3D 地图；页面失败/平台不支持时回退 FlutterMap
  bool _use3d = false;
  late final List<RideMapCandidate> _candidates3d;

  bool _hasOrigin() => widget.payload["origin"] is Map;

  List<Map<String, dynamic>> get _candidates {
    final List<dynamic> raw = widget.payload["candidates"] as List<dynamic>? ?? const <dynamic>[];
    return raw
        .whereType<Map>()
        .map((m) => <String, dynamic>{
              for (final MapEntry<Object?, Object?> e in m.entries)
                e.key.toString(): e.value,
            })
        .toList();
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

  /// origin 原样（WGS-84）交给 3D 页面，由组件内部转 GCJ 注入。
  ({double lat, double lng, String label})? get _originWgs {
    final Map<Object?, Object?>? origin = _origin;
    if (origin == null) return null;
    final num? lat = shopNum(origin["lat"]);
    final num? lng = shopNum(origin["lng"]);
    if (lat == null || lng == null) return null;
    return (lat: lat.toDouble(), lng: lng.toDouble(), label: shopStr(origin["label"]));
  }

  /// 候选冻结成 3D 组件的输入（WGS）。必须是稳定实例：每次 build 新建列表会让
  /// RideMap3dView 误判数据变化并重复注入，导致页面每次重建都重新居中。
  List<RideMapCandidate> _buildCandidates3d() {
    final List<RideMapCandidate> out = <RideMapCandidate>[];
    for (final Map<String, dynamic> c in _candidates) {
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

  /// 3D 页面的选点事件（坐标已由组件从 GCJ 转回 WGS）。
  void _on3dSelect(RideMapPick pick) {
    if (!mounted || _sent) return;
    final bool snapped = pick.index >= 0;
    setState(() {
      _selected = _SelectedPickup(
        snapped
            ? (pick.name.isEmpty ? "候选上车点" : pick.name)
            : "自定义上车点",
        snapped ? pick.address : "拖到这里就选这里",
        pick.lat,
        pick.lng,
        snapped: snapped,
      );
    });
  }

  void _fallbackTo2d() {
    if (!mounted || !_use3d) return;
    setState(() => _use3d = false);
  }

  @override
  void initState() {
    super.initState();
    _use3d = shopBool(widget.payload["map3d"]);
    _candidates3d = _buildCandidates3d();
    final List<Map<String, dynamic>> cands = _candidates;
    if (cands.isNotEmpty) {
      _selected = _fromCandidate(cands.first);
    } else {
      final Map<Object?, Object?>? origin = _origin;
      if (origin != null) {
        _selected = _SelectedPickup(
          shopStr(origin["label"]).isEmpty ? "我的定位附近" : shopStr(origin["label"]),
          "定位粒度较粗，建议拖图微调或点候选",
          shopNum(origin["lat"])?.toDouble() ?? 0,
          shopNum(origin["lng"])?.toDouble() ?? 0,
          snapped: true,
        );
      }
    }
  }

  _SelectedPickup _fromCandidate(Map<String, dynamic> c) {
    return _SelectedPickup(
      shopStr(c["name"]).isEmpty ? "候选上车点" : shopStr(c["name"]),
      shopStr(c["address"]),
      shopNum(c["lat"])?.toDouble() ?? 0,
      shopNum(c["lng"])?.toDouble() ?? 0,
      snapped: true,
    );
  }

  ColorScheme get cs => widget.cs;

  /// 中心点（地图=GCJ-02 世界坐标）→ 就近吸附候选 / 自定义点，实时更新标签。
  ///
  /// 候选坐标与 [selected] 一律 WGS-84（回传服务端用），所以先把地图中心
  /// 从 GCJ 转回 WGS，再和候选（WGS）比距离。
  void _syncFromCenter() {
    if (!mounted) return;
    final LatLng center = _mapController.camera.center;
    final ({double lat, double lng}) centerWgs =
        gcj02ToWgs84(center.latitude, center.longitude);
    final List<Map<String, dynamic>> cands = _candidates;
    Map<String, dynamic>? best;
    double bestD = double.infinity;
    for (final Map<String, dynamic> c in cands) {
      final num? lat = shopNum(c["lat"]);
      final num? lng = shopNum(c["lng"]);
      if (lat == null || lng == null) continue;
      final double d = math.sqrt(
        math.pow(centerWgs.lat - lat.toDouble(), 2) +
            math.pow(centerWgs.lng - lng.toDouble(), 2),
      );
      if (d < bestD) {
        bestD = d;
        best = c;
      }
    }
    if (best != null && bestD < 0.004) {
      final Map<String, dynamic> hit = best;
      setState(() => _selected = _fromCandidate(hit));
      return;
    }
    setState(() => _selected = _SelectedPickup(
          "自定义上车点",
          best != null
              ? "近「${shopStr(best["name"])}」"
              : "拖到这里就选这里",
          centerWgs.lat,
          centerWgs.lng,
        ));
  }

  void _pickCandidate(Map<String, dynamic> c) {
    setState(() => _selected = _fromCandidate(c));
    final num? lat = shopNum(c["lat"]);
    final num? lng = shopNum(c["lng"]);
    if (lat != null && lng != null) {
      // 候选是 WGS-84，地图是 GCJ-02：移动前转换
      final ({double lat, double lng}) gcj =
          wgs84ToGcj02(lat.toDouble(), lng.toDouble());
      _mapController.move(LatLng(gcj.lat, gcj.lng), 16.5);
    }
  }

  /// 回到「我的位置」（origin 的 GCJ 坐标）。
  void _recenter() {
    final ({double lat, double lng})? gcj = _originGcj;
    if (gcj == null) return;
    _mapController.move(LatLng(gcj.lat, gcj.lng), 16);
    Future<void>.delayed(const Duration(milliseconds: 30), _syncFromCenter);
  }

  /// 地图标记：候选点（WGS→GCJ 上底图）+「我的位置」蓝点（origin 的 GCJ）。
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
          width: 16,
          height: 16,
          child: Container(
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              color: cs.surface,
              border: Border.all(color: cs.outline, width: 1.5),
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
          width: 20,
          height: 20,
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

  void _confirm() {
    if (_sent || _selected == null) return;
    final AgentResultData? data = widget.cardData;
    final void Function(AgentResultAction, {required AgentResultData cardData})? cb =
        widget.onUserAction;
    if (data == null || cb == null) return;
    setState(() => _sent = true);
    cb(
      AgentResultAction(
        id: "ride_pickup_confirm_${DateTime.now().millisecondsSinceEpoch}",
        label: "从这里上车",
        variant: "primary",
        payload: <String, dynamic>{
          "cardAction": "ride.pickup.select",
          "lat": _selected!.lat,
          "lng": _selected!.lng,
          "pickup": _selected!.label,
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

  LatLng get _mapCenter {
    final ({double lat, double lng})? gcj = _originGcj;
    if (gcj != null) return LatLng(gcj.lat, gcj.lng);
    // 无定位参考：全国视野起步，用户拖到目的地附近再放大
    return const LatLng(32.5, 108.0);
  }

  double get _initialZoom => _hasOrigin() ? 16 : 4.2;

  @override
  Widget build(BuildContext context) {
    final String dropoff = shopStr(widget.payload["dropoff"]);
    final _SelectedPickup? sel = _selected;

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
            title: "选个上车点",
            subtitle: dropoff.isEmpty ? null : "目的地：$dropoff",
          ),
          ShopDivider(cs: cs),
          Padding(
            padding: const EdgeInsets.fromLTRB(13, 10, 13, 0),
            child: ClipRRect(
              borderRadius: BorderRadius.circular(10),
              child: SizedBox(
                height: 190,
                child: Stack(
                  children: <Widget>[
                    // 3D 模式：高德 JS 页面自绘图钉/候选/定位点/回定位按钮；
                    // 页面失败（超时/无 key/非移动平台）→ onFailed 回退下面的 FlutterMap
                    if (_use3d)
                      Positioned.fill(
                        child: RideMap3dView(
                          controller: _map3d,
                          mode: "pickup",
                          origin: _originWgs,
                          candidates: _candidates3d,
                          onSelect: _on3dSelect,
                          onFailed: _fallbackTo2d,
                        ),
                      )
                    else
                      FlutterMap(
                      mapController: _mapController,
                      options: MapOptions(
                        initialCenter: _mapCenter,
                        initialZoom: _initialZoom,
                        interactionOptions: const InteractionOptions(
                          flags: InteractiveFlag.all,
                        ),
                        onTap: (_, LatLng tapped) {
                          _mapController.move(tapped, _mapController.camera.zoom);
                          Future<void>.delayed(
                              const Duration(milliseconds: 30), _syncFromCenter);
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
                            // flutter_map 只认 {s} 占位符 + subdomains 列表，
                            // 不支持 {1-4} 区间语法（写了就原样进 URL → 域名非法 → 灰图）
                            urlTemplate:
                                "https://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}",
                            subdomains: const <String>["1", "2", "3", "4"],
                            userAgentPackageName: "app.nextbot.client",
                          ),
                          MarkerLayer(markers: _mapMarkers()),
                        ],
                    ),
                    // 中心图钉：不随地图动，选的就是这里
                    if (!_use3d)
                      Center(
                      child: Column(
                        mainAxisSize: MainAxisSize.min,
                        children: <Widget>[
                          const Icon(
                            Icons.location_on,
                            size: 34,
                            color: Colors.black,
                          ),
                          Container(
                            margin: const EdgeInsets.only(top: 2),
                            padding:
                                const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                            decoration: BoxDecoration(
                              color: cs.surface,
                              borderRadius: BorderRadius.circular(99),
                              border: Border.all(
                                color: cs.outline.withValues(alpha: 0.4),
                              ),
                            ),
                            child: Text(
                              "拖我选上车点",
                              style: TextStyle(
                                fontSize: 10,
                                color: cs.onSurface,
                              ),
                            ),
                          ),
                        ],
                      ),
                    ),
                    // 回到「我的位置」：有实时定位才出现（3D 版由页面内按钮承担）
                    if (!_use3d && _hasOrigin())
                      Positioned(
                        top: 8,
                        right: 8,
                        child: GestureDetector(
                          onTap: _recenter,
                          child: Container(
                            padding: const EdgeInsets.all(6),
                            decoration: BoxDecoration(
                              color: cs.surface,
                              shape: BoxShape.circle,
                              boxShadow: <BoxShadow>[
                                BoxShadow(
                                  color: Colors.black.withValues(alpha: 0.12),
                                  blurRadius: 4,
                                ),
                              ],
                            ),
                            child: Icon(
                              Icons.my_location,
                              size: 16,
                              color: cs.onSurface,
                            ),
                          ),
                        ),
                      ),
                    if (!_use3d)
                      Positioned(
                      left: 6,
                      bottom: 4,
                      child: Text(
                        "© 高德地图",
                        style: TextStyle(
                          fontSize: 8,
                          color: Colors.black.withValues(alpha: 0.45),
                        ),
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(13, 6, 13, 0),
            child: Text(
              "拖动地图选点 · 图钉固定中心 · 双指缩放",
              style: TextStyle(fontSize: 9.5, color: cs.onSurfaceVariant),
            ),
          ),
          if (_candidates.isNotEmpty) ...<Widget>[
            Padding(
              padding: const EdgeInsets.fromLTRB(13, 10, 13, 0),
              child: Align(
                alignment: Alignment.centerLeft,
                child: Text(
                  "附近候选 · 停车场/落客点 · 按距离排",
                  style: TextStyle(fontSize: 10, color: cs.onSurfaceVariant),
                ),
              ),
            ),
            for (int i = 0; i < _candidates.length; i++) _candidateRow(i),
          ],
          if (sel != null)
            Container(
              margin: const EdgeInsets.fromLTRB(13, 10, 13, 0),
              padding: const EdgeInsets.fromLTRB(11, 9, 11, 9),
              decoration: BoxDecoration(
                borderRadius: BorderRadius.circular(10),
                border: Border.all(color: cs.onSurface, width: 1.2),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  Text(
                    sel.label,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      fontSize: 12.5,
                      fontWeight: FontWeight.w600,
                      color: cs.onSurface,
                    ),
                  ),
                  const SizedBox(height: 2),
                  Text(
                    sel.sub,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(fontSize: 10, color: cs.onSurfaceVariant),
                  ),
                ],
              ),
            ),
          Padding(
            padding: const EdgeInsets.fromLTRB(13, 12, 13, 13),
            child: ShopButton(
              cs: cs,
              height: 40,
              label: sel == null
                  ? "点候选或拖动地图选个上车点"
                  : _sent
                      ? "已选，正在报价…"
                      : "从这里上车 · ${sel.label}",
              onTap: sel == null || _sent ? null : _confirm,
            ),
          ),
        ],
      ),
    );
  }

  Widget _candidateRow(int index) {
    final Map<String, dynamic> c = _candidates[index];
    final _SelectedPickup? sel = _selected;
    final bool on = sel != null &&
        sel.snapped &&
        shopStr(sel.label) == shopStr(c["name"]);
    final num? dist = shopNum(c["distM"]);
    final String addr = shopStr(c["address"]);
    return Padding(
      padding: const EdgeInsets.fromLTRB(13, 7, 13, 0),
      child: ShopTap(
        // 3D 模式把聚焦交给页面（页面移动后回传 select 事件统一更新选中态）
        onTap: _sent
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
                size: 15,
                color: on ? cs.onSurface : cs.onSurfaceVariant,
              ),
              const SizedBox(width: 9),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    Text(
                      shopStr(c["name"]).isEmpty ? "候选上车点" : shopStr(c["name"]),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        fontSize: 12.5,
                        fontWeight: FontWeight.w600,
                        color: cs.onSurface,
                      ),
                    ),
                    if (addr.isNotEmpty)
                      Padding(
                        padding: const EdgeInsets.only(top: 2),
                        child: Text(
                          addr,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(fontSize: 10, color: cs.onSurfaceVariant),
                        ),
                      ),
                  ],
                ),
              ),
              if (dist != null)
                Text(
                  dist >= 1000 ? "约 ${(dist / 1000).toStringAsFixed(1)}km" : "约 ${dist.toInt()}m",
                  style: TextStyle(fontSize: 10, color: cs.onSurfaceVariant),
                ),
            ],
          ),
        ),
      ),
    );
  }
}
