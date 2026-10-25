import "dart:convert";

import "package:http/http.dart" as http;

import "../config/api_config.dart";
import "access_auth_api.dart";
import "install_identity.dart";

/// 反馈提交/查询的通用结果包装。
class FeedbackResult<T> {
  const FeedbackResult._({required this.ok, this.value, this.error});

  final bool ok;
  final T? value;
  final String? error;

  factory FeedbackResult.success(T value) =>
      FeedbackResult._(ok: true, value: value);
  factory FeedbackResult.failure(String error) =>
      FeedbackResult._(ok: false, error: error);
}

/// 一条反馈记录（服务端实现：server/src/routes/http/feedback.ts）。
class FeedbackRecord {
  const FeedbackRecord({
    required this.id,
    required this.type,
    required this.title,
    required this.description,
    required this.status,
    this.contact,
    this.replyNote,
    this.createdAt,
  });

  final String id;

  /// bug / suggestion / other
  final String type;
  final String title;
  final String description;
  final String? contact;

  /// open / processing / resolved
  final String status;

  /// 管理员处理后的回复说明。
  final String? replyNote;
  final DateTime? createdAt;

  factory FeedbackRecord.fromJson(Map<String, dynamic> json) {
    return FeedbackRecord(
      id: json["id"]?.toString() ?? "",
      type: json["type"]?.toString() ?? "other",
      title: json["title"]?.toString() ?? "",
      description: json["description"]?.toString() ?? "",
      status: json["status"]?.toString() ?? "open",
      contact: json["contact"]?.toString(),
      replyNote: json["replyNote"]?.toString(),
      createdAt: json["createdAt"] == null
          ? null
          : DateTime.tryParse(json["createdAt"].toString())?.toLocal(),
    );
  }

  String get typeLabel => switch (type) {
        "bug" => "问题报障",
        "suggestion" => "功能建议",
        _ => "其他",
      };

  String get statusLabel => switch (status) {
        "open" => "待处理",
        "processing" => "处理中",
        "resolved" => "已解决",
        _ => status,
      };
}

/// 反馈 API 客户端（用户菜单「反馈」弹窗使用）。
///
/// 走控制面（[ApiConfig.controlPlaneBase]，管理后台所在服务器）而不是
/// 本地 runtime —— 否则捆绑用户的反馈落在本机数据库，后台永远收不到。
class FeedbackApi {
  FeedbackApi({String? baseUrl, http.Client? client})
      : _baseUrl = baseUrl ?? ApiConfig.controlPlaneBase,
        _client = client ?? http.Client();

  final String _baseUrl;
  final http.Client _client;

  static const Duration _timeout = Duration(seconds: 10);

  Map<String, String> get _headers => <String, String>{
        "Content-Type": "application/json",
        ...AccessCredentialStore.instance.authHeaders,
      };

  /// 提交一条反馈；[diagnostics] 为可选的附加诊断信息（服务端会做标量化清洗）。
  Future<FeedbackResult<FeedbackRecord>> submit({
    required String type,
    required String title,
    required String description,
    String? contact,
    Map<String, Object> diagnostics = const <String, Object>{},
  }) async {
    try {
      final http.Response res = await _client
          .post(
            Uri.parse("$_baseUrl/api/feedback"),
            headers: _headers,
            body: jsonEncode(<String, dynamic>{
              // 控制面身份：稳定安装 ID（或部署配置的 USER_ID），避免全员撞同一 sessionId
              "userId": await InstallIdentity.instance.actorId(),
              "type": type,
              "title": title,
              "description": description,
              if (contact != null && contact.isNotEmpty) "contact": contact,
              if (diagnostics.isNotEmpty) "diagnostics": diagnostics,
            }),
          )
          .timeout(_timeout);
      final Map<String, dynamic> data =
          jsonDecode(res.body) as Map<String, dynamic>;
      if (res.statusCode != 200 || data["ok"] != true) {
        return FeedbackResult.failure(
          data["error"]?.toString() ?? "提交失败: ${res.statusCode}",
        );
      }
      return FeedbackResult.success(
        FeedbackRecord.fromJson((data["feedback"] as Map).cast<String, dynamic>()),
      );
    } catch (e) {
      return FeedbackResult.failure("网络错误: $e");
    }
  }

  /// 拉取本人提交过的反馈（服务端按当前身份过滤）。
  Future<FeedbackResult<List<FeedbackRecord>>> listMine(
      {int limit = 50}) async {
    try {
      final Uri uri = Uri.parse("$_baseUrl/api/feedback").replace(
        queryParameters: <String, String>{
          "userId": await InstallIdentity.instance.actorId(),
          "actorId": await InstallIdentity.instance.actorId(),
          "limit": "$limit",
        },
      );
      final http.Response res =
          await _client.get(uri, headers: _headers).timeout(_timeout);
      if (res.statusCode != 200) {
        return FeedbackResult.failure("获取反馈列表失败: ${res.statusCode}");
      }
      final Map<String, dynamic> data =
          jsonDecode(res.body) as Map<String, dynamic>;
      if (data["ok"] != true) {
        return FeedbackResult.failure(
            data["error"]?.toString() ?? "获取反馈列表失败");
      }
      return FeedbackResult.success(
        (data["items"] as List<dynamic>? ?? const [])
            .map((dynamic e) =>
                FeedbackRecord.fromJson((e as Map).cast<String, dynamic>()))
            .toList(),
      );
    } catch (e) {
      return FeedbackResult.failure("网络错误: $e");
    }
  }
}
