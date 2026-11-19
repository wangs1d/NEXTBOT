/// 空闲心跳状态机回归（2026-11-11 真机「对话卡住」根修）。
///
/// 覆盖三条曾经出错的语义：
///  1. 空闲超阈值 → 发探测，**ack 回来后不能判死**（旧实现同步复查入站，
///     等价「空闲必断」）；
///  2. 探测发出后确实零入站（半开链路）→ 宽限过后必须判死并重连；
///  3. 入站静默时发 chat.user_message → 必须同时发 pre_send_probe 且消息
///     **真的写到 socket**，不能扣进待发队列后假装已发（旧实现 return true
///     却拆链，用户看到气泡已发出却永远等不到回复）。
///
/// 用注入的秒级时序跑，真实等待 <2s。
library;

import "dart:async";
import "dart:convert";
import "dart:io";

import "package:flutter_test/flutter_test.dart";
import "package:nextbot/core/services/ws_chat_service.dart";

class _Harness {
  _Harness(this.server, this.url);

  final HttpServer server;
  final String url;
  final List<String> receivedTypes = <String>[];
  final List<String> receivedRaw = <String>[];
  int connections = 0;

  /// 每次建连的时刻（「连上就掉」重连节奏回归用）。
  final List<DateTime> connectionTimes = <DateTime>[];

  /// >0 时服务端在握手成功后等待该时长再主动关闭（模拟短命连接）。
  Duration closeAfter = Duration.zero;

  /// 是否对 `ws.keepalive` 回 ack（模拟健康链路 / 半开链路）。
  bool ackKeepalive = true;

  Future<void> close() async {
    for (final WebSocket ws in _sockets) {
      await ws.close();
    }
    _sockets.clear();
    await server.close(force: true);
  }

  final List<WebSocket> _sockets = <WebSocket>[];
}

Future<_Harness> _startServer() async {
  final HttpServer server = await HttpServer.bind(
    InternetAddress.loopbackIPv4,
    0,
  );
  final _Harness harness = _Harness(
    server,
    "ws://127.0.0.1:${server.port}/ws",
  );
  server.listen((HttpRequest request) async {
    final WebSocket ws = await WebSocketTransformer.upgrade(request);
    harness.connections += 1;
    harness.connectionTimes.add(DateTime.now());
    harness._sockets.add(ws);
    if (harness.closeAfter > Duration.zero) {
      Timer(harness.closeAfter, () {
        ws.close();
      });
    }
    ws.listen((dynamic data) {
      final String raw = data.toString();
      harness.receivedRaw.add(raw);
      Map<String, dynamic>? event;
      try {
        event = jsonDecode(raw) as Map<String, dynamic>;
      } catch (_) {
        return;
      }
      final String type = (event["type"] ?? "").toString();
      harness.receivedTypes.add(type);
      final Object? payload = event["payload"];
      final String reason = payload is Map
          ? (payload["reason"] ?? "").toString()
          : "";
      if (type == "ws.keepalive" &&
          (reason == "idle_probe" || reason == "pre_send_probe")) {
        expect(reason, isNotEmpty);
      }
      if (type == "ws.keepalive" && harness.ackKeepalive) {
        ws.add(jsonEncode(<String, dynamic>{
          "type": "ws.keepalive_ack",
          "payload": <String, dynamic>{"clientTime": ""},
        }));
      }
    });
  }, onError: (Object _) {});
  return harness;
}

Future<void> _waitFor(
  bool Function() condition, {
  Duration timeout = const Duration(seconds: 3),
}) async {
  final DateTime deadline = DateTime.now().add(timeout);
  while (!condition()) {
    if (DateTime.now().isAfter(deadline)) {
      fail("等待条件超时（${timeout.inMilliseconds}ms）");
    }
    await Future<void>.delayed(const Duration(milliseconds: 20));
  }
}

