/**
 * 统一 SQLite 建连入口。
 *
 * 统一的是**行为一致性**，不是调参：
 *   - 每个库都开 WAL（原来就一致）；
 *   - WAL 下 SQLite 的 `synchronous` 默认就是 NORMAL（实测 `PRAGMA synchronous`
 *     返回 1），逐条 commit 并不会 fsync——这里显式写一次只是为了把这个事实
 *     固定在代码里，防止以后有人换 journal 模式时误判；
 *   - 外键约束由调用方按原行为决定（默认关，原本开启的库显式传 foreignKeys）。
 *
 * 结论（2026-11 实测）：better-sqlite3 + WAL 下并没有"每次 commit 都 fsync"的
 * 问题，SQLite 不是 CPU/内存瓶颈，不做额外 pragma 调参，避免引入 RSS 与行为变化。
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import Database from "better-sqlite3";
import type { Database as SqliteDatabase } from "better-sqlite3";

export type OpenSqliteOptions = {
  readonly?: boolean;
  fileMustExist?: boolean;
  /** 是否启用外键约束；默认 false，与本仓各 store 的历史行为保持一致。 */
  foreignKeys?: boolean;
};

/**
 * 打开（或创建）一个 SQLite 连接。
 *
 * 只读连接不写 pragma（synchronous 在只读事务里不可改），调用方保持原样即可。
 */
export function openSqlite(path: string, opts: OpenSqliteOptions = {}): SqliteDatabase {
  if (!opts.readonly) {
    mkdirSync(dirname(path), { recursive: true });
  }

  const db = new Database(path, {
    ...(opts.readonly ? { readonly: true } : {}),
    ...(opts.fileMustExist ? { fileMustExist: true } : {}),
  });

  if (opts.readonly) return db;

  db.pragma("journal_mode = WAL");
  // WAL 模式下的默认值就是 NORMAL；显式设置是做行为声明，不产生额外成本。
  db.pragma("synchronous = NORMAL");
  if (opts.foreignKeys) db.pragma("foreign_keys = ON");

  return db;
}
