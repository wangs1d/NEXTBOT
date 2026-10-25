/**
 * 分级提醒策略层（程序层确定性投影，零 LLM 调用）：
 *
 * 用户诉求（2026-10-04）：不同提醒任务需要不同的提前节奏，且计划是动态的——
 * 由事件时间（早晚/距今多远）、重要程度、地点/路程等因素共同决定，
 * 「早上10点看牙医 → 前一晚预警 + 自动设次日早晨闹钟 + 预留出门时间」只是其中
 * 一种因子组合的产物，不是写死的任务类型查找表。
 *
 * 决策因子（基础版从文本线索推导；后续接地图 API 换算真实路程、接手机/硬件
 * 执行晨起闹钟时，只换因子来源与执行器，不改本层的决策结构）：
 *   - importance：high=就医/考试/面试/乘运出行/证件办理等错过代价高的事项；
 *                 normal=普通安排。来源为预订桥/票务邮件的事项按 high 处理。
 *   - venue：far=机场车站等长途枢纽；mid=市内场所（医院/银行/学校…）；
 *            near=家/公司附近；online=线上；unknown=未识别。
 *   - travelMinutes / prepMinutes：路程与起床准备估时。
 *
 * 产出三段式计划（按因子动态裁剪，哪些段进计划全由因子决定）：
 *   night_before：前晚 21:00 睡前备忘（仅 high——普通安排睡前不值得打扰）。
 *                 有作息画像时改为用户实际入睡点前 1 小时（夜猫子的 21:00 备忘
 *                 说了等于没说），并按「入睡点→闹钟」的睡眠预算决定是否劝早睡。
 *   wake_alarm：  早晨开始（本地 05:00–13:00）且 high 或需要出行时才有起床闹钟，
 *                 = 开始前 路程+准备 分钟；下限默认本地 06:00，有作息画像时改为
 *                 平时起床点前 1.5 小时——且下限只在吃满行程预算仍可行时生效
 *                 （早班机必须比平时早很多时，行程保证优先）。
 *   depart：      出发预留：线上=提前10分钟候场；未识别=15分钟（与历史模型
 *                 默认 [15] 一致，保底不倒退）；识别出地点按路程估时。
 *
 * 边界：已过点的段直接裁掉（凌晨建当天上午的日程，前晚备忘不可能补发）；
 * 偏移是相对事件锚点的量（前晚备忘最大 ~27h，路程段最大 150min），恒在
 * normalizeRemindBeforeMinutes 的 7 天偏移上限内，事件隔多少天不影响各段；
 * 用户显式填了 remindBeforeMinutes 的创建不走本层——显式意愿优先。
 */

import type { ScheduleTaskRecord } from "./schedule-task-service.js";
import { MAX_ROUTE_MINUTES } from "./route-duration-service.js";

export type ReminderStage = "night_before" | "wake_alarm" | "depart";
export type ScheduleEventImportance = "high" | "normal";
export type ScheduleVenueKind = "far" | "mid" | "near" | "online" | "unknown";

/** 随 remindBeforeMinutes 一起落库的分段脚本：同偏移一一段文案，stage 供后续手机/硬件执行器路由。 */
export type SchedulePreReminder = {
  offsetMinutes: number;
  stage: ReminderStage;
  /** 展示用段名（睡前备忘/起床闹钟/该出门了…） */
  label: string;
  /** 该段实际推送的完整文案 */
  message: string;
};

export type ScheduleEventFactors = {
  importance: ScheduleEventImportance;
  venue: ScheduleVenueKind;
  /** 路上耗时估计（分钟）；0=线上/无需出行 */
  travelMinutes: number;
  /** 起床到出门的准备时间（分钟） */
  prepMinutes: number;
};

export type ReminderPolicyPlan = {
  /** 因子组合指纹（如 "high/mid"），落库用于改期重算判定与排查 */
  policyName: string;
  factors: ScheduleEventFactors;
  /** 与 preReminders 对齐的偏移数组（倒序），直接写入 remindBeforeMinutes */
  remindBeforeMinutes: number[];
  preReminders: SchedulePreReminder[];
  /** 一句话摘要（带各段本地时刻），供工具结果转述 */
  summary: string;
};

