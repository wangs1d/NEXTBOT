/**
 * 认知图 SQLite 行级持久化（P1-9）。
 *
 * 此前 HumanLikeMemoryService 每次持久化都 writeJsonAtomic 全量重写
 * human-memory.json——节点数上万后，每次 ingest/召回触碰（lastAccessedAt、
 * accessCount 更新都会 schedulePersist）都伴随全文件序列化 + fsync，成为
 * 记忆子系统的规模天花板。
 *
 * 本模块把 store 的五个集合（nodes/edges/versions/communities/domains）
 * 存为 SQLite 行，持久化时做 hash-diff：只写变更行、删消失行——高频小改动
 * 从 O(全文件) 降到 O(脏行)。内存结构与读写逻辑完全不变，仅替换持久化层。
 *
 * 迁移：SQLite 为空且同目录 .json 存在时自动种子导入（JSON 保留作备份不删除）。
 * 回退：AGENT_HUMAN_MEMORY_STORE=json 恢复旧的文件持久化。
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

import Database, { type Database as SqliteDatabase, type Statement } from "better-sqlite3";

import { getDataDir } from "../config/data-dir.js";

/**
 * 认知图 SQLite 文件路径。nodes/turns/jobs 必须落在同一个库：
 * 长期记忆（hm_nodes）是唯一真相源，L0 原始轮次（hm_turns）与抽取
 * outbox（hm_memory_jobs）与它同库才能保证固化状态一致。
 */
export function resolveMemoryDbPath(jsonPath?: string): string {
  const base =
    jsonPath ?? process.env.AGENT_HUMAN_MEMORY_FILE?.trim() ?? join(getDataDir(), "human-memory.json");
  return base.endsWith(".json") ? `${base.slice(0, -5)}.sqlite` : `${base}.sqlite`;
}

export interface GraphCollections {
  version: number;
  domains: Record<string, unknown>;
  nodes: Record<string, unknown>;
  edges: Record<string, unknown>;
  versions: Record<string, unknown>;
  communities: Record<string, unknown>;
}

type CollectionName = "domains" | "nodes" | "edges" | "versions" | "communities";
const COLLECTIONS: CollectionName[] = ["domains", "nodes", "edges", "versions", "communities"];

function jsonHash(value: unknown): string {
  return createHash("sha1").update(JSON.stringify(value)).digest("hex");
}

export class GraphSqlitePersistence {
  private readonly db: SqliteDatabase;
  private readonly jsonPath: string;
  private hashes = new Map<string, string>();

