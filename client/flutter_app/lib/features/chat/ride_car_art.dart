import "package:flutter/material.dart";

/// 车型矢量插画（对标滴滴的车型图，2026-11-24）。
///
/// 为什么不用图片资源：包里没有 flutter_svg，用位图又会在不同 DPR 下发虚。
/// 这里用与 SVG 等价的可缩放矢量路径直接绘制——同一套 path 数据在任意尺寸都
/// 清晰，且能跟着卡片主题（黑底白字）自动取色，不会像固定配图那样和卡面打架。
///
/// 体态按品类区分（滴滴口径：不同车型给出不同车身比例，用户扫一眼就能分辨）：
///   hatch 两厢小车 / sedan 快车 / comfort 舒适型 / mpv 商务六座 / taxi 出租车
enum RideCarStyle { hatch, sedan, comfort, mpv, taxi }

/// 车型名 → 体态。服务端下发的是滴滴真实品类名（惊喜特价/特惠快车/快车/专车…）。
RideCarStyle rideCarStyleFor(String name) {
  if (name.contains("商务") || name.contains("六座") || name.contains("七座") || name.contains("mpv")) {
    return RideCarStyle.mpv;
  }
  if (name.contains("出租")) return RideCarStyle.taxi;
  if (name.contains("专车") || name.contains("舒适") || name.contains("豪华") || name.contains("优享")) {
    return RideCarStyle.comfort;
  }
  if (name.contains("特价") || name.contains("惊喜") || name.contains("经济") || name.contains("拼车")) {
    return RideCarStyle.hatch;
  }
  return RideCarStyle.sedan;
}

/// 车型插画：地面投影 + 车身渐变 + 车窗 + 轮毂，纯矢量绘制。
class RideCarArt extends StatelessWidget {
  const RideCarArt({
    super.key,
    required this.style,
    required this.color,
    this.width = 84,
    this.active = false,
  });

  final RideCarStyle style;
  /// 主色（卡面前景色）；玻璃/阴影由它派生，深浅主题都成立。
  final Color color;
  final double width;
  /// 选中态：车身加一层实色，视觉重量更足。
  final bool active;

  static const double _aspect = 100 / 46;

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      width: width,
      height: width / _aspect,
      child: CustomPaint(
        painter: _RideCarArtPainter(style: style, color: color, active: active),
      ),
    );
  }
}

class _RideCarArtPainter extends CustomPainter {
  _RideCarArtPainter({required this.style, required this.color, required this.active});

  final RideCarStyle style;
  final Color color;
  final bool active;

  @override
  void paint(Canvas canvas, Size size) {
    canvas.save();
    canvas.scale(size.width / 100, size.height / 46);

    final Color ink = color;
    // 车身填充：上亮下暗的极浅渐变，保留黑白语言又不至于变成一块死板色块
    final Paint body = Paint()
      ..shader = LinearGradient(
        begin: Alignment.topCenter,
        end: Alignment.bottomCenter,
        colors: <Color>[
          ink.withValues(alpha: active ? 0.20 : 0.13),
          ink.withValues(alpha: active ? 0.10 : 0.05),
        ],
      ).createShader(const Rect.fromLTWH(0, 0, 100, 46));
    final Paint stroke = Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = 1.5
      ..color = ink.withValues(alpha: active ? 0.95 : 0.72)
      ..strokeCap = StrokeCap.round
      ..strokeJoin = StrokeJoin.round;
    final Paint glass = Paint()..color = ink.withValues(alpha: active ? 0.42 : 0.28);
    final Paint shadow = Paint()
      ..shader = RadialGradient(
        colors: <Color>[ink.withValues(alpha: 0.18), ink.withValues(alpha: 0)],
      ).createShader(const Rect.fromLTWH(10, 34, 80, 12));

    // 地面投影：一条羽化椭圆，让车“落地”而不是浮在卡面上
    canvas.drawOval(const Rect.fromLTWH(12, 36, 76, 8), shadow);

    final Path bodyPath = _bodyPath(style);
    canvas.drawPath(bodyPath, body);
    canvas.drawPath(bodyPath, stroke);

    // 车窗：前挡 + 侧窗（B 柱留缝，比一整块玻璃更像真车）
    for (final Path w in _windowPaths(style)) {
      canvas.drawPath(w, glass);
      canvas.drawPath(w, stroke..strokeWidth = 1.1);
    }
    stroke.strokeWidth = 1.5;

    // 车门缝 + 门把手
    final double doorX = style == RideCarStyle.mpv ? 54 : 52;
    canvas.drawLine(
      Offset(doorX, _roofY(style) + 4),
      Offset(doorX, 33),
      stroke..strokeWidth = 1.0,
    );

    // 车灯
    canvas.drawRRect(
      RRect.fromRectAndRadius(
        Rect.fromLTWH(_frontX(style) + 1.5, 27, 4, 2.4),
        const Radius.circular(1.2),
      ),
      Paint()..color = ink.withValues(alpha: active ? 0.85 : 0.55),
    );

    // 出租车顶灯
    if (style == RideCarStyle.taxi) {
      final RRect sign = RRect.fromRectAndRadius(
        Rect.fromLTWH(40, _roofY(style) - 5, 13, 4),
        const Radius.circular(1.4),
      );
      canvas.drawRRect(sign, Paint()..color = ink.withValues(alpha: active ? 0.9 : 0.65));
    }

    // 轮子：外圈描边 + 中心轮毂点。不用实心圆——卡面深浅两套主题共用一个
    // 绘制器，不知道底色就没法给「胎侧」选色，描边 + 空心在任何底色上都成立。
    for (final double cx in <double>[_wheelFrontX(style), _wheelRearX(style)]) {
      canvas.drawCircle(
        Offset(cx, 34),
        6.1,
        Paint()
          ..style = PaintingStyle.stroke
          ..strokeWidth = 2.3
          ..color = ink.withValues(alpha: active ? 0.95 : 0.78),
      );
      canvas.drawCircle(
        Offset(cx, 34),
        1.9,
        Paint()..color = ink.withValues(alpha: active ? 0.9 : 0.7),
      );
    }
    canvas.restore();
  }

