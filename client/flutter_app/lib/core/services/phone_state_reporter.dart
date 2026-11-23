import "dart:async";
import "dart:io" show Platform;

import "package:flutter/foundation.dart";
import "package:flutter/services.dart";

import "phone_state_buckets.dart";
import "ws_chat_service.dart";
import "ws_event_router.dart"
    show WsEventCatalog, WsEventRouter, WsSubscribeScope;

/// 手机状态上报（2026-11-23 主动触达 M1）。
///
/// 原生 [PhoneStateMonitor]（KeepAlivePlugin 的 `nextbot/phone_state` 事件源）在亮灭屏 /
/// 解锁 / 通话 / 勿扰 / 充电变化时推一帧，本类经**主连接** `WsChatService.shared` 发
/// `client.presence_state`，服务端据此：
///   - 解锁在用 → 刷新在场（不再把「手机常连」误判成「人在」）；
///   - 通话中 / 勿扰 → 非必达主动消息延后重判。
///
/// 只用已有基建：不开新连接、不加轮询器——
///   - 变化即报（原生侧已 300ms 去抖 + 去重）；
///   - 10 分钟心跳：服务端状态 30 分钟没刷新即作废，心跳保证长时间不变的状态（一直亮屏
///     看视频、一直勿扰）仍然有效；
///   - 主连接重连（总线 `ws_connected`）后补报一次当前值。
///
/// 离线时不进主连接的待发队列：状态是「此刻」的，断线期间积压的旧状态补发只会误导服务端，
/// 重连后由 `ws_connected` 补报最新值即可。
class PhoneStateReporter {
  PhoneStateReporter._();

  static final PhoneStateReporter instance = PhoneStateReporter._();

  static const EventChannel _events = EventChannel("nextbot/phone_state");
  static const MethodChannel _methods = MethodChannel("nextbot/keep_alive");
  static const String _eventType = "client.presence_state";
  static const Duration _heartbeat = Duration(minutes: 10);

  StreamSubscription<dynamic>? _nativeSub;
  Timer? _heartbeatTimer;
  bool _started = false;

  /// 最近一次原生上报的状态（重连补报与心跳兜底用）
  Map<String, dynamic>? _last;

  /// 15 分钟桶聚合器（§7.2：原始事件不出端，出端的是桶）
  final PhoneStateBucketAggregator _buckets = PhoneStateBucketAggregator();

  /// 幂等：bootstrap 在拉起保活服务后调用一次。仅 Android 生效。
  void start() {
    if (_started || kIsWeb || !Platform.isAndroid) return;
    _started = true;

    _nativeSub = _events.receiveBroadcastStream().listen(
      (dynamic raw) {
        final Map<String, dynamic>? state = _normalize(raw);
        if (state == null) return;
        _last = state;
        _buckets.observe(state);
        _send(state);
      },
      onError: (Object e) => debugPrint("[phone-state] native stream error: $e"),
    );

    _heartbeatTimer = Timer.periodic(_heartbeat, (_) => unawaited(_beat()));

    WsEventRouter.instance.subscribe(
      module: "phone-state-reporter",
      types: WsEventCatalog.connectionState,
      scope: WsSubscribeScope.root,
      onEvent: (Map<String, dynamic> event) {
        if (event["type"] == "ws_connected") unawaited(_beat());
      },
    );
  }

  void stop() {
    _flushBuckets();
    unawaited(_nativeSub?.cancel());
    _nativeSub = null;
    _heartbeatTimer?.cancel();
    _heartbeatTimer = null;
    _started = false;
  }

  /// 心跳 / 重连补报：优先取原生即时快照，取不到退回最近一次推送值。
  Future<void> _beat() async {
    Map<String, dynamic>? state;
    try {
      state = _normalize(await _methods.invokeMethod<Object>("getPhoneState"));
    } on MissingPluginException {
      state = null;
    } catch (e) {
      debugPrint("[phone-state] snapshot failed: $e");
    }
    state ??= _last;
    if (state == null) return;
    _last = state;
    // 心跳本身也是桶的一帧：没有状态变化时，靠它把亮屏时长继续记下去
    _buckets.observe(state);
    _send(state);
    _flushBuckets();
  }

  /// 已结束桶的批量上报（同一条 `client.presence_state` 链路，按 payload 区分）。
  /// 服务端见到 `buckets` 字段就走落库，不当作实时状态刷新在场。
  void _flushBuckets() {
    final List<Map<String, dynamic>> closed = _buckets.drainClosed();
    if (closed.isEmpty) return;
    final WsChatService ws = WsChatService.shared;
    if (!ws.isConnected) return;
    ws.sendEvent(_eventType, <String, dynamic>{
      "buckets": closed,
      "clientTime": DateTime.now().toIso8601String(),
    });
  }

  void _send(Map<String, dynamic> state) {
    final WsChatService ws = WsChatService.shared;
    if (!ws.isConnected) return; // 见类注释：离线不排队
    ws.sendEvent(_eventType, <String, dynamic>{
      ...state,
      "clientTime": DateTime.now().toIso8601String(),
    });
  }

  static Map<String, dynamic>? _normalize(Object? raw) {
    if (raw is! Map) return null;
    bool flag(String k) => raw[k] == true;
    return <String, dynamic>{
      "interactive": flag("interactive"),
      // 缺省按亮屏：只有原生明确报 false 才算灭屏（与服务端解析口径一致）
      "screenOn": raw["screenOn"] != false,
      "inCall": flag("inCall"),
      "dnd": flag("dnd"),
      "charging": flag("charging"),
    };
  }
}
