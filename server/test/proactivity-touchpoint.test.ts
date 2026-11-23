// 每日触点计划（PRD §3.4）单测：槽位时刻跟作息 / 周末砍通勤 / 冷启动默认 / 频率档裁剪 /
// 免排通道 / 容量溢出 / 保质期 / 生命周期推进 / 落盘幂等，
// 外加管道侧「同槽合并成一次开口」。
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { arbitrate } from "../src/proactivity/arbiter.js";
import { ProactiveDeliveryService } from "../src/proactivity/delivery-service.js";
import { FrequencyGovernor } from "../src/proactivity/frequency-governor.js";
import type { ProactiveProposal } from "../src/proactivity/pipeline-types.js";
import { ProactivePipeline } from "../src/proactivity/proactive-pipeline.js";
import { OutcomeStore } from "../src/proactivity/outcome-store.js";
import { PresenceService } from "../src/proactivity/presence-service.js";
import { TouchpointPlanner } from "../src/proactivity/touchpoint-planner.js";
import type { TouchpointPlan } from "../src/proactivity/touchpoint-planner.js";

const tmpDirs: string[] = [];
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "touchpoint-"));
  tmpDirs.push(dir);
  return dir;
}

test.afterEach(() => {
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

/** 2026-11-25 是周三，11-28 是周六：工作日/周末两组用例各自锚定 */
const WED_0700 = new Date(2026, 10, 25, 7, 0, 0).getTime();
const WED_1300 = new Date(2026, 10, 25, 13, 0, 0).getTime();
const SAT_0700 = new Date(2026, 10, 28, 7, 0, 0).getTime();

/**
 * 假取用口：把「学到的起床时刻」当输入喂进去，postWakeMinutes 按真实实现的语义
 * （+offset 后钳位）算——测的是 planner 传的参数与钳位区间对不对。
 */
function timingWithWake(wakeMinute: number | null) {
  return {
    postWakeMinutes(
      _actorId: string,
      opts?: { offsetMinutes?: number; clampMinutes?: [number, number]; fallbackMinutes?: number },
    ): number | null {
      if (wakeMinute === null) return opts?.fallbackMinutes ?? null;
      const raw = wakeMinute + (opts?.offsetMinutes ?? 30);
      const [lo, hi] = opts?.clampMinutes ?? [6 * 60, 11 * 60];
      return Math.min(hi, Math.max(lo, raw));
    },
    bedtimeHour: () => null,
  };
}

function makePlanner(opts: {
  wakeMinute?: number | null;
  previewMinute?: number | null;
  commute?: { leaveHome: number | null; leaveWork: number | null } | null;
  middayMinute?: number | null;
  confidence?: number;
  tier?: "quiet" | "normal" | "chatty";
  now?: number;
  path?: string;
} = {}) {
  const wake = opts.wakeMinute === undefined ? 7 * 60 : opts.wakeMinute;
  const preview = opts.previewMinute === undefined ? 21 * 60 : opts.previewMinute;
  return new TouchpointPlanner({
    timing: timingWithWake(wake),
    previewMinutesOf: () => preview,
    ...(opts.commute === null
      ? {}
      : {
          commuteMinutesOf: () =>
            opts.commute ?? { leaveHome: 8 * 60 + 20, leaveWork: 18 * 60 + 10 },
        }),
    ...(opts.middayMinute === null ? {} : { middayMinutesOf: () => opts.middayMinute ?? 12 * 60 + 30 }),
    rhythmConfidence: () => opts.confidence ?? 0.8,
    frequencyTierOf: () => opts.tier ?? "normal",
    nowFn: () => opts.now ?? WED_0700,
    ...(opts.path ? { path: opts.path } : {}),
  });
}

const kinds = (plan: TouchpointPlan) => plan.slots.map((s) => s.kind);
const slotOf = (plan: TouchpointPlan, kind: string) => plan.slots.find((s) => s.kind === kind);

function candidate(over: Partial<ProactiveProposal> = {}): ProactiveProposal {
  return {
    proposalId: "p1",
    actorId: "u1",
    kind: "wellness.parcel",
    tier: "social",
    importance: "medium",
    dedupKey: "k1",
    title: "快递",
    summary: "驿站到了个小件",
    evidence: ["台账"],
    directText: "你那个快递到驿站了，回来顺路捎一下。",
    createdAt: WED_0700,
    source: "ledger_watcher",
    ...over,
  };
}

/** 节律关怀类：偏好只有明日预览，用来造「同一槽位多条候选」 */
const care = (dedupKey: string, directText: string): ProactiveProposal =>
  candidate({ dedupKey, kind: "wellness.sleep_boundary", directText, summary: directText });

// ─── 计划生成 ───

test("触点计划：槽位时刻来自作息，不是硬编码", () => {
  const plan = makePlanner({ wakeMinute: 7 * 60 + 20 }).planOf("u1", WED_0700);
  const morning = slotOf(plan, "morning")!;
  // 起床 7:20 + 20min = 7:40（换成别的 offset 就会在这里暴露）
  assert.equal(morning.minuteOf, 7 * 60 + 40);
  assert.equal(morning.trigger, "first_unlock", "早安是首次解锁触发，不是固定点");
  assert.equal(slotOf(plan, "tomorrow_preview")!.minuteOf, 21 * 60, "明日预览沿用晚报的钟");
  assert.deepEqual(kinds(plan), ["morning", "leave_home", "midday", "leave_work", "tomorrow_preview"]);
  assert.deepEqual(
    plan.slots.map((s) => s.slotId),
    plan.slots.map((s) => `tp:u1:${plan.date}:${s.kind}`),
  );
});

test("触点计划：作息没学出来时用固定默认，并如实标 basis=default", () => {
  const plan = makePlanner({ wakeMinute: null, previewMinute: null, confidence: 0.2 }).planOf("u1", WED_0700);
  assert.equal(slotOf(plan, "morning")!.minuteOf, 8 * 60);
  assert.equal(slotOf(plan, "morning")!.basis.source, "default");
  assert.equal(slotOf(plan, "morning")!.basis.confidence, 0);
  assert.equal(slotOf(plan, "midday")!.minuteOf, 12 * 60 + 30);
  assert.equal(slotOf(plan, "tomorrow_preview")!.minuteOf, 22 * 60);
});

test("触点计划：起床时刻离谱时早安被钳回清晨窗口", () => {
  // 下午 3 点才"起床"（夜班/作息乱）→ 不能 15:20 才说早安，钳到 11:00
  const plan = makePlanner({ wakeMinute: 15 * 60 }).planOf("u1", WED_0700);
  assert.equal(slotOf(plan, "morning")!.minuteOf, 11 * 60);
});

test("触点计划：拿不到通勤依据就不排那两个槽（宁缺勿假）", () => {
  const plan = makePlanner({ commute: null }).planOf("u1", WED_0700);
  assert.deepEqual(kinds(plan), ["morning", "midday", "tomorrow_preview"]);
});

test("触点计划：周末不排出门/下班两趟", () => {
  const plan = makePlanner().planOf("u1", SAT_0700);
  assert.ok(!kinds(plan).includes("leave_home"));
  assert.ok(!kinds(plan).includes("leave_work"));
  assert.ok(kinds(plan).includes("morning"));
});

test("触点计划：quiet 档只剩早安与明日预览，一天两次", () => {
  const plan = makePlanner({ tier: "quiet" }).planOf("u1", WED_0700);
  assert.deepEqual(kinds(plan), ["morning", "tomorrow_preview"]);
});

test("触点计划：同一时点重复取用不重复生成，跨天才重建", () => {
  const p = makePlanner({ now: WED_0700 });
  const a = p.planOf("u1", WED_1300);
  assert.equal(p.planOf("u1", WED_1300), a, "同一天返回同一个计划对象（不是重新生成）");
  const next = p.planOf("u1", WED_0700 + 24 * 60 * 60_000);
  assert.notEqual(next.date, a.date);
  assert.equal(next.slots.length, a.slots.length);
});

test("触点计划：落盘后重开进程读回同一天，不另起炉灶", () => {
  const path = join(tmp(), "touchpoints.json");
  const first = makePlanner({ path, now: WED_0700 });
  const at = first.assign("u1", candidate({ dedupKey: "k-seed" }), WED_0700);
  assert.ok(at.kind === "slot");
  const again = makePlanner({ path, now: WED_0700 + 60_000 });
  const reloaded = again.planOf("u1", WED_0700 + 60_000);
  assert.deepEqual(reloaded.slots.flatMap((sl) => sl.candidates), ["k-seed"], "重启后候选区原样读回");
  // 读回的是同一天的计划，不是又生成一份新槽位
  assert.equal(reloaded.date, first.planOf("u1", WED_0700).date);
});

// ─── 候选分配 ───

test("排槽：must / critical / 带 firedAt 的补推一律走即时通道，不占触点容量", () => {
  const p = makePlanner();
  assert.equal(p.assign("u1", candidate({ tier: "must" })).kind, "immediate");
  assert.equal(p.assign("u1", candidate({ importance: "critical" })).kind, "immediate");
  assert.equal(p.assign("u1", candidate({ firedAt: WED_0700 - 3_600_000 })).kind, "immediate");
  const plan = p.planOf("u1", WED_0700);
  assert.deepEqual(plan.slots.flatMap((s) => s.candidates), [], "即时通道不进候选区");
});

test("排槽：快递优先午间，午间满了顺延到下班", () => {
  const p = makePlanner();
  const first = p.assign("u1", candidate({ dedupKey: "a" }), WED_0700);
  assert.ok(first.kind === "slot" && first.slot.kind === "midday", `实得 ${JSON.stringify(first)}`);
  const second = p.assign("u1", candidate({ dedupKey: "b" }), WED_0700);
  assert.ok(second.kind === "slot" && second.slot.kind === "leave_work", "午间容量 1，第二条溢出");
});

test("排槽：关怀类只进明日预览（需要一段时间静下来看）", () => {
  const p = makePlanner();
  const at = p.assign("u1", care("c1", "今天开得有点久，回去早点歇。"), WED_0700);
  assert.ok(at.kind === "slot" && at.slot.kind === "tomorrow_preview");
});

test("排槽：保质期赶不上任何槽 → no_slot 并留原因，不静默丢", () => {
  const p = makePlanner();
  // 13:00 提交，午间窗已过、最近落点是 18:10 下班，而这条 13:01 就过期
  const at = p.assign("u1", candidate({ expiresAt: WED_1300 + 60_000 }), WED_1300);
  assert.equal(at.kind, "no_slot");
  assert.ok(at.kind === "no_slot" && at.reason.includes("expires"), `实得 ${JSON.stringify(at)}`);
});

test("排槽：超出全部槽位容量后不再硬塞", () => {
  const p = makePlanner({ commute: null });
  // morning(3) + midday(1) + preview(3) = 7 个位置，第 8 条无处可去
  for (let i = 0; i < 7; i++) p.assign("u1", candidate({ dedupKey: `x${i}` }), WED_0700);
  const overflow = p.assign("u1", candidate({ dedupKey: "x8" }), WED_0700);
  assert.equal(overflow.kind, "no_slot");
  const plan = p.planOf("u1", WED_0700);
  const total = plan.slots.reduce((n, s) => n + s.candidates.length, 0);
  assert.equal(total, plan.slots.reduce((n, s) => n + s.capacity, 0));
});

test("退回候选：提案被去重丢弃时槽位不留幽灵候选", () => {
  const p = makePlanner();
  const at = p.assign("u1", candidate({ dedupKey: "gone" }), WED_0700);
  assert.ok(at.kind === "slot");
  assert.equal(p.releaseCandidate("gone"), true);
  assert.deepEqual(p.planOf("u1", WED_0700).slots.flatMap((s) => s.candidates), []);
});

// ─── 生命周期 ───

test("生命周期：窗口到点开槽，走完仍空着记 skipped（空槽是合法结果）", () => {
  const p = makePlanner();
  const midday = slotOf(p.planOf("u1", WED_0700), "midday")!;
  assert.equal(midday.status, "planned");
  p.sweep(midday.windowStart);
  assert.equal(p.slotOf(midday.slotId)!.status, "open");
  p.sweep(midday.windowEnd + 1);
  assert.equal(p.slotOf(midday.slotId)!.status, "skipped");
  assert.equal(p.slotOf(midday.slotId)!.reason, "empty");
});

test("生命周期：说了话的槽不会被空转清理改判 skipped", () => {
  const p = makePlanner();
  const at = p.assign("u1", candidate({ dedupKey: "m1" }), WED_0700);
  assert.ok(at.kind === "slot");
  p.markSent(at.slot.slotId, at.slot.windowStart);
  assert.equal(p.slotOf(at.slot.slotId)!.status, "sent");
  p.sweep(at.slot.windowEnd + 60_000);
  assert.equal(p.slotOf(at.slot.slotId)!.status, "sent");
});

test("生命周期：一个槽里攒了几条就记一次 merged", () => {
  const p = makePlanner();
  const a = p.assign("u1", care("m1", "一"), WED_0700);
  const b = p.assign("u1", care("m2", "二"), WED_0700);
  assert.ok(a.kind === "slot" && b.kind === "slot");
  p.markSent(a.slot.slotId, a.slot.windowStart);
  assert.equal(p.slotOf(a.slot.slotId)!.status, "merged", "多条 → merged");
});

// ─── 仲裁：未到时刻不抢跑 ───

test("arbiter：deliverAfter 在未来 → deferred 带上等待时刻（触点排槽的落地前提）", () => {
  const d = arbitrate(candidate({ deliverAfter: WED_1300 }), {
    now: WED_0700,
    presence: "active",
    inConversation: false,
    isSuppressed: () => ({ suppressed: false, reason: "" }),
    socialCanTrigger: () => ({ allowed: true, reason: "ok" }),
  });
  assert.equal(d.verdict, "deferred");
  assert.equal(d.deliverAfter, WED_1300);
  assert.ok(d.reasonChain.some((r) => r.startsWith("wait_until:")));
});

test("arbiter：抑制判定优先于等待（用户说别再提的，不必等到槽位时间才丢）", () => {
  const d = arbitrate(candidate({ deliverAfter: WED_1300 }), {
    now: WED_0700,
    presence: "active",
    inConversation: false,
    isSuppressed: () => ({ suppressed: true, reason: "mute_topic" }),
    socialCanTrigger: () => ({ allowed: true, reason: "ok" }),
  });
  assert.equal(d.verdict, "suppressed");
});

// ─── 管道接入 ───

function makePipelineHarness(opts: { planner: TouchpointPlanner | null; now: () => number }) {
  const dir = tmp();
  const presence = new PresenceService();
  const delivered: Array<{ actorId: string; json: string }> = [];
  const pipeline = new ProactivePipeline({
    dataPath: dir,
    governor: new FrequencyGovernor({ ignoreEnv: true, dailyBudget: 20 }),
    suppression: { isSuppressed: () => ({ suppressed: false, reason: "" }) },
    presence,
    // 对话进行中判定：给一个很久以前的时刻，避免"正在对话"把候选一路顺延
    lastConversationAt: () => opts.now() - 6 * 60 * 60_000,
    delivery: new ProactiveDeliveryService({
      trySend: (actorId, json) => {
        delivered.push({ actorId, json });
        return true;
      },
    }),
    outcomes: new OutcomeStore(join(dir, "outcomes.json")),
    nowFn: opts.now,
    ...(opts.planner ? { planner: opts.planner } : {}),
  });
  return { pipeline, presence, delivered };
}

/** 投递出去的正文（envelope: {type, payload:{text}}） */
const said = (delivered: Array<{ json: string }>) =>
  delivered.map((d) => String(JSON.parse(d.json).payload?.text ?? ""));

test("管道：非紧急候选不当场弹，同触点的几条到点合成一次开口", () => {
  const now = { value: WED_0700 };
  const planner = makePlanner({ now: WED_0700 });
  const h = makePipelineHarness({ planner, now: () => now.value });
  h.presence.markConnected("u1", WED_0700 - 60_000);
  const a = h.pipeline.submitProposal(care("p-a", "今天开得有点久，回去早点歇。"));
  const b = h.pipeline.submitProposal(care("p-b", "明天早会前记得把报销单交了。"));
  assert.equal(a.verdict, "deferred", "排槽后 deliverAfter 在未来 → 挂起而不是投递");
  assert.ok(a.proposal.slotId, "提案带着 slotId 落待发区");
  assert.equal(b.verdict, "deferred");
  assert.equal(a.proposal.slotId, b.proposal.slotId, "关怀类都偏好明日预览");
  assert.equal(h.delivered.length, 0, "没到点就不许说");
  now.value = (a.proposal.deliverAfter ?? 0) + 1;
  h.pipeline.flushDue(now.value);
  assert.equal(h.delivered.length, 1, "同槽两条只发一条通知");
  const text = said(h.delivered)[0]!;
  assert.match(text, /开得有点久/);
  assert.match(text, /报销单/, "第二条的内容确实说出去了，没有被吞");
  assert.ok(text.includes("\n"), "两条话术拼成一段，而不是各弹一次");
  const slot = planner.slotOf(a.proposal.slotId!)!;
  assert.ok(slot.status === "merged" || slot.status === "sent", `实得 ${slot.status}`);
  // 说过的候选不再滞留待发区（否则下轮 flush 各弹一次）
  h.pipeline.flushDue(now.value + 60_000);
  assert.equal(h.delivered.length, 1, "同一批候选不会二次投递");
});

test("管道：日程/提醒类 must 提案不受触点计划影响，仍然即时投递", () => {
  const now = { value: WED_1300 };
  const planner = makePlanner({ now: WED_1300 });
  const h = makePipelineHarness({ planner, now: () => now.value });
  h.presence.markConnected("u1", WED_1300 - 60_000);
  const d = h.pipeline.submitProposal(
    candidate({ tier: "must", importance: "high", directText: "3 分钟后评审", createdAt: WED_1300 }),
  );
  assert.equal(d.verdict, "delivered");
  assert.equal(d.proposal.slotId, undefined);
  assert.equal(h.delivered.length, 1);
});

test("管道：未装配 planner 时行为与改造前一致（不排槽、不吞消息）", () => {
  const now = { value: WED_1300 };
  const h = makePipelineHarness({ planner: null, now: () => now.value });
  h.presence.markConnected("u1", WED_1300 - 60_000);
  const d = h.pipeline.submitProposal(candidate({ dedupKey: "legacy", createdAt: WED_1300 }));
  assert.equal(d.verdict, "delivered");
  assert.equal(d.proposal.slotId, undefined);
});

test("管道：planner 抛错时候选按即时通道放行，不让计划层吞掉消息", () => {
  const now = { value: WED_1300 };
  const planner = makePlanner({ now: WED_1300 });
  planner.assign = () => {
    throw new Error("boom");
  };
  const h = makePipelineHarness({ planner, now: () => now.value });
  h.presence.markConnected("u1", WED_1300 - 60_000);
  const d = h.pipeline.submitProposal(candidate({ dedupKey: "boom-1", createdAt: WED_1300 }));
  assert.equal(d.verdict, "delivered");
});

test("管道：诊断视图里看得见当天的触点计划", () => {
  const now = { value: WED_0700 };
  const planner = makePlanner({ now: WED_0700 });
  const h = makePipelineHarness({ planner, now: () => now.value });
  h.presence.markConnected("u1", WED_0700 - 60_000);
  h.pipeline.submitProposal(care("diag-1", "明天记得带伞。"));
  const diag = h.pipeline.diagnostics() as unknown as {
    touchpoints: Array<{ actorId: string; plan: TouchpointPlan }>;
  };
  const mine = diag.touchpoints.find((t) => t.actorId === "u1");
  assert.ok(mine, "诊断里应能看到在线用户的计划");
  assert.ok(mine!.plan.slots.some((s) => s.candidates.includes("diag-1")));
});

test("管道：早安槽等当天首次解锁，没解锁就一轮都不说（§3.4）", () => {
  const now = { value: WED_0700 };
  const planner = makePlanner({ now: WED_0700 });
  const h = makePipelineHarness({ planner, now: () => now.value });
  h.presence.markConnected("u1", WED_0700 - 60_000);
  // 手机连着但锁着屏（人不在手机前）：有状态、无解锁
  h.presence.notePhoneState("u1", { interactive: false, screenOn: false, inCall: false, dnd: false, charging: true }, WED_0700);
  const d = h.pipeline.submitProposal(
    candidate({ dedupKey: "mb", kind: "morning_briefing", directText: "今天两场会，下午那场要带笔记本。" }),
  );
  assert.ok(d.proposal.slotId?.endsWith(":morning"), `实得 ${d.proposal.slotId}`);
  now.value = (d.proposal.deliverAfter ?? 0) + 1;
  h.pipeline.flushDue(now.value);
  assert.equal(h.delivered.length, 0, "到点但没解锁 → 早安不说");
  assert.equal(planner.slotOf(d.proposal.slotId!)!.status, "open");
  // 用户解锁起床，下一轮 flush 就说
  h.presence.notePhoneState("u1", { interactive: true, screenOn: true, inCall: false, dnd: false, charging: false }, now.value + 60_000);
  assert.equal(h.presence.firstUnlockToday("u1", now.value + 60_000), now.value + 60_000);
  h.pipeline.flushDue(now.value + 60_000);
  assert.equal(h.delivered.length, 1, "解锁后当轮就补上");
  assert.match(said(h.delivered)[0]!, /两场会/);
});
