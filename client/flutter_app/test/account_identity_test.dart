import "package:flutter_test/flutter_test.dart";

import "package:nextbot/core/config/api_config.dart";

/// 登录身份覆盖与归一化：有凭据/邮箱时全链身份=登录账号（按账号隔离），
/// 真正未登录时回落**设备匿名身份**（installId），不再用编译期 sessionId
/// 冒充账号——否则所有未登录设备挤在同一个 actor 上串记忆/世界/配额。
void main() {
  tearDown(() {
    ApiConfig.runtimeUserId = null;
    ApiConfig.installIdentityProvider = null;
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
    test("未登录且无安装标识时回落 guest 占位，绝不回落 session-mvp-001", () {
      ApiConfig.runtimeUserId = null;
      ApiConfig.installIdentityProvider = null;
      expect(ApiConfig.effectiveActorId, ApiConfig.guestFallbackActorId);
      expect(ApiConfig.effectiveActorId, isNot(ApiConfig.sessionId));
      expect(
        ApiConfig.accountAuthQuery,
        <String, String>{"userId": ApiConfig.guestFallbackActorId},
      );
    });

    test("未登录但已有安装标识：用设备匿名身份，不占 session-mvp-001", () {
      ApiConfig.runtimeUserId = null;
      ApiConfig.installIdentityProvider = () => "inst_mwayz1k7_fd56";
      expect(ApiConfig.effectiveActorId, "inst_mwayz1k7_fd56");
      expect(
        ApiConfig.accountAuthQuery,
        <String, String>{"userId": "inst_mwayz1k7_fd56"},
      );
      expect(ApiConfig.effectiveActorId, isNot(ApiConfig.sessionId));
    });

    test("登录后匿名身份让位：账号身份优先于安装标识", () {
      ApiConfig.installIdentityProvider = () => "inst_mwayz1k7_fd56";
      ApiConfig.runtimeUserId = "User@Example.COM";
      expect(ApiConfig.effectiveActorId, "user@example.com");
      expect(
        ApiConfig.accountAuthQuery,
        <String, String>{"userId": "user@example.com"},
      );
    });

    test("退出登录后回到本机匿名身份（不是默认账号）", () {
      ApiConfig.installIdentityProvider = () => "inst_mwayz1k7_fd56";
      ApiConfig.runtimeUserId = "a@x.com";
      expect(ApiConfig.effectiveActorId, "a@x.com");
      ApiConfig.runtimeUserId = null;
      expect(ApiConfig.effectiveActorId, "inst_mwayz1k7_fd56");
    });

    test("安装标识尚未就绪（provider 返空）时不炸，回落 guest 占位", () {
      ApiConfig.runtimeUserId = null;
      ApiConfig.installIdentityProvider = () => null;
      expect(ApiConfig.effectiveActorId, ApiConfig.guestFallbackActorId);
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

    test("退出登录（置空）回落 guest 占位", () {
      ApiConfig.runtimeUserId = "a@x.com";
      ApiConfig.runtimeUserId = null;
      expect(ApiConfig.runtimeUserId, isNull);
      ApiConfig.installIdentityProvider = null;
      expect(ApiConfig.effectiveActorId, ApiConfig.guestFallbackActorId);
    });

    test("空白/无效覆盖等同未登录", () {
      ApiConfig.runtimeUserId = "   ";
      expect(ApiConfig.runtimeUserId, isNull);
    });
  });

  // 2026-11-27：电脑端后端本地化。这三条断言锁住「任何机制都无权把电脑端
  // 劫持回云端」——远程配置缓存、platform channel 收回、烤入的云端地址。
  // 手机端不受影响（Android/iOS 不在闸门内）。
  group("桌面端本地后端闸门", () {
    tearDown(() {
      ApiConfig.applyRemoteOverrides(httpBase: "", controlPlaneUrl: "", updateManifestUrl: "");
      ApiConfig.applyRuntimeChannel("byok");
    });

    test("httpBase 恒为本机 runtime，远程配置覆盖无效", () {
      ApiConfig.applyRemoteOverrides(httpBase: "https://api.nextbot.top");
      expect(ApiConfig.httpBase, "http://127.0.0.1:3000");
    });

    test("platform channel 收回不生效，本机 runtime 仍拉起", () {
      ApiConfig.applyRuntimeChannel("platform");
      expect(ApiConfig.usesPlatformChannel, isFalse);
    });

    test("wsUrl 跟本地 httpBase 同源，不吃烤入的云端 WS_URL", () {
      ApiConfig.applyRemoteOverrides(httpBase: "https://api.nextbot.top");
      expect(ApiConfig.wsUrl, "ws://127.0.0.1:3000/ws");
    });
  });
}
