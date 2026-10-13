import OpenAI from "openai";

import { preparePromptCachePlan } from "../prefix-cache.js";
import {
  AbstractChatProvider,
  type SystemAndPlanContext,
  type SystemAndPlanResult,
} from "../abstract-chat-provider.js";
import type { AgentStreamOptions } from "../types.js";

const SYSTEM_PROMPT =
  "You are Kimi, an AI assistant provided by Moonshot AI. You are proficient in Chinese and English conversations. You provide users with safe, helpful, and accurate answers. You will reject any requests involving terrorism, racism, or explicit content. Moonshot AI is a proper noun and should not be translated.";

function kimiThinkingDisabled(streamOpts?: AgentStreamOptions): boolean {
  return streamOpts?.disableThinking !== false;
}

function kimiExtraBody(streamOpts?: AgentStreamOptions): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  if (kimiThinkingDisabled(streamOpts)) {
    out.thinking = { type: "disabled" };
  }
  // 2026-08-01 性能优化：对话面轻量档（contextual/light）跳过强制 tool_choice，
  // 让 LLM 基于 system prompt 中已注入的 currentTime/userLocation 直接答。
  if (streamOpts?.toolExposureProfile === "contextual" || streamOpts?.toolExposureProfile === "light") {
    out.fastProfile = true;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Moonshot OpenAI 兼容 API（Kimi 模型）。
 * 环境变量：`MOONSHOT_API_KEY`（必填以启用）、`MOONSHOT_MODEL`、`MOONSHOT_BASE_URL`。
 * @see https://platform.moonshot.ai/docs/guide/start-using-kimi-api
 *
 * 继承 {@link AbstractChatProvider}：防串台（foldCompletedToolChains 根源折叠）、时间戳注入、
 * thread 维护等公共逻辑由基类模板方法固化，本类只实现 Kimi 特有的 system prompt 构建、
 * thinking 开关与 fastProfile（对话面轻量档标志）。
 */
export class MoonshotKimiProvider extends AbstractChatProvider {
  readonly id = "moonshot-kimi";
  readonly displayLabel = "Kimi (Moonshot)";
  readonly capabilities = {
    toolCallingProtocol: "openai" as const,
    supportsParallelToolCalls: true,
    supportsVision: true,
    supportsThinking: true,
    supportsStreaming: true,
  };

  protected readonly systemPrompt = SYSTEM_PROMPT;
  protected readonly notEnabledErrorMessage = "MOONSHOT_API_KEY is not set";
  protected readonly client: OpenAI | null;
  protected readonly model: string;

  constructor() {
    super();
    const apiKey = process.env.MOONSHOT_API_KEY?.trim();
    const baseURL = (process.env.MOONSHOT_BASE_URL ?? "https://api.moonshot.ai/v1").trim();
    this.model = (process.env.MOONSHOT_MODEL ?? "kimi-k2.5").trim();
    this.client = apiKey
      ? new OpenAI({ apiKey, baseURL, timeout: 180_000, maxRetries: 2 })
      : null;
  }

  protected buildSystemAndPlan(ctx: SystemAndPlanContext): SystemAndPlanResult {
    const promptPlan = preparePromptCachePlan({
      providerId: this.id,
      model: ctx.model,
      baseSystemPrompt: ctx.overrideSys || SYSTEM_PROMPT,
      // 2026-10-11 修复：与 minimax-provider 同款问题——minimal（overrideSys）路径
      // 把 memory 丢掉，【当前时间】块/证据/档案从未进请求。与 openai-official 对齐，
      // memory 恒透传（assembler 只对有内容的块追加，空 memory 行为不变）。
      memory: ctx.promptMemory,
      finalizeOptions: {
        tools: Boolean(ctx.tools && !ctx.overrideSys),
        agentAccessMode: ctx.streamOpts?.agentAccessMode,
        desktopBridgeOnline: ctx.streamOpts?.desktopBridgeOnline,
        phoneBridgeOnline: ctx.streamOpts?.phoneBridgeOnline,
        ...(ctx.suppressSuffixes ? {
          suppressRuntimeSuffixes: true,
          functionalSuffixes: ctx.streamOpts?.functionalSuffixes !== false,
        } : {}),
      },
      tools: ctx.toolSearchPrepared?.visibleTools,
      variant: ctx.tools ? "chat-tools" : "chat",
      // 展示形式协议只属于聊天面（与 openai-official 同规则）：ephemeral
      // 工具调用不注入，防止 [RENDER_HINT:xxx] 透进无剥除层的下游。
      includeRenderProtocol:
        ctx.streamOpts?.ephemeralTurn !== true && ctx.streamOpts?.chatLanePureChat !== true,
      sessionId: ctx.sessionId,
    });
    return { sysContent: promptPlan.fullSystemPrompt, promptPlan };
  }

  protected resolveEffectiveStreamOpts(streamOpts: AgentStreamOptions | undefined): AgentStreamOptions {
    return { ...(streamOpts ?? {}), disableThinking: kimiThinkingDisabled(streamOpts) };
  }

  protected buildExtraBody(effectiveStreamOpts: AgentStreamOptions): Record<string, unknown> | undefined {
    // chat 车道采样放开（基类共享；2026-10-07 前未接，换 Kimi 时语感治理采样同样静默失效）
    const merged = { ...kimiExtraBody(effectiveStreamOpts), ...this.chatLaneSamplingExtraBody(effectiveStreamOpts) };
    return Object.keys(merged).length > 0 ? merged : undefined;
  }

  protected applyExtraBodyToPlainRequest(): boolean {
    // Kimi 需要把 thinking/fastProfile spread 到非工具分支 request 顶层
    // （OpenAI Node SDK v6 不识别 Python 风格的 extra_body，直接 spread 到顶层 Moonshot 才能收到）
    return true;
  }
}
