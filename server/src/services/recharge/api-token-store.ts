import { createHash, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

import Database from "better-sqlite3";
import type { Database as SqliteDatabase } from "better-sqlite3";

import { getDataDir } from "../../config/data-dir.js";

/**
 * 官网充值账号的「调用凭据」：登录后自动签发，供 /v1 接口以 Bearer 使用。
 *
 * 与站点会话分开存放：会话是浏览器侧 Cookie（HttpOnly、会滑动续期），
 * 凭据是跨设备长期可用的调用凭证。库里只存 sha256 明文不可逆；
 * 换发即吊销该账号全部旧凭据。
 */

export const API_TOKEN_PREFIX = "nbk_";

export function apiTokenDbPath(): string {
  return process.env.RECHARGE_API_TOKEN_DB?.trim() || join(getDataDir(), "recharge", "api-tokens.db");
}

export function hashApiToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export type ApiTokenInfo = {
  createdAt: string;
  lastUsedAt: string | null;
};

export class ApiTokenStore {
  private db: SqliteDatabase | null = null;

  private open(): SqliteDatabase {
    if (this.db) return this.db;
    const file = apiTokenDbPath();
    mkdirSync(dirname(file), { recursive: true });
    const db = new Database(file);
    db.pragma("journal_mode = WAL");
    db.exec(`
      CREATE TABLE IF NOT EXISTS api_tokens (
        token_hash TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_used_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_api_tokens_account ON api_tokens(account_id);
    `);
    this.db = db;
    return db;
  }

  private issue(accountId: string): string {
    const token = `${API_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
    this.open().prepare(`
      INSERT INTO api_tokens (token_hash, account_id, created_at) VALUES (?, ?, ?)
    `).run(hashApiToken(token), accountId, new Date().toISOString());
    return token;
  }

  /** 已有凭据则返回 null（明文只发一次）；没有则签发一枚。 */
  ensure(accountId: string): { token: string | null; created: boolean } {
    const row = this.open().prepare(
      "SELECT 1 FROM api_tokens WHERE account_id = ? LIMIT 1",
    ).get(accountId);
    if (row) return { token: null, created: false };
    return { token: this.issue(accountId), created: true };
  }

  /** 换发：吊销该账号全部旧凭据，返回新明文（仅此一次）。 */
  rotate(accountId: string): string {
    const db = this.open();
    db.transaction(() => {
      db.prepare("DELETE FROM api_tokens WHERE account_id = ?").run(accountId);
    })();
    return this.issue(accountId);
  }

  info(accountId: string): ApiTokenInfo | null {
    const row = this.open().prepare(`
      SELECT created_at AS createdAt, last_used_at AS lastUsedAt
      FROM api_tokens WHERE account_id = ? ORDER BY created_at DESC LIMIT 1
    `).get(accountId) as ApiTokenInfo | undefined;
    return row ?? null;
  }

  /** 验证 Bearer：命中则刷新 last_used_at 并返回账号邮箱。 */
  resolve(token: string): string | null {
    if (!token) return null;
    const db = this.open();
    const row = db.prepare(
      "SELECT account_id AS accountId FROM api_tokens WHERE token_hash = ?",
    ).get(hashApiToken(token)) as { accountId: string } | undefined;
    if (!row) return null;
    db.prepare("UPDATE api_tokens SET last_used_at = ? WHERE token_hash = ?").run(
      new Date().toISOString(),
      hashApiToken(token),
    );
    return row.accountId;
  }

  close(): void {
    this.db?.close();
    this.db = null;
  }
}

let sharedStore: ApiTokenStore | null = null;

export function getApiTokenStore(): ApiTokenStore {
  if (!sharedStore) sharedStore = new ApiTokenStore();
  return sharedStore;
}
