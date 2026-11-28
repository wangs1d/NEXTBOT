// HTTP 路由：安装包运行埋点（每个安装一份最新状态）+ 管理端客户端台账。
//
// POST /api/telemetry/client-boot —— 桌面客户端每次启动上报一条（免鉴权，同反馈提交）。
// GET /api/admin/clients —— 管理员令牌下的客户端列表与聚合；概览页用 clientTelemetrySummary()。
// POST /api/telemetry/events —— 客户端行为事件批量上报（2026-11-23 M1：通知展示/打开/小组件/渠道关闭等）。
// GET /api/admin/telemetry/events —— 管理员令牌下按事件名、天聚合（主动触达漏斗的客户端半段）。
//
// 用途：内测期 runtime 跑在用户本机，「装了多少台 / 后端真的起来了吗 / 起得来要多久」
// 只能靠这里收数。channel 字段记录客户端最后一次读到的运行通道（byok=本机 runtime，
// platform=统一 API 服务），是把 runtime 收回云端前唯一的判断依据。
import { getDataDir } from "../../config/data-dir.js";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

import Database from "better-sqlite3";
import type { Database as SqliteDatabase } from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { openSqlite } from "../../storage/sqlite.js";
import { isAdminRequest } from "./admin-auth.js";

/** 客户端启动结果，与 Dart 侧 RuntimeBootStatus 取值一一对应。 */
const BOOT_STATUSES: ReadonlySet<string> = new Set([
  "bundledAlreadyRunning",
  "bundledStarted",
  "bundledSpawnFailed",
  "bundledNotReady",
  "notBundled",
  "skippedByChannel",
]);
const FAILURE_STATUSES: ReadonlySet<string> = new Set(["bundledSpawnFailed", "bundledNotReady"]);

type ClientRow = {
  installId: string;
  actorId: string | null;
  appVersion: string | null;
  edition: string | null;
  channel: string | null;
  bootStatus: string;
  bootMs: number | null;
  platform: string | null;
  boots: number;
  failures: number;
  lastBootAt: string;
  firstSeenAt: string;
  updatedAt: string;
};

const bootBodySchema = z.object({
  installId: z.string().trim().regex(/^[A-Za-z0-9_-]{6,64}$/),
  actorId: z.string().trim().max(254).optional(),
  appVersion: z.string().trim().max(32).optional(),
  edition: z.string().trim().max(24).optional(),
  channel: z.string().trim().max(24).optional(),
  bootStatus: z.string().trim(),
  bootMs: z.number().int().nonnegative().max(3_600_000).optional(),
  platform: z.string().trim().max(120).optional(),
});

const listQuerySchema = z.object({
  status: z.string().optional(),
  channel: z.string().optional(),
  /** true = 只看启动失败过的安装（收回 runtime 前先确认没有装不上新包的人）。 */
  failing: z.coerce.boolean().optional(),
  limit: z.coerce.number().int().positive().max(500).optional(),
  offset: z.coerce.number().int().nonnegative().optional(),
});

/**
 * 客户端行为事件白名单（与需求文档 §12.1 一一对应）。
 * 服务端生命周期事件（候选/入时段/决策/送达）不在这里打点——它们已在
 * reach-decision-log / silence-log / outcome-store 里，重复打点只会让两份口径打架。
 */
const CLIENT_EVENT_NAMES: ReadonlySet<string> = new Set([
  "proactive_displayed",
  "proactive_opened",
  "proactive_action",
  "proactive_replied",
  "notif_channel_disabled",
  "widget_added",
  "widget_removed",
  "widget_click",
  "share_ingest_started",
  "share_ingest_committed",
  "share_ingest_failed",
  "profile_viewed",
  "profile_item_edited",
  "profile_item_deleted",
]);

const clientEventSchema = z.object({
  name: z.string().trim().max(48),
  /** 客户端发生时刻 ms（端侧缓存后批量补报，所以不用服务端收到时间） */
  at: z.number().int().positive(),
  /** 关联的投递/意图 id（漏斗串联用，可缺省） */
  deliveryId: z.string().trim().max(96).optional(),
  /** 少量维度：surface / actionId / channelId / size / area / section / field / kind 等，值只收短字符串和数字 */
  props: z.record(z.union([z.string().max(64), z.number(), z.boolean()])).optional(),
});

