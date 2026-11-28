// HTTP 路由：跨端使用习惯埋点（手机端 / 桌面端统一出口）+ 管理端聚合。
//
// POST /api/telemetry/events —— 批量上报行为事件（免鉴权，同 client-boot；端侧 fail-open）。
// 服务端聚合 summary() —— 供 /api/admin/overview 的 usage 字段消费，口径见 design/ 设计稿。
//
// 唯一事实源：
//  - 事件白名单 EVENT_TYPES（未登记事件拒收并计数，端侧新功能须先登记）。
//  - 时间一律走注入的 now()（禁 Date.now()/无参 new Date()），测试可注入固定时钟。
//  - 自然日按 UTC+8 计算（中国区固定时区，不依赖服务器本地时区）。
import { getDataDir } from "../../config/data-dir.js";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

import { openSqlite } from "../../storage/sqlite.js";
import type { Database as SqliteDatabase } from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

/** 事件白名单：端侧与服务端共用同一份登记（与 design 埋点方案一致）。 */
export const EVENT_TYPES: ReadonlySet<string> = new Set([
  "session_start",
  "session_end",
  "heartbeat",
  "feature_use",
  "screen_view",
  "client_boot",
]);

const PLATFORMS: ReadonlySet<string> = new Set(["mobile", "desktop"]);
const MAX_DURATION_MS = 4 * 3600 * 1000; // 单次时长上限裁剪（默认 4h）
const CST_OFFSET_MS = 8 * 3600 * 1000;
const CACHE_TTL_MS = 5 * 60 * 1000;
const DAY_MS = 86_400_000;

function cstDate(ms: number): Date {
  return new Date(ms + CST_OFFSET_MS);
}
function cstDay(ms: number): string {
  return cstDate(ms).toISOString().slice(0, 10);
}
function cstHour(ms: number): number {
  return cstDate(ms).getUTCHours();
}
/** 0=周一 … 6=周日 */
function cstWeekday(ms: number): number {
  return (cstDate(ms).getUTCDay() + 6) % 7;
}
function shiftDay(day: string, delta: number): string {
  const t = Date.parse(day + "T00:00:00.000Z") + delta * DAY_MS;
  return new Date(t).toISOString().slice(0, 10);
}

type UsageEvent = {
  event: string;
  ts: number;
  installId: string;
  actorId: string | null;
  platform: string;
  appVersion: string | null;
  sessionId: string;
  props: Record<string, string | number | boolean>;
};

const propsSchema = z.record(z.string().max(64), z.union([z.string().max(200), z.number(), z.boolean()]));
const eventSchema = z.object({
  event: z.string().trim().max(64),
  ts: z.number().int().nonnegative(),
  installId: z.string().trim().regex(/^[A-Za-z0-9_-]{6,64}$/),
  actorId: z.string().trim().max(254).nullish(),
  platform: z.string().trim().max(24),
  appVersion: z.string().trim().max(32).nullish(),
  sessionId: z.string().trim().max(120),
  props: propsSchema.optional().default({}),
});
const batchSchema = z.object({ events: z.array(eventSchema).min(1).max(500) });

/** 聚合视图：与概览稿一一对应。 */
export type UsageSummary = {
  ready: boolean;
  eventCount: number;
  firstEventAt: string | null;
  lastEventAt: string | null;
  kpi: {
    dau: number;
    onlineRate: number | null;
    dau7: number;
    mau: number;
    stickiness: number | null;
    avgDurationMin: number;
    medianDurationMin: number;
    d1Retention: number | null;
    featureUses: number;
    sessions: number;
  };
  onlineRateSeries: Array<{ day: string; rate: number; prev: number }>;
  durationSeries: Array<{ day: string; avg: number; median: number }>;
  featurePrefs: Array<{ name: string; count: number }>;
  retention: Array<{ cohort: string; size: number; d1: number | null; d3: number | null; d7: number | null; d30: number | null }>;
  platform: { mobile: number; desktop: number; mobileAvgMin: number; desktopAvgMin: number };
  heatmap: number[][];
  topUsers: Array<{ actorId: string; name: string; platform: string; durationMin: number; topFeature: string; lastActive: string }>;
};

export type UsageSummaryContext = {
  registeredCount?: number;
  accountName?: (actorId: string) => string | null;
};

type RawEvent = {
  event: string;
  install_id: string;
  actor_id: string | null;
  platform: string;
  session_id: string;
  props_json: string;
  client_ts: number;
  received_at: number;
  day: string;
  hour: number;
  weekday: number;
};

function userKey(e: RawEvent): string {
  return e.actor_id ? "a:" + e.actor_id : "i:" + e.install_id;
}
function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
function durationFromProps(props: Record<string, unknown>): number {
  const raw = props.durationMs;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) return 0;
  return Math.min(raw, MAX_DURATION_MS);
}
function median(values: number[]): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor((s.length - 1) / 2)];
}

