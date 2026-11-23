/**
 * 轻量健康（PRD §10 需求八，P2）：用药提醒 / 作息周报 / 喝水久坐。
 *
 * 一句话定位：**只提醒和记录，不诊断、不给用药建议**（§10 边界），语气按 SOUL
 * 「安全、金钱、健康、法律上的事严肃办，这些场合不开玩笑」——不撒娇不打趣，也不训人。
 *
 * 三条硬口径（都是 §1.3 点名的）：
 *  1. **不新建存储**：用药的「吃什么、几点、多久一次」的唯一出处仍是
 *     `ScheduleTaskService` 的重复提醒任务（对话里说「每天早饭后吃维生素 D」，
 *     chat 侧走的就是既有的 calendar.create → recurrence=daily 那条路）。本模块只给
 *     它加一层**类型化的读侧视图**（description 前缀标记，沿用 `RHYTHM_MARK` 的同一种
 *     元数据约定），外加一份「今天这颗吃没吃」的流水账（persist-file 的一个 json）。
 *     节律均值一律从 `LifeRhythmEngine` 的画像里取，绝不在别处拿原始事件重算睡眠。
 *  2. **不开任何定时器**：本模块没有 timer / 轮询 / cron。所有的「时刻」都是给提案写
 *     `deliverAfter`，落哪个触点由 §3.4 的 `TouchpointPlanner` 说了算，到点由管道既有的
 *     30s flush 触发。三个入口都是**被动被既有钩子叫一下**：
 *       用药计划 / 晚间漏服 / 周报 → `EveningDigestScheduler.onDigestTriggered`（明日预览那一刻）
 *       喝水久坐                    → `ProactivityHub.onUserActivity`（用户刚碰过手机）
 *       闭环回写                    → `hookBus.subscribeType("proactive.outcome")`（§1.3 反馈回灌）
 *  3. **唯一开口通道**：`ProactivePipeline.submitProposal`。用户点名要的到点提醒是
 *     `tier="must"`（绕过社交预算，不能被「今天已经聊够了」吞掉）；漏服补问 / 周报 /
 *     起身提醒是系统主动开的口 → `tier="social"`，计入社交日预算。三类提案在提交前都
 *     先过 `FrequencyGovernor.tierAllows(actorId,"followup")`——「只在有事时」档一句不说。
 *
 * 闭环动作全部复用既有 actionId（`notification-actions.ts` 的 `NOTIFY_ACTION`，
 * 每个都有真执行器，不新造按钮）：
 *   已吃      `schedule_complete`（带 taskId）→ 重复任务 completeTask 不动调度，
 *             但会记一次 accepted+ref → 本模块据此把今天这颗落成「已吃」；
 *   10 分钟后 `snooze`（delayMs=600_000）      → 管道 requeueProposal，10 分钟后再问；
 *             顺带把这一颗标成 deferred（说晚点吃的人不该在晚上被当成漏服追问）；
 *   知道了    `acknowledge`                    → accepted：漏服那一句问到就算办完；
 *   今天别提  `dismiss`                        → dismissed：本模块记当天静音（另计一次负反馈）。
 *
 * 锁屏不泄露：药名/病症属于 §3.5 的 private 面，通知正文（directText）只出「该吃药啦」
 * 这一类不带事项名的话，具体是哪一种药留在 summary（点开进 App 才看得见）。
 *
 * 落盘：`data/proactivity/health.json`（persist-file 原子写，不新建 DB 文件）。
 */
import { readJson, writeJson } from "./persist-file.js";
// 「回复」按钮的角色常量（与 followup-service 同一个来源，不自己拼字符串）
import { CHAT_REPLY_ROLE } from "./notification-actions.js";
import { resolveHealthRhythm } from "../services/health-rhythm-service.js";
import { expandTaskOccurrenceTimes } from "../services/schedule-recurrence-expand.js";
import { daypartOfDayKey, medianOrNull } from "../rhythm/dimensions/grouping.js";
import type { HookEvent } from "../services/hooks/hook-types.js";
import type { ScheduleRecurrence, ScheduleTaskStatus } from "../services/schedule-task-service.js";
import type { ProactiveProposal, ProposalNotifyOption } from "./pipeline-types.js";
// §3.5 的判私闸共用一处：健康类事项（药名/病症）与跟进事件走同一条锁屏口径
import { classifySensitivity } from "./followup-service.js";

const DAY_MS = 24 * 60 * 60_000;
const MINUTE_MS = 60_000;

/** 本地日期键（所有「今天/本周」的口径单位，与触点计划一致） */
function localDateKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** 「本周」的起点：周一 00:00（周日晚上要总结的正是这一周） */
export function weekStartOf(ms: number): number {
  const day = new Date(ms).getDay();
  const backToMonday = day === 0 ? 6 : day - 1;
  return startOfDay(ms) - backToMonday * DAY_MS;
}

/** 十进制小时 → 「23:45」（凌晨样本可 >24，折回当天钟面念） */
export function formatHourDecimal(hour: number | null): string {
  if (hour === null || !Number.isFinite(hour)) return "";
  const h = ((Math.floor(hour) % 24) + 24) % 24;
  const m = Math.round((hour - Math.floor(hour)) * 60);
  return `${String(h).padStart(2, "0")}:${String(m === 60 ? 0 : m).padStart(2, "0")}`;
}

// ─────────────────────────── 类型化标记（既有任务存储的元数据） ───────────────────────────

/**
 * 健康事项的 description 前缀标记，形态与 `RHYTHM_MARK`（"[节律提醒:"）完全一致——
 * 这是既有重复提醒给「机器创建的任务」打标签的唯一约定，不另立字段。
 *
 * 刻意不复用 RHYTHM_MARK：那条前缀会把任务判成 trivia（不进「今日安排」）并交给
 * `reminder-rescheduler` 做 ±15 分钟的缓慢重排。吃药的时刻是医生和用户定的，
 * 既该在「今日安排」里看得见，也绝不该被节律学走。
 */
export const HEALTH_TASK_MARK = "[健康提醒:";
export type HealthTaskPreset = "medication";

/** 打标记（对话侧/工具侧创建用药任务时用它，读侧只认这一个形状） */
export function markHealthTask(description: string, preset: HealthTaskPreset): string {
  const body = (description ?? "").replace(new RegExp(`^${HEALTH_TASK_MARK}[a-z]+\\]\\s*`), "");
  return `${HEALTH_TASK_MARK}${preset}] ${body}`.trim();
}

