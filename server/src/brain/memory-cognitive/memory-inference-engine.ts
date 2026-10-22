// Agent Brain Center — MemoryInferenceEngine（推理引擎 / 多线索交叉推理）
//
// 职责：让 agent 能从多条碎片线索（显性 + 隐性）交叉推理出新结论，
//   类似人类直觉推理。结论是图中原本不存在的节点，是真正"创造"出来的。
//
// 核心原则：
//   1. 不调 LLM 演戏——推理过程是程序化算法（RegExp + 模板拼接 + 置信度计算）
//   2. 生成新节点——结论必须是图中原本不存在的节点（与 spread 检索区分）
//   3. 多线索交叉——至少 2 条线索才能触发推理（单条线索不构成推理）
//   4. 置信度算法——基于线索数量、激活值、规则强度、因果链完整性综合计算
//   5. 可回写——高置信结论（> 0.6）回写到 HumanLikeMemoryService 成为新记忆节点
//   6. 环境开关——BRAIN_MEMORY_INFERENCE_ENABLED 缺省开启
//
// 5 层流水线：
//   线索输入 → 1.扩散层 → 2.汇合检测层 → 3.规则匹配层 → 4.结论生成层 → 5.置信度评估层
//                                                                       ↓
//                                                                  回写记忆图
//
// 详见 spec: .trae/specs/extend-memory-cognitive-architecture/spec.md

import type {
  InferenceClue,
  InferenceNode,
  InferenceResult,
} from "../types.js";
import type { MemoryAssociativeGraph } from "./memory-associative-graph.js";
import type { EmotionState, InferenceEmotionModulator } from "./memory-inference-emotion-modulator.js";
import { RuleLearner, type LearnedRule } from "./memory-inference-rule-learner.js";
import type { AnalogyMigrator, MigratedRule } from "./memory-inference-analogy-migrator.js";
import type { LLMRuleInducer } from "./memory-inference-llm-inducer.js";

// ============================================================
// 外观接口（结构兼容即可，不要求 HumanLikeMemoryService 实现这些方法）
// ============================================================

/**
 * HumanLikeMemoryService 的最小化外观接口（推理引擎版）。
 *
 * 推理引擎需要：
 *   1. 读取所有节点（用于扩散汇合检测 + 反例检查）
 *   2. 读取所有边（用于因果链完整性检查）
 *   3. 回写推理结论为新节点（高置信时调用）
 */
export interface HumanLikeMemoryInferenceLike {
  /** 获取指定 actor 的所有节点 */
  getAllNodes(actorId: string): Array<{
    id: string;
    summary: string;
    keywords: string[];
    confidence: number;
  }>;
  /** 获取指定 actor 的所有边 */
  getAllEdges(actorId: string): Array<{
    id: string;
    from: string;
    to: string;
    relation: string;
    weight: number;
  }>;
  /** 回写推理结论为新节点（高置信时调用） */
  ingestInferredNode?(actorId: string, node: InferenceNode): void;
}

// ============================================================
// 推理规则
// ============================================================

/**
 * 推理规则（可扩展注册）。
 *
 * 触发条件：
 *   1. requiredTags 全部被线索关键词合集覆盖
 *   2. patterns.clueAPattern 与 patterns.clueBPattern 能匹配到不同线索
 *
 * 结论生成：
 *   用 template 拼接，占位符 {A} {B} {X} {Y} {P} {行为} {目的}
 *   引用线索中匹配到的实体（简单 NER：从 clue text 中提取匹配子串）
 *
 * inducedBy 字段标记规则来源（可选，向后兼容）：
 *   - 缺省：内置规则（registerBuiltinRules 注册）
 *   - "algorithm"：RuleLearner 纯算法归纳（N-gram 共现陈述）
 *   - "llm"：LLMRuleInducer 归纳的因果模板（LLM 只参与"学规则"，不参与"用规则推理"）
 */
export interface InferenceRule {
  /** 规则 id（唯一） */
  id: string;
  /** 规则名 */
  name: string;
  /** 规则描述 */
  description: string;
  /** 触发条件：需要哪些"语义标签"同时存在（线索关键词合集需覆盖全部） */
  requiredTags: string[];
  /** 模式匹配：用关键词正则匹配（不调 LLM） */
  patterns: {
    /** 线索 A 匹配模式 */
    clueAPattern: RegExp;
    /** 线索 B 匹配模式 */
    clueBPattern: RegExp;
  };
  /** 结论模板：用占位符 {A} {B} 引用线索中的实体 */
  template: string;
  /** 基础置信度 */
  baseConfidence: number;
  /** 规则来源标记（可选，向后兼容；缺省视为内置规则） */
  inducedBy?: "algorithm" | "llm";
}

