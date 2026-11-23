/**
 * 承诺跟进的落库层（PRD §3.5，2026-11-25）。
 *
 * **不新开表、不新开库**：跟进事件复用 `agentic_memory.db#commitments`（方案 C
 * 承诺草稿板，见 services/commitment-store.ts 的写路径），用 `kind='follow_up'`
 * 与提醒承诺区分：
 *   - `text`     跟进事项（「跟进：下午面试」）
 *   - `deadline` `followAt`（第一次合适开口的时刻）
 *   - `category` 事件类别（interview/exam/medical…）——「别跟进这个」按类抑制 30 天
 *   - `notes`    JSON：`{ event, eventAt, sensitivity, sourceRef, followAt, submittedAt }`
 *   - `reminder_sent_at` 已提交跟进提案的时刻（同一事件最多跟进 1 次的硬闸）
 *   - `status`   active（待跟进）→ fulfilled（已跟进）/ cancelled（用户说别再提 / 过期）
 *
 * 幂等：`id` 由 `actorId|category|事件时刻(10 分钟粒度)` 派生——同一件事说两遍（「我明天面试」
 * 「明天有个面试」）落同一行，天然只跟进一次。
 */

import { createHash } from "node:crypto";

import { openAgenticSqlite } from "../agentic-memory/sqlite-store.js";
import { ensureCommitmentTable } from "./commitment-store.js";

export type FollowUpSensitivity = "normal" | "private";
export type FollowUpStatus = "active" | "fulfilled" | "cancelled";

export type FollowUpRecord = {
  id: string;
  actorId: string;
  /** 事件本身（第三人称短句，如「下午面试」） */
  event: string;
  /** 事件发生时刻（ms） */
  eventAt: number;
  /** 第一次合适开口的时刻（ms，事件之后的下班/明日预览 slot） */
  followAt: number;
  sensitivity: FollowUpSensitivity;
  /** 抽取来源（会话 id / 归档批次），供「为什么跟进这件事」回溯 */
  sourceRef: string;
  /** 事件类别：30 天同类抑制的匹配键 */
  category: string;
  status: FollowUpStatus;
  /** 已提交跟进提案的时刻（ms）；undefined = 还没提交过 */
  submittedAt?: number;
  confidence: number;
};

type Row = {
  id: string;
  actor_id: string;
  text: string;
  status: string;
  deadline: string | null;
  category: string | null;
  source: string;
  confidence: number | null;
  reminder_sent_at: string | null;
  notes: string | null;
};

/** 事件指纹 → 稳定 id：actor + 类别 + 事件时刻（10 分钟粒度），不含措辞 */
export function followUpIdFor(input: {
  actorId: string;
  category: string;
  eventAt: number;
}): string {
  // 按 10 分钟向下取整：同一件事在两轮抽取里被写成 14:00 / 14:05 也算一件事
  // （抽取侧的 eventAt 已截到分钟，这里只兜住秒级与相邻分钟的抖动）
  const bucket = Math.floor(input.eventAt / (10 * 60_000)) * (10 * 60_000);
  const raw = `${input.actorId}|${input.category}|${bucket}`;
  return `fu_${createHash("sha1").update(raw).digest("hex").slice(0, 16)}`;
}

function toRecord(row: Row): FollowUpRecord | null {
  let notes: Record<string, unknown> = {};
  try {
    notes = row.notes ? (JSON.parse(row.notes) as Record<string, unknown>) : {};
  } catch {
    notes = {};
  }
  const followAtMs = Number(notes.followAt);
  const eventAtMs = Number(notes.eventAt);
  const event = typeof notes.event === "string" ? notes.event : (row.text ?? "").replace(/^跟进：/, "");
  if (!event || !Number.isFinite(followAtMs) || !Number.isFinite(eventAtMs)) return null;
  const submittedAt = typeof row.reminder_sent_at === "string" ? Date.parse(row.reminder_sent_at) : NaN;
  return {
    id: row.id,
    actorId: row.actor_id,
    event,
    eventAt: eventAtMs,
    followAt: followAtMs,
    sensitivity: notes.sensitivity === "private" ? "private" : "normal",
    sourceRef: typeof notes.sourceRef === "string" ? notes.sourceRef : row.source,
    category: row.category ?? (typeof notes.category === "string" ? notes.category : "other"),
    status:
      row.status === "fulfilled" || row.status === "cancelled"
        ? row.status
        : "active",
    ...(Number.isFinite(submittedAt) ? { submittedAt } : {}),
    confidence: typeof row.confidence === "number" ? row.confidence : 0.6,
  };
}

