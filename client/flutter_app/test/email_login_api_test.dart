import "dart:convert";

import "package:flutter_test/flutter_test.dart";
import "package:http/http.dart" as http;
import "package:http/testing.dart";
import "package:nextbot/core/services/email_login_api.dart";

/// utf8 响应构造：http.Response(String) 默认 latin1，中文会炸；
/// 生产客户端走 utf8.decode(bodyBytes)，这里对齐构造方式。
http.Response _json(Object body, int status) =>
    http.Response.bytes(utf8.encode(jsonEncode(body)), status);

void main() {
  test("startOtp：200 ok 返回重发秒数", () async {
    final EmailLoginApi api = EmailLoginApi(
      client: MockClient((http.Request req) async {
        expect(req.url.path, "/accounts/email/otp/start");
        expect(jsonDecode(req.body)["email"], "a@b.com");
        return _json(<String, dynamic>{"ok": true, "resendAfterSeconds": 60}, 200);
      }),
    );
    final EmailLoginResult r = await api.startOtp("A@B.com");
    expect(r.ok, isTrue);
    expect(r.retryAfterSeconds, 60);
    expect(r.otpChannelDisabled, isFalse);
  });

  test("startOtp：503 = OTP 闸关闭（可免码直登）", () async {
    final EmailLoginApi api = EmailLoginApi(
      client: MockClient((_) async => _json(
            <String, dynamic>{"ok": false, "message": "邮件验证通道未开启"},
            503,
          )),
    );
    final EmailLoginResult r = await api.startOtp("a@b.com");
    expect(r.ok, isFalse);
    expect(r.otpChannelDisabled, isTrue);
  });

  test("startOtp：429 透传限频秒数与文案", () async {
    final EmailLoginApi api = EmailLoginApi(
      client: MockClient((_) async => _json(
            <String, dynamic>{
              "ok": false, "message": "验证码发送过于频繁，请稍后再试",
              "retryAfterSeconds": 37,
            },
            429,
          )),
    );
    final EmailLoginResult r = await api.startOtp("a@b.com");
    expect(r.retryAfterSeconds, 37);
    expect(r.error, contains("频繁"));
  });

  test("registerOrLogin：新号 200 ok", () async {
    final EmailLoginApi api = EmailLoginApi(
      client: MockClient((http.Request req) async {
        final Map<String, dynamic> body =
            jsonDecode(req.body) as Map<String, dynamic>;
        expect(body["userId"], "a@b.com");
        expect(body["otpCode"], "123456");
        expect(body["displayName"], "a");
        return _json(<String, dynamic>{"ok": true}, 200);
      }),
    );
    final EmailLoginResult r =
        await api.registerOrLogin("a@b.com", code: "123456");
    expect(r.ok, isTrue);
  });

  test("registerOrLogin：已存在按登录成功（幂等，与桌面端同语义）", () async {
    final EmailLoginApi api = EmailLoginApi(
      client: MockClient((_) async => _json(
            <String, dynamic>{
              "ok": false, "message": "该用户已存在 Agent 账号，无需重复注册",
            },
            400,
          )),
    );
    final EmailLoginResult r = await api.registerOrLogin("a@b.com");
    expect(r.ok, isTrue);
  });

  test("registerOrLogin：白名单拦截文案透传", () async {
    final EmailLoginApi api = EmailLoginApi(
      client: MockClient((_) async => _json(
            <String, dynamic>{
              "ok": false, "message": "内测期间暂未开放注册：可申请加入候补名单",
            },
            403,
          )),
    );
    final EmailLoginResult r = await api.registerOrLogin("a@b.com");
    expect(r.ok, isFalse);
    expect(r.error, contains("候补"));
  });
}
