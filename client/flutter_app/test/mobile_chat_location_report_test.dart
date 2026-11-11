/// 手机端定位应答链路（2026-10-09）：MobileChatController 定位事件测试。
///
/// 背景：服务端 locationCoordinator 把 `agent.location_request` 发给该 actor
/// 最后一条完成 session.init 的连接；手机端聊天 WS 与桌面根 WS 同 actor 竞绑，
/// 绑到聊天 WS 时此前无人应答 → 按需定位恒超时 → agent「不知道用户的地址」。
///
/// 覆盖：
/// - `agent.location_request`（带 jobId）→ 回 `client.location_report`（jobId + 纯坐标）
/// - 定位失败 → 仍回 jobId 空包（服务端立即结算，不白等超时）
/// - `ws_connected` → 启动定位上报（无 jobId 纯上报，填服务端缓存）
/// - 回归：普通聊天事件处理不受影响
library;

import "dart:io";

import "package:flutter_test/flutter_test.dart";

import "package:nextbot/core/db/local_history_store.dart";
import "package:nextbot/core/models/chat_models.dart";
import "package:nextbot/core/services/client_location_service.dart";
import "package:nextbot/mobile_ui/mobile_chat_controller.dart";

/// 空历史存储：不碰本机共享 Isar（诊断结论 2026-11-10：共享库残留了旧
/// `assistant-t1` 空壳消息，hits.last 命中历史垃圾导致断言失败——落屏
/// 链路本身没问题，是测试隔离缺失）。
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

/// 本地 WebSocket 服务器：控制器构造即连接，连不上会走重连定时器并触发
/// web_socket 包的异步断连错误污染测试 zone。起真监听端最稳。
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

  tearDown(() {
    MobileChatController.debugLocationResolver = null;
  });

  String wsUrl() => "ws://127.0.0.1:${_wsServer!.port}";

  Future<MobileChatController> newController() async {
    final MobileChatController controller = MobileChatController(
      wsBaseUrl: wsUrl(),
      historyStore: _EmptyHistoryStore(),
    )..debugCaptureSentEvents = true;
    // 真连接成功也会触发 ws_connected → 启动上报，等事件泵排空。
    await pumpEventQueue();
    return controller;
  }

  Future<MapEntry<String, Map<String, dynamic>>> waitForSent(
    MobileChatController controller,
    String type, {
    bool Function(Map<String, dynamic> payload)? where,
  }) async {
    final DateTime deadline = DateTime.now().add(const Duration(seconds: 3));
    while (DateTime.now().isBefore(deadline)) {
      for (final MapEntry<String, Map<String, dynamic>> e
          in controller.debugSentEvents) {
        if (e.key != type) continue;
        if (where != null && !where(e.value)) continue;
        return e;
      }
      await Future<void>.delayed(const Duration(milliseconds: 10));
    }
    fail("等待出站事件 $type 超时");
  }

  test("agent.location_request 带 jobId → 回 client.location_report 携 jobId 与坐标", () async {
    final MobileChatController controller = await newController();
    addTearDown(controller.dispose);
    MobileChatController.debugLocationResolver = () async => ClientLocationPayload(
          latitude: 27.7255,
          longitude: 106.9291,
          timezone: "Asia/Shanghai",
          label: "27.7255, 106.9291",
        );

    controller.debugHandleWsEvent(<String, dynamic>{
      "type": "agent.location_request",
      "payload": <String, dynamic>{"jobId": "job-1", "reason": "weather.get_local"},
    });

    final MapEntry<String, Map<String, dynamic>> sent =
        await waitForSent(controller, "client.location_report",
            where: (p) => p["jobId"] == "job-1");
    expect(sent.value["latitude"], 27.7255);
    expect(sent.value["longitude"], 106.9291);
    expect(sent.value["timezone"], "Asia/Shanghai");
  });

  test("定位失败仍回 jobId 空包（服务端立即结算，不等 12s 超时）", () async {
    final MobileChatController controller = await newController();
    addTearDown(controller.dispose);
    MobileChatController.debugLocationResolver = () async => null;

    controller.debugHandleWsEvent(<String, dynamic>{
      "type": "agent.location_request",
      "payload": <String, dynamic>{"jobId": "job-2"},
    });

    final MapEntry<String, Map<String, dynamic>> sent =
        await waitForSent(controller, "client.location_report",
            where: (p) => p["jobId"] == "job-2");
    expect(sent.value.containsKey("latitude"), isFalse);
  });

  test("ws_connected → 启动定位上报（无 jobId 纯上报）", () async {
    final MobileChatController controller = await newController();
    addTearDown(controller.dispose);
    controller.debugSentEvents.clear();
    MobileChatController.debugLocationResolver = () async => ClientLocationPayload(
          latitude: 31.2304,
          longitude: 121.4737,
          city: "上海",
        );

    controller.debugHandleWsEvent(<String, dynamic>{
      "type": "ws_connected",
      "payload": <String, dynamic>{},
    });

    final MapEntry<String, Map<String, dynamic>> sent =
        await waitForSent(controller, "client.location_report");
    expect(sent.value.containsKey("jobId"), isFalse);
    expect(sent.value["city"], "上海");
  });

  test("回归：聊天 chunk/done 事件处理不受定位改动影响", () async {
    final MobileChatController controller = await newController();
    addTearDown(controller.dispose);
    MobileChatController.debugLocationResolver =
        () async => throw StateError("不应触发定位");

    controller.debugHandleWsEvent(<String, dynamic>{
      "type": "chat.assistant_chunk",
      "payload": <String, dynamic>{"messageId": "assistant-t1", "chunk": "你好"},
    });
    controller.debugHandleWsEvent(<String, dynamic>{
      "type": "chat.assistant_done",
      "payload": <String, dynamic>{
        "traceId": "t1",
        "messageId": "assistant-t1",
        "finalText": "你好，世界",
      },
    });
    await pumpEventQueue();
    // 分泡逐泡揭示（2026-11-10）：done 后泡先进揭示队列按间隔定时弹出，
    // 同步断言前先跳过间隔立即整泡落屏（controller 提供的测试钩子）。
    controller.debugFlushBubbleReveals();

    // 按 messageId 精确断言，不用 messages.last：controller 构造时
    // _bootstrapHistory 会从共享 Isar 本地库恢复其他测试文件落盘的
    // 旧消息（跨文件测试污染），last 未必是本用例的消息。
    final List<ChatMessage> hits = controller.messages
        .where((m) => m.messageId == "assistant-t1")
        .toList();

    expect(hits, isNotEmpty);
    expect(hits.last.text, "你好，世界");
    expect(controller.debugSentEvents.where((e) => e.key == "client.location_report"),
        isEmpty);
  });
}
