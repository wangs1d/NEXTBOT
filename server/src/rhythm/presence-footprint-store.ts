/**
 * 在场足迹：agent 自己观察「用户什么时候在线」，作为作息的被动推断源。
 *
 * 为什么需要它：作息原本只有两条来源——① AwarenessCortex 的睡眠样本，要求
 * 夜间 23:00–06:00 且桌面无活动 ≥30 分钟才记一条（真实用户凌晨仍在用 agent，
 * 该状态几乎永不成立，样本恒为 0）；② 对话文本抽取（脆弱且依赖用户主动说）。
 * 两者都不达标，导致分级提醒的作息个性化长期休眠。
 *
 * 本模块换一条更朴素的路：**用户在场 = 用户醒着**。agent 每次被使用（工具调用、
 * 对话、主动信号）都打一个时间戳，按本地日聚合成 24 槽活跃直方图；连续几晚之后，
 * 「当夜最后一次在线」与「次日早晨首次在线」就把作息框出来了。这是 agent 用自己
 * 的眼睛观察出来的，不是用户说的、也不是靠苛刻的睡眠状态判定。
 *
 * 推断刻意保守（宁缺勿错，错记作息会连带错排睡前备忘与闹钟）：
 *   - 入睡证据只采信当夜最后活跃 ≥21:00 的日子；白天就断线的一天说明不了几点睡。
 *   - 活跃槽按区间右端计（01:47 落在 01 槽 → 按 02:00 算），再叠 0.5h 入睡缓冲，
 *     因此推断只可能偏晚、不会偏早——睡前备忘宁可晚到，也不该提前一小时打扰。
 *   - 起床证据只采信 04:00–11:00 的首次在线，避免「下午才开电脑」被当成睡到下午。
 *   - 入睡/起床各需 ≥3 个有效夜才产出，不足返回 null，策略层回退默认时刻。
 *
 * 存储：单 JSON（默认 data/rhythm/presence-footprint.json），键 = actorId。
 * 打点频繁（每次工具调用/每轮对话），故落盘走 30s 防抖 + 显式 flush。
 */

import { getDataDir } from "../config/data-dir.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** 单日在场足迹：本地自然日（按服务端本地时区切分） */
export type DailyFootprint = {
  /** YYYY-MM-DD（本地） */
  date: string;
  /** 24 槽活跃计数：activeHours[h] = 该小时内的在场事件数 */
  activeHours: number[];
  /** 当日首次在场（十进制本地小时，null=无记录） */
  firstHour: number | null;
  /** 当日末次在场（十进制本地小时） */
  lastHour: number | null;
  /** 当日事件总数 */
  total: number;
};

/** 夜段起点：当日 18:00 起算 */
const NIGHT_START_HOUR = 18;
/**
 * 夜段终点：次日 05:00 止（次日 0–4 点的活跃才算「熬夜」，05:00 起归早晨）。
 * 必须与起床证据区间不重叠，否则「早上 9 点开电脑」会被误读成「熬夜到 9 点」。
 */
const NIGHT_END_HOUR = 5;
/** 入睡证据下限：当夜最后活跃 ≥21:00 才采信（更早的断线说明不了几点睡） */
const SLEEP_EVIDENCE_MIN_HOUR = 21;
/** 起床证据区间：05:00–11:00 的首次在线才算「早起」证据（下午开电脑≠睡到下午） */
const WAKE_EVIDENCE_MIN_HOUR = 5;
const WAKE_EVIDENCE_MAX_HOUR = 11;
/** 末次在线到真正入睡的缓冲（小时） */
const FALL_ASLEEP_BUFFER_H = 0.5;
/** 起床到首次被观察到在线的缓冲（小时） */
const WAKE_BUFFER_H = 0.5;
/** 有效夜数门槛 */
export const PRESENCE_MIN_NIGHTS = 3;

const FILE_VERSION = 1;
/** 每 actor 保留的天数上限（滚动窗口，避免无限增长） */
const MAX_DAYS_PER_ACTOR = 45;
/** 落盘防抖 */
const PERSIST_DEBOUNCE_MS = 30_000;

function emptyDay(date: string): DailyFootprint {
  return {
    date,
    activeHours: new Array<number>(24).fill(0),
    firstHour: null,
    lastHour: null,
    total: 0,
  };
}

