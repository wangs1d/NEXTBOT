import "dart:async";
import "dart:convert";

import "package:flutter/foundation.dart";
import "package:web_socket_channel/web_socket_channel.dart";
import "package:web_socket_channel/status.dart" as status;

class _PendingWsEvent {
  const _PendingWsEvent({required this.type, required this.payload});

  final String type;
  final Map<String, dynamic> payload;
}

class WsChatService {
  WsChatService({required this.url});

  final String url;
  WebSocketChannel? _channel;
  StreamSubscription<dynamic>? _subscription;
  final StreamController<Map<String, dynamic>> _eventsController =
      StreamController<Map<String, dynamic>>.broadcast();
  Timer? _reconnectTimer;
  Timer? _heartbeatTimer;
  int _reconnectAttempts = 0;
  static const int _maxReconnectAttempts = 10;
  static const Duration _initialReconnectDelay = Duration(seconds: 2);
  static const Duration _maxReconnectDelay = Duration(seconds: 30);
  static const Duration _heartbeatInterval = Duration(seconds: 20);
  static const Duration _heartbeatTimeout = Duration(seconds: 75);
  static const Duration _minHealthyConnectionDuration = Duration(seconds: 12);
  bool _isConnecting = false;
  bool _isConnected = false;
  bool _manualClose = false;
  final List<_PendingWsEvent> _pendingOutbound = <_PendingWsEvent>[];
  DateTime _lastInboundAt = DateTime.fromMillisecondsSinceEpoch(0);
  DateTime _connectedAt = DateTime.fromMillisecondsSinceEpoch(0);

  /// 已写入 socket、尚未拿到服务端 ack 的 `chat.user_message`（messageId → 事件）。
  ///
  /// 半开连接上 `sink.add` 既不抛错也不阻塞，消息只是沉进内核发送缓冲区，客户端却
  /// 认定「已发出」——直到 3 分钟看门狗报「抱歉，等待回复超时」。链路随后被判死时
  /// 这些消息回补进 [_pendingOutbound]，重连后原样重发。重发是安全的：服务端
  /// MessageBatchProcessor 按 `(sessionId, messageId)` 做 10 分钟 turn 级幂等，
  /// 重复投递只记日志「重复投递被拒」并静默丢弃，不会重复跑轮次/重复触发工具。
  final Map<String, _PendingWsEvent> _chatInFlight = <String, _PendingWsEvent>{};

  /// messageId → 已重投次数；防止死循环重投（超过上限回 [chat_delivery_failed]）。
  final Map<String, int> _chatRedeliveryCount = <String, int>{};
  static const int _maxChatRedeliveries = 3;

  /// 服务端 ack 事件名：三者的 payload 都带客户端 messageId（done 走 traceId）。
  static const Set<String> _chatAckEventTypes = <String>{
    "chat.message_received",
    "chat.turn_started",
    "chat.assistant_done",
  };

  /// 连接就绪（含重连后）时回调；应在此时发送 `session.init`。
  void Function()? onConnected;

  Stream<Map<String, dynamic>> get events => _eventsController.stream;

  bool get isConnected => _isConnected;

  void connect() {
    _manualClose = false;
    if (!_isConnecting && !_isConnected) {
      _connectWithRetry();
    }
  }

  /// 放弃重连计数后再次尝试（例如用户从设置页手动重连）。
  void retryConnect() {
    _manualClose = false;
    _reconnectAttempts = 0;
    _reconnectTimer?.cancel();
    _reconnectTimer = null;
    _stopHeartbeat();
    unawaited(_subscription?.cancel());
    _subscription = null;
    _isConnecting = false;
    _isConnected = false;
    _requeueChatInFlight();
    try {
      _channel?.sink.close(1000); // 使用正常的关闭代码
    } catch (e) {
      // WebSocket close error - silently ignore
    }
    _channel = null;
    _connectWithRetry();
  }

  /// 确保连接可用（App 回前台时调用，2026-10-20）。
  ///
  /// 已连接则空转；断线且重连次数耗尽（10 次退避后永久放弃）时重置计数
  /// 强制重连——否则 App 在后台放久了 WS 就再也回不来，服务端主动消息
  /// 只能挂起等下一次冷启动。不强制断开现有连接（与 [retryConnect] 的差异）。
  void ensureConnected() {
    if (_isConnected || _isConnecting || _manualClose) return;
    if (_channel != null && _channel!.closeCode == null) return;
    retryConnect();
  }

