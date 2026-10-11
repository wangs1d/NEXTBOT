import type { ChatCompletionContentPart, ChatCompletionMessageParam } from "openai/resources/chat/completions";

import { adoptLegacyMasterDelegateThread, adoptPrimaryThreadFromMasterThread } from "./chat-thread-adopt.js";
import { masterChatSessionId } from "../agent/master-chat-session.js";
import { AGENT_COMMITMENT_RE, KEY_PIN_INSTRUCTION_RE, MEMORY_EXPLICIT_RE } from "../agent/memory-signal.js";
import type { ChatThreadPersistence } from "./chat-thread-persist.js";
import { getChatThreadPersistence } from "./chat-thread-persist.js";
import type { ChatUserTurn } from "./types.js";
import type { RecapSummarizer } from "../services/conversation-rolling-summarizer.js";
import { mergeKeyPins, normalizeRecapSummaryResult } from "../services/conversation-rolling-summarizer.js";
import {
  annotateRecapLinesWithAge,
  indexifyRecapForLlm,
  formatRecapStamp,
  layerRecapLinesByBudget,
  migrateRecapContentLabels,
} from "../services/conversation-rolling-summarizer.js";
import { openAiUserContentFromTurn } from "./build-user-message-content.js";
import {
  absorbPersistedClientIds,
  copyUserMessageClientId,
  PERSISTED_CLIENT_ID_FIELD,
  readPersistedClientIdField,
  readUserMessageClientId,
  tagUserMessageClientId,
} from "./chat-thread-client-id.js";
import {
  compactValidChatMessages,
  repairKimiAssistantToolCallReasoning,
  sanitizeToolCallMessageChain,
} from "./chat-thread-sanitize.js";
import { stripLeadingTimestampFrames } from "../utils/timestamp-frame.js";
import {
  isInternalFrameText,
  stripInternalFrameMarkup,
  stripSystemReminderBlocks,
} from "./internal-frames.js";

/**
 * clientMessageId 的绑定/落盘字段实现已抽到 {@link ./chat-thread-client-id.js}
 * （避免 store ↔ persist 循环依赖）。这里重新导出，保持既有调用方
 * （abstract-chat-provider、测试）的导入路径不变。
 */
export { PERSISTED_CLIENT_ID_FIELD, tagUserMessageClientId };

/**
 * 落库协议标记剥离（2026-09-25）：线程是 LLM 上下文的唯一事实源，模型按
 * render 协议写的 [NEXT_UP_START] 块（含漏发 END 的残块）与 RENDER_HINT/RENDER_AS
 * 声明属「展示时机性内容」，落库即成上下文噪音并会被后续轮模仿（此前对话面
 * done 载荷已剥但线程未剥，残块实测进历史）。卡片标记（AGENT_RESULT_CARD）不剥
 * ——历史渲染依赖正文标记还原行程卡。
 */