export type ReminderPolicyInput = {
  runAt: string;
  timezone: string;
  description: string;
  reminderMessage?: string;
  /** 地点线索（用户原话或模型抽取，如「协和医院」「首都机场T3」） */
  location?: string;
  /**
   * 真实路程估时（分钟，来自 route-duration-service：用户当前位置 × 目的地
   * 高德驾车实时路程）。有效值（>0）替代 venue 静态查找表——2026-10-05 起
   * 出发预留按真实路程算，只换因子来源不改决策结构；无值/无效回退静态表。
   */
  travelMinutesOverride?: number;
  /** 路程来源（amap=含实时路况 / osrm=兜底），进 policyName 指纹便于观测 */
  routeSource?: string;
  /** 创建来源：booking/email 按 high 处理；ics/commitment 不进策略层（上游各有提醒分工） */
  source?: string;
  /** 用户作息画像（agent 对用户习惯的了解）：样本足够时个性化睡前/闹钟时刻，不足时回退默认 */
  habits?: ScheduleHabitHints | null;
  /** 用户节奏因子（user-rhythm-store）：出门准备分钟按人给，证据不足回退默认 */
  rhythm?: UserRhythmHints | null;
  now?: Date;
};

/**
 * 习惯来源：
 *   - observed：被动观察（在场足迹——agent 观察用户何时在线，推导入睡/起床，
 *     ≥PRESENCE_MIN_NIGHTS 个有效夜才可信）。这是默认的主来源：用户做什么是
 *     最硬的证据，不依赖用户开口，也不依赖苛刻的睡眠状态判定；
 *   - samples：被动观测（睡眠样本链，需 AwarenessCortex 判出 sleeping，实测
 *     极难触发，作为 observed 的补充）；
 *   - explicit：用户在设置里主动设定的作息（权威，1 条即可信，覆盖观测）；
 *   - chat：用户在对话里自述的作息（确定性抽取，1 条即可信；排在观测之后——
 *     行为比自述更接近真实）。
 */
export type ScheduleHabitSource = "samples" | "explicit" | "chat" | "observed";

/**
 * 用户节奏因子（user-rhythm-store，2026-10-23 个性化闭环）：做事节奏按人给。
 * departurePrepMin=null 表示证据不足，策略层回退默认（high=60/normal=40）。
 */
export type UserRhythmHints = {
  departurePrepMin: number | null;
  source?: "explicit" | "observed";
};

/**
 * 用户作息提示（来自睡眠样本链：AwarenessCortex 桌面无活动判定 → 按日样本 →
 * 中位数窗口）。十进制本地小时：入睡 1.5 = 凌晨 01:30（跨午夜由样本侧归一）。
 * sampleCount 达到 HABIT_MIN_SAMPLES 才可信——宁缺勿错，不足时策略层用默认值。
 * source 缺省视为 samples；explicit/chat 由用户自述，不受样本数门槛限制。
 */
export type ScheduleHabitHints = {
  sleepStartHour: number | null;
  wakeHour: number | null;
  sampleCount: number;
  source?: ScheduleHabitSource;
};

export const HABIT_MIN_SAMPLES = 3;
/** 睡前备忘 = 平时入睡点前 1 小时 */
const HABIT_NIGHT_BEFORE_LEAD_HOURS = 1;
/** 睡前备忘最晚不越过入睡点前 15 分钟 */
const HABIT_NIGHT_BEFORE_MIN_LEAD_HOURS = 0.25;
/** 个性化睡前备忘的下限（再晚就不算「睡前」而是「半夜突击」了的不合理面，见 clamp 逻辑） */
const HABIT_NIGHT_FLOOR_HOUR = 19.5;
/** 起床闹钟下限 = 平时起床点前 1.5 小时（再早的叫醒只在该事件确实需要时出现） */
const HABIT_WAKE_FLOOR_LEAD_HOURS = 1.5;
/** 睡眠预算低于该小时数时，睡前备忘改为「今晚尽量早点睡」的明确提示 */
const HABIT_TIGHT_SLEEP_HOURS = 7;

