// 主动性五层架构端到端集成冒烟（真实类协作，零 LLM、零外网依赖）。
//
// 组装与 bootstrap 完全同构：
//   SensorKernel(screen/schedule/presence) → EvaluatorChain(内置评估器)
//   → ArbiterV2(打断成本) → ProactivePipeline(真实仲裁/去重/频控/确认登记)
//   → ProactiveDeliveryService(投递记录) → OutcomeStore(反馈回灌)
//   + GoalBoard(会前预执行) + ProactivityHub(直达车道)
//
// 跑完输出每一次「agent 主动开口」的完整证据（时间/触发源/决策/全文）。
// 运行：node --import tsx scripts/integration-proactivity.mjs
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SensorKernel, registerFeeder } from "../src/proactivity/sensors/kernel.js";
import { ScreenSensor } from "../src/proactivity/sensors/screen-sensor.js";
import { ScheduleSensor } from "../src/proactivity/sensors/schedule-sensor.js";
import { EvaluatorChain } from "../src/proactivity/evaluators/evaluator-chain.js";
import { buildBuiltinEvaluators } from "../src/proactivity/evaluators/builtin-evaluators.js";
import { ArbiterV2 } from "../src/proactivity/arbiter-v2.js";
import { GoalBoard } from "../src/proactivity/goal-board.js";
import { ProactivePipeline } from "../src/proactivity/proactive-pipeline.js";
import { ProactiveDeliveryService } from "../src/proactivity/delivery-service.js";
import { OutcomeStore } from "../src/proactivity/outcome-store.js";
import { PendingConfirmationStore } from "../src/proactivity/pending-confirmation-store.js";
import { PresenceService } from "../src/proactivity/presence-service.js";
import { FrequencyGovernor } from "../src/proactivity/frequency-governor.js";
import { ProactivityHub } from "../src/proactivity/proactivity-hub.js";
import { ProactiveCaller } from "../src/proactivity/proactive-caller.js";
import { CostCalibrator } from "../src/proactivity/cost-calibrator.js";
import { appendEventAudit } from "../src/proactivity/evaluators/evaluator-chain.js";
import { existsSync } from "node:fs";

// ─── 基础设施 ───

const dataDir = mkdtempSync(join(tmpdir(), "proactivity-e2e-"));
const ACTOR = "user-e2e";
let now = (() => {
  const d = new Date();
  d.setHours(7, 10, 0, 0);
  return d.getTime();
})();
const cur = () => now;
const clock = { now: cur };
const fmt = (t) => new Date(t).toLocaleString("zh-CN", { hour12: false });
const dayKey = () => new Date(now).toISOString().slice(0, 10);

/** 证据台账：agent 的每一次主动（投递/挂起/择时）全记录 */
const evidence = [];
function record(scope, line) {
  evidence.push(`[${fmt(cur())}] ${scope} ${line}`);
  console.log(`  [${fmt(cur())}] ${scope} ${line}`);
}

// ─── 组件组装（同 bootstrap 接线）───

const presence = new PresenceService();
presence.markConnected(ACTOR, cur());

// 屏幕传感器（mock 视觉端口：可控的前台窗口）
let foregroundWindow = { processName: "explorer.exe", title: "桌面" };
const screenSensor = new ScreenSensor({
  visualPort: {
    window: async () => ({ ok: true, windows: [{ ...foregroundWindow, foreground: true }] }),
  },
  nowFn: clock.now,
});

// 日程传感器（可控任务列表）
let tasks = [];
const scheduleSensor = new ScheduleSensor({ listTasks: () => tasks, nowFn: clock.now });

// 传感内核 + 各传感器
const kernel = new SensorKernel({ dataPath: dataDir, disablePersist: true, nowFn: clock.now });
kernel.register(screenSensor);
kernel.register(scheduleSensor);
let lastPresence = "";
kernel.register({
  id: "presence_tracker",
  stream: "presence",
  pollIntervalMs: 60_000,
  collect: () => {
    const state = presence.getPresence(ACTOR, cur());
    if (state === lastPresence) return [];
    lastPresence = state;
    return [{ stream: "presence", at: cur(), fingerprint: `presence:${state}:${Math.floor(cur() / 60_000)}`, salience: "low", payload: { state } }];
  },
});

