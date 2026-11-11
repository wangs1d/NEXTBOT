import "dart:convert";

import "package:http/http.dart" as http;

import "../config/media_url.dart";
import "access_auth_api.dart";

/// 访问本服务的 HTTP 出口：自动附带本机设备凭据（Bearer token）。
///
/// 云端开启周界鉴权（ACCESS_AUTH_REQUIRED=1）后，未带凭证的请求一律 401，
/// 表现是「面板空白/列表拉不到」而不是明确报错，所以凭证必须在这一处收口。
/// 只对本服务同源地址附加（[MediaUrl.isOwnOrigin]）——第三方域名拿不到 token。
///
/// 另外在 401 时做一次**静默续期重试**：token 有 TTL，过期当天如果只靠
/// 「下次登录」补救，用户会看到一片 401 而不是无感的续期。续期并发去重，
/// 避免十几个面板同时 401 各刷一次、互相把对方的新 token 顶掉。
class NbHttp {
  NbHttp._();

  /// 进行中的续期（并发 401 共用同一次，防互相顶掉）。
  static Future<bool>? _refreshing;

  /// 该地址应附带的凭证头（非本服务地址返回空 map）。
  static Map<String, String> headersFor(Uri uri) =>
      MediaUrl.headersFor(uri.toString());

  static Map<String, String> _merge(
    Uri uri,
    Map<String, String>? extra,
  ) =>
      <String, String>{...headersFor(uri), ...?extra};

  /// 续期一次（并发去重）。返回是否拿到了新凭据。
  ///
  /// 公开是因为 [NbClient] 也要用：它是 Client 层的出口，401 时需要同一套
  /// 去重逻辑，否则面板并发多个请求会各刷一次、互相把新 token 顶掉。
  static Future<bool> ensureRefreshed() => _refreshOnce();

  /// 401 时续期一次再重试；仍失败就把原始响应交回去（调用方照常报错）。
  static Future<http.Response> _send(
    Uri uri,
    Future<http.Response> Function(Map<String, String> headers) run,
    Map<String, String>? extra,
  ) async {
    final http.Response first = await run(_merge(uri, extra));
    if (first.statusCode != 401) return first;
    if (!MediaUrl.isOwnOrigin(uri.toString())) return first;
    final bool refreshed = await _refreshOnce();
    if (!refreshed) return first;
    // 重试时用新 token 重新取头；extra 保持不变（调用方的 Content-Type 等）。
    return run(_merge(uri, extra));
  }

  /// 续期一次（并发去重）。返回是否拿到了新凭据。
  static Future<bool> _refreshOnce() {
    final Future<bool>? inflight = _refreshing;
    if (inflight != null) return inflight;
    final Future<bool> task = () async {
      try {
        final AccessAuthResult<bool> r = await AccessAuthApi().refresh();
        return r.ok;
      } catch (_) {
        return false;
      } finally {
        _refreshing = null;
      }
    }();
    _refreshing = task;
    return task;
  }

  static Future<http.Response> get(
    Uri url, {
    Map<String, String>? headers,
  }) =>
      _send(url, (h) => http.get(url, headers: h), headers);

  static Future<http.Response> post(
    Uri url, {
    Map<String, String>? headers,
    Object? body,
    Encoding? encoding,
  }) =>
      _send(
        url,
        (h) => http.post(url, headers: h, body: body, encoding: encoding),
        headers,
      );

  static Future<http.Response> put(
    Uri url, {
    Map<String, String>? headers,
    Object? body,
    Encoding? encoding,
  }) =>
      _send(
        url,
        (h) => http.put(url, headers: h, body: body, encoding: encoding),
        headers,
      );

  static Future<http.Response> patch(
    Uri url, {
    Map<String, String>? headers,
    Object? body,
    Encoding? encoding,
  }) =>
      _send(
        url,
        (h) => http.patch(url, headers: h, body: body, encoding: encoding),
        headers,
      );

  static Future<http.Response> delete(
    Uri url, {
    Map<String, String>? headers,
    Object? body,
    Encoding? encoding,
  }) =>
      _send(
        url,
        (h) => http.delete(url, headers: h, body: body, encoding: encoding),
        headers,
      );
}

/// 带本机凭据的 `http.Client` 包装。
///
/// 为什么要有它：仓库里有 38 处 `http.Client()` 散落在各 API 客户端里，逐个改
/// 调用点既容易漏、也会在下次新增客户端时重新漏掉。把「附加凭证 + 401 续期」
/// 沉到 Client 层后，只要把 `http.Client()` 换成 `NbClient()`，所有既有调用点
/// （`_client.get(...)` / `_client.post(...)`）自动带上凭据。
///
/// 只对本服务同源地址生效（[MediaUrl.isOwnOrigin]）：访问 GitHub 查更新、
/// 访问用户自填的模型 API 时不会把设备凭据送出去。
class NbClient extends http.BaseClient {
  NbClient([http.Client? inner]) : _inner = inner ?? http.Client();

  final http.Client _inner;

  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) async {
    final bool own = MediaUrl.isOwnOrigin(request.url.toString());
    if (!own) return _inner.send(request);

    _applyCredential(request);

    // 可重放副本：401 续期后要重发一次。只有缓冲型 Request 能复制，
    // 流式上传（MultipartRequest/StreamedRequest）不复制——它们的 body 已消费，
    // 重发会变成空体，比返回 401 更糟。
    http.Request? replay;
    if (request is http.Request) {
      replay = http.Request(request.method, request.url)
        ..headers.addAll(request.headers)
        ..bodyBytes = request.bodyBytes
        ..encoding = request.encoding;
    }

    final http.StreamedResponse res = await _inner.send(request);
    if (res.statusCode != 401 || replay == null) return res;

    final bool refreshed = await NbHttp.ensureRefreshed();
    if (!refreshed) return res;
    replay.headers.remove("authorization");
    _applyCredential(replay);
    return _inner.send(replay);
  }

  /// 把本机凭据写进请求头。
  ///
  /// 凭据一律以本机存储为准（覆盖调用方可能手写的旧 token）：续期后旧值就是
  /// 废的，留着会让请求继续 401。Content-Type 之类非凭证头不动。
  static void _applyCredential(http.BaseRequest request) {
    final Map<String, String> creds = MediaUrl.headersFor(request.url.toString());
    creds.forEach((String k, String v) {
      final String lower = k.toLowerCase();
      request.headers.removeWhere((String existing, _) => existing.toLowerCase() == lower);
      request.headers[k] = v;
    });
  }

  @override
  void close() => _inner.close();
}