// ============================================================
// 配置（从环境变量读取，带缺省值）
// ============================================================

interface InferenceEngineConfig {
  /** 主开关（BRAIN_MEMORY_INFERENCE_ENABLED，缺省 1） */
  enabled: boolean;
  /** 高置信回写阈值（BRAIN_MEMORY_INFERENCE_WRITEBACK_THRESHOLD，缺省 0.6） */
  writebackThreshold: number;
  /** 扩散汇合加成（BRAIN_MEMORY_INFERENCE_CONVERGENCE_BONUS，缺省 0.15） */
  convergenceBonus: number;
  /** 因果链完整加成（BRAIN_MEMORY_INFERENCE_CAUSAL_BONUS，缺省 0.2） */
  causalChainBonus: number;
  /** 反例惩罚（BRAIN_MEMORY_INFERENCE_COUNTER_PENALTY，缺省 0.3） */
  counterExamplePenalty: number;
}

/** 从环境变量加载配置（每次调用实时读取，便于测试动态切换） */
function loadConfig(): InferenceEngineConfig {
  const num = (key: string, def: number): number => {
    const raw = process.env[key]?.trim();
    if (!raw) return def;
    const n = Number(raw);
    return Number.isFinite(n) ? n : def;
  };
  const bool = (key: string, def: boolean): boolean => {
    const raw = process.env[key]?.trim();
    if (raw === undefined || raw === "") return def;
    return raw === "1" || raw === "true" || raw === "yes";
  };
  return {
    enabled: bool("BRAIN_MEMORY_INFERENCE_ENABLED", true),
    writebackThreshold: num("BRAIN_MEMORY_INFERENCE_WRITEBACK_THRESHOLD", 0.6),
    convergenceBonus: num("BRAIN_MEMORY_INFERENCE_CONVERGENCE_BONUS", 0.15),
    causalChainBonus: num("BRAIN_MEMORY_INFERENCE_CAUSAL_BONUS", 0.2),
    counterExamplePenalty: num("BRAIN_MEMORY_INFERENCE_COUNTER_PENALTY", 0.3),
  };
}

// ============================================================
// 常量
// ============================================================

/** 显性线索权重 */
const EXPLICIT_CLUE_WEIGHT = 1.0;
/** 隐性线索权重（memory_recalled 来源） */
const IMPLICIT_CLUE_WEIGHT = 0.6;
/** 因果链最小深度（A→B→C 算完整链） */
const MIN_CAUSAL_CHAIN_DEPTH = 3;
/** 反例关键词（出现在节点 summary 中视为反例） */
const COUNTER_EXAMPLE_KEYWORDS = ["不是", "没有", "错误", "失败", "反例", "否定"];

// ============================================================
// 工具函数
// ============================================================

/**
 * FNV-1a 32 位哈希（用于推理结论 id 生成 + 去重）。
 *
 * 同一 conclusion 文本必然生成相同 hash，从而保证去重一致性。
 */
function fnv1aHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    // FNV prime
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** 限制数值在 [min, max] 区间 */
function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

/**
 * 简单 NER：从 clue text 中提取匹配 pattern 的子串作为实体。
 *
 * 用于填充模板占位符 {A} {B}。
 * 提取规则：取 pattern.exec(clue) 的第一个匹配组（若有），否则取整个匹配子串。
 * 若无匹配返回空串（模板将拼接出"空实体"，可读性受影响但不会崩）。
 */
function extractEntity(clueText: string, pattern: RegExp): string {
  const m = pattern.exec(clueText);
  if (!m) return "";
  // 优先用第一个捕获组
  if (m[1]) return m[1];
  return m[0];
}

/**
 * 填充模板占位符。
 *
 * 支持占位符：{A} {B} {X} {Y} {P} {行为} {目的}
 * 用 entities 字典中的对应值替换。未提供的占位符保留原样。
 */
function fillTemplate(template: string, entities: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_match, key: string) => {
    return entities[key] ?? `{${key}}`;
  });
}

/** 简单分词（中英文混合，按空格 + 标点切分，转小写） */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[\s,，。.、;；!！?？:："'`'（）()【】\[\]]+/)
    .filter((t) => t.length > 0);
}

// ============================================================
// MemoryInferenceEngine 主类
// ============================================================

/**
 * 推理引擎（多线索交叉推理）。
 *
 * 实现核心方法：
 *   1. inferFromClues — 从多条线索推理出新的结论节点
 *   2. registerRule — 注册自定义规则
 *   3. getInferences — 获取某 actor 的所有推理结论
 *   4. markVerified — 标记推理结论的验证状态
 *
 * 不调 LLM。所有推理是规则匹配 + 模板拼接的纯算法结果。
 */
