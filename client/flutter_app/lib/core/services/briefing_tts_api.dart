import "dart:convert";

import "package:flutter/foundation.dart";
import "package:http/http.dart" as http;
import "nb_http.dart";

import "../config/api_config.dart";
import "access_auth_api.dart";

/// 简报 TTS 端点收口：POST /api/morning-briefing/tts → base64 音频。
///
/// 简报独立窗口与纯语音模式控制器共用本端点；播放策略（缓存复播 /
/// 进度订阅 / 直接播报）由调用方自理，这里只管取音频。
class BriefingTtsApi {
  BriefingTtsApi._();

  static const Duration defaultTimeout = Duration(seconds: 15);

  /// 请求语音并返回 base64 音频；失败（网络 / 非 200 / 空载荷）返回 null。
  static Future<String?> fetchSpeech(
    String text, {
    Duration timeout = defaultTimeout,
  }) async {
    try {
      // 注意：authHeaders 未绑定时返回 const map，不能级联修改，需展开合并
      final Map<String, String> headers = <String, String>{
        "Content-Type": "application/json",
        ...AccessCredentialStore.instance.authHeaders,
      };
      debugPrint("[BriefingTtsApi] tts request -> ${ApiConfig.httpBase}");
      final http.Response res = await NbHttp.post(
            Uri.parse("${ApiConfig.httpBase}/api/morning-briefing/tts"),
            headers: headers,
            body: jsonEncode(<String, dynamic>{"text": text}),
          )
          .timeout(timeout);
      debugPrint("[BriefingTtsApi] tts response ${res.statusCode} "
          "len=${res.body.length}");
      if (res.statusCode != 200) return null;
      final Map<String, dynamic> data =
          jsonDecode(res.body) as Map<String, dynamic>;
      final String? base64Audio = data["base64"]?.toString();
      if (base64Audio == null || base64Audio.isEmpty) return null;
      return base64Audio;
    } catch (e) {
      debugPrint("[BriefingTtsApi] tts failed: $e");
      return null;
    }
  }
}