/** 解标记；不是健康标记返回 null（旧数据没有标记也走 null，另有关键词兜底） */
export function healthPresetOf(description: string | undefined): HealthTaskPreset | null {
  const raw = (description ?? "").trim();
  if (!raw.startsWith(HEALTH_TASK_MARK)) return null;
  const end = raw.indexOf("]");
  if (end < 0) return null;
  return raw.slice(HEALTH_TASK_MARK.length, end).trim() === "medication" ? "medication" : null;
}

/**
 * 用药事项的识别。
 *
 * 关键词表与 `schedule-intent-service` 里「用药提醒通常需要每日重复」那条规则同源
 * （那里判定要不要劝用户改成每天重复，这里判定这条重复提醒是不是吃药），两边口径
 * 差太远会出现「劝你设成每天、设完又不认得」的怪事。
 */
const MEDICATION_RE =
  /吃药|服药|用药|喝药|药片|胶囊|冲剂|滴剂|滴眼|眼药水|胰岛素|打针|维[DdＤ]|维生素|钙片|铁剂|叶酸|益生菌|处方|保健品/;

/**
 * 读侧任务视图：只取本模块用到的字段，形状与 `ScheduleTaskRecord` 结构兼容
 * （装配层直接把 `listAllTasks()` 的结果递进来，不做第二份拷贝）。
 */
export type HealthTaskView = {
  taskId: string;
  sessionId: string;
  title?: string;
  shortTitle?: string;
  description: string;
  kind: string;
  recurrence: ScheduleRecurrence;
  status: ScheduleTaskStatus;
  runAt: string;
  cronExpression?: string;
};

/** 这条任务是不是「周期用药提醒」：提醒类 + 真的在重复 + 认得它是药 */
export function isMedicationTask(task: HealthTaskView): boolean {
  if (task.kind !== "reminder" || task.status !== "active") return false;
  // cron 表达式任务的时刻由 croniter 定，expandTaskOccurrenceTimes 不认（会把
  // 它按 yearly 处理算出不存在的日子），宁可不排也不猜时刻
  if (task.cronExpression || task.recurrence === "none") return false;
  if (healthPresetOf(task.description) === "medication") return true;
  const text = `${task.shortTitle ?? ""} ${task.title ?? ""} ${task.description}`;
  return MEDICATION_RE.test(text);
}

/** 事项名（「维生素 D」）：优先用任务自己的短标题，没有才从原句剥时间词 */
export function medicationLabel(task: HealthTaskView): string {
  const marked = (task.description ?? "").replace(new RegExp(`^${HEALTH_TASK_MARK}[a-z]+\\]\\s*`), "");
  const raw = (task.shortTitle || task.title || marked || "").trim();
  if (!raw || isEchoCopy(raw)) return "药";
  return raw.length > 14 ? `${raw.slice(0, 14)}…` : raw;
}

/** 与 reminder-copy 的 ECHO_* 同口径的粗筛：原句回声不该出现在按钮旁边的正文里 */
function isEchoCopy(text: string): boolean {
  return /提醒我|叫我|喊我|^\s*$/.test(text);
}

/**
 * 判私（§3.5 口径）：药名、病症上锁屏就是泄露。命中 → 通知正文只出「该吃药啦」，
 * 事项名留在 summary（点开进 App 才看得见）。
 */
const PRIVATE_HEALTH_RE = /药|维生素|钙片|铁剂|叶酸|胰岛素|血压|血糖|抑郁|焦虑|失眠|孕|癌|艾滋|HIV/;
export function isPrivateMedication(subject: string): boolean {
  return PRIVATE_HEALTH_RE.test(subject ?? "") || classifySensitivity(subject) === "private";
}

// ─────────────────────────── 提案 kind（触点计划按叶子名给落点偏好） ───────────────────────────

export const HEALTH_KIND = {
  /** 到点那句 + 已吃按钮（用户点名事项） */
  medication: "health.medication",
  /** 晚间 slot 的漏服补问（主动社交层） */
  medicationMiss: "health.medication_miss",
  /** 周日作息周报（主动社交层） */
  rhythmReport: "health.rhythm_report",
  /** 喝水/久坐（主动社交层，默认关） */
  move: "health.sedentary",
} as const;

/** 到点提醒后隔多久问「吃了没」：贴着闹钟问等于把两条消息叠成一瞬间 */
export const DOSE_CHECK_GRACE_MS = 15 * MINUTE_MS;
/** 问一句的保质期：拖过 3 小时才问，这句已经没人认了 */
export const DOSE_CHECK_TTL_MS = 3 * 60 * MINUTE_MS;
/** 「10 分钟后」按钮的间隔（§10 表格原话） */
export const DOSE_POSTPONE_MS = 10 * MINUTE_MS;
/** §7.4 冷启动闸：置信度不到这个数就不推周报（与触点计划冷启动阈值同值） */
export const WEEKLY_MIN_CONFIDENCE = 0.5;
/** 一周至少有这么几天有样本才谈「平均入睡」，三天算不出周均值 */
export const WEEKLY_MIN_DAYS = 4;
/** 周报每周一次的去重键落在 ledger（`reportWeek`），这里只限起身提醒的当天条数 */
export const MOVE_DEFAULT_MAX_PER_DAY = 1;

// ─────────────────────────── 台账 ───────────────────────────

export type DoseState = "pending" | "taken" | "deferred" | "missed";

/** 一颗药的一天：主键 `taskId:本地日期`，既是幂等键也是漏服判据 */
export type DoseRow = {
  key: string;
  actorId: string;
  taskId: string;
  date: string;
  /** 该吃的时刻（由任务的重复规则展开，永远不猜） */
  doseAt: number;
  /** 提案实际开口时刻 */
  plannedAt: number;
  subject: string;
  private: boolean;
  state: DoseState;
  ackAt?: number;
  /** §11.1 家庭模式字段预留：只加字段不加分支 */
  householdId?: string | null;
  targetActorId?: string;
  scope?: "private" | "household";
};

type MoveState = {
  /** 默认关（§10「默认关」）：只有用户明确说过要，才置 true */
  optIn?: boolean;
  optInAt?: number;
  /** 「今天别提」的生效日（本地日期，隔天自然失效） */
  mutedDate?: string;
  /** 当日已提醒的日期与次数（一天最多一句） */
  lastDate?: string;
  count?: number;
};