export class MemoryInferenceEngine {
  private readonly humanLike: HumanLikeMemoryInferenceLike | null;
  private readonly associativeGraph: MemoryAssociativeGraph | null;
  /** 规则集（按注册顺序） */
  private readonly rules: InferenceRule[] = [];
  /** 推理结论缓存：key = `${actorId}::${conclusionHash}` */
  private readonly inferences = new Map<string, InferenceNode[]>();
  /** actor 级别的结论索引：key = actorId，value = 该 actor 所有结论 */
  private readonly actorIndex = new Map<string, string[]>();
  // ---- 4 项仿人推理能力扩展（可选注入）----
  /** 情感调制器（未注入时不调制） */
  private readonly emotionModulator: InferenceEmotionModulator | null;
  /** 规则自学习器（未注入时不自学习） */
  private readonly ruleLearner: RuleLearner | null;
  /** 类比迁移器（未注入时不迁移） */
  private readonly analogyMigrator: AnalogyMigrator | null;
  /** 已学习规则的 id 集合（用于 getLearnedRules 过滤） */
  private readonly learnedRuleIds = new Set<string>();
  /** 已迁移规则的 id 集合（用于 getMigratedRules 过滤） */
  private readonly migratedRuleIds = new Set<string>();

  constructor(opts: {
    humanLike?: HumanLikeMemoryInferenceLike | null;
    associativeGraph?: MemoryAssociativeGraph | null;
    // 4 项仿人推理能力扩展（全部可选，未注入时行为与升级前完全一致）
    emotionModulator?: InferenceEmotionModulator | null;
    ruleLearner?: RuleLearner | null;
    analogyMigrator?: AnalogyMigrator | null;
    /**
     * LLM 规则归纳器（可选）。
     *
     * 若 ruleLearner 未注入但 llmInducer 已注入，且 humanLike 可用，
     * 自动创建 RuleLearner 并注入 llmInducer。
     *
     * LLM 只参与"学规则"（一次性归纳），不参与"用规则推理"。
     */
    llmInducer?: LLMRuleInducer | null;
    /**
     * 是否跳过内置规则注册（可选，缺省 false）。
     *
     * 用于测试/验证场景：只靠自学习规则推理，不靠硬编码规则。
     * 生产环境不应设为 true（会失去基础推理能力）。
     */
    skipBuiltinRules?: boolean;
  } = {}) {
    this.humanLike = opts.humanLike ?? null;
    this.associativeGraph = opts.associativeGraph ?? null;
    this.emotionModulator = opts.emotionModulator ?? null;
    this.analogyMigrator = opts.analogyMigrator ?? null;
    // ruleLearner：优先用传入的；未传入但 llmInducer 已注入且 humanLike 可用 → 自动创建
    if (opts.ruleLearner) {
      this.ruleLearner = opts.ruleLearner;
    } else if (opts.llmInducer && opts.humanLike) {
      // 自动创建 RuleLearner 并注入 llmInducer（让 autoLearn 能用 LLM 归纳）
      // rule-learner.ts 仅以 `import type` 反向引用本文件，无运行时循环依赖
      this.ruleLearner = new RuleLearner({
        humanLike: opts.humanLike,
        llmInducer: opts.llmInducer,
      });
    } else {
      this.ruleLearner = null;
    }
    if (!opts.skipBuiltinRules) {
      this.registerBuiltinRules();
    }
  }

  // ---- 主入口 ------------------------------------------------------------

