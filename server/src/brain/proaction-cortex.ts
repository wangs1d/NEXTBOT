// Agent Brain Center — ProactionCortex（主动皮层）
//
// 职责：主动认知决策层。接收 BrainSignalInput，端到端决定是否主动开口 + 说什么。
//
// 端到端调度原则（整体 BrainCenter 端到端的一部分）：
//  阶段 1 — 规则预筛（不调 LLM）：value/disturb 纯规则评分 + policy 硬闸门 +
//           B5 人格阈值粗筛 + B4 重复抑制。低价值信号直接 silent，不进 LLM。
//  阶段 2 — 端到端认知 LLM（仅通过粗筛才走）：EndToEndDecisionMaker 一次调用
//           完成"要不要说 + 说什么"，综合记忆/活动状态/价值打扰数值，像真人一气呵成。
//  阶段 3 — 后处理：shadow 模式 / 缓存 / 记录 speak kind / 话术写入 BrainDecision.message。
//
// 设计要点：
//  1. 规则层只做硬闸门和粗筛（policy/安全/阈值/重复抑制），不切片式调 LLM 判相关性。
//  2. 端到端 LLM 产出 {speak, message, reason}，message 直接写入 BrainDecision.message。
//  3. 未注入 EndToEndDecisionMaker 时回退规则决策（speak，message 留空交后续话术流程）。
//  4. 支持 legacy 模式：BRAIN_PROACTION_LEGACY=1 时拉起旧主动服务，cortex 进入 shadow。
//
// value / disturb 双轨评估：数值仅作规则粗筛 + LLM 参考输入，非硬性数值闸门。

import type {
  BrainDecision,
  BrainDecisionAction,
  BrainSignalInput,
  MemoryRecallItem,
} from "./types.js";
import type { ProactiveContactPolicyService } from "../services/proactive-contact-policy.js";
import type { ProactiveAgentCenter } from "../services/proactive-agent-center.js";
import type { ProactiveLifeRuntimeService } from "../services/proactive-life-runtime-service.js";

// ---- 内置权重表 ----------------------------------------------------------

// importance → 权重（0-10）
const IMPORTANCE_WEIGHT: Record<NonNullable<BrainSignalInput["importance"]>, number> = {
  critical: 9,
  high: 7,
  medium: 5,
  low: 3,
};

// 信号 kind → priority 映射（参考 proactive-agent-center.ts 的 BUILTIN_RULES）
const SIGNAL_PRIORITY_MAP: Record<string, number> = {
  transaction_completed: 7,
  task_completed: 6,
  skill_purchased: 5,
  post_created: 3,
  friend_request_received: 7,
  mood_shift: 4,
  // ProactivityHub 多元触发 kind（proactivity-types.ts ProactiveIntentKind）
  overwork_care: 7,
  task_celebration: 6,
  followup: 4,
  interest_share: 3,
  interest_alert: 5,
};

const DEFAULT_THRESHOLD = 2.0;
const RECENT_DECISIONS_LIMIT = 50;
/** 同 kind 信号在最近 N 毫秒内已 speak 过 → value 砍半（重复抑制） */
const REPEAT_SUPPRESS_WINDOW_MS = 10 * 60 * 1000;
/** B5: 人格对阈值的敏感度——t 偏离 0.5 时阈值的变化幅度（0.5 = ±50%） */
const PERSONALITY_SENSITIVITY = 0.5;

// ---- 辅助函数 ------------------------------------------------------------

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/** 检查是否启用 legacy 模式（旧主动服务接管，cortex 进入 shadow） */
function isLegacyEnabled(): boolean {
  const raw = process.env.BRAIN_PROACTION_LEGACY?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "on";
}

/**
 * 检查是否启用 inferActions 的 LLM 化（端到端决策返回 actions）。
 * - "0" / "false" / "off"（不区分大小写）→ 返回 false（关闭 LLM 化，回退到纯规则 inferActions）
 * - 其他（含未设置）→ 返回 true（启用 LLM 化，优先使用端到端决策返回的 actions）
 */
function isInferActionsLlmEnabled(): boolean {
  const raw = process.env.BRAIN_LLM_INFERACTIONS_ENABLED?.trim().toLowerCase();
  if (raw === "0" || raw === "false" || raw === "off") return false;
  return true;
}

/** 读取决策阈值（可通过 PROACTION_THRESHOLD env 调整，默认 2.0） */
function readThreshold(): number {
  const raw = process.env.PROACTION_THRESHOLD?.trim();
  if (!raw) return DEFAULT_THRESHOLD;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) ? n : DEFAULT_THRESHOLD;
}

/**
 * B5: 将人格标签映射为主动倾向因子 t ∈ [0,1]。
 * t=0 → 极度沉默，t=1 → 极度话痨，t=0.5 → 中性。
 * 算法净化点：用连续因子而非离散阈值（如"话痨=1.2，沉默=3.0"），
 * 阈值 = base × (1 - α × (t - 0.5)) 连续变化，无跳变。
 */
