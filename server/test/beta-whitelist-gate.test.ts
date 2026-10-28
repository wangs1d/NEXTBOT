import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import test from "node:test";
import assert from "node:assert/strict";

/**
 * 内测注册白名单闸测试：
 * - 名单未配置（文件缺失/空）= 不设闸，任意邮箱照常注册；
 * - 名单非空 = 收紧：名单外新邮箱 403（带联系管理员文案），名单内邮箱可注册
 *   且大小写归一，重复添加幂等；
 * - 闸开启前已注册的账号重复注册（登录语义）不受闸影响；
 * - inst_* 机器身份注册豁免（保障启动自注册）；
 * - 后台 API 增删名单即时生效（注册闸实时读盘），移除到空 = 重新开放；
 * - 名单文件损坏 fail-closed（暂拒一切新注册），后台重新添加即修复；
 * - 白名单管理接口需管理凭证。
 *
 * 用真实 fastify 实例 + inject（不起监听端口），名单与账号库落临时目录。
 * 运行：npx tsx --test test/beta-whitelist-gate.test.ts
 */

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "beta-whitelist-test-"));
const TEST_TOKEN = "test-admin-token-beta-whitelist";
process.env.ADMIN_UPLOAD_TOKEN = TEST_TOKEN;
process.env.AGENT_ACCOUNTS_FILE = path.join(tmpDir, "agent-accounts.json");
process.env.BETA_WHITELIST_FILE = path.join(tmpDir, "beta-whitelist.json");
process.env.BETA_WAITLIST_FILE = path.join(tmpDir, "beta-waitlist.json");
process.env.BETA_INVITE_CODES_FILE = path.join(tmpDir, "beta-invite-codes.json");
process.env.ADMIN_AUTH_DB = path.join(tmpDir, "admin-auth.db");

const { registerAccountRoutes } = await import("../src/routes/http/accounts.js");
const { registerAccountWebRoutes } = await import("../src/routes/http/accounts-web.js");
const { registerAdminConsoleRoutes } = await import("../src/routes/http/admin-console.js");
const { AgentAccountService } = await import("../src/services/agent-account-service.js");
const { BetaWhitelistService } = await import("../src/services/beta-whitelist-service.js");
const { BetaInviteService, BetaWaitlistService } = await import("../src/services/beta-invite-service.js");
const { default: Fastify } = await import("fastify");
type HttpRouteDeps = import("../src/routes/http/types.js").HttpRouteDeps;

const accountService = new AgentAccountService();
await accountService.load();
const whitelistService = new BetaWhitelistService();
const inviteService = new BetaInviteService();
const waitlistService = new BetaWaitlistService();
const whitelistFile = process.env.BETA_WHITELIST_FILE;

const deps = {
  agentAccountService: accountService,
  emailRegistrationService: null,
  betaWhitelistService: whitelistService,
  betaWaitlistService: waitlistService,
  betaInviteService: inviteService,
} as unknown as HttpRouteDeps;

function buildApp(): ReturnType<typeof Fastify> {
  const app = Fastify({ logger: false });
  registerAccountRoutes(app, deps);
  registerAccountWebRoutes(app);
  registerAdminConsoleRoutes(app, deps);
  return app;
}

const adminHeaders = { "x-admin-token": TEST_TOKEN };

function register(app: ReturnType<typeof Fastify>, userId: string, withEmail = true) {
  return app.inject({
    method: "POST",
    url: "/accounts/register",
    payload: {
      userId,
      displayName: userId.split("@")[0] || userId,
      ...(withEmail ? { email: userId } : {}),
    },
  });
}

test("名单未配置（文件缺失）= 不设闸：任意邮箱照常注册", async () => {
  const app = buildApp();
  assert.equal(fs.existsSync(whitelistFile), false);

  const res = await register(app, "vet-ok@example.com");
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().ok, true);
});

test("后台添加邮箱后闸生效：名单外 403、名单内（大小写混写）200、重复添加幂等", async () => {
  const app = buildApp();

  const add = await app.inject({
    method: "POST",
    url: "/api/admin/beta-whitelist",
    headers: adminHeaders,
    payload: { email: "Tester@Example.COM" },
  });
  assert.equal(add.statusCode, 200);
  assert.equal(add.json().enabled, true);
  assert.deepEqual(add.json().emails, ["tester@example.com"]);

  // 名单外新邮箱：403 + 候补/邀请码指引文案（客户端 UI 原样展示 message）
  const blocked = await register(app, "stranger@example.com");
  assert.equal(blocked.statusCode, 403);
  assert.match(blocked.json().message, /候补/);
  assert.equal(accountService.getByActorId("stranger@example.com"), undefined);

  // 名单内（大小写不同写法归一）：放行并建档为小写
  const allowed = await register(app, "Tester@Example.COM");
  assert.equal(allowed.statusCode, 200);
  assert.equal(allowed.json().account.userId, "tester@example.com");

  // 幂等：重复添加不裂成两行
  const dup = await app.inject({
    method: "POST",
    url: "/api/admin/beta-whitelist",
    headers: adminHeaders,
    payload: { email: "tester@example.com" },
  });
  assert.equal(dup.statusCode, 200);
  assert.equal(dup.json().emails.length, 1);
});

