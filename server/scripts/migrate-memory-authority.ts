/**
 * 记忆权威源迁移（2026-11-12）
 *
 * 做的事：
 *   1. 删除 KV 里的 `user_profile` 全文副本（权威 = user_profiles/<actor>/USER_PROFILE.md）
 *   2. 清理 KV `memory_preferences` / `memory_facts` 里的档案字段副本
 *      （权威 = structured_facts）
 *   3. 删除 `data/long-term-memory/*.json`（它是 memory_summary 的逐字节副本）
 *
 * 默认 dry-run，只打印统计；加 `--apply` 才写盘，且写前备份 KV 文件。
 *
 * 运行：cd server && npx tsx scripts/migrate-memory-authority.ts [--apply]
 */
import fs from "node:fs";
import path from "node:path";

import { PROFILE_FIELDS } from "../src/agentic-memory/structured-fact-store.js";
import { cleanProfileFieldCopiesFromSlot } from "../src/services/user-personalization/profile-fact-authority.js";

const APPLY = process.argv.includes("--apply");
const DATA_DIR = path.resolve(process.cwd(), "data");
const KV_FILE = path.join(DATA_DIR, "agent-memory-sync.json");
const LTM_DIR = path.join(DATA_DIR, "long-term-memory");
const STAMP = new Date().toISOString().slice(0, 10).replace(/-/g, "");

const fieldSet = new Set<string>(PROFILE_FIELDS);

type Shape = { sessions?: Record<string, { revision: number; entries: Record<string, unknown> }> };

const raw = fs.readFileSync(KV_FILE, "utf8");
const data = JSON.parse(raw) as Shape;
const sessions = data.sessions ?? {};

let withProfileKv = 0;
let kvBytesFreed = 0;
let cleanedSlots = 0;
let cleanedLines = 0;
const cleanedActors: string[] = [];

for (const [actorId, session] of Object.entries(sessions)) {
  const entries = session.entries ?? {};
  const profile = entries["user_profile"];
  if (typeof profile === "string" && profile.trim()) {
    withProfileKv += 1;
    kvBytesFreed += profile.length;
    if (APPLY) delete entries["user_profile"];
  }
  let actorTouched = false;
  for (const key of ["memory_preferences", "memory_facts"]) {
    const value = entries[key];
    if (typeof value !== "string" || !value.trim()) continue;
    const cleaned = cleanProfileFieldCopiesFromSlot(value, fieldSet);
    if (!cleaned.changed) continue;
    cleanedSlots += 1;
    cleanedLines += cleaned.removed;
    actorTouched = true;
    if (APPLY) {
      if (cleaned.value.trim()) entries[key] = cleaned.value;
      else delete entries[key];
    }
  }
  if (actorTouched) cleanedActors.push(actorId);
  if (APPLY && (actorTouched || typeof profile === "string")) session.revision += 1;
}

const ltmFiles = fs.existsSync(LTM_DIR) ? fs.readdirSync(LTM_DIR).filter((f) => f.endsWith(".json")) : [];
let ltmBytes = 0;
for (const f of ltmFiles) {
  try {
    ltmBytes += fs.statSync(path.join(LTM_DIR, f)).size;
  } catch {
    /* ignore */
  }
}

console.log(`模式：${APPLY ? "APPLY（会写盘）" : "DRY-RUN（只看不写）"}`);
console.log(`KV 文件：${KV_FILE}`);
console.log(`  sessions: ${Object.keys(sessions).length}`);
console.log(`  带 user_profile 副本: ${withProfileKv} 个会话，可释放 ${kvBytesFreed} 字符`);
console.log(`  含档案字段副本的槽位: ${cleanedSlots} 个，可清理 ${cleanedLines} 行（${cleanedActors.length} 个会话）`);
console.log(`  受影响会话示例: ${cleanedActors.slice(0, 5).join(", ") || "(无)"}`);
console.log(`long-term-memory 副本文件: ${ltmFiles.length} 个，共 ${ltmBytes} 字节`);

if (!APPLY) {
  console.log("\n加 --apply 执行写盘（会先备份 KV 文件）。");
}

/* ── 短期层：清理 STM 里的 facts / preferences 副本 ─────────── */
const STM_FILE = path.join(DATA_DIR, "short-term-task-stack.json");
let stmRemovedFacts = 0;
let stmRemovedPrefs = 0;
if (fs.existsSync(STM_FILE)) {
  const stm = JSON.parse(fs.readFileSync(STM_FILE, "utf8")) as {
    episodic?: Record<string, { facts?: unknown[]; turns?: unknown[] }>;
    sessions?: Record<string, { conversationMemory?: { facts?: unknown[]; preferences?: unknown[] } }>;
  };
  for (const v of Object.values(stm.episodic ?? {})) {
    stmRemovedFacts += Array.isArray(v.facts) ? v.facts.length : 0;
    if (APPLY && Array.isArray(v.facts)) v.facts = [];
  }
  for (const v of Object.values(stm.sessions ?? {})) {
    const cm = v.conversationMemory;
    if (!cm) continue;
    stmRemovedPrefs += (cm.facts?.length ?? 0) + (cm.preferences?.length ?? 0);
    if (APPLY) {
      cm.facts = [];
      cm.preferences = [];
    }
  }
  console.log(
    `\nSTM 副本：episodic.facts ${stmRemovedFacts} 条、conversationMemory.facts/preferences ${stmRemovedPrefs} 条`,
  );
  if (APPLY) {
    const bak = `${STM_FILE}.bak-authority-${STAMP}`;
    if (!fs.existsSync(bak)) fs.copyFileSync(STM_FILE, bak);
    fs.writeFileSync(STM_FILE, JSON.stringify(stm), "utf8");
    console.log(`已备份 → ${bak}，STM 副本已清空`);
  }
}

if (!APPLY) {
  process.exit(0);
}

const backup = `${KV_FILE}.bak-authority-${STAMP}`;
fs.copyFileSync(KV_FILE, backup);
fs.writeFileSync(KV_FILE, JSON.stringify(data), "utf8");
console.log(`\n已备份 → ${backup}`);
console.log("KV 已写回");

if (ltmFiles.length > 0) {
  for (const f of ltmFiles) {
    fs.rmSync(path.join(LTM_DIR, f), { force: true });
  }
  console.log(`已删除 ${ltmFiles.length} 个 long-term-memory 副本文件`);
}
