/**
 * 一次性回填：画像正文里的档案字段 → structured_facts（权威库）。
 *
 * 背景：USER_PROFILE.md 是投影，权威源是结构化事实库；画像里写着"居住地：兴义"
 * 只代表投影生成过，事实库没有时"我住哪"召回不到。
 *
 * 运行：cd server && npx tsx scripts/backfill-profile-fact.ts --field 居住地 --value "兴义（贵州）" --apply
 * 缺省 dry-run；--db/--actor 可覆盖。
 */

import { mkdirSync, copyFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { loadServerEnv } from "../src/config/load-server-env.js";
import { getDataDir } from "../src/config/data-dir.js";
import { openAgenticSqlite } from "../src/agentic-memory/sqlite-store.js";
import { StructuredFactStore } from "../src/agentic-memory/structured-fact-store.js";

loadServerEnv();

const DEFAULT_ACTOR = "2378709729@qq.com";

function argValue(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

function main(): void {
  const actorId = argValue("actor") ?? DEFAULT_ACTOR;
  const dataDir = argValue("data-dir") ?? getDataDir();
  const dbPath = argValue("db") ?? join(dataDir, "agentic_memory", "agentic-memory.db");
  const field = argValue("field");
  const value = argValue("value");
  const apply = process.argv.includes("--apply");
  if (!field || !value) {
    console.error("[backfill-fact] 缺少 --field / --value");
    process.exit(1);
  }

  const db = openAgenticSqlite(dbPath);
  try {
    const store = new StructuredFactStore(db);
    const current = store.getFact(actorId, field);
    console.log(
      `[backfill-fact] actor=${actorId} ${field}=${value}` +
        (current ? `（现状 ${current.value}）` : "（现状为空）"),
    );
    if (!apply) {
      console.log("[backfill-fact] dry-run；加 --apply 落库。");
      return;
    }
    const backupPath = join(
      dirname(dbPath),
      `agentic-memory.bak-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-profile-backfill.db`,
    );
    mkdirSync(dirname(backupPath), { recursive: true });
    db.prepare("PRAGMA wal_checkpoint(FULL)").get();
    copyFileSync(dbPath, backupPath);
    console.log(`[backfill-fact] 备份 → ${backupPath}`);

    const result = store.applyFact(
      {
        actorId,
        field,
        value,
        confidence: 0.9,
        sourceRef: "manual:user-profile-backfill-20261120",
      },
      "NightlyMemoryTaskService",
    );
    console.log(
      `[backfill-fact] ${result?.changed ? "已写入" : "未变更"}${result?.ignored ? `（${result.ignored}）` : ""}`,
    );
  } finally {
    db.close();
  }
}

main();