const THREAD_NEXT_UP_BLOCK_RE = /\[NEXT_UP_START\][\s\S]*?(?:\[NEXT_UP_END\]|$)/g;
const THREAD_NEXT_UP_ORPHAN_RE = /\[NEXT_UP_(?:START|END)\]/g;
const THREAD_RENDER_DECL_RE = /^\s*\[(?:RENDER_HINT|RENDER_AS):[A-Za-z_]+\]\s*$/gm;
const THREAD_RENDER_DECL_INLINE_RE = /\[(?:RENDER_HINT|RENDER_AS):[A-Za-z_]+\]/g;
const THREAD_PROTOCOL_ANY_RE =
  /\[NEXT_UP_(?:START|END)\]|\[(?:RENDER_HINT|RENDER_AS):|<\s*\/?\s*system-reminder/i;

function stripProtocolMarkersForThread(text: string): string {
  // <system-reminder>（2026-10-08 事故根源）：上游 harness 注入块被模型复读后
  // 落库即成永久上下文污染——下一轮模型看到「自己说过」，再复读，自我维持。
  // 线程是 LLM 上下文的唯一事实源，必须在写入前剥干净。
  let out = stripSystemReminderBlocks(text);
  out = out.replace(THREAD_NEXT_UP_BLOCK_RE, "");
  out = out.replace(THREAD_NEXT_UP_ORPHAN_RE, "");
  out = out.replace(THREAD_RENDER_DECL_RE, "");
  out = out.replace(THREAD_RENDER_DECL_INLINE_RE, "");
  return out.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function findUserMessageByClientId(
  thread: ChatCompletionMessageParam[],
  clientMessageId: string,
): { index: number; msg: ChatCompletionMessageParam } | null {
  if (!clientMessageId) return null;
  for (let i = 0; i < thread.length; i++) {
    const msg = thread[i];
    if (msg && msg.role === "user" && readUserMessageClientId(msg) === clientMessageId) {
      return { index: i, msg };
    }
  }
  return null;
}

/** user 消息的纯文本（剥掉时间戳帧前缀 / 取文本分段），非 user 或取不到文本时 null。 */
function readUserMessagePlainText(msg: ChatCompletionMessageParam): string | null {
  if (msg.role !== "user") return null;
  if (typeof msg.content === "string") {
    return stripLeadingTimestampFrames(msg.content).trim();
  }
  if (Array.isArray(msg.content)) {
    const first = msg.content[0];
    if (first && typeof first === "object" && (first as { type?: string }).type === "text") {
      const text = (first as { text?: string }).text ?? "";
      return stripLeadingTimestampFrames(text).trim();
    }
  }
  return null;
}

/**
 * 按纯文本查找 user 消息（迁移兜底，2026-10-04）。
 *
 * 用途：本功能上线前落盘的线程没有 `__clientMessageId` 字段，重启后按 id 定位不到；
 * 客户端同时带上被删消息的原文，就能把这段存量历史也删掉。
 *
 * 返回**全部**命中：由调用方判断是否唯一——同一句话发过两次时宁可不动，也不能删错轮次。
 */
function findUserMessagesByPlainText(
  thread: ChatCompletionMessageParam[],
  text: string,
): Array<{ index: number; msg: ChatCompletionMessageParam }> {
  const target = text.trim();
  if (!target) return [];
  const out: Array<{ index: number; msg: ChatCompletionMessageParam }> = [];
  for (let i = 0; i < thread.length; i++) {
    const msg = thread[i];
    if (!msg) continue;
    if (readUserMessagePlainText(msg) === target) out.push({ index: i, msg });
  }
  return out;
}

const DEFAULT_SMART_TRIM_CONFIG = {
  maxMessages: parseInt(process.env.MAX_THREAD_MESSAGES ?? "24", 10),
  maxTokens: parseInt(process.env.MAX_CONTEXT_TOKENS ?? "6000", 10),
  preserveRecentTurns: 3,
};

// ── 滑动窗口裁剪参数（2026-09-05，替代「今天+昨天全文」策略）──
/** 原样保留的近期消息窗口（≈6 轮 user/assistant 配对）。 */
const RECENT_WINDOW_MESSAGES = 12;
/** 增量摘要批次：窗口外攒够一批才合并一次，摘要不随轮重写（保护 prefix cache）。 */
const RECAP_BATCH_MESSAGES = 6;
/** 摘要块整体 token 粗估（摘要区 30 行/2400 字符 + 关键钉区 10 行/1000 字符 + 待归纳区 24 行/2400 字符）。 */
const RECAP_LINE_TOKEN_ESTIMATE = 55;

function intEnv(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// 条内压缩配置：对「非最近 N 轮」的超长 assistant 消息（LLM 已消费过的输出）做无损级压缩，
// 让同一 token 预算保留更多轮次，减少整条 drop 进 recap（信息断层 + 额外一次 LLM 摘要调用）。
const CHAT_LONG_ASSISTANT_MAX_CHARS = parseInt(
  process.env.CHAT_LONG_ASSISTANT_MAX_CHARS ?? "800",
  10,
);
const CHAT_COMPRESS_PRESERVE_RECENT_TURNS = 2;

const SESSION_RECAP_PREFIX = "[session-recap]";
const SESSION_RECAP_TITLE = "Earlier conversation recap:";
/**
 * 注入层时间锚提示行（2026-10-09）：只加进发往 LLM 的视图，不落盘。
 * 内容静态 → 字节稳定，不打断 prefix cache；配合逐行的 `（约N天前）` 标注，
 * 把「距今多久」显式交给模型，根治「把旧事当现事说」（「刚才你说好饿」事故家族）。
 */
const RECAP_TIME_ANCHOR_HINT =
  "（本块为历史摘要：行首是该事件发生的绝对时刻，紧随的括号是它距现在的时长；" +
  "叙述时必须按括号判断「多久前」——距今超过 1 小时不得说「刚才/刚刚/现在」，" +
  "跨天（昨天及更早）必须按日期叙述，拿不准就只陈述内容、不报时间。）";
/** 待归纳区标记：其下为「已滑出窗口、尚未被 LLM 增量摘要吸收」的原文占位行（绝对时间标签）。 */
const SESSION_UNSUMMARIZED_MARKER = "[unsummarized]";

// ── 增量摘要预算（env 可调）：滑动窗口 + 增量摘要，不做「挤进固定 14 行」的折叠 ──
/** LLM 滚动摘要区行数/字符预算（摘要器提示词使用同一预算，保证输出可完整落进线程）。 */
const SESSION_SUMMARY_MAX_LINES = intEnv(process.env.SESSION_SUMMARY_MAX_LINES, 30);
const SESSION_SUMMARY_MAX_CHARS = intEnv(process.env.SESSION_SUMMARY_MAX_CHARS, 2400);
/**
 * 待归纳区（[unsummarized]）行数/字符预算：窗口溢出批次在 LLM 合并成功前的原文占位。
 * 超预算时淘汰最旧的行——这些行的全文仍在 turn WAL（全量 JSONL）与 daily journal，
 * 检索层（journalRecall）可兜底；正常情况下 LLM 摘要每批都会吸收清空该区。
 */
const SESSION_PENDING_MAX_LINES = intEnv(process.env.SESSION_PENDING_MAX_LINES, 24);
const SESSION_PENDING_MAX_CHARS = intEnv(process.env.SESSION_PENDING_MAX_CHARS, 2400);

// ── 关键钉（key pins）预算（env 可调）：不可忘事实的逐字保留区 ──
/**
 * 关键钉区标记行：渲染在摘要区之后、[unsummarized] 之前，混合式上下文的中间层
 * （[历史摘要] 全局脉络压缩 → [关键钉] 不可忘的事实 → 最近 K 轮原文 → 当前 Query）。
 * 钉行逐字保留：不参与摘要的时间分层裁剪/重排，增量合并只增不改（超预算才淘汰最旧）。
 */
const SESSION_KEY_PINS_MARKER = "[关键钉]";
const SESSION_KEY_PINS_HEADER = "[关键钉] 不可忘的事实（逐字保留，禁止改写或遗忘）：";
const SESSION_KEY_PINS_MAX_LINES = intEnv(process.env.SESSION_KEY_PINS_MAX_LINES, 10);
const SESSION_KEY_PINS_MAX_CHARS = intEnv(process.env.SESSION_KEY_PINS_MAX_CHARS, 1000);
/** 确定性自动钉的行字符上限（与摘要行同量级；超长取首行截断）。 */
const SESSION_KEY_PIN_AUTO_MAX_CHARS = intEnv(process.env.SESSION_KEY_PIN_AUTO_MAX_CHARS, 160);
/** 单批确定性自动钉上限（用户显式「要求记住」指令轮，宁缺勿滥）。 */
const SESSION_KEY_PIN_AUTO_MAX_PER_BATCH = 3;

const TIME_FRAME_PREFIX = "[timeframe:";

/**
 * 单条消息时间戳前缀：固定在消息首行，供 LLM 精确关联时间维度。
 * 格式：`[ts:ISO_LOCAL|WEEKDAY|RELATIVE]`，例：`[ts:2026-06-10 14:35:22|周二|3m ago]`。
 * 兼容历史 `[timeframe:...]` 前缀（旧数据 strip 掉即可，新写入统一用 `ts:`）。
 */
const TS_FRAME_PREFIX = "[ts:";
const TS_FRAME_REGEX = /^\[ts:[^\]]+\]\n?/;

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function formatLocalDateTime(date: Date): string {
  return (
    `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ` +
    `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`
  );
}

const WEEKDAY_CN = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"] as const;

function weekdayCn(date: Date): string {
  return WEEKDAY_CN[date.getDay()] ?? "";
}

function estimateTokens(text: string | null | undefined): number {
  if (!text) return 0;
  const chineseChars = (text.match(/[\u4e00-\u9fa5]/g) || []).length;
  const englishWords = text.replace(/[\u4e00-\u9fa5]/g, " ").split(/\s+/).filter((w) => w.length > 0).length;
  return Math.ceil(chineseChars * 1.5 + englishWords * 0.25);
}

function estimateMessageTokens(msg: ChatCompletionMessageParam | null | undefined): number {
  if (!msg || typeof msg.role !== "string") return 0;
  let tokens = 2;
  if (typeof msg.content === "string") {
    tokens += estimateTokens(msg.content);
  } else if (Array.isArray(msg.content)) {
    for (const part of msg.content) {
      if (part.type === "text") {
        tokens += estimateTokens((part as { text?: string }).text);
      } else if (part.type === "image_url") {
        tokens += 500;
      }
    }
  }
  if ("tool_calls" in msg && Array.isArray((msg as { tool_calls?: unknown[] }).tool_calls)) {
    tokens += 50 * ((msg as { tool_calls: unknown[] }).tool_calls?.length ?? 0);
  }
  if (msg.role === "tool" && typeof msg.content === "string") {
    // 不设低封顶：压缩后的工具消息可达 4-7k 字符（≈3-5k token），按 1000 封顶会
    // 低估占用、让 MAX_CONTEXT_TOKENS 预算判断偏松而放行超限内容。
    tokens += estimateTokens(msg.content);
  }
  return tokens;
}

function weekdayName(date: Date): string {
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][date.getDay()] ?? "Unknown";
}

function timeOfDayLabel(date: Date): string {
  const hour = date.getHours();
  if (hour < 5) return "deep night";
  if (hour < 8) return "early morning";
  if (hour < 12) return "morning";
  if (hour < 14) return "noon";
  if (hour < 18) return "afternoon";
  if (hour < 22) return "evening";
  return "late night";
}

function sameLocalDay(left: Date, right: Date): boolean {
  return (
    left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate()
  );
}

function dayDiff(from: Date, to: Date): number {
  const fromDay = new Date(from.getFullYear(), from.getMonth(), from.getDate()).getTime();
  const toDay = new Date(to.getFullYear(), to.getMonth(), to.getDate()).getTime();
  return Math.round((toDay - fromDay) / 86_400_000);
}

function describeRelativeTime(at: Date, now = new Date()): string {
  const diffMs = now.getTime() - at.getTime();
  if (diffMs < 0) return "in the future";

  const diffMinutes = Math.floor(diffMs / 60_000);
  const diffHours = Math.floor(diffMs / 3_600_000);
  const diffDays = dayDiff(at, now);

  if (diffMinutes <= 1) return "just now";
  if (diffMinutes < 60) return `${diffMinutes}m ago`;
  if (sameLocalDay(at, now)) return `${diffHours}h ago`;
  if (diffDays === 1) return `yesterday ${timeOfDayLabel(at)}`;
  if (diffDays < 7) return `${diffDays}d ago`;
  if (diffDays < 14) return "last week";
  if (diffDays < 31) return `${Math.floor(diffDays / 7)}w ago`;
  if (diffDays < 62) return "last month";
  return `${Math.floor(diffDays / 30)}mo ago`;
}

/** 构造 LLM 可见的时间戳前缀：`[ts:YYYY-MM-DD HH:MM:SS|周X|relative]`。 */
export function buildMessageTimestampPrefix(at: Date, now: Date = new Date()): string {
  return `${TS_FRAME_PREFIX}${formatLocalDateTime(at)}|${weekdayCn(at)}|${describeRelativeTime(at, now)}]`;
}

/** 提取消息首行的时间戳前缀；返回 null 表示无前缀。 */
export function readMessageTimestampPrefix(line: string): { prefix: string; rest: string } | null {
  const trimmed = line.trimStart();
  const tsMatch = trimmed.match(TS_FRAME_REGEX);
  if (tsMatch) {
    return { prefix: tsMatch[0].replace(/\n$/, ""), rest: trimmed.slice(tsMatch[0].length) };
  }
  if (trimmed.startsWith(TIME_FRAME_PREFIX)) {
    const newlineIdx = trimmed.indexOf("\n");
    const prefix = newlineIdx >= 0 ? trimmed.slice(0, newlineIdx) : trimmed;
    const rest = newlineIdx >= 0 ? trimmed.slice(newlineIdx + 1).trim() : "";
    return { prefix, rest };
  }
  return null;
}

/** 从 `[ts:YYYY-MM-DD HH:MM:SS|周X|relative]` 解析出原始 Date，便于持久化/排序。 */
export function parseMessageTimestamp(line: string): Date | null {
  const prefix = readMessageTimestampPrefix(line);
  if (!prefix) return null;
  const m = prefix.prefix.match(/\[ts:(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\|/);
  if (!m?.[1]) return null;
  const normalized = m[1].replace(" ", "T");
  const ts = Date.parse(normalized);
  return Number.isNaN(ts) ? null : new Date(ts);
}

/** 从消息对象中尝试读取已注入的时间戳；用于恢复历史时保持原时间，避免重新打标后顺序乱跳。 */
function extractMessageTimestamp(msg: ChatCompletionMessageParam): Date | null {
  if (msg.role !== "user" && msg.role !== "assistant") return null;
  if (typeof msg.content === "string") return parseMessageTimestamp(msg.content);
  if (Array.isArray(msg.content)) {
    for (const part of msg.content) {
      if (part && typeof part === "object" && (part as { type?: string }).type === "text") {
        const text = (part as { text?: string }).text ?? "";
        const ts = parseMessageTimestamp(text);
        if (ts) return ts;
      }
    }
  }
  return null;
}

/**
 * 供 Provider 在调 LLM 前给本轮 user 消息打时间戳前缀（避免「同 1 句用户话，下轮才看到时间」）。
 * 已有时间戳则不重复打，保持唯一。
 */
export function annotateUserContentForLlm(
  content: string | ChatCompletionMessageParam["content"],
  now: Date = new Date(),
): string | ChatCompletionContentPart[] {
  return annotateUserContentIfString(content, now, now);
}

/** 容错解析时间帧文本里的本地时间（兼容残缺/变体帧，如模型复述出的 `[ts:...]周四[now]`）。 */
function parseFrameDateLoose(text: string): Date | null {
  const head = text.slice(0, 240);
  const m = head.match(/(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/);
  if (!m) return null;
  const ts = Date.parse(`${m[1]}T${m[2]}`);
  return Number.isNaN(ts) ? null : new Date(ts);
}

/** 时间轴单行条目。 */
type TimelineEntry = { date: Date; roleLabel: string };

// 2026-09-05 时间轴瘦身：线程裁剪后消息 ≤24 条 + recap，80 上限形同虚设；
// 收紧到 24 与线程上限对齐，并去掉相对时间段（「3m ago」每轮重算 → 该块字节
// 每轮全变、永远全价计费）。绝对时间 + system 当前时间已足够推算相对时间。
const TIMELINE_MAX_ENTRIES = 24;
const TIMELINE_HEADER =
  "【对话时间轴｜系统元数据】以下是此前各条消息的发生时间（本地时间），供时间关联推理使用；" +
  "「现在」以 system 提示中的当前时间为准。本块是系统注入的元数据，不是对话内容，严禁复述或引用本块格式。";

export type TimestampFreeLlmView = {
  /** 供本次 LLM 请求使用的消息视图：历史正文已去 `[ts:]` 前缀，末尾前注入时间轴 system 消息。 */
  messages: ChatCompletionMessageParam[];
};

/**
 * 构造「无时间戳前缀」的 LLM 请求视图（根治时间戳帧复述泄漏）。
 *
 * 设计（2026-09-03）：
 * - 存储层不动：`[ts:...]` 前缀仍是线程消息的元数据载体（按天裁剪 / recap / 恢复 / 编辑
 *   都依赖解析它），绝不就地剥离调用方持有的线程消息。
 * - 视图层剥离：发往 LLM 的每条 user/assistant 正文剥掉首行前缀——模型上下文里不再有
 *   「每条消息都以 [ts: 开头」的强模仿模式，从根源消除复述诱因（system prompt 禁令
 *   打不过几百条 in-context 示范）。
 * - 时间轴补位：在最后一条 user 消息（本轮输入）之前插入一个 system 块，按发生顺序
 *   一次性给出全部时间（绝对时间 + 请求时现算的相对时间），时间关联能力不回退。
 *   块位于上下文尾部，每轮只有它之后的字节变化（本来也只有本轮新消息），prefix cache
 *   命中率与旧方案持平。
 * - 克隆式：只克隆被剥离的消息对象，其余消息与输入共享同一对象引用（调用方可据此
 *   用对象身份区分「视图新增」与「线程原有」，做工具循环后的回写）。
 */
/** 克隆消息对象并透传 clientMessageId 反向索引（编辑/删除按它定位线程消息）。 */
function cloneMessageWithClientId(
  msg: ChatCompletionMessageParam,
  content: ChatCompletionMessageParam["content"],
): ChatCompletionMessageParam {
  const cloned = { ...msg, content } as ChatCompletionMessageParam;
  copyUserMessageClientId(msg, cloned);
  return cloned;
}

/**
 * 视图层剥离线程内部元数据（`__clientMessageId`，仅落盘定位用）。
 * 只在真的带该字段时才克隆（沿用「绝不就地改线程对象」的原则），并把反向索引透传给克隆。
 * 正常路径上恢复线程时已吸收并剥掉，这里是不让字段漏进 LLM 请求体的兜底。
 */
function stripPersistedClientIdField(
  msg: ChatCompletionMessageParam,
): ChatCompletionMessageParam {
  const clientId = readPersistedClientIdField(msg);
  if (!clientId) return msg;
  const cloned = { ...(msg as unknown as Record<string, unknown>) };
  delete cloned[PERSISTED_CLIENT_ID_FIELD];
  const out = cloned as unknown as ChatCompletionMessageParam;
  copyUserMessageClientId(msg, out);
  return out;
}

export type TimestampFreeLlmViewOptions = {
  /**
   * 是否注入【对话时间轴】system 块（2026-10-06 按需时间上下文闸）。
   * 默认 true（旧行为）；时间闸关闭的轮次传 false——正文剥离照常执行
   * （防 `[ts:]` 复述的根修不回退），只是不再附时间轴块。
   */
  includeTimeline?: boolean;
  /**
   * 注入层时间锚基准时刻（2026-10-09）：给 recap 行算「距今多久」用。
   * 默认取当前时间；测试可注入固定时刻。仅影响视图克隆，存储不动。
   */
  now?: Date;
};

/**
 * 构造 recap 消息的 LLM 视图内容（2026-10-09 分类索引视图）：
 * - 逐行追加日粒度年龄标注（`（约1天前）`）——把「距今多久」显式交给模型；
 * - 分类索引加工：瞬时状态条目跨天从视图剔除（原话素材不再常驻，治「刚才你说
 *   好饿」），持久事项跨天未闭环的加策略位「勿主动提」（冷索引语义）；
 * - 标题行后补一行静态时间锚提示（字节稳定，不伤 prefix cache）；
 * - 仅视图克隆，原消息/存储/解析完全不变。
 */
function buildRecapLlmViewContent(content: string, now: Date): string {
  const withAges = annotateRecapLinesWithAge(content, now);
  const indexed = indexifyRecapForLlm(withAges, now);
  const lines = indexed.split("\n");
  const titleIdx = lines.findIndex((l) => l.trim() === SESSION_RECAP_TITLE);
  const next = titleIdx >= 0 ? (lines[titleIdx + 1] ?? "") : "";
  if (titleIdx >= 0 && !next.includes("距现在的时长")) {
    lines.splice(titleIdx + 1, 0, RECAP_TIME_ANCHOR_HINT);
  }
  const joined = lines.join("\n");
  return joined === content ? content : joined;
}

export function buildTimestampFreeLlmView(
  msgs: ChatCompletionMessageParam[],
  options: TimestampFreeLlmViewOptions = {},
): TimestampFreeLlmView {
  const includeTimeline = options.includeTimeline !== false;
  const now = options.now ?? new Date();
  const timeline: TimelineEntry[] = [];
  const view = msgs.map((raw) => {
    // 内部元数据先剥掉：它既不参与时间轴，也不该出现在发往 LLM 的正文里。
    const msg = stripPersistedClientIdField(raw);
    if (msg.role !== "user" && msg.role !== "assistant") return msg;
    const roleLabel = msg.role === "user" ? "用户" : "助手";

    if (Array.isArray(msg.content)) {
      const parts = msg.content;
      const textIdx = parts.findIndex(
        (part) => part && typeof part === "object" && (part as { type?: string }).type === "text",
      );
      if (textIdx < 0) return msg;
      const part = parts[textIdx] as { type: "text"; text: string };
      const original = part.text ?? "";
      const date = extractMessageTimestamp(msg) ?? parseFrameDateLoose(original);
      const stripped = stripLeadingTimestampFrames(original);
      if (stripped.startsWith(SESSION_RECAP_PREFIX)) {
        const recapView = buildRecapLlmViewContent(stripped, now);
        if (recapView === original) return msg;
        const clonedParts = parts.slice();
        clonedParts[textIdx] = { ...part, text: recapView };
        return cloneMessageWithClientId(msg, clonedParts);
      }
      if (date) {
        timeline.push({ date, roleLabel });
      }
      if (stripped === original) return msg;
      const clonedParts = parts.slice();
      clonedParts[textIdx] = { ...part, text: stripped };
      return cloneMessageWithClientId(msg, clonedParts);
    }

    if (typeof msg.content !== "string") return msg;
    const original = msg.content;
    const date = extractMessageTimestamp(msg) ?? parseFrameDateLoose(original);
    const stripped = stripLeadingTimestampFrames(original);
    if (stripped.startsWith(SESSION_RECAP_PREFIX)) {
      const recapView = buildRecapLlmViewContent(stripped, now);
      return recapView === original ? msg : cloneMessageWithClientId(msg, recapView);
    }
    if (date) {
      timeline.push({ date, roleLabel });
    }
    if (stripped === original) return msg;
    return cloneMessageWithClientId(msg, stripped);
  });

  // 时间轴注入点：最后一条 user 消息（本轮输入）之前。条目过少（<2，如 ephemeral 单轮）
  // 时时间轴无增量价值，跳过注入，只保留剥离。includeTimeline=false（时间闸关）同样只剥离。
  if (includeTimeline && timeline.length >= 2) {
    let lastUserIdx = -1;
    for (let i = view.length - 1; i >= 0; i--) {
      if (view[i]?.role === "user") {
        lastUserIdx = i;
        break;
      }
    }
    const rows = timeline.slice(-TIMELINE_MAX_ENTRIES).map((entry) => {
      // 不再拼相对时间段：它每轮随请求时刻重算，导致整个时间轴块字节每轮变化，
      // prefix cache 永远失配、按全价计费；绝对时间 + 当前时间足以推算相对时间。
      return `- ${formatLocalDateTime(entry.date)} ${weekdayCn(entry.date)} ${entry.roleLabel}`;
    });
    const timelineMsg: ChatCompletionMessageParam = {
      role: "system",
      content: `${TIMELINE_HEADER}\n${rows.join("\n")}`,
    };
    const insertAt = lastUserIdx >= 0 ? lastUserIdx : view.length;
    view.splice(insertAt, 0, timelineMsg);
  }

  return { messages: view };
}

/** 比较一条 user 消息的纯文本是否等于 `incoming`（去时间戳前缀后比较，避免重复追加）。 */
function userMessageTextMatches(msg: ChatCompletionMessageParam, incoming: string): boolean {
  if (msg.role !== "user") return false;
  if (typeof msg.content === "string") {
    const parsed = readMessageTimestampPrefix(msg.content);
    return (parsed?.rest ?? msg.content).trim() === incoming.trim();
  }
  if (Array.isArray(msg.content)) {
    const first = msg.content[0];
    if (first && typeof first === "object" && (first as { type?: string }).type === "text") {
      const text = (first as { text?: string }).text ?? "";
      const parsed = readMessageTimestampPrefix(text);
      return (parsed?.rest ?? text).trim() === incoming.trim();
    }
  }
  return false;
}

/**
 * 在每条 user / assistant 消息首行注入精确时间戳（年/月/日/时/分/秒 + 星期 + 相对当前时间）。
 * 重复调用同一消息时自动用新时间刷新；兼容历史 `[timeframe:...]` 前缀。
 */
function annotateTimeframe(content: string, at: Date, now: Date = new Date()): string {
  const trimmed = content.trimStart();
  const existing = readMessageTimestampPrefix(trimmed);
  const rest = existing ? existing.rest : trimmed;
  const prefix = buildMessageTimestampPrefix(at, now);
  return `${prefix}\n${rest}`;
}

function stripTimestampText(content: string): string {
  const parsed = readMessageTimestampPrefix(content);
  return (parsed?.rest ?? content).trim();
}

function isSessionRecapMessage(msg: ChatCompletionMessageParam | undefined): boolean {
  if (!msg || msg.role !== "assistant" || typeof msg.content !== "string") return false;
  return stripTimestampText(msg.content).startsWith(SESSION_RECAP_PREFIX);
}

/** 提取摘要区的行（[关键钉] / [unsummarized] 标记之前，跳过标题行）。 */
function extractSessionRecapLines(content: string | undefined): string[] {
  if (!content) return [];
  const text = stripTimestampText(content);
  if (!text.startsWith(SESSION_RECAP_PREFIX)) return [];
  const lines: string[] = [];
  for (const raw of text.split("\n").slice(1)) {
    const line = raw.replace(/^-+\s*/, "").trim();
    if (line === SESSION_UNSUMMARIZED_MARKER || line.startsWith(SESSION_KEY_PINS_MARKER)) break;
    if (line && line !== SESSION_RECAP_TITLE) lines.push(line);
  }
  return lines;
}

/** 提取关键钉区（[关键钉] 标记之后、[unsummarized] 之前）的钉行。 */
function extractSessionKeyPinLines(content: string | undefined): string[] {
  if (!content) return [];
  const text = stripTimestampText(content);
  if (!text.startsWith(SESSION_RECAP_PREFIX)) return [];
  const lines = text.split("\n");
  const pinIdx = lines.findIndex((l) => l.trim().startsWith(SESSION_KEY_PINS_MARKER));
  if (pinIdx < 0) return [];
  const out: string[] = [];
  for (const raw of lines.slice(pinIdx + 1)) {
    const line = raw.replace(/^-+\s*/, "").trim();
    if (line === SESSION_UNSUMMARIZED_MARKER) break;
    if (line && line !== SESSION_RECAP_TITLE) out.push(line);
  }
  return out;
}

/** 提取待归纳区（[unsummarized] 标记之后）的原文占位行。 */
function extractSessionPendingLines(content: string | undefined): string[] {
  if (!content) return [];
  const text = stripTimestampText(content);
  if (!text.startsWith(SESSION_RECAP_PREFIX)) return [];
  const markerIdx = text.split("\n").findIndex((l) => l.trim() === SESSION_UNSUMMARIZED_MARKER);
  if (markerIdx < 0) return [];
  return text
    .split("\n")
    .slice(markerIdx + 1)
    .map((line) => line.replace(/^-+\s*/, "").trim())
    .filter(Boolean);
}

function normalizeRecapLine(line: string): string {
  return line.replace(/\s+/g, " ").trim();
}

/** 行首项目符号与时间标签（"- [2026/09/08 周二 14:32] " / "[早期]"），事件级去重时剥离。 */
const RECAP_LINE_PREFIX_RE = /^\s*(?:[-*•]\s*)?(?:\[[^\]]*\]\s*)?/;

/** 剥掉项目符号与行首时间标签后的内容键（同一事件换时间戳/换措辞仍可对上）。 */
function recapContentKey(line: string): string {
  return normalizeRecapLine(line.replace(RECAP_LINE_PREFIX_RE, ""));
}

/**
 * 事件级去重阈值（2026-09-08，用当晚事故实录标定）：
 * 同一事件被 LLM 改写/重盖时间戳后再产出（「用户请求12点会议提醒」→
 * 「用户重复请求…被打断未完成」）实测覆盖率 0.79-0.97、重合度 0.59-0.95；
 * 真实不同事件（景甜 vs 刘浩存、睡觉 vs 会议）实测覆盖率 ≤0.73、重合度 ≤0.39。
 * 双条件同时过线才判重复，两个方向都留有余量。
 */
const RECAP_DUP_MIN_COVERAGE = 0.75;
const RECAP_DUP_MIN_DICE = 0.5;
/** 短行不参与模糊去重（避免误并两条本来就不同的短事实）。 */
const RECAP_LINE_DUP_MIN_CHARS = 12;

function recapCharGrams(text: string): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i < text.length - 1; i++) out.add(text.slice(i, i + 2));
  return out;
}

function recapGramStats(a: string, b: string): { coverage: number; dice: number } {
  const ga = recapCharGrams(a);
  const gb = recapCharGrams(b);
  if (ga.size === 0 || gb.size === 0) return { coverage: 0, dice: 0 };
  let shared = 0;
  for (const g of ga) if (gb.has(g)) shared++;
  const minSize = Math.min(ga.size, gb.size);
  return {
    coverage: shared / minSize,
    dice: (2 * shared) / (ga.size + gb.size),
  };
}

/**
 * 追加一行摘要/待归纳行，事件级去重（2026-09-08）：
 * - 精确：剥掉行首时间标签 + 空白归一后完全一致；
 * - 模糊：内容键（剥时间标签）之间的字符覆盖率与重合度双超标（同一事件被
 *   LLM 换措辞/重盖当前时间戳后再次产出——实测「用户请求12点会议提醒」在
 *   00:29/00:30/00:31 被以「重复请求/再次重复请求…」三度入区，诱使 agent
 *   反复重问已办成的事）。
 * 重复时丢弃新行、保留先入行（先入行已在线程内被后续轮次引用过，更稳定）。
 */
function pushRecapLine(target: string[], line: string): void {
  const normalized = normalizeRecapLine(line);
  if (!normalized) return;
  const key = recapContentKey(normalized);
  if (!key) return;
  if (key.length >= RECAP_LINE_DUP_MIN_CHARS) {
    for (const existing of target) {
      const existingKey = recapContentKey(existing);
      if (!existingKey || existingKey.length < RECAP_LINE_DUP_MIN_CHARS) continue;
      if (existingKey === key) return;
      const { coverage, dice } = recapGramStats(existingKey, key);
      if (coverage >= RECAP_DUP_MIN_COVERAGE && dice >= RECAP_DUP_MIN_DICE) return;
    }
  } else {
    if (target.some((existing) => recapContentKey(existing) === key)) return;
  }
  target.push(normalized);
}

/** 去重合并两列 recap 行，返回新数组（保持顺序：前者在前）。导出供回归测试锁定事件级去重契约。 */
export function pushRecapLinesUnique(base: string[], extra: string[]): string[] {
  const merged = [...base];
  for (const line of extra) pushRecapLine(merged, line);
  return merged;
}

/** 把摘要行 + 关键钉行 + 待归纳行渲染为 recap 消息的 content（与 extract 双向兼容）。 */
function buildSessionRecapContent(
  summaryLines: string[],
  pinLines: string[],
  pendingLines: string[],
  now: Date = new Date(),
): string {
  // 事件化分层 + 预算裁剪：摘要行按时间标签（绝对日期优先，旧相对标签兼容）重排
  // （今天 → 昨天 → 本周 → 更早），并按预算裁剪——近层全量、远层压缩。
  const plain = summaryLines.map((l) => l.replace(/^-+\s*/, "").trim()).filter(Boolean);
  const ordered = layerRecapLinesByBudget(plain, SESSION_SUMMARY_MAX_LINES, true, now);
  const parts = [SESSION_RECAP_PREFIX, SESSION_RECAP_TITLE, ...ordered.map((l) => `- ${l}`)];
  // 关键钉区：不可忘事实逐字保留（调用方已按预算合并，此处原样渲染）——
  // 不参与上方 layerRecapLinesByBudget 的时间分层压缩，跨轮折叠不漂移。
  if (pinLines.length > 0) {
    parts.push(SESSION_KEY_PINS_HEADER, ...pinLines.map((l) => `- ${l}`));
  }
  // 待归纳区：原文占位行原样追加（有自己的行数/字符预算，不挤占摘要区）——
  // 在 LLM 增量摘要成功吸收前，这些行保证滑出窗口的内容始终在线程内可见。
  if (pendingLines.length > 0) {
    parts.push(SESSION_UNSUMMARIZED_MARKER, ...pendingLines.map((l) => `- ${l}`));
  }
  return parts.join("\n");
}

/**
 * 待归纳原文行的时间标签：绝对本地时间 `2026/09/04 周四 14:32`。
 * 不再用「今天/昨天」相对词——相对词在折叠时刻冻结落盘，跨天后变成错误时间线索
 * （agent 会把前天的事当昨天/今天的说）；绝对日期任何时刻读取都不会失真。
 */
function formatRecapTimeLabel(at: Date): string {
  return formatRecapStamp(at);
}

/**
 * 从滑出窗口的消息生成待归纳原文行（无 LLM 合并时保证连续性的同步兜底）。
 * 每条 `[绝对时间] user/assistant: 首行内容`，去重；预算裁剪由 buildSessionRecapMessage
 * 统一做（本函数只做单批防爆上限）。语义化精炼由异步增量摘要（enhanceRecap）负责，
 * 成功后这些行会被整体吸收进摘要区并清空。
 */
function minimalRecapLinesFromDropped(
  droppedMessages: ChatCompletionMessageParam[],
  now: Date = new Date(),
): string[] {
  void now;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const msg of droppedMessages) {
    if (msg.role !== "user" && msg.role !== "assistant") continue;
    if (typeof msg.content !== "string") continue;
    const ts = extractMessageTimestamp(msg) ?? new Date();
    const text = stripTimestampText(msg.content);
    if (!text || text.startsWith(SESSION_RECAP_PREFIX)) continue;
    // 2026-10-08：内部帧（[上一轮回复中断…] / [后台任务记录] / 围栏等）不进待归纳区
    // ——它们不是对话事实，落进 recap 后会被 LLM 摘要成「用户/助手说过…」，反向污染上下文。
    if (isInternalFrameText(text)) continue;
    const label = formatRecapTimeLabel(ts);
    const norm = normalizeRecapLine(`[${label}] ${text}`);
    if (!norm || norm.length > SESSION_PENDING_MAX_CHARS) continue;
    if (seen.has(norm)) continue;
    seen.add(norm);
    out.push(norm);
    if (out.length >= SESSION_PENDING_MAX_LINES) break;
  }
  return out;
}

