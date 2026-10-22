// Agent Brain Center — 模块出口
export * from "./types.js";
export { BrainCenter } from "./brain-center.js";
export { CapabilityCortex } from "./capability-cortex.js";
export { AwarenessCortex } from "./awareness-cortex.js";
export { ProactionCortex, type EndToEndDecisionMaker, type EndToEndDecisionContext, type MemoryCortexLike, type RecentConversationProvider } from "./proaction-cortex.js";
export { SensoryCortex } from "./sensory-cortex.js";
export { MemoryCortex } from "./memory-cortex.js";
export { SynapseBus } from "./synapse-bus.js";
export { LimbicCortex } from "./limbic-cortex.js";
export { PlannerCortex, type DelegateJudge } from "./planner-cortex.js";
// subcortical 分区（脑干/小脑）：自主节律 + 时序协调
export { BrainStem } from "./brain-stem.js";
export { Cerebellum } from "./cerebellum.js";
// Step 6 扩展：类人化决策架构新模块（规则驱动 + 统一动作 + 决策协调）
export { RuleRouter, type RuleRouteDecision } from "./rule-router.js";
export { ActionExecutor, type ActionLogEntry, type ActionResult } from "./action-executor.js";
export { DecisionHub, type PassiveDecisionResult, type SharedContext, type AnticipationEngineLike } from "./decision-hub.js";
// Step 7 扩展：7 个新皮层模块（4 类人化 + 3 agent 特化）
export { WorkingMemoryCortex, type WorkingMemorySnapshot, type WorkingMemorySlot, type ActiveGoal, type TodoItem } from "./working-memory-cortex.js";
export { TaskSwitchingCortex, type TaskContext, type SwitchIntent } from "./task-switching-cortex.js";
export { ContextCortex, type SituatedContext, type DesktopActivityLike, type ScheduleLike, type DeviceStateLike } from "./context-cortex.js";
export { ToolPlanningCortex, type ToolPlan, type PlannedTool, type ToolMetadata } from "./tool-planning-cortex.js";
export { OnlineLearningCortex, type UserProfile, type UserPatternEntry } from "./online-learning-cortex.js";

// 深度优化：增强模块（让 BrainCenter 更接近人脑）
export { EmotionModulator, type EmotionModulationResult } from "./emotion-modulator.js";

// 记忆认知架构升级（Phase 0-5）：7 个子模块
export { MemoryAssociativeGraph } from "./memory-cognitive/memory-associative-graph.js";
export { MemoryMetacognitionBridge } from "./memory-cognitive/memory-metacognition-bridge.js";
export { MemoryForgettingController } from "./memory-cognitive/memory-forgetting-controller.js";
export { MemorySchemaFormation } from "./memory-cognitive/memory-schema-formation.js";
export { MemorySalienceFilter } from "./memory-cognitive/memory-salience-filter.js";
export { MemoryExperienceLearningLoop } from "./memory-cognitive/memory-experience-learning-loop.js";
// 推理引擎（多线索交叉推理）：从多条碎片线索生成新结论节点
export {
  MemoryInferenceEngine,
  type InferenceRule,
  type HumanLikeMemoryInferenceLike,
  type MemorySchemaFormationLike,
} from "./memory-cognitive/memory-inference-engine.js";
// 4 项仿人推理能力扩展：规则自学习 + 类比迁移 + 情感调制 + 无意识触发
export {
  RuleLearner,
  type LearnedRule,
} from "./memory-cognitive/memory-inference-rule-learner.js";
// LLM 规则归纳器：让 LLM 从历史记忆中归纳因果规则（仅参与"学规则"）
export {
  LLMRuleInducer,
  type LLMInducedRule,
  LLM_RULE_INDUCTION_SYSTEM_PROMPT,
} from "./memory-cognitive/memory-inference-llm-inducer.js";
export {
  AnalogyMigrator,
  type MigratedRule,
} from "./memory-cognitive/memory-inference-analogy-migrator.js";
export {
  InferenceEmotionModulator,
  type EmotionState,
} from "./memory-cognitive/memory-inference-emotion-modulator.js";
export {
  BrainStemAutoInferer,
} from "./memory-cognitive/memory-inference-brain-stem-auto-inferer.js";

// 认知引擎工厂（可插拔大脑入口）：COGNITIVE_ENGINE_IMPL 环境变量驱动选择不同实现
export {
  createDefaultCognitiveEngine,
  createCognitiveEngineFromEnv,
  registerCognitiveEngineImpl,
} from "./cognitive-engine-factory.js";

// LLM 决策器工厂（可插拔决策器入口）：EndToEndDecisionMaker / DelegateJudge / TopicExtractor
export {
  type TopicExtractor,
  type DecisionMakerSet,
  createDefaultEndToEndDecisionMaker,
  createDefaultDelegateJudge,
  createDefaultTopicExtractor,
  createDecisionMakersFromEnv,
} from "./decision-maker-factory.js";

// 世界模型（World Model）：状态转移 + 学习 + 模拟 + 反事实推理
export {
  type WorldState,
  type WorldAction,
  type WorldPrediction,
  type SimulationTrajectory,
  type TransitionSample,
  type PerceptualSlot,
  type WorldModel,
  RuleBasedWorldModel,
  createWorldModelFromEnv,
} from "./world-model-types.js";

// 世界模型转移样本持久化层
export {
  type TransitionQueryOpts,
  type TransitionStoreStats,
  WorldModelTransitionStore,
  getTransitionStore,
} from "./world-model-transition-store.js";
