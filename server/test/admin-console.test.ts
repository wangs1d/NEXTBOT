import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import test from "node:test";
import assert from "node:assert/strict";

/**
 * 管理后台域测试：共享鉴权门 / 反馈 SQLite 存储与权限边界 /
 * 支付订单台账（只记真实订单，模拟单不落库）/ 用户禁用 API 与对话禁用门。
 *
 * 用真实 fastify 实例 + inject（不起监听端口）。
 * 运行：npx tsx --test test/admin-console.test.ts
 */

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "admin-console-test-"));
const TEST_TOKEN = "test-admin-token-12345";
delete process.env.ADMIN_UPLOAD_TOKEN;
process.env.FEEDBACK_DB = path.join(tmpDir, "feedback.db");
process.env.PAYMENT_LEDGER_DB = path.join(tmpDir, "payment", "orders.db");
process.env.AGENT_ACCOUNTS_FILE = path.join(tmpDir, "agent-accounts.json");
// 隔离管理员凭据库：本机 data/admin-auth.db 已设置过管理员时
// hasAdminCredential()=true，未配置 token 的用例会 401 而非 503（环境耦合失败）。
process.env.ADMIN_AUTH_DB = path.join(tmpDir, "admin-auth.db");

const { registerFeedbackRoutes, feedbackStatusCounts } = await import(
  "../src/routes/http/feedback.js"
);
const { registerAdminConsoleRoutes } = await import("../src/routes/http/admin-console.js");
const { AgentAccountService } = await import("../src/services/agent-account-service.js");
const { PaymentService } = await import("../src/services/payment-service.js");
const { getPaymentOrderLedger, PaymentOrderLedger } = await import(
  "../src/services/payment-order-ledger.js"
);
const { isActorDisabled } = await import("../src/services/user-disable-gate.js");
const { default: Fastify } = await import("fastify");
type HttpRouteDeps = import("../src/routes/http/types.js").HttpRouteDeps;

const accountService = new AgentAccountService();
await accountService.load();
const paymentService = new PaymentService();

/** 管理台路由只需少数依赖，其余以 null/缺省占位。 */
const deps = {
  agentAccountService: accountService,
  paymentService,
} as unknown as HttpRouteDeps;

function buildApp(): ReturnType<typeof Fastify> {
  const app = Fastify({ logger: false });
  registerFeedbackRoutes(app);
  registerAdminConsoleRoutes(app, deps);
  return app;
}

const adminHeaders = { "x-admin-token": TEST_TOKEN };

test("ADMIN_UPLOAD_TOKEN 未配置时管理接口返回 503", async () => {
  // 顶层 delete 不可靠：import 链上的模块会从本机 .env 把 ADMIN_UPLOAD_TOKEN
  // 重新灌回 process.env。用例内显式置空串（trim 后为空 = 未配置），请求前生效。
  const prevToken = process.env.ADMIN_UPLOAD_TOKEN;
  process.env.ADMIN_UPLOAD_TOKEN = "";
  try {
    const app = buildApp();
    const res = await app.inject({ method: "GET", url: "/api/admin/overview" });
    assert.equal(res.statusCode, 503);
    await app.close();
  } finally {
    if (prevToken === undefined) delete process.env.ADMIN_UPLOAD_TOKEN;
    else process.env.ADMIN_UPLOAD_TOKEN = prevToken;
  }
});

test("配置 token 后：错误 token 401、正确 token 200", async () => {
  process.env.ADMIN_UPLOAD_TOKEN = TEST_TOKEN;
  const app = buildApp();
  const bad = await app.inject({ method: "GET", url: "/api/admin/overview", headers: { "x-admin-token": "wrong" } });
  assert.equal(bad.statusCode, 401);
  const good = await app.inject({ method: "GET", url: "/api/admin/overview", headers: adminHeaders });
  assert.equal(good.statusCode, 200);
  const body = good.json();
  assert.equal(body.ok, true);
  assert.equal(typeof body.users.total, "number");
  await app.close();
});

