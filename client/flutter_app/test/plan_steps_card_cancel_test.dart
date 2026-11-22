import "package:flutter/material.dart";
import "package:flutter_test/flutter_test.dart";
import "package:nextbot/core/models/turn_state.dart";
import "package:nextbot/features/chat/plan_steps_card.dart";

/// 任务步骤条「终止」入口（2026-11-22）。
///
/// 不变量：
///  - 未接 onCancel 的调用方（旧测试/手机端未接线的场景）不渲染终止按钮；
///  - 接了 onCancel 时，卡片一出现就能点到「终止」，回调只触发一次；
///  - 全部完成时卡片自隐（终止按钮随之消失，不需要额外状态）。
void main() {
  List<TurnPlanStep> steps() => <TurnPlanStep>[
        TurnPlanStep(id: "s1", title: "比价酒店", status: TurnStepStatus.ok),
        TurnPlanStep(id: "s2", title: "下单", status: TurnStepStatus.running),
      ];

  Widget host({VoidCallback? onCancel}) => MaterialApp(
        home: Scaffold(
          body: PlanStepsCard(
            steps: steps(),
            onConfirm: () {},
            onCancel: onCancel,
          ),
        ),
      );

  testWidgets("未接 onCancel 时不渲染终止按钮", (WidgetTester tester) async {
    await tester.pumpWidget(host());
    expect(find.text("任务步骤"), findsOneWidget);
    expect(find.text("终止"), findsNothing);
  });

  testWidgets("点终止回调一次，且不必等步骤完成", (WidgetTester tester) async {
    int cancelled = 0;
    await tester.pumpWidget(host(onCancel: () => cancelled++));
    expect(find.text("终止"), findsOneWidget);
    await tester.tap(find.text("终止"));
    await tester.pump();
    expect(cancelled, 1);
    // 点击是控制动作，不该顺手产生「继续下一步」之类的副作用
    // （running 行有循环呼吸动画，不能 pumpAndSettle）
    await tester.pump(const Duration(milliseconds: 300));
    expect(cancelled, 1);
  });

  testWidgets("全部完成时卡片自隐，终止入口一并消失", (WidgetTester tester) async {
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: PlanStepsCard(
            steps: <TurnPlanStep>[
              TurnPlanStep(id: "s1", title: "比价酒店", status: TurnStepStatus.ok),
            ],
            onConfirm: () {},
            onCancel: () {},
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.text("任务步骤"), findsNothing);
    expect(find.text("终止"), findsNothing);
  });
}
