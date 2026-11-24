import "dart:io";

import "package:flutter/material.dart";
import "package:flutter_test/flutter_test.dart";
import "package:path_provider_platform_interface/path_provider_platform_interface.dart";

import "package:nextbot/core/config/api_config.dart";
import "package:nextbot/core/models/chat_models.dart";
import "package:nextbot/core/models/notify_action.dart";
import "package:nextbot/mobile_ui/mobile_chat_controller.dart";
import "package:nextbot/mobile_ui/mobile_chat_page.dart";

import "helpers/temp_path_provider.dart";
import "mobile_chat_intro_pacing_test.dart" show EmptyHistoryStoreForTest;

const NotifyAction kReply = NotifyAction(
  actionId: "chat.reply",
  label: "回复",
  token: "ai_reply_1.sig",
  kind: "input",
  inputLabel: "回一句",
);

const NotifyAction kAccept = NotifyAction(
  actionId: "proactivity.accept",
  label: "这就走",
  token: "ai_accept_1.sig",
);

HttpServer? wsServer;

void main() {
  setUp(() {
    PathProviderPlatform.instance = TempPathProviderPlatform();
  });

  setUpAll(() async {
    wsServer = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
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

  test("输入框提示语仍按规划会话和旁聊切换", () {
    expect(
      mobileComposerHint(planFlowActive: true, sideChatActive: true),
      "继续说，可补充或调整规划…",
    );
    expect(
      mobileComposerHint(planFlowActive: false, sideChatActive: true),
      "在这个旁聊里继续说…",
    );
    expect(
      mobileComposerHint(planFlowActive: false, sideChatActive: false),
      "发消息…",
    );
  });

  testWidgets("仅回复动作不再在聊天气泡里展示拍板卡", (
    WidgetTester tester,
  ) async {
    final _Harness h = _Harness(<NotifyAction>[kReply]);
    await h.pump(tester);

    expect(find.text("雨 20 分钟后停，晚 5 分钟出发正好不淋"), findsOneWidget);
    expect(find.text("需要你拍板"), findsNothing);
    expect(find.text("回复"), findsNothing);
    expect(find.text("发消息…"), findsOneWidget);

    await h.teardown(tester);
  });

  testWidgets("回复与确认动作都不再在聊天气泡里展示拍板卡", (
    WidgetTester tester,
  ) async {
    final _Harness h = _Harness(<NotifyAction>[kReply, kAccept]);
    await h.pump(tester);

    expect(find.text("雨 20 分钟后停，晚 5 分钟出发正好不淋"), findsOneWidget);
    expect(find.text("需要你拍板"), findsNothing);
    expect(find.text("回复"), findsNothing);
    expect(find.text("这就走"), findsNothing);
    expect(find.text("发消息…"), findsOneWidget);

    await h.teardown(tester);
  });
}

class _Harness {
  _Harness(List<NotifyAction> actions) {
    controller = MobileChatController(
      wsBaseUrl: "ws://127.0.0.1:${wsServer!.port}",
      historyStore: EmptyHistoryStoreForTest(),
    );
    controller.messages.add(
      ChatMessage(
        messageId: "assistant-pulse-1",
        sessionId: ApiConfig.effectiveActorId,
        role: "assistant",
        text: "雨 20 分钟后停，晚 5 分钟出发正好不淋",
        timestamp: DateTime(2026, 11, 24, 9),
        notifyActions: actions,
      ),
    );
  }

  late final MobileChatController controller;
  bool _down = false;

  Future<void> pump(WidgetTester tester) async {
    await tester.pumpWidget(MaterialApp(
      home: MobileChatPage(controller: controller),
    ));
    await tester.pump();
  }

  Future<void> teardown(WidgetTester tester) async {
    await tester.pumpWidget(const SizedBox.shrink());
    shutdown();
  }

  void shutdown() {
    if (_down) return;
    _down = true;
    controller.dispose();
  }
}
