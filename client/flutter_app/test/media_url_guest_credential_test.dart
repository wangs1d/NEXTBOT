import "package:flutter_test/flutter_test.dart";
import "package:nextbot/core/config/api_config.dart";
import "package:nextbot/core/config/media_url.dart";

/// 云端开启周界鉴权（ACCESS_AUTH_REQUIRED=1）后，图片/音频/WebView 这类
/// 「发不出 Authorization 头」的消费方也必须能证明身份，否则表现是白屏或
/// 空图而不是报错。
///
/// 这里锁住未登录设备（guest）的两条通道：
///  - 能发请求头的（Image.network / Dart http）→ `X-Nb-Actor` 头；
///  - 只能拼 URL 的（音视频标签 / WebView）→ `?userId=inst_…`。
/// 有 token 时两者都必须让位给 token，不能把邮箱写进 URL。
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

  test("未登录：URL 通道补 userId（图片/音频/WebView 发不出头）", () {
    expect(
      MediaUrl.queryCredentials,
      <String, String>{"userId": "inst_9f8e7d6c5b4a3210"},
    );
    final String url = MediaUrl.resolve("/picture/assets/a.png");
    expect(url, contains("userId=inst_9f8e7d6c5b4a3210"));
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

  test("登录态（无 token 但有邮箱）不把邮箱塞进 URL", () {
    ApiConfig.runtimeUserId = "me@example.com";
    expect(MediaUrl.guestActorId, isNull);
    expect(MediaUrl.queryCredentials, isEmpty);
    expect(MediaUrl.headersFor("${ApiConfig.httpBase}/picture/a.png"), isEmpty);
  });
}
