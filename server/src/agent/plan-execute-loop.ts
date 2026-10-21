/**
 * 「计划 → 执行（工具）」编排：与 OpenAI/Kimi Provider 的多轮工具环协作。
 *
 * 优化说明（2026-05-22）：
 * - 移除了"自检 → 重试"环节，减少 50%+ 的 LLM 调用次数
 * - 显式计划一次，执行阶段交给波次工具循环（波内并行工具 + 出口自检续波），
 *   不再逐步 ReAct
 * - 保留计划解析失败时的兜底逻辑，确保稳定性
 *
 * 环境变量：
 * - `AGENT_PLAN_EXECUTE_LOOP=0|off|false|no` 关闭（默认开启，仅复杂任务触发，
 *   见 shouldPlanExecute / requiresExplicitPlan）。
 * - `AGENT_PE_VERBOSE_STREAM=1`：将计划阶段标题写入用户可见流（默认仅推 phase 状态）。
 *
 * 2026-10-21 token 收敛：
 * - 规划轮不再携带全量 system / 画像记忆 / 工具 schema（此前沿用 baseStreamOpts，
 *   一次计划调用就重发整套 chat 底板）。改为紧凑规划 system + BM25 相关工具名提示，
 *   无工具走非工具分支，单独打 `task_plane_plan` 审计 stage。
 * - 计划落定后清空规划会话，执行轮只从「原任务 + 紧凑计划」重建上下文，
 *   不把规划脚手架（指令 + JSON 原文）带进后续每一波。
 */
import { requiresExplicitPlan } from "./simple-task.js";
import { bm25HitsForQuery } from "../tools/tool-search/index.js";
import type { ChatCompletionTool } from "openai/resources/chat/completions";
import { dedupeToolsByName, slimToolSchema } from "../external-model/lane-tool-sets.js";
import type {
  AgentStreamOptions,
  ChatToolExecutionContext,
  ChatUserTurn,
  ExternalChatProvider,
  StreamDeltaHandler,
  ToolLoopAfterBatchInfo,
  VisionFrame,
} from "../external-model/types.js";

export type PlanExecuteStep = {
  id: string;
  intent: string;
  successCriteria?: string;
  suggestedTools?: string[];
};

export type TaskExecutionPlan = {
  goal: string;
  steps: PlanExecuteStep[];
};

export type PlanExecuteLoopResult = {
  finalText: string;
  modelCalls: number;
  plan: TaskExecutionPlan | null;
  /**
   * 反思环节是否耗尽 replan 次数。
   *
   * 激活方式：调用方（通常是 PlanExecuteLoopStrategy）传入 `reflectionContext` 时，
   * 由 `replanCount >= maxReplans` 计算；未传入时为 false（兼容旧路径/直调场景）。
   *
   * 在 LoopOrchestrator 模型下，反思由编排器在 strategy.run 之间驱动（assess→replan），
   * 单次 runPlanExecuteLoop 调用时通常未耗尽；任务级"是否耗尽"以 OrchestratorResult.exhaustedRetries 为准。
   */
  exhaustedRetries: boolean;
  /**
   * 最近一次进展评估的反思文本。
   *
   * 激活方式：调用方传入 `reflectionContext.lastDeviation` 时回填；未传入时为空串。
   * 任务级反思聚合见 SharedTaskContext.reflections / OrchestratorResult.verifyReflection。
   */
  verifyReflection: string;
};

export function isPlanExecuteLoopEnabled(): boolean {
  const raw = process.env.AGENT_PLAN_EXECUTE_LOOP?.trim().toLowerCase();
  // 默认开启（2026-10-21）：复杂任务走显式「计划→执行」，简单任务不受影响。
  if (!raw) return true;
  return !(raw === "0" || raw === "off" || raw === "false" || raw === "no");
}

/**
 * 本轮是否走显式计划：任务面 + 复杂任务才算（简单直办/单步查询不额外出计划调用）。
 * 调用方（agent-core）只在 mode==="task" 时使用本判定。
 */
export function shouldPlanExecute(message: string): boolean {
  return isPlanExecuteLoopEnabled() && requiresExplicitPlan(message);
}

