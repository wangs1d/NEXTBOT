import { getDataDir } from "../config/data-dir.js";
import { randomUUID } from "crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync } from "fs";
import { dirname, join } from "path";

import Database from "better-sqlite3";
import type { Database as SqliteDatabase, Statement as SqliteStatement } from "better-sqlite3";

export type FriendRequestStatus = "pending" | "accepted" | "rejected" | "cancelled";

export type FriendRequestRecord = {
  requestId: string;
  fromActorId: string;
  toActorId: string;
  message?: string;
  status: FriendRequestStatus;
  createdAt: string;
  updatedAt: string;
};

export type FriendRecord = {
  actorId: string;
  friendActorId: string;
  addedAt: string;
  lastMessageAt?: string;
};

/** 单 actor 好友数量上限；`AGENT_FRIEND_MAX_PER_ACTOR` 可覆盖。 */
export const DEFAULT_FRIEND_MAX_PER_ACTOR = 200;

/** 好友关系状态（发现/搜索接口的标注用）。 */
export type FriendshipStatus = "none" | "friends" | "outgoing_pending" | "incoming_pending";

export type FriendRequestResult =
  | { ok: true; request: FriendRequestRecord; autoAccepted?: boolean }
  | { ok: false; reason: string };

/**
 * Agent 好友系统服务：管理好友请求和好友关系。
 *
 * 存储：better-sqlite3 单文件（WAL），缺省 `data/agent-friends.db`
 * （`AGENT_FRIENDS_DB` 覆盖；测试显式传临时路径）。所有写路径走事务，
 * 查询走索引，替代旧版「全量读入 Map + 每次变更整文件重写 JSON」。
 * 首次启动时若发现旧 `agent-friends.json` 且库为空，自动一次性导入并
 * 将旧文件改名为 `*.imported.bak`。
 */
export class FriendService {
  private db: SqliteDatabase | null = null;
  private readonly dbPath: string;
  private readonly legacyJsonPath: string;
  private readonly maxFriendsPerActor: number;

  private stmtAllRequests!: SqliteStatement;
  private stmtRequestById!: SqliteStatement;
  private stmtPendingPair!: SqliteStatement;
  private stmtRequestsByTo!: SqliteStatement;
  private stmtRequestsByFrom!: SqliteStatement;
  private stmtRequestsByActor!: SqliteStatement;
  private stmtFriendsByActor!: SqliteStatement;
  private stmtFriendCount!: SqliteStatement;
  private stmtAreFriends!: SqliteStatement;
  private stmtFriendshipPair!: SqliteStatement;
  private stmtAutoAccept!: SqliteStatement;

  constructor(options?: { dbPath?: string; legacyJsonPath?: string; maxFriendsPerActor?: number }) {
    this.dbPath =
      options?.dbPath?.trim() ||
      process.env.AGENT_FRIENDS_DB?.trim() ||
      join(getDataDir(), "agent-friends.db");
    this.legacyJsonPath =
      options?.legacyJsonPath?.trim() ||
      process.env.AGENT_FRIENDS_FILE?.trim() ||
      join(getDataDir(), "agent-friends.json");
    const parsedMax = options?.maxFriendsPerActor ?? Number(process.env.AGENT_FRIEND_MAX_PER_ACTOR ?? "");
    this.maxFriendsPerActor =
      Number.isFinite(parsedMax) && parsedMax > 0 ? Math.floor(parsedMax) : DEFAULT_FRIEND_MAX_PER_ACTOR;
  }

