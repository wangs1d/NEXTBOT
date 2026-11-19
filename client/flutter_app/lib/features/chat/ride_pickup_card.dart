import "dart:async";
import "dart:convert";

import "package:flutter/material.dart";
import "package:flutter_map/flutter_map.dart";
import "package:http/http.dart" as http;
import "package:latlong2/latlong.dart" as ll;

import "../../core/config/api_config.dart";
import "../../core/services/client_location_service.dart";
import "../../core/utils/agent_result_parser.dart";

/// 打车「选个上车点」地图卡（cardType = "ride_pickup"）。
///
/// 数据来源（服务端 extra.ride，均由滴图 MCP 解析）：
///   - dest / center / pickup：目的地、初始中心、预选上车点；
///   - candidates：周边公交站/地铁站推荐点（点一下即可选中）。
///
/// 交互：地图拖动/双指缩放，图钉固定屏幕中心；停手 500ms 后向
/// `/geo/ride-pickup/resolve` 逆地理当前中心点（同源滴图 MCP），不经过模型。
/// 确认后走卡内动作 ride.pickup.quote，把这张卡换成车型报价卡。
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

class _RidePickupCardState extends State<RidePickupCard> {
  static const double _defaultZoom = 16.4;

  final MapController _mapController = MapController();
  Timer? _debounce;
  int _resolveSeq = 0;

  double _lat = 39.9042;
  double _lng = 116.4074;
  double _zoom = _defaultZoom;

  String _pickupName = "";
  String _pickupAddress = "";
  List<_PickupCandidate> _candidates = const <_PickupCandidate>[];
  bool _resolving = false;
  bool _resolveFailed = false;
  bool _confirming = false;

  ColorScheme get cs => widget.cs;

  String get _dropoff => _str(widget.payload["dropoff"]);
  String get _city => _str(widget.payload["city"]);

  @override
  void initState() {
    super.initState();
    final Map<String, dynamic>? center = _map(widget.payload["center"]);
    final Map<String, dynamic>? dest = _map(widget.payload["dest"]);
    final Map<String, dynamic>? pickup = _map(widget.payload["pickup"]);

    final double? seedLat = _num(center?["lat"]) ?? _num(dest?["lat"]) ?? _num(pickup?["lat"]);
    final double? seedLng = _num(center?["lng"]) ?? _num(dest?["lng"]) ?? _num(pickup?["lng"]);
    if (seedLat != null && seedLng != null) {
      _lat = seedLat;
      _lng = seedLng;
    }
    _zoom = seedLat != null && seedLng != null ? _defaultZoom : 11.5;
    _pickupName = _str(pickup?["name"]);
    _pickupAddress = _str(pickup?["address"]);
    _candidates = _parseCandidates(widget.payload["candidates"]);

    if (seedLat == null || seedLng == null) {
      unawaited(_seedWithClientLocation());
    }
  }

  @override
  void dispose() {
    _debounce?.cancel();
    super.dispose();
  }

  Future<void> _seedWithClientLocation() async {
    final ClientLocationPayload? loc = await ClientLocationService.getCurrentLocation();
    if (!mounted || loc == null) return;
    setState(() {
      _lat = loc.latitude;
      _lng = loc.longitude;
      _zoom = _defaultZoom;
    });
    _moveMap(_lat, _lng, _defaultZoom);
    _scheduleResolve();
  }

  void _moveMap(double lat, double lng, double zoom) {
    try {
      _mapController.move(ll.LatLng(lat, lng), zoom);
    } catch (_) {
      // 地图尚未挂载时忽略；首帧会用 initialCenter 兜底。
    }
  }

  void _onPositionChanged(MapCamera camera, bool hasGesture) {
    final ll.LatLng c = camera.center;
    final bool changed = (c.latitude - _lat).abs() > 1e-7 || (c.longitude - _lng).abs() > 1e-7;
    if (!changed && camera.zoom == _zoom) return;
    setState(() {
      _lat = c.latitude;
      _lng = c.longitude;
      _zoom = camera.zoom;
    });
    if (hasGesture) _scheduleResolve();
  }

