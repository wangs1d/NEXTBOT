// 账单管理服务测试（订阅与财务清理：追踪 / 提醒 / 预算）：
//  1. 登记：周付/月付按 dueDay 推算到期日，季/年/一次性按 dueDate；非法入参拒绝
//  2. 追踪：状态判定（即将到期 / 已逾期 / 正常 / 一次性已缴）+ 月均固定支出折算
//  3. 缴费：顺延周期 + 自动入账（source=bill_payment）+ 分类预算执行进度联动
//  4. 提醒：每日扫描到期前 3 天 / 逾期账单，同一到期日单次；已缴不再提醒
//  5. 持久化：新实例从磁盘读回
//  6. handler：finance.add_bill / finance.pay_bill / finance.cancel_subscription 全链路
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { FinanceDeepService } from "../src/services/finance-deep-service.js";
import {
  BillManagementService,
  billStatusOf,
  monthlyEquivalentOf,
  nextDueDateOf,
  validateBillInput,
} from "../src/services/bill-management-service.js";
import { SubscriptionAuditService } from "../src/services/subscription-audit-service.js";
import {
  createFinanceAddBillHandler,
  createFinanceCancelSubscriptionHandler,
  createFinancePayBillHandler,
  createFinanceSavingsSummaryHandler,
} from "../src/tools/capability-modules/finance-deep/handlers.js";

const ACTOR = "actor-bill-test";

/** 固定时钟：2026-09-03 10:00（周四） */
const NOW = new Date("2026-09-03T10:00:00");
const now = () => new Date(NOW);

async function makeFixture() {
  const dir = await mkdtemp(join(tmpdir(), "bill-mgmt-test-"));
  // 时基贯通：账本与账单管理共用同一冻结时钟，否则预算周期按真实月份归属，
  // 缴费入账后 getBudgetStatus 仍算出 spent=0（时间炸弹）。
  const finance = new FinanceDeepService(dir, now);
  await finance.load();
  const bills = new BillManagementService({ financeDeepService: finance, now });
  return { dir, finance, bills };
}

// ── 1. 登记 ──────────────────────────────────────────

test("validateBillInput：周期与 dueDay/dueDate 匹配才通过", () => {
  assert.equal(
    validateBillInput({ name: "房租", amount: 3500, cadence: "monthly", dueDay: 1 }),
    null,
  );
  assert.equal(
    validateBillInput({ name: "房租", amount: 3500, cadence: "monthly" }),
    "月付账单需要 dueDay（1~31 表示几号）",
  );
  assert.equal(
    validateBillInput({ name: "停车费", amount: 50, cadence: "weekly" }),
    "周付账单需要 dueDay（1~7 表示周一~周日）",
  );
  assert.equal(
    validateBillInput({ name: "车险", amount: 4000, cadence: "yearly" }),
    "季付/年付账单需要 dueDate（下次到期日 YYYY-MM-DD）",
  );
  assert.equal(
    validateBillInput({ name: "押金", amount: 100, cadence: "one_off" }),
    "一次性账单需要 dueDate（下次到期日 YYYY-MM-DD）",
  );
  assert.equal(
    validateBillInput({ name: "", amount: 100, cadence: "monthly", dueDay: 1 }),
    "缺少 name（账单名）",
  );
});

