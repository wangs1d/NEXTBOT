/**
 * 方案 A：记忆层间打通（Memory Bridge）。
 *
 * 现状问题：Mem0（agentic-memory）与认知图（HumanLikeMemoryService）各自独立
 * 写入/召回——NarrativeMemoryFacade 虽双写，但两路之间没有任何 linkage：
 *   - 认知图遗忘（deletionStage 推进）无法同步到 Mem0，产生僵尸记忆；
 *   - 召回是「humanLike 优先、Mem0 兜底」的短路逻辑，不是真融合；
 *   - 无跨层关联，溯源作废（方案 D）无从下手。
 *
 * 本服务提供三个能力：
 *   1. writeUnified  —— 统一写入入口：一次写入同时落认知图节点 + Mem0 记忆，
 *      并建立双向 linkage（Mem0 metadata.graphNodeId ↔ 图节点 metadata.mem0Ids，
 *      另持久化 bridge_links 表供重启后遗忘同步）。
 *   2. buildFusedRecall —— 融合召回：Mem0 结构化召回 + 认知图召回两路结果
 *      RRF（Reciprocal Rank Fusion）合排 + 语义指纹跨通道去重。
 *   3. syncForgetting —— 遗忘同步：扫描 bridge_links，认知图节点推进到
 *      soft_deleted / hard_deleted 时删除其关联的 Mem0 记忆（阈值删除策略，
 *      用户决策 2026-09-04：Mem0 OSS 无 metadata 更新 API，不留阶段标记僵尸数据）。
 *
 * 接线：create-app-services 中按 AGENT_MEMORY_BRIDGE_ENABLED（缺省开）注入
 * NarrativeMemoryFacade；关闭时回退旧的双写 + 短路召回行为。
 *
 * 【真相源定位（P2-2）】认知图（hm_nodes）+ 结构化事实库是权威数据；Mem0 是
 * **可重建的二级索引**：它的条目全部由 persistUnifiedExtraction 直存派生而来，
 * 丢失/重建只影响召回通道（graph / fts 仍可用），不影响事实本身。因此：
 *   - 写入侧永远先落图、再落 Mem0（本节 writeUnified 的顺序即契约）；
 *   - Mem0 写入失败只记录、不回滚图节点；
 *   - 遗忘以图节点 deletionStage 为准，由 syncForgetting 反向清理 Mem0。
 * 同理，KV 槽位（memory_* 键）与 journal md 也都是从权威层派生的可重建视图。
 */

import type { Database as SqliteDatabase } from "better-sqlite3";

import type { Mem0WrittenItem } from "./ingest.js";
import type { AgenticMemoryCandidate } from "./retrieval.js";
import type { FtsMemoryCandidate } from "./fts-store.js";
import {
  getBridgeFusedTopK,
  getBridgeForgetSyncIntervalMin,
  getMemoryFtsTopK,
  isMemoryBridgeEnabled,
} from "./env.js";
import { openAgenticSqlite, fromJsonColumn, toJsonColumn } from "./sqlite-store.js";
import { actorIdVariants } from "./actor-key.js";
import { semanticFingerprint } from "../services/memory-record-utils.js";

// ============================================================
// 结构化依赖接口（最小外观，便于单测注入 fake）
// ============================================================

/** Mem0 侧外观：遗忘同步需要 delete；回填/调和需要可选 getAll */
export interface BridgeMem0Like {
  delete(memoryId: string): Promise<unknown>;
  getAll?(config?: { topK?: number; filters?: { user_id?: string } }): Promise<{
    results?: Array<{ id: string; memory?: string; metadata?: Record<string, unknown> }>;
  }>;
}

/** 认知图侧外观（HumanLikeMemoryService 结构兼容即可） */
export interface BridgeGraphLike {
  ingest(
    actorId: string,
    text: string,
    source: string,
    opts?: {
      context?: string;
      metadata?: Record<string, unknown>;
    },
  ): Promise<string | null>;
  getAllNodes(actorId: string): Array<{
    id: string;
    actorId: string;
    summary: string;
    deletionStage: string;
    metadata?: Record<string, unknown>;
  }>;
  attachNodeMetadata(actorId: string, nodeId: string, patch: Record<string, unknown>): boolean;
  buildRecall(
    actorId: string,
    query: string,
    opts?: { context?: string; crossDomain?: boolean; detailLevel?: string; limit?: number },
  ): Promise<{ recalledNodeIds: string[]; confidence: number; text: string }>;
  getNodeSummariesByIds(
    actorId: string,
    nodeIds: string[],
    max?: number,
  ): Array<{ id: string; summary: string }>;
}

