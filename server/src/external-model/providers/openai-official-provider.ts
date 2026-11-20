import OpenAI from "openai";

import { preparePromptCachePlan } from "../prefix-cache.js";
import {
  AbstractChatProvider,
  type SystemAndPlanContext,
  type SystemAndPlanResult,
} from "../abstract-chat-provider.js";
import type { AgentStreamOptions } from "../types.js";

const SYSTEM_PROMPT =
  "You are a helpful, safe assistant. Respond in the same language the user uses when appropriate (Chinese or English). Refuse requests involving illegal or harmful content.";

/**
 * OpenAI 官方 Chat Completions（流式）。
 * 环境变量：`OPENAI_API_KEY`（必填以启用）、`OPENAI_MODEL`、`OPENAI_BASE_URL`（可选，默认官方端点）。
 *
 * 继承 {@link AbstractChatProvider}：防串台（foldCompletedToolChains 根源折叠）、时间戳注入、
 * thread 维护等公共逻辑由基类模板方法固化，本类只实现 OpenAI 特有的 system prompt 缓存、
 * 智能模型路由与 extraBody 构造。
 */
export class OpenAiOfficialProvider extends AbstractChatProvider {
  readonly id = "openai";
  readonly displayLabel = "OpenAI";
  readonly capabilities = {
    toolCallingProtocol: "openai" as const,
    supportsParallelToolCalls: true,
    supportsVision: true,
    supportsThinking: false,
    supportsStreaming: true,
  };

  protected readonly systemPrompt = SYSTEM_PROMPT;
  protected readonly notEnabledErrorMessage = "OPENAI_API_KEY is not set";
  protected readonly client: OpenAI | null;
  protected readonly model: string;

