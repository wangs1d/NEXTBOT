/**
 * ICS 日历订阅轮询服务（IcsSubscriptionService）——「日程零手工」的外部信源：
 * 用户把公司/学校/健身房的日历 .ics 订阅链接配进来，服务定时拉取 diff，
 * 把未来的日历事件自动落成 source=ics 的日程（进「今日安排」/冲突检测/到点提醒）。
 *
 * 为什么是轮询而非 webhook：日历订阅是只读公开链接，没有推送通道；分钟级延迟
 * 对日程场景足够。每轮 poll：HTTP GET → RFC 5545 子集解析 → 事件键差量 →
 * 新增/改期/消失分别 对应 建日程/改期/软取消 → 落盘状态（原子写）。
 *
 * 事件键与幂等：key = `${uid}/${occurrenceStartMs}`（周期事件按次展开，每况一条）。
 * 状态文件 data/ics-sub/state.json 记 key→taskId 映射；已 cancelled/completed 的
 * 任务视为「用户已处理」，不再自动重建。createTask 自带 60s 锚点容差判重兜底。
 *
 * 诚实失败约定：未启用/未配置/拉取失败都如实反映在 status()（lastError /
 * lastSyncAt）；失败只退避重试，不 crash 主进程。与 MailWatch 不同，首次接入
 * 就全量导入窗口内事件（日历订阅的本意就是导入存量），只发一条汇总提醒不轰炸。
 *
 * 解析范围（RFC 5545 子集，覆盖 Google/Outlook 导出主流形态）：
 *   - DTSTART/DTEND 的 UTC(Z)/本地浮点/全天(VALUE=DATE) 三形态；TZID 参数不解析
 *     VTIMEZONE，按服务器配置时区（默认 Asia/Shanghai，固定 +08:00 无夏令时）解释；
 *   - RRULE 的 FREQ=DAILY/WEEKLY/MONTHLY + INTERVAL + COUNT + UNTIL + BYDAY(仅 WEEKLY)；
 *   - EXDATE 排除次；RECURRENCE-ID 覆盖次（作为独立事件物化，并从主事件展开中剔除）；
 *   - STATUS:CANCELLED 跳过。窗口外（超过 lookaheadDays）不展开。
 *
 * env 键：
 *   ICS_SUB_ENABLED        默认 0（显式开启才工作）
 *   ICS_SUB_URLS           逗号分隔的「名称=URL」或裸 URL（启用时必填）
 *   ICS_SUB_POLL_SEC       轮询间隔秒，默认 900，下限 300（防把日历服务拉黑）
 *   ICS_SUB_ACTOR_ID       日程归属用户；缺省沿用 MESSAGE_BRIDGE_DEFAULT_ACTOR_ID，再兜底 "default_user"
 *   ICS_SUB_LOOKAHEAD_DAYS 向前展开天数，默认 35，范围 [7, 180]
 */

import { join } from "node:path";

import { readJson, writeJson } from "../proactivity/persist-file.js";
import type { ProactiveIntent } from "../proactivity/proactivity-types.js";
import type { ScheduleTaskService } from "./schedule-task-service.js";

// ---------------------------------------------------------------------- //
// 配置
// ---------------------------------------------------------------------- //

export type IcsFeedConfig = { name: string; url: string };

export type IcsWatchConfig = {
  enabled: boolean;
  feeds: IcsFeedConfig[];
  pollSec: number;
  actorId: string;
  lookaheadDays: number;
};

export function readIcsWatchConfig(env: NodeJS.ProcessEnv): IcsWatchConfig {
  const rawUrls = env.ICS_SUB_URLS?.trim() ?? "";
  const feeds: IcsFeedConfig[] = [];
  for (const chunk of rawUrls.split(",")) {
    const entry = chunk.trim();
    if (!entry) continue;
    const eq = entry.indexOf("=");
    // 「名称=URL」：等号后必须是合法 URL；裸 URL 内也可能有查询串无等号，逐一尝试
    if (eq > 0) {
      const name = entry.slice(0, eq).trim();
      const url = entry.slice(eq + 1).trim();
      if (name && /^https?:\/\//i.test(url)) {
        feeds.push({ name, url });
        continue;
      }
    }
    if (/^https?:\/\//i.test(entry)) {
      let host = entry;
      try {
        host = new URL(entry).hostname;
      } catch {
        /* 保留原文 */
      }
      feeds.push({ name: host, url: entry });
    }
  }
  const pollRaw = Number(env.ICS_SUB_POLL_SEC ?? "");
  const pollSec = Number.isFinite(pollRaw) && pollRaw > 0 ? Math.floor(pollRaw) : 900;
  const lookRaw = Number(env.ICS_SUB_LOOKAHEAD_DAYS ?? "");
  const lookaheadDays = Number.isFinite(lookRaw) && lookRaw > 0 ? Math.min(180, Math.max(7, Math.floor(lookRaw))) : 35;
  return {
    enabled: isTruthyEnv(env.ICS_SUB_ENABLED),
    feeds,
    pollSec: Math.min(86_400, Math.max(300, pollSec)),
    actorId: env.ICS_SUB_ACTOR_ID?.trim() || env.MESSAGE_BRIDGE_DEFAULT_ACTOR_ID?.trim() || "default_user",
    lookaheadDays,
  };
}

