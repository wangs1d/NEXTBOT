import { getDataDir } from "../config/data-dir.js";
import { randomUUID } from "crypto";
import { lookup } from "dns/promises";
import { mkdir, readFile, writeFile } from "fs/promises";
import { isIP } from "net";
import { dirname, join } from "path";

import { buildReminderPolicy, type ScheduleHabitHints, type SchedulePreReminder } from "./schedule-reminder-policy.js";
import { extractReminderSubject, formatReminderMessage, isEchoLikeReminderCopy } from "./reminder-copy.js";
import type { RouteEstimate } from "./route-duration-service.js";
import { taskHasOccurrenceInRange } from "./schedule-recurrence-expand.js";

export type ScheduleRecurrence = "none" | "daily" | "weekly" | "yearly" | "cron";
export type ScheduleTaskKind = "reminder" | "action" | "weather_brief" | "agent_task";
export type ScheduleTaskStatus = "active" | "paused" | "completed" | "cancelled" | "failed";
export type ScheduleRunStatus = "success" | "failed" | "missed";

/**
 * 任务分类：itinerary=行程/正事（会议、约会、截止等，进「今日安排」展示）；
 * trivia=生活琐事提醒（喝水、睡觉、活动身体等，只做后台到点提醒，不进「今日安排」）。
 * 缺省（含旧数据）按 itinerary 处理，保证展示兜底。
 */
export type ScheduleTaskCategory = "itinerary" | "trivia";

/** 节律任务标记前缀（care.rhythm_reminder 写入 description；旧数据无 category 时的兜底识别） */
export const RHYTHM_MARK = "[节律提醒:";

/** 宽松解析外部输入（工具参数/HTTP body）中的分类字段，非法值回退 undefined（=按 itinerary 展示）。 */
export function parseScheduleTaskCategory(value: unknown): ScheduleTaskCategory | undefined {
  const v = String(value ?? "").trim();
  return v === "itinerary" || v === "trivia" ? v : undefined;
}

/** 是否为「仅后台提醒、不进今日安排」的任务：显式 trivia 分类，或旧数据带节律标记。 */
export function isTriviaTask(
  task: Pick<ScheduleTaskRecord, "category" | "description">,
): boolean {
  return task.category === "trivia" || task.description.startsWith(RHYTHM_MARK);
}

export type ScheduleActionConfig = {
  url: string;
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  headers?: Record<string, string>;
  body?: unknown;
};

export type ScheduleAgentTaskConfig = {
  prompt: string;
  accessMode?: "sandbox" | "full";
};

export type ScheduleTaskRecord = {
  taskId: string;
  sessionId: string;
  title?: string;
  /** 简洁展示标题（用于「今日安排」等紧凑列表，创建时由 LLM 在同一个调用里生成，区别于完整 title / reminderMessage） */
  shortTitle?: string;
  description: string;
  kind: ScheduleTaskKind;
  category?: ScheduleTaskCategory;
  recurrence: ScheduleRecurrence;
  timezone: string;
  runAt: string;
  nextRunAt: string | null;
  cronExpression?: string;
  webhookToken?: string;
  status: ScheduleTaskStatus;
  reminderMessage?: string;
  action?: ScheduleActionConfig;
  agentTask?: ScheduleAgentTaskConfig;
  /** 连续失败计数（成功清零）：重试退避与死信停摆的判定依据 */
  consecutiveFailures?: number;
  /** 最近一次失败摘要（退避展示与死信通知用） */
  lastError?: string;
  /** 事件时长（分钟）；0/缺省 = 时间点提醒（无区间）。用于冲突检测与「今日安排」区间展示。 */
  durationMinutes?: number;
  /** 提前量提醒（分钟数组，如 [15,5]）：到点前按各偏移各推一次，主触发前不打断。 */
  remindBeforeMinutes?: number[];
  /** 事件地点（如「协和医院」「首都机场T3」）：提醒策略层据此估算路程并安排出发预留。 */
  location?: string;
  /** 分级提醒脚本（提醒策略层写入，与 remindBeforeMinutes 按偏移一一对应；显式设置提前量时清除）。 */
  preReminders?: SchedulePreReminder[];
  /** 生成当前分段计划的因子指纹（如 "high/mid"），改期重算判定与排查用。 */
  reminderPolicy?: string;
  /** 来源标记：manual=用户/LLM 直建；booking=预订下单联动；commitment=承诺板物化；ics=日历订阅导入；email=票务邮件提取。 */
  source?: "manual" | "booking" | "commitment" | "ics" | "email" | "ingest";
  /** 关联的本地预订订单号（source=booking 时写入，用于取消/改期反向同步）。 */
  sourceBookingOrderId?: string;
  /** 关联的外部引用 id（source=commitment 时为承诺 id；source=ics 时为「uid/occurrenceStartMs」事件键），用于反向同步。 */
  sourceRefId?: string;
  /** 本次待触发周期内已发出的提前提醒偏移（主触发后重置）。 */
  firedPreReminderOffsets?: number[];
  createdAt: string;
  updatedAt: string;
  lastRunAt?: string;
};

export type ScheduleTaskRun = {
  runId: string;
  taskId: string;
  plannedAt: string;
  startedAt: string;
  endedAt: string;
  status: ScheduleRunStatus;
  output?: unknown;
  error?: string;
};

type PersistedScheduleState = {
  tasks?: ScheduleTaskRecord[];
  runs?: ScheduleTaskRun[];
};

export type CreateScheduleTaskInput = {
  sessionId: string;
  title?: string;
  shortTitle?: string;
  description: string;
  kind: ScheduleTaskKind;
  category?: ScheduleTaskCategory;
  runAt?: string;
  recurrence: ScheduleRecurrence;
  timezone?: string;
  cronExpression?: string;
  webhookToken?: string;
  reminderMessage?: string;
  action?: ScheduleActionConfig;
  agentTask?: ScheduleAgentTaskConfig;
  durationMinutes?: number;
  remindBeforeMinutes?: number[];
  location?: string;
  source?: "manual" | "booking" | "commitment" | "ics" | "email" | "ingest";
  sourceBookingOrderId?: string;
  sourceRefId?: string;
};

export type UpdateScheduleTaskInput = {
  title?: string;
  shortTitle?: string;
  description?: string;
  category?: ScheduleTaskCategory;
  recurrence?: ScheduleRecurrence;
  runAt?: string;
  timezone?: string;
  cronExpression?: string | null;
  webhookToken?: string | null;
  reminderMessage?: string;
  action?: ScheduleActionConfig;
  agentTask?: ScheduleAgentTaskConfig;
  durationMinutes?: number;
  remindBeforeMinutes?: number[];
  location?: string;
  status?: Extract<ScheduleTaskStatus, "active" | "paused" | "cancelled">;
};

export type WeatherBriefHandler = (task: ScheduleTaskRecord) => Promise<Record<string, unknown>>;

/**
 * 提醒触达上下文：
 *   - preReminder：提前量分段提醒（睡前备忘/起床闹钟/该出门了…）。语义是「预告」，
 *     客户端走轻触达（灵动岛），不走到点弹窗；
 *   - 缺省（到点）：任务到点时的一次提醒，客户端走到点弹窗（桌面原生玻璃卡）。
 */
export type ScheduleReminderOptions = { preReminder?: boolean };

export type ScheduleReminderHandler = (
  task: ScheduleTaskRecord,
  message: string,
  options?: ScheduleReminderOptions,
) => Promise<void>;

