import "dart:async";
import "dart:convert";

import "package:http/http.dart" as http;

import "../config/api_config.dart";
import "nb_http.dart";

/// 一条旁聊摘要（服务端 `GET /api/side-chats` 的单条）。
class SideChatSummary {
  const SideChatSummary({
    required this.id,
    required this.sessionId,
    required this.title,
    required this.preview,
    required this.messageCount,
    required this.updatedAt,
  });

  final String id;

  /// 线程键 `side:<actor>:<id>`（发消息 / 拉历史时使用）。
  final String sessionId;
  final String title;
  final String preview;
  final int messageCount;
  final DateTime updatedAt;

  factory SideChatSummary.fromJson(Map<String, dynamic> json) {
    final Object? rawUpdated = json["updatedAt"];
    DateTime updated = DateTime.now();
    if (rawUpdated is String) {
      updated = DateTime.tryParse(rawUpdated)?.toLocal() ?? updated;
    }
    return SideChatSummary(
      id: json["id"]?.toString() ?? "",
      sessionId: json["sessionId"]?.toString() ?? "",
      title: json["title"]?.toString() ?? "新旁聊",
      preview: json["preview"]?.toString() ?? "",
      messageCount: json["messageCount"] is int ? json["messageCount"] as int : 0,
      updatedAt: updated,
    );
  }
}

/// 旁聊列表 API：`/api/side-chats`（新建 / 搜索 / 重命名 / 删除）。
class SideChatApi {
  SideChatApi({required this.baseUrl});

  final String baseUrl;

  static const Duration _timeout = Duration(seconds: 15);

  String get _actorId => ApiConfig.effectiveActorId;

  Uri _uri(String path, [Map<String, String>? query]) {
    final Uri root = Uri.parse(baseUrl);
    final String rel = path.startsWith("/") ? path.substring(1) : path;
    final Uri u = root.resolve(rel);
    return query == null ? u : u.replace(queryParameters: query);
  }

  static const Map<String, String> _jsonHeaders = <String, String>{
    "Content-Type": "application/json",
  };

  /// 列表（[query] 非空时服务端按标题/预览过滤）。
  Future<List<SideChatSummary>> list({String? query}) async {
    try {
      final Uri uri = _uri("/api/side-chats", <String, String>{
        "actorId": _actorId,
        if ((query ?? "").trim().isNotEmpty) "q": query!.trim(),
      });
      final http.Response res = await NbHttp.get(uri).timeout(_timeout);
      if (res.statusCode != 200) return const <SideChatSummary>[];
      final Object? decoded = jsonDecode(res.body);
      if (decoded is! Map<String, dynamic>) return const <SideChatSummary>[];
      final List<dynamic> raw = decoded["chats"] as List<dynamic>? ?? const [];
      return raw
          .whereType<Map<String, dynamic>>()
          .map(SideChatSummary.fromJson)
          .where((c) => c.id.isNotEmpty)
          .toList(growable: false);
    } catch (_) {
      return const <SideChatSummary>[];
    }
  }

  /// 新建旁聊（标题缺省由服务端补「新旁聊」）。
  Future<SideChatSummary?> create({String? title}) async {
    try {
      final http.Response res = await NbHttp.post(
        _uri("/api/side-chats"),
        headers: _jsonHeaders,
        body: jsonEncode(<String, dynamic>{
          "actorId": _actorId,
          if ((title ?? "").trim().isNotEmpty) "title": title!.trim(),
        }),
      ).timeout(_timeout);
      if (res.statusCode != 200) return null;
      final Object? decoded = jsonDecode(res.body);
      if (decoded is! Map<String, dynamic>) return null;
      final Object? chat = decoded["chat"];
      if (chat is! Map<String, dynamic>) return null;
      return SideChatSummary.fromJson(chat);
    } catch (_) {
      return null;
    }
  }

  /// 重命名。
  Future<SideChatSummary?> rename(String id, String title) async {
    try {
      final http.Response res = await NbHttp.patch(
        _uri("/api/side-chats"),
        headers: _jsonHeaders,
        body: jsonEncode(<String, dynamic>{
          "actorId": _actorId,
          "id": id,
          "title": title,
        }),
      ).timeout(_timeout);
      if (res.statusCode != 200) return null;
      final Object? decoded = jsonDecode(res.body);
      if (decoded is! Map<String, dynamic>) return null;
      final Object? chat = decoded["chat"];
      if (chat is! Map<String, dynamic>) return null;
      return SideChatSummary.fromJson(chat);
    } catch (_) {
      return null;
    }
  }

  /// 删除（服务端同时清空该旁聊线程）。
  Future<bool> delete(String id) async {
    try {
      final http.Response res = await NbHttp.delete(
        _uri("/api/side-chats", <String, String>{
          "actorId": _actorId,
          "id": id,
        }),
      ).timeout(_timeout);
      return res.statusCode == 200;
    } catch (_) {
      return false;
    }
  }
}
