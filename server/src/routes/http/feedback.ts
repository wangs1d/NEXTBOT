import { getDataDir } from "../../config/data-dir.js";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import Database from "better-sqlite3";
import type { Database as SqliteDatabase } from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { ANONYMOUS_ACTOR_ID, resolveActorId } from "../../agent/actor-id.js";
import { adminAudit, isAdminRequest } from "./admin-auth.js";
import type { InboxService } from "../../services/inbox-service.js";

/**
 * 帮助与反馈：客户端反馈的唯一落点。
 *
 * 存储为 SQLite（缺省 data/feedback.db，环境变量 FEEDBACK_DB 覆盖），
 * 不再是 500 条环形上限的 JSON 文件 —— 旧文件在首次打开且表为空时整表导入，
 * 原文件保留作备份不删除。
 *
 * 权限边界：提交（POST /api/feedback）与按身份查询自己的反馈
 * （GET /api/feedback?actorId=…，客户端「我的反馈」）保持开放；
 * 全量列表与状态流转是管理操作，须携带 x-admin-token
 * （之前无鉴权，任何人可看全部反馈并改状态）。
 *
 * 闭环：状态流转/回复保存后自动给提交者发一条站内信（复用 InboxService，
 * 在线设备经 WS 实时提醒），用户不用自己刷「我的反馈」才知道被处理了。
 */

const FEEDBACK_TYPES = new Set(["bug", "suggestion", "other"]);
const FEEDBACK_STATUSES = new Set(["open", "processing", "resolved"]);
const FEEDBACK_STATUS_LABELS: Record<string, string> = {
  open: "重新打开",
  processing: "处理中",
  resolved: "已解决",
};
const MAX_DIAGNOSTIC_ENTRIES = 30;

type FeedbackType = "bug" | "suggestion" | "other";
type FeedbackStatus = "open" | "processing" | "resolved";

type FeedbackRecord = {
  id: string;
  type: FeedbackType;
  title: string;
  description: string;
  contact: string | null;
  status: FeedbackStatus;
  replyNote: string | null;
  actorId: string;
  clientVersion: string | null;
  platform: string | null;
  diagnostics: Record<string, string | number | boolean>;
  createdAt: string;
  updatedAt: string;
};

const submitBodySchema = z.object({
  userId: z.string().optional(),
  sessionId: z.string().optional(),
  type: z.enum(["bug", "suggestion", "other"]),
  title: z.string().trim().min(1).max(80),
  description: z.string().trim().min(1).max(4000),
  contact: z.string().trim().max(120).optional(),
  clientVersion: z.string().trim().max(32).optional(),
  platform: z.string().trim().max(120).optional(),
  diagnostics: z.record(z.string(), z.unknown()).optional(),
});

const statusBodySchema = z.object({
  status: z.enum(["open", "processing", "resolved"]),
  replyNote: z.string().trim().max(500).optional(),
});

const listQuerySchema = z.object({
  userId: z.string().optional(),
  sessionId: z.string().optional(),
  /** 传入时只返回该身份的反馈（客户端「我的反馈」）；缺省为管理端全量列表（需管理员令牌）。 */
  actorId: z.string().optional(),
  status: z.string().optional(),
  type: z.string().optional(),
  limit: z.coerce.number().int().positive().max(500).optional(),
  offset: z.coerce.number().int().nonnegative().optional(),
});

/** 诊断信息只收标量、限量限长：反馈通道不该成为任意数据的倾倒口。 */
function sanitizeDiagnostics(
  raw: Record<string, unknown> | undefined,
): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  if (!raw) return out;
  for (const [key, value] of Object.entries(raw)) {
    if (Object.keys(out).length >= MAX_DIAGNOSTIC_ENTRIES) break;
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed) out[key.slice(0, 64)] = trimmed.slice(0, 500);
    } else if (typeof value === "number" && Number.isFinite(value)) {
      out[key.slice(0, 64)] = value;
    } else if (typeof value === "boolean") {
      out[key.slice(0, 64)] = value;
    }
  }
  return out;
}

