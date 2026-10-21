import { appendFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { recordBudgetUsage } from "./llm-budget-guard.js";

/**
 * LLM token 用量审计。
 *
 * 在统一的 LLM 推理入口打点，按「环节」（stage）聚合输入/输出 token 估算，
 * 用于量化一次对话的 token 消耗分布，找出占比最大的环节。
 * - 输出：内存聚合快照 + 落盘 NDJSON（data/llm-token-audit.ndjson），零性能影响（纯估算、异步写盘）
 * - 估算公式与 chat-thread-store 保持一致：中文按 1.5 token/字，英文按 0.25 token/词
 */

export type LlmAuditStage =
  /** 主对话回复（非工具分支，单次请求） */
  | "main_chat"
  /** 主对话工具循环（每次 LLM round 记一条） */
  | "main_chat_tools"
  /** 情绪推断（每轮用户消息异步触发一次） */
  | "mood_inference"
  /** 记忆写决策（启发式不置信时兜底调用 LLM） */
  | "memory_write_decision"
  /** 低信号记忆批次摘要（flush 时） */
  | "memory_flush_summarize"
  /** 对话承诺自动提取（方案 C：ingest 写入钩子旁路 LLM） */
  | "commitment_extract"
  /** 统一结构化抽取（P1-6：决策+记忆+承诺+纠正 单次调用） */
  | "memory_unified_extract"
  /** 记忆库 LLM 定期审查（lifecycle：过时/矛盾/冗余 → 归档） */
  | "memory_llm_review"
  /** 记忆召回结果压缩（超阈值时） */
  | "recall_compress"
  /** 对话滚动摘要 / recap 增强（历史被 trim 丢弃时） */
  | "rolling_summary"
  /** 用户画像深度合成 */
  | "user_profile_aggregate"
  /** 用户画像每轮结构化抽取 */
  | "user_profile_extract"
  /** 用户兴趣识别 / 监控 */
  | "interest_watch"
  /** 主动意图生成（ProactivityHub） */
  | "proactive_intent"
  | "proactive_act_loop"
  /** 主动话术生成（内容型场景：行程变化/消息来临 → LLM 生成主动回复） */
  | "proactive_phrase"
  /** 自我进化 / 自动能力迭代 */
  | "self_evolution"
  /** 代码修复 */
  | "code_repair"
  /** 任务面后台任务（首轮：轻量档） */
  | "task_plane_fast"
  /** 复杂任务显式规划轮（2026-10-21 单列归因：紧凑 system + 无工具 schema） */
  | "task_plane_plan"
  /** goal 计划步骤派发的后台任务（2026-10-01 单列归因：主动性执行成本可见） */
  | "goal_plan_stage"
  /** 任务面后台任务（升级段/完整通道） */
  | "task_plane_complex"
  /** 夜间单遍巩固器（P1：事实提升 + 新行留存评分一次调用） */
  | "nightly_unified"
  /**
   * 工具结果压缩打点（2026-09-17 WP0：非 LLM 调用，记压缩前/后规模）。
   * 约定：inputChars/outputChars = 压缩前/压缩后字符（inputTokens/outputTokens
   * 为同系数折算），toolName 标明来源工具。用于量化 compactToolOutputForLlm 主干道的
   * 每工具节省率（scripts/analyze-token-audit.mjs 按此聚合）。
   */
  | "tool_result_compaction"
  /**
   * 以下 11 项为 2026-10-21 补埋点：此前这些模块自行 new OpenAI 直接 create，
   * 从未计入审计，是占比分析的系统性盲区（真实消耗恒为 0）。
   */
  /** 灵魂档案周更（agent/soul-store.ts） */
  | "soul_store"
  /** 记忆检索精排（agentic-memory/reranker.ts、rerank-cross-encoder.ts，LLM 档） */
  | "memory_rerank"
  /** 记忆联想合成（brain/memory-cognitive/memory-association-synthesizer.ts） */
  | "memory_association"
  /** 睡眠/夜间记忆整理（services/human-like-memory-service.ts 三处） */
  | "sleep_agent"
  /** 夜间记忆任务（services/nightly-memory-task-service.ts） */
  | "nightly_task"
  /** 语音对话 LLM（services/voice-dialogue/adapters/openai-llm-adapter.ts） */
  | "voice_llm"
  /** 行程规划技能（skills/travel-planning/*） */
  | "travel_plan"
  /**
   * 视觉类四项（含 base64 图片）：inputChars 只统计文本部分，
   * 图片 token 不计入 —— 这类记录「调用次数 + 文本规模」可见，但 token 偏低估。
   */
  | "vision_presence"
  | "vision_caption"
  | "vision_photo"
  | "vision_product"
  /** 其他（外部科技扫描等低频旁路） */
  | "other";

export type LlmUsageRecord = {
  t: string;
  actorId?: string;
  sessionId?: string;
  stage: LlmAuditStage;
  model?: string;
  /** 来源工具名（仅 tool_result_compaction 打点使用，其余环节无此值）。 */
  toolName?: string;
  inputChars: number;
  outputChars: number;
  inputTokens: number;
  outputTokens: number;
  /**
   * API 真实返回的 prefix cache 命中 token 数（OpenAI prompt_tokens_details.cached_tokens /
   * DeepSeek prompt_cache_hit_tokens）。仅主对话与工具循环从响应 usage 采集，旁路估算调用无此值。
   */
  promptCacheHitTokens?: number;
  /** API 真实返回的 prefix cache 未命中 token 数（DeepSeek prompt_cache_miss_tokens）。 */
  promptCacheMissTokens?: number;
  /** API usage 真实返回的 prompt tokens（流末尾 usage；无 usage 时走字符估算）。 */
  apiPromptTokens?: number;
  /** API usage 真实返回的 completion tokens。 */
  apiCompletionTokens?: number;
};

export type LlmUsageAggregate = {
  calls: number;
  inputChars: number;
  outputChars: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** 以下为 API usage 真实值聚合（仅带 usage 的主链路调用计入；估算值不混入）。 */
  apiCalls: number;
  apiInputTokens: number;
  apiOutputTokens: number;
};

/** 简短环境信息，便于区分不同部署实例 */
function auditLogPath(): string {
  const base = process.env.PA_DATA_DIR?.trim() || "data";
  return join(base, "llm-token-audit.ndjson");
}

const AGG_BUCKETS = new Map<string, LlmUsageAggregate>();

function ensureAuditFile(): void {
  const path = auditLogPath();
  const dir = dirname(path);
  if (!existsSync(dir)) {
    try {
      mkdirSync(dir, { recursive: true });
    } catch {
      /* 目录创建失败不影响主链路 */
    }
  }
}

/**
 * 中英混合文本 token 估算（与 chat-thread-store.estimateTokens 同源）。
 */
export function estimateTokensForText(text: unknown): number {
  if (typeof text !== "string" || text.length === 0) return 0;
  const chineseChars = (text.match(/[\u4e00-\u9fa5]/g) || []).length;
  const englishWords = text
    .replace(/[\u4e00-\u9fa5]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 0).length;
  return Math.ceil(chineseChars * 1.5 + englishWords * 0.25);
}

/**
 * 字符 → token 的保守折算系数。
 * 中文约 1.5 token/字、英文约 2.5-4 字符/token；中英混合按 ~0.75 token/字符估算，
 * 与 chat-thread-store.estimateTokens 的量级一致（估算而非精确计费）。
 */
export const CHARS_TO_TOKENS_RATIO = 0.75;

/**
 * 记录一次 LLM 调用的输入/输出规模（fire-and-forget，不阻塞调用方）。
 */
export function recordLlmUsage(rec: Omit<LlmUsageRecord, "t" | "inputTokens" | "outputTokens">): void {
  const inputTokens = Math.max(1, Math.round(rec.inputChars * CHARS_TO_TOKENS_RATIO));
  const outputTokens = Math.round(rec.outputChars * CHARS_TO_TOKENS_RATIO);
  // 预算闸门记账（2026-09-19 P1-2）：单一审计入口顺带累计，80% 告警 / 100% 降级
  recordBudgetUsage({
    sessionId: rec.sessionId,
    actorId: rec.actorId,
    tokens:
      (rec.apiPromptTokens ?? 0) + (rec.apiCompletionTokens ?? 0) || inputTokens + outputTokens,
  });
  const aggregate: LlmUsageAggregate = {
    calls: 1,
    inputChars: rec.inputChars,
    outputChars: rec.outputChars,
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    apiCalls: 0,
    apiInputTokens: 0,
    apiOutputTokens: 0,
  };
  if (typeof rec.apiPromptTokens === "number" || typeof rec.apiCompletionTokens === "number") {
    aggregate.apiCalls = 1;
    aggregate.apiInputTokens = rec.apiPromptTokens ?? 0;
    aggregate.apiOutputTokens = rec.apiCompletionTokens ?? 0;
  }
  const key = rec.stage;
  const prev = AGG_BUCKETS.get(key);
  if (prev) {
    prev.calls += 1;
    prev.inputChars += rec.inputChars;
    prev.outputChars += rec.outputChars;
    prev.inputTokens += inputTokens;
    prev.outputTokens += outputTokens;
    prev.totalTokens += aggregate.totalTokens;
    prev.apiCalls += aggregate.apiCalls;
    prev.apiInputTokens += aggregate.apiInputTokens;
    prev.apiOutputTokens += aggregate.apiOutputTokens;
  } else {
    AGG_BUCKETS.set(key, aggregate);
  }

  try {
    ensureAuditFile();
    appendFileSync(
      auditLogPath(),
      JSON.stringify({
        ...rec,
        t: new Date().toISOString(),
        inputTokens,
        outputTokens,
        // 只落盘真实值，undefined 不序列化
        ...(typeof rec.promptCacheHitTokens === "number"
          ? { promptCacheHitTokens: rec.promptCacheHitTokens }
          : {}),
        ...(typeof rec.promptCacheMissTokens === "number"
          ? { promptCacheMissTokens: rec.promptCacheMissTokens }
          : {}),
        ...(typeof rec.apiPromptTokens === "number" ? { apiPromptTokens: rec.apiPromptTokens } : {}),
        ...(typeof rec.apiCompletionTokens === "number"
          ? { apiCompletionTokens: rec.apiCompletionTokens }
          : {}),
      }) + "\n",
    );
  } catch {
    /* 写盘失败静默，不影响主链路 */
  }
}

/**
 * 基于估算字符数记录一次 LLM 调用（推荐使用：直接传字符数）。
 */
export function recordLlmUsageByChars(args: {
  stage: LlmAuditStage;
  inputChars: number;
  outputChars?: number;
  actorId?: string;
  sessionId?: string;
  model?: string;
  /** 来源工具名（仅 tool_result_compaction 打点使用） */
  toolName?: string;
  /** API 真实返回的 prefix cache 命中 token 数（可选，仅主链路从响应 usage 采集） */
  promptCacheHitTokens?: number;
  /** API 真实返回的 prefix cache 未命中 token 数（可选） */
  promptCacheMissTokens?: number;
  /** API usage 真实 prompt tokens（可选，优先于字符估算用于计费分析） */
  apiPromptTokens?: number;
  /** API usage 真实 completion tokens（可选） */
  apiCompletionTokens?: number;
}): void {
  recordLlmUsage({
    stage: args.stage,
    inputChars: Math.max(0, Math.round(args.inputChars)),
    outputChars: Math.max(0, Math.round(args.outputChars ?? 0)),
    actorId: args.actorId,
    sessionId: args.sessionId,
    model: args.model,
    toolName: args.toolName,
    promptCacheHitTokens: args.promptCacheHitTokens,
    promptCacheMissTokens: args.promptCacheMissTokens,
    apiPromptTokens: args.apiPromptTokens,
    apiCompletionTokens: args.apiCompletionTokens,
  });
}

/**
 * 工具结果压缩打点（WP0，2026-09-17）：每次 compactToolOutputForLlm 调一条，
 * 记录压缩前/后字符，量化各工具的压缩节省率。非 LLM 调用，纯观测。
 */
export function recordToolCompactionByChars(args: {
  toolName: string;
  sessionId?: string;
  rawChars: number;
  compactChars: number;
}): void {
  recordLlmUsageByChars({
    stage: "tool_result_compaction",
    toolName: args.toolName,
    sessionId: args.sessionId,
    inputChars: args.rawChars,
    outputChars: args.compactChars,
  });
}

/**
 * 从字符数组/字符串批量估算输入规模：与 recordLlmUsageByChars 配合，
 * 供调用方把 messages/tools 拼成字符串后统计。
 */
export function countChars(values: Array<string | null | undefined>): number {
  let total = 0;
  for (const v of values) {
    if (typeof v === "string") total += v.length;
  }
  return total;
}

/**
 * 抽取一条 message 的文本规模。
 * content 可能是字符串，也可能是多模态数组（[{type:"text"},{type:"image_url"}]）
 * ——视觉类只计文本部分，base64 图片不计入（无法按字符折算 token）。
 */
function textLengthOfContent(content: unknown): number {
  if (typeof content === "string") return content.length;
  if (!Array.isArray(content)) return 0;
  let total = 0;
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const p = part as Record<string, unknown>;
    // 文本段（type:"text"）与无 type 的裸文本都计入；图片段整体跳过
    if (p.type === "text" || p.type === undefined) {
      if (typeof p.text === "string") total += p.text.length;
    }
  }
  return total;
}