/**
 * 从逐日睡眠样本推导作息提示（与 SleepDimensionModel 同一算法口径：
 * 跨午夜修正后取中位数）。样本不足返回 null（策略层回退默认值）。
 */
export function habitHintsFromSleepSamples(
  samples: Array<{ startHour: number; endHour: number }>,
): ScheduleHabitHints | null {
  const valid = samples.filter(
    (s) => Number.isFinite(s?.startHour) && Number.isFinite(s?.endHour),
  );
  if (valid.length < HABIT_MIN_SAMPLES) return null;
  const startHours = valid.map((s) => s.startHour);
  const endHours = valid.map((s) => s.endHour);
  const crossesMidnight = startHours.some((h) => h >= 18) && startHours.some((h) => h < 12);
  const adj = (h: number): number => (crossesMidnight && h < 12 ? h + 24 : h);
  return {
    sleepStartHour: median(startHours.map(adj)) % 24,
    wakeHour: median(endHours) % 24,
    sampleCount: valid.length,
  };
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

const NIGHT_BEFORE_LOCAL_HOUR = 21;
const WAKE_ALARM_EARLIEST_LOCAL_HOUR = 6;
/** 起床闹钟至少领先开始 30 分钟，否则没有「预留准备」的意义 */
const WAKE_ALARM_MIN_LEAD_MINUTES = 30;
const DEPART_ONLINE_LEAD_MINUTES = 10;
/** 与 normalizeRemindBeforeMinutes 的 7 天偏移上限一致 */
const MAX_OFFSET_MINUTES = 7 * 24 * 60;
/** 起床闹钟事件开始时段（本地）：05:00–13:00 之间开始才算「早晨的事件」 */
const WAKE_ALARM_START_HOUR_RANGE: [number, number] = [5, 13];

/** 高代价错过事项：就医/考试面试/乘运出行/证件办理/婚礼开庭等 */
const HIGH_IMPORTANCE_PATTERN =
  /牙医|拔牙|洗牙|补牙|种植|口腔|看病|看医生|医院|门诊|就诊|挂号|复诊|问诊|体检|复查|疫苗|打针|手术|面试|笔试|复试|考试|答辩|开庭|听证|签证|护照|办证|航班|飞机|乘机|值机|登机|高铁|火车|动车|机场|婚礼|领证/;
const VENUE_FAR_PATTERN = /机场|高铁站|火车站|汽车站|客运站|码头|港口|值机|登机口|候机|候车/;
const VENUE_MID_PATTERN =
  /医院|诊所|门诊|体检中心|体检机构|银行|政务|办事大厅|学校|校区|考场|考点|体育馆|展览|展馆|会展|剧场|剧院|影院|博物馆|文化馆/;
const VENUE_NEAR_PATTERN = /家里|在家|楼下|小区|附近|隔壁|公司|办公室|工位|本楼/;
const VENUE_ONLINE_PATTERN =
  /线上|远程|视频会议|电话会议|电话沟通|腾讯会议|zoom|teams|会议链接|网课|在线会议|直播/;

/** 路程估时（分钟）：venue × importance。未知地点按普通 15（历史模型默认）/重要 30 保底。 */
const TRAVEL_MINUTES: Record<ScheduleVenueKind, Record<ScheduleEventImportance, number>> = {
  far: { normal: 120, high: 150 },
  mid: { normal: 45, high: 60 },
  near: { normal: 10, high: 15 },
  online: { normal: 0, high: 0 },
  unknown: { normal: 15, high: 30 },
};

export function assessScheduleEventFactors(input: {
  description: string;
  location?: string;
  source?: string;
  travelMinutesOverride?: number;
  rhythm?: UserRhythmHints | null;
}): ScheduleEventFactors {
  const text = `${input.location ?? ""} ${input.description ?? ""}`;
  const importance: ScheduleEventImportance =
    input.source === "booking" || input.source === "email" || HIGH_IMPORTANCE_PATTERN.test(text)
      ? "high"
      : "normal";
  let venue: ScheduleVenueKind = "unknown";
  if (VENUE_ONLINE_PATTERN.test(text)) venue = "online";
  else if (VENUE_FAR_PATTERN.test(text)) venue = "far";
  else if (VENUE_MID_PATTERN.test(text)) venue = "mid";
  else if (VENUE_NEAR_PATTERN.test(text)) venue = "near";
  // 高代价事项（牙医/面试/值机…）几乎都是要出门办的正事：文本没给出地点信号时
  // 按市内场所估算路程，而不是按「未知=楼下随手事」的 15 分钟保底
  if (importance === "high" && venue === "unknown") venue = "mid";
  // 真实路程优先（route-duration-service 估出）：只换因子来源，其余决策不变
  const override = input.travelMinutesOverride;
  const travelMinutes =
    venue === "online"
      ? 0
      : override != null && Number.isFinite(override) && override > 0 && override <= MAX_ROUTE_MINUTES
        ? Math.round(override)
        : TRAVEL_MINUTES[venue][importance];
  // 出门准备分钟：用户节奏档案优先（对症下药），无实测/自述回退按重要度默认
  const rhythmPrep = input.rhythm?.departurePrepMin;
  const prepMinutes =
    rhythmPrep != null && Number.isFinite(rhythmPrep) && rhythmPrep > 0 && rhythmPrep <= 240
      ? Math.round(rhythmPrep)
      : importance === "high"
        ? 60
        : 40;
  return { importance, venue, travelMinutes, prepMinutes };
}

export function buildReminderPolicy(input: ReminderPolicyInput): ReminderPolicyPlan | null {
  const runAtMs = Date.parse(input.runAt);
  if (!Number.isFinite(runAtMs)) return null;
  const tz = input.timezone?.trim() || "Asia/Shanghai";
  const nowMs = (input.now ?? new Date()).getTime();
  const factors = assessScheduleEventFactors(input);
  const subject = clipSubject(input.reminderMessage?.trim() || input.description);
  const eventLocal = localParts(runAtMs, tz);
  const eventHm = `${pad2(eventLocal.hour)}:${pad2(eventLocal.minute)}`;

  type Stage = { offsetMinutes: number; stage: ReminderStage; label: string; message: string };
  const stages: Stage[] = [];
  let wakeAlarmMs: number | null = null;

  // 作息画像：证据达阈值才启用个性化（宁缺勿错），否则全走默认值。
  // 用户自述（explicit/chat）是显式意愿，1 条即启用，不受样本数门槛限制；
  // observed/samples 为被动观察，各自在产出侧已保证 ≥3 个有效夜/样本。
  const habits = input.habits ?? null;
  const habitTrusted =
    !!habits &&
    (habits.source === "explicit" ||
      habits.source === "chat" ||
      habits.source === "observed" ||
      habits.sampleCount >= HABIT_MIN_SAMPLES);
  const habitOn = habitTrusted && habits.sleepStartHour != null;

  // 起床闹钟：早晨开始且（high 或 需要出行）才值得叫醒；先算它，前晚备忘的收尾话术要引用。
  const morningStart =
    eventLocal.hour >= WAKE_ALARM_START_HOUR_RANGE[0] &&
    eventLocal.hour < WAKE_ALARM_START_HOUR_RANGE[1];
  const needsWake = factors.importance === "high" || factors.venue === "far" || factors.venue === "mid";
  let hasWake = false;
  let alarmBedtimeHours: number | null = null; // 有作息画像时：闹钟时刻相对入睡点的睡眠预算（小时）
  if (morningStart && needsWake) {
    const neededLeadMinutes = factors.travelMinutes + factors.prepMinutes;
    let alarmMs = runAtMs - neededLeadMinutes * 60_000;
    alarmMs = Math.min(alarmMs, runAtMs - WAKE_ALARM_MIN_LEAD_MINUTES * 60_000);
    // 下限（默认 06:00；有作息=平时起床点前 1.5h）：只在吃满行程预算仍可行时生效——
    // 早班机这类必须比平时早很多的场合，行程保证优先，不得用下限压掉准备时间。
    const floorHour =
      habitOn && habits.wakeHour != null
        ? Math.max(WAKE_ALARM_EARLIEST_LOCAL_HOUR, habits.wakeHour - HABIT_WAKE_FLOOR_LEAD_HOURS)
        : WAKE_ALARM_EARLIEST_LOCAL_HOUR;
    const floorMs = wallToUtcMs(
      {
        year: eventLocal.year,
        month: eventLocal.month,
        day: eventLocal.day,
        hour: Math.floor(floorHour),
        minute: Math.round((floorHour % 1) * 60),
      },
      tz,
    );
    alarmMs = Math.max(alarmMs, Math.min(floorMs, runAtMs - neededLeadMinutes * 60_000));
    const offset = Math.round((runAtMs - alarmMs) / 60_000);
    if (alarmMs > nowMs && offset >= 5 && offset <= MAX_OFFSET_MINUTES) {
      hasWake = true;
      wakeAlarmMs = alarmMs;
      if (habitOn) {
        // 入睡点在事件当天凌晨（<12 点）= 事件日当天睡的最后一觉；否则是前晚
        const bedtimeMs = wallToUtcMs(
          {
            year: eventLocal.year,
            month: eventLocal.month,
            day: eventLocal.day - (habits.sleepStartHour! < 12 ? 0 : 1),
            hour: Math.floor(habits.sleepStartHour!),
            minute: Math.round((habits.sleepStartHour! % 1) * 60),
          },
          tz,
        );
        if (bedtimeMs < alarmMs) {
          alarmBedtimeHours = (alarmMs - bedtimeMs) / 3_600_000;
        }
      }
      const commute = factors.travelMinutes > 0 ? "洗漱和路上" : "洗漱准备";
      stages.push({
        offsetMinutes: offset,
        stage: "wake_alarm",
        label: "起床闹钟",
        message: `【起床闹钟】今天${eventHm}有「${subject}」，已预留${commute}时间，现在起床刚刚好。`,
      });
    }
  }

  // 前晚睡前备忘：仅 high；事件当天才建的日程 fire 时间已过 → 自然裁掉。
  // 有作息画像时贴着用户实际入睡点前移 1 小时（夜猫子不是 21:00 睡，21:00 的
  // 「睡前备忘」说了等于没说），并按睡眠预算决定要不要劝早睡。
  if (factors.importance === "high") {
    let fireMs: number;
    if (habitOn) {
      const bedtimeMs = wallToUtcMs(
        {
          year: eventLocal.year,
          month: eventLocal.month,
          day: eventLocal.day - (habits.sleepStartHour! < 12 ? 0 : 1),
          hour: Math.floor(habits.sleepStartHour!),
          minute: Math.round((habits.sleepStartHour! % 1) * 60),
        },
        tz,
      );
      fireMs = bedtimeMs - HABIT_NIGHT_BEFORE_LEAD_HOURS * 3_600_000;
      const floorMs = wallToUtcMs(
        {
          year: eventLocal.year,
          month: eventLocal.month,
          day: eventLocal.day - 1,
          hour: Math.floor(HABIT_NIGHT_FLOOR_HOUR),
          minute: Math.round((HABIT_NIGHT_FLOOR_HOUR % 1) * 60),
        },
        tz,
      );
      fireMs = Math.max(fireMs, Math.min(floorMs, bedtimeMs - HABIT_NIGHT_BEFORE_MIN_LEAD_HOURS * 3_600_000));
    } else {
      fireMs = wallToUtcMs(
        {
          year: eventLocal.year,
          month: eventLocal.month,
          day: eventLocal.day - 1,
          hour: NIGHT_BEFORE_LOCAL_HOUR,
          minute: 0,
        },
        tz,
      );
    }
    const offset = Math.round((runAtMs - fireMs) / 60_000);
    if (fireMs > nowMs && offset > 0 && offset <= MAX_OFFSET_MINUTES) {
      let tail = hasWake ? "明早会叫你起床" : "到点会再提醒你";
      if (alarmBedtimeHours != null) {
        if (alarmBedtimeHours < HABIT_TIGHT_SLEEP_HOURS) {
          tail = `按你平时约${formatHour(habits!.sleepStartHour!)}入睡，到闹钟只睡得约${formatDurationHours(alarmBedtimeHours)}，今晚尽量早点睡`;
        } else if (habits!.wakeHour != null && wakeAlarmMs != null) {
          const alarmWall = localParts(wakeAlarmMs, tz);
          const earlierMin = Math.round((habits!.wakeHour - (alarmWall.hour + alarmWall.minute / 60)) * 60);
          if (earlierMin >= 45) {
            tail = `闹钟比你平时起床早约${earlierMin}分钟，今晚记得早点睡`;
          }
        }
      }
      stages.push({
        offsetMinutes: offset,
        stage: "night_before",
        label: "睡前备忘",
        message: `【睡前备忘】明天${eventHm}有「${subject}」，今晚先记着，${tail}。`,
      });
    }
  }

  // 出发预留：线上=提前上线候场；识别出地点按路程估时；未识别/家附近保持历史模板
  const departOffset = factors.travelMinutes > 0 ? factors.travelMinutes : DEPART_ONLINE_LEAD_MINUTES;
  const departMs = runAtMs - departOffset * 60_000;
  if (departMs > nowMs && departOffset > 0 && departOffset <= MAX_OFFSET_MINUTES) {
    if (factors.venue === "online") {
      stages.push({
        offsetMinutes: departOffset,
        stage: "depart",
        label: "提前上线",
        message: `【提前上线】${eventHm}开始的「${subject}」快到了，提前${departOffset}分钟进会议候场。`,
      });
    } else if (factors.importance === "high" && (factors.venue === "far" || factors.venue === "mid")) {
      // 2026-10-25 口吻对齐用户定调：预告=出发时刻的当下行动指令，回指用户原话
      // （「你说的今天10点…现在可以出发了」），不再用【该出门了】报数机器腔；
      // 估算路程不再写进文案（无地点时是估算值，写实了反而像承诺）。
      // 「今天/明天」按预告触发时刻算（文案创建在提前量前，相对创建日算会错）。
      const departLocal = localParts(departMs, tz);
      const dayWord =
        departLocal.year === eventLocal.year &&
        departLocal.month === eventLocal.month &&
        departLocal.day === eventLocal.day
          ? "今天"
          : "明天";
      stages.push({
        offsetMinutes: departOffset,
        stage: "depart",
        label: "该出门了",
        message: `你说的${dayWord}${eventHm}有「${subject}」，现在可以出发了。`,
      });
    } else {
      // 保底：与历史「【提前X分钟】」模板一致，普通提醒的观感不变
      stages.push({
        offsetMinutes: departOffset,
        stage: "depart",
        label: "提前提醒",
        message: `【提前${departOffset}分钟】${subject}`,
      });
    }
  }

  if (stages.length === 0) return null;
  // 同偏移去重（钳制边界可能撞段，如 06:20 的重要事项闹钟与出发同为开始前 30 分钟）：
  // 后写入者胜（depart 段最后入列，撞段时保留更紧迫的行动指令）；整体按偏移倒序
  const byOffset = new Map<number, Stage>();
  for (const s of stages) byOffset.set(s.offsetMinutes, s);
  const merged = [...byOffset.values()].sort((a, b) => b.offsetMinutes - a.offsetMinutes);
  return {
    policyName: `${factors.importance}/${factors.venue}${
      input.routeSource ? `/route:${input.routeSource}` : ""
    }`,
    factors,
    remindBeforeMinutes: merged.map((s) => s.offsetMinutes),
    preReminders: merged.map(({ offsetMinutes, stage, label, message }) => ({
      offsetMinutes,
      stage,
      label,
      message,
    })),
    summary: merged
      .map((s) => `${describeFireLocal(runAtMs - s.offsetMinutes * 60_000, tz)} ${s.label}`)
      .join(" → "),
  };
}

/** 工具结果用：把任务的分段计划转成可转述结构（无计划返回 undefined）。 */
export function describeRemindPlan(
  task: Pick<ScheduleTaskRecord, "runAt" | "timezone" | "preReminders" | "reminderPolicy">,
): {
  policyName: string;
  summary: string;
  stages: Array<{ stage: ReminderStage; label: string; offsetMinutes: number; fireAtLocal: string }>;
} | undefined {
  const runAtMs = Date.parse(task.runAt);
  if (!task.preReminders?.length || !Number.isFinite(runAtMs)) return undefined;
  const tz = task.timezone || "Asia/Shanghai";
  return {
    policyName: task.reminderPolicy ?? "",
    summary: task.preReminders
      .map((p) => `${describeFireLocal(Date.parse(task.runAt) - p.offsetMinutes * 60_000, tz)} ${p.label}`)
      .join(" → "),
    stages: task.preReminders.map((p) => ({
      stage: p.stage,
      label: p.label,
      offsetMinutes: p.offsetMinutes,
      fireAtLocal: describeFireLocal(Date.parse(task.runAt) - p.offsetMinutes * 60_000, tz),
    })),
  };
}

function clipSubject(subject: string): string {  const s = subject.trim().replace(/\s+/g, " ");
  if (!s) return "日程安排";
  return s.length <= 30 ? s : `${s.slice(0, 30)}…`;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** 十进制小时 → 「H:MM」（如 1.5 → 1:30，23.75 → 23:45）；入睡时刻转述用 */
function formatHour(h: number): string {
  const norm = ((h % 24) + 24) % 24;
  return `${Math.floor(norm)}:${pad2(Math.round((norm % 1) * 60) % 60)}`;
}

/** 小时数 → 「约X个半小时 / X小时」（睡眠预算转述用，向下取整到半小时） */
function formatDurationHours(hours: number): string {
  const halfHours = Math.max(1, Math.floor(hours * 2) / 2);
  const whole = Math.floor(halfHours);
  return halfHours % 1 === 0 ? `${whole}小时` : `${whole}个半小时`;
}

/** 段触发时刻的本地描述：「M月D日 HH:mm」统一格式（摘要/转述用，不做相对化）。 */
function describeFireLocal(utcMs: number, timezone: string): string {
  if (!Number.isFinite(utcMs)) return "?";
  const parts = localParts(utcMs, timezone);
  return `${parts.month}月${parts.day}日 ${pad2(parts.hour)}:${pad2(parts.minute)}`;
}

type LocalParts = { year: number; month: number; day: number; hour: number; minute: number };

function localParts(utcMs: number, timezone: string): LocalParts {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const v: Record<string, number> = {};
  for (const p of fmt.formatToParts(new Date(utcMs))) {
    if (p.type !== "literal") v[p.type] = Number(p.value);
  }
  return {
    year: v.year,
    month: v.month,
    day: v.day,
    hour: (v.hour ?? 0) % 24,
    minute: v.minute ?? 0,
  };
}

/** 墙钟 → UTC（与 ScheduleTaskService.toUtcFromLocalTime 同一算法，独立实现保持本模块零依赖） */
function wallToUtcMs(
  wall: { year: number; month: number; day: number; hour: number; minute: number },
  timezone: string,
): number {
  // Date 规范化自动处理「上月 0/负数日」→ 前一天的跨月回退
  const y = wall.year;
  const mo = wall.month - 1;
  const h = wall.hour;
  const mi = wall.minute;
  const tentative = new Date(Date.UTC(y, mo, wall.day, h, mi, 0));
  const parts = localParts(tentative.getTime(), timezone);
  const actual = new Date(Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, 0));
  const deltaMs = Date.UTC(y, mo, wall.day, h, mi) - actual.getTime();
  return tentative.getTime() + deltaMs;
}
