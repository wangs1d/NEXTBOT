// Agent Brain Center — DecisionHub（决策中心协调层）
//
// 职责：统一被动认知（cognize）和主动决策（decide）的共享能力，
// 解决 cognize 与 ProactionCortex 各自独立召回记忆/状态/能力的割裂问题。
//
// 设计原则：
//  1. 共享认知能力：记忆召回、用户状态感知、能力快照、最近决策——一次收集多处复用
//  2. 规则驱动路由：委托 RuleRouter，不调 LLM，避免幻觉
//  3. 规则化记忆写入：基于路由结果 + 用户消息内容规则化生成记忆条目，不让 LLM 自由发挥
//  4. 统一动作执行：通过 ActionExecutor 调度，统一安全检查和日志
//  5. 不破坏现有 ProactionCortex.decide 实现：主动路径仍走 ProactionCortex，DecisionHub 仅提供共享能力
//
// 接入关系：
//  - BrainCenter.cognize 阶段 2 调用 DecisionHub.decidePassive() 完成规则路由 + 记忆 + 动作
//  - BrainCenter.decide 仍委托 ProactionCortex.decide，但 ProactionCortex 可通过 DecisionHub 共享上下文

import type {
  BrainDecisionAction,
  CapabilityDescriptor,
  CognitiveContext,
  CognitiveInput,
  EmotionVector,
  MemoryItem,
  MemoryRecallItem,
  UserActivityState,
} from "./types.js";
import { RuleRouter, type RuleRouteDecision } from "./rule-router.js";
import { ActionExecutor } from "./action-executor.js";
import type { WorkingMemoryCortex, WorkingMemorySnapshot } from "./working-memory-cortex.js";
import type { TaskSwitchingCortex, SwitchIntent, TaskContext } from "./task-switching-cortex.js";
import type { ContextCortex, SituatedContext } from "./context-cortex.js";
import type { ToolPlanningCortex, ToolPlan } from "./tool-planning-cortex.js";
import type { OnlineLearningCortex, UserProfile } from "./online-learning-cortex.js";

// ---- 外观接口 ------------------------------------------------------------

export interface MemoryCortexLike {
  remember(actorId: string, item: MemoryItem): Promise<void>;
  recall(
    actorId: string,
    query: string,
    opts?: { limit?: number },
  ): Promise<{ items: MemoryRecallItem[] } | null>;
}

export interface AwarenessCortexLike {
  observe(actorId: string): UserActivityState | null;
}

export interface CapabilityCortexLike {
  snapshot(actorId?: string): CapabilityDescriptor[];
  introspect(actorId: string): CapabilityDescriptor[];
}

// ---- AnticipationEngine 外观接口（已存在服务，可选注入） ----------------

/**
 * AnticipationEngineService 的最小化接口。
 * 已存在于 services/anticipation-engine-service.ts，此处仅声明 DecisionHub 依赖的子集。
 */
export interface AnticipationEngineLike {
  /**
   * 预测用户下一意图。
   * 输入当前对话/活动上下文，输出可能意图 + 置信度。
   */
  predictNextIntent?(
    actorId: string,
    currentInput: { text?: string; activity?: string },
  ): Promise<{ intent: string; confidence: number; preparationHints?: string[] } | null>;
}

// ---- 决策结果类型 --------------------------------------------------------

/**
 * 被动决策结果：cognize 阶段 2 产出的完整决策。
 * 替代原 CognitiveEngine.cognize 的返回值，但 response 始终为空字符串
 * （由 streamCompletion 生成响应，避免 LLM 幻觉）。
 */
export interface PassiveDecisionResult {
  /** 路由决策（来自 RuleRouter，不调 LLM） */
  route: RuleRouteDecision;
  /** 响应：始终为空字符串，由 streamCompletion 生成 */
  response: string;
  /** 规则化生成的记忆条目 */
  memoryWrites: MemoryItem[];
  /** 基于路由规则触发的动作（如有） */
  action?: { tool: string; args: Record<string, unknown>; reason: string };
  /** 是否需要进工具循环（fast 时 true，让主 Agent 走工具循环） */
  needsToolLoop: boolean;
  /** 规则路由的理由 */
  rationale: string;
  /** 规则路由的置信度（0-1） */
  confidence: number;
  /** 置信度来源说明 */
  confidenceReason: string;
  /**
   * 工具规划链（complex 路由时由 ToolPlanningCortex 生成）。
   * 注入到 streamCompletion 的 system prompt，约束 LLM 工具选择顺序和范围。
   * fast 路由或 ToolPlanningCortex 未注册时为 null。
   */
  toolPlan?: ToolPlan | null;
}

