// 主动联系执行器（Proactive Outreach Executor）：BrainCenter 决策 speak 后的
// 「主动做事（工具）+ LLM 话术生成 + 投递」闭环。原实现长在 bootstrap 装配
// （create-app-services 内联闭包），2026-09-10 移交 proactivity 模块统一管理；
// bootstrap 只负责依赖接线。
//
// 话术上下文原则（2026-09-10 修复「主动消息像在回聊天」）：只注入用户当前聊天的
// 话题关键词摘要，绝不注入最近对话原文——原文会让话术变成对用户最后一条消息的
// 回答（"记住了/已存上"），与聊天回复管线撞车，且毫无依据（该轮没有工具结果支撑）。
import type {
  BrainCenter,
  BrainDecision,
  BrainSignalInput,
  MemoryRecallItem,
} from "../brain/index.js";
import type { SynapseBus } from "../brain/synapse-bus.js";
import { getChatThreadStore } from "../external-model/chat-thread-store.js";
import type { ChatToolExecutionContext, ExternalChatProvider } from "../external-model/types.js";
import { StreamSegmenter } from "../agent/stream-segmenter.js";
import {
  loadAgentStyleProfile,
  validateStyleConsistency,
} from "../agent/agent-style-profile.js";
import { resolvePrimaryChatSessionId } from "../agent/master-chat-session.js";
import { getAgentRuntimeConfig } from "../agent/agent-runtime-config.js";
import type { ToolContext, ToolRegistry } from "../tools/tool-registry.js";
import type { AgentMemorySyncService } from "../services/agent-memory-sync-service.js";
import { isTurnAsideEnabled } from "./turn-aside-queue.js";
import type { SpeechHub } from "./speech-express.js";
import {
  ProactiveOutboundMessageService,
  type ProactiveOutboundChannel,
} from "../services/proactive-outbound-message-service.js";
import { stripProtocolMarkersForDirectOut } from "../services/reply-envelope.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildFallbackMessage(signal: BrainSignalInput): string {
  // 通用兜底：基于 importance 和信号标题，不依赖活动类型枚举
  const importance = signal.importance ?? "medium";
  const title = signal.title;
  switch (importance) {
    case "critical": return `${title}，需要你现在处理一下。`;
    case "high": return `${title}，提醒你看一下。`;
    case "medium": return `刚刚察觉到：${title}。`;
    default: return `有个小情况：${title}。`;
  }
}

/** 话题提取忽略的功能词（高频虚词/对话套话/口语称呼，无话题信息量） */
const TOPIC_STOPWORDS = new Set([
  "什么", "怎么", "怎样", "这样", "那样", "这个", "那个", "没有", "可以", "现在", "时候",
  "他们", "我们", "自己", "一下", "然后", "还是", "就是", "不是", "好了", "谢谢", "你好",
  "觉得", "应该", "需要", "直接", "记住", "记得", "问题", "东西", "事情", "知道", "看看",
  "出来", "起来", "过来", "已经", "不用", "不行", "好的", "好吧", "来了", "说的", "的话",
  "帮我", "给我", "你对", "你的", "我的", "是不是", "有没有", "不能", "不要", "如果",
  "正在", "还是", "刚才", "一下", "一直", "不太", "有点",
  "the", "and", "you", "for", "that", "with", "this", "have", "not", "are", "was",
]);

/** 中文分词器（Node 内置 ICU 词典分词，零依赖）：把连续中文切成词典词，供话题统计 */
const ZH_WORD_SEGMENTER =
  typeof Intl !== "undefined" && typeof Intl.Segmenter === "function"
    ? new Intl.Segmenter("zh", { granularity: "word" })
    : undefined;

function* tokenizeForTopics(text: string): Generator<string> {
  if (ZH_WORD_SEGMENTER) {
    for (const seg of ZH_WORD_SEGMENTER.segment(text)) {
      if (seg.isWordLike) yield seg.segment;
    }
    return;
  }
  // 兜底（无 ICU 环境）：退化为连续中文串/英文单词，聊胜于无
  for (const raw of text.match(/[\u4e00-\u9fff]{2,}|[a-zA-Z]{3,}/g) ?? []) {
    yield raw;
  }
}

