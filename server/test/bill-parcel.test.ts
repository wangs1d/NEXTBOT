/**
 * 账单/快递识别 + 汇总台账 单测（2026-11-13 新增）。
 *
 * 覆盖用户定稿的规则：
 *   「快递|物流|取件码|话费|账单|快递单号 允许进入，只是验证码不需要」
 *   - 六类关键词各自命中 → 进汇总
 *   - 纯验证码 → 不进汇总（但仍标 otpOnly，不算误判）
 *   - 复合内容（账单验证码 / 取件验证码）→ 仍按业务走，不被验证码吃掉
 *   - 字段抽取：金额 / 快递单号 / 取件码 / 承运商
 *   - 台账：去重、汇总口径（只合计写了金额的条目）、按类别查询
 *
 * 测试封闭：全部走内存台账 + 注入时钟，不打外网、不写仓库内数据目录。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  classifyBillParcel,
  extractAmount,
  extractPickupCode,
  extractTrackingNo,
  shouldReportBillParcel,
} from "../src/services/bill-parcel-classifier.js";
import { BillParcelLedger } from "../src/services/bill-parcel-ledger.js";
import { BillParcelIngestService } from "../src/services/bill-parcel-ingest-service.js";
import { DynamicsSettingsStore } from "../src/services/dynamics-settings-store.js";
import { scanSubscriptions } from "../src/services/bill-subscription-scan.js";

const BASE_AT = Date.parse("2026-11-13T10:00:00Z");

function tempLedger(now = () => BASE_AT): { ledger: BillParcelLedger; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "bill-parcel-"));
  const ledger = new BillParcelLedger({ dataPath: dir, now });
  ledger.load();
  return { ledger, dir };
}

// ------------------------------------------------------------------ //
// 分类器
// ------------------------------------------------------------------ //

test("分类器：用户点名的六类关键词各自命中并进汇总", () => {
  const cases: Array<{ text: string; label: string }> = [
    { text: "【XX快递】您的包裹已到达XX驿站，请凭取件码 8-2-3010 取件", label: "取件码" },
    { text: "您有1件快递正在运输中，运单号 SF1234567890", label: "快递" },
    { text: "您的快递已签收，物流已送达", label: "物流" },
    { text: "本月话费已出账，扣款金额 35.50 元", label: "话费" },
    { text: "您的账单已生成，应还金额 128.00元", label: "账单" },
    { text: "快递单号：YT7483920184", label: "快递单号" },
  ];
  for (const c of cases) {
    const m = classifyBillParcel({ text: c.text });
    assert.ok(
      shouldReportBillParcel(m),
      `「${c.text}」应进汇总（${c.label}），实际 categories=${JSON.stringify(m.categories)}`,
    );
    assert.equal(m.isOtpOnly, false, `「${c.text}」不应被判为纯验证码`);
  }
});

test("分类器：纯验证码不进汇总，但仍标 otpOnly（可检索不汇报）", () => {
  const m = classifyBillParcel({ text: "【某银行】您的验证码是 837261，5 分钟内有效，请勿泄露" });
  assert.equal(shouldReportBillParcel(m), false);
  assert.equal(m.isOtpOnly, true);
  assert.deepEqual(m.categories, []);
});

test("分类器：取件码不是验证码（不得被验证码规则吃掉）", () => {
  const m = classifyBillParcel({ text: "取件码 8-2-3010，请到丰巢柜取件" });
  assert.equal(shouldReportBillParcel(m), true);
  assert.deepEqual(m.categories, ["parcel"]);
  assert.equal(m.isOtpOnly, false);
});

test("分类器：复合内容（账单+验证码）按账单走，不被验证码吃掉", () => {
  const m = classifyBillParcel({ text: "您的账单验证码为 123456，本次扣款 12.34 元" });
  assert.equal(shouldReportBillParcel(m), true);
  assert.deepEqual(m.categories, ["bill"]);
  assert.equal(m.amount, 12.34);
});

test("分类器：一条内容可同时命中账单与快递", () => {
  const m = classifyBillParcel({
    text: "您本月话费账单扣款 35.50 元，同时有快递待取，取件码 1234",
  });
  assert.ok(m.categories.includes("bill"));
  assert.ok(m.categories.includes("parcel"));
  assert.equal(m.amount, 35.5);
  assert.equal(m.pickupCode, "1234");
});

test("分类器：话费账单归入话费分组（不被混进总账单）", () => {
  // 回归：话费短信同时含「账单」「扣款」，若「账单/还款」规则在前，
  // 话费会被归进"还款扣款"分组，用户问"这个月话费扣了多少"就答错了。
  const m = classifyBillParcel({ text: "【中国移动】您本月话费账单已出，扣款金额 35.50 元" });
  assert.deepEqual(m.categories, ["bill"]);
  assert.equal(m.billType, "话费通信");
  assert.equal(m.amount, 35.5);
});

test("分类器：普通聊天短信不进汇总", () => {
  const m = classifyBillParcel({ text: "今晚一起吃饭吗？" });
  assert.equal(shouldReportBillParcel(m), false);
  assert.equal(m.isOtpOnly, false);
});

// ------------------------------------------------------------------ //
// 字段抽取
// ------------------------------------------------------------------ //

test("金额抽取：只认带货币锚点的写法，裸数字不抽", () => {
  assert.equal(extractAmount("扣款 12.34 元"), 12.34);
  assert.equal(extractAmount("¥35.50"), 35.5);
  assert.equal(extractAmount("￥8"), 8);
  assert.equal(extractAmount("RMB 19.90"), 19.9);
  assert.equal(extractAmount("人民币 128.00"), 128);
  // 裸数字：短信里绝大多数是单号尾数/日期/数量，抽出来必错
  assert.equal(extractAmount("订单 20260301 数量 2"), null);
});

test("快递单号抽取：必须锚定关键词，不做裸扫", () => {
  assert.equal(extractTrackingNo("快递单号：SF1234567890"), "SF1234567890");
  assert.equal(extractTrackingNo("运单号 7483920184 已发货"), "7483920184");
  // 无关键词的裸数字串不抽
  assert.equal(extractTrackingNo("订单 20260301123456 已支付"), null);
});

test("取件码抽取：锚定抽取，且排除日期形态", () => {
  assert.equal(extractPickupCode("取件码 8-2-3010"), "8-2-3010");
  assert.equal(extractPickupCode("取件码：1234"), "1234");
  assert.equal(extractPickupCode("提货码 A12"), "A12");
  // 纯日期不当成取件码
  assert.equal(extractPickupCode("取件 2026-03-01"), null);
});

test("取件码抽取：全角括号隔断时也能抽到（【取件验证码】123456）", () => {
  // 回归：锚定词后紧跟全角括号时，旧正则断链，码明明在眼前却抽不出来
  assert.equal(extractPickupCode("【取件验证码】123456，请凭此码到驿站取件"), "123456");
  assert.equal(extractPickupCode("【取件码】：8866"), "8866");
});

// ------------------------------------------------------------------ //
// 台账
// ------------------------------------------------------------------ //

test("台账：同一单快递只入一条（跨渠道去重）", () => {
  const { ledger, dir } = tempLedger();
  try {
    const svc = new BillParcelIngestService({ ledger, now: () => BASE_AT });
    const r1 = svc.ingest({
      actorId: "u1",
      source: "sms",
      text: "快递已到驿站，取件码 8-2-3010，运单号 SF1234567890",
    });
    assert.equal(r1.entries.length, 1);

    // 邮件里转述同一单快递：单号一致 → 不应重复入库
    const r2 = svc.ingest({
      actorId: "u1",
      source: "email",
      title: "您的快递已发出",
      text: "运单号 SF1234567890 已发出，请留意查收",
    });
    assert.equal(r2.matched, true);
    assert.equal(r2.entries.length, 0, "同一单号不应重复入台账");

    assert.equal(ledger.list().length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("台账：汇总只合计原文写了金额的条目", () => {
  const { ledger, dir } = tempLedger();
  try {
    const svc = new BillParcelIngestService({ ledger, now: () => BASE_AT });
    svc.ingest({ actorId: "u1", source: "sms", text: "话费扣款 35.50 元" });
    svc.ingest({ actorId: "u1", source: "sms", text: "您有账单待查收，具体金额请登录查看" });
    svc.ingest({ actorId: "u1", source: "sms", text: "顺丰快递已到，取件码 8-2-3010" });

    const s = ledger.summary({ actorId: "u1", days: 30 });
    assert.equal(s.bills.count, 2);
    assert.equal(s.bills.amountCount, 1, "只有一条账单带金额");
    assert.equal(s.bills.totalAmount, 35.5, "合计只统计带金额的条目");
    assert.equal(s.parcels.count, 1);
    assert.equal(s.parcels.awaitingPickup, 1);
    assert.equal(s.parcels.byCarrier[0]?.carrier, "顺丰");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("台账：按类别查询 + 持久化后重载不丢", () => {
  const { ledger, dir } = tempLedger();
  try {
    const svc = new BillParcelIngestService({ ledger, now: () => BASE_AT });
    svc.ingest({ actorId: "u1", source: "sms", text: "话费扣款 35.50 元" });
    svc.ingest({ actorId: "u1", source: "sms", text: "快递已到，取件码 8-2-3010" });

    assert.equal(ledger.list({ category: "bill" }).length, 1);
    assert.equal(ledger.list({ category: "parcel" }).length, 1);

    // 重载（新实例读同一目录）
    const reloaded = new BillParcelLedger({ dataPath: dir, now: () => BASE_AT });
    reloaded.load();
    assert.equal(reloaded.size(), 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("汇入服务：验证码不进台账、不发信号", () => {
  const { ledger, dir } = tempLedger();
  try {
    const emitted: unknown[] = [];
    const svc = new BillParcelIngestService({
      ledger,
      now: () => BASE_AT,
      emit: (s) => emitted.push(s),
    });
    const r = svc.ingest({ actorId: "u1", source: "sms", text: "您的验证码是 837261" });
    assert.equal(r.matched, false);
    assert.equal(r.otpOnly, true);
    assert.equal(ledger.size(), 0);
    assert.equal(emitted.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("汇入服务：命中则发 high 信号，payload 带结构化字段", () => {
  const { ledger, dir } = tempLedger();
  try {
    const emitted: Array<Record<string, unknown>> = [];
    const svc = new BillParcelIngestService({
      ledger,
      now: () => BASE_AT,
      emit: (s) => emitted.push(s as Record<string, unknown>),
    });
    svc.ingest({
      actorId: "u1",
      source: "sms",
      text: "顺丰快递已到XX驿站，取件码 8-2-3010，运单号 SF1234567890",
    });
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0]?.salience, "high");
    const payload = emitted[0]?.payload as Record<string, unknown>;
    assert.equal(payload.category, "parcel");
    assert.equal(payload.pickupCode, "8-2-3010");
    assert.equal(payload.trackingNo, "SF1234567890");
    assert.equal(payload.carrier, "顺丰");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------ //
// 2026-11-16 改版：状态动作 + 汇总口径 + 订阅扫描 + 入口拦截
// ------------------------------------------------------------------ //

test("台账：已取件不计入待取，仍保留在明细里", () => {
  const { ledger, dir } = tempLedger();
  try {
    const svc = new BillParcelIngestService({ ledger, now: () => BASE_AT });
    const r = svc.ingest({ actorId: "u1", source: "sms", text: "快递已到，取件码 8-2-3010" });
    const id = r.entries[0]?.id as string;
    assert.equal(ledger.summary({ actorId: "u1", days: 30 }).parcels.awaitingPickup, 1);

    ledger.setPickedUp(id, true, BASE_AT + 1000);
    const s = ledger.summary({ actorId: "u1", days: 30 });
    assert.equal(s.parcels.awaitingPickup, 0);
    assert.equal(s.parcels.pickedUp, 1);
    assert.equal(s.parcels.count, 1, "已取件不删除明细");
    assert.equal(ledger.list({ category: "parcel" }).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("台账：记错了从合计扣除，已报销只计数不改金额", () => {
  const { ledger, dir } = tempLedger();
  try {
    const svc = new BillParcelIngestService({ ledger, now: () => BASE_AT });
    const a = svc.ingest({ actorId: "u1", source: "sms", text: "话费扣款 35.50 元" });
    const b = svc.ingest({ actorId: "u1", source: "sms", text: "信用卡还款 1280 元" });
    svc.ingest({ actorId: "u1", source: "sms", text: "水电费 88 元" });

    ledger.setBillStatus(a.entries[0]?.id as string, "reimbursed");
    ledger.setBillStatus(b.entries[0]?.id as string, "wrong");

    const s = ledger.summary({ actorId: "u1", days: 30 });
    assert.equal(s.bills.count, 3);
    assert.equal(s.bills.reimbursedCount, 1);
    assert.equal(s.bills.wrongCount, 1);
    assert.equal(s.bills.totalAmount, 123.5, "记错了的 1280 必须从合计扣除");
    assert.ok(!s.bills.byType.some((t) => t.type === "还款扣款"), "分类占比也要剔除");
    assert.ok(s.bills.duplicateIds.length === 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("台账：同类型同金额 48 小时内两笔 → 标记疑似重复", () => {
  const { ledger, dir } = tempLedger();
  try {
    const svc = new BillParcelIngestService({ ledger, now: () => BASE_AT });
    svc.ingest({ actorId: "u1", source: "sms", text: "信用卡还款 1280 元", at: BASE_AT });
    svc.ingest({
      actorId: "u1",
      source: "email",
      title: "还款成功通知",
      text: "您的信用卡已还款 1280 元",
      at: BASE_AT - 3 * 60 * 60 * 1000,
    });
    const s = ledger.summary({ actorId: "u1", days: 30 });
    assert.equal(s.bills.count, 2);
    assert.equal(s.bills.duplicateIds.length, 2, "窗口内两笔都标记（提示即可，不自动删）");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("订阅扫描：识别续费 + 同类重叠 → 给出可省金额与官方取消路径", () => {
  const { ledger, dir } = tempLedger();
  try {
    const day = 24 * 60 * 60 * 1000;
    const add = (text: string, amountOffset: number) =>
      ledger.add({
        category: "bill",
        source: "sms",
        actorId: "u1",
        title: "账单·订阅续费",
        amount: 25,
        billType: "订阅续费",
        trackingNo: null,
        pickupCode: null,
        carrier: null,
        occurredAt: BASE_AT - amountOffset * day,
        excerpt: text,
      });
    add("【爱奇艺】您已开通连续包月，本期扣款 25 元", 60);
    add("【爱奇艺】连续包月续费成功，扣款 25 元", 30);
    add("【爱奇艺】连续包月续费成功，扣款 25 元", 1);

    // 另一个视频会员（金额不同 → 独立订阅），形成重叠
    for (const offset of [50, 20]) {
      ledger.add({
        category: "bill",
        source: "sms",
        actorId: "u1",
        title: "账单·订阅续费",
        amount: 15,
        billType: "订阅续费",
        trackingNo: null,
        pickupCode: null,
        carrier: null,
        occurredAt: BASE_AT - offset * day,
        excerpt: "【腾讯视频】会员连续包月自动续费 15 元",
      });
    }

    const result = scanSubscriptions(ledger.list({ category: "bill", limit: 100 }), {
      now: BASE_AT,
    });
    assert.equal(result.count, 2);
    assert.equal(result.monthlyTotal, 40);
    assert.equal(result.savingsPerMonth, 25, "保留便宜的腾讯视频，建议取消 25 元爱奇艺");
    assert.ok(result.alerts.some((a) => a.kind === "overlap"));
    const cancel = result.items.find((i) => i.suggestion === "cancel");
    assert.equal(cancel?.name, "爱奇艺");
    assert.match(cancel?.cancelPath ?? "", /会员中心/);
    assert.ok(result.items.every((i) => i.chargedCount >= 2));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("订阅扫描：忽略的订阅不再出现", () => {
  const { ledger, dir } = tempLedger();
  try {
    for (const offset of [40, 10]) {
      ledger.add({
        category: "bill",
        source: "sms",
        actorId: "u1",
        title: "账单·订阅续费",
        amount: 25,
        billType: "订阅续费",
        trackingNo: null,
        pickupCode: null,
        carrier: null,
        occurredAt: BASE_AT - offset * 24 * 60 * 60 * 1000,
        excerpt: "【爱奇艺】连续包月自动续费 25 元",
      });
    }
    const all = scanSubscriptions(ledger.list({ category: "bill", limit: 100 }), { now: BASE_AT });
    assert.equal(all.count, 1);
    const hidden = scanSubscriptions(ledger.list({ category: "bill", limit: 100 }), {
      now: BASE_AT,
      filter: (item) => item.id !== all.items[0]?.id,
    });
    assert.equal(hidden.count, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("入口拦截：营销短信 / 纯验证码 / 重复物流只计数不落台账", () => {
  const dir = mkdtempSync(join(tmpdir(), "bill-parcel-"));
  try {
    const ledger = new BillParcelLedger({ dataPath: dir, now: () => BASE_AT });
    const settings = new DynamicsSettingsStore({ dataPath: dir, now: () => BASE_AT });
    const svc = new BillParcelIngestService({ ledger, settings, now: () => BASE_AT });

    const promo = svc.ingest({
      actorId: "u1",
      source: "sms",
      text: "【某电商】限时活动，领券立减 50 元，退订回T",
    });
    assert.equal(promo.matched, false);
    assert.equal(promo.blockedReason, "marketing");

    const otp = svc.ingest({ actorId: "u1", source: "sms", text: "您的验证码是 837261" });
    assert.equal(otp.otpOnly, true);

    svc.ingest({ actorId: "u1", source: "sms", text: "快递已到，取件码 8-2-3010，运单号 SF1234567890" });
    svc.ingest({
      actorId: "u1",
      source: "sms",
      text: "快递已到，取件码 8-2-3010，运单号 SF1234567890",
      at: BASE_AT + 60_000,
    });

    assert.equal(ledger.size(), 1, "只有第一条快递入台账");
    const b = settings.blockedThisWeek(BASE_AT);
    assert.equal(b.byReason.marketing, 1);
    assert.equal(b.byReason.otp, 1);
    assert.equal(b.byReason.duplicateParcel, 1);
    assert.equal(b.total, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
