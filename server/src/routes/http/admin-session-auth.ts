import { getDataDir } from "../../config/data-dir.js";
import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

import Database from "better-sqlite3";
import type { Database as SqliteDatabase } from "better-sqlite3";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import { adminAudit } from "./admin-auth.js";

/**
 * 管理后台账号密码登录 + 可吊销会话（精简安全版，替代长期静态口令作主通道）。
 *
 * 设计边界（单管理员，多人运营再升级 RBAC/MFA/双 JWT）：
 *  - 密码用 Node 内置 scrypt（不引原生依赖，ECS `npm ci --omit=dev` 零编译风险），
 *    存储格式 `scrypt$N$r$p$salt$hash`，库文件被读也拿不到明文。
 *  - 会话是 32B 随机 opaque token，库里只存 sha256；HttpOnly Cookie 承载，
 *    浏览器永不持有主凭证。滑动过期 7 天闲置 + 30 天绝对上限，登出即删行（可吊销）。
 *  - 登录失败限流：同 IP+账号 5 次失败锁 15 分钟（内存计数，重启清零可接受）。
 *  - 全部登录/登出/设置动作进 adminAudit 审计。
 *
 * 与 admin-auth.ts 存在函数级循环引用（此处 import adminAudit，那边 import
 * resolveAdminSession/hasAdminCredential/hasCsrfHeader）——所有跨模块调用都发生在
 * 函数体内而非模块求值期，ESM 下安全。
 */

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;

/** 会话闲置滑动窗口：每次鉴权成功顺延；绝对上限从创建时刻起算。 */
const SESSION_IDLE_MS = 7 * 24 * 60 * 60 * 1000;
const SESSION_ABSOLUTE_MS = 30 * 24 * 60 * 60 * 1000;

export const ADMIN_SESSION_COOKIE = "pa_admin_session";
/** cookie 通道的写请求必须携带的自定义头（SameSite 之外的第二道 CSRF 保险）。 */
export const CSRF_HEADER = "x-requested-with";
const CSRF_HEADER_VALUE = "admin-console";

const LOGIN_MAX_FAILS = 5;
const LOGIN_LOCK_MS = 15 * 60 * 1000;

function adminAuthDbPath(): string {
  return process.env.ADMIN_AUTH_DB?.trim() || join(getDataDir(), "admin-auth.db");
}

type AdminAuthRow = { id: number; username: string; pwhash: string; updated_at: string };

type AdminSessionRow = {
  token_hash: string;
  username: string;
  ip: string | null;
  user_agent: string | null;
  created_at: string;
  last_seen_at: string;
  expires_at: string;
};

class AdminAuthStoreManager {
  private db: SqliteDatabase | null = null;

  private open(): SqliteDatabase | null {
    if (this.db) return this.db;
    try {
      const file = adminAuthDbPath();
      mkdirSync(dirname(file), { recursive: true });
      const db = new Database(file);
      db.pragma("journal_mode = WAL");
      db.exec(`
        CREATE TABLE IF NOT EXISTS admin_auth (
          id         INTEGER PRIMARY KEY CHECK (id = 1),
          username   TEXT NOT NULL,
          pwhash     TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS admin_sessions (
          token_hash   TEXT PRIMARY KEY,
          username     TEXT NOT NULL,
          ip           TEXT,
          user_agent   TEXT,
          created_at   TEXT NOT NULL,
          last_seen_at TEXT NOT NULL,
          expires_at   TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_admin_sessions_expires ON admin_sessions(expires_at);
      `);
      this.db = db;
      return db;
    } catch (err) {
      console.error("[admin-session] open sqlite failed:", err);
      return null;
    }
  }

  getCredential(): AdminAuthRow | null {
    const db = this.open();
    if (!db) return null;
    return (db.prepare("SELECT id, username, pwhash, updated_at FROM admin_auth WHERE id = 1").get() ??
      null) as AdminAuthRow | null;
  }

  setCredential(username: string, pwhash: string): void {
    const db = this.open();
    if (!db) throw new Error("admin-auth.db 不可用");
    db.prepare(`
      INSERT INTO admin_auth (id, username, pwhash, updated_at) VALUES (1, @username, @pwhash, @now)
      ON CONFLICT(id) DO UPDATE SET username = @username, pwhash = @pwhash, updated_at = @now
    `).run({ username, pwhash, now: new Date().toISOString() });
    // 凭证变更后强制全量重新登录（旧会话立即失效）
    db.prepare("DELETE FROM admin_sessions").run();
  }