test("闸开启前已注册的账号重复注册（登录语义）不受闸影响", async () => {
  const app = buildApp();

  // vet-ok@example.com 在第一个测试（未设闸时）已注册
  const res = await register(app, "vet-ok@example.com");
  assert.equal(res.statusCode, 400);
  assert.match(res.json().message, /已存在/);
});

test("inst_* 机器身份注册豁免注册闸（保障启动自注册）", async () => {
  const app = buildApp();

  const res = await register(app, "inst_beta_gate_test", false);
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().account.userId, "inst_beta_gate_test");
});

test("后台移除即时生效；移除到空 = 重新开放注册", async () => {
  const app = buildApp();

  const rm = await app.inject({
    method: "DELETE",
    url: `/api/admin/beta-whitelist/${encodeURIComponent("tester@example.com")}`,
    headers: adminHeaders,
  });
  assert.equal(rm.statusCode, 200);
  assert.equal(rm.json().enabled, false);
  assert.deepEqual(rm.json().emails, []);

  // 名单空后名单外邮箱恢复可注册
  const res = await register(app, "reopened@example.com");
  assert.equal(res.statusCode, 200);
});

test("添加非法格式邮箱 400；白名单接口未携带凭证 401", async () => {
  const app = buildApp();

  const bad = await app.inject({
    method: "POST",
    url: "/api/admin/beta-whitelist",
    headers: adminHeaders,
    payload: { email: "not-an-email" },
  });
  assert.equal(bad.statusCode, 400);

  const unauth = await app.inject({ method: "GET", url: "/api/admin/beta-whitelist" });
  assert.equal(unauth.statusCode, 401);
});

test("名单文件损坏 fail-closed：暂拒一切新注册，后台重新添加即修复", async () => {
  const app = buildApp();

  fs.writeFileSync(whitelistFile, "{broken json", "utf8");
  const snap = await app.inject({ method: "GET", url: "/api/admin/beta-whitelist", headers: adminHeaders });
  assert.equal(snap.json().corrupt, true);
  assert.equal(snap.json().enabled, true);

  const blocked = await register(app, "during-corrupt@example.com");
  assert.equal(blocked.statusCode, 403);

  // 后台重新添加：写回合法名单文件，闸恢复正常判定
  const fix = await app.inject({
    method: "POST",
    url: "/api/admin/beta-whitelist",
    headers: adminHeaders,
    payload: { email: "fixed@example.com" },
  });
  assert.equal(fix.statusCode, 200);
  assert.equal(fix.json().corrupt, undefined);
  assert.deepEqual(fix.json().emails, ["fixed@example.com"]);

  const allowed = await register(app, "fixed@example.com");
  assert.equal(allowed.statusCode, 200);
  const stillBlocked = await register(app, "still-out@example.com");
  assert.equal(stillBlocked.statusCode, 403);
});

test("邀请码通道已下线：注册携带 inviteCode 也被忽略仍拦，管理 API 保留但休眠", async () => {
  const app = buildApp();

  // 管理接口仍可建码（休眠能力，将来开启零成本）
  const created = await app.inject({
    method: "POST",
    url: "/api/admin/beta-invite-codes",
    headers: adminHeaders,
    payload: { maxUses: 1, note: "测试群" },
  });
  assert.equal(created.statusCode, 200);
  const code = created.json().code.code as string;

  // 但注册接口不再认码：带码与不带码同样 403
  const withCode = await app.inject({
    method: "POST",
    url: "/accounts/register",
    payload: {
      userId: "invite-ok@example.com",
      displayName: "io",
      email: "invite-ok@example.com",
      inviteCode: code,
    },
  });
  assert.equal(withCode.statusCode, 403);
  assert.match(withCode.json().message, /候补/);
  assert.equal(accountService.getByActorId("invite-ok@example.com"), undefined);
  // 码未消耗
  const listed = await app.inject({ method: "GET", url: "/api/admin/beta-invite-codes", headers: adminHeaders });
  assert.equal(listed.json().codes[0].uses, 0);

  // 清理休眠码库，保持测试可重跑
  await app.inject({
    method: "DELETE",
    url: `/api/admin/beta-invite-codes/${encodeURIComponent(code)}`,
    headers: adminHeaders,
  });
});

