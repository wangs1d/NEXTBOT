import type { RhythmDimension, RhythmObservation, RhythmSensor } from "../types.js";
import { formatHour, localDayKey, shiftDayKey } from "../time-utils.js";

/**
 * 手机使用传感器（PRD §7.3 的 phone-usage-sensor）。
 *
 * 输入是端上聚合、经既有 WS 主连接（client.presence_state 的 buckets 分支）
 * 落进 PhoneSignalBucketStore 的 15 分钟桶：{bucket, screenOnMin, unlocks,
 * chargingMin, placeKind, inCallMin, dndMin}。原始事件不出端，这里只看桶。
 *
 * 不自带任何轮询：引擎夜间分析 collect 时拉一次（§7.3「不自带轮询，由夜间
 * 分析 collect 拉取」），桶存储也没有新增文件/新增连接。
 *
 * 产出（全部走既有 RhythmObservation → 维度模型器，不另立统计口径）：
 *  - sleep  / sleep_sample ：夜间「最后一次亮屏 → 之后长时间无解锁」+ 充电佐证
 *  - wake   / wake_sample  ：早上首次解锁（清晨无解锁记录时退化为首次连续亮屏）
 *  - commute/ commute_leave_home / _arrive_work / _leave_work：placeKind 跳变
 *  - focus  / phone_unlock ：解锁频次（弱活跃信号）
 *  - receptivity / screen_busy：通话中 / 连续亮屏高频解锁的弱负信号
 *
 * 与桌面 sleep-window-sensor 的关系：**手机优先、桌面兜底**。本传感器的观察
 * 标 source="phone-usage"，模型器按 grouping.ts 的 SOURCE_PRIORITY 裁决同日
 * 样本（手机 3 > 在场足迹 2 > 桌面 1 > 自述 0）。桌面传感器保留注册不删：
 * 手机没上报的那几天仍要靠它出作息。
 *
 * 传感器无状态：每晚从原始桶整窗重算，所以"头天只知道入睡、第二天才知道
 * 起床"的夜晚会在第二次分析时自动补成完整样本，画像里不需要存半成品。
 */

/** 入睡判定的搜索窗（本地小时）：晚间最后一次亮屏只可能落在这段里 */
const ONSET_SEARCH_START_HOUR = 18;
const ONSET_SEARCH_END_HOUR = 6;
/** 醒来判定的搜索窗（本地小时） */
const WAKE_SEARCH_START_HOUR = 3;
const WAKE_SEARCH_END_HOUR = 12;
/** 认定"人睡了"的最短静默时长（分钟）：连续这么久既不亮屏也不解锁 */
const SILENT_STREAK_MIN = 90;
/** 醒来前至少要静默这么久（分钟）——夜里起来上厕所不算起床 */
const WAKE_MIN_SILENT_MIN = 60;
/** 一段睡眠的合理时长带（小时）：出界宁可丢样本，不要污染中位数 */
const MIN_SLEEP_HOURS = 2.5;
const MAX_SLEEP_HOURS = 14;
/** 一个清晨桶内完全没有解锁记录时的兜底：连续亮屏 ≥ 这么多分钟才算醒 */
const WAKE_SCREEN_ON_MIN = 5;
/** 桶长（分钟） */
const BUCKET_MIN = 15;
/** 回看上限（天）：桶存储本身只留 30 天，这里再收一刀控制单次分析的计算量 */
const MAX_LOOKBACK_DAYS = 30;

export type PlaceKind = "home" | "work" | "other" | "unknown";

/** 桶存储吐出来的原始行（与 PhoneSignalBucketStore.recent/list 同构） */
export type PhoneBucketRawRow = {
  bucket: number;
  unlocks?: number;
  screenOnMin?: number;
  inCallMin?: number;
  charging?: boolean;
  dnd?: boolean;
  placeKind?: unknown;
};

