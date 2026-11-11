import "dart:convert";
import "dart:io";

import "package:flutter/foundation.dart" show debugPrint;
import "package:http/http.dart" as http;
import "package:path_provider/path_provider.dart";

import "../config/api_config.dart";
import "./nb_http.dart";

/// 访问鉴权 API 通用结果包装（与 DeviceApiResult 同风格）。
class AccessAuthResult<T> {
  const AccessAuthResult._({
    required this.ok,
    this.value,
    this.error,
  });

  final bool ok;
  final T? value;
  final String? error;

  factory AccessAuthResult.success(T value) =>
      AccessAuthResult._(ok: true, value: value);
  factory AccessAuthResult.failure(String error) =>
      AccessAuthResult._(ok: false, error: error);
}

/// 鉴权开关状态（GET /api/auth/status）。
class AccessAuthStatus {
  const AccessAuthStatus({
    required this.authRequired,
    required this.bound,
  });

  /// 服务器是否开启了访问鉴权（ACCESS_AUTH_REQUIRED）。
  final bool authRequired;

  /// 服务器是否已有任意已绑定设备（false 时首台设备走引导绑定）。
  final bool bound;

  factory AccessAuthStatus.fromJson(Map<String, dynamic> json) {
    return AccessAuthStatus(
      authRequired: json["authRequired"] as bool? ?? false,
      bound: json["bound"] as bool? ?? false,
    );
  }
}

/// 绑定成功后签发的设备凭据。
class AccessDeviceBinding {
  const AccessDeviceBinding({
    required this.token,
    required this.userId,
    this.tokenId,
    this.expiresAt = 0,
  });

  final String token;
  final String userId;
  final String? tokenId;

  /// 过期时刻（毫秒时间戳）；0 = 服务端未启用 TTL（永不过期）。
  final int expiresAt;

  factory AccessDeviceBinding.fromJson(Map<String, dynamic> json) {
    return AccessDeviceBinding(
      token: json["token"] as String? ?? "",
      userId: json["userId"] as String? ?? "",
      tokenId: json["tokenId"] as String?,
      expiresAt: (json["expiresAt"] as num?)?.toInt() ?? 0,
    );
  }
}

/// 服务端返回的一台已绑定设备（GET /api/auth/devices，不含凭据）。
class AccessDevice {
  const AccessDevice({
    required this.tokenId,
    required this.deviceId,
    required this.deviceLabel,
    required this.lastSeenAt,
  });

  final String tokenId;
  final String deviceId;
  final String deviceLabel;
  final double lastSeenAt;

  factory AccessDevice.fromJson(Map<String, dynamic> json) => AccessDevice(
        tokenId: json["tokenId"]?.toString() ?? "",
        deviceId: json["deviceId"]?.toString() ?? "",
        deviceLabel: json["deviceLabel"]?.toString() ?? "",
        lastSeenAt: (json["lastSeenAt"] as num?)?.toDouble() ?? 0,
      );
}

/// 本机设备凭据的本地持久化。
///
/// 与 WindowBoundsPreference 同思路：落在应用支持目录下的单个 JSON 文件。
/// 文件内保存 token 明文 —— 与服务器约定「token 即凭据」，泄露面等同本机
/// 用户账户，不再叠加一层本地加密（桌面个人设备场景下可接受）。
class AccessCredentialStore {
  AccessCredentialStore._();

  static final AccessCredentialStore instance = AccessCredentialStore._();

  static const String _fileName = "access_auth_credentials.json";

  String? _token;
  String? _userId;
  String? _tokenId;
  String? _deviceId;
  int _expiresAt = 0;
  bool _loaded = false;

  String? get token => _token;
  String? get userId => _userId;
  String? get tokenId => _tokenId;

  /// 过期时刻（毫秒）；0 = 无 TTL。
  int get expiresAt => _expiresAt;

  /// 凭据是否已过期（无 TTL 时永远 false）。
  bool get isExpired =>
      _expiresAt > 0 && DateTime.now().millisecondsSinceEpoch >= _expiresAt;

  /// 是否该提前续期：剩余不足 7 天就换，避免用户正用着突然 401。
  bool get needsRefresh {
    if (_token == null || _token!.isEmpty) return false;
    if (_expiresAt <= 0) return false;
    const int weekMs = 7 * 24 * 60 * 60 * 1000;
    return _expiresAt - DateTime.now().millisecondsSinceEpoch < weekMs;
  }