/**
 * 待归纳区预算：保留最旧的行、淘汰最新的超限行。
 * 最旧行在区里等待归纳最久（无摘要器的降级环境下不会再有机会），且早期事实/承诺
 * 一旦丢占位就只剩检索层可查；被淘汰的新行紧邻窗口、时序上最接近当前语境，
 * 且全文在 turn WAL（JSONL）可兜底。LLM 合并成功时整区被吸收清空，正常不会触顶。
 */
function capPendingLines(lines: string[]): string[] {
  const out: string[] = [];
  let totalChars = 0;
  for (const line of lines) {
    if (out.length >= SESSION_PENDING_MAX_LINES || totalChars + line.length > SESSION_PENDING_MAX_CHARS) break;
    out.push(line);
    totalChars += line.length;
  }
  return out;
}

/**
 * 确定性自动钉（零 LLM、高精度兜底）：用户显式「要求记住」的指令轮，在滑出窗口的
 * 瞬间逐字钉入 [关键钉] 区。这类内容用户明说了"不可忘"，不能等 LLM 摘要成功
 * （无 provider / 调用失败时不丢）；LLM 关键钉挑选负责更广的语义覆盖（承诺/约束/
 * 偏好），两者互补。只动 user 消息、取首行、限条数防 bloat；去重由 mergeKeyPins 统一做。
 */
