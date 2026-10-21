/**
 * Cross-encoder 式精排（2026-10-19 P1，默认关闭）。
 *
 * 背景：我们的召回在 RRF / 加权融合之后就定序了，没有"让模型逐条判断相关性"
 * 这一层。Zep 的 rerank 阶段用 cross-encoder（或 LLM 打分）把 top-k 再排一遍，
 * 对"语义相近但答非所问"的条目效果明显。
 *
 * 这里实现 LLM 打分版的 cross-encoder：
 *   - 只对已经过融合排序的 **前 N 条** 打分（默认 8 条），成本可控；
 *   - 输出 0-10 的相关性分，按分重排，**不删除任何条目**（宁保留不误删）；
 *   - 任何失败（无 key / 超时 / 解析失败）都原样返回，不影响主链路。
 *
 * 默认关闭：热路径多一次 LLM 调用，收益依赖使用场景，用
 * AGENT_MEMORY_CROSS_ENCODER_RERANK=1 显式开启。
 * 纯函数（buildRerankPrompt / applyRerankScores）单独可测，网络部分薄封装。
 */
import { auditChatCompletion } from "../services/llm-token-audit.js";

export interface RerankCandidate {
  id: string;
  text: string;
}

export interface RerankMessage {
  role: "system" | "user";
  content: string;
}

export function isCrossEncoderRerankEnabled(): boolean {
  return getRerankMode() !== "off";
}

/**
 * 精排模式（2026-10-19）：
 *   - off（默认）：不精排，纯融合排序，零额外延迟；
 *   - always：每轮都精排（旧开关 AGENT_MEMORY_CROSS_ENCODER_RERANK=1 等价于此）；
 *   - adaptive：只在「排序结果模糊/不可信」时精排——这是"既要快又要准"的落点。
 */
export type RerankMode = "off" | "always" | "adaptive";

export function getRerankMode(): RerankMode {
  const raw = process.env.AGENT_MEMORY_RERANK_MODE?.trim().toLowerCase();
  if (raw === "always" || raw === "adaptive" || raw === "off") return raw;
  // 兼容旧开关
  const legacy = process.env.AGENT_MEMORY_CROSS_ENCODER_RERANK?.trim();
  if (legacy === "1" || legacy?.toLowerCase() === "true") return "always";
  return "off";
}

/**
 * 自适应门控（纯函数）：判断这一轮"值不值得多花一次模型调用"。
 *
 * 直觉——精排只在两种情况下有增量：
 *   ① 头部两条咬得很紧（谁先谁后说不准）→ 需要细看；
 *   ② 整体分数都低（召回很虚，可能全是"意思像但没用"的）→ 需要细看。
 * 反过来，top1 明显领先时精排几乎不会改变顺序，纯浪费。
 *
 * @param scores 已按融合分降序排列的候选分（0-1 量纲不一致也没关系，用相对差）
 */
export function shouldRerankAdaptive(scores: number[]): boolean {
  const valid = scores.filter((s) => Number.isFinite(s) && s > 0);
  if (valid.length < 2) return false;
  const top1 = valid[0]!;
  const top2 = valid[1]!;
  // ① 头部差距 <15% → 排序不可靠，值得细看
  const margin = top1 > 0 ? (top1 - top2) / top1 : 0;
  if (margin < 0.15) return true;
  // ② top1 绝对分很低（<0.3）→ 召回整体虚弱，值得细看
  if (top1 < 0.3) return true;
  return false;
}

/** 单次精排最多送几条（超过这个数成本与延迟都不划算） */
export function getCrossEncoderTopN(): number {
  const v = Number.parseInt(process.env.AGENT_MEMORY_CROSS_ENCODER_TOP_N ?? "", 10);
  return Number.isFinite(v) && v > 0 && v <= 32 ? v : 8;
}

const SYSTEM_PROMPT = [
  "你是检索结果的相关性评分器。",
  "给定用户问题和一组候选记忆，为每条候选打 0-10 分：",
  "10=直接回答了问题；6-9=部分相关；1-5=只是主题沾边；0=无关。",
  "注意时间语义：问题问的是过去，就按过去是否相关打分，不要因为候选更「新」就抬高。",
  '只输出 JSON：{"scores":[{"n":序号,"score":分值}]}，不要解释。',
].join("\n");

export function buildRerankPrompt(query: string, candidates: RerankCandidate[]): RerankMessage[] {
  return [
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "user",
      content: JSON.stringify({
        query: query.slice(0, 300),
        candidates: candidates.map((c, i) => ({ n: i, text: c.text.slice(0, 200) })),
      }),
    },
  ];
}

/** 从 LLM 输出里解析分数（容忍围栏/杂文）；解析不出的条目视为未评分 */
export function parseRerankScores(output: string, length: number): Map<number, number> {
  const out = new Map<number, number>();
  const body = output.trim();
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) return out;
  try {
    const parsed = JSON.parse(body.slice(start, end + 1)) as {
      scores?: Array<{ n?: unknown; score?: unknown }>;
    };
    for (const item of parsed.scores ?? []) {
      const n = Number(item?.n);
      const score = Number(item?.score);
      if (!Number.isInteger(n) || n < 0 || n >= length) continue;
      if (!Number.isFinite(score)) continue;
      out.set(n, Math.max(0, Math.min(10, score)));
    }
  } catch {
    /* 解析失败 → 空表，调用方原序返回 */
  }
  return out;
}

