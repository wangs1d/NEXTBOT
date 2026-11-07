import "package:flutter/material.dart";

/// 手机端线性小图标：按参考图（24×24 viewBox、1.7 描边）1:1 绘制。
///
/// 用在玻璃底栏的 4 个 tab 与旁聊列表行图标；Material 自带的
/// chat_bubble / book 轮廓与参考图不一致（圆气泡 vs 方气泡），故自绘。
enum MobileLineIconKind { chat, book, tasks, library }

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
      case MobileLineIconKind.tasks:
        canvas.drawRRect(
          RRect.fromRectAndRadius(
            const Rect.fromLTWH(4, 4, 16, 16),
            const Radius.circular(4),
          ),
          stroke,
        );
        final Path check = Path()
          ..moveTo(8.2, 12)
          ..lineTo(10.8, 14.6)
          ..lineTo(16, 9.4);
        canvas.drawPath(check, stroke);
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