test("候补申请与批量审批：apply 排队幂等、通过入白名单并可注册、白名单内申请直接告知免排", async () => {
  const app = buildApp();

  // 排队
  const apply = await app.inject({
    method: "POST",
    url: "/accounts/beta/apply",
    payload: { email: "Queue@Example.COM", note: "朋友介绍" },
  });
  assert.equal(apply.statusCode, 200);
  assert.equal(apply.json().status, "pending");
  assert.equal(apply.json().email, "queue@example.com");
  // 幂等：重复提交仍是 pending（不产生第二条）
  const again = await app.inject({
    method: "POST",
    url: "/accounts/beta/apply",
    payload: { email: "queue@example.com" },
  });
  assert.equal(again.json().status, "pending");
  const listed = await app.inject({ method: "GET", url: "/api/admin/beta-waitlist", headers: adminHeaders });
  assert.equal(listed.json().requests.filter((r: { email: string }) => r.email === "queue@example.com").length, 1);

  // 后台批量通过 → 进白名单 → 该邮箱可注册
  const approve = await app.inject({
    method: "POST",
    url: "/api/admin/beta-waitlist/approve",
    headers: adminHeaders,
    payload: { emails: ["queue@example.com"] },
  });
  assert.equal(approve.statusCode, 200);
  assert.deepEqual(approve.json().approved, ["queue@example.com"]);
  const reg = await register(app, "queue@example.com");
  assert.equal(reg.statusCode, 200);

  // 白名单内邮箱再申请：直接告知已在名单（approved + whitelisted），不新增队列行
  const direct = await app.inject({
    method: "POST",
    url: "/accounts/beta/apply",
    payload: { email: "fixed@example.com" },
  });
  assert.equal(direct.json().whitelisted, true);
  assert.equal(direct.json().status, "approved");
});

test("候补删除：整行出队且不动白名单，队列外邮箱静默跳过，已删 pending 可重新申请", async () => {
  const app = buildApp();

  await app.inject({
    method: "POST",
    url: "/accounts/beta/apply",
    payload: { email: "del-pending@example.com" },
  });
  await app.inject({
    method: "POST",
    url: "/accounts/beta/apply",
    payload: { email: "del-passed@example.com" },
  });
  await app.inject({
    method: "POST",
    url: "/api/admin/beta-waitlist/approve",
    headers: adminHeaders,
    payload: { emails: ["del-passed@example.com"] },
  });

  // 大小写混写照旧命中；队列里没有的 ghost 不报错，只返回实际删除的两条
  const del = await app.inject({
    method: "POST",
    url: "/api/admin/beta-waitlist/delete",
    headers: adminHeaders,
    payload: { emails: ["Del-Pending@Example.com", "del-passed@example.com", "ghost@example.com"] },
  });
  assert.equal(del.statusCode, 200);
  assert.deepEqual(del.json().removed.sort(), ["del-passed@example.com", "del-pending@example.com"]);

  const listed = await app.inject({ method: "GET", url: "/api/admin/beta-waitlist", headers: adminHeaders });
  const queued = listed.json().requests.map((r: { email: string }) => r.email);
  assert.equal(queued.includes("del-pending@example.com"), false);
  assert.equal(queued.includes("del-passed@example.com"), false);

  // 删除只清队列：审批时写入的白名单成员原样保留，该邮箱照常注册
  const wl = await app.inject({ method: "GET", url: "/api/admin/beta-whitelist", headers: adminHeaders });
  assert.equal(wl.json().emails.includes("del-passed@example.com"), true);
  assert.equal((await register(app, "del-passed@example.com")).statusCode, 200);

  // 被删的 pending 邮箱重新申请会以 pending 复现（删除不等于拉黑）
  const re = await app.inject({
    method: "POST",
    url: "/accounts/beta/apply",
    payload: { email: "del-pending@example.com" },
  });
  assert.equal(re.json().status, "pending");
  await app.inject({
    method: "POST",
    url: "/api/admin/beta-waitlist/delete",
    headers: adminHeaders,
    payload: { emails: ["del-pending@example.com"] },
  });

  const noAuth = await app.inject({
    method: "POST",
    url: "/api/admin/beta-waitlist/delete",
    payload: { emails: ["del-pending@example.com"] },
  });
  assert.equal(noAuth.statusCode, 401);
  const empty = await app.inject({
    method: "POST",
    url: "/api/admin/beta-waitlist/delete",
    headers: adminHeaders,
    payload: { emails: [] },
  });
  assert.equal(empty.statusCode, 400);
});

