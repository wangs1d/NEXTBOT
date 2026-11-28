/**
 * agentic-memory SQLite 存储入口。
 *
 * 方案 B（语义账本）/ 方案 C（承诺草稿板）/ 方案 D（溯源作废）共用同一个
 * SQLite 文件（缺省 data/agentic_memory/agentic-memory.db，环境变量
 * AGENT_AGENTIC_MEMORY_DB 覆盖），各模块建各自的表：
 *   - ledger_records       方案 B：append-only 语义账本
 *   - commitments          方案 C：承诺草稿板
 *   - bridge_links         方案 A：认知图节点 ↔ Mem0 记忆 linkage（遗忘同步用）
 *   - provenance_edges     方案 D：sourceRef → 派生记忆依赖图
 *
 * 测试通过显式传入临时目录下的 db 路径实现隔离（better-sqlite3 为同步本地库，
 * 无外部依赖，测试封闭）。
 */

import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

import type { Database as SqliteDatabase } from "better-sqlite3";

import { openSqlite } from "../storage/sqlite.js";
import { getAgenticMemoryDir } from "./env.js";

export function getAgenticSqlitePath(): string {
  return (
    process.env.AGENT_AGENTIC_MEMORY_DB?.trim() ||
    join(getAgenticMemoryDir(), "agentic-memory.db")
  );
}

/** 打开（或创建）agentic-memory SQLite 库：WAL + NORMAL + 外键（统一 opener，热库档）。 */
export function openAgenticSqlite(path?: string): SqliteDatabase {
  const file = path ?? getAgenticSqlitePath();
  return openSqlite(file, { foreignKeys: true });
}

/** JSON 列序列化/反序列化（null 安全）。 */
export function toJsonColumn(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return JSON.stringify(value);
}

export function fromJsonColumn<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}