export class UsageAnalyticsStore {
  private db: SqliteDatabase | null = null;
  private now: () => number;
  private cache: { at: number; value: UsageSummary } | null = null;

  constructor(options: { now?: () => number; dbPath?: string } = {}) {
    this.now = options.now ?? (() => Date.now());
    this.dbPath = options.dbPath;
  }
  private dbPath?: string;

  private path(): string {
    return this.dbPath || process.env.USAGE_ANALYTICS_DB?.trim() || join(getDataDir(), "usage-analytics.db");
  }

  private open(): SqliteDatabase | null {
    if (this.db) return this.db;
    try {
      const file = this.path();
      const db = openSqlite(file);
      db.exec(`
        CREATE TABLE IF NOT EXISTS usage_events (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          event        TEXT NOT NULL,
          install_id   TEXT NOT NULL,
          actor_id     TEXT,
          platform     TEXT NOT NULL,
          app_version  TEXT,
          session_id   TEXT NOT NULL,
          props_json   TEXT NOT NULL,
          client_ts    INTEGER NOT NULL,
          received_at  INTEGER NOT NULL,
          day          TEXT NOT NULL,
          hour         INTEGER NOT NULL,
          weekday      INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_usage_event ON usage_events(event);
        CREATE INDEX IF NOT EXISTS idx_usage_day ON usage_events(day);
        CREATE INDEX IF NOT EXISTS idx_usage_actor ON usage_events(actor_id);
        CREATE INDEX IF NOT EXISTS idx_usage_session ON usage_events(session_id);
        CREATE INDEX IF NOT EXISTS idx_usage_install ON usage_events(install_id);
      `);
      this.db = db;
      return db;
    } catch (err) {
      console.error("[usage-analytics] open sqlite failed:", err);
      return null;
    }
  }

  /** 批量追加写。返回 { accepted, rejected }，未知事件与非法端拒收。 */
  ingest(events: UsageEvent[]): { accepted: number; rejected: number } {
    const db = this.open();
    if (!db) return { accepted: 0, rejected: events.length };
    const valid: Array<Omit<RawEvent, "weekday"> & { app_version: string | null }> = [];
    for (const e of events) {
      if (!EVENT_TYPES.has(e.event) || !PLATFORMS.has(e.platform)) continue;
      const received = this.now();
      valid.push({
        event: e.event,
        install_id: e.installId,
        actor_id: e.actorId ?? null,
        platform: e.platform,
        app_version: e.appVersion ?? null,
        session_id: e.sessionId,
        props_json: JSON.stringify(e.props),
        client_ts: e.ts,
        received_at: received,
        day: cstDay(received),
        hour: cstHour(received),
      });
    }
    if (!valid.length) return { accepted: 0, rejected: events.length };
    const stmt = db.prepare(`
      INSERT INTO usage_events
        (event, install_id, actor_id, platform, app_version, session_id, props_json, client_ts, received_at, day, hour, weekday)
      VALUES
        (@event, @install_id, @actor_id, @platform, @app_version, @session_id, @props_json, @client_ts, @received_at, @day, @hour, @weekday)
    `);
    const insertAll = db.transaction((rows: typeof valid) => {
      for (const r of rows) stmt.run({ ...r, weekday: cstWeekday(r.received_at) });
    });
    insertAll(valid);
    this.cache = null; // 事件变化即失效，保证概览读到真实最新数据
    return { accepted: valid.length, rejected: events.length - valid.length };
  }

  /** 原始明细（只读，测试与下钻用）。 */
  raw(limit = 500): RawEvent[] {
    const db = this.open();
    if (!db) return [];
    return db
      .prepare(
        `SELECT event, install_id, actor_id, platform, session_id, props_json, client_ts, received_at, day, hour, weekday
         FROM usage_events ORDER BY id DESC LIMIT ?`,
      )
      .all(limit) as RawEvent[];
  }

  /** 聚合概览，5 分钟缓存；事件写入即失效。 */
  summary(ctx: UsageSummaryContext = {}): UsageSummary {
    if (this.cache && this.now() - this.cache.at < CACHE_TTL_MS) return this.cache.value;
    const db = this.open();
    const value = db ? this.compute(db, ctx) : emptySummary();
    this.cache = { at: this.now(), value };
    return value;
  }

