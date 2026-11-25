/**
 * 气泡车道裁决（唯一出口，2026-11-25 分泡管道架构收敛）。
 *
 * 一轮回复的文字呈现只有两条车道，且**车道在首个文字块外发之前定死、整轮不变**：
 *   - 气泡车道（bubbles）：chat.assistant_chunk 实时落屏的文字块就是最终呈现。
 *     done 只做对账定稿（id+文本照实下发），绝不重建、绝不替换。
 *   - 单条车道（single）：不发文字块，整段正文由 assistant_done 一次交付
 *     （卡 / 结构化 / 整块交付的场景）。语音数据帧（chat.assistant_speech）
 *     两种车道照常流式——车道闸只关文字块出口，不关语音。
 *
 * 旧架构（2026-11-23 方案 C）的问题是 done 阶段重判一次呈现权
 * （decidePresentation + finalTextReplacesStream 塌缩），两个裁决者必然碰撞：
 * 先分出来的泡被整段渲染文本翻案。新架构下呈现只有一个裁决时机（T0），
 * done 不再是第二个裁决者——「塌缩 / 翻案 / 对账自愈」这一类词从管道里退役。
 */

export type TextLane = "bubbles" | "single";

export type TextLanePlan = {
  lane: TextLane;
  /** 车道原因（日志 / 线上取证；回归时看它就能定位是哪条规则定的道）。 */
  reason: string;
};

export type TextLaneInputs = {
  /** 语音轮不拆泡（TTS 不消费气泡边界）。 */
  voiceMode: boolean;
  /** 路由决策本轮是否可分段（任务面轮为 false）。 */
  segmentable: boolean;
  /** 场景显式声明整块交付（明日速览 / 盘点清单等 produces.singleBubble 场景）。 */
  sceneSingleBubble: boolean;
};

/** T0 车道裁决：输入全部在首个 delta 之前可得，不存在事后翻案。 */
export function decideTextLane(input: TextLaneInputs): TextLanePlan {
  if (input.voiceMode) {
    return { lane: "single", reason: "voice" };
  }
  if (!input.segmentable) {
    return { lane: "single", reason: "task-surface" };
  }
  if (input.sceneSingleBubble) {
    return { lane: "single", reason: "scene-single-bubble" };
  }
  return { lane: "bubbles", reason: "chat" };
}
