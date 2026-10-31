/**
 * 事件记忆层（L0）存储：memory_events + FTS5 词面索引。
 *
 * 一个写入口（轮结束）、一个检索口（recallEvents）。表只追加不设上限——
 * 上限会制造新的「查不到」。结构化列管时间/实体/类型/状态过滤，FTS 管
 * 专名与型号的词面命中；语义向量作为后续补充路，不在这里阻塞写入。
 */

import type { Database as SqliteDatabase } from "better-sqlite3";

import { tokenize } from "../services/memory-record-utils.js";
import { actorIdVariants } from "./actor-key.js";
import { isEventMemoryEnabled, getEventSummaryMaxChars } from "./env.js";
import {
  buildTurnEvent,
  summarizeEventText,
  type EventToolTrace,
  type MemoryEventRecord,
  type TurnEventInput,
} from "./event-builder.js";
import { openAgenticSqlite, toJsonColumn, fromJsonColumn } from "./sqlite-store.js";

export type RecallEventsQuery = {
  actorId: string;
  /** 起始时间（ISO，含） */
  from?: string;
  /** 结束时间（ISO，含） */
  to?: string;
  entities?: string[];
  kinds?: string[];
  statuses?: string[];
  /** 词面检索文本（FTS5；空则纯结构化过滤） */
  query?: string;
  limit?: number;
};

export type RecalledEvent = MemoryEventRecord & { score: number };

type EventRow = {
  id: string;
  actor_id: string;
  session_id: string | null;
  message_id: string | null;
  event_time: string;
  recorded_at: string;
  kind: string;
  status: string;
  user_text: string | null;
  answer_text: string | null;
  entities_json: string | null;
  payload_json: string | null;
  refs_json: string | null;
  context: string;
};

function rowToRecord(row: EventRow): MemoryEventRecord {
  return {
    id: row.id,
    actorId: row.actor_id,
    sessionId: row.session_id,
    messageId: row.message_id,
    eventTime: row.event_time,
    recordedAt: row.recorded_at,
    kind: row.kind,
    status: row.status as MemoryEventRecord["status"],
    userText: row.user_text ?? "",
    answerText: row.answer_text ?? "",
    entities: fromJsonColumn<string[]>(row.entities_json, []),
    payload: fromJsonColumn<Record<string, unknown>>(row.payload_json, {}),
    refs: fromJsonColumn<Record<string, unknown>>(row.refs_json, {}),
    context: row.context === "notes" ? "notes" : "main",
  };
}

function toMatchExpression(tokens: string[], op: "AND" | "OR"): string {
  return tokens.map((t) => `"${t}"`).join(` ${op} `);
}

/** 含虚词/代词的二元组（在的 / 那个 / 怎么）没有检索价值，只会把闲聊词命中放大。 */
const STOP_GRAM_RE = /[的了是在我你他她它这那个些吗呢啊吧就都也还又很不会要想说问帮给让把和与么什怎样哪上下时]/;

function contentTokens(tokens: string[]): string[] {
  const filtered = tokens.filter((t) => !STOP_GRAM_RE.test(t));
  return filtered.length > 0 ? filtered : tokens;
}

export class EventMemoryStore {
  private readonly db: SqliteDatabase;
  private readonly ftsUnavailable: boolean;

