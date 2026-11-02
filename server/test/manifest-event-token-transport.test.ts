import test from "node:test";
import assert from "node:assert/strict";

/**
 * 发布事件流订阅口令的传递方式：口令走 x-manifest-event-token 请求头，
 * 不再拼进 URL —— 整条 URL（含 query）会原样落进对端 nginx access.log 与本进程
 * 请求日志，等于把控制面凭证常驻写盘。query 形式一律不授权。
 *
 * 运行：npx tsx --test test/manifest-event-token-transport.test.ts
 */

const { MANIFEST_EVENT_TOKEN_HEADER, manifestEventAuthorized } = await import(
  "../src/routes/http/internal-manifest-events.js"
);
const { subscribeTarget } = await import("../src/services/client-update-pusher.js");

const TOKEN = "nbtok_manifest_ev_test-value_0001";
const env = { MANIFEST_EVENT_TOKEN: TOKEN } as NodeJS.ProcessEnv;

test("请求头口令放行", () => {
  assert.equal(manifestEventAuthorized({ [MANIFEST_EVENT_TOKEN_HEADER]: TOKEN }, env), true);
});

test("query 口令不再参与授权：只认 x-manifest-event-token 头", () => {
  // 旧 ?token= 形式的等价形态（口令出现在参数里而不是头里）一律拒
  assert.equal(manifestEventAuthorized({ token: TOKEN }, env), false);
  assert.equal(manifestEventAuthorized({}, env), false);
});

test("口令不符 / 缺失 / 头是数组都拒", () => {
  assert.equal(manifestEventAuthorized({ [MANIFEST_EVENT_TOKEN_HEADER]: "wrong" }, env), false);
  assert.equal(manifestEventAuthorized({}, env), false);
  assert.equal(manifestEventAuthorized({ [MANIFEST_EVENT_TOKEN_HEADER]: [TOKEN] }, env), false);
});

test("未配置 MANIFEST_EVENT_TOKEN 时端点整体禁用（即使带上看起来对的口令）", () => {
  assert.equal(manifestEventAuthorized({ [MANIFEST_EVENT_TOKEN_HEADER]: TOKEN }, {}), false);
  assert.equal(
    manifestEventAuthorized({ [MANIFEST_EVENT_TOKEN_HEADER]: TOKEN }, { MANIFEST_EVENT_TOKEN: "  " }),
    false,
  );
});

test("订阅端构造的目标 URL 不含口令，口令单独成字段", () => {
  process.env.UPDATE_MANIFEST_SOURCE_URL = "https://control-plane.example";
  process.env.UPDATE_MANIFEST_EVENT_TOKEN = TOKEN;
  const built = subscribeTarget();
  assert.ok(built);
  assert.equal(built.url, "https://control-plane.example/api/internal/manifest-events");
  assert.equal(built.token, TOKEN);
  assert.ok(!built.url.includes(TOKEN), "URL 里不得出现口令");
  delete process.env.UPDATE_MANIFEST_SOURCE_URL;
  delete process.env.UPDATE_MANIFEST_EVENT_TOKEN;
});

test("源地址或口令任一缺失则不订阅", () => {
  delete process.env.UPDATE_MANIFEST_SOURCE_URL;
  delete process.env.UPDATE_MANIFEST_EVENT_TOKEN;
  assert.equal(subscribeTarget(), null);
  process.env.UPDATE_MANIFEST_SOURCE_URL = "https://control-plane.example";
  assert.equal(subscribeTarget(), null);
});
