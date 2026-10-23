/**
 * 用户作息偏好（分级提醒的冷启动习惯源）。
 *
 * 背景：分级提醒策略的作息个性化原本只吃「被动睡眠样本」——AwarenessCortex 在
 * 夜间（23:00–06:00）判定桌面无活动 ≥30 分钟才记一条入睡/醒来样本，且要连续
 * 多晚凑够 ≥3 条才可信。冷启动期样本恒为 0，策略一直走默认 21:00 睡前备忘 /
 * 06:00 闹钟下限——个性化分支实际休眠。本模块补一条立即可用的来源：
 *   - 用户显式设定（设置项 / agent 工具）；
 *   - 用户在对话里自述作息（确定性规则抽取，零 LLM）。
 * 两者都归一成同一个 `ScheduleHabitHints`，接进既有的 habit provider 接缝。
 *
 * 与睡眠样本的分工（provider 取值顺序，见 bootstrap 装配）：
 *   显式设定 > 被动睡眠样本(≥3) > 对话自述 > 节律画像维度
 * 显式设定是用户的主动配置，视为权威、可覆盖观测；对话自述同样是经验值，
 * 排在观测样本之后（观测更接近真实行为）。
 *
 * 存储：单 JSON（默认 data/schedule/sleep-routine.json），键 = actorId。
 * 数据量极小；读路径全内存（provider 每次建任务都会调一次，须同步零 IO）。
 */

import { getDataDir } from "../config/data-dir.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type SleepRoutineSource = "explicit" | "chat";

export type SleepRoutine = {
  /** 入睡（十进制本地小时，1.5 = 01:30） */
  sleepStartHour: number;
  /** 起床（十进制本地小时，8 = 08:00） */
  wakeHour: number;
  /** explicit=用户主动设定；chat=对话自述抽取 */
  source: SleepRoutineSource;
  updatedAt: string;
};

/** 入睡合理区间：晚间 18:00–24:00 或凌晨 00:00–08:00（其余视为误抽） */
const SLEEP_HOUR_MIN = 18;
const SLEEP_HOUR_MAX = 8; // 跨午夜：> 18 或 < 8
/** 起床合理区间：03:00–15:00 */
const WAKE_HOUR_MIN = 3;
const WAKE_HOUR_MAX = 15;

export function isPlausibleSleepStartHour(hour: number): boolean {
  if (!Number.isFinite(hour)) return false;
  const h = ((hour % 24) + 24) % 24;
  return h >= SLEEP_HOUR_MIN || h <= SLEEP_HOUR_MAX;
}

export function isPlausibleWakeHour(hour: number): boolean {
  if (!Number.isFinite(hour)) return false;
  const h = ((hour % 24) + 24) % 24;
  return h >= WAKE_HOUR_MIN && h <= WAKE_HOUR_MAX;
}

// ── 对话自述抽取（确定性规则，零 LLM） ───────────────────────────────────

const CN_DIGITS: Record<string, number> = {
  零: 0,
  〇: 0,
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
};

/** 睡眠线索（"睡前"里的"睡"也会命中，因此只在时钟邻域内匹配，不影响别处） */
const SLEEP_CUE = /(入睡|睡觉|睡|就寝|上床|躺下|休息|安寝|眠|歇)/;
/** 起床线索 */
const WAKE_CUE = /(起床|醒来|醒|闹钟|叫醒|起)/;

function normalizeDigits(s: string): string {
  return s.replace(/[０-９]/g, (d) => String(d.charCodeAt(0) - 0xff10));
}

function cnHourToNumber(token: string): number | null {
  if (/^[0-9]{1,2}$/.test(token)) {
    const n = Number(token);
    return n >= 0 && n <= 24 ? n : null;
  }
  if (token === "十") return 10;
  if (token === "十一") return 11;
  if (token === "十二") return 12;
  if (token.length === 1) return CN_DIGITS[token] ?? null;
  const m = /^十([一二三四五六七八九])$/.exec(token);
  if (m) return 10 + (CN_DIGITS[m[1]!] ?? 0);
  return null;
}

type Clock = { index: number; endIndex: number; hour: number; minute: number };

