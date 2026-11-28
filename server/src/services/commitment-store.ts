/**
 * commitments 写入方（2026-11-12 根修「提醒承诺在对话面失忆」）。
 *
 * 事故链（生产实证）：提醒只落在 schedule-task-service，滚动摘要显式丢弃
 * 提醒轮，【待办与承诺】块的权威源 commitments 表却**全库无写入方**——
 * 526 行全是测试种子，真实 actor 0 行，prompt 块恒空。本模块补上写路径：
 * 日程/提醒任务创建 → 落一行 active 承诺；完成/取消/删除 → 状态收口。
 *
 * 设计：
 *   - 表结构与存量 schema 逐列一致（CREATE TABLE IF NOT EXISTS，老库零迁移）；
 *   - id 确定性派生（sched_<taskId>）：重复创建/重放天然幂等；
 *   - 全部 best-effort：待办写入失败不阻塞提醒主链路，warn 留痕；
 *   - 写后失效 commitment-prompt-provider 的 30s 读缓存（同进程立即可见）。
 */

import { openAgenticSqlite } from "../agentic-memory/sqlite-store.js";
import { invalidateCommitmentCache } from "./commitment-prompt-provider.js";

export type ScheduleCommitmentInput = {
  actorId: string;
  taskId: string;
  /** 待办文案（给模型看的语义，如「提醒用户回家」） */
  text: string;
  /** ISO 截止/触发时刻 */
  deadline?: string;
  category?: string;
};

export type FollowUpCommitmentInput = {
  id: string;
  actorId: string;
  event: string;
  eventAt: number;
  followAt: number;
  sensitivity: "normal" | "private";
  sourceRef: string;
  category: string;
  confidence: number;
};

function commitmentIdForTask(taskId: string): string {
  return `sched_${taskId}`;
}

/**
 * 建表（与生产库 2026-10 存量 schema 逐列一致；老库命中 IF NOT EXISTS 零变化）。
 *
 * `kind`（2026-11-25 §3.5 承诺跟进）：区分这一行是**提醒承诺**（'schedule'，历史行
 * 为 NULL）还是**跟进事件**（'follow_up'，见 services/followup-store.ts）。老库没有
 * 这一列，PRAGMA 查到缺就补——只加可空列，存量行与既有读路径零影响。
 * 导出给跟进侧复用：一张表的 schema 只有一处定义，不各写一份 CREATE。
 */
