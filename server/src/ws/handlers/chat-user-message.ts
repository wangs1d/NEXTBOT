import { readFile } from "node:fs/promises";
import { appendFileSync } from "node:fs";

import type { RuntimeFacade } from "../../runtime/runtime-facade.js";
import type { AuditService } from "../../services/audit-service.js";
import type { VoiceCapabilityService } from "../../services/voice-capability-service.js";
import type { VoiceMessageService } from "../../services/voice-message-service.js";
import { resolveActorId } from "../../agent/actor-id.js";
import { ClientEventType, ServerEventType } from "../../protocol.js";
import type { VisionFrame } from "../../external-model/types.js";
import { agentProcessingUiSchema, userMessageSchema } from "../../schemas/api.js";
import {
  sanitizeVisionFramesFromWire,
  type VisionWireInput,
} from "../../vision/sanitize-vision-frames.js";
import { formatStatusForDisplay, normalizeDashTypos, stripSentencesAlreadySaid } from "../../utils/text.js";
import { createStreamMarkerGuard } from "../../utils/stream-marker-guard.js";
import { wireToolExecuted, wireToolExecuteStart } from "../chat-tool-wire.js";
import { subscribeTravelProgress } from "../../skills/travel-planning/travel-progress-bus.js";
import { formatScheduleToolResultForUser } from "../../tools/schedule-user-reply.js";
import { parseAgentAccessMode } from "../../agent/agent-access-mode.js";
import {
  embodimentAlert,
  embodimentHappy,
  embodimentListening,
  embodimentThinking,
} from "../../services/agent-embodiment.js";
import { getEmbodimentAutonomy } from "../../services/embodiment-autonomy-service.js";
import type { PhoneCallCoordinator } from "../../services/phone-call-coordinator.js";
import {
  MessageBatchProcessor,
  type BatchedMessage,
  type BatchTurnContext,
} from "../message-batch-processor.js";
import { getAgentRuntimeConfig } from "../../agent/agent-runtime-config.js";
import { getChatThreadStore } from "../../external-model/chat-thread-store.js";
import { getMemoryManagerService } from "../../services/memory-manager-service.js";
import { getMemoryComponents } from "../../agentic-memory/index.js";
import {
  isNotesChatSessionId,
  isIncognitoChatSessionId,
  resolvePrimaryChatSessionId,
} from "../../agent/master-chat-session.js";
import { shouldUsePhasedAsyncConversation } from "../../agent/interim-ack.js";
import { StreamSegmenter, type StreamSegmentEmitMeta } from "../../agent/stream-segmenter.js";
import { BubbleTracker } from "../../agent/bubble-tracker.js";
import {
  UtteranceAssembler,
  type UtteranceSettlement,
} from "../../agent/utterance-assembler.js";
import { isVoiceMode } from "../../proactivity/voice-mode-state.js";
import { CALENDAR_CONFIRM_TOOLS } from "../../services/agent-core.js";
import {
  buildExecutionEventPayload,
  buildIntentDetectedPayload,
  createTurnEventEmitter,
  type TurnEventEmitter,
} from "../../agent/turn-events.js";
import { getToolResultProcessor, attachMediaSearchMarker, extractMediaCards, dedupMediaCards, trimMediaCardsByTopic, buildInterleavedRenderBlocks, buildCaptionedRenderBlocks, allImageCardsHaveCaption, stripMediaCardMarker, isMediaSearchTool, type MediaCardItem } from "../../services/tool-result-processor.js";
import { stripContentSummaryBlock, extractContentSummaryCard } from "../../services/content-summary-service.js";
import {
  buildToolCard,
  lookupToolCardBuilder,
} from "../../services/tool-card-registry.js";
import {
  attachDeterministicCards,
  looksLikeHandwrittenItinerary,
  resolveTravelReceipt,
  sniffItineraryDays,
  type ExecutedToolReceipt,
} from "../../services/deterministic-card-chain.js";
import { buildVisionPhotoCards, attachImageResultPhotos } from "../../services/vision-photo-cards.js";
import { captionMediaCards, isImageCaptionEnabled } from "../../services/image-caption-service.js";
import { stripDsmlToolCallMarkup } from "../../external-model/stream-chat-helpers.js";
import {
  buildReplyBlocks,
  extractNextUpSuggestions,
  normalizeReplyCardLayout,
} from "../../services/reply-envelope.js";
import {
  isOnlyTimestampFrames,
  stripAllTimestampFrameLines,
  stripLeadingTimestampFrames,
} from "../../utils/timestamp-frame.js";
import { stripInternalFrames } from "../../external-model/internal-frames.js";
import { globalTurnLimiter, TURN_QUEUE_TIMEOUT, recordTurnOutcome } from "../../services/concurrency-limiter.js";
import { FALLBACK_TEXT_BUSY } from "../../external-model/fallback-texts.js";

const messageBatchProcessor = new MessageBatchProcessor(
  getAgentRuntimeConfig().messageBatch,
);

export { messageBatchProcessor };

/**
 * Actor 级 AbortController 跟踪:用户发新消息时 abort 旧 controller,
 * 真正中断进行中的 LLM HTTP 流式请求(节省 tokens/算力)。
 * 与 messageBatchProcessor 的 isStaleTurn 门控配合:isStale 抑制输出,abort 中断请求。
 */
const activeTurnAborters = new Map<string, AbortController>();

/**
 * 单轮主回复的硬超时：handleUserMessage 挂死（底层 LLM/桥接/工具链永不 settle）时
 * finally 里的 releaseTurn() 永不执行，全局并发上限（默认 8）会被逐个耗尽，
 * 最终所有用户收到 BUSY。超时后 abort 本轮 controller 并抛错走 catch 路径，
 * 保证 turn 槽位、心跳定时器、批处理锁全部释放。
 * 默认 540s（略小于 message-batch-processor 的 600s 硬超时，让本层先触发、
 * 用户能收到明确错误提示）；env CHAT_TURN_TIMEOUT_MS 可调。
 */
