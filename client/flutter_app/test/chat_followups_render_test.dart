import "package:flutter/material.dart";
import "package:flutter_test/flutter_test.dart";

import "package:nextbot/core/models/chat_models.dart";
import "package:nextbot/features/chat/message_body_renderer.dart";

/// 「接下来你可以」接续建议渲染测试（NEXT_UP 协议客户端半边）：
/// - followUpPrompts 非空且接线 onFollowupTap → 渲染「接下来你可以」行 + 胶囊；
/// - 点击胶囊触发回调并携带原文案（点击即作为新消息发送的链路入口）；
/// - 无回调（移动端未接线）或字段为空 → 不渲染建议行。

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
  ChatMessage message, {
  void Function(String prompt)? onFollowupTap,
}) async {
  await tester.pumpWidget(
    MaterialApp(
      home: Builder(
        builder: (BuildContext context) => Scaffold(
          body: buildMessageBody(
            context,
            Theme.of(context).colorScheme,
            message,
            isUser: false,
            onFollowupTap: onFollowupTap,
          ),
        ),
      ),
    ),
  );
}

void main() {
  testWidgets("followups: 渲染标题行与胶囊，点击回传原文案", (tester) async {
    String? tapped;
    await pumpBody(
      tester,
      messageWithFollowUps(<String>["把提醒改成提前半小时", "那天出门前帮我看下天气"]),
      onFollowupTap: (String prompt) => tapped = prompt,
    );

    expect(find.text("接下来你可以"), findsOneWidget);
    expect(find.text("把提醒改成提前半小时"), findsOneWidget);
    expect(find.text("那天出门前帮我看下天气"), findsOneWidget);

    await tester.tap(find.text("那天出门前帮我看下天气"));
    expect(tapped, "那天出门前帮我看下天气");
  });

  testWidgets("followups: 未接线回调时不渲染建议行", (tester) async {
    await pumpBody(
      tester,
      messageWithFollowUps(<String>["把提醒改成提前半小时"]),
    );
    expect(find.text("接下来你可以"), findsNothing);
    expect(find.text("把提醒改成提前半小时"), findsNothing);
  });

  testWidgets("followups: 字段为空/null 时不渲染建议行", (tester) async {
    await pumpBody(tester, messageWithFollowUps(null), onFollowupTap: (_) {});
    expect(find.text("接下来你可以"), findsNothing);

    await pumpBody(tester, messageWithFollowUps(<String>[]), onFollowupTap: (_) {});
    expect(find.text("接下来你可以"), findsNothing);
  });
}