/** 本地日键 YYYY-MM-DD */
export function localDayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** 十进制本地小时（13.5 = 13:30） */
function decimalHour(d: Date): number {
  return d.getHours() + d.getMinutes() / 60;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * 从逐日在场足迹推导入睡/起床点（纯函数，便于单测）。
 *
 * 一「夜」= 当日 18:00 → 次日 12:00。入睡取该夜最后活跃槽的右端 + 缓冲，
 * 起床取次日 04:00–11:00 的首个活跃槽 − 缓冲；两侧各需 ≥PRESENCE_MIN_NIGHTS 个
 * 有效夜，否则对应字段为 null（策略层按字段可用性分别回退）。
 */
export function deriveSleepFromFootprints(
  days: DailyFootprint[],
  opts: { minNights?: number; now?: Date } = {},
): { sleepStartHour: number | null; wakeHour: number | null; nightCount: number } {
  const minNights = opts.minNights ?? PRESENCE_MIN_NIGHTS;
  const byDate = new Map<string, DailyFootprint>();
  for (const d of days) {
    if (d?.date && Array.isArray(d.activeHours) && d.activeHours.length === 24) byDate.set(d.date, d);
  }
  if (byDate.size === 0) return { sleepStartHour: null, wakeHour: null, nightCount: 0 };

  const sleepSamples: number[] = [];
  const wakeSamples: number[] = [];

  // 每个有足迹的日子都作为「当晚」；次日足迹可能不存在（用户整晚没再来）
  const dates = [...byDate.keys()].sort();
  for (const date of dates) {
    const day = byDate.get(date)!;
    const nextDate = nextDay(date);
    const next = byDate.get(nextDate) ?? null;

    // ── 入睡证据：当夜最后活跃（次日凌晨的活跃按 +24 接续） ──
    let nightLastAbs: number | null = null;
    for (let h = NIGHT_START_HOUR; h < 24; h++) {
      if ((day.activeHours[h] ?? 0) > 0) nightLastAbs = h;
    }
    if (next) {
      for (let h = 0; h < NIGHT_END_HOUR; h++) {
        if ((next.activeHours[h] ?? 0) > 0) nightLastAbs = h + 24;
      }
    }
    // 活跃槽按右端计（保守：只可能估晚），再叠入睡缓冲
    if (nightLastAbs != null && nightLastAbs + 1 >= SLEEP_EVIDENCE_MIN_HOUR) {
      sleepSamples.push(nightLastAbs + 1 + FALL_ASLEEP_BUFFER_H);
    }

    // ── 起床证据：次日 04:00–11:00 的首次在线 ──
    if (next) {
      for (let h = WAKE_EVIDENCE_MIN_HOUR; h <= WAKE_EVIDENCE_MAX_HOUR; h++) {
        if ((next.activeHours[h] ?? 0) > 0) {
          wakeSamples.push(Math.max(0, h - WAKE_BUFFER_H));
          break;
        }
      }
    }
  }

  const sleepStartHour =
    sleepSamples.length >= minNights ? round1(median(sleepSamples) % 24) : null;
  const wakeHour = wakeSamples.length >= minNights ? round1(median(wakeSamples) % 24) : null;
  return { sleepStartHour, wakeHour, nightCount: sleepSamples.length };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** 日期 +1 天（纯字符串运算，避免时区往返） */
function nextDay(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  const dt = new Date(y!, (m ?? 1) - 1, d!);
  dt.setDate(dt.getDate() + 1);
  return localDayKey(dt);
}

// ── 存储 ────────────────────────────────────────────────────────────────

export class PresenceFootprintStore {
  private readonly actors = new Map<string, Map<string, DailyFootprint>>();
  private dirty = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly filePath: string) {}

  load(): void {
    try {
      if (!existsSync(this.filePath)) return;
      const raw = JSON.parse(readFileSync(this.filePath, "utf8")) as {
        actors?: Record<string, { days?: Record<string, Partial<DailyFootprint>> }>;
      };
      for (const [actorId, entry] of Object.entries(raw.actors ?? {})) {
        const days = new Map<string, DailyFootprint>();
        for (const [date, d] of Object.entries(entry?.days ?? {})) {
          if (!Array.isArray(d?.activeHours) || d.activeHours.length !== 24) continue;
          days.set(date, {
            date,
            activeHours: d.activeHours.map((n) => (Number.isFinite(n) ? Number(n) : 0)),
            firstHour: Number.isFinite(d.firstHour) ? Number(d.firstHour) : null,
            lastHour: Number.isFinite(d.lastHour) ? Number(d.lastHour) : null,
            total: Number.isFinite(d.total) ? Number(d.total) : 0,
          });
        }
        if (days.size > 0) this.actors.set(actorId, days);
      }
    } catch {
      /* 损坏文件按空处理 */
    }
  }

  /**
   * 打一次在场点。调用点：工具执行 / 对话轮次 / 主动信号命中。
   * @param at 在场时刻（默认当前）
   * @param weight 该次在场的权重（默认 1；弱信号可传 <1）
   */
  record(actorId: string, at: Date | number = new Date(), weight = 1): void {
    if (!actorId) return;
    const d = at instanceof Date ? at : new Date(at);
    if (Number.isNaN(d.getTime())) return;
    if (!Number.isFinite(weight) || weight <= 0) weight = 1;

    let days = this.actors.get(actorId);
    if (!days) {
      days = new Map();
      this.actors.set(actorId, days);
    }
    const key = localDayKey(d);
    const day = days.get(key) ?? emptyDay(key);
    const hour = d.getHours();
    const dec = decimalHour(d);
    day.activeHours[hour] = (day.activeHours[hour] ?? 0) + weight;
    day.firstHour = day.firstHour == null ? dec : Math.min(day.firstHour, dec);
    day.lastHour = day.lastHour == null ? dec : Math.max(day.lastHour, dec);
    day.total += weight;
    days.set(key, day);

    this.trim(days);
    this.schedulePersist();
  }

  /** 保留最近 MAX_DAYS_PER_ACTOR 天 */
  private trim(days: Map<string, DailyFootprint>): void {
    if (days.size <= MAX_DAYS_PER_ACTOR) return;
    const sorted = [...days.keys()].sort();
    for (const old of sorted.slice(0, days.size - MAX_DAYS_PER_ACTOR)) days.delete(old);
  }

  /** 最近 N 天足迹（按日期升序） */
  recentDays(actorId: string, days: number): DailyFootprint[] {
    const all = [...(this.actors.get(actorId)?.values() ?? [])];
    return all.sort((a, b) => a.date.localeCompare(b.date)).slice(-Math.max(1, days));
  }

  /** 某 actor 是否有任何足迹（判断是否冷启动） */
  hasAny(actorId: string): boolean {
    return (this.actors.get(actorId)?.size ?? 0) > 0;
  }

  /**
   * 推导入睡/起床点。有效夜不足时对应字段为 null。
   * @param lookbackDays 回看天数（默认 14）
   */
  deriveSleepWindow(
    actorId: string,
    opts: { lookbackDays?: number; minNights?: number } = {},
  ): { sleepStartHour: number | null; wakeHour: number | null; nightCount: number } {
    const days = this.recentDays(actorId, opts.lookbackDays ?? 14);
    return deriveSleepFromFootprints(days, { minNights: opts.minNights ?? PRESENCE_MIN_NIGHTS });
  }

  /** 诊断用：导出某 actor 的全部足迹 */
  listDays(actorId: string): DailyFootprint[] {
    return [...(this.actors.get(actorId)?.values() ?? [])].sort((a, b) => a.date.localeCompare(b.date));
  }

  listActorIds(): string[] {
    return [...this.actors.keys()];
  }

  // ── 落盘 ──

  private schedulePersist(): void {
    this.dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.persist();
    }, PERSIST_DEBOUNCE_MS);
    this.timer.unref?.();
  }

  persist(): void {
    if (!this.dirty) return;
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      const actors: Record<string, { days: Record<string, DailyFootprint> }> = {};
      for (const [actorId, days] of this.actors) {
        const out: Record<string, DailyFootprint> = {};
        // 只存有事件的日（避免 0 值噪声）
        for (const [date, d] of days) if (d.total > 0) out[date] = d;
        if (Object.keys(out).length > 0) actors[actorId] = { days: out };
      }
      writeFileSync(this.filePath, JSON.stringify({ version: FILE_VERSION, actors }, null, 2));
      this.dirty = false;
    } catch (err) {
      console.warn("[PresenceFootprintStore] 落盘失败（忽略）:", err);
    }
  }

  /** 立即落盘并停掉防抖定时器（停机/测试用） */
  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.persist();
  }
}

// ── 单例（与 codebase 既有 getXxxService() 模式一致） ─────────────────────

let singleton: PresenceFootprintStore | null = null;

export function initPresenceFootprintStore(filePath?: string): PresenceFootprintStore {
  const path = filePath ?? join(getDataDir(), "rhythm", "presence-footprint.json");
  const store = new PresenceFootprintStore(path);
  store.load();
  singleton = store;
  return store;
}

export function getPresenceFootprintStore(): PresenceFootprintStore | null {
  return singleton;
}

/** 测试用：清空单例 */
export function __resetPresenceFootprintStoreForTest(): void {
  singleton = null;
}
