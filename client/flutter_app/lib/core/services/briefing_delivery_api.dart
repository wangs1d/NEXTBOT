import "dart:convert";

import "package:http/http.dart" as http;

import "nb_http.dart";

class BriefingDeliveryApi {
  BriefingDeliveryApi({required this.baseUrl, http.Client? client})
      : _client = client ?? http.Client();

  final String baseUrl;
  final http.Client _client;

  static const Duration _timeout = Duration(seconds: 10);

  Future<Map<String, dynamic>> getStatus(String sessionId) async {
    final Uri uri =
        Uri.parse("$baseUrl/api/briefing-delivery?sessionId=$sessionId");
    final http.Response res = await _client
        .get(uri, headers: NbHttp.headersFor(uri))
        .timeout(_timeout);
    if (res.statusCode != 200) {
      throw Exception("获取简报投放状态失败: ${res.statusCode}");
    }
    return jsonDecode(res.body) as Map<String, dynamic>;
  }

  Future<Map<String, dynamic>> markDelivered(
    String sessionId, {
    required String channel,
  }) async {
    final Uri uri = Uri.parse("$baseUrl/api/briefing-delivery");
    final http.Response res = await _client
        .post(
          uri,
          headers: <String, String>{
            "Content-Type": "application/json",
            ...NbHttp.headersFor(uri),
          },
          body: jsonEncode(<String, dynamic>{
            "sessionId": sessionId,
            "channel": channel,
          }),
        )
        .timeout(_timeout);
    if (res.statusCode != 200) {
      throw Exception("标记简报已投放失败: ${res.statusCode}");
    }
    return jsonDecode(res.body) as Map<String, dynamic>;
  }
}
