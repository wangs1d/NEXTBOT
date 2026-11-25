// 2026-11-19 主动性重构 P1：期望效用择时闸 + 离线手机推送 + 未回复自动结算。
//
// 三条链路的共同点：让「什么时候该打扰」不再只靠静默/对话中/离线三个粗维度，
// 也不再把「用户没反应」当成没有信息——忽略是训练分寸感的主要负样本。
//
// 2026-11-23 定调：离线提醒一律走手机系统推送，不再落站内信（站内信只承载
// 后台/运营 → 用户的平台消息）。原「离线落信箱」测试已改为推送语义。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { ProactiveDeliveryService } from "../src/proactivity/delivery-service.js";
import { FrequencyGovernor } from "../src/proactivity/frequency-governor.js";
import { OutcomeStore } from "../src/proactivity/outcome-store.js";
import type { ProactiveProposal } from "../src/proactivity/pipeline-types.js";
import { PresenceService } from "../src/proactivity/presence-service.js";
import { ProactivePipeline } from "../src/proactivity/proactive-pipeline.js";

const NOON = new Date(2026, 10, 19, 12, 0, 0).getTime();
const MIN = 60_000;

function proposal(overrides: Partial<ProactiveProposal> = {}): ProactiveProposal {
  return {
    proposalId: "p_gate",
    actorId: "user-a",
    kind: "agent_pulse",
    tier: "social",
    importance: "low",
    dedupKey: "k_gate",
    title: "",
    summary: "你昨天说的那家店我今天路过了",
    directText: "你昨天说的那家店我今天路过了",
    evidence: ["test"],
    createdAt: NOON,
    source: "initiative",
    ...overrides,
  };
}

type GateResult = { action: "send_now" | "defer" | "batch" | "drop"; reason: string } | null;

type Harness = {
  pipeline: ProactivePipeline;
  presence: PresenceService;
  governor: FrequencyGovernor;
  outcomes: OutcomeStore;
  delivered: Array<{ actorId: string; json: string }>;
  pushed: Array<{ actorId: string; title: string; body: string; kind?: string }>;
  dir: string;
};

function makeHarness(opts: {
  now?: number;
  reachGate?: (p: ProactiveProposal) => GateResult;
  mobilePush?: boolean;
  lastConversationAt?: (actorId: string) => number | null;
} = {}): Harness {
  const dir = mkdtempSync(join(tmpdir(), "proactive-gate-"));
  const presence = new PresenceService();
  const governor = new FrequencyGovernor({ ignoreEnv: true, dailyBudget: 20 });
  const delivered: Harness["delivered"] = [];
  const pushed: Harness["pushed"] = [];
  const outcomes = new OutcomeStore(join(dir, "outcomes.json"));
  const pipeline = new ProactivePipeline({
    dataPath: dir,
    governor,
    suppression: { isSuppressed: () => ({ suppressed: false, reason: "" }) },
    presence,
    delivery: new ProactiveDeliveryService({
      trySend: (actorId, json) => {
        delivered.push({ actorId, json });
        return true;
      },
    }),
    outcomes,
    nowFn: () => opts.now ?? NOON,
    ...(opts.reachGate ? { reachGate: opts.reachGate } : {}),
    ...(opts.mobilePush
      ? {
          mobilePush: {
            hasChannel: () => true,
            push: async (input) => {
              pushed.push({ actorId: input.actorId, title: input.title, body: input.body, kind: input.kind });
              return { ok: true, provider: "test" };
            },
          },
          transcriptAppend: () => {},
        }
      : {}),
    ...(opts.lastConversationAt ? { lastConversationAt: opts.lastConversationAt } : {}),
  });
  return { pipeline, presence, governor, outcomes, delivered, pushed, dir };
}

