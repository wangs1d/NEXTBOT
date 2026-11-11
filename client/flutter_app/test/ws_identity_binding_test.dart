/// 连接身份绑定回归（2026-11-11 真机「思考组件卡在我看看、永远没有回复」根修）。
///
/// 事故链：App 启动期账号读盘晚于建连 → 握手时 `session.init` 仍是默认身份
/// `session-mvp-001` → 消息带着恢复后的登录邮箱发出 → 服务端
/// `msgActor !== boundActorId` 直接 `error.event(FORBIDDEN)` 丢弃且**不落审计**
/// → 客户端只看到「服务端一直不回 ack」，界面永远停在「我看看」。
///
/// 三条必须锁死的行为：
///  1. 身份变了，任何业务事件发送前必须先补发一条 `session.init`（顺序在前）；
///  2. 收到 `FORBIDDEN`/`SESSION_REQUIRED` → 重绑身份并按原 messageId 重投；
///  3. 反复被拒（重投次数用尽）→ 必须发 `chat_delivery_failed`，绝不静默留在
///     「处理中」。
library;

import "dart:async";
import "dart:convert";
import "dart:io";

import "package:flutter_test/flutter_test.dart";
import "package:nextbot/core/config/api_config.dart";
import "package:nextbot/core/services/access_auth_api.dart";
import "package:nextbot/core/services/ws_chat_service.dart";

class _Harness {
  _Harness(this.server, this.url);

  final HttpServer server;
  final String url;
  final List<Map<String, dynamic>> frames = <Map<String, dynamic>>[];

  /// 对 `chat.user_message` 回 `FORBIDDEN` 的次数（-1 = 一直拒，0 = 不拒）。
  int rejectChatTimes = 0;

  /// 对每条 `session.init` 回的错误码（模拟服务端身份拒收）。
  String? rejectInitCode;

  List<String> get types =>
      frames.map((Map<String, dynamic> f) => f["type"].toString()).toList();

  Map<String, dynamic> payloadOf(Map<String, dynamic> frame) {
    final Object? p = frame["payload"];
    return p is Map ? Map<String, dynamic>.from(p as Map) : <String, dynamic>{};
  }

  Iterable<Map<String, dynamic>> ofType(String type) =>
      frames.where((Map<String, dynamic> f) => f["type"] == type);

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
  final HttpServer server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
  final _Harness harness = _Harness(server, "ws://127.0.0.1:${server.port}/ws");
  server.listen((HttpRequest request) async {
    final WebSocket ws = await WebSocketTransformer.upgrade(request);
    harness._sockets.add(ws);
    ws.listen((dynamic data) {
      Map<String, dynamic>? event;
      try {
        event = jsonDecode(data.toString()) as Map<String, dynamic>;
      } catch (_) {
        return;
      }
      harness.frames.add(event!);
      if (event["type"] == "session.init" && harness.rejectInitCode != null) {
        ws.add(jsonEncode(<String, dynamic>{
          "type": "error.event",
          "payload": <String, dynamic>{
            "code": harness.rejectInitCode,
            "message": "登录状态已过期，请重新登录以确认账号身份",
          },
        }));
        return;
      }
      if (event["type"] == "chat.user_message" && harness.rejectChatTimes != 0) {
        if (harness.rejectChatTimes > 0) harness.rejectChatTimes -= 1;
        final Map<String, dynamic> payload = harness.payloadOf(event);
        ws.add(jsonEncode(<String, dynamic>{
          "type": "error.event",
          "payload": <String, dynamic>{
            "code": "FORBIDDEN",
            "message": "userId/sessionId 与当前连接不一致",
            "traceId": payload["messageId"],
          },
        }));
      }
    });
  }, onError: (Object _) {});
  return harness;
}

Future<void> _waitFor(
  bool Function() condition, {
  Duration timeout = const Duration(seconds: 5),
}) async {
  final DateTime deadline = DateTime.now().add(timeout);
  while (!condition()) {
    if (DateTime.now().isAfter(deadline)) {
      fail("等待条件超时（${timeout.inMilliseconds}ms）");
    }
    await Future<void>.delayed(const Duration(milliseconds: 20));
  }
}

WsChatService _service(String url) => WsChatService(
      url: url,
      heartbeatInterval: const Duration(seconds: 30),
      heartbeatTimeout: const Duration(seconds: 60),
      probeGrace: const Duration(seconds: 10),
      connectTimeout: const Duration(seconds: 3),
    );

Map<String, dynamic> _chatPayload(String messageId) => <String, dynamic>{
      "messageId": messageId,
      "text": "你好",
      "sessionId": ApiConfig.effectiveActorId,
      "userId": ApiConfig.effectiveActorId,
    };

