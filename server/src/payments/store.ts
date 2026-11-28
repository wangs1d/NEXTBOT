import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

import Database from "better-sqlite3";
import type { Database as SqliteDatabase } from "better-sqlite3";

import { getDataDir } from "../config/data-dir.js";
import { openSqlite } from "../storage/sqlite.js";
import type {
  AuthorizationStatus,
  BizDomain,
  IntentStatus,
  PaymentAuthorization,
  PaymentChannelId,
  PaymentIntent,
} from "./types.js";

/**
 * 统一支付存储（SQLite / WAL）。
 *
 * 与 payment-order-ledger 的关系：
 *   - payment-order-ledger 是「渠道收款台账」（商户网关视角，out_trade_no 为主键），
 *     管理台/统计已依赖它，不改结构；
 *   - 这里是「支付意图台账」：业务单据 ↔ 授权 ↔ 渠道单号 ↔ 状态机事件。
 *     一个 intent 对应 0..1 条渠道单号，两者通过 channel_order_id 关联。
 *
 * 金额列一律 INTEGER 分；对外对象里的元字段在映射层转换。
 * 存储失败不抛给资金主流程（除幂等键冲突这类语义错误由上层处理）。
 */

export type AuthorizationRow = {
  id: string;
  actorId: string;
  channel: PaymentChannelId;
  status: AuthorizationStatus;
  perTxCny: number;
  dailyCny: number;
  monthlyCny: number;
  autoApproveCny: number;
  categories: string[];
  consentVersion: string;
  consentText: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  lastUsedAt: string | null;
};

export type IntentRow = PaymentIntent;
export type IntentEventRow = {
  id: number;
  intentId: string;
  type: string;
  payload: string | null;
  createdAt: string;
};

const INTENT_COLUMNS = [
  "id",
  "actor_id",
  "idempotency_key",
  "biz_domain",
  "biz_ref_id",
  "merchant",
  "subject",
  "amount_cents",
  "category",
  "channel",
  "authorization_id",
  "status",
  "confirm_token",
  "confirm_expires_at",
  "channel_order_id",
  "pay_url",
  "payment_html",
  "qr_code_data_url",
  "cashier_url",
  "failure_reason",
  "refunded_cents",
  "created_at",
  "updated_at",
  "paid_at",
] as const;

type IntentColumn = (typeof INTENT_COLUMNS)[number];

/** 可被 updateIntent 修改的列（白名单，避免拼 SQL 注入）。 */
const INTENT_UPDATABLE: ReadonlySet<string> = new Set<IntentColumn>([
  "status",
  "confirm_token",
  "confirm_expires_at",
  "channel_order_id",
  "pay_url",
  "payment_html",
  "qr_code_data_url",
  "cashier_url",
  "failure_reason",
  "refunded_cents",
  "authorization_id",
  "updated_at",
  "paid_at",
  "channel",
]);

export function unifiedPaymentDbPath(): string {
  return process.env.PAYMENT_UNIFIED_DB?.trim() || join(getDataDir(), "payment", "unified.db");
}

function parseCategories(raw: unknown): string[] {
  if (typeof raw !== "string" || !raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.map((v) => String(v).trim()).filter(Boolean);
  } catch {
    return [];
  }
}

export class UnifiedPaymentStore {
  private db: SqliteDatabase | null = null;
  private readonly dbPath: string;

  constructor(dbPath?: string) {
    this.dbPath = dbPath ?? unifiedPaymentDbPath();
  }

