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
