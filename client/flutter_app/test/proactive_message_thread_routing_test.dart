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

import "package:nextbot/core/config/api_config.dart";
import "package:nextbot/core/models/chat_models.dart";
import "package:nextbot/mobile_ui/mobile_chat_controller.dart";

import "mobile_chat_intro_pacing_test.dart" show EmptyHistoryStoreForTest;

/// 预置「冷启动历史」的假存储：模拟本地只存了正文（notifyActions 不持久化）。
class _PreloadedHistoryStoreForTest extends EmptyHistoryStoreForTest {
  _PreloadedHistoryStoreForTest(this.preloaded);

  final List<ChatMessage> preloaded;

  @override
  Future<List<ChatMessage>> listMessages(String sessionId) async =>
      preloaded.where((ChatMessage m) => m.sessionId == sessionId).toList();
}

/// 等本地历史合入完成（补投闸开通）。
Future<void> waitHistoryReady(MobileChatController c) async {
  for (int i = 0; i < 100 && !c.debugHistoryReady; i++) {
    await Future<void>.delayed(const Duration(milliseconds: 5));
  }
  expect(c.debugHistoryReady, isTrue, reason: "本地历史应在测试窗口内加载完");
}

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

  /// 厂商推送补投载荷：pushed:true + 未过期 actionIntent（§4.4 行 2 的形态）。
  Map<String, dynamic> vendorPushReplayPayload({
    required String messageId,
    required String intentId,
    required int nowMs,
    String text = "周六的游泳还去吗？",
  }) {
    return <String, dynamic>{
      "deliveryId": "dp_$messageId",
      "messageId": messageId,
      "title": "游泳",
      "text": text,
      "importance": "medium",
      "kind": "agent_pulse",
      "pushed": true,
      "firedAt": nowMs,
      "actionIntent": <String, dynamic>{
        "intentId": intentId,
        "expiresAt": nowMs + 3600 * 1000,
        "actions": <Map<String, dynamic>>[
          <String, dynamic>{
            "actionId": "schedule.complete",
            "label": "去过了",
            "token": "tok_1",
          },
          <String, dynamic>{
            "actionId": "schedule.snooze",
            "label": "改天吧",
            "token": "tok_2",
          },
        ],
      },
    };
  }

  test("补投重放同一条消息：只落一泡、决策页只弹一次", () async {
    final EmptyHistoryStoreForTest store = EmptyHistoryStoreForTest();
    final MobileChatController c = await controllerInSideChat(store);
    addTearDown(c.dispose);
    await waitHistoryReady(c);

    int sheets = 0;
    c.onDecisionRequest = (_) => sheets++;

    final Map<String, dynamic> payload = vendorPushReplayPayload(
      messageId: "proactive-dp_replay_1",
      intentId: "ai_replay_1",
      nowMs: DateTime.now().millisecondsSinceEpoch,
    );

    c.debugHandleWsEvent(<String, dynamic>{
      "type": "agent.proactive_message",
      "payload": <String, dynamic>{...payload, "replay": true},
    });
    c.debugHandleWsEvent(<String, dynamic>{
      "type": "agent.proactive_message",
      "payload": <String, dynamic>{...payload, "replay": true},
    });

    await c.returnToMain();
    expect(
      c.messages.where((m) => m.text == "周六的游泳还去吗？").length,
      1,
      reason: "同一条 messageId 补投两次只能有一个气泡",
    );
    expect(sheets, 1, reason: "补投重放不能让决策半屏页跟着重放");
  });

  test("补投命中已有气泡（历史不存按钮）：按钮回挂、决策页不再弹", () async {
    final int nowMs = DateTime.now().millisecondsSinceEpoch;
    final _PreloadedHistoryStoreForTest store = _PreloadedHistoryStoreForTest(
      <ChatMessage>[
        ChatMessage(
          messageId: "proactive-dp_replay_2",
          sessionId: ApiConfig.effectiveActorId,
          role: "assistant",
          text: "周六的游泳还去吗？",
          timestamp: DateTime.now(),
        ),
      ],
    );
    // 不进旁聊：冷启动时活跃会话就是主线程，预置历史会合入主线程桶。
    final MobileChatController c =
        MobileChatController(wsBaseUrl: wsUrl(), historyStore: store);
    addTearDown(c.dispose);
    await waitHistoryReady(c);

    int sheets = 0;
    c.onDecisionRequest = (_) => sheets++;

    c.debugHandleWsEvent(<String, dynamic>{
      "type": "agent.proactive_message",
      "payload": <String, dynamic>{
        ...vendorPushReplayPayload(
          messageId: "proactive-dp_replay_2",
          intentId: "ai_replay_2",
          nowMs: nowMs,
        ),
        "replay": true,
      },
    });

    final List<ChatMessage> hits =
        c.messages.where((m) => m.messageId == "proactive-dp_replay_2").toList();
    expect(hits.length, 1, reason: "已有气泡不得重复落屏");
    expect(
      hits.single.notifyActions?.map((a) => a.label).toList(),
      <String>["去过了", "改天吧"],
      reason: "未过期决策的按钮要回挂到旧气泡，不能静默失效",
    );
    expect(sheets, 0, reason: "已见过的卡片不再弹半屏页");
  });
}