/** 在文本中找出第一个「X:MM」或「X点[Y分|半]」形式的时间；找不到返回 null */
function findClocks(text: string): Clock[] {
  const clocks: Clock[] = [];
  const colonRe = /([0-9]{1,2})\s*[:：]\s*([0-9]{1,2})/g;
  let m: RegExpExecArray | null;
  while ((m = colonRe.exec(text)) !== null) {
    const hour = Number(m[1]);
    const minute = Number(m[2]);
    if (hour <= 24 && minute <= 59) {
      clocks.push({ index: m.index, endIndex: m.index + m[0].length, hour, minute });
    }
  }
  const dianRe = /([0-9]{1,2}|[零〇一二两三四五六七八九十]{1,3})\s*点\s*(半|[0-9]{1,2}\s*分?)?/g;
  while ((m = dianRe.exec(text)) !== null) {
    const hour = cnHourToNumber(m[1]!);
    if (hour == null || hour > 24) continue;
    let minute = 0;
    if (m[2]) {
      if (m[2].startsWith("半")) minute = 30;
      else {
        const v = Number(m[2].replace(/[^0-9]/g, ""));
        if (!Number.isFinite(v) || v > 59) continue;
        minute = v;
      }
    }
    clocks.push({ index: m.index, endIndex: m.index + m[0].length, hour, minute });
  }
  return clocks.sort((a, b) => a.index - b.index);
}

/**
 * 从一句话里解析用户的作息（入睡点 + 起床点）。
 *
 * 只认「时钟紧邻线索词」的写法（如 "1点半睡" / "早上8点起" / "23:30 睡觉"），
 * 两侧线索冲突或缺失即返回 null——宁缺勿错，错记作息会连带错排睡前备忘与闹钟。
 */
export function parseSleepRoutine(text: string): { sleepStartHour: number; wakeHour: number } | null {
  const s = normalizeDigits(String(text ?? ""));
  if (!s.trim()) return null;
  let sleepStartHour: number | null = null;
  let wakeHour: number | null = null;

  for (const clock of findClocks(s)) {
    // 时钟邻域：优先看其后 4 个字符（"1点半睡" / "23:30 起床"），
    // 再回看其前 4 个字符（"睡的时候是1点"）。
    const after = s.slice(clock.endIndex, clock.endIndex + 4);
    const before = s.slice(Math.max(0, clock.index - 4), clock.index);
    const isSleep = SLEEP_CUE.test(after) || (!WAKE_CUE.test(after) && SLEEP_CUE.test(before));
    const isWake = WAKE_CUE.test(after) || (!SLEEP_CUE.test(after) && WAKE_CUE.test(before));
    if (isSleep && !isWake) {
      const normalized = normalizeSleepHour(clock, before, after);
      if (normalized != null && sleepStartHour == null) sleepStartHour = normalized;
    } else if (isWake && !isSleep) {
      const normalized = normalizeWakeHour(clock, before, after);
      if (normalized != null && wakeHour == null) wakeHour = normalized;
    }
  }

  if (sleepStartHour == null || wakeHour == null) return null;
  if (!isPlausibleSleepStartHour(sleepStartHour) || !isPlausibleWakeHour(wakeHour)) return null;
  return { sleepStartHour, wakeHour };
}

function normalizeSleepHour(clock: Clock, before: string, after: string): number | null {
  const ctx = `${before}${after}`;
  const pm = /(晚上|下午|夜里|半夜|傍晚|晚间)/.test(ctx);
  const am = /(早上|上午|早晨|清晨|凌晨|一早)/.test(ctx);
  const { hour, minute } = clock;
  if (hour === 24) return minute === 0 ? 0 : null;
  if (hour === 12) return am ? 12 + minute / 60 : minute / 60; // 凌晨12点=午夜0点
  if (pm && hour < 12) return hour + 12 + minute / 60;
  if (hour >= 13) return hour + minute / 60;
  if (hour >= 1 && hour <= 6) return hour + minute / 60; // 凌晨
  if (hour >= 7 && hour <= 11) return am ? null : hour + 12 + minute / 60; // 无标记的 7~11 点=晚上
  return null;
}

function normalizeWakeHour(clock: Clock, before: string, after: string): number | null {
  const ctx = `${before}${after}`;
  const pm = /(下午|傍晚|晚上)/.test(ctx);
  const { hour, minute } = clock;
  if (hour === 24) return minute === 0 ? 0 : null;
  if (hour === 12) return pm ? 12 + minute / 60 : minute / 60; // 中午12点=12:00
  if (pm && hour < 12) return hour + 12 + minute / 60;
  if (hour > 23) return null;
  return hour + minute / 60;
}

