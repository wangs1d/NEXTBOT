/**
 * 呈现裁决唯一出口（2026-11-23 统一）：流式是否开泡、done 是否收口，
 * 全部由本模块的两个纯函数决定，WS 层不再各自拼条件。
 *
 * 产品口径：**分泡只服务闲聊**。
 *   - 闲聊轮：正文是口语短句，按结构闭合边界拆成多条消息；
 *   - 信息类轮（卡 / 结构化正文 / 媒体 / 摘要等最终要「渲染」的回复）：
 *     一律收成一条完整消息——否则流式阶段已发出的原文气泡会和 done 阶段
 *     重排出的卡片同时出现，同一段内容渲染两遍；
 *   - 语音轮与任务面轮不分泡。
 *
 * 不变量：一条 assistant 消息有且只有一个文字呈现所有者。
 *   - 开始判 single 的轮次，结束不允许再打开分泡（单调收窄）；
 *   - 正文被渲染层重排/抽走时，结束必须收成 single。
 */

export type PresentationOwner = "bubbles" | "single";

export type PresentationPlan = {
  owner: PresentationOwner;
  /** 客户端是否必须用 done.finalText 整段替换已流内容。 */
  replacesStream: boolean;
  /** 裁决原因（日志 / 线上取证；回归时看它就能定位是哪条规则定的主）。 */
  reason: string;
};

export type StreamPlanInputs = {
  /** 路由决策本轮是否可分段（任务面轮为 false）。 */
  segmentable: boolean;
  /** 语音轮不拆泡（TTS 不消费气泡边界）。 */
  voiceMode: boolean;
};

/** 开始阶段：只依据场景，决定要不要开泡。 */
export function decideStreamPlan(input: StreamPlanInputs): PresentationPlan {
  if (input.voiceMode) {
    return { owner: "single", replacesStream: false, reason: "voice" };
  }
  if (!input.segmentable) {
    return { owner: "single", replacesStream: false, reason: "task-surface" };
  }
  return { owner: "bubbles", replacesStream: false, reason: "chat" };
}

export type FinalPlanInputs = {
  /** 开始阶段的裁决：结束阶段只允许收窄，不允许重新开泡。 */
  stream: PresentationPlan;
  /** 流式期间是否真的推出过气泡。 */
  hasBubbles: boolean;
  /** 发言结算把过程话吸收进结论（整轮塌缩成单条）。 */
  utteranceCollapse: boolean;
  /** 本轮已发过 stream_reset（正文撤回，必须整段替换）。 */
  streamResetSent: boolean;
  /** 场景显式声明 produces.singleBubble（明日速览/盘点等整块交付）。 */
  sceneSingleBubble: boolean;
  /**
   * 渲染层唯一可靠信号：本轮正文被出口重排或抽走（列表切卡、引用抽块、
   * 长文折叠、结构化正文），流式气泡里的原文已不是最终正文。
   */
  bodyRewritten: boolean;
  /**
   * 兜底信号：done 信封里存在 text/followups 以外的展示块（卡 / 形态 /
   * 结构化 / 媒体）。覆盖渲染决策之后才追加的块（工具卡、补卡、媒体）。
   */
  presentationBlocks: boolean;
};

/** 结束阶段：在流式裁决基础上做收口，保证单调收窄。 */
export function decideFinalPlan(input: FinalPlanInputs): PresentationPlan {
  if (input.stream.owner !== "bubbles") {
    return {
      owner: "single",
      replacesStream: false,
      reason: `stream-${input.stream.reason}`,
    };
  }
  if (!input.hasBubbles) {
    return { owner: "single", replacesStream: false, reason: "no-bubbles" };
  }
  if (input.utteranceCollapse) {
    return { owner: "single", replacesStream: true, reason: "utterance-collapse" };
  }
  if (input.streamResetSent) {
    return { owner: "single", replacesStream: true, reason: "stream-reset" };
  }
  if (input.sceneSingleBubble) {
    return { owner: "single", replacesStream: true, reason: "scene-single-bubble" };
  }
  if (input.bodyRewritten) {
    return { owner: "single", replacesStream: true, reason: "body-rewritten" };
  }
  if (input.presentationBlocks) {
    return { owner: "single", replacesStream: true, reason: "presentation-blocks" };
  }
  return { owner: "bubbles", replacesStream: false, reason: "chat" };
}
