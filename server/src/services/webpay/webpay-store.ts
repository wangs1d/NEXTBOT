import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import type { Database as SqliteDatabase } from "better-sqlite3";
import { getDataDir } from "../../config/data-dir.js";
import { parseAmountToCents } from "./webpay-amount.js";

/**
 * 网页收款持久订单库（SQLite）：订单、通知事件、退款三张表。
 * 幂等与资金状态必须落盘——进程重启后未决订单仍由后台对账恢复。
 * 写失败直接抛错（支付状态不允许静默丢失），由调用方返回失败。
 */

export type WebpayOrderStatus = "pending" | "paid" | "closed" | "refunded";

export type WebpayOrderRow = {
  outTradeNo: string;
  subject: string;
  /** 元，两位小数字符串 */
  totalAmount: string;
  status: WebpayOrderStatus;
  tradeNo: string | null;
  appId: string;
  env: "sandbox" | "production";
  /** 充值订单归属的登录账号（邮箱）；普通收款单为 null */
  accountId: string | null;
  buyerLogonId: string | null;
  createdAt: string;
  updatedAt: string;
  paidAt: string | null;
  refundedAmount: string;
  lastQueryAt: string | null;
  lastQueryStatus: string | null;
}

export type WebpayRefundRow = {
  outRequestNo: string;
  outTradeNo: string;
  refundAmount: string;
  status: "pending" | "success" | "failed";
  fundChange: string | null;
  reason: string;
  createdAt: string;
  updatedAt: string;
  lastQueryAt: string | null;
}

export function webpayDbPath(): string {
  return process.env.WEBPAY_LEDGER_DB?.trim() || join(getDataDir(), "webpay", "orders.db");
}

const ORDER_COLS = `out_trade_no AS outTradeNo, subject, total_amount AS totalAmount, status,
  trade_no AS tradeNo, app_id AS appId, env, account_id AS accountId, buyer_logon_id AS buyerLogonId,
  created_at AS createdAt, updated_at AS updatedAt, paid_at AS paidAt,
  refunded_amount AS refundedAmount, last_query_at AS lastQueryAt, last_query_status AS lastQueryStatus`;

const REFUND_COLS = `out_request_no AS outRequestNo, out_trade_no AS outTradeNo,
  refund_amount AS refundAmount, status, fund_change AS fundChange, reason,
  created_at AS createdAt, updated_at AS updatedAt, last_query_at AS lastQueryAt`;

export class WebpayStore {
  private db: SqliteDatabase | null = null;