// ── 存储 ────────────────────────────────────────────────────────────────

const FILE_VERSION = 1;

export class ScheduleHabitStore {
  private readonly routines = new Map<string, SleepRoutine>();

  constructor(private readonly filePath: string) {}

  load(): void {
    try {
      if (!existsSync(this.filePath)) return;
      const raw = JSON.parse(readFileSync(this.filePath, "utf8")) as {
        actors?: Record<string, Partial<SleepRoutine>>;
      };
      for (const [actorId, entry] of Object.entries(raw.actors ?? {})) {
        if (
          typeof entry?.sleepStartHour === "number" &&
          typeof entry?.wakeHour === "number" &&
          isPlausibleSleepStartHour(entry.sleepStartHour) &&
          isPlausibleWakeHour(entry.wakeHour)
        ) {
          this.routines.set(actorId, {
            sleepStartHour: entry.sleepStartHour,
            wakeHour: entry.wakeHour,
            source: entry.source === "chat" ? "chat" : "explicit",
            updatedAt: typeof entry.updatedAt === "string" ? entry.updatedAt : new Date().toISOString(),
          });
        }
      }
    } catch {
      /* 损坏文件按空处理 */
    }
  }

  private persist(): void {
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      const actors: Record<string, SleepRoutine> = {};
      for (const [actorId, routine] of this.routines) actors[actorId] = routine;
      writeFileSync(this.filePath, JSON.stringify({ version: FILE_VERSION, actors }, null, 2));
    } catch (err) {
      console.warn("[ScheduleHabitStore] 落盘失败（忽略）:", err);
    }
  }

  get(actorId: string): SleepRoutine | null {
    return this.routines.get(actorId) ?? null;
  }

  set(actorId: string, routine: { sleepStartHour: number; wakeHour: number }, source: SleepRoutineSource): SleepRoutine {
    const record: SleepRoutine = {
      sleepStartHour: routine.sleepStartHour,
      wakeHour: routine.wakeHour,
      source,
      updatedAt: new Date().toISOString(),
    };
    this.routines.set(actorId, record);
    this.persist();
    return record;
  }

  clear(actorId: string): boolean {
    const had = this.routines.delete(actorId);
    if (had) this.persist();
    return had;
  }

  /** 全部条目（诊断/接口用） */
  list(): Array<{ actorId: string } & SleepRoutine> {
    return [...this.routines].map(([actorId, r]) => ({ actorId, ...r }));
  }

  /**
   * 对话自述捕获：命中作息表述才写；与已有值相同则跳过（避免每轮重复落盘）。
   * 返回是否发生写入。
   */
  captureFromUserText(actorId: string, text: string): boolean {
    if (!actorId) return false;
    const parsed = parseSleepRoutine(text);
    if (!parsed) return false;
    const existing = this.routines.get(actorId);
    if (
      existing &&
      existing.sleepStartHour === parsed.sleepStartHour &&
      existing.wakeHour === parsed.wakeHour
    ) {
      return false;
    }
    this.set(actorId, parsed, "chat");
    console.log(
      `[ScheduleHabitStore] 对话自述作息入档：${actorId} 入睡${formatHour(parsed.sleepStartHour)} / 起床${formatHour(parsed.wakeHour)}`,
    );
    return true;
  }
}

function formatHour(h: number): string {
  const norm = ((h % 24) + 24) % 24;
  return `${String(Math.floor(norm)).padStart(2, "0")}:${String(Math.round((norm % 1) * 60) % 60).padStart(2, "0")}`;
}

// ── 单例（与 codebase 既有 getXxxService() 模式一致，避免构造序穿线） ──────

let singleton: ScheduleHabitStore | null = null;

export function initScheduleHabitStore(filePath?: string): ScheduleHabitStore {
  const path = filePath ?? join(getDataDir(), "schedule", "sleep-routine.json");
  const store = new ScheduleHabitStore(path);
  store.load();
  singleton = store;
  return store;
}

export function getScheduleHabitStore(): ScheduleHabitStore | null {
  return singleton;
}

/** 测试用：清空单例 */
export function __resetScheduleHabitStoreForTest(): void {
  singleton = null;
}
