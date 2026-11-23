// 轻量健康（PRD §10 需求八，P2）单测：用药提醒 / 作息周报 / 喝水久坐。
//
// 这一节的验收线全部来自 §10 那张表，四条：
//  ① 「对话创建（每天早饭后吃维生素 D）→ 周期提醒」＋「晚间 slot 检查当天漏服并提一次」；
//  ② 「每周日明日预览 slot：平均入睡/起床、与上周对比、一句建议（不说教）」，
//     且冷启动不推（§7.4 置信度门槛）；
//  ③ 「只在工作时段且步数长时间不变时提醒，默认关」；
//  ④ 闭环动作只有那四个（已吃 / 10 分钟后 / 知道了 / 今天别提），且都落在**既有**动作 id 上。
// 再加一条口径（§1.3）：健康**不是第二套通知系统**，也不自带钟——三类提案都只经
// submitProposal 进既有管道，靠 deliverAfter 落进 §3.4 的触点，所以最后一个用例刻意用
// 真的 ProactivePipeline + 真的 TouchpointPlanner + 真的 HookBus 回灌整条链跑一遍。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { FrequencyGovernor } from "../src/proactivity/frequency-governor.js";
import { OutcomeStore } from "../src/proactivity/outcome-store.js";
import { ProactiveDeliveryService } from "../src/proactivity/delivery-service.js";
import { PresenceService } from "../src/proactivity/presence-service.js";
import { ProactivePipeline } from "../src/proactivity/proactive-pipeline.js";
import { TouchpointPlanner } from "../src/proactivity/touchpoint-planner.js";
import { NOTIFY_ACTION, buildNotifyActions } from "../src/proactivity/notification-actions.js";
import type { ProactiveProposal } from "../src/proactivity/pipeline-types.js";
import { HookBus, setHookBus } from "../src/services/hooks/index.js";
import {
  DOSE_CHECK_GRACE_MS,
  DOSE_POSTPONE_MS,
  HEALTH_KIND,
  HealthService,
  WEEKLY_MIN_DAYS,
  formatHourDecimal,
  healthPresetOf,
  isMedicationTask,
  isPrivateMedication,
  markHealthTask,
  summarizeSleepWeek,
  weekStartOf,
} from "../src/proactivity/health-service.js";
import type { HealthTaskView, RhythmView } from "../src/proactivity/health-service.js";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const tmpDirs: string[] = [];
function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