test("反馈：提交开放；全量列表与状态流转须管理员；按身份查询保持开放", async () => {
  const app = buildApp();

  const submit = await app.inject({
    method: "POST",
    url: "/api/feedback",
    payload: { userId: "user-fb-1", type: "bug", title: "闪退", description: "点开设置就闪退" },
  });
  assert.equal(submit.statusCode, 200);
  const record = submit.json().feedback;
  assert.equal(record.status, "open");

  // 无 token 全量列表 → 401
  const listNoAuth = await app.inject({ method: "GET", url: "/api/feedback" });
  assert.equal(listNoAuth.statusCode, 401);
  // 带 token 全量列表 → 200
  const listAuth = await app.inject({ method: "GET", url: "/api/feedback", headers: adminHeaders });
  assert.equal(listAuth.statusCode, 200);
  assert.ok(listAuth.json().total >= 1);

  // 客户端按身份查自己的反馈 → 开放
  const mine = await app.inject({ method: "GET", url: "/api/feedback?actorId=user-fb-1&userId=user-fb-1" });
  assert.equal(mine.statusCode, 200);
  assert.equal(mine.json().total, 1);

  // 状态流转：无 token 401；带 token 200 并写审计
  const statusNoAuth = await app.inject({
    method: "POST",
    url: `/api/feedback/${record.id}/status`,
    payload: { status: "resolved", replyNote: "已修复" },
  });
  assert.equal(statusNoAuth.statusCode, 401);
  const statusAuth = await app.inject({
    method: "POST",
    url: `/api/feedback/${record.id}/status`,
    headers: adminHeaders,
    payload: { status: "resolved", replyNote: "已修复" },
  });
  assert.equal(statusAuth.statusCode, 200);
  assert.equal(statusAuth.json().feedback.status, "resolved");
  assert.equal(statusAuth.json().feedback.replyNote, "已修复");

  const counts = await feedbackStatusCounts();
  assert.equal(counts.resolved, 1);
  await app.close();
});

test("支付：台账只记真实订单（模拟单不落库、历史 mock 行打开时清理）", async () => {
  process.env.ADMIN_UPLOAD_TOKEN = TEST_TOKEN;
  const app = buildApp();

  // 模拟下单（测试环境无凭证 → mock 模式）：留在进程内 Map，不进台账
  await paymentService.createOrder({
    amount: 9.9,
    description: "台账测试商品",
    provider: "wechat",
    method: "native",
  });

  // 直接落一笔真实（live）订单
  getPaymentOrderLedger().record({
    outTradeNo: "LIVE-TEST-0001",
    actorId: "admin-console-test@local",
    provider: "alipay",
    method: "native",
    amount: 66,
    description: "真实通道订单",
    mode: "live",
    status: "paid",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    paidAt: new Date().toISOString(),
  });

  const res = await app.inject({ method: "GET", url: "/api/admin/orders", headers: adminHeaders });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.enabled, true);
  assert.equal(body.stats.total, 1);
  assert.equal(body.stats.paid, 1);
  assert.equal(body.stats.paidAmount, 66);
  const row = body.orders.find((o: { description: string }) => o.description === "真实通道订单");
  assert.ok(row, "后台应能查到真实订单");
  assert.equal(row.status, "paid");
  assert.ok(row.paidAt, "真实订单应带支付时间");
  assert.ok(
    !body.orders.some((o: { description: string }) => o.description === "台账测试商品"),
    "模拟订单不应出现在后台订单接口",
  );

  // 历史 mock 行清理：新开台账连接（open 时清一次）后不可再见，真实订单保留
  new PaymentOrderLedger().record({
    outTradeNo: "MOCK-LEGACY-1",
    actorId: "admin-console-test@local",
    provider: "wechat",
    method: "native",
    amount: 1,
    description: "历史模拟单",
    mode: "mock",
    status: "pending",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    paidAt: null,
  });
  const after = new PaymentOrderLedger().list(100);
  assert.ok(!after.some((o) => o.mode === "mock"), "打开台账时应清理历史 mock 行");
  assert.ok(after.some((o) => o.outTradeNo === "LIVE-TEST-0001"), "真实订单保留");

  await app.close();
});