function withHarness(h: Harness, fn: () => void): void {
  try {
    fn();
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
}

// ─── reachGate：把效用决策接进投递链 ───────────────────────────────

test("reachGate: drop → silenced（不投递，原因留痕）", () => {
  const h = makeHarness({ reachGate: () => ({ action: "drop", reason: "net_utility_negative" }) });
  withHarness(h, () => {
    h.presence.markConnected("user-a", NOON - 5 * MIN);
    const d = h.pipeline.submitProposal(proposal());
    assert.equal(d.verdict, "silenced");
    assert.equal(h.delivered.length, 0, "判死就不投");
    assert.ok(d.reasonChain.some((r) => r.includes("reach_gate:drop")), "留痕可解释");
  });
});

test("reachGate: defer → 延后 20min 再判（等用户从专注里出来）", () => {
  const h = makeHarness({ reachGate: () => ({ action: "defer", reason: "high_context_cost" }) });
  withHarness(h, () => {
    h.presence.markConnected("user-a", NOON - 5 * MIN);
    const d = h.pipeline.submitProposal(proposal());
    assert.equal(d.verdict, "deferred");
    assert.equal(d.deliverAfter, NOON + 20 * MIN);
    assert.equal(h.delivered.length, 0);
  });
});

test("reachGate: 连续延后 4 次后强制放行（不把消息饿死）", () => {
  let calls = 0;
  const h = makeHarness({
    reachGate: () => {
      calls += 1;
      return { action: "defer", reason: "still_busy" };
    },
  });
  withHarness(h, () => {
    h.presence.markConnected("user-a", NOON - 5 * MIN);
    const first = h.pipeline.submitProposal(proposal());
    assert.equal(first.verdict, "deferred");
    // 每轮推进 21min（deliverAfter = 重判时刻 + 20min，固定时刻重复 flush 永远不到期）
    for (let i = 1; i <= 6; i++) h.pipeline.flushDue(NOON + i * 21 * MIN);
    assert.ok(calls >= 5, `决策被复判（实际 ${calls} 次）`);
    assert.equal(h.delivered.length, 1, "最终放行，消息没有饿死");
  });
});

test("reachGate: must 层与 topic_dismiss 元反馈不过闸", () => {
  let calls = 0;
  const h = makeHarness({
    reachGate: () => {
      calls += 1;
      return { action: "drop", reason: "should_not_apply" };
    },
  });
  withHarness(h, () => {
    h.presence.markConnected("user-a", NOON - 5 * MIN);
    const must = h.pipeline.submitProposal(proposal({ dedupKey: "k_must", tier: "must", importance: "high" }));
    assert.equal(must.verdict, "delivered", "must 是用户点名的事，不被软分寸拦");
    const meta = h.pipeline.submitProposal(
      proposal({ dedupKey: "k_meta", source: "topic_dismiss", title: "少提这类？" }),
    );
    assert.equal(meta.verdict, "delivered", "静音建议必须送达，否则用户没法表达不满");
    assert.equal(calls, 0, "两类都没进闸");
  });
});

test("reachGate: 决策层异常 → 放行（绝不吞消息）", () => {
  const h = makeHarness({
    reachGate: () => {
      throw new Error("boom");
    },
  });
  withHarness(h, () => {
    h.presence.markConnected("user-a", NOON - 5 * MIN);
    const d = h.pipeline.submitProposal(proposal());
    assert.equal(d.verdict, "delivered");
    assert.equal(h.delivered.length, 1);
  });
});

// ─── 离线手机推送（2026-11-23：站内信已移除，提醒离线只走手机系统推送）───

test("离线 social → 走手机系统推送（不落站内信），并标记已投递不再补推", async () => {
  const h = makeHarness({ mobilePush: true });
  try {
    // 不 markConnected：两端在线状态为空 → arbitrate 判 offline_wait_reconnect
    const d = h.pipeline.submitProposal(proposal());
    assert.equal(d.verdict, "deferred");
    await new Promise((r) => setImmediate(r));
    assert.equal(h.pushed.length, 1, "推了一次手机系统通知");
    assert.equal(h.pushed[0].kind, "agent_pulse", "客户端可识别来源");
    assert.ok(h.pushed[0].body.includes("那家店"));
    const rec = h.outcomes.recent(5).at(-1);
    assert.equal(rec?.channel, "mobile_push");
    assert.equal(rec?.tier, "social");
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test("离线 social 无推送通道 → 丢弃（不挂起、不落站内信）", async () => {
  const h = makeHarness(); // 不注入 mobilePush
  try {
    h.pipeline.submitProposal(proposal({ dedupKey: "k_social_no_push" }));
    await new Promise((r) => setImmediate(r));
    assert.equal(h.pushed.length, 0, "无通道不推送");
    assert.equal(h.delivered.length, 0, "离线不直推");
    // 2026-11-24 定调：系统推送是离线唯一出口，无通道即丢弃——不挂起等重连补旧内容
    assert.equal(h.pipeline.diagnostics().pending.length, 0, "无通道即丢弃，不挂起重连补投");
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

// ─── 未回复自动结算 ────────────────────────────────────────────

test("未回复结算: social 发出 6h 无对话 → ignored（负样本回灌冷却）", () => {
  const h = makeHarness();
  withHarness(h, () => {
    h.presence.markConnected("user-a", NOON - 5 * MIN);
    h.pipeline.submitProposal(proposal());
    const settled = h.pipeline.sweepUnanswered(NOON + 7 * 60 * MIN);
    assert.equal(settled, 1);
    const rec = h.outcomes.recent(5).at(-1);
    assert.equal(rec?.outcome, "ignored");
  });
});

test("未回复结算: 期间用户说过话 → replied（正样本）", () => {
  // 用可变时钟：投递时还没有对话（否则会被判「对话中」顺延），结算时才有
  let lastConv: number | null = null;
  const h = makeHarness({ lastConversationAt: () => lastConv });
  withHarness(h, () => {
    h.presence.markConnected("user-a", NOON - 5 * MIN);
    h.pipeline.submitProposal(proposal());
    lastConv = NOON + 30 * MIN;
    h.pipeline.sweepUnanswered(NOON + 7 * 60 * MIN);
    const rec = h.outcomes.recent(5).at(-1);
    assert.equal(rec?.outcome, "replied");
  });
});

test("未回复结算: must 层不参与（处理完没回话不算忽略）", () => {
  const h = makeHarness();
  withHarness(h, () => {
    h.presence.markConnected("user-a", NOON - 5 * MIN);
    h.pipeline.submitProposal(proposal({ tier: "must", importance: "high", dedupKey: "k_must_sweep" }));
    const settled = h.pipeline.sweepUnanswered(NOON + 7 * 60 * MIN);
    assert.equal(settled, 0);
  });
});

test("未回复结算: 未到窗口（<6h）不结算", () => {
  const h = makeHarness();
  withHarness(h, () => {
    h.presence.markConnected("user-a", NOON - 5 * MIN);
    h.pipeline.submitProposal(proposal());
    assert.equal(h.pipeline.sweepUnanswered(NOON + 2 * 60 * MIN), 0);
  });
});