  private open(): SqliteDatabase | null {
    if (this.db) return this.db;
    try {
      const db = openSqlite(this.dbPath);
      db.exec(`
        CREATE TABLE IF NOT EXISTS authorizations (
          id                 TEXT PRIMARY KEY,
          actor_id           TEXT NOT NULL,
          channel            TEXT NOT NULL,
          status             TEXT NOT NULL,
          per_tx_cny         REAL NOT NULL DEFAULT 0,
          daily_cny          REAL NOT NULL DEFAULT 0,
          monthly_cny        REAL NOT NULL DEFAULT 0,
          auto_approve_cny   REAL NOT NULL DEFAULT 0,
          categories         TEXT NOT NULL DEFAULT '[]',
          consent_version    TEXT NOT NULL DEFAULT '',
          consent_text       TEXT NOT NULL DEFAULT '',
          created_at         TEXT NOT NULL,
          updated_at         TEXT NOT NULL,
          expires_at         TEXT,
          revoked_at         TEXT,
          last_used_at       TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_auth_actor ON authorizations(actor_id, status);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_auth_active_unique
          ON authorizations(actor_id, channel) WHERE status = 'active';

        CREATE TABLE IF NOT EXISTS intents (
          id                 TEXT PRIMARY KEY,
          actor_id           TEXT NOT NULL,
          idempotency_key    TEXT,
          biz_domain         TEXT NOT NULL,
          biz_ref_id         TEXT,
          merchant           TEXT,
          subject            TEXT NOT NULL,
          amount_cents       INTEGER NOT NULL,
          category           TEXT NOT NULL,
          channel            TEXT NOT NULL,
          authorization_id   TEXT,
          status             TEXT NOT NULL,
          confirm_token      TEXT,
          confirm_expires_at TEXT,
          channel_order_id   TEXT,
          pay_url            TEXT,
          payment_html       TEXT,
          qr_code_data_url   TEXT,
          cashier_url        TEXT,
          failure_reason     TEXT,
          refunded_cents     INTEGER NOT NULL DEFAULT 0,
          created_at         TEXT NOT NULL,
          updated_at         TEXT NOT NULL,
          paid_at            TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_intents_actor_created ON intents(actor_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_intents_status_created ON intents(status, created_at DESC);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_intents_idem
          ON intents(actor_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

        CREATE TABLE IF NOT EXISTS intent_events (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          intent_id  TEXT NOT NULL,
          type       TEXT NOT NULL,
          payload    TEXT,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_intent_events_intent ON intent_events(intent_id, id);
      `);
      // 旧库（本模块早期版本）补 cashier_url 列：新增列只做 ADD COLUMN，不动既有数据
      try {
        const cols = db.prepare(`PRAGMA table_info(intents)`).all() as Array<{ name: string }>;
        if (!cols.some((c) => c.name === "cashier_url")) {
          db.exec(`ALTER TABLE intents ADD COLUMN cashier_url TEXT`);
        }
      } catch (err) {
        console.error("[unified-payment] migrate cashier_url failed:", err);
      }
      this.db = db;
      return db;
    } catch (err) {
      console.error("[unified-payment] open failed:", err instanceof Error ? err.message : err);
      return null;
    }
  }

  // ───────────────────────── 授权 ─────────────────────────

  /**
   * 写入一份新授权，并把它之前的同渠道授权置为 revoked（新授权即覆盖旧授权）。
   * 单事务执行，避免出现「两份 active」触发唯一索引冲突后授权失败。
   */
  upsertActiveAuthorization(row: PaymentAuthorization): boolean {
    const db = this.open();
    if (!db) return false;
    try {
      const tx = db.transaction(() => {
        db.prepare(
          `UPDATE authorizations SET status = 'revoked', revoked_at = ?, updated_at = ?
           WHERE actor_id = ? AND channel = ? AND status = 'active'`,
        ).run(row.createdAt, row.createdAt, row.actorId, row.channel);
        db.prepare(`
          INSERT INTO authorizations (
            id, actor_id, channel, status, per_tx_cny, daily_cny, monthly_cny,
            auto_approve_cny, categories, consent_version, consent_text,
            created_at, updated_at, expires_at, revoked_at, last_used_at
          ) VALUES (
            @id, @actorId, @channel, @status, @perTxCny, @dailyCny, @monthlyCny,
            @autoApproveCny, @categories, @consentVersion, @consentText,
            @createdAt, @updatedAt, @expiresAt, @revokedAt, @lastUsedAt
          )
        `).run({
          id: row.id,
          actorId: row.actorId,
          channel: row.channel,
          status: row.status,
          perTxCny: row.limits.perTxCny,
          dailyCny: row.limits.dailyCny,
          monthlyCny: row.limits.monthlyCny,
          autoApproveCny: row.limits.autoApproveCny,
          categories: JSON.stringify(row.categories),
          consentVersion: row.consentVersion,
          consentText: row.consentText,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
          expiresAt: row.expiresAt,
          revokedAt: row.revokedAt,
          lastUsedAt: row.lastUsedAt,
        });
      });
      tx();
      return true;
    } catch (err) {
      console.error("[unified-payment] upsert authorization failed:", err instanceof Error ? err.message : err);
      return false;
    }
  }