type ActorHealthState = {
  doses?: Record<string, DoseRow>;
  /** 已为哪一天排过打卡（用户活跃事件很密，靠它把排程压回一天一次） */
  plannedDate?: string;
  /** 漏服那一句每天只问一次 */
  missCheckDate?: string;
  /** 周报每周一次（值 = 本周周一的本地日期） */
  reportWeek?: string;
  move?: MoveState;
};

type HealthFile = { version: 1; actors?: Record<string, ActorHealthState> };

/** 节律画像的读侧切片（LifeRhythmEngine.getProfile 的 sleep/wake 两维，按原样递进来） */
export type RhythmSleepSample = { date: string; startHour: number; endHour: number; source?: string };
export type RhythmWakeSample = { date: string; hour: number; source?: string };
export type RhythmView = {
  sleep: RhythmSleepSample[];
  wake: RhythmWakeSample[];
  /** 作息整体置信度（engine.rhythmConfidence），< 0.5 视为冷启动 */
  confidence: number;
};

export type HealthServiceDeps = {
  /** 唯一开口通道（ProactivePipeline.submitProposal 的薄包装，晚绑定） */
  submit: (proposal: ProactiveProposal) => unknown;
  /** 频率档闸门（§3.10「只在有事时」一句不说；社交预算由管道的 tier=social 统一管） */
  governor?: { tierAllows(actorId: string, feature: "followup" | "ask_you"): boolean };
  /** 既有重复提醒存储的读侧（ScheduleTaskService.listAllTasks）：用药事实的唯一出处 */
  medicationTasks?: () => HealthTaskView[];
  /** 触点计划读侧（bootstrap 接 TouchpointPlanner.planOf）：晚间时刻的唯一来源 */
  slotTimes?: (actorId: string, atMs: number) => Array<{ kind: string; windowStart: number }>;
  /** 节律画像读侧（LifeRhythmEngine.getProfile + rhythmConfidence）：周报的唯一数据源 */
  rhythm?: (actorId: string) => RhythmView | null;
  /** 身份相关文本（档案字段/画像行）→ 既有健康节奏档位（工作时段 + 久坐阈值） */
  identityTexts?: (actorId: string) => string[];
  /**
   * 端侧「已经坐了多久」（分钟）读取。**本期不给**：步数/运动强度要等 §10 后续的
   * Health Connect 传感器，没有依据就一句不说（缺省 = 喝水/久坐整条静默）。
   */
  stillnessOf?: (actorId: string, at: number) => number | null;
  /** 管家名（private 事项的锁屏正文前缀，与 §3.5 同口径） */
  butlerName?: (actorId: string) => string | null;
  /** 台账落盘路径（不传 = 纯内存，测试用） */
  path?: string;
  nowFn?: () => number;
  log?: (msg: string) => void;
  /** 总开关（env PROACTIVITY_HEALTH_ENABLED=0 一键关整条链） */
  enabled?: () => boolean;
};

export type EveningSlotResult = {
  /** 今天与明天排出的用药打卡提案条数 */
  planned: number;
  missCheck: ProactiveProposal | null;
  report: ProactiveProposal | null;
  reason: string[];
};

export type MoveResult = { sent: boolean; reason: string; proposal?: ProactiveProposal };

// ─────────────────────────── 周报统计（只用节律画像，不碰原始事件） ───────────────────────────

export type SleepWeekStats = {
  bedHour: number | null;
  wakeHour: number | null;
  days: number;
  /** 与上周的差（分钟，正=变晚 / 变晚起） */
  bedDeltaMinutes: number | null;
  wakeDeltaMinutes: number | null;
  weekdayDays: number;
  weekendDays: number;
  /** 周末比平时晚睡多少分钟（>0 = 周末补觉式晚睡，那句建议的依据） */
  weekendDriftMinutes: number | null;
};

/** 日期键是否落在 [from,to) 内：正午取样，与 grouping.daypartOfDayKey 同口径 */
function dayKeyInRange(dateKey: string, from: number, to: number): boolean {
  const ms = Date.parse(`${dateKey}T12:00:00`);
  return Number.isFinite(ms) && ms >= from && ms < to;
}

function hoursOf(list: readonly number[]): number[] {
  return list.filter((n) => Number.isFinite(n));
}

/**
 * 一周的入睡 / 起床均值。
 *
 * 中位数而不是算术平均：熬过一次夜就把「平均入睡」拖走一小时，那种周报是骗人的。
 * 分组读法（工作日/周末）走 rhythm 的既有小件，不在这里另立一套分桶。
 */
export function summarizeSleepWeek(rhythm: RhythmView, weekStart: number): SleepWeekStats {
  const weekEnd = weekStart + 7 * DAY_MS;
  const prevStart = weekStart - 7 * DAY_MS;

  const bed: number[] = [];
  const prevBed: number[] = [];
  let weekdayDays = 0;
  let weekendDays = 0;
  const bedByDaypart: Record<"weekday" | "weekend", number[]> = { weekday: [], weekend: [] };
  for (const s of rhythm.sleep) {
    if (!s || !Number.isFinite(s.startHour)) continue;
    if (dayKeyInRange(s.date, weekStart, weekEnd)) {
      bed.push(s.startHour);
      const part = daypartOfDayKey(s.date);
      bedByDaypart[part].push(s.startHour);
      if (part === "weekend") weekendDays += 1;
      else weekdayDays += 1;
    } else if (dayKeyInRange(s.date, prevStart, weekStart)) {
      prevBed.push(s.startHour);
    }
  }

  const wake: number[] = [];
  const prevWake: number[] = [];
  for (const w of rhythm.wake) {
    if (!w || !Number.isFinite(w.hour)) continue;
    if (dayKeyInRange(w.date, weekStart, weekEnd)) wake.push(w.hour);
    else if (dayKeyInRange(w.date, prevStart, weekStart)) prevWake.push(w.hour);
  }

  const bedMedian = medianOrNull(hoursOf(bed));
  const wakeMedian = medianOrNull(hoursOf(wake));
  const prevBedMedian = medianOrNull(hoursOf(prevBed));
  const prevWakeMedian = medianOrNull(hoursOf(prevWake));
  const weekdayBed = medianOrNull(hoursOf(bedByDaypart.weekday));
  const weekendBed = medianOrNull(hoursOf(bedByDaypart.weekend));
  const drift = weekdayBed !== null && weekendBed !== null ? Math.round((weekendBed - weekdayBed) * 60) : null;

  return {
    bedHour: bedMedian,
    wakeHour: wakeMedian,
    // 入睡与起床的样本天数取大的那个：手机只报起床不报入睡是常态
    days: Math.max(bed.length, wake.length),
    bedDeltaMinutes: bedMedian !== null && prevBedMedian !== null ? Math.round((bedMedian - prevBedMedian) * 60) : null,
    wakeDeltaMinutes: wakeMedian !== null && prevWakeMedian !== null ? Math.round((wakeMedian - prevWakeMedian) * 60) : null,
    weekdayDays,
    weekendDays,
    weekendDriftMinutes: drift,
  };
}

