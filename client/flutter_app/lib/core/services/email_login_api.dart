import "dart:convert";

import "package:flutter/foundation.dart" show debugPrint;
import "package:http/http.dart" as http;

import "../config/api_config.dart";
import "install_identity.dart";
import "./nb_http.dart";

/// 邮箱登录两步式的通用结果。
class EmailLoginResult {
  const EmailLoginResult({
    required this.ok,
    this.error,
    this.code,
    this.otpChannelDisabled = false,
    this.retryAfterSeconds,
    this.accessToken,
    this.accessTokenId,
    this.deviceId,
    this.accessTokenExpiresAt = 0,
  });

  final bool ok;

  /// 失败文案（直接可展示给用户）。
  final String? error;

  /// 服务端错误码（ACCOUNT_NOT_FOUND / ACCOUNT_EXISTS / OTP_REQUIRED /
  /// OTP_INVALID）：界面据此在「登录」与「注册」之间自动切换。
  final String? code;

  /// 服务端 OTP 闸未开启（SMTP 未配置/显式关闭）：可跳过验证码直接登录。
  final bool otpChannelDisabled;

  /// 发码限频：多少秒后可重试。
  final int? retryAfterSeconds;

  /// 登录/注册成功后签发的本机 access token（明文只返回这一次）。
  ///
  /// 这是「认证即发证」的凭据：落盘后 WS `session.init` 与 HTTP 请求都会带它，
  /// 服务端以 token 归属为身份权威（不再信任客户端自报的 userId）。
  /// 老服务端不返回该字段（null），客户端仍按自报身份工作。
  final String? accessToken;

  /// 服务端侧的 token 记录 id（吊销/排查用）。
  final String? accessTokenId;

  /// 服务端登记的设备标识（与安装标识同源时可直接落盘）。
  final String? deviceId;

  /// 凭据过期时刻（毫秒）；0 = 服务端未启用 TTL。
  /// 落盘后客户端可在临期前静默续期，而不是等 401 才补救。
  final int accessTokenExpiresAt;

  /// 该邮箱还没有账号 → 应该走注册。
  bool get accountNotFound => code == "ACCOUNT_NOT_FOUND";

  /// 该邮箱已经注册过 → 应该走登录。
  bool get accountExists => code == "ACCOUNT_EXISTS";
}

/// 手机端邮箱登录 API 客户端（服务端实现：server/src/routes/http/accounts.ts）。
///
/// 登录与注册是**两个界面、两个接口**（手机端 2026-11 拆分）：
///  1. `POST /accounts/email/otp/start {email}` → 向邮箱发 6 位验证码
///     （OTP 闸关闭时 503，调用方视 [EmailLoginResult.otpChannelDisabled]
///     允许免码直登）
///  2. 登录：`POST /accounts/login {userId: email, otpCode}` —— **只登录不建档**，
///     账号不存在返回 404 `ACCOUNT_NOT_FOUND`（界面据此切到注册）
///  3. 注册：`POST /accounts/register {userId, displayName, email, otpCode,
///     mode:"register"}` —— 已存在返回 409 `ACCOUNT_EXISTS`（界面据此切到登录）
///
/// 登录主体恒为邮箱本身（userId=email）：与桌面端「登录邮箱=运行时身份
/// 覆盖」同源，聊天/记忆/画像等全部数据按该 userId 落库，两端自动共享。
///
/// 基址默认取 [ApiConfig.controlPlaneBase]（账号/OTP/登录页所在的控制面，
/// 与反馈、站内信、桌面端 /accounts/web 同源）；单机/开发形态下它回落
/// [ApiConfig.httpBase]，行为不变。**手机端打包必须烤 CONTROL_PLANE_URL**
/// （见 build_apk.ps1），否则回落 127.0.0.1:3000 —— 真机上那是手机自己，
/// 发验证码必然落进「网络错误」兜底。
class EmailLoginApi {
  EmailLoginApi({String? baseUrl, http.Client? client})
      : _baseUrl = baseUrl ?? ApiConfig.controlPlaneBase,
        _client = client ?? NbClient();

  final String _baseUrl;
  final http.Client _client;

  static const Duration _timeout = Duration(seconds: 15);

  static final RegExp emailRe = RegExp(r"^[^\s@]+@[^\s@]+\.[^\s@]+$");

  static bool isValidEmail(String email) => emailRe.hasMatch(email.trim());

  /// 步骤 1：向邮箱发送登录验证码。
  Future<EmailLoginResult> startOtp(String email) async {
    final String mail = email.trim().toLowerCase();
    try {
      final http.Response res = await _client
          .post(
            Uri.parse("$_baseUrl/accounts/email/otp/start"),
            headers: const <String, String>{"Content-Type": "application/json"},
            body: jsonEncode(<String, String>{"email": mail}),
          )
          .timeout(_timeout);
      final Map<String, dynamic> data =
          jsonDecode(utf8.decode(res.bodyBytes)) as Map<String, dynamic>;
      if (res.statusCode == 200 && data["ok"] == true) {
        return EmailLoginResult(
          ok: true,
          retryAfterSeconds: data["resendAfterSeconds"] as int?,
        );
      }
      return EmailLoginResult(
        ok: false,
        error: data["message"]?.toString() ?? "验证码发送失败，请稍后重试",
        otpChannelDisabled: res.statusCode == 503,
        retryAfterSeconds: data["retryAfterSeconds"] as int?,
      );
    } catch (e) {
      debugPrint("[EmailLoginApi] startOtp failed: $e");
      return const EmailLoginResult(ok: false, error: "网络错误，请检查网络后重试");
    }
  }

