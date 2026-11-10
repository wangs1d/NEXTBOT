import { createHash, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

import Database from "better-sqlite3";
import type { Database as SqliteDatabase } from "better-sqlite3";

import { getDataDir } from "../../config/data-dir.js";

/**
 * 官网充值页的账号会话（邮箱 OTP 登录后签发）。
 *
 * 与桌面端设备凭证、管理后台会话相互独立：这里只证明「浏览器这一侧
 * 登录的是哪个邮箱」，充值订单与余额都按该邮箱记账。
 * 库里只存 token 的 sha256；Cookie 为 HttpOnly + SameSite=Lax
 * （Lax 是支付宝同步回跳带 Cookie 的最低要求）。
 */

export const SITE_SESSION_COOKIE = "nb_site_session";

const SESSION_IDLE_MS = 7 * 24 * 60 * 60 * 1000;
const SESSION_ABSOLUTE_MS = 30 * 24 * 60 * 60 * 1000;

export function siteSessionDbPath(): string {
  return process.env.RECHARGE_SESSION_DB?.trim() || join(getDataDir(), "recharge", "site-sessions.db");
}

export function hashSiteSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function readSiteSessionToken(cookieHeader: string | undefined): string {
  if (!cookieHeader) return "";
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === SITE_SESSION_COOKIE) {
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return "";
}

export class SiteSessionStore {
  private db: SqliteDatabase | null = null;

  private open(): SqliteDatabase {
    if (this.db) return this.db;
    const file = siteSessionDbPath();
    mkdirSync(dirname(file), { recursive: true });
    const db = new Database(file);
    db.pragma("journal_mode = WAL");
    db.exec(`
      CREATE TABLE IF NOT EXISTS site_sessions (
        token_hash TEXT PRIMARY KEY,
        email TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_site_sessions_expires ON site_sessions(expires_at);
    `);
    this.db = db;
    return db;
  }

  create(email: string): string {
    const token = randomBytes(32).toString("base64url");
    const now = Date.now();
    this.open().prepare(`
      INSERT INTO site_sessions (token_hash, email, created_at, last_seen_at, expires_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      hashSiteSessionToken(token),
      email,
      new Date(now).toISOString(),
      new Date(now).toISOString(),
      new Date(now + SESSION_ABSOLUTE_MS).toISOString(),
    );
    return token;
  }

  /** 有效则顺延滑动窗口并返回邮箱；过期即删。 */
  resolve(tokenHash: string): string | null {
    const db = this.open();
    const row = db.prepare(
      "SELECT email, created_at AS createdAt, expires_at AS expiresAt FROM site_sessions WHERE token_hash = ?",
    ).get(tokenHash) as { email: string; createdAt: string; expiresAt: string } | undefined;
    if (!row) return null;
    const now = Date.now();
    if (new Date(row.expiresAt).getTime() <= now) {
      db.prepare("DELETE FROM site_sessions WHERE token_hash = ?").run(tokenHash);
      return null;
    }
    const idleDeadline = Math.min(
      now + SESSION_IDLE_MS,
      new Date(row.createdAt).getTime() + SESSION_ABSOLUTE_MS,
    );
    db.prepare("UPDATE site_sessions SET last_seen_at = ?, expires_at = ? WHERE token_hash = ?").run(
      new Date(now).toISOString(),
      new Date(idleDeadline).toISOString(),
      tokenHash,
    );
    return row.email;
  }

  revoke(tokenHash: string): void {
    this.open().prepare("DELETE FROM site_sessions WHERE token_hash = ?").run(tokenHash);
  }

  pruneExpired(): void {
    this.open().prepare("DELETE FROM site_sessions WHERE expires_at <= ?").run(new Date().toISOString());
  }
}

export const SITE_SESSION_MAX_AGE_SECONDS = Math.floor(SESSION_ABSOLUTE_MS / 1000);

let sharedStore: SiteSessionStore | null = null;

export function getSiteSessionStore(): SiteSessionStore {
  if (!sharedStore) sharedStore = new SiteSessionStore();
  return sharedStore;
}
