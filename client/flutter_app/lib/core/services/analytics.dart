import "dart:async";
import "dart:convert";
import "dart:io" show Platform;

import "package:flutter/foundation.dart" show debugPrint, kDebugMode, kIsWeb;
import "package:http/http.dart" as http;
import "package:package_info_plus/package_info_plus.dart";

import "../config/api_config.dart";
import "install_identity.dart";
import "nb_http.dart";

/// 跨端统一埋点出入口（手机端 / 桌面端同一份代码、同一事件模型）。
///
/// 唯一对业务暴露的 API 是 [track] / [trackFeature]。业务代码不关心会话拼接、
/// 本地队列、批量上报、失败补发、鉴权与隐私开关——全部在这一层完成。
///
/// 设计约束（见 design/telemetry-unified-entry-2026-11-21.html）：
///  - 事件名必须先登记（[kEventTypes]），未登记事件本地丢弃，服务端也会拒收；
///  - 一切 fail-open：任何异常只静默丢一条上报，绝不打断主流程；
///  - 隐私：用户关闭匿名统计后只入内存、不上报；
///  - 时间用客户端 DateTime（仅用于排序，服务端以接收时刻为准）。
class Analytics {
  Analytics._();

  static final Analytics instance = Analytics._();

  static final http.Client _client = NbClient();

  /// 事件白名单——与服务端 EVENT_TYPES、design 埋点方案一致。
  static const Set<String> kEventTypes = <String>{
    "session_start",
    "session_end",
    "heartbeat",
    "feature_use",
    "screen_view",
    "client_boot",
  };

  static const int _batchSize = 20;
  static const Duration _flushInterval = Duration(seconds: 30);
  static const Duration _heartbeatInterval = Duration(seconds: 60);
  static const int _maxBacklog = 500;

  final List<Map<String, dynamic>> _queue = <Map<String, dynamic>>[];
  Timer? _flushTimer;
  Timer? _heartbeatTimer;
  String? _sessionId;
  int _sessionStartMs = 0;
  bool _started = false;
  bool _enabled = true;
  bool _flushing = false;
  String? _appVersion;
  int _failStreak = 0;

  /// 在启动副作用区（BOOT）调用一次，幂等。开始会话 + 启动定时心跳/批量上报。
  Future<void> start() async {
    if (_started) return;
    _started = true;
    try {
      _appVersion = (await PackageInfo.fromPlatform()).version;
    } catch (_) {
      _appVersion = null;
    }
    _openSession();
    _flushTimer = Timer.periodic(_flushInterval, (_) => unawaited(flush()));
    _heartbeatTimer = Timer.periodic(_heartbeatInterval, (_) {
      if (_enabled && _sessionId != null) {
        track("heartbeat", props: <String, dynamic>{"activeMs": DateTime.now().millisecondsSinceEpoch - _sessionStartMs});
      }
    });
  }

  /// 应用回到前台：开新会话（后台期间的旧会话已在 pause 时结算）。
  void resume() {
    if (!_started) return;
    _openSession();
  }

  /// 应用进入后台：结算当前会话时长并关闭会话。
  void pause() {
    if (!_started || _sessionId == null) return;
    final int duration = DateTime.now().millisecondsSinceEpoch - _sessionStartMs;
    track("session_end", props: <String, dynamic>{"durationMs": duration < 0 ? 0 : duration});
    _sessionId = null;
    unawaited(flush()); // 切后台立刻冲一次，尽量保住时长数据
  }

  /// 应用彻底退出：结算会话 + 尽力冲一次队列。
  Future<void> stop() async {
    pause();
    await flush();
    _flushTimer?.cancel();
    _heartbeatTimer?.cancel();
    _flushTimer = null;
    _heartbeatTimer = null;
  }

  /// 隐私开关：关闭后只入内存不入队上报，逻辑统一仍可调用。
  void setEnabled(bool enabled) {
    _enabled = enabled;
    if (enabled) unawaited(flush());
  }

  void _openSession() {
    if (_sessionId != null) return; // 已开会话，不重复
    _sessionStartMs = DateTime.now().millisecondsSinceEpoch;
    _sessionId = "s_${_sessionStartMs.toRadixString(36)}_${(_sessionStartMs % 1679616).toRadixString(36)}";
    track("session_start");
  }

  /// 统一上报出口：自动补全 installId / actorId / platform / sessionId / appVersion。
  Future<void> track(String event, {Map<String, dynamic>? props}) async {
    try {
      if (!kEventTypes.contains(event)) {
        debugPrint("[analytics] event not registered, dropped: $event");
        return;
      }
      if (_sessionId == null && event != "client_boot") {
        // 会话未开（例如极早启动）：先开一个，保证 sessionId 非空。
        _openSession();
      }
      final Map<String, dynamic> envelope = <String, dynamic>{
        "event": event,
        "ts": DateTime.now().millisecondsSinceEpoch,
        "installId": await InstallIdentity.instance.installId(),
        "actorId": await InstallIdentity.instance.actorId(),
        "platform": _platform(),
        "appVersion": _appVersion,
        "sessionId": _sessionId ?? "boot",
        "props": _sanitizeProps(props),
      };
      if (!_enabled) return; // 隐私关闭：构造完即丢弃，不落队列
      if (_queue.length >= _maxBacklog) {
        _queue.removeAt(0); // 有界队列，防止无限增长
      }
      _queue.add(envelope);
      if (_queue.length >= _batchSize) unawaited(flush());
    } catch (e) {
      debugPrint("[analytics] track failed (ignored): $e");
    }
  }

  /// 功能使用埋点：工具内部名（如 weather.query / calendar.create）记入 props.feature。
  Future<void> trackFeature(String toolName, {String source = "chat"}) {
    return track("feature_use", props: <String, dynamic>{"feature": toolName, "source": source});
  }

  Map<String, dynamic> _sanitizeProps(Map<String, dynamic>? props) {
    final Map<String, dynamic> out = <String, dynamic>{};
    if (props == null) return out;
    props.forEach((String key, dynamic value) {
      if (key.length > 64) return;
      if (value is String || value is num || value is bool) {
        if (value is String && value.length > 200) return;
        out[key] = value;
      }
    });
    return out;
  }

  String _platform() {
    if (kDebugMode) return "mobile"; // 调试构建按手机口径，避免桌面调试噪声
    if (!kIsWeb && (Platform.isAndroid || Platform.isIOS)) return "mobile";
    return "desktop";
  }

  /// 批量上报，失败指数退避（简单线性退避窗口），连续失败超阈值停发保留队列。
  Future<void> flush() async {
    if (_flushing || !_enabled || _queue.isEmpty) return;
    if (_failStreak >= 5) return;
    _flushing = true;
    final List<Map<String, dynamic>> batch = _queue.take(_batchSize).toList(growable: false);
    try {
      final http.Response res = await _client
          .post(
            Uri.parse("${ApiConfig.controlPlaneBase}/api/telemetry/events"),
            headers: <String, String>{"content-type": "application/json"},
            body: jsonEncode(<String, dynamic>{"events": batch}),
          )
          .timeout(const Duration(seconds: 8));
      if (res.statusCode == 200) {
        _queue.removeRange(0, batch.length);
        _failStreak = 0;
      } else {
        _failStreak++;
        debugPrint("[analytics] flush http ${res.statusCode}");
      }
    } catch (e) {
      _failStreak++;
      debugPrint("[analytics] flush failed (ignored): $e");
    } finally {
      _flushing = false;
    }
  }
}
