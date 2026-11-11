import "dart:async";
import "dart:convert";

import "package:http/http.dart" as http;
import "./nb_http.dart";

/// 日程 API 调用结果（区分网络故障与业务错误）。
class ScheduleApiResult<T> {
  const ScheduleApiResult._({
    required this.ok,
    this.value,
    this.error,
    this.networkError = false,
  });

  final bool ok;
  final T? value;
  final String? error;
  final bool networkError;

  factory ScheduleApiResult.success(T value) =>
      ScheduleApiResult._(ok: true, value: value);

  factory ScheduleApiResult.failure(String error, {bool networkError = false}) =>
      ScheduleApiResult._(ok: false, error: error, networkError: networkError);
}

/// 服务端日程任务 API（`GET/DELETE/PATCH /schedule/tasks`）。
class ScheduleApiClient {
  ScheduleApiClient({required this.baseUrl, http.Client? client})
      : _client = client ?? NbClient();

  final String baseUrl;
  final http.Client _client;

  static const Duration _timeout = Duration(seconds: 15);

  Uri _uri(String path, [Map<String, String>? query]) {
    final Uri root = Uri.parse(baseUrl);
    final String rel = path.startsWith("/") ? path.substring(1) : path;
    final Uri u = root.resolve(rel);
    return query == null ? u : u.replace(queryParameters: query);
  }

  /// 探测主服务是否可达（`GET /schedule`）。
  Future<bool> isReachable() async {
    try {
      final http.Response r = await _client
          .get(_uri("/schedule"))
          .timeout(_timeout);
      return r.statusCode >= 200 && r.statusCode < 300;
    } catch (_) {
      return false;
    }
  }

  Future<ScheduleApiResult<List<Map<String, dynamic>>>> listScheduleTasksResult(
    String sessionId, {
    DateTime? from,
    DateTime? to,
  }) async {
    final DateTime rangeFrom =
        from ?? DateTime.now().subtract(const Duration(days: 2));
    final DateTime rangeTo =
        to ?? DateTime.now().add(const Duration(days: 120));
    try {
      final http.Response r = await _client
          .get(
            _uri("/schedule/tasks", <String, String>{
              "sessionId": sessionId,
              "from": rangeFrom.toUtc().toIso8601String(),
              "to": rangeTo.toUtc().toIso8601String(),
            }),
          )
          .timeout(_timeout);
      final Map<String, dynamic>? body = _tryDecodeBody(r);
      if (r.statusCode < 200 || r.statusCode >= 300) {
        return ScheduleApiResult.failure(
          _errorMessage(body, r.statusCode, "拉取日程失败"),
        );
      }
      if (body == null || body["ok"] != true) {
        return ScheduleApiResult.failure("拉取日程失败");
      }
      final List<dynamic>? raw = body["tasks"] as List<dynamic>?;
      final List<Map<String, dynamic>> out = <Map<String, dynamic>>[];
      for (final Object? item in raw ?? <dynamic>[]) {
        if (item is! Map) continue;
        final Map<String, dynamic> t = item.cast<String, dynamic>();
        final String status = t["status"]?.toString() ?? "active";
        if (status == "cancelled") continue;
        final String? when = t["runAt"]?.toString();
        if (when == null || when.isEmpty) continue;
        out.add(t);
      }
      return ScheduleApiResult.success(out);
    } catch (e) {
      return _networkFailureList(e);
    }
  }

  Future<List<Map<String, dynamic>>> listScheduleTasks(
    String sessionId, {
    DateTime? from,
    DateTime? to,
  }) async {
    final ScheduleApiResult<List<Map<String, dynamic>>> r =
        await listScheduleTasksResult(sessionId, from: from, to: to);
    return r.ok ? (r.value ?? <Map<String, dynamic>>[]) : <Map<String, dynamic>>[];
  }

