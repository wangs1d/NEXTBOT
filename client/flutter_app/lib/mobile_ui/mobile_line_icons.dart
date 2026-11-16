import "package:flutter/material.dart";

/// 手机端线性小图标：按参考图（24×24 viewBox、1.7 描边）1:1 绘制。
///
/// 用在玻璃底栏的 4 个 tab 与旁聊列表行图标；Material 自带的
/// chat_bubble / book 轮廓与参考图不一致（圆气泡 vs 方气泡），故自绘。
enum MobileLineIconKind { chat, book, pulse, library }

class MobileLineIcon extends StatelessWidget {
  const MobileLineIcon({
    super.key,
    required this.kind,
    required this.size,
    required this.color,
    this.strokeWidth = 1.7,
  });

  final MobileLineIconKind kind;
  final double size;
  final Color color;
  final double strokeWidth;

  @override
  Widget build(BuildContext context) {
    return CustomPaint(
      size: Size.square(size),
      painter: _MobileLineIconPainter(
        kind: kind,
        color: color,
        strokeWidth: strokeWidth,
      ),
    );
  }
}

class _MobileLineIconPainter extends CustomPainter {
  const _MobileLineIconPainter({
    required this.kind,
    required this.color,
    required this.strokeWidth,
  });

  final MobileLineIconKind kind;
  final Color color;
  final double strokeWidth;

  @override
  void paint(Canvas canvas, Size size) {
    final double s = size.width / 24;
    canvas.save();
    canvas.scale(s);
    final Paint stroke = Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = strokeWidth
      ..strokeCap = StrokeCap.round
      ..strokeJoin = StrokeJoin.round
      ..color = color;
    switch (kind) {
      case MobileLineIconKind.chat:
        // M20 12 a8 8 0 0 1 -11.6 7.1 L4 20 l1 -4.2 A8 8 0 1 1 20 12 Z
        final Path bubble = Path()
          ..moveTo(20, 12)
          ..arcToPoint(
            const Offset(8.4, 19.1),
            radius: const Radius.circular(8),
            clockwise: true,
          )
          ..lineTo(4, 20)
          ..lineTo(5, 15.8)
          ..arcToPoint(
            const Offset(20, 12),
            radius: const Radius.circular(8),
            clockwise: true,
            largeArc: true,
          )
          ..close();
        canvas.drawPath(bubble, stroke);
        break;
      case MobileLineIconKind.book:
        canvas.drawRRect(
          RRect.fromRectAndRadius(
            const Rect.fromLTWH(5, 4, 14, 17),
            const Radius.circular(2.4),
          ),
          stroke,
        );
        canvas.drawLine(const Offset(9, 4), const Offset(9, 21), stroke);
        break;
      case MobileLineIconKind.pulse:
        // 「动态」tab 图标：心电脉冲线——持续的动静/生命体征，
        // 对应 Agent 主动性聚合（快递到、账单出、日程变的扫描感）。
        final Path pulse = Path()
          ..moveTo(3, 12)
          ..lineTo(7.5, 12)
          ..lineTo(10, 6.5)
          ..lineTo(14, 17.5)
          ..lineTo(16.5, 12)
          ..lineTo(21, 12);
        canvas.drawPath(pulse, stroke);
        break;
      case MobileLineIconKind.library:
        final Path folder = Path()
          ..moveTo(4, 8)
          ..quadraticBezierTo(4, 6, 6, 6)
          ..lineTo(9.6, 6)
          ..lineTo(11.4, 8)
          ..lineTo(18, 8)
          ..quadraticBezierTo(20, 8, 20, 10)
          ..lineTo(20, 18)
          ..quadraticBezierTo(20, 20, 18, 20)
          ..lineTo(6, 20)
          ..quadraticBezierTo(4, 20, 4, 18)
          ..close();
        canvas.drawPath(folder, stroke);
        break;
    }
    canvas.restore();
  }

  @override
  bool shouldRepaint(_MobileLineIconPainter oldDelegate) =>
      oldDelegate.kind != kind ||
      oldDelegate.color != color ||
      oldDelegate.strokeWidth != strokeWidth;
}
