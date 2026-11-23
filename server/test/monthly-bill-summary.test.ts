/**
 * 「钱的月报」月报卡单测（PRD §9，2026-11-24）。
 *
 * 钉住验收口径的三件事：
 *   1. **合计误差 0**：卡片总额与台账明细逐笔相加**在「分」这个整数位上完全相等**。
 *      用整数分而不是浮点累加比较：总额出自 ledger 的 summary（落盘前四舍五入到分），
 *      明细逐笔浮点相加的次序会带来 1e-13 级尾差，那不是"误差"而是二进制表示噪声；
 *      分位相等才是"误差 0"的可执行定义，且任何"另写一套聚合"都会立刻在分位露馅。
 *   2. **1 日切换**：每月 1 日小结锚定上一整月（complete=true），其余日期是本月进行中；
 *   3. **推送不带金额**：pushText 只含月份数字，正则扫不到任何金额写法。
 * 另覆盖环比、Top3 类目、最大单笔、覆盖率提示、续费预告（≤1 天）、类目纠正回灌。
 *
 * 测试封闭：内存台账 + 注入时钟 + 假订阅服务，不写仓库数据目录、不打外网。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BillParcelLedger, type BillParcelEntry } from "../src/services/bill-parcel-ledger.js";
import {
  buildMonthlyBillSummary,
  buildMonthlyPushText,
  projectRenewalIntoWindow,
  resolveMonthlyWindow,
} from "../src/services/monthly-bill-summary.js";
import { classifyBillParcel } from "../src/services/bill-parcel-classifier.js";
import { ConsumptionLedgerListener } from "../src/services/consumption-ledger-listener.js";
import type { FinanceDeepService } from "../src/services/finance-deep-service.js";
import type { SubscriptionRecord } from "../src/services/subscription-audit-service.js";

const NOW = new Date(2026, 10, 15, 9, 30); // 2026-11-15 本地时（11 月进行中）
const NOW_MS = NOW.getTime();

function tempLedger(): { ledger: BillParcelLedger; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "monthly-bill-"));
  const ledger = new BillParcelLedger({ dataPath: dir, now: () => NOW_MS });
  ledger.load();
  return { ledger, dir };
}

/** 本地时刻（不用 ISO 串：Date.parse 按 UTC 解析，东八区整体漂 8h） */
function at(y: number, m: number, d: number, hh = 10): number {
  return new Date(y, m - 1, d, hh, 0, 0, 0).getTime();
}

function addBill(
  ledger: BillParcelLedger,
  input: {
    title: string;
    amount: number | null;
    billType: string | null;
    at: number;
    actorId?: string;
    excerpt?: string;
  },
): BillParcelEntry {
  const added = ledger.add({
    category: "bill",
    source: "sms",
    actorId: input.actorId ?? "u1",
    title: input.title,
    amount: input.amount,
    billType: input.billType,
    trackingNo: null,
    pickupCode: null,
    carrier: null,
    excerpt: input.excerpt ?? input.title,
    occurredAt: input.at,
    id: `${input.title}@${input.at}`,
  });
  assert.equal(added.length, 1, "台账应新增一条");
  return added[0];
}

/** 分位整数和（比较用的"明细合计"口径） */
function detailCents(entries: BillParcelEntry[]): number {
  return entries.reduce((acc, e) => acc + Math.round((e.amount ?? 0) * 100), 0);
}

/** 样例台账：11 月 4 笔（含 1 笔无金额）+ 10 月 3 笔 + 1 条快递、1 条他人账单干扰 */
function seed(ledger: BillParcelLedger): void {
  addBill(ledger, { title: "话费 ¥59.00", amount: 59, billType: "话费通信", at: at(2026, 11, 3) });
  addBill(ledger, { title: "水电 ¥141.50", amount: 141.5, billType: "生活缴费", at: at(2026, 11, 8) });
  addBill(ledger, { title: "还款 ¥1,200.20", amount: 1200.2, billType: "还款扣款", at: at(2026, 11, 12) });
  addBill(ledger, { title: "转账", amount: null, billType: "其他", at: at(2026, 11, 14) });
  addBill(ledger, { title: "10 月话费 ¥59.00", amount: 59, billType: "话费通信", at: at(2026, 10, 4) });
  addBill(ledger, { title: "10 月房租 ¥1,800.00", amount: 1800, billType: "生活缴费", at: at(2026, 10, 6) });
  addBill(ledger, { title: "10 月还款 ¥300.00", amount: 300, billType: "还款扣款", at: at(2026, 10, 20) });
  ledger.add({
    category: "parcel",
    source: "sms",
    actorId: "u1",
    title: "快递到驿站 ¥9.90",
    amount: 9.9,
    billType: null,
    trackingNo: "SF123",
    pickupCode: "8-2-3010",
    carrier: "顺丰",
    excerpt: "快递到驿站",
    occurredAt: at(2026, 11, 9),
  });
  addBill(ledger, {
    title: "别人的账单 ¥9999",
    amount: 9999,
    billType: "还款扣款",
    at: at(2026, 11, 10),
    actorId: "u2",
  });
}

