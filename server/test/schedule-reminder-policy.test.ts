import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  assessScheduleEventFactors,
  buildReminderPolicy,
  describeRemindPlan,
  habitHintsFromSleepSamples,
} from "../src/services/schedule-reminder-policy.js";
import {
  parseScheduleTimeFromPrompt,
  ScheduleIntentService,
} from "../src/services/schedule-intent-service.js";
import { ScheduleTaskService, type ScheduleTaskRecord } from "../src/services/schedule-task-service.js";

/** 2099-01-10 10:00 北京时间（无 DST，墙钟换算稳定） */
const DENTIST_RUN_AT = "2099-01-10T02:00:00.000Z";
const CREATED_DAYS_AHEAD = "2099-01-07T18:00:00.000Z"; // 01-08 02:00 北京时间

async function withTempScheduleFile<T>(fn: (service: ScheduleTaskService) => Promise<T>) {
  const dir = await mkdtemp(join(tmpdir(), "schedule-reminder-policy-"));
  const prev = process.env.SCHEDULE_TASKS_FILE;
  process.env.SCHEDULE_TASKS_FILE = join(dir, "schedule-tasks.json");
  try {
    const service = new ScheduleTaskService();
    return await fn(service);
  } finally {
    if (prev == null) {
      delete process.env.SCHEDULE_TASKS_FILE;
    } else {
      process.env.SCHEDULE_TASKS_FILE = prev;
    }
    await rm(dir, { recursive: true, force: true });
  }
}

function stageLabels(plan: ReturnType<typeof buildReminderPolicy>): string[] {
  return plan?.preReminders.map((p) => p.label) ?? [];
}

test("牙医（high/mid）提前3天创建 → 前晚备忘+起床闹钟+出发预留 三段", () => {
  const plan = buildReminderPolicy({
    runAt: DENTIST_RUN_AT,
    timezone: "Asia/Shanghai",
    description: "周六上午十点去看牙医，带就诊卡",
    reminderMessage: "该去看牙医啦，记得带就诊卡",
    now: new Date(CREATED_DAYS_AHEAD),
  });
  assert.ok(plan);
  assert.equal(plan.policyName, "high/mid");
  // 前晚 21:00 = 13h；闹钟 = 路程60+准备60 = 2h；出发 = 路程60 = 1h
  assert.deepEqual(plan.remindBeforeMinutes, [780, 120, 60]);
  assert.deepEqual(stageLabels(plan), ["睡前备忘", "起床闹钟", "该出门了"]);
  assert.match(plan.preReminders[0]!.message, /【睡前备忘】明天10:00有「该去看牙医啦/);
  assert.match(plan.preReminders[1]!.message, /【起床闹钟】今天10:00/);
  // 2026-10-25 口吻改版：出发段=回指原话的出发指令，估算路程不再写进文案
  assert.match(plan.preReminders[2]!.message, /你说的今天10:00有「.*牙医.*」，现在可以出发了/);
  assert.match(plan.summary, /睡前备忘 → .*起床闹钟 → .*该出门了/);
});

test("截图场景：当天凌晨创建当天上午牙医 → 前晚备忘已过点裁掉，闹钟与出发保留", () => {
  const plan = buildReminderPolicy({
    runAt: DENTIST_RUN_AT,
    timezone: "Asia/Shanghai",
    description: "上午十点去看牙医",
    now: new Date("2099-01-09T17:37:00.000Z"), // 01-10 01:37 北京时间
  });  assert.ok(plan);
  assert.deepEqual(stageLabels(plan), ["起床闹钟", "该出门了"]);
  assert.deepEqual(plan.remindBeforeMinutes, [120, 60]);
});

test("无任何信号的普通提醒 → 仅出发段 15 分钟保底（历史模型默认观感不变）", () => {
  const plan = buildReminderPolicy({
    runAt: DENTIST_RUN_AT,
    timezone: "Asia/Shanghai",
    description: "提醒我交作业",
    now: new Date(CREATED_DAYS_AHEAD),
  });
  assert.ok(plan);
  assert.equal(plan.policyName, "normal/unknown");
  assert.deepEqual(plan.remindBeforeMinutes, [15]);
  assert.equal(plan.preReminders[0]!.message, "【提前15分钟】提醒我交作业");
});