/** 传感器只认这一个读取口：桶存储换实现不影响这里的判定逻辑 */
export type PhoneBucketReader = {
  list(actorId: string, from: Date, to: Date): PhoneBucketRawRow[];
};

export type PhoneSelfReport = {
  wakeHour?: number | null;
  bedtimeHour?: number | null;
  /** 单程通勤分钟数（§7.4 问卷只问方式与大致时长，不问围栏） */
  commuteMinutes?: number | null;
  /** 自述采集日 YYYY-MM-DD：样本日期用它，统计长出来会覆盖同日自述值 */
  date?: string;
};

export type PhoneUsageSensorOptions = {
  /** 时钟注入（测试用） */
  now?: () => Date;
  /**
   * 用户自述作息（§7.4 的三个问卷问题；现成的落点是 schedule-habit 的对话自述口，
   * 问卷 UI 不在本次范围）。自述值以 source="self-report" 进同一批观察：优先级
   * 最低（同一天有统计样本时模型器直接丢它），且只有它时维度置信度被
   * capConfidenceBySource 压到 0.4 —— 过不了触点计划的 0.5 冷启动闸。
   */
  selfReport?: (actorId: string) => PhoneSelfReport | null;
};

type BucketView = {
  bucketMs: number;
  unlocks: number;
  screenOnMin: number;
  inCallMin: number;
  charging: boolean;
  dnd: boolean;
  placeKind: PlaceKind;
};

type NightBuckets = {
  /** 上床那天的日期键（入睡样本按它去重） */
  date: string;
  /** 起床那天的日期键（醒来样本按它去重；跨零点时 = date + 1） */
  wakeDate: string;
  evening: BucketView[];
  morning: BucketView[];
  chargingDuringNight: boolean;
};

function asPlaceKind(v: unknown): PlaceKind {
  return v === "home" || v === "work" || v === "other" ? v : "unknown";
}

function toView(row: PhoneBucketRawRow): BucketView {
  const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
  return {
    bucketMs: row.bucket,
    unlocks: num(row.unlocks),
    screenOnMin: num(row.screenOnMin),
    inCallMin: num(row.inCallMin),
    charging: row.charging === true,
    dnd: row.dnd === true,
    placeKind: asPlaceKind(row.placeKind),
  };
}

export class PhoneUsageSensor implements RhythmSensor {
  readonly id = "phone-usage";
  readonly dimensions: RhythmDimension[] = ["sleep", "wake", "commute", "focus", "receptivity"];
  /**
   * 不声明 expectsObservations：用户没开位置/没带手机/刚装完端上还没攒够桶时
   * 返回空是合法的（§7.6「关闭可选采集项后对应维度停止更新」），标 true 会让
   * 采样链自检天天报 stalled 红点。
   */
  readonly expectsObservations = false;

  private readonly now: () => Date;
  private readonly selfReport: ((actorId: string) => PhoneSelfReport | null) | null;

  constructor(
    private readonly buckets: PhoneBucketReader,
    opts: PhoneUsageSensorOptions = {},
  ) {
    this.now = opts.now ?? (() => new Date());
    this.selfReport = opts.selfReport ?? null;
  }

