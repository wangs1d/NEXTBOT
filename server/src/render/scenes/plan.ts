/**
 * 场景计划入口：把「这一轮长什么样」收敛成一次纯函数调用。
 *
 * 调用顺序（decideRender）：
 *   SceneContext → planRenderScene() → RenderDecision（cards/body/text）
 */

import { sceneRegistry } from "./registry.js";
import type { SceneContext, ScenePlanResult } from "./types.js";

/** 跑一遍默认注册表，返回合并后的计划 */
export function planRenderScene(ctx: SceneContext): ScenePlanResult {
  return sceneRegistry.plan(ctx);
}

/** 场景契约清单（prompt 组装 / 文档 / 观测用；不含版式修辞） */
export function listSceneContracts(): Array<{ id: string; label: string; priority: number; contract: string }> {
  return sceneRegistry.list().map((s) => ({
    id: s.id,
    label: s.label,
    priority: s.priority,
    contract: s.contract ?? "",
  }));
}
