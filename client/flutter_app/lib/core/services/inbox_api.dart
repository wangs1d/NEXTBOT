import "dart:convert";

import "package:http/http.dart" as http;

import "../config/api_config.dart";
import "access_auth_api.dart";
import "install_identity.dart";
import "./nb_http.dart";

/// 站内信 API 通用结果包装。
class InboxApiResult<T> {
  const InboxApiResult._({required this.ok, this.value, this.error});

  final bool ok;
  final T? value;
  final String? error;

  factory InboxApiResult.success(T value) =>
      InboxApiResult._(ok: true, value: value);
  factory InboxApiResult.failure(String error) =>
      InboxApiResult._(ok: false, error: error);
}

/// 一条站内信（服务端 InboxService 透出）。
class InboxMessageItem {
  const InboxMessageItem({
    required this.messageId,
    required this.title,
    required this.body,
    required this.kind,
    required this.importance,
    required this.createdAt,
    required this.read,
    this.fromActorId,
  });

  final String messageId;
  final String title;
  final String body;

  /// 消息分类：system / announcement / friend / ...
  final String kind;

  /// low / normal / high / critical。
  final String importance;
  final String? fromActorId;
  final DateTime? createdAt;
  final bool read;

  factory InboxMessageItem.fromJson(Map<String, dynamic> json) {
    return InboxMessageItem(
      messageId: json["messageId"]?.toString() ?? "",
      title: json["title"]?.toString() ?? "",
      body: json["body"]?.toString() ?? "",
      kind: json["kind"]?.toString() ?? "system",
      importance: json["importance"]?.toString() ?? "normal",
      fromActorId: json["fromActorId"]?.toString(),
      createdAt: DateTime.tryParse(json["createdAt"]?.toString() ?? ""),
      read: json["readAt"] != null,
    );
  }
}

/// 收件箱快照：消息列表 + 未读数。
class InboxSnapshot {
  const InboxSnapshot({
    this.messages = const <InboxMessageItem>[],
    this.unreadCount = 0,
    this.partialError,
  });

  final List<InboxMessageItem> messages;
  final int unreadCount;

  /// 部分来源拉取失败时的提示（另一来源成功，列表仍可用）。
  final String? partialError;
}

/// 单一服务器的站内信拉取（[InboxApi] 双源合并的内部构件）。
class _SingleSourceInboxApi {
  _SingleSourceInboxApi({
    required String baseUrl,
    required Future<String> Function() userIdResolver,
    required http.Client client,
  }) : _baseUrl = baseUrl,
       _userIdResolver = userIdResolver,
       _client = client;

  final String _baseUrl;
  final Future<String> Function() _userIdResolver;
  final http.Client _client;

  static const Duration _timeout = Duration(seconds: 10);

  Map<String, String> get _headers => <String, String>{
        "Content-Type": "application/json",
        ...AccessCredentialStore.instance.authHeaders,
      };

  Future<InboxApiResult<List<InboxMessageItem>>> list({int limit = 100}) async {
    try {
      final Uri uri = Uri.parse("$_baseUrl/api/inbox/messages").replace(
        queryParameters: <String, String>{
          "userId": await _userIdResolver(),
          "limit": "$limit",
        },
      );
      final http.Response res =
          await _client.get(uri, headers: _headers).timeout(_timeout);
      if (res.statusCode != 200) {
        return InboxApiResult.failure("获取站内信失败: ${res.statusCode}");
      }
      final Map<String, dynamic> data =
          jsonDecode(res.body) as Map<String, dynamic>;
      if (data["ok"] != true) {
        return InboxApiResult.failure(
            data["error"]?.toString() ?? "获取站内信失败");
      }
      final List<dynamic> raw = data["messages"] as List<dynamic>? ?? const [];
      return InboxApiResult.success(raw
          .map((dynamic e) =>
              InboxMessageItem.fromJson((e as Map).cast<String, dynamic>()))
          .toList());
    } catch (e) {
      return InboxApiResult.failure("网络错误: $e");
    }
  }

