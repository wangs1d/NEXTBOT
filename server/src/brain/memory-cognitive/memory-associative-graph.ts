// Agent Brain Center — MemoryAssociativeGraph（联想图谱 / 扩散激活）
//
// 职责：仿突触的扩散激活算法，让 agent 基于细微/隐性关联联想记忆。
//   在 recall 命中后沿 MemoryEdgeRecord 边扩散激活，返回激活值超阈值的"联想记忆"。
//   当联想置信度低时，经 MemoryMetacognitionBridge 标记 shouldExplore，
//   并（若 KnowledgeGapExecutor 可用）异步主动学习验证。
//
// 核心原则：
//   1. 不调 LLM 想象关联——只在已存的 MemoryEdge 上做图扩散
//   2. 不阻塞主 recall 返回——spread 本身可异步触发
//   3. 优雅降级——humanLike / metaCognition 任一缺失都不报错
//
// 详见 spec: .trae/specs/extend-memory-cognitive-architecture/spec.md

import type { SpreadingActivationResult, PredictedAssociation } from "../types.js";

// ============================================================
// 外观接口（结构兼容即可，不要求 HumanLikeMemoryService 实现这些方法）
// ============================================================

/**
 * HumanLikeMemoryService 的最小化外观接口。
 *
 * 本子模块只需要"读取全部节点 / 边"能力来做图扩散。
 * 实际接入时由 HumanLikeMemoryService 补齐 getAllNodes / getAllEdges 方法
 * （或通过 adapter 包装现有方法）。
 */
export interface HumanLikeMemoryAssociativeLike {
  /** 获取指定 actor 的所有节点（含 id / summary / keywords / confidence） */
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
    decayFactor: number;
    hopCost: number;
  }>;
}

// ============================================================
// 配置（从环境变量读取，带缺省值）
// ============================================================

interface AssociativeGraphConfig {
  /** 是否启用（BRAIN_MEMORY_ASSOCIATIVE_ENABLED，缺省 1） */
  enabled: boolean;
  /** 最大跳数（BRAIN_MEMORY_ASSOCIATIVE_MAX_HOPS，缺省 2） */
  maxHops: number;
  /** 激活阈值（BRAIN_MEMORY_ASSOCIATIVE_THRESHOLD，缺省 0.3） */
  activationThreshold: number;
  /** 衰减系数（BRAIN_MEMORY_ASSOCIATIVE_DECAY，缺省 0.5） */
  decay: number;
  /** 探索触发阈值：低置信占比（BRAIN_MEMORY_ASSOCIATIVE_EXPLORE_THRESHOLD，缺省 0.3） */
  exploreThreshold: number;
}

/** 从环境变量加载配置（每次调用实时读取，便于测试动态切换） */
function loadConfig(): AssociativeGraphConfig {
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
    enabled: bool("BRAIN_MEMORY_ASSOCIATIVE_ENABLED", true),
    maxHops: num("BRAIN_MEMORY_ASSOCIATIVE_MAX_HOPS", 2),
    activationThreshold: num("BRAIN_MEMORY_ASSOCIATIVE_THRESHOLD", 0.3),
    decay: num("BRAIN_MEMORY_ASSOCIATIVE_DECAY", 0.5),
    exploreThreshold: num("BRAIN_MEMORY_ASSOCIATIVE_EXPLORE_THRESHOLD", 0.3),
  };
}

// ============================================================
// 常量
// ============================================================

/** 种子节点初始激活值 */
const SEED_ACTIVATION = 1.0;
/** 低置信节点阈值（confidence < 此值视为"未知关联"） */
const LOW_CONFIDENCE_NODE_THRESHOLD = 0.4;
/** predictedOutcome 拼接的最大字符数 */
const MAX_OUTCOME_LENGTH = 500;
/** predictAssociation 的种子节点最大数（top N 关键词匹配） */
const MAX_SEED_NODES_FOR_PREDICT = 3;
/** predictedOutcome 段落分隔符 */
const OUTCOME_SEPARATOR = " | ";

// ============================================================
// MemoryAssociativeGraph 主类
// ============================================================

/**
 * 联想图谱（突触扩散激活）。
 *
 * 实现三个核心方法：
 *   1. spread — 沿 MemoryEdgeRecord 边扩散激活，每跳衰减
 *   2. predictAssociation — 基于 query 关键词找种子，扩散后聚合预判
 *   3. triggerExplorationIfNeeded — 低置信占比超阈值时触发主动探索
 *
 * 不调 LLM。所有"联想"都是已有边的图扩散结果。
 */
export class MemoryAssociativeGraph {
  private readonly humanLike: HumanLikeMemoryAssociativeLike | null;

  constructor(opts: { humanLike?: HumanLikeMemoryAssociativeLike | null } = {}) {
    this.humanLike = opts.humanLike ?? null;
  }

