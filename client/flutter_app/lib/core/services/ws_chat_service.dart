import "dart:async";
import "dart:convert";
import "dart:math" as math;

import "package:flutter/foundation.dart";
import "package:web_socket_channel/web_socket_channel.dart";

import "../config/api_config.dart";
import "access_auth_api.dart";
import "ws_session_init.dart";

class _PendingWsEvent {
  const _PendingWsEvent({required this.type, required this.payload});

  final String type;
  final Map<String, dynamic> payload;
}

class WsChatService {
  /// [heartbeatInterval] / [heartbeatTimeout] / [probeGrace] / [connectTimeout]
  /// 默认即生产值，只有测试会注入更短的时序（秒级跑完空闲判死路径）。
  WsChatService({
    required this.url,
    Duration heartbeatInterval = const Duration(seconds: 20),
    Duration heartbeatTimeout = const Duration(seconds: 75),
    Duration probeGrace = const Duration(seconds: 10),
    Duration connectTimeout = const Duration(seconds: 12),
    Duration ackTimeout = const Duration(seconds: 8),
  })  : _heartbeatInterval = heartbeatInterval,
        _heartbeatTimeout = heartbeatTimeout,
        _probeGrace = probeGrace,
        _connectTimeout = connectTimeout,
        _ackTimeout = ackTimeout;

  /// 进程内唯一连接：连接、解码、心跳、重连、在途重投、握手 `session.init`
  /// 全部唯一（对齐主流"一站一条长连接"的做法）。业务事件由
  /// [WsEventRouter] 按归属表分拣，各模块只订阅自己的通道。
  /// 需要独立连接的场景（测试注入 wsBaseUrl）继续走构造函数。
  static final WsChatService shared = WsChatService(url: ApiConfig.wsUrl);

  final String url;
  WebSocketChannel? _channel;
  StreamSubscription<dynamic>? _subscription;
  final StreamController<Map<String, dynamic>> _eventsController =
      StreamController<Map<String, dynamic>>.broadcast();
  Timer? _reconnectTimer;
  Timer? _heartbeatTimer;
  Timer? _connectTimer;
  int _reconnectAttempts = 0;
  // 移动网络铁律（2026-11-10）：永不放弃重连。旧实现 10 次耗尽后永久躺平，
  // NAT/息屏掐掉空闲 TCP 后 App 表现为「假在线」——界面正常、消息全进离线
  // 队列永不补发（真机实证：服务端 WAL 半天无一条新消息）。_reconnectAttempts
  // 只用于退避计算（封顶 _maxReconnectDelay），不再作上限。
  static const Duration _initialReconnectDelay = Duration(seconds: 2);
  static const Duration _maxReconnectDelay = Duration(seconds: 30);
  final Duration _heartbeatInterval;
  final Duration _heartbeatTimeout;
  static const Duration _minHealthyConnectionDuration = Duration(seconds: 12);

  /// 建连超时：`channel.ready` 长期 pending（半开握手/网络抖动）时主动判死
  /// 走退避重连——否则 `_isConnecting` 恒 true，后续 start/ensureConnected
  /// 全部空转，App 会卡在「假装正在连」的状态直到下一次回前台。
  final Duration _connectTimeout;

  /// 空闲探测的等待宽限（2026-11-11 真机「对话卡住」根修）。
  ///
  /// 旧实现发完 `ws.keepalive` 探测后**同步**再判一次入站静默，ack 连一个
  /// 网络往返都来不及回来，于是「只要空闲超过 [_heartbeatTimeout] 就必然
  /// 断链重连」。App 一回前台发消息正好撞上这个窗口：消息被扣进待发队列、
  /// 连接被主动拆掉，表现就是「气泡发出去了，永远等不到回复」。
  /// 现在探测发出后给 [_probeGrace] 的宽限，收到任何入站即视为链路活着。
  final Duration _probeGrace;