void main() {
  final String? originalIdentity = ApiConfig.runtimeUserId;

  tearDown(() {
    ApiConfig.runtimeUserId = originalIdentity;
  });

  test("身份变化后发送：先补 session.init（新身份），再发消息", () async {
    ApiConfig.runtimeUserId = null;
    final _Harness server = await _startServer();
    final WsChatService service = _service(server.url);
    addTearDown(() async {
      await service.close();
      await server.close();
    });

    service.connect();
    await _waitFor(() => service.isConnected);
    await _waitFor(() => server.ofType("session.init").isNotEmpty);
    final int before = server.frames.length;

    // 模拟「账号读盘/登录晚于建连」：连接已带着默认身份建好，身份才落位。
    ApiConfig.runtimeUserId = "owner@example.com";
    expect(
      service.sendEvent("chat.user_message", _chatPayload("msg-1")),
      isTrue,
    );

    await _waitFor(() => server.ofType("chat.user_message").isNotEmpty);
    final List<String> newTypes =
        server.types.sublist(before).map((String t) => t).toList();
    expect(
      newTypes.indexOf("session.init"),
      greaterThanOrEqualTo(0),
      reason: "身份变了必须先补发 session.init，否则服务端按旧身份拒收",
    );
    expect(
      newTypes.indexOf("session.init"),
      lessThan(newTypes.indexOf("chat.user_message")),
      reason: "session.init 必须排在业务事件之前（同一 socket 顺序保证）",
    );
    final Map<String, dynamic> lastInit = server
        .ofType("session.init")
        .last;
    expect(
      server.payloadOf(lastInit)["userId"],
      "owner@example.com",
      reason: "补发的 init 必须携带当前生效身份",
    );
  });

  test("服务端 FORBIDDEN：自动重绑身份并按原 messageId 重投", () async {
    ApiConfig.runtimeUserId = "owner@example.com";
    final _Harness server = await _startServer();
    server.rejectChatTimes = 1; // 第一次拒收，重投后放行
    final WsChatService service = _service(server.url);
    final List<Map<String, dynamic>> events = <Map<String, dynamic>>[];
    final StreamSubscription<Map<String, dynamic>> sub =
        service.events.listen(events.add);
    addTearDown(() async {
      await sub.cancel();
      await service.close();
      await server.close();
    });

    service.connect();
    await _waitFor(() => service.isConnected);
    service.sendEvent("chat.user_message", _chatPayload("msg-2"));

    await _waitFor(() => server.ofType("chat.user_message").length >= 2);
    final List<Map<String, dynamic>> sent =
        server.ofType("chat.user_message").toList();
    expect(
      sent.map((Map<String, dynamic> f) => server.payloadOf(f)["messageId"]).toSet(),
      <String>{"msg-2"},
      reason: "重投必须复用原 messageId（服务端按它做 turn 级幂等）",
    );
    expect(
      server.ofType("session.init").length,
      greaterThanOrEqualTo(2),
      reason: "被拒后必须先补发 session.init 重新绑定身份",
    );
    expect(
      events.any((Map<String, dynamic> e) => e["type"] == "chat_delivery_failed"),
      isFalse,
      reason: "重投成功就不该报投递失败",
    );
  });

  test("反复被拒：用完重投次数后必须发 chat_delivery_failed", () async {
    ApiConfig.runtimeUserId = "owner@example.com";
    final _Harness server = await _startServer();
    server.rejectChatTimes = -1; // 一直拒
    final WsChatService service = _service(server.url);
    final List<Map<String, dynamic>> events = <Map<String, dynamic>>[];
    final StreamSubscription<Map<String, dynamic>> sub =
        service.events.listen(events.add);
    addTearDown(() async {
      await sub.cancel();
      await service.close();
      await server.close();
    });

    service.connect();
    await _waitFor(() => service.isConnected);
    service.sendEvent("chat.user_message", _chatPayload("msg-3"));

    await _waitFor(
      () => events.any(
        (Map<String, dynamic> e) => e["type"] == "chat_delivery_failed",
      ),
      timeout: const Duration(seconds: 8),
    );
    expect(
      server.ofType("chat.user_message").length,
      greaterThanOrEqualTo(2),
      reason: "放弃前必须真的重投过",
    );
  });

  test("无凭据时 session.init 只报一个身份，且与业务事件同源", () async {
    ApiConfig.runtimeUserId = null;
    ApiConfig.installIdentityProvider = null;
    final _Harness server = await _startServer();
    final WsChatService service = _service(server.url);
    addTearDown(() async {
      await service.close();
      await server.close();
    });

    service.connect();
    await _waitFor(() => server.ofType("session.init").isNotEmpty);

    final Map<String, dynamic> init =
        server.payloadOf(server.ofType("session.init").first);
    expect(
      init["userId"],
      ApiConfig.effectiveActorId,
      reason: "session.init 的身份必须就是全链路生效值（与消息里同一算法）",
    );
    expect(
      init["userId"],
      isNot(ApiConfig.sessionId),
      reason: "不再上报编译期占位身份 session-mvp-001",
    );
    expect(
      init.containsKey("sessionId"),
      isFalse,
      reason: "身份只留一个字段，避免 init 与消息各报一套导致服务端判 FORBIDDEN",
    );
  });

  test("服务端 IDENTITY_REQUIRED：清本地凭据并发一次性 ws_auth_expired", () async {
    ApiConfig.runtimeUserId = null;
    await AccessCredentialStore.instance.save(
      const AccessDeviceBinding(
        token: "stale-token",
        userId: "owner@example.com",
      ),
    );
    expect(AccessCredentialStore.instance.hasCredentials, isTrue);

    final _Harness server = await _startServer();
    server.rejectInitCode = "IDENTITY_REQUIRED";
    final WsChatService service = _service(server.url);
    final List<Map<String, dynamic>> events = <Map<String, dynamic>>[];
    final StreamSubscription<Map<String, dynamic>> sub =
        service.events.listen(events.add);
    addTearDown(() async {
      await sub.cancel();
      await service.close();
      await server.close();
      await AccessCredentialStore.instance.clear();
    });

    service.connect();
    await _waitFor(
      () => events.any((Map<String, dynamic> e) => e["type"] == "ws_auth_expired"),
    );

    expect(
      AccessCredentialStore.instance.hasCredentials,
      isFalse,
      reason: "脏身份必须清掉，否则每次重连都会带着它再被拒一次",
    );
  });
}
