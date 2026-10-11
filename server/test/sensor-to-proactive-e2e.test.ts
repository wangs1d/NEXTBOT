// 端到端探针：外部信源扫描 → 统一库 → 世界板 → 规则 → 仲裁 → 主动投递（2026-10-11）
//
// 目的：验证用户要求的完整链路——「外部数据扫进统一数据库 → 再看是否需要主动发起对话」。
// 本测试用**真实组件**串起生产同款接线（只用桩替代外部 IO）：
//   桩读端口 → MailSensor / IcsSensor / FinanceSensor
//     → SensorKernel（调度/去重/水位/熔断）
//     → bridgeSensorKernelToBoard（生产同款入板函数）+ SourceStore（统一库）
//     → MappingExecutor + buildBoardRules（真实规则表）
//     → ArbiterV2 → ProactivePipeline → 投递
// 只把「IMAP/HTTP 拉取」换成桩，链路上其余每一环都是生产实现。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ArbiterV2 } from "../src/proactivity/arbiter-v2.js";
import { ProactiveDeliveryService } from "../src/proactivity/delivery-service.js";
import { FrequencyGovernor } from "../src/proactivity/frequency-governor.js";
import { MappingExecutor, type AttentionEvent } from "../src/proactivity/mapping-executor.js";
import { buildBoardRules } from "../src/proactivity/mapping-rules.js";
import { OutcomeStore } from "../src/proactivity/outcome-store.js";
import { PresenceService } from "../src/proactivity/presence-service.js";
import { ProactivePipeline } from "../src/proactivity/proactive-pipeline.js";
import { SourceStore } from "../src/proactivity/source-store.js";
import { FinanceSensor } from "../src/proactivity/sensors/finance-sensor.js";
import { IcsSensor } from "../src/proactivity/sensors/ics-sensor.js";
import { SensorKernel } from "../src/proactivity/sensors/kernel.js";
import { MailSensor } from "../src/proactivity/sensors/mail-sensor.js";
import { WorldBoard, bridgeSensorKernelToBoard } from "../src/proactivity/world-board.js";

/** 固定时钟：14:00（避开静默时段与 digest/morning 节拍，便于断言单一来源） */
const T0 = new Date(2026, 9, 10, 14, 0, 0).getTime();
const ACTOR = "user-1";

type MailRow = {
  uid: number;
  mail: { actorId: string; from: string; subject: string; date?: string; textSnippet?: string };
  importance: string;
};
type IcsRow = {
  feed: string;
  key: string;
  summary: string;
  location?: string;
  startMs: number;
  allDay: boolean;
  durationMinutes?: number;
};
type TxRow = {
  id: string;
  date: string;
  amount: number;
  type: "income" | "expense";
  category?: string;
  merchant?: string;
};

function makeHarness() {
  const dir = mkdtempSync(join(tmpdir(), "sensor-e2e-"));
  const clock = { t: T0 };

  const board = new WorldBoard({ nowFn: () => clock.t });
  const kernel = new SensorKernel({ dataPath: dir, nowFn: () => clock.t, disablePersist: true });
  const store = new SourceStore({ dataPath: dir, nowFn: () => clock.t, disablePersist: true });
  // 生产同款两条订阅：一条进状态板（驱动规则），一条进统一库（跨源检索）
  bridgeSensorKernelToBoard(kernel, board, ACTOR);
  kernel.onSignal((s) => store.feed(s));

  // ── 外部信源桩（只替代 IO，形状与真实服务读端口一致）──
  const mailRows: MailRow[] = [];
  const icsRows: IcsRow[] = [];
  const txRows: TxRow[] = [];
  kernel.register(new MailSensor({ fetchNewSince: () => mailRows }));
  kernel.register(new IcsSensor({ fetchEventsSince: () => icsRows }));
  kernel.register(new FinanceSensor({ getTransactions: () => txRows }, () => ACTOR));

  const presence = new PresenceService();
  presence.markConnected(ACTOR, clock.t - 60_000);

  const arbiter = new ArbiterV2({
    presence,
    lastConversationAt: () => null,
    screenFocus: () => null,
    nextEventMin: () => null,
    receptivity: () => 0,
    primaryActorId: () => ACTOR,
    nowFn: () => clock.t,
  });

  const delivered: Array<{ actorId: string; json: string }> = [];
  const pipeline = new ProactivePipeline({
    dataPath: dir,
    governor: new FrequencyGovernor({ ignoreEnv: true, disableQuietHours: true, dailyBudget: 20 }),
    suppression: { isSuppressed: () => ({ suppressed: false, reason: "" }) },
    presence,
    delivery: new ProactiveDeliveryService({
      trySend: (actorId, json) => {
        delivered.push({ actorId, json });
        return true;
      },
    }),
    outcomes: new OutcomeStore(join(dir, "outcomes.json")),
    speak: () => {},
    nowFn: () => clock.t,
    // 生产同样注入真实对话时刻；不注入会退回"设备活跃时刻"，把刚连上的设备当成
    // 「对话进行中」→ social 提案被延迟 90s（in_conversation_defer_90s）
    lastConversationAt: () => null,
  });

  const executor = new MappingExecutor({
    board,
    rules: buildBoardRules({}),
    defaultActorId: () => ACTOR,
    dataPath: dir,
    nowFn: () => clock.t,
  });

  const events: AttentionEvent[] = [];
  executor.onEvent((e) => {
    events.push(e);
    arbiter.admit({
      actorId: e.actorId ?? ACTOR,
      urgency: e.urgency,
      tier: e.tier,
      label: e.title,
      deliver: () => {
        pipeline.submitProposal({
          proposalId: e.id,
          actorId: e.actorId ?? ACTOR,
          kind: e.proposalKind,
          tier: e.tier,
          importance: e.importance,
          dedupKey: e.dedupKey,
          title: e.title,
          summary: e.body.slice(0, 120),
          directText: e.body,
          evidence: [`evaluator:${e.kind}`],
          createdAt: clock.t,
          source: `evaluator:${e.kind}`,
        });
      },
    });
  });

  const poll = async () => {
    await kernel.pollOnce();
  };
  const tick = () => executor.tickActor(ACTOR, clock.t);

  return { dir, clock, board, kernel, store, mailRows, icsRows, txRows, events, delivered, poll, tick };
}

