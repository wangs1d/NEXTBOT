// ProactivityHub（主动性编排器）集成单测：
// 快路径（任务恭喜/待办闭环/待办跟进）、频控（分 kind 冷却/每日预算）、
// 对话轮入板回调。LLM 通用路径已整体拆除（2026-09-24 架构定稿：决策=状态板映射规则），
// 映射规则场景见 mapping-executor.test.ts。
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ProactivityHub } from "../src/proactivity/proactivity-hub.js";
import { FrequencyGovernor } from "../src/proactivity/frequency-governor.js";
import { TurnAsideQueue } from "../src/proactivity/turn-aside-queue.js";
import { SourceStore } from "../src/proactivity/source-store.js";
import { DiscoveryLayer } from "../src/proactivity/discovery-layer.js";

const ACTOR = "actor-1";

type PublishedSignal = {
  actorId: string;
  kind: string;
  title: string;
  summary: string;
  importance: string;
};

type ToolCall = { tool: string; args: Record<string, unknown> };

function makeDeps(overrides?: {
  executeTool?: (
    tool: string,
    args: Record<string, unknown>,
    actorId: string,
  ) => Promise<{ ok: boolean; result: Record<string, unknown> }>;
  onConversationTurn?: (actorId: string, text: string) => void;
}) {
  const signals: PublishedSignal[] = [];
  const toolCalls: ToolCall[] = [];
  const deps = {
    publishSignal: (s: PublishedSignal) => {
      signals.push(s);
    },
    executeTool:
      overrides?.executeTool ??
      (async (tool: string, args: Record<string, unknown>) => {
        toolCalls.push({ tool, args });
        return { ok: true, result: {} };
      }),
    onConversationTurn: overrides?.onConversationTurn,
    frequencyGovernor: new FrequencyGovernor({
      ignoreEnv: true,
      disableQuietHours: true,
    }),
  };
  return { deps, signals, toolCalls };
}

const flush = () => new Promise((r) => setTimeout(r, 20));

// ── 快路径 ─────────────────────────────────────────────

test("快路径：复杂任务完成 → speak 恭喜信号", async () => {
  const { deps, signals } = makeDeps();
  const hub = new ProactivityHub(deps);
  hub.onAgentTaskCompleted(ACTOR, "整理本周周报并生成图表");
  await flush();
  assert.equal(signals.length, 1);
  assert.equal(signals[0].kind, "task_celebration");
  assert.equal(signals[0].actorId, ACTOR);
  assert.ok(signals[0].summary.includes("周报"));
});

test("快路径：用户待办闭环 → speak 恭喜信号", async () => {
  const { deps, signals } = makeDeps();
  const hub = new ProactivityHub(deps);
  hub.onUserLoopCompleted(ACTOR, "把简历投出去了");
  await flush();
  assert.equal(signals.length, 1);
  assert.equal(signals[0].kind, "task_celebration");
  assert.ok(signals[0].summary.includes("简历"));
});

test("对话轮：followup 强线索 → 规则判主动承接", async () => {
  const turns: Array<{ actorId: string; text: string }> = [];
  const { deps, signals } = makeDeps({
    onConversationTurn: (actorId, text) => turns.push({ actorId, text }),
  });
  const hub = new ProactivityHub(deps);
  hub.observeConversationTurn(ACTOR, "那个简历HR说等结果，帮我盯着点");
  await flush();
  assert.equal(signals.length, 1);
  assert.equal(signals[0].kind, "followup");
  // 对话原话同时整理进状态板回调（会话层）
  assert.equal(turns.length, 1);
  assert.equal(turns[0].text, "那个简历HR说等结果，帮我盯着点");
});

test("对话轮：无强线索 → 静默，但原话仍入板", async () => {
  const turns: string[] = [];
  const { deps, signals } = makeDeps({ onConversationTurn: (_a, text) => turns.push(text) });
  const hub = new ProactivityHub(deps);
  hub.observeConversationTurn(ACTOR, "在忙一个新模块的设计");
  await flush();
  assert.equal(signals.length, 0);
  assert.equal(turns.length, 1);
});

test("对话观察文本截断到 120 字符（入板口径）", async () => {
  const turns: string[] = [];
  const { deps } = makeDeps({ onConversationTurn: (_a, text) => turns.push(text) });
  const hub = new ProactivityHub(deps);
  hub.observeConversationTurn(ACTOR, "长".repeat(300));
  assert.equal(turns[0].length, 120);
});

// ── 频控 ─────────────────────────────────────────────

test("频控：同 kind 冷却期内二次触发被拦", async () => {
  const { deps, signals } = makeDeps();
  const hub = new ProactivityHub(deps);
  hub.onAgentTaskCompleted(ACTOR, "任务一");
  await flush();
  hub.onAgentTaskCompleted(ACTOR, "任务二"); // task_celebration 30min 冷却
  await flush();
  assert.equal(signals.length, 1);
});

test("频控：每日预算耗尽后全部拦截", async () => {
  const signals: PublishedSignal[] = [];
  const hub = new ProactivityHub({
    publishSignal: (s) => signals.push(s),
    executeTool: async () => ({ ok: true, result: {} }),
    frequencyGovernor: new FrequencyGovernor({
      ignoreEnv: true,
      disableQuietHours: true,
      dailyBudget: 1,
    }),
  });
  hub.onAgentTaskCompleted(ACTOR, "任务一");
  await flush();
  assert.equal(signals.length, 1);
  hub.onUserLoopCompleted(ACTOR, "待办一"); // 不同 kind，但预算已尽
  await flush();
  assert.equal(signals.length, 1);
});

