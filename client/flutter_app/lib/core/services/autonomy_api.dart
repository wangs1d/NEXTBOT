import "dart:async";
import "dart:convert";

import "package:http/http.dart" as http;

import "../config/api_config.dart";
import "access_auth_api.dart";
import "./nb_http.dart";

/// 自主性设置（服务端：server/src/services/autonomy-settings-store.ts）。
///
/// 等级语义：
///  - 0 只建议：管家的主动性只说话不执行
///  - 1 标准：常规事务可自动执行，金额/不可逆/涉他人先确认
///  - 2 高效：可逆且不涉钱、不涉他人的动作直接执行，金额/不可逆仍先确认
class AutonomySettings {
  const AutonomySettings({required this.level, required this.dndUntil});

  final int level;
  /// 勿扰截止 epoch 毫秒；0 = 关闭
  final int dndUntil;

  bool get dndActive => dndUntil > DateTime.now().millisecondsSinceEpoch;

  static AutonomySettings fromJson(Map<String, dynamic> json) =>
      AutonomySettings(
        level: (json["level"] as num?)?.toInt() ?? 1,
        dndUntil: (json["dndUntil"] as num?)?.toInt() ?? 0,
      );
}

class AutonomyApi {
  AutonomyApi({String? baseUrl, http.Client? client})
      : _baseUrl = baseUrl ?? ApiConfig.httpBase,
        _client = client ?? NbClient();

  final String _baseUrl;
  final http.Client _client;

  static const Duration _timeout = Duration(seconds: 10);

  Map<String, String> get _headers => <String, String>{
        "Content-Type": "application/json",
        ...AccessCredentialStore.instance.authHeaders,
      };

  Future<AutonomySettings?> fetch() async {
    try {
      final Uri uri = Uri.parse("$_baseUrl/api/autonomy").replace(
        queryParameters: <String, String>{"userId": ApiConfig.effectiveActorId},
      );
      final http.Response res =
          await _client.get(uri, headers: _headers).timeout(_timeout);
      if (res.statusCode != 200) return null;
      final Map<String, dynamic> data =
          jsonDecode(res.body) as Map<String, dynamic>;
      if (data["ok"] != true) return null;
      return AutonomySettings.fromJson(data);
    } catch (_) {
      return null;
    }
  }

  Future<AutonomySettings?> update({int? level, int? dndUntil}) async {
    try {
      final http.Response res = await _client
          .put(
            Uri.parse("$_baseUrl/api/autonomy"),
            headers: _headers,
            body: jsonEncode(<String, dynamic>{
              "userId": ApiConfig.effectiveActorId,
              if (level != null) "level": level,
              if (dndUntil != null) "dndUntil": dndUntil,
            }),
          )
          .timeout(_timeout);
      if (res.statusCode != 200) return null;
      final Map<String, dynamic> data =
          jsonDecode(res.body) as Map<String, dynamic>;
      if (data["ok"] != true) return null;
      return AutonomySettings.fromJson(data);
    } catch (_) {
      return null;
    }
  }
}