// ---- 共享上下文 ----------------------------------------------------------

/**
 * 共享认知上下文：一次收集，多处复用。
 * 由 gatherContext() 收集，供 cognize/decide 共享使用。
 * Step 7 扩展：新增 workingMemory / situation / anticipatedIntent / currentTask / userPattern
 */
export interface SharedContext {
  memories: MemoryRecallItem[];
  userActivity: UserActivityState | null;
  capabilities: CapabilityDescriptor[];
  emotion: EmotionVector | null;
  /** Step 7 扩展：工作记忆快照（前额叶 - 当前任务上下文） */
  workingMemory?: WorkingMemorySnapshot;
  /** Step 7 扩展：当前活跃任务（任务栈顶） */
  currentTask?: TaskContext | null;
  /** Step 7 扩展：多源融合情境（颞顶联合区） */
  situation?: SituatedContext;
  /** Step 7 扩展：意图预判（下一可能意图） */
  anticipatedIntent?: { intent: string; confidence: number; preparationHints?: string[] } | null;
  /** Step 7 扩展：用户画像（在线学习） */
  userPattern?: UserProfile;
  gatheredAt: string;
}

// ---- DecisionHub 主类 ---------------------------------------------------

/**
 * 决策中心协调层。
 *
 * 不直接接管 cognize/decide 的完整流程，而是提供共享能力：
 *  - gatherContext: 统一收集记忆/状态/能力，避免 cognize 和 ProactionCortex 各自召回
 *  - decidePassive: 规则驱动的被动决策（替代 LLM 路由）
 *  - generateMemoryWrites: 规则化生成记忆条目
 *  - inferActionFromRoute: 基于路由规则触发动作
 *  - persistMemory: 统一记忆写入
 */
export class DecisionHub {
  private ruleRouter: RuleRouter;
  private actionExecutor: ActionExecutor;
  private memoryCortex: MemoryCortexLike | null = null;
  private awarenessCortex: AwarenessCortexLike | null = null;
  private capabilityCortex: CapabilityCortexLike | null = null;

  // ---- Step 7 扩展：新增 7 模块 + AnticipationEngine ----
  private workingMemory: WorkingMemoryCortex | null = null;
  private taskSwitching: TaskSwitchingCortex | null = null;
  private contextCortex: ContextCortex | null = null;
  private toolPlanning: ToolPlanningCortex | null = null;
  private onlineLearning: OnlineLearningCortex | null = null;
  private anticipationEngine: AnticipationEngineLike | null = null;

  constructor(ruleRouter: RuleRouter, actionExecutor: ActionExecutor) {
    this.ruleRouter = ruleRouter;
    this.actionExecutor = actionExecutor;
  }

  // ---- 子系统注册 -------------------------------------------------------

  registerMemory(memory: MemoryCortexLike): void {
    this.memoryCortex = memory;
  }

  registerAwareness(awareness: AwarenessCortexLike): void {
    this.awarenessCortex = awareness;
  }

  registerCapability(cap: CapabilityCortexLike): void {
    this.capabilityCortex = cap;
  }

  // ---- Step 7 扩展：新模块注册 ----

  registerWorkingMemory(wm: WorkingMemoryCortex): void {
    this.workingMemory = wm;
  }

  registerTaskSwitching(ts: TaskSwitchingCortex): void {
    this.taskSwitching = ts;
  }

  registerContextCortex(cc: ContextCortex): void {
    this.contextCortex = cc;
  }

  registerToolPlanning(tp: ToolPlanningCortex): void {
    this.toolPlanning = tp;
  }

  registerOnlineLearning(ol: OnlineLearningCortex): void {
    this.onlineLearning = ol;
  }

  registerAnticipationEngine(engine: AnticipationEngineLike): void {
    this.anticipationEngine = engine;
  }

  /** 深度优化：注册情绪调节器（让情绪影响路由） */
  registerEmotionModulator(em: import("./emotion-modulator.js").EmotionModulator): void {
    this.emotionModulator = em;
  }
  private emotionModulator: import("./emotion-modulator.js").EmotionModulator | null = null;

  // ---- 共享能力 ---------------------------------------------------------

