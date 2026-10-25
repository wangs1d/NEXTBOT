#!/usr/bin/env tsx
/**
 * 存量记忆污染修复（2026-10-23）
 *
 * 修的是什么（读取侧已能自净，本脚本清库让数据本身也干净）：
 *   1. `memory_summary` / `session_recap` / `memory_summary_forgotten` 里的
 *      **无日期逐字对话行**（`[11:15] Agent: …` / `[17:36] 用户: …`）、
 *      `[Agent 承诺/结论]` 原话残句、`[RENDER_HINT:…]` 出口协议残留；
 *   2. `session_epitome` 里的**流程元数据**（`用户问：…（路由：direct）`、
 *      `委派子 Agent 处理：…`）——它们不是用户待办，却被当"上一会话待办"注入。
 *
 * 为什么必须清：注入侧（memory-line-hygiene）只保证"脏行不进上下文"，
 * 但库里的脏行还会被别的读取方（诊断、导出、二次抽取）看到，并持续产生
 * 相似脏数据。写入侧（ltm-write-gate）已补洞，不再新增。
 *
 * 用法：
 *   tsx scripts/repair-memory-pollution.ts              # 干跑：只出报告
 *   tsx scripts/repair-memory-pollution.ts --apply      # 写回（自动备份）
 *   tsx scripts/repair-memory-pollution.ts --actor=xxx  # 只处理某个 actor
 */
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { isPollutedMemoryLine } from "../src/agent/memory-line-hygiene.js";
import { sanitizeThreadPollution } from "../src/external-model/chat-thread-pollution.js";

type EpitomeEntry = { text?: string; createdAt?: string } | string;

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.PA_DATA_DIR?.trim() || join(SCRIPT_DIR, "..", "data");
const MEMORY_FILE = join(DATA_DIR, "agent-memory-sync.json");
const THREAD_FILE = join(DATA_DIR, "chat-threads.json");
const NOTES_THREAD_FILE = join(DATA_DIR, "chat-threads-notes.json");

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const ACTOR_FILTER = args.find((a) => a.startsWith("--actor="))?.slice("--actor=".length).trim() || "";

const MEMORY_LINE_KEYS = ["memory_summary", "session_recap", "memory_summary_forgotten"] as const;

/** epitome 里的流程元数据（不是用户待办） */
const EPITOME_JUNK_RE = [
  /^用户问：/,
  /^委派子\s*Agent\s*处理：/,
  /（路由[:：][^）]*）/,
  /^\[?(?:direct|tool_loop|fast_chat|task)\]?\s*$/i,
];

function isJunkEpitomeEntry(entry: EpitomeEntry): boolean {
  const text = typeof entry === "string" ? entry : entry?.text ?? "";
  const t = text.trim();
  if (!t) return true;
  if (EPITOME_JUNK_RE.some((re) => re.test(t))) return true;
  // 纯路由/执行回执（无具体事项内容）
  if (/^(?:用户问|委派子 ?Agent 处理)[:：]/.test(t)) return true;
  return false;
}

type Report = {
  actorId: string;
  key: string;
  removed: number;
  samples: string[];
};

