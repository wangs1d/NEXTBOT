import "dart:convert";

import "package:http/http.dart" as http;

import "../config/media_url.dart";

/// 访问本服务的 HTTP 出口：自动附带本机设备凭据（Bearer token）。
///
/// 云端开启周界鉴权（ACCESS_AUTH_REQUIRED=1）后，未带凭证的请求一律 401，
/// 表现是「面板空白/列表拉不到」而不是明确报错，所以凭证必须在这一处收口。
/// 只对本服务同源地址附加（[MediaUrl.isOwnOrigin]）——第三方域名拿不到 token。
class NbHttp {
  NbHttp._();

  /// 该地址应附带的凭证头（非本服务地址返回空 map）。
  static Map<String, String> headersFor(Uri uri) =>
      MediaUrl.headersFor(uri.toString());

  static Map<String, String> _merge(
    Uri uri,
    Map<String, String>? extra,
  ) =>
      <String, String>{...headersFor(uri), ...?extra};

  static Future<http.Response> get(
    Uri url, {
    Map<String, String>? headers,
  }) =>
      http.get(url, headers: _merge(url, headers));

  static Future<http.Response> post(
    Uri url, {
    Map<String, String>? headers,
    Object? body,
    Encoding? encoding,
  }) =>
      http.post(url, headers: _merge(url, headers), body: body, encoding: encoding);

  static Future<http.Response> put(
    Uri url, {
    Map<String, String>? headers,
    Object? body,
    Encoding? encoding,
  }) =>
      http.put(url, headers: _merge(url, headers), body: body, encoding: encoding);

  static Future<http.Response> patch(
    Uri url, {
    Map<String, String>? headers,
    Object? body,
    Encoding? encoding,
  }) =>
      http.patch(url, headers: _merge(url, headers), body: body, encoding: encoding);

  static Future<http.Response> delete(
    Uri url, {
    Map<String, String>? headers,
    Object? body,
    Encoding? encoding,
  }) =>
      http.delete(url, headers: _merge(url, headers), body: body, encoding: encoding);
}