test("addBill：月付/周付自动推算，季/年/一次性用 dueDate；非法返回 null", async () => {
  const { bills } = await makeFixture();
  const rent = await bills.addBill(ACTOR, {
    name: "房租", amount: 3500, cadence: "monthly", dueDay: 10,
  });
  assert.ok(rent);
  assert.equal(nextDueDateOf(rent, NOW), "2026-09-10");

  const net = await bills.addBill(ACTOR, {
    name: "宽带", amount: 20, cadence: "weekly", dueDay: 4, // 周四 = 今天
  });
  assert.ok(net);
  assert.equal(nextDueDateOf(net, NOW), "2026-09-03");

  const insurance = await bills.addBill(ACTOR, {
    name: "车险", amount: 4000, cadence: "yearly", dueDate: "2027-01-15",
  });
  assert.ok(insurance);
  assert.equal(insurance.dueDate, "2027-01-15");

  const deposit = await bills.addBill(ACTOR, {
    name: "押金", amount: 100, cadence: "one_off", dueDate: "2026-09-30",
  });
  assert.ok(deposit);

  // 缺 dueDay / 缺 dueDate → null
  assert.equal(await bills.addBill(ACTOR, { name: "坏账单", amount: 1, cadence: "monthly" }), null);
  assert.equal(
    await bills.addBill(ACTOR, { name: "坏账单", amount: 1, cadence: "quarterly" }),
    null,
  );
});

// ── 2. 追踪 ──────────────────────────────────────────

test("billStatusOf：即将到期（≤3 天）/ 已逾期 / 正常 / 一次性已缴", async () => {
  const { bills } = await makeFixture();
  const rent = (await bills.addBill(ACTOR, { name: "房租", amount: 3500, cadence: "monthly", dueDay: 5 }))!;
  // 9-5 距今 2 天 → due_soon
  assert.deepEqual(billStatusOf(rent, NOW, 3), {
    nextDueDate: "2026-09-05", daysUntilDue: 2, status: "due_soon",
  });

  const water = (await bills.addBill(ACTOR, { name: "水费", amount: 80, cadence: "monthly", dueDay: 1 }))!;
  // 9-1 已过且未缴 → 逾期
  assert.equal(billStatusOf(water, NOW, 3).status, "overdue");
  assert.equal(billStatusOf(water, NOW, 3).daysUntilDue, -2);

  const wifi = (await bills.addBill(ACTOR, { name: "宽带", amount: 99, cadence: "monthly", dueDay: 20 }))!;
  assert.equal(billStatusOf(wifi, NOW, 3).status, "ok");
  assert.equal(billStatusOf(wifi, NOW, 3).nextDueDate, "2026-09-20");

  const deposit = (await bills.addBill(ACTOR, { name: "押金", amount: 100, cadence: "one_off", dueDate: "2026-09-04" }))!;
  assert.equal(billStatusOf(deposit, NOW, 3).status, "due_soon");
  await bills.markBillPaid(ACTOR, deposit.id, { date: "2026-09-03" });
  const refreshed = await bills.describeBill(ACTOR, deposit.id);
  assert.equal(refreshed?.status, "paid");
  assert.equal(refreshed?.nextDueDate, null);
});

test("listBills：月均固定支出折算 + 按紧迫度排序", async () => {
  const { bills } = await makeFixture();
  await bills.addBill(ACTOR, { name: "房租", amount: 3000, cadence: "monthly", dueDay: 20 });
  await bills.addBill(ACTOR, { name: "水电", amount: 300, cadence: "monthly", dueDay: 1 }); // 9-1 已过未缴 → 逾期
  await bills.addBill(ACTOR, { name: "宽带", amount: 70, cadence: "weekly", dueDay: 4 }); // 今天到期，月折算 300
  await bills.addBill(ACTOR, { name: "车险", amount: 3600, cadence: "yearly", dueDate: "2026-12-01" }); // 月折算 300

  const { bills: listed, summary } = await bills.listBills(ACTOR);
  assert.equal(summary.total, 4);
  // 3000 + 300 + 300 + 300 = 3900
  assert.equal(summary.monthlyRecurringTotal, 3900);
  assert.equal(summary.overdueCount, 1);
  assert.equal(summary.dueSoonCount, 1);
  // 逾期最前
  assert.equal(listed[0].bill.name, "水电");
  // 折算：weekly 70×30/7 = 300
  const wifi = listed.find((b) => b.bill.name === "宽带")!;
  assert.equal(monthlyEquivalentOf(wifi.bill), 300);
});

