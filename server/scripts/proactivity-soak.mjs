// 主动性模块 · 虚拟环境一周 soak 测试床。
//
// 目的：用虚拟时钟把"真实运行 7 天"压缩到秒级，让**真实组件**（传感内核 → 评估器链
// → 仲裁器 → 管道 → 投递 → 反馈回灌 → 自校准）在拟真作息下连续运转，用数据回答：
//   - 挂起/择时(deferred)是否健康流转，还是有热循环/永久滞留？
//   - 该发的(must 场景)是否必达？不该发的(深夜/连发/重复问候)是否被拦住？
//   - 挂起等 pause 的事件是否真能在用户"停下来"时放行（而不是全部过期作废）？
//   - 频控预算 / LLM 评估熔断 / 去重是否守住？
//
// 拟真建模说明（诚实边界）：
//   - 桌面客户端在真实运行中会周期性向服务端同步（desktop bridge sync），
//     本测试床把它建模为"用户在电脑前时每分钟刷新 presence 活跃"——与真实客户端行为一致；
//     （注意：当前 bootstrap 并未把该同步接到 proactivity presence，这是一处已识别的接线缺口，
//      见最终报告； soak 建模的是"客户端行为正确"时系统应有的表现。）
//   - LLM 通用路径用规则化 mock（验证管线与护栏，不评价模型智能）。
//   - 通话链路按用户决策冻结（后续接外部服务），本测试床不驱动。
//
// 运行：node --import tsx scripts/proactivity-soak.mjs
// 退出码 0=全部验收通过；1=有验收不达标（清单见输出）。

// ══════════════ 0. 虚拟时钟垫片（必须在任何模块 import 之前） ══════════════
const DAY_MS = 24 * 3600_000;
const DAYS = Number(process.env.SOAK_DAYS ?? 7);
// 起始时刻：某个周一 00:00（本地时区），周几确定
const BASE = (() => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  while (d.getDay() !== 1) d.setDate(d.getDate() - 1);
  return d.getTime();
})();
const virtual = { now: BASE };
const RealDate = Date;

class VirtualDate extends RealDate {
  constructor(...args) {
    if (args.length === 0) super(virtual.now);
    else super(...args);
  }
  static now() {
    return virtual.now;
  }
}
globalThis.Date = VirtualDate;

// setTimeout/setInterval 虚拟化：注册进虚拟定时器队列，主循环按虚拟时刻触发
const vTimers = new Map();
let vTimerSeq = 0;
globalThis.setTimeout = (fn, ms, ...rest) => {
  const id = ++vTimerSeq;
  vTimers.set(id, { id, fireAt: virtual.now + Math.max(0, Number(ms) || 0), fn, args: rest });
  return { id, unref() {}, ref() {} };
};
globalThis.clearTimeout = (handle) => {
  const id = typeof handle === "object" && handle !== null ? handle.id : handle;
  vTimers.delete(id);
};
globalThis.setInterval = globalThis.setTimeout;
globalThis.clearInterval = globalThis.clearTimeout;

process.env.PROACTIVE_CALL_ENABLED = "0"; // 通话链路冻结（用户决策：后续接外部服务）

// ══════════════ 1. 组件导入（真实实现） ══════════════
const { mkdtempSync, writeFileSync } = await import("node:fs");
const { tmpdir } = await import("node:os");
const { join } = await import("node:path");

const { SensorKernel, registerFeeder } = await import("../src/proactivity/sensors/kernel.js");
const { ScreenSensor } = await import("../src/proactivity/sensors/screen-sensor.js");
const { ScheduleSensor } = await import("../src/proactivity/sensors/schedule-sensor.js");
const { EvaluatorChain } = await import("../src/proactivity/evaluators/evaluator-chain.js");
const { buildBuiltinEvaluators } = await import("../src/proactivity/evaluators/builtin-evaluators.js");
const { ArbiterV2 } = await import("../src/proactivity/arbiter-v2.js");
const { GoalBoard } = await import("../src/proactivity/goal-board.js");
const { ProactivePipeline } = await import("../src/proactivity/proactive-pipeline.js");
const { ProactiveDeliveryService } = await import("../src/proactivity/delivery-service.js");
const { OutcomeStore } = await import("../src/proactivity/outcome-store.js");
const { PendingConfirmationStore } = await import("../src/proactivity/pending-confirmation-store.js");
const { PresenceService } = await import("../src/proactivity/presence-service.js");
const { FrequencyGovernor } = await import("../src/proactivity/frequency-governor.js");
const { ProactivityHub } = await import("../src/proactivity/proactivity-hub.js");
const { CostCalibrator } = await import("../src/proactivity/cost-calibrator.js");
const { ProposalStore } = await import("../src/proactivity/proposal-store.js");
const { renderProactiveText } = await import("../src/proactivity/voice-templates.js");