  /**
   * 统一收集认知上下文。
   * 一次收集记忆/状态/能力，避免 cognize 和 ProactionCortex 各自独立召回。
   *
   * Step 7 扩展：新增 WorkingMemory / Situation / AnticipatedIntent / CurrentTask / UserPattern 并行收集。
   *
   * 性能优化（方案 A）：接受阶段 1 已收集的字段（memories/userActivity/capabilities/emotion），
   * 避免重复调用 MemoryCortex.recall / AwarenessCortex.observe / CapabilityCortex.snapshot。
   * 已收集字段非空时直接复用，未提供时才自己调用（向后兼容）。
   */
  async gatherContext(
    actorId: string,
    query: string,
    alreadyCollected?: {
      memories?: MemoryRecallItem[];
      userActivity?: UserActivityState | null;
      capabilities?: CapabilityDescriptor[];
    },
  ): Promise<SharedContext> {
    const tasks: [
      Promise<MemoryRecallItem[]>,
      Promise<UserActivityState | null>,
      Promise<CapabilityDescriptor[]>,
      Promise<WorkingMemorySnapshot | undefined>,
      Promise<TaskContext | null>,
      Promise<SituatedContext | undefined>,
      Promise<{ intent: string; confidence: number; preparationHints?: string[] } | null>,
      Promise<UserProfile | undefined>,
    ] = [
      // 1. 记忆召回（方案 A：已收集则复用）
      alreadyCollected?.memories
        ? Promise.resolve(alreadyCollected.memories)
        : (async () => {
            if (!this.memoryCortex) return [];
            try {
              const result = await this.memoryCortex.recall(actorId, query, { limit: 5 });
              return result?.items ?? [];
            } catch {
              return [];
            }
          })(),
      // 2. 用户状态感知（方案 A：已收集则复用）
      alreadyCollected?.userActivity !== undefined
        ? Promise.resolve(alreadyCollected.userActivity)
        : Promise.resolve(this.awarenessCortex?.observe(actorId) ?? null),
      // 3. 能力快照（方案 A：已收集则复用）
      alreadyCollected?.capabilities
        ? Promise.resolve(alreadyCollected.capabilities)
        : Promise.resolve(this.capabilityCortex?.snapshot(actorId) ?? []),
      // 4. Step 7: 工作记忆
      Promise.resolve(this.workingMemory?.load(actorId) ?? undefined),
      // 5. Step 7: 当前任务
      Promise.resolve(this.taskSwitching?.getCurrentTask(actorId) ?? null),
      // 6. Step 7: 多源情境融合（方案 A：传入已收集的 activity）
      (async () => {
        if (!this.contextCortex) return undefined;
        try {
          const ac =
            alreadyCollected?.userActivity !== undefined
              ? { activity: alreadyCollected.userActivity }
              : undefined;
          return await this.contextCortex.gatherContext(actorId, ac);
        } catch {
          return undefined;
        }
      })(),
      // 7. Step 7: 意图预判
      (async () => {
        if (!this.anticipationEngine?.predictNextIntent) return null;
        try {
          return await this.anticipationEngine.predictNextIntent(actorId, { text: query });
        } catch {
          return null;
        }
      })(),
      // 8. Step 7: 用户画像
      Promise.resolve(this.onlineLearning?.getProfile(actorId) ?? undefined),
    ];
    const [memories, userActivity, capabilities, workingMemory, currentTask, situation, anticipatedIntent, userPattern] =
      await Promise.all(tasks);
    return {
      memories,
      userActivity,
      capabilities,
      emotion: null, // emotion 由 BrainCenter.cognize 阶段 1 单独收集（limbic.inferEmotion）
      workingMemory,
      currentTask,
      situation,
      anticipatedIntent,
      userPattern,
      gatheredAt: new Date().toISOString(),
    };
  }

  /**
   * Step 7 扩展：意图预判。
   * 委托 AnticipationEngineService，预测用户下一意图。
   * 高置信度（>0.8）可触发主动准备。
   */
  async anticipateNext(
    actorId: string,
    currentInput: { text?: string; activity?: string },
  ): Promise<{ intent: string; confidence: number; preparationHints?: string[] } | null> {
    if (!this.anticipationEngine?.predictNextIntent) return null;
    try {
      return await this.anticipationEngine.predictNextIntent(actorId, currentInput);
    } catch (err) {
      console.log(`[DecisionHub] anticipateNext 失败（忽略）: ${err}`);
      return null;
    }
  }

