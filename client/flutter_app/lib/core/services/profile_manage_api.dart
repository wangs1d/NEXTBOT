import "dart:convert";

import "package:http/http.dart" as http;

import "../config/api_config.dart";
import "nb_http.dart";

/// 「它眼里的你」画像管理数据模型（GET /api/profile/manage）。
class ProfileLineData {
  const ProfileLineData({
    required this.text,
    this.lastConfirmedAt,
    this.seenCount = 0,
  });

  final String text;
  final String? lastConfirmedAt;
  final int seenCount;

  /// 占位行（「（待了解…）」）：不是真实事实，列表里隐藏。
  bool get isPlaceholder {
    final String t = text.trim();
    return t.startsWith("（") && t.endsWith("）");
  }

  static ProfileLineData fromJson(Map<String, dynamic> json) => ProfileLineData(
        text: json["text"]?.toString() ?? "",
        lastConfirmedAt: json["lastConfirmedAt"]?.toString(),
        seenCount: (json["seenCount"] as num?)?.toInt() ?? 0,
      );
}

class ProfileSectionData {
  const ProfileSectionData({
    required this.key,
    required this.title,
    required this.lines,
  });

  final String key;
  final String title;
  final List<ProfileLineData> lines;

  List<ProfileLineData> get realLines => lines.where((l) => !l.isPlaceholder).toList();

  static ProfileSectionData fromJson(Map<String, dynamic> json) => ProfileSectionData(
        key: json["key"]?.toString() ?? "",
        title: json["title"]?.toString() ?? "",
        lines: ((json["lines"] as List<dynamic>?) ?? <dynamic>[])
            .whereType<Map<String, dynamic>>()
            .map(ProfileLineData.fromJson)
            .toList(),
      );
}

class ProfileUnderstandingItem {
  const ProfileUnderstandingItem({
    required this.topic,
    required this.note,
    required this.kind,
  });

  final String topic;
  final String note;
  final String kind;

  static ProfileUnderstandingItem fromJson(Map<String, dynamic> json) =>
      ProfileUnderstandingItem(
        topic: json["topic"]?.toString() ?? "",
        note: json["note"]?.toString() ?? "",
        kind: json["kind"]?.toString() ?? "",
      );
}

class ProfileFactItem {
  const ProfileFactItem({required this.field, required this.value});

  final String field;
  final String value;

  static ProfileFactItem fromJson(Map<String, dynamic> json) => ProfileFactItem(
        field: json["field"]?.toString() ?? "",
        value: json["value"]?.toString() ?? "",
      );
}

class ProfileManageData {
  const ProfileManageData({
    required this.markdown,
    required this.sections,
    required this.understandings,
    required this.facts,
    required this.pendingTurns,
  });

  final String markdown;
  final List<ProfileSectionData> sections;
  final List<ProfileUnderstandingItem> understandings;
  final List<ProfileFactItem> facts;
  final int pendingTurns;

  static ProfileManageData fromJson(Map<String, dynamic> json) => ProfileManageData(
        markdown: json["markdown"]?.toString() ?? "",
        sections: ((json["sections"] as List<dynamic>?) ?? <dynamic>[])
            .whereType<Map<String, dynamic>>()
            .map(ProfileSectionData.fromJson)
            .toList(),
        understandings: ((json["understandings"] as List<dynamic>?) ?? <dynamic>[])
            .whereType<Map<String, dynamic>>()
            .map(ProfileUnderstandingItem.fromJson)
            .toList(),
        facts: ((json["facts"] as List<dynamic>?) ?? <dynamic>[])
            .whereType<Map<String, dynamic>>()
            .map(ProfileFactItem.fromJson)
            .toList(),
        pendingTurns: (json["pendingTurns"] as num?)?.toInt() ?? 0,
      );
}

/// 画像管理 API（「它眼里的你」设置分区）。
class ProfileManageApi {
  ProfileManageApi({String? baseUrl, http.Client? client})
      : _baseUrl = baseUrl ?? ApiConfig.httpBase,
        _client = client ?? NbClient();

  final String _baseUrl;
  final http.Client _client;

  Future<ProfileManageData?> fetch() async {
    try {
      final Uri uri = Uri.parse("$_baseUrl/api/profile/manage")
          .replace(queryParameters: <String, String>{"actorId": ApiConfig.effectiveActorId});
      final http.Response res = await _client
          .get(uri, headers: NbHttp.headersFor(uri))
          .timeout(const Duration(seconds: 8));
      if (res.statusCode != 200) return null;
      final Map<String, dynamic> json =
          jsonDecode(utf8.decode(res.bodyBytes)) as Map<String, dynamic>;
      if (json["ok"] != true) return null;
      return ProfileManageData.fromJson(json);
    } catch (_) {
      return null;
    }
  }

  /// 行级修改：op=ADD/UPDATE/DELETE（UPDATE/DELETE 须带 match 定位旧行）。
  /// 返回 null = 请求失败；非 null = 成功（含服务端回传的最新画像全文）。
  Future<String?> mutateLine({
    required String op,
    required String section,
    String? line,
    String? match,
  }) async {
    try {
      final Uri uri = Uri.parse("$_baseUrl/api/profile/manage/line");
      final http.Response res = await _client
          .post(
            uri,
            headers: <String, String>{
              "Content-Type": "application/json",
              ...NbHttp.headersFor(uri),
            },
            body: jsonEncode(<String, dynamic>{
              "actorId": ApiConfig.effectiveActorId,
              "op": op,
              "section": section,
              if (line != null && line.isNotEmpty) "line": line,
              if (match != null && match.isNotEmpty) "match": match,
            }),
          )
          .timeout(const Duration(seconds: 8));
      final Map<String, dynamic> json =
          jsonDecode(utf8.decode(res.bodyBytes)) as Map<String, dynamic>;
      if (json["ok"] != true) return null;
      return json["markdown"]?.toString();
    } catch (_) {
      return null;
    }
  }
}
