/**
 * 一次性收敛：life_episodes 里同 actor + 同 source_kind + 同观察内容的重复片段，
 * 只保留最新一条。写入侧已加 24h 去重，本脚本清历史副本。
 *
 * 运行：cd server && npx tsx scripts/dedupe-life-episodes.ts [--apply]
 */

import { join } from "node:path";

import { openAgenticSqlite } from "../src/agentic-memory/sqlite-store.js";

function argValue(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

function episodeKey(kind: string | null, observation: string): string {
  return `${kind ?? ""}\u0000${observation
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "")
    .slice(0, 160)}`;
}

function main(): void {
  const dataDir =
    argValue("data-dir") ?? process.env.NEXTBOT_DATA_DIR ?? "D:/AppData/Nextbot/data";
  const dbPath = argValue("db") ?? join(dataDir, "agentic_memory", "agentic-memory.db");
  const apply = process.argv.includes("--apply");

  const db = openAgenticSqlite(dbPath);
  try {
    const rows = db
      .prepare(
        `SELECT id, actor_id, source_kind, observation, updated_at
         FROM life_episodes ORDER BY updated_at DESC`,
      )
      .all() as Array<{
      id: string;
      actor_id: string;
      source_kind: string | null;
      observation: string;
      updated_at: string;
    }>;
    const kept = new Map<string, string>();
    const stale: Array<{ id: string; actor_id: string }> = [];
    for (const row of rows) {
      const key = `${row.actor_id}\u0000${episodeKey(row.source_kind, row.observation)}`;
      if (kept.has(key)) stale.push({ id: row.id, actor_id: row.actor_id });
      else kept.set(key, row.id);
    }
    console.log(
      `[dedupe-episodes] 总 ${rows.length} 条 · 保留 ${kept.size} 条 · 重复 ${stale.length} 条`,
    );
    if (!apply) {
      for (const s of stale.slice(0, 20)) console.log(`  · 待删 ${s.id}`);
      console.log("[dedupe-episodes] dry-run；加 --apply 删除重复行。");
      return;
    }
    const del = db.prepare(`DELETE FROM life_episodes WHERE id = ?`);
    const run = db.transaction(() => {
      for (const s of stale) del.run(s.id);
    });
    run();
    console.log(`[dedupe-episodes] 已删除 ${stale.length} 条重复片段`);
  } finally {
    db.close();
  }
}

main();