  void _connectWithRetry() {
    if (_isConnecting) return;
    _reconnectTimer?.cancel();
    _reconnectTimer = null;

    _isConnecting = true;
    try {
      final WebSocketChannel channel = WebSocketChannel.connect(Uri.parse(url));
      _channel = channel;

      _subscription = channel.stream.listen(
        (dynamic data) {
          if (!identical(_channel, channel)) return;
          _lastInboundAt = DateTime.now();
          final Map<String, dynamic> event =
              jsonDecode(data.toString()) as Map<String, dynamic>;
          _confirmChatDelivery(event);
          _eventsController.add(event);
        },
        onError: (Object error) {
          _handleDisconnect(channel);
        },
        onDone: () {
          _handleDisconnect(channel);
        },
        cancelOnError: false,
      );

      unawaited(
        channel.ready.then((_) {
          if (!identical(_channel, channel)) return;
          _isConnected = true;
          _reconnectAttempts = 0;
          _isConnecting = false;
          _lastInboundAt = DateTime.now();
          _connectedAt = _lastInboundAt;
          _startHeartbeat(channel);
          _eventsController.add(<String, dynamic>{
            "type": "ws_connected",
            "payload": <String, dynamic>{
              "url": url,
              "connectedAt": _connectedAt.toIso8601String(),
            },
          });
          // session.init 必须先于补发队列：重连补发的 chat.user_message 若抢在
          // session.init 之前到达，服务端会归错车道。旧实现先 flush 后 init。
          onConnected?.call();
          _flushPendingOutbound();
        }).catchError((Object _) {
          if (!identical(_channel, channel)) return;
          _handleDisconnect(channel);
        }),
      );
    } catch (e) {
      _notifyDisconnected();
      _handleConnectionError();
    }
  }

  void _notifyDisconnected() {
    final bool wasConnected = _isConnected;
    _markDisconnected();
    if (wasConnected) {
      _eventsController.add(<String, dynamic>{
        "type": "ws_disconnected",
        "payload": <String, dynamic>{
          "message": "与服务器的连接已断开",
        },
      });
    }
  }

  void _markDisconnected() {
    _isConnected = false;
    _isConnecting = false;
    _connectedAt = DateTime.fromMillisecondsSinceEpoch(0);
  }

  void _handleDisconnect(WebSocketChannel channel) {
    if (!identical(_channel, channel)) return;
    _stopHeartbeat();
    unawaited(_subscription?.cancel());
    _subscription = null;
    _channel = null;
    _requeueChatInFlight();
    _notifyDisconnected();
    if (_manualClose) return;
    _handleConnectionError();
  }

  /// 服务端已受理该条消息（[chat.message_received] / [chat.turn_started] /
  /// [chat.assistant_done] 都会带客户端 messageId），从在途表摘除。
  void _confirmChatDelivery(Map<String, dynamic> event) {
    final Object? type = event["type"];
    if (type is! String || !_chatAckEventTypes.contains(type)) return;
    final Object? payload = event["payload"];
    if (payload is! Map) return;
    // assistant_done 的关联字段是 traceId（= 客户端 messageId），其余是 messageId。
    final Object? id = payload["messageId"] ?? payload["traceId"];
    if (id is! String || id.isEmpty) return;
    if (_chatInFlight.remove(id) != null) {
      _chatRedeliveryCount.remove(id);
    }
  }

  /// 链路被判死时，把在途 chat 消息回补进待发队列（重连后由
  /// [_flushPendingOutbound] 重发）。服务端按 `(sessionId, messageId)` 幂等，
  /// 重复投递会被静默丢弃，因此重发不会造成重复轮次/重复工具副作用。
  void _requeueChatInFlight() {
    if (_chatInFlight.isEmpty) return;
    final List<_PendingWsEvent> requeued = <_PendingWsEvent>[];
    for (final MapEntry<String, _PendingWsEvent> entry
        in _chatInFlight.entries) {
      final int attempts = (_chatRedeliveryCount[entry.key] ?? 0) + 1;
      if (attempts > _maxChatRedeliveries) {
        // 放弃重投：交给既有的 3 分钟回合看门狗报「等待回复超时」，不再造新事件。
        _chatRedeliveryCount.remove(entry.key);
        continue;
      }
      _chatRedeliveryCount[entry.key] = attempts;
      requeued.add(entry.value);
    }
    _chatInFlight.clear();
    if (requeued.isNotEmpty) {
      _pendingOutbound.insertAll(0, requeued);
    }
  }