test("线上会议 → 提前10分钟候场，不叫起床（普通重要度）", () => {
  const plan = buildReminderPolicy({
    runAt: DENTIST_RUN_AT,
    timezone: "Asia/Shanghai",
    description: "上午十点和产品经理开线上会议",
    now: new Date(CREATED_DAYS_AHEAD),
  });
  assert.ok(plan);
  assert.equal(plan.policyName, "normal/online");
  assert.deepEqual(stageLabels(plan), ["提前上线"]);
  assert.match(plan.preReminders[0]!.message, /【提前上线】.*10分钟.*候场/);
});

test("下午的牙医 → 有前晚备忘和出发，无起床闹钟", () => {
  const plan = buildReminderPolicy({
    runAt: "2099-01-10T07:00:00.000Z", // 01-10 15:00 北京时间
    timezone: "Asia/Shanghai",
    description: "下午三点去口腔医院复诊",
    now: new Date(CREATED_DAYS_AHEAD),
  });
  assert.ok(plan);
  assert.deepEqual(stageLabels(plan), ["睡前备忘", "该出门了"]);
  // 前晚 21:00 → 次日 15:00 = 18h
  assert.deepEqual(plan.remindBeforeMinutes, [1080, 60]);
});

test("清晨 6 点的航班：行程预算优先于起床下限（不得只提前30分钟叫人赶飞机）", () => {
  const plan = buildReminderPolicy({
    runAt: "2099-03-05T22:00:00.000Z", // 03-06 06:00 北京时间
    timezone: "Asia/Shanghai",
    description: "早上六点的航班去机场",
    now: new Date("2099-03-01T00:00:00.000Z"),
  });
  assert.ok(plan);
  assert.equal(plan.factors.venue, "far");
  // 闹钟 = 06:00 - (150路程+60准备)min = 02:50；06:00 下限不得压掉行程预算
  const wake = plan.preReminders.find((p) => p.stage === "wake_alarm");
  assert.ok(wake);
  assert.equal(wake.offsetMinutes, 210);
  assert.equal(plan.factors.travelMinutes, 150);
});

test("临开始 10 分钟才建牙医日程 → 所有段已过点，不生成计划（主触发兜底）", () => {
  const plan = buildReminderPolicy({
    runAt: DENTIST_RUN_AT,
    timezone: "Asia/Shanghai",
    description: "去看牙医",
    now: new Date("2099-01-10T01:50:00.000Z"), // 09:50 北京时间
  });
  assert.equal(plan, null);
});

test("十几天后的手术：三段齐全（偏移是相对事件锚点的量，事件再远偏移也不超上限）", () => {
  const plan = buildReminderPolicy({
    runAt: "2099-01-20T01:00:00.000Z", // 01-20 09:00 北京时间
    timezone: "Asia/Shanghai",
    description: "去医院做术前检查",
    now: new Date(CREATED_DAYS_AHEAD),
  });
  assert.ok(plan);
  assert.deepEqual(stageLabels(plan), ["睡前备忘", "起床闹钟", "该出门了"]);
});

test("因子评估：预订/票务来源按 high，地点词优先级 线上>长途>市内>近处", () => {
  assert.equal(assessScheduleEventFactors({ description: "普通安排", source: "booking" }).importance, "high");
  assert.equal(assessScheduleEventFactors({ description: "普通安排", source: "email" }).importance, "high");
  assert.equal(assessScheduleEventFactors({ description: "普通安排" }).importance, "normal");
  assert.equal(assessScheduleEventFactors({ description: "视频会议" }).venue, "online");
  assert.equal(assessScheduleEventFactors({ description: "到首都机场乘机" }).venue, "far");
  assert.equal(assessScheduleEventFactors({ description: "去银行办事" }).venue, "mid");
  assert.equal(assessScheduleEventFactors({ description: "在公司开会" }).venue, "near");
  assert.equal(assessScheduleEventFactors({ description: "和同学吃饭" }).venue, "unknown");
  // 地点字段与正文任一命中即可
  assert.equal(assessScheduleEventFactors({ description: "办手续", location: "协和医院" }).venue, "mid");
});