/** 造一封邮件（date 落在 now 附近，保证 30min 窗口内） */
function mail(uid: number, from: string, subject: string, importance = "normal", at = T0): MailRow {
  return {
    uid,
    mail: { actorId: ACTOR, from, subject, date: new Date(at).toISOString() },
    importance,
  };
}

function tx(id: string, amount: number, merchant: string, at = T0): TxRow {
  return { id, date: new Date(at).toISOString(), amount, type: "expense", merchant, category: "travel" };
}

// ─── 第一段：扫描 → 统一库（含跨源汇聚）───

test("E2E-1 外部信号扫进统一库：mail / schedule(ICS) / finance 三源都在库里", async () => {
  const h = makeHarness();
  try {
    h.mailRows.push(mail(1, "张总 <zhang@corp.com>", "三亚合同 review", "high"));
    h.icsRows.push({
      feed: "work",
      key: "ev-1",
      summary: "三亚出差",
      location: "三亚",
      startMs: T0 + 3 * 3600_000,
      allDay: false,
    });
    // 账本时间必须严格晚于内核水位（水位=启动时刻），否则被 at > since 过滤
    h.txRows.push(tx("t-1", 1280, "携程", T0 + 1000));

    await h.poll();

    const stats = h.store.stats();
    assert.equal(stats.streams.mail, 1, `邮件进库: ${JSON.stringify(stats.streams)}`);
    assert.equal(stats.streams.schedule, 1, `日历进库: ${JSON.stringify(stats.streams)}`);
    assert.equal(stats.streams.finance, 1, `账本进库: ${JSON.stringify(stats.streams)}`);
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test("E2E-2 跨源实体检索：一次查询同时命中邮件与日历（Muse「汇聚」的旗舰能力）", async () => {
  const h = makeHarness();
  try {
    h.mailRows.push(mail(1, "张总 <zhang@corp.com>", "三亚合同 review", "high"));
    h.icsRows.push({
      feed: "work",
      key: "ev-1",
      summary: "三亚出差",
      location: "三亚",
      startMs: T0 + 3 * 3600_000,
      allDay: false,
    });
    await h.poll();

    const hits = h.store.findByEntity("三亚");
    const streams = new Set(hits.map((x) => x.stream));
    assert.ok(hits.length >= 2, `「三亚」应命中多条：${hits.length}`);
    assert.ok(streams.has("mail"), `应含邮件来源: ${[...streams]}`);
    assert.ok(streams.has("schedule"), `应含日历来源: ${[...streams]}`);
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

// ─── 第二段：统一库/传感器 → 世界板 → 规则 → 投递（用户真正关心的「是否会主动发起」）───

test("E2E-3 邮件爆发 → 世界板 → unread_burst 规则 → 真正投递到用户", async () => {
  const h = makeHarness();
  try {
    h.mailRows.push(
      mail(1, "张总 <zhang@corp.com>", "合同签字页", "high"),
      mail(2, "李经理 <li@corp.com>", "排期确认", "normal"),
      mail(3, "王工 <wang@corp.com>", "线上告警", "high"),
    );
    await h.poll();
    await h.tick();

    const kinds = h.events.map((e) => e.kind);
    assert.ok(kinds.includes("unread_burst"), `邮件应驱动 unread_burst 规则：${kinds}`);
    assert.ok(h.delivered.length >= 1, "事件应经仲裁与管道真正投递");
    assert.match(h.delivered[0].json, /新消息|unread_burst/, `投递内容应含消息摘要: ${h.delivered[0].json}`);
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test("E2E-4 日历订阅（ICS）→ 世界板 nextEvent → meeting_soon → 投递", async () => {
  const h = makeHarness();
  try {
    h.icsRows.push({
      feed: "work",
      key: "ev-2",
      summary: "周会",
      startMs: T0 + 10 * 60_000,
      allDay: false,
    });
    await h.poll();
    await h.tick();

    const kinds = h.events.map((e) => e.kind);
    assert.ok(kinds.includes("meeting_soon"), `ICS 日程应驱动 meeting_soon：${kinds}`);
    assert.ok(h.delivered.length >= 1, "临会提醒应真正投递");
    assert.match(h.delivered[0].json, /周会/, `投递内容应含日程名: ${h.delivered[0].json}`);
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test("E2E-5 账本（finance）→ 世界板 → spend_alert → 投递", async () => {
  const h = makeHarness();
  try {
    h.txRows.push(tx("t-9", 3280, "携程", T0 + 1000));
    await h.poll();
    await h.tick();

    const kinds = h.events.map((e) => e.kind);
    assert.ok(kinds.includes("spend_alert"), `大额支出应驱动 spend_alert：${kinds}`);
    assert.ok(h.delivered.length >= 1, "账单提醒应真正投递");
    assert.match(h.delivered[0].json, /携程|3280/, `投递内容应含商户与金额: ${h.delivered[0].json}`);
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});
