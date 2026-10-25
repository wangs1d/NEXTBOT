/**
 * DDL 雷达 —— 大学生线 / 截止日期分级触达的确定性取数层。
 *
 * 定位（2026-10-22）：**只做聚合与分档，不做投递**。
 * 三级梯度不是再造一个推送通道，而是把同一批 DDL 按"离截止还有几个日历日"
 * 分档后，交付给既有的两个投递面：
 *
 *   L1 soon     （2~3 天后到期）→ 晨报末尾一行"这周还要交 N 项"
 *   L2 tomorrow （明天到期）    → 晚间备忘卡的"明天要交"
 *   L3 today    （今天到期/已过期）→ 晨报"今天截止"置顶
 *
 * 为什么不在这里推送：日程任务自带 preReminders，再发一遍推送会撞车。
 * 本模块只把"跨天的 DDL 语义"补齐，让睡前/晨间两个既有出口看到它们。
 *
 * 数据源（全部可选注入，缺失即降级为空，不抛错）：
 *   1. 日程任务（sessionId 维度）：只收**命中 DDL 语义**的条目（截止/提交/
 *      交作业/考试/答辩…），普通会议与提醒一律不收——否则整天的会都变成 DDL。
 *   2. 数据入口台账（ingest，actorId 维度）：用户上传的课表/DDL 截止项。
 *
 * 分档口径：按**本地日历日差**（不是小时数）。用户感知的"明天截止"是日历
 * 概念，23:50 和次日 00:10 只差 20 分钟却是两个档，按小时切会切错。
 */

export type DdlTier = "today" | "tomorrow" | "soon";

export type DdlSourceKind = "schedule" | "ingest";

export interface DdlItem {
  /** 全局唯一 id（schedule:xxx / ingest:xxx），供上层去重与跳转 */
  id: string;
  title: string;
  /** ISO 截止时间 */
  dueAt: string;
  source: DdlSourceKind;
  tier: DdlTier;
  /** 本地日历日差：0=今天，1=明天，2/3=后续 */
  dayDiff: number;
  /** 距截止的小时数（已过期为负） */
  hoursLeft: number;
  /** 是否已过截止时间（保留在 today 档，文案用「已过期」） */
  overdue: boolean;
  /** 日程 category 或 ingest 类别（作业/报告/交付…） */
  category?: string;
}

export interface DdlScanResult {
  /** L3：今天到期或已过期 */
  today: DdlItem[];
  /** L2：明天到期 */
  tomorrow: DdlItem[];
  /** L1：2~3 天后到期 */
  soon: DdlItem[];
  /** 三档合计（已过滤 >3 天的远期项） */
  total: number;
}

/** 日程服务最小结构接口 */
export interface ScheduleTasksLike {
  listTasksBySession(sessionId: string): Array<{
    taskId: string;
    title?: string;
    shortTitle?: string;
    description: string;
    category?: string;
    runAt: string;
    nextRunAt: string | null;
    status: string;
  }>;
}

export interface DdlRadarDeps {
  scheduleTaskService?: ScheduleTasksLike | null;
  /**
   * 数据入口台账（用户自己上传的课表/DDL/行程）。
   *
   * 这是「加一次就够」的那个 fromXxx：无论用户传的是截图、复制的表格、ics
   * 还是粘贴的一段文字，只要被抽取成 kind=deadline 且有绝对截止时刻，
   * 就会自动进三级梯度——**新增数据源不需要再动本文件**。
   */
  ingestService?: IngestDeadlinesLike | null;
  /** 统一时间源（铁律：禁 Date.now()） */
  now?: () => Date;
}

/** 数据入口台账的最小结构接口（避免与 ingest-service 重类型耦合） */
export interface IngestDeadlinesLike {
  listDeadlines(actorId: string): Array<{
    key: string;
    title: string;
    dueAt: string;
    category?: string;
    sourceLabel: string;
  }>;
}

/**
 * 日程条目的 DDL 语义识别。只有命中才当截止日期处理——
 * 宁可漏掉一个措辞奇怪的作业，也不能把每天的站会变成"今天截止"。
 */
const DDL_SEMANTIC_PATTERN =
  /(截止|deadline|\bddl\b|\bdue\b|到期|提交|上交|交作业|交报告|交论文|交材料|报名|选课|考试|补考|答辩|开题|结题|中期检查|面签|缴费|续费)/i;

/** 每档最多展示条数（超出的只计数，不逐条列，避免卡片被撑爆） */
export const MAX_ITEMS_PER_TIER = 5;

/** 本地日历日差（今天 00:00 为基准），跨时区/夏令时用本地日期构造而非毫秒除 */
export function localDayDiff(now: Date, target: Date): number {
  const a = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const b = new Date(target.getFullYear(), target.getMonth(), target.getDate()).getTime();
  return Math.round((b - a) / 86_400_000);
}

function tierOf(dayDiff: number): DdlTier | null {
  if (dayDiff <= 0) return "today";
  if (dayDiff === 1) return "tomorrow";
  if (dayDiff <= 3) return "soon";
  return null;
}

function clipTitle(raw: string, max = 28): string {
  const s = raw.trim().replace(/\s+/g, " ");
  if (!s) return "未命名事项";
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}

export class DdlRadarService {
  constructor(private readonly deps: DdlRadarDeps = {}) {}

  private now(): Date {
    return this.deps.now ? this.deps.now() : new Date();
  }

