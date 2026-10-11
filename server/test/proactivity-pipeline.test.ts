// 统一主动性管道单测：仲裁规则 / 在场 / 提案队列 / 管道端到端 / 频控持久化与自适应 / 临近日程扫描
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { arbitrate, DELIVERY_RETRY_MS, nextQuietEnd, type ArbiterContext } from "../src/proactivity/arbiter.js";
import { ProactiveDeliveryService } from "../src/proactivity/delivery-service.js";
import { FrequencyGovernor } from "../src/proactivity/frequency-governor.js";
import type { ProactiveProposal } from "../src/proactivity/pipeline-types.js";
import { ProactivePipeline } from "../src/proactivity/proactive-pipeline.js";
import { OutcomeStore } from "../src/proactivity/outcome-store.js";
import { PresenceService } from "../src/proactivity/presence-service.js";
import { ProposalStore } from "../src/proactivity/proposal-store.js";
import { PendingConfirmationStore } from "../src/proactivity/pending-confirmation-store.js";
import { WsConnectionRegistry } from "../src/services/ws-connection-registry.js";
import type { ScheduleTaskRecord } from "../src/services/schedule-task-service.js";

// 固定本地时钟：正午（非静默时段）
const NOON = new Date(2026, 7, 30, 12, 0, 0).getTime();
const NIGHT = new Date(2026, 7, 30, 23, 30, 0).getTime();

function proposal(overrides: Partial<ProactiveProposal> = {}): ProactiveProposal {
  return {
    proposalId: "p_test",
    actorId: "user-a",
    kind: "schedule_upcoming",
    tier: "must",
    importance: "high",
    dedupKey: "k1",
    title: "评审",
    summary: "马上评审",
    evidence: ["evidence-1"],
    directText: "15分钟后评审",
    createdAt: NOON,
    source: "test",
    ...overrides,
  };
}

function ctx(overrides: Partial<ArbiterContext> = {}): ArbiterContext {
  return {
    now: NOON,
    presence: "active",
    inConversation: false,
    isSuppressed: () => ({ suppressed: false, reason: "" }),
    socialCanTrigger: () => ({ allowed: true, reason: "ok" }),
    ...overrides,
  };
}

function task(overrides: Partial<ScheduleTaskRecord>): ScheduleTaskRecord {
  return {
    taskId: "t1",
    sessionId: "s1",
    description: "项目评审",
    kind: "reminder",
    recurrence: "none",
    timezone: "Asia/Shanghai",
    runAt: new Date(NOON + 10 * 60_000).toISOString(),
    nextRunAt: new Date(NOON + 10 * 60_000).toISOString(),
    status: "active",
    createdAt: new Date(NOON).toISOString(),
    updatedAt: new Date(NOON).toISOString(),
    ...overrides,
  };
}

// ─── 仲裁规则 ───

test("arbiter: 过期提案作废", () => {
  const d = arbitrate(proposal({ expiresAt: NOON - 1 }), ctx());
  assert.equal(d.verdict, "expired");
});

test("arbiter: 负反馈抑制优先", () => {
  const d = arbitrate(proposal(), ctx({ isSuppressed: () => ({ suppressed: true, reason: "user said stop" }) }));
  assert.equal(d.verdict, "suppressed");
});

test("arbiter: 静默时段 critical/high 豁免当场投递（2026-10-01：时效性事务 defer 到早晨=没提醒）", () => {
  // high 豁免（与 governor「静默仅 high 放行」口径对齐）——验证码/传票类当场说
  const h = arbitrate(proposal({ importance: "high", tier: "social" }), ctx({ now: NIGHT }));
  assert.equal(h.verdict, "delivered");
  // critical 原有豁免不变
  const c = arbitrate(proposal({ importance: "critical" }), ctx({ now: NIGHT }));
  assert.equal(c.verdict, "delivered");
});

test("arbiter: 静默时段 medium/low 且用户不在场 defer 到早晨而非丢弃", () => {
  const d = arbitrate(
    proposal({ importance: "medium", tier: "social" }),
    ctx({ now: NIGHT, presence: "offline" }),
  );
  assert.equal(d.verdict, "deferred");
  assert.equal(d.reasonChain[0], "quiet_hours_defer_to_morning");
  assert.equal(d.deliverAfter, nextQuietEnd(new Date(NIGHT)));
  const l = arbitrate(
    proposal({ importance: "low", tier: "social" }),
    ctx({ now: NIGHT, presence: "offline" }),
  );
  assert.equal(l.verdict, "deferred");
});

test("arbiter: must 层绕过社交预算（预算耗尽仍可达）", () => {
  let queried = false;
  const d = arbitrate(proposal({ tier: "must" }), ctx({
    socialCanTrigger: () => {
      queried = true;
      return { allowed: false, reason: "daily_budget_exhausted(6/6)" };
    },
  }));
  assert.equal(d.verdict, "delivered");
  assert.ok(!queried, "must 层不应查询社交预算");
});

test("arbiter: social 层预算耗尽被节流", () => {
  const d = arbitrate(proposal({ tier: "social" }), ctx({
    socialCanTrigger: () => ({ allowed: false, reason: "daily_budget_exhausted(6/6)" }),
  }));
  assert.equal(d.verdict, "throttled");
  assert.ok(d.reasonChain[0].startsWith("frequency_governor:"));
});

test("arbiter: 两端都不在线一律挂起待重连（不落离线信箱）", () => {
  const social = arbitrate(proposal({ tier: "social", importance: "medium" }), ctx({ presence: "offline" }));
  assert.equal(social.verdict, "deferred");
  assert.ok(social.reasonChain.includes("offline_wait_reconnect"));
  const must = arbitrate(proposal({ tier: "must" }), ctx({ presence: "offline" }));
  assert.equal(must.verdict, "deferred", "必达层离线同样挂起，重连即达");
  const critical = arbitrate(proposal({ importance: "critical" }), ctx({ presence: "offline" }));
  assert.equal(critical.verdict, "deferred");
});

