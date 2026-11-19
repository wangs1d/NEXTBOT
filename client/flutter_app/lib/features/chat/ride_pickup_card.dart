import "dart:async";
import "dart:convert";
import "dart:math" as math;

import "package:flutter/material.dart";
import "package:http/http.dart" as http;

import "../../core/config/api_config.dart";
import "../../core/services/client_location_service.dart";
import "../../core/utils/agent_result_parser.dart";

/// 打车「选个上车点」地图卡（cardType = "ride_pickup"）。
///
/// 底图与地点数据全部来自滴滴 MCP：
///   - 底图：maps_static_map（MCP 无瓦片服务，静态图 + 客户端图钉实现拖选）；
///   - 中心/预选：GPS 或 maps_ip_location，再由 maps_regeocode 解析地址；
///   - 周边推荐：maps_place_around。
///
/// 交互：拖动/双指缩放地图，图钉固定屏幕中心；松手后按新中心重新请求
/// 静态底图并逆地理（`/geo/ride-pickup/*`，同源滴图 MCP，不经过模型）。
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
  /// 静态底图请求尺寸（滴图 maps_static_map 上限 800）。
  static const int _imgWidth = 720;
  static const int _imgHeight = 408;
  static const double _mapHeight = 196;
  static const double _defaultZoom = 16;

  Timer? _debounce;
  int _resolveSeq = 0;
  int _mapSeq = 0;

  double? _lat;
  double? _lng;
  double _zoom = _defaultZoom;

  String _mapUrl = "";
  bool _mapLoading = false;
  bool _mapFailed = false;

  String _pickupName = "";
  bool _resolving = false;
  bool _resolveFailed = false;
  bool _confirming = false;

  // 手势临时态：拖动位移（逻辑像素）与双指缩放倍率。
  double _dragDx = 0;
  double _dragDy = 0;
  double _pinchScale = 1;
  double _gestureBasePinch = 1;
  bool _gesturePinched = false;
  double _mapWidth = 340;

  ColorScheme get cs => widget.cs;

  String get _dropoff => _str(widget.payload["dropoff"]);
  String get _city => _str(widget.payload["city"]);

  @override
  void initState() {
    super.initState();
    final Map<String, dynamic>? center = _map(widget.payload["center"]);
    final Map<String, dynamic>? dest = _map(widget.payload["dest"]);
    final Map<String, dynamic>? pickup = _map(widget.payload["pickup"]);

    _lat = _num(center?["lat"]) ?? _num(dest?["lat"]) ?? _num(pickup?["lat"]);
    _lng = _num(center?["lng"]) ?? _num(dest?["lng"]) ?? _num(pickup?["lng"]);
    _pickupName = _str(pickup?["name"]);

    if (_lat != null && _lng != null) {
      unawaited(_fetchMap());
    } else {
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
    unawaited(_fetchMap());
    _scheduleResolve();
  }

  Future<void> _fetchMap() async {
    final double? lat = _lat;
    final double? lng = _lng;
    if (lat == null || lng == null) return;
    final int seq = ++_mapSeq;
    setState(() {
      _mapLoading = true;
      _mapFailed = false;
    });
    try {
      final Uri uri = Uri.parse("${ApiConfig.httpBase}/geo/ride-pickup/static-map").replace(
        queryParameters: <String, String>{
          "latitude": lat.toStringAsFixed(6),
          "longitude": lng.toStringAsFixed(6),
          "zoom": _zoom.toStringAsFixed(1),
          "width": "$_imgWidth",
          "height": "$_imgHeight",
        },
      );
      final http.Response resp = await http.get(uri).timeout(const Duration(seconds: 15));
      if (!mounted || seq != _mapSeq) return;
      final Map<String, dynamic>? body = _decodeMap(resp.body);
      final String url = resp.statusCode == 200 ? _str(body?["url"]) : "";
      setState(() {
        _mapLoading = false;
        _mapFailed = url.isEmpty;
        if (url.isNotEmpty) _mapUrl = url;
      });
    } catch (_) {
      if (!mounted || seq != _mapSeq) return;
      setState(() {
        _mapLoading = false;
        _mapFailed = true;
      });
    }
  }

  void _scheduleResolve() {
    _debounce?.cancel();
    _debounce = Timer(const Duration(milliseconds: 400), _resolveCenter);
  }

  Future<void> _resolveCenter() async {
    final double? lat = _lat;
    final double? lng = _lng;
    if (lat == null || lng == null) return;
    final int seq = ++_resolveSeq;
    if (mounted) setState(() => _resolving = true);
    try {
      final Uri uri = Uri.parse("${ApiConfig.httpBase}/geo/ride-pickup/resolve").replace(
        queryParameters: <String, String>{
          "latitude": lat.toStringAsFixed(6),
          "longitude": lng.toStringAsFixed(6),
        },
      );
      final http.Response resp = await http.get(uri).timeout(const Duration(seconds: 12));
      if (!mounted || seq != _resolveSeq) return;
      final Map<String, dynamic>? body = _decodeMap(resp.body);
      final Map<String, dynamic>? point = _map(body?["pickup"]);
      setState(() {
        _resolving = false;
        _resolveFailed = resp.statusCode != 200 || body?["ok"] != true;
        _pickupName = point == null ? "" : _str(point["name"]);
      });
    } catch (_) {
      if (!mounted || seq != _resolveSeq) return;
      setState(() {
        _resolving = false;
        _resolveFailed = true;
      });
    }
  }

  void _onScaleStart(ScaleStartDetails details) {
    _gestureBasePinch = _pinchScale;
    _gesturePinched = details.pointerCount > 1;
  }

  void _onScaleUpdate(ScaleUpdateDetails details) {
    setState(() {
      if (details.pointerCount > 1) {
        _gesturePinched = true;
        _pinchScale = (_gestureBasePinch * details.scale).clamp(0.6, 2.6).toDouble();
      } else {
        _dragDx += details.focalPointDelta.dx;
        _dragDy += details.focalPointDelta.dy;
      }
    });
  }

  void _onScaleEnd(ScaleEndDetails details) {
    _commitGesture();
  }

  /// 单击地图：把点击位置当作新的图钉位置（图钉本身固定，移动的是底图）。
  void _onTapUp(TapUpDetails details) {
    final Offset p = details.localPosition;
    // 点击点在中心以东 delta：底图要左移 delta，选中点（图钉）才落到该处。
    _dragDx = -p.dx + _mapWidth / 2;
    _dragDy = -p.dy + _mapHeight / 2;
    _pinchScale = 1;
    _gesturePinched = false;
    _commitGesture();
  }

  /// 松手：把屏幕位移换算成经纬度，缩放换算成 zoom，然后重取底图与地址。
  void _commitGesture() {
    final double? lat = _lat;
    final double? lng = _lng;
    if (lat == null || lng == null) return;

    final double oldZoom = _zoom;
    final double newZoom = _gesturePinched
        ? (oldZoom + math.log(_pinchScale) / math.ln2).clamp(4.0, 20.0).toDouble()
        : oldZoom;

    // 屏幕逻辑像素 → 底图像素（图片按 cover 铺满卡片宽度）。
    final double factor = _imgWidth / (_mapWidth <= 0 ? 340 : _mapWidth);
    final double dxImg = _dragDx * factor;
    final double dyImg = _dragDy * factor;

    final double world = _worldSize(oldZoom);
    final double x = ((lng + 180) / 360) * world - dxImg;
    final double y = _latToY(lat, oldZoom) - dyImg;

    final double nextLng = _xToLng(x, oldZoom);
    final double nextLat = _yToLat(y, oldZoom);

    setState(() {
      _lat = nextLat.clamp(-85.0, 85.0).toDouble();
      _lng = ((nextLng + 540) % 360) - 180;
      _zoom = newZoom;
      _dragDx = 0;
      _dragDy = 0;
      _pinchScale = 1;
      _gesturePinched = false;
    });
    unawaited(_fetchMap());
    _scheduleResolve();
  }

  void _confirm() {
    if (_confirming) return;
    final double? lat = _lat;
    final double? lng = _lng;
    final AgentResultData? data = widget.cardData;
    final void Function(AgentResultAction, {required AgentResultData cardData})? cb =
        widget.onUserAction;
    if (lat == null || lng == null || data == null || cb == null) return;
    setState(() => _confirming = true);
    cb(
      AgentResultAction(
        id: "ride_pickup_confirm",
        label: "从这里上车 · 自定义上车点",
        variant: "primary",
        payload: <String, dynamic>{
          "cardAction": "ride.pickup.quote",
          "dropoff": _dropoff,
          if (_city.isNotEmpty) "city": _city,
          "pickup": _pickupName.isEmpty ? "自定义上车点" : _pickupName,
          "latitude": lat,
          "longitude": lng,
        },
      ),
      cardData: data,
    );
  }

  @override
  Widget build(BuildContext context) {
    final Map<String, dynamic>? dest = _map(widget.payload["dest"]);
    final String destAddress = _str(dest?["address"]);

    // 设计稿：卡片内边距 13，圆角 12，底色比聊天背景亮一档。
    return Container(
      constraints: const BoxConstraints(maxWidth: 430),
      decoration: BoxDecoration(
        color: cs.surfaceContainerHigh,
        borderRadius: BorderRadius.circular(12),
      ),
      clipBehavior: Clip.antiAlias,
      child: Padding(
        padding: const EdgeInsets.all(13),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            _buildHeader(destAddress),
            const SizedBox(height: 12),
            _buildMap(),
            const SizedBox(height: 9),
            Text(
              _resolveFailed
                  ? "地址解析暂不可用 · 仍可拖动选点并按坐标上车"
                  : "拖动地图选点 · 图钉固定中心 · 双指缩放",
              style: TextStyle(fontSize: 11.5, height: 1.4, color: cs.onSurfaceVariant),
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
        : "目的地：$_dropoff${destAddress.isEmpty ? "" : " $destAddress"}";
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        Padding(
          padding: const EdgeInsets.only(top: 1),
          child: Icon(Icons.local_taxi_outlined, size: 19, color: cs.onSurface),
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
                  fontSize: 17,
                  height: 1.2,
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
                    style: TextStyle(
                      fontSize: 12.5,
                      height: 1.3,
                      color: cs.onSurfaceVariant,
                    ),
                  ),
                ),
            ],
          ),
        ),
      ],
    );
  }

  Widget _buildMap() {
    return LayoutBuilder(
      builder: (BuildContext context, BoxConstraints constraints) {
        _mapWidth = constraints.maxWidth;
        return SizedBox(
          height: _mapHeight,
          child: ClipRRect(
            borderRadius: BorderRadius.circular(12),
            child: Stack(
              fit: StackFit.expand,
              children: <Widget>[
                ColoredBox(color: cs.surfaceContainerHighest),
                if (_mapUrl.isNotEmpty)
                  GestureDetector(
                    onScaleStart: _onScaleStart,
                    onScaleUpdate: _onScaleUpdate,
                    onScaleEnd: _onScaleEnd,
                    onTapUp: _onTapUp,
                    child: Transform.translate(
                      offset: Offset(_dragDx, _dragDy),
                      child: Transform.scale(
                        scale: _pinchScale,
                        child: Image.network(
                          _mapUrl,
                          fit: BoxFit.cover,
                          gaplessPlayback: true,
                          loadingBuilder: (
                            BuildContext context,
                            Widget child,
                            ImageChunkEvent? progress,
                          ) {
                            if (progress == null) return child;
                            return const Center(
                              child: SizedBox(
                                width: 18,
                                height: 18,
                                child: CircularProgressIndicator(strokeWidth: 1.8),
                              ),
                            );
                          },
                          errorBuilder: (
                            BuildContext context,
                            Object error,
                            StackTrace? stackTrace,
                          ) =>
                              _mapUnavailable("滴滴地图加载失败，拖动后重试"),
                        ),
                      ),
                    ),
                  )
                else if (_mapLoading)
                  const Center(
                    child: SizedBox(
                      width: 18,
                      height: 18,
                      child: CircularProgressIndicator(strokeWidth: 1.8),
                    ),
                  )
                else
                  _mapUnavailable(
                    _lat == null
                        ? "正在获取定位…"
                        : _mapFailed
                            ? "滴滴地图暂不可用，可直接按中心点上车"
                            : "正在加载滴滴地图…",
                  ),
                // 图钉固定屏幕中心，底图在下面移动；地址按新中心重新解析。
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
      },
    );
  }

  Widget _mapUnavailable(String text) {
    return Center(
      child: Text(
        text,
        textAlign: TextAlign.center,
        style: TextStyle(fontSize: 12, color: cs.onSurfaceVariant),
      ),
    );
  }

  Widget _buildCustomBox() {
    final double? lat = _lat;
    final double? lng = _lng;
    final String coords = lat == null || lng == null
        ? "正在获取坐标…"
        : "${lng.toStringAsFixed(4)}, ${lat.toStringAsFixed(4)}";
    return Container(
      padding: const EdgeInsets.fromLTRB(12, 10, 12, 10),
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: cs.onSurface.withValues(alpha: 0.65), width: 1.2),
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
                    height: 1.3,
                    fontWeight: FontWeight.w600,
                    color: cs.onSurface,
                  ),
                ),
                const SizedBox(height: 4),
                Text(
                  "拖到这里就选这里 · $coords",
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    fontSize: 12,
                    height: 1.35,
                    color: cs.onSurfaceVariant,
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
    final bool ready = _lat != null && _lng != null;
    return SizedBox(
      height: 48,
      child: FilledButton(
        onPressed: _confirming || !ready ? null : _confirm,
        style: FilledButton.styleFrom(
          backgroundColor: cs.onSurface,
          foregroundColor: cs.surface,
          disabledBackgroundColor: cs.onSurface.withValues(alpha: 0.55),
          disabledForegroundColor: cs.surface,
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
          padding: const EdgeInsets.symmetric(horizontal: 16),
          textStyle: const TextStyle(fontSize: 16, fontWeight: FontWeight.w600),
        ),
        child: Text(
          _confirming ? "正在报价…" : "从这里上车 · 自定义上车点",
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
        ),
      ),
    );
  }

  static double _worldSize(double zoom) => 256 * math.pow(2, zoom).toDouble();

  static double _latToY(double lat, double zoom) {
    final double s = math.sin(lat * math.pi / 180);
    return (0.5 - math.log((1 + s) / (1 - s)) / (4 * math.pi)) * _worldSize(zoom);
  }

  static double _xToLng(double x, double zoom) => x / _worldSize(zoom) * 360 - 180;

  static double _yToLat(double y, double zoom) {
    final double n = math.pi - 2 * math.pi * y / _worldSize(zoom);
    return 180 / math.pi * math.atan(0.5 * (math.exp(n) - math.exp(-n)));
  }

  static Map<String, dynamic>? _decodeMap(String body) {
    try {
      final Object? decoded = const JsonCodec().decode(body);
      return _map(decoded);
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