  private mapAuthorization(raw: Record<string, unknown> | undefined): PaymentAuthorization | null {
    if (!raw) return null;
    return {
      id: String(raw.id),
      actorId: String(raw.actor_id),
      channel: String(raw.channel) as PaymentChannelId,
      status: String(raw.status) as AuthorizationStatus,
      limits: {
        perTxCny: Number(raw.per_tx_cny ?? 0),
        dailyCny: Number(raw.daily_cny ?? 0),
        monthlyCny: Number(raw.monthly_cny ?? 0),
        autoApproveCny: Number(raw.auto_approve_cny ?? 0),
      },
      categories: parseCategories(raw.categories),
      consentVersion: String(raw.consent_version ?? ""),
      consentText: String(raw.consent_text ?? ""),
      createdAt: String(raw.created_at),
      updatedAt: String(raw.updated_at),
      expiresAt: raw.expires_at == null ? null : String(raw.expires_at),
      revokedAt: raw.revoked_at == null ? null : String(raw.revoked_at),
      lastUsedAt: raw.last_used_at == null ? null : String(raw.last_used_at),
    };
  }

  getAuthorization(id: string): PaymentAuthorization | null {
    const db = this.open();
    if (!db) return null;
    try {
      const row = db.prepare(`SELECT * FROM authorizations WHERE id = ?`).get(id) as
        | Record<string, unknown>
        | undefined;
      return this.mapAuthorization(row);
    } catch (err) {
      console.error("[unified-payment] getAuthorization failed:", err);
      return null;
    }
  }

  getActiveAuthorization(actorId: string, channel: PaymentChannelId): PaymentAuthorization | null {
    const db = this.open();
    if (!db) return null;
    try {
      const row = db
        .prepare(
          `SELECT * FROM authorizations WHERE actor_id = ? AND channel = ? AND status = 'active' LIMIT 1`,
        )
        .get(actorId, channel) as Record<string, unknown> | undefined;
      return this.mapAuthorization(row);
    } catch (err) {
      console.error("[unified-payment] getActiveAuthorization failed:", err);
      return null;
    }
  }

  /** 当前用户的全部 active 授权：用于「同一 provider 换通道复用授权」的判定。 */
  listActiveAuthorizations(actorId: string): PaymentAuthorization[] {
    const db = this.open();
    if (!db) return [];
    try {
      const rows = db
        .prepare(`SELECT * FROM authorizations WHERE actor_id = ? AND status = 'active' ORDER BY created_at DESC`)
        .all(actorId) as Array<Record<string, unknown>>;
      return rows.map((r) => this.mapAuthorization(r)).filter((r): r is PaymentAuthorization => r !== null);
    } catch (err) {
      console.error("[unified-payment] listActiveAuthorizations failed:", err);
      return [];
    }
  }

  /**
   * 多个渠道合计的已占用额度（分）。
   * 同一 provider（如扫码头 / 手机网站支付）换通道时额度必须连着算，
   * 否则换一种付款方式就能绕过日限额。
   */
  sumCommittedSinceChannels(actorId: string, channels: PaymentChannelId[], sinceIso: string): number {
    if (channels.length === 0) return 0;
    const db = this.open();
    if (!db) return 0;
    try {
      const placeholders = channels.map(() => "?").join(", ");
      const row = db
        .prepare(
          `SELECT COALESCE(SUM(amount_cents - refunded_cents), 0) AS total FROM intents
           WHERE actor_id = ? AND channel IN (${placeholders}) AND created_at >= ?
             AND status IN ('pending', 'paid', 'refunded')`,
        )
        .get(actorId, ...channels, sinceIso) as { total?: number } | undefined;
      return Math.max(0, Number(row?.total ?? 0));
    } catch (err) {
      console.error("[unified-payment] sumCommittedSinceChannels failed:", err);
      return 0;
    }
  }

