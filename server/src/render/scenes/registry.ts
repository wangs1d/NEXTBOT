/**
 * 场景注册表：唯一登记处 + 竞争合并规则。
 *
 * 规则：
 *   R1 同 id 只能登记一次（重复登记直接抛错，防止「热更两次逻辑翻倍」）。
 *   R2 卡按 `kind:topic` 去重——高优先级场景先占位，低优先级不得重复建同一张卡。
 *   R3 bodyForm 由优先级最高的、显式声明了形态的场景决定；都不声明则返回
 *      undefined，由 decideBody 的规则链判断。
 *   R4 text 改写由优先级最高且给出 text 的场景决定（如结构卡坏块剥离）。
 *   R5 单个场景故障隔离（2026-11-07）：detect/plan 抛异常只跳过该场景并记入
 *      failures，绝不让整轮回复落空——markdown 兜底场景恒命中，decideBody
 *      也仍会给正文形态。失败信息随 reason 进出口 render 日志，本文件不打日志。
 *
 * 纯逻辑：不读文件、不打日志、不调 LLM，可被单测直接驱动。
 */

import type { CardSpec } from "../types.js";
import type {
  RenderScene,
  SceneContext,
  ScenePlan,
  ScenePlanResult,
  ScenePrePlanResult,
} from "./types.js";

/** 注册表；测试与「运行期扩展」都用它（默认单例 sceneRegistry） */
export class SceneRegistry {
  private readonly entries: RenderScene[] = [];

  register(scene: RenderScene): void {
    if (!scene?.id || typeof scene.detect !== "function" || typeof scene.plan !== "function") {
      throw new Error("场景定义不完整：必须提供 id/detect/plan");
    }
    if (this.entries.some((s) => s.id === scene.id)) {
      throw new Error(`场景 id 重复登记：${scene.id}`);
    }
    if (!Number.isFinite(scene.priority)) {
      throw new Error(`场景 ${scene.id} 的 priority 必须是有限数字`);
    }
    this.entries.push(scene);
  }

  unregister(id: string): boolean {
    const idx = this.entries.findIndex((s) => s.id === id);
    if (idx < 0) return false;
    this.entries.splice(idx, 1);
    return true;
  }

  get(id: string): RenderScene | undefined {
    return this.entries.find((s) => s.id === id);
  }

  /** 优先级降序；同优先级按注册顺序（稳定排序） */
  list(): RenderScene[] {
    return this.entries
      .map((scene, index) => ({ scene, index }))
      .sort((a, b) => b.scene.priority - a.scene.priority || a.index - b.index)
      .map((x) => x.scene);
  }

  /**
   * 生成前计划（P3）：只跑 phase=pre 场景的 detect，收集 prompt 边界。
   *
   * 关键守卫：ctx 是屏蔽了 text 的 Proxy——pre 场景一旦读 ctx.text 立即抛错，
   * 该场景被跳过并记入 failures。这把「生成前不可能拿到模型正文」从口头约定
   * 变成运行期硬约束，杜绝把 promptFragment 前移后又偷偷依赖正文。
   *
   * 不调用 plan()：plan 允许读 ctx.text（如盘点剥语气句），它只属于出口阶段。
   */
  pre(ctx: SceneContext): ScenePrePlanResult {
    const guarded = new Proxy({ ...ctx, text: "" }, {
      get(target, prop, receiver) {
        if (prop === "text") {
          throw new Error("pre 场景 detect 禁止读取 ctx.text（模型正文此时尚不存在）");
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as SceneContext;

    const matched: string[] = [];
    const boundaries: string[] = [];
    const failures: string[] = [];
    for (const scene of this.list()) {
      if (scene.phase !== "pre") continue;
      try {
        if (!scene.detect(guarded)) continue;
        matched.push(scene.id);
        const staticBoundary = scene.produces?.promptBoundary?.trim() ?? "";
        let dynamicBoundary = "";
        try {
          dynamicBoundary = scene.promptBoundaryFor?.(guarded)?.trim() ?? "";
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          failures.push(`${scene.id}:boundary:${message}`);
        }
        const merged = [staticBoundary, dynamicBoundary].filter(Boolean).join("\n");
        if (merged && !boundaries.includes(merged)) boundaries.push(merged);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        failures.push(`${scene.id}:${message}`);
      }
    }
    return {
      matched,
      boundaries,
      failures,
      reason: [
        matched.length ? `pre-scenes=${matched.join(",")}` : "no-pre-scene",
        ...(failures.length ? [`pre-failures=${failures.join("|")}`] : []),
      ].join(" | "),
    };
  }

  /** 跑一遍全部场景，合并成一个计划 */
  plan(ctx: SceneContext): ScenePlanResult {
    const matched: ScenePlan[] = [];
    const failures: string[] = [];
    for (const scene of this.list()) {
      try {
        const hit = scene.detect(ctx);
        if (!hit) continue;
        const plan = scene.plan(ctx, hit);
        if (!plan) continue;
        matched.push({ ...plan, sceneId: scene.id, label: scene.label });
      } catch (err) {
        // 新场景里一个空指针就让整轮 finalText 变空，是「渲染不能正常返回」
        // 最致命的形态。这里降级为跳过该场景，并把失败原因带进 reason。
        const message = err instanceof Error ? err.message : String(err);
        failures.push(`${scene.id}:${message}`);
      }
    }

    const cards: CardSpec[] = [];
    const seen = new Set<string>();
    for (const plan of matched) {
      for (const card of plan.cards) {
        const key = `${card.kind}:${card.topic}`;
        if (seen.has(key)) continue;
        seen.add(key);
        cards.push(card);
      }
    }

    const primary = matched[0];
    const bodyForm = matched.find((p) => p.bodyForm)?.bodyForm;
    const text = matched.find((p) => typeof p.text === "string")?.text;
    const reason = [
      matched.length
        ? matched.map((p) => `${p.sceneId}(${p.reason})`).join(" → ")
        : "no-scene",
      ...(failures.length ? [`scene-failures=${failures.join("|")}`] : []),
    ].join(" | ");

    return {
      primary: primary?.sceneId ?? "none",
      matched,
      cards,
      bodyForm,
      text,
      reason,
      failures,
    };
  }

  /** 契约自检：id 唯一、优先级有限、markdown 兜底存在（供测试与启动自检用） */
  assertIntegrity(options?: { requireFallbackId?: string }): string[] {
    const problems: string[] = [];
    const ids = new Set<string>();
    for (const s of this.entries) {
      if (ids.has(s.id)) problems.push(`重复 id: ${s.id}`);
      ids.add(s.id);
      if (!Number.isFinite(s.priority)) problems.push(`${s.id} priority 非法`);
      if (!s.label) problems.push(`${s.id} 缺少 label`);
    }
    const requireId = options?.requireFallbackId;
    if (requireId && !ids.has(requireId)) problems.push(`缺少兜底场景: ${requireId}`);
    return problems;
  }
}

/** 进程级默认注册表：场景在 scenes/index.ts 里登记 */
export const sceneRegistry = new SceneRegistry();
