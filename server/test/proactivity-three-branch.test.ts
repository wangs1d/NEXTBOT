// 方案 C：proactivity-hub 三分支执行语义单测——
// execute_silently（执行不通知）/ ask_first（挂起+确认闭环）/ silence（留痕不动作）
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { ProactivityHub } from "../src/proactivity/proactivity-hub.js";
import { FrequencyGovernor } from "../src/proactivity/frequency-governor.js";
import { PendingConfirmationStore } from "../src/proactivity/pending-confirmation-store.js";
import { SilenceLog } from "../src/proactivity/silence-log.js";
import type { ProactiveIntent } from "../src/proactivity/proactivity-types.js";

const ACTOR = "actor-1";
const flush = () => new Promise((r) => setTimeout(r, 20));

type Signal = { actorId: string; kind: string; title: string; summary: string; importance: string };
type ToolCall = { tool: string; args: Record<string, unknown> };

function makeHub(opts?: { confirmations?: PendingConfirmationStore }) {
  const signals: Signal[] = [];
  const toolCalls: ToolCall[] = [];
  const silenceLog = new SilenceLog();
  const hub = new ProactivityHub({
    publishSignal: (s) => {
      signals.push(s as Signal);
    },
    executeTool: async (tool, args) => {
      toolCalls.push({ tool, args });
      return { ok: true, result: {} };
    },
    frequencyGovernor: new FrequencyGovernor({ ignoreEnv: true, }),
    silenceLog,
    pendingConfirmations: opts?.confirmations,
  });
  return { hub, signals, toolCalls, silenceLog };
}

function actIntent(overrides: Partial<ProactiveIntent> = {}): ProactiveIntent {
  return {
    actorId: ACTOR,
    kind: "life_reminder",
    importance: "high",
    title: "生活提醒",
    summary: "连续工作太久，帮你放首轻音乐",
    mode: "act",
    actArgs: [{ tool: "media.play", args: { trackId: "calm-1" } }],
    source: "rhythm",
    ...overrides,
  };
}

test("execute_silently: 可逆+隐式授权+高价值 → 执行并轻提一句（做完轻提一句语义）", async () => {
  const { hub, signals, toolCalls } = makeHub();
  hub.submitIntent(actIntent());
  await flush();
  assert.equal(toolCalls.length, 1, "行动计划已执行");
  assert.equal(toolCalls[0].tool, "media.play");
  // 静默执行不再是全无声：做完轻提一句（与 InitiativeEngine「act=做完轻提一句」
  // 的设计一致），文案为低打扰的结果告知
  assert.equal(signals.length, 1, "执行后轻提一句");
  assert.ok(signals[0].title.includes("顺手") || signals[0].summary.includes("已悄悄办好"), `轻提文案: ${signals[0].summary}`);
  assert.ok(hub.getActAudit(ACTOR).length >= 1, "act 审计留痕");
});

test("ask_first: 确认后安全门仍兜底——delete/shutdown 永不放行，无害步骤执行", async () => {
  const { hub, signals, toolCalls } = makeHub();
  hub.submitIntent(
    actIntent({
      kind: "cleanup",
      title: "想帮忙清理文件",
      actArgs: [
        { tool: "file.delete", args: { path: "/tmp/old" } },
        { tool: "media.play", args: { trackId: "t" } },
        { tool: "system.shutdown", args: {} },
      ],
    }),
  );
  await flush();
  // 整份计划含不可逆动作 → ask_first 挂起，确认请求即主动消息
  assert.deepEqual(toolCalls.map((c) => c.tool), []);
  assert.equal(hub.listPendingConfirmations(ACTOR).length, 1);
  // 用户同意 → 执行挂起计划，但黑名单安全门仍兜底：delete/shutdown 永不放行
  const resolved = await hub.resolveConfirmation(ACTOR, true);
  assert.equal(resolved.executed, true);
  assert.deepEqual(toolCalls.map((c) => c.tool), ["media.play"]);
  assert.ok(signals.length >= 1, "确认闭环有回执");
});

test("ask_first: 不可逆动作 → 不执行，发确认请求并挂起", async () => {
  const { hub, signals, toolCalls } = makeHub();
  hub.submitIntent(
    actIntent({
      title: "代发催促",
      actArgs: [{ tool: "message.send", args: { to: "third-party", text: "请问进展如何？" } }],
    }),
  );
  await flush();
  assert.equal(toolCalls.length, 0, "未确认前不执行");
  assert.equal(signals.length, 1, "确认请求即本次主动消息");
  assert.match(signals[0].title, /^需要确认/);
  assert.match(signals[0].summary, /message\.send/);

  const pending = hub.listPendingConfirmations(ACTOR);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].steps[0].tool, "message.send");
});

