/**
 * 思考档位策略层（2026-11-12）：跨 provider 通用 + 运行时动态适配。
 *
 * ## 为什么需要这一层
 *
 * 各家对「不下发思考档位」的默认处理完全不同，而且不写在文档里：
 *   - 智谱 GLM-5.3：不下发 = **比 high 更深的自动思考**（实测 511-634 reasoning
 *     tokens、首字 14.8-18.4s；显式 high 只要 0-47 tokens、首字 0.8-2.6s）
 *   - DeepSeek：不下发 = high（官方默认，不是坑）
 *   - OpenAI GPT-5.x：不下发 = medium
 * 同一个「不下发」，有的亏 10 倍延迟，有的不亏——靠人工逐个查文档、逐个实测，
 * 换模型就要重来一遍，这正是 2026-10-07 那次「换模型只改档案」想解决、
 * 但当时只解决了「关思考」没解决「开思考」的那半个问题。
 *
 * ## 这层做三件事
 *
 * 1. **统一出口**：任何 provider 的「思考开启」都必须经过 {@link resolveThinkingEffort}，
 *    拿一个显式档位；策略层永不返回 `undefined`（除非调用方明确声明该模型无档位）。
 * 2. **运行时学习**：{@link recordThinkingLatency} 按 (provider, model, 档位) 收集
 *    首字延迟样本，滑动窗口内算 P50/P90。不预判任何新模型——数据自己说话。
 * 3. **延迟预算选档**：有足够样本后，在「延迟预算」内选**质量最高的可用档位**
 *    （max > high > low）。预算内 high 能用就用 high；只有 high 的 P50 超出预算
 *    2 倍、且 low 能在预算内完成时才降档。降档是例外，不是常态——思考质量是
 *    用户明确要求保住的东西。
 *
 * ## 有意不做的事
 *
 * - 不自动升到 max：升档要牺牲延迟，属于用户/任务的显式选择（env 覆盖）。
 * - 不做跨模型归一化比较：不同模型的 TTFT 基线不可比，只在同模型同档位内统计。
 * - 不在热路径写盘：样本进内存，debounce 惰性落盘。
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { getDataDir } from "../config/data-dir.js";

export type ThinkingEffort = "low" | "high" | "max";

/** 实际下发过的档位；"none" = 一个档位都没发（历史行为，用于诊断对比）。 */
export type SentEffort = ThinkingEffort | "none";

export type ThinkingEffortResolution = {
  effort: ThinkingEffort;
  /** default = 无样本时的保守默认；learned = 依据历史延迟样本选出；env = 显式配置覆盖 */
  source: "default" | "learned" | "env";
  /** 命中的延迟预算（ms），便于日志归因 */
  budgetMs: number;
};

/** 滑动窗口大小：每个 (model, effort) 桶保留最近 N 次样本。 */
const WINDOW_SIZE = 12;
/** 判定「有统计意义」的最小样本数。 */
const MIN_SAMPLES = 3;
/** 默认首字预算：思考 + prefill + 排队的总等待上限。 */
const DEFAULT_BUDGET_MS = 4000;
/** 降档门槛：high 的 P50 要超出预算这么多倍，才认为它「确实太重」。 */
const DOWNGRADE_FACTOR = 2;

/** 质量优先级：max > high > low。数值越大越优先保留。 */
const EFFORT_RANK: Record<ThinkingEffort, number> = { low: 0, high: 1, max: 2 };

type ModelStats = {
  /** effort -> 最近 TTFT 样本（ms） */
  buckets: Record<string, number[]>;
  updatedAt: number;
};

const stats = new Map<string, ModelStats>();
let loaded = false;
let saveTimer: NodeJS.Timeout | null = null;

function statsFile(): string {
  return join(getDataDir(), "thinking-effort-stats.json");
}