/**
 * 为「自行 new OpenAI 直接 chat.completions.create」的旁路调用补审计
 *（2026-10-21：16 处历史盲区统一收编）。
 *
 * 用法：把发给 create 的 messages 与返回的 response 原样传进来即可，
 * 字符折算与 recordLlmUsageByChars 完全一致（0.75 token/字符）。
 * 失败/空响应也要调用——调用次数本身就是关键信号（否则失败调用永远不可见）。
 */
export function auditChatCompletion(args: {
  stage: LlmAuditStage;
  /** 发给 create 的 messages（数组或字符串） */
  messages: unknown;
  /** create 的返回值；也接受直接传响应文本字符串 */
  completion?: unknown;
  model?: string;
  actorId?: string;
  sessionId?: string;
}): void {
  try {
    let inputChars = 0;
    if (typeof args.messages === "string") {
      inputChars = args.messages.length;
    } else if (Array.isArray(args.messages)) {
      for (const m of args.messages) {
        if (!m || typeof m !== "object") continue;
        const msg = m as Record<string, unknown>;
        inputChars += textLengthOfContent(msg.content);
      }
    }

    let outputChars = 0;
    const c = args.completion;
    if (typeof c === "string") {
      outputChars = c.length;
    } else if (c && typeof c === "object") {
      const choices = (c as { choices?: Array<{ message?: { content?: unknown } }> }).choices;
      const content = choices?.[0]?.message?.content;
      if (typeof content === "string") outputChars = content.length;
    }

    if (inputChars <= 0 && outputChars <= 0) return;
    recordLlmUsageByChars({
      stage: args.stage,
      inputChars,
      outputChars,
      model: args.model,
      actorId: args.actorId,
      sessionId: args.sessionId,
    });
  } catch {
    /* 审计失败静默，绝不干扰主链路 */
  }
}