export type AgentTaskHandler = (task: ScheduleTaskRecord) => Promise<Record<string, unknown>>;
export type ScheduleTaskChangeAction = "created" | "updated" | "deleted";
export type ScheduleTaskChangeHandler = (
  action: ScheduleTaskChangeAction,
  task: ScheduleTaskRecord,
) => void | Promise<void>;

/** 宽松解析时长（分钟）：非法/越界回退 undefined；0 视为无区间。 */
export function normalizeDurationMinutes(value: unknown): number | undefined {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.min(Math.round(n), 24 * 60 * 7);
}

/** 宽松解析提前量数组（分钟）：过滤非法值、去重、倒序（大偏移在前），最多 5 个。 */
export function normalizeRemindBeforeMinutes(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const seen = new Set<number>();
  for (const raw of value.slice(0, 5)) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0 && n <= 24 * 60 * 7) seen.add(Math.round(n));
  }
  if (seen.size === 0) return undefined;
  return [...seen].sort((a, b) => b - a);
}

/** 任务在给定起点时刻的结束时刻（UTC ms）；无 durationMinutes 时 = 起点（零长区间）。 */
export function taskEndMs(startMs: number, durationMinutes?: number): number {
  return startMs + (durationMinutes && durationMinutes > 0 ? durationMinutes : 0) * 60_000;
}

/**
 * 分级提醒策略的适用面：单次提醒类正事。承诺物化由承诺板管梯度提醒
 * （双响治理定调见 commitment-schedule-outlet.ts）。
 * ics 日历事件原被排除（「外部日历自带提醒」），但事件本身并无提醒数据——
 * 岛的提前预示此前靠客户端关键词 Timer 撑着；该客户端调度器已按
 * 「提醒统一信服务端」定调（2026-10-05）删除，ics 纳入本策略补位。
 */
function isReminderPolicyEligible(
  task: Pick<
    ScheduleTaskRecord,
    "kind" | "recurrence" | "category" | "source" | "status"
  >,
): boolean {
  return (
    task.kind === "reminder" &&
    task.recurrence === "none" &&
    task.status === "active" &&
    task.category !== "trivia" &&
    task.source !== "commitment"
  );
}

/**
 * 同一次创建意图的 runAt 锚点容差：程序层确定性创建与模型工具调用解析的是同一句
 * 用户原话，锚点差异只会来自毫秒级解析抖动，超过该值即视为两次独立创建。
 */
const DUPLICATE_RUN_AT_TOLERANCE_MS = 60_000;
/** 失败重试退避：60s 起步指数退避，封顶 30min（agent_task 每次重试都是完整 LLM 回合） */
const RETRY_BACKOFF_BASE_MS = 60_000;
const RETRY_BACKOFF_MAX_MS = 30 * 60_000;
/** 连续失败达到该次数 → 死信停摆（status=failed 停止调度 + 一次性通知），env 可调 */
const DEAD_LETTER_AFTER_FAILURES = Math.max(
  1,
  Number.parseInt(process.env.SCHEDULE_TASK_MAX_CONSECUTIVE_FAILURES ?? "", 10) || 5,
);

/**
 * 补发（catch-up）判定：runtime 离线跨过触发点后，tick 在重启时会补执行到期的任务。
 * 实际执行晚于计划时间超过该阈值（默认 5 分钟）即视为补发，而非准点触发——
 * 提醒文案带【补发】前缀、agent_task 注入补发语境，避免把迟到的推送当成准点交付。
 */
const CATCHUP_MIN_LAG_MS =
  Math.max(
    1,
    Number.parseInt(process.env.SCHEDULE_TASK_CATCHUP_MIN_LAG_MINUTES ?? "", 10) || 5,
  ) * 60_000;

/**
 * 补发窗口：晚于计划时间超过该值（默认 24 小时）的到期任务不再执行，
 * 记 status=missed 的 run 并一次性通知用户——陈年任务静默补发比不补发更吓人。
 */
const CATCHUP_MAX_LAG_MS = (() => {
  const hours = Number.parseInt(process.env.SCHEDULE_TASK_CATCHUP_MAX_LAG_HOURS ?? "", 10) || 24;
  return Math.max(CATCHUP_MIN_LAG_MS, hours * 3_600_000);
})();

/** 内容归一化：去全部空白 + 小写，跨创建路径（程序层/工具/HTTP）对同一句话稳定可比。 */
function normalizeScheduleContent(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase().replace(/\s+/g, "");
}

/**
 * 出发段升档容忍带（分钟）：出发段本就设计在「剩余时间≈路程」的时刻触发，
 * 升档只针对「实时路程显著恶化或触发已迟到」——实时路程超过 剩余时间+容忍带
 * 才升档到点弹窗，准点触发（剩余≈路程）永远走轻触达。容忍带吸收 tick 间隔
 * 与路况小幅波动。
 */
const DEPART_ESCALATE_SLACK_MIN = 5;

/**
 * 日程服务装配选项。
 *
 * `now` 是**统一时间源**：调度链路里所有「当前时间」（未来时间闸、补发判定、
 * 退避基准、周期推进基准）都必须走它，禁止直接 `Date.now()`。
 * 教训：注入了冻结时钟的测试，一旦服务内部偷读真实时钟，真实时间越过 fixture
 * 日期后就会集体失效（时间炸弹）——表现为「不物化 / 预算 spent=0」这类
 * 看似功能缺失、实为时基不一致的失败。
 */
export type ScheduleTaskServiceOptions = {
  /** 时间源注入（测试/回放用）；缺省读真实时钟。 */
  now?: () => Date;
  /**
   * 持久化路径。**构造时快照**，服务生命周期内不再变化。
   *
   * 为什么不在每次 persist 时读 `SCHEDULE_TASKS_FILE`：测试会连续创建多个实例
   * 并各自换目录，残留实例的异步 persist 会跟着新的 env 写到**下一个测试**的
   * 文件上，两个实例并发写同一路径，Windows 上直接 `EPERM`（表现为随机红灯）。
   * 路径本就该是实例的属性，不是进程的全局状态。
   */
  persistPath?: string;
};

/**
 * 提醒展示文案契约（落库闸口，2026-10-21 根修「的11点03分提醒我吃饭」类回声）：
 * shortTitle/reminderMessage 是展示文案，不是原句回声。模型自己填的字段
 * （reminder.plan 的 structured 分支、calendar.create_task 直填、HTTP 直写）
 * 不经解析服务，全在此统一过检——含时间词/「提醒我」类指令词/悬空助词开头/
 * 超长短标题即视为解析污染，从 description 重推导干净文案。
 */
function normalizeReminderDisplayCopy(
  kind: ScheduleTaskKind,
  description: string,
  shortTitle: string | undefined,
  reminderMessage: string | undefined,
  source?: ScheduleTaskRecord["source"],
): { shortTitle?: string; reminderMessage?: string } {
  if (kind !== "reminder") {
    return { shortTitle: shortTitle?.trim() || undefined };
  }
  // 非手动来源（承诺/ics/邮件/预订）有各自的确定性文案生成器，不是模型回声，不动。
  if (source && source !== "manual") {
    return {
      shortTitle: shortTitle?.trim() || undefined,
      reminderMessage: reminderMessage?.trim() || undefined,
    };
  }
  const short = shortTitle?.trim() ?? "";
  const message = reminderMessage?.trim() ?? "";
  const subject = extractReminderSubject(description ?? "");
  const shortBad = !short || short.length > 16 || isEchoLikeReminderCopy(short);
  const msgBad = !message || isEchoLikeReminderCopy(message);
  return {
    // 短标题回退拿不到干净事项词时宁缺毋滥（今日安排走展示端剥离简化）
    shortTitle: shortBad ? (subject === "到点提醒" ? undefined : subject) : short,
    // 只拦回声（原句/半截原句），从原句重推导「该X啦」约定文案；干净文案
    // 原样放行——无条件包装会把「睡觉了」「吃药时间到」改成「该睡觉了啦」类垃圾。
    reminderMessage: msgBad ? formatReminderMessage(subject) : message || undefined,
  };
}

