// 主动消息的对话级发射器（2026-11-25 表达层收口）。
//
// 主动消息不再发 `agent.proactive_message` 单泡——它和普通对话回复走**同一套
// 事件契约**：`chat.assistant_chunk` 逐泡落屏、`chat.assistant_done` 结构化收口
// （bubbles + renderBlocks/mediaCards）。信封构造、气泡 id、done 字段全部复用
// 对话侧已有实现（render/protocol + BubbleTracker + bubble-policy），本文件只做
// 「一次主动回复 → 一组事件」的映射，不新造协议、不新造渲染。
//
// 主动特有的语义（deliveryId / why / actionIntent / firedAt / notifyOn）放在
// done 的 `proactive` 字段里；对话侧不认识它，主动侧不重复实现分泡。
import { ServerEventType } from "@nextbot/agent-protocol";

import { BubbleTracker } from "./bubble-tracker.js";
import {
  buildRenderEnvelope,
  compactEnvelopeForWire,
  expandEnvelopeToDoneFields,
} from "../render/protocol.js";
import type { RenderEnvelope } from "../render/protocol.js";
import { splitSentences } from "../utils/text.js";
import type { MediaCardItem } from "../services/tool-result-processor.js";

/**
 * 分泡：一句一泡太碎、整段一泡没节奏——两句一泡，最多三泡。
 * 主动内容是已经写好的整段，不需要流式 chunk：一次 done 带 bubbles 数组，
 * 客户端按泡定稿（_finalizeBubbles 已支持「无 chunk 的一次性分泡」）。
 */
export function bubbleTextsOf(text: string, max = 3): string[] {
  const sentences = splitSentences(text).map((s) => s.trim()).filter(Boolean);
  if (sentences.length <= 1) return sentences.length ? [sentences[0]!] : [];
  const per = Math.ceil(sentences.length / Math.min(max, Math.ceil(sentences.length / 2)));
  const out: string[] = [];
  for (let i = 0; i < sentences.length; i += per) out.push(sentences.slice(i, i + per).join(""));
  return out.slice(0, max);
}

/** done.proactive：主动消息在对话契约上的附加语义（对话轮缺省不存在） */
export type ProactiveTurnMeta = {
  deliveryId: string;
  /** 通知/长按详情的标题（对话气泡不用它） */
  title?: string;
  importance?: string;
  kind?: string;
  proposalId?: string;
  source?: string;
  /** 「为什么是现在」——长按详情与通知栏共用 */
  why?: string;
  /** 补推的到点提醒：气泡按原定时刻落屏 */
  firedAt?: number;
  display?: "popup";
  /** 多端横幅归属：只有这一端弹系统通知 */
  notifyOn?: "mobile" | "desktop";
  /** 「通知即界面」的动作视图（与通知栏同一 intent） */
  actionIntent?: Record<string, unknown>;
};

export type AssistantTurnInput = {
  sessionId: string;
  traceId: string;
  threadId?: string;
  finalText: string;
  mediaCards?: MediaCardItem[];
  renderBlocks?: ReadonlyArray<unknown>;
  proactive: ProactiveTurnMeta;
};

/**
 * 只构造帧、不发送：投递层（WS 直推 / outreach 总线）各自决定怎么送。
 * 一次主动回合 = 一个 done 帧（多句时带 bubbles 数组）。
 */
export function buildAssistantTurnFrames(input: AssistantTurnInput): {
  frames: string[];
  messageId: string;
  bubbles: number;
} {  const envelope = buildRenderEnvelope({
    finalText: input.finalText,
    ...(input.mediaCards?.length ? { mediaCards: input.mediaCards } : {}),
    ...(input.renderBlocks?.length ? { renderBlocks: input.renderBlocks } : {}),
  });
  const structured = envelope.blocks.some((b) => b.type !== "text");
  const baseMessageId = `assistant-${input.traceId}`;
  const tracker = new BubbleTracker(baseMessageId);
  // 有结构块 → 单条收口（卡片/媒体自带版式）；纯文本 → 按句分泡，>1 泡才带 bubbles。
  if (!structured) {
    const texts = bubbleTextsOf(envelope.finalText);
    if (texts.length > 1) for (const text of texts) tracker.appendStreamBlock(text, true);
  }
  const messageId = tracker.hasBubbles ? tracker.outboundDoneMessageId : baseMessageId;
  const frame = buildDoneFrame({
    sessionId: input.sessionId,
    traceId: input.traceId,
    ...(input.threadId ? { threadId: input.threadId } : {}),
    envelope,
    messageId,
    ...(tracker.hasBubbles ? { bubbles: tracker.snapshot } : {}),
    proactive: input.proactive,
  });
  return { frames: [frame], messageId, bubbles: tracker.snapshot.length };
}

/** 唯一的 chunk 帧构造（对话流式与任何主动分段共用同一 wire 形状）。 */
export function buildChunkFrame(input: {
  sessionId: string;
  messageId: string;
  blockId: string;
  index: number;
  traceId: string;
  threadId?: string;
  chunk: string;
  sequence: number;
  phase: "interim" | "stream";
  kind?: "text";
  final?: boolean;
}): string {
  return JSON.stringify({ type: ServerEventType.ChatAssistantChunk, payload: input });
}

/**
 * 唯一的 done 帧构造：信封字段只在这里展开一次。
 * `extra` 给对话轮的 utterance/toolCalls/source 等追加字段，主动轮不传。
 */
export function buildDoneFrame(input: {
  sessionId: string;
  traceId: string;
  threadId?: string;
  envelope: RenderEnvelope;
  messageId: string;
  bubbles?: Array<{ id: string; text: string }>;
  proactive?: ProactiveTurnMeta;
  extra?: Record<string, unknown>;
}): string {
  return JSON.stringify({
    type: ServerEventType.ChatAssistantDone,
    payload: {
      sessionId: input.sessionId,
      ...expandEnvelopeToDoneFields(input.envelope),
      renderEnvelope: compactEnvelopeForWire(input.envelope),
      messageId: input.messageId,
      traceId: input.traceId,
      ...(input.threadId ? { threadId: input.threadId } : {}),
      ...(input.bubbles?.length ? { bubbles: input.bubbles } : {}),
      ...(input.proactive ? { proactive: input.proactive } : {}),
      ...(input.extra ?? {}),
    },
  });
}

/**
 * 发射一次完整的 assistant 回合：结构化内容从同一个 reply 信封投影。
 * 主动内容已是成稿，不走 chunk 伪流式——done 即终态，客户端按泡定稿。
 */
export function publishAssistantTurn(
  send: (json: string) => boolean | void,
  input: AssistantTurnInput,
): { messageId: string; bubbles: number } {
  const built = buildAssistantTurnFrames(input);
  for (const frame of built.frames) send(frame);
  return { messageId: built.messageId, bubbles: built.bubbles };
}
