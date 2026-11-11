import "dart:convert";

import "package:http/http.dart" as http;

import "../config/api_config.dart";
import "access_auth_api.dart";
import "./nb_http.dart";

/// 待确认收件箱 API 通用结果包装。
class ApprovalsResult<T> {
  const ApprovalsResult._({
    required this.ok,
    this.value,
    this.error,
  });

  final bool ok;
  final T? value;
  final String? error;

  factory ApprovalsResult.success(T value) =>
      ApprovalsResult._(ok: true, value: value);
  factory ApprovalsResult.failure(String error) =>
      ApprovalsResult._(ok: false, error: error);
}

/// 一条待确认条目（服务端 approval-inbox-service 的合并视图）。
///
/// 产品口径：只有 [spend] = true（涉及花钱）的条目需要用户点确认；
/// 其余仅展示。
class ApprovalItem {
  const ApprovalItem({
    required this.id,
    required this.source,
    required this.kind,
    required this.title,
    required this.summary,
    required this.createdAt,
    required this.spend,
    this.expiresAt,
    this.payload = const {},
  });

  final String id;

  /// 来源：proactivity（主动服务）。
  final String source;
  final String kind;
  final String title;
  final String summary;
  final DateTime? createdAt;
  final DateTime? expiresAt;

  /// 是否涉及花钱：true 时渲染「批准执行 / 拒绝」按钮。
  final bool spend;
  final Map<String, dynamic> payload;

  factory ApprovalItem.fromJson(Map<String, dynamic> json) {
    return ApprovalItem(
      id: json["id"]?.toString() ?? "",
      source: json["source"]?.toString() ?? "proactivity",
      kind: json["kind"]?.toString() ?? "",
      title: json["title"]?.toString() ?? "待确认事项",
      summary: json["summary"]?.toString() ?? "",
      createdAt: DateTime.tryParse(json["createdAt"]?.toString() ?? ""),
      expiresAt: DateTime.tryParse(json["expiresAt"]?.toString() ?? ""),
      spend: json["spend"] as bool? ?? false,
      payload:
          json["payload"] is Map ? (json["payload"] as Map).cast<String, dynamic>() : const {},
    );
  }
}

/// 一条主动动态（AgentActivityStore 台账透出，只读）。
class ApprovalActivityItem {
  const ApprovalActivityItem({
    required this.id,
    required this.kind,
    required this.category,
    required this.title,
    required this.summary,
    required this.status,
    required this.createdAt,
    this.statusLabel,
    this.read = true,
  });

  final String id;

  /// 动作类型：action.purchase / action.payment / action.schedule / ...
  final String kind;

  /// 展示分类：purchase / payment / schedule / generic。
  final String category;
  final String title;
  final String summary;

  /// pending / done / failed / changed。
  final String status;

  /// 服务端给的状态文案（配送中 / 已完成 / 已改期...），可为空。
  final String? statusLabel;
  final DateTime? createdAt;
  final bool read;

  factory ApprovalActivityItem.fromJson(Map<String, dynamic> json) {
    return ApprovalActivityItem(
      id: json["id"]?.toString() ?? "",
      kind: json["kind"]?.toString() ?? "",
      category: json["category"]?.toString() ?? "generic",
      title: json["title"]?.toString() ?? "",
      summary: json["summary"]?.toString() ?? "",
      status: json["status"]?.toString() ?? "done",
      statusLabel: json["statusLabel"]?.toString(),
      createdAt: DateTime.tryParse(
        json["createdAt"]?.toString() ?? "",
      ),
      read: json["readAt"] != null,
    );
  }
}

/// 收件箱快照：待确认 + 主动动态。
class ApprovalsSnapshot {
  const ApprovalsSnapshot({
    this.items = const <ApprovalItem>[],
    this.activity = const <ApprovalActivityItem>[],
  });

  final List<ApprovalItem> items;
  final List<ApprovalActivityItem> activity;
}

/// 待确认收件箱 API 客户端（服务端实现：server/src/routes/http/approvals.ts）。
///
/// 口径：涉及花钱的主动服务确认需要点确认；其他主动化消息只做可见性。
///  - GET  /api/approvals?userId=         快照（items + activity）
///  - POST /api/approvals/resolve         批准 / 拒绝（仅 spend 条目）
class ApprovalsApi {
  ApprovalsApi({String? baseUrl, http.Client? client})
      : _baseUrl = baseUrl ?? ApiConfig.httpBase,
        _client = client ?? NbClient();

  final String _baseUrl;
  final http.Client _client;

  static const Duration _timeout = Duration(seconds: 10);

  Map<String, String> get _headers => <String, String>{
        "Content-Type": "application/json",
        ...AccessCredentialStore.instance.authHeaders,
      };

  /// 拉取收件箱快照。
  Future<ApprovalsResult<ApprovalsSnapshot>> list() async {
    try {
      final Uri uri = Uri.parse("$_baseUrl/api/approvals").replace(
        queryParameters: <String, String>{
          "userId": ApiConfig.effectiveActorId,
        },
      );
      final http.Response res =
          await _client.get(uri, headers: _headers).timeout(_timeout);
      if (res.statusCode != 200) {
        return ApprovalsResult.failure("获取收件箱失败: ${res.statusCode}");
      }
      final Map<String, dynamic> data =
          jsonDecode(res.body) as Map<String, dynamic>;
      if (data["ok"] != true) {
        return ApprovalsResult.failure(
            data["error"]?.toString() ?? "获取收件箱失败");
      }
      final List<dynamic> rawItems = data["items"] as List<dynamic>? ?? const [];
      final List<dynamic> rawActivity =
          data["activity"] as List<dynamic>? ?? const [];
      return ApprovalsResult.success(ApprovalsSnapshot(
        items: rawItems
            .map((dynamic e) =>
                ApprovalItem.fromJson((e as Map).cast<String, dynamic>()))
            .toList(),
        activity: rawActivity
            .map((dynamic e) => ApprovalActivityItem.fromJson(
                (e as Map).cast<String, dynamic>()))
            .toList(),
      ));
    } catch (e) {
      return ApprovalsResult.failure("网络错误: $e");
    }
  }

  /// 对某条花钱类待确认做出决定。返回 ok 与服务端 detail（执行结果描述）。
  Future<ApprovalsResult<String?>> resolve({
    required ApprovalItem item,
    required bool approve,
  }) async {
    try {
      final http.Response res = await _client
          .post(
            Uri.parse("$_baseUrl/api/approvals/resolve"),
            headers: _headers,
            body: jsonEncode(<String, dynamic>{
              "userId": ApiConfig.effectiveActorId,
              "source": item.source,
              "id": item.id,
              "decision": approve ? "approve" : "decline",
            }),
          )
          .timeout(_timeout);
      final Map<String, dynamic> data =
          jsonDecode(res.body) as Map<String, dynamic>;
      if (res.statusCode != 200 || data["ok"] != true) {
        return ApprovalsResult.failure(
          data["error"]?.toString() ?? "操作失败: ${res.statusCode}",
        );
      }
      return ApprovalsResult.success(data["detail"]?.toString());
    } catch (e) {
      return ApprovalsResult.failure("网络错误: $e");
    }
  }
}
