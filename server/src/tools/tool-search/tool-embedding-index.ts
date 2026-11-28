/**
 * Embedding 召回：基于余弦相似度对工具描述排序。
 *
 * 动态筛选策略（非固定 top-K）：
 *   1. 计算全部工具与 query 的余弦相似度
 *   2. 按 score 降序排列
 *   3. 保留 score >= max(absoluteFloor, maxScore * relativeRatio) 的结果
 *   4. 上限 maxKeep 防止极端宽泛 query 导致候选爆炸
 *
 * 这样：
 *   - 宽泛 query（多个工具都高相关）→ 保留更多候选
 *   - 精确 query（只有一个明确目标）→ 保留更少候选
 *   - 避免 top-K 截断导致"差一点"的候选被丢弃
 *
 * 性能：113 工具 × 1536 维 = ~700KB 内存，单次余弦计算 < 1ms。
 */

/** 余弦相似度（已归一化向量时等价于点积） */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    dot += av * bv;
    normA += av * av;
    normB += bv * bv;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/** 预归一化向量（避免每次相似度计算都开方） */
export function preNormalizeVector(v: number[]): Float32Array {
  let norm = 0;
  for (let i = 0; i < v.length; i++) norm += (v[i] ?? 0) ** 2;
  norm = Math.sqrt(norm);
  if (norm === 0) return new Float32Array(v);
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = (v[i] ?? 0) / norm;
  return out;
}

/** 动态筛选参数 */
export type DynamicThreshold = {
  /** 绝对下限：cosine 低于此值的直接丢弃（避免噪声） */
  absoluteFloor: number;
  /** 相对比例：仅保留 score >= maxScore * ratio 的结果（跟随 query 宽窄自适应） */
  relativeRatio: number;
  /** 安全上限：无论阈值通过多少个，最多保留 N 个（防止极宽 query 爆炸） */
  maxKeep: number;
};

/**
 * 计算全部工具的余弦相似度并降序排列（不做截断）。
 * 调用方拿到完整排序后自行做动态阈值筛选。
 */
export type ToolEmbeddingVectorSet = Float32Array | Float32Array[];

function maxCosine(
  query: Float32Array,
  vectors: ToolEmbeddingVectorSet,
): number | null {
  const list = vectors instanceof Float32Array ? [vectors] : vectors;
  let best: number | null = null;
  for (const vector of list) {
    if (vector.length !== query.length) continue;
    let dot = 0;
    for (let i = 0; i < query.length; i++) dot += query[i]! * vector[i]!;
    if (best === null || dot > best) best = dot;
  }
  return best;
}

export function rankAllByEmbedding(
  queryVector: number[] | Float32Array,
  docVectors: Map<string, ToolEmbeddingVectorSet>,
): Array<{ id: string; score: number }> {
  if (queryVector.length === 0 || docVectors.size === 0) return [];

  const q =
    queryVector instanceof Float32Array
      ? queryVector
      : preNormalizeVector(queryVector as number[]);

  const hits: Array<{ id: string; score: number }> = [];
  for (const [id, vectors] of docVectors) {
    const score = maxCosine(q, vectors);
    if (score !== null) hits.push({ id, score });
  }

  hits.sort((a, b) => b.score - a.score);
  return hits;
}

/**
 * 动态阈值筛选：从完整排序结果中按 absoluteFloor / relativeRatio 截断。
 *
 * 算法：
 *   threshold = max(absoluteFloor, maxScore * relativeRatio)
 *   保留所有 score >= threshold 的结果，上限 maxKeep 个。
 *
 * 边界处理：
 *   - 空列表 → 返回空
 *   - maxScore < absoluteFloor → 返回空（所有工具都不够相关）
 *   - maxScore >= absoluteFloor → 至少保留 top-1
 */