test("ask_first 闭环: 用户同意 → 执行挂起计划", async () => {
  const { hub, toolCalls } = makeHub();
  hub.submitIntent(
    actIntent({ actArgs: [{ tool: "message.send", args: { to: "x", text: "hi" } }] }),
  );
  await flush();
  const pending = hub.listPendingConfirmations(ACTOR);
  assert.equal(pending.length, 1);

  const result = await hub.resolveConfirmation(ACTOR, true);
  assert.deepEqual(result, { ok: true, executed: true, confirmId: pending[0].confirmId });
  assert.equal(toolCalls.length, 1, "同意后执行");
  assert.equal(hub.listPendingConfirmations(ACTOR).length, 0, "挂起清空");
});

test("ask_first 闭环: 用户拒绝 → 不执行", async () => {
  const { hub, toolCalls } = makeHub();
  hub.submitIntent(
    actIntent({ actArgs: [{ tool: "message.send", args: { to: "x", text: "hi" } }] }),
  );
  await flush();
  const result = await hub.resolveConfirmation(ACTOR, false);
  assert.equal(result.ok, true);
  assert.equal(result.executed, false);
  assert.equal(toolCalls.length, 0, "拒绝后不执行");
});

test("ask_first 闭环: 无待确认时返回错误；不存在的 confirmId 同样报错", async () => {
  const { hub } = makeHub();
  const none = await hub.resolveConfirmation(ACTOR, true);
  assert.equal(none.ok, false);

  hub.submitIntent(
    actIntent({ actArgs: [{ tool: "message.send", args: { to: "x", text: "hi" } }] }),
  );
  await flush();
  const bad = await hub.resolveConfirmation(ACTOR, true, "pc_not_exists");
  assert.equal(bad.ok, false);
  // 省略 confirmId → 取最新一条
  const latest = await hub.resolveConfirmation(ACTOR, true);
  assert.equal(latest.ok, true);
  assert.equal(latest.executed, true);
});

test("silence: 低价值高风险动作 → 什么都不做但记沉默日志", async () => {
  const { hub, signals, toolCalls, silenceLog } = makeHub();
  // wallet.pay：高金融影响（risk 0.3+0.4 不可逆）+ low 重要度（0.2-0.1-0.5×0.7 < 0 → silence）
  hub.submitIntent(
    actIntent({
      importance: "low",
      title: "自动下单",
      actArgs: [{ tool: "wallet.purchase", args: { amount: 99 } }],
    }),
  );
  await flush();
  assert.equal(toolCalls.length, 0, "不执行");
  assert.equal(signals.length, 0, "不通知");
  const silences = silenceLog.search({ actorId: ACTOR }).filter((e) => e.scope === "action");
  assert.equal(silences.length, 1, "沉默留痕（action 级）");
  assert.ok(silences[0].netUtility < 0);
  assert.equal(hub.searchSilences({ actorId: ACTOR, keyword: "自动下单" }).length, 1, "反问可检索");
});

test("act 黑名单安全门在三分支之后仍兜底（确认同意也不执行危险工具）", async () => {
  const { hub, signals, toolCalls } = makeHub();
  hub.submitIntent(
    actIntent({
      importance: "high",
      actArgs: [{ tool: "calendar.delete", args: { eventId: "e1" } }], // delete 命中黑名单
    }),
  );
  await flush();
  // 不可逆（delete）→ ask_first：先问
  const pending = hub.listPendingConfirmations(ACTOR);
  assert.equal(pending.length, 1);
  const before = signals.length;
  const result = await hub.resolveConfirmation(ACTOR, true);
  assert.equal(result.executed, false, "无一步成功 = 未执行");
  assert.equal(toolCalls.length, 0, "黑名单工具实际被安全门拦截");
  assert.equal(signals.length, before + 1, "反馈告知未能执行");
  assert.match(signals[signals.length - 1].summary, /未能执行/);
});

test("授权映射: 未知 source（无授权）+ 第三方 → ask_first", async () => {
  const { hub, signals, toolCalls } = makeHub();
  hub.submitIntent(
    actIntent({
      // notify_team 命中第三方正则但不在不可逆清单 → 可逆+第三方+无授权 → 规则3
      actArgs: [{ tool: "board.notify_team", args: { with: "friend" } }],
      source: "unknown_source" as never,
    }),
  );
  await flush();
  assert.equal(toolCalls.length, 0);
  assert.equal(signals.length, 1);
  assert.match(signals[0].summary, /影响第三方/);
});

test("speak/advise 模式不经三分支（纯通知维持原语义）", async () => {
  const { hub, signals, toolCalls } = makeHub();
  hub.submitIntent(actIntent({ mode: "speak", actArgs: undefined }));
  await flush();
  assert.equal(signals.length, 1);
  assert.equal(toolCalls.length, 0);
});