function feedbackDbPath(): string {
  return process.env.FEEDBACK_DB?.trim() || join(getDataDir(), "feedback.db");
}

function legacyJsonPath(): string {
  return join(getDataDir(), "feedback.json");
}

class FeedbackStoreManager {
  private db: SqliteDatabase | null = null;
  private imported = false;

  private open(): SqliteDatabase | null {
    if (this.db) return this.db;
    try {
      const file = feedbackDbPath();
      mkdirSync(dirname(file), { recursive: true });
      const db = new Database(file);
      db.pragma("journal_mode = WAL");
      db.exec(`
        CREATE TABLE IF NOT EXISTS feedback (
          id             TEXT PRIMARY KEY,
          type           TEXT NOT NULL,
          title          TEXT NOT NULL,
          description    TEXT NOT NULL,
          contact        TEXT,
          status         TEXT NOT NULL,
          reply_note     TEXT,
          actor_id       TEXT NOT NULL,
          client_version TEXT,
          platform       TEXT,
          diagnostics    TEXT,
          created_at     TEXT NOT NULL,
          updated_at     TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_feedback_created ON feedback(created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_feedback_actor ON feedback(actor_id);
      `);
      this.db = db;
      this.importLegacyJsonOnce(db);
      return db;
    } catch (err) {
      console.error("[feedback] open sqlite failed:", err);
      return null;
    }
  }

  /** 首次打开且表为空时导入旧 data/feedback.json，原文件保留作备份。 */
  private importLegacyJsonOnce(db: SqliteDatabase): void {
    if (this.imported) return;
    this.imported = true;
    try {
      const count = db.prepare("SELECT COUNT(*) AS c FROM feedback").get() as { c: number };
      if (count.c > 0) return;
      const raw = readFileSync(legacyJsonPath(), "utf8");
      const parsed = JSON.parse(raw) as { items?: FeedbackRecord[] };
      const items = Array.isArray(parsed.items) ? parsed.items : [];
      if (!items.length) return;
      const insert = db.prepare(`
        INSERT INTO feedback (id, type, title, description, contact, status, reply_note,
                              actor_id, client_version, platform, diagnostics, created_at, updated_at)
        VALUES (@id, @type, @title, @description, @contact, @status, @replyNote,
                @actorId, @clientVersion, @platform, @diagnosticsJson, @createdAt, @updatedAt)
      `);
      const insertAll = db.transaction((records: FeedbackRecord[]) => {
        for (const r of records) {
          if (!r?.id) continue;
          insert.run({
            id: r.id,
            type: r.type ?? "other",
            title: r.title ?? "",
            description: r.description ?? "",
            contact: r.contact ?? null,
            status: r.status ?? "open",
            replyNote: r.replyNote ?? null,
            actorId: r.actorId ?? "",
            clientVersion: r.clientVersion ?? null,
            platform: r.platform ?? null,
            diagnosticsJson: JSON.stringify(r.diagnostics ?? {}),
            createdAt: r.createdAt ?? new Date().toISOString(),
            updatedAt: r.updatedAt ?? r.createdAt ?? new Date().toISOString(),
          });
        }
      });
      insertAll(items);
      console.log(`[feedback] imported ${items.length} legacy records from data/feedback.json`);
    } catch {
      // 旧文件不存在或损坏：跳过导入
    }
  }

  async add(record: FeedbackRecord): Promise<void> {
    const db = this.open();
    if (!db) return;
    db.prepare(`
      INSERT INTO feedback (id, type, title, description, contact, status, reply_note,
                            actor_id, client_version, platform, diagnostics, created_at, updated_at)
      VALUES (@id, @type, @title, @description, @contact, @status, @replyNote,
              @actorId, @clientVersion, @platform, @diagnosticsJson, @createdAt, @updatedAt)
    `).run((() => {
      // diagnostics 是对象（非 SQLite 基元），序列化进 @diagnosticsJson，不进参数展开
      const { diagnostics, ...rest } = record;
      return { ...rest, diagnosticsJson: JSON.stringify(diagnostics) };
    })());
  }