export function filterByDynamicThreshold(
  sortedHits: Array<{ id: string; score: number }>,
  threshold: DynamicThreshold,
): Array<{ id: string; score: number }> {
  if (sortedHits.length === 0) return [];
  const maxScore = sortedHits[0]!.score;
  const dynamicThreshold = Math.max(threshold.absoluteFloor, maxScore * threshold.relativeRatio);

  const kept: Array<{ id: string; score: number }> = [];
  for (const hit of sortedHits) {
    if (kept.length >= threshold.maxKeep) break;
    if (hit.score < dynamicThreshold) break; // 已降序，后续只会更低
    kept.push(hit);
  }
  return kept;
}

/**
 * 工具向量索引：在 catalog 构建时一次性预归一化所有工具向量。
 * 搜索时直接 dot product，省去 sqrt。
 *
 * N4 规模化（docs/neural-retrieval-plan.md §4）：目录 ≥ ANN_MIN_TOOLS（缺省 2000）
 * 且 hnswlib-node 可加载时，全量 top-K 检索走进程内 HNSW（~50k 向量 p99 <5ms）；
 * 未安装/加载失败/规模未到 → 暴力扫描（当前百级目录是亚毫秒，零损失）。
 * hnswlib-node 是 optionalDependencies 成员：原生模块装不上不应阻断安装。
 */
import { getToolSearchConfig } from "./env.js";

/** hnswlib-node 的结构化最小接口（动态加载，避免硬类型依赖） */
type HnswIndex = {
  initIndex(maxElements: number, m?: number, efConstruction?: number): unknown;
  addPoint(vector: number[], idx: number): unknown;
  searchKnn(vector: number[], k: number): { distances: number[]; neighbors: number[] };
};

export class ToolEmbeddingIndex {
  private readonly vectors = new Map<string, Float32Array[]>();
  private dimension = 0;
  // ANN 层（惰性构建）：每个视图一条 label，检索后按工具取 max-sim。
  private annIndex: HnswIndex | null = null;
  private annIds: string[] = [];
  private annBuilding: Promise<void> | null = null;
  private annFailed = false;

  ingest(registryName: string, vector: number[] | number[][]): void {
    const source = Array.isArray(vector[0]) ? (vector as number[][]) : [vector as number[]];
    const normalized = source
      .filter((item) => item.length > 0)
      .map((item) => preNormalizeVector(item));
    if (normalized.length === 0) return;
    this.dimension = normalized[0]!.length;
    this.vectors.set(registryName, normalized);
    this.annIndex = null;
  }

  ingestMany(
    entries: Iterable<[string, number[] | number[][] | undefined | null]>,
  ): void {
    for (const [name, vectors] of entries) {
      if (vectors) this.ingest(name, vectors);
    }
  }

  /**
   * 动态筛选搜索：计算全部相似度 → 按动态阈值截断。
   * 不固定 top-K，而是根据 score 分布自适应保留候选数量。
   */
  searchDynamic(
    queryVector: number[] | Float32Array,
    threshold: DynamicThreshold,
  ): Array<{ id: string; score: number }> {
    const all = rankAllByEmbedding(queryVector, this.vectors);
    return filterByDynamicThreshold(all, threshold);
  }

  /**
   * 子集内余弦排序（只扫传入的 id 集合）：类别内搜索（Level 2）用——
   * 全量排序后过滤会把整个目录扫一遍，子集直接扫在千级目录上是数量级差。
   * 阈值语义随之变为「相对子集内 max」，弱类别不再被全局 max 压制。
   */
  rankAllWithin(
    ids: Set<string>,
    queryVector: number[] | Float32Array,
  ): Array<{ id: string; score: number }> {
    if (queryVector.length === 0 || ids.size === 0) return [];
    const q =
      queryVector instanceof Float32Array ? queryVector : preNormalizeVector(queryVector);
    const hits: Array<{ id: string; score: number }> = [];
    for (const id of ids) {
      const vectors = this.vectors.get(id);
      if (!vectors) continue;
      const score = maxCosine(q, vectors);
      if (score !== null) hits.push({ id, score });
    }
    hits.sort((a, b) => b.score - a.score);
    return hits;
  }

