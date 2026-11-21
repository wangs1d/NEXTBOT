import "dart:io";

import "package:flutter_test/flutter_test.dart";
import "package:nextbot/core/db/local_history_store.dart";
import "package:nextbot/core/models/chat_models.dart";
import "package:nextbot/mobile_ui/mobile_chat_controller.dart";

/// 空历史存储：不碰本机共享 Isar（共享库会残留旧消息，污染断言）。
class _EmptyHistoryStore implements LocalHistoryStore {
  @override
  dynamic noSuchMethod(Invocation invocation) {
    final dynamic member = invocation.memberName;
    if (member == #listSessions) {
      return Future<List<ChatSession>>.value(<ChatSession>[]);
    }
    if (member == #listMessages) {
      return Future<List<ChatMessage>>.value(<ChatMessage>[]);
    }
    if (member == #listPendingUserMessages) {
      return Future<List<Map<String, dynamic>>>.value(<Map<String, dynamic>>[]);
    }
    if (member == #migrateAssistantTimestampFrames) {
      return Future<int>.value(0);
    }
    if (member == #init ||
        member == #saveSession ||
        member == #saveMessage ||
        member == #deleteMessage ||
        member == #deleteMessagesForSession ||
        member == #clearAllMessages ||
        member == #savePreference) {
      return Future<void>.value();
    }
    if (member == #getPreference) {
      return Future<dynamic>.value(null);
    }
    return null;
  }
}

HttpServer? _wsServer;

void main() {
  setUpAll(() async {
    _wsServer = await HttpServer.bind("127.0.0.1", 0);
    _wsServer!.listen((HttpRequest req) async {
      if (WebSocketTransformer.isUpgradeRequest(req)) {
        final WebSocket ws = await WebSocketTransformer.upgrade(req);
        ws.listen((_) {});
      } else {
        await req.response.close();
      }
    });
  });

  tearDownAll(() async {
    await _wsServer?.close(force: true);
    _wsServer = null;
  });

  Future<MobileChatController> newController() async {
    final MobileChatController controller = MobileChatController(
      wsBaseUrl: "ws://127.0.0.1:${_wsServer!.port}",
      historyStore: _EmptyHistoryStore(),
    );
    await pumpEventQueue();
    return controller;
  }

  test("agent.shopping_auto_ready：自动比价结果卡落一条完整 assistant 消息", () async {
    final MobileChatController controller = await newController();
    addTearDown(controller.dispose);

    final Map<String, dynamic> card = <String, dynamic>{
      "title": "比价好了",
      "items": <dynamic>[],
      "cardType": "price_compare",
      "extra": <String, dynamic>{
        "shopping": <String, dynamic>{"items": <dynamic>[]},
      },
    };
    final int before = controller.messages.length;

    controller.debugHandleWsEvent(<String, dynamic>{
      "type": "agent.shopping_auto_ready",
      "payload": <String, dynamic>{
        "title": "比价好了",
        "text": "登录搞定，价格帮你比好了——",
        "card": card,
        "messageId": "shopping-auto-test-1",
      },
    });

    expect(controller.messages.length, before + 1, reason: "应新增一条助手消息");
    final ChatMessage last = controller.messages.last;
    expect(last.role, "assistant");
    expect(last.messageId, "shopping-auto-test-1");
    expect(last.text, contains("登录搞定"));
    expect(last.text, contains("[AGENT_RESULT_CARD_START]"), reason: "卡标记块要进正文，历史回放/复制才一致");
    expect(last.envelopeBlocks, isNotNull);
    expect(last.envelopeBlocks!.length, 1);
    expect(last.envelopeBlocks!.first["type"], "card");
    expect((last.envelopeBlocks!.first["card"] as Map)["cardType"], "price_compare");
  });

  test("agent.shopping_auto_ready：card 缺失时静默丢弃，不落空白泡", () async {
    final MobileChatController controller = await newController();
    addTearDown(controller.dispose);

    final int before = controller.messages.length;
    controller.debugHandleWsEvent(<String, dynamic>{
      "type": "agent.shopping_auto_ready",
      "payload": <String, dynamic>{"text": "有消息但没卡"},
    });
    expect(controller.messages.length, before, reason: "没有 card 不应落消息");
  });
}
