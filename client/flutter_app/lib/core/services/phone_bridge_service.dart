import "dart:async";
import "dart:convert";
import "dart:io" show Platform;

import "package:flutter/foundation.dart";
import "package:flutter/services.dart";
import "package:geolocator/geolocator.dart";
import "package:web_socket_channel/web_socket_channel.dart";
import "package:web_socket_channel/status.dart" as ws_status;

import "../config/api_config.dart";
import "phone_capture_service.dart";
import "phone_dial_invoker.dart";
import "phone_sms_invoker.dart";

/// 手机桥接连接状态（供设置页开关旁的状态展示）。
enum PhoneBridgeStatus { disabled, connecting, online, offline }

/// 待上报的捕获消息批次（含 batchId，等 ack 出队）。
class _PendingReportBatch {
  _PendingReportBatch(this.batchId, this.messages, this.sentAt);
  final String batchId;
  final List<Map<String, dynamic>> messages;
  final DateTime sentAt;
}

/// 手机桥接客户端服务（运行在用户手机 App 内）。
///
/// 与网关建立一条**独立**于聊天会话的 WebSocket 连接：`session.init` 携带
/// `phoneBridge: true` + `userId`，把本机绑定为该用户的「手机执行器」，
/// 随后接收 `phone.bridge.invoke` 并以 `phone.bridge.result` 回执：
///  - `dial`：经 [PhoneDialInvoker] 拉起原生确认窗 → 用户确认后拨号；
///  - `send_sms`：经 [PhoneSmsInvoker] 拉起短信确认窗 → 确认后 SmsManager 真发；
///  - `sms_list` / `call_log` / `battery` / `ring`：经 pai/phone_bridge 原生方法直接执行；
///  - `locate`：geolocator 单次定位（与聊天定位同源）。
///
/// 上行（手机 → 服务端）：
///  - `phone.msg.report`：通知监听捕捉的消息批量上报（等 `phone.msg.report_ack`
///    按 batchId 出队；断线期间批量暂留内存，重连后连同落盘队列补报）；
///  - `phone.loc.report`：定位低频回传（可在设置页开关，默认关闭）。
///
/// 服务端协议（ws/connection.ts + phone-bridge-coordinator.ts）：
///  - 无口令模式（未配置 PHONE_BRIDGE_TOKEN）：session.init 即自动绑定；
///  - 口令模式：需再发 `phone.bridge.register` 携带 token。本服务两种都发，
///    重复 register 在无口令模式下只是幂等重复绑定，服务端行为安全。
class PhoneBridgeService {
  PhoneBridgeService._();

  static final PhoneBridgeService instance = PhoneBridgeService._();

  /// 本地偏好 key（是否启用手机桥接；默认开启，仅 Android 生效）
  static const String _prefKeyEnabled = "phone_bridge.enabled";
  /// 定位低频回传开关（默认关闭，设置页开启）
  static const String _prefKeyLocReport = "phone_bridge.loc_report";

  static const String _bridgeTokenFromEnv = String.fromEnvironment(
    "PHONE_BRIDGE_TOKEN",
  );

  Future<dynamic> Function(String key)? _readPref;
  Future<void> Function(String key, dynamic value)? _writePref;

  final ValueNotifier<PhoneBridgeStatus> status =
      ValueNotifier<PhoneBridgeStatus>(PhoneBridgeStatus.offline);

  bool _enabled = false;
  bool get isEnabled => _enabled;

  bool _locReportEnabled = false;
  bool get isLocationReportEnabled => _locReportEnabled;

  WebSocketChannel? _channel;
  StreamSubscription<dynamic>? _subscription;
  StreamSubscription<List<CapturedPhoneMessage>>? _captureSub;
  Timer? _reconnectTimer;
  Timer? _keepaliveTimer;
  Timer? _locReportTimer;
  int _reconnectAttempts = 0;
  bool _manualStopped = false;

  /// 捕获消息上报：待 ack 批次（重连后原样重发）与批量计数器
  final List<_PendingReportBatch> _pendingReports = <_PendingReportBatch>[];
  int _batchSeq = 0;

  static const Duration _initialReconnectDelay = Duration(seconds: 2);
  static const Duration _maxReconnectDelay = Duration(seconds: 30);
  static const Duration _keepaliveInterval = Duration(seconds: 20);
  static const int _maxReportMessages = 100;

