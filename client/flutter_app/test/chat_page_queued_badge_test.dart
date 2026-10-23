import "package:flutter/material.dart";
import "package:flutter_test/flutter_test.dart";

import "package:nextbot/core/models/chat_models.dart";
import "package:nextbot/features/chat/chat_page.dart";

ChatMessage _user(String id, String text) => ChatMessage(
      messageId: id,
      sessionId: "s1",
      role: "user",
      text: text,
      timestamp: DateTime(2026, 9, 14, 10, 0),
    );

Widget _host(List<ChatMessage> messages, {Set<String> queued = const {}}) {
  return MaterialApp(
    home: Scaffold(
      body: ChatPage(
        messages: messages,
        controller: TextEditingController(),
        onSend: () {},
        queuedMessageIds: queued,
      ),
    ),
  );
}

void main() {
  testWidgets("排队徽标：排队中的用户气泡显示「排队中」，其余不显示", (WidgetTester tester) async {
    await tester.pumpWidget(_host(
      <ChatMessage>[
        _user("m-1", "调研最近的热点话题"),
        _user("m-2", "基于热点写活动提案"),
      ],
      queued: const <String>{"m-2"},
    ));
    await tester.pump();

    expect(find.text("排队中"), findsOneWidget);
  });

  testWidgets("排队徽标：队列为空时任何气泡都不显示「排队中」", (WidgetTester tester) async {
    await tester.pumpWidget(_host(<ChatMessage>[
      _user("m-1", "普通消息"),
    ]));
    await tester.pump();

    expect(find.text("排队中"), findsNothing);
  });

  testWidgets("排队徽标：消息晋级（移出集合）后徽标消失", (WidgetTester tester) async {
    await tester.pumpWidget(_host(
      <ChatMessage>[_user("m-1", "第一条")],
      queued: const <String>{"m-1"},
    ));
    await tester.pump();
    expect(find.text("排队中"), findsOneWidget);

    // 模拟 chat.turn_started 晋级：父组件把消息移出排队集合
    await tester.pumpWidget(_host(
      <ChatMessage>[_user("m-1", "第一条")],
      queued: const <String>{},
    ));
    await tester.pump();
    expect(find.text("排队中"), findsNothing);
  });
}