function isPeVerboseStreamEnabled(): boolean {
  const raw = process.env.AGENT_PE_VERBOSE_STREAM?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

export function planExecuteSessionId(actorId: string, chatMessageKey: string): string {
  return `${actorId}\u007fpe\u007f${chatMessageKey}`;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}…`;
}

function isPlanTriviallySimple(plan: TaskExecutionPlan): boolean {
  if (plan.steps.length > 1) return false;
  const step = plan.steps[0];
  if (!step) return false;
  if (step.intent.length > 80) return false;
  if (step.suggestedTools?.length && step.suggestedTools.length > 2) return false;
  return true;
}

function extractJsonObject(text: string): string | null {
  const t = text.trim();
  const direct = tryParseWhole(t);
  if (direct !== null) return direct;
  const fence = /\{[\s\S]*\}/.exec(text);
  if (fence?.[0]) {
    const inner = tryParseWhole(fence[0].trim());
    if (inner !== null) return inner;
  }
  return null;
}

function tryParseWhole(s: string): string | null {
  try {
    const o = JSON.parse(s);
    return typeof o === "object" && o !== null ? s : null;
  } catch {
    return null;
  }
}

/** 供单元测试使用 */
export function parseExecutionPlan(raw: string): TaskExecutionPlan | null {
  const jsonSrc = extractJsonObject(raw);
  if (!jsonSrc) return null;
  let data: unknown;
  try {
    data = JSON.parse(jsonSrc);
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null) return null;
  const goal = typeof (data as { goal?: unknown }).goal === "string" ? (data as { goal: string }).goal : "";
  if (!goal.trim()) return null;
  const stepsRaw = (data as { steps?: unknown }).steps;
  if (!Array.isArray(stepsRaw) || stepsRaw.length === 0) return null;
  const steps: PlanExecuteStep[] = [];
  for (const row of stepsRaw) {
    if (typeof row !== "object" || row === null) continue;
    const id = typeof (row as { id?: unknown }).id === "string" ? String((row as { id: string }).id).trim() : "";
    const intent =
      typeof (row as { intent?: unknown }).intent === "string"
        ? String((row as { intent: string }).intent).trim()
        : "";
    if (!intent) continue;
    const successCriteria =
      typeof (row as { successCriteria?: unknown }).successCriteria === "string"
        ? String((row as { successCriteria: string }).successCriteria).trim()
        : undefined;
    let suggestedTools: string[] | undefined;
    const st = (row as { suggestedTools?: unknown }).suggestedTools;
    if (Array.isArray(st)) {
      const names = st.filter((x): x is string => typeof x === "string").map((x) => x.trim()).filter(Boolean);
      if (names.length > 0) suggestedTools = names;
    }
    steps.push({
      id: id || `${steps.length + 1}`,
      intent,
      successCriteria,
      suggestedTools,
    });
  }
  if (steps.length === 0) return null;
  return { goal: goal.trim(), steps };
}

/** 计划直供预载的工具数上限（防幻觉名/超多步计划灌爆可见集）。 */
const SUGGESTED_TOOLS_MAX = 8;

function toolNameOf(tool: ChatCompletionTool): string {
  return tool.type === "function" ? tool.function?.name ?? "" : "";
}

/**
 * 计划直供预载（2026-10-10 编排器协同，五层根修的执行层补刀）：
 * 计划步里的 suggestedTools 是模型在计划阶段自声明的意图——它读过全量任务
 * 语境，比 BM25 对原话的词面猜测更准。解析成语料内真实工具定义后并入执行轮
 * 可见集（chatToolsBuiltin），执行步免 discover 直达。
 * 口径：仅收本轮语料（chatToolsExtra/延迟目录）内存在的名字，幻觉名跳过；
 * 已在 builtin 可见集的不重复注入；瘦身 schema（与域预载同款）。
 * baseStreamOpts 未装配工具集（chatToolsExtra 空）时返回空集——此时执行轮本
 * 就全量可见，无需直供。
 * （导出供单元测试；运行时唯一消费方是 runPlanExecuteLoop）
 */
export function resolveSuggestedToolDefinitions(
  plan: TaskExecutionPlan,
  baseStreamOpts: AgentStreamOptions | undefined,
): ChatCompletionTool[] {
  const names = [
    ...new Set(plan.steps.flatMap((s) => s.suggestedTools ?? []).filter(Boolean)),
  ].slice(0, SUGGESTED_TOOLS_MAX);
  if (names.length === 0) return [];
  const builtinNames = new Set(
    (baseStreamOpts?.chatToolsBuiltin ?? []).map(toolNameOf).filter(Boolean),
  );
  const corpus = baseStreamOpts?.chatToolsExtra ?? [];
  if (corpus.length === 0) return [];
  const byName = new Map(corpus.map((t) => [toolNameOf(t), t] as const));
  const out: ChatCompletionTool[] = [];
  for (const name of names) {
    if (builtinNames.has(name)) continue;
    const tool = byName.get(name);
    if (tool) out.push(slimToolSchema(tool));
  }
  return out;
}

/**
 * 规划轮紧凑 system（2026-10-21）：只讲输出契约，不重复人格/记忆/展示协议。
 * 规划质量靠 steps 契约 + 相关工具名提示，不靠全量 chat system（那套 ~6k 字符/次）。
 */
const PLAN_SYSTEM_PROMPT = [
  "你是任务规划器。只输出一个 JSON 对象，不要 Markdown 围栏或任何解释文字。",
  '格式：{"goal":"一句话概括要达成的结果","steps":[{"id":"1","intent":"这一步做什么","successCriteria":"如何判定该步完成","suggestedTools":[]}]}',
  "步骤 2-6 个，必须可执行、可检验；suggestedTools 只能从给出的工具名中选，不确定就留空数组。",
].join("\n");

/** 规划提示里最多列出的相关工具名数量（BM25 top-N，避免把目录整本塞进计划轮）。 */
const PLAN_TOOL_HINTS_MAX = 16;

/** 规划轮的工具名提示：BM25 只取与用户任务相关的少量名字，不传任何 schema。 */
function planToolHints(
  baseStreamOpts: AgentStreamOptions | undefined,
  userText: string,
): string[] {
  const corpus = [
    ...(baseStreamOpts?.chatToolsBuiltin ?? []),
    ...(baseStreamOpts?.chatToolsExtra ?? []),
  ];
  if (corpus.length === 0) return [];
  try {
    const hits = bm25HitsForQuery(userText, corpus, PLAN_TOOL_HINTS_MAX);
    return [...new Set(hits.map((h) => h.name).filter(Boolean))];
  } catch {
    return [];
  }
}

function buildPlanSystemPrompt(
  baseStreamOpts: AgentStreamOptions | undefined,
  userText: string,
): string {
  const hints = planToolHints(baseStreamOpts, userText);
  return hints.length > 0
    ? `${PLAN_SYSTEM_PROMPT}\n可用工具名（参考，只填确实要用的）：${hints.join(", ")}`
    : PLAN_SYSTEM_PROMPT;
}

async function emitPhase(
  _onPhaseStatus: ((label: string) => void) | undefined,
  onDelta: StreamDeltaHandler | undefined,
  label: string,
): Promise<void> {
  await Promise.resolve();
  // 进度由主 Agent 在执行阶段流式生成，不再推送固定阶段文案。
  if (isPeVerboseStreamEnabled()) {
    onDelta?.(`\n━━ ${label} ━━\n`);
  }
}

function buildPhaseLabel(phase: string, detail?: { stepCount?: number; currentStep?: string; totalSteps?: number }): string {
  const d = detail;
  if (!d) return phase;
  const parts = [phase];
  if (d.stepCount != null && d.stepCount > 1) parts.push(`（共 ${d.stepCount} 步）`);
  if (d.currentStep) parts.push(d.currentStep);
  if (d.totalSteps != null && d.currentStep) parts.push(`[${d.currentStep}/${d.totalSteps}]`);
  return parts.join("");
}

type RunPlanExecuteLoopArgs = {
  provider: ExternalChatProvider;
  planSessionId: string;
  userText: string;
  /** 与首轮用户消息对齐的视觉上下文；仅并入「执行」与「计划失败兜底」请求，不进入计划 JSON / 自检纯文本轮 */
  visionFrames?: VisionFrame[];
  onDelta?: StreamDeltaHandler;
  /** 计划/执行/自检阶段口语化进度（供 WS chat.agent_status），不写入正文流 */
  onPhaseStatus?: (label: string) => void;
  /** plan_execute 计划生成后回调，供上层发 chat.execution_event(plan_step) */
  onPlanReady?: (plan: { goal: string; steps: { id: string; intent: string; successCriteria?: string; suggestedTools?: string[] }[] }) => void;
  /** 启用工具时必须传入（与 AgentCore 一致） */
  toolCtx: ChatToolExecutionContext | undefined;
  /** 不包含 toolLoop（由编排器在每轮执行拼接） */
  baseStreamOpts: AgentStreamOptions | undefined;
  onToolBatchForExecute?: ((info: ToolLoopAfterBatchInfo) => void) | undefined;
  /**
   * 反思上下文（可选）。由编排器/PlanExecuteLoopStrategy 传入，用于激活
   * exhaustedRetries / verifyReflection 字段（不再恒 false/""）。
   * 不传则保持默认（兼容旧路径直调与 PlannerCortex 适配器）。
   */
  reflectionContext?: {
    replanCount: number;
    maxReplans: number;
    lastDeviation?: string;
  };
};

export async function runPlanExecuteLoop(args: RunPlanExecuteLoopArgs): Promise<PlanExecuteLoopResult> {
  const {
    provider,
    planSessionId,
    userText,
    visionFrames,
    onDelta,
    toolCtx,
    baseStreamOpts,
    onToolBatchForExecute,
    onPhaseStatus,
    onPlanReady,
    reflectionContext,
  } = args;

  // 反思字段激活：由调用方传入的 reflectionContext 驱动；未传入时为默认值（兼容旧路径）。
  const exhaustedRetries = reflectionContext
    ? reflectionContext.replanCount >= reflectionContext.maxReplans
    : false;
  const verifyReflection = reflectionContext?.lastDeviation ?? "";

  provider.clearSession?.(planSessionId);

  let modelCalls = 0;

  await emitPhase(onPhaseStatus, onDelta, "🔍 正在分析任务，制定执行计划…");

  const planUserTurn: ChatUserTurn = {
    text: [
      "用户任务：",
      truncate(userText, 8000),
      "",
      "请只输出**一个合法 JSON 对象**（不要用 Markdown 代码围栏，不要其它说明文字），格式如下：",
      '{"goal":"用一句话概括用户要达成的结果","steps":[{"id":"1","intent":"该步要做什么","successCriteria":"如何判定该步完成","suggestedTools":[]}]}',
      "suggestedTools 为可选字符串数组，填你认为可能用到的工具名；若不确定可填 []。",
      "steps 至少 1 步，且必须可执行、可检验。",
    ].join("\n"),
  };

  // 规划轮收敛（2026-10-21）：不带工具、不带全量 system/画像记忆。
  // 此前沿用 baseStreamOpts → 一次计划调用就重发整套 chat 底板（system ~6k 字符 +
  // 工具 schema）；计划只需要「任务 → 步骤」的契约，用紧凑 system 足矣。
  const planOpts: AgentStreamOptions = {
    ...baseStreamOpts,
    systemPromptOverride: buildPlanSystemPrompt(baseStreamOpts, userText),
    // 覆盖掉 baseStreamOpts 里的画像/记忆拼装与工具面
    promptContext: undefined,
    suppressRuntimeSuffixes: true,
    // 连功能性后缀（回复规则/展示协议等）一并裁掉：规划轮只要 JSON 契约
    functionalSuffixes: false,
    chatToolsBuiltin: [],
    chatToolsExtra: [],
    toolExposureProfile: "none",
    auditStage: "task_plane_plan",
    maxThreadMessages: 8,
  };

  let planAssistant = "";
  try {
    planAssistant = await provider.streamCompletion(
      planSessionId,
      planUserTurn,
      () => {},
      undefined,
      planOpts,
    );
    modelCalls += 1;
  } catch (err) {
    // 规划失败不阻断任务：退回执行轮（工具循环内部自带波内规划），与解析失败同路径
    // eslint-disable-next-line no-console
    console.warn(
      `[plan-execute] 规划轮失败，退回直接执行: ${err instanceof Error ? err.message : String(err)}`,
    );
    planAssistant = "";
  }

  const plan = planAssistant ? parseExecutionPlan(planAssistant) : null;

  // 规划脚手架（指令 + JSON 原文）不进入执行波：计划已紧凑写进 executePrompt，
  // 清空后执行轮只从 full system + 原任务 + 计划重建，避免规划轮残留在每一波重发。
  provider.clearSession?.(planSessionId);

  // v2：计划生成后立即回调，让上层发 chat.execution_event(plan_step, status=pending)
  if (plan && !isPlanTriviallySimple(plan) && onPlanReady) {
    onPlanReady(plan);
  }

  if (!plan || isPlanTriviallySimple(plan)) {
    if (plan) {
      await emitPhase(onPhaseStatus, onDelta, "⚡ 计划已确认，开始执行…");
    } else {
      await emitPhase(onPhaseStatus, onDelta, "⚡ 直接进入执行环节…");
    }
    const fallbackTurn: ChatUserTurn = {
      text: userText,
      ...(visionFrames?.length ? { visionFrames } : {}),
    };
    const full = await provider.streamCompletion(
      planSessionId,
      fallbackTurn,
      (d) => onDelta?.(d),
      toolCtx,
      {
        ...baseStreamOpts,
        ...(onToolBatchForExecute ? { toolLoop: { onAfterToolBatch: onToolBatchForExecute } } : {}),
      },
    );
    modelCalls += 1;
    return {
      finalText: full,
      modelCalls,
      plan: null,
      exhaustedRetries,
      verifyReflection,
    };
  }

  await emitPhase(
    onPhaseStatus,
    onDelta,
    `🔧 按计划执行中（${plan.steps.length} 步）…`,
  );

  const executePrompt = [
    "用户原始任务：",
    truncate(userText, 6000),
    "",
    "已批准的执行计划（必须以此为纲，逐步完成）：",
    // 紧凑序列化：pretty-print 比紧凑多 ~25-35% 字符（2026-09-05）。
    JSON.stringify(plan),
    "",
    "请调用可用工具收集事实并完成任务；最后用自然语言向用户汇总结果（含关键数据依据）。若某工具失败应换策略或说明阻塞点。",
  ].filter(Boolean).join("\n");

  // 计划直供预载（2026-10-10 编排器协同）：模型自声明的 suggestedTools 转正
  // 进执行轮可见集——比任何词面检索通道都可靠的意图来源。幻觉名/已可见名在
  // resolveSuggestedToolDefinitions 内部过滤，空集时保持 baseStreamOpts 原样。
  const suggestedDefinitions = resolveSuggestedToolDefinitions(plan, baseStreamOpts);
  const executeOpts: AgentStreamOptions = {
    ...baseStreamOpts,
    ...(suggestedDefinitions.length > 0
      ? {
          chatToolsBuiltin: dedupeToolsByName([
            ...(baseStreamOpts?.chatToolsBuiltin ?? []),
            ...suggestedDefinitions,
          ]),
        }
      : {}),
    ...(onToolBatchForExecute ? { toolLoop: { onAfterToolBatch: onToolBatchForExecute } } : {}),
  };

  const executeTurn: ChatUserTurn = {
    text: executePrompt,
    ...(visionFrames?.length ? { visionFrames } : {}),
  };

  const full = await provider.streamCompletion(
    planSessionId,
    executeTurn,
    (d) => onDelta?.(d),
    toolCtx,
    executeOpts,
  );
  modelCalls += 1;

  return {
    finalText: full,
    modelCalls,
    plan,
    exhaustedRetries,
    verifyReflection,
  };
}
