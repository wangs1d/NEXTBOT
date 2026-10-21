/**
 * 统一 Agent 运行时配置：启动时从环境变量加载一次，避免散落 process.env 读取。
 */

import { resolvePromptMemoryKeys } from "./prompt-builder.js";

function envTruthy(raw: string | undefined): boolean {
  const v = raw?.trim().toLowerCase();
  if (!v || v === "0" || v === "off" || v === "false" || v === "no") return false;
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

function envPositiveInt(raw: string | undefined, fallback: number): number {
  const n = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export type MasterDelegationConfig = {
  enabled: boolean;
  verbose: boolean;
  subtaskTimeoutMs: number;
  /** tech 子 Agent 专用超时（深度 RPA / 代码任务通常更长） */
  techSubtaskTimeoutMs: number;
  /** info 子 Agent 专用超时（多轮联网检索） */
  infoSubtaskTimeoutMs: number;
  maxSubAgentInvocationsPerTurn: number;
  forceSynthesis: boolean;
  directReplyMaxChars: number;
  maxParallelSubAgents: number;
  retryEnabled: boolean;
  maxRetryAttempts: number;
  semanticDedupEnabled: boolean;
  semanticDedupThreshold: number;
};

export type PlanExecuteConfig = {
  enabled: boolean;
  verboseStream: boolean;
};

export type MemoryPromptConfig = {
  narrativeRecallTimeoutMs: number;
  agentCapsInPrompt: boolean;
  worldCapsInPrompt: boolean;
  promptMemoryKeys: string[] | null;
  taskContextInPrompt: boolean;
};

export type QuotaConfig = {
  unitsPerModelCall: number;
};

export type MessageBatchConfig = {
  enabled: boolean;
};

/**
 * 「分阶段异步对话交互」即时确认应答开关。
 * 默认开启；设 `CHAT_INTERIM_ACK_ENABLED=0` 可关闭。
 */
export type InterimAckConfig = {
  enabled: boolean;
};

/**
 * 「分阶段异步对话交互 v2」豆包式阶段化事件流开关。
 * 默认关闭（v1 兼容期）；设 `CHAT_TURN_PANEL_V2=1` 开启
 * chat.turn_started / chat.intent_detected / chat.execution_event 三件套。
 */
export type TurnPanelV2Config = {
  enabled: boolean;
};

export type AgentRuntimeConfig = {
  masterDelegation: MasterDelegationConfig;
  planExecute: PlanExecuteConfig;
  memoryPrompt: MemoryPromptConfig;
  quota: QuotaConfig;
  messageBatch: MessageBatchConfig;
  interimAck: InterimAckConfig;
  turnPanelV2: TurnPanelV2Config;
};

function loadMasterDelegationConfig(): MasterDelegationConfig {
  const primary = process.env.ENABLE_MASTER_AGENT_DELEGATION;
  const legacy = process.env.ENABLE_MULTI_AGENT_COORDINATION;
  const hasExplicit =
    (primary !== undefined && primary.trim() !== "") ||
    (legacy !== undefined && legacy.trim() !== "");
  const hasExternalModel = Boolean(
    process.env.MOONSHOT_API_KEY?.trim() ||
      process.env.MINIMAX_API_KEY?.trim() ||
      process.env.OPENAI_API_KEY?.trim() ||
      process.env.EXTERNAL_MODEL_PROVIDER?.trim(),
  );
  const enabled = hasExplicit
    ? envTruthy(primary ?? legacy)
    : hasExternalModel;

  const verbosePrimary = process.env.MASTER_AGENT_DELEGATION_VERBOSE;
  const verbose =
    verbosePrimary !== undefined && verbosePrimary.trim() !== ""
      ? envTruthy(verbosePrimary)
      : envTruthy(process.env.MULTI_AGENT_VERBOSE);

  const subtaskTimeoutMs = envPositiveInt(process.env.SUBTASK_TIMEOUT_MS, 30_000);
  return {
    enabled,
    verbose,
    subtaskTimeoutMs,
    techSubtaskTimeoutMs: envPositiveInt(process.env.TECH_SUBTASK_TIMEOUT_MS, 90_000),
    infoSubtaskTimeoutMs: envPositiveInt(process.env.INFO_SUBTASK_TIMEOUT_MS, 25_000),
    maxSubAgentInvocationsPerTurn: envPositiveInt(process.env.MASTER_AGENT_MAX_SUB_AGENT_INVOCATIONS, 6),
    forceSynthesis: process.env.MASTER_AGENT_FORCE_SYNTHESIS === "1",
    directReplyMaxChars: envPositiveInt(process.env.MASTER_AGENT_DIRECT_REPLY_MAX_CHARS, 2800),
    maxParallelSubAgents: envPositiveInt(process.env.MAX_PARALLEL_SUB_AGENTS, 3),
    retryEnabled: envTruthy(process.env.SUBAGENT_RETRY_ENABLED),
    maxRetryAttempts: envPositiveInt(process.env.SUBAGENT_MAX_RETRY_ATTEMPTS, 2),
    semanticDedupEnabled: envTruthy(process.env.SEMANTIC_DEDUP_ENABLED),
    semanticDedupThreshold: Number.parseFloat(process.env.SEMANTIC_DEDUP_THRESHOLD ?? "0.75"),
  };
}

function loadPlanExecuteConfig(): PlanExecuteConfig {
  // 与 isPlanExecuteLoopEnabled 同口径：默认开启，显式 0/off/false/no 关闭。
  const raw = process.env.AGENT_PLAN_EXECUTE_LOOP?.trim();
  return {
    enabled: raw ? envTruthy(raw) : true,
    verboseStream: envTruthy(process.env.AGENT_PE_VERBOSE_STREAM),
  };
}

function loadMemoryPromptConfig(): MemoryPromptConfig {
  const promptMemoryKeys = resolvePromptMemoryKeys();

  // 能力自述默认开启：人格层能力总览由 FeatureCatalog 从真实注册表自动生成
  // （新能力注册即上 prompt）。AGENT_PROMPT_AGENT_CAPS=0/off/false/no 显式关闭。
  const agentCapsRaw = process.env.AGENT_PROMPT_AGENT_CAPS?.trim().toLowerCase();
  const agentCapsInPrompt = !(
    agentCapsRaw === "0" ||
    agentCapsRaw === "off" ||
    agentCapsRaw === "false" ||
    agentCapsRaw === "no"
  );

  const capsRaw = process.env.AGENT_PROMPT_WORLD_CAPS?.trim().toLowerCase();
  const worldCapsInPrompt =
    capsRaw === "1" ||
    capsRaw === "on" ||
    capsRaw === "true" ||
    capsRaw === "yes";

  return {
    // narrativeRecallTimeoutMs：默认 3000ms、上限 6000ms。
    // 修复：humanLike 召回需先算 query embedding（外部 API），原 400ms 默认值必然超时，
    // 导致对话中长期记忆永不注入（agent 失忆）。embedding 已单独降级为短超时（~1.2s），
    // 3000ms 足够 embedding 正常命中或降级后的本地关键词检索路径完成。
    narrativeRecallTimeoutMs: Math.min(
      6000,
      Math.max(200, envPositiveInt(process.env.AGENT_NARRATIVE_RECALL_TIMEOUT_MS, 3000)),
    ),
    agentCapsInPrompt,
    worldCapsInPrompt,
    promptMemoryKeys,
    taskContextInPrompt: process.env.AGENT_TASK_CONTEXT_PROMPT !== "0",
  };
}

function loadQuotaConfig(): QuotaConfig {
  return {
    unitsPerModelCall: envPositiveInt(process.env.COMPUTE_QUOTA_UNITS_PER_MODEL_CALL, 0),
  };
}

function loadMessageBatchConfig(): MessageBatchConfig {
  const rawEnabled = process.env.MESSAGE_BATCH_ENABLED;
  return {
    enabled: rawEnabled === undefined ? true : envTruthy(rawEnabled),
  };
}

function loadInterimAckConfig(): InterimAckConfig {
  const raw = process.env.CHAT_INTERIM_ACK_ENABLED;
  return {
    // 默认开启；显式置 0/off/false/no 时关闭
    enabled: raw === undefined ? true : envTruthy(raw),
  };
}

function loadTurnPanelV2Config(): TurnPanelV2Config {
  const raw = process.env.CHAT_TURN_PANEL_V2;
  return {
    // 默认关闭（v1 兼容期），显式 1/true/yes/on 时开启
    enabled: raw === undefined ? false : envTruthy(raw),
  };
}

export function loadAgentRuntimeConfig(): AgentRuntimeConfig {
  return {
    masterDelegation: loadMasterDelegationConfig(),
    planExecute: loadPlanExecuteConfig(),
    memoryPrompt: loadMemoryPromptConfig(),
    quota: loadQuotaConfig(),
    messageBatch: loadMessageBatchConfig(),
    interimAck: loadInterimAckConfig(),
    turnPanelV2: loadTurnPanelV2Config(),
  };
}

let cached: AgentRuntimeConfig | null = null;

export function getAgentRuntimeConfig(): AgentRuntimeConfig {
  if (!cached) cached = loadAgentRuntimeConfig();
  return cached;
}

/** 单元测试重置缓存 */
export function resetAgentRuntimeConfigForTests(): void {
  cached = null;
}

/** 启动日志用：人类可读摘要 */
export function formatAgentRuntimeConfigSummary(config: AgentRuntimeConfig): string {
  const m = config.masterDelegation;
  const pe = config.planExecute;
  const mb = config.messageBatch;
  return [
    `masterDelegation=${m.enabled ? "on" : "off"}`,
    m.enabled ? `maxSubAgentInvocations=${m.maxSubAgentInvocationsPerTurn}` : null,
    m.enabled ? `parallelSubAgents=${m.maxParallelSubAgents}` : null,
    m.enabled ? `retry=${m.retryEnabled ? "on" : "off"}` : null,
    `planExecute=${pe.enabled ? "on" : "off"}`,
    `agentCapsPrompt=${config.memoryPrompt.agentCapsInPrompt ? "on" : "off"}`,
    `worldCapsPrompt=${config.memoryPrompt.worldCapsInPrompt ? "on" : "off"}`,
    config.memoryPrompt.promptMemoryKeys
      ? `uapMemoryKeys=${config.memoryPrompt.promptMemoryKeys.length}`
      : "uapMemoryKeys=off",
    `taskContext=${config.memoryPrompt.taskContextInPrompt ? "on" : "off"}`,
    config.quota.unitsPerModelCall > 0 ? `quotaUnitsPerCall=${config.quota.unitsPerModelCall}` : null,
    `messageBatch=${mb.enabled ? "on(until-processing-ui-off)" : "off"}`,
    `interimAck=${config.interimAck.enabled ? "on" : "off"}`,
    `turnPanelV2=${config.turnPanelV2.enabled ? "on" : "off"}`,
  ]
    .filter(Boolean)
    .join(", ");
}
