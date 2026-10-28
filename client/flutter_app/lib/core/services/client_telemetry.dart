import "dart:convert";
import "dart:io" show Platform;

import "package:flutter/foundation.dart" show debugPrint, kDebugMode;
import "package:http/http.dart" as http;
import "package:package_info_plus/package_info_plus.dart";

import "../config/api_config.dart";
import "install_identity.dart";
import "local_runtime_manager.dart";

/// 安装包运行埋点：每次启动把「本机后端起来了吗、花了多久、什么版本/通道」
/// 上报到控制面（`POST /api/telemetry/client-boot`）。
///
/// 这是 runtime 收回云端前唯一的装机数据来源（装了多少台、多少台起不来），
/// 所以必须 fail-open：任何异常只静默丢一条上报，绝不拖慢或打断启动。
class ClientTelemetry {
  ClientTelemetry._();

  static final http.Client _client = http.Client();

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
