import "package:flutter/material.dart";
import "package:flutter_test/flutter_test.dart";

import "package:nextbot/core/models/chat_models.dart";
import "package:nextbot/features/chat/message_body_renderer.dart";
import "package:nextbot/features/chat/structured_assistant_message_body.dart";

/// 单泡中间空白段（2026-11-14 P0-B）回归：
///
/// 一个气泡 = 一条消息，空白段只该出现在消息之间。单泡轮正文来自
/// done.finalText，模型按段落排版的 `\n\n` 必须在纯叙述渲染前折成单换行，
/// 否则真机上就是一个绿泡里中间隔一整行空白（用户截图事故形态）。
void main() {
  const String sample =
      "你老婆这两天挺活跃的。\n\n最值得说的是，《消失的人》北美今天上映了，悬疑犯罪题材。\n\n上车了没？";

  test("空行折叠：连续空行/带空白字符的空行都折成单换行", () {
    expect(
      foldIntraBubbleBlankLines("第一段。\n\n第二段。\n\n\n第三段。"),
      "第一段。\n第二段。\n第三段。",
    );
    expect(
      foldIntraBubbleBlankLines("第一段。\n  \t\n第二段。"),
      "第一段。\n第二段。",
    );
    // 单换行（泡内多行内容，如列表/表格行）不受影响
    expect(
      foldIntraBubbleBlankLines("- 条目一\n- 条目二"),
      "- 条目一\n- 条目二",
    );
  });

  testWidgets("纯叙述正文渲染时不再出现段落空白段", (WidgetTester tester) async {
    await tester.pumpWidget(
      MaterialApp(
        theme: ThemeData(useMaterial3: true),
        home: Builder(
          builder: (BuildContext context) {
            final ThemeData theme = Theme.of(context);
            return Scaffold(
              body: StructuredAssistantMessageBody(
                text: sample,
                cs: theme.colorScheme,
                textTheme: theme.textTheme,
              ),
            );
          },
        ),
      ),
    );
    await tester.pump();
    _expectNoBlankSegment(tester);
  });

  testWidgets("单泡回包（信封 text 块）渲染时不再出现段落空白段",
      (WidgetTester tester) async {
    final ChatMessage message = ChatMessage(
      messageId: "assistant-t1",
      sessionId: "s1",
      role: "assistant",
      text: sample,
      timestamp: DateTime.now(),
      envelopeBlocks: <Map<String, dynamic>>[
        <String, dynamic>{"type": "text", "text": sample},
      ],
      replyBlocks: <Map<String, dynamic>>[
        <String, dynamic>{"type": "text", "text": sample},
      ],
    );
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
    await tester.pump();
    _expectNoBlankSegment(tester);
  });
}

void _expectNoBlankSegment(WidgetTester tester) {
  final List<String> rendered = tester
      .widgetList<RichText>(find.byType(RichText))
      .map((RichText t) => t.text.toPlainText())
      .where((String s) => s.isNotEmpty)
      .toList();
  expect(rendered, isNotEmpty);
  expect(
    rendered.any((String s) => s.contains("\n\n")),
    isFalse,
    reason: "泡内不得残留空白段：$rendered",
  );
  expect(
    rendered.any((String s) => s.contains("你老婆这两天挺活跃的。\n最值得说的是")),
    isTrue,
    reason: "段落之间应折成单换行：$rendered",
  );
}
