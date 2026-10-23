/**
 * 生产数据召回评测（离线诊断脚本）
 *
 * 与 test/memory-recall-benchmark.test.ts（离线夹具回归基准）互补：
 * 基准回答"检索算法对固定语料是否准"，本脚本回答"线上真实召回质量如何、
 * 仲裁器各通道贡献如何、用户反馈在惩罚什么"——为调整
 * MEMORY_ARBITRATOR_*_WEIGHT / 预筛阈值等参数提供数据依据。
 *
 * 数据源（只读，不写记忆库）：
 * - data/agent-memory-sync.json 的 recall_anchors（每 actor 最近 8 轮注入锚点）
 * - 同文件 memory_strength（反馈强度模型：指纹 → {score, hits}）
 *
 * 运行：cd server && npm run eval:recall
 *   或 npx tsx scripts/eval-memory-recall.ts [memory-sync.json 路径]
 *
 * 输出：控制台报告 + data/recall-eval-latest.json（--no-save 跳过写盘）。
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

import { getDataDir } from "../src/config/data-dir.js";

interface AnchorItem {
  content: string;
  score?: number;
  source?: string;
}

interface AnchorRecord {
  query: string;
  recalledAt: string;
  items: AnchorItem[];
}

interface StrengthEntry {
  score: number;
  hits: number;
  updatedAt: string;
}

interface SessionShape {
  revision?: number;
  entries?: Record<string, unknown>;
}

interface SyncFileShape {
  sessions?: Record<string, SessionShape>;
}

interface ActorEval {
  actorId: string;
  anchors: {
    count: number;
    latestAt: string | null;
    distinctDays: number;
    avgItemsPerTurn: number;
    avgScore: number | null;
    channelHistogram: Record<string, number>;
    topQueries: string[];
  };
  feedback: {
    totalFingerprints: number;
    positive: number;
    negative: number;
    negativeRatio: number | null;
    avgHits: number | null;
  } | null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function evalActor(actorId: string, session: SessionShape): ActorEval {
  const entries = session.entries ?? {};

  const anchorRecords = asArray(entries.recall_anchors)
    .filter((r): r is AnchorRecord => !!r && typeof r === "object")
    .sort((a, b) => String(a.recalledAt).localeCompare(String(b.recalledAt)));

  const channelHistogram: Record<string, number> = {};
  const scores: number[] = [];
  let itemCount = 0;
  const days = new Set<string>();
  for (const record of anchorRecords) {
    const date = String(record.recalledAt ?? "").slice(0, 10);
    if (date) days.add(date);
    for (const item of asArray(record.items)) {
      const it = item as AnchorItem;
      if (!it || typeof it !== "object") continue;
      itemCount += 1;
      if (typeof it.score === "number" && Number.isFinite(it.score)) scores.push(it.score);
      for (const channel of String(it.source ?? "unknown").split(",")) {
        const ch = channel.trim() || "unknown";
        channelHistogram[ch] = (channelHistogram[ch] ?? 0) + 1;
      }
    }
  }

  const anchorsEval: ActorEval["anchors"] = {
    count: anchorRecords.length,
    latestAt: anchorRecords.length > 0 ? anchorRecords[anchorRecords.length - 1]!.recalledAt : null,
    distinctDays: days.size,
    avgItemsPerTurn: anchorRecords.length > 0 ? Number((itemCount / anchorRecords.length).toFixed(2)) : 0,
    avgScore:
      scores.length > 0
        ? Number((scores.reduce((s, x) => s + x, 0) / scores.length).toFixed(4))
        : null,
    channelHistogram,
    topQueries: [...new Set(anchorRecords.map((r) => String(r.query ?? "").trim()).filter(Boolean))].slice(-5),
  };

  let feedback: ActorEval["feedback"] = null;
  const rawStrength = entries.memory_strength as
    | { entries?: Record<string, StrengthEntry> }
    | undefined;
  if (rawStrength && typeof rawStrength === "object" && rawStrength.entries) {
    const list = Object.values(rawStrength.entries).filter(
      (e): e is StrengthEntry => !!e && typeof e === "object" && typeof e.score === "number",
    );
    const negative = list.filter((e) => e.score < 0).length;
    feedback = {
      totalFingerprints: list.length,
      positive: list.filter((e) => e.score > 0).length,
      negative,
      negativeRatio: list.length > 0 ? Number((negative / list.length).toFixed(4)) : null,
      avgHits:
        list.length > 0
          ? Number((list.reduce((s, e) => s + (e.hits ?? 0), 0) / list.length).toFixed(2))
          : null,
    };
  }

  return { actorId, anchors: anchorsEval, feedback };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const saveReport = !args.includes("--no-save");
  const filePath =
    args.find((a) => !a.startsWith("--")) ??
    process.env.AGENT_MEMORY_SYNC_FILE ??
    join(getDataDir(), "agent-memory-sync.json");

  let raw: string;
  try {
    raw = await readFile(filePath, "utf-8");
  } catch (err) {
    console.error(`[eval-recall] 无法读取记忆库文件: ${filePath} (${err})`);
    process.exit(1);
  }

  let data: SyncFileShape;
  try {
    data = JSON.parse(raw) as SyncFileShape;
  } catch (err) {
    console.error(`[eval-recall] 文件不是合法 JSON: ${filePath} (${err})`);
    process.exit(1);
  }

  const sessions = data.sessions ?? {};
  const actorIds = Object.keys(sessions);
  if (actorIds.length === 0) {
    console.log("[eval-recall] 记忆库为空（无 actor）。");
    return;
  }

  const results = actorIds.map((id) => evalActor(id, sessions[id] ?? {}));

  console.log("════════════════════════════════════════════════════════");
  console.log(` 生产数据召回评测 · ${new Date().toISOString()}`);
  console.log(` 数据源: ${filePath} · actor 数: ${actorIds.length}`);
  console.log("════════════════════════════════════════════════════════");

  for (const r of results) {
    console.log(`\n◆ actor: ${r.actorId}`);
    console.log(
      `  召回锚点: ${r.anchors.count} 轮（覆盖 ${r.anchors.distinctDays} 天，最近 ${r.anchors.latestAt ?? "无"}）`,
    );
    console.log(
      `  每轮注入条数: ${r.anchors.avgItemsPerTurn} · 平均融合分: ${r.anchors.avgScore ?? "无"}`,
    );
    const channels = Object.entries(r.anchors.channelHistogram).sort((a, b) => b[1] - a[1]);
    if (channels.length > 0) {
      console.log(`  通道贡献: ${channels.map(([ch, n]) => `${ch}=${n}`).join(" · ")}`);
    }
    if (r.anchors.topQueries.length > 0) {
      console.log("  最近召回 query:");
      for (const q of r.anchors.topQueries) console.log(`    - ${q}`);
    }
    if (r.feedback) {
      console.log(
        `  反馈强度: ${r.feedback.totalFingerprints} 条指纹，负反馈 ${r.feedback.negative}` +
          `（占比 ${r.feedback.negativeRatio ?? "-"}），平均命中 ${r.feedback.avgHits ?? "-"}`,
      );
      if (r.feedback.negativeRatio !== null && r.feedback.negativeRatio > 0.3) {
        console.log("  ⚠ 负反馈占比偏高：检查召回相关性（overlapFactor / 预筛阈值）或写入噪音。");
      }
    } else {
      console.log("  反馈强度: 暂无数据");
    }
    if (r.anchors.count === 0) {
      console.log("  （尚无召回锚点记录：需要线上有触发 recall-gate/预筛的对话轮次）");
    }
  }

  if (saveReport) {
    const outPath = join(getDataDir(), "recall-eval-latest.json");
    try {
      await mkdir(dirname(outPath), { recursive: true });
      await writeFile(
        outPath,
        `${JSON.stringify({ generatedAt: new Date().toISOString(), source: filePath, results }, null, 2)}\n`,
        "utf-8",
      );
      console.log(`\n[eval-recall] 报告已写入 ${outPath}`);
    } catch (err) {
      console.error(`[eval-recall] 报告写盘失败: ${err}`);
    }
  }
}

main().catch((err) => {
  console.error("[eval-recall] 运行失败:", err);
  process.exit(1);
});
