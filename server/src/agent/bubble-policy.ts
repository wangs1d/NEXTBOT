/**
 * 分泡判定唯一出口：流式开泡门禁与 done 收口判定都从这里取结论，
 * WS 层不再各自拼条件。
 *
 * 产品口径（2026-11-23 定稿）：**分泡只服务闲聊**。闲聊轮的正文是口语短句，
 * 按结构闭合边界拆成多条消息（见 stream-segmenter）；信息类轮（卡 / 结构化
 * 正文 / 媒体 / 摘要等最终要「渲染」的回复）一律收成一条完整消息——否则流式
 * 阶段已经发出的原文气泡会和 done 阶段重排出的卡片同时出现在界面上。
 * 语音轮不拆泡（TTS 不消费气泡边界）。
 */

export type BubbleSplitInputs = {
  /** 路由决策本轮是否可分段（任务面轮为 false）。 */
  segmentable: boolean;
  /** 语音轮不拆泡（泡间停顿拖慢 done，TTS 不消费气泡边界）。 */
  voiceMode: boolean;
};

/** 本轮是否开启分泡模式。 */
export function shouldSplitBubbles(input: BubbleSplitInputs): boolean {
  return input.segmentable && !input.voiceMode;
}

export type BubbleCollapseInputs = {
  /** 流式期间是否真的推出过气泡。 */
  hasBubbles: boolean;
  /** 发言结算把过程话吸收进结论（整轮塌缩成单条）。 */
  utteranceCollapse: boolean;
  /** 本轮已发过 stream_reset（正文撤回，必须整段替换）。 */
  streamResetSent: boolean;
  /** 场景显式声明 produces.singleBubble（明日速览/盘点等整块交付）。 */
  sceneSingleBubble: boolean;
  /**
   * done 阶段回复已被渲染成卡 / 结构化正文 / 媒体 / 摘要（信息类轮）。
   * 这类轮次只保留最终版式那一条消息，不能按流式气泡逐泡落屏。
   */
  renderedReply: boolean;
};

export type BubbleCollapseDecision = {
  /** true = 客户端按 bubbles 对账数组逐泡落屏，不塌缩。 */
  bubbleSplitLive: boolean;
};

/** done 收口判定：是否保留分泡呈现。 */
export function resolveBubbleCollapse(
  input: BubbleCollapseInputs,
): BubbleCollapseDecision {
  const bubbleSplitLive =
    input.hasBubbles &&
    !input.utteranceCollapse &&
    !input.streamResetSent &&
    !input.sceneSingleBubble &&
    !input.renderedReply;
  return { bubbleSplitLive };
}
