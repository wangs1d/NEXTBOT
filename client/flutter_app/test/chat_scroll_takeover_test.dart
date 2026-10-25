import "package:flutter/foundation.dart";
import "package:flutter/gestures.dart";
import "package:flutter/material.dart";
import "package:flutter_test/flutter_test.dart";

import "package:nextbot/core/models/chat_models.dart";
import "package:nextbot/core/models/turn_state.dart";
import "package:nextbot/features/chat/chat_page.dart";

/// 回归：用户在「离底部 24–100px」这段窗口接管视图时（滚轮、触控板、右侧滚动
/// 条滑块最常停的位置），流式跟底不得再把视图拽回底部。
/// 旧实现只把 pixels>100 当作「用户已上滑」，这段窗口内每条 SSE 都会
/// `animateTo(0)`，与指针输入互相拉扯 → 表现为「拖动不稳定、不跟手」。
ChatMessage _agent(String id, String text) => ChatMessage(
      messageId: id,
      sessionId: "s1",
      role: "agent",
      text: text,
      timestamp: DateTime(2026, 10, 24, 10, 0),
    );

List<ChatMessage> _history(int count) => <ChatMessage>[
      for (int i = 0; i < count; i++)
        _agent("m-$i", "第 $i 条历史消息内容。" * 6),
    ];

Widget _host(List<ChatMessage> messages, {required bool processing}) {
  return MaterialApp(
    home: Scaffold(
      body: ChatPage(
        messages: messages,
        controller: TextEditingController(),
        onSend: () {},
        isAgentProcessing: processing,
      ),
    ),
  );
}

/// 聊天列表自己的滚动位置：reverse=true 的垂直列表 axisDirection 为 up，
/// 可据此排除气泡内横向轮播等嵌套滚动视图。
ScrollPosition _listPosition(WidgetTester tester) {
  final Iterable<ScrollableState> all =
      tester.stateList<ScrollableState>(find.byType(Scrollable));
  return all.map((ScrollableState s) => s.position).firstWhere(
        (ScrollPosition p) => p.axisDirection == AxisDirection.up,
        orElse: () => throw StateError("找不到 reverse=true 的聊天列表"),
      );
}

/// 末条消息文本变长（流式增量）
List<ChatMessage> _grown(List<ChatMessage> base, int round) {
  final ChatMessage last = base.last;
  return <ChatMessage>[
    ...base.sublist(0, base.length - 1),
    _agent(last.messageId, '${last.text}追加输出 $round。'),
  ];
}

/// 多来一条 agent 消息（条数变化路径）
List<ChatMessage> _appended(List<ChatMessage> base) =>
    <ChatMessage>[...base, _agent("m-new", "Agent 的新一条发言。")];

Future<void> _settle(WidgetTester tester) async {
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 260));
}

