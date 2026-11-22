import "package:flutter_test/flutter_test.dart";
import "package:nextbot/features/chat/shopping/platform_login_webview_page.dart";

/// App 内 WebView 登录回传的解析口（2026-11-22）。
///
/// 这条链最脆的一环是「把浏览器 Cookie 头还原成结构化 Cookie」：名字切错、
/// 值里的 `=` 被吃掉、重复项覆盖，都会让服务端的登录标记校验判成「没登进去」，
/// 用户看到的就是「明明登录了还说我没登录」。
void main() {
  test("标准 Cookie 头 → 结构化列表，值里的 = 保留", () {
    final List<Map<String, String>> jar = parseCookieHeaderToJar(
      "PDDUserID=U1; api_uid=abc=def; pdd_vds=v",
      "mobile.yangkeduo.com",
    );
    expect(jar.length, 3);
    expect(jar[0]["name"], "PDDUserID");
    expect(jar[0]["value"], "U1");
    expect(jar[1]["value"], "abc=def");
    expect(jar[0]["domain"], "mobile.yangkeduo.com");
  });

  test("空串 / 无等号项 / 重复名 → 丢掉，不炸", () {
    final List<Map<String, String>> jar = parseCookieHeaderToJar(
      " ; junk ; a=1; a=2; b=",
      "",
    );
    expect(jar.map((Map<String, String> c) => c["name"]).toList(), <String>["a", "b"]);
    expect(jar.first["value"], "1");
  });

  test("有登录页映射的平台才给「App 内登录」入口", () {
    expect(kPlatformWebLoginUrls.containsKey("pdd"), isTrue);
    expect(kPlatformWebLoginUrls["pdd"], contains("yangkeduo.com"));
    expect(kPlatformWebLoginUrls.containsKey("jd"), isTrue);
    expect(kPlatformWebLoginUrls.containsKey("taobao"), isTrue);
  });
}
