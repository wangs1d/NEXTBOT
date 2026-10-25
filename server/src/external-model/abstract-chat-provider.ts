import OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";

import {
  buildTimestampFreeLlmView,
  getChatThreadStore,
  tagUserMessageClientId,
} from "./chat-thread-store.js";
import { tagMessageTimestampMeta } from "./chat-thread-ts-meta.js";
import { isTurnScaffold } from "./turn-scaffold.js";
import { domainCardsForTurn } from "./turn-domain-cards.js";
import type { ChatThreadStore } from "./chat-thread-store.js";
import { openAiUserContentFromTurn } from "./build-user-message-content.js";
import { isUnknownModelError } from "./chat-thread-sanitize.js";
import { modelSupportsVision } from "./vision-support.js";
import {
  adaptOpenAiChatCompletionStream,
  consumeNormalizedStream,
  createStreamControlTagSanitizer,
  createStreamMetaSentenceFilter,
  pickVisibleText,
  StreamIdleTimeoutError,
  ToolIntentWithoutToolsError,
  stripInternalControlTags,
  stripMetaSentences,
  type NormalToolCall,
  type NormalUsage,
} from "./stream-chat-helpers.js";
import {
  applyPromptCacheMessages,
  preparePromptCachePlan,
} from "./prefix-cache.js";
import { fingerprintRequestHead, reportPrefixWatchOutcome } from "./prefix-watchdog.js";
import { resolveChatToolPlanForStream } from "./resolve-chat-tools.js";
// 从 agent-gateway 具体模块导入而非 gateway/index 大桶——基类模块经桶文件
// 会回连 resolve-provider → providers/*，形成 module-init 循环
// （2026-09-25 冷启动 "Cannot access AbstractChatProvider before initialization"）。
import { prepareTools } from "../gateway/agent-gateway.js";
import { streamCompletionWithTools } from "./openai-compatible-tool-loop.js";
import { normalizeTraditionalToSimplified } from "../utils/simplified-chinese.js";
import { recordLlmUsageByChars } from "../services/llm-token-audit.js";
import type {
  AgentPromptMemoryContext,
  AgentStreamOptions,
  ChatToolExecutionContext,
  ChatUserTurn,
  ExternalChatProvider,
  ProviderCapabilities,
  StreamDeltaHandler,
} from "./types.js";

/** preparePromptCachePlan 的返回类型（含 fullSystemPrompt / promptCache / requestSystemMessages）。 */
type PromptCachePlan = ReturnType<typeof preparePromptCachePlan>;
type ToolPlan = ReturnType<typeof resolveChatToolPlanForStream>;
type ToolSearchPrepared = Awaited<ReturnType<typeof prepareTools>>;

/**
 * buildSystemAndPlan 钩子的上下文：基类在调用前已解析好 model / tools / suppressSuffixes 等。
 * 子类据此决定如何构建 sysContent 与 promptPlan（例如是否走缓存、是否分层 prompt）。
 */
export interface SystemAndPlanContext {
  overrideSys: string | undefined;
  promptMemory: AgentPromptMemoryContext | undefined;
  suppressSuffixes: boolean;
  tools: ChatToolExecutionContext | undefined;
  toolSearchPrepared: ToolSearchPrepared | null;
  model: string;
  streamOpts: AgentStreamOptions | undefined;
  /** 当前会话 id（P0-1② 稳定层会话冻结用；无会话上下文时可缺省） */
  sessionId?: string;
}

export interface SystemAndPlanResult {
  sysContent: string;
  promptPlan: PromptCachePlan;
}

/**
 * 所有具体 chat provider 的抽象基类（模板方法模式）。
 *
 * 设计动机：防串台逻辑（foldCompletedToolChains，在 afterTurnCompleted 中根源折叠）、
 * 时间戳 metadata（tagMessageTimestampMeta，P1 通道分离）、clientMessageId 标记（tagUserMessageClientId）、
 * thread 维护（trimThread/afterTurnCompleted）原本散落在各 provider 的 streamCompletion 里
 * 靠复制粘贴维持，任一新 provider 漏调即导致"话题切换串台"问题。本基类把这些逻辑固化为
 * 模板方法中不可跳过的步骤，子类只覆写 provider 特定钩子，从结构上杜绝漏调。
 *
 * 子类职责：
 * - 声明 id / displayLabel / capabilities / systemPrompt / model / client / notEnabledErrorMessage
 * - 实现 buildSystemAndPlan（构建 sysContent + promptPlan）
 * - 按需覆写 resolveModel / buildExtraBody / resolveEffectiveStreamOpts / applyExtraBodyToPlainRequest
 *
 * 基类固化职责（不可被子类跳过）：
 * - thread 装载 / system 写入三分支 / 编辑重发截断
 * - userMsg 时间戳注入 + clientMessageId 标记
 * - afterTurnCompleted 中调用 foldCompletedToolChains（根源防串台：折叠已完成 tool_call 链）
 * - 流式消费 + 超时兜底 + 失败回滚
 * - afterTurnCompleted 持久化
 */