test.afterEach(() => {
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

/** 本地日期键（断言 dedupKey 用，与服务内部同口径） */
function localOf(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function at(y: number, m: number, d: number, h: number, mi = 0): number {
  return new Date(y, m, d, h, mi, 0).getTime();
}

// 2026-11-23 周一 / 11-25 周三 / 11-29 周日（与 proactivity-commitment 同一个月，口径能对着读）
const MON_0700 = at(2026, 10, 23, 7);
const WED_2000 = at(2026, 10, 25, 20);
const SUN_2000 = at(2026, 10, 29, 20);
/** 明日预览触点（当日 21:00）：晚间那句与周报都该落在这里（§3.4） */
function previewOf(ms: number): number {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 21, 0, 0).getTime();
}

/** 本地钟面 ISO（ScheduleTaskRecord.runAt 就是这个形状） */
function localIso(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 一条「每天早饭后吃维生素 D」式的周期用药任务（就是既有重复提醒那条记录的形状） */
function medTask(over: Partial<HealthTaskView> & { taskId: string; at: number }): HealthTaskView {
  return {
    sessionId: "u1",
    title: "吃药",
    shortTitle: "维生素D",
    description: markHealthTask("早饭后吃维生素 D", "medication"),
    kind: "reminder",
    recurrence: "daily",
    status: "active",
    runAt: localIso(over.at),
    ...over,
  } as HealthTaskView;
}

/**
 * 两周的节律画像：上周七天 23:00 睡 / 本周前 N 天 23:42 睡。
 * 刻意做成「本周比上周晚 42 分钟」，好让「与上周对比」那句有内容可念。
 */
function rhythmFixture(opts: { days?: number; confidence?: number; weekOf?: number } = {}): RhythmView {
  const days = opts.days ?? 6;
  const weekStart = weekStartOf(opts.weekOf ?? SUN_2000);
  const sleep: RhythmView["sleep"] = [];
  const wake: RhythmView["wake"] = [];
  for (let i = 0; i < 7; i++) {
    const key = localOf(weekStart + (i - 7) * DAY);
    sleep.push({ date: key, startHour: 23.0, endHour: 7.0, source: "sensor" });
    wake.push({ date: key, hour: 7.0, source: "sensor" });
  }
  for (let i = 0; i < days; i++) {
    const key = localOf(weekStart + i * DAY);
    sleep.push({ date: key, startHour: 23.7, endHour: 7.1, source: "sensor" });
    wake.push({ date: key, hour: 7.1, source: "sensor" });
  }
  return { sleep, wake, confidence: opts.confidence ?? 0.8 };
}

function makeService(
  opts: {
    now?: number;
    tier?: "quiet" | "normal" | "chatty";
    tasks?: HealthTaskView[];
    rhythm?: { value: RhythmView | null };
    stillness?: { value: number | null };
    identity?: string[];
    slots?: boolean;
  } = {},
) {
  const clock = { now: opts.now ?? MON_0700 };
  const proposals: ProactiveProposal[] = [];
  const svc = new HealthService({
    submit: (p) => {
      proposals.push(p);
      return true;
    },
    governor: new FrequencyGovernor({
      ignoreEnv: true,
      tierOf: () => opts.tier ?? "normal",
      nowFn: () => new Date(clock.now),
    }),
    medicationTasks: () => opts.tasks ?? [],
    nowFn: () => clock.now,
    log: () => {},
    butlerName: () => "小管",
    identityTexts: () => opts.identity ?? ["职业:后端开发"],
    ...(opts.slots
      ? { slotTimes: (_a: string, atMs: number) => [{ kind: "tomorrow_preview", windowStart: previewOf(atMs) }] }
      : {}),
    ...(opts.rhythm ? { rhythm: () => opts.rhythm!.value } : {}),
    ...(opts.stillness ? { stillnessOf: () => opts.stillness!.value } : {}),
  });
  return { svc, proposals, clock };
}

// ─── ① 用药：一颗药一天只提一条 ───

test("用药：每天一颗只排一条打卡，反复评估不翻倍；按钮是真动作", () => {
  const tasks = [medTask({ taskId: "m1", at: at(2026, 10, 23, 8, 30) })];
  const { svc, proposals, clock } = makeService({ tasks });

  const first = svc.planDoses("u1", clock.now);
  assert.equal(first.created, 1, "一天一颗 = 一条打卡提案");
  // 反复被叫（用户解锁、晚间触点、服务重启）都不能翻倍
  clock.now = MON_0700 + 20 * MIN;
  svc.planDoses("u1", clock.now);
  clock.now = MON_0700 + 2 * HOUR;
  svc.planDoses("u1", clock.now);
  assert.equal(proposals.length, 1, `同一颗药当天只该提一次，实得 ${proposals.length} 条`);

  const p = proposals[0]!;
  assert.equal(p.kind, HEALTH_KIND.medication);
  // §10「周期提醒」是用户自己点名要的，不是系统找话聊 → 必达层，不受社交预算牵连
  assert.equal(p.tier, "must", "到点吃药是用户点名事项");
  assert.equal(p.dedupKey, `health:medication:m1:${localOf(MON_0700)}`);
  assert.equal(
    p.deliverAfter,
    at(2026, 10, 23, 8, 30) + DOSE_CHECK_GRACE_MS,
    "开口时刻 = 该吃的点 + 宽限（贴着闹钟问等于同一瞬间弹两条）",
  );
  assert.ok(p.expiresAt! > p.deliverAfter!, "保质期晚于开口时刻，否则一入队就过期");
  assert.deepEqual(
    p.notifyOptions?.map((o) => o.action),
    ["schedule_complete", "snooze"],
    "不新造按钮：两个角色在 notification-action-executors 里都有真执行器",
  );
  assert.equal(p.notifyOptions?.[0].ref, "m1", "已吃要按天精确落到这一颗，必须带 taskId");
  assert.equal(p.notifyOptions?.[1].delayMs, DOSE_POSTPONE_MS, "§10 原话：10 分钟后");

  // 按钮真的渲染得出来（schedule_* 缺 ref 会被装配层丢掉，这里断言的是最终形态）
  const acts = buildNotifyActions(p);
  assert.deepEqual(
    acts.map((a) => a.actionId),
    [NOTIFY_ACTION.scheduleComplete, NOTIFY_ACTION.snooze],
  );
  assert.deepEqual(acts.map((a) => a.label), ["已吃", "10 分钟后"]);
});

test("无定时器入口：用户活跃只补排一次，开关没开时顺带什么都不做", () => {
  const tasks = [medTask({ taskId: "m1", at: at(2026, 10, 23, 8, 30) })];
  const { svc, proposals, clock } = makeService({ tasks });
  assert.equal(svc.onUserTouch("u1", clock.now).planned, 1, "昨晚没跑成（服务重启）→ 早晨一解锁就补上");
  clock.now = MON_0700 + MIN;
  const twice = svc.onUserTouch("u1", clock.now);
  assert.equal(twice.planned, 0, "同一天再来活跃事件不再翻任务表、不再排第二条");
  assert.equal(twice.move, null, "喝水/久坐默认关 → 活跃事件不产生任何健康提案");
  assert.equal(proposals.length, 1);
});

// ─── ①b 晚间 slot：漏服检查一天一次，多种药合成一句 ───

test("晚间 slot：当天没落账的药合并成一句补问，只问一次；顺带排好明天", () => {
  const tasks = [
    medTask({ taskId: "m1", at: at(2026, 10, 25, 8, 30), shortTitle: "维生素D" }),
    medTask({ taskId: "m2", at: at(2026, 10, 25, 12, 30), shortTitle: "钙片" }),
  ];
  const { svc, proposals, clock } = makeService({ now: WED_2000, tasks, slots: true });

  const res = svc.evaluateEveningSlot("u1", clock.now);
  assert.equal(res.planned, 2, "晚间顺手把明天两颗的打卡排上（时刻在明天，由管道攒着）");
  const misses = proposals.filter((x) => x.kind === HEALTH_KIND.medicationMiss);
  assert.equal(misses.length, 1, "晚间漏服每天只提一次");
  assert.equal(res.missCheck, misses[0]);
  assert.equal(misses[0]!.tier, "social", "补问是系统主动开的一句口，计入社交预算（§3.10）");
  assert.equal(misses[0]!.source, "rhythm", "落点由触点计划定（明日预览），本模块不自己找钟");
  assert.equal(misses[0]!.deliverAfter, previewOf(WED_2000), "开口时刻只来自触点计划");
  assert.match(misses[0]!.summary, /维生素D/);
  assert.match(misses[0]!.summary, /钙片/);
  assert.equal(String(misses[0]!.evidence.at(-1)), "count=2", "两颗药合成一句，不是两条通知");
  assert.equal(misses[0]!.expiresAt, at(2026, 10, 26, 0, 0), "过期不出当天");

  // 同一个晚间再跑一遍（触点重进 / 服务重启）：不重复问
  const before = proposals.length;
  clock.now = WED_2000 + 10 * MIN;
  const again = svc.evaluateEveningSlot("u1", clock.now);
  assert.equal(again.missCheck, null, "当天已经问过了，别再问第二遍");
  assert.equal(again.reason.includes("miss_already_today"), true);
  assert.equal(proposals.length, before, "排过的不重排，问过的不问");

  // 次日：日期键变了，该重新问一次（漏服是「当天」的口径）
  clock.now = WED_2000 + DAY;
  svc.evaluateEveningSlot("u1", clock.now);
  assert.equal(
    proposals.filter((x) => x.kind === HEALTH_KIND.medicationMiss && x.dedupKey.includes(localOf(WED_2000 + DAY)))
      .length,
    1,
    "次日晚间仍会问一次",
  );
});

test("晚间：说过「10 分钟后」的，晚上不再当漏服追问", () => {
  const tasks = [medTask({ taskId: "m1", at: at(2026, 10, 25, 8, 30) })];
  const { svc, proposals, clock } = makeService({ now: WED_2000, tasks, slots: true });
  svc.planDoses("u1", clock.now); // 今天这颗入账（时刻已过，只记账不补问）
  const deferred = svc.observeOutcome({ actorId: "u1", kind: HEALTH_KIND.medication, outcome: "snoozed", ref: "m1", at: clock.now });
  assert.equal(deferred.reason, "deferred");
  const res = svc.evaluateEveningSlot("u1", clock.now);
  assert.equal(res.missCheck, null, "用户已经表过态，追着再问就是催");
  assert.ok(res.reason.includes("no_missed_dose"));
  assert.equal(proposals.filter((x) => x.kind === HEALTH_KIND.medicationMiss).length, 0);
});

// ─── ② 作息周报：只有周日、样本够才推 ───

test("周报：只在周日出现；冷启动（置信度 / 样本不够）一句不说（§7.4）", () => {
  // 周三的晚间触点：可以有漏服那句，但没有周报
  const wed = makeService({ now: WED_2000, slots: true, rhythm: { value: rhythmFixture() } });
  const wedRes = wed.svc.evaluateEveningSlot("u1", wed.clock.now);
  assert.equal(wedRes.report, null, "非周日不发周报");
  assert.ok(wedRes.reason.includes("report_skipped"));
  assert.equal(wed.proposals.length, 0, "没有任务、没有周报 → 周三这个晚间一句都不说");

  // 冷启动①：置信度不到门槛
  const cold = makeService({ now: SUN_2000, slots: true, rhythm: { value: rhythmFixture({ confidence: 0.2 }) } });
  assert.equal(cold.svc.evaluateEveningSlot("u1", cold.clock.now).report, null, "§7.4：置信度不足不推");
  assert.equal(cold.proposals.length, 0);

  // 冷启动②：置信度够，但本周只有 3 天样本——「平均入睡」是编出来的
  const sparse = makeService({ now: SUN_2000, slots: true, rhythm: { value: rhythmFixture({ days: WEEKLY_MIN_DAYS - 1 }) } });
  assert.equal(sparse.svc.evaluateEveningSlot("u1", sparse.clock.now).report, null, "样本天数不足不发周报");
  assert.equal(sparse.proposals.length, 0);

  // 周日 + 样本够：一条周报，tier=social，每周只一次
  const view = { value: rhythmFixture({ days: 6 }) };
  const ok = makeService({ now: SUN_2000, slots: true, rhythm: view });
  const report = ok.svc.evaluateEveningSlot("u1", ok.clock.now).report!;
  assert.ok(report, "周日样本足够时该发周报");
  assert.equal(report.kind, HEALTH_KIND.rhythmReport);
  assert.equal(report.tier, "social", "周报是主动闲聊，不占必达额度");
  assert.equal(report.deliverAfter, previewOf(SUN_2000), "落点是明日预览 slot");
  assert.equal(report.dedupKey, `health:report:u1:${localOf(weekStartOf(SUN_2000))}`);
  assert.match(report.summary, /这周平均 23:42 睡、07:06 起/, "均值一律取自节律画像");
  assert.match(report.summary, /比上周晚了 42 分钟/, "与上周对比");
  // 边界（§10）：不说教、不诊断、不给用药/就医建议
  assert.doesNotMatch(report.summary, /应该|最好|必须|建议|伤身|熬夜|危害|就诊|诊断/);
  assert.deepEqual(
    report.notifyOptions?.map((o) => [o.action, o.label]),
    [
      ["acknowledge", "知道了"],
      ["chat_reply", "回复"],
    ],
    "闭环只有「知道了」与 §4.3 的「回复」入口，不留别的假按钮",
  );

  // 同一周内不重复；下一个周日（换到那一周的画像）再来一条
  ok.clock.now = SUN_2000 + MIN;
  assert.equal(ok.svc.evaluateEveningSlot("u1", ok.clock.now).report, null, "一周只发一次");
  ok.clock.now = SUN_2000 + 7 * DAY;
  view.value = rhythmFixture({ days: 6, weekOf: SUN_2000 + 7 * DAY });
  assert.ok(ok.svc.evaluateEveningSlot("u1", ok.clock.now).report, "下一周照常");
  assert.equal(ok.proposals.filter((x) => x.kind === HEALTH_KIND.rhythmReport).length, 2);
});

test("周报统计：取中位数、按节律既有分桶，凌晨样本折回当天钟面", () => {
  const stats = summarizeSleepWeek(rhythmFixture({ days: 6 }), weekStartOf(SUN_2000));
  assert.equal(stats.bedHour, 23.7);
  assert.equal(stats.wakeHour, 7.1);
  assert.equal(stats.days, 6);
  assert.equal(stats.bedDeltaMinutes, 42);
  assert.equal(stats.weekendDays, 1, "工作日/周末分组来自 grouping.daypartOfDayKey，不在这里另立口径");
  assert.equal(stats.weekdayDays, 5);
  assert.equal(formatHourDecimal(23.7), "23:42");
  assert.equal(formatHourDecimal(24.5), "00:30", "跨零点样本念成凌晨");
  assert.equal(formatHourDecimal(null), "");
  // 空一周：不编数字
  const empty = summarizeSleepWeek({ sleep: [], wake: [], confidence: 0.9 }, weekStartOf(SUN_2000));
  assert.equal(empty.bedHour, null);
  assert.equal(empty.days, 0);
});

// ─── ③ 喝水 / 久坐：默认关，开着也只在工作时段 ───

test("喝水/久坐：默认关 → 一句不说；开启后仍受工作时段与每日条数约束", () => {
  const TUE_1400 = at(2026, 10, 24, 14);
  const still = { value: 95 };
  const { svc, proposals, clock } = makeService({ now: TUE_1400, stillness: still });

  // 默认关（§10「默认关」）：坐了两小时也不开口
  assert.equal(svc.isMoveOptedIn("u1"), false);
  let r = svc.evaluateMove("u1", TUE_1400);
  assert.equal(r.sent, false);
  assert.equal(r.reason, "opt_out");
  assert.equal(proposals.length, 0, "没开开关的人一条都不该发");

  // 本期唯一的开法：对话里明确说要
  assert.equal(svc.captureFromUserText("u1", "记得提醒我喝水")?.kind, "opt_in");
  assert.equal(svc.isMoveOptedIn("u1"), true);

  // 时段外静默（久坐办公档 9:00–19:00，阈值与时段都取自既有节奏档位表）
  r = svc.evaluateMove("u1", at(2026, 10, 24, 22, 30));
  assert.equal(r.sent, false);
  assert.equal(r.reason, "out_of_work_hours");
  // 周末不是工作时段
  r = svc.evaluateMove("u1", at(2026, 10, 28, 14));
  assert.equal(r.sent, false);
  assert.equal(r.reason, "weekend");
  // 坐得还不够久
  still.value = 30;
  r = svc.evaluateMove("u1", TUE_1400 + 30 * MIN);
  assert.equal(r.sent, false);
  assert.equal(r.reason, "not_sedentary_yet");

  // 两个条件同时成立才提一句
  still.value = 95;
  clock.now = at(2026, 10, 25, 15);
  r = svc.evaluateMove("u1", clock.now);
  assert.equal(r.sent, true, `工作时段 + 长时间静止才提一句：${r.reason}`);
  const p = r.proposal!;
  assert.equal(p.kind, HEALTH_KIND.move);
  assert.equal(p.tier, "social", "这是主动开口，占社交预算");
  assert.deepEqual(p.notifyOptions?.map((o) => [o.action, o.label]), [
    ["acknowledge", "知道了"],
    ["dismiss", "今天别提"],
  ]);
  assert.equal(proposals.filter((x) => x.kind === HEALTH_KIND.move).length, 1);
  // 一天最多一句
  assert.equal(svc.evaluateMove("u1", clock.now + 2 * HOUR).reason, "daily_cap");
  assert.equal(proposals.filter((x) => x.kind === HEALTH_KIND.move).length, 1);

  // 「今天别提」按下去 = 当天静音（隔日自然恢复）
  svc.observeOutcome({ actorId: "u1", kind: HEALTH_KIND.move, outcome: "dismissed", at: clock.now });
  assert.equal(svc.evaluateMove("u1", clock.now + MIN).reason, "muted_today");
  assert.equal(svc.evaluateMove("u1", clock.now + DAY).reason, "submitted", "第二天照常");
});

test("喝水/久坐：本期没有步数/运动来源（Health Connect 属 §10 后续）→ 缺依据就静默", () => {
  const TUE_1400 = at(2026, 10, 24, 14);
  const svc = new HealthService({
    submit: () => true,
    medicationTasks: () => [],
    nowFn: () => TUE_1400,
    log: () => {},
    identityTexts: () => ["职业:后端开发"],
    // 刻意不传 stillnessOf：装配层本期不接这条数据，链子必须自己沉默而不是猜
  });
  svc.setMoveOptIn("u1", true);
  const r = svc.evaluateMove("u1", TUE_1400);
  assert.equal(r.sent, false);
  assert.equal(r.reason, "no_motion_source");

  // 「司机」这类身份阈值是 null：本身就该关
  const driver = makeService({ now: TUE_1400, identity: ["我是出租车司机"], stillness: { value: 200 } });
  driver.svc.captureFromUserText("u1", "提醒我起身活动");
  assert.equal(driver.svc.evaluateMove("u1", TUE_1400).reason, "identity_off");
});

// ─── ④ 档位与频控：三类提案的层级 + quiet 档一句不说 ───

test("档位：到点是 must，补问 / 周报 / 起身都是 social；「只在有事时」一档全闭", () => {
  const tasks = [medTask({ taskId: "m1", at: at(2026, 10, 29, 8, 30) })];
  const normal = makeService({ now: SUN_2000, tasks, slots: true, rhythm: { value: rhythmFixture({ days: 6 }) }, stillness: { value: 95 } });
  normal.svc.captureFromUserText("u1", "提醒我喝水");
  normal.svc.evaluateEveningSlot("u1", normal.clock.now);
  normal.svc.evaluateMove("u1", at(2026, 10, 26, 14));
  const kinds = new Set(normal.proposals.map((p) => p.kind));
  assert.ok(kinds.has(HEALTH_KIND.medicationMiss), "该有晚间补问");
  assert.ok(kinds.has(HEALTH_KIND.rhythmReport), "该有周报");
  assert.ok(kinds.has(HEALTH_KIND.move), "该有起身一句");
  assert.ok(kinds.has(HEALTH_KIND.medication), "该有到点打卡");
  for (const p of normal.proposals) {
    if (p.kind === HEALTH_KIND.medication) assert.equal(p.tier, "must", `${p.kind} 是用户点名事项`);
    else assert.equal(p.tier, "social", `${p.kind} 是系统主动开口，必须计社交预算`);
  }

  const quiet = makeService({ now: SUN_2000, tasks, slots: true, rhythm: { value: rhythmFixture({ days: 6 }) }, stillness: { value: 95 }, tier: "quiet" });
  quiet.svc.captureFromUserText("u1", "提醒我喝水");
  const res = quiet.svc.evaluateEveningSlot("u1", quiet.clock.now);
  quiet.svc.evaluateMove("u1", at(2026, 10, 26, 14));
  assert.equal(quiet.proposals.length, 0, "「只在有事时」这一档：健康三类一句都不说");
  assert.ok(res.reason.includes("quiet_tier"));
  assert.equal(quiet.svc.snapshot("u1", MON_0700 + DAY).move.optIn, true, "不开口不等于没记住用户的开关");
});

// ─── 隐私与边界 ───

test("锁屏不泄露药名（§3.5 同一判私口径），漏服只说「没记上」不吓唬人", () => {
  assert.equal(isPrivateMedication("降压药"), true);
  assert.equal(isPrivateMedication("维生素D"), true, "凡是药名一律按 private 遮，宁可多判");
  const tasks = [medTask({ taskId: "m1", at: at(2026, 10, 25, 8, 30), shortTitle: "降压药" })];
  const { svc, proposals, clock } = makeService({ tasks, slots: true });
  svc.planDoses("u1", clock.now);
  const p = proposals[0]!;
  assert.equal(p.scope, "private");
  assert.match(p.summary, /降压药/, "App 里的 summary 看得见是哪一种药");
  assert.doesNotMatch(p.directText!, /降压药/, "通知正文 / 推送 body 不进药名");
  assert.match(p.directText!, /小管/);
  assert.match(p.directText!, /该吃药啦/);
  assert.equal(p.title, "吃药", "title 也会上锁屏，一样不能带药名");
  assert.equal(p.subject, "用药", "话题归因上也不落药名");

  clock.now = WED_2000;
  const miss = svc.evaluateEveningSlot("u1", clock.now).missCheck!;
  assert.ok(miss);
  assert.doesNotMatch(miss.directText!, /降压药/);
  assert.match(miss.summary, /降压药/);
  assert.match(miss.summary, /还没记上/, "漏服只是「账没落上」，不是「你有危险」");
  assert.doesNotMatch(miss.summary, /副作用|剂量|就医|诊断|过量|危险/);
});

test("识别：单次 / cron / 非提醒都不算用药事项；标记与关键词任一命中即可", () => {
  const base = medTask({ taskId: "t", at: at(2026, 10, 23, 8, 30) });
  assert.equal(isMedicationTask(base), true);
  assert.equal(healthPresetOf(base.description), "medication");
  assert.equal(
    markHealthTask(markHealthTask("吃维生素 D", "medication"), "medication").split("]").length,
    2,
    "打标记幂等，不叠第二层前缀",
  );
  assert.equal(isMedicationTask({ ...base, recurrence: "none" }), false, "单次提醒由既有闹钟负责，这里不重复提");
  assert.equal(isMedicationTask({ ...base, cronExpression: "30 8 * * *" }), false, "cron 的时刻展开不在这里，宁可不排也不猜");
  assert.equal(isMedicationTask({ ...base, kind: "action" }), false);
  assert.equal(isMedicationTask({ ...base, status: "paused" }), false);
  assert.equal(
    isMedicationTask({ ...base, description: "[节律提醒:drink] 喝水", title: "喝水", shortTitle: "喝水" }),
    false,
    "节律 trivia 标记不算健康事项（那条路会被缓慢重排）",
  );
  assert.equal(
    isMedicationTask({ ...base, description: "", title: "每天吃维生素 D", shortTitle: "" }),
    true,
    "旧数据没打标记时按关键词兜底",
  );
});

test("对话自述：「吃过了」入账，判不准就不接话；开关可关回去", () => {
  const tasks = [medTask({ taskId: "m1", at: at(2026, 10, 23, 8, 30) })];
  const { svc, clock } = makeService({ tasks });
  svc.planDoses("u1", clock.now);

  assert.equal(svc.captureFromUserText("u1", "帮我看看明天天气"), null, "与用药无关的一句话不该被吞掉");
  // 「没吃」是承认漏服，不是吃过：账不置 taken，但今晚那句补问不用再问一遍
  const nope = svc.captureFromUserText("u1", "没吃");
  assert.equal(nope?.kind, "dose");
  assert.equal(svc.snapshot("u1", clock.now).today[0]!.state, "pending");
  assert.equal(svc.snapshot("u1", clock.now).missCheckDate, localOf(clock.now));

  const ack = svc.captureFromUserText("u1", "吃过了");
  assert.equal(ack?.kind, "dose");
  assert.equal(svc.snapshot("u1", clock.now).today[0]!.state, "taken");
  // 已经吃过的不再重复记账
  assert.equal(svc.captureFromUserText("u1", "吃了")?.message, "好，记上了。");

  svc.setMoveOptIn("u1", true);
  assert.equal(svc.captureFromUserText("u1", "别再提醒我喝水了")?.kind, "opt_out");
  assert.equal(svc.isMoveOptedIn("u1"), false);

  // 「已吃」带 ref 时精确到那颗药：一天两种只回一种，另一种仍然挂着等晚间补问
  const two = [
    medTask({ taskId: "m1", at: at(2026, 10, 25, 8, 30), shortTitle: "维生素D" }),
    medTask({ taskId: "m2", at: at(2026, 10, 25, 12, 30), shortTitle: "鱼油" }),
  ];
  const t2 = makeService({ now: WED_2000, tasks: two, slots: true });
  t2.svc.planDoses("u1", WED_2000);
  assert.equal(t2.svc.observeOutcome({ actorId: "u1", kind: HEALTH_KIND.medication, outcome: "accepted", ref: "m2", at: WED_2000 }).settled, 1);
  const snap = t2.svc.snapshot("u1", WED_2000);
  assert.deepEqual(snap.today.map((d) => d.state), ["pending", "taken"]);
  const miss = t2.svc.evaluateEveningSlot("u1", WED_2000).missCheck!;
  assert.match(miss.summary, /维生素D/, "漏服那句只提还没落账的那颗");
  assert.doesNotMatch(miss.title!, /钙片/);
});

// ─── 真管道 + 真触点计划 + 真 hook 总线：不自己找钟，回执把账记上 ───

test("经既有管道：不早跑、social 那句随明日预览 slot 说；recordOutcome 回灌成「已吃」", () => {
  const dir = tmp("-health-pipeline");
  // 真实墙上日期 = 本用例的「今天」：管道里 recordOutcome 用的是 Date.now()，
  // 台账按本地日期键记账，两者必须同一天才测得出「回执 → 今天的账」
  const TODAY = at(2026, 10, 24, 7); // 周二 07:00
  const now = { value: TODAY };
  const bus = new HookBus();
  setHookBus(bus);

  const planner = new TouchpointPlanner({
    timing: {
      postWakeMinutes: (_a, o) => Math.min(11 * 60, Math.max(6 * 60, 7 * 60 + 20 + (o?.offsetMinutes ?? 30))),
      bedtimeHour: () => 23,
    },
    previewMinutesOf: () => 21 * 60,
    commuteMinutesOf: () => ({ leaveHome: 8 * 60 + 20, leaveWork: 18 * 60 + 10 }),
    middayMinutesOf: () => 12 * 60 + 30,
    rhythmConfidence: () => 0.8,
    frequencyTierOf: () => "normal",
    nowFn: () => now.value,
  });
  const presence = new PresenceService();
  const delivered: Array<{ actorId: string; json: string }> = [];
  const pipeline = new ProactivePipeline({
    dataPath: dir,
    governor: new FrequencyGovernor({ ignoreEnv: true, dailyBudget: 20, nowFn: () => new Date(now.value) }),
    suppression: { isSuppressed: () => ({ suppressed: false, reason: "" }) },
    presence,
    planner,
    delivery: new ProactiveDeliveryService({
      trySend: (actorId, json) => {
        delivered.push({ actorId, json });
        return true;
      },
    }),
    outcomes: new OutcomeStore(join(dir, "outcomes.json")),
    speak: () => {},
    nowFn: () => now.value,
  });
  presence.markConnected("u1", now.value - MIN);

  const tasks = [
    medTask({ taskId: "m1", at: at(2026, 10, 24, 8, 30), shortTitle: "鱼油" }),
    medTask({ taskId: "m2", at: at(2026, 10, 24, 12, 30), shortTitle: "益生菌" }),
  ];
  const health = new HealthService({
    // 唯一开口通道：既有管道（§1.3 禁止旁路直投）
    submit: (p) => pipeline.submitProposal(p),
    governor: new FrequencyGovernor({ ignoreEnv: true, tierOf: () => "normal", nowFn: () => new Date(now.value) }),
    medicationTasks: () => tasks,
    slotTimes: (actorId, atMs) => planner.planOf(actorId, atMs).slots.map((s) => ({ kind: s.kind, windowStart: s.windowStart })),
    path: join(dir, "health.json"),
    nowFn: () => now.value,
    log: () => {},
  });
  const off = health.attachOutcomeHook(bus);

  try {
    // 早晨 7 点把今天两颗排上（开口时刻分别在 8:45 / 12:45）
    assert.equal(health.planDoses("u1", now.value).created, 2);
    pipeline.flushDue(now.value);
    assert.equal(delivered.length, 0, "没到点就不该跑：本模块没有自己的钟，到点靠管道 flush");

    now.value = at(2026, 10, 24, 8, 50);
    pipeline.flushDue(now.value);
    assert.equal(delivered.length, 1, `到点后由既有 flush 说一次，实得 ${delivered.length}`);
    assert.match(delivered[0]!.json, /鱼油/);
    pipeline.flushDue(now.value + MIN);
    assert.equal(delivered.length, 1, "反复 flush 不重复说");

    // 按钮回执：schedule_complete 执行器记的是 accepted + ref，回灌只走 proactive.outcome 这一个口子
    const deliveryId = String(JSON.parse(delivered[0]!.json).payload.deliveryId);
    assert.ok(deliveryId, "投递回执带 deliveryId，闭环表态才对得上");
    assert.equal(pipeline.recordOutcome(deliveryId, "accepted", { ref: "m1" }), true);
    assert.equal(health.snapshot("u1", now.value).today.find((d) => d.taskId === "m1")?.state, "taken", "recordOutcome → proactive.outcome → 健康台账");
    assert.equal(
      health.snapshot("u1", now.value).today.find((d) => d.taskId === "m2")?.state,
      "pending",
      "ref 精确到那颗药：益生菌没回话，不能跟着一起算吃过",
    );

    // 第二颗到点照常说一次
    now.value = at(2026, 10, 24, 12, 50);
    pipeline.flushDue(now.value);
    assert.equal(delivered.length, 2);
    assert.match(delivered[1]!.json, /益生菌/);

    // 晚间漏服那句：20:00 排出来，必须等 21:00 的明日预览 slot 才说
    now.value = at(2026, 10, 24, 20, 0);
    const res = health.evaluateEveningSlot("u1", now.value);
    assert.ok(res.missCheck, "今天那颗没回话，晚间该问一句");
    assert.equal(res.missCheck!.tier, "social");
    assert.equal(res.missCheck!.deliverAfter, previewOf(now.value), "开口时刻来自触点计划，不是本地算的钟");
    assert.equal(res.planned, 2, "明天两颗的打卡也一起排上（时刻在明天，管道攒着）");
    pipeline.flushDue(at(2026, 10, 24, 20, 30));
    assert.equal(delivered.length, 2, "slot 没到，social 那句只能等着——这里没有任何定时器");
    now.value = at(2026, 10, 24, 21, 5);
    pipeline.flushDue(now.value);
    assert.equal(delivered.length, 3, "明日预览到点，随触点说");
    assert.match(delivered[2]!.json, /还没记上/);
    assert.match(delivered[2]!.json, /益生菌/);
    // 一句覆盖两颗里没落账的那颗：已吃的不能再被算进漏服
    assert.doesNotMatch(delivered[2]!.json, /鱼油/);

    // 晚间那句按下「已吃」= acknowledge（不带 ref）→ 当天还没落账的一起收口
    const missDeliveryId = String(JSON.parse(delivered[2]!.json).payload.deliveryId);
    assert.equal(pipeline.recordOutcome(missDeliveryId, "accepted"), true);
    assert.equal(health.snapshot("u1", now.value).today.every((d) => d.state === "taken"), true);

    // 台账落在 persist-file 那个 json 里（§1.3：不新建数据库文件）
    const raw = JSON.parse(readFileSync(join(dir, "health.json"), "utf8"));
    assert.equal(raw.version, 1);
    assert.equal(raw.actors.u1.doses[`m1:${localOf(at(2026, 10, 24, 7))}`].state, "taken");
    assert.equal(raw.actors.u1.missCheckDate, localOf(at(2026, 10, 24, 7)));
    assert.ok(raw.actors.u1.doses[`m1:${localOf(at(2026, 10, 25, 8, 30))}`], "明天的账也提前记好了");
  } finally {
    off();
    rmSync(dir, { recursive: true, force: true });
  }
});