test("用户禁用：API 生效、写审计、对话门拦截", async () => {
  process.env.ADMIN_UPLOAD_TOKEN = TEST_TOKEN;
  const app = buildApp();
  await accountService.register("user-dis-1", "被禁用用户");

  const disable = await app.inject({
    method: "POST",
    url: "/api/admin/users/user-dis-1/disabled",
    headers: adminHeaders,
    payload: { disabled: true },
  });
  assert.equal(disable.statusCode, 200);
  assert.equal(accountService.getByActorId("user-dis-1")?.disabled, true);
  assert.equal(await isActorDisabled("user-dis-1"), true, "禁用门应读到文件里的禁用标记");

  const enable = await app.inject({
    method: "POST",
    url: "/api/admin/users/user-dis-1/disabled",
    headers: adminHeaders,
    payload: { disabled: false },
  });
  assert.equal(enable.statusCode, 200);
  assert.equal(accountService.getByActorId("user-dis-1")?.disabled, undefined);
  assert.equal(await isActorDisabled("user-dis-1"), false);

  // 不存在的用户 404
  const missing = await app.inject({
    method: "POST",
    url: "/api/admin/users/nobody/disabled",
    headers: adminHeaders,
    payload: { disabled: true },
  });
  assert.equal(missing.statusCode, 404);

  // 禁用操作进了审计
  const audit = await app.inject({ method: "GET", url: "/api/admin/audit", headers: adminHeaders });
  assert.equal(audit.statusCode, 200);
  const actions = audit.json().entries.map((e: { action: string }) => e.action);
  assert.ok(actions.includes("user.disable"), "审计应包含 user.disable");
  assert.ok(actions.includes("user.enable"), "审计应包含 user.enable");
  await app.close();
});

test("系统状态与服务配置接口返回完整结构", async () => {
  process.env.ADMIN_UPLOAD_TOKEN = TEST_TOKEN;
  const app = buildApp();

  const sys = await app.inject({ method: "GET", url: "/api/admin/system", headers: adminHeaders });
  assert.equal(sys.statusCode, 200);
  const s = sys.json();
  assert.equal(s.ok, true);
  assert.ok(s.server.uptimeMs >= 0);
  assert.ok(typeof s.storage.dataDir.totalBytes, "number");
  assert.ok(s.deps && "model" in s.deps && "redis" in s.deps && "qdrant" in s.deps);
  assert.ok(s.jobs && typeof s.jobs.total === "number");

  const cfg = await app.inject({ method: "GET", url: "/api/admin/config", headers: adminHeaders });
  assert.equal(cfg.statusCode, 200);
  const c = cfg.json();
  assert.equal(c.ok, true);
  assert.ok(c.payment.wechat && c.payment.alipay);
  // 密钥绝不回传，只回传是否已设置
  assert.equal(typeof c.payment.wechat.apiKeySet, "boolean");
  assert.equal(c.payment.wechat.apiKey, undefined);
  await app.close();
});

test("最近活跃：register/touch 记录 lastActiveAt，落盘 60s 节流", async () => {
  const svc = new AgentAccountService();
  await svc.load();
  const acc = await svc.register("active-user-1", "活跃用户");
  assert.ok(acc.lastActiveAt, "注册即记一次活跃");

  // 第一次 touch：距上次落盘超过节流窗 → 应写穿文件（异步写，等它落地）
  svc.touchLastActive("active-user-1");
  await new Promise((r) => setTimeout(r, 80));
  const persisted = new AgentAccountService();
  await persisted.load();
  const touchedAt = persisted.getByActorId("active-user-1")?.lastActiveAt;
  assert.ok(touchedAt, "touch 应落盘 lastActiveAt");

  // 第二次 touch 在 60s 节流窗内：内存即时更新、不再落盘
  svc.touchLastActive("active-user-1", new Date(Date.now() + 5000));
  assert.notEqual(
    svc.getByActorId("active-user-1")?.lastActiveAt, touchedAt,
    "节流窗内的 touch 仍应即时更新内存值",
  );
  await new Promise((r) => setTimeout(r, 80));
  const reread = new AgentAccountService();
  await reread.load();
  assert.equal(
    reread.getByActorId("active-user-1")?.lastActiveAt, touchedAt,
    "节流窗内的第二次 touch 不应额外落盘",
  );
  // 未知主体静默忽略
  svc.touchLastActive("nobody-touch");
});

