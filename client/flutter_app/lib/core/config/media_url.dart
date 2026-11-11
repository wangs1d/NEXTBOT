import "../services/access_auth_api.dart";
import "api_config.dart";

/// 媒体/页面 URL 的统一出口：相对路径 → 绝对地址，并补上本机设备凭证。
///
/// 云端一旦开启周界鉴权（ACCESS_AUTH_REQUIRED=1），`<img>` 之外的音频/视频标签
/// 与 WebView 页面地址都发不出 `Authorization` 头，凭证只能进 query（服务端
/// `?token=` 与 Bearer 两个通道同等认）。服务端只存 token 哈希、永不回吐明文，
/// 所以这一步必须在客户端做，且收口在一处——漏掉的表现是素材 404 而不是报错。
class MediaUrl {
  MediaUrl._();

  /// [url] 可以是 `/picture/...`、`picture/...` 或绝对地址。
  /// 只有指向本服务的 URL 才带凭证；外部 CDN/第三方地址原样返回，
  /// 免得把设备 token 送给别人的域名。
  static String resolve(String url, {Map<String, String>? query}) {
    final String raw = url.trim();
    if (raw.isEmpty) return raw;
    final Uri? parsed = Uri.tryParse(raw);
    if (parsed == null) return raw;

    final bool isHttp =
        parsed.scheme == "http" || parsed.scheme == "https";
    Uri target;
    if (isHttp) {
      if (!_isSameOrigin(parsed)) return raw;
      target = parsed;
    } else if (!parsed.hasScheme) {
      final Uri base = Uri.parse(ApiConfig.httpBase);
      final String rel = parsed.path.startsWith("/")
          ? parsed.path.substring(1)
          : parsed.path;
      target = base.replace(path: "/$rel");
    } else {
      return raw; // data: / file: / 其它协议不掺凭证
    }

    final Map<String, String> merged = <String, String>{
      ...parsed.queryParameters,
      ...?query,
      ...queryCredentials,
    };
    // 空 map 也要走 replace 的话，Dart 会留下一个光秃秃的 "?"，
    // 白名单外的消费方（磁盘缓存键、日志）会把它当成另一个地址。
    if (merged.isEmpty) return target.toString();
    return target.replace(queryParameters: merged).toString();
  }

  /// 无法发请求头的消费方（WebView 页面、音视频标签）要拼进 URL 的凭证。
  ///
  ///  - 有 token → `?token=`（服务端 extractToken 两个通道同等认）；
  ///  - 未登录 → `?userId=inst_…`，服务端按 guest 放行。云端强制鉴权下若什么
  ///    都不带，页面/音频会直接 401，表现是「白屏」而不是报错。
  static Map<String, String> get queryCredentials {
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