/**
 * 周报正文：两句事实 + 一句不劝人的话。
 *
 * 「不说教」在这段代码里是有具体形状的：不出现「应该 / 最好 / 熬夜伤身」，
 * 变晚了一句只把幅度说出来，没变晚就明确说不用改（§10 表格原话）。
 */
export function weeklyReportLines(stats: SleepWeekStats): { text: string; tip: string } {
  const bed = formatHourDecimal(stats.bedHour);
  const wake = formatHourDecimal(stats.wakeHour);
  const parts: string[] = [];
  if (bed && wake) parts.push(`这周平均 ${bed} 睡、${wake} 起`);
  else if (bed) parts.push(`这周平均 ${bed} 睡`);
  else if (wake) parts.push(`这周平均 ${wake} 起`);

  const delta = stats.bedDeltaMinutes;
  if (delta !== null && Math.abs(delta) >= 15) {
    parts.push(`比上周${delta > 0 ? "晚" : "早"}了 ${Math.abs(delta)} 分钟`);
  } else if (delta !== null) {
    parts.push("跟上周差不多");
  }

  let tip = "不用改什么，就是让你看一眼。";
  if (delta !== null && delta >= 45) tip = "要是想往回挪，先挪周末那两天就够了。";
  else if (stats.weekendDriftMinutes !== null && stats.weekendDriftMinutes >= 75)
    tip = "周末比平时晚一个多小时，周一会难受一点，自己心里有数。";
  else if (delta !== null && delta <= -30) tip = "这周睡得比上周早，挺好的。";

  return { text: `${parts.join("，")}。`, tip };
}

// ─────────────────────────── 服务 ───────────────────────────

export class HealthService {
  private readonly now: () => number;
  private readonly log: (msg: string) => void;
  private file: HealthFile = { version: 1, actors: {} };
  private detachOutcome: (() => void) | null = null;

  constructor(private readonly deps: HealthServiceDeps) {
    this.now = deps.nowFn ?? Date.now;
    this.log = deps.log ?? ((msg) => console.log(msg));
    if (deps.path) {
      const raw = readJson<HealthFile>(deps.path, { version: 1, actors: {} });
      this.file = { version: 1, actors: raw.actors ?? {} };
    }
  }

  private get enabled(): boolean {
    return this.deps.enabled?.() !== false;
  }

  private actor(actorId: string): ActorHealthState {
    const actors = (this.file.actors ??= {});
    return (actors[actorId] ??= {});
  }

  private persist(): void {
    if (this.deps.path) writeJson(this.deps.path, this.file);
  }

  /** §3.10 档闸：「只在有事时」什么都不说（但药该记的照记） */
  private allows(actorId: string): boolean {
    return this.deps.governor?.tierAllows(actorId, "followup") !== false;
  }

  /** 晚间触点时刻（只问触点计划要；没有计划就以「此刻」为准——此刻本就是明日预览那一刻） */
  private eveningAnchor(actorId: string, at: number): number {
    const slots = this.deps.slotTimes?.(actorId, at) ?? [];
    const hit = slots.find((s) => s.kind === "tomorrow_preview" && Number.isFinite(s.windowStart));
    return hit ? Math.max(at, hit.windowStart) : at;
  }

  private butler(actorId: string): string {
    return (this.deps.butlerName?.(actorId) ?? "").trim();
  }

  // ───────────── 用药：一天一颗一条打卡提案 ─────────────

  /** 这个人的周期用药任务（读的是既有重复提醒存储，本模块不存第二份计划） */
  medicationTasksOf(actorId: string): HealthTaskView[] {
    const all = this.deps.medicationTasks?.() ?? [];
    return all.filter((t) => t && t.sessionId === actorId && isMedicationTask(t));
  }

  /**
   * 为「at 所在那一天」排用药打卡：每颗药一天一条提案。
   *
   * 幂等靠台账主键 `taskId:日期`：晚间触点每天跑一次、服务重启后再跑一次，
   * 同一颗药当天都不会冒出第二条。
   */
  planDoses(
    actorId: string,
    atMs = this.now(),
  ): { created: number; rows: number; proposals: ProactiveProposal[] } {
    const out: ProactiveProposal[] = [];
    if (!this.enabled || !actorId?.trim()) return { created: 0, rows: 0, proposals: out };
    const now = this.now();
    const dayStart = startOfDay(atMs);
    const date = localDateKey(atMs);
    const st = this.actor(actorId);
    const doses = (st.doses ??= {});
    const quiet = !this.allows(actorId);
    let rows = 0;

    for (const task of this.medicationTasksOf(actorId)) {
      // 只展开这一天的发生时刻：重复规则由 schedule-recurrence-expand 说，这里不自己算
      const occurrences = expandTaskOccurrenceTimes(
        { runAt: task.runAt, recurrence: task.recurrence, status: task.status },
        dayStart,
        dayStart + DAY_MS - 1,
      );
      for (const doseAt of occurrences) {
        const key = `${task.taskId}:${date}`;
        if (doses[key]) continue;
        const subject = medicationLabel(task);
        const isPrivate = isPrivateMedication(subject);
        const row: DoseRow = {
          key,
          actorId,
          taskId: task.taskId,
          date,
          doseAt,
          plannedAt: doseAt + DOSE_CHECK_GRACE_MS,
          subject,
          private: isPrivate,
          state: "pending",
          scope: isPrivate ? "private" : "household",
          householdId: null,
        };
        doses[key] = row;
        rows += 1;
        // 时刻已过（晚上才第一次装配 / 中间宕机）：不再补问「吃了没」，
        // 那件事由今晚的漏服那一句一起说，免得一天里被同一颗药问两遍
        if (row.plannedAt <= now) continue;
        if (quiet) continue; // 安静档：记录照记，开口留给漏服检查一并省掉
        const p = this.buildDoseProposal(row);
        try {
          this.deps.submit(p);
          out.push(p);
        } catch (err) {
          this.log(`[Health] 用药打卡提案提交失败 actor=${actorId} ${key}: ${err}`);
          delete doses[key];
          rows -= 1;
        }
      }
    }
    // 记「这一天排过了」：用户活跃事件很密，靠它把排程压回一天一次（只往后推不回头）
    if (!st.plannedDate || st.plannedDate < date) st.plannedDate = date;
    // 账要落盘，哪怕这一轮一条提案都没出（当天早上的药已过点，账得留着给晚上对）
    this.persist();
    return { created: out.length, rows, proposals: out };
  }

