/**
 * 场景登记入口 —— 新增一种结构化回复只需要改这一个文件。
 *
 * 新增步骤：
 *   1. 新建 `xxx.scene.ts`，实现 RenderScene（detect + plan + contract）；
 *   2. 在下方 import 并 `sceneRegistry.register(xxxScene)`；
 *   3. 补一条 `test/render-scenes.test.ts` 用例 + 一条真实载荷样例。
 * 不需要改 decide.ts、不需要改客户端、不需要往 prompt 里写版式描述。
 *
 * 优先级约定（数值大者先）：
 *   90 明日预览   数据面完整、版式固定，抢占一切
 *   80 天气       回执确定性建卡
 *   75 提醒确认   创建回执确定性建卡（只读、一轮一张）
 *   70 工具卡面   业务回执注册卡
 *   60 结构卡     模型声明的卡片载荷（需契约校验）
 *   50 盘点清单   结构数据来自工具回执，模型不参与排版
 *    0 正文兜底   必须有，保证计划永远有落点
 */

import { sceneRegistry } from "./registry.js";
import { assertRenderContract } from "../contract.js";
import type { EffectStatus } from "../types.js";
import type { ScenePrePlanResult } from "./types.js";
import { weatherScene } from "./weather.scene.js";
import { tomorrowPreviewScene } from "./tomorrow-preview.scene.js";
import { resultCardScene } from "./result-card.scene.js";
import { digestRoundupScene } from "./digest-roundup.scene.js";
import { reminderConfirmScene } from "./reminder-confirm.scene.js";
import { toolCardsScene } from "./tool-cards.scene.js";
import { markdownScene } from "./markdown.scene.js";

let seeded = false;

/** 幂等登记默认场景（重复 import 不会重复注册） */
export function seedDefaultScenes(): void {
  if (seeded) return;
  seeded = true;
  sceneRegistry.register(tomorrowPreviewScene);
  sceneRegistry.register(weatherScene);
  sceneRegistry.register(reminderConfirmScene);
  sceneRegistry.register(toolCardsScene);
  sceneRegistry.register(resultCardScene);
  sceneRegistry.register(digestRoundupScene);
  sceneRegistry.register(markdownScene);

  // 启动期 fail-fast（2026-11-07）：id 冲突 / priority 非法 / 兜底被挤掉以前
  // 只在 render-scenes.test.ts 里能发现，生产是「带病上线、第一轮才丢渲染」。
  // 自检是纯检查、零 IO，注册完立即跑；不通过宁可起不来，也不静默降级。
  const problems = [
    ...sceneRegistry.assertIntegrity({ requireFallbackId: "markdown" }),
    // P4：produces 声明与客户端 case / 协议白名单交叉校验，新增形态漏登记
    // 就地起不来，不再等线上第一轮「写了卡但用户看不到」才发现。
    ...assertRenderContract(sceneRegistry),
  ];
  if (problems.length > 0) {
    throw new Error(`[render-scenes] 注册表自检失败：${problems.join("；")}`);
  }
}

seedDefaultScenes();

/** 生成前计划的输入：只含模型生成之前就存在的事实（回执 / 用户文本 / 数据面）。 */
export interface PrePlanInput {
  userText?: string;
  toolResults?: Array<{
    toolName: string;
    ok: boolean;
    result?: Record<string, unknown>;
  }>;
  /** 数据面（如 eveningDigest）：由数据持有方在生成前解析并传入 */
  payloads?: Record<string, unknown>;
  mediaCardCount?: number;
  toolName?: string;
  activeTopic?: string;
}

/**
 * 生成前计划（P3）：跑一次 phase=pre 场景的 detect，产出该轮真正要注入
 * prompt 的内容边界。出口阶段复用同一批 scene id 做渲染，不再靠
 * synthesis-strategy 硬编码短路猜场景。
 */
export function planPreRenderScene(input: PrePlanInput): ScenePrePlanResult {
  const effects = (input.toolResults ?? []).map((r) => {
    const status: EffectStatus = r.ok ? "ok" : "error";
    return {
      tool: r.toolName,
      status,
      ...(r.result ? { result: r.result } : {}),
    };
  });
  return sceneRegistry.pre({
    text: "",
    userText: input.userText,
    toolName: input.toolName,
    activeTopic: input.activeTopic,
    mediaCardCount: input.mediaCardCount,
    ...(input.payloads ? { payloads: input.payloads } : {}),
    effects,
  });
}

/**
 * 把 pre-plan 的边界编进 prompt。与 synthesis-strategy 已硬编码注入的指令
 * 精确去重（天气边界两处同源，重复注入只会变成套路，见铁律 0）。
 * 返回空串表示本轮无需新增边界 → 输出与升级前逐字节一致。
 */
export function buildSceneBoundaryBlock(
  pre: ScenePrePlanResult,
  existingInstruction = "",
): string {
  const boundaries = pre.boundaries.filter(
    (b) => b.trim() && !existingInstruction.includes(b),
  );
  return boundaries.length > 0
    ? `\n\n【本轮渲染边界】${boundaries.join("\n")}`
    : "";
}

export { sceneRegistry, SceneRegistry } from "./registry.js";
export { planRenderScene, listSceneContracts } from "./plan.js";
export { weatherScene } from "./weather.scene.js";
export { tomorrowPreviewScene, renderTomorrowPreviewFacts, formatPreviewDate } from "./tomorrow-preview.scene.js";
export { resultCardScene, auditResultCards, stripResultCardBlocks } from "./result-card.scene.js";
export {
  digestRoundupScene,
  collectRoundupItems,
  renderRoundupFacts,
} from "./digest-roundup.scene.js";
export {
  reminderConfirmScene,
  buildReminderConfirmPayload,
} from "./reminder-confirm.scene.js";
export { toolCardsScene, decideToolCards } from "./tool-cards.scene.js";
export { markdownScene } from "./markdown.scene.js";
export {
  WEATHER_CARD_BOUNDARY,
  TOMORROW_PREVIEW_BOUNDARY,
  REMINDER_CONFIRM_BOUNDARY,
  DIGEST_ROUNDUP_BOUNDARY,
  RESULT_CARD_TYPES,
  RESULT_CARD_CONTRACT,
} from "./prompts.js";
export type { SceneContext, ScenePlan, ScenePlanResult, RenderScene, SceneMatch, SceneProduces, ScenePrePlanResult } from "./types.js";