  async load(): Promise<void> {
    mkdirSync(dirname(this.dbPath), { recursive: true });
    const db = new Database(this.dbPath);
    db.pragma("journal_mode = WAL");
    db.exec(`
      CREATE TABLE IF NOT EXISTS friend_requests (
        request_id TEXT PRIMARY KEY,
        from_actor TEXT NOT NULL,
        to_actor TEXT NOT NULL,
        message TEXT,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_friend_requests_from ON friend_requests(from_actor);
      CREATE INDEX IF NOT EXISTS idx_friend_requests_to ON friend_requests(to_actor);
      CREATE INDEX IF NOT EXISTS idx_friend_requests_pair ON friend_requests(from_actor, to_actor, status);
      CREATE TABLE IF NOT EXISTS friends (
        actor_id TEXT NOT NULL,
        friend_actor_id TEXT NOT NULL,
        added_at TEXT NOT NULL,
        last_message_at TEXT,
        PRIMARY KEY (actor_id, friend_actor_id)
      );
      CREATE INDEX IF NOT EXISTS idx_friends_friend ON friends(friend_actor_id);
      CREATE TABLE IF NOT EXISTS friend_auto_accept (
        actor_id TEXT PRIMARY KEY,
        enabled INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    this.db = db;
    this.prepareStatements();
    this.migrateLegacyJsonIfNeeded();
  }

  /** 测试 / 优雅退出用。 */
  close(): void {
    this.db?.close();
    this.db = null;
  }

  private prepareStatements(): void {
    const db = this.db as SqliteDatabase;
    this.stmtAllRequests = db.prepare("SELECT * FROM friend_requests");
    this.stmtRequestById = db.prepare("SELECT * FROM friend_requests WHERE request_id = ?");
    this.stmtPendingPair = db.prepare(
      "SELECT * FROM friend_requests WHERE from_actor = ? AND to_actor = ? AND status = 'pending' LIMIT 1"
    );
    this.stmtRequestsByTo = db.prepare(
      "SELECT * FROM friend_requests WHERE to_actor = ? AND status = 'pending' ORDER BY created_at DESC"
    );
    this.stmtRequestsByFrom = db.prepare(
      "SELECT * FROM friend_requests WHERE from_actor = ? AND status = 'pending' ORDER BY created_at DESC"
    );
    this.stmtRequestsByActor = db.prepare(
      "SELECT * FROM friend_requests WHERE from_actor = ? OR to_actor = ? ORDER BY created_at DESC"
    );
    this.stmtFriendsByActor = db.prepare(
      "SELECT * FROM friends WHERE actor_id = ? ORDER BY added_at DESC"
    );
    this.stmtFriendCount = db.prepare("SELECT COUNT(*) AS n FROM friends WHERE actor_id = ?");
    this.stmtAreFriends = db.prepare(
      "SELECT 1 FROM friends WHERE actor_id = ? AND friend_actor_id = ? LIMIT 1"
    );
    this.stmtFriendshipPair = db.prepare(
      "SELECT * FROM friend_requests WHERE ((from_actor = ? AND to_actor = ?) OR (from_actor = ? AND to_actor = ?)) AND status = 'pending' LIMIT 1"
    );
    this.stmtAutoAccept = db.prepare(
      "SELECT enabled FROM friend_auto_accept WHERE actor_id = ?"
    );
  }

  /** 旧 JSON 一次性迁移：仅在两张表都为空时执行，导入后旧文件改名留存。 */
  private migrateLegacyJsonIfNeeded(): void {
    if (!existsSync(this.legacyJsonPath)) return;
    const db = this.db as SqliteDatabase;
    const reqCount = (db.prepare("SELECT COUNT(*) AS n FROM friend_requests").get() as { n: number }).n;
    const friendCount = (db.prepare("SELECT COUNT(*) AS n FROM friends").get() as { n: number }).n;
    if (reqCount > 0 || friendCount > 0) return;

    let data: { requests?: FriendRequestRecord[]; friends?: FriendRecord[] };
    try {
      data = JSON.parse(readFileSync(this.legacyJsonPath, "utf8")) as {
        requests?: FriendRequestRecord[];
        friends?: FriendRecord[];
      };
    } catch {
      return;
    }

    const insertRequest = db.prepare(
      `INSERT OR IGNORE INTO friend_requests (request_id, from_actor, to_actor, message, status, created_at, updated_at)
       VALUES (@requestId, @fromActorId, @toActorId, @message, @status, @createdAt, @updatedAt)`
    );
    const insertFriend = db.prepare(
      `INSERT OR IGNORE INTO friends (actor_id, friend_actor_id, added_at, last_message_at)
       VALUES (@actorId, @friendActorId, @addedAt, @lastMessageAt)`
    );
    db.transaction(() => {
      for (const r of data.requests ?? []) {
        // 旧 JSON 由非原子写入产生，可能存在缺字段的历史行；绑定 undefined 会抛错，
        // 这里按 schema 校验并跳过坏行，避免迁移失败导致每次启动都崩溃。
        if (
          !r?.requestId || !r.fromActorId || !r.toActorId ||
          !r.status || !r.createdAt || !r.updatedAt
        ) {
          continue;
        }
        insertRequest.run({
          requestId: r.requestId,
          fromActorId: r.fromActorId,
          toActorId: r.toActorId,
          message: r.message ?? null,
          status: r.status,
          createdAt: r.createdAt,
          updatedAt: r.updatedAt,
        });
      }
      for (const f of data.friends ?? []) {
        if (!f?.actorId || !f.friendActorId || !f.addedAt) continue;
        insertFriend.run({
          actorId: f.actorId,
          friendActorId: f.friendActorId,
          addedAt: f.addedAt,
          lastMessageAt: f.lastMessageAt ?? null,
        });
      }
    })();

    try {
      const bak = `${this.legacyJsonPath}.imported.bak`;
      if (existsSync(bak)) unlinkSync(bak);
      renameSync(this.legacyJsonPath, bak);
    } catch {
      // 改名失败不影响：两表非空后不会重复导入
    }
  }

  private rowToRequest(row: Record<string, unknown>): FriendRequestRecord {
    return {
      requestId: String(row.request_id),
      fromActorId: String(row.from_actor),
      toActorId: String(row.to_actor),
      ...(row.message ? { message: String(row.message) } : {}),
      status: String(row.status) as FriendRequestStatus,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  private rowToFriend(row: Record<string, unknown>): FriendRecord {
    return {
      actorId: String(row.actor_id),
      friendActorId: String(row.friend_actor_id),
      addedAt: String(row.added_at),
      ...(row.last_message_at ? { lastMessageAt: String(row.last_message_at) } : {}),
    };
  }

  private getFriendCount(actorId: string): number {
    return (this.stmtFriendCount.get(actorId) as { n: number }).n;
  }

  /** 建立双向好友关系 + 请求落为 accepted，同一事务。 */
  private acceptRequestTx(request: FriendRequestRecord, now: string): void {
    const db = this.db as SqliteDatabase;
    db.transaction(() => {
      db.prepare(
        "UPDATE friend_requests SET status = 'accepted', updated_at = ? WHERE request_id = ?"
      ).run(now, request.requestId);
      const insertFriend = db.prepare(
        `INSERT OR IGNORE INTO friends (actor_id, friend_actor_id, added_at) VALUES (?, ?, ?)`
      );
      insertFriend.run(request.fromActorId, request.toActorId, now);
      insertFriend.run(request.toActorId, request.fromActorId, now);
    })();
  }

  /**
   * 发送好友请求。目标 actor 开启了自动同意（agent 好友的典型形态）时，
   * 请求创建后立即代为接受并返回 `autoAccepted: true`。
   */
  async sendFriendRequest(
    fromActorId: string,
    toActorId: string,
    message?: string
  ): Promise<FriendRequestResult> {
    const from = fromActorId.trim();
    const to = toActorId.trim();

    if (!from || !to) {
      return { ok: false, reason: "用户ID不能为空" };
    }

    if (from === to) {
      return { ok: false, reason: "不能添加自己为好友" };
    }

    if (this.areFriends(from, to)) {
      return { ok: false, reason: "已经是好友关系" };
    }

    if (this.getPendingRequest(from, to)) {
      return { ok: false, reason: "已存在待处理的好友请求" };
    }

    if (this.getFriendCount(from) >= this.maxFriendsPerActor) {
      return { ok: false, reason: `你的好友数量已达上限（${this.maxFriendsPerActor}）` };
    }
    if (this.getFriendCount(to) >= this.maxFriendsPerActor) {
      return { ok: false, reason: `对方好友数量已达上限（${this.maxFriendsPerActor}）` };
    }

    const now = new Date().toISOString();
    const request: FriendRequestRecord = {
      requestId: `fr_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
      fromActorId: from,
      toActorId: to,
      message: message?.trim() || undefined,
      status: "pending",
      createdAt: now,
      updatedAt: now,
    };

    (this.db as SqliteDatabase).prepare(
      `INSERT INTO friend_requests (request_id, from_actor, to_actor, message, status, created_at, updated_at)
       VALUES (@requestId, @fromActorId, @toActorId, @message, @status, @createdAt, @updatedAt)`
    ).run({
      requestId: request.requestId,
      fromActorId: request.fromActorId,
      toActorId: request.toActorId,
      message: request.message ?? null,
      status: request.status,
      createdAt: request.createdAt,
      updatedAt: request.updatedAt,
    });

    if (this.isAutoAccept(to)) {
      this.acceptRequestTx(request, new Date().toISOString());
      return {
        ok: true,
        request: this.rowToRequest(this.stmtRequestById.get(request.requestId) as Record<string, unknown>),
        autoAccepted: true,
      };
    }

    return { ok: true, request };
  }

