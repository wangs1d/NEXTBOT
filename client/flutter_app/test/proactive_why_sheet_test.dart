/// 主动消息「为什么是现在」长按面板（需求 §3.10 可解释）的纯逻辑链：
/// WS 载荷 `why` → ChatMessage.why → 面板文案。
///
/// 覆盖三段（真机长按手势本身不在此列）：
/// - agent.proactive_message 载荷带 why → 气泡消息模型带同一句话；缺省 → null；
/// - proactiveWhyLine：普通消息 / 空白 why 一律不弹面板；
/// - 面板 widget：标题、那句人话、「以后少一点」动作行与回调。
library;

import "dart:io";

import "package:flutter/material.dart";
import "package:flutter_test/flutter_test.dart";

import "package:nextbot/core/models/chat_models.dart";
import "package:nextbot/mobile_ui/mobile_chat_controller.dart";
import "package:nextbot/mobile_ui/mobile_theme.dart";
import "package:nextbot/mobile_ui/proactive_why_sheet.dart";

import "mobile_chat_intro_pacing_test.dart" show EmptyHistoryStoreForTest;

void main() {
  HttpServer? wsServer;

  setUpAll(() async {
    wsServer = await HttpServer.bind("127.0.0.1", 0);
    wsServer!.listen((HttpRequest req) async {
      if (WebSocketTransformer.isUpgradeRequest(req)) {
        final WebSocket ws = await WebSocketTransformer.upgrade(req);
        ws.listen((_) {});
      } else {
        await req.response.close();
      }
    });
  });

  tearDownAll(() async {
    await wsServer?.close(force: true);
    wsServer = null;
  });

  String wsUrl() => "ws://127.0.0.1:${wsServer!.port}";

  ChatMessage deliver(EmptyHistoryStoreForTest store, Map<String, dynamic> payload) {
    final MobileChatController c = MobileChatController(
        wsBaseUrl: wsUrl(), historyStore: store);
    addTearDown(c.dispose);
    c.debugHandleWsEvent(<String, dynamic>{
      "type": "agent.proactive_message",
      "payload": payload,
    });
    return c.messages.last;
  }

  group("载荷 → 消息模型", () {
    test("payload.why 落到 ChatMessage.why（长按面板的唯一数据源）", () {
      final ChatMessage m = deliver(EmptyHistoryStoreForTest(), <String, dynamic>{
        "title": "提醒",
        "text": "出门记得带伞",
        "kind": "weather_alert",
        "why": "天气有变化，怕你出门吃亏。",
      });
      expect(m.text, "出门记得带伞");
      expect(m.why, "天气有变化，怕你出门吃亏。");
      expect(proactiveWhyLine(m), "天气有变化，怕你出门吃亏。");
    });

    test("载荷没带 why：字段为空串，长按保持无害", () {
      final ChatMessage m = deliver(EmptyHistoryStoreForTest(), <String, dynamic>{
        "title": "提醒",
        "text": "该睡觉啦",
        "kind": "schedule_reminder",
      });
      expect(m.why, isNull);
      expect(proactiveWhyLine(m), isNull);
    });

    test("copyWith 全字段保留时 why 不丢（card.update 等原地重写路径）", () {
      final ChatMessage m = ChatMessage(
        messageId: "a1",
        sessionId: "s",
        role: "assistant",
        text: "x",
        timestamp: DateTime(2026, 11, 23),
        why: "你设的 11:10 提醒时间到了。",
      );
      expect(m.copyWith(text: "y").why, "你设的 11:10 提醒时间到了。");
    });

    test("纯空白 why 视为没有", () {
      final ChatMessage m = ChatMessage(
        messageId: "a1",
        sessionId: "s",
        role: "assistant",
        text: "x",
        timestamp: DateTime(2026, 11, 23),
        why: "   ",
      );
      expect(proactiveWhyLine(m), isNull);
    });
  });

  group("长按面板文案", () {
    testWidgets("展示标题 + 那句人话 + 「以后少一点」，点动作行回调并收面板",
        (WidgetTester tester) async {
      int opened = 0;
      await tester.pumpWidget(
        MaterialApp(
          theme: MobileTheme.light,
          home: Builder(
            builder: (BuildContext context) => Scaffold(
              body: Center(
                child: ElevatedButton(
                  onPressed: () => showProactiveWhySheet(
                    context,
                    why: "早上要办的事排到 13:00，午间并成一条。",
                    onOpenFrequencySettings: () => opened++,
                  ),
                  child: const Text("open"),
                ),
              ),
            ),
          ),
        ),
      );
      await tester.tap(find.text("open"));
      await tester.pumpAndSettle();

      expect(find.text(kProactiveWhyTitle), findsOneWidget);
      expect(find.text("早上要办的事排到 13:00，午间并成一条。"), findsOneWidget);
      expect(find.text(kProactiveWhyLessOften), findsOneWidget);
      expect(find.text(kProactiveWhyLessOftenHint), findsOneWidget);

      await tester.tap(find.text(kProactiveWhyLessOften));
      await tester.pumpAndSettle();
      expect(opened, 1, reason: "动作行必须先收面板再把用户送去既有频率档设置");
      expect(find.text(kProactiveWhyTitle), findsNothing);
    });
  });
}