  /// 注入本地偏好存取（与 ClientLocationService.bindPreferences 同模式，
  /// 由宿主在存储初始化后调用）。
  void bindPreferences({
    required Future<dynamic> Function(String key) read,
    required Future<void> Function(String key, dynamic value) write,
  }) {
    _readPref = read;
    _writePref = write;
  }

  /// 启动时恢复开关状态：默认启用（Android）。读偏好失败按启用处理。
  Future<void> restoreAndStart() async {
    bool enabled = true;
    final reader = _readPref;
    if (reader != null) {
      try {
        final dynamic saved = await reader(_prefKeyEnabled);
        if (saved is bool) enabled = saved;
      } catch (_) {
        // 读不到偏好按默认开启处理
      }
      try {
        final dynamic locSaved = await reader(_prefKeyLocReport);
        if (locSaved is bool) _locReportEnabled = locSaved;
      } catch (_) {
        // 定位回传默认关闭
      }
    }
    _enabled = enabled;
    if (_enabled) {
      start();
    } else {
      status.value = PhoneBridgeStatus.disabled;
    }
  }

  /// 用户在设置页开启：持久化 + 立即连接。
  Future<void> enable() async {
    _enabled = true;
    final writer = _writePref;
    if (writer != null) {
      try {
        await writer(_prefKeyEnabled, true);
      } catch (_) {
        // 持久化失败不影响本次会话内生效
      }
    }
    start();
  }

  /// 用户在设置页关闭：持久化 + 断开并停止重连。
  Future<void> disable() async {
    _enabled = false;
    final writer = _writePref;
    if (writer != null) {
      try {
        await writer(_prefKeyEnabled, false);
      } catch (_) {
        // 同上
      }
    }
    stop();
    status.value = PhoneBridgeStatus.disabled;
  }

  /// 定位低频回传开关（设置页）：持久化 + 立即生效。
  Future<void> setLocationReportEnabled(bool value) async {
    _locReportEnabled = value;
    final writer = _writePref;
    if (writer != null) {
      try {
        await writer(_prefKeyLocReport, value);
      } catch (_) {
        // 同上
      }
    }
    if (value && status.value == PhoneBridgeStatus.online) {
      _startLocationReporting();
    } else {
      _stopLocationReporting();
    }
  }

  /// 建立桥接连接（幂等：已连接/连接中时跳过）。
  void start() {
    _manualStopped = false;
    if (_channel != null || _reconnectTimer != null) return;
    PhoneCaptureService.instance.ensureInitialized();
    _captureSub ??= PhoneCaptureService.instance.onBatch.listen(
      (List<CapturedPhoneMessage> batch) => _queueCapturedMessages(batch),
    );
    status.value = PhoneBridgeStatus.connecting;
    _connect();
  }

  /// 断开并停止重连（设置页关闭开关时调用）。
  void stop() {
    _manualStopped = true;
    _reconnectTimer?.cancel();
    _reconnectTimer = null;
    _keepaliveTimer?.cancel();
    _keepaliveTimer = null;
    _stopLocationReporting();
    _teardownChannel();
  }

  void _connect() {
    if (_manualStopped || !_enabled) return;
    final WebSocketChannel channel = WebSocketChannel.connect(
      Uri.parse(ApiConfig.wsUrl),
    );
    _channel = channel;

    _subscription = channel.stream.listen(
      (dynamic data) {
        if (!identical(_channel, channel)) return;
        _handleServerMessage(data.toString());
      },
      onError: (Object _) => _handleDisconnect(channel),
      onDone: () => _handleDisconnect(channel),
      cancelOnError: false,
    );

    unawaited(
      channel.ready.then((_) async {
        if (!identical(_channel, channel)) return;
        _reconnectAttempts = 0;
        status.value = PhoneBridgeStatus.offline; // 绑定成功后才算 online
        // 注册前查一次通知使用权授权状态，随 deviceInfo 上报——服务端
        // messages.capture_status 读它决定是否引导 agent 发 permission_request 卡
        _reportedListenerEnabled =
            await PhoneCaptureService.instance.isListenerEnabled();
        _send("session.init", _sessionInitPayload());
        _send("phone.bridge.register", _registerPayload());
        _startKeepalive(channel);
      }).catchError((Object _) {
        if (!identical(_channel, channel)) return;
        _handleDisconnect(channel);
      }),
    );
  }

  /// 最近一次注册前查到的通知使用权授权状态（null = 尚未查过，不随注册上报）
  bool? _reportedListenerEnabled;

