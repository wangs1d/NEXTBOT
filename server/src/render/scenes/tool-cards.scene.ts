/**
 * 工具卡面场景：业务工具真实回执 → 注册表卡片（Tier A）。
 *
 * 这里承接原先 decide.ts 里的 decideCards 逻辑（语义不变）：
 *   媒体 → 行程(+简报) → 注册业务卡 → 视频
 * 天气已上移到独立的 weather 场景（优先级更高），此处不再建天气卡，
 * 避免同一 topic 两张卡。
 *
 * 三条硬规则（原样保留）：
 *   R1 业务卡只从真实回执产出；没有回执就不可能有业务卡。
 *   R2 网页搜索不产任何结构化卡（搜索回执只作模型上下文）。
 *   R3 结构化面在场时正文只作前导（bodyForm=plain）。
 */

import { buildToolCard, lookupToolCardBuilder } from "../../services/tool-card-registry.js";
import type { CardSpec, TurnEffect } from "../types.js";
import type { RenderScene, SceneContext, SceneMatch } from "./types.js";

const MEDIA_TOOLS = new Set(["search_images", "search_images_batch", "search_videos", "image.generate"]);
const SEARCH_TOOLS = new Set(["search_web", "info.search"]);
const VIDEO_TOOLS = new Set(["video.grab", "video.find"]);
const WEATHER_PREFIX = "weather.";
const TRAVEL_TOOL = "travel.plan-itinerary";

// 失败空态警示卡（EMPTY_CARD_COPY，如「下单没有完成，没有生成订单」）已整体
// 退役（2026-11-06 用户定稿）：一张只有一句警告的卡在对话里既不成信息也不成
// 操作，观感最差。工具失败的原因与下一步一律由正文说明，不再出任何空态卡。

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

/** 卡取舍顺序即优先级：媒体 → 行程(+简报) → 注册业务卡 → 视频 */
export function decideToolCards(
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

  const seenTopics = new Set<string>();
  for (const effect of effects) {
    if (!isRegistryBusinessTool(effect.tool)) continue;
    if (effect.status === "ok" && effect.result) {
      const payload = buildToolCard(effect.tool, effect.result);
      if (!payload || payload.items.length === 0) continue;
      if (seenTopics.has(payload.cardType)) continue;
      seenTopics.add(payload.cardType);
      cards.push({
        kind: "card",
        topic: payload.cardType,
        payload: payload as unknown as Record<string, unknown>,
      });
    }
    // 失败回执不产卡：失败说明由正文承担（2026-11-06 空态卡整体退役）。
  }

  const video = okResults(effects, (t) => VIDEO_TOOLS.has(t));
  const lastVideo = video[video.length - 1];
  if (lastVideo) {
    cards.push({ kind: "card", topic: "video", payload: { executions: [lastVideo] } });
  }

  // 网页搜索刻意不留兜底分支：不要为了「搜索轮至少有个卡」再加回来。
  return cards;
}

export const toolCardsScene: RenderScene = {
  id: "tool_cards",
  label: "工具卡面",
  priority: 70,
  phase: "pre",
  // cardTypes 由 tool-card-registry 依回执动态决定，不在此静态枚举；
  // 双端漂移门（render-scenes.test.ts）覆盖全量注册卡型。
  produces: { cardTypes: [] },
  contract: "业务卡只从真实回执产出；失败轮不出卡（空态卡已退役），失败说明由正文承担。",

  detect(ctx: SceneContext): SceneMatch | null {
    const cards = decideToolCards(ctx.effects ?? [], ctx.mediaCardCount ?? 0);
    if (cards.length === 0) return null;
    const attempted = (ctx.effects ?? []).filter((e) => e.status !== "ok").length;
    return {
      reason: `${cards.length} 张卡（${cards.map((c) => `${c.kind}:${c.topic}`).join(",")}${attempted > 0 ? `，${attempted} 个失败回执` : ""}）`,
    };
  },

  plan(ctx, match) {
    const cards = decideToolCards(ctx.effects ?? [], ctx.mediaCardCount ?? 0);
    return {
      sceneId: this.id,
      label: this.label,
      cards,
      bodyForm: "plain",
      constraints: ["正文只作前导", "正文不复述卡内条目"],
      reason: match.reason,
    };
  },
};