test("月付账单本周期已缴：nextDue 推到下一期，不再提醒", async () => {
  const { bills } = await makeFixture();
  const rent = (await bills.addBill(ACTOR, { name: "房租", amount: 3500, cadence: "monthly", dueDay: 10 }))!;
  // 9-3 缴 9-10 的账单（提前缴）→ lastPaidAt=09-03 ∈ (08-10, 09-10] → 本周期已缴
  await bills.markBillPaid(ACTOR, rent.id, { date: "2026-09-03" });
  const after = await bills.describeBill(ACTOR, rent.id);
  assert.equal(after?.nextDueDate, "2026-10-10");
  assert.equal(after?.status, "ok");
});

// ── 3. 缴费（预算联动） ───────────────────────────────

test("markBillPaid：自动入账 + 预算执行进度联动 + 年付顺延", async () => {
  const { dir, finance, bills } = await makeFixture();
  finance.setBudget(ACTOR, "居住", 4000, "monthly");
  const rent = (await bills.addBill(ACTOR, {
    name: "房租", amount: 3500, cadence: "monthly", dueDay: 10, category: "居住", autopay: true,
  }))!;

  const r = await bills.markBillPaid(ACTOR, rent.id);
  assert.ok(r.ok);
  assert.ok(r.transactionId);
  assert.equal(r.bill?.lastPaidAt, "2026-09-03");
  assert.equal(r.bill?.lastPaidAmount, 3500);

  // 入账：source=bill_payment，类别居住
  const tx = finance.getTransactions(ACTOR).find((t) => t.id === r.transactionId);
  assert.ok(tx);
  assert.equal(tx.source, "bill_payment");
  assert.equal(tx.type, "expense");
  assert.equal(tx.amount, 3500);
  assert.equal(tx.category, "居住");
  assert.equal(tx.merchant, undefined);

  // 预算联动：3500/4000 = 87.5% → warning
  assert.ok(r.budget);
  assert.equal(r.budget.budget.category, "居住");
  assert.equal(r.budget.spent, 3500);
  assert.equal(r.budget.level, "warning");

  // 年付顺延：2026-12-01 缴 → 2027-12-01
  const insurance = (await bills.addBill(ACTOR, {
    name: "车险", amount: 4000, cadence: "yearly", dueDate: "2026-12-01",
  }))!;
  const r2 = await bills.markBillPaid(ACTOR, insurance.id, { date: "2026-12-05", amount: 4200 });
  assert.equal(r2.bill?.dueDate, "2027-12-01");
  assert.equal(r2.bill?.lastPaidAmount, 4200);

  await rm(dir, { recursive: true, force: true });
});

// ── 4. 提醒 ──────────────────────────────────────────

test("runDailyScan：到期前/逾期提醒，同一到期日单次，已缴不再提醒", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bill-scan-test-"));
  // 数据根真实落盘 + listActorIds 桩（登记账单不产生账本 store，参照订阅扫描测试做法）
  const financeStub = {
    getDataRoot: () => dir,
    listActorIds: () => [ACTOR],
    importTransactions: async () => 0,
    getBudgetStatus: () => [],
    getTransactions: () => [],
  } as unknown as FinanceDeepService;
  const bills = new BillManagementService({ financeDeepService: financeStub, now });
  const reminders: string[] = [];
  bills.setOnBillReminder((actorId, message) => reminders.push(`${actorId}: ${message}`));

  await bills.addBill(ACTOR, { name: "水电", amount: 300, cadence: "monthly", dueDay: 5 }); // 2 天后
  await bills.addBill(ACTOR, { name: "水费", amount: 80, cadence: "monthly", dueDay: 1 }); // 逾期 2 天
  await bills.addBill(ACTOR, { name: "宽带", amount: 99, cadence: "monthly", dueDay: 20 }); // 17 天后
  await bills.runDailyScan();
  assert.equal(reminders.length, 1);
  assert.ok(reminders[0].includes("水电"));
  assert.ok(reminders[0].includes("逾期"));
  assert.ok(!reminders[0].includes("宽带"));

  // 同一天再扫：不重复
  await bills.runDailyScan();
  assert.equal(reminders.length, 1);

  // 水电缴清（本周期已缴 → 推到下期）后再扫：两条 key 都已提醒过 → 无新提醒
  const list = await bills.listBills(ACTOR);
  const shuiDian = list.bills.find((b) => b.bill.name === "水电")!;
  await bills.markBillPaid(ACTOR, shuiDian.bill.id, { date: "2026-09-04" });
  const afterPaid = await bills.describeBill(ACTOR, shuiDian.bill.id);
  assert.equal(afterPaid?.status, "ok");
  assert.equal(afterPaid?.nextDueDate, "2026-10-05");
  await bills.runDailyScan();
  assert.equal(reminders.length, 1);

  await rm(dir, { recursive: true, force: true });
});