/** Mem0 ingest 侧外观（复用决策/裁剪/infer 抽取 + 写入钩子） */
export interface BridgeIngestLike {
  writeDecidedDetailed(
    actorId: string,
    sourceId: string,
    body: string,
    context: "main" | "notes",
    highSignal: boolean,
    extraMetadata?: Record<string, unknown>,
  ): Promise<Mem0WrittenItem[]>;
  /** 统一抽取产物直存（infer:false + 钩子携带 facts/commitments/corrections）。可选：缺失时回退 writeDecidedDetailed。 */
  persistUnifiedExtraction?(
    actorId: string,
    sourceId: string,
    extraction: import("./unified-extractor.js").UnifiedExtraction,
    context: "main" | "notes",
    highSignal: boolean,
    fallbackText?: string,
    extraMetadata?: Record<string, unknown>,
  ): Promise<Mem0WrittenItem[]>;
}

/** Mem0 检索侧外观 */
export interface BridgeRetrievalLike {
  searchStructured(
    actorId: string,
    queryText: string,
    opts?: { context?: "main" | "notes" | "any" },
  ): Promise<AgenticMemoryCandidate[]>;
}

/** FTS 关键词路外观（AgenticMemoryFtsStore 结构兼容即可；P0 混合检索第三路） */
export interface BridgeFtsLike {
  search(
    actorId: string,
    query: string,
    opts?: { context?: "main" | "notes" | "any"; topK?: number },
  ): FtsMemoryCandidate[];
}

// ============================================================
// 融合召回类型
// ============================================================

export type BridgeRecallChannel = "mem0" | "graph" | "fts" | "both";

export interface FusedMemoryCandidate {
  content: string;
  /** RRF 融合分（多路 rank 的 Σ 1/(k+rank)，非概率语义，仅用于排序） */
  fusedScore: number;
  channels: BridgeRecallChannel[];
  mem0Score?: number;
  graphNodeId?: string;
  /** Mem0 侧原始创建时间（ISO），供仲裁器做 domain τ 时间衰减 */
  timestamp?: string;
  highSignal?: boolean;
}

export interface BridgeWriteResult {
  graphNodeId: string | null;
  mem0Items: Mem0WrittenItem[];
  /** 两侧是否至少有一侧未抛错（false = 双写都失败，调用方不应丢弃原始流水） */
  ok: boolean;
}

/** 遗忘同步单条执行明细 */
export interface BridgeForgettingReport {
  scannedLinks: number;
  deletedMem0: number;
  forgottenLinks: number;
  missingNodes: number;
}

/** RRF 常数：越大排名差异对融合分影响越平缓 */
const RRF_K = 60;

function nowIso(): string {
  return new Date().toISOString();
}

/** 单字 + 二元组混合 Jaccard（与 lifecycle 去重同族算法；回填配对用，零 LLM） */
function bigramJaccard(a: string, b: string): number {
  const grams = (s: string): Set<string> => {
    const t = s.replace(/\s+/g, "");
    const set = new Set<string>();
    for (const ch of t) set.add(ch);
    for (let i = 0; i < t.length - 1; i++) set.add(t.slice(i, i + 2));
    return set;
  };
  const setA = grams(a);
  const setB = grams(b);
  let intersect = 0;
  for (const g of setA) if (setB.has(g)) intersect++;
  const union = setA.size + setB.size - intersect;
  return union === 0 ? 0 : intersect / union;
}

// ============================================================
// 主服务
// ============================================================

export class MemoryBridgeService {
  private readonly db: SqliteDatabase;
  private syncTimer: ReturnType<typeof setInterval> | null = null;
  /** link 行 id → 连续删除失败次数（>=3 封顶 tombstone，防永久重扫） */
  private deleteFailures = new Map<number, number>();