  /**
   * 从多条线索推理出新结论。
   *
   * 5 层流水线：
   *   1. 扩散层 — 每条线索用 associativeGraph.predictAssociation 找激活节点（背景知识）
   *   2. 汇合检测层 — 找两条线索扩散后被同一节点激活的"汇合点"
   *   3. 规则匹配层 — 遍历规则，检查 requiredTags + patterns 匹配
   *   4. 结论生成层 — 用 template 拼接新结论
   *   5. 置信度评估层 — 综合计算 + 高置信回写
   *
   * 增强流程（4 项仿人推理能力）：
   *   - 若现有规则无匹配，且 analogyMigrator 已注入 → 尝试迁移规则，再用迁移后的规则匹配
   *   - 置信度计算时，若 emotionModulator 已注入，对 confidence 做情感调制
   *
   * 不调 LLM。
   *
   * @param actorId 关联 actor
   * @param clues 线索列表（至少 2 条）
   * @param emotion 情绪状态（可选，null 时不调制）
   */
  async inferFromClues(
    actorId: string,
    clues: InferenceClue[],
    emotion?: EmotionState | null,
  ): Promise<InferenceResult> {
    const cfg = loadConfig();
    const now = new Date().toISOString();
    const empty: InferenceResult = {
      inferences: [],
      combinedConfidence: 0,
      inferredAt: now,
    };

    // 主开关关闭 / 线索不足 2 条 → 不推理
    if (!cfg.enabled) return empty;
    if (clues.length < 2) return empty;

    // 补全线索权重（缺省：显性 1.0，隐性 0.6）
    const normalizedClues: InferenceClue[] = clues.map((c) => ({
      ...c,
      weight: c.weight ?? (c.source === "memory_recalled" ? IMPLICIT_CLUE_WEIGHT : EXPLICIT_CLUE_WEIGHT),
      detectedAt: c.detectedAt ?? now,
    }));

    // ---- 层 1：扩散层（背景知识检索，不作为结论）----
    // 每条线索用 associativeGraph.predictAssociation 找激活节点
    // spread 只用作"背景知识"——不直接作为结论
    const spreadResults = await this.collectSpreadResults(actorId, normalizedClues);

    // ---- 层 2：汇合检测层 ----
    // 找两条线索扩散后被同一节点激活的"汇合点"
    const convergenceNodes = this.detectConvergence(spreadResults);
    const hasConvergence = convergenceNodes.length > 0;

    // ---- 层 3 + 4：规则匹配层 + 结论生成层 ----
    const candidateClues = normalizedClues.map((c) => c.text);
    const candidateNodes = this.humanLike ? this.humanLike.getAllNodes(actorId) : [];

    const newInferences: InferenceNode[] = [];
    this.matchRulesAndGenerate({
      rules: this.rules,
      normalizedClues,
      candidateClues,
      candidateNodes,
      actorId,
      hasConvergence,
      emotion,
      newInferences,
      now,
    });

    // ---- 类比迁移回退：现有规则无匹配时尝试迁移 ----
    if (newInferences.length === 0 && this.analogyMigrator) {
      const migratedRules = this.analogyMigrator.migrateRules(normalizedClues, this.rules);
      if (migratedRules.length > 0) {
        // 注册迁移规则到引擎（热更新）
        for (const migrated of migratedRules) {
          this.registerRule(migrated);
          this.migratedRuleIds.add(migrated.id);
        }
        // 用迁移后的规则重新匹配
        this.matchRulesAndGenerate({
          rules: migratedRules,
          normalizedClues,
          candidateClues,
          candidateNodes,
          actorId,
          hasConvergence,
          emotion,
          newInferences,
          now,
        });
      }
    }

    if (newInferences.length === 0) return empty;

    // 高置信回写：confidence > writebackThreshold 时回写为新节点
    for (const node of newInferences) {
      if (node.confidence > cfg.writebackThreshold && this.humanLike?.ingestInferredNode) {
        try {
          this.humanLike.ingestInferredNode(actorId, node);
        } catch (err) {
          console.error("[MemoryInferenceEngine] ingestInferredNode 失败（忽略）:", err);
        }
      }
    }

    // 综合置信度：所有新结论的平均值
    const combinedConfidence =
      newInferences.reduce((sum, n) => sum + n.confidence, 0) / newInferences.length;

    return {
      inferences: newInferences,
      combinedConfidence: Number(combinedConfidence.toFixed(3)),
      inferredAt: now,
    };
  }

  // ---- 规则注册 ----------------------------------------------------------

  /** 注册自定义规则（同 id 视为更新，覆盖旧规则） */
  registerRule(rule: InferenceRule): void {
    const idx = this.rules.findIndex((r) => r.id === rule.id);
    if (idx >= 0) {
      this.rules[idx] = rule;
    } else {
      this.rules.push(rule);
    }
  }

  /** 获取某 actor 的所有推理结论 */
  getInferences(actorId: string): InferenceNode[] {
    const keys = this.actorIndex.get(actorId) ?? [];
    const result: InferenceNode[] = [];
    for (const key of keys) {
      const nodes = this.inferences.get(key);
      if (nodes) result.push(...nodes);
    }
    return result;
  }

  /** 标记推理结论的验证状态 */
  markVerified(actorId: string, inferenceId: string, verified: boolean): void {
    const keys = this.actorIndex.get(actorId) ?? [];
    for (const key of keys) {
      const nodes = this.inferences.get(key);
      if (!nodes) continue;
      for (const node of nodes) {
        if (node.id === inferenceId) {
          node.isVerified = verified;
        }
      }
    }
    // 若已学习规则被验证，触发 RuleLearner 的置信度升级
    if (verified && this.ruleLearner) {
      // 从推理结论的 evidence.rules 找到对应规则 id
      for (const key of keys) {
        const nodes = this.inferences.get(key);
        if (!nodes) continue;
        for (const node of nodes) {
          if (node.id === inferenceId) {
            for (const ruleId of node.evidence.rules) {
              this.ruleLearner.markRuleVerified(ruleId);
            }
          }
        }
      }
    }
  }