/**
 * 统计键只用模型名，不带 providerId。
 *
 * 原因：同一模型可能经不同路径调用（provider 直连 / tool-loop 内部 / 裸 SDK 旁路），
 * 各自拿到的 providerId 不同（tool-loop 里恒为 "openai-compatible"）。按 providerId
 * 分桶会让「provider 层写样本、循环层读不到」——学了个寂寞。模型名在项目内唯一，
 * 用它做主键，任何调用路径写进来的样本都能被同一张曲线消费。
 */
function modelKey(_providerId: string, model: string): string {
  return model.trim().toLowerCase();
}

function ensureLoaded(): void {
  if (loaded) return;
  loaded = true;
  try {
    const file = statsFile();
    if (!existsSync(file)) return;
    const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, ModelStats>;
    for (const [key, value] of Object.entries(raw)) {
      if (!value || typeof value !== "object") continue;
      const buckets: Record<string, number[]> = {};
      for (const [effort, samples] of Object.entries(value.buckets ?? {})) {
        if (!Array.isArray(samples)) continue;
        const clean = samples.filter((n) => Number.isFinite(n) && n > 0).slice(-WINDOW_SIZE);
        if (clean.length > 0) buckets[effort] = clean;
      }
      if (Object.keys(buckets).length > 0) {
        stats.set(key, { buckets, updatedAt: value.updatedAt ?? Date.now() });
      }
    }
  } catch {
    // 统计文件损坏不影响主链路：当作空表重新学习
  }
}

function scheduleSave(): void {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      const dir = getDataDir();
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(statsFile(), JSON.stringify(Object.fromEntries(stats), null, 2), "utf8");
    } catch {
      // 落盘失败只影响下次启动的初始样本，不影响本次运行
    }
  }, 5_000);
  saveTimer.unref?.();
}

