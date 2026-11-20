import "package:flutter/material.dart";
import "package:flutter_test/flutter_test.dart";

import "package:nextbot/features/chat/followup_bubbles.dart";

/// 接续建议（NEXT_UP 协议客户端半边）渲染测试：
/// - 不出现「接下来你可以」标题行；
/// - 每条建议独立成气泡、一行一条、左对齐（挂在 agent 消息正下方的助手侧小泡）；
/// - 点击气泡回传原文案（点击即作为新消息发送的链路入口）。

Future<void> pumpBubbles(
  WidgetTester tester,
  List<String> prompts, {
  void Function(String prompt)? onTap,
}) async {
  await tester.pumpWidget(
    MaterialApp(
      home: Scaffold(
        body: Center(
          child: SizedBox(
            width: 400,
            child: FollowUpBubbles(
              prompts: prompts,
              onTap: onTap ?? (_) {},
              bubbleColor: const Color(0xFF000000),
              textColor: const Color(0xFFFFFFFF),
            ),
          ),
        ),
      ),
    ),
  );
}

void main() {
  testWidgets("followups: 无标题行，每条一行左对齐，点击回传原文案", (tester) async {
    String? tapped;
    const String first = "帮我看看我手里那几只跌了多少";
    const String second = "AI这波跌到哪算底";
    await pumpBubbles(
      tester,
      <String>[first, second],
      onTap: (String prompt) => tapped = prompt,
    );

    expect(find.text("接下来你可以"), findsNothing);
    expect(find.text(first), findsOneWidget);
    expect(find.text(second), findsOneWidget);

    // 一行一条：两条气泡纵向错开
    final double firstTop = tester.getTopLeft(find.text(first)).dy;
    final double secondTop = tester.getTopLeft(find.text(second)).dy;
    expect(firstTop, isNot(secondTop));

    // 左对齐：两条气泡左缘齐平，且贴住容器左缘（14 = 气泡水平内边距）
    final double firstLeft = tester.getTopLeft(find.text(first)).dx;
    final double secondLeft = tester.getTopLeft(find.text(second)).dx;
    expect(firstLeft, closeTo(secondLeft, 0.5));
    final double containerLeft =
        tester.getTopLeft(find.byType(FollowUpBubbles)).dx;
    expect(firstLeft, closeTo(containerLeft + 14, 0.5));

    await tester.tap(find.text(second));
    expect(tapped, second);
  });

  testWidgets("followups: 仅空文案时不渲染任何内容", (tester) async {
    await pumpBubbles(tester, <String>["  ", ""]);
    expect(find.byType(Text), findsNothing);
  });
}