  /// 本机设备标识：首次绑定时生成并随凭据持久化，重装后变化。
  ///
  /// 回落值不能是 `local-device`：那个字符串在服务端是「占位身份」黑名单成员，
  /// 多台设备挤在一起会被判成同一个 guest。这里生成一枚进程内唯一值兜底。
  String get deviceId =>
      _deviceId ?? "dev-${DateTime.now().microsecondsSinceEpoch.toRadixString(36)}";

  /// 是否已有可用凭据。
  bool get hasCredentials =>
      _token != null && _token!.isNotEmpty && _userId?.isNotEmpty == true;

  /// 请求头：已绑定时附带 Bearer token，否则为空 map。
  Map<String, String> get authHeaders => hasCredentials
      ? <String, String>{"Authorization": "Bearer $_token"}
      : const <String, String>{};

  /// URL 查询串形态的凭证：`<img>` 之外的音视频标签、WebView 页面地址发不出
  /// 请求头，云端开周界鉴权后只能靠 `?token=`（服务端 extractToken 两个通道都认）。
  Map<String, String> get accessTokenQuery =>
      hasCredentials ? <String, String>{"token": _token!} : const <String, String>{};

  /// 启动时加载一次；文件缺失/损坏视为未绑定。
  Future<void> load() async {
    if (_loaded) return;
    _loaded = true;
    try {
      final Directory dir = await getApplicationSupportDirectory();
      final File file = File("${dir.path}/$_fileName");
      if (!await file.exists()) return;
      final Map<String, dynamic> json =
          jsonDecode(await file.readAsString()) as Map<String, dynamic>;
      _token = json["token"] as String?;
      _userId = json["userId"] as String?;
      _tokenId = json["tokenId"] as String?;
      _deviceId = json["deviceId"] as String?;
      _expiresAt = (json["expiresAt"] as num?)?.toInt() ?? 0;
    } catch (e) {
      debugPrint("[AccessAuth] 读取本机凭据失败（视为未绑定）: $e");
      _token = null;
      _userId = null;
      _tokenId = null;
      _expiresAt = 0;
    }
  }

  /// 绑定/登录成功后保存凭据；首次会生成本机 deviceId。
  ///
  /// [deviceId] 优先用设备安装标识（`inst_…`）——与 WS `session.init` 上报的
  /// `deviceId` 同源，服务端 access-tokens 清单里能直接和设备对上；缺省时
  /// 生成 `dev-…`（历史配对链路的行为不变）。
  Future<void> save(AccessDeviceBinding binding, {String? deviceId}) async {
    _token = binding.token;
    _userId = binding.userId;
    _tokenId = binding.tokenId;
    _expiresAt = binding.expiresAt;
    final String? explicit = deviceId?.trim();
    if (explicit != null && explicit.isNotEmpty) {
      _deviceId = explicit;
    } else {
      _deviceId ??=
          "dev-${DateTime.now().millisecondsSinceEpoch.toRadixString(36)}";
    }
    await _write();
  }

  /// 解绑/吊销后清除本地凭据（deviceId 保留，避免同机重绑生成新 id）。
  Future<void> clear() async {
    _token = null;
    _userId = null;
    _tokenId = null;
    _expiresAt = 0;
    await _write();
  }

  Future<void> _write() async {
    try {
      final Directory dir = await getApplicationSupportDirectory();
      final File file = File("${dir.path}/$_fileName");
      if (_token == null) {
        if (await file.exists()) {
          await file.delete();
        }
        return;
      }
      await file.writeAsString(jsonEncode(<String, dynamic>{
        "token": _token,
        "userId": _userId,
        "tokenId": _tokenId,
        "deviceId": _deviceId,
        "expiresAt": _expiresAt,
        "updatedAt": DateTime.now().toIso8601String(),
      }));
    } catch (e) {
      debugPrint("[AccessAuth] 写入本机凭据失败: $e");
    }
  }
}

/// 访问鉴权 API 客户端（服务端实现：server/src/routes/http/auth.ts）。
///
/// 「用户自己绑定」流程：
///  1. 已绑定设备在设置页生成 6 位配对码（首台设备由服务器启动日志给出引导码）
///  2. 新设备输入配对码 → POST /api/auth/bind 换取长期设备 token
///  3. token 持久化到本机，后续 WS `session.init` 与 HTTP 请求自动附带
class AccessAuthApi {
  AccessAuthApi({String? baseUrl, http.Client? client})
      : _baseUrl = baseUrl ?? ApiConfig.httpBase,
        _client = client ?? NbClient();

