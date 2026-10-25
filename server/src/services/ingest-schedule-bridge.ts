/**
 * 课表 → 周期日程的物化桥。
 *
 * ## 为什么要有这一层（2026-10-22 收编）
 *
 * 上一版把课表存成 ingest 台账里的 `weeklySlot`，等于给课表单开了一套记录：
 * 它不会进 `schedule-sensor` → 世界板 → 晨报，也不会到点提醒。而
 * `ScheduleTaskService` 本来就支持 `recurrence: "weekly"` 并有
 * `schedule-recurrence-expand.js` 展开器——"每周三 1-2 节高数"可以原样表达。
 *
 * 所以课表的**真实载体是日程**，台账只留条目做「重传=更新」的去重索引
 * （条目上回写 `scheduleTaskId`）。这样一条上传的课表会自动：
 *   到点提醒（日程自己的提醒链）→ 进「今日安排」→ 被 schedule-sensor 扫进世界板 → 晨报
 *
 * ## 不编日期，但要给一个基准日
 *
 * `weekly` 的 `runAt` 是**首次触发时刻**，不是"学期第一周"。所以不需要校历：
 * 取「下一个周几」即可，之后按周展开。校历只影响单双周/停课，属于更高精度，
 * 这里如实写进日程描述，不假装能算。
 *
 * ## 节次 → 时刻是默认作息，不是校历
 *
 * 课表只给"第几节"，不给钟点。项目里没有各校作息表，只能用一套最常见的默认值
 * （上午 1-4、下午 5-8、晚上 9-12，每节 45 分钟、课间 5 分钟）。这是**可被用户改的**
 * 日程字段，不是静默假设：描述里写清楚"按默认作息推算，如与校历不符请改这条"。
 * 宁可给一条能改的错时间，也不给一条永远不响的课。
 */

import type { IngestItem } from "./ingest-types.js";

/** 日程服务只需要这几个方法，用窄接口而非直接依赖实现（便于测试与解耦）。 */
export interface IngestSchedulePort {
  findTaskBySourceRefId(refId: string): { taskId: string; status?: string } | undefined;
  createTask(input: IngestScheduleCreateInput): Promise<{ taskId: string }>;
  updateTask(taskId: string, input: IngestScheduleUpdateInput): Promise<{ taskId: string }>;
  deleteTask(taskId: string): Promise<void>;
}

/** 与 `CreateScheduleTaskInput` 的必填面一致（多余字段由日程服务自己兜）。 */
export interface IngestScheduleCreateInput {
  sessionId: string;
  title?: string;
  shortTitle?: string;
  description: string;
  kind: "reminder";
  category?: "itinerary" | "trivia";
  runAt?: string;
  recurrence: "none" | "weekly";
  timezone?: string;
  durationMinutes?: number;
  location?: string;
  remindBeforeMinutes?: number[];
  /** kind=reminder 必填：到点弹出的那一句话（日程服务会校验非空） */
  reminderMessage?: string;
  source?: "manual" | "booking" | "ics" | "email" | "ingest";
  sourceRefId?: string;
}

export interface IngestScheduleUpdateInput {
  title?: string;
  shortTitle?: string;
  description?: string;
  recurrence?: "none" | "weekly";
  runAt?: string;
  timezone?: string;
  durationMinutes?: number;
  location?: string;
  remindBeforeMinutes?: number[];
}

export interface IngestMaterializeContext {
  /** 日程归属会话（课表是个人长期数据，用稳定的 ingest 会话键） */
  sessionId: string;
  timezone: string;
  now: Date;
}

export interface IngestMaterializeResult {
  created: number;
  updated: number;
  /** key → taskId，供台账回写（下次重传直接按 key 找回来） */
  taskIds: Record<string, string>;
  /** 没物化的条目及原因（如"课表没有节次，无法确定上课时间"） */
  skipped: { key: string; title: string; reason: string }[];
}

/**
 * 默认作息（第 n 节开始于当天第几分钟）。集中一处便于以后接"校历/作息表"配置。
 * 1-4 上午、5-8 下午、9-12 晚上，每节 45 分钟、课间 5 分钟。
 */
const DEFAULT_PERIOD_START_MINUTES: Record<number, number> = {
  1: 8 * 60,
  2: 8 * 60 + 50,
  3: 10 * 60,
  4: 10 * 60 + 50,
  5: 14 * 60,
  6: 14 * 60 + 50,
  7: 16 * 60,
  8: 16 * 60 + 50,
  9: 19 * 60,
  10: 19 * 60 + 50,
  11: 20 * 60 + 40,
  12: 21 * 60 + 30,
};

const PERIOD_LENGTH_MINUTES = 45;
const PERIOD_GAP_MINUTES = 5;

