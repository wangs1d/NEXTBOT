import "dart:async";
import "dart:convert";

import "package:http/http.dart" as http;

import "../config/api_config.dart";
import "access_auth_api.dart";
import "./nb_http.dart";

/// 设备 API 通用结果包装。
class DeviceApiResult<T> {
  const DeviceApiResult._({
    required this.ok,
    this.value,
    this.error,
    this.networkError = false,
  });

  final bool ok;
  final T? value;
  final String? error;
  final bool networkError;

  factory DeviceApiResult.success(T value) =>
      DeviceApiResult._(ok: true, value: value);
  factory DeviceApiResult.failure(String error, {bool networkError = false}) =>
      DeviceApiResult._(ok: false, error: error, networkError: networkError);
}

/// 终端互连平台设备数据模型。
class DeviceInfo {
  const DeviceInfo({
    required this.deviceId,
    required this.kind,
    required this.name,
    required this.online,
    required this.status,
    this.boundAt,
    this.lastSeenAt,
    this.metadata,
    this.capabilities = const [],
  });

  final String deviceId;
  final String kind;
  final String name;
  final bool online;
  final String status;
  final int? boundAt;
  final int? lastSeenAt;
  final Map<String, dynamic>? metadata;
  final List<Map<String, dynamic>> capabilities;

  factory DeviceInfo.fromJson(Map<String, dynamic> json) {
    return DeviceInfo(
      deviceId: json["deviceId"] as String? ?? "",
      kind: json["kind"] as String? ?? "generic",
      name: json["name"] as String? ?? "未命名设备",
      online: json["online"] as bool? ?? false,
      status: json["status"] as String? ?? "offline",
      boundAt: json["boundAt"] as int?,
      lastSeenAt: json["lastSeenAt"] as int?,
      metadata: json["metadata"] as Map<String, dynamic>?,
      capabilities: (json["capabilities"] as List<dynamic>?)
              ?.map((e) => e as Map<String, dynamic>)
              .toList() ??
          const [],
    );
  }
}

/// 配对码状态。
class PairingCodeStatus {
  const PairingCodeStatus({
    required this.hasPending,
    this.code,
    this.expiresAt,
    this.deviceKind,
  });

  final bool hasPending;
  final String? code;
  final int? expiresAt;
  final String? deviceKind;

  factory PairingCodeStatus.fromJson(Map<String, dynamic> json) {
    return PairingCodeStatus(
      hasPending: json["hasPending"] as bool? ?? false,
      code: json["code"] as String?,
      expiresAt: json["expiresAt"] as int?,
      deviceKind: json["deviceKind"] as String?,
    );
  }
}

/// 终端互连平台 /device 端点封装（与 server/src/routes/http/device.ts 对齐）。
class DeviceApiClient {
  DeviceApiClient({
    String? baseUrl,
    String? sessionId,
    http.Client? client,
  })  : baseUrl = baseUrl ?? ApiConfig.httpBase,
        sessionId = sessionId ?? ApiConfig.effectiveActorId,
        _client = client ?? NbClient();

  final String baseUrl;
  final String sessionId;
  final http.Client _client;

  static const Duration _timeout = Duration(seconds: 20);

  Uri _uri(String path, [Map<String, String>? query]) {
    final Uri root = Uri.parse(baseUrl);
    final String rel = path.startsWith("/") ? path.substring(1) : path;
    final Uri u = root.resolve(rel);
    return query == null ? u : u.replace(queryParameters: query);
  }

  Map<String, String> _sessionQuery([Map<String, String>? extra]) {
    return <String, String>{
      "sessionId": sessionId,
      if (extra != null) ...extra,
    };
  }

  /// 设备链路同样要过云端周界鉴权（未绑定时为空 map，行为与现状一致）。
  Map<String, String> get _authHeaders =>
      AccessCredentialStore.instance.authHeaders;

  static Map<String, dynamic>? _tryDecodeBody(http.Response r) {
    if (r.body.isEmpty) return null;
    try {
      final dynamic decoded = jsonDecode(r.body);
      return decoded is Map<String, dynamic> ? decoded : null;
    } catch (_) {
      return null;
    }
  }

