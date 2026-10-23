// 开场动画关键帧 golden：用 --update-goldens 渲染各阶段帧，
// 供人工核对 N 字标（描摹自 nextbot-icon-monogram.png）在光扫/收匀下的形态。
import "package:flutter/material.dart";
import "package:flutter_test/flutter_test.dart";

import "package:nextbot/core/presentation/boot_animation.dart";

void main() {
  testWidgets("boot animation key frames", (WidgetTester tester) async {
    tester.view.physicalSize = const Size(1200, 1600);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);

    await tester.pumpWidget(const BootAnimation());

    const List<double> frames = <double>[0.2, 0.9, 1.4, 1.9, 2.4, 2.8, 3.5];
    double prev = 0;
    for (final double t in frames) {
      await tester.pump(Duration(milliseconds: ((t - prev) * 1000).round()));
      prev = t;
      await expectLater(
        find.byType(BootAnimation),
        matchesGoldenFile("goldens/boot_frame_t${t.toStringAsFixed(1)}.png"),
      );
    }
  }, timeout: const Timeout(Duration(minutes: 4)));
}
