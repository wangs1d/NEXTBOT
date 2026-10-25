/**
 * 用户节奏档案（UserRhythmStore，2026-10-23 个性化闭环）。
 *
 * 定位：分级提醒策略（schedule-reminder-policy）的**用户因子源**之一——
 * 与 ScheduleHabitHints（作息画像）同范式，但管的是「做事节奏」维度：
 *   - departurePrepMin：起床到出门的准备分钟数（策略层默认 high=60/normal=40，
 *     有了用户实测值后按人给，不再一刀切——动作快的人少闹一次，慢的人多留余量）。
 *
 * 学习闭环（对症下药）：
 *   - explicit：用户自述（"我收拾得快，20 分钟就够"）→ 权威，直接生效；
 *   - observed：确定性观察回写（如用户在出发提醒后 X 分钟内确认已出门 →
 *     记一次实测准备耗时）→ observeDepartureMinutes 滚动均值，≥2 次才生效
 *     （宁缺勿错，与 HABIT_MIN_SAMPLES 同纪律）。
 *
 * 存储：JSON 落盘（与 watch-tasks/habit 同风格），purgeActor 供隐私级联清理。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type UserRhythmSource = "explicit" | "observed";

export type UserRhythmHints = {
  /** 出门准备分钟数；null=证据不足，策略层回退默认 */
  departurePrepMin: number | null;
  source: UserRhythmSource;
};

type ActorRhythm = {
  departurePrepMin?: number | null;
  prepSource?: UserRhythmSource;
  /** observed 滚动样本（最近 5 次实测），explicit 单条即生效不进样本 */
  prepSamples?: number[];
  updatedAt?: string;
};

type PersistedRhythm = { actors?: Record<string, ActorRhythm> };

/** 出门准备分钟的合理域（策略层架构假设：>0 且 ≤ 半天的一半） */
export const PREP_MIN_FLOOR = 10;
export const PREP_MIN_CEILING = 180;
/** observed 实测样本达到该次数才可信托管（explicit 不受此限） */
export const PREP_MIN_OBSERVED_SAMPLES = 2;
const MAX_SAMPLES = 5;

function readJson(path: string): PersistedRhythm {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as PersistedRhythm;
  } catch {
    return {};
  }
}

function clampPrep(min: number): number | null {
  if (!Number.isFinite(min) || min <= 0) return null;
  return Math.round(Math.min(PREP_MIN_CEILING, Math.max(PREP_MIN_FLOOR, min)));
}

export type UserRhythmStoreDeps = {
  persistPath: string;
  now?: () => Date;
};

export class UserRhythmStore {
  private readonly data: PersistedRhythm;
  private readonly nowFn: () => Date;

  constructor(private readonly deps: UserRhythmStoreDeps) {
    this.nowFn = deps.now ?? (() => new Date());
    this.data = readJson(deps.persistPath);
    const dir = dirname(deps.persistPath);
    if (!existsSync(dir)) {
      try {
        mkdirSync(dir, { recursive: true });
      } catch {
        /* 目录创建失败时写盘会再报，构造不挡装配 */
      }
    }
  }

  private flush(): void {
    try {
      writeFileSync(this.deps.persistPath, JSON.stringify(this.data, null, 2));
    } catch (err) {
      console.log(`[user-rhythm] 落盘失败（忽略）: ${err instanceof Error ? err.message : err}`);
    }
  }

  private actor(actorId: string): ActorRhythm {
    if (!this.data.actors) this.data.actors = {};
    if (!this.data.actors[actorId]) this.data.actors[actorId] = {};
    return this.data.actors[actorId];
  }

  /**
   * 读出门准备因子（策略层消费）。explicit 直接生效；
   * observed 需 ≥PREP_MIN_OBSERVED_SAMPLES 次实测（宁缺勿错）。
   */
  hintsFor(actorId: string): UserRhythmHints {
    const a = this.data.actors?.[actorId];
    if (!a) return { departurePrepMin: null, source: "observed" };
    if (a.prepSource === "explicit" && a.departurePrepMin != null) {
      return { departurePrepMin: a.departurePrepMin, source: "explicit" };
    }
    const samples = a.prepSamples ?? [];
    if (samples.length >= PREP_MIN_OBSERVED_SAMPLES) {
      const avg = samples.reduce((s, v) => s + v, 0) / samples.length;
      return { departurePrepMin: clampPrep(avg) ?? a.departurePrepMin ?? null, source: "observed" };
    }
    return { departurePrepMin: null, source: "observed" };
  }

  /** 用户自述节奏（设置/对话里明确说了准备耗时）——权威，单条生效并覆盖 observed。 */
  setDeparturePrepMin(actorId: string, minutes: number): number | null {
    const v = clampPrep(minutes);
    if (v == null) return null;
    const a = this.actor(actorId);
    a.departurePrepMin = v;
    a.prepSource = "explicit";
    a.updatedAt = this.nowFn().toISOString();
    this.flush();
    return v;
  }

  /** 记一次实测准备耗时（确定性观察回写），滚动均值。 */
  observeDepartureMinutes(actorId: string, minutes: number): void {
    const v = clampPrep(minutes);
    if (v == null) return;
    const a = this.actor(actorId);
    if (a.prepSource === "explicit") return; // 用户自述优先，观察不覆盖
    a.prepSamples = [...(a.prepSamples ?? []), v].slice(-MAX_SAMPLES);
    a.updatedAt = this.nowFn().toISOString();
    this.flush();
  }

  /** 隐私级联：清空该 actor 的节奏档案。 */
  purgeActor(actorId: string): boolean {
    if (!this.data.actors?.[actorId]) return false;
    delete this.data.actors[actorId];
    this.flush();
    return true;
  }
}

/**
 * 从结构化事实（字段/值）解析出门准备分钟数——统一抽取钩子的桥接判据。
 * 命中「出门准备/收拾/准备出门」字段且值带可解析的分钟数才返回数值。
 * 例：field=出门准备 value=20分钟 → 20；value=半小时 → 30；field=职业 → null。
 */
export function parsePrepMinutesFromFact(field: string, value: string): number | null {
  const f = String(field ?? "");
  if (!/出门准备|收拾|准备出门/.test(f)) return null;
  const v = String(value ?? "");
  const halfHour = /半\s*小时/.test(v);
  const m = v.match(/(\d+(?:\.\d+)?)\s*(?:分钟|分|min)/);
  if (m) {
    const min = Number(m[1]) * (halfHour && !/分钟/.test(v) ? 30 : 1);
    return clampPrep(min);
  }
  if (halfHour) return clampPrep(30);
  const bare = v.match(/^(\d+(?:\.\d+)?)$/);
  if (bare) return clampPrep(Number(bare[1]));
  return null;
}