void main() {
  test("空闲探测收到 ack 不判死：链路保持、无重连", () async {
    final _Harness server = await _startServer();
    final WsChatService service = WsChatService(
      url: server.url,
      heartbeatInterval: const Duration(milliseconds: 80),
      heartbeatTimeout: const Duration(milliseconds: 200),
      probeGrace: const Duration(milliseconds: 120),
      connectTimeout: const Duration(seconds: 3),
    );
    final List<String> events = <String>[];
    final StreamSubscription<Map<String, dynamic>> sub = service.events.listen(
      (Map<String, dynamic> e) => events.add((e["type"] ?? "").toString()),
    );
    addTearDown(() async {
      await sub.cancel();
      await service.close();
      await server.close();
    });

    service.connect();
    await _waitFor(() => service.isConnected);
    final int connectionsAfterFirstConnect = server.connections;

    // 静默 1.2s：空闲远超 heartbeatTimeout(200ms)，期间会发多次探测。
    await Future<void>.delayed(const Duration(milliseconds: 1200));

    expect(
      service.isConnected,
      isTrue,
      reason: "收到 keepalive ack 时不得判死链（旧实现在第一次探测就断）",
    );
    expect(
      events.contains("ws_disconnected"),
      isFalse,
      reason: "健康空闲不允许产生断链事件",
    );
    expect(
      server.connections,
      connectionsAfterFirstConnect,
      reason: "健康空闲不允许重连",
    );
    expect(
      server.receivedTypes.where((String t) => t == "ws.keepalive").length,
      greaterThan(1),
      reason: "空闲期应持续发探测/心跳",
    );
  });

  test("探测后零入站：宽限过后判死并重连", () async {
    final _Harness server = await _startServer();
    // 半开链路：服务端收包但一个字节都不回。
    server.ackKeepalive = false;
    final WsChatService service = WsChatService(
      url: server.url,
      heartbeatInterval: const Duration(milliseconds: 80),
      heartbeatTimeout: const Duration(milliseconds: 200),
      probeGrace: const Duration(milliseconds: 120),
      connectTimeout: const Duration(seconds: 3),
    );
    final List<String> events = <String>[];
    final StreamSubscription<Map<String, dynamic>> sub = service.events.listen(
      (Map<String, dynamic> e) => events.add((e["type"] ?? "").toString()),
    );
    addTearDown(() async {
      await sub.cancel();
      await service.close();
      await server.close();
    });

    service.connect();
    await _waitFor(() => service.isConnected);
    await _waitFor(
      () => server.receivedTypes.contains("ws.keepalive"),
      timeout: const Duration(seconds: 2),
    );
    expect(
      server.receivedTypes.where((String t) => t == "ws.keepalive").length,
      greaterThan(0),
      reason: "应先发探测而不是直接判死",
    );

    // 判死后会退避（初始 2s + jitter）重连，所以用事件流观察断链即可。
    await _waitFor(
      () => events.contains("ws_disconnected"),
      timeout: const Duration(seconds: 3),
    );
    expect(
      events.contains("ws_disconnected"),
      isTrue,
      reason: "探测后零入站必须在宽限后判死，否则半开连接永远耗着",
    );
  });

  test("入站静默时发消息：发 pre_send_probe 且消息真写到 socket", () async {
    final _Harness server = await _startServer();
    server.ackKeepalive = false;
    final WsChatService service = WsChatService(
      url: server.url,
      heartbeatInterval: const Duration(milliseconds: 80),
      // timeout 设得很短：连接后立刻进入「入站静默」状态。
      heartbeatTimeout: const Duration(milliseconds: 50),
      probeGrace: const Duration(milliseconds: 5000),
      connectTimeout: const Duration(seconds: 3),
    );
    final StreamSubscription<Map<String, dynamic>> sub = service.events.listen(
      (Map<String, dynamic> _) {},
    );
    addTearDown(() async {
      await sub.cancel();
      await service.close();
      await server.close();
    });

    service.connect();
    await _waitFor(() => service.isConnected);
    await Future<void>.delayed(const Duration(milliseconds: 120));
    server.receivedRaw.clear();
    server.receivedTypes.clear();

    final bool accepted = service.sendEvent(
      "chat.user_message",
      <String, dynamic>{
        "sessionId": "probe",
        "messageId": "probe-1",
        "text": "你好",
      },
    );

    expect(accepted, isTrue, reason: "链路健康时发送必须返回已受理");
    await _waitFor(
      () => server.receivedTypes.contains("chat.user_message"),
      timeout: const Duration(seconds: 2),
    );
    expect(
      server.receivedTypes.contains("ws.keepalive"),
      isTrue,
      reason: "静默时发送应先探活",
    );
    expect(
      server.receivedRaw.any(
        (String raw) => raw.contains("pre_send_probe"),
      ),
      isTrue,
      reason: "探测原因必须是 pre_send_probe",
    );
    expect(
      service.isConnected,
      isTrue,
      reason: "探活发送不允许把消息扣进队列并立刻拆链（旧实现假成功）",
    );
  });

  test("消息 ack 超时：立刻探活并在宽限后判死重连，不等心跳", () async {
    // 真机「思考组件一直卡在我看看」：消息写进半开连接后无人追责，
    // 心跳要 75s 才判死。看门狗必须在 ack 超时后立刻探活 → 判死 → 重连 → 重投。
    final _Harness server = await _startServer();
    server.ackKeepalive = false;
    final WsChatService service = WsChatService(
      url: server.url,
      // 心跳阈值故意设得很长：证明判死来自看门狗而不是心跳。
      heartbeatInterval: const Duration(seconds: 30),
      heartbeatTimeout: const Duration(seconds: 60),
      probeGrace: const Duration(milliseconds: 200),
      ackTimeout: const Duration(milliseconds: 300),
      connectTimeout: const Duration(seconds: 3),
    );
    final List<String> events = <String>[];
    final StreamSubscription<Map<String, dynamic>> sub = service.events.listen(
      (Map<String, dynamic> e) => events.add((e["type"] ?? "").toString()),
    );
    addTearDown(() async {
      await sub.cancel();
      await service.close();
      await server.close();
    });

    service.connect();
    await _waitFor(() => service.isConnected);
    server.receivedRaw.clear();
    server.receivedTypes.clear();

    service.sendEvent("chat.user_message", <String, dynamic>{
      "sessionId": "probe",
      "messageId": "ack-timeout-1",
      "text": "你好",
    });

    // 1) 超时后应发探活（不是干等心跳）
    await _waitFor(
      () => server.receivedRaw.any((String r) => r.contains("ack_watchdog")),
      timeout: const Duration(seconds: 3),
    );
    // 2) 探活无回应 → 判死重连
    await _waitFor(
      () => events.contains("ws_disconnected"),
      timeout: const Duration(seconds: 3),
    );
  });

  test("消息 ack 丢失但链路活着：探活有回应则不判死", () async {
    final _Harness server = await _startServer();
    // 只回 keepalive ack、不回 chat 的 ack（模拟服务端处理异常但链路正常）。
    final WsChatService service = WsChatService(
      url: server.url,
      heartbeatInterval: const Duration(seconds: 30),
      heartbeatTimeout: const Duration(seconds: 60),
      probeGrace: const Duration(milliseconds: 200),
      ackTimeout: const Duration(milliseconds: 300),
      connectTimeout: const Duration(seconds: 3),
    );
    final List<String> events = <String>[];
    final StreamSubscription<Map<String, dynamic>> sub = service.events.listen(
      (Map<String, dynamic> e) => events.add((e["type"] ?? "").toString()),
    );
    addTearDown(() async {
      await sub.cancel();
      await service.close();
      await server.close();
    });

    service.connect();
    await _waitFor(() => service.isConnected);
    service.sendEvent("chat.user_message", <String, dynamic>{
      "sessionId": "probe",
      "messageId": "ack-lost-1",
      "text": "你好",
    });

    await _waitFor(
      () => server.receivedRaw.any((String r) => r.contains("ack_watchdog")),
      timeout: const Duration(seconds: 3),
    );
    await Future<void>.delayed(const Duration(milliseconds: 900));
    expect(
      events.contains("ws_disconnected"),
      isFalse,
      reason: "探活收到 ack 说明链路活着，不得因单条消息 ack 丢失就拆链",
    );
    expect(service.isConnected, isTrue);
  });

  test("连上就掉：短命连接走快重试，不按指数退避干等", () async {
    // 真机「断连重连」体验根因之一：_markDisconnected 先把 _connectedAt 清零，
    // 退避计算再读它 → wasBriefConnection 恒 false，短命连接也走 2s/4s/8s…
    // 指数退避，用户看到长时间「正在重连」。这里断言第二次建连在快重试窗口内。
    final _Harness server = await _startServer();
    server.closeAfter = const Duration(milliseconds: 300);
    final WsChatService service = WsChatService(
      url: server.url,
      heartbeatInterval: const Duration(seconds: 30),
      heartbeatTimeout: const Duration(seconds: 60),
      connectTimeout: const Duration(seconds: 3),
    );
    addTearDown(() async {
      await service.close();
      await server.close();
    });

    service.connect();
    await _waitFor(() => server.connections >= 1);
    await _waitFor(
      () => server.connections >= 2,
      timeout: const Duration(seconds: 4),
    );
    final int gapMs = server.connectionTimes[1]
        .difference(server.connectionTimes[0])
        .inMilliseconds;
    expect(
      gapMs,
      lessThan(2000),
      reason: "短命连接应在 ~1s 内重试（含 300ms 存活期），不能退避到 2s+（实际 ${gapMs}ms）",
    );
  });

  test("入站静默时发卡片动作：同样探活且真写到 socket", () async {
    // 卡片按钮（card.action「确认下单」）在半开链路上同样是假成功：
    // 用户点了没反应，比消息没回复更难察觉。它也必须先探活。
    final _Harness server = await _startServer();
    server.ackKeepalive = false;
    final WsChatService service = WsChatService(
      url: server.url,
      heartbeatInterval: const Duration(milliseconds: 80),
      heartbeatTimeout: const Duration(milliseconds: 50),
      probeGrace: const Duration(milliseconds: 5000),
      connectTimeout: const Duration(seconds: 3),
    );
    final StreamSubscription<Map<String, dynamic>> sub = service.events.listen(
      (Map<String, dynamic> _) {},
    );
    addTearDown(() async {
      await sub.cancel();
      await service.close();
      await server.close();
    });

    service.connect();
    await _waitFor(() => service.isConnected);
    await Future<void>.delayed(const Duration(milliseconds: 120));
    server.receivedRaw.clear();
    server.receivedTypes.clear();

    service.sendCardActionEvent(
      sessionId: "probe",
      messageId: "card-1",
      actionId: "confirm-order",
      cardId: "shopping-1",
    );

    await _waitFor(
      () => server.receivedTypes.contains("card.action"),
      timeout: const Duration(seconds: 2),
    );
    expect(
      server.receivedRaw.any((String raw) => raw.contains("pre_send_probe")),
      isTrue,
      reason: "卡片动作在静默期也必须先探活",
    );
    expect(service.isConnected, isTrue);
  });

  test("回前台先探活：健康链路保留原连接，不重建", () async {
    // 2026-11-18：旧实现回前台发现入站静默就直接拆链，用户每次切回来都看到
    // 「正在重连」。新语义先发 resume_probe，收到任意入站就保留连接。
    final _Harness server = await _startServer();
    server.ackKeepalive = false;
    final WsChatService service = WsChatService(
      url: server.url,
      heartbeatInterval: const Duration(milliseconds: 80),
      // 心跳阈值放长：把判死权交给 ensureConnected 的探活路径。
      heartbeatTimeout: const Duration(seconds: 30),
      probeGrace: const Duration(seconds: 5),
      resumeProbeGrace: const Duration(milliseconds: 300),
      connectTimeout: const Duration(seconds: 3),
    );
    final List<String> events = <String>[];
    final StreamSubscription<Map<String, dynamic>> sub = service.events.listen(
      (Map<String, dynamic> e) => events.add((e["type"] ?? "").toString()),
    );
    addTearDown(() async {
      await sub.cancel();
      await service.close();
      await server.close();
    });

    service.connect();
    await _waitFor(() => service.isConnected);
    final int connections = server.connections;
    // 静默超过两个心跳周期（80ms × 2），进入「回前台疑似半死链」状态。
    await Future<void>.delayed(const Duration(milliseconds: 220));
    // 恢复 ack：探活会立刻得到回应。
    server.ackKeepalive = true;
    service.ensureConnected();

    await _waitFor(
      () => server.receivedRaw.any((String r) => r.contains("resume_probe")),
      timeout: const Duration(seconds: 2),
    );
    await Future<void>.delayed(const Duration(milliseconds: 400));
    expect(
      events.contains("ws_disconnected"),
      isFalse,
      reason: "探活有回应时回前台不得拆链重连",
    );
    expect(server.connections, connections, reason: "健康链路不允许新建连接");
    expect(service.isConnected, isTrue);
  });

  test("回前台探活无回应：宽限后判死重连（真半死链）", () async {
    final _Harness server = await _startServer();
    server.ackKeepalive = false;
    final WsChatService service = WsChatService(
      url: server.url,
      heartbeatInterval: const Duration(milliseconds: 80),
      heartbeatTimeout: const Duration(seconds: 30),
      probeGrace: const Duration(seconds: 5),
      resumeProbeGrace: const Duration(milliseconds: 120),
      connectTimeout: const Duration(seconds: 3),
    );
    final List<String> events = <String>[];
    final StreamSubscription<Map<String, dynamic>> sub = service.events.listen(
      (Map<String, dynamic> e) => events.add((e["type"] ?? "").toString()),
    );
    addTearDown(() async {
      await sub.cancel();
      await service.close();
      await server.close();
    });

    service.connect();
    await _waitFor(() => service.isConnected);
    await Future<void>.delayed(const Duration(milliseconds: 220));
    service.ensureConnected();

    await _waitFor(
      () => server.receivedRaw.any((String r) => r.contains("resume_probe")),
      timeout: const Duration(seconds: 2),
    );
    await _waitFor(
      () => events.contains("ws_disconnected"),
      timeout: const Duration(seconds: 2),
    );
    expect(events.contains("ws_disconnected"), isTrue);
  });

  test("网络切换：先探活，真死才重连", () async {
    final _Harness server = await _startServer();
    final WsChatService service = WsChatService(
      url: server.url,
      heartbeatInterval: const Duration(seconds: 30),
      heartbeatTimeout: const Duration(seconds: 60),
      resumeProbeGrace: const Duration(milliseconds: 120),
      connectTimeout: const Duration(seconds: 3),
    );
    final List<String> events = <String>[];
    final StreamSubscription<Map<String, dynamic>> sub = service.events.listen(
      (Map<String, dynamic> e) => events.add((e["type"] ?? "").toString()),
    );
    addTearDown(() async {
      await sub.cancel();
      await service.close();
      await server.close();
    });

    service.connect();
    await _waitFor(() => service.isConnected);
    final int connections = server.connections;

    // 1) 链路活着：探活有 ack → 不重建。
    service.onNetworkChanged();
    await _waitFor(
      () => server.receivedRaw.any((String r) => r.contains("network_probe")),
      timeout: const Duration(seconds: 2),
    );
    await Future<void>.delayed(const Duration(milliseconds: 300));
    expect(server.connections, connections, reason: "探活有回应时不应重建");
    expect(events.contains("ws_disconnected"), isFalse);

    // 2) 路径切换后半开：探活无人应答 → 判死重连。
    server.ackKeepalive = false;
    service.onNetworkChanged();
    await _waitFor(
      () => events.contains("ws_disconnected"),
      timeout: const Duration(seconds: 2),
    );
    expect(events.contains("ws_disconnected"), isTrue);
  });

  test("服务端重启预告：按快重连节奏回来，不吃指数退避", () async {
    final _Harness server = await _startServer();
    final WsChatService service = WsChatService(
      url: server.url,
      heartbeatInterval: const Duration(seconds: 30),
      heartbeatTimeout: const Duration(seconds: 60),
      connectTimeout: const Duration(seconds: 3),
    );
    final StreamSubscription<Map<String, dynamic>> sub = service.events.listen(
      (Map<String, dynamic> _) {},
    );
    addTearDown(() async {
      await sub.cancel();
      await service.close();
      await server.close();
    });

    service.connect();
    await _waitFor(() => service.isConnected);
    expect(server.connections, 1);

    final DateTime closeAt = DateTime.now();
    for (final WebSocket ws in server._sockets) {
      ws.add(jsonEncode(<String, dynamic>{
        "type": "server.restarting",
        "payload": <String, dynamic>{"reason": "deploy"},
      }));
      await ws.close(1001, "server_restart");
    }

    await _waitFor(
      () => server.connections >= 2,
      timeout: const Duration(seconds: 3),
    );
    final int gapMs =
        server.connectionTimes[1].difference(closeAt).inMilliseconds;
    expect(
      gapMs,
      lessThan(1500),
      reason: "收到重启预告后应 ~0.5-0.9s 重连（实际 ${gapMs}ms）",
    );
  });
}