  createSession(input: {
    tokenHash: string;
    username: string;
    ip: string | null;
    userAgent: string | null;
  }): void {
    const db = this.open();
    if (!db) throw new Error("admin-auth.db 不可用");
    const now = Date.now();
    db.prepare(`
      INSERT INTO admin_sessions (token_hash, username, ip, user_agent, created_at, last_seen_at, expires_at)
      VALUES (@tokenHash, @username, @ip, @userAgent, @created, @created, @expires)
    `).run({
      ...input,
      created: new Date(now).toISOString(),
      expires: new Date(now + SESSION_ABSOLUTE_MS).toISOString(),
    });
  }

  /** 会话存在且未过期则顺延滑动窗口，返回 username；否则清理并返回 null。 */
  touchSession(tokenHash: string): string | null {
    const db = this.open();
    if (!db) return null;
    const row = db
      .prepare("SELECT username, created_at, expires_at FROM admin_sessions WHERE token_hash = ?")
      .get(tokenHash) as AdminSessionRow | undefined;
    if (!row) return null;
    const now = Date.now();
    if (new Date(row.expires_at).getTime() <= now) {
      db.prepare("DELETE FROM admin_sessions WHERE token_hash = ?").run(tokenHash);
      return null;
    }
    const idleDeadline = Math.min(now + SESSION_IDLE_MS, new Date(row.created_at).getTime() + SESSION_ABSOLUTE_MS);
    db.prepare("UPDATE admin_sessions SET last_seen_at = @seen, expires_at = @expires WHERE token_hash = @h").run({
      seen: new Date(now).toISOString(),
      expires: new Date(idleDeadline).toISOString(),
      h: tokenHash,
    });
    return row.username;
  }

  revokeSession(tokenHash: string): void {
    this.open()?.prepare("DELETE FROM admin_sessions WHERE token_hash = ?").run(tokenHash);
  }

  pruneExpired(): void {
    this.open()
      ?.prepare("DELETE FROM admin_sessions WHERE expires_at <= ?")
      .run(new Date().toISOString());
  }
}

