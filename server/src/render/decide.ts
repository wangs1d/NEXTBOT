/**
 * 渲染决策层（唯一决定者）。
 *
 * 一轮回复出什么卡、正文用什么形态，只在这里决定。四条旧出口现在都只是
 * 本函数的输入：
 *   - L1 工具绑定   → input.effects（真实执行回执，含失败/空）
 *   - L2 模型声明   → input.modelHint（形态偏好，业务卡优先于它）
 *   - 文本规则链     → classifyRenderHint（正文结构）
 *   - done 阶段附卡链 → 由 decideCards 的顺序取代，不再各自 break / 让位
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
import { buildToolCard, lookupToolCardBuilder } from "../services/tool-card-registry.js";
import { hasBlockquote } from "../services/display-effect-router.js";
import type {
  BodyDecision,
  CardSpec,
  RenderDecision,
  RenderInput,
  TextForm,
  TurnEffect,
} from "./types.js";

const MEDIA_TOOLS = new Set([
  "search_images",
  "search_images_batch",
  "search_videos",
  "image.generate",
]);
const SEARCH_TOOLS = new Set(["search_web", "info.search"]);
const VIDEO_TOOLS = new Set(["video.grab", "video.find"]);
const WEATHER_PREFIX = "weather.";
const TRAVEL_TOOL = "travel.plan-itinerary";

/**
 * 业务工具失败时的空态卡文案。本轮确实尝试过，就该给出「没拿到数据」这个
 * 事实，而不是让正文退化成一张搜索卡（用户会以为工具没跑）。
 */
const EMPTY_CARD_COPY: Record<string, { title: string; message: string }> = {
  "shopping.compare.prices": {
    title: "比价",
    message: "各平台的实时报价这次没拿到，可以稍后重试或换个商品名。",
  },
  "shopping.recommend": {
    title: "商品推荐",
    message: "这次没拿到可用的商品数据，可以换个说法或稍后重试。",
  },
  "shopping.order.place": {
    title: "下单",
    message: "下单没有完成，没有生成订单。",
  },
  "weather.get_local": {
    title: "天气",
    message: "暂时没拿到实时天气数据，可以稍后重试。",
  },
};

function okResults(
  effects: ReadonlyArray<TurnEffect>,
  predicate: (tool: string) => boolean,
): Array<{ tool: string; result: Record<string, unknown> }> {
  const out: Array<{ tool: string; result: Record<string, unknown> }> = [];
  for (const effect of effects) {
    if (effect.status === "ok" && effect.result && predicate(effect.tool)) {
      out.push({ tool: effect.tool, result: effect.result });
    }
  }
  return out;
}

function isRegistryBusinessTool(tool: string): boolean {
  if (!lookupToolCardBuilder(tool)) return false;
  if (SEARCH_TOOLS.has(tool) || MEDIA_TOOLS.has(tool) || VIDEO_TOOLS.has(tool)) return false;
  if (tool.startsWith(WEATHER_PREFIX) || tool === TRAVEL_TOOL) return false;
  return true;
}

/**
 * 卡的取舍顺序即优先级：
 *   媒体 → 行程(+简报) → 天气 → 注册业务卡 → 视频 → 搜索（兜底面）
 * 先选中的「主结构化面」会屏蔽后面的兜底面；业务卡之间可并存（多卡），
 * 同一 cardType 只保留第一张。
 */
function decideCards(
  effects: ReadonlyArray<TurnEffect>,
  mediaCardCount: number,
): CardSpec[] {
  const cards: CardSpec[] = [];
  if (mediaCardCount > 0) cards.push({ kind: "media", topic: "media" });

  const travel = okResults(effects, (t) => t === TRAVEL_TOOL)[0];
  if (travel) {
    cards.push({ kind: "card", topic: "travel_itinerary", payload: travel.result });
    cards.push({ kind: "card", topic: "travel_brief", payload: travel.result });
  }

  const weatherOk = okResults(effects, (t) => t.startsWith(WEATHER_PREFIX));
  const weatherAttempted = effects.some((e) => e.tool.startsWith(WEATHER_PREFIX));
  if (weatherOk.length > 0) {
    cards.push({ kind: "card", topic: "weather", payload: { executions: weatherOk } });
  } else if (weatherAttempted) {
    const copy = EMPTY_CARD_COPY["weather.get_local"];
    cards.push({ kind: "empty", topic: "weather", title: copy.title, message: copy.message });
  }

  const seenTopics = new Set<string>();
  let hasRegistryCard = false;
  for (const effect of effects) {
    if (!isRegistryBusinessTool(effect.tool)) continue;
    if (effect.status === "ok" && effect.result) {
      const payload = buildToolCard(effect.tool, effect.result);
      if (!payload || payload.items.length === 0) continue;
      if (seenTopics.has(payload.cardType)) continue;
      seenTopics.add(payload.cardType);
      hasRegistryCard = true;
      cards.push({
        kind: "card",
        topic: payload.cardType,
        payload: payload as unknown as Record<string, unknown>,
      });
      continue;
    }
    const copy = EMPTY_CARD_COPY[effect.tool];
    if (copy) {
      cards.push({ kind: "empty", topic: effect.tool, title: copy.title, message: copy.message });
    }
  }

  const video = okResults(effects, (t) => VIDEO_TOOLS.has(t));
  const lastVideo = video[video.length - 1];
  if (lastVideo) {
    cards.push({ kind: "card", topic: "video", payload: { executions: [lastVideo] } });
  }

  const hasPrimarySurface =
    mediaCardCount > 0 || !!travel || weatherOk.length > 0 || hasRegistryCard;
  if (!hasPrimarySurface) {
    const searchOk = okResults(effects, (t) => SEARCH_TOOLS.has(t));
    if (searchOk.length > 0) {
      cards.push({ kind: "card", topic: "search_result", payload: { executions: searchOk } });
    }
  }

  return cards;
}

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
    case "search_result":
      return { form: "search_result", reason: hint.reason };
    case "data_brief":
      return { form: "data_brief", reason: hint.reason };
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
  const cards = decideCards(input.effects ?? [], input.mediaCardCount ?? 0);
  const body = decideBody(input, text, cards);
  const cardSummary =
    cards.length === 0
      ? "no-cards"
      : cards.map((c) => `${c.kind}:${c.topic}`).join(",");
  return { cards, body, reason: `${cardSummary} | ${body.reason}` };
}
