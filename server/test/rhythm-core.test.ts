// RhythmCore（节律感知核心）单测：
// 连续工作检测、深夜活跃计数（去抖）、触发冷却、静默重置。
// 用真实 BodyBus（纯内存），受控 Date 喂 noteActivity。
import assert from "node:assert/strict";
import test from "node:test";

import { BodyBus } from "../src/body/body-bus.js";
import { RhythmCore } from "../src/body/rhythm-core.js";
import type { BodySignal } from "../src/body/types.js";

const ACTOR = "actor-1";

/** 造一个本地时间 Date（今天指定时分） */
function atHour(hour: number, minute = 0, dayOffset = 0): Date {
  const d = new Date();
  d.setDate(d.getDate() + dayOffset);
  d.setHours(hour, minute, 0, 0);
  return d;
}

function makeRhythm(): { core: RhythmCore; signals: BodySignal[] } {
  // 清掉阈值 env，保证默认（3h / 2 次 / 8h 冷却）
  delete process.env.RHYTHM_OVERWORK_HOURS;
  delete process.env.RHYTHM_LATE_NIGHT_COUNT;
  delete process.env.RHYTHM_TRIGGER_COOLDOWN_MS;
  const bus = new BodyBus();
  const signals: BodySignal[] = [];
  bus.subscribe("body.rhythm.overwork_detected", (s) => signals.push(s));
  const core = new RhythmCore({ bodyBus: bus });
  return { core, signals };
}

test("连续工作 ≥3h：发布 overwork 信号（continuous_work）", () => {
  const { core, signals } = makeRhythm();
  const start = atHour(9);
  // 连续工作语义：活跃间隔 <30 分钟不算休息。每 25 分钟活跃一次，累计 3h20m
  for (let i = 0; i <= 8; i++) {
    core.noteActivity(ACTOR, "presence", new Date(start.getTime() + i * 25 * 60 * 1000));
    if (i < 8) assert.equal(signals.length, 0); // 不足 3h 不触发
  }
  assert.equal(signals.length, 1);
  assert.equal(signals[0].kind, "body.rhythm.overwork_detected");
  assert.equal(signals[0].actorId, ACTOR);
  const payload = signals[0].payload as { continuousWorkHours: number; reason: string };
  assert.equal(payload.reason, "continuous_work");
  assert.ok(payload.continuousWorkHours >= 3);
});

test("深夜活跃 ≥3 次（去抖 30 分钟）：发布 overwork 信号（late_night_active）", () => {
  const { core, signals } = makeRhythm();
  // 凌晨同一 dateKey 内：00:10 / 00:45 / 01:20（间隔 35min > 去抖窗口，计 3 次）
  core.noteActivity(ACTOR, "conversation", atHour(0, 10));
  assert.equal(signals.length, 0);
  core.noteActivity(ACTOR, "conversation", atHour(0, 45));
  assert.equal(signals.length, 0); // 2 次不再触发（2026-10-12 降噪：2 次=误报重灾区）
  core.noteActivity(ACTOR, "conversation", atHour(1, 20));
  assert.equal(signals.length, 1);
  const payload = signals[0].payload as { reason: string; lateNightActiveCount: number };
  assert.equal(payload.reason, "late_night_active");
  assert.ok(payload.lateNightActiveCount >= 3);
});

test("深夜聊两句（同去抖窗口内）不触发全套干预", () => {
  const { core, signals } = makeRhythm();
  // 23:30 / 23:55（25min < 30min 去抖）只计 1 次；午夜前最多 2 次 → 不触发
  core.noteActivity(ACTOR, "conversation", atHour(23, 30));
  core.noteActivity(ACTOR, "conversation", atHour(23, 55));
  assert.equal(signals.length, 0);
});

test("深夜去抖：30 分钟窗口内多次活跃只计 1 次", () => {
  const { core, signals } = makeRhythm();
  core.noteActivity(ACTOR, "conversation", atHour(23, 30));
  core.noteActivity(ACTOR, "conversation", atHour(23, 35)); // 5 分钟后：去抖不计数
  core.noteActivity(ACTOR, "conversation", atHour(23, 55)); // 仍 <30min：不计数
  assert.equal(signals.length, 0);
});

test("触发后冷却：8h 内同 actor 不再触发", () => {
  const { core, signals } = makeRhythm();
  const start = atHour(9);
  // 25 分钟间隔链累计 3h20m → 触发
  for (let i = 0; i <= 8; i++) {
    core.noteActivity(ACTOR, "presence", new Date(start.getTime() + i * 25 * 60 * 1000));
  }
  assert.equal(signals.length, 1);
  const triggeredAt = start.getTime() + 8 * 25 * 60 * 1000;

  // 触发即重置工作段；之后再连续干 3h+，但 8h 冷却期内 → 不再触发
  for (let i = 1; i <= 8; i++) {
    core.noteActivity(ACTOR, "presence", new Date(triggeredAt + i * 25 * 60 * 1000));
  }
  assert.equal(signals.length, 1);
});