  Map<String, dynamic> _deviceInfoPayload() {
    return <String, dynamic>{
      "model": "flutter-app",
      "manufacturer": Platform.operatingSystem,
      "brand": Platform.operatingSystem,
      "systemVersion": Platform.operatingSystemVersion,
      if (_reportedListenerEnabled != null)
        "notificationListenerEnabled": _reportedListenerEnabled,
    };
  }

  /// 手机桥接通道必须提供 userId（服务端拒绝仅 sessionId 的桥接绑定），
  /// 统一用 effectiveActorId，与聊天会话的 actorId 保持一致。
  Map<String, dynamic> _sessionInitPayload() {
    return <String, dynamic>{
      "sessionId": "phone-bridge-${ApiConfig.sessionId}",
      "userId": ApiConfig.effectiveActorId,
      "phoneBridge": true,
      "deviceId": "phone-bridge",
      ..._deviceInfoPayload(),
    };
  }

  Map<String, dynamic> _registerPayload() {
    return <String, dynamic>{
      "token": _bridgeTokenFromEnv,
      ..._deviceInfoPayload(),
    };
  }

  void _handleServerMessage(String raw) {
    Map<String, dynamic> event;
    try {
      final dynamic decoded = jsonDecode(raw);
      if (decoded is! Map) return;
      event = decoded.cast<String, dynamic>();
    } catch (_) {
      return;
    }
    final String type = event["type"]?.toString() ?? "";
    final Map<String, dynamic> payload =
        ((event["payload"] ?? const <String, dynamic>{}) as Map)
            .cast<String, dynamic>();

    switch (type) {
      case "phone.bridge.invoke":
        unawaited(_handleInvoke(payload));
        break;
      case "phone.bridge.register_ack":
        final bool ok = payload["ok"] == true;
        status.value = ok ? PhoneBridgeStatus.online : PhoneBridgeStatus.offline;
        debugPrint("[PhoneBridge] register_ack mode=${payload["mode"]} ok=$ok");
        if (ok) {
          unawaited(_flushCapturedBacklog());
          unawaited(PhoneCaptureService.instance.startBridgeService());
          _startLocationReporting();
        }
        break;
      case "phone.msg.report_ack":
        _handleReportAck(payload);
        break;
      case "phone.bridge.sync":
        // 其他设备的绑定变化同步；本机在线性以自身 socket 为准，这里仅留日志。
        debugPrint(
          "[PhoneBridge] sync online=${payload["phoneBridgeOnline"]} at=${payload["updatedAt"]}",
        );
        break;
      case "error":
        debugPrint(
          "[PhoneBridge] server error code=${payload["code"]} msg=${payload["message"]}",
        );
        break;
      default:
        break;
    }
  }

  // ─── 服务端指令处理（action 路由表） ───

  /// 服务端下发指令：按 action 分发到各原生/系统能力。
  Future<void> _handleInvoke(Map<String, dynamic> payload) async {
    final String jobId = payload["jobId"]?.toString().trim() ?? "";
    if (jobId.isEmpty) return;
    final String action = payload["action"]?.toString() ?? "";
    final Map<String, dynamic> params =
        ((payload["params"] ?? const <String, dynamic>{}) as Map)
            .cast<String, dynamic>();

    Map<String, dynamic> result;
    switch (action) {
      case "dial":
        result = await _invokeDial(params);
        break;
      case "send_sms":
        result = await _invokeSendSms(params);
        break;
      case "sms_list":
        result = await _invokeSmsList(params);
        break;
      case "call_log":
        result = await _invokeCallLog(params);
        break;
      case "battery":
        result = await _invokeBattery();
        break;
      case "locate":
        result = await _invokeLocate();
        break;
      case "ring":
        result = await _invokeRing(params);
        break;
      case "camera_capture":
        result = await _invokeCameraCapture(params);
        break;
      case "screen_record":
        result = await _invokeScreenRecord(params);
        break;
      default:
        result = <String, dynamic>{"ok": false, "error": "action_not_supported:$action"};
    }

    _send("phone.bridge.result", <String, dynamic>{"jobId": jobId, ...result});
  }

