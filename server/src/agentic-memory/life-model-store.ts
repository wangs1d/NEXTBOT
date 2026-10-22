/**
 * 用户生活模型（Life Model）存储 —— 记忆四层金字塔的第 ④ 层一等实体。
 *
 * 定位（为什么需要它）：
 *   通用助手记忆需求是「取回」（问什么捞回一句即可）；私人管家/助理的目标是
 *   「越来越懂这个人」——要回答「我妹妹叫什么」「上次和谁去的京都」「我和老王
 *   最近怎么样」。这些答案不是「某段文本藏在哪」，而是「一个实体 / 一条关系边」。
 *   向量检索 + 一句话记忆的结构天然回答不了。本模块补上「建模」这一层。
 *
 * 收敛而非叠加（呼应读侧单一出口纪律）：
 *   - 实体属性不另存值——指向 structured_facts（entity 字段物化），superseded 链、
 *     双时间轴（event_time/observed_at）、valid_from/valid_to 全部白拿；
 *   - relationship-graph 的 warmth/rapport 里程碑收敛为一条 kind='self_agent' 的边；
 *   - MemoryExperienceLearningLoop 的内存 beliefs/episodes → life_beliefs / life_episodes。
 *
 * 隐私：与其余 agentic-memory 表共用同一个 SQLite 文件（openAgenticSqlite），
 * memory-clear-service 的 purgeActor 级联天然覆盖；本 store 亦导出 purgeActor。
 */

import type { Database as SqliteDatabase } from "better-sqlite3";

import { isEphemeralActorId } from "../agent/actor-id.js";
import type { SchemaNode } from "../brain/types.js";
import type {
  BeliefRecord,
  LearningEpisode,
} from "../brain/memory-cognitive/memory-experience-learning-loop.js";
import { fromJsonColumn, openAgenticSqlite, toJsonColumn } from "./sqlite-store.js";

/** 实体类别：self=用户本人 / person=人物 / org=组织 / place=地点 / pet=宠物 */
export type LifeEntityKind = "self" | "person" | "org" | "place" | "pet";

/** 社会关系大类；self_agent = 用户 ↔ 管家（Agent）这条特殊边 */
export type RelationKind =
  | "family"
  | "partner"
  | "friend"
  | "colleague"
  | "acquaintance"
  | "pet_owner"
  | "self_agent";

export type EdgeStatus = "active" | "ended" | "unknown";
export type SensitivityLevel = "normal" | "sensitive";

/** 关系变化轨迹的一个关键点（亲疏/情感随时间的变化证据） */
export interface EdgeChangePoint {
  at: string;
  intimacy: number;
  sentiment: number;
  triggerRef?: string;
  note?: string;
}

export interface LifeEntity {
  id: string;
  actorId: string;
  kind: LifeEntityKind;
  canonicalName: string;
  aliases: string[];
  firstSeenAt: string;
  lastSeenAt: string;
  confidence: number;
  sourceRefs: string[];
  sensitivity: SensitivityLevel;
}

export interface SocialEdge {
  id: string;
  actorId: string;
  fromEntityId: string;
  toEntityId: string;
  kind: RelationKind;
  subKind: string | null;
  intimacy: number;
  sentiment: number;
  validFrom: string | null;
  validTo: string | null;
  status: EdgeStatus;
  confidence: number;
  sourceRefs: string[];
  sensitivity: SensitivityLevel;
  createdAt: string;
  updatedAt: string;
}

interface EntityRow {
  id: string;
  actor_id: string;
  kind: string;
  canonical_name: string;
  aliases_json: string | null;
  first_seen_at: string;
  last_seen_at: string;
  confidence: number | null;
  source_refs_json: string | null;
  sensitivity: string | null;
}

interface EdgeRow {
  id: string;
  actor_id: string;
  from_entity_id: string;
  to_entity_id: string;
  kind: string;
  sub_kind: string | null;
  intimacy: number | null;
  sentiment: number | null;
  valid_from: string | null;
  valid_to: string | null;
  status: string;
  confidence: number | null;
  source_refs_json: string | null;
  sensitivity: string | null;
  created_at: string;
  updated_at: string;
}

const KIND_LABEL: Record<LifeEntityKind, string> = {
  self: "本人",
  person: "人物",
  org: "组织",
  place: "地点",
  pet: "宠物",
};