  private compute(db: SqliteDatabase, ctx: UsageSummaryContext): UsageSummary {
    const now = this.now();
    const today = cstDay(now);
    const all = db
      .prepare(
        `SELECT event, install_id, actor_id, platform, session_id, props_json, client_ts, received_at, day, hour, weekday
         FROM usage_events WHERE received_at >= ?`,
      )
      .all(now - 60 * DAY_MS) as RawEvent[];

    const out = emptySummary();
    out.eventCount = all.length;
    if (!all.length) return out;
    out.firstEventAt = new Date(Math.min(...all.map((e) => e.received_at))).toISOString();
    out.lastEventAt = new Date(Math.max(...all.map((e) => e.received_at))).toISOString();
    out.ready = true;

    const activeEvents = new Set(["session_start", "heartbeat", "feature_use", "session_end"]);
    const active = all.filter((e) => activeEvents.has(e.event));
    const usersOn = (day: string) => new Set(active.filter((e) => e.day === day).map(userKey));
    const dauUsers = usersOn(today);
    out.kpi.dau = dauUsers.size;

    const day14: string[] = [];
    for (let i = 13; i >= 0; i--) day14.push(shiftDay(today, -i));
    const registered = ctx.registeredCount ?? 0;
    out.kpi.onlineRate = registered > 0 ? round1((dauUsers.size / registered) * 100) : null;
    out.onlineRateSeries = day14.map((day) => ({
      day,
      rate: registered > 0 ? round1((usersOn(day).size / registered) * 100) : 0,
      prev: 0,
    }));
    // 上周同期：同一星期、往前 7 天
    out.onlineRateSeries.forEach((row) => {
      const prevDay = shiftDay(row.day, -7);
      row.prev = registered > 0 ? round1((usersOn(prevDay).size / registered) * 100) : 0;
    });

    const wauUsers = new Set(active.filter((e) => e.day > shiftDay(today, -7) && e.day <= today).map(userKey));
    const mauUsers = new Set(active.filter((e) => e.day > shiftDay(today, -30) && e.day <= today).map(userKey));
    out.kpi.dau7 = wauUsers.size;
    out.kpi.mau = mauUsers.size;
    out.kpi.stickiness = mauUsers.size > 0 ? round1((dauUsers.size / mauUsers.size) * 100) : null;

    // 时长：session_end.durationMs
    const ends = all.filter((e) => e.event === "session_end");
    const durationOf = (e: RawEvent) => durationFromProps(JSON.parse(e.props_json || "{}"));
    const durations = ends.map(durationOf).filter((d) => d > 0);
    const totalMs = durations.reduce((a, b) => a + b, 0);
    const distinctDurationUsers = new Set(ends.map(userKey)).size;
    out.kpi.sessions = new Set(ends.map((e) => e.session_id)).size;
    out.kpi.avgDurationMin = distinctDurationUsers ? round1(totalMs / distinctDurationUsers / 60000) : 0;
    out.kpi.medianDurationMin = round1(median(durations) / 60000);
    out.durationSeries = day14.map((day) => {
      const dayEnds = ends.filter((e) => e.day === day);
      const ds = dayEnds.map(durationOf).filter((d) => d > 0);
      const u = new Set(dayEnds.map(userKey)).size;
      return { day, avg: u ? round1(ds.reduce((a, b) => a + b, 0) / u / 60000) : 0, median: round1(median(ds) / 60000) };
    });

    // 功能偏好：feature_use.props.feature
    const featureCount = new Map<string, number>();
    for (const e of all) {
      if (e.event !== "feature_use") continue;
      const f = String(JSON.parse(e.props_json || "{}").feature || "").trim();
      if (!f) continue;
      featureCount.set(f, (featureCount.get(f) ?? 0) + 1);
    }
    out.kpi.featureUses = [...featureCount.values()].reduce((a, b) => a + b, 0);
    out.featurePrefs = [...featureCount.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 12);

    // 留存：按首次活跃日分 cohort，第 N 日是否仍有活跃（严格 Classic）
    const firstDayByUser = new Map<string, string>();
    const activeDaySet = new Set<string>();
    for (const e of active) {
      const k = userKey(e);
      const prev = firstDayByUser.get(k);
      if (!prev || e.day < prev) firstDayByUser.set(k, e.day);
      activeDaySet.add(k + "|" + e.day);
    }
    const cohortUsers = new Map<string, string[]>();
    for (const [k, day] of firstDayByUser) {
      const arr = cohortUsers.get(day) ?? [];
      arr.push(k);
      cohortUsers.set(day, arr);
    }
    const retentionDays = [1, 3, 7, 30];
    const cohortRows = [...cohortUsers.entries()]
      .filter(([day]) => day >= shiftDay(today, -45)) // 仅近 45 日 cohort，保证 N 日窗口有意义
      .sort((a, b) => b[0].localeCompare(a[0]))
      .slice(0, 5);
    out.retention = cohortRows.map(([day, users]) => {
      const row: UsageSummary["retention"][number] = { cohort: day, size: users.length, d1: null, d3: null, d7: null, d30: null };
      for (const n of retentionDays) {
        const target = shiftDay(day, n);
        if (target > today) continue; // 未到观察日，不伪造数据
        const returned = users.filter((k) => activeDaySet.has(k + "|" + target)).length;
        row[("d" + n) as "d1" | "d3" | "d7" | "d30"] = users.length ? round1((returned / users.length) * 100) : null;
      }
      return row;
    });
    const d1Values = out.retention.map((r) => r.d1).filter((v): v is number => v != null);
    out.kpi.d1Retention = d1Values.length ? round1(d1Values.reduce((a, b) => a + b, 0) / d1Values.length) : null;

    // 端分布：按会话数（session_start）
    const starts = all.filter((e) => e.event === "session_start");
    const mobile = starts.filter((e) => e.platform === "mobile").length;
    const desktop = starts.filter((e) => e.platform === "desktop").length;
    const avgByPlatform = (p: string) => {
      const set = new Set(ends.filter((e) => e.platform === p).map(userKey));
      const ms = ends.filter((e) => e.platform === p).map(durationOf).reduce((a, b) => a + b, 0);
      return set.size ? round1(ms / set.size / 60000) : 0;
    };
    out.platform = { mobile, desktop, mobileAvgMin: avgByPlatform("mobile"), desktopAvgMin: avgByPlatform("desktop") };

    // 时段热力：事件数（weekday × hour）
    const heat = Array.from({ length: 7 }, () => Array<number>(24).fill(0));
    for (const e of all) heat[e.weekday][e.hour] += 1;
    out.heatmap = heat;

    // 活跃用户 Top：按时长聚合
    const byUser = new Map<string, { ms: number; platform: string; last: number; features: Map<string, number> }>();
    for (const e of ends) {
      const k = userKey(e);
      const cur = byUser.get(k) ?? { ms: 0, platform: e.platform, last: 0, features: new Map() };
      cur.ms += durationOf(e);
      cur.last = Math.max(cur.last, e.received_at);
      cur.platform = e.platform;
      byUser.set(k, cur);
    }
    for (const e of all) {
      if (e.event !== "feature_use") continue;
      const k = userKey(e);
      const cur = byUser.get(k);
      if (!cur) continue;
      const f = String(JSON.parse(e.props_json || "{}").feature || "").trim();
      if (f) cur.features.set(f, (cur.features.get(f) ?? 0) + 1);
    }
    out.topUsers = [...byUser.entries()]
      .filter(([k]) => k.startsWith("a:"))
      .map(([k, v]) => {
        const actorId = k.slice(2);
        const topFeature = [...v.features.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || "-";
        return {
          actorId,
          name: ctx.accountName?.(actorId) || actorId.slice(0, 10),
          platform: v.platform,
          durationMin: round1(v.ms / 60000),
          topFeature,
          lastActive: new Date(v.last).toISOString(),
        };
      })
      .sort((a, b) => b.durationMin - a.durationMin)
      .slice(0, 8);

    return out;
  }
}

function emptySummary(): UsageSummary {
  return {
    ready: false,
    eventCount: 0,
    firstEventAt: null,
    lastEventAt: null,
    kpi: {
      dau: 0,
      onlineRate: null,
      dau7: 0,
      mau: 0,
      stickiness: null,
      avgDurationMin: 0,
      medianDurationMin: 0,
      d1Retention: null,
      featureUses: 0,
      sessions: 0,
    },
    onlineRateSeries: [],
    durationSeries: [],
    featurePrefs: [],
    retention: [],
    platform: { mobile: 0, desktop: 0, mobileAvgMin: 0, desktopAvgMin: 0 },
    heatmap: Array.from({ length: 7 }, () => Array<number>(24).fill(0)),
    topUsers: [],
  };
}

/** 进程内单例，与 client-telemetry 的 store 同生命周期。 */
export const usageAnalyticsStore = new UsageAnalyticsStore();

export function registerUsageAnalyticsRoutes(app: FastifyInstance): void {
  app.post("/api/telemetry/events", async (request, reply) => {
    const parsed = batchSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    }
    const result = usageAnalyticsStore.ingest(
      parsed.data.events.map((e) => ({
        event: e.event,
        ts: e.ts,
        installId: e.installId,
        actorId: e.actorId ?? null,
        platform: e.platform,
        appVersion: e.appVersion ?? null,
        sessionId: e.sessionId,
        props: e.props,
      })),
    );
    return { ok: true, ...result };
  });
}

/** 管理控制台概览调用：汇总 + 账号上下文（注册数、显示名）。 */
export function usageAnalyticsSummary(ctx: UsageSummaryContext = {}): UsageSummary {
  return usageAnalyticsStore.summary(ctx);
}
