/**
 * 声纹向量存取（SQLite，better-sqlite3）。
 *
 * 单说话人场景（每 actor 一条声纹），不做 ANN，验证时 cosine 暴力比对。
 * 库文件缺省 data/voiceprint/voiceprint.db（VOICEPRINT_DB_PATH 覆盖），
 * 与语音消息同款的 per-actor 数据目录约定。
 */

import { getDataDir } from "../../config/data-dir.js";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

import Database from "better-sqlite3";
import type { Database as SqliteDatabase } from "better-sqlite3";

export type VoiceprintRecord = {
  actorId: string;
  embedding: Float32Array;
  dims: number;
  sampleCount: number;
  updatedAt: number;
};

export class VoiceprintStore {
  private readonly db: SqliteDatabase;

  constructor(dbPath = process.env.VOICEPRINT_DB_PATH?.trim() || join(getDataDir(), "voiceprint", "voiceprint.db")) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS voiceprints (
        actor_id TEXT PRIMARY KEY,
        embedding BLOB NOT NULL,
        dims INTEGER NOT NULL,
        sample_count INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
  }

  upsert(actorId: string, embedding: Float32Array, sampleCount: number): void {
    const buf = Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
    this.db
      .prepare(
        `INSERT INTO voiceprints (actor_id, embedding, dims, sample_count, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(actor_id) DO UPDATE SET
           embedding = excluded.embedding,
           dims = excluded.dims,
           sample_count = excluded.sample_count,
           updated_at = excluded.updated_at`,
      )
      .run(actorId, buf, embedding.length, sampleCount, Date.now());
  }

  get(actorId: string): VoiceprintRecord | null {
    const row = this.db
      .prepare(`SELECT actor_id, embedding, dims, sample_count, updated_at FROM voiceprints WHERE actor_id = ?`)
      .get(actorId) as
      | { actor_id: string; embedding: Buffer; dims: number; sample_count: number; updated_at: number }
      | undefined;
    if (!row) return null;
    const embedding = new Float32Array(
      row.embedding.buffer.slice(row.embedding.byteOffset, row.embedding.byteOffset + row.embedding.byteLength),
    );
    return {
      actorId: row.actor_id,
      embedding,
      dims: row.dims,
      sampleCount: row.sample_count,
      updatedAt: row.updated_at,
    };
  }

  delete(actorId: string): boolean {
    return this.db.prepare(`DELETE FROM voiceprints WHERE actor_id = ?`).run(actorId).changes > 0;
  }

  /** 调试用：注册人数（不含向量内容） */
  count(): number {
    return (this.db.prepare(`SELECT COUNT(*) AS c FROM voiceprints`).get() as { c: number }).c;
  }

  close(): void {
    this.db.close();
  }
}
