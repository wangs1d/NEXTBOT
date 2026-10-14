import "dart:async";
import "dart:convert";
import "dart:io" show Platform;

import "package:flutter/foundation.dart";
import "package:flutter/services.dart";
import "package:http/http.dart" as http;

import "../config/api_config.dart";

/// 移动端推送通道注册（华为 HMS 直连）：
/// 原生侧（MobilePushPlugin.kt）实现 MethodChannel "pai/mobile_push" 的 getPushToken：
///   - configured=false（无 agconnect-services.json / HMS 不可用）→ 本类立即放弃，静默降级；
///   - configured=true 且 token 空（registrationID 异步生成中）→ 退避重试；
///   - token 就绪 → POST /api/proactivity/push/register 上报 actorId + provider="huawei" + token。
/// 此后手机端离线（WS 断开/App 被杀）时，日程/重要提醒经服务端华为 Push Kit
/// 直推成系统级通知（横幅弹窗）。
///
/// 重注册时机：登录身份（actorId）变化后（启动一次 + 每次 WS 连上时调用，
/// 内部按 actorId 去重——同一身份不重复上报）。
class MobilePushRegistrar {
  MobilePushRegistrar._();

  static const MethodChannel _channel = MethodChannel("pai/mobile_push");

  /// 已成功上报过的 actorId（null = 从未成功）；同身份不重复注册
  static String? _registeredForActor;

  /// 登录身份切换后允许重新注册（保留给登出/切换账号场景）
  static void reset() => _registeredForActor = null;

  static Future<void> registerIfNeeded({int maxAttempts = 15}) async {
    if (kIsWeb) return;
    // 桌面（Windows 调试）无厂商推送：跳过
    if (!Platform.isAndroid && !Platform.isIOS) return;
    final String actorId = ApiConfig.effectiveActorId;
    if (_registeredForActor == actorId) return;
    final String diagActor = actorId.isEmpty ? "(empty)" : actorId;

    // HMS 首次取 token 可能需要与华为后端握手较久：退避序列 4/8/12...60s，
    // 全窗口约 5.5 分钟；仍未就绪则等下次 WS 重连/回前台再补（见 main.dart）。
    String lastErr = "";
    var gaveUpNoConfig = false;
    for (int attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        final Object? raw = await _channel.invokeMethod<Object>("getPushToken");
        if (raw is! Map) {
          lastErr = "native returned non-map";
          break;
        }
        final String provider = raw["provider"]?.toString() ?? "huawei";
        // 原生侧无 AGC 配置：整体通道未启用——重试无意义，跳出后上报诊断
        if (raw["configured"] != true) {
          lastErr = "native configured=false (no agconnect config / HMS unavailable)";
          gaveUpNoConfig = true;
          debugPrint("[mobile-push] provider=$provider not configured, skip");
          break;
        }
        final String token = raw["token"]?.toString() ?? "";
        lastErr = raw["err"]?.toString() ?? "";
        if (token.isNotEmpty) {
          final http.Response response = await http.post(
            Uri.parse("${ApiConfig.httpBase}/api/proactivity/push/register"),
            headers: const {"Content-Type": "application/json"},
            body: jsonEncode(<String, String>{
              "actorId": actorId,
              "provider": provider,
              "token": token,
            }),
          );
          if (response.statusCode == 200) {
            _registeredForActor = actorId;
            debugPrint("[mobile-push] token registered (provider=$provider)");
            return;
          }
          lastErr = "register HTTP ${response.statusCode}";
          debugPrint("[mobile-push] register failed: $lastErr");
        } else {
          debugPrint("[mobile-push] registrationID pending (attempt $attempt)");
        }
      } catch (e) {
        // 原生侧异常 / 无网络：退避后重试，最终放弃不影响 App 其他功能
        lastErr = "client: $e";
        debugPrint("[mobile-push] register unavailable: $e");
      }
      if (attempt < maxAttempts) {
        await Future<void>.delayed(Duration(seconds: attempt * 4));
      }
    }
    // 重试耗尽 / 无配置：把设备侧真实报错上报服务端落日志（远程诊断用）
    if (lastErr.isNotEmpty) {
      try {
        await http.post(
          Uri.parse("${ApiConfig.httpBase}/api/proactivity/push/register"),
          headers: const {"Content-Type": "application/json"},
          body: jsonEncode(<String, String>{
            "actorId": diagActor,
            "provider": "huawei",
            "err": lastErr,
          }),
        );
      } catch (_) {
        /* 诊断上报失败不影响主流程 */
      }
    }
    debugPrint("[mobile-push] register gave up after $maxAttempts attempts");
  }
}