// ── 顺嘴搭车（2026-10-01 P1）──────────────────────────────

test("顺嘴搭车：low 级 submitIntent 挂起不即时推送，takeTurnAsideForTurn 取货", async () => {
  const { deps, signals } = makeDeps();
  const queue = new TurnAsideQueue();
  const hub = new ProactivityHub({ ...deps, turnAsideQueue: queue });
  hub.submitIntent({
    actorId: ACTOR,
    kind: "location_arrival",
    importance: "low",
    title: "用户到达常去地点：家",
    summary: "用户刚到家，轻问一句",
    mode: "speak",
    source: "location",
  });
  await flush();
  assert.equal(signals.length, 0, "low 意图不即时推送");
  const aside = hub.takeTurnAsideForTurn(ACTOR);
  assert.ok(aside, "下一轮对话取到顺嘴块");
  assert.match(aside, /【顺嘴机会】/);
  assert.ok(aside.includes("刚到家"));
  assert.equal(hub.takeTurnAsideForTurn(ACTOR), null, "每轮至多一条");
});

test("顺嘴搭车：medium 默认搭车挂起；扩面开关关闭时回退即时；high 恒即时", async () => {
  const { deps, signals } = makeDeps();
  const hub = new ProactivityHub({ ...deps, turnAsideQueue: new TurnAsideQueue() });
  hub.submitIntent({
    actorId: ACTOR,
    kind: "life_reminder",
    importance: "medium",
    title: "降价提醒",
    summary: "关注的商品已降价",
    mode: "speak",
    source: "finance",
  });
  await flush();
  assert.equal(signals.length, 0, "medium 默认搭车挂起（2026-10-01 扩面），不即时推");

  process.env.PROACTIVITY_TURN_ASIDE_MEDIUM = "0";
  try {
    hub.submitIntent({
      actorId: ACTOR,
      kind: "budget_alert",
      importance: "medium",
      title: "预算提醒",
      summary: "本月餐饮超预算",
      mode: "speak",
      source: "finance",
    });
    await flush();
    assert.equal(signals.length, 1, "扩面关闭时 medium 回退即时推送");

    hub.submitIntent({
      actorId: ACTOR,
      kind: "weather_alert",
      importance: "high",
      title: "暴雨预警",
      summary: "今天有暴雨",
      mode: "speak",
      source: "weather",
    });
    await flush();
    assert.equal(signals.length, 2, "high 恒即时，不受扩面影响");
  } finally {
    delete process.env.PROACTIVITY_TURN_ASIDE_MEDIUM;
  }
});

test("顺嘴搭车：未注入队列时 low 照旧即时推送（回退兼容）", async () => {
  const { deps, signals } = makeDeps();
  const hub = new ProactivityHub(deps);
  hub.submitIntent({
    actorId: ACTOR,
    kind: "location_arrival",
    importance: "low",
    title: "到达",
    summary: "到家",
    mode: "speak",
    source: "location",
  });
  await flush();
  assert.equal(signals.length, 1, "无队列回退原路径");
});

// ── 顺嘴搭车 × 共享发现层（2026-10-19 二期：全系统一道开口闸）────────
// 顺嘴搭车是**第二条开口出口**（不经管道投递，而是织进下一轮对话）。
// 这里锁住：取货点也走同一道 composeBeforeOpen——把别的层就同一主题的发现
// 合并进旁注，并"取走即说出"地结算（预留转消费），于是同一发现不会被
// 两个出口（管道 / 旁注）各说一遍。

test("顺嘴搭车取货也走同一开口闸：读走预留并结算消费，正文不拼旁注", async () => {
  const now = () => 1_700_000_400_000;
  const dir = mkdtempSync(join(tmpdir(), "pa-hub-aside-"));
  try {
    const store = new SourceStore({ dataPath: dir, disablePersist: true, nowFn: now, env: {} });
    const discovery = new DiscoveryLayer({ store, nowFn: now });
    const { deps } = makeDeps();
    const hub = new ProactivityHub({ ...deps, turnAsideQueue: new TurnAsideQueue({ nowFn: now }) });
    hub.setDiscovery(discovery);

    // 源 1（如邮件）：就同一主题登记发现，尚未开口
    discovery.write({
      subject: "g_搬家",
      actorId: ACTOR,
      source: "hub:mail",
      content: "房东邮件：搬家要提前一周预约电梯",
    });

    // 源 2（顺嘴搭车）：low 级意图挂起，等下一轮对话取货即开口
    hub.submitIntent({
      actorId: ACTOR,
      kind: "life_reminder",
      importance: "low",
      title: "搬家进度",
      summary: "搬家还有一步没走完",
      mode: "speak",
      source: "finance",
      subject: "g_搬家",
    });
    await flush();

    const aside = hub.takeTurnAsideForTurn(ACTOR);
    assert.ok(aside, "下一轮对话取到顺嘴块");
    assert.match(aside, /搬家还有一步没走完/, "顺嘴块仍是自己的那句话");
    assert.doesNotMatch(aside, /房东邮件/, "他人同主题发现只被读走预留，不拼进旁注");
    assert.equal(
      discovery.findingsFor("g_搬家").length,
      0,
      "取走即说出 → 结算为消费，读走的发现不再被别的出口重说",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