  /** 到点那句（带「已吃 / 10 分钟后」两枚真按钮） */
  buildDoseProposal(row: DoseRow, at = this.now()): ProactiveProposal {
    const name = this.butler(row.actorId);
    // 通知正文（payload.text / 推送 body / 动作意图 body 三处同源）是唯一会摊在锁屏上的字段，
    // private 的遮罩写在这里就够；全文进 summary，点开进 App 看得见是哪一种药。
    const full = `该吃${row.subject}了，吃了点一下我记上。`;
    const masked = "该吃药啦，吃了点一下。";
    const body = row.private ? (name ? `${name}：${masked}` : masked) : full;
    const options: ProposalNotifyOption[] = [
      // 已吃：走既有日程完成执行器（重复任务只落「这一次」，调度不动），
      // 按下去同时记一次 accepted+ref → observeOutcome 把今天这颗置 taken
      { action: "schedule_complete", label: "已吃", ref: row.taskId },
      { action: "snooze", label: "10 分钟后", delayMs: DOSE_POSTPONE_MS },
    ];
    return {
      proposalId: `p_${at.toString(36)}_dose`,
      actorId: row.actorId,
      kind: HEALTH_KIND.medication,
      // 用户自己说要吃药 = 点名的提醒，走必达层，不被「今天社交说够了」吞掉
      tier: "must",
      importance: "medium",
      dedupKey: `health:medication:${row.key}`,
      title: row.private ? "吃药" : row.subject,
      summary: full,
      directText: body,
      evidence: [
        "health_medication",
        `task=${row.taskId}`,
        `date=${row.date}`,
        `doseAt=${new Date(row.doseAt).toISOString()}`,
        row.private ? "sensitivity=private" : "sensitivity=normal",
      ],
      createdAt: at,
      // 贴着到点之后一刻问：太贴就成了和闹钟同时冒两条
      deliverAfter: row.plannedAt,
      expiresAt: row.doseAt + DOSE_CHECK_TTL_MS,
      source: "health",
      // subject 会进话题归因与抑制匹配，private 的事项名一样不落
      subject: row.private ? "用药" : row.subject,
      scope: row.private ? "private" : undefined,
      notifyOptions: options,
    };
  }

  // ───────────── 晚间触点：漏服补问 + 周日周报 ─────────────

  /**
   * 明日预览那一刻做的事（由 `EveningDigestScheduler.onDigestTriggered` 调，本模块无钟）：
   *   ① 把今天与明天的用药打卡排好（明天的那条 deliverAfter 指向明天早晨，管道攒着到点发）；
   *   ② 当天有药没落「已吃」→ 提一次（只一次）；
   *   ③ 周日 → 作息周报（样本够才推，§7.4 冷启动不推）。
   */
  evaluateEveningSlot(actorId: string, at = this.now()): EveningSlotResult {
    const reasons: string[] = [];
    let missCheck: ProactiveProposal | null = null;
    let report: ProactiveProposal | null = null;
    if (!this.enabled || !actorId?.trim()) return { planned: 0, missCheck, report, reason: ["disabled"] };

    const today = this.planDoses(actorId, at);
    const tomorrow = this.planDoses(actorId, at + DAY_MS);
    reasons.push(`planned_today=${today.created}`, `planned_tomorrow=${tomorrow.created}`);
    if (!this.allows(actorId)) return { planned: today.created, missCheck, report, reason: [...reasons, "quiet_tier"] };

    const st = this.actor(actorId);
    const date = localDateKey(at);
    const anchor = this.eveningAnchor(actorId, at);

    // ② 漏服：pending（从没回过话）才算漏，deferred（说过 10 分钟后）不追着问
    if (st.missCheckDate !== date) {
      const missed = Object.values(st.doses ?? {}).filter(
        (d) => d.actorId === actorId && d.date === date && d.doseAt <= at && (d.state === "pending" || d.state === "missed"),
      );
      if (missed.length === 0) {
        reasons.push("no_missed_dose");
      } else {
        st.missCheckDate = date;
        for (const d of missed) d.state = "missed";
        missCheck = this.buildMissProposal(actorId, missed, at, anchor);
        try {
          this.deps.submit(missCheck);
          this.persist();
          reasons.push(`miss_checked=${missed.length}`);
        } catch (err) {
          this.log(`[Health] 漏服提案提交失败 actor=${actorId}: ${err}`);
          st.missCheckDate = undefined;
          missCheck = null;
          reasons.push("miss_submit_failed");
        }
      }
    } else reasons.push("miss_already_today");

    // ③ 周报：只有周日，且这一周还没发过
    const weekly = this.buildWeeklyProposal(actorId, at, anchor);
    if (weekly) {
      report = weekly;
      try {
        this.deps.submit(report);
        this.persist();
        reasons.push("report_sent");
      } catch (err) {
        this.log(`[Health] 周报提案提交失败 actor=${actorId}: ${err}`);
        // 没递出去就不算这一周发过：把周额度还回去，下次触点还能说（否则一整年没周报）
        st.reportWeek = undefined;
        report = null;
        reasons.push("report_submit_failed");
      }
    } else reasons.push("report_skipped");

    return { planned: today.created + tomorrow.created, missCheck, report, reason: reasons };
  }