test("用户/概览接口：返回 lastActiveAt 与活跃统计；待办计数接口可用", async () => {
  process.env.ADMIN_UPLOAD_TOKEN = TEST_TOKEN;
  const app = buildApp();

  await accountService.register("active-user-2", "活跃用户2");
  accountService.touchLastActive("active-user-2");

  const users = await app.inject({ method: "GET", url: "/api/admin/users", headers: adminHeaders });
  assert.equal(users.statusCode, 200);
  const uj = users.json();
  const row = uj.users.find((u: { userId: string }) => u.userId === "active-user-2");
  assert.ok(row, "用户列表应包含刚注册用户");
  assert.ok(row.lastActiveAt, "用户行应带 lastActiveAt");
  assert.ok(uj.stats.activeToday >= 1, "今日活跃应至少 1（刚 touch 过）");
  assert.equal(typeof uj.stats.active7d, "number");

  const overview = await app.inject({ method: "GET", url: "/api/admin/overview", headers: adminHeaders });
  assert.equal(overview.statusCode, 200);
  const oj = overview.json();
  assert.ok(oj.users.activeToday >= 1, "概览应含今日活跃");
  assert.equal(typeof oj.users.active7d, "number");
  assert.ok(Array.isArray(oj.orders?.series), "概览应含收入趋势 series");
  assert.equal(oj.orders.series.length, 14, "收入趋势应为近 14 天");
  // 上一用例/支付用例落过 live 已付订单 → 今日金额应大于 0
  const today = oj.orders.series[oj.orders.series.length - 1];
  assert.ok(today.count > 0, "今日收入应大于 0（台账有 live 已付单）");

  const pending = await app.inject({ method: "GET", url: "/api/admin/pending-counts", headers: adminHeaders });
  assert.equal(pending.statusCode, 200);
  const pj = pending.json();
  assert.equal(pj.ok, true);
  assert.equal(typeof pj.feedbackOpen, "number");
  assert.equal(typeof pj.waitlistPending, "number");
  assert.equal(pj.waitlistPending, 0, "测试环境候补服务未装配时应为 0");
  await app.close();
});

test("反馈最老待处理：有 open 时返回 oldestOpenAt，全部流转后为 null", async () => {
  process.env.ADMIN_UPLOAD_TOKEN = TEST_TOKEN;
  const app = buildApp();

  const submit = await app.inject({
    method: "POST",
    url: "/api/feedback",
    payload: {
      type: "bug",
      title: "最老待处理测试",
      description: "检查 oldestOpenAt",
      userId: "user-oldest-1",
      clientVersion: "0.1.0",
      platform: "windows-x64",
    },
  });
  assert.equal(submit.statusCode, 200);
  const id = submit.json().feedback.id;

  let counts = await feedbackStatusCounts();
  if (counts.open > 0) {
    assert.ok(counts.oldestOpenAt, "有待处理时 oldestOpenAt 应有值");
  }

  const resolve = await app.inject({
    method: "POST",
    url: `/api/feedback/${id}/status`,
    headers: adminHeaders,
    payload: { status: "resolved", replyNote: "已处理" },
  });
  assert.equal(resolve.statusCode, 200);

  counts = await feedbackStatusCounts();
  if (counts.open === 0) {
    assert.equal(counts.oldestOpenAt, null, "无待处理时 oldestOpenAt 应为 null");
  }
  await app.close();
});
