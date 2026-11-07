/**
 * 一轮渲染的唯一出口（P2，2026-11-07）。
 *
 * 此前 decideRender 有两个生产调用点：
 *   - ToolResultProcessor.processAssistantText（full：形态 + 卡 + 场景改写）
 *   - applyDeterministicCards（cards-only：只补卡，不重跑正文形态）
 * 两条链路各算一次决策、且第二条不消费 decision.text / 不传 payloads，
 * 同一轮可能得出两套不一致的结论。现在二者都经过 renderTurn，
 * 「决策 → 正文形态 → 结构化卡 → 统一信封」的顺序只有这一份。
 *
 * mode 的差异是刻意的：cards-only 是 done 阶段的补卡收尾，此时正文已定稿
 * （已流式即定稿），绝不能重跑 applyBodyForm 或整体替换正文。
 *
 * 纯编排：不含业务判定，不读文件，不打日志。
 */

import { decideRender } from "./decide.js";
import { applyBodyForm } from "./body.js";
import { applyCards, collectCardPayloads, unfoldIfCardsPresent } from "./cards.js";
import { buildRenderEnvelope } from "./protocol.js";
import { buildReplyBlocks } from "../services/reply-envelope.js";
import { sceneRegistry } from "./scenes/index.js";
import type { RenderDecision, RenderInput } from "./types.js";
import type { RenderEnvelope } from "./protocol.js";

export type RenderTurnMode = "full" | "cards-only";

export interface RenderTurnResult {
  text: string;
  cards: Array<Record<string, unknown>>;
  decision: RenderDecision;
  envelope: RenderEnvelope;
  mode: RenderTurnMode;
}

/**
 * 唯一出口。全项目只有这里调用 decideRender / applyBodyForm / applyCards。
 *
 * @param input 决策层输入（text 必须是 preClean 之后的正文）
 * @param mode  full = 生成后主链路；cards-only = done 阶段补卡收尾
 */
export function renderTurn(input: RenderInput, mode: RenderTurnMode = "full"): RenderTurnResult {
  const decision = decideRender(input);
  let text: string;

  if (mode === "cards-only") {
    // 结构化面在场时正文不能同时是折叠卡（会互相盖住）
    text = decision.cards.length > 0 ? unfoldIfCardsPresent(input.text) : input.text;
    text = applyCards(text, decision).text;
  } else {
    // 场景对正文有确定性改写时以它为准（明日预览渲染结果 / 结构卡坏块剥离）
    const bodyText = decision.text ?? input.text;
    text = applyBodyForm(bodyText, decision, {
      userText: input.userText,
      toolName: input.toolName,
    });
    if (!input.plainTextMode) {
      text = applyCards(text, decision).text;
    }
  }

  const cards = collectCardPayloads(text);
  const scene = decision.scene ? sceneRegistry.get(decision.scene.id) : undefined;
  const envelope = buildRenderEnvelope({
    finalText: text,
    legacyBlocks: buildReplyBlocks(text),
    sceneId: decision.scene?.id,
    failures: decision.failures,
    rewritesText: scene?.produces?.rewritesText === true && decision.text !== undefined,
  });

  return { text, cards, decision, envelope, mode };
}