  /// 账号是否已注册（登录界面的分流依据）。
  ///
  /// 复用公开探活入口 `GET /accounts/me?userId=`（未注册 404 且
  /// `registered:false`）。网络异常返回 null —— 调用方应把 null 当成
  /// 「不知道」，照常继续当前流程，不要因此拦住用户。
  Future<bool?> checkRegistered(String email) async {
    final String mail = email.trim().toLowerCase();
    try {
      final http.Response res = await _client
          .get(Uri.parse(
              "$_baseUrl/accounts/me?userId=${Uri.encodeQueryComponent(mail)}"))
          .timeout(_timeout);
      final Map<String, dynamic> data =
          jsonDecode(utf8.decode(res.bodyBytes)) as Map<String, dynamic>;
      if (res.statusCode == 200) return data["registered"] == true;
      if (res.statusCode == 404) return false;
      return null;
    } catch (e) {
      debugPrint("[EmailLoginApi] checkRegistered failed: $e");
      return null;
    }
  }

  /// 登录（只登录，不建档）。[code] 为 null/空时按免码直登处理
  /// （仅当服务端 OTP 闸关闭时才会成功）。
  ///
  /// 账号不存在时返回 [EmailLoginResult.accountNotFound]，界面据此把用户
  /// 引到注册界面，而不是像旧版那样「新邮箱自动注册」。
  Future<EmailLoginResult> login(String email, {String? code}) async {
    final String mail = email.trim().toLowerCase();
    final String otp = code?.trim() ?? "";
    final String deviceId = await InstallIdentity.instance.installId();
    try {
      final http.Response res = await _client
          .post(
            Uri.parse("$_baseUrl/accounts/login"),
            headers: const <String, String>{"Content-Type": "application/json"},
            body: jsonEncode(<String, dynamic>{
              "userId": mail,
              "email": mail,
              if (otp.isNotEmpty) "otpCode": otp,
              // 认证即发证：服务端按该设备标识签发 access token，
              // 与 WS session.init 上报的 deviceId 同源，便于排查对账。
              "deviceId": deviceId,
            }),
          )
          .timeout(_timeout);
      final Map<String, dynamic> data =
          jsonDecode(utf8.decode(res.bodyBytes)) as Map<String, dynamic>;
      if (res.statusCode == 200 && data["ok"] == true) {
        return EmailLoginResult(
          ok: true,
          accessToken: data["accessToken"]?.toString(),
          accessTokenId: data["accessTokenId"]?.toString(),
          deviceId: data["deviceId"]?.toString(),
          accessTokenExpiresAt:
              (data["accessTokenExpiresAt"] as num?)?.toInt() ?? 0,
        );
      }
      return EmailLoginResult(
        ok: false,
        code: data["code"]?.toString(),
        error: data["message"]?.toString() ?? "登录失败，请稍后重试",
      );
    } catch (e) {
      debugPrint("[EmailLoginApi] login failed: $e");
      return const EmailLoginResult(ok: false, error: "网络错误，请检查网络后重试");
    }
  }

  /// 注册（只注册，不登录已有账号）。
  ///
  /// [name] 是注册表单里的「你的名称」：新账号作为 displayName 落库，开场白
  /// 用它称呼用户。邮箱已注册时服务端返回 409 → [EmailLoginResult.accountExists]。
  Future<EmailLoginResult> register(String email,
      {String? code, String? name}) async {
    final String mail = email.trim().toLowerCase();
    final String otp = code?.trim() ?? "";
    final String userName = name?.trim() ?? "";
    final String deviceId = await InstallIdentity.instance.installId();
    try {
      final http.Response res = await _client
          .post(
            Uri.parse("$_baseUrl/accounts/register"),
            headers: const <String, String>{"Content-Type": "application/json"},
            body: jsonEncode(<String, dynamic>{
              "userId": mail,
              "displayName": userName.isNotEmpty ? userName : mail.split("@").first,
              "email": mail,
              "mode": "register",
              if (otp.isNotEmpty) "otpCode": otp,
              "deviceId": deviceId,
            }),
          )
          .timeout(_timeout);
      final Map<String, dynamic> data =
          jsonDecode(utf8.decode(res.bodyBytes)) as Map<String, dynamic>;
      if (res.statusCode == 200 && data["ok"] == true) {
        return EmailLoginResult(
          ok: true,
          accessToken: data["accessToken"]?.toString(),
          accessTokenId: data["accessTokenId"]?.toString(),
          deviceId: data["deviceId"]?.toString(),
          accessTokenExpiresAt:
              (data["accessTokenExpiresAt"] as num?)?.toInt() ?? 0,
        );
      }
      final String message = data["message"]?.toString() ?? "";
      final String? code2 = data["code"]?.toString();
      // 老服务端没有 code 字段：沿用文案识别，行为不倒退
      if (code2 == "ACCOUNT_EXISTS" || message.contains("已存在")) {
        return EmailLoginResult(
          ok: false,
          code: "ACCOUNT_EXISTS",
          error: message.isNotEmpty ? message : "该邮箱已注册，请直接登录",
        );
      }
      return EmailLoginResult(
        ok: false,
        code: code2,
        error: message.isNotEmpty ? message : "注册失败，请稍后重试",
      );
    } catch (e) {
      debugPrint("[EmailLoginApi] register failed: $e");
      return const EmailLoginResult(ok: false, error: "网络错误，请检查网络后重试");
    }
  }
}
