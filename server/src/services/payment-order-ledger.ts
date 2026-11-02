import { getDataDir } from "../config/data-dir.js";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

import Database from "better-sqlite3";
import type { Database as SqliteDatabase } from "better-sqlite3";

/**
 * 支付订单持久台账（SQLite）——只记真实（live）交易。
 *
 * 模拟订单不落库（留在 PaymentService 进程内 Map，仅供本地联调），
 * 历史遗留的 mock 行在打开数据库时一次性清理。
 * live 订单状态随客户端轮询回写：客户端经 payment.query_order 轮询渠道，
 * queryOrder 拿到终态（成功/关闭/退款）时更新。
 *
 * 台账是管理侧的本地副本，渠道侧仍是交易事实源；台账写失败不阻断支付主流程。
 */

export type PaymentOrderMode = "mock" | "live";
export type PaymentOrderStatus = "pending" | "paid" | "closed" | "refunded" | "error";

export type LedgerOrderRow = {
  outTradeNo: string;
  /** 订单归属用户（多租户：列表/统计/日预算都按它过滤） */
  actorId: string;
  provider: string;
  method: string;
  amount: number;
  description: string;
  mode: PaymentOrderMode;
  status: PaymentOrderStatus;
  createdAt: string;
  updatedAt: string;
  paidAt: string | null;
};

export type LedgerModeStats = {
  total: number;
  pending: number;
  paid: number;
  closed: number;
  refunded: number;
  paidAmount: number;
};

export function paymentLedgerDbPath(): string {
  return (
    process.env.PAYMENT_LEDGER_DB?.trim() ||
    join(getDataDir(), "payment", "orders.db")
  );
}

export class PaymentOrderLedger {
  private db: SqliteDatabase | null = null;

  private open(): SqliteDatabase | null {
    if (this.db) return this.db;
    try {
      const file = paymentLedgerDbPath();
      mkdirSync(dirname(file), { recursive: true });
      const db = new Database(file);
      db.pragma("journal_mode = WAL");
      db.exec(`
        CREATE TABLE IF NOT EXISTS orders (
          out_trade_no TEXT PRIMARY KEY,
          actor_id     TEXT NOT NULL DEFAULT '',
          provider     TEXT NOT NULL,
          method       TEXT NOT NULL,
          amount       REAL NOT NULL,
          description  TEXT NOT NULL,
          mode         TEXT NOT NULL,
          status       TEXT NOT NULL,
          created_at   TEXT NOT NULL,
          updated_at   TEXT NOT NULL,
          paid_at      TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at DESC);
      `);
      // 旧库补 actor_id 列；历史订单归属未知（空串），只有迁移命令能认领
      try {
        const cols = db.prepare(`PRAGMA table_info(orders)`).all() as Array<{ name: string }>;
        if (!cols.some((c) => c.name === "actor_id")) {
          db.exec(`ALTER TABLE orders ADD COLUMN actor_id TEXT NOT NULL DEFAULT ''`);
        }
        db.exec(`CREATE INDEX IF NOT EXISTS idx_orders_actor_created ON orders(actor_id, created_at DESC)`);
      } catch (err) {
        console.error("[payment-ledger] migrate actor_id failed:", err);
      }
      this.db = db;
      // 真实通道上线后台账只放真实交易：历史 mock 测试单一次性清掉（幂等）。
      try {
        db.prepare(`DELETE FROM orders WHERE mode = 'mock'`).run();
      } catch (err) {
        console.error("[payment-ledger] purge mock rows failed:", err);
      }
      return db;
    } catch (err) {
      console.error("[payment-ledger] open failed:", err);
      return null;
    }
  }

  record(row: LedgerOrderRow): void {
    const db = this.open();
    if (!db) return;
    try {
      db.prepare(`
        INSERT INTO orders (out_trade_no, actor_id, provider, method, amount, description, mode, status, created_at, updated_at, paid_at)
        VALUES (@outTradeNo, @actorId, @provider, @method, @amount, @description, @mode, @status, @createdAt, @updatedAt, @paidAt)
        ON CONFLICT(out_trade_no) DO NOTHING
      `).run(row);
    } catch (err) {
      console.error("[payment-ledger] record failed:", err);
    }
  }

  updateStatus(outTradeNo: string, status: PaymentOrderStatus, paidAt?: string): void {
    const db = this.open();
    if (!db) return;
    try {
      db.prepare(`
        UPDATE orders SET status = @status, paid_at = COALESCE(@paidAt, paid_at), updated_at = @updatedAt
        WHERE out_trade_no = @outTradeNo
      `).run({
        outTradeNo,
        status,
        paidAt: paidAt ?? null,
        updatedAt: new Date().toISOString(),
      });
    } catch (err) {
      console.error("[payment-ledger] updateStatus failed:", err);
    }
  }

