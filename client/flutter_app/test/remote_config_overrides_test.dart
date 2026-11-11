import "package:flutter_test/flutter_test.dart";
import "package:nextbot/core/config/api_config.dart";

/// 远程配置下发·地基回归测试（2026-11-10）：
/// ApiConfig.applyRemoteOverrides 的覆盖语义——
/// - 非空字段生效、空/null 字段保持烤入值；
/// - 地址归一（去尾斜杠）与非法协议/无 host 丢弃（配置手误不得打挂请求链）；
/// - 覆盖值优先于一切烤入值（运维最新决定）。
/// 注意：ApiConfig 是全局静态，测试间用全空 applyRemoteOverrides 复位。
void main() {
  tearDown(() {
    // 复位：全空覆盖 = 清掉前一条用例的 _remote* 值。
    ApiConfig.applyRemoteOverrides(
      httpBase: "",
      controlPlaneUrl: "",
      updateManifestUrl: "",
    );
  });

  test("全空覆盖是 no-op：烤入值语义不变", () {
    ApiConfig.applyRemoteOverrides(httpBase: "", controlPlaneUrl: "", updateManifestUrl: "");
    // 本测试进程未烤 HTTP_BASE，Windows release 之外的 httpBase 回落 127.0.0.1。
    assertUpstreamBehaviorUnchanged();
  });

  test("httpBase 覆盖生效，wsUrl 由覆盖值推导", () {
    ApiConfig.applyRemoteOverrides(httpBase: "https://api.migrated.example.com/");
    expect(ApiConfig.httpBase, "https://api.migrated.example.com"); // 尾斜杠已去
    expect(ApiConfig.wsUrl, "wss://api.migrated.example.com/ws");
  });

  test("controlPlaneUrl / updateManifestUrl 覆盖各自生效", () {
    ApiConfig.applyRemoteOverrides(
      controlPlaneUrl: "https://cp.migrated.example.com",
      updateManifestUrl: "https://manifest.migrated.example.com",
    );
    expect(ApiConfig.controlPlaneBase, "https://cp.migrated.example.com");
    expect(ApiConfig.updateManifestUrl, "https://manifest.migrated.example.com");
  });

  test("覆盖为空串等于撤销覆盖（回到烤入值）", () {
    ApiConfig.applyRemoteOverrides(httpBase: "https://first.example.com");
    expect(ApiConfig.httpBase, "https://first.example.com");
    ApiConfig.applyRemoteOverrides(httpBase: "");
    assertUpstreamBehaviorUnchanged();
  });

  test("非法覆盖值被丢弃：非 http/https 协议、无 host", () {
    ApiConfig.applyRemoteOverrides(httpBase: "ftp://bad.example.com");
    expect(ApiConfig.httpBase, isNot(contains("ftp"))); // 非法值未生效
    ApiConfig.applyRemoteOverrides(httpBase: "not a url");
    assertUpstreamBehaviorUnchanged();
    ApiConfig.applyRemoteOverrides(httpBase: "https://");
    assertUpstreamBehaviorUnchanged();
  });

  test("覆盖幂等：重复调用以最后一次为准", () {
    ApiConfig.applyRemoteOverrides(httpBase: "https://first.example.com");
    ApiConfig.applyRemoteOverrides(httpBase: "https://second.example.com");
    expect(ApiConfig.httpBase, "https://second.example.com");
  });
}

/// 未烤 HTTP_BASE 且无覆盖时的基线行为（与本测试进程一致的环境）。
void assertUpstreamBehaviorUnchanged() {
  // 不关心具体值（依赖平台形态），只要求「不等于任何测试注入值」。
  expect(ApiConfig.httpBase, isNot(contains("example.com")));
}
