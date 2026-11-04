/**
 * 近期重要日子（生日 / 纪念日）的共用取数与计算。
 *
 * 2026-11-04 用户拍板：重要日子的**展示位迁往「明日速览」**（EveningDigest），
 * 晨报不再上卡。但晨报仍保留「当天命中 → 祝福草稿 + life_reminder」的副作用
 * （祝福要在当天早上就发出，挪到夜里就晚了），因此两处都要读同一份
 * important_dates KV、走同一套 7 天窗口口径——收敛到本模块，避免两套窗口漂移。
 *
 * 数据来源：care.set_important_date 写入的 KV `important_dates`
 * （记录结构与 care-reminder-tools.ts 的 ImportantDateRecord 对齐）。
 */

/** 重要日子类型 */
export type ImportantDayType = "birthday" | "anniversary" | "custom";

export interface ImportantDay {
  id: string;
  /** 人物或事件名称，如「妈妈」「结婚纪念日」 */
  name: string;
  /** MM-DD 格式（年度周期） */
  date: string;
  type: ImportantDayType;
  /** 关系标签，如「母亲」「配偶」 */
  relationship?: string;
  /** 备注（交往摘要，供祝福草稿参考） */
  notes?: string;
  /** 距今天数：0=今天，1=明天…… */
  daysUntil: number;
}

/** AgentMemorySyncService 的最小依赖接口（读 important_dates KV，避免重类型耦合） */
export interface ImportantDaysStoreLike {
  getSnapshot(
    sessionId: string,
    keys?: string[],
  ): {
    revision: number;
    entries: Record<string, unknown>;
  };
}

/** 展示窗口（天）：只呈现 7 天内的近期日子 */
export const IMPORTANT_DAYS_WINDOW = 7;
/** 单个消费面最多呈现条数 */
export const IMPORTANT_DAYS_MAX = 5;

/** 重要日子类型中文标签 */
export function importantDayTypeLabel(type: ImportantDayType): string {
  switch (type) {
    case "birthday":
      return "生日";
    case "anniversary":
      return "纪念日";
    default:
      return "特殊日子";
  }
}

/**
 * 计算 MM-DD 距今天数（0=今天；今年的日期已过则按明年计，年度周期日子永不为负）。
 * 格式非法返回 -1（调用方过滤）。
 */
export function daysUntilMMdd(mmdd: string, now: Date = new Date()): number {
  const m = mmdd.match(/^(\d{1,2})-(\d{1,2})$/);
  if (!m) return -1;
  const month = Number(m[1]);
  const day = Number(m[2]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return -1;
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  let target = new Date(now.getFullYear(), month - 1, day);
  if (target.getTime() < todayStart.getTime()) {
    target = new Date(now.getFullYear() + 1, month - 1, day);
  }
  return Math.round((target.getTime() - todayStart.getTime()) / 86_400_000);
}

/**
 * 读取 7 天窗口内的近期重要日子（确定性，无 LLM）。
 * 存储缺失 / 格式异常 → 空数组（调用方整块省略）。
 * 按剩余天数升序，最多 [max] 条。
 */
export function readUpcomingImportantDays(
  store: ImportantDaysStoreLike | undefined,
  sessionId: string,
  opts: { now?: Date; windowDays?: number; max?: number } = {},
): ImportantDay[] {
  if (!store) return [];
  const now = opts.now ?? new Date();
  const windowDays = opts.windowDays ?? IMPORTANT_DAYS_WINDOW;
  const max = opts.max ?? IMPORTANT_DAYS_MAX;
  try {
    const { entries } = store.getSnapshot(sessionId, ["important_dates"]);
    const records = Array.isArray(entries.important_dates) ? entries.important_dates : [];
    const days: ImportantDay[] = [];
    for (const r of records) {
      const rec = r as {
        id?: unknown;
        name?: unknown;
        date?: unknown;
        type?: unknown;
        relationship?: unknown;
        notes?: unknown;
      };
      if (typeof rec.name !== "string" || !rec.name.trim()) continue;
      if (typeof rec.date !== "string") continue;
      const daysUntil = daysUntilMMdd(rec.date, now);
      if (daysUntil < 0 || daysUntil > windowDays) continue;
      days.push({
        id: typeof rec.id === "string" && rec.id ? rec.id : `${rec.name}|${rec.date}`,
        name: rec.name.trim(),
        date: rec.date,
        type: rec.type === "anniversary" || rec.type === "custom" ? rec.type : "birthday",
        ...(typeof rec.relationship === "string" && rec.relationship.trim()
          ? { relationship: rec.relationship.trim() }
          : {}),
        ...(typeof rec.notes === "string" && rec.notes.trim() ? { notes: rec.notes.trim() } : {}),
        daysUntil,
      });
    }
    return days.sort((a, b) => a.daysUntil - b.daysUntil).slice(0, max);
  } catch {
    return [];
  }
}