  constructor(jsonPath: string) {
    this.jsonPath = jsonPath;
    const dbPath = resolveMemoryDbPath(jsonPath);
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    for (const c of COLLECTIONS) {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS hm_${c} (
          id TEXT PRIMARY KEY,
          hash TEXT NOT NULL,
          json TEXT NOT NULL
        );
      `);
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS hm_meta (
        key TEXT PRIMARY KEY,
        value TEXT
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  setHashes(hashes: Map<string, string>): void {
    this.hashes = hashes;
  }

  /**
   * 加载：SQLite 有数据直接重建；为空且存在旧 JSON 时自动种子迁移。
   * 返回集合数据与行 hash 表（供后续 diff）。两者皆空返回 null data。
   */
  async load(): Promise<{ data: Partial<GraphCollections> | null; hashes: Map<string, string> }> {
    const out: Partial<GraphCollections> = {};
    let total = 0;
    for (const c of COLLECTIONS) {
      const rows = this.db.prepare(`SELECT id, json FROM hm_${c}`).all() as Array<{
        id: string;
        json: string;
      }>;
      const record: Record<string, unknown> = {};
      for (const row of rows) {
        try {
          record[row.id] = JSON.parse(row.json);
        } catch {
          /* 单行损坏跳过 */
        }
      }
      out[c] = record;
      total += rows.length;
    }
    const metaRow = this.db.prepare(`SELECT value FROM hm_meta WHERE key = 'version'`).get() as
      | { value: string | null }
      | undefined;
    out.version = metaRow?.value ? Number(metaRow.value) || 0 : 0;

    if (total === 0) {
      // 空库：尝试从旧 JSON 迁移种子
      const migrated = await this.seedFromJson();
      if (migrated) return this.load();
      return { data: null, hashes: this.hashes };
    }

    this.rebuildHashes(out as GraphCollections);
    return { data: out, hashes: this.hashes };
  }

  private async seedFromJson(): Promise<boolean> {
    try {
      const raw = await readFile(this.jsonPath, "utf8");
      const parsed = JSON.parse(raw) as Partial<GraphCollections>;
      if (!parsed || typeof parsed !== "object") return false;
      const seeded: GraphCollections = {
        version: typeof parsed.version === "number" ? parsed.version : 0,
        domains: parsed.domains ?? {},
        nodes: parsed.nodes ?? {},
        edges: parsed.edges ?? {},
        versions: parsed.versions ?? {},
        communities: parsed.communities ?? {},
      };
      this.save(seeded);
      this.db
        .prepare(`INSERT OR REPLACE INTO hm_meta(key, value) VALUES ('jsonMigratedAt', ?)`)
        .run(new Date().toISOString());
      console.info(
        `[graph-sqlite] 已从 ${this.jsonPath} 迁移种子：` +
          `nodes=${Object.keys(seeded.nodes).length} edges=${Object.keys(seeded.edges).length}`,
      );
      return true;
    } catch {
      return false; // JSON 不存在/损坏：全新库
    }
  }

  private rebuildHashes(collections: GraphCollections): void {
    this.hashes = new Map();
    for (const c of COLLECTIONS) {
      for (const [id, value] of Object.entries(collections[c])) {
        this.hashes.set(`${c}:${id}`, jsonHash(value));
      }
    }
  }

  private upsertStmts = new Map<string, Statement>();
  private removeStmts = new Map<string, Statement>();

  private upsertStmt(collection: CollectionName): Statement {
    let stmt = this.upsertStmts.get(collection);
    if (!stmt) {
      stmt = this.db.prepare(
        `INSERT OR REPLACE INTO hm_${collection}(id, hash, json) VALUES (?, ?, ?)`,
      );
      this.upsertStmts.set(collection, stmt);
    }
    return stmt;
  }

  private removeStmt(collection: CollectionName): Statement {
    let stmt = this.removeStmts.get(collection);
    if (!stmt) {
      stmt = this.db.prepare(`DELETE FROM hm_${collection} WHERE id = ?`);
      this.removeStmts.set(collection, stmt);
    }
    return stmt;
  }

  /** hash-diff 持久化：只写变更行、删消失行（同步 API，WAL 下毫秒级） */
  save(collections: GraphCollections): void {
    for (const c of COLLECTIONS) {
      const entries = Object.entries(collections[c] ?? {});
      const seen = new Set<string>();
      for (const [id, value] of entries) {
        seen.add(id);
        const key = `${c}:${id}`;
        const hash = jsonHash(value);
        if (this.hashes.get(key) === hash) continue; // 未变更行零写放大
        this.upsertStmt(c).run(id, hash, JSON.stringify(value));
        this.hashes.set(key, hash);
      }
      // 该集合中消失的 id → 删行
      for (const [key, hash] of this.hashes) {
        if (!key.startsWith(`${c}:`)) continue;
        const id = key.slice(c.length + 1);
        if (!seen.has(id)) {
          this.removeStmt(c).run(id);
          this.hashes.delete(key);
        }
      }
    }

    this.db
      .prepare(`INSERT OR REPLACE INTO hm_meta(key, value) VALUES ('version', ?)`)
      .run(String(collections.version ?? 0));
  }
}

export function resolveHumanMemoryStoreMode(): "sqlite" | "json" {
  const raw = process.env.AGENT_HUMAN_MEMORY_STORE?.trim().toLowerCase();
  return raw === "json" ? "json" : "sqlite";
}

// ─────────────────────────────────────────────────────────────────────────────
// L0 原始轮次 + 抽取 outbox（统一真相源）
// ─────────────────────────────────────────────────────────────────────────────

export type MemoryTurnKind = "dialogue" | "event";

export type MemoryTurnRecord = {
  id: string;
  actorId: string;
  sessionId: string;
  kind: MemoryTurnKind;
  userText: string;
  assistantText: string;
  eventText: string;
  token: string | null;
  createdAt: string;
  dateKey: string;
  timeLabel: string;
  consolidatedAt: string | null;
};

type TurnRow = {
  id: string;
  actor_id: string;
  session_id: string;
  kind: string;
  user_text: string;
  assistant_text: string;
  event_text: string;
  token: string | null;
  created_at: string;
  date_key: string;
  time_label: string;
  consolidated_at: string | null;
};

function rowToTurn(row: TurnRow): MemoryTurnRecord {
  return {
    id: row.id,
    actorId: row.actor_id,
    sessionId: row.session_id,
    kind: row.kind === "event" ? "event" : "dialogue",
    userText: row.user_text,
    assistantText: row.assistant_text,
    eventText: row.event_text,
    token: row.token,
    createdAt: row.created_at,
    dateKey: row.date_key,
    timeLabel: row.time_label,
    consolidatedAt: row.consolidated_at,
  };
}

/**
 * 追加写轮次账本。
 *
 * - `hm_turns`：每轮原始文本 append-only（不因固化删除），是「当天发生了什么」
 *   的唯一真相；journal md 只是它的人类可读派生视图。
 * - `hm_memory_jobs`：每轮一条 pending 抽取任务。夜间固化消费 pending 任务，
 *   成功才 completed；失败保留 attempts/last_error，次日继续重试。
 *
 * 与 GraphSqlitePersistence 打开同一个 SQLite 文件（WAL），但独立连接：
 * 写入路径（对话收尾）不必等待长期记忆服务初始化。
 */
export class TurnLedgerStore {
  private readonly db: SqliteDatabase;
  private insertTurnStmt: Statement | null = null;
  private insertJobStmt: Statement | null = null;

  constructor(dbPath?: string) {
    const path = dbPath ?? resolveMemoryDbPath();
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS hm_turns (
        id TEXT PRIMARY KEY,
        actor_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        user_text TEXT NOT NULL,
        assistant_text TEXT NOT NULL,
        event_text TEXT NOT NULL,
        token TEXT,
        created_at TEXT NOT NULL,
        date_key TEXT NOT NULL,
        time_label TEXT NOT NULL,
        consolidated_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_hm_turns_actor_date ON hm_turns(actor_id, date_key);
      CREATE INDEX IF NOT EXISTS idx_hm_turns_pending ON hm_turns(actor_id, consolidated_at);
      CREATE TABLE IF NOT EXISTS hm_memory_jobs (
        id TEXT PRIMARY KEY,
        actor_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        completed_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_hm_jobs_pending ON hm_memory_jobs(actor_id, completed_at);
    `);
  }

