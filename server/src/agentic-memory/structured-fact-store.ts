/**
 * 结构化事实库（Structured Fact Store）——记忆三层架构的第三层。
 *
 * 分层定位（向量库 / 知识图谱之外的确定性层）：
 *   - 向量库（Mem0 OSS）：非结构化记忆，语义相似度检索；
 *   - 知识图谱（认知图 / bridge）：实体-关系网络，多跳联想；
 *   - 结构化事实库（本模块）：确定性高、字段固定的信息（称呼/职业/居住地/
 *     技术栈/生日…），KV 式精确寻址，不做语义检索。
 *
 * 与相邻存储的分工：
 *   - UserUnderstandingStore 存「agent 对对话的理解」（含语气与性质判断，
 *     玩笑/粉丝式称呼不当真）；本库存「字面为真的字段值」。用户说
 *     "我的老婆是刘浩存"→ 理解档案记 fandom 理解，事实库不记任何字段；
 *     用户说"我叫张三"→ 理解档案记 literal 理解，事实库记 称呼=张三。
 *   - nightly UserFactStore（JSON）是夜间批量提炼的巩固产物；本库是
 *     对话内的实时更新通道（统一抽取同一次 LLM 的产物，写钩子直落）。
 *
 * 运行语义（与理解档案同构，复用其成熟模式）：
 *   - 主键 = actor + entity + 归一化字段；同字段新值生效即旧值入「演变历史」
 *     （superseded 链，不删除——旧值是真实发生过的事实，可追溯可引用，
 *     "你上次还住在杭州"）；任意时刻 getActiveFacts 只返回每字段的当前值；
 *   - latest-wins：更新类事实（搬家/换工作）天然覆盖，不自相矛盾；
 *   - 回答侧（注入块）以当前值为权威依据；本轮提问命中的字段带寻址标记。
 *
 * 隐私闭环：purgeActor 供 memory-clear-service 级联调用。
 */

import type { Database as SqliteDatabase } from "better-sqlite3";

import { isEphemeralActorId } from "../agent/actor-id.js";
import { isStructuredFactsEnabled } from "./env.js";
import { openAgenticSqlite } from "./sqlite-store.js";

/** 单条结构化事实（当前值或历史值） */
export interface StructuredFact {
  id: string;
  actorId: string;
  /** 事实主体（缺省 "user"；预留家庭成员/设备等扩展） */
  entity: string;
  /** 归一化字段名（称呼/职业/居住地/技术栈…） */
  field: string;
  /** 字段值（确定性短值） */
  value: string;
  confidence: number | null;
  sourceRef: string | null;
  createdAt: string;
  updatedAt: string;
}

interface FactRow {
  id: string;
  actor_id: string;
  entity: string;
  field: string;
  value: string;
  confidence: number | null;
  source_ref: string | null;
  status: string;
  created_at: string;
  updated_at: string;
  superseded_at: string | null;
  superseded_by: string | null;
}

export interface ApplyFactInput {
  actorId: string;
  field: string;
  value: string;
  entity?: string;
  confidence?: number | null;
  sourceRef?: string | null;
}

export interface ApplyFactResult {
  /** true = 字段值发生变更（旧值入历史）；false = 同值确认/touch */
  changed: boolean;
  fact: StructuredFact;
  /** 被替代的旧值（changed=true 时非空，最新在前） */
  previous: StructuredFact[];
}

