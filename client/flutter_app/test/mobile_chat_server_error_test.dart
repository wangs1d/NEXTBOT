/// 手机端「服务端明确报错」必须可见（2026-11-11 真机「思考组件卡在我看看」根修）。
///
/// 背景：连接绑定的 actor 与本机身份不一致时，服务端对 `chat.user_message`
/// 直接回 `error.event(FORBIDDEN)` 并丢弃。客户端此前既不登记该事件类型，
/// 也没有任何分支消费它——于是界面永远停在「我看看」，用户无从判断是网络慢
/// 还是根本没发出去。
///
/// 锁死三条 UI 语义：
///  1. 身份类拒收 → 换成用户能读懂的过渡文案（连接层正在重绑身份并重投）；
///  2. 重投成功（收到任何 chat 事件）→ 过渡文案自动撤掉，不留假故障；
///  3. 其它错误 / 重投次数用尽 → 如实报错并退出「处理中」。
library;

import "dart:io";

import "package:flutter_test/flutter_test.dart";

import "package:nextbot/core/db/local_history_store.dart";
import "package:nextbot/core/models/chat_models.dart";
import "package:nextbot/mobile_ui/mobile_chat_controller.dart";

/// 空历史存储：不碰本机共享 Isar（共享库会残留旧消息，污染断言）。
class _EmptyHistoryStore implements LocalHistoryStore {
  @override
  Future<void> init() async {}

  @override
  Future<void> saveSession(ChatSession session) async {}

  @override
  Future<void> saveMessage(ChatMessage message) async {}

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

/// 本地 WebSocket 服务端：控制器构造即连接，连不上会走重连定时器并抛异步
/// 断连错误污染测试 zone，所以起真监听端。
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

  test("FORBIDDEN：转成能读懂的「身份同步中」，不留在处理中", () async {
    final MobileChatController controller = await newController();
    addTearDown(controller.dispose);
    controller.isProcessing = true;

    controller.debugHandleWsEvent(<String, dynamic>{
      "type": "error.event",
      "payload": <String, dynamic>{
        "code": "FORBIDDEN",
        "message": "userId/sessionId 与当前连接不一致",
        "traceId": "msg-1",
      },
    });

    expect(controller.errorMessage, contains("正在重新同步账号身份"));
    expect(
      controller.errorMessage,
      isNot(contains("userId/sessionId")),
      reason: "不能把服务端技术细节甩给用户",
    );
  });

  test("身份重同步后收到任意 chat 事件：过渡文案自动撤销", () async {
    final MobileChatController controller = await newController();
    addTearDown(controller.dispose);

    controller.debugHandleWsEvent(<String, dynamic>{
      "type": "error.event",
      "payload": <String, dynamic>{"code": "SESSION_REQUIRED", "message": "请先发送 session.init"},
    });
    expect(controller.errorMessage, contains("正在重新同步账号身份"));

    controller.debugHandleWsEvent(<String, dynamic>{
      "type": "chat.turn_started",
      "payload": <String, dynamic>{"messageId": "msg-1"},
    });
    expect(
      controller.errorMessage,
      isNull,
      reason: "重投成功后不能再挂着「身份同步中」",
    );
  });

  test("其它错误码：如实报错并退出处理中", () async {
    final MobileChatController controller = await newController();
    addTearDown(controller.dispose);
    controller.isProcessing = true;

    controller.debugHandleWsEvent(<String, dynamic>{
      "type": "error.event",
      "payload": <String, dynamic>{"code": "INVALID_CHAT_EVENT", "message": "消息格式不对"},
    });

    expect(controller.errorMessage, "消息格式不对");
    expect(controller.isProcessing, isFalse);
  });

  test("重投次数用尽：chat_delivery_failed 如实告知并退出处理中", () async {
    final MobileChatController controller = await newController();
    addTearDown(controller.dispose);
    controller.isProcessing = true;

    controller.debugHandleWsEvent(<String, dynamic>{
      "type": "chat_delivery_failed",
      "payload": <String, dynamic>{
        "messageId": "msg-9",
        "message": "消息没能送达服务器，请检查网络后重试",
      },
    });

    expect(controller.errorMessage, contains("没能送达服务器"));
    expect(controller.isProcessing, isFalse);
  });
}
