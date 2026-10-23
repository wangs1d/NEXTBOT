/**
 * 沙箱工作区结构索引（WP3，2026-09-17）。
 *
 * 借鉴 codebase-memory-mcp 的「持久化索引 + mtime 增量刷新」：对 code-sandbox
 * 工作区的每个文件按 (工作区, 文件, mtimeMs, size) 缓存确定性结构概要
 * （content-map 的 outline），供 code.workspace_map 一次调用返回全工作区地图、
 * code.read_file 的 mode="outline" 返回结构目录。
 *
 * - 持久化：better-sqlite3（data/sandbox-index.sqlite，WAL），同工作区同文件
 *   未变更时零重算（增量同步）；打开失败降级为进程内 Map（功能不缺失，仅跨重启失效）。
 * - 抽取确定性：概要全部来自 content-map 的规则抽取（标题/表头/签名），无 LLM。
 * - 大文件只读头部 buildOutlineHeadBytes 字节建索引（outline 标注 truncated）。
 */

import { mkdirSync } from "node:fs";
import { open, readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

import Database from "better-sqlite3";
import type { Database as SqliteDatabase } from "better-sqlite3";

import { buildContentMap, renderOutline } from "../external-model/content-map.js";
import { getDataDir } from "../config/data-dir.js";

/** 建索引时读取的文件头部字节数（超出部分不影响 outline 的导航价值）。 */
const OUTLINE_HEAD_BYTES = 64 * 1024;
/** 单文件 outline 渲染行数上限（workspace_map 多文件聚合时的每文件体积控制）。 */
const OUTLINE_MAX_LINES = 24;
/** 单个 workspace_map 聚合的文件数上限。 */
export const WORKSPACE_MAP_MAX_FILES = 50;

export interface WorkspaceFileOutline {
  path: string;
  size: number;
  /** 文件 kind（content-map 的 ContentKind）。 */
  kind: string;
  /** 渲染后的结构概要（行式目录，含导航声明）。 */
  outline: string;
  /** 本次是否命中缓存（未重算）。 */
  cached: boolean;
  /** 文件头部被截断（仅读了前 OUTLINE_HEAD_BYTES 字节建索引）。 */
  headTruncated: boolean;
}

interface OutlineRow {
  mtime_ms: number;
  size: number;
  kind: string;
  outline: string;
  head_truncated: number;
}

export function getSandboxIndexDbPath(): string {
  const base = process.env.PA_DATA_DIR?.trim() || getDataDir();
  return join(base, "sandbox-index.sqlite");
}

export class SandboxWorkspaceIndex {
  private db: SqliteDatabase | null = null;
  /** SQLite 不可用时的进程内回退缓存（重启后失效，功能不缺失）。 */
  private readonly memFallback = new Map<string, OutlineRow>();

  constructor(dbPath?: string) {
    try {
      const file = dbPath ?? getSandboxIndexDbPath();
      mkdirSync(dirname(file), { recursive: true });
      this.db = new Database(file);
      this.db.pragma("journal_mode = WAL");
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS sandbox_file_outline (
          ws_path TEXT NOT NULL,
          path TEXT NOT NULL,
          mtime_ms REAL NOT NULL,
          size INTEGER NOT NULL,
          kind TEXT NOT NULL,
          outline TEXT NOT NULL,
          head_truncated INTEGER NOT NULL DEFAULT 0,
          indexed_at INTEGER NOT NULL,
          PRIMARY KEY (ws_path, path)
        )
      `);
    } catch (e) {
      console.warn(
        `[sandbox-workspace-index] SQLite 打开失败，降级为进程内缓存: ${e instanceof Error ? e.message : e}`,
      );
      this.db = null;
    }
  }

  /**
   * 取文件结构概要：mtime+size 未变 → 直接命中缓存（增量同步）；
   * 变更/首次 → 读头部重建 outline 并回写。
   * 文件读取/解析失败返回 null（调用方按普通文件列出，不阻塞工作区地图）。
   */
  async getFileOutline(wsPath: string, relPath: string, fullPath: string): Promise<WorkspaceFileOutline | null> {
    let stat0: { size: number; mtimeMs: number };
    try {
      const s = await stat(fullPath);
      if (!s.isFile()) return null;
      stat0 = { size: s.size, mtimeMs: s.mtimeMs };
    } catch {
      return null;
    }
    const key = this.memKey(wsPath, relPath);
    const row = this.lookup(key, wsPath, relPath);
    if (row && row.mtime_ms === stat0.mtimeMs && row.size === stat0.size) {
      return {
        path: relPath,
        size: row.size,
        kind: row.kind,
        outline: row.outline,
        cached: true,
        headTruncated: row.head_truncated === 1,
      };
    }
    // 重建：只读头部（10MB 上限文件也只取 64KB 建 outline）
    let head: string;
    let headTruncated = false;
    try {
      if (stat0.size <= OUTLINE_HEAD_BYTES) {
        head = await readFile(fullPath, "utf-8");
      } else {
        const handle = await open(fullPath, "r");
        try {
          const buf = Buffer.alloc(OUTLINE_HEAD_BYTES);
          await handle.read(buf, 0, OUTLINE_HEAD_BYTES, 0);
          head = buf.toString("utf-8");
        } finally {
          await handle.close();
        }
        headTruncated = true;
      }
    } catch {
      return null;
    }
    let kind = "text";
    let outline = "";
    try {
      const map = buildContentMap(head);
      kind = map.kind;
      outline = renderOutline(map, OUTLINE_MAX_LINES);
      if (headTruncated) outline += `\n…（索引仅覆盖头部 ${OUTLINE_HEAD_BYTES} 字节，全文用 code.read_file mode="range" 分段读取）`;
    } catch {
      return null;
    }
    this.store(key, wsPath, relPath, { mtime_ms: stat0.mtimeMs, size: stat0.size, kind, outline, head_truncated: headTruncated ? 1 : 0 });
    return {
      path: relPath,
      size: stat0.size,
      kind,
      outline,
      cached: false,
      headTruncated,
    };
  }

  /** 工作区整体失效（写操作后调用方可选调用；mtime 机制通常已足够）。 */
  invalidate(wsPath?: string): void {
    if (!wsPath) {
      this.memFallback.clear();
      try {
        this.db?.exec("DELETE FROM sandbox_file_outline");
      } catch {
        /* 忽略 */
      }
      return;
    }
    for (const key of [...this.memFallback.keys()]) {
      if (key.startsWith(`${wsPath}::`)) this.memFallback.delete(key);
    }
    try {
      this.db?.prepare("DELETE FROM sandbox_file_outline WHERE ws_path = ?").run(wsPath);
    } catch {
      /* 忽略 */
    }
  }

  close(): void {
    try {
      this.db?.close();
    } catch {
      /* 忽略 */
    }
    this.db = null;
  }

  private memKey(wsPath: string, relPath: string): string {
    return `${wsPath}::${relPath}`;
  }

  private lookup(key: string, wsPath: string, relPath: string): OutlineRow | null {
    if (this.db) {
      try {
        const row = this.db
          .prepare("SELECT mtime_ms, size, kind, outline, head_truncated FROM sandbox_file_outline WHERE ws_path = ? AND path = ?")
          .get(wsPath, relPath) as OutlineRow | undefined;
        if (row) return row;
      } catch {
        /* 落到 mem */
      }
    }
    return this.memFallback.get(key) ?? null;
  }

  private store(key: string, wsPath: string, relPath: string, row: OutlineRow): void {
    this.memFallback.set(key, row);
    if (this.db) {
      try {
        this.db
          .prepare(
            `INSERT INTO sandbox_file_outline (ws_path, path, mtime_ms, size, kind, outline, head_truncated, indexed_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(ws_path, path) DO UPDATE SET
               mtime_ms = excluded.mtime_ms, size = excluded.size, kind = excluded.kind,
               outline = excluded.outline, head_truncated = excluded.head_truncated, indexed_at = excluded.indexed_at`,
          )
          .run(wsPath, relPath, row.mtime_ms, row.size, row.kind, row.outline, row.head_truncated, Date.now());
      } catch {
        /* 写失败静默（mem 回退已覆盖） */
      }
    }
  }
}

/** 模块级单例（handlers 直接使用，避免牵动 create-app-services 装配图）。 */
let singleton: SandboxWorkspaceIndex | null = null;

export function getSandboxWorkspaceIndex(): SandboxWorkspaceIndex {
  if (!singleton) singleton = new SandboxWorkspaceIndex();
  return singleton;
}

/** 测试专用：重置单例（下一个实例用临时目录路径）。 */
export function resetSandboxWorkspaceIndexForTest(dbPath?: string): SandboxWorkspaceIndex {
  singleton?.close();
  singleton = new SandboxWorkspaceIndex(dbPath);
  return singleton;
}