export class ScheduleTaskService {
  private readonly byTaskId = new Map<string, ScheduleTaskRecord>();
  private readonly runsByTaskId = new Map<string, ScheduleTaskRun[]>();
  private readonly runningTaskIds = new Set<string>();
  /** 统一时间源（见 ScheduleTaskServiceOptions）。 */
  private readonly clock: () => Date;
  /** 持久化路径（构造时快照，见 ScheduleTaskServiceOptions.persistPath）。 */
  private readonly persistPathValue: string;
  private tickHandle: NodeJS.Timeout | undefined;
  private weatherBriefHandler?: WeatherBriefHandler;
  private reminderHandler?: ScheduleReminderHandler;
  private agentTaskHandler?: AgentTaskHandler;
  private taskChangeHandler?: ScheduleTaskChangeHandler;
  /** 死信通知（进入 status=failed 时调用一次；bootstrap 接 proactivityHub 主动告知用户） */
  private taskDeadLetterHandler?: (task: ScheduleTaskRecord) => void;
  /** 超窗未补发通知（到期任务超过补发窗口被记 missed 时调用一次） */
  private taskMissedHandler?: (task: ScheduleTaskRecord, plannedAt: string) => void;
  /**
   * 用户作息画像提供方（agent 对用户习惯的了解，bootstrap 接睡眠样本链/节律画像）：
   * 分级提醒策略据此个性化睡前备忘与起床闹钟；返回 null/样本不足时策略层走默认值。
   */
  private reminderHabitProvider?: (sessionId: string) => ScheduleHabitHints | null | undefined;
  /**
   * 真实路程估算器（bootstrap 接 route-duration-service + 位置信源）：
   * 分级提醒策略的出发预留据此按「用户当前位置 × 目的地」的真实路程算，
   * 失败/无注入回退 venue 静态表。实现方自行兜时限，不阻塞创建主链路。
   */
  private routeEstimator?: (input: {
    sessionId: string;
    location: string;
  }) => Promise<RouteEstimate | null>;

  constructor(options: ScheduleTaskServiceOptions = {}) {
    this.clock = options.now ?? (() => new Date());
    // 路径在构造时就定死（见 ScheduleTaskServiceOptions.persistPath 的说明）
    this.persistPathValue =
      options.persistPath?.trim() ||
      process.env.SCHEDULE_TASKS_FILE?.trim() ||
      join(getDataDir(), "schedule-tasks.json");
  }

  /** 当前时间（统一时间源，禁止在本类里直接使用 Date.now()）。 */
  private now(): Date {
    return this.clock();
  }

  setRouteEstimator(
    estimator:
      | ((input: { sessionId: string; location: string }) => Promise<RouteEstimate | null>)
      | undefined,
  ): void {
    this.routeEstimator = estimator;
  }

  setReminderHabitProvider(
    provider: ((sessionId: string) => ScheduleHabitHints | null | undefined) | undefined,
  ): void {
    this.reminderHabitProvider = provider;
  }

  private habitHintsFor(sessionId: string): ScheduleHabitHints | null {
    try {
      return this.reminderHabitProvider?.(sessionId) ?? null;
    } catch {
      return null; // 画像读取失败不挡创建主链路
    }
  }

  setTaskDeadLetterHandler(handler: (task: ScheduleTaskRecord) => void): void {
    this.taskDeadLetterHandler = handler;
  }

  setTaskMissedHandler(handler: ((task: ScheduleTaskRecord, plannedAt: string) => void) | undefined): void {
    this.taskMissedHandler = handler;
  }

  private get persistPath(): string {
    return this.persistPathValue;
  }

  setWeatherBriefHandler(handler: WeatherBriefHandler | undefined): void {
    this.weatherBriefHandler = handler;
  }

  setReminderHandler(handler: ScheduleReminderHandler | undefined): void {
    this.reminderHandler = handler;
  }

  setAgentTaskHandler(handler: AgentTaskHandler | undefined): void {
    this.agentTaskHandler = handler;
  }