  constructor() {
    super();
    const apiKey = process.env.OPENAI_API_KEY?.trim();
    const baseURL = (process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1").trim();
    this.model = (process.env.OPENAI_MODEL ?? "gpt-4o-mini").trim();
    this.client = apiKey
      ? new OpenAI({ apiKey, baseURL, timeout: 180_000, maxRetries: 2 })
      : null;
  }

  /**
   * 智能模型路由：根据任务复杂度和上下文选择最优模型
   * 预期效果：成本 -40%, 简单任务速度 +50%
   */
  selectOptimalModel(userText: string, messageCount: number): string {
    // 如果配置了强制使用特定模型，直接返回
    const forceModel = process.env.FORCE_MODEL?.trim();
    if (forceModel) return forceModel;

    // 分析任务复杂度
    const complexity = this.analyzeTaskComplexityForModel(userText, messageCount);

    // 可用模型池（按成本从低到高排序）
    const modelPool = [
      { name: process.env.FAST_MODEL || 'gpt-4o-mini', maxComplexity: 0.3 },
      { name: process.env.STANDARD_MODEL || 'gpt-4o', maxComplexity: 0.7 },
      { name: process.env.POWER_MODEL || 'gpt-4-turbo', maxComplexity: 1.0 },
    ];

    // 选择最适合的模型
    for (const modelConfig of modelPool) {
      if (complexity <= modelConfig.maxComplexity) {
        return modelConfig.name;
      }
    }

    // 默认返回标准模型
    return this.model;
  }

  /**
   * 分析任务复杂度（用于模型选择）
   * 返回值范围：0.0（最简单）到 1.0（最复杂）
   */
  private analyzeTaskComplexityForModel(userText: string, messageCount: number): number {
    let score = 0;

    // 1. 文本长度评分 (0 - 0.25)
    if (userText.length > 1000) score += 0.25;
    else if (userText.length > 500) score += 0.18;
    else if (userText.length > 200) score += 0.12;
    else if (userText.length > 50) score += 0.06;

    // 2. 问题数量评分 (0 - 0.15)
    const questionCount = (userText.match(/[？?。]/g) || []).length;
    score += Math.min(questionCount * 0.05, 0.15);

    // 3. 关键词复杂度评分 (0 - 0.25)
    const complexKeywords = [
      '分析', 'analyze', '比较', 'compare', '总结', 'summarize',
      '优化', 'optimize', '设计', 'design', '实现', 'implement',
      '架构', 'architecture', '算法', 'algorithm', '推理', 'reasoning'
    ];
    const matchedKeywords = complexKeywords.filter(kw =>
      userText.toLowerCase().includes(kw)
    ).length;
    score += Math.min(matchedKeywords * 0.05, 0.25);

    // 4. 上下文长度评分 (0 - 0.20)
    if (messageCount > 10) score += 0.20;
    else if (messageCount > 6) score += 0.15;
    else if (messageCount > 3) score += 0.08;

    // 5. 特殊模式检测 (0 - 0.15)
    const hasCodeBlock = userText.includes('```') || userText.includes('code');
    const hasMathExpression = /[\+\-\*\/\=\<\>\{\}]/.test(userText);
    const hasStructuredData = userText.includes('{') && userText.includes('}');

    if (hasCodeBlock) score += 0.08;
    if (hasMathExpression) score += 0.04;
    if (hasStructuredData) score += 0.03;

    return Math.min(score, 1.0);
  }

  // ── 基类钩子实现 ──────────────────────────────────────────────

  /** 智能模型路由：override 优先，否则按任务复杂度选择。 */
  protected resolveModel(
    streamOpts: AgentStreamOptions | undefined,
    userText: string,
    msgCount: number,
  ): string {
    const override = streamOpts?.modelOverride?.trim();
    if (override) return override;
    return this.selectOptimalModel(userText, msgCount);
  }

  /**
   * 构造 extraBody：thinking 开关 + fastProfile（对话面轻量档跳过强制 tool_choice）。
   *
   * deepseek-flash（V4.1-Flash）默认带思考链（实测每轮多 200+ reasoning tokens、明显拖慢快档），
   * 与旧 deepseek-chat 行为不一致：未显式表态时对其下发 thinking:disabled 保持快档语义；
   * disableThinking === false 视为调用方明确要思考，不附加字段。deepseek-reasoner 思考模型不受影响。
   */
  protected buildExtraBody(
    effectiveStreamOpts: AgentStreamOptions,
    model?: string,
  ): Record<string, unknown> | undefined {
    const out: Record<string, unknown> = {};
    const m = (model ?? "").toLowerCase();
    const wantsThinkingOff =
      effectiveStreamOpts.disableThinking === true ||
      (effectiveStreamOpts.disableThinking === undefined && m.includes("deepseek-flash"));
    if (wantsThinkingOff) {
      out.thinking = { type: "disabled" };
    }
    if (effectiveStreamOpts.toolExposureProfile === "contextual" || effectiveStreamOpts.toolExposureProfile === "light") {
      out.fastProfile = true;
    }
    // chat 车道采样放开（2026-10-06 语感治理 A，实现提升至基类 chatLaneSamplingExtraBody 共享）
    const merged = { ...this.chatLaneSamplingExtraBody(effectiveStreamOpts), ...out };
    return Object.keys(merged).length > 0 ? merged : undefined;
  }

  /**
   * 非工具分支请求同样 spread extraBody（2026-09-28 根修）。此前仅工具分支带
   * thinking 开关，所有纯文本调用（路由/情绪推断/识情/出口重写等 ephemeral）
   * 实际从未下发 thinking:disabled——deepseek-flash 自适应思考在情绪类文本上
   * 默默展开（实测 65 次识情调用里 33 次烧 300~1074 reasoning tokens），拖慢
   * 前置串行调用且抬高同 key 限流压力。fastProfile 仅在 toolExposureProfile
   * 存在时注入（纯文本调用不携带），spread 安全。
   */
  protected applyExtraBodyToPlainRequest(): boolean {
    return true;
  }

  /**
   * 构建 system 内容与 prompt cache plan（2026-08-28 注入路径统一）：
   * 单一出口 assembleSystemPrompt——minimal/overrideSys 与完整模式共用同一条
   * 组装链（finalize → 分层 → 家族合并），旧版"先 buildLayeredSystemPrompt 再
   * preparePromptCachePlan 内部重复渲染 + 5 分钟缓存"的三重构建已删除。
   */
  protected buildSystemAndPlan(ctx: SystemAndPlanContext): SystemAndPlanResult {
    const finalizeOptions = {
      tools: Boolean(ctx.tools && !ctx.overrideSys),
      agentAccessMode: ctx.streamOpts?.agentAccessMode,
      phoneBridgeOnline: ctx.streamOpts?.phoneBridgeOnline,
      ...(ctx.suppressSuffixes ? {
        suppressRuntimeSuffixes: true,
        functionalSuffixes: ctx.streamOpts?.functionalSuffixes !== false,
      } : {}),
    };

    const promptPlan = preparePromptCachePlan({
      providerId: this.id,
      model: ctx.model,
      // overrideSys（minimal/fast 身份）与默认 SYSTEM_PROMPT 走同一条组装链，
      // 记忆块统一由 assembler 附加（memory 为空时原样返回 base，行为兼容）。
      baseSystemPrompt: ctx.overrideSys || SYSTEM_PROMPT,
      memory: ctx.promptMemory,
      finalizeOptions,
      tools: ctx.toolSearchPrepared?.visibleTools,
      variant: ctx.tools ? "chat-tools" : "chat",
      // 展示形式协议只属于聊天面：ephemeral 工具调用（简报润色/摘要/改写等）
      // 不注入，否则模型声明的 [RENDER_HINT:xxx] 在无剥除层的下游直透用户屏幕。
      // 纯闲聊轮（chatLanePureChat）同样不注入——闲聊轮不需要 hint/卡片，
      // 更不该在聊天末尾挂 NEXT_UP 任务胶囊（协议禁令压不住，直接裁源头）。
      includeRenderProtocol:
        ctx.streamOpts?.ephemeralTurn !== true && ctx.streamOpts?.chatLanePureChat !== true,
      sessionId: ctx.sessionId,
    });

    return { sysContent: promptPlan.fullSystemPrompt, promptPlan };
  }
}
