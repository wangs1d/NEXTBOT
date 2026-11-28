/// 离线 push 写穿（2026-11-26 P3 验收）：透传帧按服务端 messageId 落泡，
/// 已存在的同一条不再插双份；card.update / 看板帧不会把状态包误落成文本气泡。
library;

import "dart:convert";
import "dart:io";

import "package:flutter_test/flutter_test.dart";

import "package:nextbot/core/config/api_config.dart";
import "package:nextbot/core/models/chat_models.dart";
import "package:nextbot/mobile_ui/mobile_chat_controller.dart";

import "mobile_chat_intro_pacing_test.dart" show EmptyHistoryStoreForTest;

class _PreloadedStore extends EmptyHistoryStoreForTest {
  _PreloadedStore(this.preloaded);
  final List<ChatMessage> preloaded;

  @override
  Future<List<ChatMessage>> listMessages(String sessionId) async =>
      preloaded.where((ChatMessage m) => m.sessionId == sessionId).toList();
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
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
  });

  Future<MobileChatController> newController(
      {List<ChatMessage> preloaded = const []}) async {
    final MobileChatController c = MobileChatController(
      wsBaseUrl: "ws://127.0.0.1:${wsServer!.port}",
      historyStore: _PreloadedStore(preloaded),
    );
    for (int i = 0; i < 100 && !c.debugHistoryReady; i++) {
      await Future<void>.delayed(const Duration(milliseconds: 5));
    }
    return c;
  }

  Map<String, dynamic> pushedDone({
    required String messageId,
    required String text,
    required String stableKey,
  }) {
    final String wire = jsonEncode(<String, dynamic>{
      "type": "chat.assistant_done",
      "payload": <String, dynamic>{
        "sessionId": ApiConfig.effectiveActorId,
        "messageId": messageId,
        "traceId": messageId.replaceFirst("assistant-", ""),
        "finalText": text,
      },
    });
    return <String, dynamic>{
      "type": "chat.assistant_done",
      "body": text,
      "text": text,
      "stableKey": stableKey,
      "deliveryId": stableKey,
      "ts": 1760000000000,
      "wire": wire,
    };
  }

  test("透传帧用服务端 messageId 落泡，历史已有的同一条不再重复", () async {
    final ChatMessage existing = ChatMessage(
      messageId: "assistant-t1",
      sessionId: ApiConfig.effectiveActorId,
      role: "assistant",
      text: "行程已经订好了",
      timestamp: DateTime.fromMillisecondsSinceEpoch(1760000000000),
    );
    final MobileChatController c =
        await newController(preloaded: <ChatMessage>[existing]);
    addTearDown(c.dispose);

    c.ingestPushedMessages(<Map<String, dynamic>>[
      pushedDone(
        messageId: "assistant-t1",
        text: "行程已经订好了",
        stableKey: "d_1",
      ),
    ]);
    expect(
        c.messages
            .where((ChatMessage m) => m.messageId == "assistant-t1")
            .length,
        1);

    c.ingestPushedMessages(<Map<String, dynamic>>[
      pushedDone(
          messageId: "assistant-t2", text: "another one", stableKey: "d_2"),
    ]);
    expect(c.messages.any((ChatMessage m) => m.messageId == "assistant-t2"),
        isTrue);
  });

  Map<String, dynamic> pushedDigest({required String messageId}) {
    final Map<String, dynamic> digest = <String, dynamic>{
      "date": "2026-11-28",
      "tomorrowWeather": <String, dynamic>{
        "text": "小雨",
        "minC": 15,
        "maxC": 19,
        "alerts": <String>[],
      },
      "narrationText": "明天有小雨，记得带伞。",
    };
    return <String, dynamic>{
      "type": "evening.digest",
      "body": "明天有小雨，记得带伞。",
      "stableKey": messageId,
      "deliveryId": messageId,
      "ts": 1760000000000,
      "wire": jsonEncode(<String, dynamic>{
        "type": "evening.digest",
        "payload": <String, dynamic>{
          "sessionId": ApiConfig.effectiveActorId,
          "messageId": messageId,
          "ts": 1760000000000,
          "narrationText": "明天有小雨，记得带伞。",
          "digest": digest,
        },
      }),
    };
  }

  test("明日预览透传恢复结构化卡片，同一 messageId 不重复落泡", () async {
    final MobileChatController c = await newController();
    addTearDown(c.dispose);
    final Map<String, dynamic> item =
        pushedDigest(messageId: "evening-digest-2026-11-28");

    c.ingestPushedMessages(<Map<String, dynamic>>[item]);
    c.ingestPushedMessages(<Map<String, dynamic>>[item]);

    final List<ChatMessage> cards = c.messages
        .where((ChatMessage m) => m.messageId == "evening-digest-2026-11-28")
        .toList();
    expect(cards.length, 1);
    expect(cards.single.contentType, "evening_digest");
    expect(cards.single.eveningDigest?["date"], "2026-11-28");
  });

  test("已有同 id 文本泡被明日预览透传升级为卡片，不新增第二条", () async {
    final ChatMessage existing = ChatMessage(
      messageId: "evening-digest-2026-11-28",
      sessionId: ApiConfig.effectiveActorId,
      role: "assistant",
      text: "明天有小雨，记得带伞。",
      timestamp: DateTime.fromMillisecondsSinceEpoch(1760000000000),
    );
    final MobileChatController c =
        await newController(preloaded: <ChatMessage>[existing]);
    addTearDown(c.dispose);

    c.ingestPushedMessages(<Map<String, dynamic>>[
      pushedDigest(messageId: "evening-digest-2026-11-28"),
    ]);

    final List<ChatMessage> cards = c.messages
        .where((ChatMessage m) => m.messageId == "evening-digest-2026-11-28")
        .toList();
    expect(cards.length, 1);
    expect(cards.single.contentType, "evening_digest");
  });

  test("card.update / agent.today_board 透传不会落成文本气泡", () async {
    final MobileChatController c = await newController();
    addTearDown(c.dispose);

    c.ingestPushedMessages(<Map<String, dynamic>>[
      <String, dynamic>{
        "type": "card.update",
        "body": "一张卡片已更新",
        "stableKey": "card-1",
        "wire": jsonEncode(<String, dynamic>{
          "type": "card.update",
          "payload": <String, dynamic>{
            "messageId": "assistant-missing",
            "card": <String, dynamic>{"cardType": "booking"},
          },
        }),
      },
      <String, dynamic>{
        "type": "agent.today_board",
        "body": "管家在",
        "stableKey": "board-1",
        "wire": jsonEncode(<String, dynamic>{
          "type": "agent.today_board",
          "payload": <String, dynamic>{
            "ok": true,
            "title": "今日状态",
            "text": "管家在"
          },
        }),
      },
    ]);
    expect(c.messages.any((ChatMessage m) => m.text == "一张卡片已更新"), isFalse);
    expect(c.messages.any((ChatMessage m) => m.text == "管家在"), isFalse);
  });
}