  /**
   * 获取待处理的好友请求
   */
  getPendingRequest(fromActorId: string, toActorId: string): FriendRequestRecord | undefined {
    const row = this.stmtPendingPair.get(fromActorId.trim(), toActorId.trim()) as
      | Record<string, unknown>
      | undefined;
    return row ? this.rowToRequest(row) : undefined;
  }

  /**
   * 响应好友请求（接受或拒绝）
   */
  async respondToRequest(
    requestId: string,
    responderActorId: string,
    accept: boolean
  ): Promise<{ ok: true; request?: FriendRequestRecord } | { ok: false; reason: string }> {
    const row = this.stmtRequestById.get(requestId) as Record<string, unknown> | undefined;
    if (!row) {
      return { ok: false, reason: "好友请求不存在" };
    }

    if (String(row.to_actor) !== responderActorId) {
      return { ok: false, reason: "无权响应该请求" };
    }

    if (String(row.status) !== "pending") {
      return { ok: false, reason: "请求状态已变更" };
    }

    const request = this.rowToRequest(row);
    const now = new Date().toISOString();

    if (accept) {
      this.acceptRequestTx(request, now);
      return {
        ok: true,
        request: this.rowToRequest(this.stmtRequestById.get(requestId) as Record<string, unknown>),
      };
    }

    (this.db as SqliteDatabase).prepare(
      "UPDATE friend_requests SET status = 'rejected', updated_at = ? WHERE request_id = ?"
    ).run(now, requestId);

    return { ok: true, request: { ...request, status: "rejected", updatedAt: now } };
  }