test("进度查询端点：none → pending → approved（带下载地址）；白名单内直接 approved", async () => {
  const app = buildApp();

  const none = await app.inject({ method: "GET", url: "/accounts/beta/status?email=st@example.com" });
  assert.equal(none.json().status, "none");

  await app.inject({
    method: "POST",
    url: "/accounts/beta/apply",
    payload: { email: "st@example.com" },
  });
  const pending = await app.inject({ method: "GET", url: "/accounts/beta/status?email=st@example.com" });
  assert.equal(pending.json().status, "pending");
  assert.equal("downloadUrl" in pending.json(), false);

  await app.inject({
    method: "POST",
    url: "/api/admin/beta-waitlist/approve",
    headers: adminHeaders,
    payload: { emails: ["st@example.com"] },
  });
  const approved = await app.inject({ method: "GET", url: "/accounts/beta/status?email=st@example.com" });
  assert.equal(approved.json().status, "approved");
  assert.equal("downloadUrl" in approved.json(), true);

  // 大小写不同写法查询同一结果；白名单内邮箱直接 approved+whitelisted
  const cased = await app.inject({ method: "GET", url: "/accounts/beta/status?email=ST@Example.COM" });
  assert.equal(cased.json().status, "approved");
  const wl = await app.inject({ method: "GET", url: "/accounts/beta/status?email=fixed@example.com" });
  assert.equal(wl.json().whitelisted, true);
  assert.equal(wl.json().status, "approved");
});

test("公开 /beta 申请页渲染：含申请表单与进度面板，正则转义正确", async () => {
  const app = buildApp();

  const res = await app.inject({ method: "GET", url: "/beta" });
  assert.equal(res.statusCode, 200);
  for (const c of ["申请 / 查询进度", "accounts/beta/status", "accounts/beta/apply", "下载安装包"]) {
    if (!res.body.includes(c)) throw new Error("/beta 页缺片段: " + c);
  }
  // 渲染产物（浏览器所见）必须含单反斜杠 \s 正则；塌缩成 [^s@] 即为转义丢失
  assert.ok(res.body.includes("^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$"), "渲染产物应为 \\s 正则");
  assert.ok(!/\[\^s@\]/.test(res.body), "正则塌缩成 [^s@]，浏览器端会误拦带 s 邮箱");
});

test("审批通过触发邮件通知：配了 SMTP 就发（含下载地址），没配优雅跳过且审批不受影响", async () => {
  // —— 场景一：注入假邮件服务（isEmailEnabled=true），断言发出且带下载链接 ——
  fs.writeFileSync(path.join(tmpDir, "config-manifest.json"), "{}");
  fs.mkdirSync(path.join(tmpDir, "config"), { recursive: true });
  fs.writeFileSync(
    path.join(tmpDir, "config", "client-manifest.json"),
    JSON.stringify({ latest: "0.1.0", minVersion: "0.1.0", url: "http://dl.example/Setup.exe", notes: "", channel: "byok" }),
  );
  const sent: Array<{ to: string; subject: string; body: string; html: string }> = [];
  const mailDeps = {
    ...deps,
    emailSmsService: {
      isEmailEnabled: () => true,
      sendEmail: async (p: { to: string; subject: string; body: string; html: string }) => {
        sent.push(p);
        return { ok: true, messageId: "m1", to: p.to, summary: "fake" };
      },
    },
  } as unknown as HttpRouteDeps;
  const mailApp = Fastify({ logger: false });
  registerAccountRoutes(mailApp, mailDeps);
  registerAdminConsoleRoutes(mailApp, mailDeps);

  await mailApp.inject({
    method: "POST",
    url: "/accounts/beta/apply",
    payload: { email: "mailme@example.com" },
  });
  const approve = await mailApp.inject({
    method: "POST",
    url: "/api/admin/beta-waitlist/approve",
    headers: adminHeaders,
    payload: { emails: ["mailme@example.com"] },
  });
  assert.equal(approve.statusCode, 200);
  assert.equal(approve.json().notified.emailSent, 1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, "mailme@example.com");
  assert.match(sent[0].subject, /内测申请已通过/);
  assert.match(sent[0].html, /href="http[^"]+\.(exe|zip)"/);
  assert.match(sent[0].body, /mailme@example\.com/);

  // —— 场景二：未配置邮件服务（deps 无 emailSmsService），审批照常成功 ——
  const plainApp = buildApp();
  await plainApp.inject({
    method: "POST",
    url: "/accounts/beta/apply",
    payload: { email: "nomail@example.com" },
  });
  const approve2 = await plainApp.inject({
    method: "POST",
    url: "/api/admin/beta-waitlist/approve",
    headers: adminHeaders,
    payload: { emails: ["nomail@example.com"] },
  });
  assert.equal(approve2.statusCode, 200);
  assert.equal(approve2.json().approved[0], "nomail@example.com");
  const reg = await register(plainApp, "nomail@example.com");
  assert.equal(reg.statusCode, 200);
});
