/**
 * 回复格式黄金集：端到端回放 + 快照回归 + 格式分布统计。
 *
 * 与 eval:routing（eval-display-routing.ts）的分工：
 *   - 那边：两个路由器孤立打分（routeDisplayEffect / classifyRenderHint），
 *     输入是预结构化对象，产出准确率 + 混淆矩阵；
 *   - 这里：完整管线 processAssistantText（文本切片 → 级联优先级 → 标记注入），
 *     输入是 LLM 原始回复文本，快照锁定最终产物——切片规则或级联顺序的任何
 *     改动都会在这里炸出来。
 *
 * 用法：
 *   npm run eval:reply-format                # 校验快照 + 打印格式分布
 *   npm run eval:reply-format -- --update    # 重新生成快照（改格式逻辑后用，
 *                                            # 生成后务必逐条人工审核）
 *   npm run eval:reply-format -- -v          # 逐条明细
 *   npm run eval:reply-format -- --from-capture captures.jsonl
 *                                            # 回放 DISPLAY_ROUTE_CAPTURE 采集的
 *                                            # 线上路由决策，报告 cardType 漂移
 *
 * 线上采集：服务端设置 DISPLAY_ROUTE_CAPTURE=<jsonl路径> 后，每次路由决策
 * （含 fullText）追加落盘；积累到一定量后用 --from-capture 回放，把 agreeing
 * 的真实流量筛选沉淀进 test/fixtures/reply-format-corpus.ts。
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { getToolResultProcessor } from "../src/services/tool-result-processor.js";
import { classifyRenderHint } from "../src/services/render-hint-service.js";
import { buildReplyBlocks } from "../src/services/reply-envelope.js";
import {
  REPLY_FORMAT_CORPUS,
  type ReplyFormatCase,
} from "../test/fixtures/reply-format-corpus.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GOLDEN_PATH = path.join(ROOT, "test/fixtures/golden/reply-format.snapshots.json");

const update = process.argv.includes("--update");
const verbose = process.argv.includes("-v") || process.argv.includes("--verbose");
const captureIdx = process.argv.indexOf("--from-capture");

interface Snapshot {
  /** classifyRenderHint 的提示类型（消息级路由决策） */
  hint: string;
  /** processAssistantText 最终产物（cardId/ts 已归一化） */
  output: string;
  /** 已注入卡片的 cardType（""=通用卡；仅在无卡片标记时为 "" 且 output 不含标记） */
  cardType: string;
}

interface Golden {
  description: string;
  snapshots: Record<string, Snapshot>;
}

/** cardId/ts/summaryId/createdAt 含时间戳或随机数，归一化后快照才稳定 */
function normalize(output: string): string {
  return output
    .replace(/card_\d+_[a-z0-9]+/g, "card_<id>")
    .replace(/"ts":\d+/g, '"ts":<ts>')
    .replace(/sum-[a-z0-9]+-[a-z0-9]+/g, "sum_<id>")
    .replace(/"createdAt":"[^"]*"/g, '"createdAt":"<ts>"');
}

function runCase(c: ReplyFormatCase): Snapshot {
  const processor = getToolResultProcessor();
  const raw = processor.processAssistantText(c.text, {
    plainTextMode: c.plainTextMode,
    userText: c.userText,
    toolName: c.toolName,
    toolResult: c.toolResult,
  });
  const hint = classifyRenderHint(c.text, { toolName: c.toolName, userText: c.userText });
  // cardType 必须在归一化前提取（归一化把 "ts":数字 改成占位符，不再是合法 JSON）
  return { hint: hint.type, output: normalize(raw), cardType: extractCardType(raw) };
}

/** 从产物中提取已注入卡片的 cardType（无卡片返回 ""） */
function extractCardType(output: string): string {
  const m = output.match(
    /\[AGENT_RESULT_CARD_START\]\s*([\s\S]*?)\s*\[AGENT_RESULT_CARD_END\]/,
  );
  if (!m) return "";
  try {
    const payload = JSON.parse(m[1]) as { cardType?: string };
    return payload.cardType ?? "";
  } catch {
    return "<unparsable>";
  }
}

