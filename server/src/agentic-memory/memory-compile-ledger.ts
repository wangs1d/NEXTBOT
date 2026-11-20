import type { Database as SqliteDatabase } from "better-sqlite3";
import { openAgenticSqlite } from "./sqlite-store.js";
import {
  compileOpHash,
  compileRunInputHash,
  normalizeCompileDay,
  type CompileOp,
  type CompileStage,
} from "./memory-compile-keys.js";

export type { CompileOp, CompileStage } from "./memory-compile-keys.js";
export { compileOpHash, compileRunInputHash, normalizeCompileDay } from "./memory-compile-keys.js";

export type CompileRunResult = {
  runId: number;
  skipped: boolean;
  applied: number;
  duplicated: number;
};

const DEFAULT_RETENTION_DAYS = 120;

export class MemoryCompileLedger {
  private readonly db: SqliteDatabase;
  private readonly ownsDb: boolean;

  constructor(db?: SqliteDatabase) {
    this.db = db ?? openAgenticSqlite();
    this.ownsDb = !db;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memory_compile_ops (
        actor_id TEXT NOT NULL,
        day TEXT NOT NULL,
        stage TEXT NOT NULL,
        op_hash TEXT NOT NULL,
        op_type TEXT NOT NULL,
        target TEXT NOT NULL,
        value TEXT,
        evidence_json TEXT,
        event_time TEXT,
        applied_at TEXT NOT NULL,
        PRIMARY KEY (actor_id, day, stage, op_hash)
      );
      CREATE INDEX IF NOT EXISTS idx_memory_compile_ops_day
        ON memory_compile_ops(day);

      CREATE TABLE IF NOT EXISTS memory_compile_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        actor_id TEXT NOT NULL,
        day TEXT NOT NULL,
        stage TEXT NOT NULL,
        input_hash TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'running',
        applied INTEGER NOT NULL DEFAULT 0,
        duplicated INTEGER NOT NULL DEFAULT 0,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        UNIQUE(actor_id, day, stage, input_hash)
      );
      CREATE INDEX IF NOT EXISTS idx_memory_compile_runs_actor_day
        ON memory_compile_runs(actor_id, day);

      CREATE TABLE IF NOT EXISTS memory_compile_watermark (
        actor_id TEXT PRIMARY KEY,
        last_day TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  }

  close(): void {
    if (this.ownsDb) this.db.close();
  }

  /** 该 op 是否已应用（同步、只读）。 */
  hasOp(op: CompileOp): boolean {
    const hash = compileOpHash(op);
    const row = this.db
      .prepare(
        `SELECT 1 AS hit FROM memory_compile_ops
         WHERE actor_id = ? AND day = ? AND stage = ? AND op_hash = ?`,
      )
      .get(op.actorId, normalizeCompileDay(op.day), op.stage, hash);
    return !!row;
  }