/**
 * 内存聚合快照：按环节输出占比（totalTokens 降序）。
 * api* 字段为 API usage 真实值（仅带 usage 的调用计入）；估算值与真实值分列，不混算。
 */
export function getLlmUsageSummary(): Array<{
  stage: LlmAuditStage | string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  pct: number;
  apiCalls: number;
  apiInputTokens: number;
  apiOutputTokens: number;
}> {
  const rows = [...AGG_BUCKETS.entries()].map(([stage, agg]) => ({
    stage,
    calls: agg.calls,
    inputTokens: agg.inputTokens,
    outputTokens: agg.outputTokens,
    totalTokens: agg.totalTokens,
    pct: 0,
    apiCalls: agg.apiCalls ?? 0,
    apiInputTokens: agg.apiInputTokens ?? 0,
    apiOutputTokens: agg.apiOutputTokens ?? 0,
  }));
  const grand = rows.reduce((s, r) => s + r.totalTokens, 0);
  for (const r of rows) {
    r.pct = grand > 0 ? Math.round((r.totalTokens / grand) * 1000) / 10 : 0;
  }
  return rows.sort((a, b) => b.totalTokens - a.totalTokens);
}

/**
 * 从落盘 NDJSON 聚合（跨进程重启后仍可查）。文件不存在返回空数组。
 */
