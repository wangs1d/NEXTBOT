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

  test("register：新号 200 ok，带 mode=register", () async {
    final EmailLoginApi api = EmailLoginApi(
      client: MockClient((http.Request req) async {
        final Map<String, dynamic> body =
            jsonDecode(req.body) as Map<String, dynamic>;
        expect(req.url.path, "/accounts/register");
        expect(body["userId"], "a@b.com");
        expect(body["otpCode"], "123456");
        expect(body["displayName"], "a");
        expect(body["mode"], "register");
        return _json(<String, dynamic>{"ok": true}, 200);
      }),
    );
    final EmailLoginResult r =
        await api.register("a@b.com", code: "123456");
    expect(r.ok, isTrue);
  });

  test("register：409 ACCOUNT_EXISTS 不再当登录成功", () async {
    final EmailLoginApi api = EmailLoginApi(
      client: MockClient((_) async => _json(
            <String, dynamic>{
              "ok": false,
              "code": "ACCOUNT_EXISTS",
              "message": "该邮箱已注册，请直接登录",
            },
            409,
          )),
    );
    final EmailLoginResult r = await api.register("a@b.com");
    expect(r.ok, isFalse);
    expect(r.accountExists, isTrue);
    expect(r.error, contains("已注册"));
  });

  test("register：老服务端只有文案没有 code，仍识别为已注册", () async {
    final EmailLoginApi api = EmailLoginApi(
      client: MockClient((_) async => _json(
            <String, dynamic>{
              "ok": false, "message": "该用户已存在 Agent 账号，无需重复注册",
            },
            400,
          )),
    );
    final EmailLoginResult r = await api.register("a@b.com");
    expect(r.ok, isFalse);
    expect(r.accountExists, isTrue);
  });

  test("login：200 ok 只带 otpCode，不带 displayName", () async {
    final EmailLoginApi api = EmailLoginApi(
      client: MockClient((http.Request req) async {
        expect(req.url.path, "/accounts/login");
        final Map<String, dynamic> body =
            jsonDecode(req.body) as Map<String, dynamic>;
        expect(body["userId"], "a@b.com");
        expect(body["otpCode"], "123456");
        expect(body.containsKey("displayName"), isFalse);
        return _json(<String, dynamic>{"ok": true}, 200);
      }),
    );
    final EmailLoginResult r = await api.login("A@B.com", code: "123456");
    expect(r.ok, isTrue);
  });

  test("login：404 ACCOUNT_NOT_FOUND 提示去注册", () async {
    final EmailLoginApi api = EmailLoginApi(
      client: MockClient((_) async => _json(
            <String, dynamic>{
              "ok": false,
              "code": "ACCOUNT_NOT_FOUND",
              "message": "该邮箱还没有注册，请先创建账号",
            },
            404,
          )),
    );
    final EmailLoginResult r = await api.login("new@b.com", code: "123456");
    expect(r.ok, isFalse);
    expect(r.accountNotFound, isTrue);
  });

  test("login：验证码错误透传文案", () async {
    final EmailLoginApi api = EmailLoginApi(
      client: MockClient((_) async => _json(
            <String, dynamic>{
              "ok": false,
              "code": "OTP_INVALID",
              "message": "验证码不正确或已过期，请重新获取",
            },
            400,
          )),
    );
    final EmailLoginResult r = await api.login("a@b.com", code: "000000");
    expect(r.ok, isFalse);
    expect(r.accountNotFound, isFalse);
    expect(r.error, contains("验证码"));
  });

  test("checkRegistered：200 registered=true / 404 false / 网络错误 null", () async {
    final EmailLoginApi yes = EmailLoginApi(
      client: MockClient((http.Request req) async {
        expect(req.url.path, "/accounts/me");
        expect(req.url.queryParameters["userId"], "a@b.com");
        return _json(<String, dynamic>{"ok": true, "registered": true}, 200);
      }),
    );
    expect(await yes.checkRegistered("A@B.com"), isTrue);

    final EmailLoginApi no = EmailLoginApi(
      client: MockClient((_) async =>
          _json(<String, dynamic>{"ok": false, "registered": false}, 404)),
    );
    expect(await no.checkRegistered("new@b.com"), isFalse);

    final EmailLoginApi broken = EmailLoginApi(
      client: MockClient((_) async => throw Exception("boom")),
    );
    expect(await broken.checkRegistered("a@b.com"), isNull);
  });

  test("register：白名单拦截文案透传", () async {
    final EmailLoginApi api = EmailLoginApi(
      client: MockClient((_) async => _json(
            <String, dynamic>{
              "ok": false, "message": "内测期间暂未开放注册：可申请加入候补名单",
            },
            403,
          )),
    );
    final EmailLoginResult r = await api.register("a@b.com");
    expect(r.ok, isFalse);
    expect(r.accountExists, isFalse);
    expect(r.error, contains("候补"));
  });
}
