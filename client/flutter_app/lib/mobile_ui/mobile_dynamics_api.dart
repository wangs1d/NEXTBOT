// 「动态」页的服务端调用（真实数据源，无本地 mock）。
//
// 所有页面共用这一层：GET /api/dynamics 聚合数据 + 各类动作 POST。
// 动作失败直接抛出，由页面就地提示（不整页错误）。
import "dart:convert";

import "package:http/http.dart" as http;

import "../core/config/api_config.dart";
import "../core/services/nb_http.dart";

class DynamicsApi {
  DynamicsApi({http.Client? client}) : _client = client ?? NbClient();

  final http.Client _client;

  /// 首页/详情/列表共用的聚合数据。
  Future<Map<String, dynamic>> fetch({int days = 30, int limit = 20}) {
    return _get("/api/dynamics", <String, String>{
      "userId": ApiConfig.effectiveActorId,
      "days": "$days",
      "limit": "$limit",
    });
  }

  Future<Map<String, dynamic>> setPickedUp(String id, bool pickedUp) {
    return _post("/api/dynamics/parcels/${Uri.encodeComponent(id)}/pickup",
        <String, dynamic>{"pickedUp": pickedUp});
  }

  /// [status] 为 reimbursed / wrong；传 null 表示撤销复核。
  Future<Map<String, dynamic>> reviewBill(String id, String? status) {
    return _post("/api/dynamics/bills/${Uri.encodeComponent(id)}/review",
        <String, dynamic>{"status": status ?? "clear"});
  }

  Future<Map<String, dynamic>> snooze(String id, DateTime? until) {
    return _post("/api/dynamics/entries/${Uri.encodeComponent(id)}/snooze",
        <String, dynamic>{"until": until?.millisecondsSinceEpoch});
  }

  Future<Map<String, dynamic>> archive(String id, {bool archived = true}) {
    return _post("/api/dynamics/entries/${Uri.encodeComponent(id)}/archive",
        <String, dynamic>{"archived": archived});
  }

  Future<Map<String, dynamic>> pin(String id, {bool pinned = true}) {
    return _post("/api/dynamics/entries/${Uri.encodeComponent(id)}/pin",
        <String, dynamic>{"pinned": pinned});
  }

  Future<Map<String, dynamic>> dismissSubscription(String id) {
    return _post(
        "/api/dynamics/subscriptions/${Uri.encodeComponent(id)}/dismiss",
        const <String, dynamic>{});
  }

  Future<Map<String, dynamic>> remindSubscription(String id) {
    return _post(
        "/api/dynamics/subscriptions/${Uri.encodeComponent(id)}/remind",
        const <String, dynamic>{});
  }

  Future<Map<String, dynamic>> _get(
    String path,
    Map<String, String> query,
  ) async {
    final Uri uri = Uri.parse("${ApiConfig.httpBase}$path")
        .replace(queryParameters: query);
    final http.Response res =
        await _client.get(uri).timeout(const Duration(seconds: 20));
    return _decode(res);
  }

  Future<Map<String, dynamic>> _post(
    String path,
    Map<String, dynamic> body,
  ) async {
    final Uri uri = Uri.parse("${ApiConfig.httpBase}$path");
    final http.Response res = await _client
        .post(
          uri,
          headers: const <String, String>{"content-type": "application/json"},
          body: jsonEncode(body),
        )
        .timeout(const Duration(seconds: 20));
    return _decode(res);
  }

  Map<String, dynamic> _decode(http.Response res) {
    Map<String, dynamic> body = const <String, dynamic>{};
    try {
      final Object? decoded = jsonDecode(res.body);
      if (decoded is Map<String, dynamic>) body = decoded;
    } catch (_) {
      // 非 JSON 响应（网关错误页等）落到下面的状态码错误
    }
    if (res.statusCode != 200 || body["ok"] != true) {
      throw Exception(body["error"]?.toString() ?? "服务端返回 ${res.statusCode}");
    }
    return body;
  }
}