  final String _baseUrl;
  final http.Client _client;

  static const Duration _timeout = Duration(seconds: 10);

  Map<String, String> get _headers => <String, String>{
        "Content-Type": "application/json",
        ...AccessCredentialStore.instance.authHeaders,
      };

  /// POST /api/auth/refresh：用现有 token 换新 token（滑动续期）。
  ///
  /// 服务端允许「已过期但未超宽限期」的凭据来换，所以这个调用既可以在
  /// 建连前主动做（临期续期），也可以在收到 401 时被动做（兜底）。
  /// 成功后新凭据立即落盘，旧 token 在服务端同时作废。
  Future<AccessAuthResult<bool>> refresh() async {
    final String? current = AccessCredentialStore.instance.token;
    if (current == null || current.isEmpty) {
      return AccessAuthResult.failure("本机没有可用凭据");
    }
    try {
      final http.Response res = await _client
          .post(
            Uri.parse("$_baseUrl/api/auth/refresh"),
            headers: <String, String>{
              "Content-Type": "application/json",
              "Authorization": "Bearer $current",
            },
            body: jsonEncode(<String, dynamic>{"token": current}),
          )
          .timeout(_timeout);
      final Map<String, dynamic> data = res.body.isEmpty
          ? <String, dynamic>{}
          : jsonDecode(res.body) as Map<String, dynamic>;
      final String? fresh = data["token"] as String?;
      if (res.statusCode != 200 || data["ok"] != true || fresh == null || fresh.isEmpty) {
        return AccessAuthResult.failure(
          data["error"]?.toString() ?? "续期失败: ${res.statusCode}",
        );
      }
      await AccessCredentialStore.instance.save(
        AccessDeviceBinding(
          token: fresh,
          userId: data["userId"]?.toString() ?? AccessCredentialStore.instance.userId ?? "",
          tokenId: data["tokenId"]?.toString(),
          expiresAt: (data["expiresAt"] as num?)?.toInt() ?? 0,
        ),
        deviceId: data["deviceId"]?.toString(),
      );
      return AccessAuthResult.success(true);
    } catch (e) {
      return AccessAuthResult.failure("网络错误: $e");
    }
  }

  /// GET /api/auth/status：服务器鉴权开关与本机绑定状态。
  Future<AccessAuthResult<AccessAuthStatus>> status() async {
    try {
      final http.Response res = await _client
          .get(
            Uri.parse("$_baseUrl/api/auth/status"),
            headers: _headers,
          )
          .timeout(_timeout);
      if (res.statusCode != 200) {
        return AccessAuthResult.failure("获取鉴权状态失败: ${res.statusCode}");
      }
      return AccessAuthResult.success(
        AccessAuthStatus.fromJson(
          jsonDecode(res.body) as Map<String, dynamic>,
        ),
      );
    } catch (e) {
      return AccessAuthResult.failure("网络错误: $e");
    }
  }

  /// POST /accounts/email/otp/start：向自己的邮箱发 6 位所有权验证码。
  /// 服务端未配置出站邮件通道时返回 503，这里如实报错、不假装成功。
  Future<AccessAuthResult<void>> startEmailOtp({required String email}) async {
    try {
      final http.Response res = await _client
          .post(
            Uri.parse("$_baseUrl/accounts/email/otp/start"),
            headers: const <String, String>{"Content-Type": "application/json"},
            body: jsonEncode(<String, dynamic>{"email": email.trim()}),
          )
          .timeout(_timeout);
      final Map<String, dynamic> data = res.body.isEmpty
          ? <String, dynamic>{}
          : jsonDecode(res.body) as Map<String, dynamic>;
      if (res.statusCode != 200 || data["ok"] != true) {
        return AccessAuthResult.failure(
          data["message"]?.toString() ??
              data["error"]?.toString() ??
              "验证码发送失败: ${res.statusCode}",
        );
      }
      return AccessAuthResult.success(null);
    } catch (e) {
      return AccessAuthResult.failure("网络错误: $e");
    }
  }