  /** 订单列表；actorId 给出时只返回该用户的订单（管理台不传 = 全量） */
  list(limit = 200, actorId?: string): LedgerOrderRow[] {
    const db = this.open();
    if (!db) return [];
    const n = Math.min(Math.max(limit, 1), 1000);
    try {
      const cols = `SELECT out_trade_no AS outTradeNo, actor_id AS actorId, provider, method, amount,
                description, mode, status, created_at AS createdAt, updated_at AS updatedAt, paid_at AS paidAt
         FROM orders`;
      return (actorId
        ? db.prepare(`${cols} WHERE actor_id = ? ORDER BY created_at DESC LIMIT ?`).all(actorId, n)
        : db.prepare(`${cols} ORDER BY created_at DESC LIMIT ?`).all(n)) as unknown as LedgerOrderRow[];
    } catch (err) {
      console.error("[payment-ledger] list failed:", err);
      return [];
    }
  }

  /** 按单号取归属用户（不存在返回 null） */
  ownerOf(outTradeNo: string): string | null {
    const db = this.open();
    if (!db) return null;
    try {
      const row = db.prepare(`SELECT actor_id AS actorId FROM orders WHERE out_trade_no = ?`).get(
        outTradeNo,
      ) as { actorId?: string } | undefined;
      return row?.actorId ?? null;
    } catch (err) {
      console.error("[payment-ledger] ownerOf failed:", err);
      return null;
    }
  }

  /** 按单号取一行（归属校验用；不存在返回 null） */
  get(outTradeNo: string, actorId: string): LedgerOrderRow | null {
    const db = this.open();
    if (!db) return null;
    try {
      const row = db.prepare(
        `SELECT out_trade_no AS outTradeNo, actor_id AS actorId, provider, method, amount,
                description, mode, status, created_at AS createdAt, updated_at AS updatedAt, paid_at AS paidAt
         FROM orders WHERE out_trade_no = ? AND actor_id = ?`,
      ).get(outTradeNo, actorId) as LedgerOrderRow | undefined;
      return row ?? null;
    } catch (err) {
      console.error("[payment-ledger] get failed:", err);
      return null;
    }
  }

  /** 某时刻以来真实下单累计金额（含未支付，排除 error 单）——支付护栏日预算用，
   *  必须按 actor 算：否则 A 的消费会吃掉 B 的日额度。 */
  sumAmountSince(startIso: string, actorId: string): number {
    const db = this.open();
    if (!db) return 0;
    try {
      const row = db.prepare(
        `SELECT COALESCE(SUM(amount), 0) AS total FROM orders
         WHERE actor_id = ? AND created_at >= ? AND status != 'error'`,
      ).get(actorId, startIso) as { total: number } | undefined;
      return Number(row?.total ?? 0);
    } catch (err) {
      console.error("[payment-ledger] sumAmountSince failed:", err);
      return 0;
    }
  }

  /** 订单统计；actorId 给出时只统计该用户（不传 = 全量，管理台用） */
  stats(actorId?: string): { total: LedgerModeStats; mock: LedgerModeStats; live: LedgerModeStats } {
    const empty = (): LedgerModeStats => ({
      total: 0, pending: 0, paid: 0, closed: 0, refunded: 0, paidAmount: 0,
    });
    const out = { total: empty(), mock: empty(), live: empty() };
    const db = this.open();
    if (!db) return out;
    try {
      const sql = `SELECT mode, status, COUNT(*) AS count, COALESCE(SUM(amount), 0) AS amountSum
                   FROM orders`;
      const rows = (actorId
        ? db.prepare(`${sql} WHERE actor_id = ? GROUP BY mode, status`).all(actorId)
        : db.prepare(`${sql} GROUP BY mode, status`).all()) as Array<{
        mode: string;
        status: string;
        count: number;
        amountSum: number;
      }>;
      for (const row of rows) {
        const bucket =
          row.mode === "mock" ? out.mock : row.mode === "live" ? out.live : null;
        if (!bucket) continue;
        const targets = [out.total, bucket];
        for (const t of targets) {
          t.total += row.count;
          if (row.status === "pending") t.pending += row.count;
          else if (row.status === "paid") {
            t.paid += row.count;
            t.paidAmount += row.amountSum;
          } else if (row.status === "closed") t.closed += row.count;
          else if (row.status === "refunded") t.refunded += row.count;
        }
      }
      for (const t of [out.total, out.mock, out.live]) {
        t.paidAmount = Math.round(t.paidAmount * 100) / 100;
      }
      return out;
    } catch (err) {
      console.error("[payment-ledger] stats failed:", err);
      return out;
    }
  }
}

let sharedLedger: PaymentOrderLedger | null = null;

export function getPaymentOrderLedger(): PaymentOrderLedger {
  if (!sharedLedger) sharedLedger = new PaymentOrderLedger();
  return sharedLedger;
}
