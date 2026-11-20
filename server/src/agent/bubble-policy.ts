/**
 * 分泡判定唯一出口：流式开泡门禁与 done 收口判定都从这里取结论，
 * WS 层不再各自拼条件。
 *
 * 产品口径：文字轮恒分泡（切点是结构闭合边界，见 stream-segmenter）；
 * 只有语音轮不拆、场景显式声明 singleBubble 的轮次收口成一条。
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
    !input.sceneSingleBubble;
  return { bubbleSplitLive };
}
