import type { Database as SqliteDatabase } from "better-sqlite3";

import { openAgenticSqlite } from "./sqlite-store.js";

export type MemoryLifecycleOpStatus = "pending" | "running" | "completed" | "failed";

export interface MemoryLifecycleOpRow {
  opId: string;
  actorId: string;
  intent: string;
  status: MemoryLifecycleOpStatus;
  request: unknown;
  result: unknown;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

interface OpRow {
  op_id: string;
  actor_id: string;
  intent: string;
  status: string;
  request_json: string;
  result_json: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

interface ReceiptRow {
  op_id: string;
  action_id: string;
  status: "completed" | "failed";
  result_json: string | null;
  error: string | null;
}

function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function toOp(row: OpRow): MemoryLifecycleOpRow {
  return {
    opId: row.op_id,
    actorId: row.actor_id,
    intent: row.intent,
    status: row.status as MemoryLifecycleOpStatus,
    request: parseJson<unknown>(row.request_json, null),
    result: parseJson<unknown>(row.result_json, null),
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class MemoryLifecycleOpStore {
  private readonly db: SqliteDatabase;

  constructor(db?: SqliteDatabase) {
    this.db = db ?? openAgenticSqlite();
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memory_lifecycle_ops (
        op_id TEXT PRIMARY KEY,
        actor_id TEXT NOT NULL,
        intent TEXT NOT NULL,
        status TEXT NOT NULL,
        request_json TEXT NOT NULL,
        result_json TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_memory_lifecycle_ops_status
        ON memory_lifecycle_ops(status, updated_at);
      CREATE TABLE IF NOT EXISTS memory_lifecycle_receipts (
        op_id TEXT NOT NULL,
        action_id TEXT NOT NULL,
        status TEXT NOT NULL,
        result_json TEXT,
        error TEXT,
        completed_at TEXT NOT NULL,
        PRIMARY KEY (op_id, action_id),
        FOREIGN KEY (op_id) REFERENCES memory_lifecycle_ops(op_id) ON DELETE CASCADE
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  enqueue(input: {
    opId: string;
    actorId: string;
    intent: string;
    request: unknown;
    now?: string;
  }): MemoryLifecycleOpRow {
    const now = input.now ?? new Date().toISOString();
    this.db.prepare(`
      INSERT INTO memory_lifecycle_ops
        (op_id, actor_id, intent, status, request_json, created_at, updated_at)
      VALUES (?, ?, ?, 'pending', ?, ?, ?)
      ON CONFLICT(op_id) DO NOTHING
    `).run(input.opId, input.actorId, input.intent, JSON.stringify(input.request), now, now);
    return this.get(input.opId)!;
  }

  get(opId: string): MemoryLifecycleOpRow | null {
    const row = this.db.prepare(`SELECT * FROM memory_lifecycle_ops WHERE op_id = ?`).get(opId) as
      | OpRow
      | undefined;
    return row ? toOp(row) : null;
  }

  markRunning(opId: string, now = new Date().toISOString()): void {
    this.db.prepare(`
      UPDATE memory_lifecycle_ops SET status = 'running', error = NULL, updated_at = ? WHERE op_id = ?
    `).run(now, opId);
  }

  completeAction(input: {
    opId: string;
    actionId: string;
    result: unknown;
    now?: string;
  }): void {
    const now = input.now ?? new Date().toISOString();
    this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO memory_lifecycle_receipts
          (op_id, action_id, status, result_json, completed_at)
        VALUES (?, ?, 'completed', ?, ?)
        ON CONFLICT(op_id, action_id) DO UPDATE SET
          status = 'completed', result_json = excluded.result_json, error = NULL,
          completed_at = excluded.completed_at
      `).run(input.opId, input.actionId, JSON.stringify(input.result ?? null), now);
      this.db.prepare(`UPDATE memory_lifecycle_ops SET updated_at = ? WHERE op_id = ?`).run(now, input.opId);
    })();
  }

  failAction(input: {
    opId: string;
    actionId: string;
    error: string;
    now?: string;
  }): void {
    const now = input.now ?? new Date().toISOString();
    this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO memory_lifecycle_receipts
          (op_id, action_id, status, error, completed_at)
        VALUES (?, ?, 'failed', ?, ?)
        ON CONFLICT(op_id, action_id) DO UPDATE SET
          status = 'failed', result_json = NULL, error = excluded.error,
          completed_at = excluded.completed_at
      `).run(input.opId, input.actionId, input.error, now);
      this.db.prepare(`
        UPDATE memory_lifecycle_ops SET status = 'failed', error = ?, updated_at = ? WHERE op_id = ?
      `).run(input.error, now, input.opId);
    })();
  }

  complete(opId: string, result: unknown, now = new Date().toISOString()): void {
    this.db.prepare(`
      UPDATE memory_lifecycle_ops
      SET status = 'completed', result_json = ?, error = NULL, updated_at = ?
      WHERE op_id = ?
    `).run(JSON.stringify(result ?? null), now, opId);
  }

  completedActionIds(opId: string): Set<string> {
    const rows = this.db.prepare(`
      SELECT action_id FROM memory_lifecycle_receipts WHERE op_id = ? AND status = 'completed'
    `).all(opId) as Array<{ action_id: string }>;
    return new Set(rows.map((row) => row.action_id));
  }

  actionResults(opId: string): Record<string, unknown> {
    const rows = this.db.prepare(`
      SELECT action_id, result_json FROM memory_lifecycle_receipts
      WHERE op_id = ? AND status = 'completed'
    `).all(opId) as Array<{ action_id: string; result_json: string | null }>;
    return Object.fromEntries(
      rows.map((row) => [row.action_id, parseJson<unknown>(row.result_json, null)]),
    );
  }

  retryable(limit = 100): MemoryLifecycleOpRow[] {
    const rows = this.db.prepare(`
      SELECT * FROM memory_lifecycle_ops
      WHERE status IN ('pending', 'failed')
      ORDER BY updated_at ASC LIMIT ?
    `).all(limit) as OpRow[];
    return rows.map(toOp);
  }
}

let singleton: MemoryLifecycleOpStore | null = null;

export function getMemoryLifecycleOpStore(): MemoryLifecycleOpStore {
  singleton ??= new MemoryLifecycleOpStore();
  return singleton;
}

export function setMemoryLifecycleOpStoreForTests(store: MemoryLifecycleOpStore | null): void {
  singleton = store;
}