const eventsBodySchema = z.object({
  installId: z.string().trim().regex(/^[A-Za-z0-9_-]{6,64}$/),
  actorId: z.string().trim().max(254).optional(),
  platform: z.string().trim().max(120).optional(),
  events: z.array(clientEventSchema).min(1).max(200),
});

const eventsQuerySchema = z.object({
  days: z.coerce.number().int().positive().max(90).optional(),
  name: z.string().trim().max(48).optional(),
});

function telemetryDbPath(): string {
  return process.env.CLIENT_TELEMETRY_DB?.trim() || join(getDataDir(), "client-telemetry.db");
}

class ClientTelemetryStore {
  private db: SqliteDatabase | null = null;

  private open(): SqliteDatabase | null {
    if (this.db) return this.db;
    try {
      const file = telemetryDbPath();
      const db = openSqlite(file);
      db.exec(`
        CREATE TABLE IF NOT EXISTS clients (
          install_id    TEXT PRIMARY KEY,
          actor_id      TEXT,
          app_version   TEXT,
          edition       TEXT,
          channel       TEXT,
          boot_status   TEXT NOT NULL,
          boot_ms       INTEGER,
          platform      TEXT,
          boots         INTEGER NOT NULL DEFAULT 0,
          failures      INTEGER NOT NULL DEFAULT 0,
          last_boot_at  TEXT NOT NULL,
          first_seen_at TEXT NOT NULL,
          updated_at    TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_clients_last_boot ON clients(last_boot_at DESC);
        CREATE INDEX IF NOT EXISTS idx_clients_actor ON clients(actor_id);
        CREATE TABLE IF NOT EXISTS client_events (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          install_id  TEXT NOT NULL,
          actor_id    TEXT,
          platform    TEXT,
          name        TEXT NOT NULL,
          at          INTEGER NOT NULL,
          delivery_id TEXT,
          props       TEXT,
          received_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_client_events_name_at ON client_events(name, at);
        CREATE INDEX IF NOT EXISTS idx_client_events_delivery ON client_events(delivery_id);
      `);
      this.db = db;
      return db;
    } catch (err) {
      console.error("[telemetry] open sqlite failed:", err);
      return null;
    }
  }

  /** 按安装身份 upsert：一台机器一行，boots/failures 累加，其余字段取最新值。 */
  record(input: {
    installId: string;
    actorId: string | null;
    appVersion: string | null;
    edition: string | null;
    channel: string | null;
    bootStatus: string;
    bootMs: number | null;
    platform: string | null;
  }): void {
    const db = this.open();
    if (!db) return;
    const now = new Date().toISOString();
    const incident = FAILURE_STATUSES.has(input.bootStatus) ? 1 : 0;
    db.prepare(`
      INSERT INTO clients (install_id, actor_id, app_version, edition, channel, boot_status,
                           boot_ms, platform, boots, failures, last_boot_at, first_seen_at, updated_at)
      VALUES (@installId, @actorId, @appVersion, @edition, @channel, @bootStatus,
              @bootMs, @platform, 1, @incident, @now, @now, @now)
      ON CONFLICT(install_id) DO UPDATE SET
        actor_id = excluded.actor_id,
        app_version = excluded.app_version,
        edition = excluded.edition,
        channel = excluded.channel,
        boot_status = excluded.boot_status,
        boot_ms = excluded.boot_ms,
        platform = excluded.platform,
        boots = clients.boots + 1,
        failures = clients.failures + @incident,
        last_boot_at = excluded.last_boot_at,
        updated_at = excluded.updated_at
    `).run({ ...input, now, incident });
  }

