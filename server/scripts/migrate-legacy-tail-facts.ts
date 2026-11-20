/**
 * 一次性迁移：data/user-facts/<actor>.json → structured_facts(category=tail:*)。
 * 夜间任务会周期性执行同一逻辑；本脚本用于立即收敛存量（幂等，可重复跑）。
 *
 * 运行：cd server && npx tsx scripts/migrate-legacy-tail-facts.ts --apply
 * 缺省 dry-run（只打印将迁移的条目，不写库）。
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { loadServerEnv } from "../src/config/load-server-env.js";
import { getDataDir } from "../src/config/data-dir.js";
import { openAgenticSqlite } from "../src/agentic-memory/sqlite-store.js";
import { StructuredFactStore } from "../src/agentic-memory/structured-fact-store.js";
import { migrateLegacyTailFactValues } from "../src/services/nightly-memory-task-service.js";
import type { UserFactKind } from "../src/services/user-fact-store.js";

loadServerEnv();

const DEFAULT_ACTOR = "2378709729@qq.com";

function argValue(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

async function main(): Promise<void> {
  const actorId = argValue("actor") ?? process.env.EVAL_ACTOR ?? DEFAULT_ACTOR;
  const dataDir = argValue("data-dir") ?? getDataDir();
  const dbPath = argValue("db") ?? join(dataDir, "agentic_memory", "agentic-memory.db");
  const apply = process.argv.includes("--apply");
  const legacyPath = join(dataDir, "user-facts", `${actorId.replace(/[^a-zA-Z0-9_-]/g, "_")}.json`);

  if (!existsSync(legacyPath)) {
    console.log(`[migrate-tail] 无存量 JSON：${legacyPath}`);
    return;
  }
  const parsed = JSON.parse(await readFile(legacyPath, "utf-8")) as {
    facts?: Array<{ kind?: string; subject?: string; value?: string; confidence?: number }>;
  };
  const facts = (parsed.facts ?? [])
    .filter((f) => typeof f?.value === "string" && f.value.trim())
    .map((f) => ({
      kind: (f.kind ?? "fact") as UserFactKind,
      subject: f.subject ?? "",
      value: f.value!.trim(),
      confidence: f.confidence,
    }));

  const db = openAgenticSqlite(dbPath);
  try {
    const store = new StructuredFactStore(db);
    const existing = new Set(store.getTailFacts(actorId).map((f) => f.value.trim()));
    const pending = facts.filter((f) => !existing.has(f.value));
    console.log(
      `[migrate-tail] actor=${actorId} 存量 ${facts.length} 条 · 已在结构化库 ${facts.length - pending.length} 条 · 待迁移 ${pending.length} 条`,
    );
    for (const f of pending) console.log(`  · [${f.kind}] ${f.subject} → ${f.value}`);
    if (!apply) {
      console.log("[migrate-tail] dry-run；加 --apply 落库。");
      return;
    }
    const migrated = await migrateLegacyTailFactValues(store, actorId, facts, "NightlyMemoryTaskService");
    console.log(`[migrate-tail] 已迁移 ${migrated} 条 → structured_facts(category=tail:*)`);
  } finally {
    db.close();
  }
}

main().catch((err) => {
  console.error("[migrate-tail] 失败:", err);
  process.exit(1);
});
