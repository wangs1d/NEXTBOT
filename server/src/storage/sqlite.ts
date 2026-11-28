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
 *
 * 例外是 busy_timeout（2C2G 服务器优化，2026-11-28）：它不是性能调参，不改稳态
 * 行为、不占内存——只改"冲突时"的语义。本仓多数库虽是单写者设计，但 supervisor
 * 重启窗口、未来跨进程写者、以及 WAL checkpoint 恢复边界都可能让第二个写者立刻
 * 拿到 SQLITE_BUSY 抛错；默认等 2s 再报，把偶发冲突从"接口 500"变成"慢一点"。
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
 * busy_timeout（毫秒），可用 SQLITE_BUSY_TIMEOUT_MS 覆盖（0 = 关闭，恢复立刻抛错）。
 * 主流取值 2000~5000ms；这里取 2000ms——写冲突多是秒级窗口（supervisor 重启、
 * WAL checkpoint），超过 2s 的等待通常说明有真异常，快速失败更利于定位。
 */
function busyTimeoutMs(): number {
  const value = Number.parseInt(process.env.SQLITE_BUSY_TIMEOUT_MS ?? "", 10);
  if (!Number.isFinite(value)) return 2000;
  return Math.max(0, Math.min(60_000, value));
}

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
  // 写锁冲突时等待而非立刻抛 SQLITE_BUSY（见文件头注释的例外说明）。
  db.pragma(`busy_timeout = ${busyTimeoutMs()}`);
  if (opts.foreignKeys) db.pragma("foreign_keys = ON");

  return db;
}