  /// 拨号：native 侧自带 confirmTimeoutSec 兜底，这里再加 25s 硬超时，
  /// 保证永远赶在服务端 30s invoke 超时之前回执。
  Future<Map<String, dynamic>> _invokeDial(Map<String, dynamic> p) async {
    try {
      return await PhoneDialInvoker.dial(
        number: p["number"]?.toString() ?? "",
        contactName: p["contactName"]?.toString() ?? "",
        reason: p["reason"]?.toString() ?? "",
        mode: p["mode"]?.toString() ?? "direct",
        confirmTimeoutSec: 20,
      ).timeout(
        const Duration(seconds: 25),
        onTimeout: () =>
            <String, dynamic>{"ok": false, "error": "dial_timeout", "state": "cancelled"},
      );
    } catch (e) {
      return <String, dynamic>{"ok": false, "error": "dial_exception:$e"};
    }
  }

  /// 短信代发：原生确认窗 → 用户确认后 SmsManager 发出。
  Future<Map<String, dynamic>> _invokeSendSms(Map<String, dynamic> p) async {
    try {
      return await PhoneSmsInvoker.sendSms(
        number: p["number"]?.toString() ?? "",
        text: p["text"]?.toString() ?? "",
        contactName: p["contactName"]?.toString() ?? "",
        reason: p["reason"]?.toString() ?? "",
        confirmTimeoutSec: 25,
      ).timeout(
        const Duration(seconds: 28),
        onTimeout: () =>
            <String, dynamic>{"ok": false, "error": "sms_send_timeout", "state": "cancelled"},
      );
    } catch (e) {
      return <String, dynamic>{"ok": false, "error": "sms_invoke_exception:$e"};
    }
  }

  Future<Map<String, dynamic>> _invokeSmsList(Map<String, dynamic> p) async {
    try {
      final int limit = int.tryParse(p["limit"]?.toString() ?? "") ?? 20;
      final dynamic raw = await _nativeChannel
          .invokeMethod<dynamic>("smsList", <String, dynamic>{"limit": limit})
          .timeout(const Duration(seconds: 10));
      if (raw is Map) return raw.cast<String, dynamic>();
      return <String, dynamic>{"ok": false, "error": "bad_native_result"};
    } catch (e) {
      return <String, dynamic>{"ok": false, "error": "sms_list_exception:$e"};
    }
  }

  Future<Map<String, dynamic>> _invokeCallLog(Map<String, dynamic> p) async {
    try {
      final int limit = int.tryParse(p["limit"]?.toString() ?? "") ?? 20;
      final dynamic raw = await _nativeChannel
          .invokeMethod<dynamic>("callLog", <String, dynamic>{"limit": limit})
          .timeout(const Duration(seconds: 10));
      if (raw is Map) return raw.cast<String, dynamic>();
      return <String, dynamic>{"ok": false, "error": "bad_native_result"};
    } catch (e) {
      return <String, dynamic>{"ok": false, "error": "call_log_exception:$e"};
    }
  }

  Future<Map<String, dynamic>> _invokeBattery() async {
    try {
      final dynamic raw = await _nativeChannel
          .invokeMethod<dynamic>("battery")
          .timeout(const Duration(seconds: 5));
      if (raw is Map) return raw.cast<String, dynamic>();
      return <String, dynamic>{"ok": false, "error": "bad_native_result"};
    } catch (e) {
      return <String, dynamic>{"ok": false, "error": "battery_exception:$e"};
    }
  }

  Future<Map<String, dynamic>> _invokeRing(Map<String, dynamic> p) async {
    try {
      final int durationSec = int.tryParse(p["durationSec"]?.toString() ?? "") ?? 15;
      final dynamic raw = await _nativeChannel
          .invokeMethod<dynamic>(
        "ring",
        <String, dynamic>{
          "durationSec": durationSec,
          "vibrate": p["vibrate"] is bool ? p["vibrate"] : true,
        },
      ).timeout(const Duration(seconds: 5));
      if (raw is Map) return raw.cast<String, dynamic>();
      return <String, dynamic>{"ok": false, "error": "bad_native_result"};
    } catch (e) {
      return <String, dynamic>{"ok": false, "error": "ring_exception:$e"};
    }
  }

