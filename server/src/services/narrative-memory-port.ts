import type { AgenticMemoryIngestService } from "../agentic-memory/ingest.js";
import type { AgenticMemoryRetrievalService } from "../agentic-memory/retrieval.js";
import type { AgenticMemoryRecallCompressor } from "../agentic-memory/recall-compressor.js";
import type { MemoryBridgeService } from "../agentic-memory/memory-bridge-service.js";
import type {
  HumanLikeMemoryRecallResult,
  HumanLikeMemoryService,
  MemoryContextKind,
} from "./human-like-memory-service.js";

export type NarrativeMemoryContext = "main" | "notes";

/** 记忆条目的来源事件：LTM 结论可回溯到具体哪一轮、发生在何时（而非整理时间）。 */
export type MemoryWriteProvenance = {
  /** 来源事件 id（memory_events.id） */
  sourceEventId?: string;
  /** 批量整理时的多个来源事件 id（一夜事件压成一条结论时用） */
  sourceEventIds?: string[];
  /** 事件发生时刻（ISO，不是入库时间） */
  eventTime?: string;
};

/** 写入结果：persisted=false 表示所有配置的落库侧都抛错，调用方不应丢弃源流水。 */
export type WriteDecidedOutcome = { persisted: boolean };

export type NarrativeMemoryPort = {
  ingest(
    actorId: string,
    text: string,
    source: string,
    opts?: {
      highSignal?: boolean;
      context?: NarrativeMemoryContext;
      /** 写入契约的调用方身份（memory.cognition / memory.longterm 的 producer） */
      writer?: string;
    },
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
    opts: { context: NarrativeMemoryContext; highSignal: boolean } & MemoryWriteProvenance,
    unified?: import("../agentic-memory/unified-extractor.js").UnifiedExtraction,
  ): Promise<WriteDecidedOutcome | void>;
  buildNarrativeRecall(actorId: string, query: string): Promise<string>;
  buildCrossContextRecall(actorId: string, query: string): Promise<string>;
  buildDetailedRecall(actorId: string, query: string): Promise<string>;
  buildSourceRecall(actorId: string, query: string): Promise<string>;
  /** 同 actor 近期是否已写过同一内容（写入回执；未接线返回 false） */
  wasRecentlyWritten?(actorId: string, text: string): boolean;
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

/** 只保留有值的来源字段，避免把 undefined 写进 Mem0 metadata。 */
function pickProvenance(provenance: MemoryWriteProvenance): MemoryWriteProvenance {
  return {
    ...(provenance.sourceEventId ? { sourceEventId: provenance.sourceEventId } : {}),
    ...(provenance.sourceEventIds?.length ? { sourceEventIds: provenance.sourceEventIds } : {}),
    ...(provenance.eventTime ? { eventTime: provenance.eventTime } : {}),
  };
}

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
    opts?: {
      highSignal?: boolean;
      context?: NarrativeMemoryContext;
      /** 写入契约的调用方身份（memory.cognition / memory.longterm 的 producer） */
      writer?: string;
    },
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
        writer: opts?.writer ?? "NarrativeMemoryFacade",
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
    opts: { context: NarrativeMemoryContext; highSignal: boolean } & MemoryWriteProvenance,
    unified?: import("../agentic-memory/unified-extractor.js").UnifiedExtraction,
  ): Promise<WriteDecidedOutcome> {
    const context = opts.context as MemoryContextKind;
    const provenance = pickProvenance(opts);
    if (this.bridge) {
      const result = await this.bridge.writeUnified(
        actorId,
        source,
        text,
        {
          context,
          highSignal: opts.highSignal,
          ...provenance,
        },
        unified,
      );
      this.fireOnWrite(actorId, text, source);
      return { persisted: result.ok };
    }
    let attempted = 0;
    let failed = 0;
    if (this.humanLikeMemory) {
      attempted++;
      try {
        await this.humanLikeMemory.ingest(actorId, text, source, {
          context,
          metadata: { highSignal: opts.highSignal, ...provenance },
        });
      } catch (err) {
        failed++;
        console.error("[NarrativeMemoryFacade] 海马体写入失败:", err);
      }
    }
    if (this.agenticIngest) {
      attempted++;
      try {
        if (unified) {
          await this.agenticIngest.persistUnifiedExtraction(
            actorId,
            source,
            unified,
            context,
            opts.highSignal,
            text,
            provenance,
          );
        } else {
          await this.agenticIngest.writeDecided(
            actorId,
            source,
            text,
            context,
            opts.highSignal,
            provenance,
          );
        }
      } catch (err) {
        failed++;
        console.error("[NarrativeMemoryFacade] Mem0 写入失败:", err);
      }
    }
    this.fireOnWrite(actorId, text, source);
    // 只有“配置了落库侧且全部失败”才算未持久化；未配置任何落库侧视为无操作成功
    return { persisted: attempted === 0 || failed < attempted };
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

  wasRecentlyWritten(actorId: string, text: string): boolean {
    return this.bridge?.hasRecentWrite(actorId, text) ?? false;
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

