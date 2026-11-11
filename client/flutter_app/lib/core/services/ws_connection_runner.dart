import "dart:async";
import "dart:convert";
import "dart:math" as math;

import "package:flutter/foundation.dart";
import "package:web_socket_channel/web_socket_channel.dart";

/// WS 连接生命周期基座（2026-11-10 连接收编）。
///
/// 「自管第二连接」（桌面桥 DesktopBridgeService / 手机桥 PhoneBridgeService）
/// 共用一套连接语义：连接建立（ready + 陈旧通道竞态守卫）、心跳（周期
/// keepalive + 入站静默判死可选）、指数退避重连、stop/poke 语义。此前两处
/// 各写一份 connect/heartbeat/reconnect，桌面桥是固定 4s 重连、手机桥是
/// 指数退避但没有判死——收编后取两者并集：退避 + 可选判死。
///
/// **不收编的连接**（有意为之，勿强行并线）：
/// - 聊天主连接 `WsChatService`：带离线排队/在途重投/半开自检，语义远重于
///   本基座，保持自有实现（本类语义与它对齐，后续演进以它为准绳）；
/// - 语音双工 `VoiceDuplexService`：按需短会话，呼叫结束即拆，无重连语义。
class WsConnectionRunner {
  WsConnectionRunner({
    required this.name,
    required String Function() urlProvider,
    required void Function(WebSocketChannel channel) onConnected,
    required void Function(Object? data) onMessage,
    required void Function(bool willReconnect) onDisconnected,
    bool Function()? gate,
    Map<String, dynamic> Function()? keepalivePayload,
    this.heartbeatInterval,
    this.heartbeatTimeout,
    this.probeGrace = const Duration(seconds: 10),
    this.reconnectDelay = const Duration(seconds: 4),
    this.maxReconnectDelay = const Duration(minutes: 2),
  })  : _urlProvider = urlProvider,
        _onConnected = onConnected,
        _onMessage = onMessage,
        _onDisconnected = onDisconnected,
        _gate = gate,
        _keepalivePayload = keepalivePayload;

  /// 日志/排查标识（如 "desktop-bridge"）。
  final String name;

  final String Function() _urlProvider;
  final void Function(WebSocketChannel channel) _onConnected;
  final void Function(Object? data) _onMessage;
  final void Function(bool willReconnect) _onDisconnected;
  final bool Function()? _gate;
  final Map<String, dynamic> Function()? _keepalivePayload;

  /// 心跳间隔（null = 不发 keepalive）。
  final Duration? heartbeatInterval;

  /// 入站静默判死阈值（null = 不判死；仅依赖底层断连事件）。
  final Duration? heartbeatTimeout;

  /// 空闲探测发出后等待 ack 的宽限；超宽限仍零入站才判死（与
  /// [WsChatService] 同一套三段式：探测 → 宽限 → 判死）。
  ///
  /// 没有宽限就会退化成「健康但安静的连接每隔 timeout 被无条件重连一次」。
  final Duration probeGrace;

  /// 重连退避基长与上限：delay * 2^attempt，clamp 到 [delay, max]，再叠
  /// ±30% 随机抖动（防服务端重启时全量客户端同刻重连形成雷群）。
  final Duration reconnectDelay;
  final Duration maxReconnectDelay;

  /// 建连阶段超时：`channel.ready` 长期 pending（网络抖动/半开握手）时
  /// 主动判死走退避重连，否则会卡在 connecting 再也排不上重连。
  static const Duration connectTimeout = Duration(seconds: 10);

  static final math.Random _rng = math.Random();

  WebSocketChannel? _channel;
  StreamSubscription<dynamic>? _subscription;
  Timer? _reconnectTimer;
  Timer? _heartbeatTimer;
  Timer? _connectTimer;
  bool _connecting = false;
  bool _connected = false;
  bool _manualStopped = false;
  int _reconnectAttempts = 0;
  DateTime _lastInboundAt = DateTime.fromMillisecondsSinceEpoch(0);