function autoKeyPinLinesFromDropped(droppedMessages: ChatCompletionMessageParam[]): string[] {
  const out: string[] = [];
  for (const msg of droppedMessages) {
    if (out.length >= SESSION_KEY_PIN_AUTO_MAX_PER_BATCH) break;
    if (msg.role !== "user" || typeof msg.content !== "string") continue;
    const text = stripTimestampText(msg.content);
    if (!text || text.startsWith(SESSION_RECAP_PREFIX)) continue;
    if (!KEY_PIN_INSTRUCTION_RE.test(text)) continue;
    const firstLine = text.split("\n").map((s) => s.trim()).find(Boolean) ?? "";
    if (!firstLine) continue;
    const ts = extractMessageTimestamp(msg) ?? new Date();
    let pin = normalizeRecapLine(`[${formatRecapTimeLabel(ts)}] ${firstLine}`);
    if (pin.length > SESSION_KEY_PIN_AUTO_MAX_CHARS) {
      pin = `${pin.slice(0, SESSION_KEY_PIN_AUTO_MAX_CHARS - 3).trimEnd()}...`;
    }
    if (pin) out.push(pin);
  }
  return out;
}

function buildSessionRecapMessage(
  existingRecapLines: string[],
  existingPinLines: string[],
  existingPendingLines: string[],
  droppedMessages: ChatCompletionMessageParam[],
  now: Date = new Date(),
): ChatCompletionMessageParam | null {
  // 增量摘要布局（滑动窗口 + 增量摘要，不做挤占式折叠）：
  // - 摘要区：LLM 增量合并的结果（无 LLM 时为空）
  // - 关键钉区：已有钉 + 本次滑出消息中的显式「要求记住」轮自动钉（只增不改，逐字保留）
  // - 待归纳区：已有未归纳行 + 本次滑出窗口的原文占位行；LLM 合并成功后整体吸收清空
  // 旧的「合并后统一截断到 14 行/1600 字符」会静默挤掉更早的行（等价遗忘），已废弃。
  const mergedPending = pushRecapLinesUnique(existingPendingLines, minimalRecapLinesFromDropped(droppedMessages, now));
  const cappedPending = capPendingLines(mergedPending);
  const mergedPins = mergeKeyPins(existingPinLines, autoKeyPinLinesFromDropped(droppedMessages), {
    maxLines: SESSION_KEY_PINS_MAX_LINES,
    maxChars: SESSION_KEY_PINS_MAX_CHARS,
  });

  const summaryPlain = existingRecapLines
    .map((l) => l.replace(/^-+\s*/, "").trim())
    .filter(Boolean)
    .filter((l) => !l.startsWith(SESSION_UNSUMMARIZED_MARKER) && !l.startsWith(SESSION_KEY_PINS_MARKER));
  const summaryCharCapped: string[] = [];
  let totalChars = SESSION_RECAP_PREFIX.length + SESSION_RECAP_TITLE.length + 2;
  for (const line of summaryPlain) {
    if (totalChars + line.length + 4 > SESSION_SUMMARY_MAX_CHARS) break;
    summaryCharCapped.push(line);
    totalChars += line.length + 4;
  }
  if (summaryCharCapped.length === 0 && cappedPending.length === 0 && mergedPins.length === 0) return null;

  return {
    role: "assistant",
    content: buildSessionRecapContent(summaryCharCapped, mergedPins, cappedPending, now),
  };
}

function separateRecapMessages(messages: ChatCompletionMessageParam[]): {
  body: ChatCompletionMessageParam[];
  recapLines: string[];
  pinLines: string[];
  pendingLines: string[];
} {
  const body: ChatCompletionMessageParam[] = [];
  const recapLines: string[] = [];
  const pinLines: string[] = [];
  const pendingLines: string[] = [];
  for (const msg of messages) {
    if (isSessionRecapMessage(msg)) {
      const content = typeof msg.content === "string" ? msg.content : "";
      recapLines.push(...extractSessionRecapLines(content));
      pinLines.push(...extractSessionKeyPinLines(content));
      pendingLines.push(...extractSessionPendingLines(content));
      continue;
    }
    body.push(msg);
  }
  return { body, recapLines, pinLines, pendingLines };
}

function annotateMessageIfNeeded(
  msg: ChatCompletionMessageParam,
  at: Date,
  now: Date = new Date(),
): ChatCompletionMessageParam {
  // 摘要块（[session-recap]）不打 ts 帧：它没有单一发生时刻，行内自带绝对时间标签。
  // 若在这里兜底打上 `now`，跨天恢复后整块会被标成「刚刚」，模型把历史当现事承接
  // （「昨天聊的，刚开始对话还在说」的时间感知 bug 根源之一）。
  if (isSessionRecapMessage(msg)) {
    // 存量迁移：旧版折叠行带 [今天]/[昨天] 相对标签，折叠时刻计算后冻结落盘，跨天即失真。
    // 用 recap 块上的旧 [ts:] 帧（旧版恢复时打的帧 ≈ 折叠/整理时刻）作锚点，确定性换算
    // 为绝对日期标签；迁移后的内容随下一轮 afterTurnCompleted 落盘固化。
    if (typeof msg.content !== "string") return msg;
    const anchor = extractMessageTimestamp(msg);
    const migrated = migrateRecapContentLabels(msg.content, anchor);
    return migrated === msg.content ? msg : { ...msg, content: migrated };
  }
  if ((msg.role === "user" || msg.role === "assistant") && typeof msg.content === "string") {
    return { ...msg, content: annotateTimeframe(msg.content, at, now) };
  }
  return msg;
}

/**
 * 恢复/落盘补帧专用：只用消息自身携带的时间戳刷新 ts 帧。
 *
 * 没有时间戳的历史消息（客户端桥灌入的存量、极旧数据）宁可不打帧，也**不能**
 * 兜底打 `now`——打上 now 等于把历史伪装成「刚刚」，模型会把旧对话当现事承接：
 * 实测（2026-09-13）昨天的错误回答被整体盖成 just now 后，模型把「刘浩存在成都」
 * 当成当前对话已确立的事实复读，连 search_web 都不调。与 recap 块的修法同哲学：
 * 未知时间 ≠ 当前时间。
 */
function annotateMessageWithOwnTimeOrKeep(
  msg: ChatCompletionMessageParam,
  now: Date = new Date(),
): ChatCompletionMessageParam {
  const at = extractMessageTimestamp(msg);
  if (!at) return msg;
  return annotateMessageIfNeeded(msg, at, now);
}

/**
 * 从根源折叠「已完成的 tool_call 链」，防止串台。
 *
 * 根源问题：OpenAI 协议里 tool 消息没有「轮次边界」。一轮工具调用完成后，thread 里留下
 *   assistant(tool_calls) → tool → tool → assistant(content)
 * 下一轮 LLM 看到这些 raw tool 结果，会把它们当成「刚发生的事」去承接，导致回复开头出现
 * 「哈哈被你看穿了，我刚查 XX 没查到」之类的串台。
 *
 * 旧方案（已废弃）：closeIncompleteToolTurns 在下一轮 user 消息 push 后才插入 system 分隔提示，
 * 靠 prompt「恳求」LLM 别串台——治标不治本，raw tool 结果仍在 thread 里。
 *
 * 新方案（根源）：在轮次完成的瞬间（afterTurnCompleted），把已完成的 tool_call 链折叠成
 * 单条干净的 assistant 消息，彻底移除 tool 角色消息。LLM 下一轮根本看不到 raw tool 结果，
 * 无法串台。折叠时保留最终 assistant 回复的正文与时间戳，不丢失语义。
 *
 * 折叠规则：
 *   assistant(tool_calls, 无content) → tool* → assistant(content)
 *   压缩为：
 *   assistant(content)
 *
 * 未完成的 tool_call 链（无后续 assistant(content)，如被新消息打断）：折叠为单条 assistant
 * 占位消息，明确标注「上一轮工具调用未完成」，避免 LLM 把孤立的 tool_calls 当成当前轮语境。
 *
 * 幂等：已是普通 assistant（无 tool_calls）的消息不会被重复处理。
 */
function hasToolCalls(msg: ChatCompletionMessageParam): boolean {
  const toolCalls = (msg as { tool_calls?: unknown }).tool_calls;
  return Array.isArray(toolCalls) && toolCalls.length > 0;
}

/**
 * 未完成工具链的事实化占位文本（2026-09-08）：列出该链已调用的工具与结果摘要，
 * 并显式约束后续模型不得把本轮当作用户重复请求或悬空未办事项。
 */
function buildInterruptedToolChainNotice(
  msgs: ChatCompletionMessageParam[],
  start: number,
  end: number,
): string {
  const toolNames: string[] = [];
  const resultSnippets: string[] = [];
  for (let k = start; k < end && k < msgs.length; k++) {
    const m = msgs[k];
    if (!m) continue;
    if (m.role === "assistant" && hasToolCalls(m)) {
      for (const tc of (m as { tool_calls?: Array<{ function?: { name?: string } }> }).tool_calls ?? []) {
        const name = tc?.function?.name?.trim();
        if (name) toolNames.push(name);
      }
    } else if (m.role === "tool") {
      const raw = typeof m.content === "string" ? m.content.trim() : "";
      if (raw) {
        // 2026-10-08 根源修复：tool 消息首行恒为 `[不可信内容围栏 source=tool:x]`
        // （untrusted-content.ts），此前直接摘录，把围栏头抄进了占位文本——
        // 这就是「[上一轮回复中断…[不可信内容围栏…]」黏在同一条气泡里的成因。
        // 摘录前先剥掉围栏标签外壳（保留块内真实数据——那是「已办了什么」的事实），
        // 只留真正的工具数据。
        const cleaned = stripInternalFrameMarkup(raw).replace(/\s+/g, " ").trim();
        const firstLine = cleaned.split("\n")[0]?.trim() ?? "";
        if (firstLine && !isInternalFrameText(firstLine)) {
          resultSnippets.push(firstLine.slice(0, 80));
        }
      }
    }
  }
  const parts: string[] = ["[上一轮回复中断：最终回复未生成完整。"];
  if (toolNames.length > 0) {
    parts.push(`期间已调用工具 ${toolNames.join("、")}（共 ${toolNames.length} 次）`);
    if (resultSnippets.length > 0) {
      parts.push(`，收到结果：${resultSnippets.join("；")}。`);
    } else {
      parts.push("（结果未回传）。");
    }
    parts.push("这些动作可能已实际生效——引用本事项前先查证实际状态，");
  } else {
    parts.push("未产生任何工具动作。");
  }
  // 2026-10-08：显式禁复述。占位帧以 assistant 角色待在线程里，模型会把它当成
  // 「自己上一轮说过的话」原样复读给用户（手机端气泡事故的直接成因）。出口净化
  // （stream-chat-helpers / ToolResultProcessor）只能挡逐字复读，挡不住改写转述，
  // 因此这里在帧文本内部再钉一条硬约束。
  parts.push(
    "不要把它当作用户重复请求或未处理的悬空事项重新提起。",
    "这是系统内部记录：禁止原样或改写后复述给用户，也不要提及它的存在。]",
  );
  return parts.join("");
}

