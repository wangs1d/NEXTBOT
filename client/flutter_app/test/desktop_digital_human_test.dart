/// 桌面端数字人头像 + 专属面板回归（2026-11-27）。
///
/// 覆盖：
///  1. 桌面聊天页传 onOpenDigitalHuman 时渲染真实数字人模型人物 + 名字头部；
///  2. 未传回调（手机端路径）不渲染该头部；
///  3. 点击头部触发打开右侧面板回调；
///  4. 数字人面板裸展示人物本体（无底座/框）+ 换头像按钮（无名字/绿点/在线文案）；
///  5. 头像/面板只渲染模型本体，不嵌 WebView、不是 DG2 球；
///  6. RightPanelKind.digitalHuman 的默认分割比例已接线。
library;

import "package:flutter/material.dart";
import "package:flutter_test/flutter_test.dart";

import "package:nextbot/app/app_helpers.dart";
import "package:nextbot/core/models/chat_models.dart";
import "package:nextbot/core/services/agent_name_store.dart";
import "package:nextbot/features/chat/chat_page.dart";
import "package:nextbot/features/chat/desktop_digital_human_header.dart";
import "package:nextbot/features/chat/digital_human_avatar_visual.dart";
import "package:nextbot/features/chat/digital_human_panel.dart";
import "package:nextbot/features/chat/digital_human_view.dart";
import "package:nextbot/features/chat/digital_human_live_view.dart";

Widget _hostChatPage({
  required VoidCallback? onOpenDigitalHuman,
}) {
  return MaterialApp(
    home: Scaffold(
      body: ChatPage(
        messages: const <ChatMessage>[],
        controller: TextEditingController(),
        onSend: () {},
        agentName: "Muse",
        onOpenDigitalHuman: onOpenDigitalHuman,
      ),
    ),
  );
}

void main() {
  setUp(() {
    AgentNameStore.instance.clear();
    // 测试环境不连本地推流（8765 可能真的在跑），只用静态兜底图。
    DigitalHumanLiveView.globallyEnabled = false;
  });
  tearDown(() => AgentNameStore.instance.clear());

  test("RightPanelKind.digitalHuman 已接线默认比例", () {
    final double ratio = RightPanelKind.digitalHuman.defaultSplitRatio;
    expect(ratio, greaterThan(0.1));
    expect(ratio, lessThan(0.9));
  });

  testWidgets("桌面 ChatPage 传回调时渲染数字人模型人物，点击触发回调",
      (WidgetTester tester) async {
    int taps = 0;
    AgentNameStore.instance.set("Muse");
    await tester.pumpWidget(
      _hostChatPage(onOpenDigitalHuman: () => taps++),
    );
    await tester.pump();

    expect(find.byType(DesktopDigitalHumanHeader), findsOneWidget);
    expect(find.text("Muse"), findsWidgets);
    expect(find.byKey(const ValueKey<String>("desktop-dh-mini")), findsOneWidget);
    expect(find.descendant(
      of: find.byType(DesktopDigitalHumanHeader),
      matching: find.byType(DigitalHumanAvatarVisual),
    ), findsOneWidget);
    // 只放模型人物本体：不能有浏览器视图，也不能是 DG2 球。
    expect(find.descendant(
      of: find.byType(DesktopDigitalHumanHeader),
      matching: find.byType(DigitalHumanView),
    ), findsNothing);

    await tester.tap(find.byType(DesktopDigitalHumanHeader));
    await tester.pump();
    expect(taps, 1);
  });

  testWidgets("未传 onOpenDigitalHuman（手机端路径）不渲染头像头部",
      (WidgetTester tester) async {
    await tester.pumpWidget(_hostChatPage(onOpenDigitalHuman: null));
    await tester.pump();

    expect(find.byType(DesktopDigitalHumanHeader), findsNothing);
    expect(find.byKey(const ValueKey<String>("desktop-dh-mini")), findsNothing);
  });

  testWidgets("数字人面板只留人物舞台 + 换头像按钮", (WidgetTester tester) async {
    AgentNameStore.instance.set("Muse");
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: DigitalHumanPanel(agentName: "Muse"),
        ),
      ),
    );
    await tester.pump();

    // 面板文案全部删除：无名字、无绿点、无「在线 · 可对话」。
    expect(find.text("Muse"), findsNothing);
    expect(find.text("在线 · 可对话"), findsNothing);
    expect(find.text("换头像"), findsOneWidget);
    expect(find.descendant(
      of: find.byType(DigitalHumanPanel),
      matching: find.byType(DigitalHumanAvatarVisual),
    ), findsOneWidget);
    // 裸展示：面板内不带任何圆形底座/裁剪框。
    expect(find.descendant(
      of: find.byType(DigitalHumanPanel),
      matching: find.byType(ClipOval),
    ), findsNothing);
    expect(find.byType(DigitalHumanView), findsNothing);
  });

  testWidgets("名字为空时头部仍渲染数字人形象但隐藏名字",
      (WidgetTester tester) async {
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: DesktopDigitalHumanHeader(
            agentName: "  ",
            onTap: () {},
          ),
        ),
      ),
    );
    await tester.pump();

    expect(find.byType(DesktopDigitalHumanHeader), findsOneWidget);
    expect(find.byKey(const ValueKey<String>("desktop-dh-mini")), findsOneWidget);
    expect(find.text("  "), findsNothing);
  });
}
