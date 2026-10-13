import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";

/**
 * 消息时间戳的落盘 metadata（2026-10-11 通道分离根修）。
 *
 * 为什么单独一个模块：时间戳要与线程消息一起持久化、又不属于「人说的话」的正文，
 * 与 clientMessageId（`chat-thread-client-id.ts`）是同一类问题——线程内部元数据，
 * 绝不能进 LLM 上下文正文。
 *
 * 旧行为（已废）：`annotateTimeframe` 把 `[ts:YYYY-MM-DD HH:MM:SS|周X|relative]` 前缀
 * 写进消息正文首行。帧文本混进对话历史就成了「可被复读的对象」（模型把帧当自己的话
 * 原样带出来，2026-10-08/10-11 两次事故），且每个新模型都要重新教育一遍「别复读」。
 * 新行为：正文只存净文本；时刻存 `__ts`（ISO 字符串，随线程落盘）；LLM 的【对话时间轴】
 * 由 `buildTimestampFreeLlmView` 从 metadata 构造。旧线程的内联帧在时间戳刷新/轮次收口
 * 时顺手迁移（正文剥帧、metadata 接管），存量逐步净化，读取端对两种形态都兼容。
 */

/** 落盘用的时间戳 metadata 字段名（线程内部元数据，绝不进 LLM 上下文正文）。 */
export const PERSISTED_TS_FIELD = "__ts";

/** 给消息对象打上发生时刻（覆盖写；调用方自行决定是否保留原值）。 */
export function tagMessageTimestampMeta(
  msg: ChatCompletionMessageParam,
  at: Date,
): void {
  (msg as unknown as Record<string, unknown>)[PERSISTED_TS_FIELD] = at.toISOString();
}

/** 读取消息 metadata 上的发生时刻；无则 null。 */
export function readMessageTimestampMeta(
  msg: ChatCompletionMessageParam,
): Date | null {
  const raw = (msg as unknown as Record<string, unknown>)[PERSISTED_TS_FIELD];
  if (typeof raw !== "string" || !raw.trim()) return null;
  const ts = Date.parse(raw);
  return Number.isNaN(ts) ? null : new Date(ts);
}

/** 视图克隆时剥掉 metadata 字段（发往 LLM 的消息不带线程内部元数据）。
 *  无该字段时原引用返回——视图对无元数据消息零克隆（clientMessageId 透传测试依赖此语义）。 */
export function stripPersistedTsField<T extends ChatCompletionMessageParam>(msg: T): T {
  if ((msg as unknown as Record<string, unknown>)[PERSISTED_TS_FIELD] === undefined) return msg;
  const cloned = { ...msg } as T & Record<string, unknown>;
  delete cloned[PERSISTED_TS_FIELD];
  return cloned;
}