  /** 批量写入客户端事件（单事务）；白名单外的事件名直接丢弃，返回实际写入条数。 */
  recordEvents(input: {
    installId: string;
    actorId: string | null;
    platform: string | null;
    events: Array<{ name: string; at: number; deliveryId?: string; props?: Record<string, unknown> }>;
  }): number {
    const db = this.open();
    if (!db) return 0;
    const receivedAt = Date.now();
    const insert = db.prepare(`
      INSERT INTO client_events (install_id, actor_id, platform, name, at, delivery_id, props, received_at)
      VALUES (@installId, @actorId, @platform, @name, @at, @deliveryId, @props, @receivedAt)
    `);
    let written = 0;
    db.transaction(() => {
      for (const e of input.events) {
        if (!CLIENT_EVENT_NAMES.has(e.name)) continue;
        insert.run({
          installId: input.installId,
          actorId: input.actorId,
          platform: input.platform,
          name: e.name,
          at: e.at,
          deliveryId: e.deliveryId ?? null,
          props: e.props ? JSON.stringify(e.props) : null,
          receivedAt,
        });
        written += 1;
      }
    })();
    return written;
  }

  /** 按事件名 × 本地日聚合（管理端漏斗看板用） */
  eventSummary(days: number, name?: string): Array<{ name: string; day: string; count: number; actors: number }> {
    const db = this.open();
    if (!db) return [];
    const since = Date.now() - days * 24 * 3600 * 1000;
    const params: Record<string, string | number> = { since };
    let where = "WHERE at >= @since";
    if (name && CLIENT_EVENT_NAMES.has(name)) {
      where += " AND name = @name";
      params.name = name;
    }
    return db
      .prepare(
        `SELECT name,
                strftime('%Y-%m-%d', at / 1000, 'unixepoch', 'localtime') AS day,
                COUNT(*) AS count,
                COUNT(DISTINCT COALESCE(actor_id, install_id)) AS actors
         FROM client_events ${where}
         GROUP BY name, day
         ORDER BY day DESC, name`,
      )
      .all(params) as Array<{ name: string; day: string; count: number; actors: number }>;
  }

  query(filters: {
    status?: string;
    channel?: string;
    failing?: boolean;
    limit?: number;
    offset?: number;
  }): { total: number; items: ClientRow[] } {
    const db = this.open();
    if (!db) return { total: 0, items: [] };
    const where: string[] = [];
    const params: Record<string, string | number> = {};
    if (filters.status && BOOT_STATUSES.has(filters.status)) {
      where.push("boot_status = @status");
      params.status = filters.status;
    }
    if (filters.channel && /^[a-z0-9-]{1,24}$/.test(filters.channel)) {
      where.push("channel = @channel");
      params.channel = filters.channel;
    }
    if (filters.failing) where.push("failures > 0");
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const total = (
      db.prepare(`SELECT COUNT(*) AS c FROM clients ${whereSql}`).get(params) as { c: number }
    ).c;
    const items = db
      .prepare(
        `SELECT install_id AS installId, actor_id AS actorId, app_version AS appVersion,
                edition, channel, boot_status AS bootStatus, boot_ms AS bootMs, platform,
                boots, failures, last_boot_at AS lastBootAt, first_seen_at AS firstSeenAt,
                updated_at AS updatedAt
         FROM clients ${whereSql}
         ORDER BY last_boot_at DESC
         LIMIT @limit OFFSET @offset`,
      )
      .all({ ...params, limit: filters.limit ?? 100, offset: filters.offset ?? 0 }) as ClientRow[];
    return { total, items };
  }

