import OpenAI from "openai";

import { preparePromptCachePlan } from "../prefix-cache.js";
import { zhipuThinkingExtras } from "../provider-profiles.js";
import {
  AbstractChatProvider,
  type SystemAndPlanContext,
  type SystemAndPlanResult,
} from "../abstract-chat-provider.js";
import type { AgentStreamOptions } from "../types.js";

const SYSTEM_PROMPT =
  "You are GLM, a large language model trained by Z.ai (Zhipu AI / 智谱). You are proficient in Chinese and English conversations. You provide users with safe, helpful, and accurate answers. GLM and Zhipu are proper nouns and should not be translated.";

/**
 * 智谱 BigModel 官方 OpenAI 兼容端点（2026-11-05 原生接入，此前只能借 `openai`
 * 槽或自选目录间接使用，槽位语义与真实能力错位）。
 *
 * 为什么要独立 provider id：GLM-5.3 系是**始终思考**模型，`thinking: {type:"disabled"}`
 * 直接 400（错误码 1210）；等效关思考只能走 `reasoning_effort:"low"`（实测
 * reasoning_tokens=0）。openai 槽位的档案假设无思考链、对 deepseek-flash 下发
 * thinking:disabled——挂错槽位 = 每个 GLM 请求都被 400 打回。
 *
 * 模型事实（2026-11-05 实测探针）：
 * - `glm-5.3-flash` / `glm-5.3`：200 可用；`glm-4.7-flash` 间歇 429（1305 访问量过大）；
 * - 思考计入输出预算：max_tokens=32 时 32 个 token 全部被思考吃光、content 为空、
 *   finish_reason="length"——小 max_tokens 的旁路调用必须按思考型放大（档案表
 *   THINKING_ROUTE），主对话链路默认不传 max_tokens 不受影响；
 * - 思考内容独立在 `reasoning_content` 字段，`content` 干净（无需 reasoning_split）；
 * - 图像输入未实测：capabilities.supportsVision 固定 false，vision-support 未登记
 *   glm-5.3 模式，不会注入 image_url，按纯文本对待最稳。
 *
 * 环境变量：`ZHIPU_API_KEY`（必填以启用）、`ZHIPU_MODEL`（默认 glm-5.3-flash）、
 * `ZHIPU_BASE_URL`（默认 https://open.bigmodel.cn/api/paas/v4）、
 * `ZHIPU_REASONING_EFFORT`（思考开启时的努力档，low|high|max）。
 */
export class ZhipuProvider extends AbstractChatProvider {
  readonly id = "zhipu";
  readonly displayLabel = "智谱 GLM";

  get capabilities() {
    return {
      toolCallingProtocol: "openai" as const,
      supportsParallelToolCalls: true,
      // glm-5.3 系图像输入未实测（探针只验了纯文本对话），按纯文本对待：
      // vision-support 不含 glm-5.3 模式，注入层自然不命中。
      supportsVision: false,
      supportsThinking: true,
      supportsStreaming: true,
      // 官方窗口未实测确认，取保守值——context 裁剪只会提前触发，不会爆上下文。
      maxContextTokens: 131_072,
    };
  }

  protected readonly systemPrompt = SYSTEM_PROMPT;
  protected readonly notEnabledErrorMessage = "ZHIPU_API_KEY is not set";
  protected readonly client: OpenAI | null;
  protected readonly model: string;

  constructor() {
    super();
    const apiKey = process.env.ZHIPU_API_KEY?.trim();
    const baseURL = (process.env.ZHIPU_BASE_URL ?? "https://open.bigmodel.cn/api/paas/v4").trim();
    this.model = (process.env.ZHIPU_MODEL ?? "glm-5.3-flash").trim();
    this.client = apiKey
      ? new OpenAI({ apiKey, baseURL, timeout: 180_000, maxRetries: 2 })
      : null;
  }

  /**
   * 与 Kimi/MiniMax/DeepSeek 同契约：默认等效关思考（GLM 关不掉，降级为
   * effort=low，实测 reasoning_tokens=0）；显式 `disableThinking: false`（PRO 档）
   * 放开思考——思考型模型在复杂任务上回复质量更好。
   */
  protected resolveEffectiveStreamOpts(
    streamOpts: AgentStreamOptions | undefined,
  ): AgentStreamOptions {
    return { ...(streamOpts ?? {}), disableThinking: streamOpts?.disableThinking !== false };
  }

  protected buildSystemAndPlan(ctx: SystemAndPlanContext): SystemAndPlanResult {
    const promptPlan = preparePromptCachePlan({
      providerId: this.id,
      model: ctx.model,
      baseSystemPrompt: ctx.overrideSys || SYSTEM_PROMPT,
      // memory 恒透传（minimal 的 overrideSys 只省后缀，不丢动态事实层——
      // 【当前时间】块/检索证据/用户档案都在这里，丢了模型只能编时间）。
      memory: ctx.promptMemory,
      finalizeOptions: {
        tools: Boolean(ctx.tools && !ctx.overrideSys),
        masterSubAgentDelegate: ctx.streamOpts?.masterSubAgentDelegate,
        agentAccessMode: ctx.streamOpts?.agentAccessMode,
        desktopBridgeOnline: ctx.streamOpts?.desktopBridgeOnline,
        phoneBridgeOnline: ctx.streamOpts?.phoneBridgeOnline,
        ...(ctx.suppressSuffixes
          ? {
              suppressRuntimeSuffixes: true,
              functionalSuffixes: ctx.streamOpts?.functionalSuffixes !== false,
            }
          : {}),
      },
      tools: ctx.toolSearchPrepared?.visibleTools,
      variant: ctx.tools ? "chat-tools" : "chat",
      // 展示形式协议只属于聊天面：ephemeral 调用的 [RENDER_HINT] 无剥除层，直透屏幕。
      includeRenderProtocol:
        ctx.streamOpts?.ephemeralTurn !== true && ctx.streamOpts?.chatLanePureChat !== true,
      sessionId: ctx.sessionId,
    });
    return { sysContent: promptPlan.fullSystemPrompt, promptPlan };
  }

  protected buildExtraBody(
    effectiveStreamOpts: AgentStreamOptions,
    model?: string,
  ): Record<string, unknown> {
    // chat 车道采样放开（与其它 provider 共用基类 helper，换模型后采样治理不自失效）
    return {
      ...this.chatLaneSamplingExtraBody(effectiveStreamOpts),
      ...zhipuThinkingExtras(model ?? this.model, effectiveStreamOpts.disableThinking === true),
    };
  }

  /** 思考档位需 spread 到非工具分支 request 顶层（纯文本/识情/路由同样要吃到）。 */
  protected applyExtraBodyToPlainRequest(): boolean {
    return true;
  }
}