  void _scheduleResolve() {
    _debounce?.cancel();
    _debounce = Timer(const Duration(milliseconds: 500), _resolveCenter);
  }

  Future<void> _resolveCenter() async {
    final int seq = ++_resolveSeq;
    if (mounted) setState(() => _resolving = true);
    try {
      final Uri uri = Uri.parse("${ApiConfig.httpBase}/geo/ride-pickup/resolve").replace(
        queryParameters: <String, String>{
          "latitude": _lat.toStringAsFixed(6),
          "longitude": _lng.toStringAsFixed(6),
          "withCandidates": "1",
        },
      );
      final http.Response resp = await http.get(uri).timeout(const Duration(seconds: 12));
      if (!mounted || seq != _resolveSeq) return;
      if (resp.statusCode != 200) {
        setState(() {
          _resolving = false;
          _resolveFailed = true;
        });
        return;
      }
      final Object? decoded = _decode(resp.body);
      final Map<String, dynamic>? body = decoded is Map ? _map(decoded) : null;
      if (body == null) {
        setState(() {
          _resolving = false;
          _resolveFailed = true;
        });
        return;
      }
      final Map<String, dynamic>? point = _map(body["pickup"]);
      final List<_PickupCandidate> candidates = _parseCandidates(body["candidates"]);
      setState(() {
        _resolving = false;
        _resolveFailed = body["ok"] != true;
        if (point != null) {
          _pickupName = _str(point["name"]);
          _pickupAddress = _str(point["address"]);
        } else {
          _pickupName = "";
          _pickupAddress = "";
        }
        if (candidates.isNotEmpty) _candidates = candidates;
      });
    } catch (_) {
      if (!mounted || seq != _resolveSeq) return;
      setState(() {
        _resolving = false;
        _resolveFailed = true;
      });
    }
  }

  void _pickCandidate(_PickupCandidate candidate) {
    _debounce?.cancel();
    setState(() {
      _lat = candidate.lat;
      _lng = candidate.lng;
      _pickupName = candidate.name;
      _pickupAddress = candidate.address;
    });
    _moveMap(candidate.lat, candidate.lng, _defaultZoom);
  }

  void _confirm() {
    if (_confirming) return;
    final AgentResultData? data = widget.cardData;
    final void Function(AgentResultAction, {required AgentResultData cardData})? cb =
        widget.onUserAction;
    if (data == null || cb == null) return;
    setState(() => _confirming = true);
    cb(
      AgentResultAction(
        id: "ride_pickup_confirm",
        label: _confirmLabel,
        variant: "primary",
        payload: <String, dynamic>{
          "cardAction": "ride.pickup.quote",
          "dropoff": _dropoff,
          if (_city.isNotEmpty) "city": _city,
          "pickup": _buttonPickupName,
          "latitude": _lat,
          "longitude": _lng,
        },
      ),
      cardData: data,
    );
  }

  String get _buttonPickupName {
    if (_pickupName.isEmpty) return "自定义上车点";
    return _pickupName.length > 12 ? "自定义上车点" : _pickupName;
  }

  String get _confirmLabel => "从这里上车 · $_buttonPickupName";

