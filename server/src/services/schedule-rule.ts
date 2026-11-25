/**
 * 统一重复规则引擎（RFC 5545 子集）—— 全系统重复规则的唯一真源。
 *
 * 背景（2026-11-25 架构收敛）：
 *   旧实现有两套重复语义并存——4 档枚举 `none|daily|weekly|yearly` 负责调度推进，
 *   `cronExpression` 负责"除周一 / 工作日"这类星期集合，两套各有一个展开器，语义
 *   还互相不一致（weekly 只能同一天、cron 才有 BYDAY）。同一条提醒在列表渲染、
 *   到点触发、改期重算三处可能算出不同结果。
 *
 * 现在：任何输入（枚举 / cron / 新规则）先归一成 RRULE 字符串，展开、下一次、
 * 展示文案全部由本模块算。`recurrence` 保留为兼容字段（老客户端与历史数据），
 * 但不再参与任何时间计算。
 *
 * 支持的子集（覆盖产品实际会出现的全部形态）：
 *   FREQ=DAILY | WEEKLY | MONTHLY | YEARLY
 *   INTERVAL=n
 *   BYDAY=MO,TU,...（不带序号）
 *   BYMONTHDAY=n
 *   BYMONTH=n
 *   COUNT=n / UNTIL=YYYYMMDDTHHMMSSZ
 *
 * 语义按「本地墙上时钟」：每天 07:30 就是当地 07:30，DST 切换不漂移。
 */

export type RuleFreq = "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY";

export type RuleSpec = {
  freq: RuleFreq;
  interval: number;
  /** 0=周日 … 6=周六（JS getDay 语义）。 */
  byDay: number[];
  byMonthDay: number[];
  /** 1-12。 */
  byMonth: number[];
  count: number | null;
  untilMs: number | null;
};

export type ScheduleRuleSource = {
  recurrence: "none" | "daily" | "weekly" | "yearly" | "cron";
  cronExpression?: string;
  /** 锚点（首次触发时刻，ISO）。每周/每月的"哪一天"由它决定。 */
  runAt: string;
  timezone: string;
};

export type RuleOccurrence = {
  /** 实际触发时刻（UTC ms）。发生过改期的实例这里是被移动后的时刻。 */
  at: number;
  /** 规则本来该触发的时刻（UTC ms）：exdate/改期的对齐键。 */
  originalAt: number;
};

const DAY_MS = 86_400_000;
const WEEKDAY_CODES = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"] as const;
const WEEKDAY_CN = ["日", "一", "二", "三", "四", "五", "六"] as const;
const CODE_TO_DOW: Record<string, number> = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

// ═══════════════ 时区工具（不依赖服务器本机时区）═══════════════

export function zoneParts(ms: number, timezone: string): {
  y: number;
  m: number; // 1-12
  d: number;
  h: number;
  mi: number;
  s: number;
  dow: number;
} {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone.trim() || "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(ms));
  const v: Record<string, number> = {};
  for (const p of parts) {
    if (p.type !== "literal") v[p.type] = Number(p.value);
  }
  const y = v.year!;
  const m = v.month!;
  const d = v.day!;
  return {
    y,
    m,
    d,
    h: v.hour ?? 0,
    mi: v.minute ?? 0,
    s: v.second ?? 0,
    dow: new Date(Date.UTC(y, m - 1, d)).getUTCDay(),
  };
}

/** 把「该时区的墙上时间」换算成 UTC 毫秒（迭代收敛，DST 前后也成立）。 */
export function zonedToUtcMs(
  y: number,
  m: number,
  d: number,
  h: number,
  mi: number,
  s: number,
  timezone: string,
): number {
  const targetWall = Date.UTC(y, m - 1, d, h, mi, s);
  let guess = targetWall;
  for (let i = 0; i < 3; i += 1) {
    const p = zoneParts(guess, timezone);
    const guessWall = Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s);
    const delta = targetWall - guessWall;
    if (delta === 0) break;
    guess += delta;
  }
  return guess;
}

// ═══════════════ 解析 / 构建 ═══════════════

