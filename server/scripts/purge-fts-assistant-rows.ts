/**
 * 一次性收敛：删除 mem_fts 里「助手角色」的词法行。
 * 写入侧已停止再索引这类内容；本脚本清历史行（Mem0 源记忆不动）。
 *
 * 运行：cd server && npx tsx scripts/purge-fts-assistant-rows.ts [--apply]
 */

import { join } from "node:path";

import { openAgenticSqlite } from "../src/agentic-memory/sqlite-store.js";
import { classifyMemorySourceRole } from "../src/services/memory-source-role.js";

function argValue(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

function main(): void {
  const dataDir =
    argValue("data-dir") ?? process.env.NEXTBOT_DATA_DIR ?? "D:/AppData/Nextbot/data";
  const dbPath = argValue("db") ?? join(dataDir, "agentic_memory", "agentic-memory.db");
  const apply = process.argv.includes("--apply");

  const db = openAgenticSqlite(dbPath);
  try {
    const rows = db.prepare(`SELECT rowid, content FROM mem_fts`).all() as Array<{
      rowid: number;
      content: string;
    }>;
    const stale = rows.filter((r) => classifyMemorySourceRole(r.content) === "assistant");
    console.log(
      `[purge-fts] 总 ${rows.length} 行 · 助手角色 ${stale.length} 行` +
        `（${rows.length ? ((stale.length / rows.length) * 100).toFixed(1) : "0"}%）`,
    );
    if (!apply) {
      for (const r of stale.slice(0, 10)) console.log(`  · ${r.content.slice(0, 60)}`);
      console.log("[purge-fts] dry-run；加 --apply 删除。");
      return;
    }
    const del = db.prepare(`DELETE FROM mem_fts WHERE rowid = ?`);
    db.transaction(() => {
      for (const r of stale) del.run(r.rowid);
    })();
    console.log(`[purge-fts] 已删除 ${stale.length} 行助手词法索引`);
  } finally {
    db.close();
  }
}

main();