  constructor(
    private readonly memory: BridgeMem0Like,
    private readonly graph: BridgeGraphLike,
    private readonly ingest: BridgeIngestLike,
    private readonly retrieval: BridgeRetrievalLike,
    db?: SqliteDatabase,
    private readonly fts?: BridgeFtsLike | null,
  ) {
    this.db = db ?? openAgenticSqlite();
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS bridge_links (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        actor_id TEXT NOT NULL,
        source_ref TEXT NOT NULL,
        graph_node_id TEXT NOT NULL,
        mem0_ids TEXT NOT NULL,
        created_at TEXT NOT NULL,
        forgotten_at TEXT,
        last_stage TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_bridge_links_actor_node
        ON bridge_links(actor_id, graph_node_id);
      CREATE INDEX IF NOT EXISTS idx_bridge_links_forgotten
        ON bridge_links(forgotten_at);
    `);
  }

  close(): void {
    this.stopForgettingSync();
    this.db.close();
  }

  // ------------------------------------------------------------
  // 1. 统一写入（认知图节点 + Mem0 记忆 + 双向 linkage）
  // ------------------------------------------------------------

  /**
   * 统一写入入口。写入顺序：先认知图（拿 nodeId），再 Mem0（metadata 带
   * graphNodeId，且复用 ingest 的决策/裁剪/infer 与写入钩子——方案 B/C/D
   * 的钩子在 ingest.writeDecidedDetailed 内部触发，桥接不重复挂），
   * 最后把 mem0Ids 回写图节点 metadata 并持久化 bridge_links。
   *
   * unified 传入时（统一写入者的抽取产物）：认知图照常落合并文本，
   * Mem0 侧走 persistUnifiedExtraction 直存（infer:false，钩子携带 facts/
   * commitments/corrections），不再让 Mem0 二次 LLM 抽取。
   *
   * 任一侧失败不回滚另一侧（记忆写入尽力而为），仅记录日志——两路本就是
   * 冗余存储，单侧成功仍有召回价值。
   */
  async writeUnified(
    actorId: string,
    sourceId: string,
    text: string,
    opts: {
      context: "main" | "notes";
      highSignal: boolean;
      sourceEventId?: string;
      sourceEventIds?: string[];
      eventTime?: string;
    },
    unified?: import("./unified-extractor.js").UnifiedExtraction,
  ): Promise<BridgeWriteResult> {
    const context = opts.context;
    // 来源事件：认知图 metadata 与 Mem0 metadata 都带，结论可回溯到具体一轮
    const provenance: Record<string, string> = {};
    if (opts.sourceEventId) provenance.sourceEventId = opts.sourceEventId;
    if (opts.sourceEventIds?.length) provenance.sourceEventIds = opts.sourceEventIds.join(",");
    if (opts.eventTime) provenance.eventTime = opts.eventTime;
    const baseMetadata = { highSignal: opts.highSignal, ...provenance };
    let graphNodeId: string | null = null;
    let graphFailed = false;
    try {
      graphNodeId = await this.graph.ingest(actorId, text, sourceId, {
        context,
        metadata: baseMetadata,
      });
    } catch (err) {
      graphFailed = true;
      console.error("[memory-bridge] 认知图写入失败（继续 Mem0 侧）:", err);
    }

    const extraMetadata = { ...(graphNodeId ? { graphNodeId } : {}), ...provenance };
    let mem0Items: Mem0WrittenItem[] = [];
    let mem0Failed = false;
    try {
      if (unified && typeof this.ingest.persistUnifiedExtraction === "function") {
        mem0Items = await this.ingest.persistUnifiedExtraction(
          actorId,
          sourceId,
          unified,
          context,
          opts.highSignal,
          text,
          Object.keys(extraMetadata).length > 0 ? extraMetadata : undefined,
        );
      } else {
        mem0Items = await this.ingest.writeDecidedDetailed(
          actorId,
          sourceId,
          text,
          context,
          opts.highSignal,
          Object.keys(extraMetadata).length > 0 ? extraMetadata : undefined,
        );
      }
    } catch (err) {
      mem0Failed = true;
      console.error("[memory-bridge] Mem0 写入失败（认知图侧已落）:", err);
    }

    const mem0Ids = mem0Items.map((item) => item.id).filter(Boolean);
    if (graphNodeId && mem0Ids.length > 0) {
      // 合并去重后回写节点 metadata（re-ingest 同一节点时 mem0Ids 只增不减）
      const existing = this.findNodeMem0Ids(actorId, graphNodeId);
      const merged = [...new Set([...existing, ...mem0Ids])];
      try {
        this.graph.attachNodeMetadata(actorId, graphNodeId, {
          mem0Ids: merged,
          bridgedAt: nowIso(),
        });
      } catch (err) {
        console.error("[memory-bridge] 节点 metadata 回写失败:", err);
      }
      this.insertLink(actorId, sourceId, graphNodeId, mem0Ids);
    }

    return { graphNodeId, mem0Items, ok: !(graphFailed && mem0Failed) };
  }

  private findNodeMem0Ids(actorId: string, nodeId: string): string[] {
    const node = this.graph.getAllNodes(actorId).find((n) => n.id === nodeId);
    const raw = node?.metadata?.mem0Ids;
    return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === "string") : [];
  }

  private insertLink(actorId: string, sourceRef: string, graphNodeId: string, mem0Ids: string[]): void {
    try {
      this.db
        .prepare(
          `INSERT INTO bridge_links (actor_id, source_ref, graph_node_id, mem0_ids, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(actorId, sourceRef, graphNodeId, toJsonColumn(mem0Ids) ?? "[]", nowIso());
    } catch (err) {
      console.error("[memory-bridge] bridge_links 写入失败:", err);
    }
  }

  // ------------------------------------------------------------
  // 2. 融合召回（Mem0 结构化 + 认知图 + FTS 关键词，RRF 合排）
  // ------------------------------------------------------------

  async searchFused(
    actorId: string,
    queryText: string,
    opts?: { context?: "main" | "notes" | "any"; topK?: number },
  ): Promise<FusedMemoryCandidate[]> {
    const query = queryText.trim().replace(/\s+/g, " ");
    if (!query) return [];

    const context = opts?.context ?? "main";
    // 认知图 recall 的 limit 放宽到检索上限，保证两路候选池规模可比
    const [mem0Candidates, graphRecall] = await Promise.all([
      this.retrieval.searchStructured(actorId, query, { context }).catch(() => [] as AgenticMemoryCandidate[]),
      this.graph
        .buildRecall(actorId, query, { context, crossDomain: true, detailLevel: "summary" })
        .catch(() => ({ recalledNodeIds: [] as string[], confidence: 0, text: "" })),
    ]);

    // FTS 关键词第三路（同步 SQLite，BM25 词面排序）：专名/技术栈等低语义
    // 密度 query 上补向量的短板。检索失败静默降级为空（rank 列表缺席无害）。
    let ftsCandidates: FtsMemoryCandidate[] = [];
    if (this.fts) {
      try {
        ftsCandidates = this.fts.search(actorId, query, { context, topK: getMemoryFtsTopK() });
      } catch {
        ftsCandidates = [];
      }
    }

    const nodeSummaries = new Map(
      this.graph
        .getNodeSummariesByIds(actorId, graphRecall.recalledNodeIds, graphRecall.recalledNodeIds.length || 1)
        .map((n) => [n.id, n.summary]),
    );

    // 跨通道合并：先语义指纹精确匹配，再做包含关系匹配——
    // Mem0 infer 抽取的断言通常是认知图原文的子串（"用户喜欢在周末爬山" vs
    // "用户喜欢在周末爬山，每周都去"），指纹不同但语义同源，需合并为双通道。
    interface MergeEntry {
      channels: BridgeRecallChannel[];
      mem0Score?: number;
      graphNodeId?: string;
      timestamp?: string;
      highSignal?: boolean;
      ranks: { channel: BridgeRecallChannel; rank: number }[];
      representative: string;
    }
    const merged = new Map<string, MergeEntry>();
    const fingerprintOf = (text: string): string => semanticFingerprint(text) || text.trim();
    const MIN_CONTAIN_LEN = 8;

    const findMergeKey = (content: string): string | null => {
      const own = fingerprintOf(content);
      if (merged.has(own)) return own;
      const c = content.trim();
      for (const [key, entry] of merged) {
        const existing = entry.representative.trim();
        const shorter = c.length <= existing.length ? c : existing;
        const longer = c.length <= existing.length ? existing : c;
        if (shorter.length >= MIN_CONTAIN_LEN && longer.includes(shorter)) return key;
      }
      return null;
    };

    const upsert = (
      content: string,
      channel: BridgeRecallChannel,
      rank: number,
      extra?: { mem0Score?: number; graphNodeId?: string; timestamp?: string; highSignal?: boolean },
    ): void => {
      const mergeKey = findMergeKey(content);
      // 键保持首次插入时的指纹（稳定），代表文本单独跟踪为更长一侧
      const key = mergeKey ?? fingerprintOf(content);
      const entry = merged.get(key) ?? { channels: [], ranks: [], representative: content };
      if (!entry.channels.includes(channel)) entry.channels.push(channel);
      entry.ranks.push({ channel, rank });
      if (extra?.mem0Score !== undefined) entry.mem0Score = extra.mem0Score;
      if (extra?.graphNodeId) entry.graphNodeId = extra.graphNodeId;
      if (extra?.timestamp) entry.timestamp = extra.timestamp;
      if (extra?.highSignal !== undefined) entry.highSignal = extra.highSignal;
      if (content.trim().length > entry.representative.trim().length) {
        entry.representative = content;
      }
      merged.set(key, entry);
    };

    mem0Candidates.forEach((cand, idx) => {
      upsert(cand.content, "mem0", idx + 1, {
        mem0Score: cand.score,
        ...(cand.timestamp ? { timestamp: cand.timestamp } : {}),
        highSignal: cand.highSignal,
      });
    });
    graphRecall.recalledNodeIds.forEach((nodeId, idx) => {
      const summary = nodeSummaries.get(nodeId);
      if (!summary) return;
      upsert(summary, "graph", idx + 1, { graphNodeId: nodeId });
    });
    ftsCandidates.forEach((cand, idx) => {
      if (!cand.content) return;
      upsert(cand.content, "fts", idx + 1, {
        ...(cand.createdAt ? { timestamp: cand.createdAt } : {}),
        // 仅 true 时传入：FTS 行缺该标记时不得覆盖 mem0/graph 侧已写入的 true
        ...(cand.highSignal === true ? { highSignal: true } : {}),
      });
    });

    const fused: FusedMemoryCandidate[] = [];
    for (const entry of merged.values()) {
      const rrf = entry.ranks.reduce((sum, r) => sum + 1 / (RRF_K + r.rank), 0);
      fused.push({
        content: entry.representative,
        fusedScore: Number(rrf.toFixed(6)),
        channels: entry.channels.length >= 2 ? ["both"] : entry.channels,
        ...(entry.mem0Score !== undefined ? { mem0Score: entry.mem0Score } : {}),
        ...(entry.graphNodeId ? { graphNodeId: entry.graphNodeId } : {}),
        ...(entry.timestamp ? { timestamp: entry.timestamp } : {}),
        ...(entry.highSignal !== undefined ? { highSignal: entry.highSignal } : {}),
      });
    }

    fused.sort((a, b) => b.fusedScore - a.fusedScore);
    return fused.slice(0, opts?.topK ?? getBridgeFusedTopK());
  }

  /** 融合召回的文本渲染（格式对齐 AgenticMemoryRetrievalService.buildRecall） */
  async buildFusedRecall(
    actorId: string,
    queryText: string,
    opts?: { context?: "main" | "notes" | "any" },
  ): Promise<string> {
    const items = await this.searchFused(actorId, queryText, opts);
    if (items.length === 0) return "";

    const channelLabel = (channels: BridgeRecallChannel[]): string => {
      if (channels.includes("both")) return "多通道";
      if (channels.includes("fts")) return "关键词";
      return channels.includes("mem0") ? "Mem0" : "认知图";
    };

    const parts = items.map((item, i) => {
      const scorePercent = Math.min(100, Math.round(item.fusedScore * 100 * 5)).toString();
      return `${i + 1}. 融合相关度 ${scorePercent}% · 来源[${channelLabel(item.channels)}]\n${item.content}`;
    });
    return `以下为桥接融合召回（Mem0 记忆图 × 认知图谱 × FTS 关键词，RRF 合排 + 跨通道去重）：\n${parts.join("\n\n")}`;
  }

  // ------------------------------------------------------------
  // 3. 遗忘同步（认知图 deletionStage → Mem0 阈值删除）
  // ------------------------------------------------------------

  /**
   * 单轮遗忘同步：
   *   - 扫描未 tombstone 的 bridge_links；
   *   - 节点缺失（图库清空/换库）→ 直接 tombstone，避免永久重扫；
   *   - 节点 stage ∈ {soft_deleted, hard_deleted} → 删除关联 Mem0 记忆，
   *     全部删除成功（或已不存在）后 tombstone；downranked/cold 不动 Mem0。
   */
  async syncForgetting(actorId?: string): Promise<BridgeForgettingReport> {
    const report: BridgeForgettingReport = {
      scannedLinks: 0,
      deletedMem0: 0,
      forgottenLinks: 0,
      missingNodes: 0,
    };

    const rows = (
      actorId
        ? this.db
            .prepare(
              `SELECT id, actor_id, graph_node_id, mem0_ids FROM bridge_links
               WHERE forgotten_at IS NULL AND actor_id = ?`,
            )
            .all(actorId)
        : this.db
            .prepare(`SELECT id, actor_id, graph_node_id, mem0_ids FROM bridge_links WHERE forgotten_at IS NULL`)
            .all()
    ) as Array<{ id: number; actor_id: string; graph_node_id: string; mem0_ids: string }>;

    const nodesByActor = new Map<string, Map<string, string>>();
    const stageOf = (actor: string, nodeId: string): string | null => {
      let nodeMap = nodesByActor.get(actor);
      if (!nodeMap) {
        try {
          nodeMap = new Map(this.graph.getAllNodes(actor).map((n) => [n.id, n.deletionStage]));
        } catch {
          nodeMap = new Map();
        }
        nodesByActor.set(actor, nodeMap);
      }
      return nodeMap.get(nodeId) ?? null;
    };

    for (const row of rows) {
      report.scannedLinks += 1;
      const stage = stageOf(row.actor_id, row.graph_node_id);
      if (stage === null) {
        this.markForgotten(row.id, "node_missing");
        report.missingNodes += 1;
        report.forgottenLinks += 1;
        continue;
      }
      if (stage !== "soft_deleted" && stage !== "hard_deleted") {
        this.updateStage(row.id, stage);
        continue;
      }

      const mem0Ids = fromJsonColumn<string[]>(row.mem0_ids, []);
      let deleted = 0;
      for (const mem0Id of mem0Ids) {
        try {
          await this.memory.delete(mem0Id);
          deleted += 1;
        } catch {
          // 单条删除失败不阻断：下一轮 sync 重试（forgotten_at 不落）
        }
      }
      report.deletedMem0 += deleted;
      if (deleted === mem0Ids.length) {
        this.markForgotten(row.id, stage);
        this.deleteFailures.delete(row.id);
        report.forgottenLinks += 1;
      } else {
        // 删除连续失败封顶（Mem0 侧记录已不存在/Qdrant 短暂不可用等）：
        // 3 轮失败后 tombstone，避免每轮 sync 永远重扫同一条
        const failures = (this.deleteFailures.get(row.id) ?? 0) + 1;
        if (failures >= 3) {
          this.markForgotten(row.id, "delete_failed");
          this.deleteFailures.delete(row.id);
          report.forgottenLinks += 1;
          console.warn(
            `[memory-bridge] link#${row.id} 连续 ${failures} 轮删除失败，tombstone（last_stage=delete_failed）`,
          );
        } else {
          this.deleteFailures.set(row.id, failures);
        }
      }
    }

    if (report.forgottenLinks > 0) {
      console.info(
        `[memory-bridge] 遗忘同步：扫描 ${report.scannedLinks} 条 linkage，` +
          `删除 Mem0 记忆 ${report.deletedMem0} 条，tombstone ${report.forgottenLinks} 条`,
      );
    }
    return report;
  }

  /** 诊断/测试辅助：列出 linkage（可只看未 tombstone 的活跃 linkage） */
  listLinks(opts?: { activeOnly?: boolean }): Array<{
    id: number;
    actorId: string;
    sourceRef: string;
    graphNodeId: string;
    mem0Ids: string[];
    createdAt: string;
    forgottenAt: string | null;
    lastStage: string | null;
  }> {
    const rows = (
      opts?.activeOnly
        ? this.db
            .prepare(`SELECT * FROM bridge_links WHERE forgotten_at IS NULL ORDER BY id ASC`)
            .all()
        : this.db.prepare(`SELECT * FROM bridge_links ORDER BY id ASC`).all()
    ) as Array<{
      id: number;
      actor_id: string;
      source_ref: string;
      graph_node_id: string;
      mem0_ids: string;
      created_at: string;
      forgotten_at: string | null;
      last_stage: string | null;
    }>;
    return rows.map((row) => ({
      id: row.id,
      actorId: row.actor_id,
      sourceRef: row.source_ref,
      graphNodeId: row.graph_node_id,
      mem0Ids: fromJsonColumn<string[]>(row.mem0_ids, []),
      createdAt: row.created_at,
      forgottenAt: row.forgotten_at,
      lastStage: row.last_stage,
    }));
  }

  /**
   * Mem0 侧删除调和（P0-3）：lifecycle 的 TTL 清理/去重会绕过 bridge 直接删
   * Mem0 记录——从活跃 linkage 的 mem0Ids 里摘除被删 id；摘空的 linkage 直接
   * tombstone（last_stage=mem0_pruned），避免遗忘同步永远扫僵尸链接。
   * 由 create-app-services 把 AgenticMemoryLifecycleService 的删除通知接到这里。
   */
  handleMem0Deleted(mem0Ids: string[]): void {
    if (mem0Ids.length === 0) return;
    const deleted = new Set(mem0Ids);
    let prunedLinks = 0;
    let trimmedLinks = 0;
    const rows = this.db
      .prepare(`SELECT id, mem0_ids FROM bridge_links WHERE forgotten_at IS NULL`)
      .all() as Array<{ id: number; mem0_ids: string }>;
    const update = this.db.prepare(`UPDATE bridge_links SET mem0_ids = ? WHERE id = ?`);
    for (const row of rows) {
      const ids = fromJsonColumn<string[]>(row.mem0_ids, []);
      if (!ids.some((id) => deleted.has(id))) continue;
      const remaining = ids.filter((id) => !deleted.has(id));
      if (remaining.length === 0) {
        this.markForgotten(row.id, "mem0_pruned");
        this.deleteFailures.delete(row.id);
        prunedLinks += 1;
      } else {
        update.run(toJsonColumn(remaining) ?? "[]", row.id);
        trimmedLinks += 1;
      }
    }
    if (prunedLinks + trimmedLinks > 0) {
      console.info(
        `[memory-bridge] lifecycle 删除调和：tombstone ${prunedLinks} 条，修剪 ${trimmedLinks} 条 linkage`,
      );
    }
  }

  /** actor 级清理（memory-clear-service 级联调用） */
  purgeActor(actorId: string): number {
    const res = this.db.prepare(`DELETE FROM bridge_links WHERE actor_id = ?`).run(actorId);
    return res.changes;
  }

  /**
   * 存量 linkage 回填（P2-15）：bridge 上线前的旧记忆没有 linkage，
   * 用文本相似度（单字+二元组 Jaccard，与 lifecycle 去重同族算法，零 LLM）把
   * 认知图节点与 Mem0 记忆配对，回填节点 metadata.mem0Ids + bridge_links。
   * 幂等：已有 mem0Ids 的节点跳过。启动时 fire-and-forget 调用一次。
   */
  async backfillLinks(actorId?: string, opts?: { similarityThreshold?: number }): Promise<{ nodesMatched: number; linksCreated: number }> {
    if (!this.memory.getAll) return { nodesMatched: 0, linksCreated: 0 };
    const threshold = opts?.similarityThreshold ?? 0.55;
    // mem0ai v3 getAll 强制 filters.user_id（裸 topK 必抛，回填自升级起静默失效）；
    // 按 actor 逐形式扫（存量数据两种 actor 形式并存），再统一配对。
    const candidateActors = actorId
      ? actorIdVariants(actorId)
      : [...new Set(this.listDistinctActorIds().flatMap((a) => actorIdVariants(a)))];
    const mem0Records: Array<{ id: string; memory?: string; metadata?: Record<string, unknown> }> = [];
    try {
      for (const variant of candidateActors) {
        const allResult = await this.memory.getAll({ topK: 10000, filters: { user_id: variant } });
        mem0Records.push(...((allResult.results ?? []) as typeof mem0Records));
      }
    } catch {
      return { nodesMatched: 0, linksCreated: 0 };
    }
    const usableRecords = mem0Records.filter((r) => r.id && r.memory);
    if (usableRecords.length === 0) return { nodesMatched: 0, linksCreated: 0 };

    const nodeLists = actorId
      ? [this.graph.getAllNodes(actorId)]
      : this.listDistinctActorIds().map((a) => {
        try {
          return this.graph.getAllNodes(a);
        } catch {
          return [];
        }
      });

    let nodesMatched = 0;
    let linksCreated = 0;
    for (const nodes of nodeLists) {
      for (const node of nodes) {
        if (node.deletionStage === "hard_deleted") continue;
        const existing = Array.isArray(node.metadata?.mem0Ids) ? node.metadata.mem0Ids : [];
        if (existing.length > 0) continue; // 已有 linkage，幂等跳过
        const matched: string[] = [];
        for (const rec of usableRecords) {
          const metaActor = typeof rec.metadata?.actorId === "string" ? rec.metadata.actorId : "";
          if (metaActor && metaActor !== node.actorId) continue;
          if (bigramJaccard(node.summary, rec.memory ?? "") >= threshold) matched.push(rec.id);
        }
        if (matched.length === 0) continue;
        try {
          this.graph.attachNodeMetadata(node.actorId, node.id, {
            mem0Ids: matched,
            bridgedAt: nowIso(),
            backfilled: true,
          });
          this.insertLink(node.actorId, `backfill:${node.id}`, node.id, matched);
          nodesMatched += 1;
          linksCreated += 1;
        } catch {
          /* 单节点回填失败不影响其余 */
        }
      }
    }
    if (nodesMatched > 0) {
      console.info(`[memory-bridge] 存量回填完成：${nodesMatched} 个节点建立 linkage`);
    }
    return { nodesMatched, linksCreated };
  }

  private listDistinctActorIds(): string[] {
    const rows = this.db
      .prepare(`SELECT DISTINCT actor_id FROM bridge_links`)
      .all() as Array<{ actor_id: string }>;
    return rows.map((r) => r.actor_id);
  }

  private markForgotten(rowId: number, stage: string): void {
    this.db
      .prepare(`UPDATE bridge_links SET forgotten_at = ?, last_stage = ? WHERE id = ?`)
      .run(nowIso(), stage, rowId);
  }

  private updateStage(rowId: number, stage: string): void {
    this.db.prepare(`UPDATE bridge_links SET last_stage = ? WHERE id = ?`).run(stage, rowId);
  }

  /** 启动遗忘同步定时器（间隔 AGENT_MEMORY_BRIDGE_FORGET_SYNC_INTERVAL_MIN，0=不启动） */
  startForgettingSync(): void {
    const intervalMin = getBridgeForgetSyncIntervalMin();
    if (intervalMin <= 0) return;
    this.syncTimer = setInterval(() => {
      void this.syncForgetting().catch((err) =>
        console.error("[memory-bridge] 遗忘同步失败:", err instanceof Error ? err.message : err),
      );
    }, intervalMin * 60_000);
    this.syncTimer.unref();
    console.info(`[memory-bridge] 遗忘同步已启动（间隔 ${intervalMin}min）`);
  }

  stopForgettingSync(): void {
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = null;
    }
  }
}

// ============================================================
// 装配辅助
// ============================================================

export function createMemoryBridgeIfEnabled(opts: {
  enabled?: boolean;
  memory: BridgeMem0Like | null;
  graph: BridgeGraphLike | null;
  ingest: BridgeIngestLike | null;
  retrieval: BridgeRetrievalLike | null;
  fts?: BridgeFtsLike | null;
  db?: SqliteDatabase;
  autoStart?: boolean;
}): MemoryBridgeService | null {
  const enabled = opts.enabled ?? isMemoryBridgeEnabled();
  if (!enabled || !opts.memory || !opts.graph || !opts.ingest || !opts.retrieval) return null;
  const bridge = new MemoryBridgeService(
    opts.memory,
    opts.graph,
    opts.ingest,
    opts.retrieval,
    opts.db,
    opts.fts,
  );
  if (opts.autoStart !== false) bridge.startForgettingSync();
  return bridge;
}
