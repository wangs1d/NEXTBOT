/**
 * dreaming 过滤效果模拟（2026-11-12）
 *
 * 用真实 journal 回放：同一批行，分别按「旧规则（只滤寒暄）」与「新规则
 * （助手自述/纯问句/一次性提醒一律不固化）」计算会写入长期记忆的条数，
 * 并给出保留样本与被拒样本——回答"过滤得掉噪音、固化得住有用记忆"。
 *
 * 运行：cd server && npx tsx scripts/simulate-dreaming-filter.ts [actorId]
 */
import fs from "node:fs";
import path from "node:path";

import {
  isNoiseLogLine,
  shouldSolidifyJournalLine,
} from "../src/services/nightly-memory-task-service.js";
import { sanitizeJournalText } from "../src/services/daily-journal-service.js";

const DATA = path.resolve(process.cwd(), "data");
const ACTOR = process.argv[2] ?? "2378709729@qq.com";
const dir = path.join(DATA, "journal", ACTOR);

const LINE_RE = /^- \[(\d{2}:\d{2})\]\s*(.*)$/;
const ROLE_RE = /^(?:(\S+)\s+)?(U|A|fact|prefer|commit):\s*(.+)$/;

if (!fs.existsSync(dir)) {
  console.error(`journal 目录不存在: ${dir}`);
  process.exit(1);
}

type Row = { date: string; role: string; content: string };
const rows: Row[] = [];
for (const file of fs.readdirSync(dir).filter((f) => f.startsWith("journal-") && f.endsWith(".md"))) {
  const date = file.replace(/^journal-|\.md$/g, "");
  for (const raw of fs.readFileSync(path.join(dir, file), "utf8").split("\n")) {
    const m = LINE_RE.exec(raw);
    if (!m) continue;
    const roleMatch = ROLE_RE.exec(m[2]!);
    if (!roleMatch) continue;
    rows.push({ date, role: roleMatch[2]!, content: roleMatch[3]!.trim() });
  }
}

// 旧规则：只滤寒暄，A 行照写
const oldKept = rows.filter((r) => !isNoiseLogLine(r.role, r.content));
// 新规则：助手自述/纯问句/一次性提醒都不固化
const verdicts = rows.map((r) => ({ ...r, verdict: shouldSolidifyJournalLine(r.role, r.content) }));
const newKept = verdicts.filter((v) => v.verdict.solidify);

// 内容级去重（同一句可能同时落 U 行与 prefer 行）：与固化链路一致
const norm = (s: string) => s.replace(/\s+/g, "").replace(/[，。！？!?、；;,.]/g, "").toLowerCase();
const seenContent = new Set<string>();
const dedupedKept = newKept.filter((r) => {
  const key = norm(r.content);
  if (seenContent.has(key)) return false;
  seenContent.add(key);
  return true;
});

const byReason: Record<string, number> = {};
for (const v of verdicts) byReason[v.verdict.reason] = (byReason[v.verdict.reason] ?? 0) + 1;

// 同日同轮重复（新增去重能拦掉的部分）
const fpSeen = new Map<string, number>();
for (const r of rows) {
  if (r.role !== "U") continue;
  const key = `${r.date}|${r.content}`;
  fpSeen.set(key, (fpSeen.get(key) ?? 0) + 1);
}
const dupPairs = [...fpSeen.values()].filter((n) => n > 1);
const dupExtra = dupPairs.reduce((n, c) => n + (c - 1), 0);

console.log(`actor: ${ACTOR} | journal 文件: ${fs.readdirSync(dir).filter((f) => f.startsWith("journal-")).length}`);
console.log(`总行数: ${rows.length}`);
console.log(`旧规则会固化: ${oldKept.length} 行（含助手自述 ${oldKept.filter((r) => r.role === "A").length} 行）`);
console.log(`新规则会固化: ${newKept.length} 行 → 内容去重后 ${dedupedKept.length} 行`);
console.log(`跳过分布: ${JSON.stringify(byReason)}`);
console.log(`同日重复用户句: ${dupPairs.length} 组，多出 ${dupExtra} 行（新去重拦掉）`);

const pct = (n: number) => `${((n / Math.max(rows.length, 1)) * 100).toFixed(0)}%`;
console.log(
  `助手自述占比: 旧 ${pct(oldKept.filter((r) => r.role === "A").length)} → 新 ${pct(
    newKept.filter((r) => r.role === "A").length,
  )}`,
);

console.log("\n【保留样本（会进长期记忆）】");
for (const r of dedupedKept.slice(0, 30)) {
  console.log(`  ${r.date} ${r.role}: ${sanitizeJournalText(r.content).slice(0, 60)}`);
}

console.log("\n【被拒样本（旧规则会当记忆，新规则拒绝）】");
const rejected = verdicts.filter((v) => !v.verdict.solidify && isNoiseLogLine(v.role, v.content) === false);
for (const r of rejected.slice(0, 12)) {
  console.log(`  [${r.verdict.reason}] ${r.date} ${r.role}: ${r.content.slice(0, 60)}`);
}
