/**
 * 渲染契约（P4，2026-11-07）——双端唯一事实源。
 *
 * 场景通过 RenderScene.produces 声明自己会产出什么；本模块把全部声明汇总成
 * 一份机器可读契约，并做启动期交叉校验：
 *   - forms ⊆ RENDER_AS_FORMS（客户端 switch 的 case 集合）；
 *   - cardTypes ⊆ DISPLAY_EFFECT_TYPES ∪ 显式许可（permission_request 等）；
 *   - 每个 pre 场景声明了 promptBoundary 就必须真有内容（防空声明骗过门）；
 *   - rewritesText 场景必须有 phase=pre（否则生成前无法接管正文）。
 *
 * 新增形态只需要：写一个 scene + produces 声明 + 注册一行。
 * 契约 JSON 由 `npm run render:contract` 导出，双端测试读同一份文件比对。
 */

import { DISPLAY_EFFECT_TYPES } from "@nextbot/agent-protocol";
import type { SceneRegistry } from "./scenes/registry.js";

/** [RENDER_AS:*] 的全部合法形态名（与客户端 message_body_renderer.dart 的 switch 一致） */
export const RENDER_AS_FORMS = [
  "brief",
  "structured",
  "image_result",
  "data_brief",
  "video",
] as const;

/** 信封块类型（与 render/protocol.ts 的 EnvelopeBlock 一一对应） */
export const ENVELOPE_BLOCK_TYPES = [
  "text",
  "card",
  "form",
  "structured",
  "media",
  "summary",
  "followups",
  "media_segments",
] as const;

/** DISPLAY_EFFECT_TYPES 之外、由业务协议显式许可的 cardType */
export const EXTRA_CARD_TYPES = ["permission_request"] as const;

/**
 * 已知历史债务：这些 cardType 客户端没有专用 case，静默走通用列表卡。
 * 与 render-scenes.test.ts 的双端漂移门同一份清单（新增卡型必须接客户端）。
 */
export const KNOWN_CLIENT_EXEMPT_CARD_TYPES = [
  "file",
  "order",
  "schedule",
  "wallet",
] as const;

export interface RenderContractScene {
  id: string;
  label: string;
  priority: number;
  phase: "pre" | "post";
  cardTypes: string[];
  forms: string[];
  rewritesText: boolean;
  hasPromptBoundary: boolean;
}

export interface RenderContract {
  version: 2;
  generatedBy: "server/src/render/contract.ts";
  scenes: RenderContractScene[];
  cardTypes: string[];
  forms: string[];
  renderAsForms: readonly string[];
  blockTypes: readonly string[];
  knownClientExempt: readonly string[];
}

/** 汇总全部场景声明，输出稳定排序的契约（供构建期导出与测试比对）。 */
export function buildRenderContract(registry: SceneRegistry): RenderContract {
  const scenes: RenderContractScene[] = registry.list().map((scene) => ({
    id: scene.id,
    label: scene.label,
    priority: scene.priority,
    phase: scene.phase ?? "post",
    cardTypes: [...(scene.produces?.cardTypes ?? [])].sort(),
    forms: [...(scene.produces?.forms ?? [])].sort(),
    rewritesText: scene.produces?.rewritesText === true,
    hasPromptBoundary: Boolean(scene.produces?.promptBoundary?.trim()),
  }));
  const cardTypes = [...new Set(scenes.flatMap((s) => s.cardTypes))].sort();
  const forms = [...new Set(scenes.flatMap((s) => s.forms))].sort();
  return {
    version: 2,
    generatedBy: "server/src/render/contract.ts",
    scenes,
    cardTypes,
    forms,
    renderAsForms: RENDER_AS_FORMS,
    blockTypes: ENVELOPE_BLOCK_TYPES,
    knownClientExempt: KNOWN_CLIENT_EXEMPT_CARD_TYPES,
  };
}

/** 启动期 fail-fast 校验；返回空数组 = 契约健康。 */
export function assertRenderContract(registry: SceneRegistry): string[] {
  const problems: string[] = [];
  const allowedCardTypes = new Set<string>([
    ...DISPLAY_EFFECT_TYPES.filter((t) => t !== ""),
    ...EXTRA_CARD_TYPES,
  ]);
  const allowedForms = new Set<string>(RENDER_AS_FORMS);

  for (const scene of registry.list()) {
    const produces = scene.produces;
    for (const cardType of produces?.cardTypes ?? []) {
      if (!allowedCardTypes.has(cardType)) {
        problems.push(`${scene.id}: 未登记的 cardType「${cardType}」`);
      }
    }
    for (const form of produces?.forms ?? []) {
      if (!allowedForms.has(form)) {
        problems.push(`${scene.id}: 客户端没有 case 的 RENDER_AS 形态「${form}」`);
      }
    }
    if (produces?.rewritesText && (scene.phase ?? "post") !== "pre") {
      problems.push(`${scene.id}: 重写正文的场景必须声明 phase:"pre"`);
    }
    if (produces && "promptBoundary" in produces && !produces.promptBoundary?.trim()) {
      problems.push(`${scene.id}: promptBoundary 声明了却为空`);
    }
  }

  const ids = new Set<string>();
  for (const scene of registry.list()) {
    if (ids.has(scene.id)) problems.push(`重复 scene id: ${scene.id}`);
    ids.add(scene.id);
    if (!scene.produces && scene.id !== "markdown") {
      problems.push(`${scene.id}: 缺少 produces 声明（新增形态必须声明产出）`);
    }
  }
  if (!ids.has("markdown")) problems.push("缺少 markdown 兜底场景");
  return problems;
}
