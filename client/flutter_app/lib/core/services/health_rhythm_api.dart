import "dart:convert";

import "package:http/http.dart" as http;

import "../config/api_config.dart";

/// 健康节奏档位（GET /api/health/rhythm 下发，2026-10-23 第二版）。
///
/// 服务端按用户事实库的身份/职业线索解析档位；认不出身份返回保守默认。
/// 护眼、喝水提醒均已删除，本模型只承载久坐参数。
class HealthRhythm {
  const HealthRhythm({
    required this.key,
    required this.label,
    required this.source,
    this.matched,
    this.sedentaryAfterMinutes,
    required this.startHour,
    required this.endHour,
  });

  /// 档位 key：default / office / student / driver / active
  final String key;
  final String label;

  /// identity-fact = 按身份命中；default = 未识别身份的保守默认
  final String source;

  /// 命中的身份/职业原文（诊断用）
  final String? matched;

  /// null = 该身份不开久坐提醒（驾驶/体力站立等）
  final int? sedentaryAfterMinutes;
  final int startHour;
  final int endHour;

  static HealthRhythm? fromJson(Map<String, dynamic> json) {
    final Map<String, dynamic>? p = json["profile"] is Map<String, dynamic>
        ? json["profile"] as Map<String, dynamic>
        : null;
    if (p == null) return null;
    return HealthRhythm(
      key: p["key"]?.toString() ?? "default",
      label: p["label"]?.toString() ?? "通用",
      source: p["source"]?.toString() ?? "default",
      matched: p["matched"]?.toString(),
      sedentaryAfterMinutes: (p["sedentaryAfterMinutes"] as num?)?.toInt(),
      startHour: (p["startHour"] as num?)?.toInt() ?? 9,
      endHour: (p["endHour"] as num?)?.toInt() ?? 21,
    );
  }
}

/// 健康节奏 API：进程内只拉一次，失败静默（客户端用保守默认兜底）。
class HealthRhythmApi {
  HealthRhythmApi({String? baseUrl, http.Client? client})
      : _baseUrl = baseUrl ?? ApiConfig.httpBase,
        _client = client ?? http.Client();

  final String _baseUrl;
  final http.Client _client;

  Future<HealthRhythm?> fetch() async {
    try {
      final Uri uri = Uri.parse("$_baseUrl/api/health/rhythm").replace(
        queryParameters: <String, String>{"actorId": ApiConfig.effectiveActorId},
      );
      final http.Response res =
          await _client.get(uri).timeout(const Duration(seconds: 8));
      if (res.statusCode != 200) return null;
      final Map<String, dynamic> json =
          jsonDecode(utf8.decode(res.bodyBytes)) as Map<String, dynamic>;
      if (json["ok"] != true) return null;
      return HealthRhythm.fromJson(json);
    } catch (_) {
      return null;
    }
  }
}
