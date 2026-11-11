import "dart:convert";

import "package:http/http.dart" as http;

import "../config/api_config.dart";
import "access_auth_api.dart";
import "./nb_http.dart";

/// 注意力（分级触达）API 通用结果包装。
class AttentionResult<T> {
  const AttentionResult._({required this.ok, this.value, this.error});

  final bool ok;
  final T? value;
  final String? error;

  factory AttentionResult.success(T value) =>
      AttentionResult._(ok: true, value: value);
  factory AttentionResult.failure(String error) =>
      AttentionResult._(ok: false, error: error);
}

/// 一次投递记录（到哪个通道、什么时候、结果如何）。
class AttentionDelivery {
  const AttentionDelivery({
    required this.channel,
    required this.at,
    this.detail,
  });

  /// chat / popup / voice / phone
  final String channel;
  final DateTime? at;
  final String? detail;

  factory AttentionDelivery.fromJson(Map<String, dynamic> json) {
    return AttentionDelivery(
      channel: json["channel"]?.toString() ?? "chat",
      at: DateTime.fromMillisecondsSinceEpoch(
        (json["at"] as num?)?.toInt() ?? 0,
      ),
      detail: json["detail"]?.toString(),
    );
  }

  /// 通道中文名。
  String get channelLabel => switch (channel) {
        "chat" => "对话",
        "popup" => "弹窗",
        "voice" => "语音",
        "phone" => "电话",
        _ => channel,
      };
}

/// 一条注意力记录（分级触达的投递/升级状态机，服务端 AttentionStore 透出）。
class AttentionRecord {
  const AttentionRecord({
    required this.id,
    required this.kind,
    required this.title,
    required this.summary,
    required this.urgency,
    required this.decision,
    required this.spend,
    required this.state,
    required this.deliveries,
    required this.createdAt,
    this.deadlineAt,
    this.confirmId,
    this.ackAt,
    this.resolvedAt,
    this.resolveNote,
  });

  final String id;
  final String kind;
  final String title;
  final String summary;

  /// interrupt / alert / normal / log
  final String urgency;

  /// confirm（需拍板）/ fyi（需知晓）/ none
  final String decision;

  /// 是否涉及花钱（confirm 决策下的批准/拒绝走 /api/approvals/resolve）。
  final bool spend;

  /// open / acked / resolved / expired
  final String state;
  final List<AttentionDelivery> deliveries;
  final DateTime? createdAt;
  final DateTime? deadlineAt;

  /// 关联的挂起确认 id（decision=confirm 时批准/拒绝用它调 resolve）。
  final String? confirmId;

  /// 用户已知悉时间（ack 归一后存在）。
  final DateTime? ackAt;

  /// 闭合时间（resolved/expired）。
  final DateTime? resolvedAt;
  final String? resolveNote;

  factory AttentionRecord.fromJson(Map<String, dynamic> json) {
    return AttentionRecord(
      id: json["id"]?.toString() ?? "",
      kind: json["kind"]?.toString() ?? "",
      title: json["title"]?.toString() ?? "",
      summary: json["summary"]?.toString() ?? "",
      urgency: json["urgency"]?.toString() ?? "normal",
      decision: json["decision"]?.toString() ?? "fyi",
      spend: json["spend"] as bool? ?? false,
      state: json["state"]?.toString() ?? "open",
      deliveries: (json["deliveries"] as List<dynamic>? ?? const [])
          .map((dynamic e) =>
              AttentionDelivery.fromJson((e as Map).cast<String, dynamic>()))
          .toList(),
      createdAt: DateTime.fromMillisecondsSinceEpoch(
        (json["createdAt"] as num?)?.toInt() ?? 0,
      ),
      deadlineAt: json["deadlineAt"] == null
          ? null
          : DateTime.fromMillisecondsSinceEpoch(
              (json["deadlineAt"] as num).toInt(),
            ),
      confirmId: json["confirmId"]?.toString(),
      ackAt: json["ackAt"] == null
          ? null
          : DateTime.fromMillisecondsSinceEpoch((json["ackAt"] as num).toInt()),
      resolvedAt: json["resolvedAt"] == null
          ? null
          : DateTime.fromMillisecondsSinceEpoch(
              (json["resolvedAt"] as num).toInt(),
            ),
      resolveNote: json["resolveNote"]?.toString(),
    );
  }