export abstract class AbstractChatProvider implements ExternalChatProvider {
  abstract readonly id: string;
  abstract readonly displayLabel: string;
  abstract readonly capabilities: ProviderCapabilities;

  /** 子类提供的系统提示词常量（用于 thread 初始化与 appendThreadTurn）。 */
  protected abstract readonly systemPrompt: string;
  /** 子类解析的默认模型名（用于 resolveModel 默认实现）。 */
  protected abstract readonly model: string;
  /** 子类持有的 OpenAI 兼容 client（构造函数初始化；null 表示未配置密钥）。 */
  protected abstract readonly client: OpenAI | null;
  /** client 为 null 时抛出的错误信息。 */
  protected abstract readonly notEnabledErrorMessage: string;

  /** 共享的 thread store 单例（所有 provider 共用同一份会话历史）。 */
  protected readonly threads: ChatThreadStore = getChatThreadStore();

  isEnabled(): boolean {
    return this.client !== null;
  }

  clearSession(sessionId: string): void {
    this.threads.clearSession(sessionId);
  }

  /**
   * 按 clientMessageId 移除该 user 消息及其后的全部线程内容（fast→complex 升级
   * 重放前清理 fast 轮写入的残迹，防 user 消息/部分回复在重放后重复落盘）。
   * 无 clientMessageId 时 no-op（无法定位，保持原线程）。
   */
  removeUserTurnAndAfter(sessionId: string, clientMessageId?: string): void {
    if (!clientMessageId) return;
    this.threads.removeUserMessageAndAfter(sessionId, clientMessageId);
  }

  appendThreadTurn(
    sessionId: string,
    userTurn: ChatUserTurn,
    assistantText: string,
    maxThreadMessages?: number,
    model?: string,
  ): void {
    this.threads.appendTurn(
      sessionId,
      this.systemPrompt,
      userTurn,
      assistantText,
      maxThreadMessages,
      undefined,
      undefined,
      model ?? this.model,
    );
  }

  /**
   * 后台任务的单条事实记录（2026-09-08 建立，2026-10-13 根修迁 system 角色）：
   * 带「[后台任务记录]」前缀，取代旧的「伪造 user 轮 [后台任务] <原文> + assistant
   * 回复对」。user 轮会让后续对话把任务原文当作用户说过的话接茬（把「刘浩存才是
   * 真主 未来的老婆」接成说媒拒绝的事故根因之一）；assistant 角色则会让模型把它
   * 当自己的输出复读给用户（2026-10-13 手机端气泡事故同根源），故迁 system。
   */
  appendTaskRecord(sessionId: string, goal: string, resultText: string): void {
    this.threads.appendTaskRecord(sessionId, this.systemPrompt, goal, resultText);
  }

  protected thread(sessionId: string): ChatCompletionMessageParam[] {
    return this.threads.thread(sessionId, this.systemPrompt);
  }

  protected trimThread(msgs: ChatCompletionMessageParam[], maxMessages?: number, sessionId?: string): void {
    this.threads.trimThread(msgs, maxMessages, sessionId);
  }

  // ── 子类可覆写的钩子（均有默认实现） ──────────────────────────────

  /** 解析本轮使用的模型。默认：streamOpts.modelOverride ?? this.model。子类可覆写为智能路由。 */
  protected resolveModel(
    streamOpts: AgentStreamOptions | undefined,
    _userText: string,
    _msgCount: number,
  ): string {
    return streamOpts?.modelOverride?.trim() || this.model;
  }

  /**
   * 构造 extraBody（如 thinking 开关 / fastProfile）。
   * 默认返回 undefined（不附加任何字段）。子类按 provider 特性覆写。
   * 该返回值同时用于工具分支（传给 toolLoop）和非工具分支（按 applyExtraBodyToPlainRequest 决定是否 spread）。
   * model 为本轮已解析的模型名（modelOverride 已生效），供按模型差异化构造（如 deepseek-flash 默认关思考）。
   */
  protected buildExtraBody(
    _effectiveStreamOpts: AgentStreamOptions,
    _model?: string,
  ): Record<string, unknown> | undefined {
    return undefined;
  }