  double _roofY(RideCarStyle s) {
    switch (s) {
      case RideCarStyle.hatch:
        return 15.5;
      case RideCarStyle.sedan:
        return 14;
      case RideCarStyle.comfort:
        return 13.5;
      case RideCarStyle.mpv:
        return 11;
      case RideCarStyle.taxi:
        return 14;
    }
  }

  double _frontX(RideCarStyle s) => 5.5;

  double _rearX(RideCarStyle s) {
    switch (s) {
      case RideCarStyle.hatch:
        return 88;
      case RideCarStyle.mpv:
        return 95;
      default:
        return 94.5;
    }
  }

  double _wheelFrontX(RideCarStyle s) => s == RideCarStyle.mpv ? 25 : 24;
  double _wheelRearX(RideCarStyle s) =>
      s == RideCarStyle.hatch ? 74 : (s == RideCarStyle.mpv ? 78 : 77);

  Path _bodyPath(RideCarStyle s) {
    final double roof = _roofY(s);
    final double rear = _rearX(s);
    switch (s) {
      case RideCarStyle.hatch:
        // 两厢：车尾短促直立，车顶后段几乎不下坠
        return Path()
          ..moveTo(6, 34)
          ..cubicTo(4.4, 29.5, 5.4, 26.6, 11, 25.2)
          ..lineTo(20, 24.2)
          ..cubicTo(25, roof + 1.6, 32, roof, 42, roof)
          ..lineTo(66, roof)
          ..cubicTo(76, roof, 82, roof + 3, rear - 3, 27)
          ..cubicTo(rear, 28.4, rear + 0.6, 31, rear + 0.4, 34)
          ..close();
      case RideCarStyle.mpv:
        // 商务/六座：车顶长而平，尾门接近垂直
        return Path()
          ..moveTo(6, 34)
          ..cubicTo(4.6, 29, 5.6, 26, 11, 25)
          ..lineTo(21, 24)
          ..cubicTo(26, roof + 1.2, 33, roof, 42, roof)
          ..lineTo(78, roof)
          ..cubicTo(88, roof, 93, roof + 2.4, 95, 26)
          ..lineTo(95, 34)
          ..close();
      case RideCarStyle.taxi:
      case RideCarStyle.comfort:
      case RideCarStyle.sedan:
        return Path()
          ..moveTo(5.5, 34)
          ..cubicTo(4.2, 29.2, 5.4, 26.2, 11, 25)
          ..lineTo(21, 24)
          ..cubicTo(26, roof + 2.2, 33, roof, 43, roof)
          ..lineTo(62, roof)
          ..cubicTo(70, roof, 76, roof + 2.6, 81, 22.4)
          ..lineTo(90, 23.6)
          ..cubicTo(93.6, 24.6, 94.6, 28, 94.2, 34)
          ..close();
    }
  }

  List<Path> _windowPaths(RideCarStyle s) {
    final double roof = _roofY(s);
    if (s == RideCarStyle.mpv) {
      return <Path>[
        Path()
          ..moveTo(28.5, 23)
          ..lineTo(37, roof + 2.2)
          ..lineTo(50, roof + 2.2)
          ..lineTo(50, 23)
          ..close(),
        Path()
          ..moveTo(53.5, 23)
          ..lineTo(53.5, roof + 2.2)
          ..lineTo(68, roof + 2.2)
          ..lineTo(74, 23)
          ..close(),
        Path()
          ..moveTo(77.5, 23)
          ..lineTo(77.5, roof + 2.2)
          ..lineTo(86, roof + 2.2)
          ..lineTo(90, 23)
          ..close(),
      ];
    }
    if (s == RideCarStyle.hatch) {
      return <Path>[
        Path()
          ..moveTo(28, 23)
          ..lineTo(36, roof + 1.4)
          ..lineTo(48, roof + 1.4)
          ..lineTo(48, 23)
          ..close(),
        Path()
          ..moveTo(51.5, 23)
          ..lineTo(51.5, roof + 1.4)
          ..lineTo(65, roof + 1.4)
          ..lineTo(70, 23)
          ..close(),
      ];
    }
    return <Path>[
      Path()
        ..moveTo(28.5, 23)
        ..lineTo(37, roof + 2.4)
        ..lineTo(49.5, roof + 2.4)
        ..lineTo(49.5, 23)
        ..close(),
      Path()
        ..moveTo(53, 23)
        ..lineTo(53, roof + 2.4)
        ..lineTo(64, roof + 2.4)
        ..lineTo(71, 23)
        ..close(),
    ];
  }

  @override
  bool shouldRepaint(covariant _RideCarArtPainter old) =>
      old.style != style || old.color != color || old.active != active;
}