test("createTask：牙医提醒自动生成三段计划；显式提前量/trivia/周期不走策略", async () => {
  await withTempScheduleFile(async (service) => {
    const base = {
      sessionId: "policy-session",
      kind: "reminder" as const,
      recurrence: "none" as const,
      timezone: "Asia/Shanghai",
    };
    const task = await service.createTask({
      ...base,
      description: "周六上午十点去看牙医",
      reminderMessage: "该去看牙医啦",
      runAt: DENTIST_RUN_AT,
    });
    assert.equal(task.reminderPolicy, "high/mid");
    assert.deepEqual(task.remindBeforeMinutes, [780, 120, 60]);
    assert.equal(task.preReminders?.length, 3);
    const described = describeRemindPlan(task);
    assert.ok(described);
    assert.match(described.summary, /睡前备忘/);
    assert.equal(described.stages.length, 3);

    // 显式提前量优先，不生成计划
    const explicit = await service.createTask({
      ...base,
      description: "周六上午十点去看牙医，记得提前半小时叫我",
      reminderMessage: "该去看牙医啦",
      runAt: "2099-02-01T02:00:00.000Z",
      remindBeforeMinutes: [30],
    });
    assert.deepEqual(explicit.remindBeforeMinutes, [30]);
    assert.equal(explicit.preReminders, undefined);
    assert.equal(explicit.reminderPolicy, undefined);

    // trivia（喝水/睡觉类琐事）不做分级
    const trivia = await service.createTask({
      ...base,
      category: "trivia",
      description: "提醒我睡觉",
      reminderMessage: "该睡觉啦",
      runAt: "2099-02-01T14:00:00.000Z",
    });
    assert.equal(trivia.remindBeforeMinutes, undefined);
    assert.equal(trivia.preReminders, undefined);

    // 周期任务不做分级
    const daily = await service.createTask({
      ...base,
      recurrence: "daily" as const,
      description: "提醒我吃药",
      reminderMessage: "该吃药啦",
      runAt: DENTIST_RUN_AT,
    });
    assert.equal(daily.preReminders, undefined);

    // ics 日历事件：事件本身无提醒数据，纳入分级策略补位
    // （客户端关键词 Timer 已按「提醒统一信服务端」定调删除）
    const ics = await service.createTask({
      ...base,
      category: "itinerary" as const,
      description: "日历订阅「工作」自动导入",
      reminderMessage: "团队周会",
      runAt: DENTIST_RUN_AT,
      source: "ics" as const,
      sourceRefId: "ics-evt-1",
    });
    assert.ok(ics.preReminders?.length);
    assert.ok(ics.remindBeforeMinutes?.length);
    assert.ok(ics.reminderPolicy);
  });
});

test("firePreReminders：到期的策略段按各自脚本文案推送（一次 tick 全部到期不漏）", async () => {
  await withTempScheduleFile(async (service) => {
    const delivered: string[] = [];
    service.setReminderHandler(async (_task, message) => {
      delivered.push(message);
    });
    const task = await service.createTask({
      sessionId: "fire-session",
      kind: "reminder",
      recurrence: "none",
      timezone: "Asia/Shanghai",
      description: "周六上午十点去看牙医",
      reminderMessage: "该去看牙医啦",
      runAt: DENTIST_RUN_AT,
    });
    // 把 nextRunAt 回拨到只剩 50 分钟：三段（780/120/60）触发窗全部命中 now
    const store = (service as unknown as { byTaskId: Map<string, ScheduleTaskRecord> }).byTaskId;
    const stored = store.get(task.taskId);
    assert.ok(stored);
    stored.nextRunAt = new Date(Date.now() + 50 * 60_000).toISOString();

    await service.runSchedulerTick();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(delivered.length, 3);
    assert.match(delivered[0]!, /【睡前备忘】明天10:00/);
    assert.match(delivered[1]!, /【起床闹钟】今天10:00/);
    assert.match(delivered[2]!, /你说的今天10:00有「.*」/);
    // 触发记录落库，不重复推送
    const after = store.get(task.taskId);
    assert.deepEqual((after?.firedPreReminderOffsets ?? []).sort((a, b) => b - a), [780, 120, 60]);
    await service.runSchedulerTick();
    assert.equal(delivered.length, 3);
  });
});