  summary(): {
    total: number;
    activeToday: number;
    active7d: number;
    failing: number;
    byStatus: Record<string, number>;
    byChannel: Record<string, number>;
    byVersion: Array<{ version: string; count: number }>;
    medianBootMs: number | null;
  } {
    const db = this.open();
    const out = {
      total: 0,
      activeToday: 0,
      active7d: 0,
      failing: 0,
      byStatus: {} as Record<string, number>,
      byChannel: {} as Record<string, number>,
      byVersion: [] as Array<{ version: string; count: number }>,
      medianBootMs: null as number | null,
    };
    if (!db) return out;
    out.total = (db.prepare("SELECT COUNT(*) AS c FROM clients").get() as { c: number }).c;
    if (out.total === 0) return out;
    const now = Date.now();
    const dayMs = 24 * 3600 * 1000;
    out.activeToday = (
      db.prepare("SELECT COUNT(*) AS c FROM clients WHERE last_boot_at >= ?").get(
        new Date(now - dayMs).toISOString(),
      ) as { c: number }
    ).c;
    out.active7d = (
      db.prepare("SELECT COUNT(*) AS c FROM clients WHERE last_boot_at >= ?").get(
        new Date(now - 7 * dayMs).toISOString(),
      ) as { c: number }
    ).c;
    out.failing = (db.prepare("SELECT COUNT(*) AS c FROM clients WHERE failures > 0").get() as { c: number }).c;
    for (const row of db.prepare("SELECT boot_status AS s, COUNT(*) AS c FROM clients GROUP BY boot_status").all() as Array<{ s: string; c: number }>) {
      out.byStatus[row.s] = row.c;
    }
    for (const row of db.prepare("SELECT COALESCE(channel,'') AS c, COUNT(*) AS n FROM clients GROUP BY channel").all() as Array<{ c: string; n: number }>) {
      out.byChannel[row.c || "unknown"] = row.n;
    }
    out.byVersion = (
      db
        .prepare("SELECT COALESCE(app_version,'') AS version, COUNT(*) AS count FROM clients GROUP BY app_version ORDER BY count DESC")
        .all() as Array<{ version: string; count: number }>
    ).map((r) => ({ version: r.version || "unknown", count: r.count }));
    // 中位数（SQLite 无 percentile）：成功启动的 boot_ms 排序后取中间值
    const durations = (
      db
        .prepare(
          "SELECT boot_ms AS ms FROM clients WHERE boot_status IN ('bundledStarted','bundledAlreadyRunning') AND boot_ms IS NOT NULL ORDER BY boot_ms",
        )
        .all() as Array<{ ms: number }>
    ).map((r) => r.ms);
    if (durations.length) {
      out.medianBootMs = durations[Math.floor((durations.length - 1) / 2)];
    }
    return out;
  }
}

const store = new ClientTelemetryStore();

export function registerClientTelemetryRoutes(app: FastifyInstance): void {
  app.post("/api/telemetry/client-boot", async (request, reply) => {
    const parsed = bootBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    }
    const body = parsed.data;
    if (!BOOT_STATUSES.has(body.bootStatus)) {
      return reply.code(400).send({ ok: false, message: `unknown bootStatus "${body.bootStatus}"` });
    }
    store.record({
      installId: body.installId,
      actorId: body.actorId || null,
      appVersion: body.appVersion || null,
      edition: body.edition || null,
      channel: body.channel || null,
      bootStatus: body.bootStatus,
      bootMs: body.bootMs ?? null,
      platform: body.platform || null,
    });
    return { ok: true };
  });

  // 客户端行为事件批量上报：与 client-boot 同为免鉴权 + fail-open（客户端失败即丢，不重试风暴）
  app.post("/api/telemetry/events", async (request, reply) => {
    const parsed = eventsBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    }
    const body = parsed.data;
    const written = store.recordEvents({
      installId: body.installId,
      actorId: body.actorId || null,
      platform: body.platform || null,
      events: body.events,
    });
    return { ok: true, written };
  });

  app.get("/api/admin/telemetry/events", async (request, reply) => {
    const parsed = eventsQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    }
    if (!isAdminRequest(request)) {
      return reply.code(401).send({ ok: false, message: "Unauthorized: invalid admin token" });
    }
    const days = parsed.data.days ?? 14;
    return { ok: true, days, rows: store.eventSummary(days, parsed.data.name) };
  });

  app.get("/api/admin/clients", async (request, reply) => {
    const parsed = listQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    }
    if (!isAdminRequest(request)) {
      return reply.code(401).send({ ok: false, message: "Unauthorized: invalid admin token" });
    }
    const q = parsed.data;
    const { total, items } = store.query({
      status: q.status,
      channel: q.channel,
      failing: q.failing,
      limit: q.limit,
      offset: q.offset,
    });
    return { ok: true, total, items, summary: store.summary() };
  });
}

/** 客户端台账聚合（管理控制台概览用）。 */
export function clientTelemetrySummary(): ReturnType<ClientTelemetryStore["summary"]> {
  return store.summary();
}