  /**
   * 被动决策：用户消息触发的规则驱动决策。
   *
   * 替代原 CognitiveEngine.cognize 的 LLM 路由判断，纯规则产出：
   *  1. RuleRouter.route() 产出 {mode, confidence, reason, system}
   *  2. Step 7 扩展：TaskSwitchingCortex 识别任务切换意图（不破坏路由）
   *  3. Step 7 扩展：元认知桥评估置信度（叠加到路由 confidence 上）
   *  4. Step 7 扩展：ToolPlanningCortex 规划工具链（complex 时）
   *  5. 响应始终为空字符串（由 streamCompletion 生成，避免幻觉）
   *  6. 规则化生成记忆条目
   *  7. 基于路由规则触发动作（紧急事务走 complex 时附 safety_check action）
   *  8. needsToolLoop 由路由模式决定（fast/fast → true）
   */
  async decidePassive(
    input: CognitiveInput,
    context: CognitiveContext,
  ): Promise<PassiveDecisionResult> {
    const userText = input.text ?? "";

    // 1. 规则路由（不调 LLM）
    const route = this.ruleRouter.route(userText, context);

    // 1.5 深度优化：工作记忆影响路由（让 context.workingMemory 真正被消费）
    // 规则：有活跃 high/critical 目标且当前消息与该目标相关时 → 倾向 complex
    //      有 paused 任务且当前消息匹配该任务时 → 倾向 complex（任务恢复）
    //      工作记忆为空且当前消息是寒暄 → 保持 fast（避免无效升级）
    if (this.workingMemory && context.workingMemory) {
      const wm = context.workingMemory;
      const hasHighPriorityGoal = wm.goals.some(
        (g) => g.status === "active" && (g.priority === "high" || g.priority === "critical"),
      );
      const hasPausedTask = wm.goals.some((g) => g.status === "paused");
      const isSimpleGreeting = /^(你好|嗨|hi|hello|早|晚上好|下午好|在吗)/i.test(userText.trim());

      if (hasHighPriorityGoal && !isSimpleGreeting && route.mode === "direct") {
        // 有活跃高优先级目标时，升级 fast → complex（更谨慎处理）
        route.mode = "tool_loop";
        route.reason = `${route.reason}；工作记忆有活跃高优先级目标，升级到 complex`;
        route.confidence = Math.max(route.confidence - 0.1, 0.5); // 略降置信度，表示需要工具支撑
      }
      if (hasPausedTask && route.mode === "direct") {
        // 有暂停任务时，升级 complex（需要更多上下文以正确恢复/延续暂停任务）
        route.mode = "tool_loop";
        route.confidence = Math.max(route.confidence - 0.1, 0.5);
        route.reason = `${route.reason}；工作记忆有暂停任务，升级到 complex`;
      }
    }

    // 1.6 深度优化：情绪调节路由（让 context.emotion 真正影响决策）
    // 强负面情绪 → 升级到更谨慎路径；高唤醒 → 急速响应
    if (this.emotionModulator && context.emotion) {
      try {
        const modulated = this.emotionModulator.modulateRoute(route, context.emotion);
        if (modulated.adjusted) {
          route.mode = modulated.route.mode;
          route.reason = modulated.route.reason;
          route.confidence = modulated.route.confidence;
        }
      } catch (err) {
        console.log(`[DecisionHub] emotionModulator 失败（忽略）: ${err}`);
      }
    }

    // 1.7 深度优化：用户画像影响路由（让 context.userPattern 真正被消费）
    // 有频繁投诉/否定模式 → 升级 complex 更谨慎处理
    // 存在高频工具偏好 → 优先 fast 以快速响应
    if (context.userPattern) {
      const up = context.userPattern;
      try {
        // 高频否定模式 → 倾向 complex（用户可能对结果不满意，需要更认真处理）
        if (up.negativeFeedbackCount > 3 && route.mode === "direct") {
          route.mode = "tool_loop";
          route.reason = `${route.reason}；用户画像：高频否定(${up.negativeFeedbackCount}次)，升级到 complex`;
          route.confidence = Math.max(route.confidence - 0.1, 0.5);
        }
        // 极高频否定 → 进一步降置信度（即使已经是 complex）
        if (up.negativeFeedbackCount > 8) {
          route.confidence = Math.max(route.confidence - 0.15, 0.3);
          route.reason = `${route.reason}；用户画像：极高否定(${up.negativeFeedbackCount}次)，降低置信度`;
        }
        // 高频工具偏好 → 保持 fast（用户熟悉工具操作）
        if (up.preferredToolDomain && route.mode === "direct") {
          route.reason = `${route.reason}；用户画像：偏好${up.preferredToolDomain}领域`;
        }
        // 学习活跃期 → 尝试更深入的回答
        if (up.learningActive === true && route.mode === "direct") {
          route.reason = `${route.reason}；用户画像：学习活跃期`;
        }
      } catch (err) {
        console.log(`[DecisionHub] userPattern 路由影响失败（忽略）: ${err}`);
      }
    }

    // 2. Step 7 扩展：任务切换识别（纯规则，不破坏路由）
    let switchIntent: SwitchIntent | null = null;
    if (this.taskSwitching) {
      switchIntent = this.taskSwitching.recognizeIntent(userText);
      if (switchIntent.type !== "none" && switchIntent.confidence >= 0.7) {
        // 触发任务切换（pause/resume/switch/complete）
        try {
          this.taskSwitching.applyIntent(input.actorId, switchIntent, userText);
        } catch (err) {
          console.log(`[DecisionHub] taskSwitching.applyIntent 失败（忽略）: ${err}`);
        }
      }
    }

    // 4. Step 7 扩展：工具链规划（complex 时）
    let toolPlan: ToolPlan | null = null;
    if (this.toolPlanning && route.mode === "tool_loop") {
      try {
        toolPlan = this.toolPlanning.planTools(
          input.actorId,
          userText,
          context.capabilities,
          route,
        );
      } catch (err) {
        console.log(`[DecisionHub] toolPlanning.planTools 失败（忽略）: ${err}`);
      }
    }

    // 5. Step 7 扩展：在线学习观察（在 cognize 阶段 3 也会调用，此处提前观察）
    if (this.onlineLearning) {
      try {
        this.onlineLearning.observe(input.actorId, { text: userText }, route);
      } catch (err) {
        console.log(`[DecisionHub] onlineLearning.observe 失败（忽略）: ${err}`);
      }
    }

    // 6. Step 7 扩展：工作记忆更新（push 当前任务为目标）
    if (this.workingMemory && route.mode === "tool_loop") {
      try {
        // 性能优化（方案 C）：复用阶段 1 已加载的 wm 快照（内存引用），pushGoal/touch
        // 都接受同一 wm，避免内部重复 load。pushGoal 修改 wm 后引用同步更新。
        const wm = context.workingMemory;
        if (!wm) {
          console.log(`[DecisionHub] context.workingMemory 为空，pushGoal 将内部 load`);
        }
        const goalId = this.workingMemory.pushGoal(
          input.actorId,
          userText.slice(0, 100),
          route.confidence >= 0.9 ? "high" : "medium",
          wm,
        );
        // touch 用同一 wm 引用（已包含刚 push 的 goal），避免再 load
        this.workingMemory.touch(input.actorId, undefined, goalId, wm);
      } catch (err) {
        console.log(`[DecisionHub] workingMemory.pushGoal 失败（忽略）: ${err}`);
      }
    }

    // 7. 响应：始终为空字符串（由 streamCompletion 生成，避免幻觉）
    const response = "";

    // 8. 规则化生成记忆条目
    const memoryWrites = this.generateMemoryWrites(input, route, context);

    // 9. 基于路由规则触发动作
    const action = this.inferActionFromRoute(route, input);

    // 10. needsToolLoop 由路由模式决定
    const needsToolLoop = route.mode === "direct";

    // 11. 综合置信度：使用路由 confidence
    const finalConfidence = route.confidence;

    // 12. 综合理由：路由 reason + 工具规划
    const rationaleParts = [route.reason];
    if (toolPlan && toolPlan.capabilityGaps.length > 0) {
      rationaleParts.push(`能力缺口: ${toolPlan.capabilityGaps.join(",")}`);
    }
    if (switchIntent && switchIntent.type !== "none") {
      rationaleParts.push(`任务切换: ${switchIntent.type}`);
    }

    return {
      route,
      response,
      memoryWrites,
      action,
      needsToolLoop,
      rationale: rationaleParts.join(" | "),
      confidence: finalConfidence,
      confidenceReason: route.reason,
      toolPlan,
    };
  }