const ACTOR = "soak-user";
const dataDir = mkdtempSync(join(tmpdir(), "proactivity-soak-"));
const fmt = (t) => {
  const d = new RealDate(t);
  const days = ["日", "一", "二", "三", "四", "五", "六"][d.getDay()];
  return `周${days} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};
const hhmm = (t) => {
  const d = new RealDate(t);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

// ══════════════ 2. 全事件记账（钩在真实组件接缝上） ══════════════
const log = {
  decisions: [], // 每一次仲裁（含 flushDue 重仲裁——热循环检测数据源）
  deliveries: [], // 每一次真实投递
  governorBlocks: [], // 频控拦截
  admits: [], // ArbiterV2 裁决（打断成本）
  events: [], // 评估器产出的全部事件（admit 前真相源）
  llmEvals: [], // 每次通用路径 LLM 评估
  outcomes: 0, // 用户反馈回灌条数
};

const origLogDecision = ProposalStore.prototype.logDecision;
ProposalStore.prototype.logDecision = function (d) {
  log.decisions.push({
    at: virtual.now,
    proposalId: d.proposal?.proposalId,
    dedupKey: d.proposal?.dedupKey,
    kind: d.proposal?.kind,
    tier: d.proposal?.tier,
    importance: d.proposal?.importance,
    verdict: d.verdict,
    reasons: d.reasonChain?.join(";") ?? "",
  });
  return origLogDecision.call(this, d);
};
const origDeliver = ProactiveDeliveryService.prototype.deliver;
ProactiveDeliveryService.prototype.deliver = function (p, text, title) {
  const r = origDeliver.call(this, p, text, title);
  if (r.ok) log.deliveries.push({ at: virtual.now, kind: p.kind, tier: p.tier, importance: p.importance, title, text, dedupKey: p.dedupKey, presence: presence.getPresence(p.actorId, virtual.now) });
  return r;
};
const origGovernorCanTrigger = FrequencyGovernor.prototype.canTrigger;
FrequencyGovernor.prototype.canTrigger = function (actorId, kind, importance, now, opts) {
  const v = origGovernorCanTrigger.call(this, actorId, kind, importance, now, opts);
  if (!v.allowed) log.governorBlocks.push({ at: virtual.now, kind, reason: v.reason });
  return v;
};
const origAdmit = ArbiterV2.prototype.admit;
ArbiterV2.prototype.admit = function (input) {
  const d = origAdmit.call(this, input);
  log.admits.push({ at: virtual.now, urgency: input.urgency, tier: input.tier ?? "social", label: String(input.label).slice(0, 36), action: d.action, cost: d.cost, reason: d.reason });
  return d;
};

// ══════════════ 3. 组件装配（镜像 bootstrap 接线） ══════════════
const presence = new PresenceService();
presence.markConnected(ACTOR, virtual.now);

const sim = {
  connected: true,
  window: { processName: "explorer.exe", title: "桌面" }, // null = 离开电脑
  tasks: [],
  commitments: [],
  weather: null,
  receptivity: 0.7,
  acceptRate: 0.6,
  lastConvAt: null,
  toolCalls: [],
};

const screenSensor = new ScreenSensor({
  visualPort: { window: async () => ({ ok: true, windows: sim.window ? [{ ...sim.window, foreground: true }] : [] }) },
  nowFn: () => virtual.now,
});
const scheduleSensor = new ScheduleSensor({ listTasks: () => sim.tasks, nowFn: () => virtual.now });

const kernel = new SensorKernel({ dataPath: dataDir, disablePersist: true, nowFn: () => virtual.now });
kernel.register(screenSensor);
kernel.register(scheduleSensor);
let lastPresenceState = "";
kernel.register({
  id: "presence_tracker",
  stream: "presence",
  pollIntervalMs: 60_000,
  collect: () => {
    const state = presence.getPresence(ACTOR, virtual.now);
    if (state === lastPresenceState) return [];
    lastPresenceState = state;
    return [{
      stream: "presence", at: virtual.now,
      fingerprint: `presence:${state}:${Math.floor(virtual.now / 60_000)}`, salience: "low",
      payload: { state },
    }];
  },
});
const emitMessage = (sender, offsetMs = 0) => {
  messageFeeder({
    stream: "message", at: virtual.now + offsetMs,
    fingerprint: `msg:${sender}:${virtual.now + offsetMs}:${Math.random().toString(36).slice(2, 6)}`,
    salience: "low", payload: { sender, text: "麻烦看下之前的方案" },
  });
};
const messageFeeder = registerFeeder(kernel, "message_feeder", "message");
const goalFeeder = registerFeeder(kernel, "goal_board", "goal");

const evaluatorChain = new EvaluatorChain({
  defaultActorId: () => ACTOR,
  flushIntervalMs: 60_000,
  nowFn: () => virtual.now,
  dataPath: dataDir,
  services: {},
});
const builtinServices = {
  listTodayTasks: () => sim.tasks.filter((t) => t.runAt > virtual.now && t.runAt <= virtual.now + DAY_MS).map((t) => ({ title: t.title, runAt: t.runAt })),
  commitmentsDue: (withinMs) => sim.commitments.filter((c) => c.dueAt <= virtual.now + withinMs),
  weatherLine: () => sim.weather,
  readyGoals: () => goalBoard.readyTray().map((g) => ({ title: g.title, body: String(g.payload?.body ?? "") })),
  interestLines: () => [],
};
for (const ev of buildBuiltinEvaluators(builtinServices)) evaluatorChain.register(ev);
kernel.onSignal((s) => evaluatorChain.handleSignal(s));

const governor = new FrequencyGovernor({ ignoreEnv: true, nowFn: () => new RealDate(virtual.now) });
const deliveriesLedger = [];
const deliveryService = new ProactiveDeliveryService({
  trySend: () => sim.connected, // 设备在线才送得到；离线 = 竞态失败走挂起重试
  ledger: { record: () => {} },
});
const outcomeStore = new OutcomeStore(join(dataDir, "outcomes.json"));
const confirmations = new PendingConfirmationStore(join(dataDir, "confirmations.json"), () => virtual.now);
const calibrator = new CostCalibrator(dataDir);
const pipeline = new ProactivePipeline({
  dataPath: dataDir,
  nowFn: () => virtual.now,
  governor,
  suppression: { isSuppressed: () => ({ suppressed: false, reason: "" }) },
  presence,
  lastConversationAt: () => sim.lastConvAt, // 对话驱动判定（镜像 bootstrap 修复后的接线）
  delivery: deliveryService,
  outcomes: outcomeStore,
  confirmations,
  flushIntervalMs: DAY_MS,
});
const goalBoard = new GoalBoard({
  dataPath: dataDir,
  nowFn: () => virtual.now,
  emitGoal: (goal) => {
    if (goal.status !== "ready") return;
    goalFeeder({
      at: virtual.now,
      fingerprint: `goal:${goal.goalId}:${goal.status}`, salience: "medium",
      payload: { goalId: goal.goalId, title: goal.title, body: String(goal.payload?.body ?? "") },
    });
  },
  recallMemory: () => ["上周和小王对过 Q3 需求范围"],
});

const arbiter = new ArbiterV2({
  presence,
  lastConversationAt: () => sim.lastConvAt,
  screenFocus: () => screenSensor.latest(),
  nextEventMin: () => scheduleSensor.latest()?.min ?? null,
  receptivity: () => sim.receptivity,
  primaryActorId: () => ACTOR,
  nowFn: () => virtual.now,
  alertMidThreshold: () => calibrator.alertMidThreshold(),
});

evaluatorChain.onEvent((event) => {
  log.events.push({ at: virtual.now, kind: event.kind, urgency: event.urgency, tier: event.tier, title: event.title.slice(0, 30), dedupKey: event.dedupKey });
  // 社交开口类（away_return）→ 统一主动出口（同 bootstrap 2026-10-26 分流）：
  // 映射规则只管「何时触发」，话术由 BrainCenter 决策 + agent 主动做事 + 通用话术
  // 生成（ProactiveOutreachExecutor）。soak 无 BrainCenter/LLM → 模拟统一出口的
  // 通用兜底直投（buildFallbackMessage 语义），投递经 deliver 记录器照常记账。
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
        createdAt: virtual.now,
        source: `evaluator:${event.kind}`,
      },
      `有个小情况：${event.title}。`,
      event.title,
    );
    return;
  }
  arbiter.admit({
    actorId: event.actorId,
    urgency: event.urgency,
    tier: event.tier,
    label: event.title,
    deliver: () => {
      pipeline.submitProposal({
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
        createdAt: virtual.now,
        source: `evaluator:${event.kind}`,
        ...(event.expiresAt !== undefined ? { expiresAt: event.expiresAt } : {}),
        ...(event.confirmLabel
          ? {
              confirmAction: { label: event.confirmLabel },
              utility: {
                risk: { reversible: false, financialImpact: "none", dataSensitivity: "none", thirdPartyImpact: true },
                authorization: "implicit",
                value: { expectedValue: 0.7, interruptionCost: 0.3 },
              },
            }
          : {}),
      });
    },
  });
});

// LLM 通用路径 mock：规则化拟真（绝大多数 none；疲惫/明确托付才开口）
const mockLlm = async (prompt) => {
  log.llmEvals.push(virtual.now);
  // act 执行循环 prompt：搜索→取结果播放→确认完成
  if (prompt.includes("执行模式（act 循环）")) {
    if (prompt.includes('"ok":false')) {
      // 换路：原查询失败，换一个可行的搜索词重试
      return JSON.stringify({ action: "continue", tool: "media.search", args: { query: "轻音乐" } });
    }
    if (!prompt.includes("media.search")) {
      return JSON.stringify({ action: "continue", tool: "media.search", args: { query: "周杰伦 晴天" } });
    }
    if (!prompt.includes("media.play")) {
      const trackId = prompt.match(/"id":"([^"]+)"/)?.[1] ?? "t-99";
      return JSON.stringify({ action: "continue", tool: "media.play", args: { trackId, trackName: "晴天" } });
    }
    return JSON.stringify({ action: "done", messageHint: "已经在放《晴天》了。" });
  }
  const windowPart = prompt.split("本次新观察（决策依据）：")[1]?.split("可用工具")[0] ?? "";
  if (/累|疼|难受|撑不住|烦/.test(windowPart)) {
    return JSON.stringify({ mode: "speak", kind: "care", importance: "medium", rationale: "用户表达了疲惫，值得关心一句", messageHint: "听到你这么说我也不踏实。今晚别硬撑了。" });
  }
  if (/帮我盯着|记得提醒我|别忘了/.test(windowPart)) {
    return JSON.stringify({ mode: "speak", kind: "followup", importance: "medium", rationale: "用户有明确托付", messageHint: "记下了，到点我提你。" });
  }
  if (/找出来放|放一下|来一首/.test(windowPart)) {
    const q = /不存在/.test(windowPart) ? "不存在的歌" : "周杰伦 晴天";
    return JSON.stringify({ mode: "act", kind: "media_play", importance: "medium", rationale: "用户想听歌，直接办好", messageHint: "", actions: [{ tool: "media.search", args: { query: q } }] });
  }
  return JSON.stringify({ mode: "none", kind: "none", importance: "low", rationale: "无事值得打扰" });
};

let approvedProposals = 0;
let llmSpeakSignals = 0;
let hubSeq = 0;
const hub = new ProactivityHub({
  executeTool: async (tool, args) => {
    sim.toolCalls.push(tool);
    if (tool === "media.search") {
      if (String(args?.query ?? "").includes("不存在")) {
        return { ok: false, result: { error: "曲库中未找到该曲目" } };
      }
      return { ok: true, result: { tracks: [{ id: "t-99", name: "晴天", artist: "周杰伦" }] } };
    }
    return { ok: true, result: {} };
  },
  // LLM speak 决策的生产路径：LifeSignal → ProactionCortex（LLM 话术）→ 投递。
  // soak 用模板正文模拟话术结果，走同一套 仲裁→管道 闭环：
  //   tier=must 是语义模拟——配额已在 routeDecision 预留，管道不再复查频控；
  //   仲裁按 social 尊重成本择时（对话中挂起，等停顿再开口）
  publishSignal: (signal) => {
    llmSpeakSignals += 1;
    const proposal = {
      proposalId: `sig_${virtual.now.toString(36)}_${hubSeq++}`,
      actorId: signal.actorId,
      kind: signal.kind,
      tier: "must",
      importance: signal.importance,
      dedupKey: `sig:${signal.kind}:${String(signal.summary).slice(0, 40)}`,
      title: signal.title,
      summary: signal.summary,
      directText: renderProactiveText(signal.kind, { title: signal.title, summary: signal.summary }),
      evidence: [`source=${signal.source}`, "hub-llm-speak"],
      createdAt: virtual.now,
      source: `hub:${signal.source}`,
    };
    const urgency = signal.importance === "high" || signal.importance === "critical" ? "alert" : "normal";
    arbiter.admit({
      actorId: signal.actorId,
      urgency,
      tier: "social",
      label: signal.title,
      deliver: () => {
        pipeline.submitProposal(proposal);
      },
    });
  },
  frequencyGovernor: governor,
  pendingConfirmations: confirmations,
  getLastInteractionAt: () => sim.lastConvAt,
  onUserActivity: () => presence.noteActivity(ACTOR, virtual.now), // 镜像 bootstrap：对话/显式活跃刷新 presence
  llmComplete: mockLlm,
  getScheduleSnapshot: () => (sim.tasks.length ? sim.tasks.map((t) => `${hhmm(t.runAt)} ${t.title}`).join("；") : null),
});
hub.setPipelineConfirmationResolver((entry, approved) => {
  if (!approved) return { executed: false };
  pipeline.resolveProposalConfirmation(entry, true);
  approvedProposals += 1;
  return { executed: true };
});
hub.setDirectLane((p) => {
  const urgency = p.importance === "high" || p.importance === "critical" ? "alert" : "normal";
  arbiter.admit({
    actorId: p.actorId,
    urgency,
    tier: p.tier,
    label: p.title,
    deliver: () => {
      pipeline.submitProposal(p);
      hub.noteInitiative(p.actorId, p.kind, p.title);
    },
  });
});

// 用户反馈模拟：投递后 2min 回传 outcome（must 全收；社交按接受率）→ 回灌校准器
let rngState = 42;
const rng = () => {
  rngState = (rngState * 1664525 + 1013904223) >>> 0;
  return rngState / 0xffffffff;
};
const origLedgerPush = deliveriesLedger.push.bind(deliveriesLedger);
deliveriesLedger.push = (payload) => {
  origLedgerPush(payload);
  const isMust = /meeting|commitment|schedule|weather/.test(String(payload.kind));
  const accepted = isMust ? true : rng() < sim.acceptRate;
  setTimeout(() => {
    pipeline.recordOutcome(payload.deliveryId, accepted ? "accepted" : "ignored");
    calibrator.observe(accepted ? "accepted" : "ignored");
    log.outcomes += 1;
  }, 2 * 60_000);
  return deliveriesLedger.length;
};

// ══════════════ 4. 七天拟真作息脚本 ══════════════
const at = (day, h, m) => BASE + day * DAY_MS + h * 3600_000 + m * 60_000;

const connect = (day, h, m) => ({ t: at(day, h, m), fn: () => { if (!sim.connected) { sim.connected = true; presence.markConnected(ACTOR, virtual.now); } } });
const disconnect = (day, h, m) => ({ t: at(day, h, m), fn: () => { if (sim.connected) { sim.connected = false; presence.markDisconnected(ACTOR); sim.window = null; } } });
const setWindow = (day, h, m, processName, title = "") => ({ t: at(day, h, m), fn: () => { sim.window = processName ? { processName, title } : null; } });
const activity = (day, h, m) => ({ t: at(day, h, m), fn: () => presence.noteActivity(ACTOR, virtual.now) });
const conv = (day, h, m, text) => ({
  t: at(day, h, m),
  fn: () => {
    sim.lastConvAt = virtual.now;
    presence.noteActivity(ACTOR, virtual.now);
    hub.observeConversationTurn(ACTOR, text);
  },
});
const registerMeeting = (day, h, m, title) => ({ t: at(day, 0, 1), fn: () => sim.tasks.push({ title, runAt: at(day, h, m), status: "scheduled" }) });
const registerCommitment = (day, h, m, id, title) => ({ t: at(day, 0, 2), fn: () => sim.commitments.push({ id, title, dueAt: at(day, h, m) }) });
const inboundMsgs = (day, h, m, senders) => ({
  t: at(day, h, m),
  fn: () => senders.forEach((s, i) => emitMessage(s, i * 10_000)), // 20 秒内连到 3 条
});
const approveConfirm = (day, h, m) => ({ t: at(day, h, m), fn: () => hub.resolveConfirmation(ACTOR, true) });

/** 工作日白班模板 */
function workday(day, { meetingAt, meetingTitle, commitment: cmt, msgs, eveningConv, eveningWindow = ["cloudmusic.exe", "网易云音乐"] }) {
  const ev = [
    connect(day, 7, 40),
    setWindow(day, 7, 41, "msedge.exe", "新闻 - Microsoft Edge"),
    setWindow(day, 9, 0, "Code.exe", "main.ts - Visual Studio Code"),
    registerMeeting(day, meetingAt[0], meetingAt[1], meetingTitle),
    setWindow(day, meetingAt[0], meetingAt[1] - 20, "zoom.exe", "Zoom 会议"),
    conv(day, meetingAt[0], meetingAt[1] - 25, "马上来开会"),
    setWindow(day, meetingAt[0], meetingAt[1] + 30, "Code.exe", "main.ts - Visual Studio Code"),
    setWindow(day, 12, 5, null),
    setWindow(day, 13, 0, "Code.exe", "main.ts - Visual Studio Code"),
    conv(day, 13, 5, "继续改 bug"),
    ...(msgs ? [inboundMsgs(day, 16, 0, msgs)] : []),
    setWindow(day, 18, 30, null),
    disconnect(day, 18, 35),
    connect(day, 19, 30),
    setWindow(day, 19, 31, eveningWindow[0], eveningWindow[1]),
    conv(day, 19, 35, eveningConv ?? "嗯嗯"),
    setWindow(day, 22, 0, "explorer.exe", "桌面"),
    disconnect(day, 23, 59),
  ];
  if (cmt) ev.push(registerCommitment(day, cmt.due[0], cmt.due[1], cmt.id, cmt.title));
  return ev;
}

const dayScripts = [];
// Day0 周一：标准工作日——晨报/马拉松(9:00 起连续编码)/14:00 会/15:00 承诺(13:00 提醒→13:05 批准)/16:00 消息爆发/晚间疲惫关怀
dayScripts.push(workday(0, {
  meetingAt: [14, 0], meetingTitle: "项目周会（和小王）",
  commitment: { id: "c1", title: "给小李发报价单", due: [15, 0] },
  msgs: ["王经理", "产品小张", "王经理"],
  eveningConv: "今天改了一天bug,真的好累啊",
}));
// Day0 追加：凌晨设备离线（夜里合盖，否则晨间简报会在 07:01 误触发）
dayScripts[0].unshift(disconnect(0, 0, 30));
// Day0 追加：承诺批准（提醒 13:00 送达 → 13:05 批准，TTL 10min 内）
dayScripts[0].push(approveConfirm(0, 13, 5));
// Day1 周二：静默编码日 + 白天真实外出 4.5h（13:05 离开 → 17:30 回归 → away_return 应触发）+ 16:00 兴趣推送（离线中挂起）
dayScripts.push([
  connect(1, 8, 50), activity(1, 8, 50),
  setWindow(1, 9, 0, "Code.exe", "refactor.ts - Visual Studio Code"),
  setWindow(1, 11, 0, "msedge.exe", "文档 - Microsoft Edge"),
  setWindow(1, 13, 0, "Code.exe", "refactor.ts - Visual Studio Code"),
  disconnect(1, 13, 5), setWindow(1, 13, 5, null),
  connect(1, 17, 30), activity(1, 17, 30), setWindow(1, 17, 31, "Code.exe", "refactor.ts - Visual Studio Code"),
  { t: at(1, 16, 0), fn: () => hub.onInterestAlert(ACTOR, "刘浩存", { platform: "微博热搜", title: "新电影官宣开机", hot: 3, url: "" }) }, // 离线中注入
  conv(1, 18, 5, "在吗?帮我看看那个热搜"),
  setWindow(1, 19, 0, "explorer.exe", "桌面"),
  disconnect(1, 23, 59),
]);
// Day2 周三：早间天气预警 + 午后托付（LLM followup 路径）+ 23:35 深夜视频（sleep_boundary）
dayScripts.push([
  connect(2, 7, 50), activity(2, 7, 50), setWindow(2, 7, 51, "msedge.exe", "新闻 - Microsoft Edge"),
  { t: at(2, 8, 0), fn: () => hub.submitIntent({ actorId: ACTOR, kind: "weather_alert", importance: "high", title: "今天有暴雨", summary: "小雨转暴雨，出门带伞", mode: "speak", source: "weather", templateData: { weather: "小雨转暴雨" } }) },
  setWindow(2, 9, 0, "Code.exe", "server.ts - Visual Studio Code"),
  setWindow(2, 12, 10, null), setWindow(2, 13, 10, "Code.exe", "server.ts - Visual Studio Code"),
  conv(2, 13, 15, "下午帮我盯着小李那个交付,别忘了"),
  setWindow(2, 18, 0, "msedge.exe", "资讯 - Microsoft Edge"), activity(2, 18, 0),
  conv(2, 18, 5, "帮我把周杰伦的晴天找出来放一下"),
  setWindow(2, 23, 35, "bilibili.exe", "哔哩哔哩"), activity(2, 23, 35),
]);
// 跨零点事件在 day3 脚本创建后统一登记（见下方 dayScripts[3] 注册处）
// Day3 周四：15:00 评审会 + 17:00 兴趣推送 → 17:30 离线 → 20:00 回归（离线挂起重连必达）+ 16:00 任务完成恭喜
dayScripts.push(workday(3, {
  meetingAt: [15, 0], meetingTitle: "季度评审会",
  eveningConv: "回来了",
}));
// 跨零点事件属于 day3（主循环按天扫描脚本数组，必须登记在 day3 名下）
dayScripts[3].unshift(setWindow(3, 0, 0, "explorer.exe", "桌面"));
dayScripts[3].unshift(disconnect(3, 0, 35));
dayScripts[3].push(
  { t: at(3, 16, 0), fn: () => hub.onAgentTaskCompleted(ACTOR, "季度数据报表生成") },
  { t: at(3, 18, 20), fn: () => hub.submitIntent({ actorId: ACTOR, kind: "interest_alert", importance: "medium", title: "你关注的「新专辑」有新动态", summary: "热搜：新专辑发布", mode: "speak", source: "interest_watch", templateData: { name: "新专辑", excerpt: "新专辑发布" } }) },
);
// Day4 周五：白班收尾；18:00 起真实离开（周末模式）
dayScripts.push(workday(4, { meetingAt: [10, 30], meetingTitle: "周例会", eveningConv: "帮我把那首不存在的歌找出来放一下" }));
// Day5 周六：睡到 9:30 回归（跨夜离开）→ 懒散一天
dayScripts.push([
  connect(5, 9, 30), setWindow(5, 9, 31, "msedge.exe", "新闻 - Microsoft Edge"), activity(5, 9, 31),
  conv(5, 9, 40, "周末好"),
  setWindow(5, 14, 0, "bilibili.exe", "哔哩哔哩"),
  setWindow(5, 18, 0, "explorer.exe", "桌面"),
  disconnect(5, 23, 59),
]);
// Day6 周日：晚起 + 晚间连续对话五连（验证对话去抖重置不连发）
dayScripts.push([
  connect(6, 10, 30), setWindow(6, 10, 31, "cloudmusic.exe", "网易云音乐"), activity(6, 10, 31),
  setWindow(6, 15, 0, "steam.exe", "Steam"),
  conv(6, 20, 0, "这个游戏真好玩"),
  conv(6, 20, 1, "这关卡设计绝了"),
  conv(6, 20, 2, "帮我记一下,明天下午三点有个线上局"),
  conv(6, 20, 3, "先这样,我去打了"),
  conv(6, 20, 4, "噢对了周末过得不错"),
  setWindow(6, 22, 0, "explorer.exe", "桌面"),
  disconnect(6, 23, 59),
]);

// ══════════════ 5. 主循环（1 虚拟分钟步进 × 7 天） ══════════════
async function flushVirtualTimers() {
  for (let guard = 0; guard < 500; guard++) {
    const due = [...vTimers.values()].filter((t) => t.fireAt <= virtual.now).sort((a, b) => a.fireAt - b.fireAt);
    if (due.length === 0) return;
    for (const t of due) {
      vTimers.delete(t.id);
      try {
        await t.fn(...t.args);
      } catch (err) {
        console.log(`[soak] timer 执行失败（忽略）: ${err}`);
      }
    }
  }
}

const totalSteps = DAYS * 1440;
let hubTickCursor = virtual.now;
for (let step = 0; step < totalSteps; step++) {
  virtual.now += 60_000;
  const day = Math.floor((virtual.now - BASE) / DAY_MS);
  // 上一步末注册的虚拟定时器先落地（消息到达/反馈回传/对话去抖）——
  // 必须在传感器与评估器 flush 之前，否则信号时间戳会被 flush 水位跳过
  await flushVirtualTimers();
  // 当日事件
  for (const ev of dayScripts[day] ?? []) {
    if (ev.t === virtual.now) await ev.fn();
  }
  // 桌面同步建模：在电脑前（有前台窗口且在线）时每分钟刷新 presence 活跃（镜像 desktop bridge sync）
  if (sim.connected && sim.window) presence.noteActivity(ACTOR, virtual.now);
  // 传感器轮询 → 信号
  await kernel.pollOnce();
  // 会前准备（镜像 bootstrap 60s 定时：25-40min 窗口）
  const next = scheduleSensor.latest();
  if (next && next.min >= 25 && next.min <= 40) {
    goalBoard.maybeStartMeetingPrep(ACTOR, { title: next.title, runAtMin: next.min });
  }
  await evaluatorChain.flush();
  arbiter.forceTick();
  pipeline.flushDue(virtual.now);
  // 本步内注册的 0 延迟定时器（setImmediate 语义的脚本动作）
  await flushVirtualTimers();
  // hub 周期 tick（镜像 PROACTIVITY_TICK_MS=30min）
  if (virtual.now - hubTickCursor >= 30 * 60_000) {
    hubTickCursor = virtual.now;
    await hub.onTick(ACTOR, new RealDate(virtual.now));
    await flushVirtualTimers();
  }
  await new Promise((r) => setImmediate(r));
}
await flushVirtualTimers();
pipeline.flushDue(virtual.now);

// ══════════════ 6. 统计与验收 ══════════════
const byHour = (t) => new RealDate(t).getHours();
const isQuiet = (t) => {
  const h = byHour(t);
  return h >= 23 || h < 7;
};

// 6.1 热循环：同一提案被重复裁决次数
const decideCount = new Map();
for (const d of log.decisions) decideCount.set(d.dedupKey, (decideCount.get(d.dedupKey) ?? 0) + 1);
const hotLoops = [...decideCount.entries()].filter(([, n]) => n > 50).sort((a, b) => b[1] - a[1]);

// 6.2 verdict 分布 & deferred 原因分布
const verdictDist = {};
const deferReasonDist = {};
for (const d of log.decisions) {
  verdictDist[d.verdict] = (verdictDist[d.verdict] ?? 0) + 1;
  if (d.verdict === "deferred") {
    const r = d.reasons.split(";").find((x) => /quiet_hours|offline|in_conversation/.test(x)) ?? d.reasons;
    deferReasonDist[r] = (deferReasonDist[r] ?? 0) + 1;
  }
}

// 6.3 打扰指标
const sortedDeliveries = [...log.deliveries].sort((a, b) => a.at - b.at);
let maxBurst = 0;
for (let i = 0; i < sortedDeliveries.length; i++) {
  let j = i;
  while (j < sortedDeliveries.length && sortedDeliveries[j].at - sortedDeliveries[i].at <= 30 * 60_000) j++;
  maxBurst = Math.max(maxBurst, j - i);
}
// 深夜零打扰：与系统规则同一口径——静默时段只有 critical 直达、high 一律择时；
// 低/中打扰档仅当用户当时活跃在设备前（深夜还醒着）才允许
const quietDeliveries = sortedDeliveries.filter((d) =>
  isQuiet(d.at) && !(d.importance === "low" || d.importance === "medium" ? d.presence === "active" : false));

// 6.4 每日投递数
const perDay = new Array(DAYS).fill(0);
for (const d of sortedDeliveries) perDay[Math.floor((d.at - BASE) / DAY_MS)]++;

// 6.5 去重体检
const dupDeliveries = [];
const seenDelivered = new Map();
for (const d of sortedDeliveries) {
  const prev = seenDelivered.get(d.dedupKey);
  if (prev !== undefined && d.at - prev <= 24 * 3600_000) dupDeliveries.push(d);
  seenDelivered.set(d.dedupKey, d.at);
}

// 6.6 挂起等 pause 的转化
const parkedLabels = new Map();
for (const a of log.admits) if (a.action === "wait_for_pause") parkedLabels.set(a.label, (parkedLabels.get(a.label) ?? 0) + 1);
let parkedDelivered = 0;
for (const label of parkedLabels.keys()) {
  if (sortedDeliveries.some((d) => (d.title ?? "").slice(0, 36) === label || (d.text ?? "").includes(label.slice(0, 18)))) parkedDelivered++;
}
const parkConversion = parkedLabels.size ? parkedDelivered / parkedLabels.size : 1;

// 6.7 场景召回
const dayDeliveries = (day) => sortedDeliveries.filter((d) => Math.floor((d.at - BASE) / DAY_MS) === day);
const expectations = [];
const expect = (name, ok, detail) => expectations.push({ name, ok, detail });

for (const day of [0, 1, 2, 3, 4]) {
  const ds = dayDeliveries(day).filter((d) => d.kind === "greeting" && byHour(d.at) >= 7 && byHour(d.at) < 10);
  expect(`E1 晨间简报恰1次 d${day}`, ds.length === 1, ds.length === 1 ? `${hhmm(ds[0].at)}` : `实际 ${ds.length} 次`);
}
const meetingBrief0 = dayDeliveries(0).filter((d) => d.kind === "schedule_upcoming" && (d.text + d.title).includes("项目周会"));
expect("E2a 周会临会提醒 d0（会前送达）", meetingBrief0.length >= 1 && meetingBrief0.every((d) => d.at < at(0, 14, 0)), meetingBrief0.map((d) => hhmm(d.at)).join(",") || "缺失");
const meetingBrief3 = dayDeliveries(3).filter((d) => d.kind === "schedule_upcoming" && (d.text + d.title).includes("季度评审"));
expect("E2b 评审临会提醒 d3（会前送达）", meetingBrief3.length >= 1 && meetingBrief3.every((d) => d.at < at(3, 15, 0)), meetingBrief3.map((d) => hhmm(d.at)).join(",") || "缺失");
const marathon = dayDeliveries(0).filter((d) => d.kind === "overwork_care");
expect("E3 编码马拉松干预 d0（恰1次）", marathon.length === 1, marathon.map((d) => `${hhmm(d.at)}`).join(";") || "未触发");
const confirmNudge = dayDeliveries(0).filter((d) => d.kind === "action.commitment.nudge");
expect("E4a 承诺代催提醒 d0", confirmNudge.length === 1, confirmNudge.map((d) => hhmm(d.at)).join(",") || "未触发");
expect("E4b 承诺批准落地", approvedProposals >= 1, `批准 ${approvedProposals} 条`);
const digestLeftover = sortedDeliveries.filter((d) => d.kind === "digest_beat" || /心跳回顾/.test(d.text ?? ""));
expect("E5 心跳回顾已退役（digest_beat 固定节拍不再产出）", digestLeftover.length === 0, digestLeftover.length ? `残留 ${digestLeftover.length} 条` : "已改 Muse 式 agent_pulse（LLM 评审，soak 不含）");
const trueAway = dayDeliveries(1).filter((d) => d.kind === "away_return");
expect("E6a 白天真实外出久别问候 d1 17:30 后", trueAway.length === 1 && trueAway[0].at >= at(1, 17, 30), trueAway.map((d) => `${hhmm(d.at)}`).join(",") || "未触发");
const sleepCare = sortedDeliveries.filter((d) => d.kind === "sleep_care" && d.at >= at(2, 23, 0) && d.at <= at(3, 1, 0));
expect("E7 深夜关怀当晚送达（勿拖到早晨）", sleepCare.length === 1, sleepCare.map((d) => `${hhmm(d.at)}`).join(",") || "未在当晚送达");
const weatherD2 = dayDeliveries(2).filter((d) => d.kind === "weather_alert");
expect("E9 天气预警 d2 上午必达", weatherD2.length === 1 && weatherD2[0].at < at(2, 12, 0), weatherD2.map((d) => hhmm(d.at)).join(",") || "未触发");
const burst0 = dayDeliveries(0).filter((d) => /新消息|看一眼/.test(d.text));
expect("E10 消息爆发提醒 d0 恰1次", burst0.length === 1, `实际 ${burst0.length} 次`);
const careD0 = dayDeliveries(0).filter((d) => d.kind === "care" || d.kind === "followup");
expect("E13 疲惫关怀 d0 当晚送达", careD0.length >= 1, careD0.map((d) => `${hhmm(d.at)}(${d.kind})`).join(",") || "LLM 路径未开口");
const celebrateD3 = dayDeliveries(3).filter((d) => d.kind === "task_celebration");
expect("E14 任务完成恭喜 d3 当日送达", celebrateD3.length === 1, celebrateD3.map((d) => hhmm(d.at)).join(",") || "未触发");
const interestD3 = dayDeliveries(3).filter((d) => d.kind === "interest_alert" && d.at >= at(3, 19, 30));
expect("E12 兴趣推送离线挂起→重连必达 d3 19:30 后", interestD3.length === 1, interestD3.map((d) => hhmm(d.at)).join(",") || "重连后未送达");
// 双问候守门：跨夜回归的早晨（d5 9:30 / d6 10:30）恰好一条问候
for (const [day, label] of [[5, "d5 周六晨"], [6, "d6 周日晨"]]) {
  const greets = dayDeliveries(day).filter((d) => d.kind === "greeting" || d.kind === "away_return");
  expect(`E6c 跨夜回归不双发问候 ${label}`, greets.length === 1, greets.map((d) => `${hhmm(d.at)}(${d.kind})`).join(",") || `实际 ${greets.length} 条`);
}
const playCalls = sim.toolCalls.filter((t) => t === "media.play").length;
expect("E16 act 执行循环 d2（搜→播→完成→轻提一句）", playCalls >= 1 && dayDeliveries(2).some((d) => d.text.includes("顺手办好了")), `media.play×${playCalls}`);
expect("E17 失败换路 d4（原查询失败→换词成功→照常交付）", dayDeliveries(4).some((d) => d.kind === "media_play" && d.text.includes("顺手办好了")), dayDeliveries(4).filter((d) => d.kind === "media_play").map((d) => d.text.slice(0, 30)).join("|") || "未达成");
// followup 托付（d2 13:15 "帮我盯着…别忘了" → LLM followup 或规则 followup 当日送达）
const followupD2 = dayDeliveries(2).filter((d) => d.kind === "followup");
expect("E15 用户托付跟进 d2 当日送达", followupD2.length >= 1, followupD2.map((d) => hhmm(d.at)).join(",") || "未触发");

// 6.8 架构健康门槛
const llmPerDay = new Map();
for (const t of log.llmEvals) {
  const k = Math.floor((t - BASE) / DAY_MS);
  llmPerDay.set(k, (llmPerDay.get(k) ?? 0) + 1);
}
const expiredMust = log.decisions.filter((d) => d.verdict === "expired" && d.tier === "must");
const gates = [];
const gate = (name, ok, detail) => gates.push({ name, ok, detail });
gate("G1 热循环（无提案被裁决>50次）", hotLoops.length === 0, hotLoops.length ? `top: ${hotLoops[0][0]}×${hotLoops[0][1]}` : "通过");
gate("G2 深夜零打扰（非high/critical）", quietDeliveries.length === 0, quietDeliveries.length ? quietDeliveries.map((d) => `${hhmm(d.at)} ${d.kind}`).join(" | ") : "通过");
gate("G3 30min 连发上限(≤4)", maxBurst <= 4, `峰值 ${maxBurst}`);
gate("G4 每日预算(≤12)", perDay.every((n) => n <= 12), perDay.map((n, i) => `d${i}:${n}`).join(" "));
gate("G5 24h 去重零违例", dupDeliveries.length === 0, dupDeliveries.length ? dupDeliveries[0].dedupKey : "通过");
gate("G6 挂起转化(≥50%)", parkConversion >= 0.5, `${Math.round(parkConversion * 100)}%（${parkedDelivered}/${parkedLabels.size}）`);
gate("G7 LLM 评估熔断(≤40/天)", [...llmPerDay.values()].every((n) => n <= 40), `总评估 ${log.llmEvals.length} 次/峰值 ${Math.max(0, ...llmPerDay.values())}/天`);
gate("G8 must 提案零过期作废", expiredMust.length === 0, `${expiredMust.length} 条过期：${expiredMust.slice(0, 3).map((d) => d.kind).join(",")}`);

// ══════════════ 7. 报告输出 ══════════════
console.log("\n══════════ 虚拟一周 soak 报告 ══════════");
console.log(`时间范围：${new RealDate(BASE).toLocaleString("zh-CN")} → ${new RealDate(virtual.now).toLocaleString("zh-CN")}`);
console.log(`\n【投递】共 ${log.deliveries.length} 次；按天：${perDay.map((n, i) => `d${i}:${n}`).join(" ")}`);
for (const d of sortedDeliveries) {
  console.log(`  ${fmt(d.at)} [${d.tier}/${d.importance}] ${d.kind} 「${d.title.slice(0, 22)}」 ${d.text.slice(0, 42).replaceAll("\n", " / ")}`);
}
console.log(`\n【裁决分布】${JSON.stringify(verdictDist)}`);
console.log(`【deferred 原因】${JSON.stringify(deferReasonDist)}`);
console.log(`【频控拦截 top】${Object.entries(log.governorBlocks.reduce((m, b) => { const k = b.reason.split("(")[0]; m[k] = (m[k] ?? 0) + 1; return m; }, {})).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, n]) => `${k}×${n}`).join(" ") || "无"}`);
console.log(`【打断成本】admit ${log.admits.length} 次：deliver_now=${log.admits.filter((a) => a.action === "deliver_now").length} wait_for_pause=${log.admits.filter((a) => a.action === "wait_for_pause").length} 平均成本=${(log.admits.reduce((s, a) => s + a.cost, 0) / Math.max(1, log.admits.length)).toFixed(1)}`);
console.log(`【LLM 通用路径】评估 ${log.llmEvals.length} 次（mock 规则化）`);
console.log(`【自校准】alert 中档阈值 → ${calibrator.alertMidThreshold()}（样本 ${calibrator.snapshot().samples}）`);

console.log("\n── 场景召回 ──");
for (const e of expectations) console.log(`  ${e.ok ? "✅" : "❌"} ${e.name}${e.ok ? "" : ` —— ${e.detail}`}`);
console.log("\n── 架构健康门槛 ──");
for (const g of gates) console.log(`  ${g.ok ? "✅" : "❌"} ${g.name}${g.ok ? "" : ` —— ${g.detail}`}`);

const allOk = [...expectations, ...gates].every((x) => x.ok);
console.log(`\n${allOk ? "✅ soak 验收全部通过" : "❌ soak 验收未通过（见上列 ❌ 项）"}`);

writeFileSync(join(dataDir, "soak-report.json"), JSON.stringify({
  base: BASE, days: DAYS, allOk,
  deliveries: log.deliveries, decisions: log.decisions, admits: log.admits,
  events: log.events,
  governorBlocks: log.governorBlocks, llmEvals: log.llmEvals.length, outcomes: log.outcomes,
  expectations, gates, toolCalls: sim.toolCalls,
}, null, 1));
console.log(`[soak] 数据目录：${dataDir}`);
process.exit(allOk ? 0 : 1);
