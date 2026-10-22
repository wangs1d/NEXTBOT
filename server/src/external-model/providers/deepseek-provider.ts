import OpenAI from "openai";

import { preparePromptCachePlan } from "../prefix-cache.js";
import { deepseekThinkingExtras } from "../provider-profiles.js";
import {
  AbstractChatProvider,
  type SystemAndPlanContext,
  type SystemAndPlanResult,
} from "../abstract-chat-provider.js";
import { modelSupportsVision } from "../vision-support.js";
import type { AgentStreamOptions } from "../types.js";

const SYSTEM_PROMPT =
  "You are DeepSeek, an AI assistant created by DeepSeek (深度求索). You are proficient in Chinese and English conversations. You provide users with safe, helpful, and accurate answers. DeepSeek is a proper noun and should not be translated.";

/**
 * DeepSeek 官方 OpenAI 兼容端点（2026-10-22 原生接入，此前只能借 `openai` 槽
 * 塞 OPENAI_BASE_URL=https://api.deepseek.com 间接使用，槽位语义与真实能力错位）。
 *
 * 为什么要独立 provider id：`openai` 槽位的缓存策略是 explicit-key（每次下发
 * `prompt_cache_key`）、档案假设无思考链，而 DeepSeek 的缓存是**服务端隐式前缀
 * 缓存**（64 token 块自动命中，回传 `prompt_cache_hit_tokens`），且 flash 档
 * 默认 `effort=high` 带思考。挂错槽位=缓存 key 白发、路由预算按快模型收紧。
 *
 * 模型事实（2026-10-22 实测 `GET /v1/models` + 小请求探针）：
 * - `deepseek-flash`（V4.1-Flash）：context 1,048,576 / max_output 393,216，
 *   input_modalities 含 image，effort 支持 low|high|max（默认 high）；
 * - `deepseek-v4-pro`：仅文本输入，同样 1M 上下文；
 * - `thinking: {"type":"disabled"}` 被接受且 `reasoning_tokens=0`（对比
 *   `reasoning_effort: "minimal"` 仍烧 35 个思考 token——**关思考只能用 thinking 字段**）。
 * 因此默认关思考的语义与 Kimi/MiniMax 一致：`disableThinking !== false` 即关，
 * PRO 档显式 `disableThinking: false` 放开（见 agent-core 任务档位）。
 *
 * 环境变量：`DEEPSEEK_API_KEY`（必填以启用）、`DEEPSEEK_MODEL`（默认 deepseek-flash）、
 * `DEEPSEEK_BASE_URL`（默认 https://api.deepseek.com/v1）、`DEEPSEEK_REASONING_EFFORT`
 * （思考开启时的努力档，low|high|max）。
 */
export class DeepSeekProvider extends AbstractChatProvider {
  readonly id = "deepseek";
  readonly displayLabel = "DeepSeek";

  /** 视觉能力随模型走：flash 支持图像输入，v4-pro 纯文本（注入 image_url 会 400）。 */
  get capabilities() {
    return {
      toolCallingProtocol: "openai" as const,
      supportsParallelToolCalls: true,
      supportsVision: modelSupportsVision(this.model),
      supportsThinking: true,
      supportsStreaming: true,
      maxContextTokens: 1_048_576,
    };
  }

  protected readonly systemPrompt = SYSTEM_PROMPT;
  protected readonly notEnabledErrorMessage = "DEEPSEEK_API_KEY is not set";
  protected readonly client: OpenAI | null;
  protected readonly model: string;

  constructor() {
    super();
    const apiKey = process.env.DEEPSEEK_API_KEY?.trim();
    const baseURL = (process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com/v1").trim();
    this.model = (process.env.DEEPSEEK_MODEL ?? "deepseek-flash").trim();
    this.client = apiKey
      ? new OpenAI({ apiKey, baseURL, timeout: 180_000, maxRetries: 2 })
      : null;
  }

  /** 与 Kimi/MiniMax 同契约：默认关思考，显式 `disableThinking: false`（PRO 档）才放开。 */
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
      ...deepseekThinkingExtras(model ?? this.model, effectiveStreamOpts.disableThinking === true),
    };
  }

  /** 思考开关需 spread 到非工具分支 request 顶层（纯文本/识情/路由同样要吃到）。 */
  protected applyExtraBodyToPlainRequest(): boolean {
    return true;
  }
}