// ------------------------------------------------------------------ //
// 1. 合计与明细逐笔相加误差 0
// ------------------------------------------------------------------ //

test("月报合计 = 台账明细逐笔合计（分位误差 0），且不含快递/他人条目", async () => {
  const { ledger, dir } = tempLedger();
  try {
    seed(ledger);
    const w = resolveMonthlyWindow(NOW);
    const digest = await buildMonthlyBillSummary({ ledger }, "u1", NOW);

    const detail = ledger
      .list({ category: "bill", actorId: "u1", since: w.from, until: w.to + 1, limit: 1000 })
      .filter((e) => e.amount != null);

    assert.equal(
      Math.round(digest.totals.totalAmount * 100),
      detailCents(detail),
      "卡片总额必须与明细逐笔相加在分位完全相等",
    );
    assert.equal(digest.totals.totalAmount, 1400.7);
    assert.equal(digest.totals.count, 4, "无金额那笔仍计入笔数（覆盖率的分母）");
    assert.equal(digest.totals.amountCount, detail.length);

    // 环比上月同样按明细口径
    const prevDetail = ledger
      .list({ category: "bill", actorId: "u1", since: w.prev.from, until: w.prev.to + 1, limit: 1000 })
      .filter((e) => e.amount != null);
    assert.equal(
      Math.round((digest.previous?.totalAmount ?? -1) * 100),
      detailCents(prevDetail),
      "上月总额同样逐分相等",
    );
    assert.equal(digest.previous?.totalAmount, 2159);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("自然月窗口不把月末/月初边界条目算重或算漏", async () => {
  const { ledger, dir } = tempLedger();
  try {
    addBill(ledger, {
      title: "10月末",
      amount: 10,
      billType: "其他",
      at: new Date(2026, 10, 0, 23, 59, 59, 999).getTime(),
    });
    addBill(ledger, {
      title: "11月初",
      amount: 20,
      billType: "其他",
      at: new Date(2026, 10, 1, 0, 0, 0, 0).getTime(),
    });
    const oct = await buildMonthlyBillSummary({ ledger }, "u1", new Date(2026, 9, 20));
    const nov = await buildMonthlyBillSummary({ ledger }, "u1", NOW);
    assert.equal(oct.totals.totalAmount, 10);
    assert.equal(nov.totals.totalAmount, 20);
    assert.equal(oct.month, "2026-10");
    assert.equal(nov.month, "2026-11");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------ //
// 2. 1 日切换：上一整月 vs 本月进行中
// ------------------------------------------------------------------ //

test("resolveMonthlyWindow：每月 1 日切上一整月完整版，其余日期是本月进行中", () => {
  const first = resolveMonthlyWindow(new Date(2026, 10, 1, 7, 0));
  assert.equal(first.month, "2026-10");
  assert.equal(first.monthLabel, "10月");
  assert.equal(first.monthNumber, 10);
  assert.equal(first.complete, true);
  assert.equal(first.prev.month, "2026-09");
  assert.equal(first.next.month, "2026-11");

  const mid = resolveMonthlyWindow(new Date(2026, 10, 15, 23, 59));
  assert.equal(mid.month, "2026-11");
  assert.equal(mid.complete, false);

  // 跨年：1 月 1 日 → 去年 12 月，环比去年 11 月，预告看今年 1 月
  const ny = resolveMonthlyWindow(new Date(2027, 0, 1));
  assert.equal(ny.month, "2026-12");
  assert.equal(ny.prev.month, "2026-11");
  assert.equal(ny.next.month, "2027-01");
});

test("卡片月份随 1 日切换（1 日看上月，2 日起看本月）", async () => {
  const { ledger, dir } = tempLedger();
  try {
    seed(ledger);
    const onFirst = await buildMonthlyBillSummary({ ledger }, "u1", new Date(2026, 10, 1, 9, 0));
    assert.equal(onFirst.month, "2026-10");
    assert.equal(onFirst.complete, true);
    assert.equal(onFirst.totals.totalAmount, 2159);
    assert.equal(onFirst.pushText, "10月账单小结好了");

    const onSecond = await buildMonthlyBillSummary({ ledger }, "u1", new Date(2026, 10, 2, 9, 0));
    assert.equal(onSecond.month, "2026-11");
    assert.equal(onSecond.complete, false);
    assert.equal(onSecond.pushText, "11月账单小结好了");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------ //
// 3. 推送文案不带金额
// ------------------------------------------------------------------ //

test("pushText 只写月份，不含任何金额写法", async () => {
  const { ledger, dir } = tempLedger();
  try {
    seed(ledger);
    assert.equal(buildMonthlyPushText(11), "11月账单小结好了");
    const digest = await buildMonthlyBillSummary({ ledger }, "u1", NOW);
    const text = digest.pushText;
    assert.equal(text, "11月账单小结好了");
    // 金额的任何写法都不许出现在推送里（§9 加粗要求：不带金额）
    assert.doesNotMatch(text, /[¥￥$]|元|块|万/);
    assert.doesNotMatch(text, /\d+[.．]\d+/); // 任何带小数的数字（=金额写法）
    // 数字只可能是月份号本身：抹掉行首月份号后不应再剩任何数字
    assert.doesNotMatch(text.replace(/^\d+/, ""), /\d/);
    // 且卡片总额确实非 0 —— 证明"没金额"不是"没数据"
    assert.ok(digest.totals.totalAmount > 0);
    assert.ok(digest.largest && digest.largest.amount > 0);
    // 卡片侧该带的金额一个不少（推送与正文是两份文本，不是一句复用）
    assert.match(JSON.stringify(digest.topCategories), /141\.5/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------ //
// 4. 内容：Top3 类目 / 最大单笔 / 环比 / 覆盖率
// ------------------------------------------------------------------ //

test("Top3 类目按金额降序，最大单笔与环比方向正确", async () => {
  const { ledger, dir } = tempLedger();
  try {
    seed(ledger);
    addBill(ledger, { title: "会员 ¥25", amount: 25, billType: "订阅续费", at: at(2026, 11, 11) });
    addBill(ledger, { title: "打车 ¥18", amount: 18, billType: "出行打车", at: at(2026, 11, 11) });
    const digest = await buildMonthlyBillSummary({ ledger }, "u1", NOW);
    assert.equal(digest.topCategories.length, 3, "Top3 封顶");
    assert.deepEqual(
      digest.topCategories.map((c) => c.type),
      ["还款扣款", "生活缴费", "话费通信"],
    );
    assert.equal(digest.topCategories[0].amount, 1200.2);
    // 无金额类目（其他）不进 Top3
    assert.ok(!digest.topCategories.some((c) => c.type === "其他"));
    // 前三类金额 ≤ 总额（比率不会被四舍五入撑破）
    assert.ok(digest.topCategories.reduce((a, c) => a + c.ratio, 0) <= 1.001);
    assert.equal(digest.largest?.amount, 1200.2);
    assert.equal(digest.largest?.billType, "还款扣款");
    assert.equal(digest.mom.direction, "down");
    assert.equal(digest.mom.deltaAmount, 715.3); // 2159 - 1443.7
    assert.equal(digest.mom.ratio, -0.331);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("覆盖率提示：低覆盖时说「有 X 笔没识别到金额」", async () => {
  const { ledger, dir } = tempLedger();
  try {
    seed(ledger);
    const digest = await buildMonthlyBillSummary({ ledger }, "u1", NOW);
    assert.equal(digest.totals.missingAmount, 1);
    assert.equal(digest.coverageHint, "有 1 笔没识别到金额");
    assert.equal(digest.totals.coverage, 0.75);

    const empty = await buildMonthlyBillSummary({ ledger }, "nobody", NOW);
    assert.equal(empty.totals.count, 0);
    assert.equal(empty.totals.coverage, 0);
    assert.equal(empty.coverageHint, "这个月还没有识别到账单");
    assert.equal(empty.totals.totalAmount, 0);
    assert.equal(empty.largest, null);
    assert.deepEqual(empty.topCategories, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("上月为 0 时环比不给百分比（ratio=null），方向按 up", async () => {
  const { ledger, dir } = tempLedger();
  try {
    addBill(ledger, { title: "话费 ¥59.00", amount: 59, billType: "话费通信", at: at(2026, 11, 3) });
    const digest = await buildMonthlyBillSummary({ ledger }, "u1", NOW);
    assert.equal(digest.mom.ratio, null);
    assert.equal(digest.mom.direction, "up");
    assert.equal(digest.mom.deltaAmount, 59);
    assert.equal(digest.previous?.totalAmount, 0);
    assert.equal(digest.coverageHint, "金额都已识别");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------ //
// 5. 订阅 / 续费预告（与实际扣款日偏差 ≤1 天）
// ------------------------------------------------------------------ //

function sub(over: Partial<SubscriptionRecord>): SubscriptionRecord {
  return {
    id: "s1",
    merchant: "视频会员",
    amount: 25,
    periodDays: 30,
    status: "confirmed",
    nextRenewalDate: "2026-11-05",
    lastChargedAt: "2026-10-05",
    createdAt: "2026-10-05",
    updatedAt: "2026-10-05",
    ...over,
  };
}

const dayLabel = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
};

test("续费预告：本月已扣 + 下月预计扣款（月付按日历步进，落在同一天）", async () => {
  const { ledger, dir } = tempLedger();
  try {
    seed(ledger);
    const audit = {
      listSubscriptions: async () => [
        sub({}),
        sub({
          id: "s2",
          merchant: "云盘",
          amount: 30,
          nextRenewalDate: "2026-12-20",
          lastChargedAt: "2026-11-20",
        }),
        sub({
          id: "s3",
          merchant: "季付软件",
          amount: 300,
          periodDays: 90,
          nextRenewalDate: "2026-12-30",
          lastChargedAt: "2026-09-30",
        }),
      ],
    };
    const digest = await buildMonthlyBillSummary({ ledger, subscriptionAudit: audit }, "u1", NOW);
    // 11 月已扣：s2（lastChargedAt 11-20 落在 11 月窗口）
    assert.equal(digest.subscriptions.chargedCount, 1);
    assert.deepEqual(digest.subscriptions.charged.map((c) => c.merchant), ["云盘"]);
    assert.equal(digest.subscriptions.chargedAmount, 30);
    assert.equal(dayLabel(digest.subscriptions.charged[0]!.chargedAt), "2026-11-20");
    // 下月（12 月）预计：视频会员 12-05（日历步进，不是 30 天乘法漂到 12-04）、
    // 云盘 12-20、季付软件 12-30
    const forecast = digest.subscriptions.forecast;
    assert.deepEqual(
      forecast.map((f) => f.merchant).sort(),
      ["云盘", "季付软件", "视频会员"],
    );
    assert.equal(dayLabel(forecast.find((f) => f.merchant === "视频会员")!.expectedAt), "2026-12-5");
    assert.equal(dayLabel(forecast.find((f) => f.merchant === "云盘")!.expectedAt), "2026-12-20");
    assert.equal(dayLabel(forecast.find((f) => f.merchant === "季付软件")!.expectedAt), "2026-12-30");
    assert.equal(digest.subscriptions.forecastAmount, 355);
    assert.equal(digest.subscriptions.forecastCount, 3);
    // 预告按日期升序（客户端一行一条直接贴）
    assert.ok(
      forecast.every((f, i) => i === 0 || f.expectedAt >= forecast[i - 1]!.expectedAt),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("projectRenewalIntoWindow：缺 nextRenewalDate 时用 lastChargedAt + 一期；周付按 7 天；不命中不硬凑", () => {
  const w = resolveMonthlyWindow(new Date(2026, 10, 15)); // 目标 11 月，next = 12 月
  const weekly = sub({
    id: "w",
    merchant: "周报",
    amount: 9,
    periodDays: 7,
    nextRenewalDate: undefined,
    lastChargedAt: "2026-10-28",
  });
  const ms = projectRenewalIntoWindow(weekly, w.next.from, w.next.to);
  assert.ok(ms != null);
  assert.equal(dayLabel(ms), "2026-12-2");
  // 年付在 12 月不扣 → 不硬凑一条预告
  const yearly = sub({
    id: "y",
    merchant: "年假",
    amount: 200,
    periodDays: 365,
    nextRenewalDate: "2027-06-01",
    lastChargedAt: "2026-06-01",
  });
  assert.equal(projectRenewalIntoWindow(yearly, w.next.from, w.next.to), null);
  // 两个日期都没有 → 无锚点
  assert.equal(
    projectRenewalIntoWindow(
      sub({ id: "n", nextRenewalDate: undefined, lastChargedAt: undefined }),
      w.next.from,
      w.next.to,
    ),
    null,
  );
});

test("订阅服务取数抛错不影响月报主体", async () => {
  const { ledger, dir } = tempLedger();
  try {
    seed(ledger);
    const digest = await buildMonthlyBillSummary(
      {
        ledger,
        subscriptionAudit: {
          listSubscriptions: async () => {
            throw new Error("boom");
          },
        },
      },
      "u1",
      NOW,
    );
    assert.equal(digest.totals.totalAmount, 1400.7);
    assert.equal(digest.subscriptions.forecastCount, 0);
    assert.equal(digest.pushText, "11月账单小结好了");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------ //
// 6. 类目可改 → 分类器训练数据
// ------------------------------------------------------------------ //

test("setBillType 回写台账并标记为纠正样本，识别器下一次学到该新词", () => {
  const { ledger, dir } = tempLedger();
  try {
    // 原文里没有任何内置规则认识的词（这正是需要学习的场景）
    const e = addBill(ledger, {
      title: "账单 ¥12.00",
      amount: 12,
      billType: "其他",
      at: at(2026, 11, 4),
      excerpt: "宽带包月, 业务已受理, 本月 12.00",
    });
    const updated = ledger.setBillType(e.id, "u1", "宽带费", NOW_MS);
    assert.ok(updated, "纠正应命中条目");
    assert.equal(updated?.billType, "宽带费");
    assert.equal(updated?.correctedBillType, "宽带费");
    assert.equal(updated?.correctedAt, NOW_MS);

    const corrections = ledger.corrections("u1");
    assert.equal(corrections.length, 1);
    assert.equal(corrections[0].billType, "宽带费");

    const asSamples = corrections.map((c) => ({ text: c.text, billType: c.billType }));
    // 同一段新文本（规则表完全不认识）现在按纠正结果识别
    const learned = classifyBillParcel({ title: "", text: "宽带包月 已受理 30.00" }, { corrections: asSamples });
    assert.deepEqual(learned.categories, ["bill"]);
    assert.equal(learned.billType, "宽带费");
    assert.ok(learned.labels.includes("人工纠正样本"), "标签里留痕：这条是学来的");

    // 没纠正时的同一段文本：规则不认识 → 不进汇总
    const naive = classifyBillParcel({ title: "", text: "宽带包月 已受理 30.00" });
    assert.equal(naive.categories.length, 0);

    // 归属不符 / 条目不存在 → 不动
    assert.equal(ledger.setBillType(e.id, "u9", "随便改"), null);
    assert.equal(ledger.setBillType("nope", "u1", "随便改"), null);
    assert.equal(ledger.setBillType(e.id, "u1", "   "), null);
    // 改成同值幂等：不刷新 correctedAt（不重复投训练样本）
    const again = ledger.setBillType(e.id, "u1", "宽带费", NOW_MS + 99999);
    assert.equal(again?.correctedAt, NOW_MS);
    // 别人的纠正样本不进我的索引
    assert.equal(ledger.corrections("u2").length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("学习层不翻案：内置规则词 / 快递 / 验证码不被纠正改写", () => {
  const samples = [
    { text: "宽带包月, 业务已受理, 本月 12.00", billType: "宽带费" },
    { text: "话费充值 50元", billType: "水电费" }, // 误纠正：词本身是规则词 → 不学
  ];
  // ① 话费仍按内置规则走，不被误纠正改成水电费
  const call = classifyBillParcel({ title: "", text: "话费充值成功 50元" }, { corrections: samples });
  assert.equal(call.billType, "话费通信");
  // ② 快递不被改成账单
  const parcel = classifyBillParcel({ title: "", text: "快递到驿站，取件码 8-2-3010" }, { corrections: samples });
  assert.deepEqual(parcel.categories, ["parcel"]);
  assert.equal(parcel.billType, null);
  // ③ 纯验证码不被学习层拉成账单（验证码仍不进汇总）
  const otp = classifyBillParcel({ title: "", text: "宽带包月验证码 123456" }, { corrections: samples });
  assert.equal(otp.categories.length, 0);
  assert.equal(otp.isOtpOnly, true);
});

// ------------------------------------------------------------------ //
// 7. 台账 summary 的窗口口径（绝对区间 vs 滚动 days）
// ------------------------------------------------------------------ //

test("summary 绝对区间与 days 滚动窗口共用一套聚合；largest 落在此", async () => {
  const { ledger, dir } = tempLedger();
  try {
    seed(ledger);
    const w = resolveMonthlyWindow(NOW);
    const abs = ledger.summary({ actorId: "u1", from: w.from, to: w.to });
    assert.equal(abs.bills.totalAmount, 1400.7);
    assert.equal(abs.window.from, w.from);
    assert.equal(abs.window.to, w.to);
    assert.equal(abs.bills.largest?.amount, 1200.2);
    // largest 带条目 id → 明细可直接定位（月报卡「点开看明细」的跳转凭据）
    assert.equal(ledger.get(abs.bills.largest!.id)?.amount, abs.bills.largest?.amount);
    // 滚动 30 天口径未被改动（窗口起点仍是 now-30d，把 10 月那几笔也算进来）
    const rolling = ledger.summary({ actorId: "u1", days: 30 });
    assert.equal(rolling.window.days, 30);
    assert.equal(rolling.window.from, NOW_MS - 30 * 86_400_000);
    assert.ok(rolling.bills.count > abs.bills.count, "滚动 30 天含 10 月下旬条目");
    const digest = await buildMonthlyBillSummary({ ledger }, "u1", NOW);
    assert.equal(digest.totals.totalAmount, abs.bills.totalAmount, "卡片与 summary 同一个数");
    assert.equal(ledger.actorIds().sort().join(","), "u1,u2");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------ //
// 8. 月度推送的触发点：挂在既有每日扫描上（不新起定时器）
// ------------------------------------------------------------------ //

test("月度小结只由既有每日扫描在 1 日触发一次；文案不含金额", async () => {
  const { ledger, dir } = tempLedger();
  try {
    seed(ledger);
    // 订阅只挂在 u1 名下（u2 只有账单，无订阅）——空数据的人不该被打扰
    const audit = {
      listSubscriptions: async (actorId: string) => (actorId === "u1" ? [sub({})] : []),
    };
    const financeStub = {
      listActorIds: () => ["u1"],
      getBudgetStatus: () => [],
      analyzeSpending: () => ({
        byCategory: [],
        totalExpense: 0,
        totalIncome: 0,
        net: 0,
        count: 0,
        trend: "flat",
      }),
    } as unknown as FinanceDeepService;

    const pushes: Array<{ actorId: string; text: string }> = [];
    const listener = new ConsumptionLedgerListener({
      financeDeepService: financeStub,
      monthStartExtraActors: () => ledger.actorIds(),
      onMonthStart: async (actorId, now) => {
        const digest = await buildMonthlyBillSummary({ ledger, subscriptionAudit: audit }, actorId, now);
        if (digest.totals.count === 0 && digest.subscriptions.forecastCount === 0) return;
        pushes.push({ actorId, text: digest.pushText });
      },
    });

    // 月中：每日扫描照跑，但不该有月度推送
    await listener.runDailyScan(new Date(2026, 10, 15, 9, 0));
    assert.equal(pushes.length, 0, "非 1 日不推");

    // 1 日：推一次，且推的是上月号（卡片同口径）
    await listener.runDailyScan(new Date(2026, 10, 1, 9, 0));
    assert.deepEqual(pushes, [{ actorId: "u1", text: "10月账单小结好了" }]);

    // 台账里没有的 actor 不会被 monthStartExtraActors 重复带出来；同日重扫由
    // tickScan 的 lastScanDay 兜住（此处直调 runDailyScan，验的是覆盖面不重复）
    await listener.runDailyScan(new Date(2026, 10, 1, 13, 0));
    assert.equal(pushes.length, 2, "actor 覆盖 = finance ∪ 台账，去重后每人一条");
    for (const p of pushes) assert.doesNotMatch(p.text, /[¥￥$]|元|\d+[.．]\d+/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
