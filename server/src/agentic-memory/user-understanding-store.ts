/**
 * 用户理解档案（User Understanding Store）——agent 对用户理解的结构化沉淀。
 *
 * 设计立场（2026-09-05 修正）：记忆的最小有价值单元不是「原子事实」而是
 * 「agent 对对话的理解」。用户说"我的老婆是刘浩存"——刘浩存是明星，这是
 * 粉丝式/玩笑式表达；把它归一成 `配偶=刘浩存` 的字段事实并以最高权威注入，
 * 等于把一个语境性表达错编码成字面假命题。正确的存储单元是：
 *
 *   { topic: "老婆",
 *     note: "用户半开玩笑地自称'老婆'是明星刘浩存——粉丝式称呼，并非真实关系",
 *     kind: "fandom" }
 *
 * 运行语义：
 *   - 同一 topic 的新理解生效时，旧理解进入「演变历史」（superseded 链），
 *     不删除——旧对话是真实发生的事，可追溯、可引用（"你上次还说是景甜"）；
 *     任意时刻 getActiveUnderstandings 只返回每个 topic 的当前理解；
 *   - 回答侧（注入块）以当前理解为准，并按 kind 决定回应方式：
 *     joke/fandom/figurative 不当作真实事实转述；
 *   - 理解是「修订」而非「证伪」：不做跨存储抹除级联，矛盾由注入层的
 *     权威块 + 演变历史消解。
 *
 * 隐私闭环：purgeActor 供 memory-clear-service 级联调用。
 */

import type { Database as SqliteDatabase } from "better-sqlite3";

import { isUserUnderstandingEnabled } from "./env.js";
import { openAgenticSqlite } from "./sqlite-store.js";

/** 理解的性质标注（决定回答时的转述方式） */
export type UnderstandingKind =
  | "literal" // 字面陈述（我叫X/我住在X）
  | "joke" // 玩笑/调侃
  | "fandom" // 粉丝式称呼（对公众人物用亲属称谓等）
  | "figurative" // 比喻/夸张
  | "preference" // 偏好表达
  | "correction" // 对既往理解的更正/改口
  | "other";

export const UNDERSTANDING_KINDS: readonly UnderstandingKind[] = [
  "literal",
  "joke",
  "fandom",
  "figurative",
  "preference",
  "correction",
  "other",
];

export function normalizeUnderstandingKind(raw: unknown): UnderstandingKind {
  return typeof raw === "string" && (UNDERSTANDING_KINDS as readonly string[]).includes(raw)
    ? (raw as UnderstandingKind)
    : "other";
}

export interface UnderstandingNote {
  id: string;
  actorId: string;
  /** 话题词（用户原话中的核心称谓/主题，如「老婆」「工作」「居住地」） */
  topic: string;
  /** 理解句：第三人称、自包含、带语境与性质判断 */
  note: string;
  kind: UnderstandingKind;
  sourceRef: string | null;
  confidence: number | null;
  createdAt: string;
  lastConfirmedAt: string;
}

interface UnderstandingRow {
  id: string;
  actor_id: string;
  topic: string;
  note: string;
  kind: string;
  source_ref: string | null;
  confidence: number | null;
  status: string;
  created_at: string;
  last_confirmed_at: string;
  superseded_at: string | null;
  superseded_by: string | null;
}

export interface ApplyUnderstandingInput {
  actorId: string;
  topic: string;
  note: string;
  kind?: UnderstandingKind;
  sourceRef?: string | null;
  confidence?: number | null;
}

export interface ApplyUnderstandingResult {
  /** true = 理解发生修订（旧理解进入历史）；false = 同义理解确认/touch */
  changed: boolean;
  note: UnderstandingNote;
  /** 被修订的旧理解（changed=true 时非空，最新在前） */
  previous: UnderstandingNote[];
}

function toNote(row: UnderstandingRow): UnderstandingNote {
  return {
    id: row.id,
    actorId: row.actor_id,
    topic: row.topic,
    note: row.note,
    kind: normalizeUnderstandingKind(row.kind),
    sourceRef: row.source_ref,
    confidence: row.confidence,
    createdAt: row.created_at,
    lastConfirmedAt: row.last_confirmed_at,
  };
}