export function parseRule(rule: string | null | undefined): RuleSpec | null {
  if (!rule) return null;
  const body = rule.trim().replace(/^RRULE:/i, "");
  if (!body) return null;
  const raw: Record<string, string> = {};
  for (const kv of body.split(";")) {
    const eq = kv.indexOf("=");
    if (eq <= 0) continue;
    raw[kv.slice(0, eq).trim().toUpperCase()] = kv.slice(eq + 1).trim();
  }
  const freq = (raw.FREQ ?? "").toUpperCase();
  if (freq !== "DAILY" && freq !== "WEEKLY" && freq !== "MONTHLY" && freq !== "YEARLY") {
    return null;
  }
  const interval = Math.max(1, Number.parseInt(raw.INTERVAL ?? "1", 10) || 1);
  const byDay: number[] = [];
  for (const token of (raw.BYDAY ?? "").split(",")) {
    const key = token.trim().toUpperCase();
    if (!key) continue;
    // 带序号的 BYDAY（2TU / -1FR）本子集不支持：宁可判失败，也不给出错误日期。
    if (!/^[A-Z]{2}$/.test(key)) return null;
    const dow = CODE_TO_DOW[key];
    if (dow === undefined) return null;
    byDay.push(dow);
  }
  const byMonthDay = parseNumberList(raw.BYMONTHDAY, 1, 31);
  const byMonth = parseNumberList(raw.BYMONTH, 1, 12);
  if (byMonthDay === null || byMonth === null) return null;

  let count: number | null = null;
  if (raw.COUNT) {
    const n = Number.parseInt(raw.COUNT, 10);
    if (!Number.isFinite(n) || n <= 0) return null;
    count = n;
  }
  let untilMs: number | null = null;
  if (raw.UNTIL) {
    const m = raw.UNTIL.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/);
    if (!m) return null;
    untilMs = Date.UTC(
      Number(m[1]),
      Number(m[2]) - 1,
      Number(m[3]),
      Number(m[4] ?? "23"),
      Number(m[5] ?? "59"),
      Number(m[6] ?? "59"),
    );
    if (!Number.isFinite(untilMs)) untilMs = null;
  }
  if (count !== null && untilMs !== null) return null; // RFC: 二者互斥
  return { freq, interval, byDay, byMonthDay, byMonth, count, untilMs };
}

function parseNumberList(raw: string | undefined, min: number, max: number): number[] | null {
  if (!raw || raw === "*") return [];
  const out: number[] = [];
  for (const token of raw.split(",")) {
    const t = token.trim();
    if (!t) continue;
    const n = Number.parseInt(t, 10);
    if (!Number.isInteger(n) || n < min || n > max) return null;
    out.push(n);
  }
  return out;
}

function formatRule(parts: RuleSpec): string {
  const chunks = [`FREQ=${parts.freq}`, `INTERVAL=${parts.interval}`];
  if (parts.byDay.length > 0) {
    chunks.push(`BYDAY=${[...new Set(parts.byDay)].sort((a, b) => a - b).map((d) => WEEKDAY_CODES[d]).join(",")}`);
  }
  if (parts.byMonthDay.length > 0) chunks.push(`BYMONTHDAY=${parts.byMonthDay.join(",")}`);
  if (parts.byMonth.length > 0) chunks.push(`BYMONTH=${parts.byMonth.join(",")}`);
  if (parts.count !== null) chunks.push(`COUNT=${parts.count}`);
  if (parts.untilMs !== null) chunks.push(`UNTIL=${formatUntil(parts.untilMs)}`);
  return chunks.join(";");
}

