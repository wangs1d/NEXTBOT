/**
 * 神经交叉编码重排（N2，docs/neural-retrieval-plan.md §2）。
 *
 * 实现 reranking-pipeline 预留的 LlmReranker 钩子：sidecar /rerank
 * （bge-reranker-base，CPU 10 对 <80ms）对管线给出的 top-10 做真·交叉编码排序。
 *
 * 触发面（方案约定）：
 *   - 仅低置信路径——管线的 rerank() 本来就只在 intent.confidence < 0.85 时被
 *     调用（高置信短路不经过这里），零额外延迟；
 *   - 候选 < 3 个直接维持词面序（重排无信息增益）；
 *   - sidecar 停机/超时/熔断 → 抛错，由管线的 try/catch 回退词面序（语义不变）。
 */
import type { LlmReranker } from "./reranking-pipeline.js";
import type { HybridRetrievedResource } from "../retrieval/hybrid-retrieval.js";
import { isNeuralFeatureEnabled, neuralRerank } from "../neural-sidecar.js";

/**
 * 重排输入文档（方案 §2）：name + description + capability + tags。
 * 有意不带 level2.use_cases（examples/aliases 已由 BM25/词面通道覆盖），总长
 * 截断 120 字符——CPU 实测 6 对 × 120 ≈ 150-250ms（10 对 × 160 会打穿 600ms
 * 预算触发熔断），精排信号集中在 name/description 前段，更长截断收益递减。
 */
function rerankDocument(candidate: HybridRetrievedResource): string {
  const l1 = candidate.resource.level1;
  return [
    l1.name,
    l1.description,
    ...l1.capability,
    ...l1.tags,
  ]
    .filter(Boolean)
    .join(" ")
    .slice(0, NEURAL_RERANK_DOC_CHARS);
}

/**
 * 送 sidecar 的重排对数：CPU 实测 10 对 × 160 字符 ≈ 400ms+（打穿预算、熔断
 * 反复开闸）。重排的价值集中在决定最终 top-5 输出的前几名——只重排前 6 对
 * （6×120 ≈ 150-250ms），其余候选按词面序原样保留在尾部。
 * 可经 env 调整（GPU/更强硬件可放宽：AGENT_NEURAL_RERANK_TOP_N=10、
 * AGENT_NEURAL_RERANK_DOC_CHARS=200，CPU 标定值勿盲目调大）。
 */
const NEURAL_RERANK_TOP_N = clampEnvInt("AGENT_NEURAL_RERANK_TOP_N", 6, 1, 20);
const NEURAL_RERANK_DOC_CHARS = clampEnvInt("AGENT_NEURAL_RERANK_DOC_CHARS", 120, 40, 1000);

function clampEnvInt(name: string, fallback: number, min: number, max: number): number {
  const n = Number.parseInt(process.env[name] ?? "", 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * 采信门槛（2026-09-12 A/B 两次实测教训，门禁实现在 reranking-pipeline）：
 * golden 20 条本就是按词面+校准调优出来的，rerank 无条件接管把 golden top-1
 * 打到 15-16/20（「现在几点了」→ clock.get_user_location），RRF 融合也挡不住。
 * 最终策略：管线仅在 head 内全部候选 keyword_score=0（query 与任何候选零词面
 * 命中——纯改写场景）时才进入本重排器。N2 定位收窄为「词面完全失效时的交叉
 * 编码救援」：golden 零风险，改写集收益保留。此处无需重复判断，也无需与词面
 * 名次融合（能走到这里词面名次已是噪声），直接按交叉编码分数排序。
 */

/**
 * 构造挂到 ToolRerankingPipeline 上的神经重排器。
 * env 关闭（AGENT_NEURAL_RERANK_ENABLED=off）时返回 undefined，管线行为与
 * 注入前完全一致（回滚开关）。
 */
export function createNeuralLlmReranker(): LlmReranker | undefined {
  if (!isNeuralFeatureEnabled("rerank")) return undefined;

  return async (input) => {
    const candidates = input.candidates;
    const ids = candidates.map((c) => c.resource.level1.resource_id);
    if (candidates.length < 3) return ids;

    const topN = Math.min(NEURAL_RERANK_TOP_N, candidates.length);
    const head = candidates.slice(0, topN);

    const result = await neuralRerank(
      input.raw_query,
      head.map(rerankDocument),
      topN,
    );
    if (!result || result.scores.length !== topN) {
      // sidecar 不可用（超时/熔断/停机）：静默维持词面序回原序——降级语义与抛错
      // 等价，但不逐查询刷堆栈（熔断开闸已单次 warn + metrics 计数覆盖观测）。
      // 只有分数长度异常这种真正的意外才走抛错路径进入管线 warn。
      if (!result) return ids;
      throw new Error(`neural rerank score count mismatch: ${result.scores.length} != ${topN}`);
    }

    const headOrder = head
      .map((candidate, i) => ({
        id: head[i]!.resource.level1.resource_id,
        score: result.scores[i] ?? -Infinity,
      }))
      .sort((a, b) => b.score - a.score)
      .map((x) => x.id);

    // 边界缝合：神经只重排了 head，tail 保持词面序——head 末位词面分若低于
    // tail 首位，会把词面强候选压在分界之下。缝合规则：tail 头部词面分高于
    // head 末位时，前移到 head 末位之前（只跨一个位置，神经对 head 内部的
    // 定序权不受影响）；循环至边界单调。
    const byId = new Map(candidates.map((c) => [c.resource.level1.resource_id, c] as const));
    const headQueue = headOrder.map((id) => byId.get(id)!).filter(Boolean);
    const tailQueue = ids
      .slice(topN)
      .map((id) => byId.get(id)!)
      .filter(Boolean);
    while (tailQueue.length > 0 && headQueue.length > 1) {
      const tailHead = tailQueue[0]!;
      const headLast = headQueue[headQueue.length - 1]!;
      if (tailHead.final_score <= headLast.final_score) break;
      tailQueue.shift();
      headQueue.splice(headQueue.length - 1, 0, tailHead);
    }
    return [...headQueue, ...tailQueue].map((c) => c.resource.level1.resource_id);
  };
}
