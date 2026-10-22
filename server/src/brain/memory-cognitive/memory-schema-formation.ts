// Agent Brain Center — MemorySchemaFormation（语义抽象与图式形成）
//
// 职责：从多次具体经验提取公共结构形成图式，供新环境同化使用，并追踪刻板印象。
//   - extractSchema: 同 sceneTag 节点累计 ≥ 3 个时，用 LCS 抽取公共 step 序列
//   - matchSchema: 新场景匹配图式返回建议操作序列（仅建议，不强制）
//   - recordStereotypeFailure: 套用图式结果偏差时自增警告计数
//
// 设计要点：
//   - 不调 LLM，纯算法提取（LCS + 频次过滤）
//   - 内部缓存 Map<actorId::sceneTag, SchemaNode>
//   - 阈值可通过环境变量运行时配置
//   - 优雅降级——humanLike 缺失 / 主开关关闭时方法空操作
//
// 详见 spec: .trae/specs/extend-memory-cognitive-architecture/spec.md

import type { SchemaNode, SchemaMatchResult } from "../types.js";

// ============================================================
// 外观接口（结构兼容即可，不要求 HumanLikeMemoryService 实现这些方法）
// ============================================================

/**
 * HumanLikeMemoryService 的最小化外观接口。
 *
 * 本子模块只需要"读取指定 sceneTag 的节点 / 全部节点"能力来抽取图式。
 * 实际接入时由 HumanLikeMemoryService 补齐 getNodesBySceneTag / getAllNodes 方法
 * （或通过 adapter 包装现有方法）。
 */
export interface HumanLikeMemorySchemaLike {
  /** 获取指定 actor 指定 sceneTag 的所有节点 */
  getNodesBySceneTag?(actorId: string, sceneTag: string): Array<{
    id: string;
    summary: string;
    keywords: string[];
    sceneTags: string[];
    entityTags: string[];
    emotionTags: string[];
    metadata?: Record<string, unknown>;
  }>;
  /** 获取指定 actor 的所有节点 */
  getAllNodes?(actorId: string): Array<{
    id: string;
    summary: string;
    keywords: string[];
    sceneTags: string[];
    entityTags: string[];
    emotionTags: string[];
    metadata?: Record<string, unknown>;
  }>;
}

/** 节点的 step 序列（用于图式 step 抽取） */
export interface NodeStepSequence {
  nodeId: string;
  /** 节点的步骤序列（从 summary 解析或 metadata.steps 取） */
  steps: string[];
}

/**
 * 图式落盘适配器（P0，2026-10-20）：内存 schemaCache 重启即失 → 落盘后可跨重启。
 * 由 LifeModelStore 提供实现（life_patterns 表）；结构兼容即可，不反向依赖。
 */
export interface SchemaPersistenceLike {
  savePattern(actorId: string, schema: SchemaNode): void;
  loadPatterns(actorId: string): SchemaNode[];
}

// ============================================================
// 配置（从环境变量读取，带缺省值）
// ============================================================

interface SchemaFormationConfig {
  /** 主开关（BRAIN_MEMORY_SCHEMA_ENABLED，缺省 1） */
  enabled: boolean;
  /** 触发抽取的最小实例数（BRAIN_MEMORY_SCHEMA_MIN_INSTANCES，缺省 3） */
  minInstances: number;
  /** step 频次阈值 0-1（BRAIN_MEMORY_SCHEMA_STEP_FREQUENCY_THRESHOLD，缺省 0.5） */
  stepFrequencyThreshold: number;
  /** 匹配阈值（BRAIN_MEMORY_SCHEMA_MATCH_THRESHOLD，缺省 0.3） */
  matchThreshold: number;
  /** 刻板印象警告阈值（BRAIN_MEMORY_SCHEMA_STEREOTYPE_WARNING_THRESHOLD，缺省 3） */
  stereotypeWarningThreshold: number;
}

/** 从环境变量加载配置（每次调用实时读取，便于测试动态切换） */
function loadConfig(): SchemaFormationConfig {
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
    enabled: bool("BRAIN_MEMORY_SCHEMA_ENABLED", true),
    minInstances: num("BRAIN_MEMORY_SCHEMA_MIN_INSTANCES", 3),
    stepFrequencyThreshold: num("BRAIN_MEMORY_SCHEMA_STEP_FREQUENCY_THRESHOLD", 0.5),
    matchThreshold: num("BRAIN_MEMORY_SCHEMA_MATCH_THRESHOLD", 0.3),
    stereotypeWarningThreshold: num("BRAIN_MEMORY_SCHEMA_STEREOTYPE_WARNING_THRESHOLD", 3),
  };
}

// ============================================================
// helper 函数
// ============================================================

