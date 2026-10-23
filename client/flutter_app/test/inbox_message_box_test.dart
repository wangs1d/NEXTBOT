import "package:flutter/material.dart";
import "package:flutter_test/flutter_test.dart";

import "package:nextbot/features/mailbox/inbox_message_box.dart";

void main() {
  testWidgets("站内信消息框浮层：锚定渲染不溢出，头部可见", (WidgetTester tester) async {
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: Builder(
            builder: (BuildContext context) => Center(
              child: ElevatedButton(
                onPressed: () {
                  // 模拟头像按钮锚点：屏幕底部左侧（侧栏底部头像位置）
                  InboxMessageBox.show(
                    context,
                    anchor: const Rect.fromLTWH(10, 740, 40, 40),
                  );
                },
                child: const Text("open"),
              ),
            ),
          ),
        ),
      ),
    );

    await tester.tap(find.text("open"));
    // 只 pump 有限帧：消息框会发起真实网络拉取（测试环境失败即走错误态），
    // 不用 pumpAndSettle 以免被网络等待卡住。
    await tester.pump(const Duration(milliseconds: 100));
    await tester.pump(const Duration(milliseconds: 100));

    // 头部标题必然已渲染（加载/错误/空态都在头部之下）
    expect(find.text("站内信"), findsOneWidget);
    // 关闭按钮存在
    expect(find.byTooltip("关闭"), findsOneWidget);
  });
}
