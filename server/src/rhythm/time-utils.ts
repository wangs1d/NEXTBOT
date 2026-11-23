/**
 * 节律引擎时间工具。
 *
 * 提醒重排需要"任务时区的本地小时"（ScheduleTaskService 的 toLocalInTimezone
 * 是 private，这里用 Intl 等价实现）；以及跨午夜的小时环形差（睡觉窗口常跨 0 点）。
 */

const TZ_FORMAT_CACHE = new Map<string, Intl.DateTimeFormat>();

function tzFormatter(timezone: string): Intl.DateTimeFormat {
  let fmt = TZ_FORMAT_CACHE.get(timezone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
    TZ_FORMAT_CACHE.set(timezone, fmt);
  }
  return fmt;
}

export type TzLocalTime = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

export function toTzLocalTime(utcDate: Date, timezone: string): TzLocalTime {
  const parts = tzFormatter(timezone).formatToParts(utcDate);
  const v: Record<string, number> = {};
  for (const p of parts) {
    if (p.type !== "literal") v[p.type] = Number(p.value);
  }
  // Intl 的 hour12:false 在部分 runtime 会把午夜 0 点格式化为 "24"
  const hour = (v.hour ?? 0) % 24;
  return {
    year: v.year,
    month: v.month,
    day: v.day,
    hour,
    minute: v.minute ?? 0,
    second: v.second ?? 0,
  };
}

/** 十进制本地小时（如 23.5） */
export function localHourInTimezone(utcDate: Date, timezone: string): number {
  const t = toTzLocalTime(utcDate, timezone);
  return t.hour + t.minute / 60 + t.second / 3600;
}

/** 本地日期键（YYYY-MM-DD）；缺省用服务器本地时区（desktop 信号与用户同区部署场景） */
export function localDayKey(utcDate: Date, timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Shanghai"): string {
  const t = toTzLocalTime(utcDate, timezone);
  return `${t.year}-${String(t.month).padStart(2, "0")}-${String(t.day).padStart(2, "0")}`;
}

/**
 * 环形小时差 target-current，落在 [-12, 12)。
 * 例：current=23.0, target=0.25 → +1.25（而不是 -22.75）。
 */
export function circularHourDiff(target: number, current: number): number {
  return (((target - current) % 24) + 36) % 24 - 12;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** 十进制小时 → "HH:MM"（就地取整到分钟） */
export function formatHour(h: number): string {
  const normalized = ((h % 24) + 24) % 24;
  const hh = Math.floor(normalized);
  const mm = Math.round((normalized - hh) * 60);
  return `${String(hh).padStart(2, "0")}:${String(Math.min(59, mm)).padStart(2, "0")}`;
}

/**
 * 任务时区内"明天某时刻"的 UTC ISO。
 * 仅用于 ScheduleTaskService.updateTask 的 runAt 入参（parseLocalRunAt 会再按
 * 任务时区解析）。DST 切换日的 1 小时误差可接受（提醒场景不敏感）。
 */
export function nextLocalOccurrenceIso(hourDecimal: number, timezone: string, now = new Date()): string {
  const t = toTzLocalTime(now, timezone);
  const hh = Math.floor(((hourDecimal % 24) + 24) % 24);
  const mm = Math.round((hourDecimal - hh) * 60);
  const day = new Date(Date.UTC(t.year, t.month - 1, t.day + 1, hh, Math.min(59, mm), 0));
  return `${day.getUTCFullYear()}-${String(day.getUTCMonth() + 1).padStart(2, "0")}-${String(day.getUTCDate()).padStart(2, "0")}T${String(day.getUTCHours()).padStart(2, "0")}:${String(day.getUTCMinutes()).padStart(2, "0")}`;
}

export function dayKeyOf(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/**
 * 日期键（YYYY-MM-DD）挪 N 天。用正午做锚点，避开 UTC 偏移/DST 把日期串到
 * 隔壁那天（入睡在深夜、醒来在清晨，样本天生跨两天，这里错一天就全错）。
 */
export function shiftDayKey(dayKey: string, deltaDays: number): string {
  const d = new Date(`${dayKey}T12:00:00`);
  d.setDate(d.getDate() + deltaDays);
  return localDayKey(d);
}

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2 : sorted[mid] ?? 0;
}