test("updateTask：改期重算分段计划；显式给提前量即接管并清掉策略", async () => {
  await withTempScheduleFile(async (service) => {
    const task = await service.createTask({
      sessionId: "update-session",
      kind: "reminder",
      recurrence: "none",
      timezone: "Asia/Shanghai",
      description: "周六上午十点去看牙医",
      reminderMessage: "该去看牙医啦",
      runAt: DENTIST_RUN_AT,
    });
    assert.equal(task.preReminders?.length, 3);

    // 改期到下午 → 起床闹钟段应消失，偏移重算
    const moved = await service.updateTask(task.taskId, {
      runAt: "2099-01-10T07:00:00.000Z", // 15:00 北京时间
    });
    assert.deepEqual(stageLabelsOf(moved), ["睡前备忘", "该出门了"]);
    assert.deepEqual(moved.remindBeforeMinutes, [1080, 60]);

    // 用户显式接管提前量 → 清空策略
    const takenOver = await service.updateTask(task.taskId, { remindBeforeMinutes: [5] });
    assert.deepEqual(takenOver.remindBeforeMinutes, [5]);
    assert.equal(takenOver.preReminders, undefined);
    assert.equal(takenOver.reminderPolicy, undefined);
  });
});

function stageLabelsOf(task: ScheduleTaskRecord): string[] {
  return task.preReminders?.map((p) => p.label) ?? [];
}

test("解析器回归：显式提前量 30/90 分钟可解析；「提前X分钟」不再被误读成「X分钟后」", async () => {  const svc = new ScheduleIntentService(null);
  const r = await svc.parseForCreate("p", "明天上午十点提前30分钟提醒我去看牙医");
  assert.ok(r.matched, "应命中创建草案");
  assert.equal(r.draft.remindBeforeMinutes?.[0], 30);
  // 事件锚点必须是明天 10:00（本地），而不是「30分钟后」
  const now = new Date();
  const expected = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 10, 0, 0);
  assert.equal(r.draft.runAt, expected.toISOString());

  const r90 = await svc.parseForCreate("p", "明天上午十点提前90分钟提醒我去看牙医");
  assert.ok(r90.matched);
  assert.equal(r90.draft.remindBeforeMinutes?.[0], 90);

  // 只说提前量、没有事件锚点 → 不再编造「半小时后」的事件时间
  assert.equal(parseScheduleTimeFromPrompt("提前30分钟提醒我开会"), null);
});

test("作息画像-夜猫子（1:30睡/9:30起）：睡前备忘贴入睡点前1小时，并如实告知睡眠预算", () => {
  const plan = buildReminderPolicy({
    runAt: DENTIST_RUN_AT, // 10:00
    timezone: "Asia/Shanghai",
    description: "上午十点去看牙医",
    habits: { sleepStartHour: 1.5, wakeHour: 9.5, sampleCount: 6 },
    now: new Date(CREATED_DAYS_AHEAD),
  });
  assert.ok(plan);
  // 睡前备忘 = 事件当天 00:30（入睡 1:30 前 1 小时）→ 距 10:00 = 9.5h = 570min
  const night = plan.preReminders.find((p) => p.stage === "night_before");
  assert.ok(night);
  assert.equal(night.offsetMinutes, 570);
  // 睡眠预算 = 入睡 1:30 → 闹钟 8:00 = 6.5h < 7 → 如实劝早睡
  assert.match(night.message, /按你平时约1:30入睡，到闹钟只睡得约6个半小时，今晚尽量早点睡/);
  // 闹钟下限 = max(6, 9.5-1.5) = 8:00，闹钟本来就在 8:00 → 不变
  const wake = plan.preReminders.find((p) => p.stage === "wake_alarm");
  assert.equal(wake?.offsetMinutes, 120);
});

test("作息画像-夜猫子赶早场：预算不足7小时 → 睡前备忘明确劝早睡", () => {
  const plan = buildReminderPolicy({
    runAt: "2099-01-09T23:00:00.000Z", // 01-10 07:00
    timezone: "Asia/Shanghai",
    description: "早上七点去口腔医院复查",
    habits: { sleepStartHour: 1.5, wakeHour: 9.5, sampleCount: 5 },
    now: new Date(CREATED_DAYS_AHEAD),
  });
  assert.ok(plan);
  const night = plan.preReminders.find((p) => p.stage === "night_before");
  assert.ok(night);
  // 闹钟 = 07:00-(60+60)min = 05:00；睡眠预算 1:30→05:00 = 3.5h < 7
  assert.match(night.message, /按你平时约1:30入睡，到闹钟只睡得约3个半小时，今晚尽量早点睡/);
  // 闹钟下限 8:00 吃不进行程预算（05:00 已是预算点）→ 行程保证优先，闹钟 05:00
  const wake = plan.preReminders.find((p) => p.stage === "wake_alarm");
  assert.equal(wake?.offsetMinutes, 120);
});