  /// 最近一次空闲探测的发出时刻；收到任意入站/重连成功即复位。
  DateTime _probeSentAt = DateTime.fromMillisecondsSinceEpoch(0);

  bool get connected => _connected;
  bool get connecting => _connecting;
  WebSocketChannel? get channel => _channel;

  /// 启动（幂等）：连接中/已连/已有重连排程时空转。
  void start() {
    _manualStopped = false;
    if (_gate != null && !_gate()) return;
    if (_channel != null || _connecting || _reconnectTimer != null) return;
    _connect();
  }

  /// 断开并停止重连（用户显式关闭）。
  void stop() {
    _manualStopped = true;
    _reconnectTimer?.cancel();
    _reconnectTimer = null;
    _teardown();
    _onDisconnected(false);
  }

  /// 确保连接可用（App 回前台等场景）：取消挂着的退避定时器、清零退避计数
  /// 后立即补连——后台放久了指数退避被拉满，回前台不等退避直接试。
  void pokeReconnect() {
    if (_manualStopped || _channel != null || _connecting) return;
    if (_gate != null && !_gate()) return;
    _reconnectTimer?.cancel();
    _reconnectTimer = null;
    _reconnectAttempts = 0;
    _connect();
  }

  /// 发送一条 `{type, payload}` 信封；通道未就绪/已关闭返回 false。
  ///
  /// **不排队**（有意）：桥接类关键消息（`*.register`、`session.init`）都在
  /// [onConnected] 回调里发，断线瞬间的普通消息丢掉即可——上层若需要「必达」
  /// 语义，应在自己的业务层做重试，而不是让连接层悄悄攒着一个永不清空的队列。
  bool send(String type, Map<String, dynamic> payload) {
    final WebSocketChannel? ch = _channel;
    if (ch == null || ch.closeCode != null) return false;
    try {
      ch.sink.add(jsonEncode(<String, dynamic>{"type": type, "payload": payload}));
      return true;
    } catch (e) {
      debugPrint("[$name] send failed: $e");
      return false;
    }
  }

  void _connect() {
    if (_manualStopped) return;
    if (_gate != null && !_gate()) return;
    _connecting = true;
    WebSocketChannel channel;
    try {
      channel = WebSocketChannel.connect(Uri.parse(_urlProvider()));
    } catch (e) {
      debugPrint("[$name] connect error: $e");
      _connecting = false;
      _handleDisconnect(null);
      return;
    }
    _channel = channel;
    _subscription = channel.stream.listen(
      (Object? data) {
        if (!identical(_channel, channel)) return;
        _lastInboundAt = DateTime.now();
        // 有入站即证明链路活着：清探测标记，下次空闲重新计时。
        _probeSentAt = DateTime.fromMillisecondsSinceEpoch(0);
        _onMessage(data);
      },
      onError: (Object _) => _handleDisconnect(channel),
      onDone: () => _handleDisconnect(channel),
      cancelOnError: false,
    );
    unawaited(
      channel.ready.then((_) {
        if (!identical(_channel, channel)) return;
        _connectTimer?.cancel();
        _connectTimer = null;
        _connected = true;
        _connecting = false;
        _reconnectAttempts = 0;
        _lastInboundAt = DateTime.now();
        // 新连接从零开始计空闲：上一轮的探测时间戳必须清掉，否则一进入
        // 空闲就按「上轮探测早已超宽限」误判死链。
        _probeSentAt = DateTime.fromMillisecondsSinceEpoch(0);
        _startHeartbeat(channel);
        _onConnected(channel);
      }).catchError((Object _) {
        if (!identical(_channel, channel)) return;
        _connectTimer?.cancel();
        _connectTimer = null;
        _handleDisconnect(channel);
      }),
    );
    // 建连超时：ready 长期不 resolve 时主动判死（否则 _connecting 恒 true，
    // start/poke 全部空转，连接永久卡死在半开握手上）。
    _connectTimer?.cancel();
    _connectTimer = Timer(connectTimeout, () {
      if (!identical(_channel, channel) || _connected) return;
      debugPrint("[$name] connect timeout > ${connectTimeout.inSeconds}s");
      _handleDisconnect(channel);
    });
  }