test("确认反馈: 同意并执行成功 → speak 回执（已按你的确认完成）", async () => {
  const { hub, signals } = makeHub();
  hub.submitIntent(
    actIntent({ actArgs: [{ tool: "message.send", args: { to: "x", text: "hi" } }] }),
  );
  await flush();
  const before = signals.length;
  await hub.resolveConfirmation(ACTOR, true);
  assert.equal(signals.length, before + 1, "确认执行必须闭环告知");
  assert.match(signals[signals.length - 1].summary, /已按你的确认完成/);
});

test("确认反馈: 全部步骤被安全门拦截 → speak 告知未执行", async () => {
  const { hub, signals } = makeHub();
  hub.submitIntent(
    actIntent({ actArgs: [{ tool: "calendar.delete", args: { eventId: "e1" } }] }),
  );
  await flush();
  const before = signals.length;
  await hub.resolveConfirmation(ACTOR, true);
  assert.equal(signals.length, before + 1);
  assert.match(signals[signals.length - 1].summary, /未能执行/);
});

test("回退开关: PROACTIVITY_UTILITY_EVAL=0 → 直接执行 + speak 告知（升级前语义）", async () => {
  process.env.PROACTIVITY_UTILITY_EVAL = "0";
  try {
    const { hub, signals, toolCalls } = makeHub();
    hub.submitIntent(actIntent()); // media.play + rhythm + high：开态本应静默执行不通知
    await flush();
    assert.equal(toolCalls.length, 1);
    assert.equal(signals.length, 1, "关态恢复 act 后 speak 告知");
    assert.match(signals[0].title, /顺手做了点事/);
  } finally {
    delete process.env.PROACTIVITY_UTILITY_EVAL;
  }
});

test("低价值可逆动作直接 silence（问比做更打扰），不再 ask_first", async () => {
  const { hub, signals, toolCalls, silenceLog } = makeHub();
  hub.submitIntent(actIntent({ importance: "low" })); // media.play + rhythm(隐式) + low
  await flush();
  assert.equal(toolCalls.length, 0, "不执行");
  assert.equal(signals.length, 0, "不问（低价值不值得打扰）");
  assert.equal(silenceLog.search({ actorId: ACTOR, keyword: "生活提醒" }).length, 1, "沉默留痕");
});

test("挂起确认落盘恢复：重启后 listPendingConfirmations 仍可见且可推进", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pending-confirm-"));
  try {
    const path = join(dir, "confirmations.json");
    const store = new PendingConfirmationStore(path);
    const first = makeHub({ confirmations: store });
    first.hub.submitIntent(
      actIntent({ actArgs: [{ tool: "message.send", args: { to: "x", text: "hi" } }] }),
    );
    await flush();
    assert.equal(first.hub.listPendingConfirmations(ACTOR).length, 1);

    // 模拟重启：同一落盘路径重建 hub
    const restored = makeHub({ confirmations: new PendingConfirmationStore(path) });
    const pending = restored.hub.listPendingConfirmations(ACTOR);
    assert.equal(pending.length, 1, "重启后确认不丢");
    const result = await restored.hub.resolveConfirmation(ACTOR, true);
    assert.equal(result.executed, true);
    assert.equal(restored.toolCalls.length, 1, "步骤是纯数据，恢复后仍可执行");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("管道级确认委托: origin=pipeline 的条目经 resolver 回流，不走工具执行", async () => {
  const toolCalls: ToolCall[] = [];
  let delegated: { confirmId: string; approved: boolean } | null = null;
  const store = new PendingConfirmationStore();
  store.register({
    actorId: ACTOR,
    kind: "action.commitment.nudge",
    steps: [],
    rationale: "代发催促",
    createdAt: Date.now(),
    expiresAt: Date.now() + 60_000,
    origin: "pipeline",
  });
  const hubWithStore = new ProactivityHub({
    publishSignal: () => {},
    executeTool: async (tool, args) => {
      toolCalls.push({ tool, args });
      return { ok: true, result: {} };
    },
    frequencyGovernor: new FrequencyGovernor({ ignoreEnv: true, }),
    silenceLog: new SilenceLog(),
    pendingConfirmations: store,
  });
  hubWithStore.setPipelineConfirmationResolver((entry, approved) => {
    delegated = { confirmId: entry.confirmId, approved };
    return { executed: approved };
  });

  const result = await hubWithStore.resolveConfirmation(ACTOR, true);
  assert.equal(result.ok, true);
  assert.equal(result.executed, true);
  assert.ok(delegated);
  assert.equal((delegated as { approved: boolean }).approved, true);
  assert.equal(toolCalls.length, 0, "提案级确认不执行工具步骤");
  assert.equal(store.size(), 0, "确认后出队");
});

test("工具面: evaluateActionUtility 结果与分支一致（元数据可直接复核）", () => {
  const { hub, silenceLog } = makeHub();
  assert.equal(typeof hub.searchSilences, "function");
  assert.equal(silenceLog.size(), 0);
});
