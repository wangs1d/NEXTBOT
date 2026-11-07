/**
 * 天气场景：weather.* 回执 → 确定性天气卡（Tier A，零模型参与）。
 *
 * 数据源：本轮真实工具回执（effects）。没有回执就绝不出天气卡——
 * 卡只从事实来，不从正文里的数字反推。
 */

import type { TurnEffect } from "../types.js";
import type { RenderScene, SceneContext, SceneMatch } from "./types.js";
import { WEATHER_CARD_BOUNDARY } from "./prompts.js";

const WEATHER_PREFIX = "weather.";

function weatherEffects(ctx: SceneContext): TurnEffect[] {
  // 单工具直跑路径的 toolResult 在进入决策层前已并成 effects（见
  // tool-result-processor 的 directEffects），场景只认 effects，避免两条源。
  return (ctx.effects ?? []).filter((e) => e.tool.startsWith(WEATHER_PREFIX));
}

export const weatherScene: RenderScene = {
  id: "weather",
  label: "天气卡",
  priority: 80,
  phase: "pre",
  produces: {
    cardTypes: ["weather"],
    promptBoundary: WEATHER_CARD_BOUNDARY,
  },
  contract: "天气数值由卡片承载；正文只给口语结论与建议，不复述数值、不给坐标。",

  detect(ctx: SceneContext): SceneMatch | null {
    const weather = weatherEffects(ctx);
    if (weather.length === 0) return null;
    const ok = weather.filter((e) => e.status === "ok" && e.result);
    // 全部失败时不再出空态警示卡（2026-11-06 用户定稿：空态卡整体退役），
    // 本场景整体让位，失败说明由正文承担。
    if (ok.length === 0) return null;
    return { reason: `${ok.length} 次天气回执` };
  },

  plan(ctx, match) {
    const weather = weatherEffects(ctx);
    // applyCards 读 payload.executions 的 `tool` 字段（render/cards.ts 的
    // readExecutions），这里必须写 tool——写 toolName 会被过滤掉，天气卡静默丢失。
    const ok = weather
      .filter((e) => e.status === "ok" && e.result)
      .map((e) => ({ tool: e.tool, result: e.result as Record<string, unknown> }));

    if (ok.length === 0) {
      return {
        sceneId: this.id,
        label: this.label,
        cards: [],
        bodyForm: "plain",
        promptFragment: WEATHER_CARD_BOUNDARY,
        constraints: ["失败轮不出卡：正文如实说明没拿到数据，不猜天气数值"],
        reason: match.reason,
      };
    }

    return {
      sceneId: this.id,
      label: this.label,
      cards: [{ kind: "card", topic: "weather", payload: { executions: ok } }],
      bodyForm: "plain",
      promptFragment: WEATHER_CARD_BOUNDARY,
      constraints: ["正文不复述数值", "正文不给经纬度"],
      reason: match.reason,
    };
  },
};
