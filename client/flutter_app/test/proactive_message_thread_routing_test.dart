/// 主动消息只落主会话线程（2026-11-12 用户定调）。
///
/// 事故形态：到点提醒（该睡觉啦）经 agent.proactive_message 下发时，用户正停在
/// 旁聊里，气泡被落进了旁聊线程——提醒与旁聊上下文无关，回错会话。
/// 覆盖：
/// - 停在旁聊时收到 agent.proactive_message → 落主线程，旁聊线程不含
/// - 停在旁聊时收到 reminder_popup → 落主线程
/// - 两条都按主会话 sessionId 持久化（重启后仍在主线程）
/// - 离线补推带 firedAt → 气泡按原定触发时刻落屏（补推不冒充"刚刚发的"）
library;

import "dart:io";

import "package:flutter_test/flutter_test.dart";

import "package:nextbot/core/db/local_history_store.dart";
import "package:nextbot/mobile_ui/mobile_chat_controller.dart";

import "mobile_chat_intro_pacing_test.dart" show EmptyHistoryStoreForTest;

void main() {
  HttpServer? _wsServer;

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

  Future<MobileChatController> controllerInSideChat(
    EmptyHistoryStoreForTest store,
  ) async {
    final MobileChatController c = MobileChatController(
        wsBaseUrl: wsUrl(), historyStore: store);
    // 进入旁聊（本地空历史；服务端历史拉取在测试环境连接失败被静默吞掉）。
    await c.enterSideChat(sessionId: "side:test-actor:abc123");
    return c;
  }

  test("停在旁聊时收到主动性消息：落主线程，旁聊线程不含", () async {
    final EmptyHistoryStoreForTest store = EmptyHistoryStoreForTest();
    final MobileChatController c = await controllerInSideChat(store);
    addTearDown(c.dispose);

    c.debugHandleWsEvent(<String, dynamic>{
      "type": "agent.proactive_message",
      "payload": <String, dynamic>{
        "title": "提醒",
        "text": "该睡觉啦",
        "importance": "normal",
        "kind": "schedule_reminder",
      },
    });

    expect(c.isSideChatActive, isTrue);
    expect(
      c.messages.any((m) => m.text == "该睡觉啦"),
      isFalse,
      reason: "旁聊线程绝不能出现主动消息气泡",
    );

    await c.returnToMain();
    expect(
      c.messages.any((m) => m.text == "该睡觉啦"),
      isTrue,
      reason: "主动消息必须落在主会话线程",
    );
    expect(
      c.messages.last.sessionId,
      isNot(startsWith("side:")),
      reason: "持久化 sessionId 必须是主会话键",
    );
  });

  test("停在旁聊时收到 reminder_popup：落主线程", () async {
    final EmptyHistoryStoreForTest store = EmptyHistoryStoreForTest();
    final MobileChatController c = await controllerInSideChat(store);
    addTearDown(c.dispose);

    c.debugHandleWsEvent(<String, dynamic>{
      "type": "reminder_popup",
      "payload": <String, dynamic>{
        "title": "牙医提醒",
        "message": "明天上午10点看牙医",
        "priority": "high",
        "attentionId": "",
      },
    });

    expect(
      c.messages.any((m) => m.text.contains("看牙医")),
      isFalse,
      reason: "旁聊线程不能出现升级链提醒卡",
    );

    await c.returnToMain();
    expect(
      c.messages.any((m) => m.text.contains("看牙医")),
      isTrue,
    );
    expect(
      store.saved.any((m) => m.text.contains("看牙医") && !m.sessionId.startsWith("side:")),
      isTrue,
      reason: "提醒必须按主会话 sessionId 落盘",
    );
  });

  test("离线补推带 firedAt：气泡按原定触发时刻落屏", () async {
    final EmptyHistoryStoreForTest store = EmptyHistoryStoreForTest();
    final MobileChatController c = await controllerInSideChat(store);
    addTearDown(c.dispose);

    // 服务端补推：凌晨 01:32 该响的提醒，02:44 重连才补投（firedAt=epoch ms）
    final int firedAtMs =
        DateTime.parse("2026-11-12 01:32:00").millisecondsSinceEpoch;
    final int beforeSend = DateTime.now().millisecondsSinceEpoch;
    c.debugHandleWsEvent(<String, dynamic>{
      "type": "agent.proactive_message",
      "payload": <String, dynamic>{
        "title": "提醒",
        "text": "该睡觉啦",
        "importance": "high",
        "kind": "schedule_reminder",
        "firedAt": firedAtMs,
      },
    });

    await c.returnToMain();
    final msg = c.messages.lastWhere((m) => m.text == "该睡觉啦");
    expect(
      msg.timestamp.millisecondsSinceEpoch,
      equals(firedAtMs),
      reason: "补推气泡时间戳必须是原定触发时刻，而不是补投到达时刻",
    );
    expect(firedAtMs, lessThan(beforeSend),
        reason: "前置校验：firedAt 确实早于补投时刻（用例有效）");
  });
}
