import "package:flutter/material.dart";
import "package:flutter_test/flutter_test.dart";

import "package:nextbot/features/chat/chat_page.dart";
import "package:nextbot/features/chat/composer_skill.dart";

const ComposerSkill _detailSkill = ComposerSkill(
  id: "price_compare",
  label: "商品比价",
  icon: Icons.price_check_rounded,
  hint: "贴商品名或链接",
  prompt: "帮我比价这个商品：",
);

const ComposerSkill _instantSkill = ComposerSkill(
  id: "news_today",
  label: "今日要闻",
  icon: Icons.newspaper_rounded,
  hint: "直接发送即可",
  prompt: "查一下今天的重要新闻",
  detailRequired: false,
);

Widget _host({
  required ComposerSkill? skill,
  VoidCallback? onSend,
  VoidCallback? onClear,
}) {
  return MaterialApp(
    home: Scaffold(
      body: ChatPage(
        messages: const [],
        controller: TextEditingController(),
        onSend: onSend ?? () {},
        composerSkill: skill,
        onClearComposerSkill: onClear,
      ),
    ),
  );
}

bool _sendEnabled(WidgetTester tester) {
  final IconButton button = tester.widget<IconButton>(
    find.descendant(
      of: find.byKey(const ValueKey('input-send-btn')),
      matching: find.byType(IconButton),
    ),
  );
  return button.onPressed != null;
}

void main() {
  group("ComposerSkill.compose", () {
    test("补了参数：技能指令 + 冒号 + 用户输入", () {
      expect(_detailSkill.compose("AirPods Pro 2"), "帮我比价这个商品：AirPods Pro 2");
    });

    test("没补参数：只发技能指令", () {
      expect(_instantSkill.compose("  "), "查一下今天的重要新闻");
    });
  });

  testWidgets("挂上技能后输入框出现胶囊与占位提示", (WidgetTester tester) async {
    await tester.pumpWidget(_host(skill: _detailSkill));
    await tester.pump();

    expect(find.byKey(const ValueKey('composer-skill-pill')), findsOneWidget);
    expect(find.text("商品比价"), findsOneWidget);
    expect(find.text("贴商品名或链接"), findsOneWidget);
  });

  testWidgets("需要补参数的技能：输入为空时发送按钮不可点", (WidgetTester tester) async {
    await tester.pumpWidget(_host(skill: _detailSkill));
    await tester.pump();

    expect(_sendEnabled(tester), isFalse);
  });

  testWidgets("免参数技能：输入为空也能直接发送", (WidgetTester tester) async {
    int sent = 0;
    await tester.pumpWidget(_host(skill: _instantSkill, onSend: () => sent++));
    await tester.pump();

    expect(_sendEnabled(tester), isTrue);
    await tester.tap(find.byKey(const ValueKey('input-send-btn')));
    await tester.pump();
    expect(sent, 1);
  });

  testWidgets("点胶囊上的 × 摘掉技能", (WidgetTester tester) async {
    int cleared = 0;
    await tester.pumpWidget(_host(skill: _detailSkill, onClear: () => cleared++));
    await tester.pump();

    await tester.tap(find.descendant(
      of: find.byKey(const ValueKey('composer-skill-pill')),
      matching: find.byIcon(Icons.close_rounded),
    ));
    await tester.pump();
    expect(cleared, 1);
  });

  testWidgets("没挂技能时不渲染胶囊", (WidgetTester tester) async {
    await tester.pumpWidget(_host(skill: null));
    await tester.pump();

    expect(find.byKey(const ValueKey('composer-skill-pill')), findsNothing);
  });
}
