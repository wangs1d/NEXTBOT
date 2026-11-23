import "dart:async";
import "dart:convert";
import "dart:io" show Platform;

import "package:flutter/foundation.dart" show debugPrint, kDebugMode, kIsWeb;
import "package:http/http.dart" as http;
import "package:package_info_plus/package_info_plus.dart";

import "../config/api_config.dart";
import "install_identity.dart";
import "local_runtime_manager.dart";
import "./nb_http.dart";

/// 安装包运行埋点：每次启动把「本机后端起来了吗、花了多久、什么版本/通道」
/// 上报到控制面（`POST /api/telemetry/client-boot`）。
///
/// 这是 runtime 收回云端前唯一的装机数据来源（装了多少台、多少台起不来），
/// 所以必须 fail-open：任何异常只静默丢一条上报，绝不拖慢或打断启动。
class ClientTelemetry {
  ClientTelemetry._();

  static final http.Client _client = NbClient();

  static Future<void> reportBoot(RuntimeBootResult boot) async {
    if (kDebugMode) return; // 开发构建不进台账（避免本机噪声）
    try {
      final PackageInfo info = await PackageInfo.fromPlatform();
      final Map<String, dynamic> payload = <String, dynamic>{
        "installId": await InstallIdentity.instance.installId(),
        "actorId": await InstallIdentity.instance.actorId(),
        "appVersion": info.version,
        "edition": ApiConfig.edition,
        "channel": ApiConfig.runtimeChannel,
        "bootStatus": boot.status.name,
        if (boot.elapsedMs != null) "bootMs": boot.elapsedMs,
        "platform": Platform.operatingSystemVersion,
      };
      final http.Response res = await _client
          .post(
            Uri.parse("${ApiConfig.controlPlaneBase}/api/telemetry/client-boot"),
            headers: <String, String>{"content-type": "application/json"},
            body: jsonEncode(payload),
          )
          .timeout(const Duration(seconds: 8));
      if (res.statusCode != 200) {
        debugPrint("[telemetry] boot report http ${res.statusCode}");
      }
    } catch (e) {
      debugPrint("[telemetry] boot report failed (ignored): $e");
    }
  }
}

/// 客户端行为事件埋点（2026-11-23 主动触达 M1，需求文档 §12.1）。
///
/// 上报到与启动埋点同一个控制面（`POST /api/telemetry/events`），沿用同一条规矩：
/// **fail-open**——任何异常只丢数据，绝不拖慢或打断业务。
///
/// - 主 isolate：[track] 入内存缓冲，满 [_batchSize] 条或每 [_flushEvery] 批量发一次；
/// - 后台 isolate（App 被杀时点通知按钮）：缓冲撑不到 flush，用 [sendNow] 一次直发。
/// - 进程被杀时缓冲里没发出去的会丢：埋点用于看趋势，不追求逐条必达（与服务端
///   reach-decision-log 互相印证即可）。
///
/// 开发构建默认不报（同 [ClientTelemetry.reportBoot]），联调时加
/// `--dart-define=NB_TELEMETRY_DEBUG=true` 打开。
class ClientEventTelemetry {
  ClientEventTelemetry._();

  static const bool _debugOptIn = bool.fromEnvironment("NB_TELEMETRY_DEBUG");
  static const int _batchSize = 20;
  static const int _maxBuffer = 200;
  static const Duration _flushEvery = Duration(seconds: 60);

  static final http.Client _client = NbClient();
  static final List<Map<String, dynamic>> _buffer = <Map<String, dynamic>>[];
  static Timer? _timer;
  static bool _flushing = false;

  static bool get _enabled => !kIsWeb && (!kDebugMode || _debugOptIn);

  /// 记一条事件（同步、不抛）。[props] 只放短维度：surface / actionId / channelId 等。
  static void track(
    String name, {
    String? deliveryId,
    Map<String, Object>? props,
  }) {
    if (!_enabled) return;
    _buffer.add(_event(name, deliveryId: deliveryId, props: props));
    if (_buffer.length > _maxBuffer) {
      _buffer.removeRange(0, _buffer.length - _maxBuffer);
    }
    if (_buffer.length >= _batchSize) {
      unawaited(flush());
    } else {
      _timer ??= Timer(_flushEvery, () {
        _timer = null;
        unawaited(flush());
      });
    }
  }

  /// 立即直发（不经缓冲；后台 isolate 专用）。
  static Future<void> sendNow(
    String name, {
    String? deliveryId,
    Map<String, Object>? props,
  }) async {
    if (!_enabled) return;
    await _post(<Map<String, dynamic>>[_event(name, deliveryId: deliveryId, props: props)]);
  }

  /// 把缓冲发出去（失败即丢，不重试——避免网络差时堆出重试风暴）。
  static Future<void> flush() async {
    if (_flushing || _buffer.isEmpty) return;
    _flushing = true;
    final List<Map<String, dynamic>> batch = List<Map<String, dynamic>>.of(_buffer);
    _buffer.clear();
    try {
      await _post(batch);
    } finally {
      _flushing = false;
    }
  }

  static Map<String, dynamic> _event(
    String name, {
    String? deliveryId,
    Map<String, Object>? props,
  }) {
    return <String, dynamic>{
      "name": name,
      "at": DateTime.now().millisecondsSinceEpoch,
      if (deliveryId != null && deliveryId.isNotEmpty) "deliveryId": deliveryId,
      if (props != null && props.isNotEmpty) "props": props,
    };
  }

  static Future<void> _post(List<Map<String, dynamic>> events) async {
    try {
      final String base = ApiConfig.controlPlaneBase;
      final Map<String, dynamic> body = <String, dynamic>{
        "installId": await InstallIdentity.instance.installId(),
        "actorId": await InstallIdentity.instance.actorId(),
        "platform": Platform.operatingSystemVersion,
        "events": events,
      };
      final http.Response res = await _client
          .post(
            Uri.parse("$base/api/telemetry/events"),
            headers: <String, String>{"content-type": "application/json"},
            body: jsonEncode(body),
          )
          .timeout(const Duration(seconds: 8));
      if (res.statusCode != 200) {
        debugPrint("[telemetry] events http ${res.statusCode}");
      }
    } catch (e) {
      debugPrint("[telemetry] events report failed (ignored): $e");
    }
  }
}