/**
 * 移除会话中间（index > 0）的 transient system 消息，只保留 msgs[0] 的主 system prompt。
 * tool loop 会把「工具调用原则」等临时指令 push 进 messages（即 thread 数组），
 * 若不清理会逐轮累积，污染后续轮次的对话历史，导致 LLM 丢失对前文的感知。
 */
function removeTransientSystemMessages(msgs: ChatCompletionMessageParam[]): void {
  if (msgs.length <= 1) return;
  let write = 1;
  for (let read = 1; read < msgs.length; read++) {
    if (msgs[read].role === "system") continue;
    msgs[write++] = msgs[read];
  }
  msgs.length = write;
}

export function foldCompletedToolChains(msgs: ChatCompletionMessageParam[]): boolean {
  if (msgs.length < 2) return false;
  const result: ChatCompletionMessageParam[] = [];
  let i = 0;
  let changed = false;

  while (i < msgs.length) {
    const msg = msgs[i];

    // 检测 assistant(tool_calls) 起始，折叠整条工具链（含多轮）为单条最终 assistant(content)
    if (msg && msg.role === "assistant" && hasToolCalls(msg)) {
      let j = i;
      let finalAssistant: ChatCompletionMessageParam | null = null;

      // 向前扫描：跳过连续的 assistant(tool_calls) → tool* 段，直到最终 assistant(content) 或链被打断
      while (j < msgs.length) {
        const m = msgs[j];
        if (m.role === "assistant") {
          if (hasToolCalls(m)) {
            j++;
            while (j < msgs.length && msgs[j].role === "tool") {
              j++;
            }
            continue;
          }
          finalAssistant = m;
          j++;
          break;
        }
        break; // 遇到非 assistant 消息（如新的 user）→ 链被打断
      }

      if (finalAssistant) {
        const content =
          typeof finalAssistant.content === "string" ? finalAssistant.content.trim() : "";
        if (content) {
          result.push(finalAssistant);
        } else {
          result.push({
            role: "assistant",
            content: annotateTimeframe(
              "[上一轮工具调用已完成但未生成可见回复]",
              new Date(),
              new Date(),
            ),
          });
        }
        changed = true;
        i = j;
        continue;
      }

      // 未完成的 tool_call 链：assistant(tool_calls) → tool*（无后续 assistant content）
      // 2026-09-08：占位符必须携带已执行的工具事实——空话式「未生成完整回复」会
      // 被 recap 记成「用户重复请求…未完成」，诱导 agent 反复重问已办成的事
      // （实测：两条提醒已创建成功，agent 却在后续轮次反复追问「要提前多久叫你」）。
      result.push({
        role: "assistant",
        content: annotateTimeframe(
          buildInterruptedToolChainNotice(msgs, i, j),
          new Date(),
          new Date(),
        ),
      });
      changed = true;
      i = j;
      continue;
    }

    result.push(msg);
    i++;
  }

  if (changed) {
    msgs.length = 0;
    msgs.push(...result);
  }
  return changed;
}

function annotateUserContentIfString(
  content: ChatCompletionMessageParam["content"],
  at: Date,
  now: Date = new Date(),
): string | ChatCompletionContentPart[] {
  if (typeof content === "string") return annotateTimeframe(content, at, now);
  if (Array.isArray(content) && content.length > 0) {
    // 多模态：仅在第一个 text part 注入时间戳，保留 image_url 等
    const parts: ChatCompletionContentPart[] = content.map((part, idx) => {
      if (idx === 0 && part && typeof part === "object" && (part as { type?: string }).type === "text") {
        const text = (part as { text?: string }).text ?? "";
        return { ...(part as object), type: "text", text: annotateTimeframe(text, at, now) } as ChatCompletionContentPart;
      }
      return part as ChatCompletionContentPart;
    });
    return parts;
  }
  return "";
}

export class ChatThreadStore {
  private readonly history = new Map<string, ChatCompletionMessageParam[]>();

  /**
   * 滚动摘要增强器（LLM 增量摘要）——recap 的唯一生成者。
   * 为 null 时仅保留已有 recap 行（不生成新摘要），不影响对话主链路。
   * 通过 setRecapSummarizer 注入（bootstrap 装配）。
   */
  private recapSummarizer: RecapSummarizer | null = null;

  /**
   * 每个 session 的增强序号：trim 触发增强时递增。
   * 增强完成回写前检查序号是否仍为触发值，防止旧结果覆盖期间新生成的 recap。
   */
  private readonly recapEnhanceSeq = new Map<string, number>();

  /** 注入滚动摘要增强器（null 关闭）。 */
  setRecapSummarizer(summarizer: RecapSummarizer | null): void {
    this.recapSummarizer = summarizer;
  }

  /**
   * 把「滑出窗口的历史消息 + 待归纳原文行」异步交给 LLM 增量摘要合并。
   * - 不阻塞 trimThread 主链路（fire-and-forget）
   * - 失败静默：线程内保留摘要区/关键钉区原状 + [unsummarized] 待归纳区原文，不静默丢内容
   * - seq 守卫：期间若又有新 trim 触发增强，丢弃本次旧结果（其对应的待归纳行仍在区里，
   *   由下一次合并吸收）
   *
   * 增量合并契约（2026-09-05 漂移修复）：summarizer 只为「待归纳原文 + 新对话」产新行，
   * 已有 recap 行（含关键钉）在此原样保留、不经 LLM 重发（本地合并 + 精确去重）。此前 LLM 全量重发
   * recap，小模型改写会把事实逐步漂移（实测"七点提醒我开线上会议"在多次折叠重写后
   * 变成"七点半线上会议"，错误随每次折叠复利传播并注入后续上下文）。
   *
   * 关键钉（2026-09-07）：summarizer 可额外返回新钉（RecapSummaryResult.pins 或
   * `[关键钉]` 节解析）；已有钉逐字保留，新钉经 mergeKeyPins 去重合并（超预算淘汰最旧）。
   */
  private async enhanceRecap(
    sessionId: string,
    existingLines: string[],
    pinLines: string[],
    pendingLines: string[],
    droppedMessages: ChatCompletionMessageParam[],
  ): Promise<void> {
    const summarizer = this.recapSummarizer;
    if (!summarizer || !sessionId) return;
    // 增量合并输入 = 已有摘要行 + 待归纳原文行 + 本次溢出批次；无新素材时不空跑
    if (pendingLines.length === 0 && droppedMessages.length === 0) return;
    const seq = (this.recapEnhanceSeq.get(sessionId) ?? 0) + 1;
    this.recapEnhanceSeq.set(sessionId, seq);
    try {
      // 已有摘要行/关键钉与待归纳原文行分字段传递：前者仅供去重参考（禁止 LLM 复述），
      // 后者是必须被吸收的摘要素材（待归纳区在 apply 成功后会被清空）。
      const result = await summarizer({
        existingLines,
        pinLines,
        pendingLines,
        droppedMessages,
      });
      const normalized = normalizeRecapSummaryResult(result);
      if (!normalized || (normalized.lines.length === 0 && normalized.pins.length === 0)) return;
      // 期间又发生了 trim → 摘要已有更新版本，丢弃本次结果，避免覆盖
      if (this.recapEnhanceSeq.get(sessionId) !== seq) return;
      const merged = [...existingLines];
      for (const line of normalized.lines) pushRecapLine(merged, line);
      const mergedPins = mergeKeyPins(pinLines, normalized.pins, {
        maxLines: SESSION_KEY_PINS_MAX_LINES,
        maxChars: SESSION_KEY_PINS_MAX_CHARS,
      });
      if (merged.length === existingLines.length && mergedPins.length === pinLines.length) {
        return; // 新行/新钉全部与已有内容重复
      }
      this.applyEnhancedRecap(sessionId, merged, mergedPins);
    } catch {
      // 静默失败：保留同步生成的已有摘要行、关键钉与待归纳区
    }
  }

  private applyEnhancedRecap(sessionId: string, lines: string[], pins: string[]): void {
    const msgs = this.history.get(sessionId);
    if (!msgs) return;
    // 合并成功：摘要区替换为精炼结果（关键钉原样并入），待归纳区清空（其内容已被本次合并吸收）。
    // seq 守卫保证 apply 时线程内待归纳区与捕获时刻一致（期间有新 fold 会 bump seq 走丢弃分支）。
    const recapMsg: ChatCompletionMessageParam = {
      role: "assistant",
      content: buildSessionRecapContent(lines, pins, []),
    };
    const index = msgs.findIndex(isSessionRecapMessage);
    if (index >= 0) {
      msgs[index] = recapMsg;
    } else {
      // 无同步 recap 消息（首次压缩、此前无历史 recap）：在 system 之后插入，
      // 保证 LLM 摘要对后续轮次可见。
      msgs.splice(1, 0, recapMsg);
    }
    this.persistence?.scheduleSave(sessionId, msgs);
  }

  /**
   * 可选的「会话首条 system」提供者。
   *
   * 设计目的：让 RuntimeKernel minimal 模式下，sessionSys（薄身份 system）由 thread-store
   * 在会话首次创建时一次性写入 msgs[0]，provider 后续轮次不再覆盖——
   * 真正实现"首轮注入一次"，而不是"每轮重发但靠 prefix cache"。
   *
   * 协议：回调返回非空字符串时，thread-store 在新建会话时用它作为 msgs[0]；
   * 返回 null/undefined 时回退 defaultSystemPrompt（旧行为）。
   *
   * 模型无关性：该机制只影响 msgs[0] 内容，与具体 provider 模型解耦——
   * OpenAI / Kimi / DeepSeek / Claude 等所有 OpenAI-compatible provider 都遵循
   * "msgs[0] = system message" 的统一协议。
   */
  private sessionSystemProvider: (() => string | null | undefined) | null = null;

  constructor(private readonly persistence: ChatThreadPersistence | null) {}

  /**
   * 注入会话首条 system 提供者（通常由 bootstrap 调用，传入 RuntimeKernel.buildSessionSystem）。
   * 传 null 解除注入，回退 defaultSystemPrompt 行为。
   */
  setSessionSystemProvider(provider: (() => string | null | undefined) | null): void {
    this.sessionSystemProvider = provider;
  }

  clearSession(sessionId: string): void {
    this.history.delete(sessionId);
    this.persistence?.deleteSession(sessionId);
  }

  thread(sessionId: string, defaultSystemPrompt: string): ChatCompletionMessageParam[] {
    const sessionSys = this.sessionSystemProvider?.() ?? null;
    let t = this.history.get(sessionId);
    if (!t) {
      t = adoptLegacyMasterDelegateThread(this.history, sessionId);
    }
    if (!t) {
      // master 委派层删除后的所有权迁移：裸 actorId 主线程缺失时从 master: 收养
      t = adoptPrimaryThreadFromMasterThread(this.history, sessionId);
    }
    if (!t && this.persistence) {
      t = this.restoreThreadFromPersistence(
        sessionId,
        sessionSys ?? defaultSystemPrompt,
      ) ?? undefined;
    }
    if (!t && this.persistence && !sessionId.includes(":")) {
      // 持久层同规则收养：裸会话无落盘数据但存量 master:{actorId} 有 → 复制恢复
      t = this.restoreThreadFromPersistence(
        masterChatSessionId(sessionId),
        sessionSys ?? defaultSystemPrompt,
      ) ?? undefined;
      if (t) this.history.set(sessionId, t);
    }
    if (!t) {
      t = [{ role: "system", content: sessionSys ?? defaultSystemPrompt }];
      this.history.set(sessionId, t);
    }
    // 防串台已根源解决：afterTurnCompleted 在轮次完成时调用 foldCompletedToolChains
    // 移除 raw tool 结果。这里无需再做事后隔断。
    return t;
  }