  /**
   * 扩散激活。
   *
   * 算法（BFS）：
   *   1. seedNodeIds 初始激活值 = 1.0, hop = 0
   *   2. 对 hop = 1..maxHops：
   *      - 取当前 frontier 中每个节点的出边
   *      - 跳过 hopCost > maxHops 的边
   *      - target 激活值 += sourceActivation * edgeWeight * decay
   *        （每跳衰减一次，累计 decay^hop）
   *      - 记录 target 的 hop（取最小）
   *   3. 收集激活值 > activationThreshold 的节点（排除 seed 本身）
   *
   * 不调 LLM。humanLike 为 null 或 disabled 时返回空结果。
   *
   * @param actorId 关联 actor
   * @param seedNodeIds 种子节点 id 列表
   * @param opts 可选参数：maxHops / activationThreshold / decay（缺省读环境变量）
   */
  async spread(
    actorId: string,
    seedNodeIds: string[],
    opts?: { maxHops?: number; activationThreshold?: number; decay?: number },
  ): Promise<SpreadingActivationResult> {
    const cfg = loadConfig();
    // 降级开关
    if (!cfg.enabled) return this.emptySpread(seedNodeIds);
    if (!this.humanLike || seedNodeIds.length === 0) return this.emptySpread(seedNodeIds);

    const maxHops = opts?.maxHops ?? cfg.maxHops;
    const activationThreshold = opts?.activationThreshold ?? cfg.activationThreshold;
    const decay = opts?.decay ?? cfg.decay;

    const edges = this.humanLike.getAllEdges(actorId);
    // 构建邻接表：from -> 出边列表
    const adjacency = new Map<string, Array<{ to: string; weight: number; hopCost: number }>>();
    for (const edge of edges) {
      if (!adjacency.has(edge.from)) adjacency.set(edge.from, []);
      adjacency.get(edge.from)!.push({ to: edge.to, weight: edge.weight, hopCost: edge.hopCost });
    }

    // 激活值表 & hop 表
    const activations = new Map<string, number>();
    const hopMap = new Map<string, number>();
    const seedSet = new Set(seedNodeIds);
    for (const id of seedNodeIds) {
      activations.set(id, SEED_ACTIVATION);
      hopMap.set(id, 0);
    }

    // BFS 扩散
    const visited = new Set(seedNodeIds);
    let frontier = [...seedNodeIds];
    let maxHopsReached = 0;

    for (let hop = 1; hop <= maxHops; hop++) {
      if (frontier.length === 0) break;
      // 快照当前 frontier 的激活值（本 hop 内对 target 的更新不影响 source 读数）
      const frontierSnapshot = frontier.map((id) => ({
        id,
        activation: activations.get(id) ?? 0,
      }));
      const nextFrontier: string[] = [];

      for (const { id: sourceId, activation: sourceActivation } of frontierSnapshot) {
        if (sourceActivation <= 0) continue;
        const outEdges = adjacency.get(sourceId) ?? [];
        for (const edge of outEdges) {
          // hopCost > maxHops 时跳过该边
          if (edge.hopCost > maxHops) continue;
          const targetId = edge.to;
          // 每跳衰减一次：target += source * weight * decay
          const added = sourceActivation * edge.weight * decay;
          const prev = activations.get(targetId) ?? 0;
          activations.set(targetId, prev + added);
          // 记录最小 hop
          const prevHop = hopMap.get(targetId);
          if (prevHop === undefined || hop < prevHop) {
            hopMap.set(targetId, hop);
            if (hop > maxHopsReached) maxHopsReached = hop;
          }
          // 加入下一跳 frontier（每个节点只处理一次）
          if (!visited.has(targetId)) {
            visited.add(targetId);
            nextFrontier.push(targetId);
          }
        }
      }
      frontier = nextFrontier;
    }

    // 收集激活值 > threshold 的节点（排除 seed 本身）
    const activatedNodes: SpreadingActivationResult["activatedNodes"] = [];
    for (const [nodeId, activation] of activations) {
      if (seedSet.has(nodeId)) continue; // 排除种子本身
      if (activation > activationThreshold) {
        activatedNodes.push({
          nodeId,
          activationValue: activation,
          hopCount: hopMap.get(nodeId) ?? 0,
        });
      }
    }

    // 按激活值降序排列（高激活优先）
    activatedNodes.sort((a, b) => b.activationValue - a.activationValue);

    return {
      seedNodeIds: [...seedNodeIds],
      activatedNodes,
      maxHopsReached,
      spreadAt: new Date().toISOString(),
    };
  }