/** 课前提醒提前量（分钟）：课表的意义一半在"别迟到"，留 10 分钟够走到教室。 */
const CLASS_REMIND_BEFORE_MINUTES = [10];

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** 目标时区下"今天"的年月日（不依赖服务器本地时区）。 */
function localDateParts(now: Date, timeZone: string): { year: number; month: number; day: number } {
  const formatted = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now); // en-CA 输出 YYYY-MM-DD
  const [year, month, day] = formatted.split("-").map(Number);
  return { year, month, day };
}

/** 目标时区下"现在几点"（分钟数，用于判断今天的课是否已过）。 */
function localMinuteOfDay(now: Date, timeZone: string): number {
  const formatted = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(now); // "18:03"
  const [hour, minute] = formatted.split(":").map(Number);
  return hour * 60 + minute;
}

/** ISO 口径周几（1=周一 … 7=周日），由年月日直接算，避开时区偏移。 */
function isoWeekdayOf(year: number, month: number, day: number): number {
  const dow = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return dow === 0 ? 7 : dow;
}

/**
 * 下一个"周几 + 时刻"，返回**不带时区后缀**的本地时间串（`YYYY-MM-DDTHH:mm:00`）。
 *
 * 为什么不带后缀：日程服务 `parseRunAt` 对无后缀串按任务 timezone 解析，
 * 比自己拼 `+08:00` 更能适配用户时区。
 *
 * 今天就是该周几且时刻未到 → 就是今天（第一节早八在早上七点上传，当天就该响）。
 */
export function computeNextWeeklyRunAt(input: {
  weekday: number;
  startMinutes: number;
  now: Date;
  timezone: string;
}): string {
  const { weekday, startMinutes, now, timezone } = input;
  const { year, month, day } = localDateParts(now, timezone);
  const todayIso = isoWeekdayOf(year, month, day);

  let deltaDays = ((weekday - todayIso) % 7 + 7) % 7;
  if (deltaDays === 0) {
    // 今天的这一节已开始过 → 排到下周同一时刻，避免把 runAt 落在过去
    const nowMinutes = localMinuteOfDay(now, timezone);
    if (nowMinutes >= startMinutes - 5) deltaDays = 7;
  }

  const baseUtc = Date.UTC(year, month - 1, day) + deltaDays * 86_400_000;
  const target = new Date(baseUtc);
  const ymd = `${target.getUTCFullYear()}-${pad2(target.getUTCMonth() + 1)}-${pad2(target.getUTCDate())}`;
  const hour = Math.floor(startMinutes / 60);
  const minute = startMinutes % 60;
  return `${ymd}T${pad2(hour)}:${pad2(minute)}:00`;
}

/** 单节课时长：n 节 45 分钟 + (n-1) 个课间。 */
export function estimateDurationMinutes(periods: number[]): number {
  if (periods.length === 0) return 0;
  return periods.length * PERIOD_LENGTH_MINUTES + (periods.length - 1) * PERIOD_GAP_MINUTES;
}

function formatPeriods(periods: number[]): string {
  if (periods.length === 0) return "";
  if (periods.length === 1) return `第${periods[0]}节`;
  return `第${periods[0]}-${periods[periods.length - 1]}节`;
}

/** 描述文案：把"哪些是推算的"直接写进用户能改的地方，不留静默假设。 */
function buildClassDescription(item: IngestItem, startMinutes: number, sourceLabel?: string): string {
  const parts: string[] = [];
  const periods = item.weeklySlot?.periods ?? [];
  const startText = `${pad2(Math.floor(startMinutes / 60))}:${pad2(startMinutes % 60)}`;
  if (periods.length > 0) {
    parts.push(
      `${formatPeriods(periods)}，按默认作息 ${startText} 开始（每节 ${PERIOD_LENGTH_MINUTES} 分钟、课间 ${PERIOD_GAP_MINUTES} 分钟）`,
    );
  }
  parts.push("如与你学校的作息不符，直接改这条日程的时间即可");
  const weeks = item.weeklySlot?.weeks?.trim();
  if (weeks) {
    if (/单周|双周/.test(weeks)) {
      parts.push(`注意：该课为${weeks}，日程按每周提醒，单双周需要手动调整`);
    } else {
      parts.push(`周次：${weeks}`);
    }
  }
  if (sourceLabel) parts.push(`来源：${sourceLabel}`);
  return parts.join("；");
}