export function getLlmUsageSummaryFromDisk(): Array<{ stage: string; calls: number; inputTokens: number; outputTokens: number; totalTokens: number; pct: number; apiCalls: number; apiInputTokens: number; apiOutputTokens: number }> {
  const path = auditLogPath();
  if (!existsSync(path)) return [];
  const map = new Map<string, LlmUsageAggregate>();
  try {
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const rec = JSON.parse(line) as LlmUsageRecord;
        const agg = map.get(rec.stage);
        const hasApiUsage =
          typeof rec.apiPromptTokens === "number" || typeof rec.apiCompletionTokens === "number";
        const add = {
          calls: 1,
          inputChars: rec.inputChars ?? 0,
          outputChars: rec.outputChars ?? 0,
          inputTokens: rec.inputTokens ?? 0,
          outputTokens: rec.outputTokens ?? 0,
          totalTokens: (rec.inputTokens ?? 0) + (rec.outputTokens ?? 0),
          apiCalls: hasApiUsage ? 1 : 0,
          apiInputTokens: rec.apiPromptTokens ?? 0,
          apiOutputTokens: rec.apiCompletionTokens ?? 0,
        };
        if (agg) {
          agg.calls += add.calls;
          agg.inputChars += add.inputChars;
          agg.outputChars += add.outputChars;
          agg.inputTokens += add.inputTokens;
          agg.outputTokens += add.outputTokens;
          agg.totalTokens += add.totalTokens;
          agg.apiCalls += add.apiCalls;
          agg.apiInputTokens += add.apiInputTokens;
          agg.apiOutputTokens += add.apiOutputTokens;
        } else {
          map.set(rec.stage, add);
        }
      } catch {
        /* 单行损坏忽略 */
      }
    }
  } catch {
    return [];
  }
  const rows = [...map.entries()].map(([stage, agg]) => ({
    stage,
    calls: agg.calls,
    inputTokens: agg.inputTokens,
    outputTokens: agg.outputTokens,
    totalTokens: agg.totalTokens,
    pct: 0,
    apiCalls: agg.apiCalls ?? 0,
    apiInputTokens: agg.apiInputTokens ?? 0,
    apiOutputTokens: agg.apiOutputTokens ?? 0,
  }));
  const grand = rows.reduce((s, r) => s + r.totalTokens, 0);
  for (const r of rows) {
    r.pct = grand > 0 ? Math.round((r.totalTokens / grand) * 1000) / 10 : 0;
  }
  return rows.sort((a, b) => b.totalTokens - a.totalTokens);
}

/** 仅供测试使用 */
export function resetLlmUsageAuditForTest(): void {
  AGG_BUCKETS.clear();
}