test("静默 >30 分钟：连续工作计时重置（休息过就不算连续加班）", () => {
  const { core, signals } = makeRhythm();
  const start = atHour(10);
  core.noteActivity(ACTOR, "conversation", start);
  // 中间休息 40 分钟再来：workStartAt 重置为现在
  core.noteActivity(ACTOR, "conversation", new Date(start.getTime() + 3 * 60 * 60 * 1000 + 40 * 60 * 1000));
  assert.equal(signals.length, 0);
});

test("白天正常活跃不触发", () => {
  const { core, signals } = makeRhythm();
  const start = atHour(14);
  core.noteActivity(ACTOR, "conversation", start);
  core.noteActivity(ACTOR, "presence", new Date(start.getTime() + 30 * 60 * 1000));
  assert.equal(signals.length, 0);
});

test("act 恒拒绝（纯感知模块）；sense 返回追踪状态；snapshot 元数据", async () => {
  const { core } = makeRhythm();
  const actResult = await core.act({} as never);
  assert.equal(actResult.ok, false);

  core.noteActivity(ACTOR, "conversation", new Date());
  const sense = await core.sense({ actorId: ACTOR } as never);
  assert.equal(sense.ok, true);
  assert.equal((sense.data as { tracked: boolean }).tracked, true);

  const snap = core.snapshot();
  assert.equal(snap.name, "rhythm");
  assert.equal((snap.metadata as { trackedActors: number }).trackedActors, 1);
});

// ── 自适应基线（阈值从用户自身行为学习，非硬编码） ─────

/**
 * 喂入 count 个自然结束的工作段（段内 25 分钟一活跃，段间休息 45 分钟 > 30 分钟
 * 触发"自然结束"→ 记为学习样本）。段长须为 25 的倍数（末次活跃恰在段尾，
 * 样本长度精确）。全程白天、段长 < 3h 默认阈值 → 不触发信号。
 */
function feedNaturalSessions(
  core: RhythmCore,
  actor: string,
  sessionLenMin: number,
  count: number,
  baseHour = 8,
): void {
  const base = atHour(baseHour).getTime();
  let cursor = 0;
  for (let i = 0; i < count; i++) {
    for (let s = 0; s <= sessionLenMin; s += 25) {
      core.noteActivity(actor, "presence", new Date(base + (cursor + s) * 60000));
    }
    cursor = cursor + sessionLenMin + 45;
    core.noteActivity(actor, "presence", new Date(base + cursor * 60000));
  }
}

test("自适应工作阈值：样本不足（<5）用默认 3h 引导", () => {
  const { core } = makeRhythm();
  feedNaturalSessions(core, ACTOR, 50, 4); // 只喂 4 段
  assert.equal(core.overworkThresholdHours(ACTOR), 3);
});

test("自适应工作阈值：短 session 用户（中位 50min）→ clamp 到下限 2.5h", () => {
  const { core } = makeRhythm();
  feedNaturalSessions(core, ACTOR, 50, 5); // 5 段 × 50min：中位×1.4=1.17h < 2.5
  assert.equal(core.overworkThresholdHours(ACTOR), 2.5);
});

test("自适应工作阈值：中位 2.5h 用户 → 2.5h×1.4=3.5h（区间内精确学习值）", () => {
  const { core } = makeRhythm();
  feedNaturalSessions(core, ACTOR, 150, 5, 5); // 5 段 × 150min（05:00 起不跨午夜）
  assert.equal(core.overworkThresholdHours(ACTOR), 3.5);
});

test("自适应工作阈值：env 显式设置覆盖学习值（手动优先于学习）", () => {
  const { core } = makeRhythm();
  feedNaturalSessions(core, ACTOR, 150, 5, 5); // 学习值 3.5h
  process.env.RHYTHM_OVERWORK_HOURS = "1.5";
  try {
    assert.equal(core.overworkThresholdHours(ACTOR), 1.5);
  } finally {
    delete process.env.RHYTHM_OVERWORK_HOURS;
  }
});

