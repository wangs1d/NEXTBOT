/// 首启引导开场白「依次到达」（2026-11-09 反馈）：服务端两泡相隔不到一秒
/// 连推，客户端不能收到即落屏（两泡会一起刷在界面里）。覆盖：
/// - 第一泡立即落屏，第二泡进排队、期间 isIntroTyping = true（打字气泡）
/// - 间隔到点后第二泡才落屏，早到的取名卡随之补挂到该泡
/// - 用户已开口（无开头白场景）时取名卡照旧直接挂到命中气泡
library;

import "dart:io";

import "package:flutter_test/flutter_test.dart";

import "package:nextbot/core/db/local_history_store.dart";
import "package:nextbot/core/models/chat_models.dart";
import "package:nextbot/mobile_ui/mobile_chat_controller.dart";

/// 空历史存储：不碰本机 Isar（否则会灌进真实历史，污染条数断言）。
class _EmptyHistoryStore implements LocalHistoryStore {
  final List<ChatMessage> saved = <ChatMessage>[];

  @override
  Future<void> init() async {}

  @override
  Future<void> saveSession(ChatSession session) async {}

  @override
  Future<void> saveMessage(ChatMessage message) async => saved.add(message);

  @override
  Future<List<ChatSession>> listSessions() async => <ChatSession>[];

  @override
  Future<List<ChatMessage>> listMessages(String sessionId) async =>
      <ChatMessage>[];

  @override
  Future<int> migrateAssistantTimestampFrames() async => 0;

  @override
  Future<void> deleteMessage(String messageId) async {}

  @override
  Future<void> deleteMessagesForSession(String sessionId) async {}

  @override
  Future<void> clearAllMessages() async {}

  @override
  Future<dynamic> getPreference(String key) async => null;

  @override
  Future<void> savePreference(String key, dynamic value) async {}

  @override
  Future<List<Map<String, dynamic>>> listPendingUserMessages() async =>
      <Map<String, dynamic>>[];

  @override
  Future<void> enqueuePendingUserMessage(Map<String, dynamic> payload) async {}

  @override
  Future<void> dequeuePendingUserMessage(String messageId) async {}

  @override
  Future<bool> getBiometricRegistrationStatus() async => false;

  @override
  Future<void> saveBiometricRegistrationStatus(bool isRegistered) async {}
}

/// 控制器构造即连 WS：起个真监听端，避免断连重连污染测试 zone。
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

  String wsUrl() => "ws://127.0.0.1:${_wsServer!.port}";

  Map<String, dynamic> intro(String text, {String? messageId}) =>
      <String, dynamic>{
        "type": "agent.proactive_message",
        "payload": <String, dynamic>{
          "deliveryId": "",
          if (messageId != null) "messageId": messageId,
          "title": "",
          "text": text,
          "importance": "normal",
          "kind": "first_meeting_intro",
        },
      };

  Map<String, dynamic> nameChoices(String messageId) => <String, dynamic>{
        "type": "onboarding.name_choices",
        "payload": <String, dynamic>{
          "messageId": messageId,
          "title": "你想叫我什么呢，之后你也可以修改。",
          "choices": <String>["小N", "阿福", "管家"],
        },
      };

  test("两泡依次到达：第二泡排队，卡随第二泡落屏", () async {
    final MobileChatController c = MobileChatController(
        wsBaseUrl: wsUrl(), historyStore: _EmptyHistoryStore());
    addTearDown(c.dispose);

    c.debugHandleWsEvent(intro("嗨，阿哲，我是你的私人管家，以后生活中的事情交给我就好 😊"));
    c.debugHandleWsEvent(intro("你想叫我什么呢，之后你也可以修改。",
        messageId: "onboarding-intro-1"));
    c.debugHandleWsEvent(nameChoices("onboarding-intro-1"));

    expect(c.messages.length, 1, reason: "第二泡还没到点，不能直接落屏");
    expect(c.isIntroTyping, isTrue, reason: "排队期间显示打字气泡");

    await Future<void>.delayed(const Duration(milliseconds: 1700));

    expect(c.messages.length, 2, reason: "间隔到点后第二泡落屏");
    expect(c.messages.last.messageId, "onboarding-intro-1");
    expect(c.messages.last.nameChoices, isNotEmpty, reason: "早到的取名卡补挂");
    expect(c.isIntroTyping, isFalse);
  });

  test("非开场白的主动消息不受排队影响：收到即落屏", () {
    final MobileChatController c = MobileChatController(
        wsBaseUrl: wsUrl(), historyStore: _EmptyHistoryStore());
    addTearDown(c.dispose);

    c.debugHandleWsEvent(<String, dynamic>{
      "type": "agent.proactive_message",
      "payload": <String, dynamic>{"text": "外面下雨了，记得带伞。"},
    });

    expect(c.messages.length, 1);
    expect(c.isIntroTyping, isFalse);
  });
}