  /// 聊天消息等待服务端 ack 的上限（投递确认看门狗）。
  ///
  /// 服务端收到消息后立刻回 `chat.message_received`（协议级，与模型生成无关），
  /// 正常链路几毫秒。超过这个时长仍无 ack，说明消息很可能沉在半开连接里——
  /// 此时不能等 75s 心跳，必须主动探活/判死重连并重投。
  final Duration _ackTimeout;

  /// 退避抖动源（见 [_calculateBackoffDelay]）。
  static final math.Random _rng = math.Random();
  bool _isConnecting = false;
  bool _isConnected = false;
  bool _manualClose = false;
  final List<_PendingWsEvent> _pendingOutbound = <_PendingWsEvent>[];
  DateTime _lastInboundAt = DateTime.fromMillisecondsSinceEpoch(0);
  DateTime _connectedAt = DateTime.fromMillisecondsSinceEpoch(0);

  /// 最近一次空闲探测（`reason=idle_probe`/`pre_send_probe`）的发出时刻；
  /// 收到任意入站即复位。用于给 ack 留出往返时间，不再同步判死。
  DateTime _probeSentAt = DateTime.fromMillisecondsSinceEpoch(0);

  /// 已写入 socket、尚未拿到服务端 ack 的 `chat.user_message`（messageId → 事件）。
  ///
  /// 半开连接上 `sink.add` 既不抛错也不阻塞，消息只是沉进内核发送缓冲区，客户端却
  /// 认定「已发出」。链路随后被判死时
  /// 这些消息回补进 [_pendingOutbound]，重连后原样重发。重发是安全的：服务端
  /// MessageBatchProcessor 按 `(sessionId, messageId)` 做 10 分钟 turn 级幂等，
  /// 重复投递只记日志「重复投递被拒」并静默丢弃，不会重复跑轮次/重复触发工具。
  final Map<String, _PendingWsEvent> _chatInFlight = <String, _PendingWsEvent>{};

  /// messageId → 已重投次数；防止死循环重投（超过上限回 [chat_delivery_failed]）。
  final Map<String, int> _chatRedeliveryCount = <String, int>{};
  static const int _maxChatRedeliveries = 3;

  /// messageId → 写入 socket 的时刻（投递确认看门狗用）。
  ///
  /// 半开连接上「消息沉没」的唯一可见信号就是「迟迟没有 ack」：服务端的
  /// `chat.message_received` 是协议级 ack（<1ms，与模型生成速度无关），
  /// 正常链路几毫秒内必回。这里把「无 ack」当成待查线索而不是等心跳:
  /// 心跳判死最长要 75s+宽限，用户只会看到「一直在想」。
  final Map<String, DateTime> _chatSentAt = <String, DateTime>{};
  Timer? _ackWatchdog;

  /// 本条连接已上报给服务端的身份（= 最近一次 `session.init` 的 userId）。
  ///
  /// 服务端把连接钉在第一次 `session.init` 的 actor 上（`boundActorId`），之后
  /// 每条 `chat.user_message` 都要过 `msgActor === boundActorId` 一致性校验，
  /// 不一致直接 `error.event(FORBIDDEN)` 丢弃、**不落任何审计**。
  ///
  /// 2026-11-11 真机「消息发出去了、服务端零记录、界面永远停在『我看看』」正是
  /// 这条：启动期账号读盘晚于建连，握手时身份还是默认 `session-mvp-001`，
  /// 消息却带着恢复后的登录邮箱发出。所以任何业务事件发送前都要确认
  /// 「已上报身份 == 当前生效身份」，不一致就先补发一次 session.init。
  String? _announcedActorId;

