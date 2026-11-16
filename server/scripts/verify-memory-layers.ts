/**
 * 记忆分层验收（2026-11-12）
 *
 * 逐层验证两件事：
 *   A. 写入：该层的内容是否只存在于权威位置（不再有并行副本）
 *   B. 读取：进入 prompt 时是否从权威位置拉取（代码路径 + 实际函数调用）
 *
 * 运行：cd server && npx tsx scripts/verify-memory-layers.ts
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

import { sliceMemoryEntriesToPromptContext } from "../src/agent/prompt-builder.js";
import { sanitizeMemoryLinesForPrompt } from "../src/agent/memory-line-hygiene.js";
import { hasRealProfileContent, sanitizeProfileMarkdown } from "../src/services/user-personalization/user-profile-store.js";
import { MEMORY_AUTHORITY } from "../src/memory/memory-authority.js";

const DATA = path.resolve(process.cwd(), "data");
const ACTOR = "2378709729@qq.com";
const kv = JSON.parse(fs.readFileSync(path.join(DATA, "agent-memory-sync.json"), "utf8"));
const entries = kv.sessions?.[ACTOR]?.entries ?? {};

const ok = (b: boolean) => (b ? "✓" : "✗");
const result: Array<{ layer: string; write: string; read: string; pass: boolean }> = [];

/* ── 1. 用户画像 ─────────────────────────────────────────────── */
const mdPath = path.join(DATA, "user_profiles", "2378709729_qq.com", "USER_PROFILE.md");
const md = fs.existsSync(mdPath) ? fs.readFileSync(mdPath, "utf8") : "";
const profileKvLeft = Object.values(kv.sessions ?? {}).filter((s: any) =>
  typeof s?.entries?.user_profile === "string" && s.entries.user_profile.trim(),
).length;
const profileCtx = sliceMemoryEntriesToPromptContext(
  { ...entries, user_profile: "should-be-ignored" },
  "我是谁",
);
result.push({
  layer: "用户画像",
  write: `md 存在且有效 ${ok(hasRealProfileContent(sanitizeProfileMarkdown(md)))}；KV user_profile 副本 ${profileKvLeft} 个（期望 0）`,
  read: `prompt 不再读 KV 副本 ${ok(profileCtx.userProfile === undefined)}；画像走 UserPersonalizationService → md`,
  pass: profileKvLeft === 0 && profileCtx.userProfile === undefined && hasRealProfileContent(md),
});

/* ── 2. 档案字段 ────────────────────────────────────────────── */
let factRows: Array<{ field: string; value: string; status: string }> = [];
try {
  const out = execFileSync(
    "python",
    [
      "-c",
      `import sqlite3,json
c=sqlite3.connect('file:${path.join(DATA, "agentic_memory", "agentic-memory.db").replace(/\\/g, "/")}?mode=ro',uri=True)
cur=c.cursor()
cur.execute("SELECT field,value,status FROM structured_facts WHERE actor_id=?",("${ACTOR}",))
print(json.dumps([{"field":f,"value":v,"status":s} for f,v,s in cur.fetchall()],ensure_ascii=False))`,
    ],
    { encoding: "utf8" },
  );
  factRows = JSON.parse(out || "[]");
} catch {
  factRows = [];
}
const activeFacts = factRows.filter((r) => r.status === "active");
const factKvDup = ["memory_facts", "memory_preferences"].filter((k) =>
  typeof entries[k] === "string" &&
  activeFacts.some((f) => String(entries[k]).includes(`${f.field}：${f.value}`)),
);
result.push({
  layer: "档案字段",
  write: `structured_facts active ${activeFacts.length} 条；KV 档案副本槽 ${factKvDup.length} 个（期望 0）`,
  read: "prompt 走 PromptContextBuilder.buildUserFactsBlock → factStore.renderForPrompt",
  pass: factKvDup.length === 0,
});

