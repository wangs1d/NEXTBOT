import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import test from "node:test";
import assert from "node:assert/strict";

/**
 * 管理后台回环门禁测试：/admin 页面与全部 /api/admin/* 默认仅本机回环可达，
 * 公网 IP 一律 404（带正确 token 也不放行——网络层先于鉴权层）；
 * ADMIN_CONSOLE_ALLOW_REMOTE=1 显式放行；非 admin 路由不受门禁影响。
 *
 * 用真实 fastify 实例 + inject（light-my-request 的 remoteAddress 选项伪造来源 IP）。
 * 运行：npx tsx --test test/admin-console-loopback-gate.test.ts
 */

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "admin-gate-test-"));
const TEST_TOKEN = "gate-test-admin-token-1";
delete process.env.ADMIN_UPLOAD_TOKEN;
delete process.env.ADMIN_CONSOLE_ALLOW_REMOTE;
process.env.FEEDBACK_DB = path.join(tmpDir, "feedback.db");
process.env.PAYMENT_LEDGER_DB = path.join(tmpDir, "payment", "orders.db");
process.env.AGENT_ACCOUNTS_FILE = path.join(tmpDir, "agent-accounts.json");
process.env.ADMIN_AUTH_DB = path.join(tmpDir, "admin-auth.db");

const { installAdminConsoleLoopbackGate } = await import(
  "../src/routes/http/admin-console-gate.js"
);
const { registerAdminAuthRoutes } = await import("../src/routes/http/admin-session-auth.js");
const { registerAdminConsoleRoutes } = await import("../src/routes/http/admin-console.js");
const { registerFeedbackRoutes } = await import("../src/routes/http/feedback.js");
const { AgentAccountService } = await import("../src/services/agent-account-service.js");
const { PaymentService } = await import("../src/services/payment-service.js");
const { default: Fastify } = await import("fastify");
type HttpRouteDeps = import("../src/routes/http/types.js").HttpRouteDeps;

const accountService = new AgentAccountService();
await accountService.load();
const deps = {
  agentAccountService: accountService,
  paymentService: new PaymentService(),
} as unknown as HttpRouteDeps;

/**
 * 注意：门禁在**请求时**读 ADMIN_CONSOLE_ALLOW_REMOTE，而 load-server-env 会在
 * import 期把本机 .env 覆盖回进程环境变量——所以这里必须在建 app 时显式归位，
 * 否则本地 .env 里的一条 ALLOW_REMOTE=1 就能让「默认仅回环」的断言永远为假。
 */
function buildApp(allowRemote = false) {
  process.env.ADMIN_CONSOLE_ALLOW_REMOTE = allowRemote ? "1" : "0";
  const app = Fastify({ logger: false });
  // 门禁必须在 admin 路由注册之前安装（与 index.ts 的顺序约定一致）
  installAdminConsoleLoopbackGate(app);
  registerAdminAuthRoutes(app);
  registerAdminConsoleRoutes(app, deps);
  registerFeedbackRoutes(app);
  return app;
}

const PUBLIC_IP = "203.0.113.9";

test("公网 IP 访问 /admin 页面与 admin API 一律 404（先于鉴权层，token 正确也不放行）", async () => {
  process.env.ADMIN_UPLOAD_TOKEN = TEST_TOKEN;
  const app = buildApp();
  const page = await app.inject({ method: "GET", url: "/admin", remoteAddress: PUBLIC_IP });
  assert.equal(page.statusCode, 404);
  const pageRedirect = await app.inject({ method: "GET", url: "/admin/feedback", remoteAddress: PUBLIC_IP });
  assert.equal(pageRedirect.statusCode, 404);
  const status = await app.inject({ method: "GET", url: "/api/admin/auth/status", remoteAddress: PUBLIC_IP });
  assert.equal(status.statusCode, 404);
  const setup = await app.inject({
    method: "POST",
    url: "/api/admin/auth/setup",
    remoteAddress: PUBLIC_IP,
    headers: { "x-requested-with": "admin-console" },
    payload: { username: "attacker", password: "password123" },
  });
  assert.equal(setup.statusCode, 404);
  // 公网带正确 token 的脚本请求同样被网络层拦下
  const withToken = await app.inject({
    method: "GET",
    url: "/api/admin/overview",
    remoteAddress: PUBLIC_IP,
    headers: { "x-admin-token": TEST_TOKEN },
  });
  assert.equal(withToken.statusCode, 404);
  await app.close();
});

test("回环访问不受影响：页面 200、status 正常、token 鉴权照常工作", async () => {
  process.env.ADMIN_UPLOAD_TOKEN = TEST_TOKEN;
  const app = buildApp();
  const page = await app.inject({ method: "GET", url: "/admin" });
  assert.equal(page.statusCode, 200);
  const status = await app.inject({ method: "GET", url: "/api/admin/auth/status" });
  assert.equal(status.statusCode, 200);
  assert.equal(status.json().ok, true);
  const good = await app.inject({
    method: "GET",
    url: "/api/admin/overview",
    headers: { "x-admin-token": TEST_TOKEN },
  });
  assert.equal(good.statusCode, 200);
  // IPv6 回环映射同样放行
  const v6 = await app.inject({ method: "GET", url: "/api/admin/auth/status", remoteAddress: "::ffff:127.0.0.1" });
  assert.equal(v6.statusCode, 200);
  await app.close();
});

test("ADMIN_CONSOLE_ALLOW_REMOTE=1 显式放行公网", async () => {
  process.env.ADMIN_UPLOAD_TOKEN = TEST_TOKEN;
  try {
    const app = buildApp(true);
    const res = await app.inject({
      method: "GET",
      url: "/api/admin/overview",
      remoteAddress: PUBLIC_IP,
      headers: { "x-admin-token": TEST_TOKEN },
    });
    assert.equal(res.statusCode, 200);
    await app.close();
  } finally {
    delete process.env.ADMIN_CONSOLE_ALLOW_REMOTE;
  }
});

test("非 admin 路由不受门禁影响（公网提交反馈走正常业务逻辑，非 404）", async () => {
  const app = buildApp();
  const res = await app.inject({
    method: "POST",
    url: "/api/feedback",
    remoteAddress: PUBLIC_IP,
    payload: { userId: "gate-test-user", type: "bug", title: "门禁测试", description: "公网提交反馈" },
  });
  assert.notEqual(res.statusCode, 404);
  assert.equal(res.statusCode, 200);
  await app.close();
});