  /**
   * 只读窥线程（GET /api/chat-data/history 用）：内存 → 收养 → 持久层恢复，
   * 全部未命中返回 null，**不创建空线程**（GET 必须无副作用，避免凭空建上下文）。
   * 恢复路径与 thread() 同源（restoreThreadFromPersistence 内部会缓存进内存，
   * 与下一次真实对话的恢复行为一致）。
   */
  peekThread(sessionId: string): ChatCompletionMessageParam[] | null {
    let t = this.history.get(sessionId);
    if (!t) {
      t = adoptLegacyMasterDelegateThread(this.history, sessionId);
    }
    if (!t) {
      t = adoptPrimaryThreadFromMasterThread(this.history, sessionId);
    }
    if (!t && this.persistence) {
      t = this.restoreThreadFromPersistence(sessionId, this.sessionSystemProvider?.() ?? "") ?? undefined;
    }
    return t ?? null;
  }

  /**
   * 按持久层数据恢复一个会话线程（system 头 + 时间戳补帧 + 落盘 clientMessageId 回灌）。
   * @returns 恢复出的线程（已存入内存），持久层没数据时 null
   */
  private restoreThreadFromPersistence(
    sessionId: string,
    systemPrompt: string,
  ): ChatCompletionMessageParam[] | null {
    const restored = this.persistence?.loadRestoredMessages(sessionId);
    if (!restored?.length) return null;
    const now = new Date();
    const t: ChatCompletionMessageParam[] = [
      { role: "system", content: systemPrompt },
      ...repairKimiAssistantToolCallReasoning(
        compactValidChatMessages(
          restored.map((msg) => annotateMessageWithOwnTimeOrKeep(msg, now)),
        ),
      ),
    ];
    // 顺序不能反：先把落盘字段重新灌回反向索引，再剥掉字段。两者都必须在**最终**线程
    // 对象上做（索引按对象身份索引，灌到克隆前的中间产物等于没灌）。
    absorbPersistedClientIds(t);
    this.history.set(sessionId, t);
    return t;
  }

  /**
   * 变更类操作（按 clientMessageId 删除/编辑/定位）前取线程。
   *
   * 为什么需要它：{@link thread} 的惰性恢复只在「读线程」时发生，而删除/编辑入口
   * 直接读 `this.history`——进程刚重启（或该会话本进程还没聊过）时线程不在内存，
   * 这些操作会一律以 `session_not_found` 静默失败，用户侧表现为「点了删除没反应」。
   * 这里先按持久层恢复一次再操作。
   *
   * 与 {@link thread} 的区别：持久层也没数据时返回 null，**不**给未知会话凭空建
   * 一个空线程（一次删除请求不该产生上下文）。
   */
  private threadForClientIdOperation(
    sessionId: string,
  ): ChatCompletionMessageParam[] | null {
    const resident = this.history.get(sessionId);
    if (resident) return resident;
    const persistence = this.persistence;
    if (!persistence) return null;
    const hasPersisted =
      persistence.hasPersistedMessages(sessionId) ||
      (!sessionId.includes(":") &&
        persistence.hasPersistedMessages(masterChatSessionId(sessionId)));
    if (!hasPersisted) return null;
    // 恢复逻辑复用 thread()（含 master:{actorId} 存量收养 + clientMessageId 回灌），
    // 不另写一套，避免两处漂移。
    return this.thread(sessionId, this.sessionSystemProvider?.() ?? "");
  }

  trimThread(msgs: ChatCompletionMessageParam[], maxMessages?: number, sessionId?: string): void {
    const compacted = sanitizeToolCallMessageChain(compactValidChatMessages(msgs), "[chat-thread-store]");
    msgs.length = 0;
    msgs.push(...repairKimiAssistantToolCallReasoning(compacted));

    const config = {
      ...DEFAULT_SMART_TRIM_CONFIG,
      maxMessages: maxMessages ?? DEFAULT_SMART_TRIM_CONFIG.maxMessages,
    };

    // 优先滑动窗口切分：保留「最近 N 条」原文，窗口外走「增量摘要」（不做挤占式折叠）。
    // 2026-09-05 策略：旧「今天+昨天全文」窗口会让长会话整天背着大历史
    // （受 MAX_CONTEXT_TOKENS 兜底前最多 24 条原样重发）。
    // 记忆不丢的三层保障（与窗口大小无关）：
    //   1) 每轮 live turn 在 TurnLifecycle.finalizeTurn 已完成长期记忆种植
    //      （turn WAL / daily journal / 统一整合链路 / epitome），输入是轮次文本本身；
    //   2) 全量轮次原文在 turn WAL（JSONL，含 userText/assistantText）；daily journal
    //      存首句 + 正则命中行（事实/偏好/承诺），当日词法召回（journalRecall）可用；
    //   3) 窗口外内容先进 [unsummarized] 待归纳区（原文占位、始终在线程内可见），
    //      再由 LLM 增量摘要逐批吸收进摘要区——归纳成功前不丢，归纳后语义保留。
    if (this.trimByRecentWindow(msgs, config, sessionId)) {
      return;
    }

    // 滑动窗口+摘要后仍超 token 上限（近期消息太大），降级到 token 维度裁剪
    if (msgs.length <= 1 + config.maxMessages) {
      const totalTokens = msgs.reduce((sum, msg) => sum + estimateMessageTokens(msg), 0);
      if (totalTokens <= config.maxTokens) return;
      this.smartTrimByTokens(msgs, config, sessionId);
      return;
    }

    // 消息条数也超限（极少触发，今天消息爆量）：保留最近 N 条 + 摘要
    const sys = msgs[0];
    const separated = separateRecapMessages(msgs.slice(1));
    const trimResult = trimPreservingToolPairs(separated.body, config.maxMessages);
    const recap = buildSessionRecapMessage(
      separated.recapLines,
      separated.pinLines,
      separated.pendingLines,
      trimResult.dropped,
    );
    msgs.length = 0;
    msgs.push(sys);
    if (recap) msgs.push(recap);
    msgs.push(...trimResult.kept);

    // 溢出消息异步交给 LLM 增量摘要合并（不阻塞主链路）
    this.enhanceRecap(sessionId ?? "", separated.recapLines, separated.pinLines, separated.pendingLines, trimResult.dropped).catch(() => {});

    const totalTokens = msgs.reduce((sum, msg) => sum + estimateMessageTokens(msg), 0);
    if (totalTokens > config.maxTokens) {
      this.smartTrimByTokens(msgs, config, sessionId);
    }
  }

  /**
   * 滑动窗口 + 增量摘要（2026-09-05，替代旧 trimByDayBoundary 的「今天+昨天全文」）：
   * - 最近 RECENT_WINDOW_MESSAGES 条原样保留（含工具链成对保护）
   * - 更早的消息（含当天早些时候）滑出窗口：先进 [unsummarized] 待归纳区（原文占位，
   *   始终可见），LLM 增量摘要成功吸收后转入摘要区并清空待归纳区
   * - 合并按 RECAP_BATCH_MESSAGES 批次触发：窗口满 + 攒够一批才合并一次，
   *   避免摘要每轮重写导致 prefix cache 每轮全断
   *
   * 记忆连续性保障：滑出窗口的轮次，其长期记忆种植在 finalizeTurn 已完成（与线程无关），
   * 全量原文在 turn WAL，摘要合并前原文占位行始终在线程内。
   *
   * @returns true 表示已成功按窗口切分（无需上层再裁剪）；
   *          false 表示近期消息已使 token 超限，上层需降级到 smartTrimByTokens
   */
  private trimByRecentWindow(
    msgs: ChatCompletionMessageParam[],
    config: typeof DEFAULT_SMART_TRIM_CONFIG,
    sessionId?: string,
  ): boolean {
    if (msgs.length <= 1) return true; // 仅 system，无需压缩

    const sys = msgs[0];
    const separated = separateRecapMessages(msgs.slice(1));
    const body = separated.body;
    if (body.length === 0) return true;

    // 未超「窗口 + 合并批」阈值：不动摘要，仅做 token 超限判定（超限交上层 smartTrimByTokens）
    const foldThreshold = RECENT_WINDOW_MESSAGES + RECAP_BATCH_MESSAGES;
    if (body.length <= foldThreshold) {
      const totalTokens =
        estimateMessageTokens(sys) +
        (separated.recapLines.length + separated.pinLines.length + separated.pendingLines.length) *
          RECAP_LINE_TOKEN_ESTIMATE +
        body.reduce((s, m) => s + estimateMessageTokens(m), 0);
      return totalTokens <= config.maxTokens;
    }

    // 最旧的 (body.length - RECENT_WINDOW_MESSAGES) 条滑出窗口进待归纳区；
    // 稳态下窗口保持 RECENT_WINDOW_MESSAGES，摘要约每 RECAP_BATCH_MESSAGES 轮合并一次
    const foldCount = body.length - RECENT_WINDOW_MESSAGES;
    const foldedMessages = body.slice(0, foldCount);
    const keptMessages = body.slice(foldCount);

    const recap = buildSessionRecapMessage(
      separated.recapLines,
      separated.pinLines,
      separated.pendingLines,
      foldedMessages,
    );

    // 滑出窗口的内容异步交给 LLM 增量摘要合并（不阻塞主链路）。
    // 失败/无摘要器时待归纳区原文行仍在线程内，不会静默丢失。
    this.enhanceRecap(sessionId ?? "", separated.recapLines, separated.pinLines, separated.pendingLines, foldedMessages).catch(() => {});

    // 重组后 token 检查：若近期窗口消息本身就超限，让上层走 smartTrimByTokens
    const sysTokens = estimateMessageTokens(sys);
    const recapTokens = recap ? estimateMessageTokens(recap) : 0;
    const keptTokens = keptMessages.reduce((s, m) => s + estimateMessageTokens(m), 0);
    if (sysTokens + recapTokens + keptTokens > config.maxTokens) {
      return false;
    }

    msgs.length = 0;
    msgs.push(sys);
    if (recap) msgs.push(recap);
    msgs.push(
      ...sanitizeToolCallMessageChain(keptMessages, "[chat-thread-store-window]"),
    );
    return true;
  }