test("arbiter: 对话中不打断非 interruptible 提案（短延迟 90s）", () => {
  const d = arbitrate(proposal({ tier: "social", interruptible: false }), ctx({ inConversation: true }));
  assert.equal(d.verdict, "deferred");
  assert.equal(d.deliverAfter, NOON + 90_000);
});

test("arbiter: critical 在对话中默认允许打断", () => {
  const d = arbitrate(proposal({ importance: "critical", tier: "social" }), ctx({ inConversation: true }));
  assert.equal(d.verdict, "delivered");
});

// ─── 在场判定 ───

test("presence: active/idle/offline 三态", () => {
  const presence = new PresenceService();
  assert.equal(presence.getPresence("u"), "offline");
  presence.markConnected("u", NOON - 1000);
  assert.equal(presence.getPresence("u", NOON), "active");
  presence.markConnected("u", NOON - 11 * 60_000);
  assert.equal(presence.getPresence("u", NOON), "idle");
  presence.markDisconnected("u");
  presence.markDisconnected("u");
  assert.equal(presence.getPresence("u", NOON), "offline");
});

test("presence: 多端引用计数（任一设备在线即在线，全部掉线才离线）", () => {
  const presence = new PresenceService();
  presence.markConnected("u", NOON);
  presence.markConnected("u", NOON); // 手机端第二连接
  presence.markDisconnected("u"); // 电脑端断开 → 手机仍在线
  assert.equal(presence.getPresence("u", NOON), "active");
  presence.markDisconnected("u"); // 全部掉线
  assert.equal(presence.getPresence("u", NOON), "offline");
});

test("registry: 多设备 fan-out（电脑+手机都收到；单端断开不误判离线）", () => {
  const registry = new WsConnectionRegistry();
  const states: boolean[] = [];
  registry.onConnectionChange = (_actorId, connected) => states.push(connected);
  const sent: string[] = [];
  const desktop = { send: (d: string) => void sent.push(`desktop:${d}`) };
  const mobile = { send: (d: string) => void sent.push(`mobile:${d}`) };
  registry.register("u", desktop);
  registry.register("u", mobile);
  assert.ok(registry.trySend("u", "m1"), "双端在线应投递成功");
  assert.equal(sent.filter((s) => s.startsWith("desktop:")).length, 1, "电脑端收到");
  assert.equal(sent.filter((s) => s.startsWith("mobile:")).length, 1, "手机端也收到");
  registry.unregister("u", desktop); // 电脑端关闭 → 手机仍在线，不算离线
  assert.deepEqual(states, [true]);
  assert.ok(registry.trySend("u", "m2"));
  registry.unregister("u", mobile);
  assert.deepEqual(states, [true, false]);
  assert.equal(registry.trySend("u", "m3"), false);
});

test("registry: 死连接 trySend 兜底清理并正确判定离线", () => {
  const registry = new WsConnectionRegistry();
  const states: boolean[] = [];
  registry.onConnectionChange = (_actorId, connected) => states.push(connected);
  registry.register("u", { send: () => {}, readyState: 3 }); // 已关闭的僵尸连接
  assert.equal(registry.trySend("u", "m"), false, "无健康连接不投递");
  assert.deepEqual(states, [true, false], "僵尸连接清理后应标记离线");
  // 混合：僵尸 + 健康手机端 → 投递成功且不离线
  states.length = 0;
  registry.register("u", { send: () => {}, readyState: 3 });
  registry.register("u", { send: () => {} });
  assert.ok(registry.trySend("u", "m"));
  assert.deepEqual(states, [true]);
});

// ─── 提案队列 ───