  listAuthorizations(actorId: string): PaymentAuthorization[] {    const db = this.open();
    if (!db) return [];
    try {
      const rows = db
        .prepare(`SELECT * FROM authorizations WHERE actor_id = ? ORDER BY created_at DESC LIMIT 50`)
        .all(actorId) as Array<Record<string, unknown>>;
      return rows.map((r) => this.mapAuthorization(r)).filter((r): r is PaymentAuthorization => r !== null);
    } catch (err) {
      console.error("[unified-payment] listAuthorizations failed:", err);
      return [];
    }
  }

  revokeAuthorization(id: string, actorId: string, at: string): boolean {
    const db = this.open();
    if (!db) return false;
    try {
      const info = db
        .prepare(
          `UPDATE authorizations SET status = 'revoked', revoked_at = ?, updated_at = ?
           WHERE id = ? AND actor_id = ? AND status = 'active'`,
        )
        .run(at, at, id, actorId);
      return info.changes > 0;
    } catch (err) {
      console.error("[unified-payment] revokeAuthorization failed:", err);
      return false;
    }
  }

  touchAuthorization(id: string, at: string): void {
    const db = this.open();
    if (!db) return;
    try {
      db.prepare(`UPDATE authorizations SET last_used_at = ? WHERE id = ?`).run(at, id);
    } catch (err) {
      console.error("[unified-payment] touchAuthorization failed:", err);
    }
  }

  // ───────────────────────── 意图 ─────────────────────────

  private mapIntent(raw: Record<string, unknown> | undefined): PaymentIntent | null {
    if (!raw) return null;
    return {
      id: String(raw.id),
      actorId: String(raw.actor_id),
      idempotencyKey: raw.idempotency_key == null ? null : String(raw.idempotency_key),
      bizDomain: String(raw.biz_domain) as BizDomain,
      bizRefId: raw.biz_ref_id == null ? null : String(raw.biz_ref_id),
      merchant: raw.merchant == null ? null : String(raw.merchant),
      subject: String(raw.subject),
      amountCents: Number(raw.amount_cents),
      category: String(raw.category),
      channel: String(raw.channel) as PaymentChannelId,
      authorizationId: raw.authorization_id == null ? null : String(raw.authorization_id),
      status: String(raw.status) as IntentStatus,
      confirmToken: raw.confirm_token == null ? null : String(raw.confirm_token),
      confirmExpiresAt: raw.confirm_expires_at == null ? null : String(raw.confirm_expires_at),
      channelOrderId: raw.channel_order_id == null ? null : String(raw.channel_order_id),
      payUrl: raw.pay_url == null ? null : String(raw.pay_url),
      paymentHtml: raw.payment_html == null ? null : String(raw.payment_html),
      qrCodeDataUrl: raw.qr_code_data_url == null ? null : String(raw.qr_code_data_url),
      cashierUrl: raw.cashier_url == null ? null : String(raw.cashier_url),
      failureReason: raw.failure_reason == null ? null : String(raw.failure_reason),
      refundedCents: Number(raw.refunded_cents ?? 0),
      createdAt: String(raw.created_at),
      updatedAt: String(raw.updated_at),
      paidAt: raw.paid_at == null ? null : String(raw.paid_at),
    };
  }