  setTaskChangeHandler(handler: ScheduleTaskChangeHandler | undefined): void {
    this.taskChangeHandler = handler;
  }

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.persistPath, "utf8");
      const data = JSON.parse(raw) as PersistedScheduleState;
      this.byTaskId.clear();
      this.runsByTaskId.clear();
      for (const task of data.tasks ?? []) {
        if (task?.taskId && task?.sessionId) {
          this.byTaskId.set(task.taskId, task);
        }
      }
      for (const run of data.runs ?? []) {
        if (!run?.taskId || !run?.runId) continue;
        const list = this.runsByTaskId.get(run.taskId) ?? [];
        list.push(run);
        this.runsByTaskId.set(run.taskId, list);
      }
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === "ENOENT") return;
      throw e;
    }
  }

  startScheduler(): void {
    if (this.tickHandle) return;
    this.tickHandle = setInterval(() => {
      void this.tick();
    }, 1000);
  }

  /** 手动驱动一次调度扫描（与 interval tick 同一条路径；管理操作/测试用）。 */
  async runSchedulerTick(): Promise<void> {
    await this.tick();
  }

  stopScheduler(): void {
    if (!this.tickHandle) return;
    clearInterval(this.tickHandle);
    this.tickHandle = undefined;
  }

  async persist(): Promise<void> {
    const dir = dirname(this.persistPath);
    await mkdir(dir, { recursive: true });
    const tasks = Array.from(this.byTaskId.values());
    const runs = Array.from(this.runsByTaskId.values()).flat();
    const payload = JSON.stringify({ tasks, runs }, null, 2);
    // Windows 上目标文件可能被短暂占用（杀毒扫描、索引、另一个实例正在读）→
    // EPERM/EBUSY。这类占用是毫秒级的，直接抛会让调用方以为"日程没存上"，
    // 所以有限重试；仍失败才如实抛出（不能让调用方以为写成功了）。
    for (let attempt = 0; ; attempt += 1) {
      try {
        await writeFile(this.persistPath, payload, "utf8");
        return;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        const retriable =
          code === "EPERM" || code === "EBUSY" || code === "EACCES" || code === "EAGAIN";
        if (!retriable || attempt >= 4) throw error;
        await new Promise((resolve) => setTimeout(resolve, 20 * (attempt + 1)));
      }
    }
  }

  /** 全量任务列表（跨会话；UpcomingScheduleWatcher 临近日程扫描用） */
  listAllTasks(): ScheduleTaskRecord[] {
    return Array.from(this.byTaskId.values());
  }

  listTasksBySession(
    sessionId: string,
    range?: { from?: string; to?: string },
  ): ScheduleTaskRecord[] {
    const now = this.now().getTime();
    const from = range?.from ? new Date(range.from).getTime() : now;
    const hasExplicitTo = !!range?.to;
    // 非周期任务沿用原行为：未给 to → +∞（列出所有未来单次任务）
    const toForSingle = hasExplicitTo ? new Date(range!.to!).getTime() : Number.POSITIVE_INFINITY;
    // 周期任务展开需要有限上界，避免 expandTaskOccurrenceTimes 无限循环；未指定时默认查 7 天
    const toForRecurring = hasExplicitTo
      ? new Date(range!.to!).getTime()
      : now + 7 * 24 * 60 * 60 * 1000;
    return Array.from(this.byTaskId.values())
      .filter((task) => task.sessionId === sessionId)
      .filter((task) => {
        if (task.status === "cancelled") return false;
        // 周期任务（daily/weekly/yearly）：用展开器检查区间内是否有任何实例
        if (task.recurrence !== "none") {
          return taskHasOccurrenceInRange(task, from, toForRecurring);
        }
        const relevantAt =
          task.status === "completed"
            ? task.lastRunAt ?? task.runAt
            : (task.nextRunAt ?? task.runAt);
        const relevantTime = new Date(relevantAt).getTime();
        return Number.isFinite(relevantTime) && relevantTime >= from && relevantTime <= toForSingle;
      })
      .sort((a, b) =>
        (a.status === "completed" ? (a.lastRunAt ?? a.runAt) : (a.nextRunAt ?? a.runAt)).localeCompare(
          b.status === "completed" ? (b.lastRunAt ?? b.runAt) : (b.nextRunAt ?? b.runAt),
        ),
      );
  }

  listRuns(taskId: string, limit = 20): ScheduleTaskRun[] {
    const list = this.runsByTaskId.get(taskId) ?? [];
    return [...list].sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, limit);
  }

  getTask(taskId: string): ScheduleTaskRecord | undefined {
    return this.byTaskId.get(taskId);
  }

  /** 按关联预订订单号查找未结束的日程（预订取消/改期反向同步用）。 */
  findTaskByBookingOrderId(orderId: string): ScheduleTaskRecord | undefined {
    const id = orderId.trim();
    if (!id) return undefined;
    for (const task of this.byTaskId.values()) {
      if (task.sourceBookingOrderId === id && task.status !== "cancelled") return task;
    }
    return undefined;
  }

  /** 按外部引用 id 查找未取消的日程（承诺物化/ICS 订阅反向同步用）。 */
  findTaskBySourceRefId(refId: string): ScheduleTaskRecord | undefined {
    const id = refId.trim();
    if (!id) return undefined;
    for (const task of this.byTaskId.values()) {
      if (task.sourceRefId === id && task.status !== "cancelled") return task;
    }
    return undefined;
  }

  async deleteTask(taskId: string): Promise<void> {
    const task = this.byTaskId.get(taskId);
    if (!task) {
      throw new Error("task not found");
    }
    this.byTaskId.delete(taskId);
    this.runsByTaskId.delete(taskId);
    await this.persist();
    await this.emitTaskChange("deleted", task);
  }

  /**
   * 活动任务重复检测（幂等创建的判定核心）：同会话 + 同类型 + 同归一化内容 +
   * 同时间签名（时区/重复规则/cron/runAt 锚点）的 active/paused 任务已存在时，
   * 判定为同一次创建意图的多路径重放——程序层确定性创建、模型工具调用
   * （reminder.plan / calendar.create_*）、客户端断线重发、HTTP 直写都从这里落库，
   * 只有第一次真实创建，后续一律返回已有任务。已结束（completed/cancelled）的
   * 任务不参与判定：用户稍后重设同名同刻的提醒必须能成功。
   */
  private findActiveDuplicate(
    input: CreateScheduleTaskInput,
    incomingCopy: { shortTitle?: string; reminderMessage?: string },
    schedule: { recurrence: ScheduleRecurrence; runAt: string; cronExpression?: string },
    timezone: string,
  ): ScheduleTaskRecord | undefined {
    const description = normalizeScheduleContent(input.description);
    const reminderMessage = normalizeScheduleContent(
      incomingCopy.reminderMessage ?? input.description,
    );
    const runAtMs = Date.parse(schedule.runAt);
    for (const task of this.byTaskId.values()) {
      if (task.sessionId !== input.sessionId || task.kind !== input.kind) continue;
      if (task.status !== "active" && task.status !== "paused") continue;
      if (normalizeScheduleContent(task.description) !== description) continue;
      // 存量任务按同一文案契约规整后参与比较：签名必须与落库值同源，
      // 否则闸口改写（回声文案重推导）会让同内容重放在签名上错位。
      const taskCopy = normalizeReminderDisplayCopy(
        task.kind,
        task.description,
        task.shortTitle,
        task.reminderMessage,
        task.source,
      );
      if (
        normalizeScheduleContent(taskCopy.reminderMessage ?? task.description) !==
        reminderMessage
      ) {
        continue;
      }
      if (task.timezone !== timezone || task.recurrence !== schedule.recurrence) continue;
      if (schedule.recurrence === "cron") {
        // cron 任务的签名就是表达式本身（runAt 是随创建时刻浮动的下次触发点）。
        if ((task.cronExpression ?? "") !== (schedule.cronExpression ?? "")) continue;
        return task;
      }
      const taskRunAtMs = Date.parse(task.runAt);
      if (
        Number.isFinite(runAtMs) &&
        Number.isFinite(taskRunAtMs) &&
        Math.abs(taskRunAtMs - runAtMs) <= DUPLICATE_RUN_AT_TOLERANCE_MS
      ) {
        return task;
      }
    }
    return undefined;
  }

  async createTask(input: CreateScheduleTaskInput): Promise<ScheduleTaskRecord> {
    const tz = input.timezone?.trim() || "Asia/Shanghai";
    const schedule = this.resolveSchedule(input.runAt, input.recurrence, tz, input.cronExpression);
    const now = this.now().toISOString();
    this.validateKindPayload(input.kind, input.reminderMessage, input.action, input.agentTask);
    // 文案契约先归一再判重：幂等签名与落库值同源（见 findActiveDuplicate 注释）。
    const copy = normalizeReminderDisplayCopy(
      input.kind,
      input.description,
      input.shortTitle,
      input.reminderMessage,
      input.source,
    );
    // 幂等创建：命中重复时直接返回已有任务，不插入、不持久化、不广播 tasks_changed
    //（客户端本地镜像按 taskId 幂等，旧广播已存在，无需再发）。
    const duplicate = this.findActiveDuplicate(input, copy, schedule, tz);
    if (duplicate) return duplicate;
    const task: ScheduleTaskRecord = {
      taskId: randomUUID(),
      sessionId: input.sessionId,
      title: input.title?.trim() || undefined,
      shortTitle: copy.shortTitle,
      description: input.description.trim(),
      kind: input.kind,
      category: input.category,
      recurrence: schedule.recurrence,
      timezone: tz,
      runAt: schedule.runAt,
      nextRunAt: schedule.nextRunAt,
      cronExpression: schedule.cronExpression,
      webhookToken: this.normalizeWebhookToken(input.webhookToken),
      status: "active",
      reminderMessage: copy.reminderMessage,
      action: input.action,
      agentTask: input.agentTask,
      durationMinutes: normalizeDurationMinutes(input.durationMinutes),
      remindBeforeMinutes: normalizeRemindBeforeMinutes(input.remindBeforeMinutes),
      location: input.location?.trim() || undefined,
      source: input.source,
      sourceBookingOrderId: input.sourceBookingOrderId?.trim() || undefined,
      sourceRefId: input.sourceRefId?.trim() || undefined,
      createdAt: now,
      updatedAt: now,
    };
    await this.applyReminderPolicyOnCreate(task, input);
    this.byTaskId.set(task.taskId, task);
    await this.persist();
    await this.emitTaskChange("created", task);
    return task;
  }

  /**
   * 真实路程因子解析：任务带地点线索且注入了估算器时，取「用户当前位置 ×
   * 目的地」的驾车估时；失败/无注入返回 null，策略层回退 venue 静态表。
   * 估算器实现方自带时限，这里再兜一层异常——路程估时永远不挡创建主链路。
   */
  private async routeFactorFor(sessionId: string, location: string | undefined): Promise<RouteEstimate | null> {
    const dest = location?.trim();
    if (!dest || !this.routeEstimator) return null;
    try {
      const estimate = await this.routeEstimator({ sessionId, location: dest });
      if (estimate && estimate.durationMin > 0) return estimate;
    } catch {
      // 路程估时失败不挡创建
    }
    return null;
  }

  /**
   * 分级提醒策略（schedule-reminder-policy.ts）：用户没显式给提前量时，按事件
   * 时间/重要程度/地点动态生成前晚备忘/起床闹钟/出发预留的分段计划。
   * 显式 remindBeforeMinutes 优先（用户自己说了提前量），ics/commitment 上游
   * 各有提醒分工不进策略层，trivia/周期任务不做分级。
   */
  private async applyReminderPolicyOnCreate(task: ScheduleTaskRecord, input: CreateScheduleTaskInput): Promise<void> {
    if (input.remindBeforeMinutes != null) return;
    if (!isReminderPolicyEligible(task)) return;
    const route = await this.routeFactorFor(task.sessionId, task.location);
    const plan = buildReminderPolicy({
      runAt: task.runAt,
      timezone: task.timezone,
      description: task.description,
      reminderMessage: task.reminderMessage,
      location: task.location,
      source: task.source,
      habits: this.habitHintsFor(task.sessionId),
      ...(route
        ? { travelMinutesOverride: route.durationMin, routeSource: route.source }
        : {}),
    });
    if (!plan) return;
    task.remindBeforeMinutes = plan.remindBeforeMinutes;
    task.preReminders = plan.preReminders;
    task.reminderPolicy = plan.policyName;
  }

  async updateTask(taskId: string, input: UpdateScheduleTaskInput): Promise<ScheduleTaskRecord> {
    const task = this.byTaskId.get(taskId);
    if (!task) {
      throw new Error("task not found");
    }
    if (task.status === "completed" || task.status === "cancelled") {
      throw new Error("task already ended");
    }
    const next: ScheduleTaskRecord = {
      ...task,
      title: input.title?.trim() || task.title,
      shortTitle: input.shortTitle?.trim() || task.shortTitle,
      description: input.description?.trim() || task.description,
      category: input.category ?? task.category,
      recurrence: input.recurrence ?? task.recurrence,
      timezone: input.timezone?.trim() || task.timezone,
      cronExpression:
        input.cronExpression === undefined
          ? task.cronExpression
          : (input.cronExpression?.trim() || undefined),
      webhookToken:
        input.webhookToken === undefined
          ? task.webhookToken
          : this.normalizeWebhookToken(input.webhookToken ?? undefined),
      reminderMessage: input.reminderMessage?.trim() || task.reminderMessage,
      action: input.action ?? task.action,
      agentTask: input.agentTask ?? task.agentTask,
      durationMinutes:
        input.durationMinutes !== undefined
          ? normalizeDurationMinutes(input.durationMinutes)
          : task.durationMinutes,
      remindBeforeMinutes:
        input.remindBeforeMinutes !== undefined
          ? normalizeRemindBeforeMinutes(input.remindBeforeMinutes)
          : task.remindBeforeMinutes,
      location:
        input.location !== undefined ? input.location?.trim() || undefined : task.location,
      updatedAt: this.now().toISOString(),
    };
    // 更新同样过文案契约闸（改期/改写不得把回声文案带进展示链）。
    const copy = normalizeReminderDisplayCopy(
      next.kind,
      next.description,
      next.shortTitle,
      next.reminderMessage,
    );
    next.shortTitle = copy.shortTitle;
    next.reminderMessage = copy.reminderMessage;
    if (
      input.runAt !== undefined ||
      input.recurrence !== undefined ||
      input.timezone !== undefined ||
      input.cronExpression !== undefined
    ) {
      const schedule = this.resolveSchedule(
        input.runAt ?? task.runAt,
        next.recurrence,
        next.timezone,
        next.cronExpression,
      );
      next.recurrence = schedule.recurrence;
      next.runAt = schedule.runAt;
      next.nextRunAt = schedule.nextRunAt;
      next.cronExpression = schedule.cronExpression;
    }
    if (input.status) {
      next.status = input.status;
      if (input.status === "cancelled") {
        next.nextRunAt = null;
      }
    }
    await this.reconcileReminderPolicy(task, next, input);
    this.validateKindPayload(next.kind, next.reminderMessage, next.action, next.agentTask);
    this.byTaskId.set(taskId, next);
    await this.persist();
    await this.emitTaskChange("updated", next);
    return next;
  }

  async triggerNow(taskId: string): Promise<void> {
    const task = this.byTaskId.get(taskId);
    if (!task) throw new Error("task not found");
    if (task.status !== "active") throw new Error("current task is not active");
    await this.executeTask(task, this.now().toISOString());
  }

  async triggerByWebhookToken(webhookToken: string): Promise<ScheduleTaskRecord> {
    const token = webhookToken.trim();
    if (!token) throw new Error("webhook token is required");
    const task = Array.from(this.byTaskId.values()).find((entry) => entry.webhookToken === token);
    if (!task) throw new Error("webhook task not found");
    if (task.status !== "active") throw new Error("current task is not active");
    await this.executeTask(task, this.now().toISOString());
    return this.byTaskId.get(task.taskId) ?? task;
  }

  private async tick(): Promise<void> {
    const now = this.now().getTime();
    await this.firePreReminders(now);
    const dueTasks = Array.from(this.byTaskId.values()).filter((task) => {
      if (task.status !== "active" || !task.nextRunAt) return false;
      return new Date(task.nextRunAt).getTime() <= now;
    });
    for (const task of dueTasks) {
      if (this.runningTaskIds.has(task.taskId)) continue;
      this.runningTaskIds.add(task.taskId);
      const plannedAt = task.nextRunAt ?? this.now().toISOString();
      void this.executeTask(task, plannedAt).finally(() => {
        this.runningTaskIds.delete(task.taskId);
      });
    }
  }

  /**
   * 更新侧的策略对账：
   *  - 用户显式给了 remindBeforeMinutes → 接管，清掉策略脚本与指纹（显式意愿优先）；
   *  - 时间/内容/地点变了且任务原本是策略生成的（或本来就没有提前量）→ 按新值重算；
   *  - 不再符合策略条件（改周期/改 trivia 等）→ 清掉整份计划。
   */
  private async reconcileReminderPolicy(
    previous: ScheduleTaskRecord,
    next: ScheduleTaskRecord,
    input: UpdateScheduleTaskInput,
  ): Promise<void> {
    if (input.remindBeforeMinutes !== undefined) {
      next.preReminders = undefined;
      next.reminderPolicy = undefined;
      next.firedPreReminderOffsets = undefined;
      return;
    }
    const scheduleOrContentChanged =
      (input.runAt !== undefined && input.runAt !== previous.runAt) ||
      (input.timezone !== undefined && input.timezone !== previous.timezone) ||
      (input.recurrence !== undefined && input.recurrence !== previous.recurrence) ||
      (input.description !== undefined && input.description.trim() !== previous.description) ||
      (input.reminderMessage !== undefined && input.reminderMessage.trim() !== (previous.reminderMessage ?? "")) ||
      (input.location !== undefined && input.location.trim() !== (previous.location ?? "")) ||
      (input.category !== undefined && input.category !== previous.category);
    if (!scheduleOrContentChanged) return;
    const wasPolicyGenerated =
      next.reminderPolicy !== undefined || next.preReminders !== undefined;
    if (!wasPolicyGenerated && next.remindBeforeMinutes !== undefined) return; // 显式提前量任务不碰
    next.firedPreReminderOffsets = undefined;
    if (!isReminderPolicyEligible(next)) {
      next.preReminders = undefined;
      next.reminderPolicy = undefined;
      next.remindBeforeMinutes = undefined;
      return;
    }
    const route = await this.routeFactorFor(next.sessionId, next.location);
    const plan = buildReminderPolicy({
      runAt: next.runAt,
      timezone: next.timezone,
      description: next.description,
      reminderMessage: next.reminderMessage,
      location: next.location,
      source: next.source,
      habits: this.habitHintsFor(next.sessionId),
      ...(route
        ? { travelMinutesOverride: route.durationMin, routeSource: route.source }
        : {}),
    });
    if (plan) {
      next.remindBeforeMinutes = plan.remindBeforeMinutes;
      next.preReminders = plan.preReminders;
      next.reminderPolicy = plan.policyName;
    } else {
      next.preReminders = undefined;
      next.reminderPolicy = undefined;
      next.remindBeforeMinutes = undefined;
    }
  }

  /** 提前量提醒：到点前按 remindBeforeMinutes 各偏移推送一次（不产生 run、不推进 nextRunAt）。 */
  private async firePreReminders(now: number): Promise<void> {
    if (!this.reminderHandler) return;
    for (const task of Array.from(this.byTaskId.values())) {
      if (task.status !== "active" || !task.nextRunAt) continue;
      if (task.kind !== "reminder") continue;
      const offsets = task.remindBeforeMinutes;
      if (!offsets?.length) continue;
      const runMs = new Date(task.nextRunAt).getTime();
      // 全部到期偏移一次触发（tick 间隔大于偏移间隔时不漏提醒）
      const dueOffsets = offsets.filter(
        (o) =>
          !(task.firedPreReminderOffsets ?? []).includes(o) &&
          now >= runMs - o * 60_000 &&
          now < runMs,
      );
      if (dueOffsets.length === 0) continue;
      const updated: ScheduleTaskRecord = {
        ...task,
        firedPreReminderOffsets: [...(task.firedPreReminderOffsets ?? []), ...dueOffsets],
      };
      this.byTaskId.set(task.taskId, updated);
      await this.persist();
      const base = task.reminderMessage || task.title || task.description;
      for (const dueOffset of dueOffsets.sort((a, b) => b - a)) {
        // 策略段有专属脚本（睡前备忘/起床闹钟/该出门了…），无脚本段保持历史模板
        const script = task.preReminders?.find((p) => p.offsetMinutes === dueOffset);
        let message = script?.message ?? `【提前${dueOffset}分钟】${base}`;
        // 出发段实时富化（2026-10-05）：触发瞬间重算一次「当前位置 × 目的地」
        // 的实时路程，文案带真实车程；实时路程+到场缓冲已超过剩余时间 → 升档
        // 走到点弹窗决策出口（轻触达拦不住迟到的出发）。
        if (script?.stage === "depart" && task.location?.trim()) {
          const estimate = await this.routeFactorFor(task.sessionId, task.location);
          const remainingMin = (runMs - now) / 60_000;
          if (estimate) {
            const routeNote = `${task.location} 当前车程约 ${estimate.durationMin} 分钟${
              estimate.source === "amap" ? "（含实时路况）" : ""
            }`;
            if (
              remainingMin > 0 &&
              estimate.durationMin > remainingMin + DEPART_ESCALATE_SLACK_MIN
            ) {
              message =
                `现在就出发：${routeNote}，距开始只剩 ${Math.max(1, Math.round(remainingMin))} 分钟，` +
                `再不走就要迟到了。`;
              try {
                await this.reminderHandler(updated, message);
                continue;
              } catch {
                // 升档推送失败 → 退回轻触达，不吞掉提醒
              }
            } else {
              message = `${message}（${routeNote}）`;
            }
          }
        }
        try {
          await this.reminderHandler(updated, message, { preReminder: true });
        } catch {
          // 提前提醒推送失败不影响主触发链路
        }
      }
    }
  }

  private async executeTask(task: ScheduleTaskRecord, plannedAt: string): Promise<void> {
    // 补发判定：实际执行比计划晚太多 = runtime 离线跨过了触发点（重启补跑）。
    // 超窗 → 不执行、记 missed、通知一次；窗内 → 照常执行但带补发语境。
    const lagMs = this.now().getTime() - new Date(plannedAt).getTime();
    if (Number.isFinite(lagMs) && lagMs > CATCHUP_MAX_LAG_MS) {
      await this.recordMissedRun(task, plannedAt);
      return;
    }
    const catchUp = Number.isFinite(lagMs) && lagMs > CATCHUP_MIN_LAG_MS;
    const startedAt = this.now().toISOString();
    const runId = randomUUID();
    const run: ScheduleTaskRun = {
      runId,
      taskId: task.taskId,
      plannedAt,
      startedAt,
      endedAt: startedAt,
      status: "success",
    };
    try {
      if (task.kind === "reminder") {
        const message = task.reminderMessage || task.description;
        run.output = {
          type: "reminder",
          title: task.title,
          message,
          ...(catchUp ? { catchUp: true } : {}),
        };
      } else if (task.kind === "weather_brief") {
        if (!this.weatherBriefHandler) {
          throw new Error("weather brief handler is not configured");
        }
        run.output = await this.weatherBriefHandler(task);
      } else if (task.kind === "agent_task") {
        if (!this.agentTaskHandler) {
          throw new Error("agent task handler is not configured");
        }
        run.output = await this.agentTaskHandler(
          catchUp
            ? { ...task, agentTask: { ...task.agentTask, prompt: this.buildCatchUpAgentPrompt(task.agentTask?.prompt ?? "", plannedAt) } }
            : task,
        );
      } else {
        run.output = await this.executeAction(task);
      }
    } catch (e) {
      run.status = "failed";
      run.error = e instanceof Error ? e.message : String(e);
    } finally {
      run.endedAt = this.now().toISOString();
      const nextTaskState = this.computeNextTaskState(task, run.status === "success", run.error);
      this.byTaskId.set(task.taskId, nextTaskState);
      const list = this.runsByTaskId.get(task.taskId) ?? [];
      list.push(run);
      this.runsByTaskId.set(task.taskId, list);
      await this.persist();
      await this.emitTaskChange("updated", nextTaskState);
      if (run.status === "failed" && nextTaskState.status === "failed" && task.status !== "failed") {
        // 刚进入死信（本次之前还在重试队列里）→ 通知一次，之后不再重复打扰
        try {
          this.taskDeadLetterHandler?.(nextTaskState);
        } catch {
          /* 通知失败不影响任务记账 */
        }
      }
      if (task.kind === "reminder" && run.status === "success" && this.reminderHandler) {
        const message = task.reminderMessage || task.description;
        await this.reminderHandler(
          nextTaskState,
          catchUp ? `【补发】${message}` : message,
        );
      }
    }
  }

  /**
   * 到期但超过补发窗口：不执行任何 handler，记 status=missed 的 run，
   * 任务状态按"已处理"收口（单次 → completed；周期 → 推进到下一个未来槽位，
   * 循环推进避免停机多天后每个陈旧槽位连环触发 missed）。
   */
  private async recordMissedRun(task: ScheduleTaskRecord, plannedAt: string): Promise<void> {
    const nowIso = this.now().toISOString();
    const run: ScheduleTaskRun = {
      runId: randomUUID(),
      taskId: task.taskId,
      plannedAt,
      startedAt: nowIso,
      endedAt: nowIso,
      status: "missed",
      error: `补发窗口已过：原定 ${plannedAt}，超 ${Math.round(CATCHUP_MAX_LAG_MS / 3_600_000)} 小时未执行，不再补发`,
    };
    let next = this.computeNextTaskState(task, true);
    let guard = 0;
    while (
      next.nextRunAt &&
      new Date(next.nextRunAt).getTime() <= this.now().getTime() &&
      guard < 400
    ) {
      next = this.computeNextTaskState(next, true);
      guard += 1;
    }
    this.byTaskId.set(task.taskId, next);
    const list = this.runsByTaskId.get(task.taskId) ?? [];
    list.push(run);
    this.runsByTaskId.set(task.taskId, list);
    await this.persist();
    await this.emitTaskChange("updated", next);
    try {
      this.taskMissedHandler?.(next, plannedAt);
    } catch {
      /* 通知失败不影响任务记账 */
    }
  }

  /** agent_task 补发语境：显式给出原定时间与当前时间，防相对时间（"今早/今天"）被按现在理解。 */
  private buildCatchUpAgentPrompt(prompt: string, plannedAt: string): string {
    const nowIso = this.now().toISOString();
    return (
      `【补发任务】此任务原定 ${plannedAt} 触发，因 runtime 未运行错过，现在补跑（当前实际时间 ${nowIso}）。` +
      `任务里"今早/今天/昨晚"等相对时间按原定时间点理解；产出开头用一句话说明这是原定 ${plannedAt} 的补发。` +
      `原任务：${prompt}`
    );
  }

  private computeNextTaskState(
    task: ScheduleTaskRecord,
    wasSuccessful: boolean,
    errorMessage?: string,
  ): ScheduleTaskRecord {
    const updated: ScheduleTaskRecord = {
      ...task,
      lastRunAt: this.now().toISOString(),
      updatedAt: this.now().toISOString(),
      // 主触发后重置提前提醒记录，下一周期可再次推送
      firedPreReminderOffsets: undefined,
    };
    if (!wasSuccessful) {
      // 失败重试治理：指数退避（60s 起步，封顶 30min），连续失败达阈值进入死信
      // （status=failed，停止调度）——此前是 60s 固定间隔无限重试，
      // agent_task 每次重试都是完整 LLM 回合，持续失败等于无人值守空烧 token。
      const fails = (task.consecutiveFailures ?? 0) + 1;
      updated.consecutiveFailures = fails;
      if (errorMessage) updated.lastError = errorMessage.slice(0, 300);
      if (fails >= DEAD_LETTER_AFTER_FAILURES) {
        updated.status = "failed";
        updated.nextRunAt = null;
        return updated;
      }
      const backoffMs = Math.min(RETRY_BACKOFF_BASE_MS * 2 ** (fails - 1), RETRY_BACKOFF_MAX_MS);
      updated.nextRunAt = new Date(this.now().getTime() + backoffMs).toISOString();
      return updated;
    }
    // 成功清零失败计数
    if (task.consecutiveFailures !== undefined) updated.consecutiveFailures = 0;
    if (task.lastError !== undefined) updated.lastError = undefined;
    if (updated.cronExpression) {
      updated.recurrence = "cron";
      updated.nextRunAt = this.computeNextCronRun(
        updated.cronExpression,
        updated.timezone,
        updated.lastRunAt ?? updated.runAt,
      );
      return updated;
    }
    if (updated.recurrence === "none") {
      updated.status = "completed";
      updated.nextRunAt = null;
      return updated;
    }

    const anchorUtc = new Date(updated.nextRunAt ?? updated.runAt);
    const local = this.toLocalInTimezone(anchorUtc, updated.timezone);
    if (updated.recurrence === "daily") {
      local.setDate(local.getDate() + 1);
    } else if (updated.recurrence === "weekly") {
      local.setDate(local.getDate() + 7);
    } else {
      local.setFullYear(local.getFullYear() + 1);
    }
    updated.nextRunAt = this.toUtcFromLocalTime(local, updated.timezone).toISOString();
    return updated;
  }

  private async executeAction(task: ScheduleTaskRecord): Promise<unknown> {
    if (!task.action?.url) {
      throw new Error("action task requires url");
    }
    await assertSafeActionUrl(task.action.url);
    const method = task.action.method ?? "POST";
    const res = await fetch(task.action.url, {
      method,
      headers: {
        "content-type": "application/json",
        ...(task.action.headers ?? {}),
      },
      body:
        method === "GET" || method === "DELETE" ? undefined : JSON.stringify(task.action.body ?? {}),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`task api call failed: ${res.status} ${res.statusText} ${text}`);
    }
    try {
      return JSON.parse(text);
    } catch {
      return { text };
    }
  }

  private resolveSchedule(
    runAtRaw: string | undefined,
    recurrence: ScheduleRecurrence,
    timezone: string,
    cronExpression?: string,
  ): {
    recurrence: ScheduleRecurrence;
    runAt: string;
    nextRunAt: string | null;
    cronExpression?: string;
  } {
    const normalizedCron = cronExpression?.trim() || undefined;
    if (normalizedCron) {
      const nextRunAt = this.computeNextCronRun(normalizedCron, timezone);
      return {
        recurrence: "cron",
        runAt: nextRunAt,
        nextRunAt,
        cronExpression: normalizedCron,
      };
    }
    if (!runAtRaw?.trim()) {
      throw new Error("runAt or cronExpression is required");
    }
    const runAt = this.parseRunAt(runAtRaw, timezone).toISOString();
    return {
      recurrence,
      runAt,
      nextRunAt: runAt,
    };
  }

  private parseRunAt(raw: string, timezone: string): Date {
    const normalizedRaw = raw.trim();
    const hasExplicitTimezone = /(?:[zZ]|[+\-]\d{2}:\d{2})$/.test(normalizedRaw);
    const utc =
      hasExplicitTimezone
        ? this.parseAbsoluteRunAt(normalizedRaw)
        : this.parseLocalRunAt(normalizedRaw, timezone);
    if (utc.getTime() < this.now().getTime() - 5000) {
      throw new Error("runAt must be in the future");
    }
    return utc;
  }

  private parseAbsoluteRunAt(raw: string): Date {
    const date = new Date(raw);
    if (Number.isNaN(date.getTime())) {
      throw new Error("invalid runAt");
    }
    return date;
  }

  private parseLocalRunAt(raw: string, timezone: string): Date {
    const match = raw.match(
      /^(\d{4})-(\d{2})-(\d{2})(?:[T\s](\d{2})(?::(\d{2}))?(?::(\d{2}))?)?$/,
    );
    if (match) {
      const [, year, month, day, hour = "00", minute = "00", second = "00"] = match;
      const local = new Date(
        Number(year),
        Number(month) - 1,
        Number(day),
        Number(hour),
        Number(minute),
        Number(second),
        0,
      );
      return this.toUtcFromLocalTime(local, timezone);
    }
    const date = new Date(raw);
    if (Number.isNaN(date.getTime())) {
      throw new Error("invalid runAt");
    }
    return this.toUtcFromLocalTime(date, timezone);
  }

  private normalizeWebhookToken(token: string | undefined): string | undefined {
    const normalized = token?.trim();
    return normalized ? normalized : undefined;
  }

  private computeNextCronRun(
    cronExpression: string,
    timezone: string,
    fromIso?: string,
  ): string {
    const fields = cronExpression.trim().split(/\s+/);
    if (fields.length !== 5) {
      throw new Error("cronExpression must have 5 fields");
    }
    const minutes = this.parseCronField(fields[0]!, 0, 59);
    const hours = this.parseCronField(fields[1]!, 0, 23);
    const daysOfMonth = this.parseCronField(fields[2]!, 1, 31);
    const months = this.parseCronField(fields[3]!, 1, 12);
    const daysOfWeek = this.parseCronField(fields[4]!, 0, 7, true);
    const base = fromIso ? new Date(fromIso) : this.now();
    const candidate = this.toLocalInTimezone(new Date(base.getTime() + 60_000), timezone);
    candidate.setSeconds(0, 0);
    for (let i = 0; i < 366 * 24 * 60; i += 1) {
      const month = candidate.getMonth() + 1;
      const day = candidate.getDate();
      const hour = candidate.getHours();
      const minute = candidate.getMinutes();
      const dayOfWeek = candidate.getDay();
      if (
        months.has(month) &&
        daysOfMonth.has(day) &&
        hours.has(hour) &&
        minutes.has(minute) &&
        daysOfWeek.has(dayOfWeek)
      ) {
        return this.toUtcFromLocalTime(candidate, timezone).toISOString();
      }
      candidate.setMinutes(candidate.getMinutes() + 1);
    }
    throw new Error("unable to compute next cron run within one year");
  }

  private parseCronField(
    expr: string,
    min: number,
    max: number,
    normalizeSunday = false,
  ): Set<number> {
    const values = new Set<number>();
    for (const rawPart of expr.split(",")) {
      const part = rawPart.trim();
      if (!part) continue;
      const [rangeExpr, stepExpr] = part.split("/");
      const step = stepExpr ? Number(stepExpr) : 1;
      if (!Number.isInteger(step) || step <= 0) {
        throw new Error(`invalid cron step: ${part}`);
      }
      let rangeStart = min;
      let rangeEnd = max;
      if (rangeExpr !== "*") {
        const rangeParts = rangeExpr.split("-");
        if (rangeParts.length === 1) {
          rangeStart = Number(rangeParts[0]);
          rangeEnd = rangeStart;
        } else if (rangeParts.length === 2) {
          rangeStart = Number(rangeParts[0]);
          rangeEnd = Number(rangeParts[1]);
        } else {
          throw new Error(`invalid cron field: ${part}`);
        }
      }
      if (
        !Number.isInteger(rangeStart) ||
        !Number.isInteger(rangeEnd) ||
        rangeStart < min ||
        rangeEnd > max ||
        rangeStart > rangeEnd
      ) {
        throw new Error(`cron field out of range: ${part}`);
      }
      for (let value = rangeStart; value <= rangeEnd; value += step) {
        values.add(normalizeSunday && value === 7 ? 0 : value);
      }
    }
    if (values.size === 0) {
      throw new Error(`empty cron field: ${expr}`);
    }
    return values;
  }

  private async emitTaskChange(
    action: ScheduleTaskChangeAction,
    task: ScheduleTaskRecord,
  ): Promise<void> {
    if (!this.taskChangeHandler) return;
    await this.taskChangeHandler(action, task);
  }

  private toUtcFromLocalTime(localTime: Date, timezone: string): Date {
    const y = localTime.getFullYear();
    const mo = localTime.getMonth();
    const d = localTime.getDate();
    const h = localTime.getHours();
    const mi = localTime.getMinutes();
    const s = localTime.getSeconds();

    let tentative = new Date(Date.UTC(y, mo, d, h, mi, s));

    const fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
    const parts = fmt.formatToParts(tentative);
    const tzVals: Record<string, number> = {};
    for (const p of parts) {
      if (p.type !== "literal") tzVals[p.type] = Number(p.value);
    }

    let deltaMs =
      ((h - (tzVals.hour ?? 0)) * 60 + (mi - (tzVals.minute ?? 0))) * 60000 +
      (s - (tzVals.second ?? 0)) * 1000;

    if (deltaMs > 43200000) deltaMs -= 86400000;
    if (deltaMs < -43200000) deltaMs += 86400000;

    return new Date(tentative.getTime() + deltaMs);
  }

  private toLocalInTimezone(utcDate: Date, timezone: string): Date {
    const fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
    const parts = fmt.formatToParts(utcDate);
    const v: Record<string, number> = {};
    for (const p of parts) {
      if (p.type !== "literal") v[p.type] = Number(p.value);
    }
    return new Date(v.year, v.month - 1, v.day, v.hour ?? 0, v.minute ?? 0, v.second ?? 0);
  }

  private validateKindPayload(
    kind: ScheduleTaskKind,
    reminderMessage?: string,
    action?: ScheduleActionConfig,
    agentTask?: ScheduleAgentTaskConfig,
  ): void {
    if (kind === "reminder" && !(reminderMessage?.trim() || "").length) {
      throw new Error("reminder task requires reminderMessage");
    }
    if (kind === "action" && !action?.url?.trim()) {
      throw new Error("action task requires action.url");
    }
    if (kind === "agent_task" && !(agentTask?.prompt?.trim() || "").length) {
      throw new Error("agent task requires agentTask.prompt");
    }
  }
}

async function assertSafeActionUrl(rawUrl: string): Promise<void> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("invalid action.url");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("action.url only supports http/https");
  }
  if (process.env.SCHEDULE_ACTION_ALLOW_PRIVATE === "1") {
    return;
  }
  const hostname = url.hostname.toLowerCase();
  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    throw new Error("action.url cannot access localhost by default");
  }
  const addresses =
    isIP(hostname)
      ? [{ address: hostname }]
      : await lookup(hostname, { all: true, verbatim: false });
  if (addresses.some((entry) => isPrivateOrLocalAddress(entry.address))) {
    throw new Error("action.url cannot access local or private network by default");
  }
}

function isPrivateOrLocalAddress(address: string): boolean {
  if (address === "::1" || address === "0:0:0:0:0:0:0:1") return true;
  const lower = address.toLowerCase();
  if (lower.startsWith("fe80:") || lower.startsWith("fc") || lower.startsWith("fd")) return true;
  if (lower.startsWith("::ffff:")) {
    return isPrivateOrLocalAddress(address.slice("::ffff:".length));
  }
  const parts = address.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }
  const [a, b] = parts;
  return (
    a === 10 ||
    a === 127 ||
    a === 0 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}