/**
 * 从最近对话提取话题关键词（零 LLM，确定性）。
 * 只回传关键词而非原文：主动话术只需「知道在聊什么」以避免突兀/重复，
 * 看到原文就会被带偏成聊天回复（见文件头注释）。
 * 用户消息权重高于 Agent 消息；越靠后（越新）权重越高。
 */
export function extractChatTopics(
  messages: { role: string; content?: unknown }[],
  maxTopics = 3,
): string[] {
  const counts = new Map<string, { n: number; recency: number }>();
  const total = Math.max(messages.length, 1);
  messages.forEach((msg, i) => {
    if (typeof msg.content !== "string" || !msg.content.trim()) return;
    const weight = (msg.role === "user" ? 2 : 1) * (1 + i / total);
    const cleaned = msg.content.replace(/^\[ts:[^\]]+\]\n?/, "").trim();
    for (const rawToken of tokenizeForTopics(cleaned)) {
      const word = rawToken.toLowerCase();
      if (TOPIC_STOPWORDS.has(word) || /^\d+$/.test(word) || /^一./.test(word)) continue;
      // 中文词至少 2 字（单字虚词无信息量），英文至少 3 字母
      const cjkChars = word.match(/[\u4e00-\u9fff]/g)?.length ?? 0;
      if (cjkChars > 0 ? cjkChars < 2 : word.length < 3) continue;
      if (word.length > 12) continue;
      const entry = counts.get(word) ?? { n: 0, recency: 0 };
      entry.n += weight;
      entry.recency = Math.max(entry.recency, 1 + i / total);
      counts.set(word, entry);
    }
  });
  return [...counts.entries()]
    .sort((a, b) => b[1].recency * b[1].n - a[1].recency * a[1].n)
    .slice(0, maxTopics)
    .map(([word]) => word);
}

/**
 * 构建主动话术 prompt：信号 + 最近主动话术记忆 + 用户当前聊天话题摘要。
 * 依赖用 getter 传入：brainCenter / synapseBus 在 bootstrap 装配段才赋值，
 * 执行时（信号到达后）才取值，避免创建执行器时捕获到 null。
 */
export type ProactiveOutreachDeps = {
  externalChat: () => ExternalChatProvider | null;
  toolRegistry: ToolRegistry;
  brainCenter: () => BrainCenter | null;
  synapseBus: () => SynapseBus | null;
  proactiveOutbound: ProactiveOutboundMessageService;
  agentMemorySyncService: AgentMemorySyncService;
  /**
   * 顺嘴搭车队列（2026-10-01 P1）：low 级主动消息挂起等用户下一轮对话织入
   * 回复末尾（rhythm 关怀候选等）。队列拒绝/关闭时走原即时推送路径。
   */
  turnAsideQueue?: import("./turn-aside-queue.js").TurnAsideQueue;
  /**
   * 死信闸（2026-10-01 P0）：用户全设备离线时外发必蒸发——照发既浪费一次
   * 话术 LLM 调用（还可能带工具循环），又产生「已发送」假台账。缺省视为在线。
   */
  isActorOnline?: (actorId: string) => boolean;
  /**
   * 统一开口出口（2026-10-26）：full 档 system 块装配（人格·静态 + 语感 + 通用
   * 纪律 + 画像）与用量记账归 SpeechHub 单点——本执行器保留工具循环、择时与投递。
   */
  speech: SpeechHub;
};