  /// 未决事项 = 还没被任何界面处理过的记录。
  bool get isPending => state == "open";

  /// 投递升级到哪一级了（对话 < 弹窗 < 语音 < 电话）。
  String get escalationLabel {
    if (deliveries.isEmpty) return "待投递";
    final last = deliveries.last;
    return "已通过${last.channelLabel}提醒${deliveries.length} 次";
  }
}

/// 决策中心快照。
class AttentionSnapshot {
  const AttentionSnapshot({
    this.pending = const <AttentionRecord>[],
    this.doneToday = const <AttentionRecord>[],
  });

  final List<AttentionRecord> pending;
  final List<AttentionRecord> doneToday;
}

/// 注意力 API 客户端（服务端实现：server/src/routes/http/attention.ts）。
class AttentionApi {
  AttentionApi({String? baseUrl, http.Client? client})
      : _baseUrl = baseUrl ?? ApiConfig.httpBase,
        _client = client ?? NbClient();

  final String _baseUrl;
  final http.Client _client;

  static const Duration _timeout = Duration(seconds: 10);

  Map<String, String> get _headers => <String, String>{
        "Content-Type": "application/json",
        ...AccessCredentialStore.instance.authHeaders,
      };

  /// 拉取决策中心快照（未决事项 + 今天已闭合）。
  Future<AttentionResult<AttentionSnapshot>> snapshot() async {
    try {
      final Uri uri = Uri.parse("$_baseUrl/api/attention").replace(
        queryParameters: <String, String>{
          "userId": ApiConfig.effectiveActorId,
        },
      );
      final http.Response res =
          await _client.get(uri, headers: _headers).timeout(_timeout);
      if (res.statusCode != 200) {
        return AttentionResult.failure("获取决策中心失败: ${res.statusCode}");
      }
      final Map<String, dynamic> data =
          jsonDecode(res.body) as Map<String, dynamic>;
      if (data["ok"] != true) {
        return AttentionResult.failure(
            data["error"]?.toString() ?? "获取决策中心失败");
      }
      return AttentionResult.success(AttentionSnapshot(
        pending: (data["pending"] as List<dynamic>? ?? const [])
            .map((dynamic e) =>
                AttentionRecord.fromJson((e as Map).cast<String, dynamic>()))
            .toList(),
        doneToday: (data["doneToday"] as List<dynamic>? ?? const [])
            .map((dynamic e) =>
                AttentionRecord.fromJson((e as Map).cast<String, dynamic>()))
            .toList(),
      ));
    } catch (e) {
      return AttentionResult.failure("网络错误: $e");
    }
  }

  /// ack 归一：告知服务端「用户已知悉」（升级计时即停）。
  Future<AttentionResult<void>> ack(String id, {String via = "inbox"}) async {
    try {
      final http.Response res = await _client
          .post(
            Uri.parse("$_baseUrl/api/attention/ack"),
            headers: _headers,
            body: jsonEncode(<String, dynamic>{
              "userId": ApiConfig.effectiveActorId,
              "id": id,
              "via": via,
            }),
          )
          .timeout(_timeout);
      if (res.statusCode != 200) {
        final Map<String, dynamic> data =
            jsonDecode(res.body) as Map<String, dynamic>;
        return AttentionResult.failure(
          data["error"]?.toString() ?? "ack 失败: ${res.statusCode}",
        );
      }
      return AttentionResult.success(null);
    } catch (e) {
      return AttentionResult.failure("网络错误: $e");
    }
  }
}
