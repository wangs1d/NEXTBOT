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
 * 用户自有 OpenAI 兼容端点（云端连接版 BYOK，2026-10-20）。
 *
 * 与 {@link OpenAiOfficialProvider | OpenAiOfficialProvider} 的差异：构造参数化
 * （baseUrl/apiKey/model 由调用方注入），不读 process.env——云端部署时运营方
 * 环境变量是平台自己的 key，用户对话轮必须走用户在客户端填写的自有 key。
 *
 * 生命周期：由 ActorModelBindingStore 按 actor 缓存单例（thread 历史挂 provider
 * 实例语义），客户端 session.init 重传三元组时按内容判等续期、配置变更才重建。
 * 旁路 LLM（记忆/摘要/评分等）不走本类，继续用运营方 env 解析的 provider。
 */
export class UserByokProvider extends AbstractChatProvider {
  readonly id = "user-byok";
  readonly displayLabel = "用户自有模型";
  readonly capabilities = {
    toolCallingProtocol: "openai" as const,
    supportsParallelToolCalls: true,
    supportsVision: true,
    supportsThinking: false,
    supportsStreaming: true,
  };

  protected readonly systemPrompt = SYSTEM_PROMPT;
  protected readonly notEnabledErrorMessage = "用户自有模型未配置";
  protected readonly client: OpenAI | null;
  protected readonly model: string;

  constructor(params: { baseUrl: string; apiKey: string; model: string }) {
    super();
    this.model = params.model;
    this.client = new OpenAI({
      apiKey: params.apiKey,
      baseURL: params.baseUrl,
      timeout: 180_000,
      maxRetries: 2,
    });
  }

  /**
   * 构造 extraBody：与 OpenAiOfficialProvider 同语义（deepseek-flash 默认关思考、
   * 轻量档 fastProfile、chat 车道采样放开）。用户自有端点不识别的字段多数会被
   * 忽略；不识别 extra body 而报错的严格端点极少，暂不做按端点的白名单。
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
    if (
      effectiveStreamOpts.toolExposureProfile === "contextual" ||
      effectiveStreamOpts.toolExposureProfile === "light"
    ) {
      out.fastProfile = true;
    }
    const merged = { ...this.chatLaneSamplingExtraBody(effectiveStreamOpts), ...out };
    return Object.keys(merged).length > 0 ? merged : undefined;
  }

  /** 非工具分支请求同样 spread extraBody（与 OpenAiOfficialProvider 对齐）。 */
  protected applyExtraBodyToPlainRequest(): boolean {
    return true;
  }

  /**
   * 构建 system 内容与 prompt cache plan：与 OpenAiOfficialProvider 同一条
   * assembleSystemPrompt 组装链（overrideSys 与默认 SYSTEM_PROMPT 共用，
   * 记忆块由 assembler 附加），保证 BYOK 轮的人格/记忆注入与平台轮一致。
   */
  protected buildSystemAndPlan(ctx: SystemAndPlanContext): SystemAndPlanResult {
    const finalizeOptions = {
      tools: Boolean(ctx.tools && !ctx.overrideSys),
      agentAccessMode: ctx.streamOpts?.agentAccessMode,
      desktopBridgeOnline: ctx.streamOpts?.desktopBridgeOnline,
      phoneBridgeOnline: ctx.streamOpts?.phoneBridgeOnline,
      ...(ctx.suppressSuffixes
        ? {
            suppressRuntimeSuffixes: true,
            functionalSuffixes: ctx.streamOpts?.functionalSuffixes !== false,
          }
        : {}),
    };

    const promptPlan = preparePromptCachePlan({
      providerId: this.id,
      model: ctx.model,
      baseSystemPrompt: ctx.overrideSys || SYSTEM_PROMPT,
      memory: ctx.promptMemory,
      finalizeOptions,
      tools: ctx.toolSearchPrepared?.visibleTools,
      variant: ctx.tools ? "chat-tools" : "chat",
      includeRenderProtocol:
        ctx.streamOpts?.ephemeralTurn !== true && ctx.streamOpts?.chatLanePureChat !== true,
      sessionId: ctx.sessionId,
    });

    return { sysContent: promptPlan.fullSystemPrompt, promptPlan };
  }
}
