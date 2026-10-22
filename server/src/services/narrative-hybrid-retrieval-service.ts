import { Bm25LiteIndex } from "../agent/retrieval/bm25-lite.js";
import { reciprocalRankFusion } from "../agent/retrieval/rrf.js";
import { gateLtmWrite } from "../agentic-memory/ltm-write-gate.js";
import {
  fetchOpenAiCompatibleEmbedding,
  fetchOpenAiCompatibleEmbeddings,
  resolveEmbeddingModel,
} from "./openai-embedding-client.js";
import type { NarrativePointPayload } from "./sqlite-narrative-store.js";
import { SqliteNarrativeStore } from "./sqlite-narrative-store.js";

function envPositiveInt(name: string, fallback: number): number {
  const v = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

/**
 * 叙事文本切块：优先在句界（。！？!?\n）聚合到目标长度，超长单句硬切；
 * 相邻 chunk 携带上一块尾部重叠，保持检索上下文连续。
 * 长文本整块进 embedding 会把语义"平均掉"，切块后向量精度与 BM25 命中率显著提升。
 */
export function splitNarrativeChunks(
  text: string,
  maxLen: number,
  overlap: number,
): string[] {
  if (text.length <= maxLen) return [text];
  const segments = text.split(/(?<=[。！？!?\n])/);
  const chunks: string[] = [];
  let buf = "";
  const flush = () => {
    const t = buf.trim();
    if (t) chunks.push(t);
    buf = "";
  };
  for (const seg of segments) {
    if (!seg) continue;
    if (seg.length > maxLen) {
      flush();
      for (let i = 0; i < seg.length; i += maxLen) {
        const piece = seg.slice(i, i + maxLen).trim();
        if (piece) chunks.push(piece);
      }
      continue;
    }
    if (buf.length + seg.length > maxLen) flush();
    buf += seg;
  }
  flush();
  if (overlap > 0 && chunks.length > 1) {
    return chunks.map((c, i) =>
      i === 0 ? c : `${chunks[i - 1]!.slice(-overlap)}${c}`,
    );
  }
  return chunks;
}

/**
 * BM25（进程内）+ SQLite 向量检索 + RRF 融合 → 拼装进 Prompt 的长期叙事摘录。
 *
 * 进程内状态（BM25 索引 / chunk 原文）重启即丢；首次召回时从 SQLite scroll
 * 回灌重建（narrative-memory.sqlite 是唯一事实源，payload 携带原文）。
 *
 * ENV:
 * - `AGENT_NARRATIVE_DB_PATH`（SQLite 持久化路径，缺省 data/narrative-memory.sqlite）
 * - `OPENAI_API_KEY` 或沿用对话 Key 做 embeddings；模型经 resolveEmbeddingModel 统一解析
 * - `OPENAI_EMBEDDINGS_URL` 可选，自定义兼容端点
 * - `AGENT_NARRATIVE_MAX_DOCS_PER_ACTOR`、`AGENT_NARRATIVE_*_TOP` 可调
 * - `AGENT_NARRATIVE_CHUNK_CHARS`（缺省 800）、`AGENT_NARRATIVE_CHUNK_OVERLAP`（缺省 120）
 */
export class NarrativeHybridRetrievalService {
  private seq = 0;
  private readonly chunkTexts = new Map<string, string>();
  private readonly bmByActor = new Map<string, Bm25LiteIndex>();
  private readonly maxDocsPerActor: number;
  private readonly bmTop: number;
  private readonly vecTop: number;
  private readonly rrfK: number;
  private readonly fuseTop: number;
  /** 切块阈值：bridge 启用时短于该值的文本已由 Mem0×图×FTS 融合覆盖，无需再进向量索引 */
  readonly chunkChars: number;
  private readonly chunkOverlap: number;
  private readonly embeddingModel: string;
  private readonly embeddingKey: string | null;
  /** 每 actor 每进程只回灌一次；在飞请求共享同一个 Promise */
  private rehydratedActors = new Set<string>();
  private rehydrating = new Map<string, Promise<void>>();

  constructor(private readonly store: SqliteNarrativeStore) {
    this.maxDocsPerActor = envPositiveInt("AGENT_NARRATIVE_MAX_DOCS_PER_ACTOR", 800);
    this.bmTop = envPositiveInt("AGENT_NARRATIVE_BM25_TOP", 24);
    this.vecTop = envPositiveInt("AGENT_NARRATIVE_VEC_TOP", 24);
    this.rrfK = envPositiveInt("AGENT_NARRATIVE_RRF_K", 60);
    this.fuseTop = envPositiveInt("AGENT_NARRATIVE_FUSE_TOP", 8);
    this.chunkChars = envPositiveInt("AGENT_NARRATIVE_CHUNK_CHARS", 800);
    this.chunkOverlap = envPositiveInt("AGENT_NARRATIVE_CHUNK_OVERLAP", 120);
    this.embeddingModel = resolveEmbeddingModel();
    this.embeddingKey =
      process.env.AGENT_EMBEDDING_API_KEY?.trim() ||
      process.env.OPENAI_API_KEY?.trim() ||
      null;
  }

  private bm(actorId: string): Bm25LiteIndex {
    let idx = this.bmByActor.get(actorId);
    if (!idx) {
      idx = new Bm25LiteIndex(this.maxDocsPerActor);
      this.bmByActor.set(actorId, idx);
    }
    return idx;
  }

  /**
   * 从 SQLite 回灌重建 BM25 词法索引（每 actor 每进程一次）。
   * 失败时标记已完成避免重试风暴——后续 ingest 会继续增量填充。
   */
  private async ensureBmRehydrated(actorId: string): Promise<void> {
    if (this.rehydratedActors.has(actorId)) return;
    if (!this.store.isEnabled() || !this.embeddingKey) {
      this.rehydratedActors.add(actorId);
      return;
    }
    let p = this.rehydrating.get(actorId);
    if (!p) {
      const idx = this.bm(actorId);
      p = (async () => {
        const points = await this.store.scrollByActor(actorId, this.maxDocsPerActor);
        for (const pt of points) {
          const text = pt.payload?.text;
          const chunkId = pt.payload?.chunkId;
          if (!text || !chunkId) continue;
          this.chunkTexts.set(chunkId, text);
          idx.upsert(chunkId, text);
        }
        if (points.length > 0) {
          console.log(
            `[narrative-hybrid] BM25 回灌完成: ${actorId} (${points.length} chunks)`,
          );
        }
      })()
        .catch((e) => {
          console.warn(
            "[narrative-hybrid] BM25 回灌失败（跳过）:",
            e instanceof Error ? e.message : e,
          );
        })
        .finally(() => {
          this.rehydratedActors.add(actorId);
          this.rehydrating.delete(actorId);
        });
      this.rehydrating.set(actorId, p);
    }
    await p;
  }

  /**
   * ingest 单行叙事（进化循环 observe、轨迹摘要等）；切块后向量索引批量写入。
   *
   * opts.skipVector：文本短于切块阈值且上游已有 bridge 融合召回（Mem0 向量 ×
   * 认知图 × FTS）时，SQLite 向量索引与 Mem0 collection 内容高度重复，跳过可
   * 省掉一次 embedding API 与一份向量存储；BM25 仍照常增量写入。
   */
  async ingest(
    actorId: string,
    text: string,
    source: string,
    opts?: { skipVector?: boolean },
  ): Promise<void> {
    // v3 写入门：任务态（evolution:observe/活跃目标）、回声体、一次性提醒
    // 在叙事库入口即拒（277 条里 48 条化石的根因收口）
    const verdict = gateLtmWrite(text, source);
    if (!verdict.admit) {
      console.log(`[ltm-gate] 拒绝 narrative 写入(${verdict.reason}) source=${source}: ${text.slice(0, 60)}`);
      return;
    }
    const t = verdict.cleaned;
    if (!t || t.length < 4) return;
    const baseId = `${actorId}:${source}:${Date.now().toString(36)}:${(this.seq++).toString(36)}`;
    const chunks = splitNarrativeChunks(t, this.chunkChars, this.chunkOverlap).filter(
      (c) => c.length >= 4,
    );
    if (chunks.length === 0) return;
    const chunkIds = chunks.map((_, i) => (i === 0 ? baseId : `${baseId}:${i}`));

    chunks.forEach((body, i) => {
      this.chunkTexts.set(chunkIds[i]!, body);
      this.bm(actorId).upsert(chunkIds[i]!, body);
    });

    if (opts?.skipVector) return;
    if (!this.store.isEnabled() || !this.embeddingKey) return;

    try {
      // 一次 API 往返嵌入全部 chunk（此前逐块串行调用）
      const { vectors } = await fetchOpenAiCompatibleEmbeddings({
        apiKey: this.embeddingKey,
        model: this.embeddingModel,
        inputs: chunks,
      });
      await Promise.all(
        chunks.map((body, i) => {
          const payload: NarrativePointPayload = {
            actorId,
            text: body,
            source,
            chunkId: chunkIds[i]!,
            createdAt: new Date().toISOString(),
          };
          return this.store.upsertPoint(
            vectors[i]!,
            chunkIds[i]!,
            payload,
          );
        }),
      );
    } catch (e) {
      console.warn(
        "[narrative-hybrid] vector ingest skipped:",
        e instanceof Error ? e.message : e,
      );
    }
  }

  /**
   * 混合召回的结构化输出（BM25+向量 RRF 融合后的 chunk 文本列表）。
   * 供 NarrativeHybridAdapter 与 facade 融合文本做跨通道去重。
   */
  async recallChunks(actorId: string, query: string): Promise<string[]> {
    const q = query.trim().replace(/\s+/g, " ");
    if (!q) return [];

    await this.ensureBmRehydrated(actorId);
    const bmHits = this.bm(actorId).search(q, this.bmTop);
    let vecChunkIds: { id: string }[] = [];
    // 双通道恒开（不要按 BM25 命中数短路）：中文 query 下 BM25 对几乎所有 doc
    // 都有单字/bigram 级命中，按命中数门控会让语义通道长期被屏蔽，融合退化成纯 BM25。
    // 交由 RRF 统一仲裁；外层调用方（turn-lifecycle）有超时兜底。
    if (this.store.isEnabled() && this.embeddingKey) {
      try {
        const { vector } = await fetchOpenAiCompatibleEmbedding({
          apiKey: this.embeddingKey,
          model: this.embeddingModel,
          input: q,
        });
        const hits = await this.store.search(vector, actorId, this.vecTop);
        for (const h of hits) {
          this.chunkTexts.set(h.payload.chunkId, h.payload.text);
        }
        vecChunkIds = hits.map((h) => ({ id: h.payload.chunkId })).filter((x) => x.id);
      } catch {
        vecChunkIds = [];
      }
    }

    const fused = reciprocalRankFusion(
      [
        bmHits.map((h) => ({ id: h.id })),
        vecChunkIds,
      ].filter((l) => l.length > 0),
      this.rrfK,
      this.fuseTop,
    );

    const texts: string[] = [];
    for (const hit of fused) {
      const txt = this.chunkTexts.get(hit.id);
      if (txt) texts.push(txt);
    }
    return texts;
  }

  /** 格式化融合结果，注入 system 叙事块 */
  async buildNarrativeRecall(actorId: string, query: string): Promise<string> {
    return formatHybridRecall(await this.recallChunks(actorId, query));
  }
}

/** 将融合后的 chunk 文本渲染为注入 Prompt 的叙事块（空列表返回空串）。 */
export function formatHybridRecall(texts: string[]): string {
  if (texts.length === 0) return "";
  const parts = texts.map((txt, i) => `[${i + 1}] ${txt}`);
  return `以下为与当前问题相关的「长期叙事 / 履历」摘录（BM25+向量+RRF 融合）：\n${parts.join("\n\n")}`;
}

export function createNarrativeHybridRetrievalDefault(): NarrativeHybridRetrievalService | null {
  const disabled = process.env.AGENT_MEMORY_HYBRID_DISABLED?.trim().toLowerCase();
  if (disabled === "1" || disabled === "true" || disabled === "yes") return null;

  const store = new SqliteNarrativeStore();
  return new NarrativeHybridRetrievalService(store);
}