/** 落一行跟进事件（幂等：同 id 只刷新措辞与置信度，绝不复活已取消的行）。 */
export function insertFollowUp(dbPath: string | undefined, rec: FollowUpRecord): boolean {
  const db = openAgenticSqlite(dbPath);
  try {
    ensureCommitmentTable(db);
    const now = new Date().toISOString();
    const notes = JSON.stringify({
      event: rec.event,
      eventAt: rec.eventAt,
      followAt: rec.followAt,
      sensitivity: rec.sensitivity,
      sourceRef: rec.sourceRef,
      category: rec.category,
    });
    const info = db
      .prepare(
        `INSERT INTO commitments (
           id, actor_id, text, committed_by, status, deadline, dependencies,
           escalation_policy, evidence_ledger_ids, source, confidence,
           created_at, updated_at, category, kind, notes
         ) VALUES (?, ?, ?, 'user', 'active', ?, '[]', '{}', '[]', 'follow_up', ?, ?, ?, ?, 'follow_up', ?)
         ON CONFLICT(id) DO UPDATE SET
           text = excluded.text,
           confidence = excluded.confidence,
           updated_at = excluded.updated_at`,
      )
      .run(
        rec.id,
        rec.actorId,
        `跟进：${rec.event}`.slice(0, 200),
        new Date(rec.followAt).toISOString(),
        rec.confidence,
        now,
        now,
        rec.category,
        notes,
      );
    return info.changes > 0;
  } finally {
    db.close();
  }
}

function query(dbPath: string | undefined, sql: string, ...args: unknown[]): FollowUpRecord[] {
  const db = openAgenticSqlite(dbPath);
  try {
    ensureCommitmentTable(db);
    const rows = db.prepare(sql).all(...(args as never[])) as Row[];
    return rows.map(toRecord).filter((r): r is FollowUpRecord => r !== null);
  } finally {
    db.close();
  }
}

export function getFollowUp(dbPath: string | undefined, id: string): FollowUpRecord | null {
  return query(dbPath, `SELECT * FROM commitments WHERE id = ? AND kind = 'follow_up' LIMIT 1`, id)[0] ?? null;
}

/** 某 actor 的跟进事件（默认只取待跟进的） */
export function listFollowUps(
  dbPath: string | undefined,
  actorId: string,
  opts?: { status?: FollowUpStatus | "any"; limit?: number },
): FollowUpRecord[] {
  const status = opts?.status ?? "active";
  const limit = opts?.limit ?? 50;
  return status === "any"
    ? query(
        dbPath,
        `SELECT * FROM commitments WHERE actor_id = ? AND kind = 'follow_up'
         ORDER BY deadline ASC LIMIT ?`,
        actorId,
        limit,
      )
    : query(
        dbPath,
        `SELECT * FROM commitments WHERE actor_id = ? AND kind = 'follow_up' AND status = ?
         ORDER BY deadline ASC LIMIT ?`,
        actorId,
        status,
        limit,
      );
}

/** 某类事件当前挂着（未跟进、未取消）的跟进事件——同类抑制要顺手收掉它们 */
export function listFollowUpsByCategory(
  dbPath: string | undefined,
  actorId: string,
  category: string,
): FollowUpRecord[] {
  return query(
    dbPath,
    `SELECT * FROM commitments WHERE actor_id = ? AND kind = 'follow_up' AND category = ?
     ORDER BY deadline ASC LIMIT ?`,
    actorId,
    category,
    20,
  );
}

/** 提交过跟进提案（写 reminder_sent_at）——「同一事件最多跟进 1 次」的落库依据 */
export function markFollowUpSubmitted(dbPath: string | undefined, id: string, at: number): void {
  const db = openAgenticSqlite(dbPath);
  try {
    ensureCommitmentTable(db);
    db.prepare(
      `UPDATE commitments SET reminder_sent_at = ?, updated_at = ?
       WHERE id = ? AND kind = 'follow_up'`,
    ).run(new Date(at).toISOString(), new Date(at).toISOString(), id);
  } finally {
    db.close();
  }
}

/** 状态收口：fulfilled=已经跟进过，cancelled=用户别再提/过期作废 */
export function settleFollowUp(
  dbPath: string | undefined,
  id: string,
  outcome: "fulfilled" | "cancelled",
  at: number,
): boolean {
  const db = openAgenticSqlite(dbPath);
  try {
    ensureCommitmentTable(db);
    const iso = new Date(at).toISOString();
    const info = db
      .prepare(
        `UPDATE commitments
         SET status = ?, updated_at = ?, fulfilled_at = ?, cancelled_at = ?
         WHERE id = ? AND kind = 'follow_up' AND status = 'active'`,
      )
      .run(
        outcome,
        iso,
        outcome === "fulfilled" ? iso : null,
        outcome === "cancelled" ? iso : null,
        id,
      );
    return info.changes > 0;
  } finally {
    db.close();
  }
}