  async query(filters: {
    actorId?: string;
    status?: string;
    type?: string;
    limit?: number;
    offset?: number;
  }): Promise<{ total: number; items: FeedbackRecord[] }> {
    const db = this.open();
    if (!db) return { total: 0, items: [] };
    const where: string[] = [];
    const params: Record<string, unknown> = {};
    if (filters.actorId) {
      where.push("actor_id = @actorId");
      params.actorId = filters.actorId;
    }
    if (filters.status && FEEDBACK_STATUSES.has(filters.status)) {
      where.push("status = @status");
      params.status = filters.status;
    }
    if (filters.type && FEEDBACK_TYPES.has(filters.type)) {
      where.push("type = @type");
      params.type = filters.type;
    }
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    // better-sqlite3 具名绑定要求 SqliteValue 值域；未知来源参数统一 String 化
    const totalRow = db
      .prepare(`SELECT COUNT(*) AS c FROM feedback ${whereSql}`)
      .get(
        Object.fromEntries(Object.entries(params).map(([k, v]) => [k, typeof v === "object" ? JSON.stringify(v) : (v as string | number | null)])),
      ) as { c: number };
    const rows = db.prepare(
      `SELECT id, type, title, description, contact, status, reply_note AS replyNote,
              actor_id AS actorId, client_version AS clientVersion, platform, diagnostics,
              created_at AS createdAt, updated_at AS updatedAt
       FROM feedback ${whereSql}
       ORDER BY created_at DESC
       LIMIT @limit OFFSET @offset`,
    ).all({ ...params, limit: filters.limit ?? 50, offset: filters.offset ?? 0 }) as Array<
      Omit<FeedbackRecord, "diagnostics"> & { diagnostics: string }
    >;
    return {
      total: totalRow.c,
      items: rows.map((row) => ({
        ...row,
        diagnostics: safeParseDiagnostics(row.diagnostics),
      })),
    };
  }

  async updateStatus(
    id: string,
    status: FeedbackStatus,
    replyNote?: string,
  ): Promise<FeedbackRecord | null> {
    const db = this.open();
    if (!db) return null;
    const existing = db.prepare("SELECT id FROM feedback WHERE id = ?").get(id);
    if (!existing) return null;
    db.prepare(
      `UPDATE feedback SET status = @status,
             reply_note = COALESCE(@replyNote, reply_note),
             updated_at = @updatedAt
       WHERE id = @id`,
    ).run({
      id,
      status,
      replyNote: replyNote ?? null,
      updatedAt: new Date().toISOString(),
    });
    return this.getById(id);
  }

  async getById(id: string): Promise<FeedbackRecord | null> {
    const db = this.open();
    if (!db) return null;
    const row = db.prepare(
      `SELECT id, type, title, description, contact, status, reply_note AS replyNote,
              actor_id AS actorId, client_version AS clientVersion, platform, diagnostics,
              created_at AS createdAt, updated_at AS updatedAt
       FROM feedback WHERE id = ?`,
    ).get(id) as (Omit<FeedbackRecord, "diagnostics"> & { diagnostics: string }) | undefined;
    if (!row) return null;
    return { ...row, diagnostics: safeParseDiagnostics(row.diagnostics) };
  }

  async counts(): Promise<{
    total: number;
    open: number;
    processing: number;
    resolved: number;
    /** 最老一条待处理的提交时间；无待处理时为 null（管理台催办提示用） */
    oldestOpenAt: string | null;
  }> {
    const db = this.open();
    const counts = { total: 0, open: 0, processing: 0, resolved: 0, oldestOpenAt: null as string | null };
    if (!db) return counts;
    const rows = db.prepare("SELECT status, COUNT(*) AS c FROM feedback GROUP BY status").all() as Array<{
      status: string;
      c: number;
    }>;
    for (const row of rows) {
      counts.total += row.c;
      if (row.status === "open") counts.open = row.c;
      else if (row.status === "processing") counts.processing = row.c;
      else if (row.status === "resolved") counts.resolved = row.c;
    }
    if (counts.open > 0) {
      const oldest = db.prepare(
        "SELECT MIN(created_at) AS t FROM feedback WHERE status = 'open'",
      ).get() as { t: string | null };
      counts.oldestOpenAt = oldest.t ?? null;
    }
    return counts;
  }
}

