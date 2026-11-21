// 账单/快递主动汇报端到端测试（P0，2026-11-19）。
//
// 验证此前从未被覆盖的那一环：**短信/通知原文 → 识别 → 台账 → 主动提案 → 投递/推送**。
// bill-parcel.test.ts 只测到「分类 + 发信号」；本测试用真实组件串起剩余链路：
//   BillParcelIngestService（真实规则 + 真实台账）→ BillParcelReactiveReporter（真实冷却/文案）
//     → ProactivePipeline（真实仲裁 + 真实投递）→ 桩 WS / 桩手机推送（只替代外部 IO）
// 四个断言对应 P0 的四个关键语义：
//   1. 快递命中 → 提案立即投递（must 绕过预算/静默），文案带取件码；
//   2. 同类冷却：10min 内第二条快递不重复打扰；
//   3. 账单走 medium + 6h 冷却，跨来源标签正确；
//   4. 两端离线 → 自动升级手机系统推送，body 同样带取件码。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { BillParcelLedger } from "../src/services/bill-parcel-ledger.js";
import { BillParcelIngestService } from "../src/services/bill-parcel-ingest-service.js";
import {
  BillParcelReactiveReporter,
  BILL_PARCEL_COOLDOWN_MS,
} from "../src/services/bill-parcel-reporter.js";
import { ProactivePipeline } from "../src/proactivity/proactive-pipeline.js";
import { ProactiveDeliveryService } from "../src/proactivity/delivery-service.js";
import { FrequencyGovernor } from "../src/proactivity/frequency-governor.js";
import { OutcomeStore } from "../src/proactivity/outcome-store.js";
import { PresenceService } from "../src/proactivity/presence-service.js";
import type { ProactiveProposal } from "../src/proactivity/pipeline-types.js";

const T0 = new Date(2026, 10, 19, 14, 0, 0).getTime();
const ACTOR = "user-1";

type PushCall = { actorId: string; title: string; body: string; kind: string };

function makeHarness(opts: { online?: boolean; pushEnabled?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "bp-e2e-"));
  const clock = { t: T0 };
  const online = opts.online ?? true;

  const ledger = new BillParcelLedger({ dataPath: dir, nowFn: () => clock.t });
  ledger.load();
  const submitted: ProactiveProposal[] = [];
  // 生产同款晚绑定：pipeline 在 reporter 之后创建，submit 闭包到调用时才解引用。
  let pipeline: ProactivePipeline | null = null;
  const reporter = new BillParcelReactiveReporter({
    now: () => clock.t,
    submit: (p) => {
      submitted.push(p);
      pipeline?.submitProposal(p);
    },
  });
  const ingest = new BillParcelIngestService({
    ledger,
    now: () => clock.t,
    onMatched: (info) => reporter.report(info),
  });

  const presence = new PresenceService();
  if (online) presence.markConnected(ACTOR, T0 - 60_000);

  const delivered: Array<{ actorId: string; json: string }> = [];
  const pushes: PushCall[] = [];
  pipeline = new ProactivePipeline({
    dataPath: dir,
    governor: new FrequencyGovernor({ ignoreEnv: true, dailyBudget: 100 }),
    suppression: { isSuppressed: () => ({ suppressed: false, reason: "" }) },
    presence,
    delivery: new ProactiveDeliveryService({
      trySend: (actorId, json) => {
        delivered.push({ actorId, json });
        return true;
      },
    }),
    outcomes: new OutcomeStore(join(dir, "outcomes.json")),
    nowFn: () => clock.t,
    mobilePush: {
      hasChannel: () => opts.pushEnabled ?? false,
      push: async (input) => {
        pushes.push({
          actorId: input.actorId,
          title: input.title,
          body: input.body,
          kind: input.kind,
        });
        return { ok: true, provider: "stub" };
      },
    },
  });

  return { dir, clock, ledger, ingest, reporter, pipeline, submitted, delivered, pushes, presence };
}

const flush = async () => {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
};

