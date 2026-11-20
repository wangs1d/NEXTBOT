import "package:flutter/material.dart";
import "package:flutter_map/flutter_map.dart";
import "package:latlong2/latlong.dart" show LatLng;

import "../../core/utils/agent_result_parser.dart";
import "../../core/utils/link_utils.dart";
import "shopping/shopping_shared.dart";

/// 叫车报价卡（cardType = "ride_quote"）。
///
/// 服务端把车型（含每档价格）与「选择这个车型」的卡内动作一起下发
/// （extra.ride.options[].action）。本卡只负责展示与回传：
/// 点选后经 card.action（ride.book.prepare）把这张卡换成统一确认卡，
/// 不发消息、不进模型上下文——和购物卡的下单链路同构。
///
/// 2026-11-20 加值（滴图 maps_direction_driving / taxi_generate_ride_app_link）：
/// - extra.ride.route.points 有轨迹 → 卡内小地图画驾车路线 + 里程/耗时摘要；
/// - extra.ride.rideAppLink 有深链 → 「在滴滴 App 打开」备用入口（外部打开）。
class RideQuoteCard extends StatefulWidget {
  const RideQuoteCard({
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
  State<RideQuoteCard> createState() => _RideQuoteCardState();
}

class _RideQuoteCardState extends State<RideQuoteCard> {
  /// 已点选、正等服务端出确认卡：锁住整卡避免重复点单。
  String _pickedOptionId = "";

  ColorScheme get cs => widget.cs;

  void _emit(Map<String, dynamic> option) {
    if (_pickedOptionId.isNotEmpty) return;
    final AgentResultData? data = widget.cardData;
    final void Function(AgentResultAction, {required AgentResultData cardData})? cb =
        widget.onUserAction;
    if (data == null || cb == null) return;
    final Map<String, dynamic> action = _asMap(option["action"]);
    final String cardAction = shopStr(action["cardAction"]);
    if (cardAction.isEmpty) return;
    final String optionId = shopStr(option["optionId"]);
    setState(() => _pickedOptionId = optionId);
    cb(
      AgentResultAction(
        id: shopStr(action["id"]).isEmpty
            ? "ride_pick_${DateTime.now().millisecondsSinceEpoch}"
            : shopStr(action["id"]),
        label: shopStr(action["label"]).isEmpty
            ? "就选${shopStr(option["name"])}"
            : shopStr(action["label"]),
        variant: "primary",
        // 卡内动作凭据与起终点上下文由服务端预埋，客户端原样回传。
        payload: <String, dynamic>{
          ..._asMap(action["payload"]),
          "cardAction": cardAction,
        },
      ),
      cardData: data,
    );
  }

  Map<String, dynamic> _asMap(Object? raw) {
    if (raw is Map) {
      return <String, dynamic>{
        for (final MapEntry<Object?, Object?> e in raw.entries)
          e.key.toString(): e.value,
      };
    }
    return const <String, dynamic>{};
  }

  /// extra.ride.route.points（[[lat,lng],…]）→ LatLng 列表。
  List<LatLng> _routePoints(Object? raw) {
    final List<dynamic> list = raw is List ? raw : const <dynamic>[];
    final List<LatLng> out = <LatLng>[];
    for (final dynamic item in list) {
      if (item is List && item.length >= 2) {
        final num? lat = shopNum(item[0]);
        final num? lng = shopNum(item[1]);
        if (lat != null && lng != null) {
          out.add(LatLng(lat.toDouble(), lng.toDouble()));
        }
      }
    }
    return out;
  }

  @override
  Widget build(BuildContext context) {
    final Map<String, dynamic> p = widget.payload;
    final List<Map<String, dynamic>> options = shopMaps(p["options"]);
    if (options.isEmpty) {
      return ShopCardShell(
        cs: cs,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(13, 12, 13, 12),
          child: Text(
            "这次没拿到可用车型，换个说法再报一次",
            style: TextStyle(fontSize: 12, color: cs.onSurfaceVariant),
          ),
        ),
      );
    }
    final String pickup = shopStr(p["pickup"]);
    final String dropoff = shopStr(p["dropoff"]);
    final String providerLabel = shopStr(p["providerLabel"]);
    final String note = shopStr(p["note"]);
    final Map<String, dynamic> route = _asMap(p["route"]);
    final List<LatLng> routePoints = _routePoints(route["points"]);
    final String rideAppLink = shopStr(p["rideAppLink"]);

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
            title: "可选车型",
            subtitle: pickup.isNotEmpty || dropoff.isNotEmpty
                ? "${pickup.isEmpty ? "当前位置" : pickup} → ${dropoff.isEmpty ? "目的地" : dropoff}"
                : null,
            trailing: providerLabel.isEmpty
                ? null
                : Text(
                    providerLabel,
                    style: TextStyle(
                      fontSize: 9.5,
                      color: cs.onSurfaceVariant,
                    ),
                  ),
          ),
          ShopDivider(cs: cs),
          if (routePoints.length >= 2) ...<Widget>[
            Padding(
              padding: const EdgeInsets.fromLTRB(13, 10, 13, 0),
              child: ClipRRect(
                borderRadius: BorderRadius.circular(10),
                child: SizedBox(
                  height: 130,
                  child: FlutterMap(
                    options: MapOptions(
                      initialCameraFit: CameraFit.coordinates(
                        coordinates: routePoints,
                        padding: const EdgeInsets.all(28),
                      ),
                      interactionOptions: const InteractionOptions(
                        flags: InteractiveFlag.all,
                      ),
                    ),
                    children: <Widget>[
                      TileLayer(
                        // flutter_map 只认 {s} 占位符 + subdomains 列表（同选点卡）
                        urlTemplate:
                            "https://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}",
                        subdomains: const <String>["1", "2", "3", "4"],
                        userAgentPackageName: "app.nextbot.client",
                      ),
                      PolylineLayer(
                        polylines: <Polyline>[
                          Polyline(
                            points: routePoints,
                            strokeWidth: 3.5,
                            color: cs.onSurface,
                          ),
                        ],
                      ),
                      MarkerLayer(
                        markers: <Marker>[
                          Marker(
                            point: routePoints.first,
                            width: 10,
                            height: 10,
                            child: Container(
                              decoration: BoxDecoration(
                                shape: BoxShape.circle,
                                color: cs.surface,
                                border: Border.all(color: cs.onSurface, width: 1.5),
                              ),
                            ),
                          ),
                          Marker(
                            point: routePoints.last,
                            width: 10,
                            height: 10,
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
              ),
            ),
          ],
          if (shopStr(route["distanceText"]).isNotEmpty ||
              shopStr(route["durationText"]).isNotEmpty)
            Padding(
              padding: const EdgeInsets.fromLTRB(13, 8, 13, 0),
              child: Row(
                children: <Widget>[
                  Icon(Icons.route_outlined, size: 13, color: cs.onSurfaceVariant),
                  const SizedBox(width: 5),
                  Text(
                    [
                      shopStr(route["distanceText"]).isNotEmpty
                          ? "驾车 ${shopStr(route["distanceText"])}"
                          : "",
                      shopStr(route["durationText"]).isNotEmpty
                          ? shopStr(route["durationText"])
                          : "",
                    ].where((s) => s.isNotEmpty).join(" · "),
                    style: TextStyle(fontSize: 11, color: cs.onSurface),
                  ),
                ],
              ),
            ),
          for (final Map<String, dynamic> option in options)
            _optionRow(option, cs),
          if (rideAppLink.isNotEmpty)
            Padding(
              padding: const EdgeInsets.fromLTRB(13, 9, 13, 0),
              child: ShopTap(
                onTap: () => LinkUtils.launchExternal(rideAppLink),
                child: Container(
                  padding: const EdgeInsets.fromLTRB(11, 9, 11, 9),
                  decoration: BoxDecoration(
                    borderRadius: BorderRadius.circular(10),
                    border: Border.all(color: cs.outline.withValues(alpha: 0.2)),
                  ),
                  child: Row(
                    children: <Widget>[
                      Icon(Icons.open_in_new, size: 14, color: cs.onSurfaceVariant),
                      const SizedBox(width: 7),
                      Expanded(
                        child: Text(
                          "在滴滴 App 打开此行程",
                          style: TextStyle(fontSize: 11.5, color: cs.onSurface),
                        ),
                      ),
                    ],
                  ),
                ),
              ),
            ),
          if (note.isNotEmpty)
            Padding(
              padding: const EdgeInsets.fromLTRB(13, 8, 13, 0),
              child: Text(
                note,
                style: TextStyle(
                  fontSize: 9.5,
                  height: 1.5,
                  color: cs.onSurfaceVariant,
                ),
              ),
            ),
          Padding(
            padding: const EdgeInsets.fromLTRB(13, 8, 13, 13),
            child: Text(
              "价格为预估，实际以平台结算为准",
              style: TextStyle(
                fontSize: 9.5,
                height: 1.5,
                color: cs.onSurfaceVariant,
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _optionRow(Map<String, dynamic> option, ColorScheme cs) {
    final String optionId = shopStr(option["optionId"]);
    final String name = shopStr(option["name"]);
    final String price = shopStr(option["price"]);
    final String desc = shopStr(option["description"]);
    final bool simulated = shopBool(option["simulated"]);
    final bool picked = _pickedOptionId == optionId && optionId.isNotEmpty;
    final num? eta = shopNum(option["etaMinutes"]);

    return Container(
      margin: const EdgeInsets.fromLTRB(13, 9, 13, 0),
      padding: const EdgeInsets.fromLTRB(11, 10, 11, 10),
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: cs.outline.withValues(alpha: 0.2)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              // 车型侧影（滴滴式线稿，按品类区分车型体态；黑白语言与卡面一致）
              Padding(
                padding: const EdgeInsets.only(top: 1, right: 9),
                child: RideCarGlyph(
                  style: carStyleForName(name),
                  color: picked ? cs.onSurface : cs.onSurfaceVariant,
                  width: 62,
                ),
              ),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
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
                          const SizedBox(width: 6),
                          ShopBadge(
                            cs: cs,
                            label: "模拟报价",
                            tone: ShopBadgeTone.warn,
                          ),
                        ],
                      ],
                    ),
                    if (desc.isNotEmpty)
                      Padding(
                        padding: const EdgeInsets.only(top: 3),
                        child: Text(
                          desc,
                          maxLines: 2,
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(
                            fontSize: 10.5,
                            height: 1.45,
                            color: cs.onSurfaceVariant,
                          ),
                        ),
                      ),
                    if (eta != null)
                      Padding(
                        padding: const EdgeInsets.only(top: 2),
                        child: Text(
                          "约 ${eta.toInt()} 分钟接驾",
                          style: TextStyle(
                            fontSize: 10,
                            color: cs.onSurfaceVariant,
                          ),
                        ),
                      ),
                  ],
                ),
              ),
              const SizedBox(width: 10),
              Text(
                price.isEmpty ? "—" : price,
                style: TextStyle(
                  fontSize: 17,
                  fontWeight: FontWeight.w700,
                  letterSpacing: -0.4,
                  color: cs.onSurface,
                ),
              ),
            ],
          ),
          const SizedBox(height: 9),
          ShopButton(
            cs: cs,
            label: picked ? "已选，正在准备确认…" : "就选这个",
            onTap: _pickedOptionId.isNotEmpty ? null : () => _emit(option),
            height: 36,
          ),
        ],
      ),
    );
  }
}