void main() {
  testWidgets("触控板上滑到 24–100px 窗口后，流式分片不抢滚动",
      (WidgetTester tester) async {
    final List<ChatMessage> base = _history(30);
    await tester.pumpWidget(_host(base, processing: true));
    await tester.pump();
    expect(_listPosition(tester).maxScrollExtent, greaterThan(300));

    // reverse 列表向下拖＝远离底部；60px 落在旧实现的盲区（<100px）
    await tester.dragFrom(
      tester.getCenter(find.byType(ListView)),
      const Offset(0, 60),
      kind: PointerDeviceKind.trackpad,
    );
    await tester.pump();
    final double held = _listPosition(tester).pixels;
    expect(held, inInclusiveRange(24, 100), reason: "需要停在必被拽走的盲区");

    for (int i = 0; i < 3; i++) {
      await tester.pumpWidget(_host(_grown(base, i), processing: true));
      await _settle(tester);
      expect(_listPosition(tester).pixels, closeTo(held, 2),
          reason: "第 $i 个流式分片把视图从用户手上抢走了");
    }
  });

  testWidgets("滚动条滑块跳到 24–100px 后，流式分片不抢滚动",
      (WidgetTester tester) async {
    final List<ChatMessage> base = _history(30);
    await tester.pumpWidget(_host(base, processing: true));
    await tester.pump();

    // RawScrollbar 拖滑块内部就是 position.jumpTo
    _listPosition(tester).jumpTo(60);
    await tester.pump();
    expect(_listPosition(tester).pixels, closeTo(60, 2));

    for (int i = 0; i < 3; i++) {
      await tester.pumpWidget(_host(_grown(base, i), processing: true));
      await _settle(tester);
      expect(_listPosition(tester).pixels, closeTo(60, 2),
          reason: "第 $i 个流式分片打断了滑块拖拽");
    }
  });

  testWidgets("盲区内新增 agent 消息不跳底", (WidgetTester tester) async {
    final List<ChatMessage> base = _history(30);
    await tester.pumpWidget(_host(base, processing: true));
    await tester.pump();
    _listPosition(tester).jumpTo(60);
    await tester.pump();

    await tester.pumpWidget(_host(_appended(base), processing: true));
    await _settle(tester);
    expect(_listPosition(tester).pixels, closeTo(60, 2));
  });

  testWidgets("贴底且未接管时仍然自动跟底（不被新逻辑误伤）",
      (WidgetTester tester) async {
    final List<ChatMessage> base = _history(30);
    await tester.pumpWidget(_host(base, processing: true));
    await tester.pump();
    expect(_listPosition(tester).pixels, lessThanOrEqualTo(1));

    for (int i = 0; i < 3; i++) {
      await tester.pumpWidget(_host(_grown(base, i), processing: true));
      await _settle(tester);
      expect(_listPosition(tester).pixels, lessThanOrEqualTo(1),
          reason: "贴底时应该继续跟住最新消息");
    }
  });

  testWidgets("滚回贴底区后交还控制权，跟底恢复", (WidgetTester tester) async {
    final List<ChatMessage> base = _history(30);
    await tester.pumpWidget(_host(base, processing: true));
    await tester.pump();

    _listPosition(tester).jumpTo(400);
    await tester.pump();
    await tester.pumpWidget(_host(_grown(base, 0), processing: true));
    await _settle(tester);
    expect(_listPosition(tester).pixels, closeTo(400, 2), reason: "接管期间不跳底");

    // 用户自己滚回底部 → 之后的流式分片重新跟住
    _listPosition(tester).jumpTo(0);
    await tester.pump();
    await tester.pumpWidget(_host(_grown(base, 1), processing: true));
    await _settle(tester);
    expect(_listPosition(tester).pixels, lessThanOrEqualTo(1));
  });

  testWidgets("拖动滑块途中布局变化（计划卡出现），内容位移仍按指针走",
      (WidgetTester tester) async {
    // 桌面端滚动条由 MaterialScrollBehavior 自动加，需切到 Windows 平台
    debugDefaultTargetPlatformOverride = TargetPlatform.windows;
    try {
      // 高度参差的历史消息，贴近真实聊天
      final List<ChatMessage> base = <ChatMessage>[
        for (int i = 0; i < 40; i++)
          _agent("m-$i", i.isEven ? "短句 $i" : "长段落内容。" * (6 + i % 7)),
      ];
      Widget host({bool busy = false}) => MaterialApp(
            home: Scaffold(
              body: ChatPage(
                messages: base,
                controller: TextEditingController(),
                onSend: () {},
                isAgentProcessing: busy,
                agentStatusLine: busy ? "正在检索资料" : null,
                planSteps: busy
                    ? <TurnPlanStep>[
                        TurnPlanStep(
                            id: "s1",
                            title: "第一步",
                            status: TurnStepStatus.pending),
                      ]
                    : const <TurnPlanStep>[],
              ),
            ),
          );

      await tester.pumpWidget(host());
      await tester.pump();
      ScrollPosition p = _listPosition(tester);
      p.jumpTo(p.maxScrollExtent / 2);
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 400));
      p = _listPosition(tester);

      final Rect listRect =
          tester.getRect(find.byWidgetPredicate((Widget w) => w is ListView));
      final double viewportBefore = p.viewportDimension;
      final TestGesture gesture = await tester.startGesture(
        Offset(listRect.right - 6, listRect.center.dy),
        kind: PointerDeviceKind.mouse,
      );
      await tester.pump(const Duration(milliseconds: 20));

      double last = p.pixels;
      final List<double> steps = <double>[];
      for (int i = 1; i <= 6; i++) {
        if (i == 3) {
          // 拖动进行中：状态条 + 计划卡出现，列表视口被压矮、总高估算同步变大
          await tester.pumpWidget(host(busy: true));
          await tester.pump();
          last = _listPosition(tester).pixels;
        }
        await gesture.moveBy(const Offset(0, -20));
        await tester.pump(const Duration(milliseconds: 16));
        final ScrollPosition q = _listPosition(tester);
        steps.add(q.pixels - last);
        last = q.pixels;
      }
      await gesture.up();
      await tester.pump(const Duration(milliseconds: 100));

      // 确认场景有效：视口真的在拖动途中变了，否则测不到映射重算
      expect(_listPosition(tester).viewportDimension,
          lessThan(viewportBefore - 50));

      final double first = steps.first;
      for (int i = 0; i < steps.length; i++) {
        expect(steps[i], closeTo(first, first * 0.15),
            reason: "第 ${i + 1} 步位移偏离首步，滑块映射在拖动中被重算了");
      }
    } finally {
      debugDefaultTargetPlatformOverride = null;
    }
  });
}