  /**
   * 取消好友请求
   */
  async cancelRequest(
    requestId: string,
    requesterActorId: string
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    const row = this.stmtRequestById.get(requestId) as Record<string, unknown> | undefined;
    if (!row) {
      return { ok: false, reason: "好友请求不存在" };
    }

    if (String(row.from_actor) !== requesterActorId) {
      return { ok: false, reason: "无权取消该请求" };
    }

    if (String(row.status) !== "pending") {
      return { ok: false, reason: "请求状态已变更" };
    }

    (this.db as SqliteDatabase).prepare(
      "UPDATE friend_requests SET status = 'cancelled', updated_at = ? WHERE request_id = ?"
    ).run(new Date().toISOString(), requestId);

    return { ok: true };
  }

  /**
   * 检查两个用户是否是好友
   */
  areFriends(actorId1: string, actorId2: string): boolean {
    return !!this.stmtAreFriends.get(actorId1, actorId2);
  }

  /**
   * 我与目标的好友关系状态（发现/搜索标注用）。
   */
  friendshipStatus(fromActorId: string, toActorId: string): FriendshipStatus {
    const from = fromActorId.trim();
    const to = toActorId.trim();
    if (this.areFriends(from, to)) return "friends";
    const row = this.stmtFriendshipPair.get(from, to, to, from) as Record<string, unknown> | undefined;
    if (!row) return "none";
    return String(row.from_actor) === from ? "outgoing_pending" : "incoming_pending";
  }

  /**
   * 获取用户的好友列表
   */
  getFriends(actorId: string): FriendRecord[] {
    return (this.stmtFriendsByActor.all(actorId) as Record<string, unknown>[]).map((r) =>
      this.rowToFriend(r)
    );
  }

  /**
   * 获取发送给某用户的待处理好友请求
   */
  getIncomingRequests(toActorId: string): FriendRequestRecord[] {
    return (this.stmtRequestsByTo.all(toActorId) as Record<string, unknown>[]).map((r) =>
      this.rowToRequest(r)
    );
  }

  /**
   * 获取某用户发出的待处理好友请求
   */
  getOutgoingRequests(fromActorId: string): FriendRequestRecord[] {
    return (this.stmtRequestsByFrom.all(fromActorId) as Record<string, unknown>[]).map((r) =>
      this.rowToRequest(r)
    );
  }

  /**
   * 获取用户的所有好友请求（包括已接受、已拒绝等）
   */
  getAllRequests(actorId: string): FriendRequestRecord[] {
    return (this.stmtRequestsByActor.all(actorId, actorId) as Record<string, unknown>[]).map((r) =>
      this.rowToRequest(r)
    );
  }

  /**
   * 更新最后消息时间
   */
  async updateLastMessageTime(actorId: string, friendActorId: string): Promise<void> {
    (this.db as SqliteDatabase).prepare(
      "UPDATE friends SET last_message_at = ? WHERE actor_id = ? AND friend_actor_id = ?"
    ).run(new Date().toISOString(), actorId, friendActorId);
  }

  /**
   * 设置本 actor 的好友请求自动同意开关（agent 好友：服务端托管的 agent
   * 打开后即可被直接添加；真人用户默认关闭，不受影响）。
   */
  setAutoAccept(actorId: string, enabled: boolean): void {
    const id = actorId.trim();
    if (!id) return;
    (this.db as SqliteDatabase).prepare(
      `INSERT INTO friend_auto_accept (actor_id, enabled, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(actor_id) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at`
    ).run(id, enabled ? 1 : 0, new Date().toISOString());
  }

  isAutoAccept(actorId: string): boolean {
    const row = this.stmtAutoAccept.get(actorId.trim()) as { enabled: number } | undefined;
    return !!row && row.enabled === 1;
  }
}