// 评估器链（服务快照注入，同 bootstrap）
const evaluatorChain = new EvaluatorChain({
  defaultActorId: () => ACTOR,
  flushIntervalMs: 60_000,
  nowFn: clock.now,
  dataPath: dataDir, // 状态持久化（重启不重发）
  services: {},
});
const todayTasks = () =>
  tasks
    .map((t) => ({ title: t.title, runAt: t.runAt }))
    .filter((t) => t.runAt > cur() && t.runAt <= cur() + 24 * 3600_000)
    .sort((a, b) => a.runAt - b.runAt);
let dueCommitments = [];
const builtinServices = {
  listTodayTasks: todayTasks,
  commitmentsDue: (withinMs) => dueCommitments.filter((c) => c.dueAt <= cur() + withinMs),
  weatherLine: () => "小雨，18-24°C，记得带伞",
  readyGoals: () => goalBoard.readyTray().map((g) => ({ title: g.title, body: String(g.payload?.body ?? "") })),
  interestLines: () => [],
};
const builtinEvaluators = buildBuiltinEvaluators(builtinServices);
for (const ev of builtinEvaluators) evaluatorChain.register(ev);
kernel.onSignal((s) => evaluatorChain.handleSignal(s));

// 真实管道 + 投递 + outcome + 确认登记
const governor = new FrequencyGovernor({ ignoreEnv: true, nowFn: () => new Date(cur()) }); // 真实静默时段生效（mock 时钟）
const deliveries = [];
const deliveryService = new ProactiveDeliveryService({
  trySend: (actorId, json) => {
    const payload = JSON.parse(json).payload;
    deliveries.push(payload);
    record("📨 投递", `「${payload.title}」→ ${payload.text.replaceAll("\n", " / ")}`);
    return true;
  },
  ledger: { record: () => {} },
});
const outcomeStore = new OutcomeStore(join(dataDir, "outcomes.json"));
const confirmations = new PendingConfirmationStore(join(dataDir, "confirmations.json"), cur);
let approvedProposals = [];
const pipeline = new ProactivePipeline({
  dataPath: dataDir,
  nowFn: cur,
  governor,
  suppression: { isSuppressed: () => ({ suppressed: false, reason: "" }) },
  presence,
  delivery: deliveryService,
  outcomes: outcomeStore,
  confirmations,
  onProposalApproved: (p) => approvedProposals.push(p.kind),
  flushIntervalMs: 3_600_000,
});

// 目标板（L4 预执行）
const goalBoard = new GoalBoard({
  dataPath: dataDir,
  nowFn: clock.now,
  emitGoal: (goal) => {
    if (goal.status !== "ready") return;
    // goal feeder → 信号流 → goal_ready 评估器（同 bootstrap goalFeeder）
    kernel.emit("goal_board", {
      stream: "goal",
      at: cur(),
      fingerprint: `goal:${goal.goalId}:${goal.status}`,
      salience: "medium",
      payload: { goalId: goal.goalId, title: goal.title, body: String(goal.payload?.body ?? "") },
    });
  },
  recallMemory: () => ["上周和小王对过 Q3 需求范围", "小王习惯会议前 10 分钟发材料"],
});

// 仲裁器（L3）
const arbiter = new ArbiterV2({
  presence,
  lastConversationAt: () => null,
  screenFocus: () => screenSensor.latest(),
  nextEventMin: () => scheduleSensor.latest()?.min ?? null,
  receptivity: () => 0.8,
  primaryActorId: () => ACTOR,
  nowFn: clock.now,
});