  /**
   * 全目录 top-K 检索（N4）：ANN 就绪走 HNSW，否则暴力扫描后取前 K。
   * 注意 HNSW 是近邻检索，尾部排序不保证精确——top-K 场景（K ≪ N）足够。
   */
  async searchTopK(
    queryVector: number[] | Float32Array,
    k: number,
  ): Promise<Array<{ id: string; score: number }>> {
    if (queryVector.length === 0 || this.vectors.size === 0) return [];
    if (this.annIndex) {
      try {
        const q = Array.from(queryVector);
        const maxViews = Math.max(1, ...[...this.vectors.values()].map((items) => items.length));
        const raw = this.annIndex.searchKnn(
          q,
          Math.min(this.annIds.length, Math.max(k, k * maxViews)),
        );
        const bestById = new Map<string, number>();
        for (let i = 0; i < raw.neighbors.length; i++) {
          const label = raw.neighbors[i];
          const distance = raw.distances[i];
          const id = label !== undefined ? this.annIds[label] : undefined;
          if (id === undefined || distance === undefined) continue;
          const score = 1 - distance;
          const previous = bestById.get(id);
          if (previous === undefined || score > previous) bestById.set(id, score);
        }
        return [...bestById.entries()]
          .map(([id, score]) => ({ id, score }))
          .sort((a, b) => b.score - a.score)
          .slice(0, Math.max(0, k));
      } catch {
        this.annIndex = null;
      }
    }
    return rankAllByEmbedding(queryVector, this.vectors).slice(0, Math.max(0, k));
  }

  /** ANN 是否该建（auto：规模达标；on：强制；off：永不）。 */
  private shouldBuildAnn(): boolean {
    const cfg = getToolSearchConfig();
    if (cfg.annMode === "off") return false;
    if (cfg.annMode === "on") return true;
    return (
      [...this.vectors.values()].reduce((sum, items) => sum + items.length, 0) >=
      cfg.annMinTools
    );
  }

  /**
   * 惰性构建 ANN 索引（fire-and-forget 安全，重复调用幂等）。
   * hnswlib-node 未安装 / 原生模块加载失败 → 标记 failed 永久回落暴力扫描。
   */
  async ensureAnn(): Promise<boolean> {
    if (this.annIndex || this.annFailed || !this.shouldBuildAnn()) return this.annIndex !== null;
    if (!this.annBuilding) {
      this.annBuilding = (async () => {
        try {
          const mod = (await import("hnswlib-node")) as unknown as {
            default?: { HierarchicalNSW: new (space: string, dim: number) => HnswIndex };
            HierarchicalNSW?: new (space: string, dim: number) => HnswIndex;
          };
          const ids: string[] = [];
          const points: Float32Array[] = [];
          for (const [id, vectors] of this.vectors) {
            for (const vector of vectors) {
              ids.push(id);
              points.push(vector);
            }
          }
          if (ids.length === 0 || this.dimension === 0) return;
          // ESM 互操作：类挂在 default 下（ESM/CJS 混合包，顶层无具名导出）
          const Ctor = mod.default?.HierarchicalNSW ?? mod.HierarchicalNSW;
          if (typeof Ctor !== "function") throw new Error("HierarchicalNSW constructor not found");
          const index = new Ctor("cosine", this.dimension);
          index.initIndex(ids.length, 16, 200);
          for (let i = 0; i < points.length; i++) {
            index.addPoint(Array.from(points[i]!), i);
          }
          this.annIds = ids;
          this.annIndex = index;
        } catch (error) {
          this.annFailed = true;
          console.warn(
            "[tool-embedding-index] hnswlib-node 不可用，embedding 检索保持暴力扫描（规模化前无损失）:",
            error instanceof Error ? error.message : String(error),
          );
        } finally {
          this.annBuilding = null;
        }
      })();
    }
    await this.annBuilding;
    return this.annIndex !== null;
  }

  /**
   * 返回全部余弦相似度排序（不截断），用于 Level 1 类别路由。
   */
  rankAll(queryVector: number[] | Float32Array): Array<{ id: string; score: number }> {
    return rankAllByEmbedding(queryVector, this.vectors);
  }

  get size(): number {
    return this.vectors.size;
  }

  get dim(): number {
    return this.dimension;
  }
}
