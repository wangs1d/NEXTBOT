/// 右侧面板底部「召唤桌宠」入口的位置回归：入口固定在面板底部（界面右下角），
/// 不挂顶栏。面板水平居中于 800x600 测试视口 → 面板左边界 x=290、右边界 x=510。
library;

import "dart:async" show Future;

import "package:flutter/material.dart";
import "package:flutter_test/flutter_test.dart";

import "package:nextbot/core/models/schedule_models.dart";
import "package:nextbot/core/theme/app_theme.dart";
import "package:nextbot/features/chat/right_side_panel.dart";

Future<Rect> _pumpPetFooter(WidgetTester tester, double panelHeight) async {
  await tester.pumpWidget(
    MaterialApp(
      debugShowCheckedModeBanner: false,
      theme: AppTheme.of(AppThemeVariant.dark),
      home: Scaffold(
        body: Center(
          child: SizedBox(
            width: 220,
            height: panelHeight,
            child: RightSidePanel(
              scheduleFuture: Future<List<ScheduleEvent>>.value(
                <ScheduleEvent>[],
              ),
            ),
          ),
        ),
      ),
    ),
  );
  await tester.pump(const Duration(milliseconds: 300));
  expect(find.text("召唤桌宠"), findsOneWidget);
  return tester.getRect(
    find
        .ancestor(
          of: find.text("召唤桌宠"),
          matching: find.byType(InkWell),
        )
        .first,
  );
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  testWidgets("召唤桌宠按钮固定在面板底部右下角", (WidgetTester tester) async {
    final Rect pill = await _pumpPetFooter(tester, 560);
    final double panelBottom = (600 + 560) / 2;

    expect(pill.center.dx, closeTo(400, 2));
    expect(panelBottom - pill.bottom, closeTo(14, 2));

    await tester.pumpWidget(const SizedBox.shrink());
    await tester.pump(const Duration(milliseconds: 50));
  });

  testWidgets("矮窗口下按钮仍钉底不被挤出", (WidgetTester tester) async {
    final Rect pill = await _pumpPetFooter(tester, 320);
    final double panelBottom = (600 + 320) / 2;

    expect(panelBottom - pill.bottom, closeTo(14, 2));

    await tester.pumpWidget(const SizedBox.shrink());
    await tester.pump(const Duration(milliseconds: 50));
  });
}