  Future<InboxApiResult<int>> markRead({List<String>? ids}) async {
    try {
      final http.Response res = await _client
          .post(
            Uri.parse("$_baseUrl/api/inbox/read"),
            headers: _headers,
            body: jsonEncode(<String, dynamic>{
              "userId": await _userIdResolver(),
              if (ids != null) "ids": ids,
            }),
          )
          .timeout(_timeout);
      final Map<String, dynamic> data =
          jsonDecode(res.body) as Map<String, dynamic>;
      if (res.statusCode != 200 || data["ok"] != true) {
        return InboxApiResult.failure(
          data["error"]?.toString() ?? "操作失败: ${res.statusCode}",
        );
      }
      return InboxApiResult.success((data["marked"] as num?)?.toInt() ?? 0);
    } catch (e) {
      return InboxApiResult.failure("网络错误: $e");
    }
  }
}

/// 站内信 API 客户端（服务端实现：server/src/routes/http/inbox.ts）。
///
/// 消息由两侧写入，客户端双源合并拉取：
/// - 控制面（[ApiConfig.controlPlaneBase]，身份 [InstallIdentity.actorId]）：
///   管理后台/运营群发的站内信落在控制面服务器上；身份与反馈一致，
///   保证后台收件人列表、反馈记录、站内信是同一个用户。
/// - 本地 runtime（[ApiConfig.httpBase]，身份 [ApiConfig.effectiveActorId]）：
///   Agent 侧写入（电话代办回执等）落在本地服务器上。
/// 开发单机形态两者同源，按 messageId 去重后与单源行为一致。
class InboxApi {
  InboxApi({
    String? controlPlaneBase,
    String? localBase,
    http.Client? client,
  })  : _control = _SingleSourceInboxApi(
          baseUrl: controlPlaneBase ?? ApiConfig.controlPlaneBase,
          userIdResolver: InstallIdentity.instance.actorId,
          client: client ?? NbClient(),
        ),
        _local = _SingleSourceInboxApi(
          baseUrl: localBase ?? ApiConfig.httpBase,
          userIdResolver: () async => ApiConfig.effectiveActorId,
          client: client ?? NbClient(),
        );

  final _SingleSourceInboxApi _control;
  final _SingleSourceInboxApi _local;

  /// 拉取收件箱（双源合并去重，按时间倒序；返回列表 + 未读数）。
  Future<InboxApiResult<InboxSnapshot>> list({int limit = 100}) async {
    final List<InboxApiResult<List<InboxMessageItem>>> results =
        await Future.wait(<Future<InboxApiResult<List<InboxMessageItem>>>>[
      _control.list(limit: limit),
      _local.list(limit: limit),
    ]);

    final List<String> errors = <String>[];
    final Map<String, InboxMessageItem> merged = <String, InboxMessageItem>{};
    for (final InboxApiResult<List<InboxMessageItem>> r in results) {
      if (r.ok && r.value != null) {
        for (final InboxMessageItem m in r.value!) {
          if (m.messageId.isEmpty) continue;
          merged[m.messageId] = m;
        }
      } else {
        errors.add(r.error ?? "未知错误");
      }
    }
    if (errors.length == results.length) {
      return InboxApiResult.failure(errors.first);
    }
    final List<InboxMessageItem> messages = merged.values.toList()
      ..sort((InboxMessageItem a, InboxMessageItem b) => (b.createdAt ??
              DateTime.now())
          .compareTo(a.createdAt ?? DateTime.now()));
    return InboxApiResult.success(InboxSnapshot(
      messages: messages,
      unreadCount: messages.where((InboxMessageItem m) => !m.read).length,
      partialError: errors.isEmpty ? null : errors.first,
    ));
  }

  /// 批量置已读；[ids] 缺省时标记全部未读。两个来源各自标记，返回合计条数。
  Future<InboxApiResult<int>> markRead({List<String>? ids}) async {
    final List<InboxApiResult<int>> results =
        await Future.wait(<Future<InboxApiResult<int>>>[
      _control.markRead(ids: ids),
      _local.markRead(ids: ids),
    ]);
    if (results.every((InboxApiResult<int> r) => !r.ok)) {
      return InboxApiResult.failure(results.first.error ?? "操作失败");
    }
    return InboxApiResult.success(results.fold<int>(
      0,
      (int sum, InboxApiResult<int> r) => sum + (r.value ?? 0),
    ));
  }

  /// 未读数（角标轮询用）：取合并列表的未读数，避免同源双计。
  Future<InboxApiResult<int>> unreadCount() async {
    final InboxApiResult<InboxSnapshot> snap = await list(limit: 500);
    if (!snap.ok) {
      return InboxApiResult.failure(snap.error ?? "获取未读数失败");
    }
    return InboxApiResult.success(snap.value?.unreadCount ?? 0);
  }
}