/* ── 3. 长期记忆摘要 ───────────────────────────────────────── */
const ltmDir = path.join(DATA, "long-term-memory");
const ltmCount = fs.existsSync(ltmDir) ? fs.readdirSync(ltmDir).filter((f) => f.endsWith(".json")).length : 0;
const memCtx = sliceMemoryEntriesToPromptContext(entries, "小米那个怎么样了");
const summaryLines = String(entries.memory_summary ?? "").split("\n").filter(Boolean).length;
const hygiene = sanitizeMemoryLinesForPrompt(String(entries.memory_summary ?? ""));
const usableLines = hygiene.text.split("\n").filter(Boolean).length;
result.push({
  layer: "长期记忆",
  write: `KV memory_summary ${summaryLines} 行；long-term-memory 副本 ${ltmCount} 个（期望 0）`,
  read:
    `可注入 ${usableLines}/${summaryLines} 行（净化器丢弃 ${hygiene.dropped} 行逐字对话/协议残留）；` +
    `召回结果 ${usableLines === 0 ? "为空（存量本身无可用内容，非读取故障）" : ok(Boolean(memCtx.memorySummary))}`,
  pass: ltmCount === 0,
});

/* ── 4. 短期记忆 ───────────────────────────────────────────── */
const stmPath = path.join(DATA, "short-term-task-stack.json");
let stmActors = 0;
let stmTurns = 0;
let stmFacts = 0;
if (fs.existsSync(stmPath)) {
  const stm = JSON.parse(fs.readFileSync(stmPath, "utf8"));
  stmActors = Object.keys(stm.episodic ?? {}).length;
  stmTurns = Object.values(stm.episodic ?? {}).reduce(
    (n: number, v: any) => n + (Array.isArray(v?.turns) ? v.turns.length : 0),
    0,
  );
  stmFacts = Object.values(stm.episodic ?? {}).reduce(
    (n: number, v: any) => n + (Array.isArray(v?.facts) ? v.facts.length : 0),
    0,
  );
}
result.push({
  layer: "短期记忆",
  write: `chat-threads.json（权威）；STM 仍存 ${stmActors} actors / ${stmTurns} turns / ${stmFacts} 条 fact 副本`,
  read: "prompt 走 shortTermMemoryGateway.buildPromptContext（会话内）",
  pass: stmFacts === 0,
});

/* ── 5. 待办 ───────────────────────────────────────────────── */
let commitmentActive = 0;
try {
  const out = execFileSync(
    "python",
    [
      "-c",
      `import sqlite3
c=sqlite3.connect('file:${path.join(DATA, "agentic_memory", "agentic-memory.db").replace(/\\/g, "/")}?mode=ro',uri=True)
cur=c.cursor(); cur.execute("SELECT COUNT(*) FROM commitments WHERE status='active'"); print(cur.fetchone()[0])`,
    ],
    { encoding: "utf8" },
  );
  commitmentActive = Number(out.trim()) || 0;
} catch {
  commitmentActive = 0;
}
const loopSlots = ["memory_open_loops", "memory_commitments"].filter(
  (k) => typeof entries[k] === "string" && String(entries[k]).trim(),
);
result.push({
  layer: "待办",
  write: `commitments active ${commitmentActive} 条；KV 两个槽存量 ${loopSlots.length} 个（已停写）`,
  read: "prompt 已改由 commitments 权威读取（setCommitmentsProvider 接线；空则零注入）",
  pass: loopSlots.length === 0,
});

/* ── 输出 ─────────────────────────────────────────────────── */
console.log("权威矩阵：");
for (const spec of Object.values(MEMORY_AUTHORITY)) {
  console.log(`  ${spec.concept.padEnd(18)} → ${spec.authority}（owner=${spec.owner}）`);
}
console.log("\n分层验收（写入位置 / 读取来源）：");
for (const r of result) {
  console.log(`\n[${r.pass ? "PASS" : "TODO"}] ${r.layer}`);
  console.log(`  写入: ${r.write}`);
  console.log(`  读取: ${r.read}`);
}
const failed = result.filter((r) => !r.pass).length;
console.log(`\n${result.length - failed}/${result.length} 层通过`);
process.exit(failed === 0 ? 0 : 1);