const RELATION_LABEL: Record<RelationKind, string> = {
  family: "家人",
  partner: "伴侣",
  friend: "朋友",
  colleague: "同事",
  acquaintance: "熟人",
  pet_owner: "宠物",
  self_agent: "管家",
};

const VALID_ENTITY_KINDS: readonly LifeEntityKind[] = ["self", "person", "org", "place", "pet"];
const VALID_RELATION_KINDS: readonly RelationKind[] = [
  "family",
  "partner",
  "friend",
  "colleague",
  "acquaintance",
  "pet_owner",
  "self_agent",
];

function clamp01(n: number | null | undefined, fallback = 0.5): number {
  if (typeof n !== "number" || !Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(1, n));
}

function clampSentiment(n: number | null | undefined): number {
  if (typeof n !== "number" || !Number.isFinite(n)) return 0;
  return Math.max(-1, Math.min(1, n));
}

function simpleHash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

function normalizeName(name: string): string {
  return name.trim().replace(/\s+/g, "").slice(0, 24);
}

function toStringArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((x): x is string => typeof x === "string" && x.trim().length > 0);
}

function intimacyLabel(v: number): string {
  if (v >= 0.7) return "近";
  if (v >= 0.4) return "中";
  return "疏";
}

export interface UpsertEntityInput {
  actorId: string;
  kind: LifeEntityKind;
  canonicalName: string;
  aliases?: string[];
  confidence?: number;
  sourceRef?: string;
  sensitivity?: SensitivityLevel;
  seenAt?: string;
}

export interface UpsertEdgeInput {
  actorId: string;
  fromEntityId: string;
  toEntityId: string;
  kind: RelationKind;
  subKind?: string | null;
  intimacy?: number;
  sentiment?: number;
  validFrom?: string | null;
  validTo?: string | null;
  status?: EdgeStatus;
  confidence?: number;
  sourceRef?: string;
  sensitivity?: SensitivityLevel;
  changePoint?: EdgeChangePoint;
}

export class LifeModelStore {
  private readonly db: SqliteDatabase;

