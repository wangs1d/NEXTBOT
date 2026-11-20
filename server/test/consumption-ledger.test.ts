// Task 16 消费管家闭环测试：
//  1. tool.executed 事件 → 消费类工具自动入账（金额/分类映射/来源工具）
//  2. 非消费工具不入账；同订单指纹去重
//  3. 预算超支检测 → onBudgetAlert 单次提醒（同月同分类不重复）
//  4. 月度消费报告：确定性数据拼接 + 单次 LLM 总结 + LLM 缺省退化
//  5. 每日扫描：预算检查 + 每月 1 日触发上月月报
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { HookBus } from "../src/services/hooks/hook-bus.js";
import { FinanceDeepService } from "../src/services/finance-deep-service.js";
import {
  ConsumptionLedgerListener,
  extractLedgerEntry,
  isConsumptionTool,
  summarizeToolPayload,
} from "../src/services/consumption-ledger-listener.js";

const ACTOR = "actor-consumption-test";

async function makeFixture() {
  const dir = await mkdtemp(join(tmpdir(), "consumption-ledger-test-"));
  const finance = new FinanceDeepService(dir);
  await finance.load();
  return { dir, finance };
}

/** 事件派发是 fire-and-forget，flush 等待订阅者完成 */
const flush = () => new Promise((r) => setTimeout(r, 30));

function makeListener(
  finance: FinanceDeepService,
  overrides?: {
    onBudgetAlert?: (actorId: string, message: string) => void;
    onMonthlyReport?: (actorId: string, reportText: string) => void;
    llmComplete?: (prompt: string) => Promise<string>;
  },
) {
  const alerts: string[] = [];
  const reports: string[] = [];
  const listener = new ConsumptionLedgerListener({
    financeDeepService: finance,
    onBudgetAlert:
      overrides?.onBudgetAlert ??
      ((actorId, message) => {
        alerts.push(`${actorId}: ${message}`);
      }),
    onMonthlyReport:
      overrides?.onMonthlyReport ??
      ((actorId, text) => {
        reports.push(`${actorId}: ${text}`);
      }),
    llmComplete: overrides?.llmComplete,
  });
  return { listener, alerts, reports };
}

// ── 1. 消费事件自动入账 ───────────────────────────────

