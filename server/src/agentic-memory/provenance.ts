/**
 * 方案 D：溯源作废（Provenance）。
 *
 * 维护 sourceRef → 派生记忆 ID 的依赖图，回答「这条记忆是从哪来的」，
 * 并在来源被作废时级联清理所有派生物：
 *   - 语义账本（方案 B）：supersededBy = void 哨兵（append-only，不物理删）；
 *   - 认知图节点：metadata.overridden = { at, by, reason }（保留内容但标记失效）；
 *   - Mem0 记忆：直接删除（阈值删除策略，用户决策 2026-09-04——Mem0 OSS
 *     无 metadata 更新 API，不留 voided 僵尸数据污染检索）。
 *
 * 依赖图的登记时机：
 *   - ingest 写入钩子（Mem0 infer 结果 → mem0Ids + ledgerIds）；
 *   - memory-bridge 统一写入（→ graphNodeId）。
 *
 * 作废入口：
 *   - invalidateSource(sourceRef)：来源级（如一条聊天消息、一份文档被撤回）；
 *   - invalidateClaim(ledgerId)：断言级（某个具体 claim 被证伪），
 *     经账本记录的 mem0Id 反查 Mem0 条目，再经节点 metadata.mem0Ids
 *     反查认知图节点做级联。
 */

import type { Database as SqliteDatabase } from "better-sqlite3";

import { LEDGER_VOID_PREFIX, type AgenticLedger, type LedgerRecord } from "./ledger.js";
import { isProvenanceEnabled } from "./env.js";
import { openAgenticSqlite } from "./sqlite-store.js";

export type DerivedKind = "ledger" | "mem0" | "graph";

export interface ProvenanceMem0Like {
  delete(memoryId: string): Promise<unknown>;
}

export interface ProvenanceGraphLike {
  getAllNodes(actorId: string): Array<{
    id: string;
    deletionStage?: string;
    metadata?: Record<string, unknown>;
  }>;
  attachNodeMetadata(actorId: string, nodeId: string, patch: Record<string, unknown>): boolean;
}

/** 账本侧最小外观（AgenticLedger 结构兼容） */
export interface ProvenanceLedgerLike {
  supersedeBySource(sourceRef: string, voidToken: string, reason?: string): number;
  supersede(id: string, supersededBy: string, reason?: string): boolean;
  getById(id: string): LedgerRecord | null;
}

/** 证据作废回调入参（承诺板等下游消费者据此级联自己的 superseded） */
export interface EvidenceVoidedInfo {
  /** 被作废的账本断言 id */
  ledgerIds: string[];
  voidToken: string;
  reason: string;
}

export interface DerivationRegistrations {
  ledgerIds?: string[];
  mem0Ids?: string[];
  graphNodeIds?: string[];
}

export interface ProvenanceEdge {
  id: number;
  sourceRef: string;
  actorId: string;
  derivedKind: DerivedKind;
  derivedId: string;
  createdAt: string;
  invalidatedAt: string | null;
  invalidatedBy: string | null;
}

export interface InvalidationReport {
  sourceRef: string;
  reason: string;
  edgesInvalidated: number;
  ledgerSuperseded: number;
  mem0Deleted: number;
  mem0DeleteErrors: string[];
  graphOverridden: number;
}

interface ProvRow {
  id: number;
  source_ref: string;
  actor_id: string;
  derived_kind: string;
  derived_id: string;
  created_at: string;
  invalidated_at: string | null;
  invalidated_by: string | null;
}

function toEdge(row: ProvRow): ProvenanceEdge {
  return {
    id: row.id,
    sourceRef: row.source_ref,
    actorId: row.actor_id,
    derivedKind: row.derived_kind as DerivedKind,
    derivedId: row.derived_id,
    createdAt: row.created_at,
    invalidatedAt: row.invalidated_at,
    invalidatedBy: row.invalidated_by,
  };
}

function nowIso(): string {
  return new Date().toISOString();
}

export class ProvenanceService {
  private readonly db: SqliteDatabase;
  private evidenceVoidedHook: ((info: EvidenceVoidedInfo) => void) | null = null;