/// 车型品类 → 侧影体态。
RideCarStyle carStyleForName(String name) {
  if (name.contains("商务") || name.contains("专车") || name.contains("六座")) {
    return RideCarStyle.mpv;
  }
  if (name.contains("出租")) return RideCarStyle.taxi;
  if (name.contains("特惠") || name.contains("特价") || name.contains("经济")) {
    return RideCarStyle.hatch;
  }
  return RideCarStyle.sedan;
}

enum RideCarStyle { hatch, sedan, mpv, taxi }

/// 车型侧影（滴滴式线稿，黑白语言与卡面一致；按品类区分体态）。
class RideCarGlyph extends StatelessWidget {
  const RideCarGlyph({
    super.key,
    required this.style,
    required this.color,
    this.width = 62,
  });

  final RideCarStyle style;
  final Color color;
  final double width;

  @override
  Widget build(BuildContext context) {
    final double height = width * 30 / 64;
    return SizedBox(
      width: width,
      height: height,
      child: CustomPaint(
        size: Size(width, height),
        painter: _RideCarPainter(style, color),
      ),
    );
  }
}

class _RideCarPainter extends CustomPainter {
  _RideCarPainter(this.style, this.color);

  final RideCarStyle style;
  final Color color;

  @override
  void paint(Canvas canvas, Size size) {
    final double s = size.width / 64;
    canvas.scale(s);
    final Paint stroke = Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = 1.6
      ..color = color
      ..strokeCap = StrokeCap.round
      ..strokeJoin = StrokeJoin.round;

    Path body;
    Offset w1;
    Offset w2;
    double r;
    Offset doorA;
    Offset doorB;
    Rect? roofSign;

    switch (style) {
      case RideCarStyle.hatch:
        body = Path()
          ..moveTo(4, 21)
          ..cubicTo(4, 17.2, 6, 15.6, 10, 14.8)
          ..lineTo(19, 14)
          ..cubicTo(23, 9.5, 28, 8, 34, 8)
          ..cubicTo(41, 8, 47, 9.5, 51, 12.5)
          ..lineTo(57, 13.8)
          ..cubicTo(59.2, 14.4, 59.8, 16, 59.8, 17.8)
          ..lineTo(59.8, 21)
          ..close();
        w1 = const Offset(15, 21);
        w2 = const Offset(46, 21);
        r = 4.4;
        doorA = const Offset(30, 12.5);
        doorB = const Offset(30, 20.4);
      case RideCarStyle.mpv:
        body = Path()
          ..moveTo(3, 21.5)
          ..cubicTo(3, 18.2, 4, 16, 8, 15)
          ..lineTo(12, 14.6)
          ..cubicTo(15, 8.5, 19, 6.5, 27, 6.5)
          ..lineTo(45, 6.5)
          ..cubicTo(52, 6.5, 56, 8, 58.5, 11)
          ..lineTo(60.5, 15)
          ..cubicTo(61.2, 16.5, 61.2, 19, 60.5, 21.5)
          ..close();
        w1 = const Offset(14, 21.5);
        w2 = const Offset(49, 21.5);
        r = 4.8;
        doorA = const Offset(33, 11);
        doorB = const Offset(33, 20.8);
      case RideCarStyle.taxi:
        body = Path()
          ..moveTo(3, 21)
          ..cubicTo(3, 17.5, 5, 16, 9, 15.2)
          ..lineTo(17, 14.4)
          ..cubicTo(21, 9.5, 26, 8, 32, 8)
          ..cubicTo(39, 8, 44, 9.8, 48, 12)
          ..cubicTo(55, 13.2, 61, 14.6, 61, 17.5)
          ..cubicTo(61, 20, 60, 21, 58, 21)
          ..close();
        w1 = const Offset(15, 21);
        w2 = const Offset(48, 21);
        r = 4.6;
        doorA = const Offset(32, 12.5);
        doorB = const Offset(32, 20.4);
        roofSign = const Rect.fromLTRB(26, 3.5, 38, 6.5);
      case RideCarStyle.sedan:
        body = Path()
          ..moveTo(3, 21)
          ..cubicTo(3, 17.5, 5, 16, 9, 15.2)
          ..lineTo(17, 14.4)
          ..cubicTo(21, 9.5, 26, 7.5, 32, 7.5)
          ..cubicTo(39, 7.5, 44, 9.8, 48, 12)
          ..cubicTo(55, 13.2, 61, 14.6, 61, 17.5)
          ..cubicTo(61, 20, 60, 21, 58, 21)
          ..close();
        w1 = const Offset(15, 21);
        w2 = const Offset(48, 21);
        r = 4.6;
        doorA = const Offset(32, 12.5);
        doorB = const Offset(32, 20.4);
    }

    canvas.drawPath(body, stroke);
    canvas.drawLine(doorA, doorB, stroke..strokeWidth = 1.1);
    if (roofSign != null) {
      canvas.drawRect(roofSign, stroke..strokeWidth = 1.3);
    }
    for (final Offset w in <Offset>[w1, w2]) {
      canvas.drawCircle(w, r, stroke);
      canvas.drawCircle(w, 1.6, Paint()..color = color);
    }
  }

  @override
  bool shouldRepaint(covariant _RideCarPainter old) =>
      old.style != style || old.color != color;
}