export function ensureCommitmentTable(db: ReturnType<typeof openAgenticSqlite>): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS commitments (
      id TEXT PRIMARY KEY,
      actor_id TEXT NOT NULL,
      text TEXT NOT NULL,
      committed_by TEXT NOT NULL,
      status TEXT NOT NULL,
      deadline TEXT,
      dependencies TEXT NOT NULL DEFAULT '[]',
      escalation_policy TEXT NOT NULL,
      evidence_ledger_ids TEXT NOT NULL DEFAULT '[]',
      source TEXT NOT NULL,
      confidence REAL,
      reminder_sent_at TEXT,
      escalation_count INTEGER NOT NULL DEFAULT 0,
      last_escalated_at TEXT,
      dependency_blocked INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      fulfilled_at TEXT,
      cancelled_at TEXT,
      broken_at TEXT,
      notes TEXT
    , reminder_tiers_sent TEXT NOT NULL DEFAULT '[]', superseded_at TEXT, category TEXT, confirm_reminder_sent_at TEXT, contact TEXT, kind TEXT)
  `);
  const cols = db.prepare(`PRAGMA table_info(commitments)`).all() as Array<{ name?: string }>;
  if (!cols.some((c) => c?.name === "kind")) {
    db.exec(`ALTER TABLE commitments ADD COLUMN kind TEXT`);
  }
}

export function insertFollowUpCommitment(
  dbPath: string | undefined,
  rec: FollowUpCommitmentInput,
): boolean {
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
    if (info.changes > 0) invalidateCommitmentCache(rec.actorId);
    return info.changes > 0;
  } finally {
    db.close();
  }
}

export function markFollowUpCommitmentSubmitted(
  dbPath: string | undefined,
  id: string,
  at: number,
): void {
  const db = openAgenticSqlite(dbPath);
  try {
    ensureCommitmentTable(db);
    const iso = new Date(at).toISOString();
    const info = db
      .prepare(
        `UPDATE commitments SET reminder_sent_at = ?, updated_at = ?
         WHERE id = ? AND kind = 'follow_up'`,
      )
      .run(iso, iso, id);
    if (info.changes > 0) {
      const row = db.prepare(`SELECT actor_id FROM commitments WHERE id = ?`).get(id) as
        | { actor_id?: string }
        | undefined;
      if (row?.actor_id) invalidateCommitmentCache(row.actor_id);
    }
  } finally {
    db.close();
  }
}

export function settleFollowUpCommitment(
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
    if (info.changes > 0) {
      const row = db.prepare(`SELECT actor_id FROM commitments WHERE id = ?`).get(id) as
        | { actor_id?: string }
        | undefined;
      if (row?.actor_id) invalidateCommitmentCache(row.actor_id);
    }
    return info.changes > 0;
  } finally {
    db.close();
  }
}

/** 任务创建/更新为 active → upsert 一行 active 承诺（幂等）。 */
export function upsertScheduleCommitment(input: ScheduleCommitmentInput): void {
  const text = input.text.trim();
  if (!input.actorId || !input.taskId || !text) return;
  try {
    const db = openAgenticSqlite();
    try {
      ensureCommitmentTable(db);
      const now = new Date().toISOString();
      db.prepare(
        `INSERT INTO commitments (
           id, actor_id, text, committed_by, status, deadline, dependencies,
           escalation_policy, evidence_ledger_ids, source, created_at, updated_at, category, kind
         ) VALUES (?, ?, ?, 'agent', 'active', ?, '[]', '{}', '[]', 'schedule', ?, ?, ?, 'schedule')
         ON CONFLICT(id) DO UPDATE SET
           text = excluded.text,
           deadline = excluded.deadline,
           status = 'active',
           updated_at = excluded.updated_at,
           fulfilled_at = NULL,
           cancelled_at = NULL`,
      ).run(
        commitmentIdForTask(input.taskId),
        input.actorId,
        text.slice(0, 200),
        input.deadline ?? null,
        now,
        now,
        input.category ?? null,
      );
      invalidateCommitmentCache(input.actorId);
    } finally {
      db.close();
    }
  } catch (err) {
    console.warn(`[commitments] 提醒承诺写入失败（不影响提醒主链路）: ${err}`);
  }
}

/**
 * 任务终态收口：fulfilled（已触发完成）/ cancelled（用户取消或任务删除）。
 * 只收口 active 行；行不存在（如老任务）静默跳过。
 */
export function settleScheduleCommitment(
  actorId: string,
  taskId: string,
  outcome: "fulfilled" | "cancelled",
): void {
  if (!actorId || !taskId) return;
  try {
    const db = openAgenticSqlite();
    try {
      ensureCommitmentTable(db);
      const now = new Date().toISOString();
      const info = db
        .prepare(
          `UPDATE commitments
           SET status = ?, updated_at = ?, fulfilled_at = ?, cancelled_at = ?
           WHERE id = ? AND status = 'active'`,
        )
        .run(
          outcome,
          now,
          outcome === "fulfilled" ? now : null,
          outcome === "cancelled" ? now : null,
          commitmentIdForTask(taskId),
        );
      if (info.changes > 0) invalidateCommitmentCache(actorId);
    } finally {
      db.close();
    }
  } catch (err) {
    console.warn(`[commitments] 提醒承诺状态收口失败（不影响提醒主链路）: ${err}`);
  }
}