function tallyBy<T>(items: T[], key: (item: T) => string): Map<string, number> {
  const map = new Map<string, number>();
  for (const item of items) {
    map.set(key(item), (map.get(key(item)) ?? 0) + 1);
  }
  return map;
}

function printDistribution(title: string, map: Map<string, number>, total: number): void {
  console.log(`\n== ${title} ==`);
  for (const [k, n] of [...map.entries()].sort((a, b) => b[1] - a[1])) {
    const pct = total === 0 ? 0 : ((n / total) * 100).toFixed(0);
    console.log(`  ${k || "(none)"}: ${n}/${total} (${pct}%)`);
  }
}

function diffLine(expected: string, got: string): string {
  const a = expected.split("\n");
  const b = got.split("\n");
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== b[i]) {
      return `第 ${i + 1} 行不一致:\n  期望: ${JSON.stringify(a[i] ?? "<缺失>")}\n  实际: ${JSON.stringify(b[i] ?? "<缺失>")}`;
    }
  }
  return "无差异";
}

// ─────────────────────────────────────────────────────────────────────────────
// 模式一：--from-capture 线上采集回放
// ─────────────────────────────────────────────────────────────────────────────

interface CaptureEntry {
  ts: string;
  where: string;
  toolName?: string;
  cardType: string;
  fullText: string;
}