  // ---- 4 项仿人推理能力扩展方法 --------------------------------------------

  /** 获取所有已注册规则（含内置 + 自定义 + 学习 + 迁移） */
  getRules(): InferenceRule[] {
    return [...this.rules];
  }

  /**
   * 触发一次规则自学习（若 ruleLearner 已注入）。
   *
   * 扫描记忆图，挖掘频繁共现的关键词对，自动生成新规则并注册到引擎。
   * 新规则立即可用于推理（热更新）。
   *
   * @param actorId 指定 actor 的记忆图（可选，缺省 "default"）
   * @returns 本次学习到的新规则列表（ruleLearner 未注入时返回空）
   */
  async autoLearn(actorId?: string): Promise<LearnedRule[]> {
    if (!this.ruleLearner) return [];
    const newRules = await this.ruleLearner.learnRules(this, actorId);
    for (const rule of newRules) {
      this.learnedRuleIds.add(rule.id);
    }
    return newRules;
  }

  /** 获取已学习的规则列表（ruleLearner 未注入时返回空） */
  getLearnedRules(): LearnedRule[] {
    if (!this.ruleLearner) return [];
    return this.ruleLearner.getLearnedRules();
  }

  /** 获取已迁移的规则列表（从 rules 中过滤 migrated 标记） */
  getMigratedRules(): MigratedRule[] {
    const result: MigratedRule[] = [];
    for (const rule of this.rules) {
      if ((rule as MigratedRule).migrated === true) {
        result.push(rule as MigratedRule);
      }
    }
    return result;
  }

  // ---- 内部：内置规则注册 ------------------------------------------------

  private registerBuiltinRules(): void {
    // 规则 1: 求助目的推断（拼多多场景）
    // clueBPattern 用 /加.*?群|拉.*?群|进.*?群|互助群/ 兼容 "加一个群" / "加群" 等变体
    this.registerRule({
      id: "help_purpose_pdd",
      name: "求助目的推断",
      description: "拼多多场景：朋友让加群是为了帮他点拼多多助力链接",
      requiredTags: ["拼多多", "加群"],
      patterns: {
        clueAPattern: /拼多多|助力|砍价|拆红包/,
        clueBPattern: /加.*?群|拉.*?群|进.*?群|互助群/,
      },
      template: "朋友让加群是为了帮他点拼多多助力链接",
      baseConfidence: 0.6,
    });

    // 规则 2: 因果传递律
    this.registerRule({
      id: "causal_transitivity",
      name: "因果传递律",
      description: "A 导致 B，B 导致 C → A 通过中间环节导致 C",
      requiredTags: ["导致", "结果"],
      patterns: {
        clueAPattern: /(.+?)导致|引起|造成|引发/,
        clueBPattern: /(.+?)结果|所以|因此/,
      },
      template: "{A}通过中间环节导致{B}",
      baseConfidence: 0.5,
    });

    // 规则 3: 共现预测
    this.registerRule({
      id: "cooccurrence_prediction",
      name: "共现预测",
      description: "当两个实体在记忆中频繁共现，预测下次出现 A 时 B 也会出现",
      requiredTags: ["频繁共现"],
      patterns: {
        clueAPattern: /(.+?)和(.+?)频繁共现|共同出现/,
        clueBPattern: /记忆|历史|经验/,
      },
      template: "出现{A}时，大概率也会出现{B}",
      baseConfidence: 0.4,
    });

    // 规则 4: 类比推理
    this.registerRule({
      id: "analogy",
      name: "类比推理",
      description: "X 与 Y 相似，且 X 有属性 P → Y 也有属性 P",
      requiredTags: ["相似"],
      patterns: {
        clueAPattern: /(.+?)和(.+?)相似|类似|差不多/,
        clueBPattern: /(.+?)有(.+?)属性|特征|特点/,
      },
      template: "因为{X}与{Y}相似，所以{Y}可能也有{P}",
      baseConfidence: 0.45,
    });

    // 规则 5: 行为目的推断
    this.registerRule({
      id: "behavior_purpose",
      name: "行为目的推断",
      description: "某人有某行为 + 该行为通常有目的 → 推断目的",
      requiredTags: ["行为", "目的"],
      patterns: {
        clueAPattern: /(.+?)加班|赶|做|完成|处理/,
        clueBPattern: /(.+?)deadline|截止|项目|任务|目标/,
      },
      template: "{行为}的目的是{目的}",
      baseConfidence: 0.55,
    });
  }

  // ---- 内部：规则匹配 + 结论生成（提取为方法，支持类比迁移复用）---------

