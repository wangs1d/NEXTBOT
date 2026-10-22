/**
 * 模型分级配置中心化（Token 效率优化 - Phase 6.1）
 *
 * 设计原则：
 * - 能规则不 LLM，能小模型不大模型
 * - routine 任务用 nano/mini，复杂决策才用 full
 * - 通过环境变量灵活覆盖
 *
 * 使用方式：
 *   import { getModelForTask, TASK_TIER } from "../config/model-routing.js";
 *   const model = getModelForTask(TASK_TIER.MINI); // 默认跟随当前 provider 主模型
 *   provider.streamCompletion(sessionId, userTurn, onDelta, tools, { modelOverride: model });
 */

import { resolvePrimaryLlmClientConfig } from "../external-model/resolve-provider.js";

/** 任务分级：按复杂度从低到高 */
export enum TaskTier {
  /** flash 档：对话/轻量工具/简单查询 — 使用 DeepSeek V4.1-Flash（deepseek-flash，支持图像理解） */
  FLASH = "flash",
  /** pro 档：深度推理/子 Agent 委派/多步计划 — 同 deepseek-flash 但放开思考链
   *  （deepseek-reasoner 已下线，官方 /models 2026-09 起不再列出） */
  PRO = "pro",
  /** 最简单：情绪识别 L2、技术扫描评估、简单分类 */
  NANO = "nano",
  /** 中等：EndToEndDecisionMaker、SkillGenerator、子 Agent */
  MINI = "mini",
  /** 最复杂：cognize、master_delegate、复杂推理 */
  FULL = "full",
}

/** 默认模型映射 */
const DEFAULT_MODELS: Record<TaskTier, string> = {
  // 2026-10-07：FLASH/PRO 不再硬编码 deepseek-flash——主模型已换 MiniMax-M3，
  // 硬编码模型名打到 MiniMax 端点必 400（unknown model），且炸的是**每一次
  // 工具循环调用**（真机实证：天气/提醒轮全跌 emergency 无工具兜底 → 模型嘴硬
  // "没有天气接口/没法定时"）。缺省跟随主模型（与 NANO/MINI/FULL 同策略）；
  // 确需分档用 MODEL_FAST / MODEL_COMPLEX 或 MODEL_ROUTING_OVERRIDE 显式配置。
  [TaskTier.FLASH]: "",
  [TaskTier.PRO]: "",
  [TaskTier.NANO]: "",                // 空 = 跟随 provider 主模型（gpt-4.1-nano 在 DeepSeek 端点已无效）
  [TaskTier.MINI]: "",                // 空 = 跟随 provider 主模型（gpt-4.1-mini 同款问题，2026-09 已改）
  [TaskTier.FULL]: "", // 空字符串表示使用主模型（OPENAI_MODEL / MOONSHOT_MODEL）
};

/** 环境变量名前缀 */
const ENV_PREFIX: Record<TaskTier, string> = {
  [TaskTier.FLASH]: "MODEL_FAST",
  [TaskTier.PRO]: "MODEL_COMPLEX",
  [TaskTier.NANO]: "MODEL_NANO",
  [TaskTier.MINI]: "MODEL_MINI",
  [TaskTier.FULL]: "MODEL_FULL",
};

/** 缓存解析后的覆盖配置，避免每次调用都解析 JSON */
let cachedOverride: Record<string, string> | null = null;
let cachedOverrideTimestamp = 0;
const OVERRIDE_CACHE_TTL_MS = 60_000; // 1 分钟

/**
 * 解析 MODEL_ROUTING_OVERRIDE 环境变量（JSON 格式）
 * 示例：{"nano":"gpt-4.1-mini","mini":"kimi-k2.5"}
 */
function loadOverride(): Record<string, string> {
  const now = Date.now();
  if (cachedOverride && now - cachedOverrideTimestamp < OVERRIDE_CACHE_TTL_MS) {
    return cachedOverride;
  }

  const raw = process.env.MODEL_ROUTING_OVERRIDE?.trim();
  if (!raw) {
    cachedOverride = {};
  } else {
    try {
      const parsed = JSON.parse(raw);
      cachedOverride =
        typeof parsed === "object" && parsed && !Array.isArray(parsed)
          ? parsed
          : {};
    } catch {
      console.warn(
        `[model-routing] Failed to parse MODEL_ROUTING_OVERRIDE, using defaults.`,
      );
      cachedOverride = {};
    }
  }
  cachedOverrideTimestamp = now;
  return cachedOverride!;
}

/**
 * 获取指定任务分级的模型名
 *
 * 优先级：
 * 1. MODEL_ROUTING_OVERRIDE JSON 中的对应 tier
 * 2. 环境变量 MODEL_NANO / MODEL_MINI / MODEL_FULL
 * 3. 默认值（FULL 返回空字符串，表示用主模型；MINI 默认跟随当前生效 provider 的主模型，
 *    避免在只支持 deepseek-v4-* 等模型名的代理下被 400 拒绝）
 *
 * @param tier 任务分级
 * @returns 模型名（空字符串表示使用 provider 默认主模型）
 */
export function getModelForTask(tier: TaskTier): string {
  const override = loadOverride();

  // 1. JSON 覆盖
  const jsonOverride = override[tier];
  if (jsonOverride) return jsonOverride;

  // 2. 环境变量
  const envVar = ENV_PREFIX[tier];
  const envValue = process.env[envVar]?.trim();
  if (envValue) return envValue;

  // 3. 默认值：空 = 跟随当前生效 provider 的主模型（各家模型名不互通，硬编码
  //    会在该家端点上 400；MINI 2026-09 先改，FLASH/PRO 2026-10-07 跟进）。
  if (tier === TaskTier.MINI || tier === TaskTier.FLASH || tier === TaskTier.PRO) {
    return resolvePrimaryLlmClientConfig()?.model?.trim() || DEFAULT_MODELS[tier];
  }
  return DEFAULT_MODELS[tier];
}

/**
 * 获取 AgentStreamOptions.modelOverride 用的模型名
 * 如果返回空字符串，调用方可不设置 modelOverride（使用 provider 默认）
 */
export function getModelOverrideForTask(
  tier: TaskTier,
): string | undefined {
  const model = getModelForTask(tier);
  return model || undefined;
}

/**
 * 便捷构造 AgentStreamOptions 的 modelOverride
 * 仅当模型与主模型不同时才设置（避免无意义的 override）
 */
export function buildModelOverrideOpts(
  tier: TaskTier,
): { modelOverride?: string } {
  const model = getModelOverrideForTask(tier);
  return model ? { modelOverride: model } : {};
}

/**
 * 输出当前模型路由配置（用于日志/调试）
 */
export function dumpModelRouting(): Record<string, string> {
  return {
    [TaskTier.FLASH]: getModelForTask(TaskTier.FLASH) || "(provider default)",
    [TaskTier.PRO]: getModelForTask(TaskTier.PRO) || "(provider default)",
    [TaskTier.NANO]: getModelForTask(TaskTier.NANO) || "(provider default)",
    [TaskTier.MINI]: getModelForTask(TaskTier.MINI) || "(provider default)",
    [TaskTier.FULL]: getModelForTask(TaskTier.FULL) || "(provider default)",
    overrideSource: process.env.MODEL_ROUTING_OVERRIDE ? "env" : "defaults",
  };
}