function isTruthyEnv(raw: string | undefined): boolean {
  if (!raw) return false;
  return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
}

/**
 * 私网 / 环回 / 链路本地地址字面量。
 *
 * 用户可自助填 URL 意味着服务端会去 fetch 任意地址——公开部署下这是标准的
 * SSRF 面（拿它探内网、扫端口）。所以默认拦掉这些字面量；
 * 自建日历（Radicale/群晖）确实在内网时，由部署方用 ICS_SUB_ALLOW_PRIVATE=1 放行。
 */
const PRIVATE_HOST_PATTERN =
  /^(localhost|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|169\.254\.\d{1,3}\.\d{1,3}|0\.0\.0\.0|::1|\[::1\])$/i;

/** 校验用户填的订阅链接。**不合法就别落盘**，否则会留一个永远失败的源。 */
export function validateIcsFeedUrl(
  raw: string,
  env: NodeJS.ProcessEnv = process.env,
): { ok: true; url: string } | { ok: false; error: string } {
  const s = (raw ?? "").trim();
  if (!s) return { ok: false, error: "请提供一个 ics 订阅链接" };
  let parsed: URL;
  try {
    parsed = new URL(s);
  } catch {
    return { ok: false, error: "链接格式不对，应为 https:// 开头的一段地址" };
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return { ok: false, error: "只支持 http / https 链接" };
  }
  if (isTruthyEnv(env.ICS_SUB_ALLOW_PRIVATE)) return { ok: true, url: parsed.toString() };
  if (PRIVATE_HOST_PATTERN.test(parsed.hostname)) {
    return {
      ok: false,
      error: "不能填内网或本机地址。自建日历（群晖/Radicale 等）请由部署方用 ICS_SUB_URLS 配置",
    };
  }
  return { ok: true, url: parsed.toString() };
}

/** 从链接生成可读源名（用域名），用户不填名字时用。 */
export function safeFeedName(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./i, "") || "日历订阅";
  } catch {
    return "日历订阅";
  }
}

// ---------------------------------------------------------------------- //
// ICS 解析（RFC 5545 子集）
// ---------------------------------------------------------------------- //

export type IcsOccurrence = {
  /** 稳定事件键：`${uid}/${occurrenceStartMs}` */
  key: string;
  uid: string;
  summary: string;
  startIso: string;
  startMs: number;
  /** 全天事件（VALUE=DATE）：物化时落到本地 08:30，避免零点提醒 */
  allDay: boolean;
  durationMinutes: number | null;
  location?: string;
  description?: string;
};

type IcsDateTime = { ms: number; allDay: boolean };

type ParsedIcsEvent = {
  uid: string;
  summary: string;
  description?: string;
  location?: string;
  start: IcsDateTime | null;
  durationMinutes: number | null;
  rrule: Record<string, string> | null;
  exdates: number[];
  recurrenceIdMs: number | null;
  cancelled: boolean;
};

/** 折行还原（RFC 5545：续行以空格/制表符开头）+ 行切分。 */
function unfoldIcsLines(text: string): string[] {
  return text
    .replace(/\r\n[ \t]/g, "")
    .replace(/\r[ \t]/g, "")
    .replace(/\n[ \t]/g, "")
    .split(/\r\n|\r|\n/);
}

/** ics 文本反转义。 */
function unescapeIcsText(value: string): string {
  return value
    .replace(/\\n/gi, "\n")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replace(/\\\\/g, "\\")
    .trim();
}

