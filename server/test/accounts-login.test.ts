import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import test from "node:test";
import assert from "node:assert/strict";

/**
 * 登录 / 注册分家后的账号链测试（2026-11）：
 * - `POST /accounts/login`：只登录不建档，账号不存在 → 404 ACCOUNT_NOT_FOUND；
 *   OTP 闸开启时必须验码通过才放行（验证码一次性）。
 * - `POST /accounts/register` 带 `mode:"register"`：已存在 → 409 ACCOUNT_EXISTS，
 *   不再把「重复注册」悄悄当成登录。
 * - 不传 mode 的旧语义（桌面 /accounts/web、机器身份自注册）保持原样不倒退。
 *
 * 运行：npx tsx --test test/accounts-login.test.ts
 */

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "accounts-login-test-"));
process.env.AGENT_ACCOUNTS_FILE = path.join(tmpDir, "agent-accounts.json");
delete process.env.EMAIL_OTP_REQUIRED;

const { registerAccountRoutes } = await import("../src/routes/http/accounts.js");
const { AgentAccountService } = await import("../src/services/agent-account-service.js");
const { EmailOtpService } = await import("../src/services/email-otp-service.js");
const { default: Fastify } = await import("fastify");
type HttpRouteDeps = import("../src/routes/http/types.js").HttpRouteDeps;

const accountService = new AgentAccountService();
await accountService.load();
const otpService = new EmailOtpService();

/** 假邮件通道：isEmailEnabled()=true 打开 OTP 闸，不真发信。 */
const fakeSms = {
  isEmailEnabled: () => true,
  sendEmail: async () => ({ ok: true }),
};

function buildApp(otpOn: boolean): ReturnType<typeof Fastify> {
  const deps = {
    agentAccountService: accountService,
    emailRegistrationService: null,
    ...(otpOn ? { emailOtpService: otpService, emailSmsService: fakeSms } : {}),
  } as unknown as HttpRouteDeps;
  const app = Fastify({ logger: false });
  registerAccountRoutes(app, deps);
  return app;
}

async function issueCode(email: string): Promise<string> {
  let code = "";
  const r = await otpService.issue(email, {
    deliver: async (_e, c) => {
      code = c;
    },
  });
  assert.equal(r.ok, true, "发码应成功");
  assert.match(code, /^\d{6}$/);
  return code;
}

// ── 闸关（单机/开发形态）──

test("闸关：登录未注册邮箱 → 404 ACCOUNT_NOT_FOUND，且不偷偷建档", async () => {
  const app = buildApp(false);
  const res = await app.inject({
    method: "POST",
    url: "/accounts/login",
    payload: { userId: "ghost@example.com", email: "ghost@example.com" },
  });
  assert.equal(res.statusCode, 404);
  assert.equal(res.json().code, "ACCOUNT_NOT_FOUND");
  assert.equal(accountService.getByActorId("ghost@example.com"), undefined);
});

test("闸关：注册（mode=register）新号 200 / 老号 409", async () => {
  const app = buildApp(false);
  const first = await app.inject({
    method: "POST",
    url: "/accounts/register",
    payload: {
      userId: "old@example.com",
      displayName: "老用户",
      email: "old@example.com",
      mode: "register",
    },
  });
  assert.equal(first.statusCode, 200);
  assert.equal(first.json().account.displayName, "老用户");

  const again = await app.inject({
    method: "POST",
    url: "/accounts/register",
    payload: {
      userId: "old@example.com",
      displayName: "老用户",
      email: "old@example.com",
      mode: "register",
    },
  });
  assert.equal(again.statusCode, 409);
  assert.equal(again.json().code, "ACCOUNT_EXISTS");
});

test("闸关：已注册用户可免码直接登录", async () => {
  const app = buildApp(false);
  const res = await app.inject({
    method: "POST",
    url: "/accounts/login",
    payload: { userId: "OLD@example.com", email: "OLD@example.com" },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().account.userId, "old@example.com", "主键归一小写");
});

test("旧语义不倒退：不带 mode 的重复注册仍是「已存在」幂等响应", async () => {
  const app = buildApp(false);
  const res = await app.inject({
    method: "POST",
    url: "/accounts/register",
    payload: { userId: "old@example.com", displayName: "老用户", email: "old@example.com" },
  });
  assert.equal(res.statusCode, 400);
  assert.match(res.json().message, /已存在/);
});

// ── 闸开（SMTP 凭据齐备）──

test("闸开：登录必须带码且码要对，通过后一次性作废", async () => {
  const app = buildApp(true);
  const email = "vip@example.com";
  await accountService.register(email, "VIP", email);

  const noCode = await app.inject({
    method: "POST",
    url: "/accounts/login",
    payload: { userId: email, email },
  });
  assert.equal(noCode.statusCode, 400);
  assert.equal(noCode.json().code, "OTP_REQUIRED");

  const code = await issueCode(email);
  const wrong = await app.inject({
    method: "POST",
    url: "/accounts/login",
    payload: { userId: email, email, otpCode: code === "000000" ? "111111" : "000000" },
  });
  assert.equal(wrong.statusCode, 400);
  assert.equal(wrong.json().code, "OTP_INVALID");

  const ok = await app.inject({
    method: "POST",
    url: "/accounts/login",
    payload: { userId: "VIP@Example.com", email: "VIP@Example.com", otpCode: code },
  });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.json().account.userId, email, "大写写法也登进同一账号");

  // 同一枚码重放：拒绝（登录侧也一次性）
  const replay = await app.inject({
    method: "POST",
    url: "/accounts/login",
    payload: { userId: email, email, otpCode: code },
  });
  assert.equal(replay.statusCode, 400);
  assert.equal(replay.json().code, "OTP_INVALID");
});

test("闸开：注册（mode=register）在验码前就挡掉已注册邮箱", async () => {
  const app = buildApp(true);
  const email = "dupe@example.com";
  await accountService.register(email, "Dupe", email);
  const res = await app.inject({
    method: "POST",
    url: "/accounts/register",
    payload: { userId: email, displayName: "Dupe", email, mode: "register" },
  });
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().code, "ACCOUNT_EXISTS");
});

test.after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