  /**
   * 对一组规则执行匹配 + 结论生成 + 置信度评估 + 缓存。
   *
   * 从 inferFromClues 提取，支持类比迁移后对迁移规则复用同一流程。
   * 若 emotionModulator 已注入且 emotion 非 null，对 confidence 做情感调制。
   */
  private matchRulesAndGenerate(params: {
    rules: InferenceRule[];
    normalizedClues: InferenceClue[];
    candidateClues: string[];
    candidateNodes: Array<{ summary: string; keywords: string[] }>;
    actorId: string;
    hasConvergence: boolean;
    emotion?: EmotionState | null;
    newInferences: InferenceNode[];
    now: string;
  }): void {
    const {
      rules,
      normalizedClues,
      candidateClues,
      candidateNodes,
      actorId,
      hasConvergence,
      emotion,
      newInferences,
      now,
    } = params;

    for (const rule of rules) {
      const matched = this.matchRule(rule, normalizedClues);
      if (!matched) continue;

      // 填充模板生成结论
      const entities: Record<string, string> = {
        A: extractEntity(matched.clueA.text, rule.patterns.clueAPattern),
        B: extractEntity(matched.clueB.text, rule.patterns.clueBPattern),
      };
      // 额外提取用于规则 4/5 的占位符
      if (rule.id === "analogy") {
        entities["X"] = entities["A"];
        entities["Y"] = entities["B"];
        entities["P"] = "类似属性"; // 简化：无 LLM 时无法自动抽取属性
      }
      if (rule.id === "behavior_purpose") {
        entities["行为"] = entities["A"];
        entities["目的"] = entities["B"];
      }
      const conclusion = fillTemplate(rule.template, entities);

      // 去重：相同 conclusion 文本不重复生成
      const hash = fnv1aHash(conclusion);
      const dedupKey = `${actorId}::${hash}`;
      if (this.inferences.has(dedupKey)) {
        // 已存在相同结论，跳过（不重新生成）
        continue;
      }

      // ---- 层 5：置信度评估层 ----
      let confidence = this.evaluateConfidence({
        baseConfidence: rule.baseConfidence,
        cluesCount: normalizedClues.length,
        cluesWeight: normalizedClues.reduce((sum, c) => sum + (c.weight ?? 1.0), 0),
        hasConvergence,
        causalChainComplete: this.checkCausalChain(actorId, matched.clueA.text, matched.clueB.text),
        hasCounterExample: this.checkCounterExample(candidateNodes, conclusion),
      });

      // 情感调制：若 emotionModulator 已注入且 emotion 非 null，对 confidence 做调制
      if (this.emotionModulator && emotion) {
        confidence = this.emotionModulator.modulate(confidence, emotion);
      }

      const inferenceId = `inf_${hash}`;
      const reasoningChain = this.buildReasoningChain(rule, matched, conclusion, confidence);
      const inferenceNode: InferenceNode = {
        id: inferenceId,
        conclusion,
        confidence: Number(confidence.toFixed(3)),
        evidence: {
          clues: [matched.clueA.text, matched.clueB.text],
          rules: [rule.id],
          reasoningChain,
        },
        isVerified: false,
        createdAt: now,
      };

      // 缓存
      this.inferences.set(dedupKey, [inferenceNode]);
      const actorInferences = this.actorIndex.get(actorId) ?? [];
      actorInferences.push(dedupKey);
      this.actorIndex.set(actorId, actorInferences);

      newInferences.push(inferenceNode);
    }
  }

  // ---- 内部：层 1 扩散 ---------------------------------------------------

  /**
   * 对每条线索调 associativeGraph.predictAssociation 收集激活节点。
   *
   * 用 predictAssociation 而非 spread：前者内部已做关键词匹配找种子，
   * 直接接受 query 文本，更贴合"线索"的语义。
   *
   * 返回每条线索对应的 activated node id 集合，供层 2 汇合检测使用。
   */
  private async collectSpreadResults(
    actorId: string,
    clues: InferenceClue[],
  ): Promise<Array<{ clueIdx: number; activatedNodeIds: string[] }>> {
    if (!this.associativeGraph) return [];
    const results: Array<{ clueIdx: number; activatedNodeIds: string[] }> = [];
    for (let i = 0; i < clues.length; i++) {
      try {
        const r = await this.associativeGraph.predictAssociation(actorId, clues[i]!.text);
        results.push({
          clueIdx: i,
          activatedNodeIds: r.activatedNodes,
        });
      } catch (err) {
        console.error(`[MemoryInferenceEngine] predictAssociation 失败（clue ${i}，忽略）:`, err);
        results.push({ clueIdx: i, activatedNodeIds: [] });
      }
    }
    return results;
  }

