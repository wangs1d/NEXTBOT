import "dart:async";

import "package:flutter_test/flutter_test.dart";
import "package:nextbot/core/services/ws_event_router.dart";

/// WS 事件路由器（2026-11-10 单分发改造）单测。
///
/// 守护的核心不变量：**同一条业务事件只能有一个 owner**。
/// 之前两处分发器各写一份 `if (type == ...)`，改一处漏一处（normal/high/
/// critical 门槛就漏在手机分发器里）。归属表现在是唯一事实源，这里逐条钉住。
void main() {
  late WsEventRouter router;
  late List<String> rootTypes;
  late List<String> chatTypes;
  late List<StreamSubscription<Map<String, dynamic>>> subs;

  void collect() {
    rootTypes = <String>[];
    chatTypes = <String>[];
    subs = <StreamSubscription<Map<String, dynamic>>>[
      router.rootEvents.listen((e) => rootTypes.add(e["type"] as String)),
      router.chatEvents.listen((e) => chatTypes.add(e["type"] as String)),
    ];
  }

  Future<void> dispatchOne(String type) async {
    router.dispatch(<String, dynamic>{"type": type, "payload": <String, dynamic>{}});
    await Future<void>.delayed(Duration.zero);
  }

  setUp(() {
    router = WsEventRouter.instance;
  });

  tearDown(() async {
    for (final StreamSubscription<Map<String, dynamic>> s in subs) {
      await s.cancel();
    }
  });

  test("手机端：chatOnly 事件只进聊天通道，根分发器收不到", () async {
    router.bindPlatform(isMobile: true);
    collect();

    for (final String type in <String>[
      "agent.proactive_message",
      "reminder_popup",
      "agent.voice.alarm",
      "agent.location_request",
      "schedule.reminder_fired",
      "chat.assistant_done",
      "evening.digest",
      "card.update",
    ]) {
      await dispatchOne(type);
    }

    expect(rootTypes, isEmpty, reason: "chatOnly 事件不得再被根分发器处理（会重复落盘/双通知/双 ack）");
    expect(chatTypes.length, 8);
  });

  test("手机端：rootOnly 事件只进根通道（闹钟/浏览器/来电等全局动作）", () async {
    router.bindPlatform(isMobile: true);
    collect();

    for (final String type in <String>[
      "alarm.sync",
      "alarm.trigger",
      "reminder.deliver",
      "shared.browser.busy",
      "update.available",
      "inbox.message",
      "agent.phone.ringing_start",
    ]) {
      await dispatchOne(type);
    }

    expect(chatTypes, isEmpty);
    expect(rootTypes.length, 7);
  });

  test("手机端：both 事件两端各收一次（连接状态/工具进度）", () async {
    router.bindPlatform(isMobile: true);
    collect();

    await dispatchOne("ws_connected");
    await dispatchOne("ws_disconnected");
    await dispatchOne("connection_error");
    await dispatchOne("tool.call");
    await dispatchOne("tool.result");

    expect(rootTypes, <String>[
      "ws_connected",
      "ws_disconnected",
      "connection_error",
      "tool.call",
      "tool.result",
    ]);
    expect(chatTypes, rootTypes);
  });

  test("桌面端：chatOnly 回落根通道（桌面没有聊天控制器）", () async {
    router.bindPlatform(isMobile: false);
    collect();

    await dispatchOne("agent.proactive_message");
    await dispatchOne("chat.assistant_done");

    expect(rootTypes, <String>["agent.proactive_message", "chat.assistant_done"]);
    expect(chatTypes, isEmpty);
  });

  test("桌面端：both 只进根通道（不投无人订阅的 chat 通道）", () async {
    router.bindPlatform(isMobile: false);
    collect();

    await dispatchOne("ws_connected");
    await dispatchOne("tool.call");

    expect(rootTypes, <String>["ws_connected", "tool.call"]);
    expect(chatTypes, isEmpty);
  });

  test("未登记的事件默认 rootOnly（忘记登记不会丢事件）", () async {
    router.bindPlatform(isMobile: true);
    collect();

    await dispatchOne("brand.new.event");

    expect(rootTypes, <String>["brand.new.event"]);
    expect(chatTypes, isEmpty);
  });

  test("归属表自身完整性：不存在空 type / 重复登记冲突", () {
    for (final MapEntry<String, WsEventRoute> e in WsEventRouter.routes.entries) {
      expect(e.key.trim(), isNotEmpty);
      expect(e.key, e.key.trim(), reason: "事件名不得带空白：${e.key}");
      // rootOnly 是默认值，登记它等于冗余（容易让人误以为已经特殊处理）
      expect(e.value, isNot(WsEventRoute.rootOnly),
          reason: "\"${e.key}\" 无需登记 rootOnly，未登记即为 rootOnly");
    }
  });
}