test("作息画像-早鸟（22:30睡/6:30起）：睡前备忘 21:30，闹钟照常不越界", () => {
  const plan = buildReminderPolicy({
    runAt: DENTIST_RUN_AT,
    timezone: "Asia/Shanghai",
    description: "上午十点去看牙医",
    habits: { sleepStartHour: 22.5, wakeHour: 6.5, sampleCount: 4 },
    now: new Date(CREATED_DAYS_AHEAD),
  });
  assert.ok(plan);
  const night = plan.preReminders.find((p) => p.stage === "night_before");
  assert.ok(night);
  // 睡前备忘 = 前晚 21:30（入睡 22:30 前 1 小时）→ 距次日 10:00 = 12.5h = 750min
  assert.equal(night.offsetMinutes, 750);
  // 预算充足且闹钟晚于平时起床 → 默认收尾话术
  assert.match(night.message, /今晚先记着，明早会叫你起床。/);
});

test("作息样本不足（<3条）→ 与无画像完全一致（宁缺勿错）", () => {
  const base = {
    runAt: DENTIST_RUN_AT,
    timezone: "Asia/Shanghai",
    description: "上午十点去看牙医",
    now: new Date(CREATED_DAYS_AHEAD),
  };
  const withSparse = buildReminderPolicy({ ...base, habits: { sleepStartHour: 1.5, wakeHour: 9.5, sampleCount: 2 } });
  const without = buildReminderPolicy(base);
  assert.deepEqual(withSparse?.remindBeforeMinutes, without?.remindBeforeMinutes);
  assert.deepEqual(withSparse?.preReminders, without?.preReminders);
  assert.equal(withSparse?.policyName, without?.policyName);
});

test("habitHintsFromSleepSamples：跨午夜样本取中位，样本不足返回 null", () => {
  const hints = habitHintsFromSleepSamples([
    { startHour: 1.2, endHour: 9.4 },
    { startHour: 1.8, endHour: 9.8 },
    { startHour: 1.5, endHour: 9.5 },
    { startHour: 2.0, endHour: 10.0 },
  ]);
  assert.ok(hints);
  assert.equal(hints.sampleCount, 4);
  assert.equal(hints.sleepStartHour, 1.65);
  assert.equal(hints.wakeHour, 9.65);
  assert.equal(habitHintsFromSleepSamples([{ startHour: 1, endHour: 9 }, { startHour: 2, endHour: 9 }]), null);
});

// ── 真实路程因子（travelMinutesOverride，2026-10-05）──

test("travelMinutesOverride 有效值替代 venue 静态表，policyName 带 route 来源", () => {
  const plan = buildReminderPolicy({
    runAt: DENTIST_RUN_AT,
    timezone: "Asia/Shanghai",
    description: "周六上午十点去看牙医，带就诊卡",
    location: "协和医院",
    travelMinutesOverride: 90,
    routeSource: "amap",
    now: new Date(CREATED_DAYS_AHEAD),
  });
  assert.ok(plan);
  assert.equal(plan.policyName, "high/mid/route:amap");
  // 闹钟 = 真实路程90+准备60 = 150；出发 = 真实路程 90（静态表 mid/high=60 被替代）
  assert.deepEqual(plan.remindBeforeMinutes, [780, 150, 90]);
  const depart = plan.preReminders.find((p) => p.stage === "depart");
  assert.ok(depart);
  // 路程改由偏移量表达（上面 remindBeforeMinutes 已断言 90），文案只留出发指令
  assert.match(depart.message, /现在可以出发了/);
});

