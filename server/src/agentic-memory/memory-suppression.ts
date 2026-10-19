/**
 * 记忆软抑制（"别再提这个"，2026-10-19 P2）。
 *
 * 与"忘记"的区别（ChatGPT 的 Delete vs Don't mention this again 同款）：
 *   - 忘记（forget / delete）：把事实从档案下线、把记忆删掉，以后**查也查不到**；
 *   - 软抑制（本模块）：**不删任何源数据**，只在注入与召回时打上「勿主动提」，
 *     用户主动问起时仍然可以引用，只是模型不会自己挑起来。
 *
 * 存在业务场景里这一档很必要：用户嫌某件事啰嗦，不代表他要销毁那条记录
 * （例如"别再提我体检报告的事了"——他不想被主动关心，但问起来还要能答）。
 *
 * 存储：与结构化事实同库（agentic SQLite），单表 + 主键幂等。
 */

import type { Database as SqliteDatabase } from "better-sqlite3";

import { openAgenticSqlite } from "./sqlite-store.js";
import { canonicalFactField } from "./structured-fact-store.js";

export type SuppressionKind = "field" | "text";

export interface MemorySuppression {
  actorId: string;
  kind: SuppressionKind;
  /** field=标准字段名；text=要抑制的文案片段 */
  key: string;
  reason: string | null;
  createdAt: string;
}

interface SuppressionRow {
  actor_id: string;
  kind: string;
  key: string;
  reason: string | null;
  created_at: string;
}

function toSuppression(row: SuppressionRow): MemorySuppression {
  return {
    actorId: row.actor_id,
    kind: row.kind === "field" ? "field" : "text",
    key: row.key,
    reason: row.reason,
    createdAt: row.created_at,
  };
}

export class MemorySuppressionStore {
  private readonly db: SqliteDatabase;

  constructor(db?: SqliteDatabase) {
    this.db = db ?? openAgenticSqlite();
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memory_suppressions (
        actor_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        key TEXT NOT NULL,
        reason TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY (actor_id, kind, key)
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  /** 新增/刷新一条软抑制（幂等：同 actor+kind+key 覆盖 reason） */
  add(
    actorId: string,
    kind: SuppressionKind,
    key: string,
    reason?: string | null,
    at?: string,
  ): MemorySuppression | null {
    const actor = actorId?.trim();
    const rawKey = key?.trim();
    if (!actor || !rawKey) return null;
    const normalized = kind === "field" ? canonicalFactField(rawKey) : rawKey.slice(0, 60);
    if (!normalized) return null;
    const now = at ?? new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO memory_suppressions (actor_id, kind, key, reason, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(actor_id, kind, key) DO UPDATE SET reason = excluded.reason`,
      )
      .run(actor, kind, normalized, reason?.trim() || null, now);
    return { actorId: actor, kind, key: normalized, reason: reason?.trim() || null, createdAt: now };
  }

  list(actorId: string): MemorySuppression[] {
    const actor = actorId?.trim();
    if (!actor) return [];
    const rows = this.db
      .prepare(`SELECT * FROM memory_suppressions WHERE actor_id = ? ORDER BY created_at DESC`)
      .all(actor) as SuppressionRow[];
    return rows.map(toSuppression);
  }

  remove(actorId: string, kind: SuppressionKind, key: string): boolean {
    const actor = actorId?.trim();
    const rawKey = key?.trim();
    if (!actor || !rawKey) return false;
    const normalized = kind === "field" ? canonicalFactField(rawKey) : rawKey;
    const res = this.db
      .prepare(`DELETE FROM memory_suppressions WHERE actor_id = ? AND kind = ? AND key = ?`)
      .run(actor, kind, normalized);
    return res.changes > 0;
  }

  /** 字段是否被软抑制（渲染档案时用来打「勿主动提」标记） */
  suppressedFields(actorId: string): Set<string> {
    const actor = actorId?.trim();
    if (!actor) return new Set();
    const rows = this.db
      .prepare(`SELECT key FROM memory_suppressions WHERE actor_id = ? AND kind = 'field'`)
      .all(actor) as Array<{ key: string }>;
    return new Set(rows.map((r) => r.key));
  }

  /** 文本片段是否命中软抑制（召回时给条目打标记，不删条目） */
  textKeys(actorId: string): string[] {
    const actor = actorId?.trim();
    if (!actor) return [];
    const rows = this.db
      .prepare(`SELECT key FROM memory_suppressions WHERE actor_id = ? AND kind = 'text'`)
      .all(actor) as Array<{ key: string }>;
    return rows.map((r) => r.key).filter((k) => k.length >= 2);
  }

  purgeActor(actorId: string): number {
    const actor = actorId?.trim();
    if (!actor) return 0;
    return this.db.prepare(`DELETE FROM memory_suppressions WHERE actor_id = ?`).run(actor).changes;
  }
}

let singleton: MemorySuppressionStore | null = null;

/**
 * 进程级单例（路由与渲染侧共用；测试可自行 new）。
 * 首次调用会建库——只应在启动装配期调用，热路径请用 peek。
 */
export function getMemorySuppressionStore(): MemorySuppressionStore | null {
  if (singleton) return singleton;
  try {
    singleton = new MemorySuppressionStore();
    return singleton;
  } catch {
    return null;
  }
}

/**
 * 热路径只读访问器（不建库）：prompt 装配 / 召回每轮都会调，
 * 没有显式初始化时返回 null，避免在测试或未装配环境里顺手写出一个库文件。
 */
export function peekMemorySuppressionStore(): MemorySuppressionStore | null {
  return singleton;
}

/** 装配期注册（bootstrap 调用一次） */
export function initMemorySuppressionStore(): MemorySuppressionStore | null {
  return getMemorySuppressionStore();
}

/** 仅测试用：注入内存态实例（不落盘），并可在结束时还原 */
export function setMemorySuppressionStoreForTests(store: MemorySuppressionStore | null): void {
  singleton = store;
}