  void _handleDisconnect(WebSocketChannel? channel) {
    if (channel != null && !identical(_channel, channel)) return;
    final bool wasActive = _connected || _connecting;
    _teardown();
    _connected = false;
    _connecting = false;
    final bool willReconnect =
        !_manualStopped && wasActive && (_gate?.call() ?? true);
    _onDisconnected(willReconnect);
    if (willReconnect) _scheduleReconnect();
  }

  void _teardown() {
    _connectTimer?.cancel();
    _connectTimer = null;
    _heartbeatTimer?.cancel();
    _heartbeatTimer = null;
    _probeSentAt = DateTime.fromMillisecondsSinceEpoch(0);
    unawaited(_subscription?.cancel());
    _subscription = null;
    try {
      _channel?.sink.close(1000);
    } catch (_) {
      // 已断开时 close 可能抛错，忽略
    }
    _channel = null;
  }

  void _scheduleReconnect() {
    if (_reconnectTimer != null) return;
    final int exponent = _reconnectAttempts.clamp(0, 8);
    final int baseMs = (reconnectDelay.inMilliseconds * (1 << exponent))
        .clamp(reconnectDelay.inMilliseconds, maxReconnectDelay.inMilliseconds);
    // 抖动：base + [0, 30%·base]，再夹到上限。所有客户端同时掉线时把重连
    // 打散开，避免服务端刚起来就被同时敲门。
    final int jitterMs = _rng.nextInt((baseMs * 0.3).ceil() + 1);
    final int delayMs = math.min(baseMs + jitterMs, maxReconnectDelay.inMilliseconds);
    _reconnectAttempts += 1;
    _reconnectTimer = Timer(Duration(milliseconds: delayMs), () {
      _reconnectTimer = null;
      _connect();
    });
  }

  void _startHeartbeat(WebSocketChannel channel) {
    final Duration? interval = heartbeatInterval;
    if (interval == null) return;
    _heartbeatTimer?.cancel();
    _heartbeatTimer = Timer.periodic(interval, (_) {
      if (!identical(_channel, channel)) {
        _heartbeatTimer?.cancel();
        _heartbeatTimer = null;
        return;
      }
      if (!_connected) return;
      final Duration? timeout = heartbeatTimeout;
      if (timeout != null) {
        final Duration idle = DateTime.now().difference(_lastInboundAt);
        if (idle > timeout) {
          // 半开连接自检（三段式）：先探活，给一个网络往返的宽限；下个 tick
          // 仍零入站才判死。旧实现（2026-11-11 前）在 idle 超阈值时直接拆链，
          // 健康但安静的桥连接会每隔 timeout 被无条件重连一次。
          final bool hasProbe =
              _probeSentAt != DateTime.fromMillisecondsSinceEpoch(0);
          final Duration sinceProbe = DateTime.now().difference(_probeSentAt);
          if (hasProbe && sinceProbe <= probeGrace) return;
          if (hasProbe) {
            debugPrint(
                "[$name] idle probe timeout > ${probeGrace.inMilliseconds}ms, tearing down");
            _handleDisconnect(channel);
            return;
          }
          _probeSentAt = DateTime.now();
          final Map<String, dynamic> probePayload =
              Map<String, dynamic>.from(_keepalivePayload?.call() ??
                  <String, dynamic>{
                    "clientTime": DateTime.now().toIso8601String(),
                  })
                ..["reason"] = "idle_probe";
          send("ws.keepalive", probePayload);
          return;
        }
      }
      send("ws.keepalive",
          _keepalivePayload?.call() ??
              <String, dynamic>{
                "clientTime": DateTime.now().toIso8601String(),
              });
    });
  }
}