  // ---- 内部：层 2 汇合检测 -----------------------------------------------

  /**
   * 找两条线索扩散后被同一节点激活的"汇合点"。
   *
   * 汇合点不等于结论——只是"两条线索在此有关联"的信号。
   * 后续会作为置信度加成（+ convergenceBonus）使用。
   */
  private detectConvergence(
    spreadResults: Array<{ clueIdx: number; activatedNodeIds: string[] }>,
  ): string[] {
    if (spreadResults.length < 2) return [];
    const commonNodes: string[] = [];
    const first = spreadResults[0]!.activatedNodeIds;
    for (let i = 1; i < spreadResults.length; i++) {
      const other = spreadResults[i]!.activatedNodeIds;
      const setA = new Set(first);
      for (const id of other) {
        if (setA.has(id)) commonNodes.push(id);
      }
    }
    // 去重
    return [...new Set(commonNodes)];
  }

  // ---- 内部：层 3 规则匹配 -----------------------------------------------

  /**
   * 检查规则是否匹配。
   *
   * 匹配条件：
   *   1. 所有线索的 token 合集需覆盖 requiredTags
   *   2. patterns.clueAPattern 和 clueBPattern 能匹配到不同线索
   *
   * 返回匹配到的两条线索（用于证据记录 + 实体提取），无匹配返回 null。
   */
  private matchRule(
    rule: InferenceRule,
    clues: InferenceClue[],
  ): { clueA: InferenceClue; clueB: InferenceClue } | null {
    // 1. 检查 requiredTags 覆盖
    //    先直接子串匹配，匹配失败再退化为"按顺序出现所有字符"模糊匹配
    //    （例如 tag="加群" 在 "加一个群" 中按顺序出现 "加" ... "群"）
    //    迁移规则放宽：任一 tag 命中即视为覆盖（因迁移后场景可能缺部分 tag）
    const isMigrated = (rule as { migrated?: boolean }).migrated === true;
    const allText = clues.map((c) => c.text).join(" ");
    const allTokens = new Set([
      ...tokenize(allText),
      ...this.extractChineseKeywords(allText),
    ]);
    const tagHitFn = (tag: string): boolean => {
      // 直接子串匹配
      if (allText.includes(tag)) return true;
      // token 精确匹配
      if (allTokens.has(tag.toLowerCase())) return true;
      // 模糊匹配：tag 中的所有字符按顺序出现在 allText 中
      let tagIdx = 0;
      for (const ch of allText) {
        if (tagIdx < tag.length && ch === tag[tagIdx]) {
          tagIdx++;
        }
      }
      return tagIdx === tag.length;
    };
    const tagsCovered = isMigrated
      ? rule.requiredTags.some(tagHitFn)   // 迁移规则：任一 tag 命中
      : rule.requiredTags.every(tagHitFn); // 原生规则：所有 tag 必须命中
    if (!tagsCovered) return null;

    // 2. 检查 patterns 匹配不同线索
    //    迁移规则（isMigrated=true）放宽：任一 pattern 命中即触发
    //    原生规则严格要求两个 patterns 都命中
    let clueAMatch: InferenceClue | null = null;
    let clueBMatch: InferenceClue | null = null;
    for (const clue of clues) {
      if (!clueAMatch && rule.patterns.clueAPattern.test(clue.text)) {
        clueAMatch = clue;
      }
      if (!clueBMatch && rule.patterns.clueBPattern.test(clue.text)) {
        clueBMatch = clue;
      }
      if (clueAMatch && clueBMatch) break;
    }

    if (isMigrated) {
      // 迁移规则：任一 pattern 命中即触发（人类直觉：看到部分线索联想规则）
      // 缺失的 clue 用命中的那条代替（避免 null）
      if (!clueAMatch && !clueBMatch) return null;
      const fallback = clueAMatch ?? clueBMatch!;
      return {
        clueA: clueAMatch ?? fallback,
        clueB: clueBMatch ?? fallback,
      };
    }

    if (!clueAMatch || !clueBMatch) return null;
    return { clueA: clueAMatch, clueB: clueBMatch };
  }

