import "dart:async";
import "dart:convert";

import "package:http/http.dart" as http;

import "../config/api_config.dart";

/// 手机桥接在线状态（桌面「手机」页顶部的连接条）。
class PhoneRemoteStatus {
  const PhoneRemoteStatus({required this.online, this.deviceInfo});

  /// 该用户已绑定的手机是否在线（手机 App 的桥接 WS 是否已连接）。
  final bool online;

  /// 手机端上报的设备信息（型号/品牌/系统/电量等，可能为空）。
  final Map<String, dynamic>? deviceInfo;
}

/// 单次远控调用结果。
///
/// [ok] 为手机端回执的最终成败；[error] 为失败原因（服务端拒绝 / 手机端异常 /
/// 网络错误）；[data] 为手机端原始回执（如 dial 的 `state`、battery 的
/// `level`/`charging`、sms_list 的 `messages` 等）。
class PhoneRemoteResult {
  const PhoneRemoteResult({required this.ok, this.error, this.data = const {}});

  final bool ok;
  final String? error;
  final Map<String, dynamic> data;

  /// 手机端回执里的状态串（dial/send_sms 等确认型动作使用）。
  String get state => data["state"]?.toString() ?? "";

  List<Map<String, dynamic>> listOf(String key) {
    final dynamic raw = data[key];
    if (raw is List) {
      return raw
          .whereType<Map>()
          .map((Map e) => e.cast<String, dynamic>())
          .toList();
    }
    return const <Map<String, dynamic>>[];
  }
}

/// 手机远控 HTTP 客户端（桌面端「手机」按钮落地页 / 任意 UI 直调）。
///
/// 对应服务端 `server/src/routes/http/phone-bridge.ts`：
///  - `GET  /phone-bridge/status`  查询该用户手机是否在线
///  - `POST /phone-bridge/invoke`  下发一条能力指令（拨号/短信/响铃/定位…）
///
/// 身份与 [ApiConfig.effectiveActorId] 一致（登录邮箱 → USER_ID → sessionId），
/// 与手机 App 桥接绑定时上报的 actorId 同源，因此能命中同一台已配对手机。
class PhoneRemoteApi {
  PhoneRemoteApi({String? baseUrl, String? actorId, http.Client? client})
      : baseUrl = baseUrl ?? ApiConfig.httpBase,
        actorId = actorId ?? ApiConfig.effectiveActorId,
        _client = client ?? http.Client();

  final String baseUrl;
  final String actorId;
  final http.Client _client;

  /// 拨号/短信要等手机端原生确认窗（最长 25s）+ 服务端 30s 超时，客户端留冗余。
  static const Duration _timeout = Duration(seconds: 35);

  Uri _uri(String path, [Map<String, String>? query]) {
    final Uri root = Uri.parse(baseUrl);
    final String rel = path.startsWith("/") ? path.substring(1) : path;
    final Uri u = root.resolve(rel);
    return query == null ? u : u.replace(queryParameters: query);
  }

  static Map<String, dynamic>? _tryDecodeBody(http.Response r) {
    if (r.body.isEmpty) return null;
    try {
      final dynamic decoded = jsonDecode(r.body);
      return decoded is Map<String, dynamic> ? decoded : null;
    } catch (_) {
      return null;
    }
  }

  /// 查询手机桥接在线状态。
  Future<PhoneRemoteStatus> status() async {
    try {
      final http.Response r = await _client
          .get(_uri("/phone-bridge/status", <String, String>{"sessionId": actorId}))
          .timeout(const Duration(seconds: 12));
      final body = _tryDecodeBody(r);
      if (r.statusCode >= 200 && r.statusCode < 300 && body != null) {
        final dynamic info = body["deviceInfo"];
        return PhoneRemoteStatus(
          online: body["phoneBridgeOnline"] == true,
          deviceInfo: info is Map ? info.cast<String, dynamic>() : null,
        );
      }
      return const PhoneRemoteStatus(online: false);
    } catch (_) {
      return const PhoneRemoteStatus(online: false);
    }
  }

  /// 下发一条能力指令到已绑定手机执行。
  Future<PhoneRemoteResult> invoke(
    String action, [
    Map<String, dynamic> params = const <String, dynamic>{},
  ]) async {
    try {
      final http.Response r = await _client
          .post(
            _uri("/phone-bridge/invoke"),
            headers: <String, String>{"Content-Type": "application/json"},
            body: jsonEncode(<String, dynamic>{
              "sessionId": actorId,
              "action": action,
              "params": params,
            }),
          )
          .timeout(_timeout);
      final body = _tryDecodeBody(r);
      if (body == null) {
        return PhoneRemoteResult(
          ok: false,
          error: "服务端返回异常（HTTP ${r.statusCode}）",
        );
      }
      final bool ok = body["ok"] == true;
      final dynamic err = body["error"] ?? body["message"];
      return PhoneRemoteResult(
        ok: ok,
        error: ok ? null : (err?.toString() ?? "调用失败（HTTP ${r.statusCode}）"),
        data: body,
      );
    } on TimeoutException {
      return const PhoneRemoteResult(ok: false, error: "请求超时（手机可能未响应）");
    } catch (e) {
      return PhoneRemoteResult(ok: false, error: "网络错误：$e");
    }
  }
}