  constructor(db?: SqliteDatabase) {
    this.db = db ?? openAgenticSqlite();
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memory_events (
        id            TEXT PRIMARY KEY,
        actor_id      TEXT NOT NULL,
        session_id    TEXT,
        message_id    TEXT,
        event_time    TEXT NOT NULL,
        recorded_at   TEXT NOT NULL,
        kind          TEXT NOT NULL,
        status        TEXT NOT NULL,
        user_text     TEXT,
        answer_text   TEXT,
        entities_json TEXT,
        payload_json  TEXT,
        refs_json     TEXT,
        context       TEXT NOT NULL DEFAULT 'main'
      );
      CREATE INDEX IF NOT EXISTS idx_evt_actor_time ON memory_events(actor_id, event_time);
      CREATE INDEX IF NOT EXISTS idx_evt_actor_kind ON memory_events(actor_id, kind, event_time);
    `);
    try {
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS memory_events_fts USING fts5(
          tokens,
          id UNINDEXED,
          actor_id UNINDEXED,
          event_time UNINDEXED,
          kind UNINDEXED,
          status UNINDEXED
        );
      `);
      this.ftsUnavailable = false;
    } catch (err) {
      console.warn(
        "[event-memory] FTS5 初始化失败（词面路降级为空）:",
        err instanceof Error ? err.message : err,
      );
      this.ftsUnavailable = true;
    }
  }

  /** 幂等写入：同 id（messageId 键）覆盖，WAL 定稿替换时可重复落同一条。 */
  upsertEvent(record: MemoryEventRecord): void {
    const write = this.db.transaction((evt: MemoryEventRecord) => {
      this.db
        .prepare(
          `INSERT INTO memory_events
             (id, actor_id, session_id, message_id, event_time, recorded_at, kind, status,
              user_text, answer_text, entities_json, payload_json, refs_json, context)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             session_id = excluded.session_id,
             message_id = excluded.message_id,
             event_time = excluded.event_time,
             recorded_at = excluded.recorded_at,
             kind = excluded.kind,
             status = excluded.status,
             user_text = excluded.user_text,
             answer_text = excluded.answer_text,
             entities_json = excluded.entities_json,
             payload_json = excluded.payload_json,
             refs_json = excluded.refs_json,
             context = excluded.context`,
        )
        .run(
          evt.id,
          evt.actorId,
          evt.sessionId,
          evt.messageId,
          evt.eventTime,
          evt.recordedAt,
          evt.kind,
          evt.status,
          evt.userText,
          evt.answerText,
          toJsonColumn(evt.entities),
          toJsonColumn(evt.payload),
          toJsonColumn(evt.refs),
          evt.context,
        );
      if (!this.ftsUnavailable) {
        this.db.prepare(`DELETE FROM memory_events_fts WHERE id = ?`).run(evt.id);
        const tokens = tokenize(
          `${evt.kind} ${evt.status} ${evt.entities.join(" ")} ${evt.userText} ${evt.answerText}`,
        );
        if (tokens.length > 0) {
          this.db
            .prepare(
              `INSERT INTO memory_events_fts (tokens, id, actor_id, event_time, kind, status)
               VALUES (?, ?, ?, ?, ?, ?)`,
            )
            .run(tokens.join(" "), evt.id, evt.actorId, evt.eventTime, evt.kind, evt.status);
        }
      }
    });
    write(record);
  }

  /** 轮结束写事件：构造 + 幂等落库，返回落库记录。 */
  recordTurn(input: TurnEventInput): MemoryEventRecord {
    const record = buildTurnEvent(input);
    this.upsertEvent(record);
    return record;
  }

  /** WAL 定稿文本替换后同步事件摘要（按 actor + messageId 定位）。 */
  updateAnswerByMessageId(actorId: string, messageId: string, answerText: string): boolean {
    const row = this.db
      .prepare(`SELECT id FROM memory_events WHERE actor_id = ? AND message_id = ? LIMIT 1`)
      .get(actorId, messageId) as { id: string } | undefined;
    if (!row) return false;
    const text = summarizeEventText(answerText, getEventSummaryMaxChars());
    this.db.prepare(`UPDATE memory_events SET answer_text = ? WHERE id = ?`).run(text, row.id);
    if (!this.ftsUnavailable) {
      const fresh = this.db
        .prepare(`SELECT kind, status, user_text, entities_json FROM memory_events WHERE id = ?`)
        .get(row.id) as
        | { kind: string; status: string; user_text: string | null; entities_json: string | null }
        | undefined;
      this.db.prepare(`DELETE FROM memory_events_fts WHERE id = ?`).run(row.id);
      if (fresh) {
        const entities = fromJsonColumn<string[]>(fresh.entities_json, []);
        const tokens = tokenize(
          `${fresh.kind} ${fresh.status} ${entities.join(" ")} ${fresh.user_text ?? ""} ${text}`,
        );
        if (tokens.length > 0) {
          this.db
            .prepare(
              `INSERT INTO memory_events_fts (tokens, id, actor_id, event_time, kind, status)
               SELECT ?, id, actor_id, event_time, kind, status FROM memory_events WHERE id = ?`,
            )
            .run(tokens.join(" "), row.id);
        }
      }
    }
    return true;
  }

  /**
   * 唯一检索口：结构化（actor/时间/类型/状态/实体）+ 词面（FTS）融合。
   * 返回按 event_time 倒序（词面命中按 bm25 排序后再取头部，同分按时间）。
   */
  recallEvents(query: RecallEventsQuery): RecalledEvent[] {
    const limit = Math.max(1, Math.min(query.limit ?? 20, 200));
    const variants = actorIdVariants(query.actorId);
    if (variants.length === 0) return [];

    const wheres: string[] = [`actor_id IN (${variants.map(() => "?").join(",")})`];
    const params: Array<string | number> = [...variants];
    if (query.from) {
      wheres.push(`event_time >= ?`);
      params.push(query.from);
    }
    if (query.to) {
      wheres.push(`event_time <= ?`);
      params.push(query.to);
    }
    if (query.kinds?.length) {
      wheres.push(`kind IN (${query.kinds.map(() => "?").join(",")})`);
      params.push(...query.kinds);
    }
    if (query.statuses?.length) {
      wheres.push(`status IN (${query.statuses.map(() => "?").join(",")})`);
      params.push(...query.statuses);
    }
    const entities = (query.entities ?? []).filter(Boolean);
    for (const entity of entities) {
      wheres.push(
        `EXISTS (SELECT 1 FROM json_each(memory_events.entities_json) WHERE value LIKE ?)`,
      );
      params.push(`%${entity}%`);
    }

    const text = query.query?.trim();
    if (text) {
      const hits = this.searchText(query.actorId, text, limit);
      if (hits.length === 0) return [];
      const ids = hits.map((h) => h.id);
      const rows = this.db
        .prepare(
          `SELECT * FROM memory_events WHERE id IN (${ids.map(() => "?").join(",")}) AND ${wheres.join(" AND ")}`,
        )
        .all(...ids, ...params) as EventRow[];
      const byId = new Map(rows.map((row) => [row.id, row]));
      return ids
        .map((id) => byId.get(id))
        .filter((row): row is EventRow => Boolean(row))
        .slice(0, limit)
        .map((row) => ({ ...rowToRecord(row), score: 1 }));
    }

    const rows = this.db
      .prepare(
        `SELECT * FROM memory_events WHERE ${wheres.join(" AND ")} ORDER BY event_time DESC LIMIT ?`,
      )
      .all(...params, limit) as EventRow[];
    return rows.map((row) => ({ ...rowToRecord(row), score: 1 }));
  }

  /** 词面检索：AND 精确优先；全落空时 OR + bm25，且只保留命中 ≥2 个词的条目。 */
  private searchText(actorId: string, text: string, limit: number): Array<{ id: string }> {
    if (this.ftsUnavailable) return [];
    const tokens = contentTokens(tokenize(text));
    if (tokens.length === 0) return [];
    const variants = actorIdVariants(actorId);
    if (variants.length === 0) return [];
    const actorClause = `actor_id IN (${variants.map(() => "?").join(",")})`;
    const runAnd = (): Array<{ id: string }> =>
      this.db
        .prepare(
          `SELECT id FROM memory_events_fts
           WHERE memory_events_fts MATCH ? AND ${actorClause}
           ORDER BY bm25(memory_events_fts) ASC LIMIT ?`,
        )
        .all(toMatchExpression(tokens, "AND"), ...variants, limit) as Array<{ id: string }>;
    // OR 兜底必须限词数：闲聊问句的二元组会命中几乎所有文本，不带门槛等于瞎给
    const runOr = (): Array<{ id: string }> => {
      if (tokens.length < 2) return [];
      const minHits = Math.min(3, Math.max(2, Math.ceil(tokens.length / 4)));
      const rows = this.db
        .prepare(
          `SELECT id, tokens FROM memory_events_fts
           WHERE memory_events_fts MATCH ? AND ${actorClause}
           ORDER BY bm25(memory_events_fts) ASC LIMIT ?`,
        )
        .all(toMatchExpression(tokens, "OR"), ...variants, limit * 3) as Array<{
        id: string;
        tokens: string;
      }>;
      return rows
        .filter((row) => {
          const indexed = new Set(row.tokens.split(" "));
          return tokens.filter((t) => indexed.has(t)).length >= minHits;
        })
        .slice(0, limit)
        .map((row) => ({ id: row.id }));
    };
    try {
      const andRows = runAnd();
      if (andRows.length > 0) return andRows;
      return runOr();
    } catch (err) {
      console.warn("[event-memory] FTS 检索失败（忽略）:", err instanceof Error ? err.message : err);
      return [];
    }
  }

  stats(): { events: number; ftsRows: number; ftsUnavailable: boolean } {
    const events = Number(
      (this.db.prepare(`SELECT count(*) AS n FROM memory_events`).get() as { n: number }).n ?? 0,
    );
    let ftsRows = 0;
    if (!this.ftsUnavailable) {
      try {
        ftsRows = Number(
          (this.db.prepare(`SELECT count(*) AS n FROM memory_events_fts`).get() as { n: number }).n ?? 0,
        );
      } catch {
        ftsRows = 0;
      }
    }
    return { events, ftsRows, ftsUnavailable: this.ftsUnavailable };
  }

  purgeActor(actorId: string): number {
    const variants = actorIdVariants(actorId);
    if (variants.length === 0) return 0;
    const ids = this.db
      .prepare(`SELECT id FROM memory_events WHERE actor_id IN (${variants.map(() => "?").join(",")})`)
      .all(...variants) as Array<{ id: string }>;
    const transaction = this.db.transaction(() => {
      if (!this.ftsUnavailable) {
        for (const { id } of ids) {
          this.db.prepare(`DELETE FROM memory_events_fts WHERE id = ?`).run(id);
        }
      }
      return this.db
        .prepare(`DELETE FROM memory_events WHERE actor_id IN (${variants.map(() => "?").join(",")})`)
        .run(...variants).changes;
    });
    return transaction();
  }

  close(): void {
    this.db.close();
  }
}