  /**
   * 扫描并分档。任一数据源缺失/抛错 → 该源当作空，不影响另一源。
   * @param sessionId 日程维度 key
   * @param actorId   ingest 维度 key
   */
  scan(sessionId: string, actorId?: string): DdlScanResult {
    const now = this.now();
    const actorKey = actorId ?? sessionId;
    const items: DdlItem[] = [
      ...this.fromSchedule(sessionId, now),
      ...this.fromIngested(actorKey, now),
    ];

    // 同一件事可能既在日程又在 ingest 台账：按标题去重，
    // 保留截止更早的那条（更紧迫）。
    const deduped = new Map<string, DdlItem>();
    for (const item of items) {
      const key = normalizeTitle(item.title);
      const prev = deduped.get(key);
      if (!prev || Date.parse(item.dueAt) < Date.parse(prev.dueAt)) {
        deduped.set(key, item);
      }
    }

    const sorted = [...deduped.values()].sort(
      (a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt),
    );

    const pick = (tier: DdlTier): DdlItem[] =>
      sorted.filter((i) => i.tier === tier).slice(0, MAX_ITEMS_PER_TIER);

    return {
      today: pick("today"),
      tomorrow: pick("tomorrow"),
      soon: pick("soon"),
      total: sorted.length,
    };
  }

  /** L2 投递面用（晚间备忘卡）：明天要交的 + 今天已过期还没交的 */
  forEvening(
    sessionId: string,
    actorId?: string,
  ): { tomorrow: DdlItem[]; overdue: DdlItem[] } {
    const r = this.scan(sessionId, actorId);
    return { tomorrow: r.tomorrow, overdue: r.today.filter((i) => i.overdue) };
  }

  /** L3 + L1 投递面用：今天截止 + 这周还要交的（晨间简报） */
  forMorning(sessionId: string, actorId?: string): { today: DdlItem[]; soon: DdlItem[] } {
    const r = this.scan(sessionId, actorId);
    return { today: r.today, soon: r.soon };
  }

  // ---- 数据源 ---------------------------------------------------------

  private fromSchedule(sessionId: string, now: Date): DdlItem[] {
    if (!sessionId || !this.deps.scheduleTaskService) return [];
    let tasks: ReturnType<ScheduleTasksLike["listTasksBySession"]> = [];
    try {
      tasks = this.deps.scheduleTaskService.listTasksBySession(sessionId);
    } catch {
      return [];
    }
    const out: DdlItem[] = [];
    for (const t of tasks) {
      // 已取消/已完成的不再当 DDL
      if (t.status === "cancelled" || t.status === "completed") continue;
      const text = `${t.title ?? ""} ${t.shortTitle ?? ""} ${t.description}`;
      if (!DDL_SEMANTIC_PATTERN.test(text)) continue;
      const when = t.nextRunAt ?? t.runAt;
      const due = new Date(when);
      const dueMs = due.getTime();
      if (!Number.isFinite(dueMs)) continue;
      const dayDiff = localDayDiff(now, due);
      const tier = tierOf(dayDiff);
      if (!tier) continue;
      out.push({
        id: `schedule:${t.taskId}`,
        title: clipTitle(t.shortTitle ?? t.title ?? t.description),
        dueAt: due.toISOString(),
        source: "schedule",
        tier,
        dayDiff,
        hoursLeft: Math.round(((dueMs - now.getTime()) / 3_600_000) * 10) / 10,
        overdue: dueMs < now.getTime(),
        category: t.category,
      });
    }
    return out;
  }

  /**
   * 用户自己上传的数据（数据入口台账）里的截止项。
   *
   * 只认「有绝对截止时刻」的条目。课表条目是「周一第1-2节」，没有日期——
   * 混进来会让晨报的"今天要交"里冒出一门周三的课（见 ingest-types 的说明）。
   *
   * 已过期的**不丢**：归 today 档并标 overdue。没交的作业第二天更该催，
   * 静默消失是这套梯度最不能犯的错（与 ddl 分级定调一致）。
   *
   * 上限 200 条：台账本身无硬上限（用户可能传一整学期），单次扫描只需覆盖
   * 近几天的量；listDeadlines 已按时间排序，取前 200 不会漏掉近期的。
   */
  private fromIngested(actorId: string | undefined, now: Date): DdlItem[] {
    if (!actorId || !this.deps.ingestService) return [];
    let rows: ReturnType<IngestDeadlinesLike["listDeadlines"]> = [];
    try {
      rows = this.deps.ingestService.listDeadlines(actorId);
    } catch {
      return [];
    }
    const out: DdlItem[] = [];
    for (const row of rows.slice(0, 200)) {
      const dueMs = Date.parse(row.dueAt);
      if (!Number.isFinite(dueMs)) continue;
      const due = new Date(dueMs);
      const dayDiff = localDayDiff(now, due);
      const tier = tierOf(dayDiff);
      if (!tier) continue;
      out.push({
        id: `ingest:${row.key}`,
        title: clipTitle(row.title),
        dueAt: due.toISOString(),
        source: "ingest",
        tier,
        dayDiff,
        hoursLeft: Math.round(((dueMs - now.getTime()) / 3_600_000) * 10) / 10,
        overdue: dueMs < now.getTime(),
        category: row.category,
      });
    }
    return out;
  }
}

/** 标题归一（去空白/标点/大小写）用于跨源去重 */
function normalizeTitle(s: string): string {
  return s.replace(/[\s，。！？、,.!?：:；;（）()【】\[\]"'“”]/g, "").toLowerCase();
}