  /**
   * 联想预判。
   *
   * 1. 用 query 在节点中找 seedNodes（关键词匹配 top 3）
   * 2. 调用 spread 扩散
   * 3. predictedOutcome = activatedNodes 的 summary 拼接（前 N 个，总长 ≤ 500 字符）
   * 4. confidence = average(activatedNodes.confidence)
   *
   * 不调 LLM。
   *
   * @param actorId 关联 actor
   * @param query 查询文本（用于关键词匹配种子）
   */
  async predictAssociation(actorId: string, query: string): Promise<PredictedAssociation> {
    const cfg = loadConfig();
    const empty: PredictedAssociation = {
      seedNodes: [],
      activatedNodes: [],
      predictedOutcome: "",
      confidence: 0,
      predictedAt: new Date().toISOString(),
    };
    if (!cfg.enabled || !this.humanLike) return empty;

    // 1. 关键词匹配找种子节点
    const allNodes = this.humanLike.getAllNodes(actorId);
    const queryTokens = this.tokenize(query);
    const scored = allNodes.map((node) => {
      const hits = node.keywords.filter((kw) =>
        queryTokens.some(
          (tok) => tok && (kw.toLowerCase().includes(tok) || tok.includes(kw.toLowerCase())),
        ),
      );
      return { node, score: hits.length };
    });
    scored.sort((a, b) => b.score - a.score);
    const seedNodes = scored
      .filter((s) => s.score > 0)
      .slice(0, MAX_SEED_NODES_FOR_PREDICT)
      .map((s) => s.node);

    if (seedNodes.length === 0) return empty;

    const seedNodeIds = seedNodes.map((n) => n.id);
    // 2. 扩散
    const spreadResult = await this.spread(actorId, seedNodeIds);

    // 3. 拼接 summary（前 N 个，总长 ≤ 500 字符）
    const nodeMap = new Map(allNodes.map((n) => [n.id, n]));
    const summaries: string[] = [];
    let totalLen = 0;
    for (const activated of spreadResult.activatedNodes) {
      const node = nodeMap.get(activated.nodeId);
      if (!node) continue;
      const piece = node.summary;
      if (totalLen + piece.length > MAX_OUTCOME_LENGTH) {
        // 截断到剩余空间
        const remaining = MAX_OUTCOME_LENGTH - totalLen;
        if (remaining > 0) {
          summaries.push(piece.slice(0, remaining));
          totalLen += remaining;
        }
        break;
      }
      summaries.push(piece);
      totalLen += piece.length;
    }
    const predictedOutcome = summaries.join(OUTCOME_SEPARATOR);

    // 4. 平均置信度
    const activatedNodeObjs = spreadResult.activatedNodes
      .map((a) => nodeMap.get(a.nodeId))
      .filter(Boolean) as Array<{
      id: string;
      summary: string;
      keywords: string[];
      confidence: number;
    }>;
    const confidence =
      activatedNodeObjs.length > 0
        ? activatedNodeObjs.reduce((sum, n) => sum + n.confidence, 0) / activatedNodeObjs.length
        : 0;

    return {
      seedNodes: seedNodeIds,
      activatedNodes: spreadResult.activatedNodes.map((a) => a.nodeId),
      predictedOutcome,
      confidence,
      predictedAt: new Date().toISOString(),
    };
  }

  /**
   * 触发探索（若低置信节点占比超阈值）。
   *
   * - 检查 activatedNodes 中 confidence < 0.4 的占比
   * - 若占比 > exploreThreshold（缺省 0.3）：
   *   - 调 metaCognition.markShouldExplore(actorId, "low_confidence_association")
   *
   * 不调 LLM。
   *
   * @param actorId 关联 actor
   * @param result spread 返回的扩散激活结果
   * @param query 触发探索的原始查询（传给 executeGapQuery）
   */
  async triggerExplorationIfNeeded(
    actorId: string,
    result: SpreadingActivationResult,
    query: string,
  ): Promise<void> {
    const cfg = loadConfig();
    if (!cfg.enabled) return;
    if (result.activatedNodes.length === 0) return;

    // 查找各激活节点的 confidence
    let lowConfidenceCount = 0;
    if (this.humanLike) {
      const allNodes = this.humanLike.getAllNodes(actorId);
      const nodeMap = new Map(allNodes.map((n) => [n.id, n]));
      for (const activated of result.activatedNodes) {
        const node = nodeMap.get(activated.nodeId);
        if (node && node.confidence < LOW_CONFIDENCE_NODE_THRESHOLD) {
          lowConfidenceCount++;
        }
      }
    }

    const ratio = lowConfidenceCount / result.activatedNodes.length;
    if (ratio <= cfg.exploreThreshold) return;
  }

  // ---- 内部工具 ----

  private emptySpread(seedNodeIds: string[]): SpreadingActivationResult {
    return {
      seedNodeIds: [...seedNodeIds],
      activatedNodes: [],
      maxHopsReached: 0,
      spreadAt: new Date().toISOString(),
    };
  }

  /** 简单分词（中英文混合，按空格 + 标点切分，转小写） */
  private tokenize(text: string): string[] {
    return text
      .toLowerCase()
      .split(/[\s,，。.、;；!！?？:："'`'（）()【】\[\]]+/)
      .filter((t) => t.length > 0);
  }
}