  insertIntent(intent: PaymentIntent): { ok: boolean; conflict?: PaymentIntent } {
    const db = this.open();
    if (!db) return { ok: false };
    try {
      db.prepare(`
        INSERT INTO intents (${INTENT_COLUMNS.join(", ")})
        VALUES (${INTENT_COLUMNS.map((c) => `@${c}`).join(", ")})
      `).run({
        id: intent.id,
        actor_id: intent.actorId,
        idempotency_key: intent.idempotencyKey,
        biz_domain: intent.bizDomain,
        biz_ref_id: intent.bizRefId,
        merchant: intent.merchant,
        subject: intent.subject,
        amount_cents: intent.amountCents,
        category: intent.category,
        channel: intent.channel,
        authorization_id: intent.authorizationId,
        status: intent.status,
        confirm_token: intent.confirmToken,
        confirm_expires_at: intent.confirmExpiresAt,
        channel_order_id: intent.channelOrderId,
        pay_url: intent.payUrl,
        payment_html: intent.paymentHtml,
        qr_code_data_url: intent.qrCodeDataUrl,
        cashier_url: intent.cashierUrl,
        failure_reason: intent.failureReason,
        refunded_cents: intent.refundedCents,
        created_at: intent.createdAt,
        updated_at: intent.updatedAt,
        paid_at: intent.paidAt,
      });
      return { ok: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("UNIQUE") && intent.idempotencyKey) {
        const existing = this.getIntentByIdempotency(intent.actorId, intent.idempotencyKey);
        if (existing) return { ok: false, conflict: existing };
      }
      console.error("[unified-payment] insertIntent failed:", message);
      return { ok: false };
    }
  }

  getIntent(id: string): PaymentIntent | null {
    const db = this.open();
    if (!db) return null;
    try {
      const row = db.prepare(`SELECT * FROM intents WHERE id = ?`).get(id) as
        | Record<string, unknown>
        | undefined;
      return this.mapIntent(row);
    } catch (err) {
      console.error("[unified-payment] getIntent failed:", err);
      return null;
    }
  }

  getIntentByIdempotency(actorId: string, key: string): PaymentIntent | null {
    const db = this.open();
    if (!db) return null;
    try {
      const row = db
        .prepare(`SELECT * FROM intents WHERE actor_id = ? AND idempotency_key = ? LIMIT 1`)
        .get(actorId, key) as Record<string, unknown> | undefined;
      return this.mapIntent(row);
    } catch (err) {
      console.error("[unified-payment] getIntentByIdempotency failed:", err);
      return null;
    }
  }

  updateIntent(id: string, patch: Partial<Record<IntentColumn, string | number | null>>): PaymentIntent | null {
    const db = this.open();
    if (!db) return null;
    const entries = Object.entries(patch).filter(
      ([key, value]) => INTENT_UPDATABLE.has(key) && value !== undefined,
    );
    if (entries.length === 0) return this.getIntent(id);
    const sets = entries.map(([key]) => `${key} = @${key}`);
    try {
      db.prepare(`UPDATE intents SET ${sets.join(", ")} WHERE id = @id`).run({
        ...Object.fromEntries(entries),
        id,
      });
      return this.getIntent(id);
    } catch (err) {
      console.error("[unified-payment] updateIntent failed:", err);
      return null;
    }
  }

  listIntents(actorId: string, limit = 50): PaymentIntent[] {
    const db = this.open();
    if (!db) return [];
    const n = Math.min(Math.max(limit, 1), 500);
    try {
      const rows = db
        .prepare(`SELECT * FROM intents WHERE actor_id = ? ORDER BY created_at DESC LIMIT ?`)
        .all(actorId, n) as Array<Record<string, unknown>>;
      return rows.map((r) => this.mapIntent(r)).filter((r): r is PaymentIntent => r !== null);
    } catch (err) {
      console.error("[unified-payment] listIntents failed:", err);
      return [];
    }
  }

  /** 待收敛的意图（pending 且未超龄）：对账循环用。 */
  listPendingIntents(limit = 50): PaymentIntent[] {
    const db = this.open();
    if (!db) return [];
    try {
      const rows = db
        .prepare(`SELECT * FROM intents WHERE status = 'pending' ORDER BY created_at ASC LIMIT ?`)
        .all(Math.min(Math.max(limit, 1), 200)) as Array<Record<string, unknown>>;
      return rows.map((r) => this.mapIntent(r)).filter((r): r is PaymentIntent => r !== null);
    } catch (err) {
      console.error("[unified-payment] listPendingIntents failed:", err);
      return [];
    }
  }

