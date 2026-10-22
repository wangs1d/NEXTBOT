import type { AgenticMemoryIngestService } from "../agentic-memory/ingest.js";
import type { AgenticMemoryRetrievalService } from "../agentic-memory/retrieval.js";
import type { AgenticMemoryRecallCompressor } from "../agentic-memory/recall-compressor.js";
import type { MemoryBridgeService } from "../agentic-memory/memory-bridge-service.js";
import { formatHybridRecall } from "./narrative-hybrid-retrieval-service.js";
import type {
  HumanLikeMemoryRecallResult,
  HumanLikeMemoryService,
  MemoryContextKind,
} from "./human-like-memory-service.js";

export type NarrativeMemoryContext = "main" | "notes";

export type NarrativeMemoryPort = {
  ingest(
    actorId: string,
    text: string,
    source: string,
    opts?: { highSignal?: boolean; context?: NarrativeMemoryContext },
  ): Promise<void>;
  /**
   * 统一写入者出口：候选已经过整合链路裁决（decideMemoryWrite / 回声过滤 /
   * supersession），此处直接落库，不再二次决策。语义与 ingest 相同
   * （海马体 + Mem0 [+ hybrid 索引]），只是免去重复 LLM 裁决。
   *
   * unified 传入时为统一抽取产物（extraction 已含 memories/facts/commitments/
   * corrections）：Mem0 侧直存（infer:false）并经写入钩子驱动事实注册表等
   * 下游，text 仅作为认知图/hybrid 索引侧的内容。
   */
  writeDecided(
    actorId: string,
    text: string,
    source: string,
    opts: { context: NarrativeMemoryContext; highSignal: boolean },
    unified?: import("../agentic-memory/unified-extractor.js").UnifiedExtraction,
  ): Promise<void>;
  buildNarrativeRecall(actorId: string, query: string): Promise<string>;
  buildCrossContextRecall(actorId: string, query: string): Promise<string>;
  buildDetailedRecall(actorId: string, query: string): Promise<string>;
  buildSourceRecall(actorId: string, query: string): Promise<string>;
  runSleepConsolidation(actorIds: string[]): Promise<
    Array<{
      actorId: string;
      dailyCleanupCount: number;
      weeklyMergedCount: number;
      monthlyAbstractedCount: number;
      consistencyFlagCount: number;
      knowledgePromotedCount: number;
      compressionRate: number;
      estimatedRecallPrecision: number;
      plannedActions: number;
      executedActions: number;
      stageReports: Array<{ stage: string; changed: number; notes: string[] }>;
    }>
  >;
  selfCheck(actorId: string, query: string): Promise<{ exists: boolean; domainId: string | null; confidence: number }>;
  getTelemetrySnapshot(): Record<string, unknown>;
};

async function unwrapRecall(
  recall: Promise<HumanLikeMemoryRecallResult>,
  compressor: AgenticMemoryRecallCompressor | null,
): Promise<string> {
  const result = await recall;
  if (!result.text) return "";
  return compressor ? compressor.compress(result.text) : result.text;
}

export class NarrativeMemoryFacade implements NarrativeMemoryPort {
  constructor(
    private readonly agenticIngest: AgenticMemoryIngestService | null,
    private readonly agenticRetrieval: AgenticMemoryRetrievalService | null,
    private readonly compressor: AgenticMemoryRecallCompressor | null,
    private readonly humanLikeMemory: HumanLikeMemoryService | null,
    /**
     * 方案 A 记忆桥接（可选）。注入后写入走 bridge.writeUnified（认知图 + Mem0
     * + 双向 linkage 一次完成），主召回走 buildFusedRecall（两路 RRF 融合）；
     * 未注入（AGENT_MEMORY_BRIDGE_ENABLED=false / 单测）保持旧双写 + 短路召回。
     */
    private readonly bridge: MemoryBridgeService | null = null,
    /**
     * 记忆写入后钩子（方案 E 偏好变更触发链路）。fire-and-forget：
     * 写入成功后异步通知（如 PreferenceChangeTrigger.noteMemoryWrite），
     * 钩子失败不影响写入主链路。
     */
    private readonly onWrite?: (actorId: string, text: string, source: string) => void | Promise<void>,
  ) {}

