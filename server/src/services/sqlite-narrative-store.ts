import { getDataDir } from "../config/data-dir.js";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

import Database from "better-sqlite3";
import type {
  Database as SqliteDatabase,
  Statement as SqliteStatement,
} from "better-sqlite3";

export type NarrativePointPayload = {
  actorId: string;
  text: string;
  source: string;
  chunkId: string;
  createdAt: string;
  /** Mem0 记忆图作用域元数据（source 等） */
  scope?: string;
  sourceId?: string;
  lifecycle?: string;
};

/**
 * SQLite 叙事向量段落存储（原 QdrantNarrativeStore 的本地替代，2026-09-21）。
 *
 * - 持久化事实源：BM25 词法索引是进程内的、重启即丢；首次召回时从本表回灌重建，
 *   向量召回同样直接查本表——叙事记忆自此跨重启存活，且零外部组件。
 * - 余弦相似度为 JS 暴力计算：个人 agent 量级（每 actor 数千 chunk）下 <5ms，
 *   无需 HNSW；数据量进入十万级再评估外置向量库。
 * - ENV: `AGENT_NARRATIVE_DB_PATH`（缺省 `<cwd>/data/narrative-memory.sqlite`）。
 */
export class SqliteNarrativeStore {
  readonly db: SqliteDatabase;
  readonly dbPath: string;

  private readonly upsertStmt: SqliteStatement;
  private readonly scrollByActorStmt: SqliteStatement;
  private readonly vectorsByActorStmt: SqliteStatement;

  constructor(opts?: { dbPath?: string }) {
    this.dbPath =
      opts?.dbPath?.trim() ||
      process.env.AGENT_NARRATIVE_DB_PATH?.trim() ||
      join(getDataDir(), "narrative-memory.sqlite");
    mkdirSync(dirname(this.dbPath), { recursive: true });
    this.db = new Database(this.dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS narrative_points (
        id TEXT PRIMARY KEY,
        actor_id TEXT NOT NULL,
        chunk_id TEXT NOT NULL,
        text TEXT NOT NULL,
        source TEXT,
        scope TEXT,
        source_id TEXT,
        lifecycle TEXT,
        created_at TEXT NOT NULL,
        dim INTEGER NOT NULL,
        vector BLOB NOT NULL
      )
    `);
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS idx_narrative_points_actor ON narrative_points(actor_id)",
    );
    this.upsertStmt = this.db.prepare(`
      INSERT OR REPLACE INTO narrative_points
        (id, actor_id, chunk_id, text, source, scope, source_id, lifecycle, created_at, dim, vector)
      VALUES
        (@id, @actorId, @chunkId, @text, @source, @scope, @sourceId, @lifecycle, @createdAt, @dim, @vector)
    `);
    this.scrollByActorStmt = this.db.prepare(
      `SELECT id, actor_id, chunk_id, text, source, scope, source_id, lifecycle, created_at
       FROM narrative_points WHERE actor_id = ?
       ORDER BY created_at ASC, id ASC LIMIT ?`,
    );
    this.vectorsByActorStmt = this.db.prepare(
      `SELECT id, dim, vector FROM narrative_points WHERE actor_id = ?`,
    );
  }

  /** 与原 QdrantNarrativeStore 保持同形接口；本地 SQLite 恒可用 */
  isEnabled(): boolean {
    return true;
  }

  /** 兼容旧接口：SQLite 无需按维度预建 collection，no-op */
  async ensureCollection(_dim: number): Promise<void> {}

  async upsertPoint(
    vec: number[],
    id: string | number,
    payload: NarrativePointPayload,
  ): Promise<void> {
    const f32 = Float32Array.from(vec);
    this.upsertStmt.run({
      id: String(id),
      actorId: payload.actorId,
      chunkId: payload.chunkId,
      text: payload.text,
      source: payload.source ?? null,
      scope: payload.scope ?? null,
      sourceId: payload.sourceId ?? null,
      lifecycle: payload.lifecycle ?? null,
      createdAt: payload.createdAt,
      dim: f32.length,
      vector: Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength),
    });
  }

  async search(
    vec: number[],
    actorId: string,
    limit: number,
  ): Promise<Array<{ id: string | number; score: number; payload: NarrativePointPayload }>> {
    if (limit <= 0) return [];
    const q = Float32Array.from(vec);
    const qNorm = normOf(q);
    if (qNorm === 0) return [];

    const rows = this.vectorsByActorStmt.all(actorId) as Array<{
      id: string;
      dim: number;
      vector: Buffer;
    }>;
    const scored: Array<{ id: string; score: number }> = [];
    for (const row of rows) {
      // 维度不匹配（换 embedding 模型后的旧数据）：跳过而不是误算
      if (row.dim !== q.length) continue;
      const f32 = new Float32Array(
        row.vector.buffer,
        row.vector.byteOffset,
        row.vector.byteLength / 4,
      );
      const rNorm = normOf(f32);
      if (rNorm === 0) continue;
      let dot = 0;
      for (let i = 0; i < q.length; i++) dot += q[i]! * f32[i]!;
      scored.push({ id: row.id, score: dot / (qNorm * rNorm) });
    }
    scored.sort((a, b) => b.score - a.score);

    const metaStmt = this.db.prepare(
      `SELECT actor_id, chunk_id, text, source, scope, source_id, lifecycle, created_at
       FROM narrative_points WHERE id = ?`,
    );
    const out: Array<{ id: string | number; score: number; payload: NarrativePointPayload }> = [];
    for (const hit of scored.slice(0, limit)) {
      const meta = metaStmt.get(hit.id) as
        | {
            actor_id: string;
            chunk_id: string;
            text: string;
            source: string | null;
            scope: string | null;
            source_id: string | null;
            lifecycle: string | null;
            created_at: string;
          }
        | undefined;
      if (!meta) continue;
      out.push({
        id: hit.id,
        score: hit.score,
        payload: {
          actorId: meta.actor_id,
          text: meta.text,
          source: meta.source ?? "",
          chunkId: meta.chunk_id,
          createdAt: meta.created_at,
          ...(meta.scope ? { scope: meta.scope } : {}),
          ...(meta.source_id ? { sourceId: meta.source_id } : {}),
          ...(meta.lifecycle ? { lifecycle: meta.lifecycle } : {}),
        },
      });
    }
    return out;
  }

  /**
   * 按 actor 拉取全部点（payload 含原文）。
   * 用途：BM25/文本缓存是进程内的，进程重启即丢；本表是唯一事实源，
   * 首次召回时据此回灌重建词法索引。
   */
  async scrollByActor(
    actorId: string,
    limit: number,
  ): Promise<Array<{ id: string | number; payload: NarrativePointPayload }>> {
    const rows = this.scrollByActorStmt.all(actorId, limit) as Array<{
      id: string;
      actor_id: string;
      chunk_id: string;
      text: string;
      source: string | null;
      scope: string | null;
      source_id: string | null;
      lifecycle: string | null;
      created_at: string;
    }>;
    return rows.map((row) => ({
      id: row.id,
      payload: {
        actorId: row.actor_id,
        text: row.text,
        source: row.source ?? "",
        chunkId: row.chunk_id,
        createdAt: row.created_at,
        ...(row.scope ? { scope: row.scope } : {}),
        ...(row.source_id ? { sourceId: row.source_id } : {}),
        ...(row.lifecycle ? { lifecycle: row.lifecycle } : {}),
      },
    }));
  }
}

function normOf(v: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < v.length; i++) sum += v[i]! * v[i]!;
  return Math.sqrt(sum);
}
