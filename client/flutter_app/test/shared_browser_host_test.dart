import "package:flutter_test/flutter_test.dart";

import "package:nextbot/core/services/shared_browser_host.dart";

void main() {
  group("SharedBrowserHost.resolveInputToUrl", () {
    test("完整 http/https URL 原样返回", () {
      expect(
        SharedBrowserHost.resolveInputToUrl("https://example.com/a?b=1"),
        "https://example.com/a?b=1",
      );
      expect(
        SharedBrowserHost.resolveInputToUrl("http://localhost:3000/ws"),
        "http://localhost:3000/ws",
      );
    });

    test("无 scheme 的域名补 https", () {
      expect(
        SharedBrowserHost.resolveInputToUrl("example.com"),
        "https://example.com",
      );
      expect(
        SharedBrowserHost.resolveInputToUrl("github.com/user/repo"),
        "https://github.com/user/repo",
      );
      expect(
        SharedBrowserHost.resolveInputToUrl("localhost:8080"),
        "http://localhost:8080",
      );
    });

    test("搜索词返回 null", () {
      expect(SharedBrowserHost.resolveInputToUrl("今天天气怎么样"), isNull);
      expect(SharedBrowserHost.resolveInputToUrl("how to learn flutter"), isNull);
      expect(SharedBrowserHost.resolveInputToUrl(""), isNull);
      expect(SharedBrowserHost.resolveInputToUrl("  "), isNull);
    });

    test("带空格的内容不视为 URL", () {
      expect(SharedBrowserHost.resolveInputToUrl("example.com 关于我们"), isNull);
    });
  });

  group("SharedBrowserHost.searchUrlFor", () {
    test("生成 Bing 中文搜索链接并对查询做 URL 编码", () {
      final String url = SharedBrowserHost.searchUrlFor("私有 Agent 浏览器");
      expect(url, startsWith("https://cn.bing.com/search?q="));
      expect(
        Uri.decodeQueryComponent(url.split("q=").last),
        "私有 Agent 浏览器",
      );
    });
  });
}