  /**
   * 条内压缩：把「非最近 preserveRecentTurns 轮」的超长 assistant 消息压到 maxChars。
   *
   * 背景：历史窗口 token 预算固定（MAX_CONTEXT_TOKENS），超预算时旧逻辑只会
   * 「整条 drop 进 recap」——长 assistant 回复（LLM 已消费过的输出）占预算越多，
   * 被 drop 的轮次越多，信息断层越严重，还白触发一次 LLM 滚动摘要（输出也耗 token）。
   *
   * 本函数在 drop 之前先压缩超长 assistant 消息（保留头尾、标记已压缩），
   * 让同一预算保留约 2 倍轮次；仍超预算才走整条 drop。
   * 安全约束：
   * - 只动 assistant 纯文本；user / tool / 多模态 content 一律不碰；
   * - 最近 preserveRecentTurns 轮全量保留（LLM 追赶问需要完整衔接，防幻觉）；
   * - 已压缩（带 [已压缩 前缀）与 recap 消息跳过；
   * - 防过度压缩守卫（2026-08）：承诺/结论轮不压缩（与窗口 pin 同一保护类，
   *   "答应过的事"被腰斩比占 token 危害大）；含代码围栏的消息不压缩
   *   （代码被头尾截断后完全不可用，用户"再发一下那段代码"时模型只能看到残骸）；
   * - 切点对齐句子边界（见 compressAssistantTextForWindow），压缩无收益则保持原文。
   */
  private compressOversizedAssistantMessages(
    msgs: ChatCompletionMessageParam[],
    maxChars: number,
    preserveRecentTurns: number = CHAT_COMPRESS_PRESERVE_RECENT_TURNS,
  ): void {
    if (!Number.isFinite(maxChars) || maxChars < 200 || msgs.length <= 4) return;
    const recentStart = Math.max(1, msgs.length - preserveRecentTurns * 2);
    for (let i = 1; i < recentStart; i++) {
      const msg = msgs[i];
      if (msg.role !== "assistant" || typeof msg.content !== "string") continue;
      const text = msg.content;
      if (text.length <= maxChars) continue;
      if (text.includes("[session-recap]")) continue; // recap 内容不动
      if (/^\[已压缩/.test(text)) continue; // 已压缩过（幂等）
      if (AGENT_COMMITMENT_RE.test(text)) continue; // 承诺/结论轮不压缩
      if (text.includes("```")) continue; // 含代码块的消息不压缩
      const compressed = compressAssistantTextForWindow(text, maxChars);
      if (!compressed) continue;
      msg.content = compressed;
    }
  }

  private smartTrimByTokens(
    msgs: ChatCompletionMessageParam[],
    config: typeof DEFAULT_SMART_TRIM_CONFIG,
    sessionId?: string,
  ): void {
    if (msgs.length <= 2) return;
    // 先做条内压缩（非最近 2 轮的超长 assistant 消息压到阈值），释放预算后再决定丢哪些组。
    // 纯规则、同步、零 LLM 调用；压缩后总 token 仍超才走整条 drop + recap。
    this.compressOversizedAssistantMessages(msgs, CHAT_LONG_ASSISTANT_MAX_CHARS);
    const sys = msgs[0];
    const separated = separateRecapMessages(msgs.slice(1));
    const rest = separated.body;
    const recentMessages = rest.slice(-config.preserveRecentTurns * 2);
    const olderMessages = rest.slice(0, -config.preserveRecentTurns * 2);
    let currentTokens =
      estimateMessageTokens(sys) + recentMessages.reduce((sum, msg) => sum + estimateMessageTokens(msg), 0);

    const olderGroups = groupMessagesPreservingToolPairs(olderMessages);
    const preservedOlder: ChatCompletionMessageParam[] = [];
    for (let g = olderGroups.length - 1; g >= 0 && currentTokens < config.maxTokens; g--) {
      const group = olderGroups[g];
      const groupTokens = group.reduce((sum, msg) => sum + estimateMessageTokens(msg), 0);
      if (currentTokens + groupTokens > config.maxTokens) continue;
      preservedOlder.unshift(...group);
      currentTokens += groupTokens;
    }

    const droppedMessages = olderMessages.filter((msg) => !preservedOlder.includes(msg));
    const recap = buildSessionRecapMessage(
      separated.recapLines,
      separated.pinLines,
      separated.pendingLines,
      droppedMessages,
    );

    // 溢出消息异步交给 LLM 增量摘要合并（不阻塞主链路；失败保留待归纳区原文）
    if (droppedMessages.length > 0 || separated.pendingLines.length > 0) {
      this.enhanceRecap(sessionId ?? "", separated.recapLines, separated.pinLines, separated.pendingLines, droppedMessages).catch(() => {});
    }

    msgs.length = 0;
    msgs.push(sys);
    if (recap) msgs.push(recap);
    msgs.push(
      ...sanitizeToolCallMessageChain([...preservedOlder, ...recentMessages], "[chat-thread-store-trim]"),
    );
  }

  appendTurn(
    sessionId: string,
    defaultSystemPrompt: string,
    userTurn: ChatUserTurn,
    assistantText: string,
    maxThreadMessages?: number,
    now: Date = new Date(),
    clientMessageId?: string,
    model?: string,
  ): void {
    const trimmed = stripProtocolMarkersForThread(assistantText.trim());
    if (!trimmed) return;
    const msgs = this.thread(sessionId, defaultSystemPrompt);
    // turn 级幂等（2026-10-09 发言模型 I5）：同一 clientMessageId 的轮次已经落库
    // （user 消息带该 id，且其后已有 assistant 回复）→ 不再重复追加。
    // 落库层是最后一道闸：即使入口幂等漏网（老客户端无 id、进程重启丢内存态），
    // 上下文里也不会出现同一句话的两轮，杜绝"重复回复"污染后续对话与记忆。
    if (this.isTurnAlreadyPersisted(msgs, clientMessageId)) return;
    const userAt = new Date(now.getTime());
    const assistantAt = new Date(now.getTime() + 1); // 1ms 偏移，避免同毫秒时排序并列
    const incomingUserText = userTurn.text;
    // 兼容两种调用姿势：
    // 1. Provider 已在 streamCompletion 里把 user 消息 push 进 msgs（此时最后一条就是 user）→ 只刷新时间戳
    // 2. Plan-Execute 等场景下没有 push → 新增一条带时间戳的 user 消息
    const last = msgs[msgs.length - 1];
    if (last && last.role === "user" && userMessageTextMatches(last, incomingUserText)) {
      const next = {
        ...last,
        content: annotateUserContentIfString(last.content, userAt, now),
      } as ChatCompletionMessageParam;
      tagUserMessageClientId(next, clientMessageId ?? readUserMessageClientId(last));
      msgs[msgs.length - 1] = next;
    } else {
      const userMsg = {
        role: "user",
        content: annotateUserContentIfString(openAiUserContentFromTurn(userTurn, { model }), userAt, now),
      } as ChatCompletionMessageParam;
      tagUserMessageClientId(userMsg, clientMessageId);
      msgs.push(userMsg);
    }
    msgs.push({ role: "assistant", content: annotateTimeframe(trimmed, assistantAt, now) });
    this.trimThread(msgs, maxThreadMessages, sessionId);
    this.persistence?.scheduleSave(sessionId, msgs);
  }

  /**
   * turn 级幂等判定（2026-10-09 发言模型 I5）：该 clientMessageId 的轮次是否已落库。
   *
   * 判定口径 = 线程里存在一条带该 clientMessageId 的 user 消息，**且其后已经跟过
   * assistant 回复**（只有 user 没回复 = 上一轮中途失败，允许重试续写，不算重复）。
   */
  private isTurnAlreadyPersisted(
    msgs: ChatCompletionMessageParam[],
    clientMessageId?: string,
  ): boolean {
    const id = clientMessageId?.trim();
    if (!id) return false;
    for (let i = msgs.length - 1; i >= 0; i--) {
      const msg = msgs[i];
      if (!msg || msg.role !== "user") continue;
      if (readUserMessageClientId(msg) !== id) continue;
      for (let j = i + 1; j < msgs.length; j++) {
        if (msgs[j]?.role === "assistant") return true;
      }
      return false;
    }
    return false;
  }

  /**
   * 后台任务的单条事实记录（2026-09-08）：assistant 角色、带时间戳帧。
   * 单条消息而非 user/assistant 对——见 AbstractChatProvider.appendTaskRecord 注释。
   */
  appendTaskRecord(
    sessionId: string,
    defaultSystemPrompt: string,
    goal: string,
    resultText: string,
    maxThreadMessages?: number,
  ): void {
    const trimmedResult = resultText.trim();
    if (!trimmedResult && !goal.trim()) return;
    const msgs = this.thread(sessionId, defaultSystemPrompt);
    const now = new Date();
    const goalLine = goal.replace(/\s+/g, " ").trim().slice(0, 200);
    const content = `[后台任务记录] 目标：${goalLine || "未命名任务"}\n结果：${trimmedResult || "（无结果）"}`;
    msgs.push({ role: "assistant", content: annotateTimeframe(content, now, now) });
    this.trimThread(msgs, maxThreadMessages, sessionId);
    this.persistence?.scheduleSave(sessionId, msgs);
  }

  appendAssistantContinuation(
    sessionId: string,
    clientMessageId: string | undefined,
    continuation: string,
    maxThreadMessages?: number,
  ): string | null {
    const trimmed = continuation.trim();
    if (!trimmed) return null;
    const msgs = this.history.get(sessionId);
    if (!msgs) return null;

    let assistantIndex = -1;
    if (clientMessageId) {
      const found = findUserMessageByClientId(msgs, clientMessageId);
      if (found) {
        for (let i = found.index + 1; i < msgs.length; i++) {
          const msg = msgs[i];
          if (!msg) continue;
          if (msg.role === "user") break;
          if (msg.role === "assistant" && typeof msg.content === "string") {
            assistantIndex = i;
            break;
          }
        }
      }
    }

    if (assistantIndex < 0) {
      for (let i = msgs.length - 1; i >= 0; i--) {
        const msg = msgs[i];
        if (msg?.role === "assistant" && typeof msg.content === "string") {
          assistantIndex = i;
          break;
        }
      }
    }

    if (assistantIndex < 0) return null;
    const msg = msgs[assistantIndex];
    if (!msg || msg.role !== "assistant" || typeof msg.content !== "string") return null;

    const parsed = readMessageTimestampPrefix(msg.content);
    const body = (parsed?.rest ?? msg.content).trim();
    const mergedBody = body ? `${body}\n\n${trimmed}` : trimmed;
    msg.content = parsed ? `${parsed.prefix}\n${mergedBody}` : annotateTimeframe(mergedBody, new Date());
    this.trimThread(msgs, maxThreadMessages);
    this.persistence?.scheduleSave(sessionId, msgs);
    return mergedBody;
  }

  appendAssistantFollowup(
    sessionId: string,
    clientMessageId: string | undefined,
    text: string,
    maxThreadMessages?: number,
  ): string | null {
    const trimmed = text.trim();
    if (!trimmed) return null;
    const msgs = this.history.get(sessionId);
    if (!msgs) return null;

    let insertAfter = msgs.length - 1;
    if (clientMessageId) {
      const found = findUserMessageByClientId(msgs, clientMessageId);
      if (found) {
        insertAfter = found.index;
        for (let i = found.index + 1; i < msgs.length; i++) {
          const msg = msgs[i];
          if (!msg) continue;
          if (msg.role === "user") break;
          insertAfter = i;
        }
      }
    }

    const assistantMsg = {
      role: "assistant",
      content: annotateTimeframe(trimmed, new Date()),
    } as ChatCompletionMessageParam;
    msgs.splice(Math.max(0, insertAfter + 1), 0, assistantMsg);
    this.trimThread(msgs, maxThreadMessages);
    this.persistence?.scheduleSave(sessionId, msgs);
    return trimmed;
  }

  afterTurnCompleted(sessionId: string, msgs: ChatCompletionMessageParam[]): void {
    const now = new Date();
    // P0-1 冻结历史消息时间戳：已有时间戳前缀的消息保持字节级原样（相对时间
    // 不再随轮次重写），保证 thread 前缀稳定，最大化 DeepSeek 等 provider 的
    // prompt prefix cache 命中率。仅对缺失时间戳的消息（极旧数据/纯 tool 消息）
    // 补一次原始时间戳，且补完后不再刷新。相对时间的语义在写入锚点时刻已固定，
    // 会话临近轮次的绝对时间足够 LLM 判断时序。
    const annotated = msgs.map((msg) => {
      if (
        (msg.role === "user" || msg.role === "assistant") &&
        typeof msg.content === "string"
      ) {
        if (readMessageTimestampPrefix(msg.content)) return msg; // 已有时间戳 → 冻结
        return annotateMessageWithOwnTimeOrKeep(msg, now);
      }
      return msg;
    });
    // 落库协议标记剥离（2026-09-25）：工具循环回写/非工具分支的 assistant 正文
    // 直 push 进线程，绕过 appendTurn——NEXT_UP 残块与 RENDER 声明在此统一收口。
    // 快测守卫避免对无标记消息做无谓重建。
    for (let i = 0; i < annotated.length; i++) {
      const m = annotated[i];
      if (
        m &&
        m.role === "assistant" &&
        typeof m.content === "string" &&
        THREAD_PROTOCOL_ANY_RE.test(m.content)
      ) {
        annotated[i] = { ...m, content: stripProtocolMarkersForThread(m.content) };
      }
    }
    msgs.length = 0;
    msgs.push(...annotated);
    // 根源防串台：轮次完成的瞬间折叠已完成的 tool_call 链，移除 raw tool 结果。
    // 下一轮 LLM 只看到干净的 assistant(content)，不会把上轮 tool 结果当成当前轮语境。
    foldCompletedToolChains(msgs);
    // 清理 tool loop 残留在会话中间的 transient system 消息（如「工具调用原则」），
    // 只保留 msgs[0] 的主 system prompt，避免污染后续轮次的对话历史。
    removeTransientSystemMessages(msgs);
    this.persistence?.scheduleSave(sessionId, msgs);
  }

  /**
   * 删除指定 clientMessageId 的 user 消息及其后所有内容（assistant / tool 链）。
   * 供 provider 在 streamCompletion 写入新一轮（编辑后的）user 消息前调用：
   *   1. 先删掉旧 user 消息及之后内容
   *   2. 再 push 新 user 消息并跑 Agent
   * 这样编辑时不会留下「同 id 两条 user 消息」的脏数据。
   * @returns 是否命中并截断
   */
  removeUserMessageAndAfter(
    sessionId: string,
    clientMessageId: string | undefined,
  ): boolean {
    if (!clientMessageId) return false;
    const msgs = this.threadForClientIdOperation(sessionId);
    if (!msgs) return false;
    const found = findUserMessageByClientId(msgs, clientMessageId);
    if (!found) return false;
    if (found.index < msgs.length) {
      msgs.length = found.index;
      this.persistence?.scheduleSave(sessionId, msgs);
    }
    return true;
  }

  /**
   * 删除「一整轮问答对」：指定 clientMessageId 的 user 消息 + 其后的 assistant /
   * tool 链，直到（不含）下一条 user 消息。后续轮次与 Agent 记忆原样保留。
   *
   * 与 {@link removeUserMessageAndAfter} 的区别：后者把该 user 消息之后的**全部**
   * 内容截断（用于「编辑后重发」），本方法只摘掉这一轮——对应客户端「删除这一轮
   * 对话」按钮。此前该按钮走 `chat.clear_history`（clearAllMemoryForActor），
   * 删一条消息会把整个会话线程 + 全部 Agent 记忆一并清空，属误伤。
   *
   * 局限：命中依赖 clientMessageId。反向索引是进程内 WeakMap，进程重启后旧消息原本
   * 定位不到（返回 message_not_found）——现已把 id 随线程一起落盘、恢复时回灌
   * （见 {@link PERSISTED_CLIENT_ID_FIELD}），跨重启同样命中。
   *
   * 存量兜底：本功能上线**之前**落盘的线程没有该字段，重启后仍定位不到；此时若调用方
   * 带上 `fallbackText`（被删消息原文），按纯文本唯一命中定位（见
   * {@link findUserMessagesByPlainText}）。
   *
   * @returns 命中并删除时 `{ ok: true, removed: N }`；未命中带 reason
   *   （`ambiguous_text_match` = 原文命中多条，拒绝删以免删错轮次）
   */
  deleteTurn(
    sessionId: string,
    clientMessageId: string | undefined,
    fallbackText?: string,
  ): { ok: boolean; reason?: string; removed?: number } {
    if (!clientMessageId) return { ok: false, reason: "missing_message_id" };
    const msgs = this.threadForClientIdOperation(sessionId);
    if (!msgs) return { ok: false, reason: "session_not_found" };
    let found = findUserMessageByClientId(msgs, clientMessageId);
    if (!found && fallbackText?.trim()) {
      // 迁移兜底：本功能上线前落盘的线程没有 clientMessageId 字段（重启后按 id 定位不到），
      // 客户端同时带上原文 → 按纯文本定位。只在「唯一命中」时才用，同文本发过两次就放弃，
      // 宁可返回未命中，也不删错轮次。
      const byText = findUserMessagesByPlainText(msgs, fallbackText);
      if (byText.length > 1) return { ok: false, reason: "ambiguous_text_match" };
      found = byText[0] ?? null;
    }
    if (!found) return { ok: false, reason: "message_not_found" };

    // 轮次右边界：向后扫到下一条 user 消息（不含）；到末尾则截断到末尾。
    let end = found.index + 1;
    while (end < msgs.length && msgs[end]?.role !== "user") {
      end++;
    }

    const removed = end - found.index;
    msgs.splice(found.index, removed);
    this.persistence?.scheduleSave(sessionId, msgs);
    return { ok: true, removed };
  }

  /**
   * 读取 user 消息的纯文本（去时间戳前缀），用于客户端编辑回填 / 服务端校验。
   * @returns 命中则返回文本，未命中返回 null
   */
  readUserMessageText(
    sessionId: string,
    clientMessageId: string,
  ): string | null {
    if (!clientMessageId) return null;
    const msgs = this.threadForClientIdOperation(sessionId);
    if (!msgs) return null;
    const found = findUserMessageByClientId(msgs, clientMessageId);
    if (!found) return null;
    if (typeof found.msg.content === "string") {
      const parsed = readMessageTimestampPrefix(found.msg.content);
      return (parsed?.rest ?? found.msg.content).trim();
    }
    return null;
  }

  /**
   * 编辑一条 user 消息：替换内容，并截断到该消息之后的所有内容（assistant / tool 链）。
   * 通常编辑后服务端会再走一次 Agent 重答（参考 `agentCore.handleUserMessage`）。
   */
  editUserMessage(
    sessionId: string,
    defaultSystemPrompt: string,
    clientMessageId: string,
    newText: string,
    now: Date = new Date(),
  ): { ok: boolean; reason?: string; index?: number } {
    if (!clientMessageId) return { ok: false, reason: "missing_message_id" };
    const text = newText.trim();
    if (!text) return { ok: false, reason: "empty_text" };
    const msgs = this.threadForClientIdOperation(sessionId);
    if (!msgs) return { ok: false, reason: "session_not_found" };
    const found = findUserMessageByClientId(msgs, clientMessageId);
    if (!found) return { ok: false, reason: "message_not_found" };
    const { index, msg } = found;
    const replaced = {
      ...msg,
      content: annotateUserContentIfString(text, now, now),
    } as ChatCompletionMessageParam;
    tagUserMessageClientId(replaced, clientMessageId);
    msgs[index] = replaced;
    if (index < msgs.length - 1) {
      msgs.length = index + 1;
    }
    this.persistence?.scheduleSave(sessionId, msgs);
    return { ok: true, index };
  }

  /**
   * 跨轮并行冲突检测辅助：返回「clientMessageId 之后、最新一条 user 纯文本」。
   *
   * 用途：后台复杂任务被某个 chatUserMessageId 触发；当它在后台执行期间，用户可能
   * 又发了新消息（新的 user turn）。续接迟到的后台结果前，需要知道这条中断后的
   * 最新用户话题是否已与原任务目标脱钩，据此决定续接还是丢弃。
   *
   * 仅在 clientMessageId 能定位到该消息、且其后存在新的 user 消息时返回其一；
   * 否则返回 undefined（表示用户没有在任务执行中插话，可安全续接，不触发额外分类）。
   */
  latestUserTextAfter(
    sessionId: string,
    defaultSystemPrompt: string,
    clientMessageId: string,
  ): string | undefined {
    if (!clientMessageId) return undefined;
    const msgs = this.thread(sessionId, defaultSystemPrompt);
    const found = findUserMessageByClientId(msgs, clientMessageId);
    if (!found) return undefined;
    // 自触发消息之后向后扫描，取最后一条带文本的 user 消息。
    for (let i = msgs.length - 1; i > found.index; i--) {
      const m = msgs[i];
      if (m && m.role === "user" && typeof m.content === "string") {
        const text = m.content.trim();
        if (text && text.length > 0) return text;
      }
    }
    return undefined;
  }
}

let sharedStore: ChatThreadStore | null = null;

export function getChatThreadStore(): ChatThreadStore {
  if (!sharedStore) {
    sharedStore = new ChatThreadStore(getChatThreadPersistence());
  }
  return sharedStore;
}

export function resetChatThreadStoreForTests(): void {
  sharedStore = null;
}

function groupMessagesPreservingToolPairs(
  messages: ChatCompletionMessageParam[],
): ChatCompletionMessageParam[][] {
  const groups: ChatCompletionMessageParam[][] = [];
  let i = 0;
  while (i < messages.length) {
    const msg = messages[i];
    if (!msg || typeof msg.role !== "string") {
      i++;
      continue;
    }
    if (msg.role === "assistant" && Array.isArray((msg as { tool_calls?: unknown }).tool_calls)) {
      const group: ChatCompletionMessageParam[] = [msg];
      i++;
      while (i < messages.length && messages[i]?.role === "tool") {
        group.push(messages[i]);
        i++;
      }
      groups.push(group);
      continue;
    }
    if (msg.role === "tool") {
      const orphanTools: ChatCompletionMessageParam[] = [];
      while (i < messages.length && messages[i]?.role === "tool") {
        orphanTools.push(messages[i]);
        i++;
      }
      if (orphanTools.length > 0) {
        console.warn(`[chat-thread-store] Skipping ${orphanTools.length} orphan tool message(s) during trim`);
      }
      continue;
    }
    groups.push([msg]);
    i++;
  }
  return groups;
}

/**
 * pin 判定（滑动窗口驱逐 → 优先级驱逐）：用户显式要求记住的轮次、agent 做出
 * 承诺/结论的轮次，不允许被更新的内容无声挤出窗口——被挤掉后"答应过的事"
 * 只能靠 recap 兜底重注入，保真度和时序都变差。
 */
function isPinnedGroup(group: ChatCompletionMessageParam[]): boolean {
  for (const msg of group) {
    const content = typeof msg.content === "string" ? msg.content : "";
    if (!content) continue;
    if (msg.role === "user" && MEMORY_EXPLICIT_RE.test(content)) return true;
    if (msg.role === "assistant" && AGENT_COMMITMENT_RE.test(content)) return true;
  }
  return false;
}

/**
 * 头尾保留 + 句子边界对齐的确定性压缩（零 LLM）。
 * 防过度压缩设计：
 * - 头尾切点优先对齐句末标点（。！？!?\n…），避免截出半句话污染上下文；
 *   但边界对齐最多只牺牲窗口的一半（保不住就退回原始切点），防止信息过度损失；
 * - 压缩无收益（边界回退后没有变短）返回 null，调用方保持原文。
 * 返回文本以 [已压缩 前缀标注（调用方的幂等检查依赖此前缀）。
 */
export function compressAssistantTextForWindow(text: string, maxChars: number): string | null {
  if (!Number.isFinite(maxChars) || maxChars < 200 || text.length <= maxChars) return null;
  const keep = Math.floor(maxChars / 2);
  if (keep <= 0) return null;

  const headRaw = text.slice(0, keep);
  const tailRaw = text.slice(-keep);

  // 头段：回退到最后一个句末标点（含标点本身）；回退超过窗口一半则放弃对齐
  const headBoundary = Math.max(
    headRaw.lastIndexOf("。"),
    headRaw.lastIndexOf("！"),
    headRaw.lastIndexOf("？"),
    headRaw.lastIndexOf("!"),
    headRaw.lastIndexOf("?"),
    headRaw.lastIndexOf("\n"),
    headRaw.lastIndexOf("…"),
  );
  const head =
    headBoundary >= Math.floor(headRaw.length / 2)
      ? headRaw.slice(0, headBoundary + 1)
      : headRaw;

  // 尾段：前进到第一个句末标点之后；前进超过窗口一半则放弃对齐
  const tailBoundaryMatch = tailRaw.match(/[。！？!?\n…]/);
  const tailBoundary = tailBoundaryMatch?.index ?? -1;
  const tail =
    tailBoundary >= 0 && tailBoundary <= Math.floor(tailRaw.length / 2)
      ? tailRaw.slice(tailBoundary + 1)
      : tailRaw;

  const headTrimmed = head.trimEnd();
  const tailTrimmed = tail.trimStart();
  if (!headTrimmed || !tailTrimmed) return null;

  const result = `[已压缩·${text.length}字符→${headTrimmed.length + tailTrimmed.length}] ${headTrimmed} … ${tailTrimmed}`;
  // 压缩无收益（标记+边界对齐反而变长/等长）就不压
  if (result.length >= text.length) return null;
  return result;
}

export function trimPreservingToolPairs(
  messages: ChatCompletionMessageParam[],
  maxMessages: number,
): { kept: ChatCompletionMessageParam[]; dropped: ChatCompletionMessageParam[] } {
  if (messages.length <= maxMessages) {
    return {
      kept: sanitizeToolCallMessageChain(messages, "[chat-thread-store-trim]"),
      dropped: [],
    };
  }
  const groups = groupMessagesPreservingToolPairs(messages);

  // 选择改为"预算内优先级"而非纯尾部截断：
  // 1) 从尾部向后贪心装填（原行为，近因优先）；
  // 2) pin 回填：被挤出的显式记忆/承诺组，预算不足时从保留窗口的**最旧端**
  //    驱逐非 pin 组腾位——早期"帮我记住 X / 我会帮你 Y"不再被新闲聊顶掉，
  //    同时保证最近的对话尾部完整无损。
  const selected = new Array<boolean>(groups.length).fill(false);
  let total = 0;
  for (let g = groups.length - 1; g >= 0; g--) {
    if (total + groups[g]!.length > maxMessages) continue;
    selected[g] = true;
    total += groups[g]!.length;
  }
  for (let g = 0; g < groups.length; g++) {
    if (selected[g] || !isPinnedGroup(groups[g]!)) continue;
    const need = groups[g]!.length;
    if (total + need > maxMessages) {
      let freed = 0;
      for (let s = 0; s < groups.length && freed < need; s++) {
        if (!selected[s] || s === g || isPinnedGroup(groups[s]!)) continue;
        selected[s] = false;
        freed += groups[s]!.length;
      }
      total -= freed;
    }
    if (total + need <= maxMessages) {
      selected[g] = true;
      total += need;
    }
  }

  const kept = sanitizeToolCallMessageChain(
    groups.filter((_, g) => selected[g]).flat(),
    "[chat-thread-store-trim]",
  );
  const keptSet = new Set(kept);
  const dropped = messages.filter((msg) => !keptSet.has(msg));
  return { kept, dropped };
}
