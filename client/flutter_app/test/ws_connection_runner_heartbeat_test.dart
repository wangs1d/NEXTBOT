/// 连接基座（桌面/手机桥共用）空闲判死回归。
///
/// 与 [WsChatService] 同一套三段式语义：空闲超阈值 → 发探测 → 宽限内收到
/// 任意入站即视为活着；宽限后仍零入站才判死。收编前 Runner 是「超时直接
/// 拆链」，健康但安静的桥连接会被每隔 timeout 无条件重连一次。
library;

import "dart:convert";
import "dart:io";

import "package:flutter_test/flutter_test.dart";
import "package:nextbot/core/services/ws_connection_runner.dart";

class _Server {
  _Server(this.http, this.url);

  final HttpServer http;
  final String url;
  bool ackKeepalive = true;
  int connections = 0;
  final List<String> received = <String>[];
  final List<WebSocket> sockets = <WebSocket>[];

  Future<void> close() async {
    for (final WebSocket ws in sockets) {
      await ws.close();
    }
    sockets.clear();
    await http.close(force: true);
  }
}

Future<_Server> _startServer() async {
  final HttpServer http = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
  final _Server server = _Server(http, "ws://127.0.0.1:${http.port}/ws");
  http.listen((HttpRequest request) async {
    final WebSocket ws = await WebSocketTransformer.upgrade(request);
    server.connections += 1;
    server.sockets.add(ws);
    ws.listen((dynamic data) {
      final String raw = data.toString();
      server.received.add(raw);
      if (!server.ackKeepalive) return;
      ws.add(jsonEncode(<String, dynamic>{
        "type": "ws.keepalive_ack",
        "payload": <String, dynamic>{"ok": true},
      }));
    });
  }, onError: (Object _) {});
  return server;
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

WsConnectionRunner _runner(
  _Server server, {
  required void Function(bool) onDisconnected,
}) {
  return WsConnectionRunner(
    name: "test-bridge",
    urlProvider: () => server.url,
    heartbeatInterval: const Duration(milliseconds: 80),
    heartbeatTimeout: const Duration(milliseconds: 200),
    probeGrace: const Duration(milliseconds: 120),
    reconnectDelay: const Duration(milliseconds: 100),
    maxReconnectDelay: const Duration(milliseconds: 200),
    onConnected: (dynamic _) {},
    onMessage: (Object? _) {},
    onDisconnected: onDisconnected,
  );
}

void main() {
  test("健康空闲：探测收到 ack 不判死", () async {
    final _Server server = await _startServer();
    final List<bool> disconnects = <bool>[];
    final WsConnectionRunner runner =
        _runner(server, onDisconnected: disconnects.add);
    addTearDown(() async {
      runner.stop();
      await server.close();
    });

    runner.start();
    await _waitFor(() => runner.connected);

    await Future<void>.delayed(const Duration(milliseconds: 1200));

    expect(runner.connected, isTrue, reason: "ack 回来时不得判死链");
    expect(disconnects, isEmpty, reason: "健康空闲不允许触发断线回调");
    // 注意：ack 本身就是入站，会不断把 idle 归零，所以健康链路**不会**进入
    // 探测分支——这正是设计意图（探测只服务于「连 ack 都收不到」的半开链路）。
    expect(
      server.received.where((String r) => r.contains("ws.keepalive")).length,
      greaterThan(1),
      reason: "健康空闲应持续发心跳",
    );
  });

  test("半开链路：探测后宽限内零入站必须判死并重连", () async {
    final _Server server = await _startServer();
    server.ackKeepalive = false;
    final List<bool> disconnects = <bool>[];
    final WsConnectionRunner runner =
        _runner(server, onDisconnected: disconnects.add);
    addTearDown(() async {
      runner.stop();
      await server.close();
    });

    runner.start();
    await _waitFor(() => runner.connected);

    await _waitFor(() => disconnects.isNotEmpty);
    expect(
      disconnects.first,
      isTrue,
      reason: "非主动停止时应要求重连",
    );
    // 重连会重新建链
    await _waitFor(() => server.connections >= 2);
  });
}