  close(): void {
    this.db.close();
  }

  /** 追加一轮原始文本，并在同一事务里登记抽取任务。 */
  appendTurn(input: {
    actorId: string;
    sessionId: string;
    kind: MemoryTurnKind;
    userText?: string;
    assistantText?: string;
    eventText?: string;
    token?: string | null;
    createdAt: string;
    dateKey: string;
    timeLabel: string;
  }): { turnId: string; jobId: string } {
    const turnId = `turn_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const jobId = `job_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    this.insertTurnStmt ??= this.db.prepare(
      `INSERT INTO hm_turns
        (id, actor_id, session_id, kind, user_text, assistant_text, event_text, token, created_at, date_key, time_label, consolidated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    );
    this.insertJobStmt ??= this.db.prepare(
      `INSERT INTO hm_memory_jobs
        (id, actor_id, kind, turn_id, created_at, attempts, last_error, completed_at)
       VALUES (?, ?, 'turn_consolidate', ?, ?, 0, NULL, NULL)`,
    );
    const insert = this.db.transaction(() => {
      this.insertTurnStmt!.run(
        turnId,
        input.actorId,
        input.sessionId,
        input.kind,
        input.userText ?? "",
        input.assistantText ?? "",
        input.eventText ?? "",
        input.token ?? null,
        input.createdAt,
        input.dateKey,
        input.timeLabel,
      );
      this.insertJobStmt!.run(jobId, input.actorId, turnId, input.createdAt);
    });
    insert();
    return { turnId, jobId };
  }

  /** 未固化的轮次（pending job 驱动，按时间升序）。 */
  listPendingTurns(actorId: string): MemoryTurnRecord[] {
    const rows = this.db
      .prepare(
        `SELECT t.* FROM hm_memory_jobs j
         JOIN hm_turns t ON t.id = j.turn_id
         WHERE j.actor_id = ? AND j.completed_at IS NULL
         ORDER BY t.created_at ASC`,
      )
      .all(actorId) as TurnRow[];
    return rows.map(rowToTurn);
  }

  /** 按 turn id 精确关闭（避免固化快照之后新写入的轮次被误标已处理）。 */
  markConsolidatedByTurnIds(actorId: string, turnIds: string[]): number {
    if (turnIds.length === 0) return 0;
    const at = new Date().toISOString();
    const finish = this.db.transaction(() => {
      let changed = 0;
      const turnStmt = this.db.prepare(
        `UPDATE hm_turns SET consolidated_at = ? WHERE actor_id = ? AND id = ? AND consolidated_at IS NULL`,
      );
      const jobStmt = this.db.prepare(
        `UPDATE hm_memory_jobs SET completed_at = ? WHERE actor_id = ? AND turn_id = ? AND completed_at IS NULL`,
      );
      for (const id of turnIds) {
        changed += turnStmt.run(at, actorId, id).changes;
        jobStmt.run(at, actorId, id);
      }
      return changed;
    });
    return finish();
  }

  /** 该日期是否还有 pending 轮次（用于决定派生 md 能否安全删除）。 */
  countPendingForDate(actorId: string, dateKey: string): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM hm_memory_jobs j
         JOIN hm_turns t ON t.id = j.turn_id
         WHERE j.actor_id = ? AND j.completed_at IS NULL AND t.date_key = ?`,
      )
      .get(actorId, dateKey) as { n: number };
    return row.n;
  }