  /**
   * 规则化生成记忆写入条目。
   * 基于路由结果 + 用户消息内容规则化生成，不让 LLM 自由发挥。
   */
  generateMemoryWrites(
    input: CognitiveInput,
    route: RuleRouteDecision,
    _context: CognitiveContext,
  ): MemoryItem[] {
    const writes: MemoryItem[] = [];
    const userText = input.text ?? "";
    const now = new Date().toISOString();

    // 路由 1：complex → 写入"任务委派"记忆
    if (route.mode === "tool_loop") {
      writes.push({
        actorId: input.actorId,
        kind: "procedure",
        domain: "procedural",
        content: `委派子 Agent 处理：${userText.slice(0, 200)}`,
        importance: route.confidence >= 0.9 ? "high" : "medium",
        metadata: { tags: ["delegation", route.agentType ?? "unknown"] },
        source: "chat",
        timestamp: now,
      });
    }

    // 路由 2：complex + 紧急事务 → 写入"敏感操作"记忆
    if (route.mode === "tool_loop" && route.confidence >= 0.9) {
      writes.push({
        actorId: input.actorId,
        kind: "event",
        domain: "episodic",
        content: `敏感事务触发：${userText.slice(0, 200)}（confidence=${route.confidence}）`,
        importance: "critical",
        sensitivity: "personal",
        metadata: { tags: ["urgent", "transaction"] },
        source: "chat",
        timestamp: now,
      });
    }

    // 通用：写入对话上下文记忆（所有路由都写）。
    // 2026-11-04 修正：正文只放用户原话。此前拼的 `（路由：xxx）` 协议后缀会被
    // ltm-write-gate 的 TASK_STATE_RE（`（路由` 模式）整条拒掉——用户当轮陈述的
    // 持久事实（"我领养了只猫叫煤球"）从未到达 Mem0/叙事抽取器，长期记忆
    // "聊过但没存下"的总病根。路由信息已在 metadata.tags，无需进正文。
    writes.push({
      actorId: input.actorId,
      kind: "event",
      domain: "episodic",
      content: userText.slice(0, 200),
      importance: "medium",
      metadata: { tags: ["conversation", route.mode] },
      source: "chat",
      timestamp: now,
    });

    return writes;
  }