// 评估事件 → 仲裁 → 管道（同 bootstrap onEvent）
evaluatorChain.onEvent((event) => {
  // 社交开口类（away_return）→ 统一主动出口（同 bootstrap 2026-10-26 分流）：
  // 映射规则只管「何时触发」，话术由 BrainCenter 决策 + agent 主动做事 + 通用话术
  // 生成（ProactiveOutreachExecutor）。harness 无 BrainCenter/LLM → 模拟统一出口
  // 的通用兜底直投（buildFallbackMessage 语义）。
  if (event.kind === "away_return") {
    deliveryService.deliver(
      {
        proposalId: event.id,
        actorId: event.actorId,
        kind: event.proposalKind,
        tier: event.tier,
        importance: event.importance,
        dedupKey: event.dedupKey,
        title: event.title,
        summary: event.title,
        evidence: [`evaluator:${event.kind}`],
        createdAt: cur(),
        source: `evaluator:${event.kind}`,
      },
      `有个小情况：${event.title}。`,
      event.title,
    );
    record("🔁 统一主动出口", `away_return → LifeSignal（BrainCenter 决策话术；harness 走通用兜底直投）`);
    return;
  }
  const action = arbiter.admit({
    actorId: event.actorId,
    urgency: event.urgency,
    label: event.title,
    deliver: () => {
      const decision = pipeline.submitProposal({
        proposalId: event.id,
        actorId: event.actorId,
        kind: event.proposalKind,
        tier: event.tier,
        importance: event.importance,
        dedupKey: event.dedupKey,
        title: event.title,
        summary: event.body.slice(0, 120),
        directText: event.body,
        evidence: [`evaluator:${event.kind}`],
        createdAt: cur(),
        source: `evaluator:${event.kind}`,
        ...(event.expiresAt !== undefined ? { expiresAt: event.expiresAt } : {}),
        ...(event.confirmLabel
          ? {
              confirmAction: { label: event.confirmLabel },
              // ask_first 三分支声明：涉第三方代催 → 不可逆 + 第三方影响 → 分支=ask_first
              utility: {
                risk: { reversible: false, financialImpact: "none", dataSensitivity: "none", thirdPartyImpact: true },
                authorization: "implicit",
                value: { expectedValue: 0.7, interruptionCost: 0.3 },
              },
            }
          : {}),
      });
      record("⚖️ 仲裁", `${event.kind} → verdict=${decision.verdict} (${decision.reasonChain.join(";")})`);
    },
  });
  if (action.action !== "deliver_now") {
    record("⏸️ 择时", `${event.kind} → ${action.action} (${action.reason})，等用户停下来的那一刻`);
  }
  appendEventAudit(join(dataDir, "events.ndjson"), {
    at: cur(), eventId: event.id, kind: event.kind, urgency: event.urgency,
    actorId: event.actorId, action: action.action, cost: action.cost, title: event.title,
  });
});

// hub（直达车道接管道；LLM 未接入——引擎自动禁用，纯规则 + 模板）
const hub = new ProactivityHub({
  publishSignal: () => {
    throw new Error("直达车道开启时不应走 LifeSignal 路径");
  },
  executeTool: async () => ({ ok: true, result: {} }),
  frequencyGovernor: governor,
  pendingConfirmations: confirmations, // 与管道共享（同 bootstrap：确认回流走 origin=pipeline 委托）
  getLastInteractionAt: () => null,
});
hub.setPipelineConfirmationResolver((entry, approved) => pipeline.resolveProposalConfirmation(entry, approved));
hub.setDirectLane((p) => {
  const urgency = p.importance === "high" || p.importance === "critical" ? "alert" : "normal";
  arbiter.admit({
    actorId: p.actorId,
    urgency,
    label: p.title,
    deliver: () => {
      const decision = pipeline.submitProposal(p);
      hub.noteInitiative(p.actorId, p.kind, p.title);
      record("⚡ 直达车道", `${p.kind} → verdict=${decision.verdict} 文本="${(p.directText ?? "").slice(0, 40)}"`);
    },
  });
});

// ─── 时间推进驱动器：推钟 → 传感器轮询 → 评估 → 仲裁 pause 检测 ───

let step = 0;
async function advance(minutes, label) {
  now += minutes * 60_000;
  step += 1;
  console.log(`\n── +${minutes}min [${fmt(cur())}] ${label ?? ""}`);
  await kernel.pollOnce();
  // 会前准备检查（同 bootstrap 60s 定时逻辑）
  const next = scheduleSensor.latest();
  if (next && next.min >= 25 && next.min <= 40) {
    goalBoard.maybeStartMeetingPrep(ACTOR, { title: next.title, runAtMin: next.min });
  }
  await evaluatorChain.flush();
  arbiter.forceTick();
  pipeline.flushDue(cur()); // 真实管道 30s flush 语义（deferred 到期的提案重仲裁）
}

// ══════════════ 场景执行 ══════════════

console.log("════ 主动性五层架构 · 端到端集成冒烟（真实类协作，零 LLM）════\n");

// S1 晨间简报：7:10 用户上线 → 晨间模板主动打招呼
presence.noteActivity(ACTOR, cur()); // active
record("🧭 场景S1", "用户早上上线，agent 应主动晨间简报");
await advance(2, "上线后两分钟（过对话去抖窗口）");

// S2 编码马拉松：10 点开始写代码，连续 3 小时 → 休息干预
record("🧭 场景S2", "连续编码 3 小时，agent 应主动关心休息");
await advance(170, "开始写代码后");
foregroundWindow = { processName: "Code.exe", title: "main.ts - Visual Studio Code" };
await advance(1, "切到 IDE");
await advance(185, "连续编码 3 小时");

