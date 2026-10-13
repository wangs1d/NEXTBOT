// ProactivityHub（主动性编排器）集成单测：
// 快路径（任务恭喜/待办闭环/过劳干预/待办跟进）、频控（分 kind 冷却/每日预算）、
// 对话轮入板回调。LLM 通用路径已整体拆除（2026-09-24 架构定稿：决策=状态板映射规则），
// 映射规则场景见 mapping-executor.test.ts。
import assert from "node:assert/strict";
import { test } from "node:test";

import { ProactivityHub } from "../src/proactivity/proactivity-hub.js";
import { FrequencyGovernor } from "../src/proactivity/frequency-governor.js";
import { TurnAsideQueue } from "../src/proactivity/turn-aside-queue.js";

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

test("快路径：过劳信号 → act 三步静默执行（可逆+隐式授权+高价值，不通知）", async () => {
  const { deps, signals, toolCalls } = makeDeps({
    executeTool: async (tool, args) => {
      toolCalls.push({ tool, args });
      if (tool === "media.search") {
        return {
          ok: true,
          result: {
            tracks: [{ id: "t-01", name: "月光", artist: "某人", durationSec: 180 }],
          },
        };
      }
      return { ok: true, result: {} };
    },
  });
  const hub = new ProactivityHub(deps);
  hub.onRhythmSignal(ACTOR, "body.rhythm.overwork_detected", {
    continuousWorkHours: 3.5,
    lateNightActiveCount: 0,
    // 作息基线已学会 → 才排休息提醒（纯作息驱动，无基线时 hub 不发 calendar 步骤）
    learnedBedtimeHour: 23,
  });
  await flush();

  // 三分支语义（方案 C）：过劳干预全部为可逆+已授权（rhythm 隐式）+高净效用
  // → execute_silently 直接执行；做完轻提一句（告知放了歌/排了提醒）
  assert.equal(signals.length, 1);
  assert.equal(signals[0].kind, "overwork_care");

  const tools = toolCalls.map((c) => c.tool);
  assert.deepEqual(tools, ["media.search", "media.play", "calendar.create_task"]);
  // fromStep 链式填参：media.play 拿到 search 结果第一条曲目
  const play = toolCalls[1].args;
  assert.equal(play.trackId, "t-01");
  assert.equal(play.trackName, "月光");
  assert.equal(play.artist, "某人");
  // 休息日程按作息排（就寝 23:00 前 1h → 下一个未过的 22:00）
  assert.equal(toolCalls[2].args.kind, "reminder");
  assert.ok(String(toolCalls[2].args.runAt).includes("T22:00:00"));
  assert.ok(hub.getActAudit(ACTOR).length >= 3, "静默执行仍有 act 审计");
});

test("快路径：非 overwork 的节律信号被忽略", async () => {
  const { deps, signals } = makeDeps();
  const hub = new ProactivityHub(deps);
  hub.onRhythmSignal(ACTOR, "body.rhythm.heartbeat", {});
  await flush();
  assert.equal(signals.length, 0);
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
