import "dart:convert";

import "package:http/http.dart" as http;

/// 用户偏好设置 API 客户端。
///
/// 服务端实现位于 `server/src/routes/http/user-preferences.ts`，
/// 负责存储包括"早安简报"在内的用户个性化配置。
class UserPreferencesApi {
  UserPreferencesApi({required this.baseUrl, http.Client? client})
      : _client = client ?? http.Client();

  final String baseUrl;
  final http.Client _client;

  /// 简报播报方式：仅语音
  static const String modeVoice = "voice";

  /// 简报播报方式：桌面弹窗
  static const String modeWindow = "window";

  /// 简报播报方式：聊天卡片（仅文本展示）
  static const String modeCard = "card";

  static const Duration _timeout = Duration(seconds: 10);

  static const Map<String, bool> defaultBriefingSections = <String, bool>{
    "schedule": true,
  };

  static const String moodFunny = "funny";
  static const String moodSad = "sad";
  static const String moodCool = "cool";
  static const String moodGentle = "gentle";
  static const String moodEnergetic = "energetic";
  static const String moodMysterious = "mysterious";

  /// 拉取指定会话的偏好。
  Future<Map<String, dynamic>> getPreferences(String sessionId) async {
    final Uri uri = Uri.parse("$baseUrl/api/user-preferences?sessionId=$sessionId");
    final http.Response res = await _client.get(uri).timeout(_timeout);
    if (res.statusCode != 200) {
      throw Exception("获取偏好失败: ${res.statusCode}");
    }
    final Map<String, dynamic> data =
        jsonDecode(res.body) as Map<String, dynamic>;
    final Object? prefs = data["preferences"];
    if (prefs is Map) {
      return prefs.cast<String, dynamic>();
    }
    return <String, dynamic>{};
  }

  /// 更新早安简报相关的偏好设置。
  ///
  /// 任意参数为 `null` 时不会发送到服务端，保留原值。
  Future<Map<String, dynamic>> updatePreferences(
    String sessionId, {
    bool? enabled,
    String? time,
    String? mode,
    bool? showOnDesktopLaunch,
    Map<String, bool>? sections,
    Map<String, Object?>? agentProfile,
  }) async {
    final Uri uri = Uri.parse("$baseUrl/api/user-preferences");
    final Map<String, Object?> body = <String, Object?>{
      "sessionId": sessionId,
      "preferences": <String, Object?>{
        "morningBriefing": <String, Object?>{
          if (enabled != null) "enabled": enabled,
          if (time != null) "time": time,
          if (mode != null) "mode": mode,
          if (showOnDesktopLaunch != null)
            "showOnDesktopLaunch": showOnDesktopLaunch,
          if (sections != null) "sections": sections,
        },
        if (agentProfile != null) "agentProfile": agentProfile,
      },
    };
    final http.Response res = await _client
        .put(
          uri,
          headers: const <String, String>{"Content-Type": "application/json"},
          body: jsonEncode(body),
        )
        .timeout(_timeout);
    if (res.statusCode != 200) {
      throw Exception("更新偏好失败: ${res.statusCode}");
    }
    final Map<String, dynamic> data =
        jsonDecode(res.body) as Map<String, dynamic>;
    final Object? prefs = data["preferences"];
    if (prefs is Map) {
      return prefs.cast<String, dynamic>();
    }
    return <String, dynamic>{};
  }
}