test("travelMinutesOverride 无效（0/负数/超 8h 上限）→ 回退 venue 静态表", () => {
  const base = {
    runAt: DENTIST_RUN_AT,
    timezone: "Asia/Shanghai",
    description: "周六上午十点去看牙医，带就诊卡",
    now: new Date(CREATED_DAYS_AHEAD),
  };
  const without = buildReminderPolicy(base);
  for (const override of [0, -5, 601, Number.NaN]) {
    const plan = buildReminderPolicy({ ...base, travelMinutesOverride: override });
    assert.deepEqual(plan?.remindBeforeMinutes, without?.remindBeforeMinutes);
    assert.equal(plan?.policyName, without?.policyName);
  }
});

test("createTask 注入路程估算器 → 策略按真实路程生成出发段", async () => {
  await withTempScheduleFile(async (service) => {
    service.setRouteEstimator(async () => ({ durationMin: 70, distanceKm: 42.5, source: "amap" }));
    const task = await service.createTask({
      sessionId: "route-session",
      kind: "reminder",
      recurrence: "none",
      timezone: "Asia/Shanghai",
      description: "周六上午十点去看牙医",
      reminderMessage: "该去看牙医啦",
      location: "协和医院",
      runAt: DENTIST_RUN_AT,
    });
    // 闹钟 = 70+60 = 130；出发 = 70（静态表 mid/high=60 被真实路程替代）
    assert.deepEqual(task.remindBeforeMinutes, [780, 130, 70]);
    assert.equal(task.reminderPolicy, "high/mid/route:amap");
  });
});

test("出发段触达实时富化：文案带当前车程（准点触发不升档）", async () => {
  await withTempScheduleFile(async (service) => {
    const delivered: Array<{ message: string; pre: boolean }> = [];
    service.setReminderHandler(async (_task, message, options) => {
      delivered.push({ message, pre: options?.preReminder === true });
    });
    service.setRouteEstimator(async () => ({ durationMin: 70, distanceKm: 42.5, source: "amap" }));
    const task = await service.createTask({
      sessionId: "depart-enrich",
      kind: "reminder",
      recurrence: "none",
      timezone: "Asia/Shanghai",
      description: "周六上午十点去看牙医",
      reminderMessage: "该去看牙医啦",
      location: "协和医院",
      runAt: DENTIST_RUN_AT,
    });
    const store = (service as unknown as { byTaskId: Map<string, ScheduleTaskRecord> }).byTaskId;
    const stored = store.get(task.taskId);
    assert.ok(stored);
    // 回拨到只剩 69 分钟：出发段（70）到期且实时路程 70 ≤ 69+5 容忍带 → 正常富化
    stored.nextRunAt = new Date(Date.now() + 69 * 60_000).toISOString();
    await service.runSchedulerTick();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const depart = delivered.find((d) => /现在可以出发了/.test(d.message));
    assert.ok(depart);
    assert.equal(depart.pre, true);
    assert.match(depart.message, /当前车程约 70 分钟（含实时路况）/);
  });
});

test("出发段实时恶化：实时路程超过剩余+容忍带 → 升档到点出口（无 preReminder）", async () => {
  await withTempScheduleFile(async (service) => {
    const delivered: Array<{ message: string; pre: boolean }> = [];
    service.setReminderHandler(async (_task, message, options) => {
      delivered.push({ message, pre: options?.preReminder === true });
    });
    // 创建时估 70 分钟；触发时实时恶化到 120 分钟
    let calls = 0;
    service.setRouteEstimator(async () => {
      calls += 1;
      return calls === 1
        ? { durationMin: 70, distanceKm: 42.5, source: "amap" }
        : { durationMin: 120, distanceKm: 60, source: "amap" };
    });
    const task = await service.createTask({
      sessionId: "depart-escalate",
      kind: "reminder",
      recurrence: "none",
      timezone: "Asia/Shanghai",
      description: "周六上午十点去看牙医",
      reminderMessage: "该去看牙医啦",
      location: "协和医院",
      runAt: DENTIST_RUN_AT,
    });
    const store = (service as unknown as { byTaskId: Map<string, ScheduleTaskRecord> }).byTaskId;
    const stored = store.get(task.taskId);
    assert.ok(stored);
    stored.nextRunAt = new Date(Date.now() + 69 * 60_000).toISOString();
    await service.runSchedulerTick();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const escalate = delivered.find((d) => /现在就出发/.test(d.message));
    assert.ok(escalate);
    assert.equal(escalate.pre, false);
    assert.match(escalate.message, /车程约 120 分钟/);
    assert.match(escalate.message, /只剩 69 分钟/);
  });
});