  /** 标记这些日期的全部轮次已固化（同时关闭对应 job）。 */
  markConsolidatedByDate(actorId: string, dateKeys: string[]): number {
    if (dateKeys.length === 0) return 0;
    const placeholders = dateKeys.map(() => "?").join(",");
    const at = new Date().toISOString();
    const finish = this.db.transaction(() => {
      const turnIds = this.db
        .prepare(`SELECT id FROM hm_turns WHERE actor_id = ? AND date_key IN (${placeholders})`)
        .all(actorId, ...dateKeys) as Array<{ id: string }>;
      this.db
        .prepare(`UPDATE hm_turns SET consolidated_at = ? WHERE actor_id = ? AND date_key IN (${placeholders})`)
        .run(at, actorId, ...dateKeys);
      for (const { id } of turnIds) {
        this.db
          .prepare(`UPDATE hm_memory_jobs SET completed_at = ? WHERE actor_id = ? AND turn_id = ? AND completed_at IS NULL`)
          .run(at, actorId, id);
      }
      return turnIds.length;
    });
    return finish();
  }

  /** 固化失败：保留 pending，累加 attempts 与错误信息（次日重试）。 */
  recordFailureByDate(actorId: string, dateKeys: string[], error: string): void {
    if (dateKeys.length === 0) return;
    const placeholders = dateKeys.map(() => "?").join(",");
    this.db
      .prepare(
        `UPDATE hm_memory_jobs
         SET attempts = attempts + 1, last_error = ?
         WHERE actor_id = ? AND completed_at IS NULL
           AND turn_id IN (SELECT id FROM hm_turns WHERE actor_id = ? AND date_key IN (${placeholders}))`,
      )
      .run(error.slice(0, 500), actorId, actorId, ...dateKeys);
  }

  /** 该日期是否已有 turns（历史 md 迁移的幂等判定）。 */
  hasTurnsForDate(actorId: string, dateKey: string): boolean {
    const row = this.db
      .prepare(`SELECT 1 AS hit FROM hm_turns WHERE actor_id = ? AND date_key = ? LIMIT 1`)
      .get(actorId, dateKey) as { hit: number } | undefined;
    return Boolean(row);
  }

  /** 运维/测试口径：pending 任务数与历史轮次数。 */
  stats(actorId: string): { turns: number; pending: number } {
    const turns = this.db
      .prepare(`SELECT COUNT(*) AS n FROM hm_turns WHERE actor_id = ?`)
      .get(actorId) as { n: number };
    const pending = this.db
      .prepare(`SELECT COUNT(*) AS n FROM hm_memory_jobs WHERE actor_id = ? AND completed_at IS NULL`)
      .get(actorId) as { n: number };
    return { turns: turns.n, pending: pending.n };
  }
}