  constructor(db?: SqliteDatabase) {
    this.db = db ?? openAgenticSqlite();
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS life_entities (
        id TEXT PRIMARY KEY,
        actor_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        canonical_name TEXT NOT NULL,
        aliases_json TEXT,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        confidence REAL,
        source_refs_json TEXT,
        sensitivity TEXT NOT NULL DEFAULT 'normal'
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_life_entities_actor_name
        ON life_entities(actor_id, canonical_name);
      CREATE INDEX IF NOT EXISTS idx_life_entities_actor_kind
        ON life_entities(actor_id, kind);

      CREATE TABLE IF NOT EXISTS life_edges (
        id TEXT PRIMARY KEY,
        actor_id TEXT NOT NULL,
        from_entity_id TEXT NOT NULL,
        to_entity_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        sub_kind TEXT,
        intimacy REAL NOT NULL DEFAULT 0.5,
        sentiment REAL NOT NULL DEFAULT 0,
        valid_from TEXT,
        valid_to TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        confidence REAL,
        source_refs_json TEXT,
        sensitivity TEXT NOT NULL DEFAULT 'normal',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_life_edges_pair
        ON life_edges(actor_id, from_entity_id, to_entity_id, kind, sub_kind);
      CREATE INDEX IF NOT EXISTS idx_life_edges_actor_from
        ON life_edges(actor_id, from_entity_id);

      CREATE TABLE IF NOT EXISTS life_edge_history (
        id TEXT PRIMARY KEY,
        edge_id TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        at TEXT NOT NULL,
        intimacy REAL,
        sentiment REAL,
        trigger_ref TEXT,
        note TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_life_edge_history_edge
        ON life_edge_history(edge_id, at);

      CREATE TABLE IF NOT EXISTS life_patterns (
        id TEXT PRIMARY KEY,
        actor_id TEXT NOT NULL,
        scene_tag TEXT NOT NULL,
        steps_json TEXT,
        preconditions_json TEXT,
        expected_outcomes_json TEXT,
        instances_json TEXT,
        warning_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_life_patterns_actor_scene
        ON life_patterns(actor_id, scene_tag);

      CREATE TABLE IF NOT EXISTS life_beliefs (
        id TEXT PRIMARY KEY,
        actor_id TEXT NOT NULL,
        claim TEXT NOT NULL,
        status TEXT NOT NULL,
        confidence REAL NOT NULL,
        support_json TEXT,
        contradict_json TEXT,
        use_count INTEGER NOT NULL DEFAULT 0,
        success_count INTEGER NOT NULL DEFAULT 0,
        failure_count INTEGER NOT NULL DEFAULT 0,
        last_used_at TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_life_beliefs_actor ON life_beliefs(actor_id);

      CREATE TABLE IF NOT EXISTS life_episodes (
        id TEXT PRIMARY KEY,
        actor_id TEXT NOT NULL,
        source_memory_id TEXT,
        source_kind TEXT,
        status TEXT NOT NULL,
        observation TEXT NOT NULL,
        interpretation TEXT,
        lesson TEXT,
        tags_json TEXT,
        evidence_json TEXT,
        confidence REAL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_life_episodes_actor ON life_episodes(actor_id, updated_at);
    `);
  }

  close(): void {
    this.db.close();
  }

  /* ────────────────────────────── 实体 ────────────────────────────── */

  /**
   * 实体 upsert（幂等）：同 (actor, canonical_name) 已存在则合并别名/刷新 lastSeen，
   * 否则新建。id = ent:<actorId>:<hash>，命名空间隔离。
   */
  upsertEntity(input: UpsertEntityInput): LifeEntity | null {
    const actorId = input.actorId?.trim();
    if (!actorId || isEphemeralActorId(actorId)) return null;
    const canonicalName = normalizeName(input.canonicalName ?? "");
    if (!canonicalName) return null;
    const kind: LifeEntityKind = VALID_ENTITY_KINDS.includes(input.kind) ? input.kind : "person";
    const now = input.seenAt ?? new Date().toISOString();
    const aliases = (input.aliases ?? []).map(normalizeName).filter(Boolean);

    const existing = this.db
      .prepare(`SELECT * FROM life_entities WHERE actor_id = ? AND canonical_name = ?`)
      .get(actorId, canonicalName) as EntityRow | undefined;
    if (existing) {
      const mergedAliases = [
        ...new Set([...toStringArray(fromJsonColumn<unknown>(existing.aliases_json, [])), ...aliases]),
      ].slice(0, 12);
      const refs = input.sourceRef
        ? [...new Set([...toStringArray(fromJsonColumn<unknown>(existing.source_refs_json, [])), input.sourceRef])].slice(0, 20)
        : toStringArray(fromJsonColumn<unknown>(existing.source_refs_json, []));
      this.db
        .prepare(
          `UPDATE life_entities
           SET aliases_json = ?, last_seen_at = ?, confidence = ?, source_refs_json = ?
           WHERE id = ?`,
        )
        .run(
          toJsonColumn(mergedAliases),
          now,
          input.confidence != null ? Math.max(existing.confidence ?? 0, clamp01(input.confidence)) : existing.confidence,
          toJsonColumn(refs),
          existing.id,
        );
      return this.getEntity(actorId, existing.id);
    }

    const id = `ent:${actorId}:${simpleHash(`${kind}:${canonicalName}`)}`;
    this.db
      .prepare(
        `INSERT INTO life_entities
           (id, actor_id, kind, canonical_name, aliases_json, first_seen_at, last_seen_at,
            confidence, source_refs_json, sensitivity)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        actorId,
        kind,
        canonicalName,
        toJsonColumn(aliases),
        now,
        now,
        clamp01(input.confidence, 0.6),
        toJsonColumn(input.sourceRef ? [input.sourceRef] : []),
        input.sensitivity ?? "normal",
      );
    return this.getEntity(actorId, id);
  }

  /** 确保「用户本人」self 实体存在，返回其 id。 */
  ensureSelfEntity(actorId: string): string | null {
    const self = this.upsertEntity({
      actorId,
      kind: "self",
      canonicalName: "我",
      confidence: 1,
      sensitivity: "normal",
    });
    return self?.id ?? null;
  }

  /** 确保「管家」agent 实体存在（self_agent 边的对端），返回其 id。 */
  ensureAgentEntity(actorId: string, agentName = "管家"): string | null {
    const agent = this.upsertEntity({
      actorId,
      kind: "org",
      canonicalName: agentName,
      confidence: 1,
    });
    return agent?.id ?? null;
  }

  getEntity(actorId: string, id: string): LifeEntity | null {
    const row = this.db
      .prepare(`SELECT * FROM life_entities WHERE actor_id = ? AND id = ?`)
      .get(actorId, id) as EntityRow | undefined;
    return row ? toEntity(row) : null;
  }

  /** 按名（规范名或别名）精确查找实体；无则 null。 */
  findEntityByName(actorId: string, name: string): LifeEntity | null {
    const n = normalizeName(name);
    if (!n) return null;
    for (const e of this.listEntities(actorId)) {
      if (e.canonicalName === n || e.aliases.includes(n)) return e;
    }
    return null;
  }

  listEntities(actorId: string, opts?: { kind?: LifeEntityKind }): LifeEntity[] {
    if (!actorId) return [];
    const rows = (
      opts?.kind
        ? this.db
            .prepare(`SELECT * FROM life_entities WHERE actor_id = ? AND kind = ? ORDER BY last_seen_at DESC`)
            .all(actorId, opts.kind)
        : this.db
            .prepare(`SELECT * FROM life_entities WHERE actor_id = ? ORDER BY last_seen_at DESC`)
            .all(actorId)
    ) as EntityRow[];
    return rows.map(toEntity);
  }

  /** 用户消息里命中的实体（用于召回通道与「本轮问到谁」寻址）。 */
  matchEntitiesInText(actorId: string, text: string): LifeEntity[] {
    const t = text?.trim();
    if (!t) return [];
    return this.listEntities(actorId).filter((e) => {
      if (e.kind === "self") return false;
      if (e.canonicalName.length >= 2 && t.includes(e.canonicalName)) return true;
      return e.aliases.some((a) => a.length >= 2 && t.includes(a));
    });
  }

  /** 删除实体及其关联边/轨迹（"忘掉我妹妹"→ 实体 + 边 + 轨迹三清）。 */
  deleteEntity(actorId: string, id: string): { entities: number; edges: number } {
    if (!actorId || !id) return { entities: 0, edges: 0 };
    const run = this.db.transaction(() => {
      const edges = this.db
        .prepare(`DELETE FROM life_edges WHERE actor_id = ? AND (from_entity_id = ? OR to_entity_id = ?)`)
        .run(actorId, id, id).changes;
      const entities = this.db
        .prepare(`DELETE FROM life_entities WHERE actor_id = ? AND id = ?`)
        .run(actorId, id).changes;
      return { entities, edges };
    });
    return run();
  }

  /* ────────────────────────────── 关系边 ────────────────────────────── */

  upsertEdge(input: UpsertEdgeInput): SocialEdge | null {
    const actorId = input.actorId?.trim();
    if (!actorId || isEphemeralActorId(actorId)) return null;
    const kind: RelationKind = VALID_RELATION_KINDS.includes(input.kind) ? input.kind : "acquaintance";
    const subKind = input.subKind?.trim() || null;
    const now = new Date().toISOString();
    const existing = this.db
      .prepare(
        `SELECT * FROM life_edges
         WHERE actor_id = ? AND from_entity_id = ? AND to_entity_id = ? AND kind = ?
           AND (sub_kind IS ? OR sub_kind = ?)`,
      )
      .get(actorId, input.fromEntityId, input.toEntityId, kind, subKind, subKind) as
      | EdgeRow
      | undefined;

    if (existing) {
      const intimacy = input.intimacy != null ? clamp01(input.intimacy, existing.intimacy ?? 0.5) : existing.intimacy ?? 0.5;
      const sentiment = input.sentiment != null ? clampSentiment(input.sentiment) : existing.sentiment ?? 0;
      const refs = input.sourceRef
        ? [...new Set([...toStringArray(fromJsonColumn<unknown>(existing.source_refs_json, [])), input.sourceRef])].slice(0, 20)
        : toStringArray(fromJsonColumn<unknown>(existing.source_refs_json, []));
      this.db
        .prepare(
          `UPDATE life_edges
           SET intimacy = ?, sentiment = ?, valid_from = COALESCE(?, valid_from),
               valid_to = COALESCE(?, valid_to), status = ?, confidence = COALESCE(?, confidence),
               source_refs_json = ?, sensitivity = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          intimacy,
          sentiment,
          input.validFrom ?? null,
          input.validTo ?? null,
          input.status ?? existing.status,
          input.confidence != null ? clamp01(input.confidence) : null,
          toJsonColumn(refs),
          input.sensitivity ?? existing.sensitivity ?? "normal",
          now,
          existing.id,
        );
      if (input.changePoint) this.appendChangePoint(actorId, existing.id, input.changePoint);
      return this.getEdge(actorId, existing.id);
    }

    const id = `edge:${actorId}:${simpleHash(`${input.fromEntityId}>${input.toEntityId}:${kind}:${subKind ?? ""}`)}`;
    this.db
      .prepare(
        `INSERT INTO life_edges
           (id, actor_id, from_entity_id, to_entity_id, kind, sub_kind, intimacy, sentiment,
            valid_from, valid_to, status, confidence, source_refs_json, sensitivity, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        actorId,
        input.fromEntityId,
        input.toEntityId,
        kind,
        subKind,
        clamp01(input.intimacy, 0.5),
        clampSentiment(input.sentiment),
        input.validFrom ?? null,
        input.validTo ?? null,
        input.status ?? "active",
        input.confidence != null ? clamp01(input.confidence) : 0.6,
        toJsonColumn(input.sourceRef ? [input.sourceRef] : []),
        input.sensitivity ?? "normal",
        now,
        now,
      );
    if (input.changePoint) this.appendChangePoint(actorId, id, input.changePoint);
    return this.getEdge(actorId, id);
  }

  getEdge(actorId: string, id: string): SocialEdge | null {
    const row = this.db
      .prepare(`SELECT * FROM life_edges WHERE actor_id = ? AND id = ?`)
      .get(actorId, id) as EdgeRow | undefined;
    return row ? toEdge(row) : null;
  }

  getEdges(actorId: string, opts?: { kind?: RelationKind; status?: EdgeStatus }): SocialEdge[] {
    if (!actorId) return [];
    const clauses = ["actor_id = ?"];
    const args: string[] = [actorId];
    if (opts?.kind) {
      clauses.push("kind = ?");
      args.push(opts.kind);
    }
    if (opts?.status) {
      clauses.push("status = ?");
      args.push(opts.status);
    }
    const rows = this.db
      .prepare(`SELECT * FROM life_edges WHERE ${clauses.join(" AND ")} ORDER BY updated_at DESC`)
      .all(...args) as EdgeRow[];
    return rows.map(toEdge);
  }

  /** 用户 ↔ 管家 特殊边（relationship-graph 收敛落点）。 */
  getSelfAgentEdge(actorId: string): SocialEdge | null {
    const edges = this.getEdges(actorId, { kind: "self_agent" });
    return edges[0] ?? null;
  }

  /**
   * 把 relationship-graph 的 warmth/rapport 状态映射到 self_agent 边。
   * warmth → intimacy；rapport → sentiment 的正面分量（映射到 [-1,1]）。
   * @returns 收敛后的边
   */
  convergeRelationshipState(
    actorId: string,
    state: { warmth: number; rapport: number },
    changePoint?: EdgeChangePoint,
  ): SocialEdge | null {
    const selfId = this.ensureSelfEntity(actorId);
    const agentId = this.ensureAgentEntity(actorId);
    if (!selfId || !agentId) return null;
    return this.upsertEdge({
      actorId,
      fromEntityId: selfId,
      toEntityId: agentId,
      kind: "self_agent",
      subKind: "私人管家",
      intimacy: clamp01(state.warmth, 0.5),
      sentiment: clampSentiment((clamp01(state.rapport, 0.5) - 0.5) * 2),
      confidence: 0.8,
      changePoint,
    });
  }

  appendChangePoint(actorId: string, edgeId: string, point: EdgeChangePoint): void {
    if (!actorId || !edgeId) return;
    this.db
      .prepare(
        `INSERT INTO life_edge_history (id, edge_id, actor_id, at, intimacy, sentiment, trigger_ref, note)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        `ech:${simpleHash(`${edgeId}:${point.at}:${Date.now()}`)}`,
        edgeId,
        actorId,
        point.at,
        clamp01(point.intimacy, 0.5),
        clampSentiment(point.sentiment),
        point.triggerRef ?? null,
        point.note ?? null,
      );
  }

  getEdgeChangeLog(actorId: string, edgeId: string, limit = 20): EdgeChangePoint[] {
    const rows = this.db
      .prepare(
        `SELECT at, intimacy, sentiment, trigger_ref, note FROM life_edge_history
         WHERE actor_id = ? AND edge_id = ? ORDER BY at ASC LIMIT ?`,
      )
      .all(actorId, edgeId, limit) as Array<{
      at: string;
      intimacy: number | null;
      sentiment: number | null;
      trigger_ref: string | null;
      note: string | null;
    }>;
    return rows.map((r) => ({
      at: r.at,
      intimacy: r.intimacy ?? 0.5,
      sentiment: r.sentiment ?? 0,
      ...(r.trigger_ref ? { triggerRef: r.trigger_ref } : {}),
      ...(r.note ? { note: r.note } : {}),
    }));
  }

  /** 删除一条边及其轨迹。 */
  deleteEdge(actorId: string, id: string): number {
    if (!actorId || !id) return 0;
    const run = this.db.transaction(() => {
      this.db.prepare(`DELETE FROM life_edge_history WHERE actor_id = ? AND edge_id = ?`).run(actorId, id);
      return this.db.prepare(`DELETE FROM life_edges WHERE actor_id = ? AND id = ?`).run(actorId, id).changes;
    });
    return run();
  }

  /* ───────────────────── 图式 / 经验学习（落盘收敛） ───────────────────── */

  /** 图式落盘（SchemaPersistenceLike）：savePattern/loadPatterns 供 SchemaFormation 写穿/hydrate。 */
  savePattern(actorId: string, schema: SchemaNode): void {
    if (!actorId || !schema?.id) return;
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO life_patterns
           (id, actor_id, scene_tag, steps_json, preconditions_json, expected_outcomes_json,
            instances_json, warning_count, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           steps_json = excluded.steps_json,
           preconditions_json = excluded.preconditions_json,
           expected_outcomes_json = excluded.expected_outcomes_json,
           instances_json = excluded.instances_json,
           warning_count = excluded.warning_count,
           updated_at = excluded.updated_at`,
      )
      .run(
        schema.id,
        actorId,
        schema.sceneTag,
        toJsonColumn(schema.steps),
        toJsonColumn(schema.preconditions),
        toJsonColumn(schema.expectedOutcomes),
        toJsonColumn(schema.instances),
        schema.stereotypeWarningCount ?? 0,
        schema.createdAt ?? now,
        schema.updatedAt ?? now,
      );
  }

  loadPatterns(actorId: string): SchemaNode[] {
    if (!actorId) return [];
    const rows = this.db
      .prepare(`SELECT * FROM life_patterns WHERE actor_id = ? ORDER BY updated_at DESC`)
      .all(actorId) as Array<{
      id: string;
      scene_tag: string;
      steps_json: string | null;
      preconditions_json: string | null;
      expected_outcomes_json: string | null;
      instances_json: string | null;
      warning_count: number | null;
      created_at: string;
      updated_at: string;
    }>;
    return rows.map((r) => ({
      id: r.id,
      name: `${r.scene_tag}图式`,
      steps: fromJsonColumn<string[]>(r.steps_json, []),
      preconditions: fromJsonColumn<string[]>(r.preconditions_json, []),
      expectedOutcomes: fromJsonColumn<string[]>(r.expected_outcomes_json, []),
      instances: fromJsonColumn<string[]>(r.instances_json, []),
      stereotypeWarningCount: r.warning_count ?? 0,
      sceneTag: r.scene_tag,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }

  deletePattern(actorId: string, schemaId: string): number {
    if (!actorId || !schemaId) return 0;
    return this.db
      .prepare(`DELETE FROM life_patterns WHERE actor_id = ? AND id = ?`)
      .run(actorId, schemaId).changes;
  }

  /** 全量替换某 actor 的信念集（内存 store 为权威小集，写穿落盘）。 */
  saveBeliefs(actorId: string, beliefs: BeliefRecord[]): void {
    if (!actorId) return;
    const run = this.db.transaction(() => {
      this.db.prepare(`DELETE FROM life_beliefs WHERE actor_id = ?`).run(actorId);
      const ins = this.db.prepare(
        `INSERT INTO life_beliefs
           (id, actor_id, claim, status, confidence, support_json, contradict_json,
            use_count, success_count, failure_count, last_used_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const b of beliefs.slice(0, 120)) {
        ins.run(
          b.id,
          actorId,
          b.claim,
          b.status,
          clamp01(b.confidence),
          toJsonColumn(b.supportEpisodeIds ?? []),
          toJsonColumn(b.contradictingEpisodeIds ?? []),
          b.useCount ?? 0,
          b.successCount ?? 0,
          b.failureCount ?? 0,
          b.lastUsedAt ?? null,
          b.updatedAt ?? new Date().toISOString(),
        );
      }
    });
    run();
  }

  loadBeliefs(actorId: string): BeliefRecord[] {
    if (!actorId) return [];
    const rows = this.db
      .prepare(`SELECT * FROM life_beliefs WHERE actor_id = ? ORDER BY updated_at DESC`)
      .all(actorId) as Array<{
      id: string;
      actor_id: string;
      claim: string;
      status: string;
      confidence: number | null;
      support_json: string | null;
      contradict_json: string | null;
      use_count: number | null;
      success_count: number | null;
      failure_count: number | null;
      last_used_at: string | null;
      updated_at: string;
    }>;
    return rows.map((r) => ({
      id: r.id,
      actorId: r.actor_id,
      claim: r.claim,
      status: r.status as BeliefRecord["status"],
      confidence: r.confidence ?? 0.5,
      supportEpisodeIds: fromJsonColumn<string[]>(r.support_json, []),
      contradictingEpisodeIds: fromJsonColumn<string[]>(r.contradict_json, []),
      useCount: r.use_count ?? 0,
      successCount: r.success_count ?? 0,
      failureCount: r.failure_count ?? 0,
      ...(r.last_used_at ? { lastUsedAt: r.last_used_at } : {}),
      updatedAt: r.updated_at,
    }));
  }

  /** 全量替换某 actor 的经历集。 */
  saveEpisodes(actorId: string, episodes: LearningEpisode[]): void {
    if (!actorId) return;
    const run = this.db.transaction(() => {
      this.db.prepare(`DELETE FROM life_episodes WHERE actor_id = ?`).run(actorId);
      const ins = this.db.prepare(
        `INSERT INTO life_episodes
           (id, actor_id, source_memory_id, source_kind, status, observation, interpretation,
            lesson, tags_json, evidence_json, confidence, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const e of episodes.slice(0, 200)) {
        ins.run(
          e.id,
          actorId,
          e.sourceMemoryId ?? null,
          e.sourceKind ?? null,
          e.status,
          e.observation,
          e.interpretation ?? null,
          e.lesson ?? null,
          toJsonColumn(e.tags ?? []),
          toJsonColumn(e.evidence ?? []),
          clamp01(e.confidence, 0.5),
          e.createdAt ?? new Date().toISOString(),
          e.updatedAt ?? new Date().toISOString(),
        );
      }
    });
    run();
  }

  loadEpisodes(actorId: string): LearningEpisode[] {
    if (!actorId) return [];
    const rows = this.db
      .prepare(`SELECT * FROM life_episodes WHERE actor_id = ? ORDER BY updated_at DESC`)
      .all(actorId) as Array<{
      id: string;
      actor_id: string;
      source_memory_id: string | null;
      source_kind: string | null;
      status: string;
      observation: string;
      interpretation: string | null;
      lesson: string | null;
      tags_json: string | null;
      evidence_json: string | null;
      confidence: number | null;
      created_at: string;
      updated_at: string;
    }>;
    return rows.map((r) => ({
      id: r.id,
      actorId: r.actor_id,
      sourceMemoryId: r.source_memory_id ?? "",
      sourceKind: (r.source_kind ?? "experience") as LearningEpisode["sourceKind"],
      status: r.status as LearningEpisode["status"],
      observation: r.observation,
      interpretation: r.interpretation ?? "",
      lesson: r.lesson ?? "",
      tags: fromJsonColumn<string[]>(r.tags_json, []),
      evidence: fromJsonColumn<string[]>(r.evidence_json, []),
      confidence: r.confidence ?? 0.5,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }

  /* ────────────────────────── 渲染 / 隐私 / 统计 ────────────────────────── */

  /**
   * 【用户关系一览】块：用户生活中人物的结构化一览（人物/宠物/组织 + 与用户的关系）。
   * 空返回 null（宁缺毋滥：无实体就不注入）。敏感实体默认不进块（仅在敏感分级放开时纳入）。
   */
  renderRelationsForPrompt(actorId: string, opts?: { includeSensitive?: boolean }): string | null {
    const entities = this.listEntities(actorId).filter(
      (e) => e.kind !== "self" && (opts?.includeSensitive || e.sensitivity !== "sensitive"),
    );
    if (entities.length === 0) return null;
    const selfId = this.findEntityByName(actorId, "我")?.id ?? null;
    const edges = this.getEdges(actorId).filter((e) => e.kind !== "self_agent" && e.status !== "ended");
    const edgeByTarget = new Map(edges.map((e) => [e.toEntityId, e]));
    const lines = entities.slice(0, 12).map((e) => {
      const edge = (selfId && edges.find((x) => x.fromEntityId === selfId && x.toEntityId === e.id))
        || edgeByTarget.get(e.id)
        || null;
      const rel = edge ? RELATION_LABEL[edge.kind] : KIND_LABEL[e.kind];
      const sub = edge?.subKind ? `·${edge.subKind}` : "";
      const intimacy = edge ? `（亲疏${intimacyLabel(edge.intimacy)}）` : "";
      return `- ${rel}${sub}：${e.canonicalName}${intimacy}`;
    });
    return [
      "【用户关系一览】",
      "（这是对用户生活中人物/宠物的结构化记录，供你理解人物关系、自然称呼与指代消解；",
      "仅作背景，不要直接罗列或在回复里暴露记忆系统的存在。与用户最新消息冲突时以最新消息为准）",
      ...lines,
    ].join("\n");
  }

  /** actor 级清理（memory-clear-service 级联调用，隐私闭环）。返回清理的总行数。 */
  purgeActor(actorId: string): number {
    if (!actorId) return 0;
    const run = this.db.transaction(() => {
      let n = 0;
      n += this.db.prepare(`DELETE FROM life_edge_history WHERE actor_id = ?`).run(actorId).changes;
      n += this.db.prepare(`DELETE FROM life_edges WHERE actor_id = ?`).run(actorId).changes;
      n += this.db.prepare(`DELETE FROM life_entities WHERE actor_id = ?`).run(actorId).changes;
      n += this.db.prepare(`DELETE FROM life_patterns WHERE actor_id = ?`).run(actorId).changes;
      n += this.db.prepare(`DELETE FROM life_beliefs WHERE actor_id = ?`).run(actorId).changes;
      n += this.db.prepare(`DELETE FROM life_episodes WHERE actor_id = ?`).run(actorId).changes;
      return n;
    });
    return run();
  }

  stats(actorId?: string): {
    entities: number;
    edges: number;
    patterns: number;
    beliefs: number;
    episodes: number;
  } {
    const q = (sql: string): number => {
      const row = (actorId
        ? this.db.prepare(`${sql} WHERE actor_id = ?`).get(actorId)
        : this.db.prepare(sql).get()) as { n: number } | undefined;
      return row?.n ?? 0;
    };
    return {
      entities: q(`SELECT COUNT(*) AS n FROM life_entities`),
      edges: q(`SELECT COUNT(*) AS n FROM life_edges`),
      patterns: q(`SELECT COUNT(*) AS n FROM life_patterns`),
      beliefs: q(`SELECT COUNT(*) AS n FROM life_beliefs`),
      episodes: q(`SELECT COUNT(*) AS n FROM life_episodes`),
    };
  }
}

function toEntity(r: EntityRow): LifeEntity {
  return {
    id: r.id,
    actorId: r.actor_id,
    kind: (VALID_ENTITY_KINDS.includes(r.kind as LifeEntityKind) ? r.kind : "person") as LifeEntityKind,
    canonicalName: r.canonical_name,
    aliases: toStringArray(fromJsonColumn<unknown>(r.aliases_json, [])),
    firstSeenAt: r.first_seen_at,
    lastSeenAt: r.last_seen_at,
    confidence: r.confidence ?? 0.6,
    sourceRefs: toStringArray(fromJsonColumn<unknown>(r.source_refs_json, [])),
    sensitivity: r.sensitivity === "sensitive" ? "sensitive" : "normal",
  };
}

function toEdge(r: EdgeRow): SocialEdge {
  return {
    id: r.id,
    actorId: r.actor_id,
    fromEntityId: r.from_entity_id,
    toEntityId: r.to_entity_id,
    kind: (VALID_RELATION_KINDS.includes(r.kind as RelationKind) ? r.kind : "acquaintance") as RelationKind,
    subKind: r.sub_kind,
    intimacy: r.intimacy ?? 0.5,
    sentiment: r.sentiment ?? 0,
    validFrom: r.valid_from,
    validTo: r.valid_to,
    status: (["active", "ended", "unknown"].includes(r.status) ? r.status : "active") as EdgeStatus,
    confidence: r.confidence ?? 0.6,
    sourceRefs: toStringArray(fromJsonColumn<unknown>(r.source_refs_json, [])),
    sensitivity: r.sensitivity === "sensitive" ? "sensitive" : "normal",
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}