  async collect(actorId: string, since: Date): Promise<RhythmObservation[]> {
    const now = this.now();
    const floorMs = now.getTime() - MAX_LOOKBACK_DAYS * 24 * 3600_000;
    const fromMs = Math.max(floorMs, Math.min(since.getTime(), floorMs) - 12 * 3600_000);
    const rows = this.buckets
      .list(actorId, new Date(fromMs), now)
      .map(toView)
      .filter((r) => Number.isFinite(r.bucketMs))
      .sort((a, b) => a.bucketMs - b.bucketMs);

    const observations: RhythmObservation[] = [];

    // ── 1. 夜与晨：醒来样本先出（不依赖入睡），入睡样本要配成完整夜再出 ──
    for (const night of groupNights(rows)) {
      const onset = deriveSleepOnset(night.evening);
      const wake = deriveWakeTime(night.morning);
      if (wake !== null) {
        observations.push({
          dimension: "wake",
          // at 只用日期部分去重（样本按"起床那天"记），时刻放 value：跨零点时
          // 入睡日与起床日不是一天，靠 at 推日期会把样本挂错天
          at: `${night.wakeDate}T${formatHour(wake.hour)}:00`,
          value: wake.hour,
          kind: "wake_sample",
          source: this.id,
          ...(wake.by === "unlock" ? {} : { note: "清晨无解锁记录，按首次连续亮屏判定" }),
        });
      }
      // 完整夜（既知入睡又知醒来、时长在合理带内）才喂 sleep 维度：
      // 半截样本会把 sleep 的醒来中位数拉歪（老口径 value2 缺省取 value 就是这个坑）
      if (onset !== null && wake !== null && sleepDurationHours(onset, wake.hour) !== null) {
        observations.push({
          dimension: "sleep",
          at: `${night.date}T${formatHour(onset)}:00`,
          value: onset,
          value2: wake.hour,
          kind: "sleep_sample",
          source: this.id,
          ...(night.chargingDuringNight
            ? { note: "夜间持续充电 + 长静默，入睡判定有充电佐证" }
            : { note: "夜间无充电记录，仅按长静默判定入睡" }),
        });
      }
    }

    // ── 2. 通勤：placeKind 跳变（围栏事实已经在桶里，不新造统计） ──
    observations.push(...deriveCommuteObservations(rows, this.id));

    // ── 3. 解锁频次 → focus（弱活跃）；占用桶 → receptivity（弱负） ──
    for (const row of rows) {
      if (row.unlocks <= 0 && row.inCallMin <= 0) continue;
      const local = new Date(row.bucketMs);
      const hour = local.getHours() + local.getMinutes() / 60;
      if (row.unlocks > 0) {
        observations.push({
          dimension: "focus",
          at: local.toISOString(),
          value: hour,
          kind: "phone_unlock",
          // 一次解锁只是一次抬头：权重给弱交互档，强度靠频次堆
          weight: Math.min(1, 0.2 + row.unlocks * 0.1),
          source: this.id,
        });
      }
      const busy = row.inCallMin >= 8 || (row.screenOnMin >= 12 && row.unlocks >= 4);
      if (busy) {
        observations.push({
          dimension: "receptivity",
          at: local.toISOString(),
          value: 0,
          kind: "screen_busy",
          weight: 0.5,
          source: this.id,
          note: row.inCallMin >= 8 ? "通话中" : "连续亮屏高频解锁",
        });
      }
    }

    // ── 4. 自述问卷值（§7.4）：同一条观察链路的低置信输入 ──
    observations.push(...this.selfReportObservations(actorId));

    return observations;
  }

  /**
   * 问卷/对话自述 → 观察。无条件发即可：自述源优先级最低（SOURCE_PRIORITY=0），
   * 同一天一旦有手机统计样本，模型器合并时就把它顶掉，所以这里不必读画像历史
   * （保持传感器无状态，也不引入对存储的第二个依赖）。
   */
  private selfReportObservations(actorId: string): RhythmObservation[] {
    const report = this.selfReport?.(actorId) ?? null;
    if (!report) return [];
    const date = report.date ?? localDayKey(this.now());
    const src = "self-report";
    const out: RhythmObservation[] = [];
    const wake = Number.isFinite(report.wakeHour ?? NaN) ? (report.wakeHour as number) : null;
    const bedtime = Number.isFinite(report.bedtimeHour ?? NaN) ? (report.bedtimeHour as number) : null;
    if (wake !== null) {
      out.push({
        dimension: "wake",
        at: `${date}T${formatHour(wake)}:00`,
        value: wake,
        kind: "wake_sample",
        source: src,
        note: "用户自述（问卷/对话）",
      });
    }
    if (bedtime !== null) {
      out.push({
        dimension: "sleep",
        at: `${date}T${formatHour(bedtime)}:00`,
        value: bedtime,
        value2: wake ?? bedtime,
        kind: "sleep_sample",
        source: src,
        note: "用户自述（问卷/对话）",
      });
    }
    // 自述通勤只给"离家"这一条腿：问卷问的是出门时间与通勤时长，没有围栏事实，
    // 就不硬编到公司与离公司两个时刻（宁缺勿假）。
    if (wake !== null && Number.isFinite(report.commuteMinutes ?? NaN)) {
      const leave = wake + (report.commuteMinutes as number) / 60;
      out.push({
        dimension: "commute",
        at: `${date}T${formatHour(leave)}:00`,
        value: ((leave % 24) + 24) % 24,
        kind: "commute_leave_home",
        source: src,
        note: "用户自述通勤时长推算",
      });
    }
    return out;
  }
}