  /**
   * 应用成功后登记 op；已存在返回 false（调用方据此跳过落库）。
   * 不做自动重试：失败路径根本不调用这里。
   */
  markOp(op: CompileOp): boolean {
    const hash = compileOpHash(op);
    const info = this.db
      .prepare(
        `INSERT OR IGNORE INTO memory_compile_ops
           (actor_id, day, stage, op_hash, op_type, target, value,
            evidence_json, event_time, applied_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        op.actorId,
        normalizeCompileDay(op.day),
        op.stage,
        hash,
        op.opType,
        op.target,
        op.value ?? null,
        op.evidence?.length ? JSON.stringify(op.evidence) : null,
        op.eventTime ?? null,
        new Date().toISOString(),
      );
    return info.changes > 0;
  }

  /**
   * 同一 actor/day/stage/input 已完整跑完时返回上次结果（跳过整段），
   * 否则创建 running 记录。input 用本批输入摘要（transcript hash）。
   */
  beginRun(input: {
    actorId: string;
    day: string;
    stage: CompileStage;
    inputHash: string;
  }): { runId: number; replay: boolean } {
    const day = normalizeCompileDay(input.day);
    const existing = this.db
      .prepare(
        `SELECT id, status, applied, duplicated FROM memory_compile_runs
         WHERE actor_id = ? AND day = ? AND stage = ? AND input_hash = ?`,
      )
      .get(input.actorId, day, input.stage, input.inputHash) as
      | { id: number; status: string; applied: number; duplicated: number }
      | undefined;
    if (existing?.status === "completed") {
      return { runId: existing.id, replay: true };
    }
    if (existing) {
      this.db
        .prepare(
          `UPDATE memory_compile_runs SET status = 'running', started_at = ?, finished_at = NULL
           WHERE id = ?`,
        )
        .run(new Date().toISOString(), existing.id);
      return { runId: existing.id, replay: false };
    }
    const info = this.db
      .prepare(
        `INSERT INTO memory_compile_runs
           (actor_id, day, stage, input_hash, status, started_at)
         VALUES (?, ?, ?, ?, 'running', ?)`,
      )
      .run(input.actorId, day, input.stage, input.inputHash, new Date().toISOString());
    return { runId: Number(info.lastInsertRowid), replay: false };
  }

  finishRun(runId: number, counts: { applied: number; duplicated: number }): void {
    this.db
      .prepare(
        `UPDATE memory_compile_runs
         SET status = 'completed', applied = ?, duplicated = ?, finished_at = ?
         WHERE id = ?`,
      )
      .run(counts.applied, counts.duplicated, new Date().toISOString(), runId);
  }

  /** 可回放水位：该 actor 已完成编译的最大事件日。 */
  getWatermark(actorId: string): string | null {
    const row = this.db
      .prepare(`SELECT last_day FROM memory_compile_watermark WHERE actor_id = ?`)
      .get(actorId) as { last_day: string } | undefined;
    return row?.last_day ?? null;
  }

  /** 只前进不后退；返回是否推进。 */
  advanceWatermark(actorId: string, day: string): boolean {
    const normalized = normalizeCompileDay(day);
    const current = this.getWatermark(actorId);
    if (current && current >= normalized) return false;
    this.db
      .prepare(
        `INSERT INTO memory_compile_watermark (actor_id, last_day, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(actor_id) DO UPDATE SET
           last_day = excluded.last_day,
           updated_at = excluded.updated_at`,
      )
      .run(actorId, normalized, new Date().toISOString());
    return true;
  }

  /** 已应用 op 的日期范围（报告 / 运维排查用）。 */
  summarize(actorId: string, day: string): {
    appliedOps: number;
    byStage: Record<string, number>;
  } {
    const rows = this.db
      .prepare(
        `SELECT stage, COUNT(*) AS n FROM memory_compile_ops
         WHERE actor_id = ? AND day = ?
         GROUP BY stage`,
      )
      .all(actorId, normalizeCompileDay(day)) as Array<{ stage: string; n: number }>;
    const byStage: Record<string, number> = {};
    let appliedOps = 0;
    for (const row of rows) {
      byStage[row.stage] = row.n;
      appliedOps += row.n;
    }
    return { appliedOps, byStage };
  }

  /** 裁剪过期 op（只删账本记录，不动记忆内容）。 */
  prune(retentionDays = DEFAULT_RETENTION_DAYS): number {
    const cutoff = new Date(Date.now() - retentionDays * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const info = this.db
      .prepare(`DELETE FROM memory_compile_ops WHERE day < ?`)
      .run(cutoff);
    return info.changes;
  }
}

let shared: MemoryCompileLedger | null = null;

export function getMemoryCompileLedger(): MemoryCompileLedger {
  if (!shared) shared = new MemoryCompileLedger();
  return shared;
}

export function resetMemoryCompileLedgerForTest(): void {
  shared?.close();
  shared = null;
}