  /// 单次定位（phone.locate 按需）：geolocator 与聊天定位同源。
  Future<Map<String, dynamic>> _invokeLocate() async {    try {
      final bool serviceEnabled = await Geolocator.isLocationServiceEnabled();
      if (!serviceEnabled) {
        return <String, dynamic>{"ok": false, "error": "location_service_disabled"};
      }
      LocationPermission permission = await Geolocator.checkPermission();
      if (permission == LocationPermission.denied) {
        // 后台触发时不弹系统授权窗（弹也看不见），直接报权限不足
        return <String, dynamic>{"ok": false, "error": "location_permission_denied"};
      }
      if (permission == LocationPermission.deniedForever) {
        return <String, dynamic>{"ok": false, "error": "location_permission_denied_forever"};
      }
      final Position pos = await Geolocator.getCurrentPosition(
        locationSettings: const LocationSettings(accuracy: LocationAccuracy.medium, timeLimit: Duration(seconds: 15)),
      );
      return <String, dynamic>{
        "ok": true,
        "latitude": pos.latitude,
        "longitude": pos.longitude,
        "accuracy": pos.accuracy,
        "timestamp": pos.timestamp.toIso8601String(),
      };
    } catch (e) {
      return <String, dynamic>{"ok": false, "error": "locate_exception:$e"};
    }
  }

  /// 远程拍照：前台服务 CameraX 拍摄 → 服务端上传 → 返回 {ok, url}。
  Future<Map<String, dynamic>> _invokeCameraCapture(Map<String, dynamic> p) async {
    try {
      final dynamic raw = await _nativeChannel
          .invokeMethod<dynamic>(
        "cameraCapture",
        <String, dynamic>{
          "camera": p["camera"]?.toString() ?? "back",
          "uploadBaseUrl": ApiConfig.httpBase,
          "uploadToken": _bridgeTokenFromEnv,
          "actorId": ApiConfig.effectiveActorId,
        },
      )
          .timeout(const Duration(seconds: 45));
      if (raw is Map) return raw.cast<String, dynamic>();
      return <String, dynamic>{"ok": false, "error": "bad_native_result"};
    } catch (e) {
      return <String, dynamic>{"ok": false, "error": "camera_capture_exception:$e"};
    }
  }

  /// 远程录屏：授权窗（用户必须点同意）→ 录制 durationSec 秒 → 上传返回 {ok, url}。
  Future<Map<String, dynamic>> _invokeScreenRecord(Map<String, dynamic> p) async {
    final int durationSec =
        int.tryParse(p["durationSec"]?.toString() ?? "") ?? 15;
    try {
      final dynamic raw = await _nativeChannel
          .invokeMethod<dynamic>(
        "screenRecord",
        <String, dynamic>{
          "durationSec": durationSec.clamp(5, 60),
          "uploadBaseUrl": ApiConfig.httpBase,
          "uploadToken": _bridgeTokenFromEnv,
          "actorId": ApiConfig.effectiveActorId,
        },
      )
          .timeout(Duration(seconds: durationSec.clamp(5, 60) + 90));
      if (raw is Map) return raw.cast<String, dynamic>();
      return <String, dynamic>{"ok": false, "error": "bad_native_result"};
    } catch (e) {
      return <String, dynamic>{"ok": false, "error": "screen_record_exception:$e"};
    }
  }

  static const MethodChannel _nativeChannel = MethodChannel("pai/phone_bridge");

  // ─── 捕获消息上报（phone.msg.report → ack 出队） ───

  void _queueCapturedMessages(List<CapturedPhoneMessage> batch) {
    final messages = batch.map((m) => m.toReportPayload()).toList();
    _sendReportBatch(messages);
  }

  /// 桥接上线：补报落盘队列积压（引擎未运行期间的捕获）+ 重发未 ack 批次。
  Future<void> _flushCapturedBacklog() async {
    final queued = await PhoneCaptureService.instance.drainQueue();
    if (queued.isNotEmpty) {
      _sendReportBatch(queued.map((m) => m.toReportPayload()).toList());
    }
    final stale = List<_PendingReportBatch>.from(_pendingReports);
    for (final batch in stale) {
      _sendReportBatch(batch.messages);
    }
  }

  void _sendReportBatch(List<Map<String, dynamic>> messages) {
    if (messages.isEmpty) return;
    // 单批上限保护：超出切片（服务端也按 100 条截断）
    for (var i = 0; i < messages.length; i += _maxReportMessages) {
      final slice = messages.sublist(
        i,
        (i + _maxReportMessages) > messages.length ? messages.length : (i + _maxReportMessages),
      );
      final batchId =
          "b${DateTime.now().millisecondsSinceEpoch.toRadixString(36)}_${_batchSeq++}";
      final sent = _send(
        "phone.msg.report",
        <String, dynamic>{"batchId": batchId, "messages": slice},
      );
      if (sent) {
        _pendingReports.add(_PendingReportBatch(batchId, slice, DateTime.now()));
      } else {
        // WS 断开：丢弃本批（原生侧落盘队列已兜底，重连后 drainQueue 补报）
        return;
      }
    }
    // 防 ack 丢失导致无限堆积：超过 50 批时丢弃最老的未确认批次
    while (_pendingReports.length > 50) {
      _pendingReports.removeAt(0);
    }
  }

