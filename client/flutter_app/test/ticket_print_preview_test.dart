import "package:flutter/material.dart";
import "package:flutter_test/flutter_test.dart";
import "package:nextbot/features/chat/travel_plan_archive.dart";

// 出票动画复现:idle 点罗盘(临时调试入口)→ 出票覆盖层应完整打印出票面。
void main() {
  testWidgets("出票动画:票应完整打印出来", (WidgetTester tester) async {
    await tester.pumpWidget(
      const MaterialApp(home: TravelPlanArchivePage()),
    );
    await tester.pump();

    expect(find.byIcon(Icons.explore_outlined), findsNWidgets(2));
    await tester.tap(find.byIcon(Icons.explore_outlined).last);
    await tester.pump(); // overlay 插入,动画 t=0

    // 初始:票应藏在缝内(标题为打印中)
    expect(find.text("正在出票 · · ·"), findsOneWidget);

    // 推进到吐票中段(约 v=0.35)
    await tester.pump(const Duration(milliseconds: 900));
    // 推进到动画结束(blink 永动,不能用 pumpAndSettle)
    await tester.pump(const Duration(milliseconds: 4200));

    expect(find.text("叮——你的行程票打好了"), findsOneWidget);
    // 票面字段应已渲染且可见
    expect(find.text("成都"), findsOneWidget);
    expect(find.textContaining("ITINERARY PASS"), findsOneWidget);
    expect(find.textContaining("3 天 2 晚"), findsOneWidget);
    expect(find.text("¥1,180"), findsOneWidget);

    // 票可见性:目的地文字的 RenderBox 应落在视口内
    final RenderBox box =
        tester.renderObject(find.text("成都")) as RenderBox;
    final Offset origin = box.localToGlobal(Offset.zero);
    expect(origin.dy, greaterThan(0));
    expect(origin.dy, lessThan(700));

    // 出完成态 golden 取证(首次用 --update-goldens 生成)
    await expectLater(
      find.byType(TravelPlanArchivePage),
      matchesGoldenFile("goldens/ticket_print_overlay.png"),
    );
  });
}