  /// 入站静默是否已超过心跳阈值（服务端每 20~30s 会推 embodiment / autonomy
  /// 事件，长时间零入站即链路已死或半开）。
  bool _isInboundStale() {
    if (_lastInboundAt == DateTime.fromMillisecondsSinceEpoch(0)) return true;
    return DateTime.now().difference(_lastInboundAt) > _heartbeatTimeout;
  }

  void _startHeartbeat(WebSocketChannel channel) {
    _stopHeartbeat();
    _heartbeatTimer = Timer.periodic(_heartbeatInterval, (_) {
      if (!identical(_channel, channel)) {
        _stopHeartbeat();
        return;
      }
      if (!_isConnected) return;
      final Duration idle = DateTime.now().difference(_lastInboundAt);
      if (idle > _heartbeatTimeout) {
        _sendNow(
          "ws.keepalive",
          <String, dynamic>{
            "clientTime": DateTime.now().toIso8601String(),
            "reason": "idle_probe",
          },
        );
        if (DateTime.now().difference(_lastInboundAt) > _heartbeatTimeout) {
          _handleDisconnect(channel);
        }
        return;
      }
      _sendNow(
        "ws.keepalive",
        <String, dynamic>{
          "clientTime": DateTime.now().toIso8601String(),
        },
      );
    });
  }

  void _stopHeartbeat() {
    _heartbeatTimer?.cancel();
    _heartbeatTimer = null;
  }

  void _flushPendingOutbound() {
    if (!_isConnected || _channel == null) return;
    final List<_PendingWsEvent> batch =
        List<_PendingWsEvent>.from(_pendingOutbound);
    _pendingOutbound.clear();
    for (final _PendingWsEvent item in batch) {
      _sendNow(item.type, item.payload);
    }
  }

  void _handleConnectionError() {
    if (_reconnectAttempts < _maxReconnectAttempts && !_isConnecting) {
      if (_reconnectTimer != null) return;
      _reconnectAttempts++;

      final Duration currentDelay = _calculateBackoffDelay();
      debugPrint(
        "Attempting to reconnect ($_reconnectAttempts/$_maxReconnectAttempts) "
        "in ${currentDelay.inSeconds} seconds...",
      );

      _reconnectTimer?.cancel();
      _reconnectTimer = Timer(currentDelay, () {
        _connectWithRetry();
      });
    } else if (_reconnectAttempts >= _maxReconnectAttempts) {
      debugPrint(
        "Max reconnection attempts reached. Please check your network "
        "connection and server status.",
      );
      _eventsController.add(<String, dynamic>{
        "type": "connection_error",
        "payload": <String, dynamic>{
          "message": "无法连接到服务器，请检查网络连接和服务器状态",
          "attempts": _reconnectAttempts,
          "url": url,
        },
      });
    }
  }

  Duration _calculateBackoffDelay() {
    final bool wasBriefConnection =
        _connectedAt != DateTime.fromMillisecondsSinceEpoch(0) &&
        DateTime.now().difference(_connectedAt) < _minHealthyConnectionDuration;
    if (wasBriefConnection && _reconnectAttempts <= 2) {
      return const Duration(milliseconds: 800);
    }
    final int exponent = _reconnectAttempts - 1;
    final int delayInSeconds = (_initialReconnectDelay.inSeconds * (1 << exponent)).clamp(
      _initialReconnectDelay.inSeconds,
      _maxReconnectDelay.inSeconds,
    );
    return Duration(seconds: delayInSeconds);
  }

  bool sendEvent(String type, Map<String, dynamic> payload) {
    if (_isConnected && _channel != null && _channel!.closeCode == null) {
      // 半开连接自检：链路已被中间设备静默掐断时 `sink.add` 不抛错，消息只会沉在
      // 内核发送缓冲区里，客户端却当成「已发出」——用户随后必然等到看门狗报
      // 「抱歉，等待回复超时」。服务端有稳定的周期性推送，入站静默超过心跳阈值
      // 即判死链：主动拆链入队、重连后再发，语义上仍算「已受理」。
      if (type == "chat.user_message" && _isInboundStale()) {
        _pendingOutbound.add(_PendingWsEvent(type: type, payload: payload));
        final WebSocketChannel? dead = _channel;
        if (dead != null) _handleDisconnect(dead);
        return true;
      }
      final result = _sendNow(type, payload);
      return result;
    }
    _pendingOutbound.add(_PendingWsEvent(type: type, payload: payload));
    if (!_isConnecting) {
      _connectWithRetry();
    }
    return false;
  }

