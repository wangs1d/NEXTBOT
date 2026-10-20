import OpenAI from "openai";

import { preparePromptCachePlan } from "../prefix-cache.js";
import { minimaxThinkingExtras } from "../provider-profiles.js";
import {
  AbstractChatProvider,
  type SystemAndPlanContext,
  type SystemAndPlanResult,
} from "../abstract-chat-provider.js";
import type { AgentStreamOptions } from "../types.js";

const SYSTEM_PROMPT =
  "You are MiniMax AI, an AI assistant powered by the MiniMax large language model. You are proficient in Chinese and English conversations. You provide users with safe, helpful, and accurate answers. You will reject any requests involving terrorism, racism, or explicit content. MiniMax is a proper noun and should not be translated.";

/**
 * 思考参数按模型分档（判定收敛在 {@link minimaxThinkingExtras}，与裸 SDK 旁路同源）：
 * M2.x 系思考无法关闭，默认把 `<think>` 内联在 `content` 里逐字透出；请求体带
 * `reasoning_split: true` 后思考分流到 `reasoning_content`（`reasoning_details`
 * 伴随出现），与流式基建的 reasoning 字段嗅探对齐：思考不进 onDelta，仅 content
 * 为空时兜底。
 *
 * 思考开关：与 Kimi 同契约（`disableThinking !== false` 默认关）。M3 真支持
 * `thinking: {"type": "disabled"}`（实测 reasoning_tokens=0、正文直出）；M2.x
 * 会 accept 该参数但照常思考（仅靠 reasoning_split 保证正文干净）；M3.1 系
 * （MiniMax-M3.1-Flash）硬拒 disabled（400/2013），由 helper 改发
 * `reasoning: {effort:"minimal"}`（实测 reasoning_tokens=0）。
 * 默认关思考的动机：意图路由等旁路走 provider 时 maxOutputTokens 仅 192，
 * M 系思考计入 max_tokens 预算，不关会把正文饿死（实测思考连"1+1"都上千 token）。
 * @see https://platform.minimax.io/docs/api-reference/text-openai-api
 */
function minimaxExtraBody(
  effectiveStreamOpts: AgentStreamOptions,
  model: string,
): Record<string, unknown> {
  return minimaxThinkingExtras(model, effectiveStreamOpts.disableThinking === true);
}

/**
 * MiniMax OpenAI 兼容 API（M 系文本模型）。
 * 环境变量：`MINIMAX_API_KEY`（必填以启用）、`MINIMAX_MODEL`、`MINIMAX_BASE_URL`。
 * 国内平台密钥仅对 `https://api.minimaxi.com/v1` 有效；海外平台
 * （`https://api.minimax.io/v1`）需在 `MINIMAX_BASE_URL` 显式覆盖。
 *
 * 模型差异（2026-09-05 实测）：
 * - M2.x（M2 / M2.1 / M2.5 / M2.7）：思考无法关闭（thinking 开关被 accept 但仍思考）；
 * - M3：多模态模型但 OpenAI 兼容端点暂不接受 image_url（500 system error 1033），
 *   思考默认 adaptive、同样无法经 reasoning_split 之外的手段关闭。
 * 综上统一按纯文本 provider 处理（照片降级为文本说明，视觉理解依赖视觉模型），思考一律经
 * `reasoning_split` 分流到 `reasoning_content`，与流式基建的字段嗅探对齐。
 *
 * 继承 {@link AbstractChatProvider}：防串台（foldCompletedToolChains 根源折叠）、时间戳注入、
 * thread 维护等公共逻辑由基类模板方法固化，本类只实现 MiniMax 特有的 system prompt 构建与
 * reasoning_split 开关。
 */
export class MiniMaxProvider extends AbstractChatProvider {
  readonly id = "minimax";
  readonly displayLabel = "MiniMax";
  get capabilities() {
    return {
      toolCallingProtocol: "openai" as const,
      supportsParallelToolCalls: true,
      supportsVision: false,
      supportsThinking: true,
      supportsStreaming: true,
      maxContextTokens: this.model.startsWith("MiniMax-M3") ? 1_000_000 : 204_800,
    };
  }

  protected readonly systemPrompt = SYSTEM_PROMPT;
  protected readonly notEnabledErrorMessage = "MINIMAX_API_KEY is not set";
  protected readonly client: OpenAI | null;
  protected readonly model: string;

  constructor() {
    super();
    const apiKey = process.env.MINIMAX_API_KEY?.trim();
    const baseURL = (process.env.MINIMAX_BASE_URL ?? "https://api.minimaxi.com/v1").trim();
    this.model = (process.env.MINIMAX_MODEL ?? "MiniMax-M3").trim();
    this.client = apiKey
      ? new OpenAI({ apiKey, baseURL, timeout: 180_000, maxRetries: 2 })
      : null;
  }

  /** 与 Kimi 同契约：默认关思考（M3 真生效；M2.x 忽略该参数但 reasoning_split 仍保证正文干净）。 */
  protected resolveEffectiveStreamOpts(streamOpts: AgentStreamOptions | undefined): AgentStreamOptions {
    return { ...(streamOpts ?? {}), disableThinking: streamOpts?.disableThinking !== false };
  }

  protected buildSystemAndPlan(ctx: SystemAndPlanContext): SystemAndPlanResult {
    const promptPlan = preparePromptCachePlan({
      providerId: this.id,
      model: ctx.model,
      baseSystemPrompt: ctx.overrideSys || SYSTEM_PROMPT,
      // 2026-10-11 修复（「现在几点」实盘探针定位）：minimal 模式走 overrideSys，
      // 此前这里把 memory 整个丢掉 → 【当前时间】块/前置检索证据/用户档案从未进
      // 请求，模型只看到 kernel 里"当前时间永远在上下文"一句话，只能编时间
      // （真机：答「2026-05-12 周二 22:41」，真实日期 2026-10-11）。minimal 的
      // 本意是省 system 后缀，不是丢动态事实层——与 openai-official 对齐，
      // memory 恒透传（assembler 只对有内容的块追加，空 memory 行为不变）。
      memory: ctx.promptMemory,
      finalizeOptions: {
        tools: Boolean(ctx.tools && !ctx.overrideSys),
        masterSubAgentDelegate: ctx.streamOpts?.masterSubAgentDelegate,
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

  protected buildExtraBody(
    effectiveStreamOpts: AgentStreamOptions,
    model?: string,
  ): Record<string, unknown> {
    // chat 车道采样放开（基类共享；2026-10-07 前 MiniMax 路径未接，语感治理采样静默失效）
    return {
      ...this.chatLaneSamplingExtraBody(effectiveStreamOpts),
      ...minimaxExtraBody(effectiveStreamOpts, model ?? this.model),
    };
  }

  protected applyExtraBodyToPlainRequest(): boolean {
    // reasoning_split 需 spread 到非工具分支 request 顶层
    // （OpenAI Node SDK v6 不识别 Python 风格的 extra_body，直接 spread 到顶层 MiniMax 才能收到）
    return true;
  }
}