// ─── 桶 → 夜/晨分组 ─────────────────────────────

/**
 * 把桶按"夜"分组：一晚 = [D 18:00, D+1 06:00) 的晚间段 + [D+1 03:00, D+1 12:00)
 * 的清晨段，两段共用 D+1 这个"起床日"。凌晨 0-6 点的桶归前一晚（"周五熬夜"
 * 算周五的样本），并同时进清晨段（同一次 5 点起床在两段都看得见）。
 */
function groupNights(rows: BucketView[]): NightBuckets[] {
  const nights = new Map<string, NightBuckets>();
  const ensure = (ownerDay: string): NightBuckets => {
    let night = nights.get(ownerDay);
    if (!night) {
      night = {
        date: ownerDay,
        wakeDate: shiftDayKey(ownerDay, 1),
        evening: [],
        morning: [],
        chargingDuringNight: false,
      };
      nights.set(ownerDay, night);
    }
    return night;
  };
  for (const row of rows) {
    const local = new Date(row.bucketMs);
    const hour = local.getHours() + local.getMinutes() / 60;
    const dayKey = localDayKey(local);
    const inEvening = hour >= ONSET_SEARCH_START_HOUR || hour < ONSET_SEARCH_END_HOUR;
    const inMorning = hour >= WAKE_SEARCH_START_HOUR && hour < WAKE_SEARCH_END_HOUR;
    if (!inEvening && !inMorning) continue;
    // 晚间段的桶属于"上床那天"：凌晨 0-6 点要挪回前一天
    if (inEvening) {
      const ownerDay = hour < ONSET_SEARCH_END_HOUR ? shiftDayKey(dayKey, -1) : dayKey;
      const night = ensure(ownerDay);
      night.evening.push(row);
      if (row.charging) night.chargingDuringNight = true;
    }
    // 清晨段的桶属于"它结束的那一晚"：周二 07:00 的解锁是周一夜的醒来
    if (inMorning) {
      const night = ensure(shiftDayKey(dayKey, -1));
      night.morning.push(row);
      if (row.charging) night.chargingDuringNight = true;
    }
  }
  return [...nights.values()].sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * 入睡时刻：晚间段最后一个"有亮屏或解锁"的桶 + 桶长，要求其后再静默
 * ≥ SILENT_STREAK_MIN。返回 null = 这一晚没活动记录或静默不够（手机整晚没电/
 * 没带），宁缺勿假。
 */
function deriveSleepOnset(evening: BucketView[]): number | null {
  if (evening.length === 0) return null;
  const sorted = [...evening].sort((a, b) => a.bucketMs - b.bucketMs);
  let lastActiveIdx = -1;
  for (let i = sorted.length - 1; i >= 0; i--) {
    const row = sorted[i]!;
    if (row.screenOnMin > 0 || row.unlocks > 0) {
      lastActiveIdx = i;
      break;
    }
  }
  if (lastActiveIdx < 0) return null;
  let silentMin = 0;
  for (let i = lastActiveIdx + 1; i < sorted.length; i++) {
    const row = sorted[i]!;
    if (row.screenOnMin > 0 || row.unlocks > 0) break;
    silentMin += BUCKET_MIN;
  }
  if (silentMin < SILENT_STREAK_MIN) return null;
  const local = new Date(sorted[lastActiveIdx]!.bucketMs);
  const hour = local.getHours() + local.getMinutes() / 60 + BUCKET_MIN / 60;
  return roundHour(hour % 24);
}

/**
 * 醒来时刻：清晨段静默 ≥ WAKE_MIN_SILENT_MIN 之后的首次解锁；整段没有解锁
 * 记录时退化为首次连续亮屏（息屏闹钟/手表解锁的场景）。
 */
function deriveWakeTime(morning: BucketView[]): { hour: number; by: "unlock" | "screen" } | null {
  if (morning.length === 0) return null;
  const sorted = [...morning].sort((a, b) => a.bucketMs - b.bucketMs);
  let silentMin = 0;
  let screenFallback: { hour: number; by: "screen" } | null = null;
  for (const row of sorted) {
    const local = new Date(row.bucketMs);
    const hour = local.getHours() + local.getMinutes() / 60;
    if (row.unlocks <= 0 && row.screenOnMin <= 0) {
      silentMin += BUCKET_MIN;
      continue;
    }
    if (silentMin >= WAKE_MIN_SILENT_MIN && row.unlocks > 0) {
      return { hour: roundHour(hour), by: "unlock" };
    }
    if (silentMin >= WAKE_MIN_SILENT_MIN && row.screenOnMin >= WAKE_SCREEN_ON_MIN && !screenFallback) {
      screenFallback = { hour: roundHour(hour), by: "screen" };
    }
    // 静默被中断（夜里刷手机）：重新等一段静默之后的第一次交互
    silentMin = 0;
  }
  return screenFallback;
}

/** 睡眠时长（小时）；跨零点自动 +24，出合理带返回 null */
function sleepDurationHours(onset: number, wake: number): number | null {
  const span = wake + (wake < onset ? 24 : 0) - onset;
  if (span < MIN_SLEEP_HOURS || span > MAX_SLEEP_HOURS) return null;
  return span;
}

// ─── 通勤：placeKind 跳变 ────────────────────────

/**
 * 家→非家 = 离家；非家→家 = 到家；公司侧同理。一天每条腿只记**首次**跳变
 * （中位数与按星期分布在 commute-model 里算，这里只出事实）。
 */
function deriveCommuteObservations(rows: BucketView[], source: string): RhythmObservation[] {
  const out: RhythmObservation[] = [];
  const seen = new Set<string>();
  for (let i = 1; i < rows.length; i++) {
    const prev = rows[i - 1]!;
    const cur = rows[i]!;
    // unknown 是"没定位到"而不是"在别处"：两侧都要有明确地点才认这次跳变，
    // 否则室内无信号会被整段判成离家。
    if (prev.placeKind === "unknown" || cur.placeKind === "unknown") continue;
    if (prev.placeKind === cur.placeKind) continue;
    const local = new Date(cur.bucketMs);
    const dayKey = localDayKey(local);
    const value = roundHour(local.getHours() + local.getMinutes() / 60);
    const emit = (leg: string, kind: RhythmObservation["kind"]): void => {
      const key = `${leg}|${dayKey}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push({
        dimension: "commute",
        at: `${dayKey}T${formatHour(value)}:00`,
        value,
        kind,
        source,
      });
    };
    if (prev.placeKind === "home" && cur.placeKind !== "home") emit("leave_home", "commute_leave_home");
    if (prev.placeKind !== "home" && cur.placeKind === "home") emit("arrive_home", "commute_arrive_home");
    if (prev.placeKind !== "work" && cur.placeKind === "work") emit("arrive_work", "commute_arrive_work");
    if (prev.placeKind === "work" && cur.placeKind !== "work") emit("leave_work", "commute_leave_work");
  }
  return out;
}

function roundHour(h: number): number {
  return Math.round(h * 1000) / 1000;
}