// ── 5. 持久化 ────────────────────────────────────────

test("账单持久化：新实例从磁盘读回（含缴费历史）", async () => {
  const { dir, finance, bills } = await makeFixture();
  const rent = (await bills.addBill(ACTOR, {
    name: "房租", amount: 3500, cadence: "monthly", dueDay: 10, note: "季度付",
  }))!;
  await bills.markBillPaid(ACTOR, rent.id, { date: "2026-09-02" });

  const bills2 = new BillManagementService({ financeDeepService: finance, now });
  const { bills: loaded } = await bills2.listBills(ACTOR);
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].bill.lastPaidAt, "2026-09-02");
  assert.equal(loaded[0].bill.payments.length, 1);
  assert.equal(loaded[0].bill.note, "季度付");
  assert.equal(loaded[0].nextDueDate, "2026-10-10");

  await rm(dir, { recursive: true, force: true });
});

// ── 6. handler 全链路 ────────────────────────────────

test("handler：finance.add_bill / finance.pay_bill / finance.cancel_subscription", async () => {
  const { dir, finance, bills } = await makeFixture();
  const audit = new SubscriptionAuditService({ financeDeepService: finance, now });
  const ctx = { userId: ACTOR, sessionId: ACTOR };

  // ① 登记账单
  const add = createFinanceAddBillHandler(bills);
  const added = await add(
    { name: "房租", amount: 3500, cadence: "monthly", dueDay: 10, category: "居住" },
    ctx,
  );
  assert.equal(added.ok, true);
  assert.ok(String(added.summary).includes("下次到期 2026-09-10"));
  const billId = (added.bill as { id: string }).id;

  // ② 缴费入账 + 预算联动
  finance.setBudget(ACTOR, "居住", 4000, "monthly");
  const pay = createFinancePayBillHandler(bills);
  const paid = await pay({ billId, date: "2026-09-03" }, ctx);
  assert.equal(paid.ok, true);
  assert.ok(String(paid.summary).includes("已花 ¥3500.00"));
  assert.ok(String(paid.summary).includes("接近上限"));
  assert.ok(paid.budget);

  // ③ 自动取消订阅：不传目标返回建议名单；指定商户退订 + 省钱
  await audit.confirmSubscription(ACTOR, { merchant: "Netflix", amount: 45, periodDays: 30 });
  const cancel = createFinanceCancelSubscriptionHandler(audit);
  const listed = await cancel({}, ctx);
  assert.equal(listed.ok, true);
  assert.equal(listed.cancelled, false);
  assert.equal((listed.candidates as unknown[]).length, 1);
  const cancelled = await cancel({ merchant: "netflix" }, ctx);
  assert.equal(cancelled.ok, true);
  assert.equal(cancelled.cancelled, true);
  assert.ok(String(cancelled.summary).includes("一年 ¥540.00"));
  assert.ok(String(cancelled.summary).includes("取消路径"));

  // ④ 省钱统计
  const savings = await createFinanceSavingsSummaryHandler(audit)({}, ctx);
  assert.equal(savings.ok, true);
  assert.ok(String(savings.summary).includes("每月省下 ¥45.00"));

  await rm(dir, { recursive: true, force: true });
});