  /**
   * 基于路由规则触发动作。
   * 当前仅紧急事务场景生成 safety_check action，其他路由不触发动作
   * （工具调用由 streamCompletion 工具循环处理，环境控制由 ProactionCortex 处理）。
   */
  inferActionFromRoute(
    route: RuleRouteDecision,
    input: CognitiveInput,
  ): { tool: string; args: Record<string, unknown>; reason: string } | undefined {
    // 紧急事务场景：标记需要安全检查
    if (route.mode === "tool_loop" && route.confidence >= 0.9) {
      return {
        tool: "safety_check",
        args: {
          actorId: input.actorId,
          userText: input.text ?? "",
          reason: "urgent_transaction_safety_check",
        },
        reason: "紧急事务触发安全检查",
      };
    }
    return undefined;
  }

  /**
   * 统一记忆写入。
   * 把决策产出的记忆条目写入 MemoryCortex，失败不阻塞主流程。
   */
  async persistMemory(actorId: string, items: MemoryItem[]): Promise<void> {
    if (!this.memoryCortex || items.length === 0) return;
    for (const item of items) {
      try {
        await this.memoryCortex.remember(actorId, item);
      } catch (err) {
        console.log(`[DecisionHub] 记忆写入失败 actorId=${actorId}: ${err}`);
      }
    }
  }

  /**
   * 执行动作（封装 ActionExecutor）。
   * 供 BrainCenter 调用，统一动作执行入口。
   */
  async executeAction(
    action: BrainDecisionAction,
    opts: {
      actorId: string;
      source: "proaction" | "cognize" | "planner";
      signalKind?: string;
    },
  ): Promise<{ ok: boolean; result: Record<string, unknown> }> {
    return this.actionExecutor.execute(action.tool, action.args, opts);
  }

  /** 获取 RuleRouter 引用（供 BrainCenter 调用） */
  getRuleRouter(): RuleRouter {
    return this.ruleRouter;
  }

  /** 获取 ActionExecutor 引用（供 ProactionCortex/PlannerCortex 调用） */
  getActionExecutor(): ActionExecutor {
    return this.actionExecutor;
  }
}