  /** 晚间那一句漏服（当天只一次，多种药合成一句，绝不逐条轰炸） */
  buildMissProposal(
    actorId: string,
    missed: DoseRow[],
    at: number,
    deliverAfter: number,
  ): ProactiveProposal {
    const names = missed.map((m) => m.subject);
    const isPrivate = missed.some((m) => m.private);
    const named = `今天的${names.slice(0, 3).join("、")}我这边还没记上。吃了点一下，现在补也来得及。`;
    const masked = "今天的药我这边还没记上。吃了点一下，现在补也来得及。";
    const butler = this.butler(actorId);
    return {
      proposalId: `p_${at.toString(36)}_dosecheck`,
      actorId,
      kind: HEALTH_KIND.medicationMiss,
      // 这是系统主动开的一句问，不是用户点名要的事 → 计入社交预算（§3.10）
      tier: "social",
      importance: "low",
      dedupKey: `health:miss:${actorId}:${localDateKey(at)}`,
      title: isPrivate ? "吃药的事" : `${names.slice(0, 2).join("、")}吃了没`,
      summary: named,
      // 锁屏上只留一句不带事项名的话（§3.5 private 同一套遮法：正文遮、App 内看得见）
      directText: isPrivate ? (butler ? `${butler}：有件事跟你确认一下` : masked) : named,
      evidence: [
        "health_medication_miss",
        ...missed.map((m) => `${m.taskId}@${new Date(m.doseAt).toISOString()}`),
        `count=${missed.length}`,
      ],
      createdAt: at,
      deliverAfter,
      expiresAt: startOfDay(at) + DAY_MS,
      source: "rhythm", // 触点计划里 rhythm 只落「明日预览」——睡前才有空回这一句
      subject: "用药",
      scope: isPrivate ? "private" : undefined,
      notifyOptions: [
        // 知道了 = 这一句问到就算办完（漏服补问不猜是哪一颗，整天的 pending 一起收）
        { action: "acknowledge", label: "已吃" },
        { action: "snooze", label: "10 分钟后", delayMs: DOSE_POSTPONE_MS },
      ],
    };
  }

  /**
   * 周日作息周报（§10：每周日明日预览 slot）。
   *
   * 三道闸，任一道不过就一句不说：
   *   ① 今天不是周日；② 这一周已经发过；③ 节律是冷启动 / 样本天数不够（§7.4）。
   */
  buildWeeklyProposal(actorId: string, at: number, deliverAfter: number): ProactiveProposal | null {
    if (new Date(at).getDay() !== 0) return null;
    const st = this.actor(actorId);
    const weekStart = weekStartOf(at);
    const weekKey = localDateKey(weekStart);
    if (st.reportWeek === weekKey) return null;
    const view = this.deps.rhythm?.(actorId) ?? null;
    if (!view) return null;
    if (!(view.confidence >= WEEKLY_MIN_CONFIDENCE)) return null;
    const stats = summarizeSleepWeek(view, weekStart);
    if (stats.days < WEEKLY_MIN_DAYS) return null;
    if (stats.bedHour === null && stats.wakeHour === null) return null;

    const { text, tip } = weeklyReportLines(stats);
    st.reportWeek = weekKey;
    return {
      proposalId: `p_${at.toString(36)}_sleepweek`,
      actorId,
      kind: HEALTH_KIND.rhythmReport,
      tier: "social",
      importance: "low",
      dedupKey: `health:report:${actorId}:${weekKey}`,
      title: "这周的觉",
      summary: `${text}${tip}`,
      directText: "这周的作息整理好了，点开看一眼。",
      evidence: [
        "health_rhythm_report",
        `week=${weekKey}`,
        `days=${stats.days}`,
        `bed=${stats.bedHour ?? "n/a"}`,
        `wake=${stats.wakeHour ?? "n/a"}`,
        `bedDelta=${stats.bedDeltaMinutes ?? "n/a"}`,
        `confidence=${view.confidence}`,
      ],
      createdAt: at,
      deliverAfter,
      expiresAt: startOfDay(at) + DAY_MS,
      source: "rhythm",
      subject: "作息",
      // §10 表格的两个闭环动作：知道了（收下这条，正反馈）+ 回复（通知栏里回一句，
      // 走既有 chat_reply 执行器落成主会话一个 user turn，agent 顺口感慨一句）
      notifyOptions: [
        { action: "acknowledge", label: "知道了" },
        { action: CHAT_REPLY_ROLE as ProposalNotifyOption["action"], label: "回复" },
      ],
    };
  }

  // ───────────── 喝水 / 久坐（手机版，默认关） ─────────────

  /** 用户明确表过态才开（§10「默认关」）；对话自述口与后续设置页共用这一个入口 */
  setMoveOptIn(actorId: string, enabled: boolean, at = this.now()): void {
    const st = this.actor(actorId);
    const move = (st.move ??= {});
    move.optIn = enabled;
    move.optInAt = at;
    if (!enabled) {
      move.mutedDate = undefined;
      move.lastDate = undefined;
      move.count = 0;
    }
    this.persist();
    this.log(`[Health] 喝水/久坐提醒 actor=${actorId} ${enabled ? "已开启（用户明确要求）" : "已关闭"}`);
  }

  isMoveOptedIn(actorId: string): boolean {
    return this.actor(actorId).move?.optIn === true;
  }

  /** 今天别提（dismiss 按钮 / 用户明说）：当天不再提，隔日自然恢复 */
  muteMoveToday(actorId: string, at = this.now()): void {
    const st = this.actor(actorId);
    (st.move ??= {}).mutedDate = localDateKey(at);
    this.persist();
  }

  /**
   * 工作时段 + 静止时长都成立才提一句（§10 表格原话）。
   *
   * 时段与阈值取自既有的健康节奏档位表（`/api/health/rhythm` 给桌面灵动岛下发的是
   * 同一套），不在这另立一张表；步数/运动强度要等 §10 后续的 Health Connect 传感器，
   * 没有静止时长依据时**一句不说**——「长时间不变」这件事不能靠猜。
   */
  evaluateMove(actorId: string, at = this.now()): MoveResult {
    if (!this.enabled) return { sent: false, reason: "disabled" };
    if (!actorId?.trim()) return { sent: false, reason: "no_actor" };
    const st = this.actor(actorId);
    if (st.move?.optIn !== true) return { sent: false, reason: "opt_out" };
    if (!this.allows(actorId)) return { sent: false, reason: "quiet_tier" };
    const date = localDateKey(at);
    if (st.move.mutedDate === date) return { sent: false, reason: "muted_today" };
    if (st.move.lastDate === date && (st.move.count ?? 0) >= MOVE_DEFAULT_MAX_PER_DAY) {
      return { sent: false, reason: "daily_cap" };
    }
    const day = new Date(at);
    // 只在工作时段：周末不是工作日，久坐提醒跟着休息（分组口径用节律的 weekday 判定）
    if (daypartOfDayKey(date) === "weekend") return { sent: false, reason: "weekend" };
    const rhythm = resolveHealthRhythm(this.deps.identityTexts?.(actorId) ?? []);
    if (rhythm.sedentaryAfterMinutes === null) return { sent: false, reason: "identity_off" };
    const hour = day.getHours() + day.getMinutes() / 60;
    if (hour < rhythm.startHour || hour >= rhythm.endHour) return { sent: false, reason: "out_of_work_hours" };
    const still = this.deps.stillnessOf?.(actorId, at) ?? null;
    if (still === null) return { sent: false, reason: "no_motion_source" };
    if (still < rhythm.sedentaryAfterMinutes) return { sent: false, reason: "not_sedentary_yet" };

    const proposal = this.buildMoveProposal(actorId, still, at);
    try {
      this.deps.submit(proposal);
    } catch (err) {
      this.log(`[Health] 久坐提案提交失败 actor=${actorId}: ${err}`);
      return { sent: false, reason: "submit_failed", proposal };
    }
    const move = (st.move ??= {});
    if (move.lastDate !== date) {
      move.lastDate = date;
      move.count = 0;
    }
    move.count = (move.count ?? 0) + 1;
    this.persist();
    return { sent: true, reason: "submitted", proposal };
  }