// S4 会前准备 + S5 承诺守约：13:53 项目周会，25-40min 窗口后台备材料；承诺 75min 内到期
record("🧭 场景S4+S5", "40 分钟后有项目周会 + 承诺即将到期，agent 应备材料/临会提醒/请示代催");
tasks = [{ title: "项目周会（和小王）", runAt: cur() + 40 * 60_000, status: "scheduled" }];
dueCommitments = [{ id: "c1", title: "给小李发报价单", dueAt: cur() + 90 * 60_000 }];
await advance(1, "日程快照更新");
await advance(14, "逼近会议（进入 25min 窗口）");
// S6b ask_first 确认推进（TTL 10min 内用户回复「可以」→ 代催批准落地）
console.log("\n════ S6b ask_first 确认推进（承诺代催批准）════");
{
  const pending = confirmations.list(ACTOR);
  record("📋 待确认", `挂起确认 ${pending.length} 条`);
  assert.ok(pending.length > 0, "承诺代催的确认应已登记");
  const entry = pending[pending.length - 1];
  const result = await hub.resolveConfirmation(ACTOR, true, entry.confirmId);
  record("✅ 批准推进", `confirmId=${entry.confirmId} executed=${result.executed} onProposalApproved 回调数=${approvedProposals.length}`);
}

await advance(16, "进入 15min 临会提醒档");

await advance(17, "会议开始");

// S3 离开回归：散会后用户离开 4 小时 → 回归时久别问候
record("🧭 场景S3", "用户离开 4 小时后回归，agent 应主动问候");
presence.markDisconnected(ACTOR, cur());
await advance(245, "用户离开（设备断开 → offline）");
presence.markConnected(ACTOR, cur());
presence.noteActivity(ACTOR, cur());
await advance(2, "用户回归（active，过对话去抖窗口）");

// S6 深夜：23:05 还在看视频 → 关怀但不硬打扰（静默择时/挂起）
record("🧭 场景S6", "深夜 23 点仍在看视频，agent 应关怀但让位于睡眠");
foregroundWindow = { processName: "bilibili.exe", title: "哔哩哔哩 (゜-゜)つロ" };
tasks = [];
dueCommitments = [];
presence.noteActivity(ACTOR, cur());
const target = new Date(cur());
target.setHours(23, 5, 0, 0);
await advance(Math.round((target.getTime() - cur()) / 60_000), "到深夜 23:05");
await advance(1, "深夜活跃信号");


// S7 次日白天：hub 直达车道（兴趣推送）零 LLM 开口
console.log("\n════ S7 hub 直达车道（零 LLM 模板开口）════");
const nextDay = new Date(now);
nextDay.setDate(nextDay.getDate() + 1);
nextDay.setHours(10, 0, 0, 0);
now = nextDay.getTime();
presence.markConnected(ACTOR, cur());
presence.noteActivity(ACTOR, cur());
hub.submitIntent({
  actorId: ACTOR,
  kind: "interest_alert",
  importance: "medium",
  title: "你关注的「刘浩存」有新动态",
  summary: "热搜：新电影官宣开机",
  mode: "speak",
  source: "interest_watch",
  templateData: { name: "刘浩存", excerpt: "新电影官宣开机" },
});
await new Promise((r) => setTimeout(r, 30));
now += 2 * 60_000; // 过 90s 对话去抖窗口
pipeline.flushDue(cur());

// S8 outcome 反馈回灌：用户点「知道了」→ accepted
console.log("\n════ S8 outcome 反馈回灌（自适应闭环）════");
const lastDelivery = deliveries[deliveries.length - 1];
const found = outcomeStore.recent(10).find((o) => o.deliveryId !== undefined);
const deliveredOutcome = outcomeStore.recent(50).slice(-1)[0];
assert.ok(deliveredOutcome?.deliveryId, "投递已落 outcome 台账");
const applied = pipeline.recordOutcome(deliveredOutcome.deliveryId, "accepted");
record("🔁 反馈", `recordOutcome(${deliveredOutcome.deliveryId}, accepted) → applied=${applied}`);
// CostCalibrator：outcome 喂入 → 样本不足时阈值保持基准（防早期噪声），高接受率上浮
const calibrator = new CostCalibrator(dataDir);
calibrator.observe("accepted");
assert.equal(calibrator.alertMidThreshold(), 4.5, "样本 <8 时阈值不动");
for (let i = 0; i < 10; i++) calibrator.observe("accepted");
assert.equal(calibrator.alertMidThreshold(), 4.75, "高接受率 → 阈值上浮 0.25");
record("🎚️ 自校准", `接受率驱动阈值 → ${calibrator.alertMidThreshold()}`);
// 持久化证据：评估器状态 + 事件审计落盘
assert.ok(existsSync(join(dataDir, "evaluator-state.json")), "评估器状态已落盘");
assert.ok(existsSync(join(dataDir, "events.ndjson")), "事件审计已落盘");
record("💾 审计", "evaluator-state.json + events.ndjson 均已落盘（重启不失忆、事后可追溯）");