test("自适应工作阈值生效：短 session 用户 2.75h 即触发（默认 3h 不会）", () => {
  const { core, signals } = makeRhythm();
  feedNaturalSessions(core, ACTOR, 50, 5); // 阈值已学成 2.5h
  assert.equal(signals.length, 0); // 学习段本身不触发（50min << 2.5h）

  // 新工作段：2h45m（25 分钟一活跃）≥ 学习阈值 2.5h → 触发
  const start = atHour(16);
  for (let i = 0; i <= 6; i++) {
    core.noteActivity(ACTOR, "presence", new Date(start.getTime() + i * 25 * 60 * 1000));
  }
  assert.equal(signals.length, 1);
  const payload = signals[0].payload as { reason: string; thresholdHours: number };
  assert.equal(payload.reason, "continuous_work");
  assert.equal(payload.thresholdHours, 2.5); // 信号里携带的是学习阈值而非默认值
});

test("自适应深夜窗口：凌晨睡的用户学到 01:30 起点，23:30 活跃不算深夜", () => {
  const { core, signals } = makeRhythm();
  // 5 个"凌晨 00:30 才歇"的昼夜 → 就寝样本中位 24.5 → 窗口起点 25.5（01:30）
  for (let d = 0; d < 5; d++) {
    core.noteActivity(ACTOR, "conversation", atHour(0, 30, d));
    core.noteActivity(ACTOR, "conversation", atHour(9, 0, d + 1)); // 跨天 → 记就寝样本
  }
  assert.equal(core.lateNightStartHour(ACTOR), 25.5);
  // 学习期凌晨活跃本身可能触发 late_night 信号（默认窗口下计入深夜）——记录基线
  const signalsDuringLearning = signals.length;

  // 学习后：23:30/23:45 连续活跃对夜猫子是常态 → 不触发（默认窗口 23 起会触发）
  const nightOwl = atHour(23, 30, 30); // 换一天，避开学习期累计的深夜计数与冷却
  core.noteActivity(ACTOR, "conversation", nightOwl);
  core.noteActivity(ACTOR, "conversation", new Date(nightOwl.getTime() + 15 * 60000));
  assert.equal(signals.length, signalsDuringLearning); // 学习后 23:30 不再计入深夜
});

test("自适应深夜窗口：样本不足用默认 23 点（23:30 活跃计入深夜）", async () => {
  const { core } = makeRhythm();
  assert.equal(core.lateNightStartHour(ACTOR), 23);
  core.noteActivity(ACTOR, "conversation", atHour(23, 30));
  const sense = await core.sense({ actorId: ACTOR } as never);
  const data = sense.data as { lateNightCount?: number };
  assert.ok((data.lateNightCount ?? 0) >= 1);
});

test("就寝样本防污染：下午关 App 的日子不计入就寝基线", () => {
  const { core } = makeRhythm();
  // 5 个「下午 14 点最后活跃」的昼夜：不是就寝，不应进样本
  for (let d = 0; d < 5; d++) {
    core.noteActivity(ACTOR, "conversation", atHour(14, 0, d));
    core.noteActivity(ACTOR, "conversation", atHour(9, 0, d + 1)); // 跨天采样点
  }
  assert.equal(core.learnedBedtimeHour(ACTOR), null); // 样本被拒收 → 无学习值
  assert.equal(core.lateNightStartHour(ACTOR), 23); // 深夜窗口不漂移
});

test("作息基线：2 个有效夜晚即学习（不等 5 天，不落硬默认）", () => {
  const { core } = makeRhythm();
  // 两个「23:30 最后活跃」的夜晚 → 就寝样本 23.5×2
  for (let d = 0; d < 2; d++) {
    core.noteActivity(ACTOR, "conversation", atHour(23, 30, d));
    core.noteActivity(ACTOR, "conversation", atHour(9, 0, d + 1)); // 跨天记样本
  }
  assert.equal(core.learnedBedtimeHour(ACTOR), 23.5); // 提醒将排在 22:30（就寝前 1h）
  assert.equal(core.lateNightStartHour(ACTOR), 23); // 检测窗口仍走 5 样本门槛 → 默认
});

test("sense：adaptive 视图暴露学习阈值与样本数", async () => {
  const { core } = makeRhythm();
  feedNaturalSessions(core, ACTOR, 150, 5, 5);
  core.noteActivity(ACTOR, "conversation", new Date());
  const sense = await core.sense({ actorId: ACTOR } as never);
  const data = sense.data as {
    adaptive: {
      overworkThresholdHours: number;
      lateNightStartHour: number;
      sessionSamples: number;
      bedtimeSamples: number;
    };
  };
  assert.equal(data.adaptive.overworkThresholdHours, 3.5);
  assert.equal(data.adaptive.lateNightStartHour, 23); // 无就寝样本 → 默认
  assert.equal(data.adaptive.sessionSamples, 5);
  assert.equal(data.adaptive.bedtimeSamples, 0);
});