test("消费管家：restaurant.book 成功事件 → 自动入账（分类映射）", async () => {
  const { dir, finance } = await makeFixture();
  try {
    const { listener } = makeListener(finance);
    const bus = new HookBus();
    listener.subscribe(bus);

    bus.emit(
      "tool.executed",
      {
        toolName: "restaurant.book",
        args: { optionId: "opt-lunch", amountCny: 35.5 },
        result: {
          ok: true,
          simulated: false,
          amountCny: 35.5,
          summary: "中午的外卖",
          provider: "美团",
          orderId: "purchase_123",
        },
        actorId: ACTOR,
        timestamp: new Date().toISOString(),
      },
      { actorId: ACTOR, source: "tool-registry" },
    );
    await flush();

    const txs = finance.getTransactions(ACTOR);
    assert.equal(txs.length, 1);
    assert.equal(txs[0].amount, 35.5);
    assert.equal(txs[0].type, "expense");
    assert.equal(txs[0].category, "餐饮");
    assert.equal(txs[0].source, "booking_tool");
    assert.equal(txs[0].merchant, "美团");
    listener.stop();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("消费管家：payment/ride 事件的分类与类型映射", async () => {
  const { dir, finance } = await makeFixture();
  try {
    const { listener } = makeListener(finance);
    const bus = new HookBus();
    listener.subscribe(bus);

    // 支付下单 → 购物支出
    bus.emit("tool.executed", {
      toolName: "payment.create_order",
      args: { amount: 99, description: "视频会员" },
      result: { amount: 99, description: "视频会员", outTradeNo: "otn-1" },
      actorId: ACTOR,
      timestamp: new Date().toISOString(),
    });
    // 网约车 → 交通支出（amountCny）
    bus.emit("tool.executed", {
      toolName: "ride_hailing.book",
      args: { dropoff: "公司" },
      result: { amountCny: 12.8, summary: "快车行程", orderId: "ride-1" },
      actorId: ACTOR,
      timestamp: new Date().toISOString(),
    });
    await flush();

    const txs = finance.getTransactions(ACTOR);
    assert.equal(txs.length, 2);
    const bySource = new Map(txs.map((t) => [t.source!, t]));
    assert.equal(bySource.get("payment_tool")!.category, "购物");
    assert.equal(bySource.get("payment_tool")!.amount, 99);
    assert.equal(bySource.get("booking_tool")!.category, "交通");
    assert.equal(bySource.get("booking_tool")!.amount, 12.8);
    listener.stop();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("消费管家：非消费工具不入账 + 同订单指纹去重", async () => {
  const { dir, finance } = await makeFixture();
  try {
    const { listener } = makeListener(finance);
    const bus = new HookBus();
    listener.subscribe(bus);

    // 非消费工具（天气查询）→ 不入账
    bus.emit("tool.executed", {
      toolName: "weather.get_local",
      args: {},
      result: { temperature: 28 },
      actorId: ACTOR,
      timestamp: new Date().toISOString(),
    });
    await flush();
    assert.equal(finance.getTransactions(ACTOR).length, 0);

    // 同一订单事件重放两次 → 只入账一次
    const orderEvent = {
      toolName: "payment.create_order",
      args: { amount: 59, description: "外卖订单" },
      result: { amount: 59, description: "外卖订单", outTradeNo: "otn-dup" },
      actorId: ACTOR,
      timestamp: new Date().toISOString(),
    };
    bus.emit("tool.executed", orderEvent, { actorId: ACTOR });
    await flush();
    bus.emit("tool.executed", orderEvent, { actorId: ACTOR });
    await flush();
    assert.equal(finance.getTransactions(ACTOR).length, 1);
    listener.stop();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── 2. 预算超支检测 ──────────────────────────────────

test("消费管家：入账触发预算超支单次提醒（同月同分类不重复）", async () => {
  const { dir, finance } = await makeFixture();
  try {
    // 预先设置餐饮月度预算 ¥100
    finance.setBudget(ACTOR, "餐饮", 100, "monthly");
    const { listener, alerts } = makeListener(finance);
    const bus = new HookBus();
    listener.subscribe(bus);

    // 一笔 ¥120 外卖 → 餐饮超支 → 提醒一次
    bus.emit("tool.executed", {
      toolName: "restaurant.book",
      args: { optionId: "opt-dinner", amountCny: 120 },
      result: { simulated: false, amountCny: 120, summary: "聚餐", provider: "美团", orderId: "p1" },
      actorId: ACTOR,
      timestamp: new Date().toISOString(),
    });
    await flush();
    assert.equal(alerts.length, 1);
    assert.ok(alerts[0].includes("餐饮"));
    assert.ok(alerts[0].includes("超支"));

    // 再来一笔继续超支 → 同月同分类不重复提醒
    bus.emit("tool.executed", {
      toolName: "wallet.purchase",
      args: { category: "food_delivery", amount: 50, description: "宵夜" },
      result: { amount: 50, category: "food_delivery", description: "宵夜", transactionId: "p2" },
      actorId: ACTOR,
      timestamp: new Date().toISOString(),
    });
    await flush();
    assert.equal(alerts.length, 1);
    listener.stop();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── 3. 月度报告 ──────────────────────────────────────

test("消费管家：月报 = 确定性数据 + 单次 LLM 总结", async () => {
  const { dir, finance } = await makeFixture();
  try {
    // 上月消费数据（确定性）
    await finance.importTransactions(ACTOR, [
      { date: "2026-07-05T12:00:00", amount: 880, type: "expense", category: "餐饮" },
      { date: "2026-07-15T12:00:00", amount: 220, type: "expense", category: "交通" },
      { date: "2026-07-20T12:00:00", amount: 1500, type: "expense", category: "购物" },
      { date: "2026-07-10T12:00:00", amount: 5000, type: "income", category: "工资" },
    ]);
    const llmPrompts: string[] = [];
    const { listener, reports } = makeListener(finance, {
      llmComplete: async (prompt) => {
        llmPrompts.push(prompt);
        return "上月你一共花了 2600，大头是购物和餐饮，这个月悠着点。";
      },
    });

    const report = await listener.generateMonthlyReport(ACTOR, new Date("2026-08-01T10:00:00"));

    // LLM 恰好调用一次（克制原则）
    assert.equal(llmPrompts.length, 1);
    // prompt 含确定性数据（LLM 输入是拼接结果）
    assert.ok(llmPrompts[0].includes("2600"));
    // 报告用 LLM 文本
    assert.ok(report.includes("悠着点"));
    // 回调收到报告
    assert.equal(reports.length, 1);
    assert.ok(reports[0].includes(ACTOR));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("消费管家：LLM 未注入时月报退化为确定性文本", async () => {
  const { dir, finance } = await makeFixture();
  try {
    await finance.importTransactions(ACTOR, [
      { date: "2026-07-05T12:00:00", amount: 300, type: "expense", category: "餐饮" },
    ]);
    const { listener } = makeListener(finance); // 无 llmComplete
    const report = await listener.generateMonthlyReport(ACTOR, new Date("2026-08-01T10:00:00"));
    assert.ok(report.includes("2026-07"));
    assert.ok(report.includes("300"));
    assert.ok(report.includes("餐饮"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── 4. 每日扫描 ──────────────────────────────────────

test("消费管家：每日扫描在每月 1 日触发上月月报 + 预算检查", async () => {
  const { dir, finance } = await makeFixture();
  try {
    finance.setBudget(ACTOR, "餐饮", 100, "monthly");
    await finance.importTransactions(ACTOR, [
      { date: new Date().toISOString(), amount: 150, type: "expense", category: "餐饮" },
      { date: "2026-07-05T12:00:00", amount: 400, type: "expense", category: "购物" },
    ]);
    const { listener, alerts, reports } = makeListener(finance, {
      llmComplete: async () => "上月消费小结。",
    });

    // 8 月 1 日扫描：预算超支提醒 + 7 月月报
    await listener.runDailyScan(new Date("2026-08-01T10:00:00"));
    assert.equal(alerts.length, 1); // 餐饮超支
    assert.equal(reports.length, 1); // 7 月月报

    // 非 1 日扫描：只有预算检查（已提醒过不再重复），无新月报
    await listener.runDailyScan(new Date("2026-08-15T10:00:00"));
    assert.equal(alerts.length, 1);
    assert.equal(reports.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── 5. 纯函数单测 ────────────────────────────────────

test("消费管家：isConsumptionTool / extractLedgerEntry / summarizeToolPayload", () => {
  assert.equal(isConsumptionTool("payment.create_order"), true);
  assert.equal(isConsumptionTool("restaurant.book"), true);
  assert.equal(isConsumptionTool("ride_hailing.book"), true);
  assert.equal(isConsumptionTool("shopping.order.place"), true);
  assert.equal(isConsumptionTool("wallet.get_balance"), false);
  assert.equal(isConsumptionTool("ride_hailing.status"), false);
  assert.equal(isConsumptionTool("weather.get_local"), false);

  // 两阶段下单无金额（阶段一）→ 不入账
  assert.equal(
    extractLedgerEntry({
      tool: "shopping.order.place",
      input: { platform: "jd", item: "耳机" },
      result: { ok: true, confirmationToken: "tok", message: "待确认" },
    }),
    null,
  );

  // 摘要化：长字符串截断、金额保留
  const summarized = summarizeToolPayload({
    qrCodeDataUrl: "data:image/png;base64," + "A".repeat(500),
    amount: 66.6,
  }) as Record<string, unknown>;
  assert.ok(String(summarized.qrCodeDataUrl).length < 200);
  assert.ok(String(summarized.qrCodeDataUrl).endsWith("..."));
  assert.equal(summarized.amount, 66.6);
});