  async ingest(
    actorId: string,
    text: string,
    source: string,
    opts?: { highSignal?: boolean; context?: NarrativeMemoryContext },
  ): Promise<void> {
    const context = (opts?.context ?? "main") as MemoryContextKind;

    if (this.bridge) {
      await this.bridge.writeUnified(actorId, source, text, {
        context,
        highSignal: opts?.highSignal === true,
      });
      this.fireOnWrite(actorId, text, source);
      return;
    }

    if (this.humanLikeMemory) {
      await this.humanLikeMemory.ingest(actorId, text, source, {
        context,
        metadata: { highSignal: opts?.highSignal === true },
      });
    }

    if (this.agenticIngest) {
      await this.agenticIngest.ingestText(actorId, source, text, {
        highSignal: opts?.highSignal,
        context,
      });
    }
    this.fireOnWrite(actorId, text, source);
  }

  async writeDecided(
    actorId: string,
    text: string,
    source: string,
    opts: { context: NarrativeMemoryContext; highSignal: boolean },
    unified?: import("../agentic-memory/unified-extractor.js").UnifiedExtraction,
  ): Promise<void> {
    const context = opts.context as MemoryContextKind;
    if (this.bridge) {
      await this.bridge.writeUnified(
        actorId,
        source,
        text,
        {
          context,
          highSignal: opts.highSignal,
        },
        unified,
      );
      this.fireOnWrite(actorId, text, source);
      return;
    }
    if (this.humanLikeMemory) {
      await this.humanLikeMemory.ingest(actorId, text, source, {
        context,
        metadata: { highSignal: opts.highSignal },
      });
    }
    if (this.agenticIngest) {
      if (unified) {
        await this.agenticIngest.persistUnifiedExtraction(
          actorId,
          source,
          unified,
          context,
          opts.highSignal,
          text,
        );
      } else {
        await this.agenticIngest.writeDecided(actorId, source, text, context, opts.highSignal);
      }
    }
    this.fireOnWrite(actorId, text, source);
  }

  /** 写入后钩子（fire-and-forget，异常只记日志不抛出） */
  private fireOnWrite(actorId: string, text: string, source: string): void {
    if (!this.onWrite) return;
    try {
      void Promise.resolve(this.onWrite(actorId, text, source)).catch((err) => {
        console.log(`[NarrativeMemoryFacade] onWrite 钩子失败（忽略）: ${err}`);
      });
    } catch (err) {
      console.log(`[NarrativeMemoryFacade] onWrite 钩子抛错（忽略）: ${err}`);
    }
  }

  async buildNarrativeRecall(actorId: string, query: string): Promise<string> {
    if (this.bridge) {
      const fused = await this.bridge.buildFusedRecall(actorId, query, { context: "main" });
      return this.compressor && fused ? this.compressor.compress(fused) : fused;
    }

    if (this.humanLikeMemory) {
      return unwrapRecall(
        this.humanLikeMemory.buildRecall(actorId, query, {
          context: "main",
          crossDomain: false,
          detailLevel: "summary",
        }),
        this.compressor,
      );
    }

    if (!this.agenticRetrieval) return "";
    const recall = await this.agenticRetrieval.buildRecall(actorId, query);
    return this.compressor && recall ? this.compressor.compress(recall) : recall;
  }

  async buildCrossContextRecall(actorId: string, query: string): Promise<string> {
    if (this.bridge) {
      const fused = await this.bridge.buildFusedRecall(actorId, query, { context: "any" });
      return this.compressor && fused ? this.compressor.compress(fused) : fused;
    }

    if (this.humanLikeMemory) {
      return unwrapRecall(
        this.humanLikeMemory.buildRecall(actorId, query, {
          context: "main",
          crossDomain: true,
          detailLevel: "summary",
        }),
        this.compressor,
      );
    }

    if (!this.agenticRetrieval) return "";
    const recall = await this.agenticRetrieval.buildCrossContextRecall(actorId, query);
    return this.compressor && recall ? this.compressor.compress(recall) : recall;
  }

  async buildDetailedRecall(actorId: string, query: string): Promise<string> {
    if (!this.humanLikeMemory) return this.buildNarrativeRecall(actorId, query);
    return unwrapRecall(
      this.humanLikeMemory.buildRecall(actorId, query, {
        context: "main",
        crossDomain: true,
        detailLevel: "detail",
      }),
      this.compressor,
    );
  }

  async buildSourceRecall(actorId: string, query: string): Promise<string> {
    if (!this.humanLikeMemory) return this.buildNarrativeRecall(actorId, query);
    return unwrapRecall(
      this.humanLikeMemory.buildRecall(actorId, query, {
        context: "main",
        crossDomain: true,
        detailLevel: "source",
      }),
      this.compressor,
    );
  }