  /// 续期进行中标记：服务端 TOKEN_INVALID 可能连发两帧，重复续期会互相顶掉。
  bool _tokenRefreshInFlight = false;

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
    if (_isConnecting || _isConnected) return;
    // 临期凭据在后台换新，不阻塞建连：当前 token 还在有效期内，建连能用；
    // 换完下次重连（或 401 兜底）就用新凭据，用户不会在某个时间点突然被踢。
    if (AccessCredentialStore.instance.needsRefresh) {
      unawaited(AccessAuthApi().refresh());
    }
    _connectWithRetry();
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
  /// 已连接则空转；断线时重置计数强制重连——App 在后台放久了 WS 链路可能
  /// 已被中间设备掐断，回前台必须重新握一次手，服务端主动消息才送得进来。
  /// 不强制断开现有连接（与 [retryConnect] 的差异）。
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
          // 有入站即证明链路活着：清掉探测标记，让下一次空闲重新计时。
          _probeSentAt = DateTime.fromMillisecondsSinceEpoch(0);
          final Map<String, dynamic> event =
              jsonDecode(data.toString()) as Map<String, dynamic>;
          _handleServerRejection(event);
          _confirmChatDelivery(event);
          _emitEvent(event);
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
          _connectTimer?.cancel();
          _connectTimer = null;
          _isConnected = true;
          _reconnectAttempts = 0;
          _isConnecting = false;
          _lastInboundAt = DateTime.now();
          // 新连接从零开始计空闲：上一轮的探测时间戳必须清掉，否则一进入
          // 空闲就按「上轮探测早已超宽限」误判死链。
          _probeSentAt = DateTime.fromMillisecondsSinceEpoch(0);
          _connectedAt = _lastInboundAt;
          _startHeartbeat(channel);
          // 握手即上报身份：连接层唯一一份 session.init，必须先于任何业务事件
          // 与重连补发队列（否则服务端把消息归错车道）。
          _sendSessionInit();
          _emitEvent(<String, dynamic>{
            "type": "ws_connected",
            "payload": <String, dynamic>{
              "url": url,
              "connectedAt": _connectedAt.toIso8601String(),
            },
          });
          // session.init 必须先于补发队列：重连补发的 chat.user_message 若抢在
          // session.init 之前到达，服务端会归错车道。
          onConnected?.call();
          _flushPendingOutbound();
        }).catchError((Object _) {
          if (!identical(_channel, channel)) return;
          _connectTimer?.cancel();
          _connectTimer = null;
          _handleDisconnect(channel);
        }),
      );
      // 建连超时兜底：ready 不 resolve 也要能进入重连节奏。
      _connectTimer?.cancel();
      _connectTimer = Timer(_connectTimeout, () {
        if (!identical(_channel, channel) || _isConnected) return;
        debugPrint("[ws] connect timeout > ${_connectTimeout.inSeconds}s");
        _handleDisconnect(channel);
      });
    } catch (e) {
      _notifyDisconnected();
      _handleConnectionError();
    }
  }

  /// 事件出口统一收口：连接被 close（页面销毁 / 测试收尾）之后仍有迟到的
  /// socket 回调，直接丢弃，避免 "Bad state: Cannot add new events after
  /// calling close" 把整个测试进程带崩。
  void _emitEvent(Map<String, dynamic> event) {
    if (_eventsController.isClosed) return;
    _eventsController.add(event);
  }

  /// 握手后的唯一一份 `session.init`（每次（重）连都补发：服务端按连接重新
  /// 登记 actor / 设备类别 / 时区 / 鉴权 token）。集中在此的原因见 [shared]。
  void _sendSessionInit({bool announceModelUnbind = false}) {
    try {
      final bool sent = _sendNow(
        "session.init",
        buildWsSessionInit(announceModelUnbind: announceModelUnbind),
      );
      // 只有真正写进 socket 才记为「已上报」：否则下一次发送会误以为身份
      // 已经同步过，继续带着旧绑定发消息。
      if (sent) _announcedActorId = ApiConfig.effectiveActorId;
    } catch (e) {
      debugPrint("[ws] session.init 组装失败：$e");
    }
  }

  /// 身份变了就补发 `session.init` 重新绑定服务端 actor（幂等、可直接重入）。
  ///
  /// 服务端允许同一连接重复 init，且以最后一次为准（connection.ts 每次
  /// `boundActorId = actorId`），因此不需要拆链重连——补一条 init 就能把
  /// 已经建立的连接改绑到新身份，连接上的其他模块（闹钟/围巾/推送）不受影响。
  ///
  /// 调用时机：登录/登出/切换账号后（main.dart 的身份写入点），以及任何业务
  /// 事件发送前的兜底（[_refreshIdentityIfNeeded]）。
  bool ensureIdentityAnnounced() {
    if (!_isConnected) return false;
    if (_announcedActorId == ApiConfig.effectiveActorId) return false;
    debugPrint("[ws] identity changed, re-announcing session.init");
    _sendSessionInit();
    return true;
  }

  /// 本机 BYOK 三元组变化（保存/停用自有模型）后立刻重发一条 `session.init`。
  ///
  /// 2026-11-11 根修：`buildWsSessionInit` 只在建连那一刻带 `modelProvider`，
  /// 服务端也只在这一帧按 actor 绑定/撤绑。服务接入页保存后旧实现既不重连
  /// 也不补发，当前连接上的服务端永远收不到新 key，用户看到「配置好了却
  /// 仍提示模型服务没配置好」。服务端允许同一连接重复 init 且以最后一帧
  /// 为准，因此这里补一帧即可即时生效，不必断线重连（闹钟/推送等旁路不受影响）。
  /// 未连接时返回 false——下次建连的握手自然会带上最新三元组。
  ///
  /// [clearModelBinding]：停用自有模型时必须置 true——服务端对「字段缺失」
  /// 是保留绑定，只有显式空对象才撤绑；不传的话云端绑定撤不掉，重装后
  /// 会幽灵复活（2026-11-12 修复）。
  bool reannounceSessionInit({bool clearModelBinding = false}) {
    if (!_isConnected) return false;
    _sendSessionInit(announceModelUnbind: clearModelBinding);
    return true;
  }

  /// 发送前的身份守卫（[_sendNow] 内调用）：不一致就先补 init，保证
  /// session.init 一定排在本条业务事件之前。
  void _refreshIdentityIfNeeded() {
    if (_channel == null || _channel!.closeCode != null) return;
    if (_announcedActorId == ApiConfig.effectiveActorId) return;
    debugPrint("[ws] identity mismatch before send, re-announcing session.init");
    _sendSessionInit();
  }

  /// 服务端明确拒收（`error.event`）时的自愈入口。
  ///
  /// `FORBIDDEN` / `SESSION_REQUIRED` 只有一种成因：连接绑定的 actor 与本机
  /// 当前身份不一致（启动期账号读盘晚于建连、登录/切换账号后没重新 init）。
  /// 这种拒收**不会**产生 `chat.message_received`，看门狗看到的只是「服务端
  /// 一直不回 ack」，如果只把计时基准前移就永远等下去——必须在这里把在途
  /// 消息重投一次。其余错误（schema/图片帧非法）重投也没用，交给 UI 展示。
  void _handleServerRejection(Map<String, dynamic> event) {
    if (event["type"] != "error.event") return;
    final Object? rawPayload = event["payload"];
    if (rawPayload is! Map) return;
    final String code = rawPayload["code"]?.toString() ?? "";
    if (code == "TOKEN_INVALID") {
      // 凭据过期 ≠ 登录失效。先拿旧凭据换新（服务端允许过期未超宽限期的
      // token 续期），成功就静默重绑，用户看不到任何提示；只有续期也失败
      // （被吊销/超宽限期）才回登录门禁。
      if (_tokenRefreshInFlight) return;
      _tokenRefreshInFlight = true;
      unawaited(() async {
        try {
          final AccessAuthResult<bool> r = await AccessAuthApi().refresh();
          if (r.ok) {
            debugPrint("[ws] access token refreshed, re-announcing identity");
            _announcedActorId = null;
            _sendSessionInit();
            return;
          }
        } catch (e) {
          debugPrint("[ws] token refresh failed: $e");
        } finally {
          _tokenRefreshInFlight = false;
        }
        _expireCredentials(rawPayload["message"]?.toString());
      }());
      return;
    }
    if (code == "IDENTITY_REQUIRED" || code == "AUTH_REQUIRED") {
      // 服务端判定本机在无凭据情况下自报了账号身份（账号身份只能由 token
      // 证明，服务端不会兜底信任），或服务端已强制要求登录而本机连安装标识
      // 都没报上。两种都是「继续重连也没用」，续期同样没意义——手里压根
      // 没有可用凭据。清掉本地凭据并回登录门禁。
      _expireCredentials(rawPayload["message"]?.toString());
      return;
    }
    if (code != "FORBIDDEN" && code != "SESSION_REQUIRED") return;
    if (_chatInFlight.isEmpty) {
      // 没有在途消息也要纠正绑定，否则下一条消息仍会被同一条规则拒收。
      _announcedActorId = null;
      _sendSessionInit();
      return;
    }
    debugPrint("[ws] chat rejected by server ($code), re-binding identity and redelivering");
    _announcedActorId = null;
    _sendSessionInit();
    _requeueChatInFlight();
    _flushPendingOutbound();
  }

  /// 凭据彻底不可用：清掉本机凭据并通知上层回登录门禁。
  ///
  /// 只有在「续期也失败」或「本来就无凭据却自报账号」时才走到这里。留着旧
  /// 凭据不删的话，每次重连都会带着同一份脏身份再被拒一次，永远绑不上。
  void _expireCredentials(String? message) {
    _announcedActorId = null;
    unawaited(AccessCredentialStore.instance.clear());
    debugPrint("[ws] credentials cleared, requiring re-login");
    _emitEvent(<String, dynamic>{
      "type": "ws_auth_expired",
      "payload": <String, dynamic>{
        "message": message ?? "登录状态已失效，请重新登录",
      },
    });
  }

  void _notifyDisconnected() {
    final bool wasConnected = _isConnected;
    _markDisconnected();
    if (wasConnected) {
      _emitEvent(<String, dynamic>{
        "type": "ws_disconnected",
        "payload": <String, dynamic>{
          "message": "与服务器的连接已断开",
        },
      });
    }
  }

  void _markDisconnected() {
    _connectTimer?.cancel();
    _connectTimer = null;
    _isConnected = false;
    _isConnecting = false;
    _connectedAt = DateTime.fromMillisecondsSinceEpoch(0);
    _probeSentAt = DateTime.fromMillisecondsSinceEpoch(0);
    // 连接没了，绑定也随之失效：重连后的 init 会重新记录。
    _announcedActorId = null;
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
      _chatSentAt.remove(id);
      if (_chatSentAt.isEmpty) {
        _ackWatchdog?.cancel();
        _ackWatchdog = null;
      }
    }
  }

  /// 投递确认看门狗：有 chat 消息迟迟拿不到服务端 ack 时，先探活、再判死重连。
  ///
  /// 为什么不能只靠心跳：心跳判死阈值 75s（+探测宽限），而「用户发了消息、
  /// 界面转圈、永远没有回复」的容忍上限只有几秒。ack 是协议级回执，8s 不到
  /// 只可能是消息沉在半开连接里——这时必须立刻动手，而不是让用户干等。
  void _ensureAckWatchdog() {
    if (_ackWatchdog != null) return;
    // 检查粒度跟随 ackTimeout：生产 8s → 2s 一次；测试注入短超时可秒级跑完。
    final int tickMs = (_ackTimeout.inMilliseconds ~/ 4).clamp(200, 2000);
    _ackWatchdog = Timer.periodic(
      Duration(milliseconds: tickMs),
      (_) => _checkUnackedChat(),
    );
  }

  void _checkUnackedChat() {
    if (_chatSentAt.isEmpty) {
      _ackWatchdog?.cancel();
      _ackWatchdog = null;
      return;
    }
    if (!_isConnected) return; // 断链由重连链路负责重投
    final DateTime now = DateTime.now();
    DateTime oldest = now;
    for (final DateTime at in _chatSentAt.values) {
      if (at.isBefore(oldest)) oldest = at;
    }
    if (now.difference(oldest) < _ackTimeout) return;

    final bool hasProbe =
        _probeSentAt != DateTime.fromMillisecondsSinceEpoch(0);
    if (hasProbe) {
      if (_lastInboundAt.isAfter(_probeSentAt)) {
        // 探测有回应：链路是活的，只是这条消息的 ack 没来（服务端慢/丢了）。
        // 把计时基准推到现在避免每 2s 重复探活；后续 done/turn_started 仍会
        // 正常清表，不必在这里判死。
        for (final String id in _chatSentAt.keys.toList()) {
          _chatSentAt[id] = _lastInboundAt;
        }
        _probeSentAt = DateTime.fromMillisecondsSinceEpoch(0);
        return;
      }
      if (now.difference(_probeSentAt) > _probeGrace) {
        debugPrint(
            "[ws] chat ack timeout > ${_ackTimeout.inSeconds}s and probe unanswered, reconnecting");
        _probeSentAt = DateTime.fromMillisecondsSinceEpoch(0);
        final WebSocketChannel? ch = _channel;
        if (ch != null) _handleDisconnect(ch); // 在途消息随重连重投
      }
      return;
    }
    _sendNow("ws.keepalive", <String, dynamic>{
      "clientTime": now.toIso8601String(),
      "reason": "ack_watchdog",
    });
    _probeSentAt = now;
  }

  /// 链路被判死时，把在途 chat 消息回补进待发队列（重连后由
  /// [_flushPendingOutbound] 重发）。服务端按 `(sessionId, messageId)` 幂等，
  /// 重复投递会被静默丢弃，因此重发不会造成重复轮次/重复工具副作用。
  void _requeueChatInFlight() {
    if (_chatInFlight.isEmpty) return;
    final List<_PendingWsEvent> requeued = <_PendingWsEvent>[];
    final List<String> abandoned = <String>[];
    for (final MapEntry<String, _PendingWsEvent> entry
        in _chatInFlight.entries) {
      final int attempts = (_chatRedeliveryCount[entry.key] ?? 0) + 1;
      if (attempts > _maxChatRedeliveries) {
        // 放弃重投：必须显式告知 UI（否则界面永远停在「处理中」），
        // 服务端 turn 幂等/心跳判死仍会兜底，不再造新事件。
        _chatRedeliveryCount.remove(entry.key);
        _chatSentAt.remove(entry.key);
        abandoned.add(entry.key);
        continue;
      }
      _chatRedeliveryCount[entry.key] = attempts;
      requeued.add(entry.value);
    }
    _chatInFlight.clear();
    _chatSentAt.clear();
    if (requeued.isNotEmpty) {
      _pendingOutbound.insertAll(0, requeued);
    }
    for (final String id in abandoned) {
      debugPrint("[ws] chat delivery abandoned after $_maxChatRedeliveries retries: $id");
      _emitEvent(<String, dynamic>{
        "type": "chat_delivery_failed",
        "payload": <String, dynamic>{
          "messageId": id,
          "message": "消息没能送达服务器，请检查网络后重试",
        },
      });
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
        // 空闲超阈值：先发探测，给一个网络往返的宽限再判死。
        // 旧实现在这一行之后立刻同步复查 _lastInboundAt（ack 不可能已回），
        // 等价于「空闲超时必断链」——每 75~95s 无条件拆一次连接，用户发消息
        // 撞上窗口就卡住（2026-11-11）。
        final Duration sinceProbe =
            DateTime.now().difference(_probeSentAt);
        final bool probing = _probeSentAt !=
                DateTime.fromMillisecondsSinceEpoch(0) &&
            sinceProbe <= _probeGrace;
        if (probing) return; // 探测在途，等下个 tick 看 ack
        if (_probeSentAt != DateTime.fromMillisecondsSinceEpoch(0) &&
            sinceProbe > _probeGrace) {
          // 上轮探测已过宽限仍零入站：链路确实死了，走重连。
          debugPrint("[ws] idle probe timeout > ${_probeGrace.inMilliseconds}ms, reconnecting");
          _handleDisconnect(channel);
          return;
        }
        _sendNow(
          "ws.keepalive",
          <String, dynamic>{
            "clientTime": DateTime.now().toIso8601String(),
            "reason": "idle_probe",
          },
        );
        _probeSentAt = DateTime.now();
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
    // 无限重连（2026-11-10）：退避封顶 30s 后循环重试直到连上，绝不停止调度。
    // connection_error 只作为诊断事件发一次（跨过 10 次阈值时），供 UI 提示
    // 「网络不稳定」，但连接层绝不停手。
    if (_isConnecting) return;
    if (_reconnectTimer != null) return;
    _reconnectAttempts++;
    if (_reconnectAttempts == 10) {
      _emitEvent(<String, dynamic>{
        "type": "connection_error",
        "payload": <String, dynamic>{
          "message": "网络不稳定，正在自动重连…",
          "attempts": _reconnectAttempts,
          "url": url,
        },
      });
    }

    final Duration currentDelay = _calculateBackoffDelay();
    debugPrint(
      "Attempting to reconnect ($_reconnectAttempts) "
      "in ${currentDelay.inSeconds} seconds...",
    );

    _reconnectTimer?.cancel();
    _reconnectTimer = Timer(currentDelay, () {
      _reconnectTimer = null;
      _connectWithRetry();
    });
  }

  Duration _calculateBackoffDelay() {
    final bool wasBriefConnection =
        _connectedAt != DateTime.fromMillisecondsSinceEpoch(0) &&
        DateTime.now().difference(_connectedAt) < _minHealthyConnectionDuration;
    if (wasBriefConnection && _reconnectAttempts <= 2) {
      // 短命连接（连上就掉）快重试，同样叠抖动：多设备同刻被踢时打散。
      return Duration(milliseconds: 800 + _rng.nextInt(240));
    }
    final int exponent = (_reconnectAttempts - 1).clamp(0, 16); // 封顶后恒 30s，防 1<<n 溢出
    final int delayInSeconds = (_initialReconnectDelay.inSeconds * (1 << exponent)).clamp(
      _initialReconnectDelay.inSeconds,
      _maxReconnectDelay.inSeconds,
    );
    // ±30% 抖动：服务端重启/网络恢复时全量设备不会同刻敲门（雷群）。
    final int jitterMs = _rng.nextInt((delayInSeconds * 1000 * 0.3).ceil() + 1);
    return Duration(milliseconds: delayInSeconds * 1000 + jitterMs);
  }

  bool sendEvent(String type, Map<String, dynamic> payload) {
    if (_isConnected && _channel != null && _channel!.closeCode == null) {
      // 半开连接自检：链路已被中间设备静默掐断时 `sink.add` 不抛错，消息只会沉在
      // 内核发送缓冲区里，客户端却当成「已发出」，回复永远不来。
      //
      // 覆盖所有业务事件（不只聊天消息）：卡片按钮（card.action「就这家/确认下单」）
      // 同样有这个问题，用户点了没反应比消息没回复更难察觉。心跳自身不探活，
      // 否则一个 keepalive 会再触发一个 keepalive。
      if (type != "ws.keepalive" && _isInboundStale()) {
        // 空闲后回前台发第一条消息的常态：入站静默超阈值，但链路往往还活着。
        // 旧实现在这里把消息扣进待发队列、立刻拆链、再 return true（假装已发），
        // 重连退避一拉长就变成「气泡发出去了，永远等不到回复」——2026-11-11
        // 真机「对话卡住」的根因之一。
        // 新语义：先探活（给服务端一次 RTT 机会），事件照常走 socket。链路真死
        // 时 sink.add 会沉进发送缓冲区、链路随后被判死，_chatInFlight 按原
        // messageId 重投，服务端 turn 级幂等（10 分钟）会静默丢弃重复，不会跑两轮。
        //
        // 非 chat 事件（card.action 等）只探活不自动重投：服务端对卡片动作没有
        // 幂等键，重投等于重复下单。链路真死时交给「判死 → 用户重试」。
        _sendNow(
          "ws.keepalive",
          <String, dynamic>{
            "clientTime": DateTime.now().toIso8601String(),
            "reason": "pre_send_probe",
          },
        );
        _probeSentAt = DateTime.now();
        return _sendNow(type, payload);
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

  /// 卡片内动作（2026-11-06 定稿）：与 [sendCardAction] 是两条路。
  ///
  /// [sendCardAction] 会走 `chat.user_action`，服务端把它转写成 user_message，
  /// 于是必然多一条用户气泡 + 一轮模型生成 + 一条助手回复；
  /// 本方法走 `card.action`，服务端只回 `card.update` 把这张卡**原地**换掉，
  /// 消息列表长度不变。用于购物流程里「就这家 / 确认下单 / 查物流」这类
  /// 一步到下一步的动作。
  bool sendCardActionEvent({
    required String sessionId,
    required String messageId,
    required String actionId,
    String cardId = "",
    String stage = "",
    Map<String, dynamic>? payload,
  }) {
    return sendEvent("card.action", <String, dynamic>{
      "sessionId": sessionId,
      "messageId": messageId,
      "cardId": cardId,
      "actionId": actionId,
      if (stage.isNotEmpty) "stage": stage,
      if (payload != null && payload.isNotEmpty) "payload": payload,
    });
  }

  bool _sendNow(String type, Map<String, dynamic> payload) {
    if (_channel == null || _channel!.closeCode != null) {
      // 通道已不可用：业务事件留待重连补发；心跳类直接丢（否则待发队列被
      // keepalive 垃圾灌满，重连后还要逐条净发）。
      if (type != "ws.keepalive") {
        _pendingOutbound.add(_PendingWsEvent(type: type, payload: payload));
      }
      return false;
    }
    // 身份守卫：任何业务事件都必须带着「连接已绑定的那个身份」出去，否则
    // 服务端按 msgActor !== boundActorId 直接拒收（且不落审计，客户端只能
    // 看到永远等不到回复）。session.init 自己不能走这条，否则递归。
    if (type != "session.init") {
      _refreshIdentityIfNeeded();
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
          _chatSentAt[id] = DateTime.now();
          _ensureAckWatchdog();
        }
      }
      return true;
    } catch (e) {
      _markDisconnected();
      if (type != "ws.keepalive") {
        _pendingOutbound.add(_PendingWsEvent(type: type, payload: payload));
      }
      _handleConnectionError();
      return false;
    }
  }

  Future<void> close() async {
    _manualClose = true;
    _reconnectTimer?.cancel();
    _reconnectTimer = null;
    _stopHeartbeat();
    _ackWatchdog?.cancel();
    _ackWatchdog = null;
    await _subscription?.cancel();
    _subscription = null;
    _isConnecting = false;
    _isConnected = false;
    _pendingOutbound.clear();
    _chatInFlight.clear();
    _chatRedeliveryCount.clear();
    _chatSentAt.clear();
    // 1001(goingAway) 被 web_socket 包 checkCloseCode 拒绝（只收 1000/3000-4999），
    // 会抛 ArgumentError 成未捕获异步异常；统一用 1000 正常关闭。
    await _channel?.sink.close(1000);
    await _eventsController.close();
  }
}