function formatUntil(ms: number): string {
  const d = new Date(ms);
  const p = (n: number, len = 2) => String(n).padStart(len, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

/**
 * cron（系统定时语法的历史包袱）→ RRULE。
 * 只接受「分/时单值」：`0 9 * * 1,2,3,4,5`。步长、列表、跨月等复杂形态返回 null，
 * 由调用方保留 cronExpression 走旧的计算路径（过渡期兼容，不静默算错）。
 */
export function ruleFromCron(cronExpression: string): RuleSpec | null {
  const fields = cronExpression.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const [minuteRaw, hourRaw, domRaw, monthRaw, dowRaw] = fields;
  if (!/^\d{1,2}$/.test(minuteRaw!) || !/^\d{1,2}$/.test(hourRaw!)) return null;
  const minute = Number(minuteRaw);
  const hour = Number(hourRaw);
  if (minute > 59 || hour > 23) return null;

  const dom = domRaw === "*" ? [] : parseCronIntList(domRaw!, 1, 31);
  const month = monthRaw === "*" ? [] : parseCronIntList(monthRaw!, 1, 12);
  const dowParsed = dowRaw === "*" ? [] : parseCronIntList(dowRaw!, 0, 7);
  const dow = dowParsed === null ? null : dowParsed.map((d) => (d === 7 ? 0 : d));
  if (dom === null || month === null || dow === null) return null;

  if (dom.length === 0 && dow.length === 0 && month.length === 0) {
    return { freq: "DAILY", interval: 1, byDay: [], byMonthDay: [], byMonth: [], count: null, untilMs: null };
  }
  if (dom.length === 0 && month.length === 0 && dow.length > 0) {
    return {
      freq: "WEEKLY",
      interval: 1,
      byDay: [...new Set(dow)].sort((a, b) => a - b),
      byMonthDay: [],
      byMonth: [],
      count: null,
      untilMs: null,
    };
  }
  if (dom.length > 0 && month.length === 0 && dow.length === 0) {
    return {
      freq: "MONTHLY",
      interval: 1,
      byDay: [],
      byMonthDay: [...new Set(dom)].sort((a, b) => a - b),
      byMonth: [],
      count: null,
      untilMs: null,
    };
  }
  return null;
}

function parseCronIntList(raw: string, min: number, max: number): number[] | null {
  if (raw.includes("/") || raw.includes("*")) return null;
  const out: number[] = [];
  for (const token of raw.split(",")) {
    const t = token.trim();
    if (!t) continue;
    const range = t.match(/^(\d{1,2})-(\d{1,2})$/);
    if (range) {
      const a = Number(range[1]);
      const b = Number(range[2]);
      if (a < min || b > max || a > b) return null;
      for (let v = a; v <= b; v += 1) out.push(v);
      continue;
    }
    if (!/^\d{1,2}$/.test(t)) return null;
    const n = Number(t);
    if (n < min || n > max) return null;
    out.push(n);
  }
  return out;
}

/**
 * 任意历史输入 → RRULE 字符串。返回 null 表示"单次任务，无重复规则"。
 *
 * 迁移友好：老数据只有 `recurrence` 枚举，用 `runAt` 的本地星期/日期补齐
 * weekly / monthly / yearly 缺的那部分，结果与旧展开器完全等价。
 */
export function buildRule(source: ScheduleRuleSource): string | null {
  const { recurrence, cronExpression, runAt, timezone } = source;
  if (recurrence === "none") return null;
  const anchorMs = new Date(runAt).getTime();
  if (!Number.isFinite(anchorMs)) return null;
  const anchor = zoneParts(anchorMs, timezone);

  if (recurrence === "cron") {
    const cron = cronExpression?.trim();
    if (!cron) return null;
    const spec = ruleFromCron(cron);
    return spec ? formatRule(spec) : null;
  }
  if (recurrence === "daily") {
    return formatRule({
      freq: "DAILY",
      interval: 1,
      byDay: [],
      byMonthDay: [],
      byMonth: [],
      count: null,
      untilMs: null,
    });
  }
  if (recurrence === "weekly") {
    return formatRule({
      freq: "WEEKLY",
      interval: 1,
      byDay: [anchor.dow],
      byMonthDay: [],
      byMonth: [],
      count: null,
      untilMs: null,
    });
  }
  return formatRule({
    freq: "YEARLY",
    interval: 1,
    byDay: [],
    byMonthDay: [anchor.d],
    byMonth: [anchor.m],
    count: null,
    untilMs: null,
  });
}

// ═══════════════ 展开 ═══════════════

/**
 * 展开 [fromMs, toMs] 内的全部实例。
 *
 * - 本地日历逐日推进（不用 +86400000 累加），DST 不漂移、BYDAY 不漏跳；
 * - `exdates` 按 originalAt 排除（跳过某一次）；
 * - `overrides` 把某一次移到别的时刻（改期），移动后仍占位、不重复；
 * - COUNT 从锚点起数（子集语义，够用且不会算多）。
 */
export function expandRuleOccurrences(input: {
  rule: string;
  anchorIso: string;
  timezone: string;
  fromMs: number;
  toMs: number;
  exdates?: string[];
  overrides?: Array<{ originalAt: string; at: string }>;
  limit?: number;
}): RuleOccurrence[] {
  const spec = parseRule(input.rule);
  if (!spec) return [];
  const anchorMs = new Date(input.anchorIso).getTime();
  if (!Number.isFinite(anchorMs) || input.fromMs > input.toMs) return [];
  const tz = input.timezone.trim() || "Asia/Shanghai";
  const anchor = zoneParts(anchorMs, tz);
  const limit = input.limit ?? 500;

  const skip = new Set<number>();
  for (const iso of input.exdates ?? []) {
    const ms = new Date(iso).getTime();
    if (Number.isFinite(ms)) skip.add(ceilToMinute(ms));
  }
  const moved = new Map<number, number>();
  for (const o of input.overrides ?? []) {
    const from = new Date(o.originalAt).getTime();
    const to = new Date(o.at).getTime();
    if (Number.isFinite(from) && Number.isFinite(to)) moved.set(ceilToMinute(from), to);
  }

  const fromDay = dayIndex(zoneParts(Math.min(input.fromMs, input.toMs), tz));
  const toDay = dayIndex(zoneParts(Math.max(input.fromMs, input.toMs), tz));
  const anchorDay = dayIndex(anchor);

  const out: RuleOccurrence[] = [];
  // 无 COUNT 时不必从锚点日逐日扫（锚点可能在很久以前），直接跳到窗口前一日。
  let cursor = spec.count !== null ? anchorDay : Math.max(anchorDay, fromDay - 1);
  let emitted = 0;
  let guard = 0;
  const maxIterations = spec.count !== null ? 7_500 : toDay - cursor + 3;

  while (cursor <= toDay && guard < maxIterations && out.length < limit) {
    guard += 1;
    const day = dayFromIndex(cursor);
    if (matchesDay(spec, anchor, day, anchorDay, cursor)) {
      const originalMs = zonedToUtcMs(day.y, day.m, day.d, anchor.h, anchor.mi, anchor.s, tz);
      if (originalMs >= anchorMs && (spec.untilMs === null || originalMs <= spec.untilMs)) {
        emitted += 1;
        const withinCount = spec.count === null || emitted <= spec.count;
        if (withinCount) {
          const key = ceilToMinute(originalMs);
          if (!skip.has(key)) {
            const at = moved.get(key) ?? originalMs;
            if (at >= input.fromMs && at <= input.toMs) {
              out.push({ at, originalAt: originalMs });
            }
          }
        } else if (spec.count !== null) {
          break;
        }
      }
    }
    cursor += 1;
  }
  return out.sort((a, b) => a.at - b.at);
}

function matchesDay(
  spec: RuleSpec,
  anchor: { y: number; m: number; d: number; dow: number },
  day: { y: number; m: number; d: number; dow: number },
  anchorDay: number,
  cursor: number,
): boolean {
  const dayOffset = cursor - anchorDay;
  if (dayOffset < 0) return false;

  if (spec.freq === "DAILY") {
    if (dayOffset % spec.interval !== 0) return false;
    // BYDAY 在 DAILY 下是"过滤"：空 = 每天；有值 = 只要这些星期。
    return spec.byDay.length === 0 || spec.byDay.includes(day.dow);
  }
  if (spec.freq === "WEEKLY") {
    const weekOffset = Math.floor(dayOffset / 7);
    if (weekOffset % spec.interval !== 0) return false;
    const byDay = spec.byDay.length > 0 ? spec.byDay : [anchor.dow];
    return byDay.includes(day.dow);
  }
  if (spec.freq === "MONTHLY") {
    const monthOffset = (day.y - anchor.y) * 12 + (day.m - anchor.m);
    if (monthOffset < 0 || monthOffset % spec.interval !== 0) return false;
    const monthDays = spec.byMonthDay.length > 0 ? spec.byMonthDay : [anchor.d];
    return monthDays.includes(day.d);
  }
  // YEARLY
  const monthOffset = (day.y - anchor.y) * 12 + (day.m - anchor.m);
  if (monthOffset < 0 || monthOffset % (spec.interval * 12) !== 0) return false;
  if (spec.byMonth.length > 0 && !spec.byMonth.includes(day.m)) return false;
  const yearDays = spec.byMonthDay.length > 0 ? spec.byMonthDay : [anchor.d];
  return yearDays.includes(day.d);
}

function dayIndex(parts: { y: number; m: number; d: number }): number {
  return Math.floor(Date.UTC(parts.y, parts.m - 1, parts.d) / DAY_MS);
}

function dayFromIndex(index: number): { y: number; m: number; d: number; dow: number } {
  const dt = new Date(index * DAY_MS);
  return {
    y: dt.getUTCFullYear(),
    m: dt.getUTCMonth() + 1,
    d: dt.getUTCDate(),
    dow: dt.getUTCDay(),
  };
}

function ceilToMinute(ms: number): number {
  return Math.round(ms / 60_000) * 60_000;
}

// ═══════════════ 下一次 / 展示 ═══════════════

/** 严格晚于 afterMs 的下一次触发；没有则 null。 */
export function nextRuleOccurrenceMs(input: {
  rule: string;
  anchorIso: string;
  timezone: string;
  afterMs: number;
  exdates?: string[];
  overrides?: Array<{ originalAt: string; at: string }>;
}): number | null {
  const horizon = input.afterMs + 400 * DAY_MS;
  const all = expandRuleOccurrences({
    ...input,
    fromMs: input.afterMs + 1,
    toMs: horizon,
    limit: 1,
  });
  return all.length > 0 ? all[0]!.at : null;
}

/** 规则 → 人话（用于列表副标题、确认回执，替代按枚举反查）。 */
export function describeRule(
  rule: string | null | undefined,
  anchorIso?: string,
  timezone = "Asia/Shanghai",
): string {
  const spec = parseRule(rule);
  if (!spec) return "单次提醒";
  const anchor =
    anchorIso && Number.isFinite(new Date(anchorIso).getTime())
      ? zoneParts(new Date(anchorIso).getTime(), timezone)
      : null;
  const dayName = (d: number) => `周${WEEKDAY_CN[d]}`;

  if (spec.freq === "DAILY") {
    const days = spec.byDay.length > 0 ? [...new Set(spec.byDay)].sort() : [0, 1, 2, 3, 4, 5, 6];
    if (days.length === 7) return spec.interval === 1 ? "每天" : `每 ${spec.interval} 天`;
    if (days.length === 5 && [1, 2, 3, 4, 5].every((d) => days.includes(d))) {
      return spec.interval === 1 ? "每个工作日" : `每 ${spec.interval} 天的工作日`;
    }
    if (days.length === 6) {
      const missing = [0, 1, 2, 3, 4, 5, 6].find((d) => !days.includes(d));
      if (missing !== undefined) return `每天除${dayName(missing)}`;
    }
    return `每${days.map(dayName).join("、")}`;
  }
  if (spec.freq === "WEEKLY") {
    const days =
      spec.byDay.length > 0 ? [...new Set(spec.byDay)].sort() : anchor ? [anchor.dow] : [];
    const prefix =
      spec.interval === 1 ? "每周" : spec.interval === 2 ? "隔周" : `每 ${spec.interval} 周的周`;
    if (days.length === 0) return spec.interval === 1 ? "每周" : `每 ${spec.interval} 周`;
    const allWeekdays = [1, 2, 3, 4, 5];
    if (days.length === 5 && allWeekdays.every((d) => days.includes(d))) {
      return spec.interval === 1 ? "每个工作日" : `每 ${spec.interval} 周的工作日`;
    }
    // 整周 / 整周只缺一天：说「每天」「每天除周一」，比「每周日、二、三…」自然。
    if (spec.interval === 1 && days.length === 7) return "每天";
    if (spec.interval === 1 && days.length === 6) {
      const missing = [0, 1, 2, 3, 4, 5, 6].find((d) => !days.includes(d));
      if (missing !== undefined) return `每天除${dayName(missing)}`;
    }
    if (days.length === 1) return `${prefix}${WEEKDAY_CN[days[0]!]}`;
    return `${prefix}${days.map((d) => WEEKDAY_CN[d]).join("、")}`;
  }
  if (spec.freq === "MONTHLY") {
    const days = spec.byMonthDay.length > 0 ? spec.byMonthDay : anchor ? [anchor.d] : [];
    const prefix = spec.interval === 1 ? "每月" : `每 ${spec.interval} 个月`;
    return days.length > 0 ? `${prefix} ${days.join("、")} 日` : prefix;
  }
  const month = spec.byMonth[0] ?? anchor?.m;
  const day = spec.byMonthDay[0] ?? anchor?.d;
  if (month && day) return `每年 ${month} 月 ${day} 日`;
  return "每年";
}