  async runSleepConsolidation(actorIds: string[]): Promise<
    Array<{
      actorId: string;
      dailyCleanupCount: number;
      weeklyMergedCount: number;
      monthlyAbstractedCount: number;
      consistencyFlagCount: number;
      knowledgePromotedCount: number;
      compressionRate: number;
      estimatedRecallPrecision: number;
      plannedActions: number;
      executedActions: number;
      stageReports: Array<{ stage: string; changed: number; notes: string[] }>;
    }>
  > {
    if (!this.humanLikeMemory || actorIds.length === 0) return [];
    return this.humanLikeMemory.runSleepCycleForActors(actorIds);
  }

  async selfCheck(actorId: string, query: string): Promise<{ exists: boolean; domainId: string | null; confidence: number }> {
    if (!this.humanLikeMemory) return { exists: false, domainId: null, confidence: 0 };
    const recall = await this.humanLikeMemory.buildRecall(actorId, query, {
      context: "main",
      crossDomain: false,
      detailLevel: "summary",
      limit: 1,
    });
    return {
      exists: recall.recalledNodeIds.length > 0,
      domainId: recall.recalledNodeIds.length > 0 ? recall.domainId : null,
      confidence: recall.confidence,
    };
  }

  getTelemetrySnapshot(): Record<string, unknown> {
    return this.humanLikeMemory?.getTelemetrySnapshot() ?? {};
  }
}

export function createNarrativeMemoryPort(opts: {
  agenticIngest: AgenticMemoryIngestService | null;
  agenticRetrieval: AgenticMemoryRetrievalService | null;
  compressor: AgenticMemoryRecallCompressor | null;
  humanLikeMemory: HumanLikeMemoryService | null;
  bridge?: MemoryBridgeService | null;
  /** 写入后钩子（方案 E 偏好变更触发链路；fire-and-forget） */
  onWrite?: (actorId: string, text: string, source: string) => void | Promise<void>;
}): NarrativeMemoryPort | null {
  if (!opts.agenticIngest && !opts.agenticRetrieval && !opts.humanLikeMemory && !opts.bridge) {
    return null;
  }
  return new NarrativeMemoryFacade(
    opts.agenticIngest,
    opts.agenticRetrieval,
    opts.compressor,
    opts.humanLikeMemory,
    opts.bridge ?? null,
    opts.onWrite,
  );
}

/**
 * 混合检索适配器：把 NarrativeHybridRetrievalService（BM25+Qdrant+RRF）
 * 与现有 NarrativeMemoryPort 组合，实现「人脑记忆 + 向量检索」双通道。
 *
 * - ingest：双写（facade 做人脑记忆沉淀，hybrid 做 BM25+Qdrant 索引）。
 *   bridgeActive 时短文本（< 切块阈值）跳过 hybrid 向量嵌入——其内容已由
 *   Mem0×认知图×FTS 融合召回覆盖，重复嵌入只是多烧一次 API 与一份向量存储；
 *   BM25 仍照常写入。
 * - buildNarrativeRecall：双通道召回后拼接结果（facade 优先，hybrid 补充）；
 *   hybrid 块与 facade 已展示内容做跨通道去重，避免同一记忆原文+抽取事实
 *   双份进 Prompt。
 * - 其余方法：仅委托 facade（hybrid 未实现这些方法）
 */
class NarrativeHybridAdapter implements NarrativeMemoryPort {
  constructor(
    private readonly facade: NarrativeMemoryPort,
    private readonly hybrid: import("./narrative-hybrid-retrieval-service.js").NarrativeHybridRetrievalService,
    /** bridge 融合召回是否生效（决定短文本是否还需要 hybrid 向量索引） */
    private readonly bridgeActive: boolean,
  ) {}

