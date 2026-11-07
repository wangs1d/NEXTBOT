/**
 * 渲染决策层（唯一决定者）。
 *
 * 一轮回复出什么卡、正文用什么形态，只在这里决定：
 *   - 场景计划（scenes/）→ 卡与形态的主来源：明日预览 / 天气 / 工具卡面 / 结构卡
 *   - 正文规则链（classifyRenderHint + decideBody）→ 无结构化面时的形态判断
 *
 * 2026-11-05 收敛：原来 decideCards 直接内联在本文件，现在上移为 tool_cards
 * 场景（语义不变），天气独立成 weather 场景。新增结构化形态只改
 * scenes/index.ts 的登记，不改本文件。
 *
 * 三条硬规则：
 *   R1 业务卡只从 effects 产出；没有回执就不可能有业务卡。
 *   R2 fold 只在「没有结构化卡」且「主题判得出来」时出现；主题不猜类目名。
 *   R3 结构化面（卡/媒体）在场时正文只是前导，不进 fold。
 *
 * 纯函数：不读文件、不打日志、不调 LLM。
 */

import { classifyRenderHint } from "../services/render-hint-service.js";
import { inferTaskSubject } from "../services/content-summary-service.js";
import { hasBlockquote } from "../services/display-effect-router.js";
import { planRenderScene } from "./scenes/plan.js";
// 副作用导入：登记默认场景（明日预览/天气/工具卡面/结构卡/正文兜底）
import "./scenes/index.js";
import type {
  BodyDecision,
  CardSpec,
  RenderDecision,
  RenderInput,
  TextForm,
} from "./types.js";

function hintToForm(hint?: string | null): TextForm | null {
  switch (hint) {
    case "structured":
      return "markdown";
    case "brief":
      return "brief";
    case "card":
      return "result_card";
    case "plain":
      return "plain";
    default:
      return null;
  }
}

function decideBody(
  input: RenderInput,
  text: string,
  cards: ReadonlyArray<CardSpec>,
): BodyDecision {
  if (input.plainTextMode) return { form: "plain", reason: "plain-text-channel" };

  // 结构化面在场：正文只作前导，绝不折叠（折叠会盖住卡）。
  if (cards.length > 0) {
    return { form: "plain", reason: "structured-surface-primary" };
  }

  if (!text) return { form: "plain", reason: "empty" };

  const declared = hintToForm(input.modelHint);
  if (declared) return { form: declared, reason: `model-hint:${input.modelHint}` };

  const hint = classifyRenderHint(text, {
    toolName: input.toolName,
    userText: input.userText,
  });

  switch (hint.type) {
    case "image_text":
      return { form: "image_text", reason: hint.reason };
    case "result_card":
      return { form: "result_card", reason: hint.reason };
    case "brief":
      return { form: "brief", reason: hint.reason };
    default:
      break;
  }

  // 引用块（> xxx）：一句话结论/强调场景，顺序与旧链路一致（切卡之后、折叠之前）
  if (hasBlockquote(text)) return { form: "quote", reason: "blockquote" };

  if (hint.type === "summary_card") {
    const subject = input.activeTopic?.trim() || inferTaskSubject(text, input.userText);
    if (!subject) {
      // 主题判不出来 → 不折叠，正文照常按长文排版
      return { form: "markdown", reason: "long-structured-no-subject" };
    }
    return { form: "fold", subject, reason: `fold:${subject}` };
  }
  if (hint.type === "long_text") {
    return hint.intent
      ? { form: "markdown", reason: hint.reason }
      : { form: "plain", reason: hint.reason };
  }
  return { form: "plain", reason: hint.reason };
}

/** 唯一的渲染决策入口。 */
export function decideRender(input: RenderInput): RenderDecision {
  const text = input.text?.trim() ?? "";
  // 场景计划：数据面（明日预览）、回执（天气/工具卡）、模型声明（结构卡）一次判完
  const plan = planRenderScene({ ...input, text });
  const cards = plan.cards;
  const workingText = plan.text ?? text;

  const body: BodyDecision = plan.bodyForm
    ? { form: plan.bodyForm, reason: `scene:${plan.primary}` }
    : decideBody({ ...input, text: workingText }, workingText, cards);

  const primaryLabel = plan.matched[0]?.label ?? "";
  const reason = `${plan.reason} | ${body.reason}`;

  return {
    cards,
    body,
    reason,
    ...(plan.text !== undefined ? { text: plan.text } : {}),
    scene: { id: plan.primary, label: primaryLabel, reason: plan.reason },
    failures: plan.failures,
  };
}