const store = new AdminAuthStoreManager();

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const key = scryptSync(password, salt, SCRYPT_KEYLEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString("base64")}$${key.toString("base64")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  try {
    const salt = Buffer.from(parts[4], "base64");
    const expected = Buffer.from(parts[5], "base64");
    const actual = scryptSync(password, salt, expected.length, { N, r, p });
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/** 账号不存在时也做一次同开销校验，抹平「账号不存在 vs 密码错误」的时序差。 */
let dummyHash: string | null = null;
function dummyVerify(password: string): boolean {
  dummyHash ??= hashPassword(randomBytes(24).toString("base64"));
  return verifyPassword(password, dummyHash);
}

export function hasAdminCredential(): boolean {
  return store.getCredential() !== null;
}

// —— Cookie（手解析，不引 @fastify/cookie） ——

export function readSessionToken(req: FastifyRequest): string {
  const raw = req.headers.cookie;
  if (!raw) return "";
  for (const part of raw.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === ADMIN_SESSION_COOKIE) {
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return "";
}

function applySessionCookie(reply: FastifyReply, req: FastifyRequest, token: string): void {
  const secure = req.protocol === "https" ? "; Secure" : "";
  reply.header(
    "Set-Cookie",
    `${ADMIN_SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict${secure}; Max-Age=${Math.floor(SESSION_ABSOLUTE_MS / 1000)}`,
  );
}

function clearSessionCookie(reply: FastifyReply): void {
  reply.header("Set-Cookie", `${ADMIN_SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
}

export type AdminSessionInfo = { tokenHash: string; username: string } | null;

/** 请求是否携带有效会话；有效则顺延滑动窗口。 */
export function resolveAdminSession(req: FastifyRequest): AdminSessionInfo {
  const token = readSessionToken(req);
  if (!token) return null;
  const tokenHash = sha256Hex(token);
  const username = store.touchSession(tokenHash);
  if (!username) return null;
  return { tokenHash, username };
}

/** cookie 通道的写请求必须带约定头（控制台 api() 统一注入），否则视为 CSRF 拒绝。 */
export function hasCsrfHeader(req: FastifyRequest): boolean {
  return String(req.headers[CSRF_HEADER] ?? "") === CSRF_HEADER_VALUE;
}

function requireCsrfHeader(req: FastifyRequest): boolean {
  return hasCsrfHeader(req);
}

// —— 登录失败限流（内存；进程重启清零可接受） ——

const loginAttempts = new Map<string, { fails: number; lockUntil: number }>();

function attemptKey(req: FastifyRequest, username: string): string {
  return `${req.ip}|${username.trim().toLowerCase()}`;
}

function isLocked(key: string): number {
  const entry = loginAttempts.get(key);
  if (!entry) return 0;
  if (entry.lockUntil > Date.now()) return entry.lockUntil - Date.now();
  if (entry.lockUntil > 0) loginAttempts.delete(key);
  return 0;
}

function recordFail(key: string): void {
  const entry = loginAttempts.get(key) ?? { fails: 0, lockUntil: 0 };
  entry.fails += 1;
  if (entry.fails >= LOGIN_MAX_FAILS) {
    entry.lockUntil = Date.now() + LOGIN_LOCK_MS;
    entry.fails = 0;
  }
  loginAttempts.set(key, entry);
}

function clearFails(key: string): void {
  loginAttempts.delete(key);
}

// —— 路由 ——

const credentialSchema = z.object({
  username: z.string().trim().min(3).max(32),
  password: z.string().min(8).max(128),
});
const loginSchema = z.object({
  username: z.string().trim().min(1).max(32),
  password: z.string().min(1).max(128),
});

export function registerAdminAuthRoutes(app: FastifyInstance): void {
  // 页面启动探测：是否已登录 / 是否需要首次设置。匿名可访问，只暴露这两个布尔。
  app.get("/api/admin/auth/status", async (request) => {
    const session = resolveAdminSession(request);
    return {
      ok: true,
      authenticated: session !== null,
      username: session?.username ?? null,
      needsSetup: !hasAdminCredential(),
    };
  });

  // 首次设置管理员账号密码（仅当尚未设置时可用，先到先得的标准引导）。
  app.post("/api/admin/auth/setup", async (request, reply) => {
    if (!requireCsrfHeader(request)) {
      return reply.code(403).send({ ok: false, message: "CSRF check failed" });
    }
    if (hasAdminCredential()) {
      return reply.code(409).send({ ok: false, message: "管理员账号已设置，如需重置请用 admin-set-password 脚本" });
    }
    const parsed = credentialSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, message: "账号 3-32 位、密码至少 8 位" });
    }
    const { username, password } = parsed.data;
    store.setCredential(username, hashPassword(password));
    const token = randomBytes(32).toString("base64url");
    store.createSession({
      tokenHash: sha256Hex(token),
      username,
      ip: request.ip ?? null,
      userAgent: String(request.headers["user-agent"] ?? "").slice(0, 200) || null,
    });
    applySessionCookie(reply, request, token);
    await adminAudit("admin.auth.setup", { username }, request);
    return { ok: true, username };
  });

  app.post("/api/admin/auth/login", async (request, reply) => {
    if (!requireCsrfHeader(request)) {
      return reply.code(403).send({ ok: false, message: "CSRF check failed" });
    }
    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, message: "参数缺失" });
    }
    const { username, password } = parsed.data;
    const key = attemptKey(request, username);

    const lockRemainMs = isLocked(key);
    if (lockRemainMs > 0) {
      await adminAudit("admin.auth.login.locked", { username }, request);
      return reply.code(429).send({
        ok: false,
        message: `失败次数过多，已锁定，约 ${Math.ceil(lockRemainMs / 60000)} 分钟后重试`,
      });
    }

    const credential = store.getCredential();
    const passwordOk = credential ? verifyPassword(password, credential.pwhash) : dummyVerify(password);
    const usernameOk = credential !== null && credential.username === username;
    if (!credential || !usernameOk || !passwordOk) {
      recordFail(key);
      store.pruneExpired();
      await adminAudit("admin.auth.login.failure", { username }, request);
      // 不区分「账号不存在 / 密码错误」，防账号枚举
      return reply.code(401).send({ ok: false, message: "账号或密码错误" });
    }

    clearFails(key);
    const token = randomBytes(32).toString("base64url");
    store.createSession({
      tokenHash: sha256Hex(token),
      username: credential.username,
      ip: request.ip ?? null,
      userAgent: String(request.headers["user-agent"] ?? "").slice(0, 200) || null,
    });
    applySessionCookie(reply, request, token);
    await adminAudit("admin.auth.login.success", { username: credential.username }, request);
    return { ok: true, username: credential.username };
  });

  app.post("/api/admin/auth/logout", async (request, reply) => {
    if (!requireCsrfHeader(request)) {
      return reply.code(403).send({ ok: false, message: "CSRF check failed" });
    }
    const token = readSessionToken(request);
    if (token) {
      store.revokeSession(sha256Hex(token));
      await adminAudit("admin.auth.logout", {}, request);
    }
    clearSessionCookie(reply);
    return { ok: true };
  });
}