  /// 删除或取消日程：优先 `PATCH cancelled`（兼容未注册 DELETE 的旧进程），再尝试 `DELETE`。
  Future<ScheduleApiResult<void>> deleteScheduleTask(String taskId) async {
    final String id = taskId.trim();
    if (id.isEmpty) {
      return ScheduleApiResult.failure("任务 id 无效");
    }
    final String encoded = Uri.encodeComponent(id);

    final ScheduleApiResult<void> cancelResult = await _cancelScheduleTask(encoded);
    if (cancelResult.ok) {
      return cancelResult;
    }

    try {
      final http.Response deleteResp = await _client
          .delete(_uri("/schedule/tasks/$encoded"))
          .timeout(_timeout);
      final Map<String, dynamic>? deleteBody = _tryDecodeBody(deleteResp);

      if (deleteResp.statusCode >= 200 && deleteResp.statusCode < 300) {
        if (deleteBody == null || deleteBody["ok"] == true) {
          return ScheduleApiResult.success(null);
        }
        return ScheduleApiResult.failure(
          _errorMessage(deleteBody, deleteResp.statusCode, "删除失败"),
        );
      }

      if (_isTaskNotFound(deleteResp.statusCode, deleteBody)) {
        return ScheduleApiResult.success(null);
      }

      return cancelResult.networkError
          ? cancelResult
          : ScheduleApiResult.failure(
              _errorMessage(deleteBody, deleteResp.statusCode, "删除失败"),
            );
    } catch (e) {
      if (cancelResult.networkError) {
        return cancelResult;
      }
      return _networkFailure(e);
    }
  }

  Future<ScheduleApiResult<void>> _cancelScheduleTask(String encodedTaskId) async {
    try {
      final http.Response r = await _client
          .patch(
            _uri("/schedule/tasks/$encodedTaskId"),
            headers: <String, String>{"Content-Type": "application/json"},
            body: jsonEncode(<String, String>{"status": "cancelled"}),
          )
          .timeout(_timeout);
      final Map<String, dynamic>? body = _tryDecodeBody(r);
      if (r.statusCode >= 200 && r.statusCode < 300 && (body == null || body["ok"] == true)) {
        return ScheduleApiResult.success(null);
      }
      if (_isTaskNotFound(r.statusCode, body)) {
        return ScheduleApiResult.success(null);
      }
      if (r.statusCode == 404 || r.statusCode == 405) {
        return ScheduleApiResult.failure(
          _errorMessage(body, r.statusCode, "取消日程失败"),
        );
      }
      return ScheduleApiResult.failure(
        _errorMessage(body, r.statusCode, "取消日程失败"),
      );
    } catch (e) {
      return _networkFailure(e);
    }
  }

  ScheduleApiResult<List<Map<String, dynamic>>> _networkFailureList(Object e) {
    if (!_looksLikeNetworkError(e)) {
      return ScheduleApiResult.failure(e.toString());
    }
    return ScheduleApiResult.failure(_networkHint(), networkError: true);
  }

  ScheduleApiResult<void> _networkFailure(Object e) {
    if (!_looksLikeNetworkError(e)) {
      return ScheduleApiResult.failure(e.toString());
    }
    return ScheduleApiResult.failure(_networkHint(), networkError: true);
  }

  bool _looksLikeNetworkError(Object e) {
    if (e is TimeoutException) return true;
    final String m = e.toString().toLowerCase();
    return m.contains("failed to fetch") ||
        m.contains("connection refused") ||
        m.contains("network is unreachable") ||
        m.contains("socketexception") ||
        m.contains("clientexception") ||
        m.contains("xhr error");
  }

  String _networkHint() {
    return "无法连接主服务 $baseUrl（Web 端请确认后端已启动且使用 localhost:3000，勿混用 127.0.0.1）";
  }

  Map<String, dynamic>? _tryDecodeBody(http.Response r) {
    if (r.bodyBytes.isEmpty) return null;
    try {
      final Object? data = jsonDecode(utf8.decode(r.bodyBytes));
      if (data is Map<String, dynamic>) return data;
      if (data is Map) return data.cast<String, dynamic>();
    } catch (_) {
      return null;
    }
    return null;
  }

  bool _isTaskNotFound(int statusCode, Map<String, dynamic>? body) {
    final String msg = (body?["message"] ?? body?["error"] ?? "").toString();
    if (msg.contains("任务不存在")) return true;
    if (statusCode == 404 && msg.contains("Route ")) return false;
    if (statusCode == 404 && msg.toLowerCase().contains("not found")) {
      return !msg.contains("Route ");
    }
    return statusCode == 400 && msg.contains("任务不存在");
  }

  String _errorMessage(
    Map<String, dynamic>? body,
    int statusCode,
    String fallback,
  ) {
    final String? msg = body?["message"]?.toString();
    if (msg != null && msg.isNotEmpty) return msg;
    final Object? err = body?["error"];
    if (err is String && err.isNotEmpty) return err;
    return "$fallback（HTTP $statusCode）";
  }

  @Deprecated("Use listScheduleTasks")
  Future<List<Map<String, dynamic>>> listReminderTasks(String sessionId) {
    return listScheduleTasks(sessionId);
  }
}