function toFact(row: FactRow): StructuredFact {
  return {
    id: row.id,
    actorId: row.actor_id,
    entity: row.entity,
    field: row.field,
    value: row.value,
    confidence: row.confidence,
    sourceRef: row.source_ref,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function clampConfidence(raw: number | null | undefined): number | null {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return null;
  return Math.max(0, Math.min(1, raw));
}

/** 字段名规范化：去标点空白，压缩长度上限 */
export function normalizeFactField(field: string): string {
  return field
    .trim()
    .replace(/[「」"'（）()。．.！!？?~～、,;；:：=\s]+/g, "")
    .slice(0, 16);
}

/**
 * 字段别名归一：同一语义的不同说法收敛到标准字段，避免「姓名/名字/称呼」
 * 各存一行导致精确寻址漏命中。归一在 normalizeFactField 之后做精确匹配。
 *
 * 2026-10-09 单一权威源：本表同时是「档案字段」的权威定义——凡是能归一到
 * 下列标准字段之一者，其值只允许存在于本库；USER_PROFILE.md / KV 槽位只能是
 * 本库的投影（见 profile-fact-authority.ts）。新增档案字段在此登记即可。
 */
export const PROFILE_FIELD_ALIASES: ReadonlyArray<readonly [string, RegExp]> = [
  ["称呼", /^(姓名|名字|全名|叫我|昵称|英名|花名|称呼)$/],
  ["职业", /^(工作|职务|职位|岗位|行业|职业)$/],
  ["居住地", /^(住址|住处|所在地|城市|定居地|家在|坐标|居住地)$/],
  ["技术栈", /^(技术|技术方向|stack|编程语言|技术栈)$/i],
  ["生日", /^(出生日期|生日|诞辰|生日日期)$/],
  ["公司", /^(任职|雇主|单位|公司|所在公司)$/],
  ["学历", /^(教育|毕业院校|学校|学历)$/],
];

export function canonicalFactField(field: string): string {
  const f = normalizeFactField(field);
  if (!f) return "";
  for (const [canonical, re] of PROFILE_FIELD_ALIASES) {
    if (re.test(f)) return canonical;
  }
  return f;
}

/** 全部标准档案字段（调用方用于投影/清理的遍历） */
export const PROFILE_FIELDS: readonly string[] = PROFILE_FIELD_ALIASES.map(
  ([canonical]) => canonical,
);

/**
 * 是否为「档案字段」（确定性、字段固定的用户信息：称呼/职业/居住地…）。
 * 只有本库对这类字段有写入权；其余存储只能是投影。
 */
export function isProfileField(field: string): boolean {
  const canonical = canonicalFactField(field);
  return canonical !== "" && PROFILE_FIELDS.includes(canonical);
}

let uidSeq = 0;
function nextFactId(): string {
  uidSeq = (uidSeq + 1) % 100000;
  return `sft_${Date.now().toString(36)}_${uidSeq.toString(36)}`;
}

const MAX_ACTIVE_FACTS = 120;

export class StructuredFactStore {
  private readonly db: SqliteDatabase;

  constructor(db?: SqliteDatabase) {
    this.db = db ?? openAgenticSqlite();
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS structured_facts (
        id TEXT PRIMARY KEY,
        actor_id TEXT NOT NULL,
        entity TEXT NOT NULL DEFAULT 'user',
        field TEXT NOT NULL,
        value TEXT NOT NULL,
        confidence REAL,
        source_ref TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        superseded_at TEXT,
        superseded_by TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_structured_facts_actor_active
        ON structured_facts(actor_id, entity, field, status);
    `);
  }

  close(): void {
    this.db.close();
  }

  /**
   * 字段级事务 upsert（当前值权威）：
   *   - 同 (actor, entity, field) 当前值与新值相同 → touch（更新确认时间），
   *     changed=false；
   *   - 否则旧值入历史 + 新值生效（同一事务）。
   * 字段/值规范化后为空或超长返回 null（不入库，调用方走普通记忆路径）。
   */
  applyFact(input: ApplyFactInput): ApplyFactResult | null {
    const actorId = input.actorId?.trim();
    const entity = normalizeFactField(input.entity ?? "user") || "user";
    const field = canonicalFactField(input.field ?? "");
    // 值规范（对齐主流口径）：无主语短值由抽取侧语义改写保证（unified-extractor
    // 协议约束「存兴义不存我在兴义」），本层不做正则剥字——正则剥「我是做后端的」
    // 会剥坏语义，LLM 抽取时改写成「职业:后端开发」才是正确姿势
    const value = input.value?.trim().replace(/\s+/g, " ");
    if (!actorId || !field || !value || value.length > 80) return null;
    if (isEphemeralActorId(actorId)) return null;

    const now = new Date().toISOString();
    const run = this.db.transaction((): ApplyFactResult => {
      const actives = this.db
        .prepare(
          `SELECT * FROM structured_facts
           WHERE actor_id = ? AND entity = ? AND field = ? AND status = 'active'
           ORDER BY updated_at ASC`,
        )
        .all(actorId, entity, field) as FactRow[];

      const same = actives.find((r) => r.value === value);
      if (same) {
        this.db
          .prepare(
            `UPDATE structured_facts SET updated_at = ?,
               confidence = COALESCE(?, confidence)
             WHERE id = ?`,
          )
          .run(now, clampConfidence(input.confidence), same.id);
        return {
          changed: false,
          fact: toFact({ ...same, updated_at: now }),
          previous: [],
        };
      }

      const id = nextFactId();
      this.db
        .prepare(
          `INSERT INTO structured_facts
             (id, actor_id, entity, field, value, confidence, source_ref,
              status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
        )
        .run(
          id,
          actorId,
          entity,
          field,
          value,
          clampConfidence(input.confidence),
          input.sourceRef ?? null,
          now,
          now,
        );
      for (const old of actives) {
        this.db
          .prepare(
            `UPDATE structured_facts SET status = 'superseded', superseded_at = ?, superseded_by = ?
             WHERE id = ? AND status = 'active'`,
          )
          .run(now, id, old.id);
      }
      const inserted = this.db
        .prepare(`SELECT * FROM structured_facts WHERE id = ?`)
        .get(id) as FactRow;
      this.enforceCapacity(actorId);
      return { changed: true, fact: toFact(inserted), previous: actives.map(toFact).reverse() };
    });
    return run();
  }

  /** 容量上限：淘汰最久未更新的 active 事实（防字段爆炸，历史行不动） */
  private enforceCapacity(actorId: string): void {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM structured_facts
         WHERE actor_id = ? AND status = 'active'`,
      )
      .get(actorId) as { n: number };
    if (row.n <= MAX_ACTIVE_FACTS) return;
    const stale = this.db
      .prepare(
        `SELECT id FROM structured_facts
         WHERE actor_id = ? AND status = 'active'
         ORDER BY updated_at ASC LIMIT ?`,
      )
      .all(actorId, row.n - MAX_ACTIVE_FACTS) as Array<{ id: string }>;
    const del = this.db.prepare(
      `DELETE FROM structured_facts WHERE id = ? AND status = 'active'`,
    );
    for (const s of stale) del.run(s.id);
  }

  getActiveFacts(actorId: string, entity = "user"): StructuredFact[] {
    if (!actorId) return [];
    const rows = this.db
      .prepare(
        `SELECT * FROM structured_facts
         WHERE actor_id = ? AND entity = ? AND status = 'active'
         ORDER BY updated_at DESC`,
      )
      .all(actorId, entity) as FactRow[];
    return rows.map(toFact);
  }

  /** 精确寻址（KV 语义，无向量检索）：单字段当前值 */
  getFact(actorId: string, field: string, entity = "user"): StructuredFact | null {
    const f = canonicalFactField(field);
    if (!actorId || !f) return null;
    const row = this.db
      .prepare(
        `SELECT * FROM structured_facts
         WHERE actor_id = ? AND entity = ? AND field = ? AND status = 'active'`,
      )
      .get(actorId, entity, f) as FactRow | undefined;
    return row ? toFact(row) : null;
  }

  /**
   * 某字段的全部已知值（当前 + superseded 历史，去重）——供投影侧识别「陈旧副本」：
   * 别的存储里若还写着该字段的旧值（"我是王king"），可据此判定并清除。
   */
  getAllValuesForField(actorId: string, field: string, entity = "user"): string[] {
    const f = canonicalFactField(field);
    const ent = normalizeFactField(entity) || "user";
    if (!actorId || !f) return [];
    const rows = this.db
      .prepare(
        `SELECT value FROM structured_facts
         WHERE actor_id = ? AND entity = ? AND field = ?`,
      )
      .all(actorId, ent, f) as Array<{ value: string }>;
    return [...new Set(rows.map((r) => r.value))];
  }

  /**
   * 问句直接寻址：userText 命中某字段名（"我是做什么工作的"→「职业」）时
   * 返回对应事实，供注入块标记"本轮提问相关，基于此回答"。
   * 字段名 ≥2 字才参与命中（单字误命中率高）。
   */
  matchFieldsInText(actorId: string, text: string, entity = "user"): StructuredFact[] {
    const t = text?.trim();
    if (!t) return [];
    return this.getActiveFacts(actorId, entity).filter(
      (f) => f.field.length >= 2 && t.includes(f.field),
    );
  }

  /** 某当前值的演变历史（沿 superseded_by 链回溯，最新在前，limit 条） */
  getHistoryFor(actorId: string, factId: string, limit = 2, entity = "user"): StructuredFact[] {
    const out: StructuredFact[] = [];
    let cursor: string | null = factId;
    for (let i = 0; i < limit; i++) {
      const row = this.db
        .prepare(
          `SELECT * FROM structured_facts
           WHERE actor_id = ? AND entity = ? AND status = 'superseded' AND superseded_by = ?
           ORDER BY superseded_at DESC LIMIT 1`,
        )
        .get(actorId, entity, cursor) as FactRow | undefined;
      if (!row) break;
      out.push(toFact(row));
      cursor = row.id;
    }
    return out;
  }

  /**
   * 事实档案块渲染（注入侧直接使用；空返回 null 零注入）。
   * 头部写明权威语义：这是确定性记录，被问及对应字段时直接引用当前值，
   * 不要靠语义检索猜；用户最新消息明确更正时以最新消息为准（系统自动登记变更）。
   */
  renderForPrompt(actorId: string, groundedFields?: Set<string>, entity = "user"): string | null {
    const facts = this.getActiveFacts(actorId, entity);
    if (facts.length === 0) return null;
    const lines = facts.slice(0, 20).map((f) => {
      const updatedAt = f.updatedAt.slice(5, 10).replace("-", "/");
      const grounded = groundedFields?.has(f.field)
        ? " ← 本轮提问相关，基于此回答"
        : "";
      const history = this.getHistoryFor(actorId, f.id, 1, entity);
      const historyLine =
        history.length > 0
          ? `（此前：${history[0]!.value}，${history[0]!.updatedAt.slice(5, 10).replace("-", "/")}）`
          : "";
      // 低置信标注（ChatGPT 式 Confidence，2026-10-11）：只标低置信条目，
      // 提示模型转述时不要把话说满——治「画像精确度/用词准确性」
      const lowConfidence =
        f.confidence !== null && f.confidence < 0.6
          ? "〔置信度低：据你随口提及，转述时不要把话说满〕"
          : "";
      return `- ${f.field}：${f.value}（${updatedAt} 更新）${historyLine}${grounded}${lowConfidence}`;
    });
    return [
      "【用户档案·结构化事实】",
      "（以下是用户确定信息的精确记录，确定性高于其他记忆来源。被问及对应",
      "字段时直接引用当前值，不要靠语义检索猜测。带「此前」的是演变历史，",
      "仅供追溯，不代表现状。仅当用户最新消息明确更正时以最新消息为准——",
      "此时系统会自动登记字段变更）",
      "（称呼礼仪：称呼用户时优先用用户明确指定的称呼（如「叫我王哥」的",
      "「王哥」）；没有指定时用「姓氏+先生/女士」（如「王先生」）或自然省略",
      "称呼。称呼/姓名字段的大名（如「王铭川」）只是事实记录，供问答引用，",
      "不要在回复里连名带姓直呼用户）",
      ...lines,
    ].join("\n");
  }

  /**
   * 字段级遗忘（Mem0 DELETE 语义，2026-10-11）：用户明确要求忘掉某字段
   * （「别记我住哪了」「把那个忘了」）时，该字段全部 active 值 supersede
   * 下线（superseded_by='forget'），历史行保留可追溯（与隐私 purge 不同，
   * 这不是数据销毁而是档案修正）。返回下线条数；字段无效返回 null。
   */
  clearFact(
    actorId: string,
    field: string,
    opts?: { entity?: string },
  ): number | null {
    const actor = actorId?.trim();
    const canonical = canonicalFactField(field ?? "");
    const entity = normalizeFactField(opts?.entity ?? "user") || "user";
    if (!actor || !canonical) return null;
    const now = new Date().toISOString();
    const run = this.db.transaction((): number => {
      const actives = this.db
        .prepare(
          `SELECT id FROM structured_facts
           WHERE actor_id = ? AND entity = ? AND field = ? AND status = 'active'`,
        )
        .all(actor, entity, canonical) as Array<{ id: string }>;
      if (actives.length === 0) return 0;
      const clear = this.db.prepare(
        `UPDATE structured_facts
         SET status = 'superseded', superseded_at = ?, superseded_by = 'forget'
         WHERE id = ? AND status = 'active'`,
      );
      for (const row of actives) clear.run(now, row.id);
      return actives.length;
    });
    return run();
  }

  /** actor 级清理（memory-clear-service 级联调用，隐私闭环） */
  purgeActor(actorId: string): number {
    if (!actorId) return 0;
    return this.db
      .prepare(`DELETE FROM structured_facts WHERE actor_id = ?`)
      .run(actorId).changes;
  }

  stats(actorId?: string): { total: number; active: number; superseded: number } {
    const row = actorId
      ? (this.db
          .prepare(
            `SELECT COUNT(*) AS total,
                    SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active
             FROM structured_facts WHERE actor_id = ?`,
          )
          .get(actorId) as { total: number; active: number | null })
      : (this.db
          .prepare(
            `SELECT COUNT(*) AS total,
                    SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active
             FROM structured_facts`,
          )
          .get() as { total: number; active: number | null });
    const total = row.total;
    const active = row.active ?? 0;
    return { total, active, superseded: total - active };
  }
}

export function createStructuredFactStoreIfEnabled(db?: SqliteDatabase): StructuredFactStore | null {
  if (!isStructuredFactsEnabled()) return null;
  return new StructuredFactStore(db);
}