function clampConfidence(raw: number | null | undefined): number | null {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return null;
  return Math.max(0, Math.min(1, raw));
}

function normalizeTopic(topic: string): string {
  return topic.trim().replace(/[「」"'（）()。．.！!？?~～\s]+/g, "");
}

function normalizeNote(note: string): string {
  return note.trim().replace(/\s+/g, " ");
}

let uidSeq = 0;
function nextNoteId(): string {
  uidSeq = (uidSeq + 1) % 100000;
  return `und_${Date.now().toString(36)}_${uidSeq.toString(36)}`;
}

export class UserUnderstandingStore {
  private readonly db: SqliteDatabase;

  constructor(db?: SqliteDatabase) {
    this.db = db ?? openAgenticSqlite();
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS user_understanding (
        id TEXT PRIMARY KEY,
        actor_id TEXT NOT NULL,
        topic TEXT NOT NULL,
        note TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'other',
        source_ref TEXT,
        confidence REAL,
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL,
        last_confirmed_at TEXT NOT NULL,
        superseded_at TEXT,
        superseded_by TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_user_understanding_actor_active
        ON user_understanding(actor_id, topic, status);
    `);
  }

  close(): void {
    this.db.close();
  }

  /**
   * 主题级事务 upsert（当前理解权威）：
   *   - 同 topic 当前理解与新理解相同 → touch（更新确认时间），changed=false；
   *   - 否则旧理解入历史 + 新理解生效（同一事务）。
   * topic/note 规范化后为空或超长返回 null（不入档，走普通记忆路径）。
   */
  applyUnderstanding(input: ApplyUnderstandingInput): ApplyUnderstandingResult | null {
    const actorId = input.actorId?.trim();
    const topic = normalizeTopic(input.topic ?? "");
    const note = normalizeNote(input.note ?? "");
    if (!actorId || !topic || topic.length > 24 || !note || note.length > 200) return null;
    const kind = normalizeUnderstandingKind(input.kind);

    const now = new Date().toISOString();
    const run = this.db.transaction((): ApplyUnderstandingResult => {
      const actives = this.db
        .prepare(
          `SELECT * FROM user_understanding
           WHERE actor_id = ? AND topic = ? AND status = 'active'
           ORDER BY created_at ASC`,
        )
        .all(actorId, topic) as UnderstandingRow[];

      const same = actives.find((r) => r.note === note);
      if (same) {
        this.db
          .prepare(
            `UPDATE user_understanding SET last_confirmed_at = ?,
               confidence = COALESCE(?, confidence)
             WHERE id = ?`,
          )
          .run(now, clampConfidence(input.confidence), same.id);
        return {
          changed: false,
          note: toNote({ ...same, last_confirmed_at: now }),
          previous: [],
        };
      }

      const id = nextNoteId();
      this.db
        .prepare(
          `INSERT INTO user_understanding
             (id, actor_id, topic, note, kind, source_ref, confidence,
              status, created_at, last_confirmed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
        )
        .run(
          id,
          actorId,
          topic,
          note,
          kind,
          input.sourceRef ?? null,
          clampConfidence(input.confidence),
          now,
          now,
        );
      for (const old of actives) {
        this.db
          .prepare(
            `UPDATE user_understanding SET status = 'superseded', superseded_at = ?, superseded_by = ?
             WHERE id = ? AND status = 'active'`,
          )
          .run(now, id, old.id);
      }
      const inserted = this.db
        .prepare(`SELECT * FROM user_understanding WHERE id = ?`)
        .get(id) as UnderstandingRow;
      return { changed: true, note: toNote(inserted), previous: actives.map(toNote).reverse() };
    });
    return run();
  }

  getActiveUnderstandings(actorId: string): UnderstandingNote[] {
    if (!actorId) return [];
    const rows = this.db
      .prepare(
        `SELECT * FROM user_understanding
         WHERE actor_id = ? AND status = 'active'
         ORDER BY last_confirmed_at DESC`,
      )
      .all(actorId) as UnderstandingRow[];
    return rows.map(toNote);
  }

  /**
   * 问句直接寻址：userText 含某理解的话题词（"我老婆是谁"→topic「老婆」）时
   * 返回对应当前理解，供注入块标记"本轮提问相关，基于此回答"。
   */
  matchTopicsInText(actorId: string, text: string): UnderstandingNote[] {
    const t = text?.trim();
    if (!t) return [];
    return this.getActiveUnderstandings(actorId).filter((n) => {
      const topic = normalizeTopic(n.topic);
      return topic.length >= 1 && t.includes(topic);
    });
  }

  /** 某当前理解的演变历史（沿 superseded_by 链回溯，最新在前，limit 条） */
  getHistoryFor(actorId: string, noteId: string, limit = 2): UnderstandingNote[] {
    const out: UnderstandingNote[] = [];
    let cursor: string | null = noteId;
    for (let i = 0; i < limit; i++) {
      const row = this.db
        .prepare(
          `SELECT * FROM user_understanding
           WHERE actor_id = ? AND status = 'superseded' AND superseded_by = ?
           ORDER BY superseded_at DESC LIMIT 1`,
        )
        .get(actorId, cursor) as UnderstandingRow | undefined;
      if (!row) break;
      out.push(toNote(row));
      cursor = row.id;
    }
    return out;
  }

  /**
   * 理解档案块渲染（注入侧直接使用；空返回 null 零注入）。
   * 按性质标注回应的指令写在块头；本轮提问命中的主题带寻址标记；
   * 有修订史的理解附「理解演变」（仅供追溯）。
   */
  renderForPrompt(actorId: string, groundedTopics?: Set<string>): string | null {
    const notes = this.getActiveUnderstandings(actorId);
    if (notes.length === 0) return null;
    const lines = notes.slice(0, 12).map((n) => {
      const confirmedAt = n.lastConfirmedAt.slice(5, 10).replace("-", "/");
      const grounded = groundedTopics?.has(normalizeTopic(n.topic))
        ? " ← 本轮提问相关，基于此理解回答"
        : "";
      const history = this.getHistoryFor(actorId, n.id, 1);
      const historyLine =
        history.length > 0
          ? `\n  理解演变：此前理解「${history[0]!.note}」（${history[0]!.lastConfirmedAt.slice(5, 10).replace("-", "/")}）`
          : "";
      return `- 关于「${n.topic}」：${n.note}（${confirmedAt} 确认）${grounded}${historyLine}`;
    });
    return [
      // 块头禁用「我」开头（人称视角根因修复 2026-10-11）：同 prompt 里
      // 用户档案块可能含第一人称用户原话，块头「我」=agent 会造成两套
      // 代词坐标系并存，模型转述时主语翻转（「你光知道我在兴义」实盘案例）
      "【Agent 对用户的理解】",
      "（以下是你在过往对话中对用户形成的理解记录，含语境与语气判断。被问及用户的",
      "偏好、关系等话题时，以本块为当前理解的依据，并按性质回应：玩笑/",
      "粉丝式称呼/比喻不要当作真实事实转述。「理解演变」仅供追溯，不代表现状。",
      "仅当用户最新消息明确表达新理解时以最新消息为准——此时系统会自动登记修订）",
      ...lines,
    ].join("\n");
  }

  /** actor 级清理（memory-clear-service 级联调用，隐私闭环） */
  purgeActor(actorId: string): number {
    if (!actorId) return 0;
    return this.db
      .prepare(`DELETE FROM user_understanding WHERE actor_id = ?`)
      .run(actorId).changes;
  }

  stats(): { total: number; active: number; superseded: number } {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active
         FROM user_understanding`,
      )
      .get() as { total: number; active: number | null };
    const total = row.total;
    const active = row.active ?? 0;
    return { total, active, superseded: total - active };
  }
}

export function createUserUnderstandingStoreIfEnabled(db?: SqliteDatabase): UserUnderstandingStore | null {
  if (!isUserUnderstandingEnabled()) return null;
  return new UserUnderstandingStore(db);
}