/**
 * 从节点解析 step 序列。
 *  - 优先从 metadata.steps 取（若为非空字符串数组）
 *  - 否则按 → / -> / ； / ; 分割 summary
 *  - 返回非空 step 列表（去空白）
 */
export function parseSteps(
  summary: string,
  metadata?: Record<string, unknown>,
): string[] {
  // 优先从 metadata.steps 取
  if (metadata && Array.isArray(metadata.steps)) {
    const steps = metadata.steps
      .map((s) => (typeof s === "string" ? s.trim() : ""))
      .filter((s) => s.length > 0);
    if (steps.length > 0) return steps;
  }
  // 否则按分隔符切分 summary
  if (!summary || typeof summary !== "string") return [];
  return summary
    .split(/→|->|；|;/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * 多序列 LCS（频次统计实现）。
 *
 * 简化版：在所有序列中出现次数 >= ceil(N/2) 的 step 保留，
 * 按首个序列中的顺序排序。
 *
 * @param sequences 多个 step 序列
 * @returns 公共 step 序列
 */
export function longestCommonSubsequence(sequences: string[][]): string[] {
  if (sequences.length === 0) return [];
  const n = sequences.length;
  // 频次阈值：至少在 ceil(N/2) 个序列中出现过
  const threshold = Math.ceil(n / 2);

  // 统计每个 step 在多少个序列中出现过（每序列只计一次）
  const seqCount = new Map<string, number>();
  for (const seq of sequences) {
    const seen = new Set<string>();
    for (const step of seq) {
      if (!seen.has(step)) {
        seen.add(step);
        seqCount.set(step, (seqCount.get(step) ?? 0) + 1);
      }
    }
  }

  // 保留出现次数 >= threshold 的 step
  const kept = new Set<string>();
  for (const [step, count] of seqCount) {
    if (count >= threshold) kept.add(step);
  }

  // 按首个序列中的顺序排序
  const firstSeq = sequences[0];
  const result: string[] = [];
  const seenInResult = new Set<string>();
  for (const step of firstSeq) {
    if (kept.has(step) && !seenInResult.has(step)) {
      result.push(step);
      seenInResult.add(step);
    }
  }
  return result;
}

/**
 * 提取高频关键词（前 topN）。
 *
 * 综合 keywords + entityTags，按频次降序取前 topN。
 * 同一节点内重复的关键词只计一次。
 *
 * @param nodes 节点列表
 * @param topN 返回的前 N 个
 * @returns 高频关键词列表
 */
export function extractKeywords(
  nodes: Array<{ keywords: string[]; entityTags: string[] }>,
  topN: number,
): string[] {
  const freq = new Map<string, number>();
  for (const node of nodes) {
    const seen = new Set<string>();
    for (const kw of node.keywords) {
      const k = kw.trim();
      if (k && !seen.has(k)) {
        seen.add(k);
        freq.set(k, (freq.get(k) ?? 0) + 1);
      }
    }
    for (const tag of node.entityTags) {
      const t = tag.trim();
      if (t && !seen.has(t)) {
        seen.add(t);
        freq.set(t, (freq.get(t) ?? 0) + 1);
      }
    }
  }
  const sorted = [...freq.entries()].sort((a, b) => b[1] - a[1]);
  return sorted.slice(0, topN).map(([k]) => k);
}

/** 从 metadata 中安全提取字符串数组 */
function getStringArray(
  metadata: Record<string, unknown> | undefined,
  key: string,
): string[] {
  if (!metadata) return [];
  const v = metadata[key];
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string");
}

/**
 * 计算 keywords 与 target 的 overlap 比例（intersection / target.length）。
 * 大小写不敏感，去重。
 */
function computeOverlap(keywords: string[], target: string[]): number {
  if (target.length === 0) return 0;
  const targetSet = new Set(target.map((t) => t.trim().toLowerCase()));
  let hits = 0;
  const seen = new Set<string>();
  for (const kw of keywords) {
    const k = kw.trim().toLowerCase();
    if (k && !seen.has(k)) {
      seen.add(k);
      if (targetSet.has(k)) hits++;
    }
  }
  return hits / target.length;
}

/** 简易 hash（djb2 变体），生成 8 位 hex 串 */
function simpleHash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h) + s.charCodeAt(i);
    h = h | 0; // 转为 32 位整数
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

// ============================================================
// MemorySchemaFormation 主类
// ============================================================

/**
 * 语义抽象与图式形成。
 *
 * 实现三个核心方法：
 *   1. extractSchema — 从多次相似经历提取公共 step 序列形成图式
 *   2. matchSchema — 新场景匹配图式，返回建议操作序列（仅建议）
 *   3. recordStereotypeFailure — 套用图式失败时自增警告计数
 *
 * 不调 LLM。所有图式提取都是 LCS + 频次过滤的纯算法结果。
 */
export class MemorySchemaFormation {
  private readonly humanLike: HumanLikeMemorySchemaLike | null;
  /** 内部缓存：key = `${actorId}::${sceneTag}` */
  private readonly schemaCache = new Map<string, SchemaNode>();
  /** id → cacheKey 反查表（便于按 schemaId 查找） */
  private readonly idIndex = new Map<string, string>();
  /** 落盘适配器（P0）：非空时 read 先 hydrate、write 写穿；null 时保持纯内存旧行为 */
  private persistence: SchemaPersistenceLike | null = null;
  /** 已从盘内 hydrate 过的 actor（避免每轮重复加载） */
  private readonly hydratedActors = new Set<string>();

  constructor(opts: { humanLike?: HumanLikeMemorySchemaLike | null } = {}) {
    this.humanLike = opts.humanLike ?? null;
  }

  /** 注入落盘适配器（装配层接线；LifeModelStore 实例）。 */
  setPersistence(p: SchemaPersistenceLike | null): void {
    this.persistence = p;
  }

  /** 首次访问某 actor 时把盘内图式载回内存缓存（幂等）。 */
  private hydrate(actorId: string): void {
    if (!this.persistence || this.hydratedActors.has(actorId)) return;
    this.hydratedActors.add(actorId);
    try {
      for (const schema of this.persistence.loadPatterns(actorId)) {
        const cacheKey = `${actorId}::${schema.sceneTag}`;
        this.schemaCache.set(cacheKey, schema);
        this.idIndex.set(schema.id, cacheKey);
      }
    } catch (err) {
      console.log(`[SchemaFormation] hydrate 失败（忽略）: ${err}`);
    }
  }

  /**
   * 图式抽取。
   *
   * 算法：
   *   1. 调 humanLike.getNodesBySceneTag(actorId, sceneTag) 获取同 sceneTag 节点
   *   2. 节点数 < minInstances 时返回 null
   *   3. 从每个节点提取 step 序列（parseSteps）
   *   4. 用 LCS 提取公共 step 序列（频次过滤：>= stepFrequencyThreshold 比例）
   *   5. preconditions 从 entityTags 高频提取（前 3）
   *   6. expectedOutcomes 从 emotionTags + metadata.outcomes 高频提取（前 3）
   *   7. 生成 SchemaNode 并写入缓存（保留已有 id / createdAt / warningCount）
   *
   * 不调 LLM。humanLike 为 null 或 disabled 时返回 null。
   */
  async extractSchema(actorId: string, sceneTag: string): Promise<SchemaNode | null> {
    const cfg = loadConfig();
    if (!cfg.enabled) return null;
    if (!this.humanLike || !this.humanLike.getNodesBySceneTag) return null;
    this.hydrate(actorId);

    const nodes = this.humanLike.getNodesBySceneTag(actorId, sceneTag) ?? [];
    if (nodes.length < cfg.minInstances) return null;

    // 从每个节点提取 step 序列
    const sequences: NodeStepSequence[] = nodes.map((node) => ({
      nodeId: node.id,
      steps: parseSteps(node.summary, node.metadata),
    }));

    // 用 LCS 提取公共 step 序列（内部已做 ceil(N/2) 过滤）
    let commonSteps = longestCommonSubsequence(sequences.map((s) => s.steps));

    // 额外频次过滤：只保留在 >= stepFrequencyThreshold 比例节点中出现的 step
    if (cfg.stepFrequencyThreshold > 0) {
      const minCount = Math.ceil(nodes.length * cfg.stepFrequencyThreshold);
      const stepCounts = new Map<string, number>();
      for (const seq of sequences) {
        const seen = new Set<string>();
        for (const step of seq.steps) {
          if (!seen.has(step)) {
            seen.add(step);
            stepCounts.set(step, (stepCounts.get(step) ?? 0) + 1);
          }
        }
      }
      commonSteps = commonSteps.filter(
        (step) => (stepCounts.get(step) ?? 0) >= minCount,
      );
    }

    // 提取 preconditions（entityTags 高频前 3）
    const preconditions = extractKeywords(
      nodes.map((n) => ({ keywords: [], entityTags: n.entityTags })),
      3,
    );

    // 提取 expectedOutcomes（emotionTags + metadata.outcomes 高频前 3）
    const outcomeNodes = nodes.map((n) => ({
      keywords: n.emotionTags,
      entityTags: getStringArray(n.metadata, "outcomes"),
    }));
    const expectedOutcomes = extractKeywords(outcomeNodes, 3);

    // 生成 SchemaNode（保留已有 id / createdAt / stereotypeWarningCount）
    const cacheKey = `${actorId}::${sceneTag}`;
    const existing = this.schemaCache.get(cacheKey);
    const id = existing?.id ?? this.generateSchemaId(actorId, sceneTag);
    const now = new Date().toISOString();
    const schema: SchemaNode = {
      id,
      name: `${sceneTag}图式`,
      steps: commonSteps,
      preconditions,
      expectedOutcomes,
      instances: nodes.map((n) => n.id),
      stereotypeWarningCount: existing?.stereotypeWarningCount ?? 0,
      sceneTag,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };

    this.schemaCache.set(cacheKey, schema);
    this.idIndex.set(id, cacheKey);
    // 写穿落盘（P0）：图式跨重启存活
    this.persistence?.savePattern(actorId, schema);
    return schema;
  }

  /**
   * 图式同化。
   *
   * 算法：
   *   1. 遍历所有缓存的 SchemaNode 计算 matchScore
   *   2. sceneTag 相同：基础分 0.6
   *   3. 否则用 keywords overlap 计算：hits / target.length
   *   4. 返回 matchScore 最高的 schema（> matchThreshold）
   *   5. stereotypeWarningCount > stereotypeWarningThreshold 时附加警告
   *
   * 不调 LLM。无匹配时返回 null。
   */
  matchSchema(newSituation: {
    sceneTag?: string;
    keywords?: string[];
    summary?: string;
    /** actor 过滤（2026-10-22 补）：schemaCache 全 actor 共享，不传会跨身份串图式 */
    actorId?: string;
  }): SchemaMatchResult | null {
    const cfg = loadConfig();
    if (!cfg.enabled) return null;

    let best: { schema: SchemaNode; score: number } | null = null;
    for (const [cacheKey, schema] of this.schemaCache.entries()) {
      if (newSituation.actorId && !cacheKey.startsWith(`${newSituation.actorId}::`)) {
        continue;
      }
      let score: number;
      if (newSituation.sceneTag && newSituation.sceneTag === schema.sceneTag) {
        score = 0.6;
      } else {
        // keywords overlap 计算
        const kw = newSituation.keywords ?? [];
        const target = [...schema.preconditions, ...schema.steps];
        score = computeOverlap(kw, target);
      }
      if (best === null || score > best.score) {
        best = { schema, score };
      }
    }

    if (!best || best.score < cfg.matchThreshold) return null;

    const hasWarning =
      best.schema.stereotypeWarningCount > cfg.stereotypeWarningThreshold;
    return {
      schema: best.schema,
      matchScore: best.score,
      hasStereotypeWarning: hasWarning,
      matchedAt: new Date().toISOString(),
    };
  }

  /**
   * 刻板印象追踪。
   *
   *   - 在缓存中找到 schemaId 对应的 SchemaNode
   *   - stereotypeWarningCount += 1
   *   - updatedAt 更新
   *   - schemaId 不存在时静默返回（不报错）
   *
   * 不调 LLM。
   */
  recordStereotypeFailure(schemaId: string): void {
    const cfg = loadConfig();
    if (!cfg.enabled) return;
    const cacheKey = this.idIndex.get(schemaId);
    if (!cacheKey) return;
    const schema = this.schemaCache.get(cacheKey);
    if (!schema) return;
    schema.stereotypeWarningCount += 1;
    schema.updatedAt = new Date().toISOString();
    // 写穿落盘（P0）：警告计数跨重启存活
    const actorId = cacheKey.includes("::") ? cacheKey.slice(0, cacheKey.indexOf("::")) : "";
    if (actorId) this.persistence?.savePattern(actorId, schema);
  }

  /** 获取指定 schema（不存在返回 null） */
  getSchema(schemaId: string): SchemaNode | null {
    const cacheKey = this.idIndex.get(schemaId);
    if (!cacheKey) return null;
    return this.schemaCache.get(cacheKey) ?? null;
  }

  /** 获取所有 schema（可选按 actorId 过滤） */
  getAllSchemas(actorId?: string): SchemaNode[] {
    if (actorId) this.hydrate(actorId);
    const all = [...this.schemaCache.values()];
    if (!actorId) return all;
    const prefix = `${actorId}::`;
    const result: SchemaNode[] = [];
    for (const schema of all) {
      const cacheKey = this.idIndex.get(schema.id);
      if (cacheKey && cacheKey.startsWith(prefix)) {
        result.push(schema);
      }
    }
    return result;
  }

  /** 生成 schema id（sceneTag + hash） */
  private generateSchemaId(actorId: string, sceneTag: string): string {
    const hash = simpleHash(`${actorId}::${sceneTag}::${Date.now()}`);
    return `schema:${sceneTag}:${hash}`;
  }
}