export function createProactiveOutreachExecutor(
  deps: ProactiveOutreachDeps,
): (decision: BrainDecision, signal: BrainSignalInput) => Promise<void> {
  const { toolRegistry, proactiveOutbound, agentMemorySyncService } = deps;

  /** C2: 构建主动话术 prompt，注入最近主动话术记忆 + 当前聊天话题摘要。 */
  async function buildProactivePrompt(
    signal: BrainSignalInput,
    decision: BrainDecision,
  ): Promise<string> {
    const summary = signal.summary ? `\n信号摘要: ${signal.summary}` : "";
    const importance = signal.importance ?? "medium";
    const occurredAt = String(signal.metadata?.occurredAt ?? new Date().toISOString());

    // C2: 召回最近主动话术记忆，注入 prompt 供 LLM 引用上下文。
    // Task 5: 优先复用 decide 阶段（recallRecentMemories）已召回的 decision.recallItems，
    // 避免对同一 LifeSignal 重复执行 MemoryCortex.recall；仅在 decide 未携带
    // recallItems（如 fallback:no_e2e_maker 路径 / 召回失败）时降级到独立 episodic 召回。
    const decisionRecall = decision.recallItems;
    let recallItems: MemoryRecallItem[];
    if (decisionRecall !== undefined) {
      recallItems = decisionRecall;
    } else if (deps.brainCenter()) {
      try {
        const recallResult = await deps.brainCenter()!.recall(signal.actorId, signal.title, {
          domain: "episodic",
          limit: 3,
        });
        recallItems = recallResult.items;
      } catch (err) {
        console.log(`[ProactiveOutreach] 主动话术记忆召回失败（忽略）: ${err}`);
        recallItems = [];
      }
    } else {
      recallItems = [];
    }

    let memoryContext = "";
    if (recallItems.length > 0) {
      const recentMsgs = recallItems
        .map((item) => `- ${item.content}`)
        .join("\n");
      memoryContext = `\n你最近主动说过的话:\n${recentMsgs}\n如果与当前信号相关，可以自然引用（如"刚才那个我又看了一下"），但别生硬。`;
    }

    // 用户当前聊天话题摘要（零 LLM 关键词，不注入原文）：只用于感知话题走向、
    // 避免开口突兀或撞题；明确禁止以回答者身份接这些聊天内容（聊天回复由对话管线负责）。
    let chatTopicContext = "";
    try {
      const chatSessionId = resolvePrimaryChatSessionId(
        signal.actorId,
        getAgentRuntimeConfig().masterDelegation.enabled,
      );
      const messages = getChatThreadStore().thread(chatSessionId, "");
      const topics = extractChatTopics(messages.slice(-10));
      if (topics.length > 0) {
        chatTopicContext = `\n用户当前聊天话题：${topics.join("、")}\n（仅用于避免开口突兀或撞题；不要回答/接续这些聊天内容）`;
      }
    } catch {
      // thread store 读取失败不阻塞话术生成
    }

    return `信号类型：${signal.kind}
信号标题：${signal.title}
重要程度：${importance}
检测时间：${occurredAt}
决策评分：value=${decision.valueScore}, disturb=${decision.disturbScore}${summary}${memoryContext}${chatTopicContext}

请基于信号内容，主动帮用户做事（调用工具）并生成主动话术。`;
  }

  async function executeProactiveDecision(
    decision: BrainDecision,
    signal: BrainSignalInput,
  ): Promise<void> {
    // 顺嘴搭车（2026-10-01 P1）：low 级主动消息挂起等下一轮对话织入回复末尾，
    // 比单推一条气泡打扰更低（rhythm 关怀候选即此形态）。队列拒绝（同 kind
    // 挂起中/间隔不足）或通道关闭时回退原即时推送路径——不静默吞消息。
    if (
      signal.importance === "low" &&
      isTurnAsideEnabled() &&
      deps.turnAsideQueue?.tryEnqueue({
        actorId: signal.actorId,
        kind: signal.kind,
        title: signal.title,
        summary: signal.summary,
      })
    ) {
      console.log(
        `[ProactiveOutreach] 顺嘴挂起（等下一轮对话织入）kind=${signal.kind} actor=${signal.actorId}`,
      );
      return;
    }

    // 死信闸（2026-10-01 P0）：全设备离线时话术发不进任何屏幕——放弃这次
    // 说话（省一次话术 LLM + 可能的工具循环），决策日志已留痕可追溯。
    // 注意放在顺嘴挂起之后：low 级挂起不等在线（用户回来聊天才织入）。
    if (deps.isActorOnline && !deps.isActorOnline(signal.actorId)) {
      console.log(
        `[ProactiveOutreach] 死信丢弃（全设备离线，省话术 LLM）kind=${signal.kind} actor=${signal.actorId}`,
      );
      return;
    }

    const brainCenter = deps.brainCenter();
    const externalChat = deps.externalChat();
    // Task 5: 加载 Agent 自身风格指纹（仅用于话术风格一致性校验；system 块装配
    // 已单点化到 SpeechHub——人格·静态/语感/纪律/画像由其统一注入）
    const styleProfile = loadAgentStyleProfile(agentMemorySyncService);

    // 1. 调 LLM 生成话术（启用 function calling，LLM 可自主调工具做事）
    let message = "";
    if (externalChat) {
      try {
        // 构建工具执行上下文：LLM 调工具 → toolRegistry.execute → 真实执行
        const toolContext: ToolContext = {
          sessionId: signal.actorId,
          userId: signal.actorId,
          agentAccessMode: "full",
        };
        const toolExecCtx: ChatToolExecutionContext = {
          executeTool: (name, args) => toolRegistry.execute(name, args, toolContext),
        };
        await externalChat.streamCompletion(
          `proactive:${signal.actorId}:${Date.now()}`,
          { text: await buildProactivePrompt(signal, decision) },
          (delta) => {
            message += delta;
          },
          toolExecCtx,
          {
            // C2: 关闭 ephemeralTurn，让主动话术写入 provider thread
            // 下次 buildProactivePrompt 的 recall 能召回"我之前主动说过什么"
            ephemeralTurn: false,
            disableThinking: true,
            maxThreadMessages: 4,
            systemPromptOverride: await deps.speech.buildSystemPrompt({
              sessionId: signal.actorId,
              kind: signal.kind,
              tier: "full",
            }),
            toolExposureProfile: "contextual",
            toolLoop: { maxRounds: 2 },
          },
        );
        // full 档用量记账（与 light 档共享日熔断池）
        deps.speech.recordUsage();
        // Task 5: LLM 话术生成后做风格一致性校验（非阻塞，仅记录警告日志，不修改输出内容）
        if (message.trim()) {
          const consistency = validateStyleConsistency(message, styleProfile);
          if (!consistency.passed) {
            console.log(
              `[ProactiveOutreach] 话术风格偏离警告: ${consistency.reason}（偏离度=${consistency.deviation}）话术="${message.slice(0, 50)}..."`,
            );
          }
        }
      } catch (err) {
        console.log(`[ProactiveOutreach] LLM 话术生成失败，使用模板兜底: ${err}`);
        message = buildFallbackMessage(signal);
      }
    } else {
      message = buildFallbackMessage(signal);
    }

    // 2. LLM 输出异常（SILENT/空）时用模板兜底发送——
    //    ProactionCortex 已决策 speak，LLM 只负责话术，不应有否决权，
    //    否则 LLM 的保守倾向会把规则判定该发的信号压成静默。
    if (message.trim().toUpperCase() === "SILENT" || !message.trim()) {
      console.log(`[ProactiveOutreach] LLM 输出异常，使用模板兜底`);
      message = buildFallbackMessage(signal);
    }

    // 2.4 渲染协议标记剥离：主动外呼是 ephemeralTurn:false 的非聊天直出出口
    //     （协议提示词有注入，为线程召回），出口必须确定性剥掉模型可能复述的
    //     RENDER_HINT / NEXT_UP / 结构化卡 JSON，避免协议标记原样推给用户。
    message = stripProtocolMarkersForDirectOut(message);

    // 2.5 Stage 4 Task 2：输出安全过滤——检测话术中的敏感信息并替换为 [REDACTED]。
    //     brainCenter 未注册时原文本透传（checkOutputSafety 内部已降级）。
    //     命中时用 sanitized 覆盖 message，避免把 API key/私钥/内部路径推给用户。
    if (brainCenter && message.trim()) {
      const outputSafety = brainCenter.checkOutputSafety(message, {
        actorId: signal.actorId,
        stage: "executeProactiveDecision",
      });
      if (!outputSafety.safe) {
        console.log(
          `[ProactiveOutreach] 主动话术输出已脱敏 actorId=${signal.actorId} reason=${outputSafety.reason}`,
        );
        message = outputSafety.sanitized;
      }
    }

    // 3. 通过 SynapseBus.sendToUser 投递（WS + MessageHub 离线降级）
    //    注意：synapseBus 可能在 brainNeuroEnabled=0 时未创建
    //    垫词 + 分段已统一到 StreamSegmenter（与 chat 主回复同一模块）：
    //    垫词 = 话术首个分句（interim），信息块分段 + 增量去重后逐段（stream）推送，
    //    模拟真人"开口一句、再打一段发一段"的节奏，而不是一次性冒出完整结论。
    const targetBus = deps.synapseBus();
    if (targetBus) {
      const bubbles: Array<{ text: string; phase: "interim" | "stream" }> = [];
      const proactiveSegmenter = new StreamSegmenter(
        (seg, phase) => bubbles.push({ text: seg, phase }),
        {
          pauseMs: 400,
          minSegmentChars: 6,
          interimReplyGapMs: 600,
          segmentationEnabled: true,
          blockCharTarget: 56,
          maxStreamSegments: 3,
        },
      );
      proactiveSegmenter.feed(message.trim());
      await proactiveSegmenter.flushFinal();
      if (bubbles.length === 0) {
        // 极端兜底：分段器未产出（可能全被去重），整条作为单个消息发
        await targetBus.sendToUser(signal.actorId, {
          type: "agent.proactive_message",
          payload: {
            title: "Agent 主动联系",
            text: message.trim(),
            channel: decision.channel ?? "websocket",
            reason: decision.rationale,
          },
        });
      } else {
        // 逐段发送：垫词气泡先行，随后正文逐段，间隔由 StreamSegmenter 的停顿保证
        for (let i = 0; i < bubbles.length; i++) {
          const isLast = i === bubbles.length - 1;
          await targetBus.sendToUser(signal.actorId, {
            type: "agent.proactive_message",
            payload: {
              title: "Agent 主动联系",
              text: bubbles[i].text,
              channel: decision.channel ?? "websocket",
              // importance 透传：客户端据此选择弹窗触达（高重要度主动消息可弹窗）
              importance: signal.importance ?? (decision.valueScore > 5 ? "high" : "medium"),
              reason: isLast ? decision.rationale : undefined,
              isPartial: !isLast,
            },
          });
          if (!isLast) {
            await sleep(400);
          }
        }
      }
      console.log(`[ProactiveOutreach] 主动消息已发送给 ${signal.actorId}（${bubbles.length} 段）: ${message.slice(0, 50)}...`);
    } else {
      // synapseBus 不存在时降级到 proactiveOutbound
      await proactiveOutbound.send({
        actorId: signal.actorId,
        title: "Agent 主动联系",
        text: message.trim(),
        reason: `brain:${decision.rationale}`,
        channel: (decision.channel ?? "websocket") as ProactiveOutboundChannel,
      });
      console.log(`[ProactiveOutreach] 主动消息已通过 outbound 发送给 ${signal.actorId}`);
    }

    // 4. 出行建议已合并到 function calling 阶段：
    //    LLM 可自主调 weather.get_local 等工具查信息并融入话术，
    //    不再需要单独的"出行建议"消息块，避免双消息打断用户。

    // 5. C2: 主动话术写入记忆——下次 buildProactivePrompt 的 recall 能召回
    //    让 LLM 能说"刚才那个我又看了一下"，产生连续感而非每次孤立开口
    if (brainCenter && message.trim()) {
      try {
        await brainCenter.remember(signal.actorId, {
          actorId: signal.actorId,
          kind: "event",
          domain: "episodic",
          content: `[主动话术] ${message.trim()}`,
          importance: signal.importance as "critical" | "high" | "medium" | "low" | undefined,
          source: "system",
          timestamp: new Date().toISOString(),
          metadata: {
            signalKind: signal.kind,
            signalTitle: signal.title,
            decisionRationale: decision.rationale,
          },
        });
      } catch (err) {
        console.log(`[ProactiveOutreach] 主动话术记忆写入失败（忽略）: ${err}`);
      }
    }
  }

  return executeProactiveDecision;
}