function safeParseDiagnostics(raw: string): Record<string, string | number | boolean> {
  try {
    const parsed = JSON.parse(raw || "{}") as Record<string, string | number | boolean>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

const storeManager = new FeedbackStoreManager();

export function registerFeedbackRoutes(
  app: FastifyInstance,
  deps: { inboxService?: InboxService | null } = {},
): void {
  app.post("/api/feedback", async (request, reply) => {
    const parsed = submitBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    }
    const body = parsed.data;
    const actorId = resolveActorId({
      userId: body.userId,
      sessionId: body.sessionId ?? "",
    });
    const now = new Date().toISOString();
    const record: FeedbackRecord = {
      id: `fb_${randomUUID().slice(0, 8)}`,
      type: body.type,
      title: body.title,
      description: body.description,
      contact: body.contact || null,
      status: "open",
      replyNote: null,
      actorId,
      clientVersion: body.clientVersion || null,
      platform: body.platform || null,
      diagnostics: sanitizeDiagnostics(body.diagnostics),
      createdAt: now,
      updatedAt: now,
    };
    await storeManager.add(record);
    return { ok: true, feedback: record };
  });

  app.get("/api/feedback", async (request, reply) => {
    const parsed = listQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    }
    const q = parsed.data;
    // 带身份 = 客户端查自己的反馈，保持开放；不带身份 = 管理端全量列表，须鉴权。
    let actorId: string | undefined;
    if (q.actorId) {
      actorId = resolveActorId({
        userId: q.userId,
        sessionId: q.sessionId ?? "",
      });
    } else if (!isAdminRequest(request)) {
      return reply.code(401).send({ ok: false, message: "Unauthorized: invalid admin token" });
    }
    const { total, items } = await storeManager.query({
      actorId,
      status: q.status,
      type: q.type,
      limit: q.limit,
      offset: q.offset,
    });
    return { ok: true, total, items };
  });

  app.post<{ Params: { id: string } }>("/api/feedback/:id/status", async (request, reply) => {
    if (!isAdminRequest(request)) {
      return reply.code(401).send({ ok: false, message: "Unauthorized: invalid admin token" });
    }
    const parsed = statusBodySchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    }
    const id = String(request.params.id ?? "").trim();
    const record = await storeManager.updateStatus(id, parsed.data.status, parsed.data.replyNote);
    if (!record) return reply.code(404).send({ ok: false, message: "feedback not found" });
    await adminAudit("feedback.update_status", { id, status: record.status }, request);
    // 闭环通知：状态流转/回复保存后给提交者发站内信（必达落盘 + 在线 WS 直推）。
    // 匿名/空身份无处投递；通知失败不影响流转本身。
    const actorId = record.actorId?.trim();
    if (deps.inboxService && actorId && actorId !== ANONYMOUS_ACTOR_ID) {
      const statusLabel = FEEDBACK_STATUS_LABELS[record.status] ?? record.status;
      const body = record.replyNote
        ? `「${record.title}」${statusLabel}。管理员回复：${record.replyNote}`
        : `「${record.title}」状态更新为：${statusLabel}。`;
      try {
        await deps.inboxService.send({
          actorId,
          title: "你的反馈有新回复",
          body,
          kind: "feedback",
          importance: record.replyNote ? "normal" : "low",
          fromActorId: "admin",
          messageId: `fb_reply_${id}_${record.updatedAt}`,
        });
      } catch (err) {
        console.warn("[feedback] reply inbox notify failed:", err);
      }
    }
    return { ok: true, feedback: record };
  });
}

/** 各状态反馈计数（管理控制台概览用）。 */
export async function feedbackStatusCounts(): Promise<{
  total: number;
  open: number;
  processing: number;
  resolved: number;
  oldestOpenAt: string | null;
}> {
  return storeManager.counts();
}
