// Agent Brain Center — 认知引擎工厂（可插拔大脑入口）
//
// 职责：把 CognitiveEngine 的具体实现从 bootstrap 装配代码中解耦，
// 通过环境变量 COGNITIVE_ENGINE_IMPL 配置驱动选择不同实现，
// 让"换大脑"（升级到更强 LLM / 切换到 AGI 世界模型）只需改环境变量，
// 无需改动 bootstrap 装配代码。
//
// 设计原则（与 BodyGateway / registerCognitiveEngine 一致）：
//   1. 默认实现保持与原 bootstrap 内联实现完全等价（向后兼容）
//   2. 工厂返回 CognitiveEngine 接口，调用方不感知具体实现
//   3. 新增实现只需在此文件追加 case，不改 bootstrap
//   4. 未识别的 COGNITIVE_ENGINE_IMPL 值 → 回退默认实现 + 警告日志
//
// 未来"换 AGI 大脑"路径：
//   - 新增 world-model-cognitive-engine.ts 实现 CognitiveEngine 接口
//   - 在工厂 case 中注册 "world-model"
//   - 设 COGNITIVE_ENGINE_IMPL=world-model 即可切换，bootstrap 零改动

import type { CognitiveEngine, CognitiveInput, CognitiveContext } from "./types.js";

/**
 * 默认认知引擎实现：确定性路由（零 LLM）。
 *
 * 行为与原 create-app-services.ts 内联实现等价（就路由结果而言）：
 *   - 产出 route（mode=direct，交由外层 streamCompletion 生成回复）
 *   - 不产出 response（统一走 streamCompletion 让主 Agent 生成回复）
 *   - needsToolLoop=true（与既有默认实现一致）
 *
 * 2026-10-20 token 优化（短路死路径）：DecisionHub（规则驱动端到端认知）已在
 * bootstrap 装配处**无条件**注册（create-app-services.ts 无条件 setDecisionHub），
 * BrainCenter.cognize 阶段 2 优先走 decisionHub.decidePassive，本引擎的
 * `else if (this.cognitiveEngine)` 分支永不执行——此处原先的 LLM 路由调用是
 * 纯死路径，且其 prompt 本身硬编码 `{"mode": "direct"}`（模型无论怎么答都只能
 * 得到 direct），LLM 调用对路由结果零影响。现直接短路为确定性诊断路由，
 * 保留 CognitiveEngine 接口与诊断字段（rationale），可插拔扩展（COGNITIVE_ENGINE_IMPL
 * / registerCognitiveEngineImpl）不受影响。
 */
export function createDefaultCognitiveEngine(): CognitiveEngine {
  return {
    async cognize(input: CognitiveInput, ctx: CognitiveContext) {
      const userText = input.text ?? ctx.audioText ?? "";
      const now = new Date().toISOString();
      const route = {
        userMessage: userText,
        system: "system1" as const,
        mode: "direct" as const,
        rationale: "cognize_shortcircuit:decision_hub_authoritative",
        decidedAt: now,
      };
      return {
        route,
        response: "",
        memoryWrites: [],
        needsToolLoop: true,
        rationale: route.rationale,
      };
    },
  };
}

/**
 * 认知引擎注册表：COGNITIVE_ENGINE_IMPL 值 → 工厂函数。
 *
 * 新增实现时在此追加一行即可。默认实现已注册为 "default"。
 *
 * 未来"换 AGI 大脑"示例：
 *   COGNITIVE_ENGINE_IMPL=world-model → 注册 createWorldModelCognitiveEngine()
 *   COGNITIVE_ENGINE_IMPL=anthropic   → 注册 createAnthropicCognitiveEngine()
 */
const COGNITIVE_ENGINE_REGISTRY: Record<string, () => CognitiveEngine> = {
  default: createDefaultCognitiveEngine,
  openai: createDefaultCognitiveEngine, // 别名：OpenAI 兼容协议
};

/**
 * 注册自定义认知引擎实现（供外部项目扩展）。
 *
 * 调用时机：在 bootstrap 调 createCognitiveEngineFromEnv() 之前注册。
 * 示例：外部 AGI 项目 import { registerCognitiveEngine } from "..." 后注册自己的实现。
 */
export function registerCognitiveEngineImpl(name: string, factory: () => CognitiveEngine): void {
  COGNITIVE_ENGINE_REGISTRY[name] = factory;
}

/**
 * 根据环境变量 COGNITIVE_ENGINE_IMPL 创建认知引擎实例。
 *
 * - 未设置 / "default" / "openai" → 默认 OpenAI 兼容实现
 * - 其他已注册值 → 对应实现
 * - 未识别值 → 回退默认实现 + 警告日志（fail-safe，不让 typo 阻断启动）
 *
 * bootstrap 装配处只需：
 *   const cognitiveEngine = createCognitiveEngineFromEnv();
 *   brainCenter.registerCognitiveEngine(cognitiveEngine);
 */
export function createCognitiveEngineFromEnv(): CognitiveEngine {
  const implName = (process.env.COGNITIVE_ENGINE_IMPL ?? "default").trim().toLowerCase();
  const factory = COGNITIVE_ENGINE_REGISTRY[implName];
  if (factory) {
    if (implName !== "default" && implName !== "openai") {
      console.log(`[CognitiveEngineFactory] 使用自定义认知引擎实现: ${implName}`);
    }
    return factory();
  }
  console.warn(`[CognitiveEngineFactory] 未识别的 COGNITIVE_ENGINE_IMPL="${implName}"，回退默认实现`);
  return createDefaultCognitiveEngine();
}