function resolveChatTurnTimeoutMs(): number {
  const n = Number.parseInt(process.env.CHAT_TURN_TIMEOUT_MS ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : 540_000;
}

function withTurnHardTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  onTimeout: () => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      try {
        onTimeout();
      } catch {
        /* ignore */
      }
      reject(new Error(`chat turn hard timeout: exceeded ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** 中断指定 actor 当前进行中的 LLM 请求(如有)。 */
function abortActiveTurn(actorId: string): void {
  const prev = activeTurnAborters.get(actorId);
  if (prev) {
    try { prev.abort(); } catch { /* ignore */ }
    activeTurnAborters.delete(actorId);
  }
}

/**
 * 搜索类媒体工具：其产出照片/视频是「搜索证据」，有真实产出时本轮主形态为
 * 媒体卡，search_result 文字搜索卡整卡让位（意图仲裁，见 done 阶段附卡链）。
 * image.generate 生图不算搜索证据，不在集合内（生图 + 搜资讯的轮文字卡保留）。
 */
const SEARCH_MEDIA_TOOL_NAMES = new Set([
  "search_images",
  "search_images_batch",
  "search_videos",
]);

/**
 * 工具调用成功 + LLM 末轮没出正文时，把工具结果格式化成用户可读的回复文本。
 * 不再用"已查到见上面"等合成提示语——直接展示工具返回的真实数据。
 * 返回空串表示无法格式化（上层会走其他回退路径）。
 */
function formatToolResultAsReply(toolName: string, result: Record<string, unknown>): string {
  // 元工具/能力查询类输出是结构化 JSON（工具 schema、能力清单），不是用户可读内容。
  // 若 LLM 末轮没出正文,不能用它们拼成回复透出到前端,直接返回空串走其他兜底路径。
  const META_TOOL_NAMES = new Set([
    "tool_discover",
    "tool_search",
    "tool_describe",
    "tool_call",
    "agent.query_capabilities",
    "brain.list_capabilities",
    "self.list_custom_skills",
  ]);
  if (META_TOOL_NAMES.has(toolName)) return "";

  const t = toolName.toLowerCase();
  // 媒体搜索（search_images/search_videos）：照片/视频已由 independent 的 mediaCards
  // 结构化卡片渲染给用户，绝对不能再把工具的 items 原始 JSON 拼成回复文本透出——
  // 否则会出现"空 thumbnailUrl 的无效项、原始 JSON、脏字段"一起发给用户的脏展示。
  // 这里直接返回空串，让本轮只呈现干净的媒体卡片（不产生任何文本噪音）。
  if (t.includes("search_images") || t.includes("search_videos")) return "";
  // 旅游行程规划：行程的正确呈现形态是 travel_itinerary 双面板卡，手工拼文本只会
  // 得到 `days: [{...}]` 式 key:value 垃圾展示。这里原样返回 summarizeItinerary JSON，
  // 交由 processAssistantText 的行程检测器（detectRawTravelItineraryJson）确定性转卡。
  if (t.startsWith("travel.plan-itinerary")) {
    try {
      return JSON.stringify(result);
    } catch {
      return "";
    }
  }
  // 搜索类：把标题/摘要/URL 列出来
  if (t.includes("search_web") || t.includes("web_search") || t.includes("info_hub")) {
    const items = (result.results ?? result.items ?? []) as Array<Record<string, unknown>>;
    if (Array.isArray(items) && items.length > 0) {
      const lines = items.slice(0, 5).map((it, i) => {
        const title = (it.title ?? "") as string;
        const url = (it.url ?? it.link ?? "") as string;
        const snippet = (it.snippet ?? it.summary ?? "") as string;
        return `${i + 1}. ${title}${url ? `\n   ${url}` : ""}${snippet ? `\n   ${snippet.slice(0, 120)}` : ""}`;
      });
      return `查到了 ${items.length} 条结果：\n\n${lines.join("\n\n")}`;
    }
    return "";
  }
  // 抓取类：返回正文摘要
  if (t.includes("fetch_web") || t.includes("web_fetch") || t.includes("http_get")) {
    const title = (result.title ?? "") as string;
    const content = (result.content ?? result.text ?? result.body ?? "") as string;
    if (title || content) {
      return `${title}\n\n${content.slice(0, 800)}`.trim();
    }
    return "";
  }
  // 按内容找视频（video.find）：有可播流时播放卡已经是完整形态，正文再拼一遍
  // 标题/链接就是噪音（「面板纯视频、不带文案」定稿）→ 直接空串，只留卡片；
  // 全无可播流时才降级成「标题 + 播放页链接」，保证至少有东西可点。
  if (t === "video.find" || t.includes("video_find")) {
    const items = (result.items ?? []) as Array<Record<string, unknown>>;
    const playable = items.find((it) => String(it?.videoUrl ?? "").trim());
    if (playable) return "";
    const first = items[0];
    if (!first) return "";
    const title = String(first.title ?? "").trim();
    const pageUrl = String(first.pageUrl ?? "").trim();
    return [title ? `视频：${title}` : "", pageUrl].filter(Boolean).join("\n");
  }
  // 视频抓取：列出标题/作者/链接，播放页链接供点击
  if (t === "video.grab" || t.includes("video_grab") || t.includes("video.grab")) {
    const title = (result.title ?? "") as string;
    const author = (result.author ?? "") as string;
    const pageUrl = (result.playPageUrl ?? result.pageUrl ?? "") as string;
    const notes = Array.isArray(result.notes) ? result.notes.map(String).join("；") : "";
    const parts: string[] = [];
    if (title) parts.push(`视频：${title}`);
    if (author) parts.push(`作者：${author}`);
    if (pageUrl) parts.push(`原链接：${pageUrl}`);
    if (notes) parts.push(notes);
    return parts.join("\n");
  }
  // 天气/时钟/日历：直接 JSON 转可读文本
  const summary = (result.summary ?? result.description ?? result.text ?? "") as string;
  if (summary) return String(summary);
  // 兜底：把 result 的关键字段拼出来，避免完全无内容
  const keys = Object.keys(result).filter((k) => !["ok", "error"].includes(k));
  if (keys.length === 0) return "";
  return keys.map((k) => `${k}: ${JSON.stringify(result[k]).slice(0, 200)}`).join("\n");
}

/**
 * 把 finalText 中以纯文本形式出现的图片地址提升为可见缩略图（Markdown 图片语法）。
 *
 * 这是 mediaCards 解析为空时的最后兜底：LLM 若把图片 URL 直接写进正文（如
 * `http.../a.png`），前端 markdown 默认只当普通链接，用户看到的是地址而非照片。
 * 仅按常见图片扩展名识别，避免误伤一般超链接；已处于 `![alt](url)` 内则不重复包裹。
 */
function promoteImageUrlsToMedia(text: string): string {
  if (!text) return text;
  const IMG_URL_RE = /https?:\/\/[^\s)\]}"'<>]+\.(?:png|jpe?g|gif|webp|avif)(?:\?[^\s)\]}"'<>]*)?/gi;
  const promote = (segment: string): string =>
    segment.replace(IMG_URL_RE, (match: string, offset: number, full: string) => {
      // 前面紧邻 `](` => 已处于 markdown 图片/链接语法内，不重复包裹
      if (/\]\($/.test(full.slice(0, offset))) return match;
      return `![图片](${match})`;
    });
  // 卡片标记段内是结构化 JSON（travelPlan.images 等自带图片字段，前端直读渲染），
  // 往 JSON 字符串值里注入 markdown 会让面板图片地址解析失败。只处理卡片外的纯文本段。
  const START = "[AGENT_RESULT_CARD_START]";
  const END = "[AGENT_RESULT_CARD_END]";
  if (!text.includes(START)) return promote(text);
  let out = "";
  let cursor = 0;
  for (let guard = 0; guard < 10; guard++) {
    const si = text.indexOf(START, cursor);
    if (si === -1) break;
    const ei = text.indexOf(END, si);
    if (ei === -1) break;
    out += promote(text.slice(cursor, si));
    out += text.slice(si, ei + END.length);
    cursor = ei + END.length;
  }
  out += promote(text.slice(cursor));
  return out;
}

/**
 * 从文本中剥离媒体工具 echo：形如 `[/agent/images/.../xxx.png]说明` 或
 * `![...](http.../xxx.jpg)` 这类「图片路径 + 标题」行。
 *
 * 场景：即便 `formatToolResultAsReply` 已对 media 工具返回空串，LLM 仍可能把
 * `search_images` 的工具项原样抄进自己的正文（如 `[路径]歌名`）。但这些照片已经
 * 由独立 mediaCards 结构化卡片渲染，正文里再出现 URL 行就会变成底部脏文本。
 * 这里按行剔除含图片地址的行，保留纯文字叙述（若整段都是 echo 则剩余为空）。
 */
function stripMediaEchoText(text: string): string {
  if (!text) return text;
  // 图片地址：代理路径 /agent/images/... 或 http(s) 常见图片扩展名
  const MEDIA_LINE_RE =
    /(\/agent\/images\/[^\s)\]"']+)|(https?:\/\/[^\s)\]"']+\.(?:png|jpe?g|gif|webp|avif)(?::\d+)?(?:\?[^\s)\]"']*)?)/i;
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => !MEDIA_LINE_RE.test(line))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export type ChatUserMessageHandlerDeps = {
  runtime: RuntimeFacade;
  auditService: AuditService;
  /** 语音能力中枢（可选；注入后支持 contentType=audio 的 ASR 链路） */
  voiceCapabilityService?: VoiceCapabilityService;
  /** 语音消息落盘服务（可选；用于解析 audio 消息的本地文件路径） */
  voiceMessageService?: VoiceMessageService;
  /**
   * 电话代办协调器（可选）：等待确认期间用户文本明确「确认拨打」时的
   * 兜底确认入口（确认卡按钮渲染失败/旧客户端场景）。权威确认仍是
   * connection.ts 在 chat.user_action 原点记录的卡片点击。
   */
  phoneCallCoordinator?: PhoneCallCoordinator;
};

export type ChatUserMessageContext = {
  socket: { send: (data: string) => void };
  boundActorId: string;
  /** 当前 WS 的完整 sessionId（含 notes:/master: 前缀），用于记忆上下文区分。 */
  sessionId: string;
  initAsDesktopBridge: boolean;
  clientIp?: string;
  /**
   * 发送本条消息的连接自报设备类别（2026-10-07）：session.init 的 platform 归一，
   * 注入【运行环境】块让 agent 知道用户此刻在手机上还是电脑上。
   * 缺省（连接未登记/旧客户端）按 undefined 传递，prompt 侧不注入该块。
   */
  deviceClass?: "desktop" | "mobile";
  sendUnifiedError: (code: string, message: string, traceId?: string) => void;
};

/**
 * 处理 `chat.user_message` WebSocket 事件。
 * @returns 是否已消费该事件
 */
export async function handleChatUserMessageEvent(
  ctx: ChatUserMessageContext,
  payload: unknown,
  deps: ChatUserMessageHandlerDeps,
): Promise<boolean> {
  if (!ctx.boundActorId) {
    ctx.socket.send(
      JSON.stringify({
        type: ServerEventType.ErrorEvent,
        payload: { code: "SESSION_REQUIRED", message: "请先发送 session.init" },
      }),
    );
    return true;
  }
  if (ctx.initAsDesktopBridge) {
    ctx.socket.send(
      JSON.stringify({
        type: ServerEventType.ErrorEvent,
        payload: {
          code: "DESKTOP_BRIDGE_NO_CHAT",
          message: "桌面桥接连接不能发送 chat.user_message，请使用普通客户端聊天",
        },
      }),
    );
    return true;
  }

  const parsed = userMessageSchema.safeParse(payload);
  if (!parsed.success) {
    ctx.socket.send(
      JSON.stringify({
        type: ServerEventType.ErrorEvent,
        payload: { code: "INVALID_CHAT_EVENT", message: parsed.error.message },
      }),
    );
    return true;
  }

  const data = parsed.data;
  const msgActor = resolveActorId({ userId: data.userId, sessionId: data.sessionId });
  if (msgActor !== ctx.boundActorId) {
    ctx.socket.send(
      JSON.stringify({
        type: ServerEventType.ErrorEvent,
        payload: { code: "FORBIDDEN", message: "userId/sessionId 与当前连接不一致" },
      }),
    );
    return true;
  }

  let visionFrames: VisionFrame[] | undefined;
  try {
    // 边界收敛：zod 双实例（agent-protocol 与 server 各自的 zod 副本）会让
    // 跨包 z.infer 把枚举字段退化成 unknown；schema 本身已校验 sourceKind，
    // 这里仅做类型断言，无运行时行为差异。
    visionFrames = sanitizeVisionFramesFromWire(
      data.visionFrames as VisionWireInput[] | undefined,
    );
  } catch (ve) {
    ctx.socket.send(
      JSON.stringify({
        type: ServerEventType.ErrorEvent,
        payload: {
          code: "INVALID_VISION",
          message: ve instanceof Error ? ve.message : String(ve),
        },
      }),
    );
    return true;
  }

  const textTrim = data.text.trim();
  const agentAccessMode = parseAgentAccessMode(data.agentAccessMode);
  let effectiveText =
    textTrim ||
    (visionFrames?.length ? "（用户发送了摄像头/配图画面，请根据图像描述内容并回答。）" : "");

  // audio 消息：拉取本地 mp3 → ASR 识别 → 用 transcript 作为正文喂给 LLM
  // 同时把 transcript 回推给客户端，让 user 消息气泡直接显示识别文本。
  if (data.contentType === "audio" && data.mediaUrl && deps.voiceCapabilityService && deps.voiceMessageService) {
    try {
      const asrText = await transcribeAudioFromMediaUrl(
        data.mediaUrl,
        msgActor,
        deps.voiceCapabilityService,
        deps.voiceMessageService,
      );
      if (asrText) {
        effectiveText = asrText;
      } else {
        effectiveText = "（用户发送了一段语音消息，但识别失败，请提示用户重试或用文字发送）";
      }
      // 回推 ASR 转写结果给客户端（无论成功失败，方便用户/客户端核对）
      ctx.socket.send(
        JSON.stringify({
          type: ServerEventType.ChatAudioTranscript,
          payload: {
            sessionId: msgActor,
            messageId: data.messageId,
            mediaUrl: data.mediaUrl,
            transcript: asrText ?? "",
            language: "zh",
            ok: Boolean(asrText),
          },
        }),
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`[chat.user_message] ASR 失败: ${msg}`);
      effectiveText = `（用户发送了一段语音消息，识别失败：${msg}）`;
      ctx.socket.send(
        JSON.stringify({
          type: ServerEventType.ChatAudioTranscript,
          payload: {
            sessionId: msgActor,
            messageId: data.messageId,
            mediaUrl: data.mediaUrl,
            transcript: "",
            language: "zh",
            ok: false,
            error: msg,
          },
        }),
      );
    }
  } else if (data.contentType === "audio" && data.mediaUrl) {
    // 未注入 ASR 服务：降级提示
    effectiveText = "（用户发送了一段语音消息，但服务端未配置 ASR 能力，无法识别内容）";
    ctx.socket.send(
      JSON.stringify({
        type: ServerEventType.ChatAudioTranscript,
        payload: {
          sessionId: msgActor,
          messageId: data.messageId,
          mediaUrl: data.mediaUrl,
          transcript: "",
          language: "zh",
          ok: false,
          error: "ASR 服务未注入",
        },
      }),
    );
  }

  // 电话代办文本兜底确认：会话等待确认期间，用户文本明确「确认拨打」时记录确认
  // （与确认卡点击同效；正则严格短语匹配，避免误伤无关场景的「确认」）。fire-and-forget。
  deps.phoneCallCoordinator?.observeUserText(msgActor, effectiveText);

  void deps.auditService
    .record({
      type: ClientEventType.ChatUserMessage,
      sessionId: msgActor,
      userId: data.userId,
      messageId: data.messageId,
      text: effectiveText,
    })
    .catch(() => {});

  embodimentListening(msgActor, (json) => ctx.socket.send(json));

  // 立即发送协议级 received-ack（< 1ms），让客户端知道消息已被服务端接收
  ctx.socket.send(
    JSON.stringify({
      type: ServerEventType.ChatMessageReceived,
      payload: {
        sessionId: msgActor,
        messageId: data.messageId,
        receivedAt: Date.now(),
      },
    }),
  );

  messageBatchProcessor.submit(msgActor, {
    text: effectiveText,
    visionFrames,
    agentAccessMode,
    clientIp: data.clientIp || ctx.clientIp,
    clientLocation: data.clientLocation,
    deviceClass: ctx.deviceClass,
    interruptedContext: (data as { interruptedContext?: string }).interruptedContext,
    originalMessageId: data.messageId,
    userId: data.userId ?? msgActor,
    // 隐身会话（incognito: 前缀）是唯一放行的 payload sessionId——主通道会话
    // 一律钉死为绑定身份（防串台），但隐身标记必须流到 finalizeTurn 才能生效。
    sessionId:
      typeof data.sessionId === "string" && isIncognitoChatSessionId(data.sessionId)
        ? data.sessionId
        : ctx.sessionId,
    contentType: typeof data.contentType === "string" ? data.contentType : undefined,
  }, (batched, turn) => processBatchedMessage(ctx, batched, deps, turn));

  return true;
}

/**
 * 处理 `chat.agent_processing_ui`：客户端「处理中」组件显隐。
 */
export function handleChatAgentProcessingUiEvent(
  ctx: ChatUserMessageContext,
  payload: unknown,
): boolean {
  if (!ctx.boundActorId) {
    return true;
  }
  const parsed = agentProcessingUiSchema.safeParse(payload);
  if (!parsed.success) {
    ctx.socket.send(
      JSON.stringify({
        type: ServerEventType.ErrorEvent,
        payload: { code: "INVALID_CHAT_EVENT", message: parsed.error.message },
      }),
    );
    return true;
  }
  const data = parsed.data;
  const msgActor = resolveActorId({ userId: data.userId, sessionId: data.sessionId });
  if (msgActor !== ctx.boundActorId) {
    ctx.socket.send(
      JSON.stringify({
        type: ServerEventType.ErrorEvent,
        payload: { code: "FORBIDDEN", message: "userId/sessionId 与当前连接不一致" },
      }),
    );
    return true;
  }
  messageBatchProcessor.setClientProcessingUiActive(msgActor, data.active);
  return true;
}

async function processBatchedMessage(
  ctx: ChatUserMessageContext,
  batched: BatchedMessage,
  deps: ChatUserMessageHandlerDeps,
  turn: BatchTurnContext,
): Promise<void> {
  const msgActor = ctx.boundActorId;
  const isStale = (): boolean => messageBatchProcessor.isStaleTurn(msgActor, turn.generation);

  if (isStale()) return;

  // 中断该 actor 上一轮进行中的 LLM 请求(用户发新消息 → abort 旧的 HTTP 流式)
  abortActiveTurn(msgActor);
  const turnAbortController = new AbortController();
  activeTurnAborters.set(msgActor, turnAbortController);

  getEmbodimentAutonomy()?.setProcessing(msgActor, true, (json) => ctx.socket.send(json));

  let chunkSeq = 0;
  const assistantMessageId = `assistant-${batched.originalMessageId}`;

  // 真·分绿泡（2026-09-28）：对话面闲聊轮把信息块升级为独立气泡连发。
  // bubbleSplitActive 在路由决策就绪后置位（首个主回复 delta 之前，无竞态）；
  // 每个气泡独立 messageId（assistant-$traceId-bN，避开 interim- 保留前缀），
  // done 载荷带 bubbles 对账数组。非拆分轮所有字段与原协议完全一致。
  // 分配/记账逻辑见 BubbleTracker（bubble-tracker.ts，含独立单测）。
  const bubbleTracker = new BubbleTracker(false, assistantMessageId);

  // 发言模型（2026-10-09 重复回复根源修复）：一轮 = 一条发言（utteranceId =
  // 本轮 traceId，客户端据此把多泡归组成同一条消息）。气泡是发言的**视图分段**，
  // 分段数量不改变身份。过程话（首个工具开始执行之前的文本）在结算时若与结论
  // 语义等价或纯属无实质内容（记账轮），由装配器裁掉 → 展示侧塌缩为单条发言。
  // 设计说明见 agent/utterance-assembler.ts；不变量 I1-I5 有单测。
  const utterance = new UtteranceAssembler({ utteranceId: batched.originalMessageId });

  // 会出卡片的轮次不流式（2026-10-08 用户定调）：手机端「先流式打纯文本 →
  // done 整条替换成卡片渲染」的跳变根治。本轮一旦确认会携带结构化卡片
  // （工具确定性附卡源 / 识图照片卡 / LLM 自产结构化标记），正文一律扣发；
  // 已流出的文本以 chat.stream_reset 撤回，最终内容统一由 assistant_done
  // 结构化一次性下发（卡片 + renderBlocks + 正文同帧呈现，无二次重排）。
  let turnWillCarryCards = batched.visionFrames?.length
    ? // 识图轮：done 阶段确定性附照片卡（buildVisionPhotoCards），天然是卡片轮
      true
    : false;
  let suppressStreamForCards = false;
  let anyStreamChunkSent = false;
  let streamResetSent = false;
  const retractAndSuppressStream = (): void => {
    if (suppressStreamForCards) return;
    suppressStreamForCards = true;
    if (anyStreamChunkSent && !isStale()) {
      streamResetSent = true;
      ctx.socket.send(
        JSON.stringify({
          type: ServerEventType.ChatStreamReset,
          payload: {
            sessionId: msgActor,
            traceId: batched.originalMessageId,
          },
        }),
      );
    }
  };

  /** 直跑路径工具回执是否产得出结构化卡片（runToolIfNeeded 补判用）。
   *  与 done 阶段 attachDeterministicCards 的建卡条件同口径：媒体类看真实
   *  items，搜索/天气/行程/视频有成功回执即出卡，注册工具看 buildToolCard。 */
  const directPathToolProducesCard = (
    toolName: string,
    result: Record<string, unknown>,
  ): boolean => {
    if (SEARCH_MEDIA_TOOL_NAMES.has(toolName) || toolName === "image.generate") {
      return extractMediaCards(toolName, result).length > 0;
    }
    if (
      toolName === "weather.get_local" ||
      toolName === "search_web" ||
      toolName === "info.search" ||
      toolName === "travel.plan-itinerary" ||
      toolName === "video.grab" ||
      toolName === "video.find"
    ) {
      return true;
    }
    const payload = buildToolCard(toolName, result);
    return !!payload && payload.items.length > 0;
  };

  // [ts:...] 是系统注入的元数据标记，仅供 LLM 上下文使用，绝不能透出到用户可见消息。
  // 2026-09-03 收紧：此前只剥首块，后续块里模型复述的时间戳帧（含残缺帧）会直透前端。
  // 现在每个 chunk 出口都剥"帧"：
  // - stripLeadingTimestampFrames：剥块首的帧（分段器的信息块经常以复述的帧开头）；
  // - 整块恰好是一帧/一串帧（复述的帧独立成块时）→ 整块丢弃；
  // - 首块额外做全量整行清洗（兜底模型把帧复述在正文中间的行）。
  // 剥离容忍残缺帧（[ts 后断行/丢冒号），杜绝"严格正则匹配不上所以漏网"。
  // 流式标记防泄漏 guard（L2 配套，见 stream-marker-guard.ts 文件头）
  const streamMarkerGuard = createStreamMarkerGuard();
  const sendAssistantChunk = (
    chunk: string,
    phase: "interim" | "stream" = "stream",
    meta?: StreamSegmentEmitMeta,
  ): void => {
    if (isStale()) return;
    chunkSeq += 1;
    let cleanedChunk = stripLeadingTimestampFrames(chunk);
    if (chunkSeq === 1) cleanedChunk = stripAllTimestampFrameLines(cleanedChunk);
    if (isOnlyTimestampFrames(cleanedChunk)) cleanedChunk = "";
    // 线程内部帧（2026-10-08）：[上一轮回复中断…] / [不可信内容围栏 …] / [session-recap]
    // 这类写给模型的上下文帧一旦被复读，必须在这里（所有 chunk 的唯一出口）拦死，
    // 否则已推给客户端的气泡无法撤回——手机端事故气泡就是这么漏出去的。
    cleanedChunk = stripInternalFrames(cleanedChunk);
    // 展示形式标记防泄漏（L2 配套）：模型声明的 [RENDER_HINT]/卡片 JSON 块等
    // 只允许随 assistant_done 的 finalText 一次性解析渲染，流式阶段一律扣下，
    // 避免打字机气泡闪现原始标记/JSON。
    cleanedChunk = streamMarkerGuard.feed(cleanedChunk);
    // 会出卡片的轮次不流式：工具附卡源就绪（cardSourceSeen）或模型自产结构化
    // 标记（guard.sawStructuredBlock，含当前块）→ 撤回已流正文并转静默。
    // 注意在 feed 之后判定：当前块内嵌标记时，同块前缀一并扣下（finalText
    // 权威存在，done 统一下发，不丢内容）。
    if (
      !suppressStreamForCards &&
      (turnWillCarryCards || streamMarkerGuard.sawStructuredBlock)
    ) {
      retractAndSuppressStream();
    }
    if (suppressStreamForCards) return;
    if (!cleanedChunk) return;
    // 气泡拆分：new 开新泡（独立 messageId），无 meta 的直推段（确定性收口
    // supplement / 零正文兜底）追加到当前末泡；尚无泡时兜底开第一泡。
    const outbound = bubbleTracker.assign(cleanedChunk, meta);
    // 发言记账：只登记真正出站的文本（角色由工具起点自动划分，见装配器）。
    utterance.noteEmitted(cleanedChunk);
    ctx.socket.send(
      JSON.stringify({
        type: ServerEventType.ChatAssistantChunk,
        payload: {
          sessionId: msgActor,
          messageId: outbound.messageId,
          traceId: batched.originalMessageId,
          chunk: cleanedChunk,
          sequence: chunkSeq,
          phase,
          ...(outbound.bubbleIndex !== undefined
            ? { bubbleIndex: outbound.bubbleIndex }
            : {}),
        },
      }),
    );
    anyStreamChunkSent = true;
  };

  const turnEmitter: TurnEventEmitter = createTurnEventEmitter({
    send: (json) => {
      if (isStale()) return;
      ctx.socket.send(json);
    },
    enabled: getAgentRuntimeConfig().turnPanelV2.enabled,
  });

  // 路由决策 & 分阶段异步开关
  // 2026-08-29：语义 LLM 路由为唯一权威（词法硬规则退出判定链，仅作其失败降级）。
  // 拉最近几条用户消息供 LLM 理解短追问（"娱乐圈的""新鲜的"）继承的话题意图；
  // 拉取失败不阻塞，LLM 路由内部对 provider 异常也有词法降级兜底。
  const cfg = getAgentRuntimeConfig();
  let recentUserTurns: string[] = [];
  let entityContextLines: string[] = [];
  try {
    const chatSessionId =
      batched.sessionId && typeof batched.sessionId === "string" && isNotesChatSessionId(batched.sessionId)
        ? batched.sessionId
        : resolvePrimaryChatSessionId(msgActor, cfg.masterDelegation.enabled);
    const current = batched.text.trim();
    // 取 12 条：buildRoutePrompt 内部只注入最近 4 条给路由 LLM（语境足够），
    // 多取的部分供代码侧指代消解回溯实体（realtime 轮 search_query 的
    // entity 兜底需要更深的对话窗口，4 条内往往只有代词没有实体名）。
    recentUserTurns = getChatThreadStore()
      .thread(chatSessionId, "")
      .filter((m) => m.role === "user" && typeof m.content === "string" && m.content.trim() && m.content.trim() !== current)
      .slice(-12)
      .map((m) => (m.content as string).trim());
    // 代码侧指代消解语料（2026-09-13）：只进 search_query 实体频次统计，
    // 不进任何 prompt。实体名（如「刘浩存」）常只出现在更早的 assistant 消息
    // 与长期记忆档案里——真实线程实证：近 12 条 user 轮全是「她/我老婆」代词，
    // 实体只在 profile（「关注演员刘浩存（称「老婆」）」）与会话回顾里。
    // 线程行剥掉开头连续的 [...] 元数据标签（[ts:...|周日|...] / [session-recap]），
    // 防「周日/assistant」这类标签词以高词频污染实体频次统计（真实测试实证）。
    const threadAnyRole = getChatThreadStore()
      .thread(chatSessionId, "")
      .map((m) => (typeof m.content === "string" ? m.content : "").replace(/^(?:\[[^\]]*\]\s*)+/g, ""))
      .filter((c) => c.trim() && c.trim() !== current)
      .slice(-30);
    // 写时结构化的指代映射（「老婆是刘浩存」形态）：O(1) 精确读取，频次挖掘
    // 之外的首选实体来源（真实测试的「她→刘浩存」消解由此直达）
    const referentLines =
      getMemoryComponents()
        .factStore?.getActiveFacts(msgActor)
        .filter((f) => f.field.startsWith("指代·"))
        .map((f) => `${f.field.replace(/^指代·/, "")}是${f.value}`) ?? [];
    const profileText = getMemoryManagerService()?.getProfileForPrompt(msgActor) ?? "";
    entityContextLines = [
      ...threadAnyRole,
      ...referentLines,
      ...(profileText ? [profileText] : []),
    ];
  } catch {
    recentUserTurns = [];
    entityContextLines = [];
  }
  // 路由决策以 Promise 下传：WS 层不再串行等待路由 LLM 调用（此前在这里
  // await 最多 3s），agent-core 侧与记忆认知（cognize）并行消费。
  // 面板事件 / 实时流式开关等路由衍生配置在 .then 里就绪——首个主回复 delta
  // 必然晚于路由决策（agent-core 的主 LLM 调用依赖平面/工具束），无竞态。
  const decisionPromise = deps.runtime.routeTurnForWs(msgActor, batched.text, recentUserTurns, entityContextLines);
  // turn 面板 v2 阶段 0/1（路由结果就绪后补发，不阻塞主链路）
  void decisionPromise
    .then((decision) => {
      const phasedAsyncEnabled = shouldUsePhasedAsyncConversation(batched.text, {
        enabled: cfg.interimAck.enabled,
      });
      if (cfg.turnPanelV2.enabled && phasedAsyncEnabled) {
        const t0 = Date.now();
        turnEmitter.emitTurnStarted({
          sessionId: msgActor,
          traceId: batched.originalMessageId,
          t0,
        });
        turnEmitter.emitIntentDetected(
          buildIntentDetectedPayload({
            sessionId: msgActor,
            traceId: batched.originalMessageId,
            decision,
          }),
        );
      }
      // 2026-09-28 放流：knowledge_qa 缓冲模式废除。此前该意图整轮缓冲到
      // 生成完 + 出口收口之后才推 chunk，提问类消息几乎必命中——是「纯提问
      // 也要全程黑等」的最大单点（实测 TTFT=总耗时 92%）。出口自检重跑/出口
      // 重写与已流文本的分歧，改由 flushFinal 后的分歧裁决 + done 载荷
      // finalTextReplacesStream 信号（客户端整段替换气泡）承接。
      // AGENT_REALTIME_STREAM=0 可整体回退缓冲模式（应急开关）。
      realtimeStream = process.env.AGENT_REALTIME_STREAM !== "0";
      // 真·分绿泡门禁（2026-09-28）：仅对话面（segmentable=plane chat）拆泡；
      // 语音轮不拆（泡间停顿会拖慢 done，且语音 TTS 不消费气泡边界）；
      // AGENT_BUBBLE_SPLIT=0 可整体关停（回退单泡协议）。
      // 置位点在首个主回复 delta 之前（agent-core 主 LLM 依赖同一决策），无竞态。
      if (
        decision.segmentable &&
        !isVoiceMode(msgActor) &&
        process.env.AGENT_BUBBLE_SPLIT !== "0"
      ) {
        bubbleTracker.active = true;
        streamSegmenter.enableBubbleMode();
      }
    })
    .catch(() => {
      /* 路由决策永不 reject（内部降级）；防御性忽略 */
    });

  // 统一分段器：主回复流式 delta 按"信息块"（同话题连贯短句）切分，像真人
  // 一句一句蹦出来（GPT live 节奏）。垫词、分段、层层递进全部由此模块统一产出：
  // - 垫词 = 主回复的首个分句：仅当确认主回复还有后续内容时才作为 phase="interim"
  //   独立气泡先出现（前端渲染成独立垫词气泡），后续信息块走 phase="stream"
  //   追加到正文气泡；若整段回复只有一句，则整体走 stream 单个气泡。
  // - 信息块分段 + 段落增量去重：能一个气泡放完的合并，话题切换才切块，
  //   每块推送前剔除与已推送句级重复的内容，保证层层递进不重复。
  // - 重量上限 + 首段做结论锚：正文块数封顶（超限并入尾部块），首个信息块承载结论。
  // 全程同源（都来自主回复流式），天然连续、不重复。
  // 语音模式轮次：分段器切零停顿档。文字聊天的 400ms 块间停顿 / 800ms 首句
  // 间隔 / 首句按住是给前端打字机节奏用的；语音端（orb）拿 chunk 直接分句合成
  // TTS，这些人为停顿只会把 assistant_done 和首句 TTS 一起拖慢——语音链路
  // 的"节奏感"由真人语音本身的播放时长天然保证，不需要额外 sleep。
  // 分段器统一零停顿档（2026-09-28）：文字端原「块间 400ms / 首句后 800ms /
  // 首句按住到第二块」三个人为停顿实测把 TTFT 推到总耗时的 84%~92%（用户
  // 全程干等模型生成完才见第一个字），而前端打字机自身已有逐字节奏，服务端
  // 不再叠加 sleep；语音端（orb）拿 chunk 直接分句合成 TTS，节奏感由真人
  // 语音播放时长天然保证。
  // 实时流式开关（2026-09-05）：主回复 delta 即刻喂分段器，前端打字机/语音 TTS
  // 在生成过程中就拿到首个信息块，不再等整段生成完才推 chunk（此前 chunk 全部
  // 滞留到 reply 完成后才一次性推出，是文字链路"回复慢"的最大单点）。
  // 例外（knowledge_qa 缓冲）由上方路由 .then 里按决策改写；默认 true——
  // 首个 delta 只会在路由决策就绪后到达，此时开关必然已被赋值。
  let realtimeStream = true;
  const streamSegmenter = new StreamSegmenter(
    (segment, phase, meta) => sendAssistantChunk(segment, phase, meta),
    {
      // 2026-09-28 去人工节奏：块间 400ms / 首句后 800ms 停顿与首句按住全部
      // 归零（文字与语音同档）。节奏交给前端打字机逐字渲染；服务端分段器只
      // 负责信息块切分与句级去重，不再引入任何 sleep。
      pauseMs: 0,
      minSegmentChars: 6,
      interimReplyGapMs: 0,
      // 2026-08-28 修复"分段回复一次性整段渲染"：原按路由决策
      // （decision.segmentable）关闭工具/搜索/知识问答轮的分段，工具循环的
      // 最终文本只在收尾时经一次 onDelta 整段喂入 → segmentationEnabled=false
      // 时 flushFinal 把全文作为单个 stream chunk 推出，前端一条气泡一次性
      // 渲染全部内容。改为所有轮次统一启用信息块分段：无论闲聊还是工具轮，
      // 回复都按信息块逐条推送（块间 400ms 停顿），前端一条一条渲染。
      segmentationEnabled: true,
      // 信息块目标字符数（同话题短句累积到该长度切块）；正文块数上限从 8 提到 24：
      // 8 块 × 56 字 ≈ 450 字，普通长回复就会触顶，超限内容并入 tailBuffer 后在
      // flushFinal 一次性输出——长回复尾部"同时渲染"的根因。24 块 ≈ 1300 字，
      // 覆盖真实回复体量，尾部合并只对病态超长输出生效（保留为防刷屏极端阀）。
      blockCharTarget: 56,
      maxStreamSegments: 24,
      // 首句随到随发（2026-09-28 文字端同样关闭按住）：首句不再等第二块裁决，
      // 第一个完整句边界即推送——TTFT 从「第二块边界/flushFinal」提前到首个完整句。
      holdFirstSentence: false,
    },
  );

  // 工具执行心跳：长工具（如 shopping.order.place 180s）执行期间定期发 chat.agent_status，
  // 重置客户端 3 分钟 watchdog，防止用户感知"等待回复超时"。
  const TOOL_HEARTBEAT_INTERVAL_MS = 30_000;
  // 心跳总时长封顶（自本轮 turnStartedAt 起算），env TOOL_HEARTBEAT_MAX_MS 可调。
  // 默认 5 分钟：超时后客户端 watchdog（3 分钟）可在 8 分钟内正常触发；
  // 本层硬超时（CHAT_TURN_TIMEOUT_MS 默认 540s）作为最终兜底。
  const TOOL_HEARTBEAT_MAX_MS = (() => {
    const n = Number.parseInt(process.env.TOOL_HEARTBEAT_MAX_MS ?? "", 10);
    return Number.isFinite(n) && n > 0 ? n : 300_000;
  })();
  const toolHeartbeatTimers = new Map<string, NodeJS.Timeout>();
  let heartbeatLineCache: string | null = null;
  // 进度条：每个心跳累计 15%，封顶 90%（留 10% 给最终收尾），支持客户端渲染进度条
  const heartbeatPercent = new Map<string, number>();
  // 防 status line 抖动：tool loop 阶段 LLM 的每个流式 delta 都会把整段 fullText
  // 推过来，formatStatusForDisplay 经常把它剪成同一句"正在查阅历史记忆…" / "正在从网络检索相关信息…"
  // → 不去重的话单轮能连发几百次完全相同的事件，挤占通道并延长 LLM 等待窗口。
  // 这里按"格式化后的展示文案"去重：文案变了才发，文案不变直接吞掉。
  let lastStatusDisplayLine: string | null = null;
  let statusLineRepeats = 0;

  function startToolHeartbeat(toolName: string): void {
    // 已有同工具的心跳则跳过（并行工具调用时可能重名，用 timer 存在性判重）
    if (toolHeartbeatTimers.has(toolName)) return;
    const timer = setInterval(() => {
      if (isStale()) {
        stopToolHeartbeat(toolName);
        return;
      }
      // 心跳总时长封顶：心跳每 30s 重置客户端 3 分钟 watchdog，会把挂死轮次
      // 掩盖成永远"正在调用工具"。超过封顶后停止心跳，让客户端 watchdog 正常
      // 超时（合法长任务如 shopping.order.place 180s 远小于该值，不受影响）。
      if (Date.now() - turnStartedAt > TOOL_HEARTBEAT_MAX_MS) {
        console.warn(
          `[WS] tool heartbeat capped at ${TOOL_HEARTBEAT_MAX_MS}ms (tool=${toolName})，停止重置客户端 watchdog`,
        );
        stopToolHeartbeat(toolName);
        return;
      }
      // 进度条：每次心跳 +15%，封顶 90%（最终收尾时 agent-core 会再推 100%）
      const prev = heartbeatPercent.get(toolName) ?? 0;
      const next = Math.min(90, prev + 15);
      heartbeatPercent.set(toolName, next);
      // 发一条轻量 chat.agent_status 心跳，重置客户端 watchdog + 推进度
      const heartbeatLine = heartbeatLineCache ?? `正在执行 ${toolName}…`;
      ctx.socket.send(
        JSON.stringify({
          type: ServerEventType.ChatAgentStatus,
          payload: {
            sessionId: msgActor,
            messageId: assistantMessageId,
            traceId: batched.originalMessageId,
            phase: "live",
            line: heartbeatLine,
            percent: next,
          },
        }),
      );
    }, TOOL_HEARTBEAT_INTERVAL_MS);
    // 允许事件循环在无其他任务时退出
    timer.unref();
    toolHeartbeatTimers.set(toolName, timer);
  }

  function stopToolHeartbeat(toolName: string): void {
    const timer = toolHeartbeatTimers.get(toolName);
    if (timer) {
      clearInterval(timer);
      toolHeartbeatTimers.delete(toolName);
    }
    heartbeatPercent.delete(toolName);
  }

  function clearAllToolHeartbeats(): void {
    for (const timer of toolHeartbeatTimers.values()) {
      clearInterval(timer);
    }
    toolHeartbeatTimers.clear();
  }

  // 获取全局 turn 并发许可（防止高并发时事件循环饱和 + LLM API 限流耗尽）
  const turnStartedAt = Date.now();
  let releaseTurn: (() => void) | null = null;
  try {
    releaseTurn = await globalTurnLimiter.acquire(TURN_QUEUE_TIMEOUT);
  } catch {
    // 排队超时 → 返回 429 风格提示，避免客户端无限等待
    ctx.socket.send(
      JSON.stringify({
        type: ServerEventType.ChatAssistantDone,
        payload: {
          sessionId: msgActor,
          messageId: assistantMessageId,
          traceId: batched.originalMessageId,
          finalText: FALLBACK_TEXT_BUSY(),
          toolCalls: [],
        },
      }),
    );
    if (!isStale()) messageBatchProcessor.markReplyStarted(msgActor);
    return;
  }

  let turnSucceeded = false;
  let turnError: string | undefined;

  // 旅游规划进度流式（B2）：规划引擎各阶段经 travel-progress-bus 发布，这里按 sessionId
  // 订阅并转成 chat.agent_status 下发（phase=live，与工具心跳同一通道，前端无需新协议）。
  const unsubscribeTravelProgress = subscribeTravelProgress((event) => {
    if (event.sessionId !== msgActor || isStale()) return;
    ctx.socket.send(
      JSON.stringify({
        type: ServerEventType.ChatAgentStatus,
        payload: {
          sessionId: msgActor,
          messageId: assistantMessageId,
          traceId: batched.originalMessageId,
          phase: "live",
          line: event.message,
          toolName: "travel.plan-itinerary",
        },
      }),
    );
  });

  // 收集本轮实际执行的媒体搜索工具结果（search_images / search_videos）。
  // 原因：LLM 的最终回复 reply.toolName 时常为 undefined（模型在搜完图后仅输出
  // 正文，不再带工具声明），导致 extractMediaCards 拿不到 items，前端照片无法展示。
  // 这里绕开 reply.toolName，直接从 onExternalToolExecuted 捕获真实工具结果，
  // 保证 chat.assistant_done 的 mediaCards 一定有真实缩略图。
  const executedMediaToolResults: Array<{
    toolName: string;
    result: Record<string, unknown>;
  }> = [];
  // 搜索类工具（tool-loop 路径）的真实结果聚合：search_web/info.search 的
  // search_result 卡由此确定性附卡（L1），不依赖 LLM 抄写列表（与媒体/行程同理）
  const executedSearchToolResults: Array<{
    toolName: string;
    result: Record<string, unknown>;
  }> = [];
  // 天气工具（tool-loop 路径）的真实结果聚合：weather.get_local 不强制路由，
  // LLM 末轮只输出正文不带工具声明 → 单工具直跑路径拿不到回执、天气卡恒为
  // 纯文本。这里与搜索/媒体同理从回调捕获，done 阶段确定性附 weather 卡。
  const executedWeatherToolResults: Array<{
    toolName: string;
    result: Record<string, unknown>;
  }> = [];
  // 其余注册工具（wallet/calendar/shopping…）的真实结果聚合：注册表 builder
  // 同样只在单工具直跑路径（reply.toolName 有值）被消费，tool-loop 轮次全部
  // 漏卡。按执行顺序捕获，done 阶段取第一张建成功的卡；搜索/天气有专属
  // 合并附卡路径，捕获时排除防重复。
  const executedRegistryToolResults: Array<ExecutedToolReceipt> = [];
  // 视频抓取（video.grab）的真实结果聚合：媒体标记此前只接 reply.toolName
  // 直跑路径，loop 轮次解析到可播放视频也不会带 [RENDER_AS:video] 标记。
  const executedVideoToolResults: Array<ExecutedToolReceipt> = [];
  // 行程规划工具（tool-loop 路径）：LLM 末轮通常只输出正文不带工具声明，
  // reply.toolName/toolResult 均为空 → attachTravelItineraryCard 拿不到原始
  // 结果、行程卡永远附不上（右侧面板不自动展开）。这里从 onExternalToolExecuted
  // 捕获真实结果作为附卡数据源。
  let executedTravelPlanResult: Record<string, unknown> | undefined;
  // 本轮是否尝试过规划工具（成功与否都算）：失败时 executedTravelPlanResult 保持
  // undefined，但没有这个标记，done 阶段的手写行程兜底会对失败轮再补跑一次，
  // 用户承受双重 10~30s 等待。
  let executedTravelPlanAttempted = false;
  // 「边说边出图」已推送过的媒体地址集合：跨工具批去重，避免同一张图被推两次
  const sentEarlyMediaKeys = new Set<string>();
  // 「边说边出图」按组预算（2026-10-10）：与 done 阶段 trimMediaCardsByTopic 的
  // maxPerGroup=4 同规则、同分组键（groupTitle）跨批累计——保证最终 mediaCards
  // 恒为已早推内容的前缀（只增不换），根治「流式中一组照片、落定换成另一组」。
  const EARLY_MEDIA_MAX_PER_GROUP = 4;
  const earlyMediaGroupCounts = new Map<string, number>();
  // 方案1：不再把流式 delta 逐段喂入分段器（多段流/工具边界会打断 heldFirst 导致
  // 多个垫词、顺序错乱、语义重复）。仅累积原始流式文本作兜底，最终只把"最终文本"一次性
  // 喂入分段器，保证：垫词恰好一个、信息块按最终文本顺序、层层递进不重复。
  let streamedText = "";

  try {
    // 硬超时兜底：挂死时 abort 本轮 controller（中断 LLM 流式请求）并抛错，
    // 让 catch/finally 路径释放 turn 槽位与全部定时器（见 withTurnHardTimeout 注释）。
    const chatTurnTimeoutMs = resolveChatTurnTimeoutMs();
    const reply = await withTurnHardTimeout(
      deps.runtime.handleUserMessage(msgActor, batched.text, {
      chatUserMessageId: batched.originalMessageId,
      userId: batched.userId,
      agentAccessMode: parseAgentAccessMode(batched.agentAccessMode),
      clientIp: batched.clientIp,
      clientLocation: batched.clientLocation,
      deviceClass: batched.deviceClass,
      ...(batched.visionFrames?.length ? { visionFrames: batched.visionFrames } : {}),
      interruptedContext: batched.interruptedContext,
      sessionId: typeof batched.sessionId === "string" ? batched.sessionId : undefined,
      signal: turnAbortController.signal,
      routeDecision: decisionPromise,
      // 任务面异步收尾（2026-09-08）：plane=task 派发后台任务后本轮立即结束，
      // 对话窗回到空闲态；结果由后台完成后以 source=task_plane 独立消息回灌。
      taskPlaneAsync: true,
      // 中途推卡：工具执行中把二维码等媒体即时挂到当前流式回复（chat.media_ready，
      // 复用「边说边出图」客户端渲染路径）；购物登录/支付扫码等待期间用户可实时看到。
      pushMediaCards: (cards) => {
        if (isStale()) return;
        try {
          ctx.socket.send(
            JSON.stringify({
              type: "chat.media_ready",
              payload: {
                sessionId: msgActor,
                messageId: assistantMessageId,
                traceId: batched.originalMessageId,
                cards,
              },
            }),
          );
        } catch {
          /* 中途推卡失败不阻塞工具执行 */
        }
      },
      onAssistantDelta: (delta) => {
        // 实时流式：delta 即刻喂分段器（增量去重由分段器内部保证）；
        // 同时累积原始流式文本，供最终残差计算与兜底。knowledge_qa 缓冲模式
        // 下只累积、不喂（出口自检重跑后一次性喂最终文本，避免气泡重复）。
        if (isStale()) return;
        streamedText += delta;
        if (realtimeStream && delta) {
          streamSegmenter.feed(delta);
        }
      },
      onExternalToolExecuteStart: (info) => {
        if (isStale()) return;
        // 发言模型：首个工具开始执行 = 过程话阶段截止，此后产出均为结论。
        // 先等分段器把已喂入的过程话发完（分发是异步串行的，不设屏障会与仍在
        // 链上的过程话乱序 → 过程话被误判为结论、塌缩裁决失效）。
        void streamSegmenter
          .awaitPending()
          .then(() => utterance.noteToolStart(info.toolName))
          .catch(() => utterance.noteToolStart(info.toolName));
        // 方案1：不再需要 markToolBoundary——分段器只在最终文本一次性喂入时才裁决，
        // 工具边界不会再产生垫词碎片。
        wireToolExecuteStart(
          {
            sessionId: msgActor,
            traceId: batched.originalMessageId,
            assistantMessageId,
            send: (json) => ctx.socket.send(json),
          },
          info,
        );
        // 启动工具执行心跳：每 30s 发一次 chat.agent_status，
        // 防止单个长工具（如 shopping.order.place 180s）执行期间客户端 watchdog 超时。
        startToolHeartbeat(info.toolName);
      },
      onExternalToolExecuted: (info) => {
        if (isStale()) return;
        // 发言模型：登记工具名（直跑路径可能只有完成回调、没有 start 回调）
        utterance.noteToolExecuted(info.toolName);
        wireToolExecuted(
          {
            sessionId: msgActor,
            traceId: batched.originalMessageId,
            assistantMessageId,
            send: (json) => ctx.socket.send(json),
          },
          info,
        );
        // 清除工具执行心跳
        stopToolHeartbeat(info.toolName);
        // 确认轮标记（与 agent-core CALENDAR_CONFIRM_TOOLS 同源）：分泡轮
        // 说话算话裁决的确认轮例外——确认轮保留出口收口塌缩。
        if (info.ok && CALENDAR_CONFIRM_TOOLS.has(info.toolName)) {
          bubbleTracker.confirmationAnchored = true;
        }
        // 捕获搜索类工具的真实结果，供 done 阶段确定性附 search_result 卡（L1）
        if (
          info.ok &&
          info.result &&
          (info.toolName === "search_web" || info.toolName === "info.search")
        ) {
          executedSearchToolResults.push({
            toolName: info.toolName,
            result: info.result as Record<string, unknown>,
          });
          // 搜索回执 → done 阶段确定性附 search_result 卡（或让位给照片卡）：
          // 结构化产出轮，按「会出卡片的轮次不流式」扣流
          turnWillCarryCards = true;
        }
        // 捕获天气工具的真实结果，供 done 阶段确定性附 weather 卡（L1，与搜索同理）
        if (info.ok && info.result && info.toolName === "weather.get_local") {
          executedWeatherToolResults.push({
            toolName: info.toolName,
            result: info.result as Record<string, unknown>,
          });
          turnWillCarryCards = true;
        }
        // 捕获其余注册工具（wallet/calendar/shopping…）的真实结果（L1，同上）
        if (
          info.ok &&
          info.result &&
          lookupToolCardBuilder(info.toolName) &&
          info.toolName !== "search_web" &&
          info.toolName !== "info.search" &&
          info.toolName !== "weather.get_local"
        ) {
          executedRegistryToolResults.push({
            toolName: info.toolName,
            result: info.result as Record<string, unknown>,
          });
          // 精确判定：注册工具卡实际建得出（items 非空）才算卡片轮，
          // 避免注册工具执行成功但无卡时白白牺牲流式打字机
          const cardPayload = buildToolCard(info.toolName, info.result as Record<string, unknown>);
          if (cardPayload && cardPayload.items.length > 0) turnWillCarryCards = true;
        }
        // 捕获视频工具的真实结果，供 done 阶段附加 [RENDER_AS:video] 媒体标记
        // （video.grab=贴链接解析 / video.find=按内容找视频直接出可播流）
        if (
          info.ok &&
          info.result &&
          (info.toolName === "video.grab" || info.toolName === "video.find")
        ) {
          executedVideoToolResults.push({
            toolName: info.toolName,
            result: info.result as Record<string, unknown>,
          });
          // 视频回执 → done 阶段附 [RENDER_AS:video] 可播媒体标记：卡片轮
          turnWillCarryCards = true;
        }
        // 捕获媒体搜索工具的真实结果，供 done 阶段构建 mediaCards（见上方说明）
        if (info.toolName === "travel.plan-itinerary") {
          // 尝试标记（成功与否都算）：手写行程兜底对已尝试轮不再补跑
          executedTravelPlanAttempted = true;
          if (info.ok && info.result) {
            executedTravelPlanResult = info.result as Record<string, unknown>;
            // 行程回执 → done 阶段确定性附行程卡：卡片轮
            turnWillCarryCards = true;
          }
        }
        // 捕获媒体搜索/图像生成工具的真实结果，供 done 阶段构建 mediaCards。
        // image.generate 与搜索同链路：执行完即早推卡片（边说边出图），
        // done 时聚合成结构化卡 + renderBlocks，生成图不再依赖 LLM 转述 URL。
        if (
          info.ok &&
          info.result &&
          (info.toolName === "search_images" ||
            info.toolName === "search_images_batch" ||
            info.toolName === "search_videos" ||
            info.toolName === "image.generate")
        ) {
          executedMediaToolResults.push({
            toolName: info.toolName,
            result: info.result as Record<string, unknown>,
          });
          // 媒体回执 → done 阶段聚合 mediaCards/renderBlocks：卡片轮
          if (extractMediaCards(info.toolName, info.result as Record<string, unknown>).length > 0) {
            turnWillCarryCards = true;
          }
          // 边说边出图：媒体工具一执行完，先把该批照片结构化推给前端，
          // 前端插到当前流式正文下方实时展示；done 时再按 renderBlocks 校正顺序。
          try {
            const earlyCards = dedupMediaCards(
              extractMediaCards(
                info.toolName,
                info.result as Record<string, unknown>,
              ),
            ).filter((c) => {
              const key = (c.thumbnailUrl || c.mediaUrl || "").trim();
              if (!key || sentEarlyMediaKeys.has(key)) return false;
              // 按组预算：与 done 阶段裁剪同规则，同组超预算的不再早推
              //（也不占用 sentEarlyMediaKeys，留给 done 阶段聚合裁决）
              const group = (c.groupTitle ?? "").trim();
              const used = earlyMediaGroupCounts.get(group) ?? 0;
              if (used >= EARLY_MEDIA_MAX_PER_GROUP) return false;
              earlyMediaGroupCounts.set(group, used + 1);
              sentEarlyMediaKeys.add(key);
              return true;
            });
            if (earlyCards.length > 0) {
              ctx.socket.send(
                JSON.stringify({
                  type: ServerEventType.ChatMediaReady,
                  payload: {
                    sessionId: msgActor,
                    messageId: assistantMessageId,
                    traceId: batched.originalMessageId,
                    cards: earlyCards,
                  },
                }),
              );
            }
          } catch {
            /* 边说边出图为可选增强，失败静默不阻塞主流程 */
          }
        }
      },
      onBackgroundAssistantDelta: (info) => {
        if (isStale()) return;
        chunkSeq += 1;
        ctx.socket.send(
          JSON.stringify({
            type: ServerEventType.ChatAssistantChunk,
            payload: {
              sessionId: msgActor,
              messageId: info.messageId,
              traceId: batched.originalMessageId,
              chunk: info.delta,
              sequence: chunkSeq,
              phase: "stream",
              source: info.source,
            },
          }),
        );
      },
      onBackgroundAssistantDone: (info) => {
        if (isStale()) return;
        ctx.socket.send(
          JSON.stringify({
            type: ServerEventType.ChatAssistantDone,
            payload: {
              sessionId: msgActor,
              messageId: info.messageId,
              traceId: batched.originalMessageId,
              finalText: info.finalText,
              toolCalls: [],
              source: info.source,
            },
          }),
        );
      },
      onAgentPhaseStatus: (line) => {
        if (isStale()) return;
        const displayLine = formatStatusForDisplay(line);
        if (!displayLine) return;
        // 去重：同一句展示文案不重复推送（tool loop 每个 delta 都会调一次）
        if (displayLine === lastStatusDisplayLine) {
          statusLineRepeats += 1;
          // 重复超过 20 次（约略估算同一 LLM 轮次上限）就彻底吞掉，避免：
          //   1) WS 通道被同一文案挤爆
          //   2) 客户端 watchdog 始终不超时（chat.agent_status 本身在重置 watchdog），
          //      而真正的 chat.assistant_done 因为 LLM 卡在同一句 status 而发不出
          //   3) 用户在前端看到 LLM 永远在"正在查阅历史记忆…"，超 90s 后被前端兜底成"没听清"
          if (statusLineRepeats > 20) return;
          // 20 次以内仍保留心跳语义（重置 watchdog），但不再 emit event
        } else {
          lastStatusDisplayLine = displayLine;
          statusLineRepeats = 0;
        }
        // 更新心跳文案缓存，让后续心跳更有上下文感
        heartbeatLineCache = displayLine;
        embodimentThinking(msgActor, (json) => ctx.socket.send(json), displayLine, {
          phase: "live",
          source: "agent_status",
        });
        ctx.socket.send(
          JSON.stringify({
            type: ServerEventType.ChatAgentStatus,
            payload: {
              sessionId: msgActor,
              messageId: assistantMessageId,
              traceId: batched.originalMessageId,
              phase: "live",
              line: displayLine,
            },
          }),
        );
        // v2：plan_execute 的阶段进度（"正在分析任务…"等）也按 log 下发
        turnEmitter.emitExecutionEvent(
          buildExecutionEventPayload({
            sessionId: msgActor,
            traceId: batched.originalMessageId,
            eventId: `phase-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            kind: "log",
            log: displayLine,
          }),
        );
      },
      onPlanReady: (plan) => {
        if (isStale()) return;
        // v2：plan_execute 计划生成后，对每个 step 发 plan_step(status=pending)
        for (const step of plan.steps) {
          turnEmitter.emitExecutionEvent(
            buildExecutionEventPayload({
              sessionId: msgActor,
              traceId: batched.originalMessageId,
              eventId: `plan-${step.id}-${Date.now()}`,
              kind: "plan_step",
              planStep: {
                id: step.id,
                title: step.intent,
                status: "pending",
              },
            }),
          );
        }
        // 执行开始后，把所有 step 标记为 running（当前架构是一次性执行，非逐步）
        // 若未来拆成逐步执行，应在每步开始/完成时单独发 running/ok
        // 这里先发一条 running 表示整体进入执行
        if (plan.steps.length > 0) {
          turnEmitter.emitExecutionEvent(
            buildExecutionEventPayload({
              sessionId: msgActor,
              traceId: batched.originalMessageId,
              eventId: `plan-running-${Date.now()}`,
              kind: "plan_step",
              planStep: {
                id: plan.steps[0].id,
                title: plan.steps[0].intent,
                status: "running",
              },
            }),
          );
        }
      },
    }),
      chatTurnTimeoutMs,
      () => {
        console.error(
          `[WS] chat turn hard timeout (${chatTurnTimeoutMs}ms), actor=${msgActor}，abort 本轮并释放并发槽位`,
        );
        try {
          turnAbortController.abort();
        } catch {
          /* ignore */
        }
      },
    );

    if (isStale()) return;

    // 主回复流结束后的分段器收尾（2026-09-05 实时流式版）：
    // - 实时流式轮次：流式内容已随生成过程推出，这里只喂"最终答复里有、
    //   流式里没说过"的残差（工具拼接/后处理清洗产生的差异），已发内容靠
    //   分段器内部句级去重双保险，不重复推送。
    // - 缓冲模式轮次（knowledge_qa）：沿用方案1——最终文本一次性喂入，
    //   优先 reply.text，为空时用流式累积兜底。
    // - 入料前统一清一遍时间戳帧（streamedText 分支是原始流式累积、从未清洗过；
    //   复述的帧不在这里剥掉，就会成为独立信息块推给前端）。
    const finalFeedRaw = (reply.text && reply.text.trim()) ? reply.text : streamedText;
    const finalFeed = stripAllTimestampFrameLines(finalFeedRaw);
    // 分歧裁决（2026-09-28 放流配套）：knowledge_qa 缓冲废除后，出口自检重跑/
    // 出口重写会让最终文本与已流文本分叉。残差小（收口清洗产生的差异）→ 照旧
    // 补推残差增量；残差大（≥40%，重写/重跑换了说法）→ 不再补推（避免新旧两版
    // 拼接），改在 done 载荷打 finalTextReplacesStream 信号，客户端整段替换气泡。
    let finalTextReplacesStream = false;
    if (finalFeed && finalFeed.trim()) {
      if (realtimeStream && streamedText.trim()) {
        const streamedClean = stripAllTimestampFrameLines(streamedText);
        const residual = stripSentencesAlreadySaid(streamedClean, finalFeed).trim();
        if (residual) {
          // 分歧裁决（2026-09-28 说话算话根修）：分泡轮走 BubbleTracker 策略
          // （残差 ≥40% 且非确认轮 → 弃重写文本、不再触发客户端塌缩）；
          // 非分泡轮（语音/任务面）保持原语义（≥40% → finalTextReplacesStream）。
          // belt-and-braces：确认工具若漏走 onExternalToolExecuted，用末次
          // toolName 兜底补标。
          if (reply.toolName && CALENDAR_CONFIRM_TOOLS.has(reply.toolName)) {
            bubbleTracker.confirmationAnchored = true;
          }
          const verdict = bubbleTracker.hasBubbles
            ? bubbleTracker.resolveDivergence(residual.length, finalFeed.trim().length)
            : residual.length >= finalFeed.trim().length * 0.4
              ? "replace"
              : "feed";
          if (verdict === "replace") {
            finalTextReplacesStream = true;
          } else if (verdict === "feed") {
            streamSegmenter.feed(residual);
          } else {
            // 说话算话：已流式分泡即最终回复——真人不会把说出去的话吞回来
            // 重说。重写版本对展示侧废弃（done.finalText 仍携带重写版供
            // 记忆/语音链路），客户端永不塌缩，杜绝"泡说出来又被吞"的混乱。
            console.log(
              `[bubble-split] 弃出口分歧重写文本（${residual.length}/${finalFeed.trim().length}ch，trace=${batched.originalMessageId}）`,
            );
          }
        }
      } else {
        streamSegmenter.feed(finalFeed);
      }
    }

    // 主回复流结束：把分段器缓冲中剩余的半截文本作为最后一段推送
    // （guard 中被误扣的非标记残段先放行；标记/卡片块内容 flush 时已丢弃）
    const guardResidual = streamMarkerGuard.flush();
    if (guardResidual) streamSegmenter.feed(guardResidual);
    await streamSegmenter.flushFinal();

    // 发言结算（2026-10-09 重复回复根源修复）：本轮唯一发言在此定稿。
    // - 过程话与结论语义等价、或过程话在记账轮无实质内容 → 裁掉过程话，复用既有
    //   「整轮塌缩」通道（finalTextReplacesStream + bubbles 清单）让客户端删除
    //   过程话气泡、只落一条发言 —— 事故形态「好的王爷，记下了。」+「已经记上啦」
    //   从此只剩后者。
    // - 检索轮两段都保留：它们仍是同一条发言的两个分段，客户端按 utteranceId
    //   归组渲染（头像/名字只出现一次），"先应一句、停顿、再细说"的节奏不受损。
    const utteranceSettlement: UtteranceSettlement = utterance.settle(finalFeed);
    let utteranceCollapse = false;
    if (utteranceSettlement.collapse) {
      utteranceCollapse = true;
      finalTextReplacesStream = true;
      console.log(
        `[utterance] 过程话被结论吸收（reason=${utteranceSettlement.collapseReason}，` +
          `trace=${batched.originalMessageId}，drop=[${utteranceSettlement.droppedSegmentIndexes.join(",")}]）`,
      );
    }

    if (isStale()) return;

    let toolResult: { ok: boolean; result?: Record<string, unknown> } | undefined;
    if (reply.toolName && reply.toolInput) {
      if (isStale()) return;
      ctx.socket.send(
        JSON.stringify({
          type: ServerEventType.ToolCall,
          payload: {
            toolName: reply.toolName,
            input: reply.toolInput,
            traceId: batched.originalMessageId,
          },
        }),
      );
      const startedAt = Date.now();
      toolResult = reply.toolResult
        ? { ok: true, result: reply.toolResult }
        : await deps.runtime.runToolIfNeeded(msgActor, reply, {
            chatUserMessageId: batched.originalMessageId,
            userId: batched.userId,
            agentAccessMode: parseAgentAccessMode(batched.agentAccessMode),
            clientIp: batched.clientIp,
            clientLocation: batched.clientLocation,
          });
      if (isStale()) return;
      ctx.socket.send(
        JSON.stringify({
          type: ServerEventType.ToolResult,
          payload: {
            toolName: reply.toolName,
            ok: toolResult.ok,
            result: toolResult.result ?? {},
            traceId: batched.originalMessageId,
            durationMs: Date.now() - startedAt,
          },
        }),
      );
      // 直跑路径卡片源补判：runToolIfNeeded 不走 onExternalToolExecuted，
      // 上面的工具捕获点看不到这类回执。直跑工具在主回复流之后执行——
      // 产出可建卡即扣流（已流文本由 retract 内部撤回），done 统一结构化下发。
      if (
        !suppressStreamForCards &&
        toolResult.ok &&
        toolResult.result &&
        directPathToolProducesCard(reply.toolName, toolResult.result as Record<string, unknown>)
      ) {
        retractAndSuppressStream();
      }
    }

    const scheduleOutcome =
      reply.toolName && toolResult?.result
        ? formatScheduleToolResultForUser(reply.toolName, toolResult.result)
        : null;

    let finalText =
      scheduleOutcome?.trim() ||
      reply.text.trim() ||
      (chunkSeq > 0 ? "" : "");
    // 确定性收口（日程/提醒格式化结果）与流式原文整体不同 → 同样走整段替换信号
    if (scheduleOutcome?.trim()) finalTextReplacesStream = true;

    // 错字归一化：模型偶发用单个「—」冒充量词「一」（deepseek 破折号习惯），
    // 发送前修掉（不动合法的「——」）。
    finalText = normalizeDashTypos(finalText);

    // 工具成功但 LLM 末轮没出正文时，用工具结果文本作为回复（不再用合成的"已查到见上面"）。
    // 真实数据比提示语更有价值——用户能看到工具到底返回了什么。
    if (
      !finalText &&
      reply.toolName &&
      toolResult?.ok &&
      toolResult.result &&
      !chunkSeq
    ) {
      const toolResultText = formatToolResultAsReply(reply.toolName, toolResult.result);
      if (toolResultText) finalText = toolResultText;
    }

    const processor = getToolResultProcessor();
    finalText = processor.processAssistantText(finalText, {
      userText: batched.text,
      toolName: reply.toolName,
      // 注册工具（weather/wallet/calendar…）的结构化回执直出卡：不依赖 LLM
      // 把结果抄写成 markdown 列表（tool-card-registry，B 阶段）
      toolResult:
        toolResult?.ok && toolResult.result
          ? (toolResult.result as Record<string, unknown>)
          : undefined,
    });
    // 旅游行程确定性附卡：工具返回已瘦身，LLM 口头回复不再携带明细、也写不出
    // 能被切卡的逐日列表，卡片由代码直接从行程原始数据生成（autoOpen=false，
    // 行程以回复末尾的独立规划卡呈现：卡面直接逐日展示安排，不自动弹出双面板，
    // 用户点卡片按钮可进面板看完整明细；卡片保留在消息中供回看）。
    // 回执裁决统一走 resolveTravelReceipt：直跑回执 / onToolExecuted 捕获 /
    // 冷层近窗回捞三路归一——此前 reply.toolName 是其他工具（如
    // travel.destination-info）会短路掉冷层回捞，行程卡整轮漏发；
    // planId 补全量数据由 attachTravelItineraryCard 内部完成。
    let travelReceiptResolution = resolveTravelReceipt({
      replyToolName: reply.toolName,
      replyToolResult:
        toolResult?.ok && toolResult.result
          ? (toolResult.result as Record<string, unknown>)
          : undefined,
      executedReceipt: executedTravelPlanResult,
      goal: batched.text,
      finalText,
    });
    // 手写行程确定性兜底（2026-10-08）：模型把完整行程手写成 markdown 却没调
    // travel.plan-itinerary → 行程卡整轮缺席（travel-plans 落盘自 9/28 零新增的
    // 实证，手机/桌面行程卡点击界面形同虚设）。双闸检测（领域词 × 行程表结构）
    // 命中且本轮没尝试过规划工具时，代码强制补跑一次规划，回执走下方
    // attachDeterministicCards 原链路附卡；规划阶段进度经 travel-progress-bus
    // 照常下发，用户端可见「正在规划行程」。
    // intent 闸（2026-10-10 词表判定退役）：结构检测器会被「回复里引用旧方案」
    // 的轮次误命中（「你叫我什么？」答句回扣方案A/B/C 被强制补跑规划）——
    // 模型判定本轮非旅行话题（travel_query=false）时不再补跑。understanding
    // 缺省（路由失败）保持旧行为：双闸检测自身误报率低，不因路由抖动丢卡。
    const routeUnderstanding = await decisionPromise
      .then((d) => d.understanding)
      .catch(() => undefined);
    if (
      !executedTravelPlanAttempted &&
      !travelReceiptResolution.toolName &&
      routeUnderstanding?.travelQuery !== false &&
      looksLikeHandwrittenItinerary(finalText)
    ) {
      const forcedInput = batched.text.trim() || "规划行程";
      const forcedDays = sniffItineraryDays([batched.text, finalText]);
      const forcedToolInput = {
        input: forcedInput,
        ...(forcedDays ? { days: forcedDays } : {}),
      };
      if (isStale()) return;
      const forcedStartedAt = Date.now();
      ctx.socket.send(
        JSON.stringify({
          type: ServerEventType.ToolCall,
          payload: {
            toolName: "travel.plan-itinerary",
            input: forcedToolInput,
            traceId: batched.originalMessageId,
          },
        }),
      );
      const forcedPlan = await deps.runtime.runToolIfNeeded(
        msgActor,
        { text: "", toolName: "travel.plan-itinerary", toolInput: forcedToolInput },
        {
          chatUserMessageId: batched.originalMessageId,
          userId: batched.userId,
          agentAccessMode: parseAgentAccessMode(batched.agentAccessMode),
          clientIp: batched.clientIp,
          clientLocation: batched.clientLocation,
        },
      );
      if (isStale()) return;
      ctx.socket.send(
        JSON.stringify({
          type: ServerEventType.ToolResult,
          payload: {
            toolName: "travel.plan-itinerary",
            ok: forcedPlan.ok,
            result: forcedPlan.result ?? {},
            traceId: batched.originalMessageId,
            durationMs: Date.now() - forcedStartedAt,
          },
        }),
      );
      if (forcedPlan.ok && forcedPlan.result) {
        travelReceiptResolution = {
          toolName: "travel.plan-itinerary",
          result: forcedPlan.result as Record<string, unknown>,
        };
        // 正文已在流式阶段以纯文本送达（没有卡片形态），补卡后 finalText ≠ 已流
        // 文本，必须整段替换让两端重渲染出卡片（桌面端 done 默认保留已流正文）。
        finalTextReplacesStream = true;
      }
    }
    // 「接下来你可以」接续建议（NEXT_UP 协议）：从正文提取成独立 followups
    // 字段并从文本剥离——done 载荷与落库文本都不再含标记块（时机性内容不落
    // 历史；流式阶段已由 stream-marker-guard 扣下，用户全程看不到原始标记）。
    // 顺序铁律（2026-09-24 大理轮任务面复现）：必须先剥 NEXT_UP 再附确定性
    // 卡片——模型把建议块写在回复末尾，行程卡附在它后面，若先附卡后剥离，
    // extractNextUpSuggestions 从 [NEXT_UP_START] 起整段截断会把尾部行程卡
    // 一并吃掉。
    const nextUp = extractNextUpSuggestions(finalText);
    finalText = nextUp.text;
    const followups = nextUp.followups;
    // done 阶段确定性附卡链（L1）：行程 → 天气 → 搜索 → 其余注册工具 → 视频，
    // 顺序与优先级见 deterministic-card-chain.ts；各 attach 自带结构化标记
    // guard，先附上的卡生效、后续自动让位。视频回执 loop 捕获优先、直跑兜底。
    const videoReceipts: Array<ExecutedToolReceipt> =
      executedVideoToolResults.length > 0
        ? executedVideoToolResults
        : (reply.toolName === "video.grab" || reply.toolName === "video.find") && toolResult?.result
          ? [{ toolName: reply.toolName, result: toolResult.result as Record<string, unknown> }]
          : [];
    // 搜索卡让位仲裁：本轮搜索类媒体有真实产出（照片/视频卡已组装得出）→
    // search_result 文字卡整卡不附，照片是唯一主形态；媒体 0 产出（搜图全挂）
    // 时不让位，文字卡兜底保证本轮仍有结构化结果。直跑路径（loop 捕获为空、
    // reply.toolName 命中媒体工具）与 loop 捕获同权裁决。
    let searchMediaHasItems = executedMediaToolResults.some(
      (mt) =>
        SEARCH_MEDIA_TOOL_NAMES.has(mt.toolName) &&
        extractMediaCards(mt.toolName, mt.result).length > 0,
    );
    if (
      !searchMediaHasItems &&
      reply.toolName &&
      SEARCH_MEDIA_TOOL_NAMES.has(reply.toolName)
    ) {
      searchMediaHasItems = extractMediaCards(reply.toolName, toolResult?.result).length > 0;
    }
    finalText = attachDeterministicCards({
      text: finalText,
      travelToolName: travelReceiptResolution.toolName,
      travelResult: travelReceiptResolution.result,
      weatherResults: executedWeatherToolResults,
      searchResults: executedSearchToolResults,
      searchMediaHasItems,
      registryResults: executedRegistryToolResults,
      videoResults: videoReceipts,
    });
    // 结构化媒体卡片（Coze 式架构）：与 LLM 文本解耦，作为独立字段下发。
    // 前端直接读取 chat.assistant_done 的 mediaCards 字段渲染缩略图，
    // 不再依赖从 LLM 文本解析 [AGENT_RESULT_CARD_START] 标记。
    //
    // 聚合规则（2026-08-20）：**保留本轮所有**媒体搜索执行结果，而不是只取第一个。
    // 原因：对比类需求（马尔代夫 vs 印尼）LLM 会多次调用 search_images/
    // search_images_batch（不同维度/两侧），旧逻辑只取首个非空结果导致
    // 对比图只显示一侧或单维度。现在全部聚合，配合每条卡片携带的
    // groupTitle/side/sideLabel 分组元数据，前端按维度分组、左右分栏展示。
    let mediaCards: MediaCardItem[] = [];
    for (const mt of executedMediaToolResults) {
      const cards = extractMediaCards(mt.toolName, mt.result);
      if (cards.length > 0) mediaCards.push(...cards);
    }
    // 兜底：reply.toolName 路径执行（runToolIfNeeded 未走 onExternalToolExecuted）时，
    // 本轮执行结果里没有它，这里直接补齐。
    if (mediaCards.length === 0 && reply.toolName) {
      mediaCards = extractMediaCards(reply.toolName, toolResult?.result);
    }
    // 同一张图不重复展示：跨轮聚合后按图片地址去重（对比图各维度/两侧常重复返回）
    mediaCards = dedupMediaCards(mediaCards);
    // 主题粒度自适应裁剪：不设全局总量硬限，按主题(分组)保证"少而精、不遗漏"。
    // - 普通分组(单次搜索)最多 maxPerGroup 张，不堆一墙；
    // - 对比分组(A/B)每侧各 maxPerSide 张，两侧对称；
    // - 主题多则每个主题都保留前几张，不因总量上限把后面的主题/某侧挤掉。
    mediaCards = trimMediaCardsByTopic(mediaCards, {
      maxPerGroup: 4,
      maxPerSide: 2,
    });
    // 真实图片描述（Coze 式「一图一句」）：对裁剪后的图片卡逐张看图生成 caption。
    // 视觉模型批量调用（与主对话同 provider），失败/超时/模型不支持视觉时
    // 静默跳过——卡片保持无 caption，渲染回退旧的正文交错排版。
    if (mediaCards.length > 0 && isImageCaptionEnabled()) {
      try {
        await captionMediaCards(mediaCards);
      } catch (err) {
        console.info(
          `[chat] 图片描述生成异常（忽略，回退旧渲染）: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
    // 仅当没有结构化卡片时，才回退走文本标记注入（保持旧客户端兼容、
    // 以及非图片工具不带结构数据的场景）。有 mediaCards 时不再注入标记，
    // 避免 finalText 携带标记被前端旧解析路径抢先渲染、且无真实缩略图。
    if (mediaCards.length === 0) {
      // 媒体搜索：确定性注入 thumbnailUrl 到 media 卡片（不依赖 LLM 转发）
      finalText = attachMediaSearchMarker(finalText, reply.toolName, toolResult?.result);
    } else {
      // mediaCards 由 toolResult 承载、前端已能独立渲染缩略图；若 finalText 里
      // 还残留 processAssistantText 注入的 [AGENT_RESULT_CARD_START] 卡片块，
      // 前端会将其当作纯文本原样展示（重复/来回渲染）。这里剥掉，避免与
      // mediaCards 双份展示。
      finalText = stripMediaCardMarker(finalText);
      // 媒体搜索轮次：照片已由 mediaCards 卡片渲染，正文里若还残留 LLM 抄的
      // 工具项（`[路径]说明` 行）就会变成底部脏文本。按行剔除含图片地址的 echo，
      // 只保留纯文字叙述（若整段都是 echo 则剩余为空），保证下方只剩干净照片。
      finalText = stripMediaEchoText(finalText);
      // 出口不变量（2026-10-10 搜图轮 CONTENT_SUMMARY 裸 JSON 泄漏）：照片是
      // 本轮唯一主形态时，摘要折叠块绝不允许随正文透出——不管它是哪条路由
      // （summary_card / 模型自发标记 / 未来新增生产者）塞进来的，这里一律剥掉。
      // 客户端渲染层另有同语义兜底，两侧任一生效即可防泄漏。
      if (stripContentSummaryBlock(finalText) !== finalText) {
        console.log("[chat] media round: stripped CONTENT_SUMMARY block from finalText");
        finalText = stripContentSummaryBlock(finalText);
      }
    }
    // 提升最终回复文本中图片地址为可见缩略图（mediaCards 为空时的最后兜底）
    if (mediaCards.length === 0) {
      finalText = promoteImageUrlsToMedia(finalText);
    }

    // 识图照片卡（Coze 式「一图一句」，用户要求的 image_result 真实设计）：
    // 用户本轮发来的照片（visionFrames，此前只进模型上下文从不落盘）逐张落盘，
    // VLM 逐张看图生成「画面内容 + 可推断拍摄场景/地点」的一句话描述，
    // 以 [IMAGE_RESULT_START] 结构化块确定性附着——照片与描述绑定下发，
    // 客户端渲染为「照片卡片 + 下方描述」，不再展示「结论 + 要点」散文形态。
    if (batched.visionFrames?.length) {
      try {
        const photoItems = await buildVisionPhotoCards({
          actorId: msgActor,
          frames: batched.visionFrames,
          locationHint: batched.clientLocation?.label?.trim() || undefined,
        });
        finalText = attachImageResultPhotos(finalText, photoItems);
        // 路由配对不变量（与 CONTENT_SUMMARY 泄漏同源）：块存在 ⇒ 路由必在。
        // [IMAGE_RESULT_START] 块只有 [RENDER_AS:image_result] 路由的消费者；
        // LLM 叙事文本若被路由到其它形态（plain/brief/structured），客户端
        // 不会解析该块 → 裸 JSON 顶在正文最前面。附块而缺路由时强制补声明。
        if (
          finalText.includes("[IMAGE_RESULT_START]") &&
          !finalText.includes("[RENDER_AS:image_result]")
        ) {
          console.log("[chat] vision photos: force-pairing RENDER_AS:image_result");
          finalText = `[RENDER_AS:image_result]\n${finalText}`;
        }
      } catch (err) {
        console.info(
          `[chat] 识图照片卡构建失败（忽略，照片不入卡）: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    // 结构化通道迁移（2026-10-10 搜图轮 CONTENT_SUMMARY 裸 JSON 泄漏根治）：
    // 摘要卡是「路由资产」，永远不该以 JSON 内嵌在正文里透出。这里把正文中的
    // CONTENT_SUMMARY 块确定性摘出为 summaryCard 结构化字段随 done 下发，
    // 文本通道从此不携带 JSON——与 mediaCards 同构的 side-channel 模式。
    // 模型自发复读、任何路由注入、任何新模型行为都到不了用户眼前：
    // 块要么变成结构化卡，要么消失。媒体轮（照片是唯一主形态）整卡让位。
    let summaryCard: Record<string, unknown> | undefined;
    {
      const extracted = extractContentSummaryCard(finalText);
      if (extracted.card && mediaCards.length === 0) {
        summaryCard = extracted.card;
        console.log(
          `[chat] summary card -> structured field: ${String((extracted.card as { id?: string }).id ?? "")}`,
        );
      }
      finalText = extracted.text;
    }

    // [调试] 图片搜索链路诊断：记录工具名 / items / 卡片是否注入，用于排查前端照片不显示
    try {
      const debugItems = Array.isArray((toolResult?.result as any)?.items)
        ? ((toolResult?.result as any).items as unknown[]).length
        : -1;
      appendFileSync(
        "data/debug-image-card.log",
        `${new Date().toISOString()} toolName=${reply.toolName ?? "undefined"} ` +
          `toolOk=${toolResult?.ok} items=${debugItems} hasCard=${finalText.includes(
            "[AGENT_RESULT_CARD_START]",
          )}\n`,
      );
    } catch {
      /* 调试日志失败不影响主流程 */
    }

    if (scheduleOutcome && scheduleOutcome !== reply.text.trim()) {
      const supplement = scheduleOutcome.startsWith(reply.text.trim())
        ? scheduleOutcome.slice(reply.text.trim().length)
        : `\n\n${scheduleOutcome}`;
      // 去重兜底：剔除 supplement 与已流式正文句级重复的内容，
      // 避免"整段一模一样出现两次"（工具结果拼接与 LLM 已说内容重叠）。
      // 2026-10-08：对账基准从 reply.text 扩到「已流式文本 ∪ reply.text」——
      // 流式出口净化（时间戳帧/内部帧剥离）会让 reply.text 与用户实际看到的
      // 文本分叉，只对 reply.text 去重会漏掉"用户已经看到过"的句子。
      const seenSource = `${streamedText}\n${reply.text}`;
      const deduped = stripSentencesAlreadySaid(seenSource, supplement);
      if (!isStale() && deduped.trim()) sendAssistantChunk(deduped, "stream");
    } else if (!reply.text.trim() && chunkSeq === 0) {
      if (!isStale() && finalText) sendAssistantChunk(finalText, "stream");
    }

    if (isStale()) return;

    embodimentHappy(msgActor, (json) => ctx.socket.send(json));
    getEmbodimentAutonomy()?.setProcessing(msgActor, false, (json) => ctx.socket.send(json));

    // 兜底剥离 [ts:] 时间戳帧（chunk 出口已逐块剥，这里对 finalText 再整行兜底一次，
    // 容忍残缺帧，防路径绕过 sendAssistantChunk）
    finalText = stripAllTimestampFrameLines(finalText).trim();
    // 兜底再剥一次 DSML 工具调用标记：极少数情况下 DSML 跨多个 chunk 拼接后正则未在 adapter 层
    // 命中（极端异步路径），这里二次清理避免内部格式透出到用户可见消息。
    finalText = stripDsmlToolCallMarkup(finalText);

    // 卡片版式归一化：旅游规划回复固定三段式——模型总览卡置首、正文居中、
    // 行程卡独立收尾在最后（无行程卡的回复不重排，卡保持在模型落笔位置）。
    // done 载荷、落库文本、renderBlocks 与 blocks 派生共用这份归一化后的
    // finalText（此前 renderBlocks 在归一化前构建，媒体锚点与卡片版式会分叉），
    // 见 normalizeReplyCardLayout。
    finalText = normalizeReplyCardLayout(finalText);

    // 交错渲染块（renderBlocks）：把「清洗后的正文段落」与「媒体分组」按正文顺序交错，
    // 前端按块顺序渲染 → 「一段文字介绍后放一组照片，再一段文字，再一组照片」，
    // 替代旧行为「全部照片一次性铺在最前面」。由代码层位置锚定完成，不依赖 prompt。
    // 仅当有结构化媒体卡片时构建；无媒体时前端走原「文本+标记」路径。
    //
    // 2026-09-03：图片卡全部带真实描述（caption）时改走 buildCaptionedRenderBlocks——
    // 正文保持完整一段，照片逐张附各自的 caption（描述由视觉模型看图生成），
    // 不再用位置启发式把正文切段钉到照片旁（那是「文字与照片对不上」的根源）。
    const renderBlocks =
      mediaCards.length > 0
        ? allImageCardsHaveCaption(mediaCards)
          ? buildCaptionedRenderBlocks(finalText, mediaCards)
          : buildInterleavedRenderBlocks(finalText, mediaCards)
        : [];

    // 回复信封（A 阶段）：finalText 里的卡片标记在服务端确定性拆成 blocks，
    // 随 done 可选下发。text 仍是唯一事实源，blocks 是派生视图——旧客户端
    // 忽略 blocks 照旧解析标记，新客户端优先 blocks（消除解析漂移/标记泄漏）。
    // 含 v1 未支持标记（RENDER_AS/data_brief/video/summary）时返回 null，不下发。
    //
    // v2（2026-09-18）：媒体段一并编入 blocks——原先 blocks 只装 text/card，
    // 照片在独立的 renderBlocks/mediaCards 里，客户端按优先级取 blocks 即丢照片
    // （带卡回复「卡片在、照片没了」的根源）。media 块兼容性见 reply-envelope.ts
    // 文件头：v1 客户端静默跳过未知块，表现与升级前一致，无回归。
    const replyBlocks = buildReplyBlocks(finalText, renderBlocks);

    ctx.socket.send(
      JSON.stringify({
        type: ServerEventType.ChatAssistantDone,
        payload: {
          sessionId: msgActor,
          // 气泡拆分轮指向末泡 id（客户端按泡对账）；普通轮保持 assistant-$traceId
          messageId: bubbleTracker.outboundDoneMessageId,
          traceId: batched.originalMessageId,
          finalText,
          // 真·分绿泡（2026-09-28）：各气泡定稿对账数组（id+定稿文本）。
          // 客户端据此逐泡定稿/补建漏收的泡；finalTextReplacesStream=true 时
          // 该数组同时是"待塌缩删除"的泡清单。普通轮不下发该字段。
          // 发言塌缩轮即使无泡也要下发（空数组语义 = 只按单条发言收口）。
          ...(bubbleTracker.hasBubbles || utteranceCollapse
            ? { bubbles: bubbleTracker.snapshot }
            : {}),
          // 发言模型观测字段（2026-10-09）：本轮唯一发言的 id 与结算结果。
          // 客户端已可用 traceId 归组（utteranceId === traceId），此字段供
          // 端到端断言与线上取证（重复回复回归时看 collapse/reason 即可定位）。
          utterance: {
            id: utteranceSettlement.utteranceId,
            segments: utteranceSettlement.segments.length,
            keptSegments: utteranceSettlement.kept.length,
            collapse: utteranceSettlement.collapse,
            collapseReason: utteranceSettlement.collapseReason,
            bookkeepingOnly: utteranceSettlement.bookkeepingOnly,
          },
          // 放流配套（2026-09-28）：最终文本与已流文本分叉（重写/重跑/确定性
          // 收口）时置 true，客户端收到后用 finalText 整段替换流式气泡。
          // 卡片轮撤回（2026-10-08）：stream_reset 已撤回正文，done 必须
          // 整段替换（桌面端 done 默认保留已流正文，不强制会保留空泡）。
          ...(finalTextReplacesStream || streamResetSent
            ? { finalTextReplacesStream: true }
            : {}),
          toolCalls: reply.toolName ? [reply.toolName] : [],
          // 任务面异步收尾：本轮已把任务派发到后台（无正文），客户端按
          // source=task_plane + traceId 结清前台处理状态、不落正文气泡——
          // 任务回执与结果由任务面事件（chat.task_update / 结果 done）独立承载。
          ...(reply.taskDispatched ? { source: "task_plane" } : {}),
          // 结构化媒体卡片（Coze 式架构）：独立于 LLM 文本，前端直接渲染缩略图
          ...(mediaCards.length > 0 ? { mediaCards } : {}),
          // 结构化摘要卡（2026-10-10 通道迁移）：正文中的 CONTENT_SUMMARY 块
          // 已确定性摘出，卡片随本字段下发；文本通道不再携带 JSON。
          ...(summaryCard ? { summaryCard } : {}),
          // 交错渲染块：按正文顺序切好的「文字段+媒体组」，前端按序渲染
          // → 「一段文字介绍后放一组照片，再一段文字，再一组照片」。
          ...(renderBlocks.length > 0 ? { renderBlocks } : {}),
          // 回复信封块：text+card 的结构化序列，前端优先按 blocks 渲染
          ...(replyBlocks && replyBlocks.length > 0 ? { blocks: replyBlocks } : {}),
          // 「接下来你可以」接续建议：模型生成的下一步任务（可点击发送）
          ...(followups.length > 0 ? { followups } : {}),
        },
      }),
    );
    if (!isStale()) {
      messageBatchProcessor.markReplyStarted(msgActor);
    }
    turnSucceeded = true;
  } catch (err) {
    if (isStale()) return;
    const msg = err instanceof Error ? err.message : String(err);
    turnError = msg;
    // 内部错误日志保留完整信息（含 stack），便于排查
    console.error("[WS] chat.user_message failed:", err);
    embodimentAlert(msgActor, (json) => ctx.socket.send(json), msg, "error");
    getEmbodimentAutonomy()?.setProcessing(msgActor, false, (json) => ctx.socket.send(json));
    ctx.sendUnifiedError("CHAT_HANDLER_ERROR", msg, batched.originalMessageId);
    // 不再用 apology 兜底文案掩盖错误：agent-core 已尝试 emergencyRegenerate，
    // 此处发空串让 UI 不显示虚假回复。sendUnifiedError 已通知前端出错。
    const errText = "";
    if (isStale()) return;
    ctx.socket.send(
      JSON.stringify({
        type: ServerEventType.ChatAssistantDone,
        payload: {
          sessionId: msgActor,
          // 错误收口：已推出的气泡原样定稿（半截也是用户亲眼所见），不回吞
          messageId: bubbleTracker.outboundDoneMessageId,
          traceId: batched.originalMessageId,
          finalText: errText,
          ...(bubbleTracker.hasBubbles ? { bubbles: bubbleTracker.snapshot } : {}),
          toolCalls: [],
        },
      }),
    );
    if (!isStale()) {
      messageBatchProcessor.markReplyStarted(msgActor);
    }
  } finally {
    unsubscribeTravelProgress();
    releaseTurn();
    // 丢弃主回复分段器缓冲（异常路径防残留半截文本）
    streamSegmenter.discard();
    // 清除所有可能残留的工具心跳定时器（如工具异常未触发 onToolExecuted）
    clearAllToolHeartbeats();
    // 清理本轮 AbortController(如未被新消息 abort 则正常清理)
    if (activeTurnAborters.get(msgActor) === turnAbortController) {
      activeTurnAborters.delete(msgActor);
    }
    // 中断/异常轮次兜底记账（2026-09-08）：轮次未正常收尾但已有部分回复流式
    // 送达用户时，以部分文本完成 STM 挂起项结清 / WAL / 日志记账。否则用户
    // 亲眼看到的「安排好了…11:30 提醒」不进任何账本——挂起栈里的原始请求
    // （默认 TTL 6 小时）每轮注入 open-loops，agent 会反复重问已办成的事。
    // finish 只做记账不触发 LLM（文本非空不会走 regenerate），幂等可重入。
    if (!turnSucceeded && streamedText.trim()) {
      try {
        deps.runtime.settleInterruptedTurn?.(msgActor, batched.text, streamedText, {
          sessionId: typeof batched.sessionId === "string" ? batched.sessionId : undefined,
          messageId: batched.originalMessageId,
        });
      } catch {
        /* 兜底记账失败不影响主流程 */
      }
    }
    // Phase 2：记录 turn 结果供自适应并发调整（AIMD）
    const turnDuration = Date.now() - turnStartedAt;
    recordTurnOutcome(turnSucceeded, turnDuration, turnError);
  }
}

/**
 * 从 mediaUrl 解析本地文件路径，读取 mp3 字节并调 ASR 识别。
 * mediaUrl 形如 `/agent/voice/messages/{actorId}/{msgId}.mp3`。
 * 失败时返回空字符串，由调用方降级处理。
 */
async function transcribeAudioFromMediaUrl(
  mediaUrl: string,
  actorId: string,
  voiceCapability: VoiceCapabilityService,
  voiceMessageService: VoiceMessageService,
): Promise<string> {
  // 从 mediaUrl 提取 actorId 与 fileName
  const match = mediaUrl.match(/^\/agent\/voice\/messages\/([^/]+)\/([^/]+)$/);
  if (!match) {
    console.warn(`[ASR] 无法解析 mediaUrl: ${mediaUrl}`);
    return "";
  }
  const [, urlActorId, fileName] = match;
  const fullPath = voiceMessageService.resolveFilePath(urlActorId, fileName);
  if (!fullPath) {
    console.warn(`[ASR] 文件不存在: ${mediaUrl}`);
    return "";
  }

  const buffer = await readFile(fullPath);
  const result = await voiceCapability.transcribe({
    audio: { data: Buffer.from(buffer), format: "mp3" },
    language: "zh",
  });

  if (!result.ok || !result.text) {
    console.warn(`[ASR] 识别失败: ${result.error ?? "empty"}`);
    return "";
  }

  console.log(`[ASR] 识别成功（actor=${actorId}, ${buffer.length} bytes）: ${result.text.slice(0, 80)}…`);
  return result.text.trim();
}