  /// 离线待发队列里是否已有同类事件。
  ///
  /// 用于避免断线期间用户反复点击导致同类请求堆积（例如连点呼叫，恢复后
  /// 一次性补发好几通电话，除第一通外全撞忙线护栏）。只读查询，无副作用。
  bool hasPendingEvent(String type) {
    return _pendingOutbound.any((_PendingWsEvent e) => e.type == type);
  }

  bool sendContactFeedback({
    required String sessionId,
    required String channel,
    required bool responded,
    int? responseTimeMs,
    String? feedback,
    bool? quietHours,
  }) {
    return sendEvent("companion.contact_feedback", <String, dynamic>{
      "sessionId": sessionId,
      "channel": channel,
      "responded": responded,
      if (responseTimeMs != null) "responseTimeMs": responseTimeMs,
      if (feedback != null && feedback.isNotEmpty) "feedback": feedback,
      if (quietHours != null) "quietHours": quietHours,
    });
  }

  /// 发送「选择型卡片」底部按钮点击事件。
  /// 后端收到后转写为 chat.user_message 走原 chat 流程,
  /// 并在 payload 中保留 [cardAction] 元数据(actionId/cardId/variant/payload)
  /// 供审计/埋点/路由分流。
  ///
  /// - [messageId] 客户端生成,保证前端 UI 气泡与服务端审计可对齐
  ///   (与键盘输入发送消息的 messageId 用同一前缀体系)
  /// - [actionPayload] 是服务端为该 action 预埋的元数据(可空),原样透传
  /// - [cardTitle]/[cardItems] 卡片摘要,后端用它拼接上下文,
  ///   让 Agent 知道用户是在回应哪张卡片、卡片内容是什么,从而主动衔接
  bool sendCardAction({
    required String sessionId,
    required String messageId,
    required String actionId,
    required String label,
    String? cardId,
    String variant = "primary",
    Map<String, dynamic>? actionPayload,
    String? cardTitle,
    List<String>? cardItems,
    String? userId,
  }) {
    return sendEvent("chat.user_action", <String, dynamic>{
      "sessionId": sessionId,
      "messageId": messageId,
      "actionId": actionId,
      "cardId": cardId ?? "",
      "label": label,
      "variant": variant,
      "timestamp": DateTime.now().toIso8601String(),
      if (actionPayload != null && actionPayload.isNotEmpty)
        "payload": actionPayload,
      if (cardTitle != null && cardTitle.isNotEmpty) "cardTitle": cardTitle,
      if (cardItems != null && cardItems.isNotEmpty) "cardItems": cardItems,
      if (userId != null && userId.isNotEmpty) "userId": userId,
    });
  }

  bool _sendNow(String type, Map<String, dynamic> payload) {
    if (_channel == null || _channel!.closeCode != null) {
      return false;
    }
    try {
      final message = jsonEncode(<String, dynamic>{
        "type": type,
        "payload": payload,
      });
      _channel!.sink.add(message);
      // 记账「在途」：拿到服务端 ack 前若链路死掉，重连后按原 messageId 重发。
      if (type == "chat.user_message") {
        final Object? id = payload["messageId"];
        if (id is String && id.isNotEmpty) {
          _chatInFlight[id] =
              _PendingWsEvent(type: type, payload: payload);
        }
      }
      return true;
    } catch (e) {
      _markDisconnected();
      _pendingOutbound.add(_PendingWsEvent(type: type, payload: payload));
      _handleConnectionError();
      return false;
    }
  }

  Future<void> close() async {
    _manualClose = true;
    _reconnectTimer?.cancel();
    _reconnectTimer = null;
    _stopHeartbeat();
    await _subscription?.cancel();
    _subscription = null;
    _isConnecting = false;
    _isConnected = false;
    _pendingOutbound.clear();
    _chatInFlight.clear();
    _chatRedeliveryCount.clear();
    // 1001(goingAway) 被 web_socket 包 checkCloseCode 拒绝（只收 1000/3000-4999），
    // 会抛 ArgumentError 成未捕获异步异常；统一用 1000 正常关闭。
    await _channel?.sink.close(1000);
    await _eventsController.close();
  }
}