  /**
   * 从中文文本提取关键词（覆盖 requiredTags 中文标签）。
   *
   * 简化版：按常见标点 + 空格切分，过滤过短片段。
   * 用于让 requiredTags 中的中文词能被识别（如"拼多多"、"加群"）。
   */
  private extractChineseKeywords(text: string): string[] {
    return text
      .split(/[\s,，。.、;；!！?？:："'`'（）()【】\[\]]+/)
      .filter((t) => t.length >= 2)
      .map((t) => t.toLowerCase());
  }

  // ---- 内部：层 5 置信度评估 ---------------------------------------------

  /**
   * 综合置信度计算。
   *
   *   baseConfidence（来自规则）
   *   + 线索数量加成：clues.length >= 2 → +0.1, >= 3 → +0.2
   *   + 扩散汇合加成：若两条线索的扩散节点有交集 → +0.15
   *   + 因果链完整加成：若能在记忆图中找到 A→B→C 完整路径 → +0.2
   *   - 反例惩罚：若记忆中有反例节点 → -0.3
   *   最终 clamp 到 [0, 1]
   */
  private evaluateConfidence(params: {
    baseConfidence: number;
    cluesCount: number;
    cluesWeight: number;
    hasConvergence: boolean;
    causalChainComplete: boolean;
    hasCounterExample: boolean;
  }): number {
    const cfg = loadConfig();
    let conf = params.baseConfidence;

    // 线索数量加成
    if (params.cluesCount >= 3) {
      conf += 0.2;
    } else if (params.cluesCount >= 2) {
      conf += 0.1;
    }

    // 扩散汇合加成
    if (params.hasConvergence) {
      conf += cfg.convergenceBonus;
    }

    // 因果链完整加成
    if (params.causalChainComplete) {
      conf += cfg.causalChainBonus;
    }

    // 反例惩罚
    if (params.hasCounterExample) {
      conf -= cfg.counterExamplePenalty;
    }

    return clamp(conf, 0, 1);
  }

  /**
   * 检查记忆图中是否存在 A→B→C 完整因果链。
   *
   * 简化实现：检查是否存在长度 >= 3 的因果边链路。
   * 因 → 关系为 relation 包含 "causal" / "导致" / "result" 的边。
   */
  private checkCausalChain(actorId: string, clueA: string, clueB: string): boolean {
    if (!this.humanLike) return false;
    const edges = this.humanLike.getAllEdges(actorId);
    const causalEdges = edges.filter((e) =>
      /causal|导致|result|cause|effect/i.test(e.relation),
    );
    if (causalEdges.length === 0) return false;

    // 构建邻接表
    const adjacency = new Map<string, string[]>();
    for (const e of causalEdges) {
      if (!adjacency.has(e.from)) adjacency.set(e.from, []);
      adjacency.get(e.from)!.push(e.to);
    }

    // BFS 检查是否存在长度 >= MIN_CAUSAL_CHAIN_DEPTH 的链路
    for (const startNode of adjacency.keys()) {
      const visited = new Set<string>([startNode]);
      const queue: Array<{ node: string; depth: number }> = [
        { node: startNode, depth: 1 },
      ];
      while (queue.length > 0) {
        const { node, depth } = queue.shift()!;
        if (depth >= MIN_CAUSAL_CHAIN_DEPTH) return true;
        const neighbors = adjacency.get(node) ?? [];
        for (const next of neighbors) {
          if (!visited.has(next)) {
            visited.add(next);
            queue.push({ node: next, depth: depth + 1 });
          }
        }
      }
    }
    // 用线索文本兜底：若两条线索本身就构成因果叙述，视为链完整
    return /导致|引起|造成|因为.*所以|结果|因此/.test(`${clueA} ${clueB}`);
  }

  /**
   * 检查记忆中是否存在反例节点（否定结论的节点）。
   */
  private checkCounterExample(
    nodes: Array<{ summary: string; keywords: string[] }>,
    conclusion: string,
  ): boolean {
    if (nodes.length === 0) return false;
    // 简化：检查是否有节点 summary 包含反例关键词 + 与结论相关
    const conclusionTokens = new Set(tokenize(conclusion));
    for (const node of nodes) {
      const hasCounterKeyword = COUNTER_EXAMPLE_KEYWORDS.some((kw) =>
        node.summary.includes(kw),
      );
      if (!hasCounterKeyword) continue;
      // 检查是否与结论相关（关键词重叠 >= 1）
      const nodeTokens = new Set([
        ...tokenize(node.summary),
        ...node.keywords.map((k) => k.toLowerCase()),
      ]);
      let overlap = 0;
      for (const t of conclusionTokens) {
        if (nodeTokens.has(t)) overlap++;
      }
      if (overlap > 0) return true;
    }
    return false;
  }

  /**
   * 构建人类可读的推理链。
   */
  private buildReasoningChain(
    rule: InferenceRule,
    matched: { clueA: InferenceClue; clueB: InferenceClue },
    conclusion: string,
    confidence: number,
  ): string[] {
    return [
      `规则匹配：${rule.name}（${rule.description}）`,
      `线索 A：${matched.clueA.text}`,
      `线索 B：${matched.clueB.text}`,
      `套用模板：${rule.template}`,
      `生成结论：${conclusion}`,
      `置信度：${confidence.toFixed(3)}`,
    ];
  }
}