  static String _errorMessage(
    Map<String, dynamic>? body,
    int status,
    String fallback,
  ) {
    final dynamic m = body?["error"] ?? body?["message"];
    if (m is String && m.isNotEmpty) return m;
    return "$fallback (HTTP $status)";
  }

  /// 列出当前用户已绑定的设备（含在线状态）。
  Future<DeviceApiResult<List<DeviceInfo>>> listDevices() async {
    try {
      final http.Response r = await _client
          .get(_uri("/device/list", _sessionQuery()), headers: _authHeaders)
          .timeout(_timeout);
      final body = _tryDecodeBody(r);
      if (r.statusCode >= 200 && r.statusCode < 300 && body != null) {
        final list = (body["devices"] as List<dynamic>?)
                ?.map((e) => DeviceInfo.fromJson(e as Map<String, dynamic>))
                .toList() ??
            const <DeviceInfo>[];
        return DeviceApiResult.success(list);
      }
      return DeviceApiResult.failure(
        _errorMessage(body, r.statusCode, "获取设备列表失败"),
      );
    } on TimeoutException {
      return DeviceApiResult.failure("请求超时", networkError: true);
    } catch (e) {
      return DeviceApiResult.failure("网络错误: $e", networkError: true);
    }
  }

  /// 生成配对码（10 分钟有效）。
  Future<DeviceApiResult<String>> generatePairingCode({
    String? deviceKind,
  }) async {
    try {
      final Map<String, dynamic> body = <String, dynamic>{
        "sessionId": sessionId,
        if (deviceKind != null) "deviceKind": deviceKind,
      };
      final http.Response r = await _client
          .post(
            _uri("/device/pairing/code"),
            headers: <String, String>{
              "Content-Type": "application/json",
              ..._authHeaders,
            },
            body: jsonEncode(body),
          )
          .timeout(_timeout);
      final resp = _tryDecodeBody(r);
      if (r.statusCode >= 200 && r.statusCode < 300 && resp != null) {
        final code = resp["code"] as String?;
        if (code != null) return DeviceApiResult.success(code);
      }
      return DeviceApiResult.failure(
        _errorMessage(resp, r.statusCode, "生成配对码失败"),
      );
    } on TimeoutException {
      return DeviceApiResult.failure("请求超时", networkError: true);
    } catch (e) {
      return DeviceApiResult.failure("网络错误: $e", networkError: true);
    }
  }

  /// 查询当前用户未消费的配对码。
  Future<DeviceApiResult<PairingCodeStatus>> getPendingCode() async {
    try {
      final http.Response r = await _client
          .get(
            _uri("/device/pairing/code/status", _sessionQuery()),
            headers: _authHeaders,
          )
          .timeout(_timeout);
      final body = _tryDecodeBody(r);
      if (r.statusCode >= 200 && r.statusCode < 300 && body != null) {
        return DeviceApiResult.success(PairingCodeStatus.fromJson(body));
      }
      return DeviceApiResult.failure(
        _errorMessage(body, r.statusCode, "查询配对码失败"),
      );
    } on TimeoutException {
      return DeviceApiResult.failure("请求超时", networkError: true);
    } catch (e) {
      return DeviceApiResult.failure("网络错误: $e", networkError: true);
    }
  }

  /// 解绑设备。
  Future<DeviceApiResult<bool>> unbindDevice(String deviceId) async {
    try {
      final http.Response r = await _client
          .delete(
            _uri("/device/$deviceId", _sessionQuery()),
            headers: _authHeaders,
          )
          .timeout(_timeout);
      final body = _tryDecodeBody(r);
      if (r.statusCode >= 200 && r.statusCode < 300) {
        return DeviceApiResult.success(body?["removed"] as bool? ?? false);
      }
      return DeviceApiResult.failure(
        _errorMessage(body, r.statusCode, "解绑设备失败"),
      );
    } on TimeoutException {
      return DeviceApiResult.failure("请求超时", networkError: true);
    } catch (e) {
      return DeviceApiResult.failure("网络错误: $e", networkError: true);
    }
  }
}