function replayCapture(file: string): void {
  const lines = readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim());
  const entries: CaptureEntry[] = [];
  for (const line of lines) {
    try {
      entries.push(JSON.parse(line) as CaptureEntry);
    } catch {
      // 跳过半行/脏行
    }
  }
  if (entries.length === 0) {
    console.log("采集文件为空或全部不可解析。");
    process.exit(1);
  }

  const processor = getToolResultProcessor();
  let agree = 0;
  let drift = 0;
  let noCardNow = 0;
  const drifts: Array<{ ts: string; captured: string; now: string; fullText: string }> = [];
  for (const e of entries) {
    const marked = processor.processAssistantText(e.fullText, {
      toolName: e.toolName,
    });
    const now = extractCardType(marked);
    if (now === e.cardType) {
      agree++;
    } else if (now === "") {
      noCardNow++;
      drifts.push({ ts: e.ts, captured: e.cardType, now: "(no card)", fullText: e.fullText });
    } else {
      drift++;
      drifts.push({ ts: e.ts, captured: e.cardType, now, fullText: e.fullText });
    }
  }
  console.log(
    `回放 ${entries.length} 条线上路由决策：一致 ${agree}，改判 ${drift}，现在不上卡 ${noCardNow}`,
  );
  if (drifts.length > 0) {
    console.log("\n漂移明细（captured → now）：");
    for (const d of drifts.slice(0, verbose ? drifts.length : 10)) {
      console.log(
        `  [${d.ts}] ${d.captured || "(generic)"} → ${d.now} | ${d.fullText.slice(0, 60).replace(/\n/g, "⏎")}…`,
      );
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 模式二：语料快照校验 / 更新
// ─────────────────────────────────────────────────────────────────────────────

function main(): void {
  if (captureIdx !== -1) {
    replayCapture(process.argv[captureIdx + 1] ?? "");
    return;
  }

  const results = REPLY_FORMAT_CORPUS.map((c) => ({ case: c, snap: runCase(c) }));

  // 格式分布统计（命中率反馈回路的离线口径：语料覆盖了哪些形态、各走了什么渲染层）
  printDistribution(
    "消息级路由分布（classifyRenderHint）",
    tallyBy(results, (r) => r.snap.hint),
    results.length,
  );
  const carded = results.filter((r) => r.snap.output.includes("[AGENT_RESULT_CARD_START]"));
  console.log(
    `\n卡片产出率：${carded.length}/${results.length}（${((carded.length / results.length) * 100).toFixed(0)}%）`,
  );
  printDistribution(
    "卡片类型分布（routeDisplayEffect）",
    tallyBy(carded, (r) => r.snap.cardType || "(generic)"),
    carded.length,
  );
  // 回复信封统计：done 时会随 finalText 下发 blocks 的比例（降级口径见 reply-envelope.ts）
  const enveloped = results.filter((r) => buildReplyBlocks(r.snap.output) !== null).length;
  console.log(
    `\n信封下发率：${enveloped}/${results.length}（其余为纯文本或含 v1 未支持标记 → 前端文本解析回退）`,
  );

  if (update) {
    const golden: Golden = {
      description:
        "回复格式黄金快照。由 `npm run eval:reply-format -- --update` 生成；cardId 已归一化。" +
        "更新后必须逐条人工审核是否符合语料 note 声明的意图。",
      snapshots: Object.fromEntries(results.map((r) => [r.case.name, r.snap])),
    };
    mkdirSync(path.dirname(GOLDEN_PATH), { recursive: true });
    writeFileSync(GOLDEN_PATH, JSON.stringify(golden, null, 2) + "\n", "utf8");
    console.log(`\n已写入 ${results.length} 条快照 → ${path.relative(ROOT, GOLDEN_PATH)}`);
    console.log("⚠ 请逐条人工审核新快照是否符合语料 note 声明的意图（快照锁现状，审核锁正确）。");
    return;
  }

  if (!existsSync(GOLDEN_PATH)) {
    console.error("快照文件不存在，先执行: npm run eval:reply-format -- --update");
    process.exit(1);
  }
  const golden = JSON.parse(readFileSync(GOLDEN_PATH, "utf8")) as Golden;

  const missing = REPLY_FORMAT_CORPUS.filter((c) => !golden.snapshots[c.name]);
  const stale = Object.keys(golden.snapshots).filter(
    (name) => !REPLY_FORMAT_CORPUS.some((c) => c.name === name),
  );
  const mismatches = results.filter((r) => {
    const snap = golden.snapshots[r.case.name];
    if (!snap) return false;
    return (
      snap.hint !== r.snap.hint ||
      snap.output !== r.snap.output ||
      snap.cardType !== r.snap.cardType
    );
  });

  if (verbose) {
    console.log("\n== 逐条明细 ==");
    for (const r of results) {
      const hasMarker = r.snap.output.includes("[AGENT_RESULT_CARD_START]");
      const cardLabel = hasMarker ? `card=${r.snap.cardType || "(generic)"}` : "card=-";
      console.log(
        `  ${r.case.name}: hint=${r.snap.hint || "(plain)"} ${cardLabel} out=${r.snap.output.length}字`,
      );
    }
  }

  let failed = false;
  if (missing.length > 0) {
    failed = true;
    console.error(`\n语料中新增 ${missing.length} 条快照缺失: ${missing.map((c) => c.name).join(", ")}`);
  }
  if (stale.length > 0) {
    failed = true;
    console.error(`\n快照中残留 ${stale.length} 条已删除语料: ${stale.join(", ")}`);
  }
  if (mismatches.length > 0) {
    failed = true;
    console.error(`\n${mismatches.length} 条快照不匹配：`);
    for (const r of mismatches) {
      const snap = golden.snapshots[r.case.name];
      console.error(`\n✗ ${r.case.name}（${r.case.note}）`);
      if (snap.hint !== r.snap.hint) {
        console.error(`  hint: ${snap.hint || "(plain)"} → ${r.snap.hint || "(plain)"}`);
      }
      if (snap.cardType !== r.snap.cardType) {
        console.error(`  cardType: ${snap.cardType || "(generic)"} → ${r.snap.cardType || "(generic)"}`);
      }
      if (snap.output !== r.snap.output) {
        console.error(`  output: ${diffLine(snap.output, r.snap.output)}`);
      }
    }
  }

  if (failed) {
    console.error(
      "\n若上述差异是本次改动的预期结果，重新生成并人工审核后提交:\n  npm run eval:reply-format -- --update",
    );
    process.exit(1);
  }
  console.log(`\n✓ 全部 ${results.length} 条快照与黄金集一致。`);
}

main();
