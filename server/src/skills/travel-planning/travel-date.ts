/**
 * 行程日期纯工具（travel 规划主线 F0）
 *
 * 存在的理由：规划服务此前用 `new Date().toISOString().split('T')[0]` 取「今天」，
 * 那是 UTC 日期——东八区每天 00:00~08:00 之间会得到「昨天」，Day1 直接排到过去
 * 的日子，逐日天气与接驳提醒随之错位。所有需要日历日的地方统一走这里。
 */

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function two(n: number): string {
  return String(n).padStart(2, "0");
}

/** `YYYY-MM-DD`（本地时区；不按 UTC 截取，避免跨零点的日期漂移） */
export function localDateISO(date: Date): string {
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}`;
}

/** 今天（本地时区） */
export function localTodayISO(now: Date = new Date()): string {
  return localDateISO(now);
}

export function isValidISODate(value: unknown): value is string {
  return typeof value === "string" && ISO_DATE_RE.test(value);
}

/** ISO 日 → 本地 Date（正午锚点，规避夏令时/时区导致的 ±1 天漂移） */
export function parseISODate(iso: string): Date | null {
  if (!isValidISODate(iso)) return null;
  const d = new Date(`${iso}T12:00:00`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** 加减天数（越界/非法输入原样返回，调用方无需再判空） */
export function addDaysISO(iso: string, days: number): string {
  const base = parseISODate(iso);
  if (!base) return iso;
  base.setDate(base.getDate() + days);
  return localDateISO(base);
}

/** 0=周日 … 6=周六；非法日期返回 -1 */
export function weekdayOfISO(iso: string): number {
  const d = parseISODate(iso);
  return d ? d.getDay() : -1;
}

/** `2026-11-03` → `11-03 周二`（卡片行展示用；非法则原样） */
export function formatDateLabel(iso: string): string {
  const d = parseISODate(iso);
  if (!d) return iso;
  const wd = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][d.getDay()] ?? "";
  return `${two(d.getMonth() + 1)}-${two(d.getDate())} ${wd}`;
}

/** iso 相对今天的天数（今天=0，过去为负）；非法返回 null */
export function daysFromToday(iso: string, now: Date = new Date()): number | null {
  const d = parseISODate(iso);
  if (!d) return null;
  const today = parseISODate(localTodayISO(now));
  if (!today) return null;
  return Math.round((d.getTime() - today.getTime()) / 86400000);
}