function repair(): void {
  if (!existsSync(MEMORY_FILE)) {
    console.error(`未找到记忆文件：${MEMORY_FILE}`);
    process.exit(1);
  }
  const raw = JSON.parse(readFileSync(MEMORY_FILE, "utf8")) as {
    sessions?: Record<string, { revision?: number; entries?: Record<string, unknown> }>;
  };
  const sessions = raw.sessions ?? {};
  const reports: Report[] = [];
  let touchedActors = 0;

  for (const [actorId, session] of Object.entries(sessions)) {
    if (ACTOR_FILTER && actorId !== ACTOR_FILTER) continue;
    const entries = session?.entries;
    if (!entries) continue;
    let actorTouched = false;

    // 1) KV 记忆行
    for (const key of MEMORY_LINE_KEYS) {
      const value = entries[key];
      if (typeof value !== "string" || !value) continue;
      const lines = value.split("\n");
      const kept = lines.filter((line) => !isPollutedMemoryLine(line));
      const removed = lines.length - kept.length;
      if (removed === 0) continue;
      reports.push({
        actorId,
        key,
        removed,
        samples: lines.filter((line) => isPollutedMemoryLine(line)).slice(0, 3),
      });
      entries[key] = kept.join("\n");
      actorTouched = true;
    }

    // 2) session_epitome（openLoops / commitments / preferences）
    const epitome = entries["session_epitome"];
    if (epitome && typeof epitome === "object") {
      const e = epitome as Record<string, unknown>;
      for (const kind of ["openLoops", "commitments", "preferences"] as const) {
        const list = e[kind];
        if (!Array.isArray(list)) continue;
        const kept = (list as EpitomeEntry[]).filter((x) => !isJunkEpitomeEntry(x));
        const removed = list.length - kept.length;
        if (removed === 0) continue;
        reports.push({
          actorId,
          key: `session_epitome.${kind}`,
          removed,
          samples: (list as EpitomeEntry[])
            .filter((x) => isJunkEpitomeEntry(x))
            .slice(0, 3)
            .map((x) => (typeof x === "string" ? x : x?.text ?? "")),
        });
        e[kind] = kept;
        actorTouched = true;
      }
    }

    if (actorTouched) touchedActors++;
  }

  if (reports.length === 0) {
    console.log(`[repair-memory] 无污染行（file=${MEMORY_FILE}）`);
  } else {
    console.log(`[repair-memory] ${APPLY ? "写入" : "干跑"} file=${MEMORY_FILE}`);
    for (const r of reports) {
      console.log(`  · ${r.actorId} :: ${r.key} → 剔除 ${r.removed} 条`);
      for (const s of r.samples) console.log(`      - ${s.slice(0, 90)}`);
    }
    console.log(`[repair-memory] 涉及 actor=${touchedActors}，共 ${reports.length} 个字段`);
    if (!APPLY) {
      console.log("[repair-memory] 干跑结束。确认无误后加 --apply 写回（会自动备份）。");
    } else {
      const backup = `${MEMORY_FILE}.bak-pre-pollution-repair-${new Date().toISOString().slice(0, 10)}`;
      copyFileSync(MEMORY_FILE, backup);
      writeFileSync(MEMORY_FILE, JSON.stringify(raw, null, 2) + "\n", "utf8");
      console.log(`[repair-memory] 已写回，备份：${backup}`);
    }
  }

  // 线程正文：内部子调用泄漏 + 相邻重复用户消息（「重复设置/重复回复」根因）
  repairThreadFile(THREAD_FILE);
  repairThreadFile(NOTES_THREAD_FILE);
}

/**
 * 线程文件清洗（服务启动时也会自动做一次，这里用于不重启也能立刻修）。
 * ⚠️ 服务运行中执行会被内存态覆盖 —— 建议先停服务再 --apply。
 */
function repairThreadFile(path: string): void {
  if (!existsSync(path)) return;
  const raw = JSON.parse(readFileSync(path, "utf8")) as {
    sessions?: Record<string, { updatedAt?: string; messages?: unknown[] }>;
  };
  const sessions = raw.sessions ?? {};
  let touched = 0;
  let totalInternal = 0;
  let totalDup = 0;
  for (const [sid, row] of Object.entries(sessions)) {
    if (ACTOR_FILTER && sid !== ACTOR_FILTER) continue;
    const messages = row?.messages;
    if (!Array.isArray(messages) || messages.length === 0) continue;
    const r = sanitizeThreadPollution(messages);
    if (r.removedInternalCalls === 0 && r.removedDuplicateUserTurns === 0) continue;
    touched++;
    totalInternal += r.removedInternalCalls;
    totalDup += r.removedDuplicateUserTurns;
    console.log(
      `  · [thread] ${sid} → 内部子调用 ${r.removedInternalCalls} 轮 / ` +
        `重复用户消息 ${r.removedDuplicateUserTurns} 条（${messages.length} → ${r.messages.length}）`,
    );
    row.messages = r.messages;
    row.updatedAt = new Date().toISOString();
  }
  if (touched === 0) {
    console.log(`[repair-thread] 无线程污染（file=${path}）`);
    return;
  }
  console.log(
    `[repair-thread] ${APPLY ? "写入" : "干跑"} file=${path} 会话 ${touched} 个，` +
      `内部子调用 ${totalInternal} 轮 / 重复用户消息 ${totalDup} 条`,
  );
  if (!APPLY) {
    console.log("[repair-thread] 干跑结束。--apply 前请先停止服务（运行中会被内存态覆盖）。");
    return;
  }
  const backup = `${path}.bak-pre-pollution-repair-${new Date().toISOString().slice(0, 10)}`;
  copyFileSync(path, backup);
  writeFileSync(path, JSON.stringify(raw, null, 2) + "\n", "utf8");
  console.log(`[repair-thread] 已写回，备份：${backup}`);
}

repair();
