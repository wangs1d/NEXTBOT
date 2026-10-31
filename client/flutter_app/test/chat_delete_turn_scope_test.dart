// 「删除这一轮」的范围判定（UI 层）：点气泡后的预选集合按轮次归属算，
// 夹在这一轮里的主动推送不会被一起选进删除范围。
import "package:flutter/gestures.dart";
import "package:flutter/material.dart";
import "package:flutter_test/flutter_test.dart";

import "package:nextbot/core/models/chat_models.dart";
import "package:nextbot/features/chat/chat_page.dart";

ChatMessage _msg(String id, String role, String text, int minute) => ChatMessage(
      messageId: id,
      sessionId: "s1",
      role: role,
      text: text,
      timestamp: DateTime(2026, 10, 30, 9, minute),
    );

Widget _host(List<ChatMessage> messages) {
  return MaterialApp(
    home: Scaffold(
      body: ChatPage(
        messages: messages,
        controller: TextEditingController(),
        onSend: () {},
        onDeleteMessage: (_) {},
      ),
    ),
  );
}

Future<void> _hover(WidgetTester tester, Finder target) async {
  final TestGesture gesture =
      await tester.createGesture(kind: PointerDeviceKind.mouse);
  await gesture.addPointer(location: Offset.zero);
  addTearDown(gesture.removePointer);
  await gesture.moveTo(tester.getCenter(target));
  await tester.pump(const Duration(milliseconds: 250));
}

Finder _deleteButtonIn(WidgetTester tester, Finder bubble) {
  return find.descendant(
    of: find.ancestor(of: bubble, matching: find.byType(Stack)).first,
    matching: find.byIcon(Icons.delete_outline),
  );
}

void main() {
  testWidgets("点主对话气泡 → 预选整轮，夹在中间的主动推送不入选",
      (WidgetTester tester) async {
    await tester.pumpWidget(_host(<ChatMessage>[
      _msg("msg-1", "user", "明天几点出门", 0),
      _msg("assistant-msg-1", "assistant", "七点半，路上堵", 1),
      _msg("assistant-proactive-1", "assistant", "顺手提醒：伞带上", 2),
    ]));
    await tester.pump(const Duration(milliseconds: 250));

    await _hover(tester, find.text("明天几点出门"));
    await tester.tap(_deleteButtonIn(tester, find.text("明天几点出门")));
    await tester.pump(const Duration(milliseconds: 250));

    // 一轮 = user + 它自己的回复；主动推送不在其中
    expect(find.text("删除这一轮（2 条）"), findsOneWidget);
  });

  testWidgets("点主动推送气泡 → 只删这一条", (WidgetTester tester) async {
    await tester.pumpWidget(_host(<ChatMessage>[
      _msg("msg-1", "user", "明天几点出门", 0),
      _msg("assistant-msg-1", "assistant", "七点半，路上堵", 1),
      _msg("assistant-proactive-1", "assistant", "顺手提醒：伞带上", 2),
    ]));
    await tester.pump(const Duration(milliseconds: 250));

    await _hover(tester, find.text("顺手提醒：伞带上"));
    await tester.tap(_deleteButtonIn(tester, find.text("顺手提醒：伞带上")));
    await tester.pump(const Duration(milliseconds: 250));

    expect(find.text("删除这条"), findsOneWidget);
    expect(find.textContaining("删除这一轮"), findsNothing);
  });
}
