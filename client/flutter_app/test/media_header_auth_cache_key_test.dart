import "package:flutter_test/flutter_test.dart";
import "package:nextbot/core/config/api_config.dart";
import "package:nextbot/core/config/media_url.dart";
import "package:nextbot/features/chat/media_disk_cache.dart";

/// 2026-11-12 根修：**凭证进 URL 会让磁盘缓存整库失效**。
///
/// token 有 TTL，`AccessCredentialStore.needsRefresh` 每轮续期都会换新值；
/// 只要缓存键里含 `?token=`，换 token 就等于"所有历史照片重新下载一遍"。
/// 三条防线：
///  1. `resolve` / `resolveForHeaders`：字节消费方只补全地址、不带凭证，
///     鉴权走 Authorization 头；
///  2. `webViewPageUrl`：唯一会带凭证的出口（页面地址 → 服务端落同站 Cookie）；
///  3. `MediaDiskCache.keyFor`：键归一，剔除易变凭证参数——即便某条链路漏了，
///     同一张图在 token 轮换前后仍命中同一个缓存文件。
void main() {
  setUp(() {
    ApiConfig.runtimeUserId = null;
    ApiConfig.installIdentityProvider = () => "inst_9f8e7d6c5b4a3210";
  });

  tearDown(() {
    ApiConfig.runtimeUserId = null;
    ApiConfig.installIdentityProvider = null;
  });

  group("resolveForHeaders", () {
    test("图片地址不带任何凭证（凭证交给请求头）", () {
      expect(MediaUrl.pageBootstrapQuery, isNotEmpty);
      for (final String u in <String>[
        MediaUrl.resolve("/agent/images/a/1.png"),
        MediaUrl.resolveForHeaders("/agent/images/a/1.png"),
      ]) {
        expect(u, isNot(contains("userId=")));
        expect(u, isNot(contains("token=")));
        expect(u, "${ApiConfig.httpBase}/agent/images/a/1.png");
      }
    });

    test("WebView 页面地址是唯一带凭证的出口（供服务端落 Cookie）", () {
      expect(
        MediaUrl.webViewPageUrl("/gallery-wall", query: <String, String>{"host": "1"}),
        contains("userId=inst_9f8e7d6c5b4a3210"),
      );
    });

    test("相对路径补全 + 已有 query 参数原样保留", () {
      expect(
        MediaUrl.resolveForHeaders("/agent/images/a/1.png?w=400"),
        "${ApiConfig.httpBase}/agent/images/a/1.png?w=400",
      );
      expect(
        MediaUrl.resolveForHeaders("/agent/images/a/1.png", query: <String, String>{"w": "640"}),
        "${ApiConfig.httpBase}/agent/images/a/1.png?w=640",
      );
    });

    test("外部域名原样返回，不掺任何身份", () {
      const String cdn = "https://cdn.example.com/a.png?x=1";
      expect(MediaUrl.resolveForHeaders(cdn), cdn);
    });

    test("data:/file: 等非 http 协议原样返回", () {
      const String dataUri = "data:image/png;base64,AAAA";
      expect(MediaUrl.resolveForHeaders(dataUri), dataUri);
    });
  });

  group("MediaDiskCache.keyFor 键归一", () {
    final MediaDiskCache cache = MediaDiskCache.instance;
    const String base = "http://127.0.0.1:3000/agent/images/me/1.png";

    test("token 轮换前后是同一个缓存键", () {
      expect(
        cache.keyFor("$base?token=old-token"),
        cache.keyFor("$base?token=new-token"),
      );
    });

    test("业务参数（宽度档）仍然是不同的缓存键", () {
      expect(cache.keyFor("$base?w=400"), isNot(cache.keyFor("$base?w=640")));
      // 业务参数保留、只剔凭证
      expect(cache.keyFor("$base?w=400&token=t1"), cache.keyFor("$base?w=400"));
    });

    test("去掉凭证后不留光秃秃的 ?", () {
      expect(cache.keyFor("$base?token=t1"), cache.keyFor(base));
    });

    test("漏网之鱼也命中同一桶：resolve 与 resolveForHeaders 的地址同键", () {
      final String withCreds = MediaUrl.resolve("/agent/images/me/1.png");
      final String headerOnly = MediaUrl.resolveForHeaders("/agent/images/me/1.png");
      expect(cache.keyFor(withCreds), cache.keyFor(headerOnly));
    });
  });
}