  private open(): SqliteDatabase {
    if (this.db) return this.db;
    const file = webpayDbPath();
    mkdirSync(dirname(file), { recursive: true });
    const db = new Database(file);
    db.pragma("journal_mode = WAL");
    db.exec(`
      CREATE TABLE IF NOT EXISTS webpay_orders (
        out_trade_no TEXT PRIMARY KEY,
        subject TEXT NOT NULL,
        total_amount TEXT NOT NULL,
        status TEXT NOT NULL,
        trade_no TEXT,
        app_id TEXT NOT NULL,
        env TEXT NOT NULL,
        account_id TEXT,
        buyer_logon_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        paid_at TEXT,
        refunded_amount TEXT NOT NULL DEFAULT '0.00',
        last_query_at TEXT,
        last_query_status TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_webpay_orders_status ON webpay_orders(status, created_at);
      CREATE TABLE IF NOT EXISTS recharge_accounts (
        account_id TEXT PRIMARY KEY,
        balance_cents INTEGER NOT NULL DEFAULT 0,
        billing_remainder_micro INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS recharge_ledger (
        out_trade_no TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        amount_cents INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_recharge_ledger_account ON recharge_ledger(account_id, created_at);
      CREATE TABLE IF NOT EXISTS recharge_usage (
        request_id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        model TEXT NOT NULL,
        prompt_tokens INTEGER NOT NULL,
        completion_tokens INTEGER NOT NULL,
        cost_microcents INTEGER NOT NULL,
        charged_cents INTEGER NOT NULL,
        shortfall_microcents INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_recharge_usage_account ON recharge_usage(account_id, created_at);
      CREATE TABLE IF NOT EXISTS webpay_notify_events (
        notify_id TEXT NOT NULL,
        trade_status TEXT NOT NULL,
        out_trade_no TEXT NOT NULL,
        trade_no TEXT,
        params_json TEXT NOT NULL,
        received_at TEXT NOT NULL,
        PRIMARY KEY (notify_id, trade_status)
      );
      CREATE TABLE IF NOT EXISTS webpay_refunds (
        out_request_no TEXT PRIMARY KEY,
        out_trade_no TEXT NOT NULL,
        refund_amount TEXT NOT NULL,
        status TEXT NOT NULL,
        fund_change TEXT,
        reason TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_query_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_webpay_refunds_status ON webpay_refunds(status, created_at);
    `);
    // 旧库补列：account_id 上线前建的表没有该字段
    const cols = db.prepare("PRAGMA table_info(webpay_orders)").all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === "account_id")) {
      db.exec("ALTER TABLE webpay_orders ADD COLUMN account_id TEXT");
    }
    const accountCols = db.prepare("PRAGMA table_info(recharge_accounts)").all() as Array<{ name: string }>;
    if (!accountCols.some((c) => c.name === "billing_remainder_micro")) {
      db.exec("ALTER TABLE recharge_accounts ADD COLUMN billing_remainder_micro INTEGER NOT NULL DEFAULT 0");
    }
    this.db = db;
    return db;
  }

  close(): void {
    this.db?.close();
    this.db = null;
  }

  createOrder(row: Omit<WebpayOrderRow, "accountId"> & { accountId?: string | null }): void {
    this.open().prepare(`
      INSERT INTO webpay_orders (out_trade_no, subject, total_amount, status, trade_no, app_id, env,
        account_id, buyer_logon_id, created_at, updated_at, paid_at, refunded_amount)
      VALUES (@outTradeNo, @subject, @totalAmount, @status, @tradeNo, @appId, @env,
        @accountId, @buyerLogonId, @createdAt, @updatedAt, @paidAt, @refundedAmount)
    `).run({ ...row, accountId: row.accountId ?? null });
  }

  getOrder(outTradeNo: string): WebpayOrderRow | null {
    const row = this.open().prepare(
      `SELECT ${ORDER_COLS} FROM webpay_orders WHERE out_trade_no = ?`,
    ).get(outTradeNo) as WebpayOrderRow | undefined;
    return row ?? null;
  }

  /**
   * 仅 pending → paid，重复通知/查询天然幂等；返回是否本次翻转。
   * 翻转与「入充值余额」在同一事务内完成（以 out_trade_no 去重），
   * 不会出现已支付未入账或重复入账。
   */
  markPaidIdempotently(outTradeNo: string, tradeNo: string, buyerLogonId: string | null, paidAt: string): boolean {
    const db = this.open();
    const updatedAt = new Date().toISOString();
    const tx = db.transaction((): boolean => {
      const result = db.prepare(`
        UPDATE webpay_orders SET status = 'paid', trade_no = @tradeNo, buyer_logon_id = @buyerLogonId,
          paid_at = @paidAt, updated_at = @updatedAt
        WHERE out_trade_no = @outTradeNo AND status = 'pending'
      `).run({ outTradeNo, tradeNo, buyerLogonId, paidAt, updatedAt });
      if (result.changes === 0) return false;
      const order = db.prepare(
        "SELECT account_id AS accountId, total_amount AS totalAmount FROM webpay_orders WHERE out_trade_no = ?",
      ).get(outTradeNo) as { accountId: string | null; totalAmount: string } | undefined;
      if (order?.accountId) {
        const cents = parseAmountToCents(order.totalAmount);
        if (cents !== null) this.creditOnce(order.accountId, outTradeNo, Number(cents), updatedAt);
      }
      return true;
    });
    return tx();
  }

  /** 充值入账（事务内调用）：台账按 out_trade_no 去重，余额只加一次 */
  private creditOnce(accountId: string, outTradeNo: string, amountCents: number, at: string): void {
    const db = this.open();
    const inserted = db.prepare(`
      INSERT OR IGNORE INTO recharge_ledger (out_trade_no, account_id, amount_cents, created_at)
      VALUES (?, ?, ?, ?)
    `).run(outTradeNo, accountId, amountCents, at);
    if (inserted.changes === 0) return;
    db.prepare(`
      INSERT INTO recharge_accounts (account_id, balance_cents, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(account_id) DO UPDATE SET
        balance_cents = balance_cents + excluded.balance_cents,
        updated_at = excluded.updated_at
    `).run(accountId, amountCents, at);
  }

  /** 账户货币余额（分） */
  getRechargeBalanceCents(accountId: string): number {
    const row = this.open().prepare(
      "SELECT balance_cents AS balanceCents FROM recharge_accounts WHERE account_id = ?",
    ).get(accountId) as { balanceCents: number } | undefined;
    return row?.balanceCents ?? 0;
  }

  /** 充值流水（倒序） */
  listRechargeLedger(accountId: string, limit = 20): Array<{ outTradeNo: string; amountCents: number; createdAt: string }> {
    return this.open().prepare(`
      SELECT out_trade_no AS outTradeNo, amount_cents AS amountCents, created_at AS createdAt
      FROM recharge_ledger WHERE account_id = ? ORDER BY created_at DESC LIMIT ?
    `).all(accountId, limit) as Array<{ outTradeNo: string; amountCents: number; createdAt: string }>;
  }

  /** 余额与计费零头（微分为单位，1 分 = 1e6 微） */
  getBalanceState(accountId: string): { balanceCents: number; remainderMicro: number } {
    const row = this.open().prepare(
      "SELECT balance_cents AS balanceCents, billing_remainder_micro AS remainderMicro FROM recharge_accounts WHERE account_id = ?",
    ).get(accountId) as { balanceCents: number; remainderMicro: number } | undefined;
    return { balanceCents: row?.balanceCents ?? 0, remainderMicro: row?.remainderMicro ?? 0 };
  }

  /**
   * 按 token 用量扣减（事务内：写用量台账 + 扣余额）。
   * - 零头滚存：不足 1 分的部分留在 billing_remainder_micro，下次调用继续累计；
   * - 不透支：余额扣到 0 为止，差额记 shortfall 便于对账；
   * - 幂等：request_id 主键，同一请求重复入账直接返回既有结果。
   */
  chargeUsage(input: {
    requestId: string;
    accountId: string;
    model: string;
    promptTokens: number;
    completionTokens: number;
    costMicrocents: number;
  }): { chargedCents: number; balanceCents: number; duplicate: boolean } {
    const db = this.open();
    const at = new Date().toISOString();
    const tx = db.transaction((): { chargedCents: number; balanceCents: number; duplicate: boolean } => {
      const existing = db.prepare(`
        SELECT charged_cents AS chargedCents,
          (SELECT balance_cents FROM recharge_accounts WHERE account_id = recharge_usage.account_id) AS balanceCents
        FROM recharge_usage WHERE request_id = ?
      `).get(input.requestId) as { chargedCents: number; balanceCents: number | null } | undefined;
      if (existing) {
        return { chargedCents: existing.chargedCents, balanceCents: existing.balanceCents ?? 0, duplicate: true };
      }
      const state = this.getBalanceState(input.accountId);
      const available = state.balanceCents * 1_000_000 + state.remainderMicro;
      const cost = Math.max(0, Math.trunc(input.costMicrocents));
      let chargedCents: number;
      let nextRemainder: number;
      let shortfall = 0;
      if (cost > available) {
        shortfall = cost - available;
        chargedCents = state.balanceCents;
        nextRemainder = 0;
      } else {
        const combined = state.remainderMicro + cost;
        chargedCents = Math.floor(combined / 1_000_000);
        nextRemainder = combined % 1_000_000;
      }
      const balanceCents = state.balanceCents - chargedCents;
      db.prepare(`
        INSERT INTO recharge_usage (request_id, account_id, model, prompt_tokens, completion_tokens,
          cost_microcents, charged_cents, shortfall_microcents, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.requestId,
        input.accountId,
        input.model,
        Math.max(0, Math.trunc(input.promptTokens)),
        Math.max(0, Math.trunc(input.completionTokens)),
        cost,
        chargedCents,
        shortfall,
        at,
      );
      db.prepare(`
        INSERT INTO recharge_accounts (account_id, balance_cents, billing_remainder_micro, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(account_id) DO UPDATE SET
          balance_cents = excluded.balance_cents,
          billing_remainder_micro = excluded.billing_remainder_micro,
          updated_at = excluded.updated_at
      `).run(input.accountId, balanceCents, nextRemainder, at);
      return { chargedCents, balanceCents, duplicate: false };
    });
    return tx();
  }

  listUsage(
    accountId: string,
    limit = 20,
  ): Array<{
    requestId: string;
    model: string;
    promptTokens: number;
    completionTokens: number;
    costMicrocents: number;
    chargedCents: number;
    shortfallMicrocents: number;
    createdAt: string;
  }> {
    return this.open().prepare(`
      SELECT request_id AS requestId, model, prompt_tokens AS promptTokens,
        completion_tokens AS completionTokens, cost_microcents AS costMicrocents,
        charged_cents AS chargedCents, shortfall_microcents AS shortfallMicrocents,
        created_at AS createdAt
      FROM recharge_usage WHERE account_id = ? ORDER BY created_at DESC LIMIT ?
    `).all(accountId, limit) as Array<{
      requestId: string;
      model: string;
      promptTokens: number;
      completionTokens: number;
      costMicrocents: number;
      chargedCents: number;
      shortfallMicrocents: number;
      createdAt: string;
    }>;
  }

  markClosed(outTradeNo: string): boolean {    const result = this.open().prepare(`
      UPDATE webpay_orders SET status = 'closed', updated_at = @updatedAt
      WHERE out_trade_no = @outTradeNo AND status = 'pending'
    `).run({ outTradeNo, updatedAt: new Date().toISOString() });
    return result.changes > 0;
  }

  recordQuery(outTradeNo: string, tradeStatus: string): void {
    this.open().prepare(`
      UPDATE webpay_orders SET last_query_at = @now, last_query_status = @tradeStatus
      WHERE out_trade_no = @outTradeNo
    `).run({ outTradeNo, tradeStatus, now: new Date().toISOString() });
  }

    /** 退款确认成功后累计金额；全额退完时订单转 refunded */
  recordRefundSuccess(outTradeNo: string, newRefundedTotal: string, fullyRefunded: boolean): void {
    this.open().prepare(`
      UPDATE webpay_orders SET refunded_amount = @newRefundedTotal,
        status = CASE WHEN @fullyRefunded THEN 'refunded' ELSE status END,
        updated_at = @updatedAt
      WHERE out_trade_no = @outTradeNo
    `).run({ outTradeNo, newRefundedTotal, fullyRefunded: fullyRefunded ? 1 : 0, updatedAt: new Date().toISOString() });
  }

  listPendingOrders(limit = 100): WebpayOrderRow[] {
    return this.open().prepare(
      `SELECT ${ORDER_COLS} FROM webpay_orders WHERE status = 'pending' ORDER BY created_at ASC LIMIT ?`,
    ).all(limit) as unknown as WebpayOrderRow[];
  }

  insertNotifyOnce(notifyId: string, tradeStatus: string, outTradeNo: string, tradeNo: string | null, paramsJson: string): boolean {
    const result = this.open().prepare(`
      INSERT OR IGNORE INTO webpay_notify_events (notify_id, trade_status, out_trade_no, trade_no, params_json, received_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(notifyId, tradeStatus, outTradeNo, tradeNo, paramsJson, new Date().toISOString());
    return result.changes > 0;
  }

  createRefund(row: WebpayRefundRow): void {
    this.open().prepare(`
      INSERT INTO webpay_refunds (out_request_no, out_trade_no, refund_amount, status, fund_change, reason, created_at, updated_at)
      VALUES (@outRequestNo, @outTradeNo, @refundAmount, @status, @fundChange, @reason, @createdAt, @updatedAt)
    `).run(row);
  }

  getRefund(outRequestNo: string): WebpayRefundRow | null {
    const row = this.open().prepare(
      `SELECT ${REFUND_COLS} FROM webpay_refunds WHERE out_request_no = ?`,
    ).get(outRequestNo) as WebpayRefundRow | undefined;
    return row ?? null;
  }

  setRefundResult(outRequestNo: string, status: WebpayRefundRow["status"], fundChange: string | null): void {
    this.open().prepare(`
      UPDATE webpay_refunds SET status = @status, fund_change = @fundChange,
        updated_at = @updatedAt, last_query_at = @now
      WHERE out_request_no = @outRequestNo
    `).run({ outRequestNo, status, fundChange, updatedAt: new Date().toISOString(), now: new Date().toISOString() });
  }

  touchRefundQuery(outRequestNo: string): void {
    this.open().prepare(
      `UPDATE webpay_refunds SET last_query_at = ? WHERE out_request_no = ?`,
    ).run(new Date().toISOString(), outRequestNo);
  }

  listPendingRefunds(limit = 100): WebpayRefundRow[] {
    return this.open().prepare(
      `SELECT ${REFUND_COLS} FROM webpay_refunds WHERE status = 'pending' ORDER BY created_at ASC LIMIT ?`,
    ).all(limit) as unknown as WebpayRefundRow[];
  }

  listPendingRefundsForOrder(outTradeNo: string): WebpayRefundRow[] {
    return this.open().prepare(
      `SELECT ${REFUND_COLS} FROM webpay_refunds WHERE out_trade_no = ? AND status = 'pending'`,
    ).all(outTradeNo) as unknown as WebpayRefundRow[];
  }
}

let sharedStore: WebpayStore | null = null;

export function getWebpayStore(): WebpayStore {
  if (!sharedStore) sharedStore = new WebpayStore();
  return sharedStore;
}