  /// POST /api/auth/pairing-code：生成 6 位配对码（供其他设备绑定）。
  ///
  /// 本机已有 token → 直接签；本机还没 token 但服务端已有别的绑定设备 →
  /// 必须带 [emailCode]（先向 /accounts/email/otp/start 发码）证明邮箱归属，
  /// 否则新装设备永远签不出码、也就永远绑不上。
  Future<AccessAuthResult<String>> issuePairingCode({
    String? emailCode,
    String? userId,
  }) async {
    try {
      final http.Response res = await _client
          .post(
            Uri.parse("$_baseUrl/api/auth/pairing-code"),
            headers: _headers,
            body: jsonEncode(<String, dynamic>{
              "userId":
                  userId ??
                  AccessCredentialStore.instance.userId ??
                  ApiConfig.effectiveActorId,
              "deviceId": AccessCredentialStore.instance.deviceId,
              if (emailCode != null && emailCode.trim().isNotEmpty)
                "emailCode": emailCode.trim(),
            }),
          )
          .timeout(_timeout);
      final Map<String, dynamic> data =
          jsonDecode(res.body) as Map<String, dynamic>;
      if (res.statusCode != 200 || data["ok"] != true) {
        return AccessAuthResult.failure(
          data["error"]?.toString() ?? data["message"]?.toString() ??
              "生成配对码失败: ${res.statusCode}",
        );
      }
      return AccessAuthResult.success(data["code"] as String);
    } catch (e) {
      return AccessAuthResult.failure("网络错误: $e");
    }
  }

  /// POST /api/auth/bind：用配对码换取本机设备 token。
  Future<AccessAuthResult<AccessDeviceBinding>> bind({
    required String code,
  }) async {
    try {
      final http.Response res = await _client
          .post(
            Uri.parse("$_baseUrl/api/auth/bind"),
            headers: _headers,
            body: jsonEncode(<String, dynamic>{
              "code": code.trim(),
              "deviceId": AccessCredentialStore.instance.deviceId,
              "deviceLabel": _deviceLabel(),
            }),
          )
          .timeout(_timeout);
      final Map<String, dynamic> data =
          jsonDecode(res.body) as Map<String, dynamic>;
      if (res.statusCode != 200 || data["ok"] != true) {
        return AccessAuthResult.failure(
          data["error"]?.toString() ??
              data["message"]?.toString() ??
              "绑定失败: ${res.statusCode}",
        );
      }
      return AccessAuthResult.success(
        AccessDeviceBinding.fromJson(data),
      );
    } catch (e) {
      return AccessAuthResult.failure("网络错误: $e");
    }
  }

  /// GET /api/auth/devices：本人名下已绑定设备列表（含本机，不含任何凭据）。
  Future<AccessAuthResult<List<AccessDevice>>> listDevices() async {
    try {
      final http.Response res = await _client
          .get(
            Uri.parse("$_baseUrl/api/auth/devices"),
            headers: _headers,
          )
          .timeout(_timeout);
      if (res.statusCode != 200) {
        final Map<String, dynamic> data =
            jsonDecode(res.body) as Map<String, dynamic>;
        return AccessAuthResult.failure(
          data["error"]?.toString() ?? "获取设备列表失败: ${res.statusCode}",
        );
      }
      final Map<String, dynamic> data =
          jsonDecode(res.body) as Map<String, dynamic>;
      final List<dynamic> raw = data["devices"] as List<dynamic>? ?? const [];
      return AccessAuthResult.success(
        raw
            .whereType<Map<String, dynamic>>()
            .map(AccessDevice.fromJson)
            .toList(growable: false),
      );
    } catch (e) {
      return AccessAuthResult.failure("网络错误: $e");
    }
  }

  /// POST /api/auth/revoke：吊销某台设备的 token（含本机解绑）。
  Future<AccessAuthResult<void>> revoke(String tokenId) async {
    try {
      final http.Response res = await _client
          .post(
            Uri.parse("$_baseUrl/api/auth/revoke"),
            headers: _headers,
            body: jsonEncode(<String, dynamic>{"tokenId": tokenId}),
          )
          .timeout(_timeout);
      if (res.statusCode != 200) {
        final Map<String, dynamic> data =
            jsonDecode(res.body) as Map<String, dynamic>;
        return AccessAuthResult.failure(
          data["error"]?.toString() ?? "吊销失败: ${res.statusCode}",
        );
      }
      return AccessAuthResult.success(null);
    } catch (e) {
      return AccessAuthResult.failure("网络错误: $e");
    }
  }

  /// 设备展示名：平台 + 可执行形态，供服务端设备列表辨识。
  static String _deviceLabel() {
    if (Platform.isWindows) return "Windows 客户端";
    if (Platform.isAndroid) return "Android 客户端";
    if (Platform.isIOS) return "iOS 客户端";
    if (Platform.isMacOS) return "macOS 客户端";
    if (Platform.isLinux) return "Linux 客户端";
    return "Flutter 客户端";
  }
}