  @override
  Widget build(BuildContext context) {
    final Map<String, dynamic>? dest = _map(widget.payload["dest"]);
    final String destAddress = _str(dest?["address"]);

    return Container(
      constraints: const BoxConstraints(maxWidth: 430),
      decoration: BoxDecoration(
        color: cs.surfaceContainerHigh,
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: cs.outline.withValues(alpha: 0.24)),
      ),
      clipBehavior: Clip.antiAlias,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(12, 12, 12, 12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            _buildHeader(destAddress),
            const SizedBox(height: 10),
            _buildMap(),
            const SizedBox(height: 8),
            Text(
              _resolveFailed
                  ? "地址解析暂不可用 · 仍可拖动选点并按坐标上车"
                  : "拖动地图选点 · 图钉固定中心 · 双指缩放",
              style: TextStyle(fontSize: 11.5, color: cs.onSurfaceVariant),
            ),
            const SizedBox(height: 10),
            _buildCustomBox(),
            const SizedBox(height: 12),
            _buildConfirmButton(),
          ],
        ),
      ),
    );
  }

  Widget _buildHeader(String destAddress) {
    final String subtitle = _dropoff.isEmpty
        ? ""
        : "目的地：$_dropoff${destAddress.isEmpty ? "" : "  $destAddress"}";
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        Padding(
          padding: const EdgeInsets.only(top: 2),
          child: Icon(Icons.local_taxi_outlined, size: 18, color: cs.onSurface),
        ),
        const SizedBox(width: 8),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: <Widget>[
              Text(
                "选个上车点",
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(
                  fontSize: 16,
                  fontWeight: FontWeight.w600,
                  color: cs.onSurface,
                ),
              ),
              if (subtitle.isNotEmpty)
                Padding(
                  padding: const EdgeInsets.only(top: 3),
                  child: Text(
                    subtitle,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(fontSize: 12.5, color: cs.onSurfaceVariant),
                  ),
                ),
            ],
          ),
        ),
      ],
    );
  }

  Widget _buildMap() {
    return SizedBox(
      height: 224,
      child: ClipRRect(
        borderRadius: BorderRadius.circular(12),
        child: Stack(
          children: <Widget>[
            FlutterMap(
              mapController: _mapController,
              options: MapOptions(
                initialCenter: ll.LatLng(_lat, _lng),
                initialZoom: _zoom,
                minZoom: 3,
                maxZoom: 19,
                interactionOptions: const InteractionOptions(
                  flags: InteractiveFlag.drag |
                      InteractiveFlag.pinchZoom |
                      InteractiveFlag.doubleTapZoom,
                ),
                onPositionChanged: _onPositionChanged,
              ),
              children: <Widget>[
                TileLayer(
                  urlTemplate: _tileTemplate(),
                  userAgentPackageName: "com.nextbot.app",
                  tileProvider: NetworkTileProvider(),
                  keepBuffer: 3,
                  panBuffer: 1,
                ),
                MarkerLayer(
                  markers: <Marker>[
                    for (final _PickupCandidate c in _candidates)
                      Marker(
                        point: ll.LatLng(c.lat, c.lng),
                        width: 26,
                        height: 26,
                        child: GestureDetector(
                          onTap: () => _pickCandidate(c),
                          child: Container(
                            decoration: BoxDecoration(
                              color: cs.surface,
                              shape: BoxShape.circle,
                              border: Border.all(
                                color: cs.onSurface.withValues(alpha: 0.65),
                                width: 1.6,
                              ),
                              boxShadow: const <BoxShadow>[
                                BoxShadow(color: Color(0x33000000), blurRadius: 4),
                              ],
                            ),
                            child: Icon(
                              Icons.directions_bus_outlined,
                              size: 14,
                              color: cs.onSurface,
                            ),
                          ),
                        ),
                      ),
                  ],
                ),
              ],
            ),
            // 固定中心图钉 + 拖动提示：图钉钉在屏幕中心，地址随地图移动解析。
            IgnorePointer(
              child: Center(
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: <Widget>[
                    SizedBox(
                      width: 40,
                      height: 46,
                      child: Stack(
                        alignment: Alignment.topCenter,
                        children: <Widget>[
                          Icon(
                            Icons.location_on,
                            size: 46,
                            color: cs.onSurface,
                            shadows: const <Shadow>[
                              Shadow(color: Color(0x55000000), blurRadius: 6),
                            ],
                          ),
                          Padding(
                            padding: const EdgeInsets.only(top: 12),
                            child: Container(
                              width: 9,
                              height: 9,
                              decoration: BoxDecoration(
                                color: cs.surface,
                                shape: BoxShape.circle,
                              ),
                            ),
                          ),
                        ],
                      ),
                    ),
                    Container(
                      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 5),
                      decoration: BoxDecoration(
                        color: const Color(0xCC111111),
                        borderRadius: BorderRadius.circular(999),
                      ),
                      child: const Text(
                        "拖我选上车点",
                        style: TextStyle(
                          fontSize: 12,
                          fontWeight: FontWeight.w500,
                          color: Colors.white,
                        ),
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildCustomBox() {
    final String addressLine = _pickupAddress.isEmpty
        ? ""
        : (_pickupAddress == _pickupName ? "" : _pickupAddress);
    return Container(
      padding: const EdgeInsets.fromLTRB(12, 10, 12, 10),
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: cs.onSurface.withValues(alpha: 0.55)),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: <Widget>[
                Text(
                  "自定义上车点",
                  style: TextStyle(
                    fontSize: 14.5,
                    fontWeight: FontWeight.w600,
                    color: cs.onSurface,
                  ),
                ),
                const SizedBox(height: 3),
                Text(
                  "拖到这里就选这里 · ${_lng.toStringAsFixed(4)}, ${_lat.toStringAsFixed(4)}",
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(fontSize: 12, color: cs.onSurfaceVariant),
                ),
                if (addressLine.isNotEmpty)
                  Padding(
                    padding: const EdgeInsets.only(top: 2),
                    child: Text(
                      addressLine,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(fontSize: 11.5, color: cs.onSurfaceVariant),
                    ),
                  ),
              ],
            ),
          ),
          if (_resolving)
            Padding(
              padding: const EdgeInsets.only(left: 8, top: 2),
              child: SizedBox(
                width: 14,
                height: 14,
                child: CircularProgressIndicator(
                  strokeWidth: 1.8,
                  color: cs.onSurfaceVariant,
                ),
              ),
            ),
        ],
      ),
    );
  }

  Widget _buildConfirmButton() {
    return SizedBox(
      height: 48,
      child: FilledButton(
        onPressed: _confirming ? null : _confirm,
        style: FilledButton.styleFrom(
          backgroundColor: cs.onSurface,
          foregroundColor: cs.surface,
          disabledBackgroundColor: cs.onSurface.withValues(alpha: 0.55),
          disabledForegroundColor: cs.surface,
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
          padding: const EdgeInsets.symmetric(horizontal: 16),
          textStyle: const TextStyle(fontSize: 15.5, fontWeight: FontWeight.w600),
        ),
        child: Text(
          _confirming ? "正在报价…" : _confirmLabel,
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
        ),
      ),
    );
  }

  static String _tileTemplate() {
    final String esri = Uri.encodeComponent(
      "https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}",
    );
    return "${ApiConfig.httpBase}/travel-basemap/fetch?u=$esri&z={z}&x={x}&y={y}";
  }

  static List<_PickupCandidate> _parseCandidates(Object? raw) {
    if (raw is! List) return const <_PickupCandidate>[];
    final List<_PickupCandidate> out = <_PickupCandidate>[];
    for (final Object? item in raw) {
      final Map<String, dynamic>? map = _map(item);
      if (map == null) continue;
      final double? lat = _num(map["lat"]);
      final double? lng = _num(map["lng"]);
      if (lat == null || lng == null) continue;
      out.add(_PickupCandidate(
        name: _str(map["name"]),
        address: _str(map["address"]),
        lat: lat,
        lng: lng,
      ));
    }
    return out;
  }

  static Object? _decode(String body) {
    try {
      return const JsonCodec().decode(body);
    } catch (_) {
      return null;
    }
  }

  static String _str(Object? value) => value?.toString().trim() ?? "";

  static double? _num(Object? value) {
    if (value is num) return value.toDouble();
    if (value is String) return double.tryParse(value);
    return null;
  }

  static Map<String, dynamic>? _map(Object? raw) {
    if (raw is Map) {
      return <String, dynamic>{
        for (final MapEntry<Object?, Object?> e in raw.entries)
          e.key.toString(): e.value,
      };
    }
    return null;
  }
}

class _PickupCandidate {
  const _PickupCandidate({
    required this.name,
    required this.address,
    required this.lat,
    required this.lng,
  });

  final String name;
  final String address;
  final double lat;
  final double lng;
}