/**
 * 按分数重排：已评分的按分数降序，未评分的保持原相对顺序排在后面（不丢）。
 * 分数相同时保留原始顺序（稳定排序）。
 */
export function applyRerankScores<T>(items: T[], scores: Map<number, number>): T[] {
  if (scores.size === 0) return items;
  const scored: Array<{ item: T; score: number; idx: number }> = [];
  const unscored: Array<{ item: T; idx: number }> = [];
  items.forEach((item, idx) => {
    const s = scores.get(idx);
    if (s === undefined) unscored.push({ item, idx });
    else scored.push({ item, score: s, idx });
  });
  scored.sort((a, b) => b.score - a.score || a.idx - b.idx);
  return [...scored.map((s) => s.item), ...unscored.map((u) => u.item)];
}

/** LLM 客户端最小外观（测试注入 fake） */
export interface RerankLlmClient {
  chat: {
    completions: {
      create(args: {
        model: string;
        temperature: number;
        messages: RerankMessage[];
      }): Promise<{ choices?: Array<{ message?: { content?: string } }> }>;
    };
  };
}

export interface RerankDeps {
  client: RerankLlmClient;
  model: string;
}

/* ───────────────── 观测（P0-3）：精排门控的数据闭环 ─────────────────
 * "adaptive 该不该做默认"不能靠感觉，要三个数：
 *   triggerRate（多常触发）/ flipRate（触发后 top1 有没有真被改）/ 延迟增量。
 * flipRate < 5% 说明精排没价值，保持 off；触发率 < 30% 且 flipRate > 10%
 * 说明门控判得准、收益真实，可设默认。进程内累计，重启清零（够 3 天观测用，
 * 不为观测引入持久化）。
 */
interface RerankStats {
  triggered: number;
  skipped: number;
  top1Flipped: number;
  totalLatencyMs: number;
  lastAt: string | null;
}

const rerankStats: RerankStats = {
  triggered: 0,
  skipped: 0,
  top1Flipped: 0,
  totalLatencyMs: 0,
  lastAt: null,
};

export function recordRerankDecision(input: {
  triggered: boolean;
  beforeTop1?: string;
  afterTop1?: string;
  latencyMs?: number;
}): void {
  if (input.triggered) {
    rerankStats.triggered += 1;
    rerankStats.totalLatencyMs += Math.max(0, input.latencyMs ?? 0);
    if (
      input.beforeTop1 !== undefined &&
      input.afterTop1 !== undefined &&
      input.beforeTop1 !== input.afterTop1
    ) {
      rerankStats.top1Flipped += 1;
    }
  } else {
    rerankStats.skipped += 1;
  }
  rerankStats.lastAt = new Date().toISOString();
}

export function getRerankStatsSnapshot(): RerankStats & {
  triggerRate: number | null;
  flipRate: number | null;
  avgLatencyMs: number | null;
} {
  const decisions = rerankStats.triggered + rerankStats.skipped;
  return {
    ...rerankStats,
    triggerRate: decisions > 0 ? rerankStats.triggered / decisions : null,
    flipRate: rerankStats.triggered > 0 ? rerankStats.top1Flipped / rerankStats.triggered : null,
    avgLatencyMs:
      rerankStats.triggered > 0 ? Math.round(rerankStats.totalLatencyMs / rerankStats.triggered) : null,
  };
}

/** 仅测试用 */
export function resetRerankStatsForTests(): void {
  rerankStats.triggered = 0;
  rerankStats.skipped = 0;
  rerankStats.top1Flipped = 0;
  rerankStats.totalLatencyMs = 0;
  rerankStats.lastAt = null;
}

/**
 * 执行精排：失败/未启用时返回原数组（顺序不变），调用方无需判空。
 */
export async function rerankCandidates<T extends RerankCandidate>(
  query: string,
  items: T[],
  deps: RerankDeps,
): Promise<T[]> {
  if (items.length <= 1) return items;
  const topN = Math.min(getCrossEncoderTopN(), items.length);
  const head = items.slice(0, topN);
  try {
    const promptMessages = buildRerankPrompt(query, head);
    const res = await deps.client.chat.completions.create({
      model: deps.model,
      temperature: 0,
      messages: promptMessages,
    });
    auditChatCompletion({
      stage: "memory_rerank",
      messages: promptMessages,
      completion: res,
      model: deps.model,
    });
    const content = res.choices?.[0]?.message?.content?.trim() ?? "";
    if (!content) return items;
    const scores = parseRerankScores(content, head.length);
    if (scores.size === 0) return items;
    const reorderedHead = applyRerankScores(head, scores);
    return [...reorderedHead, ...items.slice(topN)];
  } catch {
    return items;
  }
}
