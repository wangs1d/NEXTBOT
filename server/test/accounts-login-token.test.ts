/**
 * 认证即发证（2026-11-11）：`POST /accounts/login` 与 `/accounts/register`
 * 成功后向客户端返回本机 access token。
 *
 * 这条链路是「身份跟随账号」的根：客户端拿到 token 后，WS `session.init`
 * 与所有 HTTP 请求都以 token 归属为身份权威，不再靠自报 userId——也就不会
 * 再出现「建连时本地会话没读出来 → 报默认 session-mvp-001」的故障。
 *
 * 覆盖：
 *  1. 登录成功返回 token，且能解出登录邮箱；
 *  2. 同设备再次登录撤销旧 token（换号/重登不串凭据）；
 *  3. 未注入鉴权服务时响应不含 token（老部署/桌面链向后兼容，行为不倒退）。
 *
 * 凭证与账号文件都钉到临时目录，绝不碰真实数据根。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import test from "node:test";
import assert from "node:assert/strict";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "accounts-token-test-"));
process.env.AGENT_ACCOUNTS_FILE = path.join(tmpDir, "agent-accounts.json");
process.env.NEXTBOT_DATA_DIR = tmpDir;
process.env.ACCESS_TOKENS_FILE = path.join(tmpDir, "access-tokens.json");
delete process.env.EMAIL_OTP_REQUIRED;

const { registerAccountRoutes } = await import("../src/routes/http/accounts.js");
const { AgentAccountService } = await import("../src/services/agent-account-service.js");
const { AccessAuthService } = await import("../src/services/access-auth-service.js");
const { default: Fastify } = await import("fastify");
type HttpRouteDeps = import("../src/routes/http/types.js").HttpRouteDeps;

const accountService = new AgentAccountService();
await accountService.load();

const EMAIL = "token-user@example.com";

async function ensureAccount(): Promise<void> {
  await accountService.register(EMAIL, "Token用户", EMAIL);
  await accountService.markSetupComplete(EMAIL);
}

function buildApp(withAuthService: boolean): {
  app: ReturnType<typeof Fastify>;
  accessAuthService: InstanceType<typeof AccessAuthService>;
} {
  const accessAuthService = new AccessAuthService();
  const deps = {
    agentAccountService: accountService,
    emailRegistrationService: null,
    ...(withAuthService ? { accessAuthService } : {}),
  } as unknown as HttpRouteDeps;
  const app = Fastify({ logger: false });
  registerAccountRoutes(app, deps);
  return { app, accessAuthService };
}

test("登录成功返回 access token，且能解出登录邮箱", async () => {
  await ensureAccount();
  const { app, accessAuthService } = buildApp(true);
  const res = await app.inject({
    method: "POST",
    url: "/accounts/login",
    payload: { userId: EMAIL, email: EMAIL, deviceId: "inst_phone_t1" },
  });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body) as Record<string, unknown>;
  assert.equal(body.ok, true);
  const token = String(body.accessToken ?? "");
  assert.ok(token.length >= 48, "应返回 64 hex 量级的 token 明文");
  assert.equal(body.deviceId, "inst_phone_t1");
  const verified = accessAuthService.verifyToken(token);
  assert.ok(verified, "返回的 token 必须能通过服务端校验");
  assert.equal(verified.userId, EMAIL);
});

test("同设备重复登录：旧 token 失效，新 token 上位", async () => {
  const { app, accessAuthService } = buildApp(true);
  const first = JSON.parse(
    (
      await app.inject({
        method: "POST",
        url: "/accounts/login",
        payload: { userId: EMAIL, email: EMAIL, deviceId: "inst_phone_t2" },
      })
    ).body,
  ) as Record<string, unknown>;
  const second = JSON.parse(
    (
      await app.inject({
        method: "POST",
        url: "/accounts/login",
        payload: { userId: EMAIL, email: EMAIL, deviceId: "inst_phone_t2" },
      })
    ).body,
  ) as Record<string, unknown>;
  assert.notEqual(first.accessToken, second.accessToken, "每次登录都应签发新凭据");
  assert.equal(accessAuthService.verifyToken(String(first.accessToken)), null);
  assert.equal(
    accessAuthService.verifyToken(String(second.accessToken))?.userId,
    EMAIL,
  );
});

test("注册成功同样发证（新装首启不需要额外的配对码）", async () => {
  const fresh = "fresh-user@example.com";
  const { app, accessAuthService } = buildApp(true);
  const res = await app.inject({
    method: "POST",
    url: "/accounts/register",
    payload: {
      userId: fresh,
      email: fresh,
      displayName: "新用户",
      mode: "register",
      deviceId: "inst_phone_t3",
    },
  });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body) as Record<string, unknown>;
  const token = String(body.accessToken ?? "");
  assert.ok(token.length >= 48);
  assert.equal(accessAuthService.verifyToken(token)?.userId, fresh);
});

test("未注入鉴权服务：响应不含 token，登录本身仍成功（向后兼容）", async () => {
  const { app } = buildApp(false);
  const res = await app.inject({
    method: "POST",
    url: "/accounts/login",
    payload: { userId: EMAIL, email: EMAIL, deviceId: "inst_phone_t4" },
  });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body) as Record<string, unknown>;
  assert.equal(body.ok, true);
  assert.equal(body.accessToken, undefined);
});