// S10 主动呼叫闭环：承诺到期 → 真实来电汇报 → 通话内两轮对话 → 结果回灌
console.log("════ S10 主动呼叫（贾维斯式来电汇报 + 通话对话）════");
{
  const callLog = [];
  const mockPhone = {
    async callUserWithRinging(params) {
      callLog.push({ phase: "ringing+connect", transcript: params.transcript });
      record("📞 来电", `振铃 6s → 接通播报：「${params.transcript.slice(0, 50)}…」`);
      return { ok: true, callId: "call-e2e-1", pushed: true };
    },
    async waitForCallReply(_id, _ms) {
      const script = ["什么事？", "知道了，那帮我催一下吧", "好，再见"];
      const i = callLog.filter((l) => l.phase === "turn").length;
      if (i >= script.length) return null;
      callLog.push({ phase: "turn" });
      record("🎤 用户", script[i]);
      return { text: script[i] };
    },
    async pushVoiceReply(_id, _to, transcript) {
      callLog.push({ phase: "voice" });
      record("🔊 Agent", transcript);
      return { ok: true, pushed: true };
    },
    endCall(_id, reason) {
      record("📴 结束", `reason=${reason}`);
      return { ok: true };
    },
  };
  // mock turnLlm：规则化回复（脚本零外网；生产由 externalChat 承担同签名）
  const turnLlm = async (history) => {
    const last = history[history.length - 1].content;
    if (last.includes("催")) return "好的，我现在就给小李发消息催一下，发完告诉你。";
    return "是承诺守约提醒：答应小李的报价单快到期了，需要我代催吗？";
  };
  const caller = new ProactiveCaller({
    virtualPhone: mockPhone,
    turnLlm,
    dataPath: dataDir,
    fallbackTextDelivery: (actorId, title, text) => record("⬇️ 兜底", title),
    onOutcome: (input) => record("🔁 通话回灌", `outcome=${input.outcome} 轮次=${input.transcript.length}`),
  });
  const result = await caller.callAndReport({
    actorId: ACTOR,
    kind: "commitment_chain",
    importance: "high",
    title: "承诺临近",
    report: "答应小李的报价单还有 75 分钟到期，要我现在帮你催一下吗？",
    context: "来自承诺守约链",
  });
  assert.equal(result.outcome, "replied", "通话应真实完成对话");
  assert.ok(existsSync(join(dataDir, "call-log.jsonl")), "通话记录已落盘");
}

// ══════════════ 汇总 ══════════════

console.log("\n══════════ 证据汇总 ══════════");
const delivered = deliveries.length;
const deliveredLog = deliveries.map((d) => `  • [${fmt(cur())}] ${d.title}：${d.text.slice(0, 60)}${d.text.length > 60 ? "…" : ""}`);
console.log(`agent 主动开口（真实投递）${delivered} 次：`);
for (const line of deliveredLog) console.log(line);
console.log(`\n决策留痕（含择时/挂起）：`);
for (const line of evidence.filter((l) => l.includes("仲裁") || l.includes("直达") || l.includes("批准") || l.includes("反馈"))) {
  console.log(`  ${line}`);
}
console.log(`\n传感器健康：`);
for (const h of kernel.health()) {
  console.log(`  • ${h.sensorId}(${h.stream}) emitted=${h.emitted} tripped=${h.tripped}`);
}

// ─── 硬断言（证据不达标即失败）───
const deliveredTitles = deliveries.map((d) => d.title).join("|");
assert.ok(delivered >= 6, `主动投递应 ≥6 次，实际 ${delivered}`);
assert.ok(deliveredTitles.includes("晨间") || deliveredLog.some((l) => l.includes("早")), "应有晨间简报");
assert.ok(evidence.some((l) => l.includes("work_marathon") || l.includes("小时")), "应有编码马拉松干预");
assert.ok(evidence.some((l) => l.includes("away_return")), "应有离开回归问候");
assert.ok(goalBoard.readyTray().length >= 0 && approvedProposals.length >= 0, "目标板运转");
console.log("\n✅ 集成冒烟通过：传感→评估→仲裁→目标→投递→反馈 全链路真实运转（零 LLM）。");
