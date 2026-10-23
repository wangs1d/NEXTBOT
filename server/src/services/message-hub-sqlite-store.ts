/**
 * 消息聚合中心 SQLite 存储内核（照 agentic-memory/sqlite-store.ts 模式）。
 *
 * 库文件缺省 data/message-hub/message-hub.db（AGENT_MESSAGE_HUB_DB 覆盖）。
 * 两张表：
 *   - mh_conversations 会话表（未读计数、最新预览）
 *   - mh_messages      消息表（append-only，external_message_id 唯一去重）
 *
 * 去重靠部分唯一索引 (actor_id, platform, external_message_id)（仅非 NULL 生效）：
 * 手机通知捕捉可能重复上报同一条通知，INSERT OR IGNORE + changes 即可判重，
 * 不需要应用层先查后插。
 *
 * better-sqlite3 为同步本地库：所有方法都是同步的，调用方 await 兼容。
 */

import { getDataDir } from "../config/data-dir.js";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

import Database from "better-sqlite3";
import type { Database as SqliteDatabase, Statement } from "better-sqlite3";

import type { MessageHubConversation, MessageHubMessage } from "./message-hub-service.js";

export function getMessageHubDbPath(): string {
  return (
    process.env.AGENT_MESSAGE_HUB_DB?.trim() ||
    join(getDataDir(), "message-hub", "message-hub.db")
  );
}