  /**
   * hybrid 块与 facade 融合文本的跨通道去重：
   * - facade 文本已逐字包含该块 → 纯重复，丢弃；
   * - 短块（<200 字符）包含 facade 的某条事实行 → 块是该事实的原文冗余，丢弃；
   * - 长块（切块的独有价值：上下文连续性）保守保留。
   */
  private dedupeChunksAgainstFacade(chunks: string[], facadeText: string): string[] {
    if (chunks.length === 0) return chunks;
    if (!facadeText.trim()) return chunks;
    const norm = (s: string): string => s.replace(/\s+/g, " ").trim();
    const facadeNorm = norm(facadeText);
    // facade 渲染格式（buildFusedRecall / buildRecall / 认知图 recall）中事实行的
    // 启发式提取：跳过说明头（以下为…）与元数据行（N. [融合]相关度 …）
    const factLines = facadeText
      .split("\n")
      .map((l) => norm(l))
      .filter((l) => l.length >= 10 && !/^(以下为|\d+[.、]\s*(融合)?相关度)/.test(l));
    return chunks.filter((chunk) => {
      const c = norm(chunk);
      if (!c) return false;
      if (facadeNorm.includes(c)) return false;
      if (c.length < 200 && factLines.some((line) => c.includes(line))) return false;
      return true;
    });
  }

  async ingest(
    actorId: string,
    text: string,
    source: string,
    opts?: { highSignal?: boolean; context?: NarrativeMemoryContext },
  ): Promise<void> {
    const skipVector = this.bridgeActive && text.trim().length < this.hybrid.chunkChars;
    await Promise.all([
      this.facade.ingest(actorId, text, source, opts),
      this.hybrid.ingest(actorId, text, source, { skipVector }),
    ]);
  }

  async writeDecided(
    actorId: string,
    text: string,
    source: string,
    opts: { context: NarrativeMemoryContext; highSignal: boolean },
    unified?: import("../agentic-memory/unified-extractor.js").UnifiedExtraction,
  ): Promise<void> {
    const skipVector = this.bridgeActive && text.trim().length < this.hybrid.chunkChars;
    await Promise.all([
      this.facade.writeDecided(actorId, text, source, opts, unified),
      this.hybrid.ingest(actorId, text, source, { skipVector }),
    ]);
  }

  async buildNarrativeRecall(actorId: string, query: string): Promise<string> {
    const [facadeResult, chunks] = await Promise.all([
      this.facade.buildNarrativeRecall(actorId, query),
      this.hybrid.recallChunks(actorId, query),
    ]);
    const hybridResult = formatHybridRecall(this.dedupeChunksAgainstFacade(chunks, facadeResult));
    return [facadeResult, hybridResult].filter(Boolean).join("\n\n");
  }

  async buildCrossContextRecall(actorId: string, query: string): Promise<string> {
    return this.facade.buildCrossContextRecall(actorId, query);
  }

  async buildDetailedRecall(actorId: string, query: string): Promise<string> {
    return this.facade.buildDetailedRecall(actorId, query);
  }

  async buildSourceRecall(actorId: string, query: string): Promise<string> {
    return this.facade.buildSourceRecall(actorId, query);
  }

  async runSleepConsolidation(actorIds: string[]): Promise<
    Array<{
      actorId: string;
      dailyCleanupCount: number;
      weeklyMergedCount: number;
      monthlyAbstractedCount: number;
      consistencyFlagCount: number;
      knowledgePromotedCount: number;
      compressionRate: number;
      estimatedRecallPrecision: number;
      plannedActions: number;
      executedActions: number;
      stageReports: Array<{ stage: string; changed: number; notes: string[] }>;
    }>
  > {
    return this.facade.runSleepConsolidation(actorIds);
  }

  async selfCheck(actorId: string, query: string): Promise<{ exists: boolean; domainId: string | null; confidence: number }> {
    return this.facade.selfCheck(actorId, query);
  }

  getTelemetrySnapshot(): Record<string, unknown> {
    return {
      ...this.facade.getTelemetrySnapshot(),
      hybridRetrieval: "enabled",
    };
  }
}

/**
 * 条件包装：如果 hybrid 检索服务可用，把 port 包装为双通道适配器。
 * @param port 现有 NarrativeMemoryPort（可能为 null）
 * @param hybrid NarrativeHybridRetrievalService 实例（可能为 null）
 * @param bridgeActive bridge 融合召回是否生效（true 时短文本跳过 hybrid 向量重复索引）
 * @returns 包装后的 NarrativeMemoryPort（或原 port / null）
 */
export function wrapNarrativeWithHybrid(
  port: NarrativeMemoryPort | null,
  hybrid: import("./narrative-hybrid-retrieval-service.js").NarrativeHybridRetrievalService | null,
  bridgeActive = false,
): NarrativeMemoryPort | null {
  if (!port || !hybrid) return port;
  return new NarrativeHybridAdapter(port, hybrid, bridgeActive);
}
