import "package:flutter/material.dart";
import "package:flutter_test/flutter_test.dart";

import "package:nextbot/core/models/chat_models.dart";
import "package:nextbot/features/chat/message_body_renderer.dart";

/// 「接下来你可以」接续建议渲染测试（2026-11-17 用户定稿）：
/// - 建议不再内联渲染在助手气泡里，`buildMessageBody` 完全不消费 followUpPrompts；
/// - 建议由气泡外的 [buildFollowUpRow] 独立承载：灰色标题 + 每条一个胶囊；
/// - 点击胶囊回传原文案（点击即作为新消息发送的链路入口）；
/// - 空列表不渲染任何东西。

ChatMessage messageWithFollowUps(List<String>? prompts) => ChatMessage(
      messageId: "m1",
      sessionId: "s1",
      role: "assistant",
      text: "日程建好了——后天上午十点理发，我提前15分钟提醒你。",
      timestamp: DateTime.now(),
      followUpPrompts: prompts,
    );

Future<void> pumpBody(
  WidgetTester tester,
  ChatMessage message,
) async {
  await tester.pumpWidget(
    MaterialApp(
      home: Builder(
        builder: (BuildContext context) => Scaffold(
          body: buildMessageBody(
            context,
            Theme.of(context).colorScheme,
            message,
            isUser: false,
          ),
        ),
      ),
    ),
  );
}

Future<void> pumpFollowUpRow(
  WidgetTester tester,
  List<String> prompts, {
  void Function(String prompt)? onFollowupTap,
}) async {
  await tester.pumpWidget(
    MaterialApp(
      home: Builder(
        builder: (BuildContext context) => Scaffold(
          body: buildFollowUpRow(
            context,
            Theme.of(context).colorScheme,
            prompts,
            onFollowupTap ?? (_) {},
          ),
        ),
      ),
    ),
  );
}

void main() {
  testWidgets("气泡内不再渲染接续建议（即使 followUpPrompts 非空）", (tester) async {
    await pumpBody(
      tester,
      messageWithFollowUps(<String>["把提醒改成提前半小时", "那天出门前帮我看下天气"]),
    );
    expect(find.text("接下来你可以"), findsNothing);
    expect(find.text("把提醒改成提前半小时"), findsNothing);
  });

  testWidgets("气泡外独立组件：渲染标题行与胶囊，点击回传原文案", (tester) async {
    String? tapped;
    await pumpFollowUpRow(
      tester,
      <String>["把提醒改成提前半小时", "那天出门前帮我看下天气"],
      onFollowupTap: (String prompt) => tapped = prompt,
    );

    expect(find.text("接下来你可以"), findsOneWidget);
    expect(find.text("把提醒改成提前半小时"), findsOneWidget);
    expect(find.text("那天出门前帮我看下天气"), findsOneWidget);

    await tester.tap(find.text("那天出门前帮我看下天气"));
    expect(tapped, "那天出门前帮我看下天气");
  });

  testWidgets("空列表不渲染建议行", (tester) async {
    await pumpFollowUpRow(tester, <String>[]);
    expect(find.text("接下来你可以"), findsNothing);
  });
}
