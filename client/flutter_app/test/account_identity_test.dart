import "package:flutter_test/flutter_test.dart";

import "package:nextbot/core/config/api_config.dart";

/// 登录身份覆盖与归一化：邮箱登录后全链身份=登录邮箱（按账号隔离），
/// 退出登录回落编译期默认；同一邮箱大小写不同写法归一成同一身份。
void main() {
  tearDown(() {
    ApiConfig.runtimeUserId = null;
  });

  group("ApiConfig.normalizeIdentity", () {
    test("邮箱统一小写并 trim", () {
      expect(ApiConfig.normalizeIdentity("  Mix@Example.COM "), "mix@example.com");
    });

    test("非邮箱形态保留原样（仅 trim）", () {
      expect(ApiConfig.normalizeIdentity(" session-mvp-001 "), "session-mvp-001");
      expect(ApiConfig.normalizeIdentity("inst_abc_DEF"), "inst_abc_DEF");
    });

    test("空值归一为空串", () {
      expect(ApiConfig.normalizeIdentity(null), "");
      expect(ApiConfig.normalizeIdentity("   "), "");
    });
  });

  group("ApiConfig.runtimeUserId 覆盖", () {
    test("未登录时回落默认会话身份", () {
      ApiConfig.runtimeUserId = null;
      expect(ApiConfig.effectiveActorId, ApiConfig.sessionId);
      expect(ApiConfig.accountAuthQuery, <String, String>{"sessionId": ApiConfig.sessionId});
    });

    test("登录后全链身份切换为登录邮箱", () {
      ApiConfig.runtimeUserId = "User@Example.COM";
      expect(ApiConfig.runtimeUserId, "user@example.com");
      expect(ApiConfig.effectiveActorId, "user@example.com");
      expect(
        ApiConfig.accountAuthQuery,
        <String, String>{"userId": "user@example.com"},
      );
      final Map<String, String> body = ApiConfig.accountRegisterBody("demo");
      expect(body["userId"], "user@example.com");
      expect(body.containsKey("sessionId"), isFalse);
      final Map<String, String> verify = ApiConfig.accountEmailVerifyBody("123456");
      expect(verify["userId"], "user@example.com");
      expect(verify["code"], "123456");
    });

    test("换账号登录=身份跟着换（数据互不串台的前提）", () {
      ApiConfig.runtimeUserId = "a@x.com";
      expect(ApiConfig.effectiveActorId, "a@x.com");
      ApiConfig.runtimeUserId = "B@X.com";
      expect(ApiConfig.effectiveActorId, "b@x.com");
    });

    test("退出登录（置空）回落默认会话身份", () {
      ApiConfig.runtimeUserId = "a@x.com";
      ApiConfig.runtimeUserId = null;
      expect(ApiConfig.runtimeUserId, isNull);
      expect(ApiConfig.effectiveActorId, ApiConfig.sessionId);
    });

    test("空白/无效覆盖等同未登录", () {
      ApiConfig.runtimeUserId = "   ";
      expect(ApiConfig.runtimeUserId, isNull);
    });
  });
}