  buildMoveProposal(actorId: string, stillMinutes: number, at = this.now()): ProactiveProposal {
    const minutes = Math.max(1, Math.round(stillMinutes / 5) * 5);
    const text = `连着坐了有一个${minutes >= 60 ? `小时${minutes % 60 ? `半` : ""}` : `${minutes} 分钟`}了，起来走两步、顺手倒杯水。`;
    return {
      proposalId: `p_${at.toString(36)}_move`,
      actorId,
      kind: HEALTH_KIND.move,
      tier: "social",
      importance: "low",
      dedupKey: `health:move:${actorId}:${localDateKey(at)}:${Math.floor(at / 3_600_000)}`,
      title: "起来动一动",
      summary: text,
      directText: text,
      evidence: ["health_sedentary", `stillMinutes=${Math.round(stillMinutes)}`],
      createdAt: at,
      // 不填 deliverAfter：这句由管道按在场/择时即时评估，落不进 slot 也不该压到深夜
      expiresAt: startOfDay(at) + DAY_MS,
      source: "life_reminder",
      subject: "活动",
      notifyOptions: [
        { action: "acknowledge", label: "知道了" },
        // 今天别提：dismiss → 记一次负反馈 + 本模块置当天静音（两个后果都是真的）
        { action: "dismiss", label: "今天别提" },
      ],
    };
  }

  /**
   * 用户刚碰过手机（`ProactivityHub.onUserActivity` 的既有钩子）时顺手做两件事：
   *   ① 把今天还没排上的用药打卡补排（昨晚服务没跑、或中途重启过 → 早晨一解锁就补上，
   *      主键幂等，同一颗药当天不会冒出第二条）；
   *   ② 评估一次喝水/久坐（只有开了开关的人才会走到判断，默认关 = 直接返回）。
   * 这是「没有定时器」的另一半答案：到点不用谁来叫醒，用户一动就有一次评估机会，
   * 真到点要发的由管道 30s flush 兜住。
   */
  onUserTouch(actorId: string, at = this.now()): { planned: number; move: MoveResult | null } {
    if (!this.enabled) return { planned: 0, move: null };
    const st = this.actor(actorId);
    // 用户活跃事件很密（每次对话、每次设备活跃都来一发）：这一天排过就不再翻任务表
    const planned = st.plannedDate === localDateKey(at) ? 0 : this.planDoses(actorId, at).created;
    // 只有明确开过开关的人才值得为久坐做一次评估（省下节奏档与静止时长的读取）
    const move = st.move?.optIn === true ? this.evaluateMove(actorId, at) : null;
    return { planned, move };
  }

  // ───────────── 闭环回写（§1.3：反馈只从 outcome-store + hook-bus 这条路回来） ─────────────
  /**
   * 订阅 `proactive.outcome`。管道里每个按钮按下都会发一条，载荷带
   * `kind / outcome / ref / actorId`——按 kind 认领属于健康这一块的三条：
   *   health.medication    accepted(+ref) → 那颗置 taken；snoozed → 置 deferred（不当漏服）
   *   health.medication_miss accepted/replied → 今天所有没落账的一起收口（一句问覆盖多颗药）
   *   health.sedentary     dismissed → 今天别提
   * 不新造 actionId、不加执行器：按钮语义全是既有的。
   */
  attachOutcomeHook(bus: {
    subscribeType(type: "proactive.outcome", handler: (event: HookEvent) => void): () => void;
  }): () => void {
    this.detachOutcome?.();
    const unsub = bus.subscribeType("proactive.outcome", (event) => {
      const data = (event.data ?? {}) as Record<string, unknown>;
      const actorId = typeof event.actorId === "string" ? event.actorId : typeof data.actorId === "string" ? data.actorId : "";
      const kind = typeof data.kind === "string" ? data.kind : "";
      const outcome = typeof data.outcome === "string" ? data.outcome : "";
      const ref = typeof data.ref === "string" ? data.ref : "";
      const at = typeof data.at === "number" ? data.at : this.now();
      if (!actorId || !kind.startsWith("health.")) return;
      try {
        this.observeOutcome({ actorId, kind, outcome, ref, at });
      } catch (err) {
        this.log(`[Health] 回灌处理失败（忽略）actor=${actorId} kind=${kind}: ${err}`);
      }
    });
    this.detachOutcome = unsub;
    return unsub;
  }

  /** 一次表态的落点（测试与 hook 共用这一个入口） */
  observeOutcome(input: {
    actorId: string;
    kind: string;
    outcome: string;
    ref?: string;
    at?: number;
  }): { settled: number; reason: string } {
    const at = input.at ?? this.now();
    const st = this.actor(input.actorId);
    const doses = st.doses ?? {};

    if (input.kind === HEALTH_KIND.medication) {
      if (input.outcome === "accepted") return { ...this.settleDose(input.actorId, input.ref ?? "", at), reason: "taken" };
      if (input.outcome === "snoozed") return this.deferDose(input.actorId, input.ref ?? "", at);
      return { settled: 0, reason: "ignored_outcome" };
    }
    if (input.kind === HEALTH_KIND.medicationMiss) {
      // 「已吃」= 今天这些我都吃了：整天的 pending/missed 一起收口
      if (input.outcome === "accepted" || input.outcome === "replied") {
        const date = localDateKey(at);
        let settled = 0;
        for (const d of Object.values(doses)) {
          if (d.date !== date) continue;
          if (d.state !== "pending" && d.state !== "missed") continue;
          d.state = "taken";
          d.ackAt = at;
          settled += 1;
        }
        this.persist();
        return { settled, reason: "miss_acknowledged" };
      }
      return { settled: 0, reason: "ignored_outcome" };
    }
    if (input.kind === HEALTH_KIND.move) {
      if (input.outcome === "dismissed") {
        this.muteMoveToday(input.actorId, at);
        return { settled: 0, reason: "muted_today" };
      }
      return { settled: 0, reason: input.outcome === "accepted" ? "acknowledged" : "ignored_outcome" };
    }
    return { settled: 0, reason: "not_health" };
  }