  /**
   * chat 车道采样放开（2026-10-06 语感治理 A，2026-10-07 提升为基类共享）：
   * 主模型训练分布偏中性助手腔，靠温度+频罚对冲（示例与人格块教「怎么说」，
   * 采样让它「敢说」）。门控 = agent-core chat 车道显式置位的 chatLaneSampling
   * 且非 ephemeral 内部调用；任务面/内部识情/路由/收尾汇总不置位，保持默认采样。
   * CHAT_TEMPERATURE / CHAT_FREQUENCY_PENALTY 可覆盖。各 provider 在自己的
   * buildExtraBody 里 merge 本 helper 返回值（此前仅 openai-official 内联实现，
   * MiniMax/Kimi 换模型后采样治理静默失效）。
   */
  protected chatLaneSamplingExtraBody(
    effectiveStreamOpts: AgentStreamOptions,
  ): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    const chatMainTurn =
      effectiveStreamOpts.chatLaneSampling === true && effectiveStreamOpts.ephemeralTurn !== true;
    if (!chatMainTurn) return out;
    const temperature = Number.parseFloat(process.env.CHAT_TEMPERATURE ?? "0.85");
    if (Number.isFinite(temperature) && temperature > 0) out.temperature = temperature;
    const frequencyPenalty = Number.parseFloat(process.env.CHAT_FREQUENCY_PENALTY ?? "0.4");
    if (Number.isFinite(frequencyPenalty) && frequencyPenalty > 0) {
      out.frequency_penalty = frequencyPenalty;
    }
    return out;
  }

  /** 派生 effectiveStreamOpts。默认原样返回；子类可覆写（如 Kimi 强制 disableThinking）。 */
  protected resolveEffectiveStreamOpts(streamOpts: AgentStreamOptions | undefined): AgentStreamOptions {
    return streamOpts ?? {};
  }

  /** 非工具分支的 request 是否 spread extraBody。默认 false（OpenAI 风格）；Kimi 覆写为 true。 */
  protected applyExtraBodyToPlainRequest(): boolean {
    return false;
  }

  /**
   * 构建 system 内容与 prompt cache plan（子类必须实现）。
   *
   * 子类在此完成：
   * - sysContent 的构建（可走缓存 / 分层 prompt / 直算）
   * - promptPlan 的构建（含 tools 信息，供工具分支与非工具分支共用）
   *
   * 基类保证在调用此钩子前已解析 model、已准备 toolSearchPrepared。
   */
  protected abstract buildSystemAndPlan(ctx: SystemAndPlanContext): SystemAndPlanResult;

  // ── 模板方法（固化防串台逻辑的唯一入口） ──────────────────────────

  async streamCompletion(
    sessionId: string,
    userTurn: ChatUserTurn,
    onDelta: StreamDeltaHandler,
    tools?: ChatToolExecutionContext,
    streamOpts?: AgentStreamOptions,
  ): Promise<string> {
    // 模型名自愈（2026-10-07 事故根治配套）：tier 分档的 modelOverride 模型名与
    // 当前端点不匹配（换主模型后遗留的硬编码，如 deepseek-flash → MiniMax 端点）
    // 时，请求在发出前就 400，整轮工具循环报废、跌 emergency 无工具兜底——
    // 用户看到的是"agent 不调工具"，实际是模型根本没收到工具清单。
    // 此处剥掉 override 回落 provider 主模型重试一次：坏配置自动降级为可用请求，
    // 同类事故不再有全轮报废形态。仅当首试尚未流式输出任何内容时重试
    // （400 unknown model 必然发生在请求创建期，此时零 delta，重试不会重复推送）；
    // 线程防重由 clientMessageId 的 removeUserMessageAndAfter 幂等承接。
    if (streamOpts?.modelOverride?.trim()) {
      // 流式已推送检测：一旦有任何 delta 出去就不再自愈重试（400 unknown model
      // 必然发生在请求创建期、零 delta 阶段，此守卫只为防御误匹配误重试）。
      let streamedAny = false;
      const guardedDelta: StreamDeltaHandler = (delta) => {
        if (delta) streamedAny = true;
        onDelta(delta);
      };
      try {
        return await this.streamCompletionTurn(sessionId, userTurn, guardedDelta, tools, streamOpts);
      } catch (e) {
        // 线程防重：非 ephemeral 且无 clientMessageId 时，重试会在线程里重复 push
        // user 消息（removeUserMessageAndAfter 无幂等键）——此类调用方不重试。
        const threadSafeRetry =
          streamOpts?.ephemeralTurn === true || !!userTurn.clientMessageId;
        if (isUnknownModelError(e) && !streamedAny && threadSafeRetry) {
          console.warn(
            `[abstract-chat-provider] modelOverride "${streamOpts.modelOverride}" 被端点拒绝（unknown model），` +
              `剥 override 回落主模型重试一次`,
          );
          return this.streamCompletionTurn(sessionId, userTurn, onDelta, tools, {
            ...streamOpts,
            modelOverride: undefined,
          });
        }
        throw e;
      }
    }
    return this.streamCompletionTurn(sessionId, userTurn, onDelta, tools, streamOpts);
  }

  private async streamCompletionTurn(
    sessionId: string,
    userTurn: ChatUserTurn,
    onDelta: StreamDeltaHandler,
    tools?: ChatToolExecutionContext,
    streamOpts?: AgentStreamOptions,
  ): Promise<string> {
    const client = this.client;
    if (!client) {
      throw new Error(this.notEnabledErrorMessage);
    }

    const ephemeral = streamOpts?.ephemeralTurn === true;
    const msgs: ChatCompletionMessageParam[] = ephemeral ? [] : this.thread(sessionId);
    // Token 用量审计：非工具分支记录实际发往 LLM 的输入规模（估算）
    let requestAuditInput = 0;

    const overrideSys = streamOpts?.systemPromptOverride?.trim();
    const promptMemory = streamOpts?.promptContext?.memory;
    const suppressSuffixes = streamOpts?.suppressRuntimeSuffixes === true;

    // 模型解析（子类可覆写为智能路由；此时 msgs 尚未 push userMsg，msgCount 为 thread 原始长度）
    const model = this.resolveModel(streamOpts, userTurn.text, msgs.length);

    // 工具准备（若启用工具）
    const toolPlan: ToolPlan | null = tools
      ? resolveChatToolPlanForStream(userTurn.text, streamOpts)
      : null;
    // disableToolSearch（轻量白名单链路）：visible 全量即 searchable，不构建延迟目录。
    // 小 maxRounds 下 tool_discover→tool_call 两波召回必断头，目录只会造成
    // "发现工具说明就被截断"的断头回复。
    const searchableForTurn =
      streamOpts?.disableToolSearch === true
        ? toolPlan?.visibleTools
        : toolPlan?.searchableTools;
    const toolSearchPrepared: ToolSearchPrepared | null = toolPlan
      ? await prepareTools(toolPlan.visibleTools, searchableForTurn)
      : null;

    // 子类构建 sysContent + promptPlan（含 tools 信息，两个分支共用，避免 Kimi 式重复构建）
    const { sysContent, promptPlan } = this.buildSystemAndPlan({
      overrideSys,
      promptMemory,
      suppressSuffixes,
      tools,
      toolSearchPrepared,
      model,
      streamOpts,
      sessionId,
    });

    // 能力域目录并入 **system 段**（2026-10-22）：它原本挂在请求尾部的轮内 system
    // 消息里，位置每轮后移 → 隐式前缀缓存永远命中不了（实测每轮全价 3,200 token）。
    // 工具面已按会话冻结，域卡语料（可见 ∪ 延迟）在会话内字节稳定，放进 system
    // 就能随 system 一起命中。只改「发往 LLM 的 system」，不改写进线程的 msgs[0]
    //（后者要落盘，不必背这份目录）。
    const domainCards = domainCardsForTurn(toolSearchPrepared);
    if (domainCards) {
      const withCards = (base: string): string => (base ? `${base}\n\n${domainCards}` : domainCards);
      promptPlan.requestSystemMessages = promptPlan.requestSystemMessages.map((m, i) =>
        i === 0 && m.role === "system" && typeof m.content === "string"
          ? { ...m, content: withCards(m.content) }
          : m,
      );
      promptPlan.fullSystemPrompt = withCards(promptPlan.fullSystemPrompt);
    }

    // system 写入 msgs：三分支逻辑（ephemeral/空 → push；minimal+override → 内容不同才覆盖；else → 覆盖）
    if (ephemeral || msgs.length === 0) {
      msgs.push({ role: "system", content: sysContent });
    } else if (suppressSuffixes && overrideSys) {
      const first = msgs[0];
      const currentContent =
        first && first.role === "system" && typeof first.content === "string"
          ? first.content
          : "";
      if (currentContent !== sysContent) {
        msgs[0] = { role: "system", content: sysContent };
      }
    } else {
      msgs[0] = { role: "system", content: sysContent };
    }

    // 支持「编辑同 clientMessageId 的 user 消息并重发」：先把该消息及其后续内容删掉。
    if (!ephemeral && userTurn.clientMessageId) {
      this.threads.removeUserMessageAndAfter(sessionId, userTurn.clientMessageId);
    }
    const turnStartLen = msgs.length;

    // ★ 防串台关键步骤 1：user 消息时间戳注入 + clientMessageId 标记（固化，子类无法跳过）
    // 用户照片注入分流：纯文本模型（deepseek-chat 等）无法接收 image_url，注入会直接
    // 报 400 导致整轮失败。openAiUserContentFromTurn 按模型能力决定：
    // 视觉模型注入 image_url，非视觉模型降级为"存在照片"的文本说明（PaddleOCR 已移除）。
    const userMsg = {
      role: "user",
      content: openAiUserContentFromTurn(userTurn, { model }),
    } as ChatCompletionMessageParam;
    // P1（2026-10-11 通道分离）：时间戳不再写进正文（帧会被复读），改存消息 metadata；
    // LLM 的时间锚由 buildTimestampFreeLlmView 的时间轴块承担。
    tagMessageTimestampMeta(userMsg, new Date());
    tagUserMessageClientId(userMsg, userTurn.clientMessageId);
    msgs.push(userMsg);

    // ★ 防串台已根源解决：afterTurnCompleted 在上一轮完成时已调用 foldCompletedToolChains
    //    移除 raw tool 结果。这里只需 trimThread 控制上下文长度。
    if (!ephemeral) {
      this.trimThread(msgs, streamOpts?.maxThreadMessages, sessionId);
    }

    const effectiveStreamOpts = this.resolveEffectiveStreamOpts(streamOpts);
    const extraBody = this.buildExtraBody(effectiveStreamOpts, model);

    // ★ 时间戳根治视图（2026-09-03）：发往 LLM 的副本剥掉历史正文首行的 [ts:] 前缀——
    //   存储层（msgs）前缀原样保留（按天裁剪 / recap / 恢复 / 编辑都依赖解析它）——
    //   模型上下文里不再有「每条消息以 [ts: 开头」的 in-context 模仿源，从根源消除
    //   时间戳帧复述泄漏到用户气泡的问题。
    //   2026-10-23（用户拍板）**删除按需时间闸**：【对话时间轴】不再看本轮有没有时间词，
    //   有 ≥2 条带时间的消息就每轮注入（按自然日分组 + 今天/昨天/N天前）。
    //   旧闸的代价是"普通续聊轮历史零时间锚"，模型只能把昨天当今天。
    const llmView = buildTimestampFreeLlmView(msgs).messages;
    // 线程原有消息的对象身份集合：工具循环只应往线程回写「视图新增」的消息。
    const llmViewLiveObjects = new Set<ChatCompletionMessageParam>(msgs);
    /**
     * 回写边界 = 视图构建完成时的长度（**不是**「最后一个活对象的下标」）。
     *
     * 2026-10-22 根因修复：视图构建会剥离内部元数据（`__ts` / clientMessageId），
     * 本轮 user 消息必然被克隆成新对象——旧实现按「最后一个活对象的索引」定界，
     * 于是从本轮 user 起整段都被当成「视图新增」回写，**每轮往线程里多插一条
     * 一模一样的 user 消息**（实测 n=2→4→7→10，且它每轮位置/内容固定，
     * 让下一轮请求与上一轮在 user 消息处必然分叉，历史段缓存全废）。
     * 按长度定界后，视图内既有的消息无论被克隆/插入与否都不回写，只回写循环
     * 真正追加的（assistant tool_calls / tool 结果 / 收尾正文）。
     */
    const llmViewAppendBoundary = llmView.length;

    // ── 工具分支 ──
    if (tools && toolPlan && toolSearchPrepared) {
      let completed = false;
      // 已流式送达用户的内容累计（2026-09-08 中断记账）：异常/中断时用于
      // 「保留现场」——用户亲眼看到的回复必须落进 thread。此前整体回滚
      // （msgs.length = turnStartLen）会让 thread 与用户所见分叉：实测一轮
      // 成功流式的回复中断后，thread 里只剩「未生成完整回复」占位符，
      // recap 把已办成的事记成反复未完成，agent 据此反复重问。
      let streamedVisible = "";
      const trackingDelta: StreamDeltaHandler = (delta: string) => {
        if (!delta) {
          onDelta(delta);
          return;
        }
        streamedVisible += delta;
        onDelta(delta);
      };
      const hasToolCallPayload = (m: ChatCompletionMessageParam): boolean =>
        Array.isArray((m as { tool_calls?: unknown }).tool_calls) &&
        ((m as { tool_calls?: unknown[] }).tool_calls as unknown[]).length > 0;
      try {
        const full = await streamCompletionWithTools(
          client,
          model,
          llmView,
          trackingDelta,
          tools,
          {
            onAfterToolBatch: effectiveStreamOpts.toolLoop?.onAfterToolBatch,
            tools: toolPlan.visibleTools,
            // disableToolSearch（轻量白名单链路）必须同样作用于循环内的延迟目录：
            // 此前只有 prompt 侧的 prepareTools 吃到 searchableForTurn，这里仍传
            // 全量 searchableTools → 循环内部 prepareTools 重建目录并注入
            // tool_discover/tool_call 桥，"discover→call 两波召回必断头"的死路
            // 复活——提醒/搜索轮 discover 成功后 call 不到工具，只剩口头承诺。
            toolSearchSourceTools: searchableForTurn,
            maxRounds: effectiveStreamOpts.toolLoop?.maxRounds,
            // 会话工具面冻结（2026-10-22）：晋升常驻可能在会话中途跨过阈值，
            // 冻结后不会自动吸收——由 agent-core 显式声明可增长项，漏掉 = 晋升
            // 要等下个会话才生效。
            ...(effectiveStreamOpts.toolFaceGrowNames?.length
              ? { toolFaceGrowNames: effectiveStreamOpts.toolFaceGrowNames }
              : {}),
            // 路由意图标签：出口检查用它确定性拦截"声明要动手但零工具尝试"的轮次
            turnIntent: effectiveStreamOpts.turnIntent,
            // 证据注入豁免 + 路由置信度（2026-09-23 扩面配套，见工具循环出口检查处）
            turnEvidenceInjected: effectiveStreamOpts.turnEvidenceInjected,
            turnRouteConfidence: effectiveStreamOpts.turnRouteConfidence,
            // 确定性媒体预执行（2026-10-10）：白名单透传，漏掉 = 预执行静默失效
            deterministicToolCalls: effectiveStreamOpts.deterministicToolCalls,
            // 答案留存（2026-10-13 根修）：白名单透传，漏掉 = 工具轮照旧流式，
            // 「先流式输出正文 → done 弹卡」的通道级根修失效
            holdAnswer: effectiveStreamOpts.holdAnswer,
            extraBody,
            promptCache: promptPlan.promptCache,
            requestSystemMessages: promptPlan.requestSystemMessages,
            tailDynamicContext: promptPlan.tailDynamicContext,
            maxOutputTokens: effectiveStreamOpts.maxOutputTokens,
            // 工具分支同样透传 AbortSignal：用户发新消息中断旧轮时，
            // 工具循环内的 LLM 流式请求（规划轮 + 总结轮）一并中断，
            // 不再吃满 SDK 默认超时（与非工具分支对齐）。
            signal: effectiveStreamOpts.signal,
            audit: {
              sessionId,
              // 计划主键由 agent-core 下发（工具层写入用的同一个会话键）；缺省回落 sessionId
              planKey: effectiveStreamOpts.planSessionKey ?? sessionId,
              // B1 stage 打标：任务面透传 task_plane_*；缺省 = 前台工具循环 main_chat_tools
              // （该 stage 此前已声明但从未被写入，工具循环的用量一直混在 main_chat 里）。
              stage: (streamOpts?.auditStage as Parameters<typeof recordLlmUsageByChars>[0]["stage"] | undefined) ?? "main_chat_tools",
            },
          },
        );
        completed = true;
        if (!ephemeral) {
          // 回写工具循环新增的消息（assistant tool_calls / tool 结果 / 规划注入）到线程。
          // 循环操作的是视图副本；这里按边界 + 对象身份只回写新增，剥离克隆不入线程。
          // 轮内脚手架（域卡/时间轴/请求卡与出口闸的转向指令）同样排除：它们只对
          // 本轮请求有效，落库会变成每轮重发的大块死 token + 前缀漂移源
          // （2026-10-22 实测：8,266 字符域卡常驻历史，历史段缓存 0 命中）。
          if (llmViewAppendBoundary >= 0) {
            for (let i = llmViewAppendBoundary; i < llmView.length; i++) {
              const m = llmView[i];
              if (process.env.PREFIX_DEBUG === "1") {
                console.log(
                  `[writeback] i=${i} role=${m?.role} live=${m ? llmViewLiveObjects.has(m) : "-"} ` +
                    `scaffold=${isTurnScaffold(m)} keep=${Boolean(m && !llmViewLiveObjects.has(m) && !isTurnScaffold(m))}`,
                );
              }
              if (m && !llmViewLiveObjects.has(m) && !isTurnScaffold(m)) msgs.push(m);
            }
          }
          // 中断兜底（2026-09-08）：循环正常返回但回写内容里没有最终 assistant 正文
          // （如末轮流被中断、循环内部吞掉流异常后返回）时，用已送达的部分文本补一条
          // assistant 消息，保证「用户看到的」=「thread 记录的」，且 fold 后不留
          // 「未生成完整回复」空占位。
          const hasFinalAssistant = msgs
            .slice(turnStartLen)
            .some((m) => m.role === "assistant" && !hasToolCallPayload(m));
          // 兜底第二梯队（2026-10-22 根修·重复回复事故）：holdAnswer 轮正文不进
          // 流式通道（streamedVisible 恒空），但本轮最终答案就在返回值 full 里——
          // 用户亲眼看到的回复必须落 thread（2026-09-08 契约），否则线程停在
          // tool 链上被 fold 成「未生成可见回复」台账，下一轮模型重复调工具。
          // 正常路径（最终波 / schema-less 汇总落 messages）hasFinalAssistant
          // 已为 true，不会走到这里，无双重落库。
          if (!hasFinalAssistant) {
            const finalFallback = streamedVisible.trim() || full.trim();
            if (finalFallback) {
              msgs.push({ role: "assistant", content: finalFallback });
            }
          }
          this.trimThread(msgs, streamOpts?.maxThreadMessages, sessionId);
          this.threads.afterTurnCompleted(sessionId, msgs);
        }
        return full;
      } catch (e) {
        if (!completed && !ephemeral) {
          if (streamedVisible.trim()) {
            // 用户已看到部分回复：保留现场而非整体回滚（用户消息 + 工具记录 +
            // 部分回复一并留存），与客户端所见保持一致。fold 会把工具链折叠到
            // 这条部分回复上，占位符不再出现。
            msgs.push({ role: "assistant", content: streamedVisible.trim() });
          } else {
            msgs.length = turnStartLen;
          }
        }
        throw e;
      }
    }

    // ── 非工具分支 ──
    let stream;
    // 前缀看门狗指纹（在下方 try 内赋值，流结束后上报归因）
    let plainHeadFps: ReturnType<typeof fingerprintRequestHead> | null = null;
    try {
      const finalMessages = applyPromptCacheMessages(
        llmView,
        promptPlan.requestSystemMessages,
        promptPlan.tailDynamicContext,
      );
      const request = {
        model,
        messages: finalMessages,
        stream: true,
        ...(streamOpts?.maxOutputTokens ? { max_tokens: streamOpts.maxOutputTokens } : {}),
        // 结构化输出契约（2026-10-07）：OpenAI 兼容 response_format 透传，
        // JSON 合法性由厂商解码层保证（对齐主流网关的结构化输出语义）。
        ...(streamOpts?.responseFormat ? { response_format: { type: streamOpts.responseFormat } } : {}),
        ...(promptPlan.promptCache ?? {}),
        ...(this.applyExtraBodyToPlainRequest() ? (extraBody ?? {}) : {}),
      };
      // Token 用量审计：记录发往 LLM 的实际输入规模（估算）
      requestAuditInput = JSON.stringify(finalMessages).length + (toolPlan ? JSON.stringify(toolPlan.visibleTools).length : 0);
      // 前缀看门狗（2026-10-12）：非工具分支同样取分段指纹，usage 到达后归因。
      plainHeadFps = fingerprintRequestHead({ tools: [], messages: finalMessages });
      stream = await client.chat.completions.create(
        request as Parameters<typeof client.chat.completions.create>[0],
        effectiveStreamOpts.signal ? { signal: effectiveStreamOpts.signal } : undefined,
      ) as AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>;
    } catch (e) {
      msgs.length = turnStartLen;
      throw e;
    }

    let visible = "";
    // 已流式送达用户的内容累计（2026-09-08 中断记账，与工具分支同语义）
    let streamedVisible = "";
    // API 流末尾 chunk 返回的 prefix cache 计费数据（scope 提升供下方 token 审计采集）
    let streamUsage: NormalUsage | undefined;
    // 流末从 DSML 原文提取出的工具调用（带出 try 作用域供下方意图升级判定）
    let toolIntentCalls: NormalToolCall[] = [];
    try {
      const sanitizer = createStreamControlTagSanitizer();
      const metaFilter = createStreamMetaSentenceFilter();
      // LLM 计时（2026-09-28 延迟诊断配套）：request 发出 → 首个可见 delta → 流结束，
      // 区分「API 排队/首 token 慢」与「生成长」。首 delta 为空（净化后无输出）
      // 时以首个原始 chunk 近似（由首参数记录）。量小常开，一行一条。
      const timingStart = Date.now();
      let timingFirstRaw: number | null = null;
      let timingFirstDelta: number | null = null;
      const timedSource = (async function* () {
        for await (
          const chunk of stream as AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>
        ) {
          if (timingFirstRaw === null) timingFirstRaw = Date.now();
          yield chunk;
        }
      })();
      const result = await consumeNormalizedStream(
        adaptOpenAiChatCompletionStream(timedSource),
        {
          onContentDelta: (d) => {
            // 根源净化：model 偶发会把内部控制标签（如 [STOP...] / [话题切换...]）
            // 混进 content，逐 chunk 直推这里时先过净化器，避免标签透出到前端气泡。
            // 2026-08-29 扩展：再叠一层元术语整句过滤（"上一轮转入规划任务..."），
            // 兜底 LLM 在流式中把系统元描述整段写进回复。
            const clean = metaFilter(sanitizer(d));
            if (clean) {
              // 繁→简出口正规化（2026-10-11）：流式与累计（streamedVisible）用同一
              // 归一文本，1:1 等长替换不破坏流式分段。
              const t2s = normalizeTraditionalToSimplified(clean);
              const normalized = t2s.text;
              streamedVisible += normalized;
              if (timingFirstDelta === null) timingFirstDelta = Date.now();
              onDelta(normalized);
            }
          },
          providerId: this.id,
          model,
        },
      );
      // eslint-disable-next-line no-console
      console.info(
        `[llm-timing] plain provider=${this.id} model=${model} session=${sessionId} ` +
          `firstRaw=${timingFirstRaw === null ? "-" : timingFirstRaw - timingStart}ms ` +
          `firstDelta=${timingFirstDelta === null ? "-" : timingFirstDelta - timingStart}ms ` +
          `total=${Date.now() - timingStart}ms chars=${streamedVisible.length}`,
      );
      streamUsage = result.usage;
      toolIntentCalls = result.toolCalls;
      // 2026-10-11：整串路径补一道 stripMetaSentences（含「元决策自述句」判据，
      // 与流式 metaFilter 同一套词面），防止净化后文本仍把「根据规范必须调用…」
      // 这类自述带进最终回复。
      visible = normalizeTraditionalToSimplified(
        stripMetaSentences(
          stripInternalControlTags(pickVisibleText(result.content, result.reasoning)),
        ),
      ).text;
    } catch (e) {
      // 流式空闲超时：如果有 partial content，用它作为兜底回复而非直接失败。
      if (e instanceof StreamIdleTimeoutError && e.partialContent.trim()) {
        visible = e.partialContent.trim();
        // eslint-disable-next-line no-console
        console.warn(
          `[stream-idle-timeout] provider=${this.id} model=${model} ` +
            `→ 使用 ${visible.length} 字符的 partial content 兜底`,
        );
      } else if (streamedVisible.trim()) {
        // 中断记账（2026-09-08）：流异常但用户已看到部分回复 → 保留现场
        // （user 消息 + 部分回复），不整体回滚；e 继续上抛由上层按中断处理。
        if (!ephemeral) {
          msgs.push({ role: "assistant", content: streamedVisible.trim() });
          this.trimThread(msgs, streamOpts?.maxThreadMessages, sessionId);
          this.threads.afterTurnCompleted(sessionId, msgs);
        }
        throw e;
      } else {
        msgs.length = turnStartLen;
        throw e;
      }
    }

    // 2026-09-11 根修：无工具轮次的工具意图不再静默丢弃。
    // consumeNormalizedStream 已从正文提取出 DSML 工具调用（协议原文也已从流式
    // 通道剥离，见 createStreamDsmlSanitizer）。本分支没有工具执行器，无法兑现
    // 模型意图——显式上抛 ToolIntentWithoutToolsError，由 agent-core 捕获后升级
    // 到带工具的任务面重跑同一句用户消息。ephemeral 轮次（应急重生成等）保持
    // 原行为：返回剥离后的文本（可能为空，由上层空响应兜底处理）。
    if (!ephemeral && toolIntentCalls.length > 0) {
      msgs.length = turnStartLen;
      throw new ToolIntentWithoutToolsError({
        providerId: this.id,
        model,
        toolCalls: toolIntentCalls,
      });
    }

    if (visible.trim()) {
      msgs.push({ role: "assistant", content: visible });
    }
    if (!ephemeral) {
      this.trimThread(msgs, streamOpts?.maxThreadMessages, sessionId);
      this.threads.afterTurnCompleted(sessionId, msgs);
    }
    // Token 用量审计（非工具分支）：输入为发往 LLM 的 messages + 可见工具 schema，
    // 并附带 API 真实返回的 usage（prompt/completion tokens + prefix cache 命中/未命中）
    try {
      recordLlmUsageByChars({
        stage: (streamOpts?.auditStage as Parameters<typeof recordLlmUsageByChars>[0]["stage"]) ?? "main_chat",
        sessionId,
        inputChars: requestAuditInput,
        outputChars: visible.length,
        model,
        promptCacheHitTokens: streamUsage?.promptCacheHitTokens,
        promptCacheMissTokens: streamUsage?.promptCacheMissTokens,
        ...(typeof streamUsage?.inputTokens === "number" ? { apiPromptTokens: streamUsage.inputTokens } : {}),
        ...(typeof streamUsage?.outputTokens === "number"
          ? { apiCompletionTokens: streamUsage.outputTokens }
          : {}),
      });
    } catch {
      /* 审计失败静默 */
    }
    // 前缀看门狗归因上报（非工具分支）：直答轮无 tools 段，主要盯 system 漂移
    if (plainHeadFps) {
      reportPrefixWatchOutcome({
        sessionId,
        stage: (streamOpts?.auditStage as string | undefined) ?? "main_chat",
        fingerprint: plainHeadFps,
        hitTokens: streamUsage?.promptCacheHitTokens,
        missTokens: streamUsage?.promptCacheMissTokens,
      });
    }
    return visible;
  }
}