let singleton: EventMemoryStore | null = null;
let initFailed = false;

export function getEventMemoryStore(): EventMemoryStore | null {
  if (singleton) return singleton;
  if (initFailed) return null;
  try {
    singleton = new EventMemoryStore();
    return singleton;
  } catch (err) {
    initFailed = true;
    console.warn(
      "[event-memory] 存储初始化失败（事件层关闭，不影响回复）:",
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

/** 仅供测试：重置单例。 */
export function resetEventMemoryStoreForTest(): void {
  try {
    singleton?.close();
  } catch {
    /* 已关闭 */
  }
  singleton = null;
  initFailed = false;
}

/**
 * 轮结束写事件（唯一入口）：开关关闭时不写；任何异常只记日志，
 * 绝不影响回复与 WAL。返回落库事件（供 LTM 派生条目记录来源）。
 */
export function recordTurnEventSafely(input: TurnEventInput): MemoryEventRecord | null {
  if (!isEventMemoryEnabled()) return null;
  try {
    return getEventMemoryStore()?.recordTurn(input) ?? null;
  } catch (err) {
    console.warn(
      "[event-memory] 事件写入失败（忽略）:",
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

/** 出口定稿文本（卡片附加/协议标记剥离后）回写事件摘要；失败静默。 */
export function updateEventAnswerSafely(actorId: string, messageId: string, answerText: string): void {
  if (!isEventMemoryEnabled() || !messageId.trim()) return;
  try {
    getEventMemoryStore()?.updateAnswerByMessageId(actorId, messageId, answerText);
  } catch (err) {
    console.warn(
      "[event-memory] 事件定稿回写失败（忽略）:",
      err instanceof Error ? err.message : err,
    );
  }
}

export type { EventToolTrace, MemoryEventRecord, TurnEventInput };