test("proposal-store: 同 dedupKey 合并保留最新且 deliverAfter 取更晚", () => {
  const dir = mkdtempSync(join(tmpdir(), "proactive-store-"));
  try {
    const path = join(dir, "proposals.json");
    const store = new ProposalStore(path);
    assert.equal(store.enqueue(proposal({ dedupKey: "k", deliverAfter: NOON })), true);
    assert.equal(store.enqueue(proposal({ dedupKey: "k", title: "新内容" })), false);
    assert.equal(store.listPending().length, 1);
    assert.equal(store.listPending()[0].title, "新内容");
    assert.equal(store.listPending()[0].deliverAfter, NOON);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("proposal-store: 落盘重启恢复待发区", () => {
  const dir = mkdtempSync(join(tmpdir(), "proactive-store-"));
  try {
    const path = join(dir, "proposals.json");
    const store = new ProposalStore(path);
    // createdAt 用当前时间：启动清理会丢弃 48h+ 的僵尸挂起（2026-10-01 P0）
    const fresh = proposal({ dedupKey: "kp", createdAt: Date.now() });
    store.enqueue(fresh);
    store.logDecision({ proposal: proposal(), verdict: "deferred", reasonChain: ["r1"] });
    store.flush();
    const restored = new ProposalStore(path);
    assert.equal(restored.listPending().length, 1);
    assert.equal(restored.recentDecisions()[0].reasonChain[0], "r1");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("proposal-store: 启动清理丢弃幽灵/超期僵尸挂起（2026-10-01 P0）", () => {
  const dir = mkdtempSync(join(tmpdir(), "proactive-store-"));
  try {
    const path = join(dir, "proposals.json");
    const store = new ProposalStore(path);
    store.enqueue(proposal({ dedupKey: "fresh", createdAt: Date.now(), actorId: "user-a" }));
    store.enqueue(
      proposal({
        dedupKey: "stale",
        createdAt: Date.now() - 49 * 60 * 60_000,
        actorId: "user-a",
      }),
    );
    store.enqueue(
      proposal({
        dedupKey: "ghost",
        createdAt: Date.now(),
        actorId: "()=>{const actors=proactivityHub.exportActors()",
      }),
    );
    store.flush();
    const restored = new ProposalStore(path);
    const ids = restored.listPending().map((p) => p.dedupKey);
    assert.deepEqual(ids, ["fresh"], "僵尸（48h+）与幽灵（函数串 actor）启动即弃");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── 管道端到端 ───

type Harness = {
  pipeline: ProactivePipeline;
  presence: PresenceService;
  governor: FrequencyGovernor;
  delivered: Array<{ actorId: string; json: string }>;
  spoken: ProactiveProposal[];
  /** 离线落信箱记录（2026-10-10：social 层离线兜底可观测） */
  inbox: Array<{ actorId: string; title: string; body: string; kind?: string; importance?: string; messageId?: string }>;
  flags: { failSend: boolean; failInbox: boolean };
  dir: string;
};

function makeHarness(opts: { now?: number; dailyBudget?: number; failSend?: boolean; failInbox?: boolean; inboxEnabled?: boolean; confirmations?: PendingConfirmationStore; onProposalApproved?: (p: ProactiveProposal) => void } = {}): Harness {
  const dir = mkdtempSync(join(tmpdir(), "proactive-pipe-"));
  const presence = new PresenceService();
  const governor = new FrequencyGovernor({ ignoreEnv: true, disableQuietHours: true, dailyBudget: opts.dailyBudget ?? 6 });
  const delivered: Array<{ actorId: string; json: string }> = [];
  const spoken: ProactiveProposal[] = [];
  const inbox: Harness["inbox"] = [];
  const flags = { failSend: opts.failSend ?? false, failInbox: opts.failInbox ?? false };
  // 缺省注入站内信通道（验证离线兜底）；inboxEnabled=false 时模拟「未接通道」旧挂起语义
  const inboxDep =
    opts.inboxEnabled === false
      ? undefined
      : {
          send: async (input: Harness["inbox"][number]) => {
            if (flags.failInbox) throw new Error("inbox down");
            inbox.push(input);
            return { deliveredLive: false };
          },
        };
  const pipeline = new ProactivePipeline({
    dataPath: dir,
    governor,
    suppression: { isSuppressed: () => ({ suppressed: false, reason: "" }) },
    presence,
    delivery: new ProactiveDeliveryService({
      trySend: (actorId, json) => {
        if (flags.failSend) return false;
        delivered.push({ actorId, json });
        return true;
      },
    }),
    outcomes: new OutcomeStore(join(dir, "outcomes.json")),
    speak: (p) => spoken.push(p),
    nowFn: () => opts.now ?? NOON,
    inbox: inboxDep,
    confirmations: opts.confirmations,
    onProposalApproved: opts.onProposalApproved,
  });
  return { pipeline, presence, governor, delivered, spoken, inbox, flags, dir };
}

test("pipeline: 在线 directText 零 LLM 直投 + outcome 记录", async () => {
  const h = makeHarness();
  try {
    h.presence.markConnected("user-a", NOON - 5 * 60_000); // active 但非对话中
    const d = h.pipeline.submitProposal(proposal());
    assert.equal(d.verdict, "delivered");
    assert.equal(h.delivered.length, 1);
    assert.equal(h.spoken.length, 0, "directText 提案不调 LLM");
    const payload = JSON.parse(h.delivered[0].json);
    assert.equal(payload.type, "agent.proactive_message");
    assert.ok(payload.payload.deliveryId);
    assert.equal(payload.payload.importance, "high");
    await new Promise((r) => setImmediate(r));
    assert.equal(h.pipeline.diagnostics().recentOutcomes.at(-1)?.outcome, "delivered");
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test("pipeline: 无 directText 提案走 speak 闭环（唯一 LLM 点）", () => {
  const h = makeHarness();
  try {
    h.presence.markConnected("user-a", NOON - 5 * 60_000);
    h.pipeline.submitProposal(proposal({ directText: undefined, tier: "social", kind: "greeting" }));
    assert.equal(h.spoken.length, 1);
    assert.equal(h.delivered.length, 0);
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test("pipeline: 同 dedupKey 二次提交合并（待发区内 + 已投递窗口内都防重）", () => {
  const h = makeHarness();
  try {
    h.presence.markConnected("user-a", NOON - 5 * 60_000);
    h.pipeline.submitProposal(proposal());
    // 已投递后短窗口内重提交（如 watcher 重启重扫同一会议）→ 合并
    const again = h.pipeline.submitProposal(proposal({ title: "重复" }));
    assert.equal(again.verdict, "merged");
    assert.equal(h.delivered.length, 1);
    // 挂起中的提案同键重提交 → 合并
    h.presence.markDisconnected("user-a");
    h.pipeline.submitProposal(proposal({ dedupKey: "k-pending", tier: "social", importance: "medium" }));
    const dupPending = h.pipeline.submitProposal(proposal({ dedupKey: "k-pending", tier: "social", importance: "medium" }));
    assert.equal(dupPending.verdict, "merged");
    assert.equal(h.pipeline.diagnostics().pending.length, 1);
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test("pipeline: 两端离线提案挂起 → 任一设备重连后直推（弹窗保证）", async () => {
  const h = makeHarness();
  try {
    const d1 = h.pipeline.submitProposal(proposal({ tier: "social", importance: "medium" }));
    assert.equal(d1.verdict, "deferred");
    assert.equal(h.pipeline.diagnostics().pending.length, 1);
    assert.equal(h.delivered.length, 0, "离线不投递");
    // 手机端重连（idle：11 分钟前标记，非对话中）→ flush 重仲裁 → 直推
    h.presence.markConnected("user-a", NOON - 11 * 60_000);
    h.pipeline.flushDue(NOON);
    assert.equal(h.delivered.length, 1, "重连后立即直推");
    assert.equal(h.pipeline.diagnostics().pending.length, 0);
    await new Promise((r) => setImmediate(r));
    assert.equal(h.pipeline.diagnostics().recentOutcomes.at(-1)?.outcome, "delivered");
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

// ─── 离线兜底：落站内信（2026-10-10 对症 97 条 offline_wait_reconnect 静默作废） ───

test("pipeline: 两端离线且 social+medium → 落站内信（不再挂到 TTL 静默过期）", async () => {
  const h = makeHarness();
  try {
    // 离线：无设备连接
    const d = h.pipeline.submitProposal(proposal({ tier: "social", importance: "medium", dedupKey: "k-inbox" }));
    assert.equal(d.verdict, "deferred");
    assert.equal(h.delivered.length, 0, "离线不直推");
    await new Promise((r) => setImmediate(r));
    assert.equal(h.inbox.length, 1, "medium social 落站内信");
    assert.equal(h.inbox[0].actorId, "user-a");
    assert.equal(h.inbox[0].messageId, "proactive:k-inbox", "幂等键按 dedupKey 派生");
    assert.equal(h.inbox[0].kind, "proactive:schedule_upcoming");
    // 落信箱 = 已送达语义：出队，避免重连重复直推
    assert.equal(h.pipeline.diagnostics().pending.length, 0, "落信箱后出队");
    const outcome = h.pipeline.diagnostics().recentOutcomes.at(-1);
    assert.equal(outcome?.channel, "offline_inbox");
    assert.equal(outcome?.outcome, "delivered");
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test("pipeline: 离线 low social 不落信箱（避免收件箱灌爆，维持挂起语义）", async () => {
  const h = makeHarness();
  try {
    const d = h.pipeline.submitProposal(proposal({ tier: "social", importance: "low", dedupKey: "k-low" }));
    assert.equal(d.verdict, "deferred");
    await new Promise((r) => setImmediate(r));
    assert.equal(h.inbox.length, 0, "low 不落站内信");
    assert.equal(h.pipeline.diagnostics().pending.length, 1, "仍保留待发区等重连");
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test("pipeline: 未接站内信通道时维持旧挂起语义（回退兼容）", async () => {
  const h = makeHarness({ inboxEnabled: false });
  try {
    h.pipeline.submitProposal(proposal({ tier: "social", importance: "medium", dedupKey: "k-noch" }));
    await new Promise((r) => setImmediate(r));
    assert.equal(h.inbox.length, 0);
    assert.equal(h.pipeline.diagnostics().pending.length, 1, "无通道 = 旧挂起语义");
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test("pipeline: 落信箱失败保留待发区（重连即达，不丢）", async () => {
  const h = makeHarness({ failInbox: true });
  try {
    h.pipeline.submitProposal(proposal({ tier: "social", importance: "medium", dedupKey: "k-failin" }));
    await new Promise((r) => setImmediate(r));
    assert.equal(h.inbox.length, 0);
    assert.equal(h.pipeline.diagnostics().pending.length, 1, "落信箱异常不吞提案");
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test("pipeline: PROACTIVITY_OFFLINE_INBOX=0 一键回退旧挂起语义", async () => {
  const prev = process.env.PROACTIVITY_OFFLINE_INBOX;
  process.env.PROACTIVITY_OFFLINE_INBOX = "0";
  const h = makeHarness();
  try {
    h.pipeline.submitProposal(proposal({ tier: "social", importance: "medium", dedupKey: "k-envoff" }));
    await new Promise((r) => setImmediate(r));
    assert.equal(h.inbox.length, 0, "开关关闭 = 不落信箱");
    assert.equal(h.pipeline.diagnostics().pending.length, 1);
  } finally {
    if (prev === undefined) delete process.env.PROACTIVITY_OFFLINE_INBOX;
    else process.env.PROACTIVITY_OFFLINE_INBOX = prev;
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test("pipeline: 重连抢跑优先——站内信落盘前重连直推（store.take 单点守卫，不重复记账）", async () => {
  const h = makeHarness();
  try {
    h.pipeline.submitProposal(proposal({ tier: "social", importance: "medium", dedupKey: "k-race" }));
    // 站内信 send 是异步的：在 microtask 落盘前重连并 flush → WS 直推抢先
    h.presence.markConnected("user-a", NOON - 11 * 60_000);
    h.pipeline.flushDue(NOON);
    await new Promise((r) => setImmediate(r));
    assert.equal(h.delivered.length, 1, "WS 直推发生");
    // store.take 单点守卫：直推已出队，站内信侧 take 落空 → 不重复记 outcome
    const outcomes = h.pipeline.diagnostics().recentOutcomes;
    assert.equal(outcomes.length, 1, "同一提案只记一次 outcome（不双发）");
    assert.equal(outcomes[0].channel, "in_app", "以先到者为准");
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test("pipeline: 投递竞态（WS 发送失败）→ 落站内信兜底（不再静默丢失）", async () => {
  const h = makeHarness({ failSend: true });
  try {
    h.presence.markConnected("user-a", NOON - 5 * 60_000);
    const d = h.pipeline.submitProposal(proposal());
    assert.equal(d.verdict, "delivered");
    assert.equal(h.delivered.length, 0, "WS 发送失败不产出直推");
    await new Promise((r) => setImmediate(r));
    assert.equal(h.inbox.length, 1, "WS 竞态失败 → 落站内信兜底");
    assert.equal(h.pipeline.diagnostics().pending.length, 0, "兜底成功即出队");
    assert.equal(h.pipeline.diagnostics().recentOutcomes.at(-1)?.channel, "offline_inbox");
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test("pipeline: WS 发送失败且无站内信通道 → 30s 后重试不丢失（旧语义）", async () => {
  const h = makeHarness({ failSend: true, inboxEnabled: false });
  try {
    h.presence.markConnected("user-a", NOON - 5 * 60_000);
    const d = h.pipeline.submitProposal(proposal());
    assert.equal(d.verdict, "delivered");
    assert.equal(h.delivered.length, 0, "发送失败不产出投递");
    assert.equal(h.pipeline.diagnostics().pending.length, 1, "提案保留待发区等待重试");
    await new Promise((r) => setImmediate(r));
    assert.equal(h.pipeline.diagnostics().recentOutcomes.length, 0, "未送达不记 outcome");
    // 设备恢复 → 重试成功
    h.flags.failSend = false;
    h.pipeline.flushDue(NOON + DELIVERY_RETRY_MS + 1);
    assert.equal(h.delivered.length, 1, "重试投递成功");
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test("pipeline: 对话中提案延迟 90s 后自动投递", () => {
  const h = makeHarness();
  try {
    h.presence.markConnected("user-a", NOON); // 刚活跃 = 对话中
    const d = h.pipeline.submitProposal(proposal({ tier: "social", importance: "medium", interruptible: false }));
    assert.equal(d.verdict, "deferred");
    assert.equal(h.delivered.length, 0);
    h.pipeline.flushDue(NOON + 90_001);
    assert.equal(h.delivered.length, 1);
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test("pipeline: social 层预算耗尽节流（governor 共享口径）", () => {
  const h = makeHarness({ dailyBudget: 1 });
  try {
    h.presence.markConnected("user-a", NOON - 5 * 60_000);
    const first = h.pipeline.submitProposal(proposal({ tier: "social", dedupKey: "s1" }));
    assert.equal(first.verdict, "delivered");
    const second = h.pipeline.submitProposal(proposal({ tier: "social", dedupKey: "s2" }));
    assert.equal(second.verdict, "throttled");
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test("pipeline: must 层不占社交预算（预算耗尽仍投递）", () => {
  const h = makeHarness({ dailyBudget: 1 });
  try {
    h.presence.markConnected("user-a", NOON - 5 * 60_000);
    h.pipeline.submitProposal(proposal({ tier: "social", dedupKey: "s1" }));
    const must = h.pipeline.submitProposal(proposal({ tier: "must", dedupKey: "m1" }));
    assert.equal(must.verdict, "delivered");
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test("pipeline: 连续忽略 → 自适应冷却上升（分寸感回灌）", async () => {
  const h = makeHarness();
  try {
    h.presence.markConnected("user-a", NOON - 5 * 60_000);
    for (let i = 0; i < 5; i++) {
      h.pipeline.submitProposal(proposal({ tier: "social", kind: "followup", dedupKey: `f${i}` }));
    }
    const before = h.governor.snapshot().cooldowns.followup;
    const ids = h.pipeline.diagnostics().recentOutcomes.map((o) => o.deliveryId);
    for (const id of ids) h.pipeline.recordOutcome(id, "ignored");
    const after = h.governor.snapshot().cooldowns.followup;
    assert.ok(after > before, `忽略 5 次后冷却应上升 ${before} -> ${after}`);
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test("pipeline: unknown deliveryId 的 outcome 返回 false", () => {
  const h = makeHarness();
  try {
    assert.equal(h.pipeline.recordOutcome("nope", "accepted"), false);
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

// ─── 频控持久化 ───

test("governor: 快照恢复（重启不重置预算与冷却）", () => {
  const g1 = new FrequencyGovernor({ ignoreEnv: true });
  g1.record("u", "care", new Date(NOON - 60_000));
  g1.noteOutcome("care", false);
  const snap = g1.snapshot();
  const g2 = new FrequencyGovernor({ ignoreEnv: true });
  g2.restore(snap);
  assert.equal(g2.usageSnapshot()[0].dailyCount, 1);
  assert.equal(g2.snapshot().cooldowns.care, snap.cooldowns.care);
  // 恢复后 kind 冷却沿用：1 分钟前刚触发过 care（8h 冷却）→ 拦截
  const v = g2.canTrigger("u", "care", "medium", new Date(NOON));
  assert.equal(v.allowed, false);
  assert.ok(v.reason.startsWith("kind_cooldown"), `reason=${v.reason}`);
});

test("governor: 自适应冷却上下界（负反馈×1.5 上限 48h，正反馈回落不低于默认）", () => {
  const g = new FrequencyGovernor({ ignoreEnv: true });
  const base = g.snapshot().cooldowns.care;
  for (let i = 0; i < 30; i++) g.noteOutcome("care", false);
  assert.ok(g.snapshot().cooldowns.care <= 48 * 60 * 60 * 1000);
  for (let i = 0; i < 30; i++) g.noteOutcome("care", true);
  assert.equal(g.snapshot().cooldowns.care, base);
});

// ─── 助手动态台账（action.* 提案投递成功落库）───

test("ledger: action.* 提案投递成功落库，非 action.* 不落", () => {
  const recorded: ProactiveProposal[] = [];
  const delivery = new ProactiveDeliveryService({
    trySend: () => true,
    ledger: { record: (p) => recorded.push(p) },
  });
  const r1 = delivery.deliver(proposal({ kind: "action.purchase", dedupKey: "buy-milk" }), "牛奶订好啦", "已为你订购牛奶");
  const r2 = delivery.deliver(proposal({ kind: "schedule_upcoming", dedupKey: "k2" }), "评审提醒", "评审");
  assert.ok(r1.ok && r2.ok);
  assert.equal(recorded.length, 1, "只有 action.* 提案进台账");
  assert.equal(recorded[0]!.kind, "action.purchase");
});

test("ledger: 投递失败（两端离线）不落台账", () => {
  const recorded: ProactiveProposal[] = [];
  const delivery = new ProactiveDeliveryService({
    trySend: () => false,
    ledger: { record: (p) => recorded.push(p) },
  });
  const r = delivery.deliver(proposal({ kind: "action.payment" }), "水电费已缴", "已缴纳水电费");
  assert.equal(r.ok, false);
  assert.equal(recorded.length, 0, "挂起重投的提案在送达前不进台账");
});

test("ledger: AgentActivityStore 记录/去重/已读/裁剪", async () => {
  const { AgentActivityStore } = await import("../src/proactivity/activity-store.js");
  const dir = mkdtempSync(join(tmpdir(), "activity-store-"));
  const file = join(dir, "activities.json");
  const store = new AgentActivityStore(file);
  const a = store.record({
    actorId: "user-a", kind: "action.purchase", title: "已为你订购牛奶",
    summary: "光明每日鲜语 950ml ×1", status: "pending", statusLabel: "配送中",
    detail: { 商品: "光明每日鲜语 950ml ×1", 金额: "¥15.80" }, dedupKey: "buy-milk",
  });
  assert.ok(a && a.category === "purchase" && a.readAt === null);
  // 同 dedupKey 重投不重复
  assert.equal(store.record({ actorId: "user-a", kind: "action.purchase", title: "x", summary: "y", dedupKey: "buy-milk" }), null);
  // 其他 actor / 其他 dedupKey 正常
  store.record({ actorId: "user-b", kind: "action.payment", title: "已缴纳水电费", summary: "8月账单 ¥128.50", dedupKey: "pay-1" });
  assert.equal(store.unreadCount("user-a"), 1);
  assert.equal(store.unreadCount(), 2);
  assert.equal(store.markRead("user-a", [a!.id]), 1);
  assert.equal(store.unreadCount("user-a"), 0);
  assert.equal(store.unreadCount("user-b"), 1);
  // 重启恢复（同文件再开一遍）
  const store2 = new AgentActivityStore(file);
  assert.equal(store2.list("user-a").length, 1);
  assert.equal(store2.list("user-a")[0]!.statusLabel, "配送中");
  rmSync(dir, { recursive: true, force: true });
});

// ─── 消息监控触发器（日程变动识别 → action.* 提案）───

test("message_watch: 延迟开会消息 → 提交 action.schedule_change 提案", async () => {
  const { MessageWatchTrigger, detectScheduleChange } = await import("../src/proactivity/triggers/message-watch-trigger.js");
  const submitted: ProactiveProposal[] = [];
  const trigger = new MessageWatchTrigger({ submitProposal: (p) => submitted.push(p) });
  trigger.handleInbound({
    actorId: "user-a", platform: "wechat", channelId: "conv-1",
    text: "王哥，下午的评审会议要延迟到4点了，你那边别走开",
    participantName: "王工",
  });
  assert.equal(submitted.length, 1);
  const p = submitted[0]!;
  assert.equal(p.kind, "action.schedule_change");
  assert.equal(p.tier, "must");
  assert.equal(p.importance, "high");
  assert.ok(p.directText?.includes("评审会议"));
  assert.equal(p.detail?.["发件人"], "王工");
  assert.equal(p.detail?.["来源"], "微信");
  assert.ok(detectScheduleChange("明天的面试取消") != null);
});

test("message_watch: 噪声/无关消息不提案", async () => {
  const { MessageWatchTrigger, detectScheduleChange } = await import("../src/proactivity/triggers/message-watch-trigger.js");
  const submitted: ProactiveProposal[] = [];
  const trigger = new MessageWatchTrigger({ submitProposal: (p) => submitted.push(p) });
  const hub = await import("../src/services/message-hub-service.js");
  const mk = (text: string): hub.MessageHubInboundInput => ({
    actorId: "user-a", platform: "generic", channelId: "c1", text,
  });
  trigger.handleInbound(mk("您的验证码是 882233，请勿泄露"));
  trigger.handleInbound(mk("今天天气真不错，周末去爬山吧"));
  trigger.handleInbound(mk("订单已取消，退款将在3个工作日内退回")); // 无日程语境
  assert.equal(submitted.length, 0);
  assert.equal(detectScheduleChange(""), null);
});

test("message_watch: 同会话 10 分钟冷却 + 同文本指纹去重", async () => {
  const { MessageWatchTrigger } = await import("../src/proactivity/triggers/message-watch-trigger.js");
  const submitted: ProactiveProposal[] = [];
  let now = 1_000_000;
  const trigger = new MessageWatchTrigger({ submitProposal: (p) => submitted.push(p), now: () => now });
  const mk = (text: string): import("../src/services/message-hub-service.js").MessageHubInboundInput => ({
    actorId: "user-a", platform: "wechat", channelId: "grp-1", text,
  });
  trigger.handleInbound(mk("会议推迟到明天上午十点"));
  trigger.handleInbound(mk("会议推迟到明天上午十点"));   // 冷却期内
  assert.equal(submitted.length, 1);
  now += 11 * 60_000;
  trigger.handleInbound(mk("会议推迟到明天上午十点"));   // 冷却期外，同文本 → 同 dedupKey 由管道去重
  assert.equal(submitted.length, 2);
  assert.equal(submitted[0]!.dedupKey, submitted[1]!.dedupKey);
});

test("message_watch: 提案带 ask_first 效用声明与「让助手处理」确认入口", async () => {
  const { MessageWatchTrigger } = await import("../src/proactivity/triggers/message-watch-trigger.js");
  const { evaluateActionUtility, deriveNotifyValue } = await import("../src/proactivity/action-utility.js");
  const submitted: ProactiveProposal[] = [];
  const trigger = new MessageWatchTrigger({ submitProposal: (p) => submitted.push(p) });
  trigger.handleInbound({
    actorId: "user-a", platform: "email", channelId: "from@example.com",
    text: "各位，明天的项目评审会议改到周四下午三点",
    participantName: "项目经理",
  });
  assert.equal(submitted.length, 1);
  const p = submitted[0]!;
  assert.ok(p.confirmAction, "带确认入口");
  assert.equal(p.confirmAction!.label, "让助手处理");
  assert.ok(p.utility, "带效用声明");
  const u = evaluateActionUtility({
    kind: p.kind,
    title: p.title,
    risk: p.utility!.risk,
    authorization: p.utility!.authorization,
    value: p.utility!.value ?? deriveNotifyValue(p.importance),
  });
  assert.equal(u.branch, "ask_first", "效用分支必须是 ask_first（代用户做事先问）");
});

// ─── 方案 A/B：效用评估前置 + silenced 判定 + 沉默日志 ───

test("arbiter: 未声明 utility 的提案不评估（既有行为不变）", () => {
  const d = arbitrate(proposal(), ctx());
  assert.equal(d.verdict, "delivered");
  assert.ok(!d.reasonChain.some((r) => r.startsWith("action_utility")));
  assert.equal(d.utility, undefined);
});

test("arbiter: 效用评估在仲裁链最前面（净效用为负 → silenced，与 suppressed 区分）", () => {
  const d = arbitrate(
    proposal({
      utility: {
        risk: { reversible: true, financialImpact: "none", dataSensitivity: "none", thirdPartyImpact: false },
        authorization: "implicit",
        value: { expectedValue: 0.2, interruptionCost: 0.5 },
      },
    }),
    ctx({ isSuppressed: () => ({ suppressed: true, reason: "user said stop" }) }),
  );
  assert.equal(d.verdict, "silenced", "效用评估优先于负反馈抑制（链首）");
  assert.match(d.reasonChain[0], /^action_utility_silence:net_utility_negative/);
  assert.ok(d.utility);
  assert.ok(d.utility.netUtility < 0);
});

test("arbiter: 非 silence 分支记入 reasonChain 并继续仲裁（ask_first 投递确认请求文案）", () => {
  const d = arbitrate(
    proposal({
      kind: "action.commitment.nudge",
      utility: {
        risk: { reversible: false, financialImpact: "none", dataSensitivity: "none", thirdPartyImpact: true },
        authorization: "none",
        value: { expectedValue: 0.9, interruptionCost: 0.3 },
      },
    }),
    ctx(),
  );
  assert.equal(d.verdict, "delivered", "ask_first 的提案照常投递（文案即确认请求）");
  assert.match(d.reasonChain[0], /^action_utility:ask_first:irreversible_action/);
  assert.equal(d.utility?.branch, "ask_first");
});

test("arbiter: execute_silently 分支的提案投递不误伤（通知类提案投递即执行）", () => {
  const d = arbitrate(
    proposal({
      utility: {
        risk: { reversible: true, financialImpact: "none", dataSensitivity: "none", thirdPartyImpact: false },
        authorization: "explicit",
        value: { expectedValue: 0.9, interruptionCost: 0.2 },
      },
    }),
    ctx(),
  );
  assert.equal(d.verdict, "delivered");
  assert.match(d.reasonChain[0], /^action_utility:execute_silently/);
});

test("pipeline: silenced 提案出队不投递，沉默日志留痕可反问", () => {
  const h = makeHarness();
  try {
    h.presence.markConnected("user-a", NOON - 5 * 60_000);
    const d = h.pipeline.submitProposal(
      proposal({
        title: "低价值推送",
        utility: {
          risk: { reversible: true, financialImpact: "none", dataSensitivity: "none", thirdPartyImpact: false },
          authorization: "implicit",
          value: { expectedValue: 0.2, interruptionCost: 0.5 },
        },
      }),
    );
    assert.equal(d.verdict, "silenced");
    assert.equal(h.delivered.length, 0, "不投递");
    assert.equal(h.pipeline.diagnostics().pending.length, 0, "出队");
    const silences = h.pipeline.diagnostics().recentSilences;
    assert.equal(silences.length, 1);
    assert.equal(silences[0].title, "低价值推送");
    assert.equal(silences[0].scope, "proposal");
    // 反问检索：「为什么没提醒我低价值推送」
    const hit = h.pipeline.searchSilences({ keyword: "低价值" });
    assert.equal(hit.length, 1);
    assert.ok(hit[0].netUtility < 0);
    assert.match(hit[0].reason, /net_utility_negative/);
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test("pipeline: 无 utility 提案投递不写沉默日志（suppressed 语义分离）", () => {
  const h = makeHarness();
  try {
    h.presence.markConnected("user-a", NOON - 5 * 60_000);
    const d = h.pipeline.submitProposal(proposal({ dedupKey: "sup-1" }));
    assert.equal(d.verdict, "delivered");
    assert.equal(h.delivered.length, 1);
    assert.equal(h.pipeline.diagnostics().recentSilences.length, 0, "正常投递不产生沉默记录");
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test("pipeline: 低价值承诺类提案（带 utility）端到端被沉默", () => {
  const h = makeHarness();
  try {
    h.presence.markConnected("user-a", NOON - 5 * 60_000);
    const d = h.pipeline.submitProposal(
      proposal({
        kind: "action.commitment",
        tier: "social",
        importance: "medium",
        dedupKey: "cmt-low",
        title: "承诺提醒",
        utility: {
          risk: { reversible: true, financialImpact: "none", dataSensitivity: "none", thirdPartyImpact: false },
          authorization: "implicit",
          value: { expectedValue: 0.2475, interruptionCost: 0.3 }, // 自动提取置信 0.55 折算
        },
      }),
    );
    assert.equal(d.verdict, "silenced");
    assert.equal(h.delivered.length, 0);
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

// ─── 提案级确认闭环（ask_first + confirmAction）与回退开关 ───

const NUDGE_UTILITY = {
  risk: { reversible: false, financialImpact: "none", dataSensitivity: "none", thirdPartyImpact: true },
  authorization: "none",
  value: { expectedValue: 0.9, interruptionCost: 0.3 },
} as const;

test("pipeline: ask_first+confirmAction 提案投递后登记待确认，批准走回调 + speak 回执", () => {
  const store = new PendingConfirmationStore();
  let approved: ProactiveProposal | null = null;
  // 真实时钟：确认的 expiresAt 基于 nowFn，固定过去时刻的测试时钟会立即被判过期
  const h = makeHarness({
    now: Date.now(),
    confirmations: store,
    onProposalApproved: (p) => {
      approved = p;
    },
  });
  try {
    h.presence.markConnected("user-a", Date.now() - 5 * 60_000);
    const d = h.pipeline.submitProposal(
      proposal({
        kind: "action.commitment.nudge",
        dedupKey: "nudge-1",
        title: "第三方未履约",
        importance: "critical", // 豁免仲裁器静默时段（真实时钟可能落在 23:00-07:00）
        utility: NUDGE_UTILITY,
        confirmAction: { label: "代发催促" },
      }),
    );
    assert.equal(d.verdict, "delivered", "确认文案即本次投递");
    assert.equal(h.delivered.length, 1);

    const pending = store.list("user-a");
    assert.equal(pending.length, 1);
    assert.equal(pending[0].origin, "pipeline");
    assert.equal(pending[0].proposal?.dedupKey, "nudge-1");

    const r = h.pipeline.resolveProposalConfirmation(pending[0], true);
    assert.equal(r.executed, true);
    assert.ok(approved, "onProposalApproved 已回调");
    assert.equal((approved as ProactiveProposal | null).dedupKey, "nudge-1");
    assert.equal(h.spoken.length, 1, "speak 回执");
    assert.match(h.spoken[0].title, /^已确认/);
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test("pipeline: 无 confirmAction 的 ask_first 提案不登记确认（投递即完成）", () => {
  const store = new PendingConfirmationStore();
  const h = makeHarness({ confirmations: store });
  try {
    h.presence.markConnected("user-a", NOON - 5 * 60_000);
    const d = h.pipeline.submitProposal(
      proposal({
        kind: "action.commitment.nudge",
        dedupKey: "nudge-2",
        utility: NUDGE_UTILITY,
      }),
    );
    assert.equal(d.verdict, "delivered");
    assert.equal(store.size(), 0, "普通通知类 ask_first 不产生待确认");
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test("arbiter: PROACTIVITY_UTILITY_EVAL=0 时忽略 utility 元数据（一键回退）", () => {
  process.env.PROACTIVITY_UTILITY_EVAL = "0";
  try {
    const d = arbitrate(
      proposal({
        utility: {
          risk: { reversible: true, financialImpact: "none", dataSensitivity: "none", thirdPartyImpact: false },
          authorization: "implicit",
          value: { expectedValue: 0.2, interruptionCost: 0.5 }, // 开态本应 silenced
        },
      }),
      ctx(),
    );
    assert.equal(d.verdict, "delivered");
    assert.equal(d.utility, undefined, "回退态不产生效用评估结果");
  } finally {
    delete process.env.PROACTIVITY_UTILITY_EVAL;
  }
});

// ─── 代办足迹：actorId 归一 + 告知/执行语义分层 + 实时推送钩子 ───

test("message_watch: 渠道 scoped actor（xxx@wechat）归一为基础 actor", async () => {
  const { MessageWatchTrigger } = await import("../src/proactivity/triggers/message-watch-trigger.js");
  const { resolveChannelScopedSessionId, resolveBaseActorId, isChannelScopedSessionId } =
    await import("../src/agent/master-chat-session.js");
  // 契约前置：桥接侧派生的 scoped id 一定能被剥回原样（往返恒等）
  const scoped = resolveChannelScopedSessionId("session-mvp-001", "wechat");
  assert.ok(isChannelScopedSessionId(scoped));
  assert.equal(resolveBaseActorId(scoped), "session-mvp-001");

  const submitted: ProactiveProposal[] = [];
  const trigger = new MessageWatchTrigger({ submitProposal: (p) => submitted.push(p) });
  trigger.handleInbound({
    actorId: scoped, // 桥接无显式绑定 + 渠道隔离时的真实形态
    platform: "wechat",
    channelId: "conv-1",
    text: "下午的评审会议要延迟到4点了",
    participantName: "王工",
  });
  assert.equal(submitted.length, 1);
  assert.equal(
    submitted[0]!.actorId,
    "session-mvp-001",
    "提案触达与足迹按基础 actor 归属，否则设备收不到、客户端查不到",
  );
});

test("ledger: 告知类自动落库默认「已告知」，显式 status 的执行类不覆盖", async () => {
  const { AgentActivityStore } = await import("../src/proactivity/activity-store.js");
  const dir = mkdtempSync(join(tmpdir(), "activity-label-"));
  try {
    const store = new AgentActivityStore(join(dir, "activities.json"));
    // 告知类：delivery 层自动落库（不传 status/statusLabel）→「已告知」
    const informed = store.record({
      actorId: "user-a", kind: "action.schedule_change",
      title: "发现日程变动", summary: "王工：评审会延迟到4点",
    });
    assert.equal(informed!.status, "changed");
    assert.equal(informed!.statusLabel, "已告知", "告知类不是「办完了」，文案要如实");
    // 执行类：工具链显式上报（status=done）→ 不吃「已告知」默认值
    const executed = store.record({
      actorId: "user-a", kind: "action.schedule_change",
      title: "已把评审会改到16:00", summary: "已同步所有与会人", status: "done",
    });
    assert.equal(executed!.statusLabel, undefined, "执行类走客户端按 status 推导（已完成）");
    // 执行类显式 statusLabel 优先
    const shipping = store.record({
      actorId: "user-a", kind: "action.purchase",
      title: "已为你订购牛奶", summary: "950ml ×1", status: "pending", statusLabel: "配送中",
    });
    assert.equal(shipping!.statusLabel, "配送中");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ledger: onRecord 钩子逐条触发（dedup 吞掉的不触发）", async () => {
  const { AgentActivityStore } = await import("../src/proactivity/activity-store.js");
  const dir = mkdtempSync(join(tmpdir(), "activity-hook-"));
  try {
    const store = new AgentActivityStore(join(dir, "activities.json"));
    const seen: string[] = [];
    store.onRecord = (a) => seen.push(a.id);
    const a = store.record({ actorId: "user-a", kind: "action.payment", title: "已缴水费", summary: "8月 ¥36.5" });
    assert.equal(seen.length, 1);
    // 新 dedupKey 合法落库 → 推送；同 dedupKey 重报 → record 返回 null，不推送
    store.record({ actorId: "user-a", kind: "action.payment", title: "x", summary: "y", dedupKey: "water-8月" });
    assert.equal(seen.length, 2);
    store.record({ actorId: "user-a", kind: "action.payment", title: "z", summary: "w", dedupKey: "water-8月" });
    assert.equal(seen.length, 2, "dedup 命中的重报不触发推送");
    assert.ok(a);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