  /**
   * 某时间点以来已占用的额度（分）：pending 也计入——未付款的单同样占用授权额度，
   * 否则连开多单就能绕过日限额。退款金额冲减占用。
   */
  sumCommittedSince(actorId: string, channel: PaymentChannelId, sinceIso: string): number {
    const db = this.open();
    if (!db) return 0;
    try {
      const row = db
        .prepare(
          `SELECT COALESCE(SUM(amount_cents - refunded_cents), 0) AS total FROM intents
           WHERE actor_id = ? AND channel = ? AND created_at >= ?
             AND status IN ('pending', 'paid', 'refunded')`,
        )
        .get(actorId, channel, sinceIso) as { total?: number } | undefined;
      return Math.max(0, Number(row?.total ?? 0));
    } catch (err) {
      console.error("[unified-payment] sumCommittedSince failed:", err);
      return 0;
    }
  }

  /** 按渠道单号反查意图：异步通知只带渠道单号（out_trade_no），需要它回到本模块。 */
  findIntentByChannelOrderId(channel: PaymentChannelId, channelOrderId: string): PaymentIntent | null {
    const db = this.open();
    if (!db) return null;
    try {
      const row = db
        .prepare(
          `SELECT * FROM intents WHERE channel = ? AND channel_order_id = ?
           ORDER BY created_at DESC LIMIT 1`,
        )
        .get(channel, channelOrderId) as Record<string, unknown> | undefined;
      return this.mapIntent(row);
    } catch (err) {
      console.error("[unified-payment] findIntentByChannelOrderId failed:", err);
      return null;
    }
  }

  /** 跨渠道的已占用额度（分）：全局日预算护栏用（授权额度按渠道，全局护栏按人）。 */
  sumCommittedAllChannelsSince(actorId: string, sinceIso: string): number {
    const db = this.open();
    if (!db) return 0;
    try {
      const row = db
        .prepare(
          `SELECT COALESCE(SUM(amount_cents - refunded_cents), 0) AS total FROM intents
           WHERE actor_id = ? AND created_at >= ?
             AND status IN ('pending', 'paid', 'refunded')`,
        )
        .get(actorId, sinceIso) as { total?: number } | undefined;
      return Math.max(0, Number(row?.total ?? 0));
    } catch (err) {
      console.error("[unified-payment] sumCommittedAllChannelsSince failed:", err);
      return 0;
    }
  }

  addEvent(intentId: string, type: string, payload?: unknown): void {    const db = this.open();
    if (!db) return;
    try {
      db.prepare(
        `INSERT INTO intent_events (intent_id, type, payload, created_at) VALUES (?, ?, ?, ?)`,
      ).run(
        intentId,
        type,
        payload === undefined ? null : JSON.stringify(payload),
        new Date().toISOString(),
      );
    } catch (err) {
      console.error("[unified-payment] addEvent failed:", err);
    }
  }

  listEvents(intentId: string, limit = 50): IntentEventRow[] {
    const db = this.open();
    if (!db) return [];
    try {
      const rows = db
        .prepare(`SELECT * FROM intent_events WHERE intent_id = ? ORDER BY id ASC LIMIT ?`)
        .all(intentId, Math.min(Math.max(limit, 1), 200)) as Array<{
        id: number;
        intent_id: string;
        type: string;
        payload: string | null;
        created_at: string;
      }>;
      return rows.map((r) => ({
        id: r.id,
        intentId: r.intent_id,
        type: r.type,
        payload: r.payload,
        createdAt: r.created_at,
      }));
    } catch (err) {
      console.error("[unified-payment] listEvents failed:", err);
      return [];
    }
  }

  close(): void {
    try {
      this.db?.close();
    } catch {
      /* ignore */
    }
    this.db = null;
  }
}

let sharedStore: UnifiedPaymentStore | null = null;

export function getUnifiedPaymentStore(): UnifiedPaymentStore {
  if (!sharedStore) sharedStore = new UnifiedPaymentStore();
  return sharedStore;
}

export function setUnifiedPaymentStore(store: UnifiedPaymentStore): void {
  sharedStore = store;
}