/** 打开（或创建）消息聚合库：WAL + 外键。 */
export function openMessageHubSqlite(path?: string): SqliteDatabase {
  const file = path ?? getMessageHubDbPath();
  mkdirSync(dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  return db;
}

function toJsonColumn(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return JSON.stringify(value);
}

export type MessageHubGlobalStats = {
  conversations: number;
  messages: number;
  outbound: number;
  inbound: number;
  today: number;
  series: Array<{ day: string; count: number }>;
};

export type MessageHubPlatformStat = {
  platform: string;
  conversations: number;
  messages: number;
};

export type MessageHubRecentMessage = {
  messageId: string;
  actorId: string;
  platform: string;
  conversationId: string;
  direction: string;
  senderName: string | null;
  text: string;
  createdAt: string;
};

function fromJsonColumn<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** legacy JSON 记录运行时可迁移性：NOT NULL 列（platform/channelId）非空字符串。 */
function legacyRecordMigratable(record: Pick<MessageHubConversation, "platform" | "channelId">): boolean {
  return (
    typeof record.platform === "string" &&
    record.platform.length > 0 &&
    typeof record.channelId === "string" &&
    record.channelId.length > 0
  );
}

type ConversationRow = {
  conversation_id: string;
  actor_id: string;
  platform: string;
  channel_id: string;
  title: string | null;
  participant_id: string | null;
  participant_name: string | null;
  last_message_at: string;
  unread_count: number;
  last_message_preview: string;
  created_at: string;
  updated_at: string;
};

type MessageRow = {
  message_id: string;
  actor_id: string;
  conversation_id: string;
  platform: string;
  channel_id: string;
  direction: string;
  sender_id: string | null;
  sender_name: string | null;
  text: string;
  created_at: string;
  reply_to_message_id: string | null;
  external_message_id: string | null;
  meta: string | null;
  seq: number | null;
};

function rowToConversation(row: ConversationRow): MessageHubConversation {
  return {
    conversationId: row.conversation_id,
    actorId: row.actor_id,
    platform: row.platform as MessageHubConversation["platform"],
    channelId: row.channel_id,
    title: row.title ?? undefined,
    participantId: row.participant_id ?? undefined,
    participantName: row.participant_name ?? undefined,
    lastMessageAt: row.last_message_at,
    unreadCount: row.unread_count,
    lastMessagePreview: row.last_message_preview,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToMessage(row: MessageRow): MessageHubMessage {
  return {
    messageId: row.message_id,
    actorId: row.actor_id,
    conversationId: row.conversation_id,
    platform: row.platform as MessageHubMessage["platform"],
    channelId: row.channel_id,
    direction: row.direction as MessageHubMessage["direction"],
    senderId: row.sender_id ?? undefined,
    senderName: row.sender_name ?? undefined,
    text: row.text,
    createdAt: row.created_at,
    replyToMessageId: row.reply_to_message_id ?? undefined,
    externalMessageId: row.external_message_id ?? undefined,
    meta: fromJsonColumn<Record<string, unknown> | undefined>(row.meta, undefined),
    // 会话内单调序号（2026-10-17）：客户端排序/去重/增量拉取（sinceSeq 游标）的稳定依据
    seq: row.seq ?? undefined,
  };
}

export type ConversationUpsertInput = {
  actorId: string;
  conversationId: string;
  platform: string;
  channelId: string;
  title?: string;
  participantId?: string;
  participantName?: string;
  incrementUnread: boolean;
  lastMessageText: string;
  lastMessageAt: string;
};

export type MessageInsertInput = {
  messageId: string;
  actorId: string;
  conversationId: string;
  platform: string;
  channelId: string;
  direction: "inbound" | "outbound";
  senderId?: string;
  senderName?: string;
  text: string;
  createdAt: string;
  replyToMessageId?: string;
  externalMessageId?: string;
  meta?: Record<string, unknown>;
};

export type PlatformStat = {
  platform: string;
  unreadCount: number;
  conversationCount: number;
  latest: Array<{
    conversationId: string;
    title?: string;
    participantName?: string;
    preview: string;
    lastMessageAt: string;
    unreadCount: number;
  }>;
};

const PRUNE_DEFAULT_RETENTION_DAYS = 7;
const PRUNE_PER_CONVERSATION_CAP = 500;

export class MessageHubSqliteStore {
  private readonly db: SqliteDatabase;
  private readonly insertMessageStmt: Statement;
  private readonly upsertConversationStmt: Statement;
  private readonly nextSeqStmt: Statement;

  constructor(db?: SqliteDatabase | string) {
    // 支持传路径字符串（message-hub-service 持有 dbPath 配置）：按需打开，父目录不存在则创建
    if (typeof db === "string") {
      mkdirSync(dirname(db), { recursive: true });
      this.db = new Database(db);
    } else {
      this.db = db ?? openMessageHubSqlite();
    }
    // 顺序约束：建表 → 补列迁移 → 建索引。idx_mh_msg_conv_seq 依赖 seq 列，
    // 必须在 migrateAddSeqColumn 之后创建，否则旧库（无 seq 列）启动即崩
    // "no such column: seq"（2026-10-17 修复）。
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS mh_conversations (
        conversation_id TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        platform TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        title TEXT,
        participant_id TEXT,
        participant_name TEXT,
        last_message_at TEXT NOT NULL,
        unread_count INTEGER NOT NULL DEFAULT 0,
        last_message_preview TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (actor_id, conversation_id)
      );

      CREATE TABLE IF NOT EXISTS mh_messages (
        message_id TEXT PRIMARY KEY,
        actor_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        platform TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        direction TEXT NOT NULL,
        sender_id TEXT,
        sender_name TEXT,
        text TEXT NOT NULL,
        created_at TEXT NOT NULL,
        reply_to_message_id TEXT,
        external_message_id TEXT,
        meta TEXT,
        seq INTEGER
      );
    `);
    this.migrateAddSeqColumn();
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_mh_conv_actor_platform
        ON mh_conversations(actor_id, platform, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_mh_msg_conv_time
        ON mh_messages(actor_id, conversation_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_mh_msg_conv_seq
        ON mh_messages(actor_id, conversation_id, seq);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_mh_msg_external
        ON mh_messages(actor_id, platform, external_message_id)
        WHERE external_message_id IS NOT NULL;
    `);
    this.upsertConversationStmt = this.db.prepare(`
      INSERT INTO mh_conversations (
        conversation_id, actor_id, platform, channel_id, title,
        participant_id, participant_name, last_message_at,
        unread_count, last_message_preview, created_at, updated_at
      ) VALUES (
        @conversation_id, @actor_id, @platform, @channel_id, @title,
        @participant_id, @participant_name, @last_message_at,
        @unread_delta, @last_message_preview, @now, @now
      )
      ON CONFLICT(actor_id, conversation_id) DO UPDATE SET
        title = COALESCE(excluded.title, mh_conversations.title),
        participant_id = COALESCE(excluded.participant_id, mh_conversations.participant_id),
        participant_name = COALESCE(excluded.participant_name, mh_conversations.participant_name),
        last_message_at = excluded.last_message_at,
        last_message_preview = excluded.last_message_preview,
        updated_at = excluded.updated_at,
        unread_count = mh_conversations.unread_count + excluded.unread_count
    `);
    this.insertMessageStmt = this.db.prepare(`
      INSERT OR IGNORE INTO mh_messages (
        message_id, actor_id, conversation_id, platform, channel_id,
        direction, sender_id, sender_name, text, created_at,
        reply_to_message_id, external_message_id, meta, seq
      ) VALUES (
        @message_id, @actor_id, @conversation_id, @platform, @channel_id,
        @direction, @sender_id, @sender_name, @text, @created_at,
        @reply_to_message_id, @external_message_id, @meta, @seq
      )
    `);
    this.nextSeqStmt = this.db.prepare(`
      SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq
      FROM mh_messages
      WHERE actor_id = ? AND conversation_id = ?
    `);
  }

  /**
   * 旧库迁移：补 seq 列（会话内单调序号，2026-10-17）。
   * 存量数据按 (actor_id, conversation_id) 分区、以 created_at/rowid 排序回填，
   * 之后所有插入都由 insertMessage 分配。幂等：已迁移的库直接跳过。
   */
  private migrateAddSeqColumn(): void {
    const cols = this.db.prepare(`PRAGMA table_info(mh_messages)`).all() as Array<{ name: string }>;
    if (cols.some((c) => c.name === "seq")) return;
    this.db.exec(`ALTER TABLE mh_messages ADD COLUMN seq INTEGER`);
    this.db.exec(`
      WITH ordered AS (
        SELECT message_id,
               ROW_NUMBER() OVER (
                 PARTITION BY actor_id, conversation_id
                 ORDER BY created_at, rowid
               ) AS rn
        FROM mh_messages
      )
      UPDATE mh_messages
      SET seq = (SELECT rn FROM ordered WHERE ordered.message_id = mh_messages.message_id)
    `);
  }

  /** 关闭底层 SQLite 连接（测试 teardown / 进程优雅退出用）。 */
  close(): void {
    this.db.close();
  }

  upsertConversation(input: ConversationUpsertInput): MessageHubConversation {
    this.upsertConversationStmt.run({
      conversation_id: input.conversationId,
      actor_id: input.actorId,
      platform: input.platform,
      channel_id: input.channelId,
      title: input.title ?? null,
      participant_id: input.participantId ?? null,
      participant_name: input.participantName ?? null,
      last_message_at: input.lastMessageAt,
      unread_delta: input.incrementUnread ? 1 : 0,
      last_message_preview: input.lastMessageText,
      now: new Date().toISOString(),
    });
    return this.getConversation(input.actorId, input.conversationId)!;
  }

  /** @returns true=新插入；false=externalMessageId 命中唯一索引判重跳过 */
  insertMessage(input: MessageInsertInput): boolean {
    // 会话内单调 seq：MAX(seq)+1（better-sqlite3 同步单连接，SELECT→INSERT 之间无并发交错）；
    // 判重跳过时该 seq 未被消费，下次重算无空洞
    const seq = (this.nextSeqStmt.get(input.actorId, input.conversationId) as { next_seq: number }).next_seq;
    const result = this.insertMessageStmt.run({
      message_id: input.messageId,
      actor_id: input.actorId,
      conversation_id: input.conversationId,
      platform: input.platform,
      channel_id: input.channelId,
      direction: input.direction,
      sender_id: input.senderId ?? null,
      sender_name: input.senderName ?? null,
      text: input.text,
      created_at: input.createdAt,
      reply_to_message_id: input.replyToMessageId ?? null,
      external_message_id: input.externalMessageId ?? null,
      meta: toJsonColumn(input.meta),
      seq,
    });
    return result.changes > 0;
  }

  listConversations(
    actorId: string,
    opts?: { platform?: string; limit?: number },
  ): MessageHubConversation[] {
    const limit = Math.max(1, Math.min(200, Math.trunc(opts?.limit ?? 50)));
    const rows = (opts?.platform
      ? this.db.prepare(`
          SELECT * FROM mh_conversations
          WHERE actor_id = ? AND platform = ?
          ORDER BY updated_at DESC LIMIT ?
        `)
      : this.db.prepare(`
          SELECT * FROM mh_conversations
          WHERE actor_id = ?
          ORDER BY updated_at DESC LIMIT ?
        `)
    ).all(...(opts?.platform ? [actorId, opts.platform, limit] : [actorId, limit])) as ConversationRow[];
    return rows.map(rowToConversation);
  }

  getConversation(actorId: string, conversationId: string): MessageHubConversation | null {
    const row = this.db
      .prepare(`SELECT * FROM mh_conversations WHERE actor_id = ? AND conversation_id = ?`)
      .get(actorId, conversationId) as ConversationRow | undefined;
    return row ? rowToConversation(row) : null;
  }

  listMessages(
    actorId: string,
    conversationId: string,
    opts?: { limit?: number; sinceSeq?: number },
  ): MessageHubMessage[] {
    const limit = Math.max(1, Math.min(500, Math.trunc(opts?.limit ?? 50)));
    // sinceSeq 游标（2026-10-17）：只取 seq > sinceSeq 的增量，客户端断线补拉用
    const rows = (opts?.sinceSeq != null
      ? this.db
          .prepare(`
            SELECT * FROM (
              SELECT * FROM mh_messages
              WHERE actor_id = ? AND conversation_id = ? AND seq > ?
              ORDER BY seq DESC LIMIT ?
            ) ORDER BY seq ASC
          `)
          .all(actorId, conversationId, Math.trunc(opts.sinceSeq), limit)
      : this.db
          .prepare(`
            SELECT * FROM (
              SELECT * FROM mh_messages
              WHERE actor_id = ? AND conversation_id = ?
              ORDER BY seq DESC LIMIT ?
            ) ORDER BY seq ASC
          `)
          .all(actorId, conversationId, limit)) as MessageRow[];
    return rows.map(rowToMessage);
  }

  getMessage(actorId: string, messageId: string): MessageHubMessage | null {
    const row = this.db
      .prepare(`SELECT * FROM mh_messages WHERE actor_id = ? AND message_id = ?`)
      .get(actorId, messageId) as MessageRow | undefined;
    return row ? rowToMessage(row) : null;
  }

  getMessageByExternalId(
    actorId: string,
    platform: string,
    externalMessageId: string,
  ): MessageHubMessage | null {
    const row = this.db
      .prepare(`
        SELECT * FROM mh_messages
        WHERE actor_id = ? AND platform = ? AND external_message_id = ?
        LIMIT 1
      `)
      .get(actorId, platform, externalMessageId) as MessageRow | undefined;
    return row ? rowToMessage(row) : null;
  }

  /** LIKE 通配符转义（用户输入的关键词按字面匹配）。 */
  private static escapeLike(raw: string): string {
    return raw.replace(/[\\%_]/g, (ch) => `\\${ch}`);
  }

  /**
   * 关键词检索消息（messages.search 工具用）：LIKE 字面匹配 + 可选平台/起始时间过滤，
   * 时间倒序。direction 不限（查"收到的话"和"让他人办的事"都有用）。
   */
  searchMessages(
    actorId: string,
    opts?: { query?: string; platform?: string; since?: string; limit?: number },
  ): MessageHubMessage[] {
    const limit = Math.max(1, Math.min(50, Math.trunc(opts?.limit ?? 20)));
    const conds = ["actor_id = ?"];
    const args: Array<string | number> = [actorId];
    const query = opts?.query?.trim();
    if (query) {
      conds.push(`text LIKE ? ESCAPE '\\'`);
      args.push(`%${MessageHubSqliteStore.escapeLike(query)}%`);
    }
    if (opts?.platform) {
      conds.push("platform = ?");
      args.push(opts.platform);
    }
    if (opts?.since) {
      conds.push("created_at >= ?");
      args.push(opts.since);
    }
    args.push(limit);
    const rows = this.db
      .prepare(
        `SELECT * FROM mh_messages WHERE ${conds.join(" AND ")} ORDER BY created_at DESC LIMIT ?`,
      )
      .all(...args) as MessageRow[];
    return rows.map(rowToMessage);
  }

  /**
   * 通知捕捉统计（messages.capture_status 工具用）：按 platform 聚合
   * phone_capture 来源的入站消息最近捕获时间与 24h 条数。断流判断的数据源。
   */
  captureStats(
    actorId: string,
  ): Array<{ platform: string; lastInboundAt: string; count24h: number }> {
    const rows = this.db
      .prepare(`
        SELECT platform,
               MAX(created_at) AS last_at,
               COALESCE(SUM(CASE WHEN created_at >= datetime('now', 'localtime', '-1 day') THEN 1 ELSE 0 END), 0) AS c24
        FROM mh_messages
        WHERE actor_id = ?
          AND direction = 'inbound'
          AND meta IS NOT NULL
          AND json_valid(meta)
          AND json_extract(meta, '$.source') = 'phone_capture'
        GROUP BY platform
      `)
      .all(actorId) as Array<{ platform: string; last_at: string; c24: number }>;
    return rows.map((r) => ({
      platform: r.platform,
      lastInboundAt: r.last_at,
      count24h: r.c24,
    }));
  }

  markConversationRead(actorId: string, conversationId: string): boolean {
    const result = this.db
      .prepare(`
        UPDATE mh_conversations
        SET unread_count = 0, updated_at = ?
        WHERE actor_id = ? AND conversation_id = ?
      `)
      .run(new Date().toISOString(), actorId, conversationId);
    return result.changes > 0;
  }

  /** 各平台统计（messages.overview 用）：未读数 / 会话数 / 最近 3 条会话预览。 */
  overviewStats(actorId: string, latestPerPlatform = 3): PlatformStat[] {
    const platforms = this.db
      .prepare(`SELECT DISTINCT platform FROM mh_conversations WHERE actor_id = ?`)
      .all(actorId) as Array<{ platform: string }>;
    const unreadStmt = this.db.prepare(`
      SELECT COALESCE(SUM(unread_count), 0) AS unread, COUNT(*) AS convs
      FROM mh_conversations WHERE actor_id = ? AND platform = ?
    `);
    const latestStmt = this.db.prepare(`
      SELECT * FROM mh_conversations
      WHERE actor_id = ? AND platform = ?
      ORDER BY updated_at DESC LIMIT ?
    `);
    const stats: PlatformStat[] = [];
    for (const { platform } of platforms) {
      const agg = unreadStmt.get(actorId, platform) as { unread: number; convs: number };
      const latestRows = latestStmt.all(actorId, platform, latestPerPlatform) as ConversationRow[];
      stats.push({
        platform,
        unreadCount: agg.unread,
        conversationCount: agg.convs,
        latest: latestRows.map((row) => ({
          conversationId: row.conversation_id,
          title: row.title ?? undefined,
          participantName: row.participant_name ?? undefined,
          preview: row.last_message_preview,
          lastMessageAt: row.last_message_at,
          unreadCount: row.unread_count,
        })),
      });
    }
    return stats;
  }

  /**
   * 全库消息统计（管理概览）：总量、收/发、今日、近 N 天逐日量。
   * created_at 是 ISO 字符串，SQLite 的 date()/datetime() 可直接解析。
   */
  globalStats(days = 14): MessageHubGlobalStats {
    const span = Math.max(1, Math.min(Math.trunc(days), 90));
    const one = <T>(sql: string): T => this.db.prepare(sql).get() as T;
    const conversations = one<{ n: number }>(
      `SELECT COUNT(*) AS n FROM mh_conversations`,
    ).n;
    const messages = one<{ n: number }>(`SELECT COUNT(*) AS n FROM mh_messages`).n;
    const directions = one<{ outbound: number; inbound: number }>(`
      SELECT COALESCE(SUM(direction = 'outbound'), 0) AS outbound,
             COALESCE(SUM(direction = 'inbound'), 0) AS inbound
      FROM mh_messages
    `);
    const today = one<{ n: number }>(
      `SELECT COUNT(*) AS n FROM mh_messages WHERE date(created_at, 'localtime') = date('now', 'localtime')`,
    ).n;
    const rows = this.db
      .prepare(
        `SELECT date(created_at, 'localtime') AS day, COUNT(*) AS n
         FROM mh_messages
         WHERE created_at >= datetime('now', 'localtime', ?)
         GROUP BY day`,
      )
      .all(`-${span - 1} days`) as Array<{ day: string; n: number }>;
    const byDay = new Map(rows.map((r) => [r.day, r.n]));
    const series: Array<{ day: string; count: number }> = [];
    for (let i = span - 1; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86_400_000);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      series.push({ day: key, count: byDay.get(key) ?? 0 });
    }
    return {
      conversations,
      messages,
      outbound: directions.outbound,
      inbound: directions.inbound,
      today,
      series,
    };
  }

  /** 按平台聚合会话/消息量（管理后台站内信页）。 */
  platformStats(): MessageHubPlatformStat[] {
    const rows = this.db
      .prepare(`
        SELECT c.platform AS platform,
               COUNT(DISTINCT c.conversation_id) AS conversations,
               (SELECT COUNT(*) FROM mh_messages m WHERE m.platform = c.platform) AS messages
        FROM mh_conversations c
        GROUP BY c.platform
        ORDER BY messages DESC
      `)
      .all() as Array<{ platform: string; conversations: number; messages: number }>;
    return rows.map((r) => ({
      platform: r.platform,
      conversations: r.conversations,
      messages: r.messages,
    }));
  }

  /** 跨身份的最近消息（管理后台站内信页）。 */
  recentMessages(limit = 30): MessageHubRecentMessage[] {
    const rows = this.db
      .prepare(`
        SELECT message_id, actor_id, platform, conversation_id, direction,
               sender_name, text, created_at
        FROM mh_messages
        ORDER BY created_at DESC
        LIMIT ?
      `)
      .all(Math.max(1, Math.min(Math.trunc(limit), 200))) as Array<{
        message_id: string;
        actor_id: string;
        platform: string;
        conversation_id: string;
        direction: string;
        sender_name: string | null;
        text: string;
        created_at: string;
      }>;
    return rows.map((r) => ({
      messageId: r.message_id,
      actorId: r.actor_id,
      platform: r.platform,
      conversationId: r.conversation_id,
      direction: r.direction,
      senderName: r.sender_name,
      text: r.text,
      createdAt: r.created_at,
    }));
  }

  /**
   * 清理：删除 created_at 早于保留期的消息 + 每会话只留最近 cap 条。
   * SQLite 窗口函数做每会话保留（better-sqlite3 内置现代 SQLite 支持窗口函数）。
   */
  prune(retentionDays?: number, perConversationCap = PRUNE_PER_CONVERSATION_CAP): void {
    const days = Math.max(1, Math.trunc(retentionDays ?? PRUNE_DEFAULT_RETENTION_DAYS));
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
    this.db.prepare(`DELETE FROM mh_messages WHERE created_at < ?`).run(cutoff);
    this.db.prepare(`
      DELETE FROM mh_messages WHERE message_id IN (
        SELECT message_id FROM (
          SELECT message_id,
                 ROW_NUMBER() OVER (PARTITION BY actor_id, conversation_id ORDER BY created_at DESC) AS rn
          FROM mh_messages
        ) WHERE rn > ?
      )
    `).run(perConversationCap);
  }

  /**
   * 旧 JSON 全量导入（一次性迁移）：INSERT OR IGNORE 尊重去重索引。
   * legacy JSON 是 JSON.parse 直接 cast 的，历史上 platform/channelId 未必填时
   * 产生的记录会带 null，撞 NOT NULL 约束会把启动打崩——这里运行时跳过脏记录
   * （及其孤儿消息），只导入可迁移的部分。
   */
  importLegacy(conversations: MessageHubConversation[], messages: MessageHubMessage[]): void {
    const validConversations = conversations.filter(legacyRecordMigratable);
    const conversationIds = new Set(validConversations.map((c) => c.conversationId));
    const validMessages = messages.filter(
      (m) => legacyRecordMigratable(m) && conversationIds.has(m.conversationId),
    );
    const skippedConv = conversations.length - validConversations.length;
    const skippedMsg = messages.length - validMessages.length;
    if (skippedConv > 0 || skippedMsg > 0) {
      console.warn(
        `[message-hub] legacy 迁移跳过脏记录：会话 ${skippedConv} 条、消息 ${skippedMsg} 条（platform/channelId 缺失或所属会话已跳过）`,
      );
    }
    const tx = this.db.transaction(() => {
      for (const c of validConversations) {
        this.upsertConversation({
          actorId: c.actorId,
          conversationId: c.conversationId,
          platform: c.platform,
          channelId: c.channelId,
          title: c.title,
          participantId: c.participantId,
          participantName: c.participantName,
          incrementUnread: false,
          lastMessageText: c.lastMessagePreview,
          lastMessageAt: c.lastMessageAt,
        });
        // 保留原未读数与创建时间（upsert 的 ON CONFLICT 分支会重置预览时间，
        // 这里直接补一条精确 UPDATE 兜底）
        this.db.prepare(`
          UPDATE mh_conversations
          SET unread_count = ?, created_at = ?, updated_at = ?, last_message_at = ?
          WHERE actor_id = ? AND conversation_id = ?
        `).run(c.unreadCount, c.createdAt, c.updatedAt, c.lastMessageAt, c.actorId, c.conversationId);
      }
      for (const m of validMessages) {
        this.insertMessage({
          messageId: m.messageId,
          actorId: m.actorId,
          conversationId: m.conversationId,
          platform: m.platform,
          channelId: m.channelId,
          direction: m.direction,
          senderId: m.senderId,
          senderName: m.senderName,
          text: m.text,
          createdAt: m.createdAt,
          replyToMessageId: m.replyToMessageId,
          externalMessageId: m.externalMessageId,
          meta: m.meta,
        });
      }
    });
    tx();
  }
}