function percentile(samples: number[], p: number): number {
  if (samples.length === 0) return Number.NaN;
  const sorted = [...samples].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

/** 记录一次真实请求的首字延迟，供后续选档使用。热路径安全：纯内存 + 惰性落盘。 */
export function recordThinkingLatency(input: {
  providerId: string;
  model: string;
  effortSent: SentEffort;
  ttftMs: number;
}): void {
  const { providerId, model, effortSent, ttftMs } = input;
  if (!Number.isFinite(ttftMs) || ttftMs <= 0) return;
  ensureLoaded();
  const key = modelKey(providerId, model);
  let entry = stats.get(key);
  if (!entry) {
    entry = { buckets: {}, updatedAt: Date.now() };
    stats.set(key, entry);
  }
  const bucket = entry.buckets[effortSent] ?? [];
  bucket.push(Math.round(ttftMs));
  entry.buckets[effortSent] = bucket.slice(-WINDOW_SIZE);
  entry.updatedAt = Date.now();
  scheduleSave();
}

/** 读当前统计（诊断/日志用，不参与决策）。 */
export function snapshotThinkingStats(): Record<string, Record<string, { p50: number; p90: number; n: number }>> {
  ensureLoaded();
  const out: Record<string, Record<string, { p50: number; p90: number; n: number }>> = {};
  for (const [key, entry] of stats.entries()) {
    out[key] = {};
    for (const [effort, samples] of Object.entries(entry.buckets)) {
      out[key][effort] = {
        p50: Math.round(percentile(samples, 50)),
        p90: Math.round(percentile(samples, 90)),
        n: samples.length,
      };
    }
  }
  return out;
}

/**
 * 清空学习结果（测试与「模型换代后重新学习」用）。
 */
export function resetThinkingStatsForTest(): void {
  stats.clear();
  loaded = true;
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
}

function resolveBudget(envName: string | undefined, fallback: number): number {
  const raw = envName ? process.env[envName]?.trim() : undefined;
  const n = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n >= 500 ? n : fallback;
}

/**
 * 解析本次请求该下发的思考档位。
 *
 * 优先级：显式 env 覆盖 > 历史样本选档 > 默认 high。
 * 返回值一定是显式档位——调用方不得再把它变成「不下发」。
 *
 * @param providerId   provider 标识（统计分桶用）
 * @param model        模型名（统计分桶用）
 * @param opts.envOverride  该 provider 的档位覆盖环境变量名（如 ZHIPU_REASONING_EFFORT）
 * @param opts.budgetMs     首字延迟预算；不传走 provider 环境变量或全局默认
 */
export function resolveThinkingEffort(
  providerId: string,
  model: string,
  opts: {
    /** 显式档位环境变量名；值非法时忽略。 */
    envOverride?: string;
    /** 该 provider 的预算环境变量名（如 ZHIPU_THINKING_BUDGET_MS）。 */
    budgetEnv?: string;
    /** 调用方直接给预算（优先级高于环境变量）。 */
    budgetMs?: number;
    /** 无样本时的默认档（默认 high）。 */
    fallback?: ThinkingEffort;
  } = {},
): ThinkingEffortResolution {
  const budgetMs =
    Number.isFinite(opts.budgetMs) && (opts.budgetMs ?? 0) > 0
      ? (opts.budgetMs as number)
      : resolveBudget(opts.budgetEnv, DEFAULT_BUDGET_MS);

  const rawEnv = opts.envOverride ? process.env[opts.envOverride]?.trim().toLowerCase() : "";
  if (rawEnv && rawEnv in EFFORT_RANK) {
    return { effort: rawEnv as ThinkingEffort, source: "env", budgetMs };
  }

  const fallback = opts.fallback ?? "high";
  ensureLoaded();
  const entry = stats.get(modelKey(providerId, model));
  if (!entry) return { effort: fallback, source: "default", budgetMs };

  const measured = (effort: ThinkingEffort): { p50: number; p90: number; n: number } | null => {
    const samples = entry.buckets[effort];
    if (!samples || samples.length < MIN_SAMPLES) return null;
    return { p50: percentile(samples, 50), p90: percentile(samples, 90), n: samples.length };
  };

  const high = measured("high");
  const low = measured("low");

  // 预算内 high 扛得住 → 保留 full 思考（质量优先，这也是用户的明确要求）。
  if (high && high.p90 <= budgetMs) {
    return { effort: "high", source: "learned", budgetMs };
  }
  // high 明显过重，且 low 确实能进预算 → 降到 low，把「闲聊秒回」拉回来。
  if (high && low && high.p50 > budgetMs * DOWNGRADE_FACTOR && low.p90 <= budgetMs) {
    return { effort: "low", source: "learned", budgetMs };
  }
  // 样本不足或介于两者之间：维持默认档，宁可慢也不悄悄降质量。
  return { effort: fallback, source: high ? "learned" : "default", budgetMs };
}

/**
 * 诊断：某模型是否存在「不下发档位反而更慢」的证据。
 *
 * 用于把「这个模型默认是 auto 深度思考」这类隐性事实变成日志/告警，
 * 而不是等用户觉得慢再人肉排查。返回 null = 样本不足或没有异常。
 */
export function diagnoseImplicitEffortTrap(
  providerId: string,
  model: string,
): { noneP50: number; explicitP50: number; ratio: number } | null {
  ensureLoaded();
  const entry = stats.get(modelKey(providerId, model));
  if (!entry) return null;
  const none = entry.buckets["none"];
  const explicit = entry.buckets["high"] ?? entry.buckets["low"];
  if (!none || !explicit || none.length < MIN_SAMPLES || explicit.length < MIN_SAMPLES) return null;
  const noneP50 = percentile(none, 50);
  const explicitP50 = percentile(explicit, 50);
  if (!Number.isFinite(noneP50) || !Number.isFinite(explicitP50) || explicitP50 <= 0) return null;
  const ratio = noneP50 / explicitP50;
  return ratio >= 1.5
    ? { noneP50, explicitP50, ratio: Number(ratio.toFixed(2)) }
    : null;
}

/** 从实际下发的 extraBody 反推本次用了哪一档（"none" = 一个都没发）。 */
export function effortSentFrom(extraBody?: Record<string, unknown> | null): SentEffort {
  const raw = extraBody?.["reasoning_effort"];
  const v = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  return v === "low" || v === "high" || v === "max" ? (v as ThinkingEffort) : "none";
}

export type ThinkingBudgetModelHealth = {
  model: string;
  /** 各档位的延迟分布（P50/P90/样本数）；无样本的档位不出现。 */
  efforts: Record<string, { p50: number; p90: number; n: number }>;
  /** 非空 = 该模型「不下发档位」明显比显式档位慢（GLM 式隐性陷阱）。 */
  implicitEffortTrap: { noneP50: number; explicitP50: number; ratio: number } | null;
};

/**
 * 健康检查快照：按最近活跃排序，返回前 limit 个模型的档位曲线 + 隐性陷阱诊断。
 *
 * 只读内存，无 IO、无副作用——`/health` 会被客户端高频轮询，这里必须廉价。
 */
export function buildThinkingBudgetHealth(limit = 8): {
  models: ThinkingBudgetModelHealth[];
  totalModels: number;
} {
  ensureLoaded();
  const entries = [...stats.entries()].sort((a, b) => b[1].updatedAt - a[1].updatedAt);
  const models: ThinkingBudgetModelHealth[] = [];
  for (const [model, entry] of entries.slice(0, Math.max(1, limit))) {
    const efforts: Record<string, { p50: number; p90: number; n: number }> = {};
    for (const [effort, samples] of Object.entries(entry.buckets)) {
      if (samples.length === 0) continue;
      efforts[effort] = {
        p50: Math.round(percentile(samples, 50)),
        p90: Math.round(percentile(samples, 90)),
        n: samples.length,
      };
    }
    if (Object.keys(efforts).length === 0) continue;
    models.push({
      model,
      efforts,
      implicitEffortTrap: diagnoseImplicitEffortTrap("", model),
    });
  }
  return { models, totalModels: stats.size };
}

/**
 * 启动摘要：一行日志说明「学习到了什么、有没有隐性陷阱」。
 *
 * 设计意图：换模型后不必等用户抱怨，启动时就能看到该模型的历史延迟曲线；
 * 检测到隐性陷阱（不下发反而更慢）时用 warn 级别提示，便于巡检发现。
 */
export function describeThinkingBudgetForStartup(): {
  line: string;
  traps: Array<{ model: string; ratio: number; noneP50: number; explicitP50: number }>;
} {
  const health = buildThinkingBudgetHealth(6);
  if (health.models.length === 0) {
    return {
      line: "[thinking-budget] 暂无历史延迟样本（首次运行或统计文件为空），本次按默认档 high 起步",
      traps: [],
    };
  }
  const parts = health.models.map((m) => {
    const high = m.efforts["high"];
    const low = m.efforts["low"];
    const seg: string[] = [];
    if (high) seg.push(`high p50=${high.p50}ms p90=${high.p90}ms n=${high.n}`);
    if (low) seg.push(`low p50=${low.p50}ms n=${low.n}`);
    if (seg.length === 0) seg.push(`档位样本=${Object.keys(m.efforts).join("/")}`);
    return `${m.model}(${seg.join(", ")})`;
  });
  const traps = health.models
    .filter((m) => m.implicitEffortTrap)
    .map((m) => ({
      model: m.model,
      ratio: Number((m.implicitEffortTrap!.ratio).toFixed(2)),
      noneP50: m.implicitEffortTrap!.noneP50,
      explicitP50: m.implicitEffortTrap!.explicitP50,
    }));
  return {
    line: `[thinking-budget] 已加载 ${health.totalModels} 个模型的档位曲线：${parts.join("；")}`,
    traps,
  };
}

/** 初始化（幂等）：启动时调用一次即可把历史样本读进内存。 */
export function initThinkingBudget(): void {
  ensureLoaded();
}