  constructor(
    private readonly memory: ProvenanceMem0Like | null,
    private readonly graph: ProvenanceGraphLike | null,
    private readonly ledger: ProvenanceLedgerLike | null,
    db?: SqliteDatabase,
    private readonly fts?: { remove(memoryIds: string[]): void } | null,
  ) {
    this.db = db ?? openAgenticSqlite();
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS provenance_edges (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_ref TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        derived_kind TEXT NOT NULL,
        derived_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        invalidated_at TEXT,
        invalidated_by TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_prov_source ON provenance_edges(source_ref, invalidated_at);
      CREATE INDEX IF NOT EXISTS idx_prov_derived ON provenance_edges(derived_kind, derived_id);
    `);
  }

  close(): void {
    this.db.close();
  }

  /**
   * 注入证据作废回调（create-app-services 接线到承诺板 supersedeByEvidence）：
   * 来源撤回/用户否认（"我改主意了，不报价了"）时，账本断言作废的同时
   * 通知下游把关联承诺级联标为 superseded——治"幽灵幻觉"。
   */
  setEvidenceVoidedHook(hook: ((info: EvidenceVoidedInfo) => void) | null): void {
    this.evidenceVoidedHook = hook;
  }

  private fireEvidenceVoided(ledgerIds: string[], voidToken: string, reason: string): void {
    if (!this.evidenceVoidedHook || ledgerIds.length === 0) return;
    try {
      this.evidenceVoidedHook({ ledgerIds, voidToken, reason });
    } catch (err) {
      console.error("[provenance] evidenceVoided 钩子失败（忽略）:", err);
    }
  }

  /** 登记派生关系（写入钩子 / bridge 统一写入时调用；重复登记自动去重） */
  recordDerivations(sourceRef: string, actorId: string, regs: DerivationRegistrations): number {
    let inserted = 0;
    const insert = this.db.prepare(
      `INSERT INTO provenance_edges
         (source_ref, actor_id, derived_kind, derived_id, created_at)
       SELECT ?, ?, ?, ?, ?
       WHERE NOT EXISTS (
         SELECT 1 FROM provenance_edges
         WHERE source_ref = ? AND derived_kind = ? AND derived_id = ? AND invalidated_at IS NULL
       )`,
    );
    const run = (kind: DerivedKind, id: string): void => {
      const res = insert.run(sourceRef, actorId, kind, id, nowIso(), sourceRef, kind, id);
      inserted += res.changes;
    };
    for (const id of regs.ledgerIds ?? []) run("ledger", id);
    for (const id of regs.mem0Ids ?? []) run("mem0", id);
    for (const id of regs.graphNodeIds ?? []) run("graph", id);
    return inserted;
  }

  /** 查询某来源的全部（或仅活跃）派生物 */
  getDerivations(sourceRef: string, opts?: { includeInvalidated?: boolean }): ProvenanceEdge[] {
    const sql = opts?.includeInvalidated
      ? `SELECT * FROM provenance_edges WHERE source_ref = ? ORDER BY created_at ASC, id ASC`
      : `SELECT * FROM provenance_edges WHERE source_ref = ? AND invalidated_at IS NULL
         ORDER BY created_at ASC, id ASC`;
    return (this.db.prepare(sql).all(sourceRef) as ProvRow[]).map(toEdge);
  }

  /** 反查：某派生 ID 来自哪些来源（调试/审计） */
  findSourcesOf(derivedKind: DerivedKind, derivedId: string): ProvenanceEdge[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM provenance_edges
           WHERE derived_kind = ? AND derived_id = ? AND invalidated_at IS NULL`,
        )
        .all(derivedKind, derivedId) as ProvRow[]
    ).map(toEdge);
  }

  /**
   * 来源级作废：级联处理该 sourceRef 的全部活跃派生物。
   * 各存储侧失败不互相阻断（尽力而为级联），错误收集进 report。
   */
  async invalidateSource(sourceRef: string, reason: string): Promise<InvalidationReport> {
    const report: InvalidationReport = {
      sourceRef,
      reason,
      edgesInvalidated: 0,
      ledgerSuperseded: 0,
      mem0Deleted: 0,
      mem0DeleteErrors: [],
      graphOverridden: 0,
    };
    const voidToken = `${LEDGER_VOID_PREFIX}source:${sourceRef}`;
    const edges = this.getDerivations(sourceRef);
    if (edges.length === 0) return report;

    const actorIds = [...new Set(edges.map((e) => e.actorId))];

    if (this.ledger) {
      try {
        report.ledgerSuperseded = this.ledger.supersedeBySource(sourceRef, voidToken, reason);
      } catch (err) {
        report.mem0DeleteErrors.push(`ledger: ${String(err)}`);
      }
    }
    this.fireEvidenceVoided(
      edges.filter((e) => e.derivedKind === "ledger").map((e) => e.derivedId),
      voidToken,
      reason,
    );

    for (const edge of edges) {
      if (edge.derivedKind === "mem0" && this.memory) {
        try {
          await this.memory.delete(edge.derivedId);
          this.fts?.remove([edge.derivedId]);
          report.mem0Deleted += 1;
        } catch (err) {
          report.mem0DeleteErrors.push(`mem0:${edge.derivedId}: ${String(err)}`);
        }
      }
      if (edge.derivedKind === "graph" && this.graph) {
        try {
          const ok = this.graph.attachNodeMetadata(edge.actorId, edge.derivedId, {
            overridden: { at: nowIso(), by: `source:${sourceRef}`, reason },
          });
          if (ok) report.graphOverridden += 1;
        } catch (err) {
          report.mem0DeleteErrors.push(`graph:${edge.derivedId}: ${String(err)}`);
        }
      }
    }

    // 补一刀：同 actor 下，metadata.mem0Ids 里挂着被删 Mem0 id 的节点也标记 overridden
    // （bridge 只在统一写入时登记 graph 边，旧数据/非桥接写入的节点走元数据反查）
    if (this.graph && this.memory) {
      const deletedMem0Ids = new Set(
        edges.filter((e) => e.derivedKind === "mem0").map((e) => e.derivedId),
      );
      if (deletedMem0Ids.size > 0) {
        for (const actorId of actorIds) {
          for (const node of this.safeGetAllNodes(actorId)) {
            const linked = Array.isArray(node.metadata?.mem0Ids) ? node.metadata.mem0Ids : [];
            const hit = linked.some((id) => typeof id === "string" && deletedMem0Ids.has(id));
            if (!hit) continue;
            const ok = this.graph.attachNodeMetadata(actorId, node.id, {
              overridden: { at: nowIso(), by: `source:${sourceRef}`, reason },
            });
            if (ok) report.graphOverridden += 1;
          }
        }
      }
    }

    const mark = this.db.prepare(
      `UPDATE provenance_edges SET invalidated_at = ?, invalidated_by = ?
       WHERE source_ref = ? AND invalidated_at IS NULL`,
    );
    report.edgesInvalidated = mark.run(nowIso(), voidToken, sourceRef).changes;
    return report;
  }

  /**
   * 断言级作废：某条账本 claim 被证伪 → 级联其关联 Mem0 条目与认知图节点。
   * 链路：ledger.mem0Id → Mem0 删除；节点 metadata.mem0Ids 反查 → overridden。
   */
  async invalidateClaim(ledgerId: string, reason: string): Promise<InvalidationReport> {
    const report: InvalidationReport = {
      sourceRef: `claim:${ledgerId}`,
      reason,
      edgesInvalidated: 0,
      ledgerSuperseded: 0,
      mem0Deleted: 0,
      mem0DeleteErrors: [],
      graphOverridden: 0,
    };

    const record = this.ledger?.getById(ledgerId) ?? null;
    if (!record) {
      report.mem0DeleteErrors.push(`ledger:${ledgerId}: 断言不存在`);
      return report;
    }

    const voidToken = `${LEDGER_VOID_PREFIX}claim:${ledgerId}`;
    if (this.ledger) {
      try {
        if (this.ledger.supersede(ledgerId, voidToken, reason)) report.ledgerSuperseded += 1;
      } catch (err) {
        report.mem0DeleteErrors.push(`ledger: ${String(err)}`);
      }
    }
    this.fireEvidenceVoided([ledgerId], voidToken, reason);

    if (record.mem0Id && this.memory) {
      try {
        await this.memory.delete(record.mem0Id);
        this.fts?.remove([record.mem0Id]);
        report.mem0Deleted += 1;
        // 节点反查：同 actor 下 metadata.mem0Ids 含该 id 的节点标记 overridden
        if (this.graph) {
          for (const node of this.safeGetAllNodes(record.actorId)) {
            const linked = Array.isArray(node.metadata?.mem0Ids) ? node.metadata.mem0Ids : [];
            if (!linked.includes(record.mem0Id)) continue;
            const ok = this.graph.attachNodeMetadata(record.actorId, node.id, {
              overridden: { at: nowIso(), by: `claim:${ledgerId}`, reason },
            });
            if (ok) report.graphOverridden += 1;
          }
        }
      } catch (err) {
        report.mem0DeleteErrors.push(`mem0:${record.mem0Id}: ${String(err)}`);
      }
    }

    const mark = this.db.prepare(
      `UPDATE provenance_edges SET invalidated_at = ?, invalidated_by = ?
       WHERE derived_kind = 'ledger' AND derived_id = ? AND invalidated_at IS NULL`,
    );
    report.edgesInvalidated = mark.run(nowIso(), voidToken, ledgerId).changes;
    return report;
  }

  private safeGetAllNodes(actorId: string): Array<{ id: string; metadata?: Record<string, unknown> }> {
    try {
      return this.graph?.getAllNodes(actorId) ?? [];
    } catch {
      return [];
    }
  }

  stats(): { total: number; active: number; invalidated: number } {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN invalidated_at IS NULL THEN 1 ELSE 0 END) AS active
         FROM provenance_edges`,
      )
      .get() as { total: number; active: number | null };
    const total = row.total;
    const active = row.active ?? 0;
    return { total, active, invalidated: total - active };
  }

  /** actor 级清理（memory-clear-service 级联调用） */
  purgeActor(actorId: string): number {
    const res = this.db.prepare(`DELETE FROM provenance_edges WHERE actor_id = ?`).run(actorId);
    return res.changes;
  }
}

export function createProvenanceIfEnabled(opts: {
  memory?: ProvenanceMem0Like | null;
  graph?: ProvenanceGraphLike | null;
  ledger?: AgenticLedger | ProvenanceLedgerLike | null;
  db?: SqliteDatabase;
  fts?: { remove(memoryIds: string[]): void } | null;
}): ProvenanceService | null {
  if (!isProvenanceEnabled()) return null;
  return new ProvenanceService(
    opts.memory ?? null,
    opts.graph ?? null,
    (opts.ledger as ProvenanceLedgerLike | null) ?? null,
    opts.db,
    opts.fts ?? null,
  );
}