/** 把 NAME;PARAM=V;PARAM=V:VALUE 拆开（冒号/分号在双引号内不切分）。 */
function parseIcsProperty(line: string): { name: string; params: Record<string, string>; value: string } | null {
  let inQuote = false;
  let colon = -1;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') inQuote = !inQuote;
    else if (ch === ":" && !inQuote) {
      colon = i;
      break;
    }
  }
  if (colon <= 0) return null;
  const head = line.slice(0, colon);
  const value = line.slice(colon + 1);
  const segs: string[] = [];
  let cur = "";
  inQuote = false;
  for (const ch of head) {
    if (ch === '"') inQuote = !inQuote;
    if (ch === ";" && !inQuote) {
      segs.push(cur);
      cur = "";
    } else cur += ch;
  }
  segs.push(cur);
  const name = (segs.shift() ?? "").trim().toUpperCase();
  if (!name) return null;
  const params: Record<string, string> = {};
  for (const seg of segs) {
    const eq = seg.indexOf("=");
    if (eq <= 0) continue;
    params[seg.slice(0, eq).trim().toUpperCase()] = seg.slice(eq + 1).trim().replace(/^"|"$/g, "");
  }
  return { name, params, value };
}

/**
 * ICS 日期时间三形态：
 *   20261001T090000Z  UTC
 *   20261001T090000   本地浮点（按 fixedOffsetMs 解释，默认 +08:00，中国无夏令时）
 *   20261001          全天（VALUE=DATE，落到 fixedOffsetMs 时区当日 00:00，由调用方决定展示时刻）
 */