test("E2E：快递短信 → 命中 → 提案立即投递，文案带取件码", async () => {
  const h = makeHarness();
  try {
    const r = h.ingest.ingest({
      actorId: ACTOR,
      source: "sms",
      text: "【菜鸟驿站】您的快递已到，取件码 8-2-3010，运单号 SF1234567890，顺丰速运。",
      externalId: "msg-001",
    });
    assert.equal(r.matched, true, "识别为快递");
    assert.equal(r.match.pickupCode, "8-2-3010");
    assert.equal(h.submitted.length, 1, "命中即提交一条提案");

    const p = h.submitted[0]!;
    assert.equal(p.kind, "action.bill_parcel");
    assert.equal(p.tier, "must", "必达层：绕过社交预算");
    assert.equal(p.importance, "high", "快递时效刚需 = high");
    assert.equal(p.title, "收到快递通知");
    assert.match(p.directText ?? "", /取件码 8-2-3010/, "取件码必须进推送文案");
    assert.equal(p.detail?.["取件码"], "8-2-3010");
    assert.equal(p.detail?.["承运商"], "顺丰");

    await flush();
    assert.equal(h.delivered.length, 1, "在线 → WS 直投一次");
    const wire = JSON.parse(h.delivered[0]!.json);
    assert.match(JSON.stringify(wire), /取件码/, "投递到客户端的报文含取件码");
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test("E2E：同类冷却——10min 内第二条快递不重复提案", async () => {
  const h = makeHarness();
  try {
    const sms = (code: string, id: string) =>
      h.ingest.ingest({
        actorId: ACTOR,
        source: "notification",
        text: `【中通快递】包裹已到，取件码 ${code}。`,
        externalId: id,
      });
    sms("1111", "a");
    assert.equal(h.submitted.length, 1);

    h.clock.t += BILL_PARCEL_COOLDOWN_MS - 1000;
    sms("2222", "b"); // 台账仍新增（不同单号），但同类冷却内不提案
    assert.equal(h.submitted.length, 1, "冷却期内不重复打扰");

    h.clock.t += 2000; // 越过 10min
    sms("3333", "c");
    assert.equal(h.submitted.length, 2, "冷却到期后可再提案");
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test("E2E：账单走 medium + 6h 冷却，来源标签为手机通知", async () => {
  const h = makeHarness();
  try {
    h.ingest.ingest({
      actorId: ACTOR,
      source: "notification",
      text: "话费账单：本月通信费 ¥58.00 已扣款。",
      externalId: "bill-1",
    });
    assert.equal(h.submitted.length, 1);
    const p = h.submitted[0]!;
    assert.equal(p.importance, "medium", "账单汇总型 = medium");
    assert.equal(p.title, "收到账单通知");
    assert.equal(p.detail?.["来源"], "手机通知");
    assert.equal(p.detail?.["账单类型"], "话费通信");
    assert.equal(p.detail?.["金额"], "¥58");

    h.clock.t += 60 * 60 * 1000; // 1h < 6h
    h.ingest.ingest({
      actorId: ACTOR,
      source: "sms",
      text: "信用卡账单 ¥100.00 待还款。",
      externalId: "bill-2",
    });
    assert.equal(h.submitted.length, 1, "账单 6h 冷却内不提案");
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test("E2E：两端离线 + 推送通道 → 快递提案升级系统推送，body 带取件码", async () => {
  const h = makeHarness({ online: false, pushEnabled: true });
  try {
    h.ingest.ingest({
      actorId: ACTOR,
      source: "notification",
      text: "【丰巢】快递到柜，取件码 556677。",
      externalId: "offline-1",
    });
    assert.equal(h.submitted.length, 1);
    await flush();

    assert.equal(h.delivered.length, 0, "离线 → 无 WS 直投");
    assert.equal(h.pushes.length, 1, "自动升级手机系统推送");
    assert.equal(h.pushes[0]!.title, "收到快递通知");
    assert.match(h.pushes[0]!.body, /取件码 556677/, "离线推送 body 同样带取件码");
    assert.equal(h.pipeline.diagnostics().pending.length, 0, "推送成功即出队，不重复");
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});
