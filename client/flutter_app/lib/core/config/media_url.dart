import "../services/access_auth_api.dart";
import "api_config.dart";

/// 媒体/页面 URL 的统一出口：相对路径 → 绝对地址。
///
/// 2026-11-12 定稿：**凭证不再进 URL**。周界鉴权（ACCESS_AUTH_REQUIRED）下每条
/// 链路按自己能力取凭证，URL 只承载业务参数：
///
/// | 消费方 | 凭证通道 |
/// |---|---|
/// | Dart 侧字节加载（CachedMediaImage / Image.network / NbHttp） | `Authorization` 头 |
/// | 音视频播放器（发不出头） | 先经 MediaDiskCache 落盘，播本地文件 |
/// | WebView 页面与其内 `<img>`/`fetch` | 页面地址带一次 `?token=` → 服务端落 HttpOnly Cookie |
///
/// 为什么非改不可：token 有 TTL、`needsRefresh` 提前 7 天续期，凭证一旦进 URL，
/// 磁盘缓存键（sha256(url)）就跟着换 → 整库媒体缓存作废（"照片又全部重下一遍"），
/// 同时 token 会写进服务端访问日志与图片 Referer。
class MediaUrl {
  MediaUrl._();

  /// [url] 可以是 `/picture/...`、`picture/...` 或绝对地址；**只补全、不带凭证**。
  /// 外部 CDN/第三方地址原样返回。
  static String resolve(String url, {Map<String, String>? query}) {
    final Uri? target = _absolute(url);
    if (target == null) return url.trim();
    final Map<String, String> merged = <String, String>{
      ...target.queryParameters,
      ...?query,
    };
    // 空 map 也要走 replace 的话，Dart 会留下一个光秃秃的 "?"，
    // 白名单外的消费方（磁盘缓存键、日志）会把它当成另一个地址。
    if (merged.isEmpty) return target.toString();
    return target.replace(queryParameters: merged).toString();
  }

  /// 语义化别名：字节消费方（走请求头鉴权）用它，读代码时一眼能看出凭证通道。
  /// 行为与 [resolve] 完全一致。
  static String resolveForHeaders(String url, {Map<String, String>? query}) =>
      resolve(url, query: query);

  /// 渲染进程内部播放专用出口：补全 + 带凭证，**仅在「既发不出请求头、又共享
  /// 不到同站 Cookie」的场景使用**（当前唯一：Windows 视频面板用
  /// `loadStringContent` 载入的 HTML，document 是 null 原点，`SameSite=Strict`
  /// 的 Cookie 不会随 `<video>` 请求发出；`SameSite=None` 又要求 Secure，
  /// http://局域网地址 上不可靠）。
  ///
  /// 除上述场景外一律用 [resolve] / [resolveForHeaders]。
  static String resolveForRenderer(String url, {Map<String, String>? query}) {
    final Uri? target = _absolute(url);
    if (target == null) return url.trim();
    final Map<String, String> merged = <String, String>{
      ...target.queryParameters,
      ...?query,
      ...pageBootstrapQuery,
    };
    if (merged.isEmpty) return target.toString();
    return target.replace(queryParameters: merged).toString();
  }

  /// WebView **页面地址**专用出口：补全 + 带上页面级凭证。
  ///
  /// 这是全客户端唯一还会把 token 放进 URL 的地方，目的只有一个：服务端在
  /// HTML 页面路径上会把它落成同站 `HttpOnly` Cookie（见 server `auth.ts`
  /// 的 `HTML_PAGE_PATHS`），之后页面内的 `<img>`、`fetch`、音视频标签都靠
  /// Cookie 认人，子资源 URL 不需要再拼任何凭证。
  ///
  /// 未登录时带 `?userId=inst_…`（服务端按 guest 放行）。
  static String webViewPageUrl(String url, {Map<String, String>? query}) {
    final Uri? target = _absolute(url);
    if (target == null) return url.trim();
    final Map<String, String> merged = <String, String>{
      ...target.queryParameters,
      ...?query,
      ...pageBootstrapQuery,
    };
    if (merged.isEmpty) return target.toString();
    return target.replace(queryParameters: merged).toString();
  }