/**
 * 把 class 条目物化成日程。
 *
 * 幂等键是 `sourceRefId = ingest:<item.key>`：重传同一门课（换教室、改标题）
 * 会更新同一条日程，而不是再建一条。
 *
 * **已知边界（不假装支持）**：条目 key 含「周几 + 节次」，所以**改了上课时段**
 * 会被当成另一条（旧的仍在，需自行删）。这是有意的取舍——一门课一周上两次
 * （周一 1-2 节 + 周三 5-6 节）必须分成两条，把节次从 key 里拿掉就会互相覆盖。
 * 正确的"带节次迁移"需要日程服务支持改写 sourceRefId，未做。
 */
export async function materializeIngestedClasses(
  items: IngestItem[],
  schedule: IngestSchedulePort | null | undefined,
  ctx: IngestMaterializeContext,
): Promise<IngestMaterializeResult> {
  const result: IngestMaterializeResult = { created: 0, updated: 0, taskIds: {}, skipped: [] };
  if (!schedule) return result;

  for (const item of items) {
    if (item.kind !== "class") continue;

    const refId = `ingest:${item.key}`;
    const periods = item.weeklySlot?.periods ?? [];
    const absoluteStart = item.startsAt && Number.isFinite(Date.parse(item.startsAt)) ? item.startsAt : null;

    // 有绝对时刻的课（"10月20日 08:00 高数"）优先用绝对时刻，单次即可
    let runAt: string;
    let recurrence: "none" | "weekly";
    let durationMinutes: number | undefined;
    let description: string;

    if (absoluteStart) {
      runAt = absoluteStart;
      recurrence = "none";
      durationMinutes = item.durationMinutes;
      description = [item.evidence ? `${item.evidence}` : "", "来自上传的数据"]
        .filter(Boolean)
        .join("；");
    } else if (periods.length > 0) {
      const startMinutes = DEFAULT_PERIOD_START_MINUTES[periods[0]];
      if (startMinutes == null) {
        result.skipped.push({
          key: item.key,
          title: item.title,
          reason: `第${periods[0]}节超出默认作息表（支持 1-12 节）`,
        });
        continue;
      }
      const weekday = item.weeklySlot?.weekday;
      if (!weekday || weekday < 1 || weekday > 7) {
        result.skipped.push({ key: item.key, title: item.title, reason: "课表缺周几，无法排期" });
        continue;
      }
      runAt = computeNextWeeklyRunAt({
        weekday,
        startMinutes,
        now: ctx.now,
        timezone: ctx.timezone,
      });
      recurrence = "weekly";
      durationMinutes = estimateDurationMinutes(periods);
      description = buildClassDescription(item, startMinutes);
    } else {
      // 既没有绝对时刻也没有节次：排不了期。如实记下来，由调用方汇总告诉用户。
      result.skipped.push({
        key: item.key,
        title: item.title,
        reason: "没有节次也没有具体时间，排不了日程",
      });
      continue;
    }

    const title = item.title;
    const shortTitle = title.length > 12 ? `${title.slice(0, 12)}…` : title;
    const existing = schedule.findTaskBySourceRefId(refId);
    try {
      if (existing) {
        await schedule.updateTask(existing.taskId, {
          title,
          shortTitle,
          description,
          recurrence,
          runAt,
          timezone: ctx.timezone,
          durationMinutes,
          location: item.location,
        });
        result.updated += 1;
        result.taskIds[item.key] = existing.taskId;
      } else {
        const created = await schedule.createTask({
          sessionId: ctx.sessionId,
          title,
          shortTitle,
          description,
          kind: "reminder",
          category: "itinerary",
          runAt,
          recurrence,
          timezone: ctx.timezone,
          durationMinutes,
          location: item.location,
          // 到点弹的那句话：课名 + 地点，别写成时间回声
          reminderMessage: item.location ? `${title} 上课（${item.location}）` : `${title} 上课`,
          remindBeforeMinutes: CLASS_REMIND_BEFORE_MINUTES,
          source: "ingest",
          sourceRefId: refId,
        });
        result.created += 1;
        result.taskIds[item.key] = created.taskId;
      }
    } catch (error) {
      // 单条失败不拖垮整批：其余课照常物化，失败的那门如实上报
      result.skipped.push({
        key: item.key,
        title: item.title,
        reason: `写入日程失败：${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  return result;
}

/** 撤销课表对应的日程（用户从台账删条目时调用），按 key 反查，不猜标题。 */
export async function removeIngestedClassSchedules(
  keys: string[],
  schedule: IngestSchedulePort | null | undefined,
): Promise<number> {
  if (!schedule) return 0;
  let removed = 0;
  for (const key of keys) {
    const existing = schedule.findTaskBySourceRefId(`ingest:${key}`);
    if (!existing) continue;
    try {
      await schedule.deleteTask(existing.taskId);
      removed += 1;
    } catch {
      // 已被用户手动删掉的日程：忽略（目标状态已达成）
    }
  }
  return removed;
}
