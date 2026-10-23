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
        INSERT INTO orders (out_trade_no, provider, method, amount, description, mode, status, created_at, updated_at, paid_at)
        VALUES (@outTradeNo, @provider, @method, @amount, @description, @mode, @status, @createdAt, @updatedAt, @paidAt)
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

  list(limit = 200): LedgerOrderRow[] {
    const db = this.open();
    if (!db) return [];
    try {
      return db.prepare(
        `SELECT out_trade_no AS outTradeNo, provider, method, amount, description,
                mode, status, created_at AS createdAt, updated_at AS updatedAt, paid_at AS paidAt
         FROM orders ORDER BY created_at DESC LIMIT ?`,
      ).all(Math.min(Math.max(limit, 1), 1000)) as unknown as LedgerOrderRow[];
    } catch (err) {
      console.error("[payment-ledger] list failed:", err);
      return [];
    }
  }

  /** 某时刻以来真实下单累计金额（含未支付，排除 error 单）——支付护栏日预算用 */
  sumAmountSince(startIso: string): number {
    const db = this.open();
    if (!db) return 0;
    try {
      const row = db.prepare(
        `SELECT COALESCE(SUM(amount), 0) AS total FROM orders WHERE created_at >= ? AND status != 'error'`,
      ).get(startIso) as { total: number } | undefined;
      return Number(row?.total ?? 0);
    } catch (err) {
      console.error("[payment-ledger] sumAmountSince failed:", err);
      return 0;
    }
  }

  stats(): { total: LedgerModeStats; mock: LedgerModeStats; live: LedgerModeStats } {
    const empty = (): LedgerModeStats => ({
      total: 0, pending: 0, paid: 0, closed: 0, refunded: 0, paidAmount: 0,
    });
    const out = { total: empty(), mock: empty(), live: empty() };
    const db = this.open();
    if (!db) return out;
    try {
      const rows = db.prepare(
        `SELECT mode, status, COUNT(*) AS count, COALESCE(SUM(amount), 0) AS amountSum FROM orders GROUP BY mode, status`,
      ).all() as Array<{ mode: string; status: string; count: number; amountSum: number }>;
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