  /// 相对地址补全为绝对地址；外部域名/data:/file: 等一律返回 null（调用方原样用）。
  static Uri? _absolute(String url) {
    final String raw = url.trim();
    if (raw.isEmpty) return null;
    final Uri? parsed = Uri.tryParse(raw);
    if (parsed == null) return null;

    final bool isHttp =
        parsed.scheme == "http" || parsed.scheme == "https";
    if (isHttp) {
      return _isSameOrigin(parsed) ? parsed : null;
    }
    if (parsed.hasScheme) return null; // data: / file: / 其它协议不掺东西
    final Uri base = Uri.parse(ApiConfig.httpBase);
    final String rel =
        parsed.path.startsWith("/") ? parsed.path.substring(1) : parsed.path;
    // 相对地址自带的 query（如缩略图档位 `?w=400`、travel 代理的 `?u=`）
    // 必须跟着走：只 replace(path) 会把它整条丢掉，拼出来的地址变成另一张图。
    return base.replace(
      path: "/$rel",
      queryParameters:
          parsed.queryParameters.isEmpty ? null : parsed.queryParameters,
    );
  }

  /// 页面地址要拼的凭证（只给 [webViewPageUrl] 用）。
  ///
  ///  - 有 token → `?token=`（服务端换成同站 HttpOnly Cookie）；
  ///  - 未登录 → `?userId=inst_…`，服务端按 guest 放行。强制鉴权下页面若什么都
  ///    不带会直接 401，表现是「白屏」而不是报错。
  static Map<String, String> get pageBootstrapQuery {
    final Map<String, String> tokenQuery =
        AccessCredentialStore.instance.accessTokenQuery;
    if (tokenQuery.isNotEmpty) return tokenQuery;
    final String? guest = guestActorId;
    return guest == null
        ? const <String, String>{}
        : <String, String>{"userId": guest};
  }

  /// 未登录设备的有效身份（`inst_…` / `guest_…`）；已登录或尚未生成安装标识时返回 null。
  ///
  /// 只认「非账号形态」的值：登录态若丢了 token，把邮箱当地址参数带出去既
  /// 证明不了身份（服务端 403），又会把邮箱写进访问日志。
  static String? get guestActorId {
    if (AccessCredentialStore.instance.hasCredentials) return null;
    final String actor = ApiConfig.effectiveActorId.trim();
    if (actor.isEmpty || actor.contains("@")) return null;
    return actor;
  }

  /// 该地址是否属于本服务（接口面 [ApiConfig.httpBase] 或控制面
  /// [ApiConfig.controlPlaneBase]）。
  ///
  /// 两个域名指向同一台服务、同一套周界鉴权：控制面放的是账号/反馈/站内信，
  /// 只认接口域名的话登录态的反馈与站内信会带着邮箱被 403（自报账号不认）。
  /// 其余第三方域名一律不给凭证。
  static bool _isSameOrigin(Uri uri) => _matchesBase(uri, ApiConfig.httpBase) ||
      _matchesBase(uri, ApiConfig.controlPlaneBase);

  static bool _matchesBase(Uri uri, String base) {
    final Uri parsed = Uri.parse(base);
    return uri.scheme == parsed.scheme &&
        uri.host == parsed.host &&
        uri.port == parsed.port;
  }

  /// 该地址是否指向本服务（外部 CDN 一律不给凭证）。
  static bool isOwnOrigin(String url) {
    final Uri? uri = Uri.tryParse(url.trim());
    if (uri == null) return false;
    if (uri.scheme != "http" && uri.scheme != "https") return false;
    return _isSameOrigin(uri);
  }

  /// 能发请求头的消费方（Dart http、`Image.network`）用 Bearer 头即可，
  /// 凭证不进 URL → 磁盘缓存键不随 token 变化，也不会被写进访问日志。
  ///
  /// 未登录时退化为设备标识头（`X-Nb-Actor`）：服务端按 guest 放行，既能看
  /// 图/听音频，又拿不到任何账号数据。
  static Map<String, String> headersFor(String url) {
    if (!isOwnOrigin(url)) return const <String, String>{};
    final Map<String, String> auth = AccessCredentialStore.instance.authHeaders;
    if (auth.isNotEmpty) return auth;
    final String? guest = guestActorId;
    return guest == null ? const <String, String>{} : <String, String>{"X-Nb-Actor": guest};
  }
}