function personalityToTendency(personality: string | undefined): number {
  switch (personality) {
    case "talkative":  return 0.9;
    case "quiet":      return 0.1;
    default:           return 0.5; // normal / unknown
  }
}

/**
 * B5: 按 actor 人格计算个体阈值。
 * - 基础阈值由环境变量 PROACTION_THRESHOLD 控制（默认 2.0）
 * - 人格因子 t ∈ [0,1]：t 越高（话痨）阈值越低（更容易开口），t 越低（沉默）阈值越高
 * - 阈值 = base × (1 - α × (t - 0.5))，α=PERSONALITY_SENSITIVITY
 */
function computeActorThreshold(base: number, personality: string | undefined): number {
  const t = personalityToTendency(personality);
  const factor = 1 - PERSONALITY_SENSITIVITY * (t - 0.5);
  return base * factor;
}

function readNumber(
  meta: Record<string, unknown> | undefined,
  key: string,
  fallback: number,
): number {
  const v = meta?.[key];
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function readBoolean(
  meta: Record<string, unknown> | undefined,
  key: string,
  fallback: boolean,
): boolean {
  const v = meta?.[key];
  return typeof v === "boolean" ? v : fallback;
}

function readStringArray(meta: Record<string, unknown> | undefined, key: string): string[] {
  const v = meta?.[key];
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function readString(
  meta: Record<string, unknown> | undefined,
  key: string,
  fallback: string,
): string {
  const v = meta?.[key];
  return typeof v === "string" ? v : fallback;
}

// ---- 决策引擎外观接口 ----------------------------------------------------

/**
 * 决策引擎最小外观（外部决策引擎的结构适配接口，参数 unknown 保持宽松兼容）。
 *
 * 当前 ProactionCortex 仅存储引用，不实际调用其 decide（避免触发 LLM 链路）。
 * 未来若需接入更复杂的评分，可在此接口上扩展。
 */
export interface DecisionEngineLike {
  decide?(ctx: unknown): Promise<unknown>;
  evaluateValue?(ctx: unknown): { composite?: number; rationale?: string[] };
  evaluateDisturb?(trigger: unknown): { composite?: number; rationale?: string[] };
}

/**
 * AwarenessCortex 最小外观（鸭子类型，结构兼容即可注入）。
 * ProactionCortex 用它读取用户当前活动状态，调整 disturb 评分。
 */
export interface AwarenessCortexLike {
  observe(actorId: string): { activity: string; confidence: number } | null;
}

/**
 * MemoryCortex 最小外观（鸭子类型，结构兼容即可注入）。
 * 端到端决策时用它召回最近对话，作为 LLM 的记忆输入（像人"想起点什么"）。
 */
export interface MemoryCortexLike {
  recall(
    actorId: string,
    query: string,
    opts?: { domain?: string; limit?: number },
  ): Promise<{
    items: MemoryRecallItem[];
  }>;
  /** 端到端决策的工作记忆摘要输入（短字符串，可空）。可选——未实现时跳过 */
  toSummary?: (actorId: string) => string;
}

/**
 * 最近对话提供者：从 ChatThreadStore 拉取用户最近几轮实时对话。
 * 端到端决策时注入，让 LLM 能感知"用户刚说了什么、话题转到哪了"，
 * 避免在用户已转换话题后还回去讲旧话题（根源修复"重复且不正面回复"问题）。
 */
export interface RecentConversationProvider {
  /** 返回最近对话的文本摘要（如 "用户：xxx\nAgent：yyy"），无对话时返回空字符串 */
  fetchRecentConversation(actorId: string, limit?: number): string;
}

/**
 * 端到端决策上下文：把规则层算出的参考量 + 召回记忆 + 用户状态打包，
 * 一次性交给 LLM 完成"要不要说 + 说什么"。
 *
 * r6 优化：补充 workingMemoryBrief（活跃目标/槽位/待办的短摘要），
 * 让主动话术能感知"当前在聊什么"——避免突兀开口。
 * 不堆 prompt：仅一两句方向化描述，让模型基于上下文自己发挥。
 */
export interface EndToEndDecisionContext {
  recentMemories: Array<{ content: string; timestamp?: string }>;
  userActivity: { activity: string; confidence: number } | null;
  valueScore: number;
  disturbScore: number;
  recentDecisions: BrainDecision[];
  /** 活跃工作记忆摘要（活跃目标/槽位/待办），空字符串表示无活跃任务 */
  workingMemoryBrief?: string;
  /** 用户最近实时对话（2-3 轮文本摘要），让 LLM 感知当前话题走向 */
  recentConversation?: string;
}

/**
 * 端到端决策器：像真人一样一气呵成完成"要不要说 + 说什么"。
 *
 * 设计理念（端到端调度）：
 *  - 规则层只做硬闸门（policy/安全）+ 粗筛（低价值信号不进 LLM）；
 *  - 通过粗筛的信号走一次端到端 LLM 调用，把"判断 + 话术 + 理由"作为一个
 *    整体认知过程产出，不再切片式（先判相关性 → 再决策 → 再生成话术）。
 *  - value/disturb 数值作为 LLM 的参考输入，而非硬性数值闸门。
 *  - inferActions LLM 化：在同一次 LLM 调用中通过 function calling 风格的
 *    JSON 输出决定调用哪些环境控制工具（calendar/smart_home），不单独调一次 LLM。
 *    返回的 actions 供 ProactionCortex 直接执行；LLM 不可用/未返回时回退到 inferActions 硬编码规则。
 */
export interface EndToEndDecisionMaker {
  decide(
    signal: BrainSignalInput,
    context: EndToEndDecisionContext,
  ): Promise<{
    speak: boolean;
    message: string;
    reason: string;
    /** LLM 决定的环境控制动作（function calling 风格）；缺失或空时 ProactionCortex 回退到 inferActions 规则 */
    actions?: BrainDecisionAction[];
  }>;
}

/**
 * ActionExecutor 外观接口。
 * 让 ProactionCortex 在决策后能直接执行环境控制类动作，
 * 而非只发消息。bootstrap 注入 ToolRegistry 的包装。
 */
export interface ActionExecutorLike {
  execute(
    name: string,
    args: Record<string, unknown>,
    opts?: { actorId?: string },
  ): Promise<{ ok: boolean; result: Record<string, unknown> }>;
}

// ---- ProactionCortex -----------------------------------------------------

/**
 * ProactionCortex —— 主动皮层。
 *
 * 实现 ProactionCortexLike 接口（start / stop / decide / recentDecisions），
 * 并扩展注册方法以接入 contact policy 与 legacy 主动服务。
 */
export class ProactionCortex {
  // 注册的子系统
  private decisionEngine: DecisionEngineLike | null = null;
  private awarenessCortex: AwarenessCortexLike | null = null;
  /** 端到端决策的记忆皮层引用，用于召回最近对话作为 LLM 记忆输入 */
  private memoryCortex: MemoryCortexLike | null = null;
  /** 最近对话提供者：拉取用户实时对话，让主动决策感知当前话题走向 */
  private recentConversationProvider: RecentConversationProvider | null = null;
  /** 端到端决策器：一次 LLM 调用完成"要不要说 + 说什么" */
  private endToEndMaker: EndToEndDecisionMaker | null = null;
  private contactPolicy: ProactiveContactPolicyService | null = null;
  private legacyAgentCenter: ProactiveAgentCenter | null = null;
  private legacyLifeRuntime: ProactiveLifeRuntimeService | null = null;
  /** ActionExecutor：决策后直接执行环境控制类动作 */
  private actionExecutor: ActionExecutorLike | null = null;

  // 运行时状态
  private shadowMode = false;
  private started = false;
  private readonly recentDecisionsMap = new Map<string, BrainDecision[]>();
  private readonly lastDecisionAt = new Map<string, number>();
  /** B4: 重复抑制——记录每个 actor 最近 speak 过的 kind + 时间戳 */
  private readonly recentSpokenKinds = new Map<string, Array<{ kind: string; at: number }>>();

  // ---- 注册方法 ----------------------------------------------------------

  /** 注册外部决策引擎为决策入口（当前仅存储引用，供未来扩展） */
  registerDecisionEngine(engine: DecisionEngineLike): void {
    this.decisionEngine = engine;
    console.log("[ProactionCortex] 已注册 DecisionEngine");
  }

  /** B3: 注册 AwarenessCortex，让 disturb 评分能感知用户当前活动状态 */
  registerAwareness(awareness: AwarenessCortexLike): void {
    this.awarenessCortex = awareness;
    console.log("[ProactionCortex] 已注册 AwarenessCortex");
  }

  /** 注册 MemoryCortex，端到端决策时召回最近对话作为记忆输入 */
  registerMemory(memory: MemoryCortexLike): void {
    this.memoryCortex = memory;
    console.log("[ProactionCortex] 已注册 MemoryCortex（端到端记忆输入）");
  }

  /** 注册最近对话提供者：让主动决策能感知用户当前话题走向 */
  registerRecentConversationProvider(provider: RecentConversationProvider): void {
    this.recentConversationProvider = provider;
    console.log("[ProactionCortex] 已注册 RecentConversationProvider（实时对话上下文）");
  }

  /** 注册端到端决策器：一次 LLM 调用完成"要不要说 + 说什么" */
  registerEndToEndMaker(maker: EndToEndDecisionMaker): void {
    this.endToEndMaker = maker;
    console.log("[ProactionCortex] 已注册 EndToEndDecisionMaker");
  }

  /** 注册 ProactiveContactPolicyService（policy 闸门） */
  registerContactPolicy(policy: ProactiveContactPolicyService): void {
    this.contactPolicy = policy;
    console.log("[ProactionCortex] 已注册 ContactPolicy");
  }

  /** 注册旧 ProactiveAgentCenter（仅 legacy 模式启用） */
  registerLegacyProactiveAgentCenter(svc: ProactiveAgentCenter): void {
    this.legacyAgentCenter = svc;
    console.log("[ProactionCortex] 已注册 LegacyProactiveAgentCenter");
  }

  /** 注册旧 ProactiveLifeRuntimeService（仅 legacy 模式启用） */
  registerLegacyProactiveLifeRuntime(svc: ProactiveLifeRuntimeService): void {
    this.legacyLifeRuntime = svc;
    console.log("[ProactionCortex] 已注册 LegacyProactiveLifeRuntime");
  }

  /** 注册 ActionExecutor：让决策后能直接执行环境控制类动作（关窗/调空调/创建日程等） */
  registerActionExecutor(executor: ActionExecutorLike): void {
    this.actionExecutor = executor;
    console.log("[ProactionCortex] 已注册 ActionExecutor");
  }

  /** shadow 模式：只记录决策不实际发送（speak → shadow，silent 保持 silent） */
  setShadowMode(enabled: boolean): void {
    this.shadowMode = enabled;
    console.log(`[ProactionCortex] shadowMode=${enabled}`);
  }

  // ---- 生命周期 ----------------------------------------------------------

  async start(): Promise<void> {
    if (this.started) {
      console.log("[ProactionCortex] 已启动，跳过重复 start");
      return;
    }
    if (isLegacyEnabled()) {
      // legacy 模式：拉起旧服务，cortex 进入 shadow（只记录不发送）
      console.log("[ProactionCortex] legacy 模式启用，拉起旧主动服务");
      this.legacyAgentCenter?.start();
      this.legacyLifeRuntime?.start();
      this.setShadowMode(true);
    } else {
      // 默认：cortex 自主决策，start 为 no-op
      console.log("[ProactionCortex] cortex 模式启用（自主决策）");
    }
    this.started = true;
    console.log("[ProactionCortex] 启动完成");
  }

  async stop(): Promise<void> {
    if (!this.started) {
      console.log("[ProactionCortex] 未启动，跳过 stop");
      return;
    }
    if (isLegacyEnabled()) {
      this.legacyAgentCenter?.stop();
      this.legacyLifeRuntime?.stop();
    }
    this.started = false;
    console.log("[ProactionCortex] 已停止");
  }

  // ---- 核心决策 ----------------------------------------------------------

  /**
   * 端到端决策流水线：
   *  阶段 1 — 规则预筛（不调 LLM）：
   *    1a) value 纯规则评分（importance 权重 + kind priority）
   *    1b) B4 重复抑制（同 kind 窗口期内已 speak → value 砍半）
   *    1c) disturb 评分（时段 + 间隔 + mood + B3 用户活动状态）
   *    1d) policy 硬闸门（静音 / cooldown）
   *    1e) 阈值粗筛（B5 人格阈值）：gap < threshold → 直接 silent，不进 LLM
   *  阶段 2 — 端到端 LLM 决策（仅通过粗筛才走）：
   *    召回最近对话（MemoryCortex）+ 用户活动状态（AwarenessCortex）
   *    + value/disturb 数值 + 最近决策 → 一次 LLM 调用产出 {speak, message, reason}
   *  阶段 3 — 后处理：
   *    shadow 模式 / 缓存 / 记录 speak kind / 话术写入 BrainDecision.message
   */
  async decide(signal: BrainSignalInput): Promise<BrainDecision> {
    const { actorId } = signal;

    // === 阶段 1：规则预筛（不调 LLM）===
    // 1a) value 纯规则评分
    const value = this.evaluateValue(signal);

    // 1b) B4 重复抑制——同 kind 信号窗口期内已 speak 过 → value 砍半
    const recentSameKind = this.countRecentSpokenKind(actorId, signal.kind);
    const adjustedValueScore = recentSameKind > 0 ? value.score / 2 : value.score;

    // 1c) disturb 评分
    const disturb = this.evaluateDisturb(signal);

    // 1d) policy 硬闸门
    const policy = this.checkPolicy(signal, adjustedValueScore);

    // 1e) B5 人格阈值粗筛
    const personality = signal.metadata?.personality;
    const threshold = computeActorThreshold(
      readThreshold(),
      typeof personality === "string" ? personality : undefined,
    );
    const gap = adjustedValueScore - disturb.score;

    const rationaleParts: string[] = [...value.rationale, ...disturb.rationale];
    rationaleParts.push(`gap=${gap.toFixed(2)}`);
    rationaleParts.push(`threshold=${threshold.toFixed(2)}`);
    if (recentSameKind > 0) {
      rationaleParts.push(`repeat_suppress(kind=${signal.kind},count=${recentSameKind})`);
    }

    let outcome: BrainDecision["outcome"];
    let message: string | undefined;
    // Task 5: 端到端路径召回的记忆条目，携带到 BrainDecision 供 executeProactiveDecision 复用，
    // 避免对同一 LifeSignal 在 buildProactivePrompt 中重复召回。
    let recallItems: MemoryRecallItem[] | undefined;
    // inferActions LLM 化：端到端决策返回的环境控制动作（function calling 风格）。
    // 缺失或无效时回退到 inferActions 硬编码规则。
    let e2eActions: BrainDecisionAction[] | undefined;

    if (!policy.allowed) {
      // 硬闸门拦截（静音 / cooldown）→ silent，不进 LLM
      outcome = "silent";
      rationaleParts.push(`policy_blocked:${policy.reason ?? "unknown"}`);
    } else if (gap < threshold && signal.metadata?.direct !== true) {
      // 粗筛未通过（低价值信号）→ silent，不进 LLM。
      // direct 标记（InitiativeEngine 自主决策产生的信号）豁免本阈值——
      // 预筛公式对 LLM 自造 kind 的 4 分保底会误杀低/中重要度的自主主动；
      // 那条链路的克制判断已由 InitiativeEngine + 频控完成。
      outcome = "silent";
      rationaleParts.push(`prefilter:gap<${threshold.toFixed(2)}`);
    } else if (!this.endToEndMaker) {
      // 通过粗筛但未注入端到端决策器 → 回退规则决策（speak，message 留空交由后续话术流程）
      outcome = "speak";
      rationaleParts.push("fallback:no_e2e_maker");
    } else {
      // === 阶段 2：端到端 LLM 决策 ===
      const recentMemories = await this.recallRecentMemories(signal);
      recallItems = recentMemories; // Task 5: 透传 recall 上下文，供 buildProactivePrompt 复用
      const userActivity = this.observeUserActivity(actorId);
      const recentDecisions = this.recentDecisions(actorId, 5);
      // r6: 拉取工作记忆摘要（活跃目标/槽位/待办），让主动话术能感知"当前在聊什么"
      let workingMemoryBrief = "";
      try {
        workingMemoryBrief = this.memoryCortex?.toSummary?.(actorId) ?? "";
      } catch {
        /* ignore summary failure */
      }
      // 拉取用户最近实时对话，让 LLM 感知当前话题走向
      const recentConversation = this.fetchRecentConversation(actorId);
      try {
        const e2e = await this.endToEndMaker.decide(signal, {
          recentMemories,
          userActivity,
          valueScore: adjustedValueScore,
          disturbScore: disturb.score,
          recentDecisions,
          workingMemoryBrief,
          recentConversation,
        });
        if (e2e.speak) {
          outcome = "speak";
          message = e2e.message || undefined;
          rationaleParts.push(`e2e:speak(${e2e.reason || ""})`);
        } else {
          outcome = "silent";
          rationaleParts.push(`e2e:silent(${e2e.reason || ""})`);
        }
        // inferActions LLM 化：保存端到端决策返回的 actions，供后续优先使用
        if (isInferActionsLlmEnabled() && Array.isArray(e2e.actions) && e2e.actions.length > 0) {
          e2eActions = e2e.actions;
        }
      } catch (e) {
        // 端到端 LLM 调用失败 → 回退规则决策（gap 已通过粗筛，倾向 speak）
        outcome = "speak";
        rationaleParts.push(`e2e_failed:fallback_rule(${String(e).slice(0, 80)})`);
      }
    }

    // === 阶段 3：后处理 ===
    if (this.shadowMode && outcome === "speak") {
      outcome = "shadow";
      rationaleParts.push("shadow_override");
    }

    // 环境控制：outcome=speak 时，产出建议动作并直接执行。
    // inferActions LLM 化：优先使用端到端决策返回的 e2eActions（LLM function calling 风格），
    // 缺失或无效时回退到 inferActions 硬编码规则（travel→calendar / late_night→smart_home 等）。
    // 注意：此处不影响 speak/silent 决策（speak/silent 已由端到端 LLM 完成）。
    // 风险点4：LLM 返回的 actions 需经过白名单+信号场景双重过滤，防止幻觉导致非预期工具调用。
    let actions: BrainDecisionAction[] | undefined;
    if (outcome === "speak" || outcome === "shadow") {
      const llmActions = e2eActions ?? [];
      if (llmActions.length > 0) {
        // 过滤 LLM 幻觉：仅保留白名单工具 + 信号场景匹配的动作
        const filtered = this.filterLlmActions(llmActions, signal);
        if (filtered.length === 0) {
          // LLM actions 全部被过滤 → 回退到规则 inferActions
          actions = this.inferActions(signal);
          rationaleParts.push(`actions:${actions.length}(rule_fallback_filtered)`);
        } else {
          actions = filtered;
          rationaleParts.push(`actions:${actions.length}(llm_filtered:${llmActions.length - filtered.length} dropped)`);
        }
      } else {
        actions = this.inferActions(signal);
        if (actions.length > 0) {
          rationaleParts.push(`actions:${actions.length}(rule)`);
        }
      }
      if (actions && actions.length > 0) {
        // 直接执行动作（环境控制类，如关窗/调空调/创建日程）
        await this.executeActions(actions, actorId);
      }
    }

    const decision: BrainDecision = {
      actorId,
      outcome,
      valueScore: Number(adjustedValueScore.toFixed(2)),
      disturbScore: Number(disturb.score.toFixed(2)),
      rationale: rationaleParts.join(" | "),
      channel: policy.channel,
      decidedAt: new Date().toISOString(),
      message,
      actions: actions?.length ? actions : undefined,
      recallItems,
    };

    this.cacheDecision(actorId, decision);
    this.lastDecisionAt.set(actorId, Date.now());
    if (outcome === "speak" || outcome === "shadow") {
      this.recordSpokenKind(actorId, signal.kind);
    }

    return decision;
  }

  /**
   * 基于信号 kind/title 产出环境控制类建议动作。
   * 规则驱动（非 LLM），确保关键场景能直接动手做事：
   *  - 出行信号 → 创建日程提醒（calendar.create）
   *  - 截止日期信号 → 创建待办（calendar.create）
   *  - 深夜活动信号 → 调暗灯光（smart_home.control_device，若设备可用）
   *  - 市场异动信号 → 不直接操作（仅通知，金融操作需用户确认）
   */
  private inferActions(signal: BrainSignalInput): BrainDecisionAction[] {
    const actions: BrainDecisionAction[] = [];
    const kind = signal.kind.toLowerCase();
    const title = signal.title.toLowerCase();

    if (/travel|出行|出差|旅游|出发/.test(kind) || /travel|出行|出差/.test(title)) {
      actions.push({
        tool: "calendar",
        args: {
          action: "create",
          title: `出行提醒: ${signal.title}`,
          description: signal.summary ?? "",
          dueTime: "tomorrow_morning",
        },
        reason: "出行信号触发日程创建",
      });
    }

    if (/deadline|截止|到期|due/.test(kind) || /deadline|截止|到期/.test(title)) {
      actions.push({
        tool: "calendar",
        args: {
          action: "create",
          title: `待办: ${signal.title}`,
          description: signal.summary ?? "",
        },
        reason: "截止日期信号触发待办创建",
      });
    }

    if (/late_night|深夜|熬夜/.test(kind) || /late_night|深夜/.test(title)) {
      // 深夜活动 → 激活"晚安"场景（若设备可用）
      actions.push({
        tool: "smart_home",
        args: { action: "scene", scene_action: "activate", scene_name: "晚安" },
        reason: "深夜活动触发晚安场景",
      });
    }

    return actions;
  }

  // ---- 风险点4：LLM actions 幻觉过滤 ----

  /** 允许 LLM 调用的环境控制工具白名单 */
  private static readonly ACTION_TOOL_WHITELIST = new Set([
    "calendar",
    "smart_home",
    // ProactivityHub act 模式：过劳干预放音乐等场景
    "media.search",
    "media.play",
  ]);

  /**
   * 信号 kind/title 关键词 → 允许的工具集合映射。
   * LLM 只能对匹配信号场景的动作执行对应工具，避免在市场异动等无关信号上创建日程。
   * 未在映射中的信号场景 → 允许全部白名单工具（保守放行，避免过度过滤）。
   */
  private static readonly SIGNAL_TOOL_MAP: Array<{ keywords: RegExp; tools: Set<string> }> = [
    { keywords: /travel|出行|出差|旅游|出发|trip|flight|deadline|截止|到期|due|schedule|日程|待办|todo/, tools: new Set(["calendar"]) },
    { keywords: /late_night|深夜|熬夜|night|晚安|sleep|休息/, tools: new Set(["smart_home"]) },
    { keywords: /weather|天气|温度|temperature|hot|cold|热|冷/, tools: new Set(["smart_home"]) },
  ];

  /**
   * 过滤 LLM 返回的 actions：白名单 + 信号场景双重校验。
   *
   * 过滤规则：
   *  1. 工具必须在 ACTION_TOOL_WHITELIST 内（拒绝 calendar.delete / smart_home.delete 等危险操作）
   *  2. 信号场景匹配时，工具必须在对应 SIGNAL_TOOL_MAP 的允许集合内
   *  3. 信号场景未匹配任何映射 → 保守放行白名单工具（避免过度过滤合法动作）
   *
   * 被过滤的动作记日志便于排查 LLM 幻觉模式。
   */
  private filterLlmActions(actions: BrainDecisionAction[], signal: BrainSignalInput): BrainDecisionAction[] {
    const kind = signal.kind.toLowerCase();
    const title = signal.title.toLowerCase();
    const combined = `${kind} ${title}`;

    // 找到信号场景匹配的工具集（取首个命中）
    let allowedByScene: Set<string> | null = null;
    for (const mapping of ProactionCortex.SIGNAL_TOOL_MAP) {
      if (mapping.keywords.test(combined)) {
        allowedByScene = mapping.tools;
        break;
      }
    }

    const result: BrainDecisionAction[] = [];
    for (const action of actions) {
      // 校验1：白名单
      if (!ProactionCortex.ACTION_TOOL_WHITELIST.has(action.tool)) {
        console.log(`[ProactionCortex] LLM action 被过滤（非白名单工具）: ${action.tool}`);
        continue;
      }
      // 校验2：信号场景匹配时，工具必须在场景允许集合内
      if (allowedByScene && !allowedByScene.has(action.tool)) {
        console.log(
          `[ProactionCortex] LLM action 被过滤（信号场景不匹配）: ${action.tool} on signal[${signal.kind}]`,
        );
        continue;
      }
      result.push(action);
    }
    return result;
  }

  /** 执行建议动作：actionExecutor 未注册时只记日志不阻塞决策 */
  private async executeActions(actions: BrainDecisionAction[], actorId: string): Promise<void> {
    if (!this.actionExecutor) {
      console.log(`[ProactionCortex] ActionExecutor 未注册，跳过 ${actions.length} 个动作`);
      return;
    }
    for (const action of actions) {
      try {
        const result = await this.actionExecutor.execute(action.tool, action.args, { actorId });
        if (result.ok) {
          console.log(`[ProactionCortex] 动作执行成功: ${action.tool} (${action.reason})`);
        } else {
          console.log(`[ProactionCortex] 动作执行失败: ${action.tool} - ${JSON.stringify(result.result).slice(0, 100)}`);
        }
      } catch (err) {
        console.log(`[ProactionCortex] 动作异常: ${action.tool} - ${err}`);
      }
    }
  }

  /** 端到端决策的记忆召回：失败或无 memoryCortex 时返回空数组，不阻塞决策 */
  private async recallRecentMemories(
    signal: BrainSignalInput,
  ): Promise<MemoryRecallItem[]> {
    if (!this.memoryCortex) return [];
    try {
      const result = await this.memoryCortex.recall(signal.actorId, signal.title, { limit: 5 });
      return result?.items ?? [];
    } catch {
      return [];
    }
  }

  /** 拉取用户最近实时对话：无 provider 时返回空字符串，不阻塞决策 */
  private fetchRecentConversation(actorId: string): string {
    if (!this.recentConversationProvider) return "";
    try {
      return this.recentConversationProvider.fetchRecentConversation(actorId, 6);
    } catch {
      return "";
    }
  }

  /** 读取用户当前活动状态：无 awarenessCortex 时返回 null */
  private observeUserActivity(actorId: string): { activity: string; confidence: number } | null {
    if (!this.awarenessCortex) return null;
    try {
      return this.awarenessCortex.observe(actorId);
    } catch {
      return null;
    }
  }

  /** B4: 统计窗口期内同 kind 信号已 speak 过的次数 */
  private countRecentSpokenKind(actorId: string, kind: string): number {
    const list = this.recentSpokenKinds.get(actorId);
    if (!list) return 0;
    const now = Date.now();
    return list.filter((x) => x.kind === kind && now - x.at < REPEAT_SUPPRESS_WINDOW_MS).length;
  }

  /** B4: 记录一次 speak 的 kind（保留窗口期内的记录） */
  private recordSpokenKind(actorId: string, kind: string): void {
    const now = Date.now();
    const list = (this.recentSpokenKinds.get(actorId) ?? []).filter(
      (x) => now - x.at < REPEAT_SUPPRESS_WINDOW_MS,
    );
    list.push({ kind, at: now });
    this.recentSpokenKinds.set(actorId, list);
  }

  /** 返回某 actor 最近 N 条决策（默认 20） */
  recentDecisions(actorId: string, limit = 20): BrainDecision[] {
    const list = this.recentDecisionsMap.get(actorId);
    if (!list || list.length === 0) return [];
    return [...list].slice(-limit);
  }

  // ---- 评分实现 ----------------------------------------------------------

  /**
   * value 评分（纯规则，0-10）：
   *  - importance 权重（critical=9, high=7, medium=5, low=3）
   *  - kind priority（SIGNAL_PRIORITY_MAP，未知 kind 默认 4）
   *  - 加权：importance * 0.6 + kindPriority * 0.4
   *
   * 情境相关性判定已下沉到端到端决策（EndToEndDecisionMaker），
   * 规则层只算基础价值，不再切片式调 LLM 判相关性。
   */
  private evaluateValue(signal: BrainSignalInput): { score: number; rationale: string[] } {
    const importance = signal.importance ?? "medium";
    const importanceWeight = IMPORTANCE_WEIGHT[importance] ?? IMPORTANCE_WEIGHT.medium;
    const kindPriority = SIGNAL_PRIORITY_MAP[signal.kind] ?? 4;
    const baseScore = clamp(importanceWeight * 0.6 + kindPriority * 0.4, 0, 10);
    const rationale = [
      `value=${baseScore.toFixed(2)}`,
      `importance=${importance}(${importanceWeight})`,
      `kind=${signal.kind}(${kindPriority})`,
    ];
    return { score: baseScore, rationale };
  }

  /**
   * disturb 评分（0-10）：
   *  - 时段：深夜 23-6 → +3，工作时间 9-12/14-18 → +2，其他 → +1
   *  - 最近决策间隔：<5min → +3，<30min → +2，<60min → +1，>1h → +0
   *  - mood：若信号暗示 sad/stress/negative → +1
   */
  private evaluateDisturb(signal: BrainSignalInput): { score: number; rationale: string[] } {
    const hour = new Date().getHours();
    const hourPenalty = this.hourDisturbPenalty(hour);
    const recencyPenalty = this.recencyDisturbPenalty(signal.actorId);
    const moodPenalty = this.detectMoodDisturb(signal);
    // B3: 接入 AwarenessCortex 用户活动状态
    const activityPenalty = this.activityDisturbPenalty(signal.actorId, signal.importance ?? "medium");
    const score = clamp(hourPenalty + recencyPenalty + moodPenalty + activityPenalty.score, 0, 10);
    const rationale = [
      `disturb=${score.toFixed(2)}`,
      `hour=${hour}(+${hourPenalty})`,
      `recency(+${recencyPenalty})`,
      `mood(+${moodPenalty})`,
    ];
    if (activityPenalty.tag) rationale.push(activityPenalty.tag);
    return { score, rationale };
  }

  /**
   * B3: 用户活动状态打扰惩罚。
   * - busy（在工作应用）→ +3
   * - sleeping → +4（除非 critical 信号）
   * - just_off_work → -1（刚下班反而适合唠两句）
   * - idle/going_out/unknown → +0
   * AwarenessCortex 未注册或返回 null 时按 unknown 处理。
   */
  private activityDisturbPenalty(
    actorId: string,
    importance: string,
  ): { score: number; tag?: string } {
    if (!this.awarenessCortex) return { score: 0 };
    let state: { activity: string; confidence: number } | null = null;
    try {
      state = this.awarenessCortex.observe(actorId);
    } catch {
      return { score: 0 };
    }
    if (!state) return { score: 0 };
    const isCritical = importance === "critical";
    let score = 0;
    switch (state.activity) {
      case "busy":
        score = 3;
        break;
      case "sleeping":
        score = isCritical ? 1 : 4;
        break;
      case "just_off_work":
        score = -1;
        break;
      default:
        score = 0;
    }
    return { score, tag: `activity=${state.activity}(+${score})` };
  }

  /** 时段打扰惩罚：深夜 23-6 → +3，工作时间 9-12/14-18 → +2，其他 → +1 */
  private hourDisturbPenalty(hour: number): number {
    if (hour >= 23 || hour <= 6) return 3;
    if ((hour >= 9 && hour < 12) || (hour >= 14 && hour < 18)) return 2;
    return 1;
  }

  /** 最近决策间隔打扰惩罚：<5min → +3，<30min → +2，<60min → +1，>1h → +0 */
  private recencyDisturbPenalty(actorId: string): number {
    const last = this.lastDecisionAt.get(actorId);
    if (!last) return 0;
    const diffMin = (Date.now() - last) / 60_000;
    if (diffMin < 5) return 3;
    if (diffMin < 30) return 2;
    if (diffMin < 60) return 1;
    return 0;
  }

  /** mood 打扰惩罚：若信号暗示 sad/stress/negative → +1 */
  private detectMoodDisturb(signal: BrainSignalInput): number {
    const meta = signal.metadata;
    if (!meta) return 0;
    const mood = readString(meta, "mood", "");
    const emotionTags = readStringArray(meta, "emotionTags");
    const sentiment = readNumber(meta, "sentimentScore", 0);
    const pattern = /(sad|stress|negative|down|anxious|tired|exhausted|depress)/i;
    if (mood && pattern.test(mood)) return 1;
    if (emotionTags.some((t) => pattern.test(t))) return 1;
    if (sentiment < 0) return 1;
    return 0;
  }

  // ---- policy 闸门 -------------------------------------------------------

  /**
   * 调用 contact policy 检查是否被静音 / cooldown。
   * 若未注册 policy，默认放行。
   * 从 signal.metadata 尽力提取 policy 所需字段，缺失字段使用默认值。
   */
  private checkPolicy(
    signal: BrainSignalInput,
    valueScore: number,
  ): { allowed: boolean; reason?: string; channel?: string } {
    if (!this.contactPolicy) {
      return { allowed: true, reason: "no_policy" };
    }
    const meta = signal.metadata;
    const decision = this.contactPolicy.decide({
      actorId: signal.actorId,
      category: readString(meta, "category", signal.kind),
      urgency: readNumber(meta, "urgency", valueScore),
      confidence: readNumber(meta, "confidence", 0.7),
      tags: readStringArray(meta, "tags"),
      wsConnected: readBoolean(meta, "wsConnected", true),
      recentContactCountHour: readNumber(meta, "recentContactCountHour", 0),
      recentContactCountDay: readNumber(meta, "recentContactCountDay", 0),
      relationship: null,
      timeRhythm: null,
      styleProfile: null,
      preference: null,
    });
    return {
      allowed: decision.allowed,
      reason: decision.reason,
      channel: decision.channel,
    };
  }

  // ---- 缓存 --------------------------------------------------------------

  /** 缓存决策到 Map<actorId, BrainDecision[]>，保留最近 50 条 */
  private cacheDecision(actorId: string, decision: BrainDecision): void {
    const list = this.recentDecisionsMap.get(actorId) ?? [];
    list.push(decision);
    if (list.length > RECENT_DECISIONS_LIMIT) {
      list.splice(0, list.length - RECENT_DECISIONS_LIMIT);
    }
    this.recentDecisionsMap.set(actorId, list);
  }
}