export function parseIcsDateTime(value: string, params: Record<string, string>, fixedOffsetMs = 8 * 3_600_000): IcsDateTime | null {
  const raw = value.trim();
  const isDateParam = (params["VALUE"] ?? "").toUpperCase() === "DATE";
  if (/^\d{8}$/.test(raw) || isDateParam) {
    const m = /^(\d{4})(\d{2})(\d{2})/.exec(raw);
    if (!m) return null;
    // 全天日期按「配置时区的当日」理解：先当 UTC 取日历日，再减去偏移得到该时区的零点
    const utcMidnight = Date.parse(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`);
    if (!Number.isFinite(utcMidnight)) return null;
    return { ms: utcMidnight - fixedOffsetMs, allDay: true };
  }
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/.exec(raw);
  if (!m) return null;
  if (m[7]) {
    const ms = Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`);
    return Number.isFinite(ms) ? { ms, allDay: false } : null;
  }
  // 浮点时间（无 Z 后缀、无 TZID 解析）：墙钟字面值按配置时区解释。
  // 先补 Z 按 UTC 解出「墙钟字面值」，再减偏移得到真实 epoch（+08:00 固定偏移，无夏令时）。
  const wallMs = Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`);
  if (!Number.isFinite(wallMs)) return null;
  return { ms: wallMs - fixedOffsetMs, allDay: false };
}

const WEEKDAY_MAP: Record<string, number> = { MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6, SU: 0 };

/**
 * 解析 VEVENT 块集合。返回按 uid 分组的事件（主事件 + RECURRENCE-ID 覆盖次）。
 */
export function parseIcsCalendar(text: string, fixedOffsetMs = 8 * 3_600_000): ParsedIcsEvent[] {
  const lines = unfoldIcsLines(text);
  const events: ParsedIcsEvent[] = [];
  let depth = 0;
  let cur: { props: Array<{ name: string; params: Record<string, string>; value: string }> } | null = null;
  for (const line of lines) {
    const upper = line.trim().toUpperCase();
    if (upper === "BEGIN:VEVENT") {
      depth = 1;
      cur = { props: [] };
      continue;
    }
    if (!cur) continue;
    if (upper.startsWith("BEGIN:")) {
      depth += 1; // VALARM 等嵌套块整体跳过
      continue;
    }
    if (upper.startsWith("END:")) {
      depth -= 1;
      if (depth <= 0) {
        events.push(buildIcsEvent(cur.props, fixedOffsetMs));
        cur = null;
        depth = 0;
      }
      continue;
    }
    if (depth === 1) {
      const prop = parseIcsProperty(line);
      if (prop) cur.props.push(prop);
    }
  }
  return events.filter((e) => e.uid && e.start);
}

function buildIcsEvent(
  props: Array<{ name: string; params: Record<string, string>; value: string }>,
  fixedOffsetMs: number,
): ParsedIcsEvent {
  const ev: ParsedIcsEvent = {
    uid: "",
    summary: "",
    start: null,
    durationMinutes: null,
    rrule: null,
    exdates: [],
    recurrenceIdMs: null,
    cancelled: false,
  };
  let end: IcsDateTime | null = null;
  for (const prop of props) {
    switch (prop.name) {
      case "UID":
        ev.uid = unescapeIcsText(prop.value);
        break;
      case "SUMMARY":
        ev.summary = unescapeIcsText(prop.value);
        break;
      case "DESCRIPTION":
        ev.description = unescapeIcsText(prop.value);
        break;
      case "LOCATION":
        ev.location = unescapeIcsText(prop.value);
        break;
      case "DTSTART":
        ev.start = parseIcsDateTime(prop.value, prop.params, fixedOffsetMs);
        break;
      case "DTEND":
        end = parseIcsDateTime(prop.value, prop.params, fixedOffsetMs);
        break;
      case "RRULE":
        ev.rrule = {};
        for (const seg of prop.value.split(";")) {
          const eq = seg.indexOf("=");
          if (eq > 0) ev.rrule[seg.slice(0, eq).trim().toUpperCase()] = seg.slice(eq + 1).trim();
        }
        break;
      case "EXDATE": {
        for (const v of prop.value.split(",")) {
          const dt = parseIcsDateTime(v, prop.params, fixedOffsetMs);
          if (dt) ev.exdates.push(dt.ms);
        }
        break;
      }
      case "RECURRENCE-ID": {
        const dt = parseIcsDateTime(prop.value, prop.params, fixedOffsetMs);
        ev.recurrenceIdMs = dt?.ms ?? null;
        break;
      }
      case "STATUS":
        ev.cancelled = prop.value.trim().toUpperCase() === "CANCELLED";
        break;
      default:
        break;
    }
  }
  if (ev.start && end && end.ms > ev.start.ms && end.ms - ev.start.ms < 24 * 3_600_000) {
    ev.durationMinutes = Math.round((end.ms - ev.start.ms) / 60_000);
  }
  return ev;
}

/**
 * 展开单事件在 [windowStartMs, windowEndMs] 内的发生次（含 RRULE/EXDATE；
 * overrideStarts 是该 uid 的 RECURRENCE-ID 覆盖次起点，从主事件展开中剔除）。
 */
export function expandIcsEvent(
  ev: ParsedIcsEvent,
  windowStartMs: number,
  windowEndMs: number,
  overrideStarts: Set<number>,
  fixedOffsetMs = 8 * 3_600_000,
): IcsOccurrence[] {
  if (!ev.start || ev.cancelled || !ev.uid) return [];
  const start = ev.start; // 局部常量：闭包内访问需非空收窄
  const dayMs = 24 * 3_600_000;
  const exSet = new Set(ev.exdates);
  const makeOccurrence = (ms: number): IcsOccurrence => ({
    key: `${ev.uid}/${ms}`,
    uid: ev.uid,
    summary: ev.summary || "(无标题事件)",
    startIso: new Date(ms).toISOString(),
    startMs: ms,
    allDay: start.allDay,
    durationMinutes: ev.durationMinutes,
    location: ev.location,
    description: ev.description,
  });
  const emit = (ms: number, out: IcsOccurrence[]) => {
    if (ms < windowStartMs || ms >= windowEndMs) return;
    if (exSet.has(ms) || overrideStarts.has(ms)) return;
    out.push(makeOccurrence(ms));
  };
  const out: IcsOccurrence[] = [];

  if (!ev.rrule || !ev.rrule["FREQ"]) {
    emit(start.ms, out);
    return out;
  }

  const freq = ev.rrule["FREQ"].toUpperCase();
  const interval = Math.max(1, Number(ev.rrule["INTERVAL"] ?? "1") || 1);
  const count = ev.rrule["COUNT"] ? Number(ev.rrule["COUNT"]) : null;
  const untilMs = ev.rrule["UNTIL"] ? (parseIcsDateTime(ev.rrule["UNTIL"], {}, fixedOffsetMs)?.ms ?? null) : null;
  const byday = (ev.rrule["BYDAY"] ?? "")
    .split(",")
    .map((s) => WEEKDAY_MAP[s.trim().toUpperCase()])
    .filter((n): n is number => Number.isInteger(n));

  // 展开上限：COUNT 优先，否则给硬顶防止无限 RRULE 打爆轮询
  const maxOccurs = count ? Math.min(count, 1000) : 1000;
  let produced = 0;

  if (freq === "DAILY") {
    for (let ms = start.ms; ms < windowEndMs && produced < maxOccurs; ms += interval * dayMs) {
      if (untilMs != null && ms > untilMs) break;
      emit(ms, out);
      produced += 1;
    }
    return out;
  }
  if (freq === "WEEKLY") {
    const weekdays = byday.length > 0 ? byday : [new Date(start.ms).getUTCDay()];
    // 周起点 = dtstart 所在周的周日零点（UTC 日界）；逐周步进后按 BYDAY 摆放
    const timeOfDay = ((start.ms % dayMs) + dayMs) % dayMs;
    const weekStartMidnight = start.ms - timeOfDay - new Date(start.ms).getUTCDay() * dayMs;
    for (let week = 0; produced < maxOccurs; week += interval) {
      const weekBase = weekStartMidnight + week * 7 * dayMs;
      if (weekBase - 7 * dayMs > windowEndMs) break;
      const days = [...weekdays].sort((a, b) => a - b);
      for (const wd of days) {
        const ms = weekBase + wd * dayMs + timeOfDay;
        if (ms < start.ms) continue;
        if (untilMs != null && ms > untilMs) {
          return out;
        }
        if (ms >= windowEndMs) continue;
        emit(ms, out);
        produced += 1;
        if (produced >= maxOccurs) break;
      }
    }
    return out;
  }
  if (freq === "MONTHLY") {
    const base = new Date(start.ms);
    for (let add = 0; produced < maxOccurs; add += interval) {
      const cand = new Date(start.ms);
      cand.setUTCMonth(base.getUTCMonth() + add);
      if (cand.getUTCDate() !== base.getUTCDate()) continue; // 月内无此日（如 31 号）
      const ms = cand.getTime();
      if (untilMs != null && ms > untilMs) break;
      if (ms > windowEndMs) break;
      if (ms >= start.ms) {
        emit(ms, out);
        produced += 1;
      }
      if (Date.UTC(cand.getUTCFullYear(), cand.getUTCMonth() + 1, 1) > windowEndMs) break;
    }
    return out;
  }
  // YEARLY 等未支持的 FREQ：退化为只取首次（诚实降级，不丢事件）
  emit(start.ms, out);
  return out;
}

/** 由解析结果产出窗口内的物化候选（主事件展开 + RECURRENCE-ID 覆盖次独立成键）。 */
export function resolveIcsOccurrences(
  events: ParsedIcsEvent[],
  windowStartMs: number,
  windowEndMs: number,
  fixedOffsetMs = 8 * 3_600_000,
): IcsOccurrence[] {
  const overridesByUid = new Map<string, Set<number>>();
  const overrideEvents: ParsedIcsEvent[] = [];
  for (const ev of events) {
    if (ev.recurrenceIdMs != null && ev.start) {
      const set = overridesByUid.get(ev.uid) ?? new Set<number>();
      set.add(ev.recurrenceIdMs);
      overridesByUid.set(ev.uid, set);
      overrideEvents.push(ev);
    }
  }
  const byKey = new Map<string, IcsOccurrence>();
  for (const ev of events) {
    if (ev.recurrenceIdMs != null) continue; // 主事件才走展开
    const overrides = overridesByUid.get(ev.uid) ?? new Set<number>();
    for (const occ of expandIcsEvent(ev, windowStartMs, windowEndMs, overrides, fixedOffsetMs)) {
      byKey.set(occ.key, occ);
    }
  }
  // 覆盖次：以 RECURRENCE-ID 的起点独立成键（取代主事件该次）
  for (const ev of overrideEvents) {
    if (!ev.start || ev.cancelled) continue;
    const occ: IcsOccurrence = {
      key: `${ev.uid}/${ev.start.ms}`,
      uid: ev.uid,
      summary: ev.summary || "(无标题事件)",
      startIso: new Date(ev.start.ms).toISOString(),
      startMs: ev.start.ms,
      allDay: ev.start.allDay,
      durationMinutes: ev.durationMinutes,
      location: ev.location,
      description: ev.description,
    };
    byKey.set(occ.key, occ);
  }
  return [...byKey.values()].sort((a, b) => a.startMs - b.startMs);
}

// ---------------------------------------------------------------------- //
// 轮询服务
// ---------------------------------------------------------------------- //

type IcsFeedState = { materialized: Record<string, string> };
type IcsWatchPersistedState = { version: 1; feeds: Record<string, IcsFeedState> };

export type IcsFeedStatus = {
  name: string;
  url: string;
  eventCount: number;
  lastSyncAt: string | null;
  lastError: string | null;
};

export type IcsWatchStatus = {
  enabled: boolean;
  pollSec: number;
  lookaheadDays: number;
  feeds: IcsFeedStatus[];
};

/** 全天事件物化的展示时刻（本地 08:30），避免半夜零点提醒。 */
const ALL_DAY_LOCAL_HOUR_MS = 8 * 3_600_000 + 30 * 60_000;
/** 已结束/已取消的旧映射清理阈值：超过窗口仍留在 state 的 key 定期清掉。 */
const STATE_PRUNE_LIMIT = 2000;

export class IcsSubscriptionService {
  private readonly config: IcsWatchConfig;
  private readonly tasks: ScheduleTaskService;
  private readonly notify: ((intent: ProactiveIntent) => void) | null;
  private readonly statePath: string;
  /**
   * 用户自助添加的订阅源（data/ics-sub/feeds.json）。
   *
   * 为什么必须有这一层：原来订阅源只能通过 ICS_SUB_URLS 环境变量配置，
   * 意味着"接日历"这件事永远得由部署方改配置重启。而上班族的安排表
   * （Outlook / Google / 飞书 / 企微 / 钉钉）恰恰都能导出 ics 订阅链接——
   * 只要用户能把链接粘进来，就不需要任何一方改代码。
   */
  private readonly feedsPath: string;
  private userFeeds: IcsFeedConfig[] = [];
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;
  private state: IcsWatchPersistedState;
  private timer: NodeJS.Timeout | null = null;
  private polling = false;
  private feedStatus = new Map<string, { lastSyncAt: string | null; lastError: string | null; eventCount: number }>();
  /** 最近解析出的窗口内事件（外部信源收编读取口用） */
  private readonly recentEvents: Array<{
    feed: string;
    key: string;
    summary: string;
    location?: string;
    startMs: number;
    allDay: boolean;
    durationMinutes?: number;
  }> = [];

  constructor(deps: {
    config: IcsWatchConfig;
    tasks: ScheduleTaskService;
    notify?: ((intent: ProactiveIntent) => void) | null;
    statePath?: string;
    /** 用户自助订阅源落盘路径，缺省 <cwd>/data/ics-sub/feeds.json */
    feedsPath?: string;
    fetchImpl?: typeof fetch;
    now?: () => Date;
  }) {
    this.config = deps.config;
    this.tasks = deps.tasks;
    this.notify = deps.notify ?? null;
    this.statePath = deps.statePath ?? join(process.cwd(), "data", "ics-sub", "state.json");
    this.feedsPath = deps.feedsPath ?? join(process.cwd(), "data", "ics-sub", "feeds.json");
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.now = deps.now ?? (() => new Date());
    this.state = readJson<IcsWatchPersistedState>(this.statePath, { version: 1, feeds: {} });
    this.userFeeds = readJson<{ version: 1; feeds: IcsFeedConfig[] }>(this.feedsPath, {
      version: 1,
      feeds: [],
    }).feeds.filter((f) => f && typeof f.url === "string" && typeof f.name === "string");
  }

  /** 生效的订阅源 = 环境变量配置 + 用户自助添加（按 URL 去重，env 优先）。 */
  private allFeeds(): IcsFeedConfig[] {
    const seen = new Set<string>();
    const out: IcsFeedConfig[] = [];
    for (const feed of [...this.config.feeds, ...this.userFeeds]) {
      if (seen.has(feed.url)) continue;
      seen.add(feed.url);
      out.push(feed);
    }
    return out;
  }

  /** 是否有源在生效（env 开启且有源，或用户自助加了源）。 */
  private isActive(): boolean {
    return (this.config.enabled && this.config.feeds.length > 0) || this.userFeeds.length > 0;
  }

  start(): void {
    if (!this.isActive()) {
      console.info(
        "[ics-sub] 未启用（ICS_SUB_ENABLED=0 且没有用户自助订阅源），不拉取日历订阅",
      );
      return;
    }
    for (const feed of this.allFeeds()) this.ensureFeedState(feed.name);
    // 启动即拉第一轮（日历订阅首接就该看到存量），之后按间隔轮询
    void this.pollAll().catch(() => {}).finally(() => this.scheduleNext());
  }

  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  status(): IcsWatchStatus {
    return {
      enabled: this.isActive(),
      pollSec: this.config.pollSec,
      lookaheadDays: this.config.lookaheadDays,
      feeds: this.allFeeds().map((feed) => {
        const st = this.feedStatus.get(feed.name);
        return {
          name: feed.name,
          url: feed.url,
          eventCount: st?.eventCount ?? 0,
          lastSyncAt: st?.lastSyncAt ?? null,
          lastError: st?.lastError ?? null,
        };
      }),
    };
  }

  /**
   * 用户自助添加订阅源（粘一个 ics 链接就完事）。
   *
   * 添加后**立刻拉一轮**并把导入条数返回给调用方：用户粘完链接要马上知道
   * "成了没有、导进来几条"，而不是等 15 分钟后的下一次轮询。
   *
   * 失败话术分层：
   *   - 链接不合法 → 400 语义（invalid）
   *   - 拉取失败（404/超时/内容不是日历）→ 也返回 error，但不落盘，
   *     免得用户留一个永远失败的源在系统里
   */
  async addFeed(input: { name?: string; url: string }): Promise<{
    ok: boolean;
    feed?: IcsFeedConfig;
    imported?: number;
    error?: string;
  }> {
    const checked = validateIcsFeedUrl(input.url);
    if (!checked.ok) return { ok: false, error: checked.error };

    const existing = this.allFeeds().find((f) => f.url === checked.url);
    if (existing) {
      // 已经在（env 或用户）里：不重复加，但顺手拉一次，让用户看到当前状态
      const imported = await this.pollFeed(existing).catch(() => 0);
      return { ok: true, feed: existing, imported };
    }

    const feed: IcsFeedConfig = {
      name: (input.name ?? "").trim() || safeFeedName(checked.url),
      url: checked.url,
    };

    let imported: number;
    try {
      imported = await this.pollFeed(feed);
    } catch (e) {
      return {
        ok: false,
        error: `这个链接拉不到日历：${e instanceof Error ? e.message : String(e)}。请确认是「.ics 订阅地址」而不是日历网页地址。`,
      };
    }

    this.userFeeds = [...this.userFeeds, feed];
    this.persistUserFeeds();
    this.ensureFeedState(feed.name);
    // 之前可能因为"没有源"而没启动轮询，加完要接上
    if (!this.timer) void this.pollAll().catch(() => {}).finally(() => this.scheduleNext());
    return { ok: true, feed, imported };
  }

  /** 删订阅源。只删用户自助加的那些；环境变量配置的删不掉（那是部署方的）。 */
  removeFeed(nameOrUrl: string): { ok: boolean; removed: boolean; error?: string } {
    const target = nameOrUrl.trim();
    const idx = this.userFeeds.findIndex((f) => f.name === target || f.url === target);
    if (idx < 0) {
      const fromEnv = this.config.feeds.some((f) => f.name === target || f.url === target);
      return {
        ok: false,
        removed: false,
        error: fromEnv
          ? "这个订阅源来自服务端环境变量（ICS_SUB_URLS），不能在客户端删除"
          : "没有这个订阅源",
      };
    }
    const [removedFeed] = this.userFeeds.splice(idx, 1);
    this.persistUserFeeds();
    this.feedStatus.delete(removedFeed.name);
    return { ok: true, removed: true };
  }

  private persistUserFeeds(): void {
    writeJson(this.feedsPath, { version: 1, feeds: this.userFeeds });
  }

  private ensureFeedState(name: string): IcsFeedState {
    const existing = this.state.feeds[name];
    if (existing) return existing;
    const fresh: IcsFeedState = { materialized: {} };
    this.state.feeds[name] = fresh;
    return fresh;
  }

  /**
   * 只读取数口（2026-10-10 外部信源收编）：返回本服务最近解析出的窗口内事件，
   * 供 IcsSensor 转成 Signal 进统一采集层。不发起新的网络请求。
   */
  fetchEventsSince(since: number): Array<{
    feed: string;
    key: string;
    summary: string;
    location?: string;
    startMs: number;
    allDay: boolean;
    durationMinutes?: number;
  }> {
    return this.recentEvents.filter((e) => e.startMs > since).sort((a, b) => a.startMs - b.startMs);
  }

  /** 记录最近解析事件（容量封顶防膨胀） */
  private rememberRecent(
    feed: string,
    occurrences: Array<{ key: string; summary: string; location?: string | null; startMs: number; allDay: boolean; durationMinutes?: number | null }>,
    windowStartMs: number,
  ): void {
    for (const occ of occurrences) {
      if (occ.startMs < windowStartMs) continue;
      this.recentEvents.push({
        feed,
        key: occ.key,
        summary: occ.summary,
        ...(occ.location ? { location: occ.location } : {}),
        startMs: occ.startMs,
        allDay: occ.allDay,
        ...(occ.durationMinutes ? { durationMinutes: occ.durationMinutes } : {}),
      });
    }
    while (this.recentEvents.length > 500) this.recentEvents.shift();
  }

  private scheduleNext(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.pollAll().catch(() => {}).finally(() => this.scheduleNext());
    }, this.config.pollSec * 1000);
    this.timer.unref?.();
  }

  /** 拉取全部订阅源（顺序执行，单个失败不阻断其余）。返回是否有变更。 */
  async pollAll(): Promise<boolean> {
    if (this.polling) return false;
    this.polling = true;
    try {
      let changed = false;
      for (const feed of this.allFeeds()) {
        try {
          const diff = await this.pollFeed(feed);
          changed = changed || diff > 0;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          const st = this.ensureFeedStatus(feed.name);
          st.lastError = message;
          console.warn(`[ics-sub] 订阅「${feed.name}」拉取失败（下轮重试）:`, message);
        }
      }
      return changed;
    } finally {
      this.polling = false;
    }
  }

  private ensureFeedStatus(name: string) {
    let st = this.feedStatus.get(name);
    if (!st) {
      st = { lastSyncAt: null, lastError: null, eventCount: 0 };
      this.feedStatus.set(name, st);
    }
    return st;
  }

  /** 拉取并 diff 单个订阅源；返回变更条数（建+改+撤）。 */
  async pollFeed(feed: IcsFeedConfig): Promise<number> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20_000);
    let text: string;
    try {
      const res = await this.fetchImpl(feed.url, { signal: controller.signal, redirect: "follow" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      text = await res.text();
    } finally {
      clearTimeout(timeout);
    }

    const nowMs = this.now().getTime();
    const windowStartMs = nowMs;
    const windowEndMs = nowMs + this.config.lookaheadDays * 24 * 3_600_000;
    const events = parseIcsCalendar(text);
    const occurrences = resolveIcsOccurrences(events, windowStartMs, windowEndMs);

    const feedState = this.ensureFeedState(feed.name);
    const materialized = feedState.materialized;
    const seen = new Set(occurrences.map((o) => o.key));
    let created = 0;
    let updated = 0;
    let cancelled = 0;

    for (const occ of occurrences) {
      // 全天事件落到本地 08:30，避免零点提醒；普通事件原样
      const runAtMs = occ.allDay ? occ.startMs + ALL_DAY_LOCAL_HOUR_MS : occ.startMs;
      const runAtIso = new Date(runAtMs).toISOString();
      const taskId = materialized[occ.key];
      if (taskId) {
        const task = this.tasks.getTask(taskId);
        if (!task) {
          delete materialized[occ.key]; // 本地任务被清（换库/手删）→ 视为新建
        } else if (task.status === "cancelled" || task.status === "completed") {
          continue; // 用户已处理，不自动重建
        } else if (Date.parse(task.runAt) !== runAtMs) {
          await this.tasks.updateTask(taskId, {
            runAt: runAtIso,
            ...(occ.durationMinutes ? { durationMinutes: occ.durationMinutes } : {}),
          });
          updated += 1;
        }
        continue;
      }
      const task = await this.tasks.createTask({
        sessionId: this.config.actorId,
        title: `【日历·${feed.name}】${occ.summary}`,
        shortTitle: occ.summary.slice(0, 12),
        description: `日历订阅「${feed.name}」自动导入${occ.location ? ` · ${occ.location}` : ""}`,
        kind: "reminder",
        category: "itinerary",
        runAt: runAtIso,
        recurrence: "none",
        reminderMessage: occ.summary,
        durationMinutes: occ.durationMinutes ?? undefined,
        source: "ics",
        sourceRefId: occ.key,
      });
      materialized[occ.key] = task.taskId;
      created += 1;
    }

    // 源里消失的事件 → 软取消对应日程（source=ics 且仍 active 才动）
    for (const key of Object.keys(materialized)) {
      if (seen.has(key)) continue;
      const taskId = materialized[key];
      delete materialized[key];
      const task = this.tasks.getTask(taskId);
      if (task && task.status === "active" && Date.parse(task.runAt) >= windowStartMs) {
        await this.tasks.updateTask(taskId, { status: "cancelled" });
        cancelled += 1;
      }
    }

    // 状态瘦身：映射超限时只保留最早的窗口内映射（防无限增长）
    const keys = Object.keys(materialized);
    if (keys.length > STATE_PRUNE_LIMIT) {
      for (const key of keys.slice(0, keys.length - STATE_PRUNE_LIMIT)) delete materialized[key];
    }
    writeJson(this.statePath, this.state);

    const st = this.ensureFeedStatus(feed.name);
    st.lastSyncAt = this.now().toISOString();
    st.lastError = null;
    st.eventCount = occurrences.length;

    // 收编读取口（2026-10-10）：把本轮解析出的窗口内事件留在环形缓冲，
    // 供 SensorKernel 的 IcsSensor 拉取（跨源汇聚用），不重复拉网络。
    this.rememberRecent(feed.name, occurrences, windowStartMs);

    const changed = created + updated + cancelled;
    if (changed > 0 && this.notify) {
      const parts: string[] = [];
      if (created > 0) parts.push(`新增 ${created} 条`);
      if (updated > 0) parts.push(`改期 ${updated} 条`);
      if (cancelled > 0) parts.push(`取消 ${cancelled} 条`);
      this.notify({
        actorId: this.config.actorId,
        kind: "life_reminder",
        importance: "medium",
        title: `日历「${feed.name}」${created > 0 && Object.keys(materialized).length === created ? "已接入" : "有更新"}`,
        summary: `日历订阅「${feed.name}」同步完成：${parts.join("、")}，已写入日程。`,
        mode: "speak",
        source: "ics",
      });
    }
    return changed;
  }
}