  /** 已吃：ref 精确到那颗药；没带 ref（旧记录/别的面回传）就收最早还没落账的一颗 */
  settleDose(actorId: string, taskId: string, at = this.now()): { settled: number } {
    const st = this.actor(actorId);
    const rows = Object.values(st.doses ?? {}).filter((d) => d.date === localDateKey(at));
    const hit = taskId
      ? rows.filter((d) => d.taskId === taskId && d.state !== "taken")
      : rows.filter((d) => d.state === "pending" || d.state === "missed").slice(0, 1);
    let settled = 0;
    for (const row of hit) {
      if (row.state === "taken") continue;
      row.state = "taken";
      row.ackAt = at;
      settled += 1;
    }
    if (settled) this.persist();
    return { settled };
  }

  /** 10 分钟后：这颗先不当漏服（用户已经表过态，晚上再追一遍就是催） */
  deferDose(actorId: string, taskId: string, at = this.now()): { settled: number; reason: string } {
    const st = this.actor(actorId);
    const rows = Object.values(st.doses ?? {}).filter((d) => d.date === localDateKey(at));
    const target = taskId
      ? rows.find((d) => d.taskId === taskId && d.state === "pending")
      : rows.find((d) => d.state === "pending");
    if (!target) return { settled: 0, reason: "no_pending_dose" };
    target.state = "deferred";
    target.ackAt = at;
    this.persist();
    return { settled: 1, reason: "deferred" };
  }

  /**
   * 对话自述口（与 `ScheduleHabitStore.captureFromUserText` 同一个思路）：
   * 用户在聊天里说「吃过了 / 别再提醒我喝水」，这里收口，不额外等按钮。
   * 判不准就返回 null 什么都不做——把别人的话误当成「吃了」是记账错误，比漏记更糟。
   */
  captureFromUserText(actorId: string, text: string, at = this.now()): { kind: "dose" | "opt_in" | "opt_out"; message: string } | null {
    if (!this.enabled || !actorId?.trim()) return null;
    const t = (text ?? "").trim();
    if (!t || t.length > 30) return null;
    // 明确说了「没吃」：不当已吃，也不追问（晚上那句漏服同样不再重复提）
    if (/^(没|未|还没|不曾)(吃|服用)/.test(t) || /忘了吃|没吃呢/.test(t)) {
      const st = this.actor(actorId);
      st.missCheckDate = localDateKey(at);
      this.persist();
      return { kind: "dose", message: "好，那今天就先不算漏，想起来再吃。" };
    }
    if (/^(吃过了|吃了|吃完了|刚吃|已吃|服了|服用过)/.test(t)) {
      const settled = this.settleDose(actorId, "", at);
      return settled.settled
        ? { kind: "dose", message: `记上了，今天${settled.settled > 1 ? `这 ${settled.settled} 颗` : "那颗"}都算吃了。` }
        : { kind: "dose", message: "好，记上了。" };
    }
    if (/别(再|用)?(提醒|叫|说).{0,6}(喝水|起身|活动|久坐)/.test(t) || /(喝水|久坐).{0,6}(提醒)?关掉/.test(t)) {
      this.setMoveOptIn(actorId, false, at);
      return { kind: "opt_out", message: "行，喝水和起身这类就不主动说了。" };
    }
    if (/(提醒我|叫我|别忘了提醒).{0,8}(喝水|起身|活动一下|站一站)|(喝水|久坐|起身).{0,4}提醒我/.test(t)) {
      this.setMoveOptIn(actorId, true, at);
      return { kind: "opt_in", message: "好，工作的时候我会看你坐得久不久，提醒你起来一下。" };
    }
    return null;
  }

  /** 诊断视图：今天这颗药的账、周报与喝水开关，一眼看得清 */
  snapshot(actorId: string, at = this.now()): {
    medicationTasks: Array<{ taskId: string; label: string; runAt: string; recurrence: string }>;
    today: Array<{ taskId: string; subject: string; doseAt: number; state: DoseState }>;
    missCheckDate: string | null;
    reportWeek: string | null;
    move: { optIn: boolean; mutedToday: boolean; countToday: number };
  } {
    const st = this.actor(actorId);
    const date = localDateKey(at);
    return {
      medicationTasks: this.medicationTasksOf(actorId).map((t) => ({
        taskId: t.taskId,
        label: medicationLabel(t),
        runAt: t.runAt,
        recurrence: t.recurrence,
      })),
      today: Object.values(st.doses ?? {})
        .filter((d) => d.date === date)
        .sort((a, b) => a.doseAt - b.doseAt)
        .map((d) => ({ taskId: d.taskId, subject: d.subject, doseAt: d.doseAt, state: d.state })),
      missCheckDate: st.missCheckDate ?? null,
      reportWeek: st.reportWeek ?? null,
      move: {
        optIn: st.move?.optIn === true,
        mutedToday: st.move?.mutedDate === date,
        countToday: st.move?.lastDate === date ? (st.move?.count ?? 0) : 0,
      },
    };
  }
}

/** 总开关（默认开）：PROACTIVITY_HEALTH_ENABLED=0 整条链关停 */
export function isHealthFeatureEnabled(): boolean {
  const raw = process.env.PROACTIVITY_HEALTH_ENABLED?.trim();
  return raw !== "0" && raw !== "false";
}

/**
 * 装配层句柄（同 getFollowUpService 的惯例）：通知按钮执行器、HTTP 诊断路由
 * 从这里取实例，不必让 bootstrap 把参数一路透传下去。
 */
let healthServiceInstance: HealthService | null = null;

export function setHealthService(svc: HealthService | null): void {
  healthServiceInstance = svc;
}

export function getHealthService(): HealthService | null {
  return healthServiceInstance;
}
