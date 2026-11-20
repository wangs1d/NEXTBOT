import "package:flutter/material.dart";
import "package:flutter_test/flutter_test.dart";

import "package:nextbot/features/chat/structured_assistant_message_body.dart";

/// 分泡后的文档单元渲染回归：一个泡 = 一段文档单元时，
/// 标题行 / 多行结构仍必须走块级渲染，不能把 ## 原样漏成正文。
void main() {
  Future<List<String>> pumpAndCollect(
    WidgetTester tester,
    String text,
  ) async {
    await tester.pumpWidget(
      MaterialApp(
        theme: ThemeData(useMaterial3: true),
        home: Builder(
          builder: (BuildContext context) {
            final ThemeData theme = Theme.of(context);
            return Scaffold(
              body: SingleChildScrollView(
                child: StructuredAssistantMessageBody(
                  text: text,
                  cs: theme.colorScheme,
                  textTheme: theme.textTheme,
                ),
              ),
            );
          },
        ),
      ),
    );
    await tester.pump();
    return tester
        .widgetList<RichText>(find.byType(RichText))
        .map((RichText t) => t.text.toPlainText())
        .where((String s) => s.isNotEmpty)
        .toList();
  }

  testWidgets("标题+正文段成泡：井号被剥除，正文可见", (WidgetTester tester) async {
    final List<String> rendered = await pumpAndCollect(
      tester,
      "## 结论\n先给结论：整体还行，但有两个点要留意。",
    );
    final String all = rendered.join("\n");
    expect(all.contains("##"), isFalse, reason: "标题井号不得漏成正文：$rendered");
    expect(all.contains("结论"), isTrue, reason: "标题文字要保留：$rendered");
    expect(all.contains("有两个点要留意"), isTrue);
  });

  testWidgets("只含一行标题的泡：按块级标题渲染", (WidgetTester tester) async {
    final List<String> rendered = await pumpAndCollect(tester, "## 🧭 先看事实");
    final String all = rendered.join("\n");
    expect(all.contains("##"), isFalse, reason: "井号不得漏出：$rendered");
    expect(all.contains("先看事实"), isTrue);
  });

  testWidgets("代码块泡：围栏整块渲染，内容与空行保留", (WidgetTester tester) async {
    const String code = "```ts\nconst a = 1;\n\nconsole.log(\"好了。\");\n```";
    final List<String> rendered = await pumpAndCollect(tester, code);
    expect(rendered.any((String s) => s.contains("```")), isFalse,
        reason: "围栏不得漏出：$rendered");
    final SelectableText body =
        tester.widget<SelectableText>(find.byType(SelectableText));
    final String plain =
        body.textSpan?.toPlainText() ?? body.data ?? "";
    expect(plain.contains("const a = 1;"), isTrue, reason: plain);
    expect(plain.contains("好了。"), isTrue, reason: plain);
    expect(plain.contains("\n\n"), isTrue, reason: "块内空行保留：$plain");
  });
}
