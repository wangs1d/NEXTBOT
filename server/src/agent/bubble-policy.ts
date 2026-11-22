/**
 * 呈现裁决唯一出口（2026-11-23 重构）：**先整段看，再判分泡还是渲染**。
 *
 * 旧架构的问题：流式阶段边收边判要不要开泡，渲染阶段等全文到了才判要不要
 * 抽卡，两个判断的输入和时机都不同，必然出现「先出泡、done 再收口」的碰撞，
 * 同一段内容被渲染两遍，或已展示的气泡被整段替换。
 *
 * 现在：WS 层不再把 chunk 当气泡外发。整轮结束后这里只判一次——
 *   - 闲聊（口语、无结构、无卡）：把 finalText 用同一套分段规则拆成多条，
 *     客户端按 done 数组逐泡揭示；
 *   - 信息类（卡 / 结构化正文 / 媒体 / 摘要 / 正文被重排）：收成一条渲染消息；
 *   - 语音轮与任务面轮不分泡。
 *
 * 不变量：一条 assistant 消息有且只有一个文字呈现所有者，判定只发生一次。
 */

import { StreamSegmenter } from "./stream-segmenter.js";

export type PresentationOwner = "bubbles" | "single";

export type PresentationPlan = {
  owner: PresentationOwner;
  /** 裁决原因（日志 / 线上取证；回归时看它就能定位是哪条规则定的主）。 */
  reason: string;
};

export type PresentationInputs = {
  /** 语音轮不拆泡（TTS 不消费气泡边界）。 */
  voiceMode: boolean;
  /** 路由决策本轮是否可分段（任务面轮为 false）。 */
  segmentable: boolean;
  /** 发言结算把过程话吸收进结论（整轮塌缩成单条）。 */
  utteranceCollapse: boolean;
  /** 场景显式声明 produces.singleBubble（明日速览/盘点等整块交付）。 */
  sceneSingleBubble: boolean;
  /**
   * 渲染层唯一可靠信号：本轮正文被出口重排或抽走（列表切卡、引用抽块、
   * 长文折叠、结构化正文）。
   */
  bodyRewritten: boolean;
  /**
   * 兜底信号：done 信封里存在 text/followups 以外的展示块（卡 / 形态 /
   * 结构化 / 媒体）。覆盖渲染决策之后才追加的块（工具卡、补卡、媒体）。
   */
  presentationBlocks: boolean;
};

/** 整轮结束后的一次性裁决：输入已包含全文渲染结果，不存在事后翻案。 */
export function decidePresentation(input: PresentationInputs): PresentationPlan {
  if (input.voiceMode) {
    return { owner: "single", reason: "voice" };
  }
  if (!input.segmentable) {
    return { owner: "single", reason: "task-surface" };
  }
  if (input.utteranceCollapse) {
    return { owner: "single", reason: "utterance-collapse" };
  }
  if (input.sceneSingleBubble) {
    return { owner: "single", reason: "scene-single-bubble" };
  }
  if (input.bodyRewritten) {
    return { owner: "single", reason: "body-rewritten" };
  }
  if (input.presentationBlocks) {
    return { owner: "single", reason: "presentation-blocks" };
  }
  return { owner: "bubbles", reason: "chat" };
}

/**
 * 出口分泡：与流式分泡共用同一套分段规则（结构闭合边界、每泡字数上限、
 * 结构块不拆），只是把整段文本一次性喂进去。
 */
export async function splitReplyBubbles(text: string): Promise<string[]> {
  const bubbles: string[] = [];
  const segmenter = new StreamSegmenter(
    (segment, _phase, meta) => {
      const trimmed = segment.trim();
      if (!trimmed) return;
      if (meta?.bubble === "continue" && bubbles.length > 0) {
        bubbles[bubbles.length - 1] += trimmed;
      } else {
        bubbles.push(trimmed);
      }
    },
    {
      bubbleMode: true,
      pauseMs: 0,
      interimReplyGapMs: 0,
      bubbleGapMinMs: 0,
      bubbleGapMaxMs: 0,
      bubbleGapPerCharMs: 0,
    },
  );
  segmenter.feed(text);
  await segmenter.flushFinal();
  return bubbles;
}
