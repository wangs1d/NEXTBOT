import "package:flutter_test/flutter_test.dart";
import "package:nextbot/core/config/api_config.dart";
import "package:nextbot/core/config/media_url.dart";

/// 云端开启周界鉴权（ACCESS_AUTH_REQUIRED=1）后，图片/音频/WebView 这类
/// 「发不出 Authorization 头」的消费方也必须能证明身份，否则表现是白屏或
/// 空图而不是报错。
///
/// 2026-11-12 定稿后的三条通道（凭证不再进子资源 URL）：
///  - 能发请求头的（Image.network / Dart http）→ `X-Nb-Actor` 头 / Bearer；
///  - WebView **页面地址** → `?userId=inst_…`（服务端落成同站 Cookie）；
///  - 其余一律不带凭证：`resolve()` 只补全地址。
/// 有 token 时页面地址也必须让位给 token，不能把邮箱写进 URL。
void main() {
  setUp(() {
    ApiConfig.runtimeUserId = null;
    ApiConfig.installIdentityProvider = () => "inst_9f8e7d6c5b4a3210";
  });

  tearDown(() {
    ApiConfig.runtimeUserId = null;
    ApiConfig.installIdentityProvider = null;
  });

  test("未登录：同源请求带设备标识头", () {
    final Map<String, String> headers =
        MediaUrl.headersFor("${ApiConfig.httpBase}/picture/assets/a.png");
    expect(headers["X-Nb-Actor"], "inst_9f8e7d6c5b4a3210");
    expect(headers.containsKey("Authorization"), isFalse);
  });

  test("未登录：只有 WebView 页面地址带 userId，子资源 URL 一律不带", () {
    expect(
      MediaUrl.pageBootstrapQuery,
      <String, String>{"userId": "inst_9f8e7d6c5b4a3210"},
    );
    // 页面地址：这一次带，服务端据此落同站 Cookie
    expect(
      MediaUrl.webViewPageUrl("/gallery-wall"),
      contains("userId=inst_9f8e7d6c5b4a3210"),
    );
    // 图片/音频字节地址：不再带任何凭证（走请求头）
    expect(
      MediaUrl.resolve("/picture/assets/a.png"),
      isNot(contains("userId=")),
    );
  });

  test("外部域名一律不给身份", () {
    expect(
      MediaUrl.headersFor("https://cdn.example.com/a.png"),
      isEmpty,
    );
    expect(
      MediaUrl.resolve("https://cdn.example.com/a.png"),
      "https://cdn.example.com/a.png",
    );
  });

  test("控制面（账号/反馈/站内信所在域名）算本站，未登录也带设备标识", () {
    // 控制面与接口面同机同鉴权；只认接口域名的话，登录态的反馈/站内信
    // 会带着邮箱被 403（自报账号不认），未登录则一律 401。
    final String controlPlane = ApiConfig.controlPlaneBase;
    final Map<String, String> headers =
        MediaUrl.headersFor("$controlPlane/api/inbox/messages");
    expect(headers["X-Nb-Actor"], "inst_9f8e7d6c5b4a3210");
  });

  test("登录态（无 token 但有邮箱）不把邮箱塞进任何 URL", () {
    ApiConfig.runtimeUserId = "me@example.com";
    expect(MediaUrl.guestActorId, isNull);
    expect(MediaUrl.pageBootstrapQuery, isEmpty);
    expect(MediaUrl.webViewPageUrl("/gallery-wall"), isNot(contains("example.com")));
    expect(MediaUrl.headersFor("${ApiConfig.httpBase}/picture/a.png"), isEmpty);
  });
}