  void _handleReportAck(Map<String, dynamic> payload) {
    final String batchId = payload["batchId"]?.toString() ?? "";
    if (batchId.isEmpty) return;
    _pendingReports.removeWhere((b) => b.batchId == batchId);
  }

  // ─── 定位低频回传（phone.loc.report） ───

  void _startLocationReporting() {
    _stopLocationReporting();
    if (!_locReportEnabled || !_enabled) return;
    _locReportTimer = Timer.periodic(const Duration(minutes: 15), (_) {
      unawaited(_reportLocationOnce());
    });
    // 开启后先报一次
    unawaited(_reportLocationOnce());
  }

  void _stopLocationReporting() {
    _locReportTimer?.cancel();
    _locReportTimer = null;
  }

  Future<void> _reportLocationOnce() async {
    if (!_locReportEnabled || status.value != PhoneBridgeStatus.online) return;
    try {
      final bool serviceEnabled = await Geolocator.isLocationServiceEnabled();
      if (!serviceEnabled) return;
      LocationPermission permission = await Geolocator.checkPermission();
      if (permission == LocationPermission.denied ||
          permission == LocationPermission.deniedForever) {
        return;
      }
      final Position pos = await Geolocator.getCurrentPosition(
        locationSettings: const LocationSettings(accuracy: LocationAccuracy.low, timeLimit: Duration(seconds: 20)),
      );
      _send("phone.loc.report", <String, dynamic>{
        "latitude": pos.latitude,
        "longitude": pos.longitude,
        "accuracy": pos.accuracy,
        "source": "continuous",
      });
    } catch (_) {
      // 定位失败静默跳过（无网/室内/权限变化）
    }
  }

  // ─── 连接生命周期 ───

  void _startKeepalive(WebSocketChannel channel) {
    _keepaliveTimer?.cancel();
    _keepaliveTimer = Timer.periodic(_keepaliveInterval, (_) {
      if (!identical(_channel, channel)) {
        _keepaliveTimer?.cancel();
        _keepaliveTimer = null;
        return;
      }
      _sendNow("ws.keepalive", <String, dynamic>{
        "clientTime": DateTime.now().toIso8601String(),
        "reason": "phone_bridge",
      });
    });
  }

  void _handleDisconnect(WebSocketChannel channel) {
    if (!identical(_channel, channel)) return;
    _keepaliveTimer?.cancel();
    _keepaliveTimer = null;
    _stopLocationReporting();
    _teardownChannel();
    if (_manualStopped || !_enabled) return;
    status.value = PhoneBridgeStatus.offline;
    _scheduleReconnect();
  }

  void _teardownChannel() {
    unawaited(_subscription?.cancel());
    _subscription = null;
    try {
      _channel?.sink.close(ws_status.goingAway);
    } catch (_) {
      // 已断开时 close 可能抛错，忽略
    }
    _channel = null;
  }

  void _scheduleReconnect() {
    if (_reconnectTimer != null) return;
    final int exponent = _reconnectAttempts.clamp(0, 8);
    final int delaySec = (_initialReconnectDelay.inSeconds * (1 << exponent)).clamp(
      _initialReconnectDelay.inSeconds,
      _maxReconnectDelay.inSeconds,
    );
    _reconnectAttempts += 1;
    status.value = PhoneBridgeStatus.connecting;
    _reconnectTimer = Timer(Duration(seconds: delaySec), () {
      _reconnectTimer = null;
      _connect();
    });
  }

  bool _send(String type, Map<String, dynamic> payload) {
    return _sendNow(type, payload);
  }

  bool _sendNow(String type, Map<String, dynamic> payload) {
    final channel = _channel;
    if (channel == null || channel.closeCode != null) return false;
    try {
      channel.sink.add(jsonEncode(<String, dynamic>{
        "type": type,
        "payload": payload,
      }));
      return true;
    } catch (_) {
      return false;
    }
  }
}
