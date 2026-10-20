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

/**
 * 事实时态（2026-10-19 时间锚定）：
 *   - current：现状陈述（"我现在住兴义"）——参与 latest-wins，可覆盖旧的现状；
 *   - past：历史陈述（"我以前住浙江"）——只登记为历史，**永不覆盖现状**。
 *
 * 这是「时间认知」在存储侧的落点：同一字段可以同时存在 current 与 past 行，
 * 模型回答「你现在住哪」读 current，「你以前住哪」读 past，两者不互相污染。
 */
export type FactTemporality = "current" | "past" | "upcoming";

/**
 * 未来态（upcoming）的确认状态：
 *   - pending：计划尚未到期，系统只知道"用户说要做"；
 *   - lapsed：计划时点已过，但**没有任何证据**表明发生了——降级为"未确认"，
 *     绝不自动改写成"已发生"（2026-10-19 用户定调：无证据不得断言）；
 *   - confirmed：有证据（用户复述 / 位置到达）后转正，行本身留作溯源。
 */
export type PlanState = "pending" | "lapsed" | "confirmed";

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
  /** 时态：current=现状 / past=历史陈述 / upcoming=计划中的未来变更 */
  temporal: FactTemporality;
  /**
   * 事情发生/生效的时间线索（用户原话里的时间，如 "2023-06"、"2021年"、
   * "大学毕业前"）。**不是**记忆登记时间——这是让模型区分「何时发生」与
   * 「何时被告知」的关键字段，缺省 null。
   */
  eventTime: string | null;
  /** 结构化有效区间起点（YYYY-MM-DD 或 YYYY-MM，可比、可过滤）；缺省 null */
  validFrom: string | null;
  /** 结构化有效区间终点；缺省 null（= 至今 / 未知） */
  validTo: string | null;
  /** 用户说出这件事的时刻（观察时间）；历史行用它排出先后 */
  observedAt: string;
  /** 未来态的计划状态；非 upcoming 行恒为 null */
  planState: PlanState | null;
  /** 同值被确认的次数（≥3 次时置信度升到 0.9，见 CONFIRM_LIFT_*） */
  confirmCount: number;
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
  temporal: string | null;
  event_time: string | null;
  observed_at: string | null;
  valid_from: string | null;
  valid_to: string | null;
  confirm_count: number;
}

export interface ApplyFactInput {
  actorId: string;
  field: string;
  value: string;
  entity?: string;
  confidence?: number | null;
  sourceRef?: string | null;
  /** 缺省 current（兼容旧调用方：无时态信息按现状处理） */
  temporal?: FactTemporality;
  /** 事情发生/生效的时间线索（用户原话里的时间），非登记时间 */
  eventTime?: string | null;
  /** 结构化区间起点（ISO 日期/月份）；缺省时尝试从 eventTime 解析 */
  validFrom?: string | null;
  /** 结构化区间终点；缺省 null */
  validTo?: string | null;
  /** 观察时间（用户说出这句话的时刻），缺省取当前时刻 */
  observedAt?: string | null;
}

/** 未生效原因（changed=false 时可能非空，供上层日志/诊断） */
export type FactIgnoredReason = "past" | "upcoming" | "low_confidence";

export interface ApplyFactResult {
  /** true = 字段值发生变更（旧值入历史）；false = 同值确认/touch 或未生效 */
  changed: boolean;
  fact: StructuredFact;
  /** 被替代的旧值（changed=true 时非空，最新在前） */
  previous: StructuredFact[];
  /** 未生效原因：past=历史陈述不改现状；low_confidence=低置信值被现状挡下 */
  ignored?: FactIgnoredReason;
}

function toFact(row: FactRow): StructuredFact {
  const temporal: FactTemporality =
    row.temporal === "past" ? "past" : row.temporal === "upcoming" ? "upcoming" : "current";
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
    temporal,
    eventTime: row.event_time ?? null,
    validFrom: row.valid_from ?? null,
    validTo: row.valid_to ?? null,
    observedAt: row.observed_at ?? row.created_at,
    confirmCount: row.confirm_count ?? 1,
    planState:
      temporal === "upcoming"
        ? row.status === "lapsed"
          ? "lapsed"
          : row.status === "confirmed_plan"
            ? "confirmed"
            : "pending"
        : null,
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
/** 历史行上限（含 past 陈述与 superseded 旧值），防追踪链无限膨胀 */
const MAX_HISTORICAL_FACTS = 400;

/**
 * 置信度闸参数（2026-10-19）：
 * 现状值已足够可信（≥ floor）时，新值必须比它高出 margin 才允许覆盖，
 * 否则视为「随口一提」，不推翻已确认的档案。
 */
const CONFIDENT_CURRENT_FLOOR = 0.8;
const CONFIDENCE_OVERWRITE_MARGIN = 0.2;

/**
 * 重复确认升权（P1-6）：同一现状被用户确认满 N 次，置信度抬到不低于 floor。
 * 动机——用户三次说"我做后端"，值仍是 0.75，后来一句 0.65 的"我做产品？"就会
 * 覆盖它；反复确认过的东西不该这么脆弱。
 */
const CONFIRM_LIFT_AT = 3;
const CONFIRM_LIFT_FLOOR = 0.9;

/** 观察时间规范化：非法/缺失回落到当前时刻 */
function normalizeObservedAt(raw: string | null | undefined, fallback: string): string {
  if (typeof raw === "string") {
    const ts = Date.parse(raw);
    if (Number.isFinite(ts)) return new Date(ts).toISOString();
  }
  return fallback;
}

function normalizeEventTime(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const t = raw.trim().replace(/\s+/g, " ");
  if (!t) return null;
  return t.slice(0, 40);
}

/* ───────────────────────── 结构化有效区间 ───────────────────────── */

/**
 * 有效区间的统一表示：一律归一到 YYYY-MM-DD（起点取该粒度的第一天、
 * 终点取最后一天），这样字符串比较就等于时间比较——不用额外解析，
 * SQLite 里也能直接 `valid_from <= ?`。
 *
 * "2019"      → 起点 2019-01-01 / 终点 2019-12-31
 * "2023-06"   → 起点 2023-06-01 / 终点 2023-06-30
 * "2023-06-15"→ 原样（起点终点同一粒度时由调用方决定）
 */
const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function isLeapYear(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

function lastDayOfMonth(y: number, m: number): number {
  if (m === 2 && isLeapYear(y)) return 29;
  return DAYS_IN_MONTH[m - 1] ?? 28;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** 把一个时间点表达式归一为 YYYY-MM-DD；edge 决定「年份/月份」取首日还是末日 */
export function normalizeValidPoint(
  raw: string | null | undefined,
  edge: "start" | "end",
): string | null {
  if (typeof raw !== "string") return null;
  const t = raw.trim();
  if (!t) return null;
  const m = t.match(/^(\d{4})(?:[-/年.](\d{1,2}))?(?:[-/月.](\d{1,2}))?/);
  if (!m) return null;
  const y = Number(m[1]);
  if (!Number.isFinite(y) || y < 1900 || y > 2200) return null;
  const hasMonth = m[2] !== undefined;
  const hasDay = m[3] !== undefined;
  const mo = hasMonth ? Math.min(12, Math.max(1, Number(m[2]))) : edge === "start" ? 1 : 12;
  const day = hasDay
    ? Math.min(lastDayOfMonth(y, mo), Math.max(1, Number(m[3])))
    : edge === "start"
      ? 1
      : lastDayOfMonth(y, mo);
  return `${y}-${pad2(mo)}-${pad2(day)}`;
}

/**
 * 从用户原话的时间线索里抽区间（LLM 已给 validFrom/validTo 时优先用它的）。
 * 只认能确定的形态，含糊表达（"大学毕业前""很久以前"）返回 null——
 * 宁可没有区间，也不要编一个精确日期出来。
 */
export function inferValidRange(
  eventTime: string | null | undefined,
): { from: string | null; to: string | null } | null {
  const t = eventTime?.trim();
  if (!t) return null;
  // 至今 / 现在 / 目前 → 有起点无终点
  const openEnded = /(至今|到现在|到目前为止|目前还在|目前|现在|如今)/.test(t);
  // 区间：2019-2023 / 2019年到2023年 / 2019~2023
  const span = t.match(/(\d{4})\s*年?\s*(?:[-~～至到]|—)\s*(\d{4})\s*年?/);
  if (span) {
    const [, a, b] = span;
    const from = a ? normalizeValidPoint(a, "start") : null;
    const to = b ? normalizeValidPoint(b, "end") : null;
    return from || to ? { from, to } : null;
  }
  // 单点：2023-06 / 2023年6月 / 2023
  const single = normalizeValidPoint(t, "start");
  if (!single) return null;
  const end = openEnded ? null : normalizeValidPoint(t, "end");
  return { from: single, to: end };
}

export class StructuredFactStore {
  private readonly db: SqliteDatabase;
  /**
   * 实体物化副作用（P0，2026-10-20 生活模型接线）：每次写入一个非 user 主体的事实时
   * 回调一次，供 LifeModelStore 旁路 upsert life_entities（同一 LLM 产物，零新增调用）。
   * 由 create-app-services 装配注入；未注入时为 null（纯事实库行为不变）。
   */
  private entityObserver:
    | ((actorId: string, entity: string, seenAt: string, sourceRef: string | null) => void)
    | null = null;

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
        superseded_by TEXT,
        temporal TEXT NOT NULL DEFAULT 'current',
        event_time TEXT,
        observed_at TEXT,
        valid_from TEXT,
        valid_to TEXT,
        confirm_count INTEGER NOT NULL DEFAULT 1
      );
      CREATE INDEX IF NOT EXISTS idx_structured_facts_actor_active
        ON structured_facts(actor_id, entity, field, status);
    `);
    this.migrateTemporalColumns();
  }

  /**
   * 存量库增量迁移（2026-10-19 时间锚定）：老库没有 temporal/event_time/
   * observed_at 三列。加列而不是重建表——历史行原样保留，attribution 不丢。
   * 幂等：按 PRAGMA table_info 判定，重复启动无副作用。
   */
  private migrateTemporalColumns(): void {
    const cols = new Set(
      (this.db.prepare(`PRAGMA table_info(structured_facts)`).all() as Array<{ name: string }>).map(
        (c) => c.name,
      ),
    );
    if (!cols.has("temporal")) {
      this.db.exec(
        `ALTER TABLE structured_facts ADD COLUMN temporal TEXT NOT NULL DEFAULT 'current'`,
      );
    }
    if (!cols.has("event_time")) {
      this.db.exec(`ALTER TABLE structured_facts ADD COLUMN event_time TEXT`);
    }
    if (!cols.has("observed_at")) {
      this.db.exec(`ALTER TABLE structured_facts ADD COLUMN observed_at TEXT`);
      // 存量行回填：观察时间 = 创建时间（老数据没有更精确的来源）
      this.db.exec(`UPDATE structured_facts SET observed_at = created_at WHERE observed_at IS NULL`);
    }
    if (!cols.has("valid_from")) {
      this.db.exec(`ALTER TABLE structured_facts ADD COLUMN valid_from TEXT`);
    }
    if (!cols.has("valid_to")) {
      this.db.exec(`ALTER TABLE structured_facts ADD COLUMN valid_to TEXT`);
    }
    if (!cols.has("confirm_count")) {
      // 重复确认计数（P1-6）：同一现状被用户反复说起会升权，防止后来一次
      // 中等置信的说法覆盖多次确认的值。存量行回填默认 1。
      this.db.exec(
        `ALTER TABLE structured_facts ADD COLUMN confirm_count INTEGER NOT NULL DEFAULT 1`,
      );
    }
    // 存量行回填结构化区间（尽力而为）：event_time 能解析就拆成 from/to，
    // 解析不了就留空——空格比编一个日期更诚实。
    const unparsed = this.db
      .prepare(
        `SELECT id, event_time FROM structured_facts
         WHERE valid_from IS NULL AND event_time IS NOT NULL`,
      )
      .all() as Array<{ id: string; event_time: string }>;
    if (unparsed.length > 0) {
      const upd = this.db.prepare(
        `UPDATE structured_facts SET valid_from = ?, valid_to = ? WHERE id = ?`,
      );
      for (const row of unparsed) {
        const range = inferValidRange(row.event_time);
        if (range) upd.run(range.from, range.to, row.id);
      }
    }
  }

  close(): void {
    this.db.close();
  }

  /**
   * 字段级事务 upsert（当前值权威 + 时间锚定）：
   *   - 同 (actor, entity, field) 当前值与新值相同 → touch（更新确认时间），
   *     changed=false；
   *   - temporal='past'（"我以前住浙江"）→ 只登记历史行，**不改现状**；
   *   - temporal='current' 且现状值为高置信 → 新值置信度明显更低时挡下
   *     （ignored='low_confidence'），不推翻已确认档案；
   *   - 其余情况旧值入历史 + 新值生效（同一事务）。
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

    const temporal: FactTemporality =
      input.temporal === "past" ? "past" : input.temporal === "upcoming" ? "upcoming" : "current";
    const confidence = clampConfidence(input.confidence);
    const eventTime = normalizeEventTime(input.eventTime);
    const now = normalizeObservedAt(input.observedAt, new Date().toISOString());
    // 结构化区间：显式给了就归一，没给就从 eventTime 尽力解析。
    // 解析不出来就留空——**不编日期**，空格比假精确诚实。
    const explicitFrom = normalizeValidPoint(input.validFrom, "start");
    const explicitTo = normalizeValidPoint(input.validTo, "end");
    const inferred = inferValidRange(eventTime);
    const validFrom = explicitFrom ?? inferred?.from ?? null;
    const validTo = explicitTo ?? inferred?.to ?? null;

    const run = this.db.transaction((): ApplyFactResult => {
      const actives = this.db
        .prepare(
          `SELECT * FROM structured_facts
           WHERE actor_id = ? AND entity = ? AND field = ? AND status = 'active'
           ORDER BY updated_at ASC`,
        )
        .all(actorId, entity, field) as FactRow[];

      const same = actives.find((r) => r.value === value);

      // ── 未来态通道（计划，不是事实）：只登记"用户说要做"，绝不改现状 ──
      // 2026-10-19 证据门：计划到期也**不会**自动变成"已发生"——无证据的断言
      // 就是错误记忆。确认只能来自用户复述或位置证据（confirmPlan*）。
      if (temporal === "upcoming") {
        const planned = this.db
          .prepare(
            `SELECT * FROM structured_facts
             WHERE actor_id = ? AND entity = ? AND field = ?
               AND temporal = 'upcoming' AND status IN ('planned','lapsed')
             ORDER BY updated_at DESC LIMIT 1`,
          )
          .get(actorId, entity, field) as FactRow | undefined;
        if (planned && planned.value === value) {
          this.touchRow(planned.id, now, confidence, eventTime, validFrom, validTo);
          // 重复提及计划 → 视为重新确认计划（若已 lapsed 则回到 planned）
          if (planned.status === "lapsed") {
            this.db
              .prepare(`UPDATE structured_facts SET status = 'planned' WHERE id = ?`)
              .run(planned.id);
          }
          return {
            changed: false,
            ignored: "upcoming",
            fact: toFact({ ...planned, updated_at: now, status: planned.status === "lapsed" ? "planned" : planned.status }),
            previous: [],
          };
        }
        if (same) {
          // 计划值 = 现状值（"我下个月还住兴义"）：没有状态变化，只更新计划时点
          return { changed: false, ignored: "upcoming", fact: toFact(same), previous: [] };
        }
        const planId = this.insertRow({
          actorId,
          entity,
          field,
          value,
          confidence,
          sourceRef: input.sourceRef,
          status: "planned",
          temporal: "upcoming",
          eventTime,
          validFrom,
          validTo,
          at: now,
        });
        // 同一字段只保留最新的一条计划（旧计划是"说过但不作数了"）
        this.db
          .prepare(
            `UPDATE structured_facts SET status = 'superseded', superseded_at = ?, superseded_by = ?
             WHERE actor_id = ? AND entity = ? AND field = ? AND id <> ?
               AND temporal = 'upcoming' AND status IN ('planned','lapsed')`,
          )
          .run(now, planId, actorId, entity, field, planId);
        return {
          changed: false,
          ignored: "upcoming",
          fact: toFact(this.rowById(planId)),
          previous: [],
        };
      }

      // ── 历史陈述通道（时间认知核心）：只登记，绝不改现状 ──
      if (temporal === "past") {
        // 与现状同值（"我以前就住兴义"）→ 只更新现状行的确认时间与事发时间
        if (same) {
          this.touchRow(same.id, now, confidence, eventTime, validFrom, validTo);
          return {
            changed: false,
            ignored: "past",
            fact: toFact({
              ...same,
              updated_at: now,
              event_time: eventTime ?? same.event_time,
            }),
            previous: [],
          };
        }
        // 同一历史值重复提及 → touch，不重复插行
        const dup = this.db
          .prepare(
            `SELECT * FROM structured_facts
             WHERE actor_id = ? AND entity = ? AND field = ? AND value = ? AND status <> 'active'
             ORDER BY updated_at DESC LIMIT 1`,
          )
          .get(actorId, entity, field, value) as FactRow | undefined;
        if (dup) {
          this.touchRow(dup.id, now, confidence, eventTime, validFrom, validTo);
          return {
            changed: false,
            ignored: "past",
            fact: toFact({ ...dup, updated_at: now, event_time: eventTime ?? dup.event_time }),
            previous: [],
          };
        }
        const pastId = this.insertRow({
          actorId,
          entity,
          field,
          value,
          confidence,
          sourceRef: input.sourceRef,
          status: "historical",
          temporal: "past",
          eventTime,
          validFrom,
          validTo,
          at: now,
        });
        this.enforceHistoricalCapacity(actorId);
        return {
          changed: false,
          ignored: "past",
          fact: toFact(this.rowById(pastId)),
          previous: [],
        };
      }

      // ── 现状陈述通道 ──
      if (same) {
        const liftedConfidence = this.touchCurrentRow(
          same.id,
          now,
          confidence,
          eventTime,
          validFrom,
          validTo,
        );
        return {
          changed: false,
          fact: toFact({
            ...same,
            updated_at: now,
            event_time: eventTime ?? same.event_time,
            confidence: liftedConfidence,
            confirm_count: same.confirm_count + 1,
          }),
          previous: [],
        };
      }

      // 置信度闸：已确认的现状（≥0.8）不接受明显更弱的说法（<?-0.2），
      // 防「随口一句」推翻档案。新值置信度未知时不做限制（旧调用方兼容）。
      const current = actives[actives.length - 1];
      if (
        current &&
        confidence !== null &&
        current.confidence !== null &&
        current.confidence >= CONFIDENT_CURRENT_FLOOR &&
        confidence < current.confidence - CONFIDENCE_OVERWRITE_MARGIN
      ) {
        return {
          changed: false,
          ignored: "low_confidence",
          fact: toFact(current),
          previous: [],
        };
      }

      const id = this.insertRow({
        actorId,
        entity,
        field,
        value,
        confidence,
        sourceRef: input.sourceRef,
        status: "active",
        temporal: "current",
        eventTime,
        validFrom,
        validTo,
        at: now,
      });
      for (const old of actives) {
        // 旧的现状行补一个区间终点（= 新值生效时刻的日期），as-of 查询才有边界
        const closeAt = validFrom ?? now.slice(0, 10);
        this.db
          .prepare(
            `UPDATE structured_facts
             SET status = 'superseded', superseded_at = ?, superseded_by = ?,
                 valid_to = COALESCE(valid_to, ?)
             WHERE id = ? AND status = 'active'`,
          )
          .run(now, id, closeAt, old.id);
      }
      const inserted = this.rowById(id);
      this.enforceCapacity(actorId);
      return { changed: true, fact: toFact(inserted), previous: actives.map(toFact).reverse() };
    });
    const result = run();
    // 实体物化（P0）：非 user 主体写事实时旁路通知生活模型建/更新实体节点。
    if (result && this.entityObserver && entity !== "user") {
      try {
        this.entityObserver(actorId, entity, result.fact.updatedAt, input.sourceRef ?? null);
      } catch (err) {
        console.log(`[structured-facts] 实体物化回调失败（忽略）: ${err}`);
      }
    }
    return result;
  }

  /** 注入实体物化副作用（装配层接线；LifeModelStore.upsertEntity 的薄封装）。 */
  setEntityObserver(
    cb: ((actorId: string, entity: string, seenAt: string, sourceRef: string | null) => void) | null,
  ): void {
    this.entityObserver = cb;
  }

  /** 某 actor 出现过的全部非 user 事实主体（实体物化迁移用，幂等）。 */
  listFactEntities(actorId: string): string[] {
    if (!actorId) return [];
    const rows = this.db
      .prepare(
        `SELECT DISTINCT entity FROM structured_facts
         WHERE actor_id = ? AND entity <> 'user' ORDER BY entity ASC`,
      )
      .all(actorId) as Array<{ entity: string }>;
    return rows.map((r) => r.entity).filter(Boolean);
  }

  /** 同值确认：刷新确认时间/置信度/事发时间/区间（不动 status 与 temporal） */
  private touchRow(
    id: string,
    now: string,
    confidence: number | null,
    eventTime: string | null,
    validFrom: string | null = null,
    validTo: string | null = null,
  ): void {
    this.db
      .prepare(
        `UPDATE structured_facts
         SET updated_at = ?,
             confidence = COALESCE(?, confidence),
             event_time = COALESCE(?, event_time),
             valid_from = COALESCE(?, valid_from),
             valid_to = COALESCE(?, valid_to),
             observed_at = COALESCE(observed_at, ?)
         WHERE id = ?`,
      )
      .run(now, confidence, eventTime, validFrom, validTo, now, id);
  }

  /**
   * 现状同值确认：confirm_count +1；满 CONFIRM_LIFT_AT 次后置信度抬到
   * CONFIRM_LIFT_FLOOR。@returns 更新后的置信度（供返回的 fact 使用）
   */
  private touchCurrentRow(
    id: string,
    now: string,
    confidence: number | null,
    eventTime: string | null,
    validFrom: string | null,
    validTo: string | null,
  ): number | null {
    this.db
      .prepare(
        `UPDATE structured_facts
         SET updated_at = ?,
             confirm_count = confirm_count + 1,
             confidence = CASE
               WHEN confirm_count + 1 >= ? THEN max(COALESCE(confidence, 0), ?)
               ELSE COALESCE(?, confidence)
             END,
             event_time = COALESCE(?, event_time),
             valid_from = COALESCE(?, valid_from),
             valid_to = COALESCE(?, valid_to),
             observed_at = COALESCE(observed_at, ?)
         WHERE id = ?`,
      )
      .run(now, CONFIRM_LIFT_AT, CONFIRM_LIFT_FLOOR, confidence, eventTime, validFrom, validTo, now, id);
    return this.rowById(id).confidence;
  }

  private insertRow(args: {
    actorId: string;
    entity: string;
    field: string;
    value: string;
    confidence: number | null;
    sourceRef?: string | null;
    status: "active" | "historical" | "planned";
    temporal: FactTemporality;
    eventTime: string | null;
    validFrom?: string | null;
    validTo?: string | null;
    at: string;
  }): string {
    const id = nextFactId();
    this.db
      .prepare(
        `INSERT INTO structured_facts
           (id, actor_id, entity, field, value, confidence, source_ref,
            status, created_at, updated_at, temporal, event_time, observed_at,
            valid_from, valid_to)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        args.actorId,
        args.entity,
        args.field,
        args.value,
        args.confidence,
        args.sourceRef ?? null,
        args.status,
        args.at,
        args.at,
        args.temporal,
        args.eventTime,
        args.at,
        args.validFrom ?? null,
        args.validTo ?? null,
      );
    return id;
  }

  private rowById(id: string): FactRow {
    return this.db.prepare(`SELECT * FROM structured_facts WHERE id = ?`).get(id) as FactRow;
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

  /** 历史行上限：淘汰最久未更新的非 active 行（计划行不参与淘汰） */
  private enforceHistoricalCapacity(actorId: string): void {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM structured_facts
         WHERE actor_id = ? AND status NOT IN ('active','planned','lapsed')`,
      )
      .get(actorId) as { n: number };
    if (row.n <= MAX_HISTORICAL_FACTS) return;
    const stale = this.db
      .prepare(
        `SELECT id FROM structured_facts
         WHERE actor_id = ? AND status NOT IN ('active','planned','lapsed')
         ORDER BY updated_at ASC LIMIT ?`,
      )
      .all(actorId, row.n - MAX_HISTORICAL_FACTS) as Array<{ id: string }>;
    const del = this.db.prepare(
      `DELETE FROM structured_facts WHERE id = ? AND status NOT IN ('active','planned','lapsed')`,
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
   * 某字段的历史陈述（temporal='past' 且未被现状取代者）。
   * 「你以前住哪」类问题读这里，「你现在住哪」读 getFact——两条通道互不污染。
   */
  getPastFacts(actorId: string, field?: string, entity = "user"): StructuredFact[] {
    if (!actorId) return [];
    const ent = normalizeFactField(entity) || "user";
    const f = field ? canonicalFactField(field) : "";
    const rows = (
      f
        ? this.db
            .prepare(
              `SELECT * FROM structured_facts
               WHERE actor_id = ? AND entity = ? AND field = ? AND status = 'historical'
               ORDER BY COALESCE(event_time, observed_at) DESC`,
            )
            .all(actorId, ent, f)
        : this.db
            .prepare(
              `SELECT * FROM structured_facts
               WHERE actor_id = ? AND entity = ? AND status = 'historical'
               ORDER BY COALESCE(event_time, observed_at) DESC`,
            )
            .all(actorId, ent)
    ) as FactRow[];
    return rows.map(toFact);
  }

  /* ─────────────────── 未来态：计划、到期降级、证据确认 ─────────────────── */

  /** 某 actor 的全部计划行（upcoming，含已到期未确认的 lapsed） */
  getPlannedFacts(actorId: string, entity = "user"): StructuredFact[] {
    if (!actorId) return [];
    const ent = normalizeFactField(entity) || "user";
    const rows = this.db
      .prepare(
        `SELECT * FROM structured_facts
         WHERE actor_id = ? AND entity = ? AND temporal = 'upcoming'
           AND status IN ('planned','lapsed')
         ORDER BY COALESCE(valid_from, updated_at) ASC`,
      )
      .all(actorId, ent) as FactRow[];
    return rows.map(toFact);
  }

  /**
   * 计划到期扫描（夜间任务调用）：到了计划生效日仍**没有证据**的，降级为
   * lapsed「未确认」。刻意**不**改 temporal、**不**写 past——用户可能根本没去，
   * 系统凭什么说他去了？降级后渲染为〔原计划…未确认是否发生〕，模型不得断言。
   *
   * 判据用严格小于（valid_from < 今天）：生效当天不判，留一天执行窗口。
   * @returns 本轮降级的条数
   */
  sweepUpcomingPlans(actorId: string, at: string | Date): number {
    if (!actorId) return 0;
    const atIso =
      typeof at === "string" ? normalizeObservedAt(at, new Date().toISOString()) : at.toISOString();
    const today = atIso.slice(0, 10);
    const res = this.db
      .prepare(
        `UPDATE structured_facts SET status = 'lapsed', updated_at = ?
         WHERE actor_id = ? AND temporal = 'upcoming' AND status = 'planned'
           AND valid_from IS NOT NULL AND valid_from < ?`,
      )
      .run(atIso, actorId, today);
    if (res.changes > 0) {
      console.info(
        `[structured-facts] ${res.changes} 条计划到期未确认（降级 lapsed，不断言已发生）actor=${actorId}`,
      );
    }
    return res.changes;
  }

  /**
   * 证据确认（唯一的"计划→事实"通道）：只有拿到证据才能把计划转成现实。
   * @param became 证据表明的结果：current=已经发生且仍是现状；past=发生过但已结束
   * @param evidenceRef 证据出处（用户原话 / location:成都 / 票务…），必填
   */
  confirmPlan(
    actorId: string,
    field: string,
    opts: {
      became: "current" | "past";
      evidenceRef: string;
      at?: string;
      confidence?: number;
    },
  ): ApplyFactResult | null {
    const evidence = opts.evidenceRef?.trim();
    if (!evidence) return null; // 无证据 = 不许确认
    const plans = this.getPlannedFacts(actorId).filter(
      (p) => p.field === canonicalFactField(field ?? ""),
    );
    const plan = plans[plans.length - 1];
    if (!plan) return null;

    const applied = this.applyFact({
      actorId,
      field: plan.field,
      value: plan.value,
      temporal: opts.became,
      sourceRef: evidence,
      confidence: opts.confidence ?? 0.95,
      eventTime: plan.eventTime,
      validFrom: plan.validFrom,
      validTo: plan.temporal === "upcoming" && opts.became === "current" ? null : plan.validTo,
      observedAt: opts.at ?? null,
    });
    if (applied) {
      this.db
        .prepare(`UPDATE structured_facts SET status = 'confirmed_plan' WHERE id = ?`)
        .run(plan.id);
      console.info(
        `[structured-facts] 计划确认 actor=${actorId} ${plan.field}=${plan.value} ` +
          `→${opts.became}（证据：${evidence}）`,
      );
    }
    return applied;
  }

  /**
   * 位置证据确认：用户定位/常驻城市落到计划目标地时，才把计划转成现状。
   * 这是"以后 IP 到了新加坡才改写"的那条通道——没有位置就不动。
   * 只对**地理类字段**生效（职业/公司无法用位置证明）。
   * @param location 当前位置文本（如"四川省成都市武侯区"）
   */
  confirmPlansByLocation(
    actorId: string,
    location: string | null | undefined,
    at?: string,
  ): StructuredFact[] {
    const loc = location?.trim();
    if (!loc) return [];
    const confirmed: StructuredFact[] = [];
    for (const plan of this.getPlannedFacts(actorId)) {
      if (plan.field !== "居住地") continue; // 位置只能证明居住地类
      // 双向包含：计划值"成都" ⊂ 定位"四川省成都市"；计划值"四川成都" ⊃ 定位"成都"
      const hit = loc.includes(plan.value) || plan.value.includes(loc);
      if (!hit) continue;
      const res = this.confirmPlan(actorId, plan.field, {
        became: "current",
        evidenceRef: `location:${loc}`,
        at,
      });
      if (res?.changed) confirmed.push(res.fact);
    }
    return confirmed;
  }

  /* ───────────────────── 结构化区间查询（双时态） ───────────────────── */

  /**
   * as-of 查询（valid time，用户世界里"当时"的事实）：
   * "2024 年 6 月他住哪" → 传 asOf='2024-06-15'，返回当时有效的值。
   *
   * 行区间 = [valid_from ?? 观察到的那天, valid_to ?? 至今]。一个字段按时间切段，
   * 取覆盖 asOf 且起点最晚的那一段（多次搬迁时保证只返回一段）。
   * 计划行（upcoming）不参与——计划不是当时的现实。
   */
  getFactsAsOf(
    actorId: string,
    asOf: string,
    opts?: { field?: string; entity?: string },
  ): StructuredFact[] {
    const day = normalizeValidPoint(asOf, "start");
    if (!actorId || !day) return [];
    const ent = normalizeFactField(opts?.entity ?? "user") || "user";
    const field = opts?.field ? canonicalFactField(opts.field) : "";
    const rows = (
      field
        ? this.db
            .prepare(
              `SELECT * FROM structured_facts
               WHERE actor_id = ? AND entity = ? AND field = ? AND temporal <> 'upcoming'`,
            )
            .all(actorId, ent, field)
        : this.db
            .prepare(
              `SELECT * FROM structured_facts
               WHERE actor_id = ? AND entity = ? AND temporal <> 'upcoming'`,
            )
            .all(actorId, ent)
    ) as FactRow[];

    const best = new Map<string, { row: FactRow; from: string }>();
    for (const row of rows) {
      const from = (row.valid_from ?? (row.observed_at ?? row.created_at).slice(0, 10)).slice(0, 10);
      const to = (row.valid_to ?? "9999-12-31").slice(0, 10);
      if (!(from <= day && day <= to)) continue;
      const prev = best.get(row.field);
      // 起点更晚者胜（更贴近 asOf 的那一段）；同起点优先 active
      if (
        !prev ||
        from > prev.from ||
        (from === prev.from && row.status === "active" && prev.row.status !== "active")
      ) {
        best.set(row.field, { row, from });
      }
    }
    return [...best.values()].map((v) => toFact(v.row)).sort((a, b) => a.field.localeCompare(b.field));
  }

  /**
   * knowledge-as-of 查询（system time，"当时系统以为"的事实）：
   * 用 observed_at / superseded_at 判定，不看 valid 区间。
   * 用途：调试与审计——"上周三系统认为我是做什么的"。
   */
  getKnownFactsAsOf(
    actorId: string,
    asOf: string,
    opts?: { field?: string; entity?: string },
  ): StructuredFact[] {
    const day = normalizeValidPoint(asOf, "start");
    if (!actorId || !day) return [];
    const ent = normalizeFactField(opts?.entity ?? "user") || "user";
    const field = opts?.field ? canonicalFactField(opts.field) : "";
    const rows = (
      field
        ? this.db
            .prepare(
              `SELECT * FROM structured_facts
               WHERE actor_id = ? AND entity = ? AND field = ?
                 AND status IN ('active','superseded')`,
            )
            .all(actorId, ent, field)
        : this.db
            .prepare(
              `SELECT * FROM structured_facts
               WHERE actor_id = ? AND entity = ?
                 AND status IN ('active','superseded')`,
            )
            .all(actorId, ent)
    ) as FactRow[];

    const best = new Map<string, { row: FactRow; at: string }>();
    for (const row of rows) {
      const known = (row.observed_at ?? row.created_at).slice(0, 10);
      const closed = row.superseded_at ? row.superseded_at.slice(0, 10) : null;
      if (known > day) continue;
      if (closed && closed <= day) continue;
      const prev = best.get(row.field);
      if (!prev || known > prev.at) best.set(row.field, { row, at: known });
    }
    return [...best.values()].map((v) => toFact(v.row)).sort((a, b) => a.field.localeCompare(b.field));
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
  renderForPrompt(
    actorId: string,
    groundedFields?: Set<string>,
    entity = "user",
    opts?: { suppressedFields?: ReadonlySet<string> },
  ): string | null {
    const facts = this.getActiveFacts(actorId, entity);
    const activeFields = new Set(facts.map((f) => f.field));
    // 只有历史陈述、没有现状的字段（用户只说过"我以前住浙江"）：
    // 不冒充现状，但要进入模型视野——否则它会当作"从没听过"。
    const pastOnly = this.getPastFacts(actorId, undefined, entity)
      .filter((f) => !activeFields.has(f.field))
      .reduce<StructuredFact[]>((acc, f) => {
        if (!acc.some((x) => x.field === f.field)) acc.push(f);
        return acc;
      }, []);
    const plannedFacts = this.getPlannedFacts(actorId, entity);
    if (facts.length === 0 && pastOnly.length === 0 && plannedFacts.length === 0) return null;

    const day = (iso: string | null | undefined): string =>
      iso ? iso.slice(5, 10).replace("-", "/") : "";

    const lines = facts.slice(0, 20).map((f) => {
      const updatedAt = day(f.updatedAt);
      const grounded = groundedFields?.has(f.field)
        ? " ← 本轮提问相关，基于此回答"
        : "";
      // 「此前」合并两条来源（2026-10-19）：
      //   ① superseded 链 = 曾经是现状、后来被新值取代的旧值；
      //   ② historical 行 = 用户用过去时态讲的历史（"我以前住浙江"）。
      // 二者都是"已结束的旧状态"，对模型而言同义，统一进「此前」——用户问
      // "你以前住哪"能直接命中，问"你现在住哪"仍只读当前值。
      const seenPrev = new Set<string>([f.value]);
      const previous = [
        ...this.getHistoryFor(actorId, f.id, 1, entity),
        ...this.getPastFacts(actorId, f.field, entity),
      ]
        .filter((p) => {
          if (seenPrev.has(p.value)) return false;
          seenPrev.add(p.value);
          return true;
        })
        .slice(0, 2);
      const historyLine =
        previous.length > 0
          ? `（此前：${previous
              .map((p) => `${p.value}，${p.eventTime ?? day(p.updatedAt)}`)
              .join("；")}）`
          : "";
      // 事发时间（用户原话里的时间线索）与登记时间分开标注——模型据此区分
      // 「事情何时发生」与「什么时候告诉我的」
      const eventSuffix = f.eventTime ? `，事发 ${f.eventTime}` : "";
      // 低置信标注（ChatGPT 式 Confidence，2026-10-11）：只标低置信条目，
      // 提示模型转述时不要把话说满——治「画像精确度/用词准确性」
      const lowConfidence =
        f.confidence !== null && f.confidence < 0.6
          ? "〔置信度低：据你随口提及，转述时不要把话说满〕"
          : "";
      // 软抑制（"别再提这个"）：不删数据，只让模型不主动挑起来。
      // 用户主动问起时仍可正常引用——所以是标记而不是移除。
      const muted = opts?.suppressedFields?.has(f.field)
        ? "〔用户要求别再主动提；他问起时才回答〕"
        : "";
      return `- ${f.field}：${f.value}（${updatedAt} 记录${eventSuffix}）${historyLine}${grounded}${lowConfidence}${muted}`;
    });
    const pastLines = pastOnly
      .slice(0, 8)
      .map(
        (f) =>
          `- ${f.field}：〔历史〕${f.value}（${f.eventTime ?? day(f.observedAt)}；当前未知）`,
      );
    // 未来态（计划）：永远与现状分行的独立事实类型。pending=还没到点；
    // lapsed=到点了但没有任何证据 → 只能标"未确认"，不得断言发生。
    const planLines = plannedFacts
      .slice(0, 6)
      .map((p) => {
        const when = p.validFrom ?? "时点未定";
        return p.planState === "lapsed"
          ? `- ${p.field}：〔原计划〕${p.value}（原定 ${when} 起；**未确认是否发生**，除非用户明确说过做到了，不要当成已发生）`
          : `- ${p.field}：〔计划〕${p.value}（${when} 起；尚未发生，不要当成现状）`;
      });
    return [
      "【用户档案·结构化事实】",
      "（以下是用户确定信息的精确记录，确定性高于其他记忆来源。被问及对应",
      "字段时直接引用当前值，不要靠语义检索猜测。带「此前」或〔历史〕的是已经",
      "结束的旧状态，仅供追溯、不代表现状；括注里「记录」是这条信息的登记时间，",
      "「事发」是事情本身发生的时间，两者不要混用——用户问过去就读「此前/事发」，",
      "问现状只读当前值。〔计划〕是用户说过要做、但还没发生的事；〔原计划〕是时点",
      "已过且没有任何证据表明做了的事——两者都不得当成现状或已发生，只有用户",
      "明确说做到了才可以转为事实。仅当用户最新消息明确更正时以最新消息为准——",
      "此时系统会自动登记字段变更）",
      "（称呼礼仪：称呼用户时优先用用户明确指定的称呼（如「叫我王哥」的",
      "「王哥」）；没有指定时用「姓氏+先生/女士」（如「王先生」）或自然省略",
      "称呼。称呼/姓名字段的大名（如「王铭川」）只是事实记录，供问答引用，",
      "不要在回复里连名带姓直呼用户）",
      ...lines,
      ...pastLines,
      ...planLines,
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
      // 用户说"别记我住哪了"时，未执行的计划也一起下线——否则忘掉现状后
      // 档案里还留一条"〔计划〕成都"，等于没忘干净。
      const actives = this.db
        .prepare(
          `SELECT id FROM structured_facts
           WHERE actor_id = ? AND entity = ? AND field = ?
             AND status IN ('active','planned','lapsed')`,
        )
        .all(actor, entity, canonical) as Array<{ id: string }>;
      if (actives.length === 0) return 0;
      const clear = this.db.prepare(
        `UPDATE structured_facts
         SET status = 'superseded', superseded_at = ?, superseded_by = 'forget'
         WHERE id = ? AND status IN ('active','planned','lapsed')`,
      );
      for (const row of actives) clear.run(now, row.id);
      return actives.length;
    });
    return run();
  }

  /**
   * 实体级遗忘（2026-10-20，Life Model P2）：用户要求「忘掉我妹妹」时，把该实体
   * 主体名下的全部事实行物理删除。与 clearFact 的字段级 supersede 不同——这是隐私
   * 级删除，与 LifeModelStore.deleteEntity 配套「实体 + 边 + 轨迹 + 事实」三清。
   * @returns 删除行数
   */
  deleteFactsByEntity(actorId: string, entity: string): number {
    const actor = actorId?.trim();
    const e = entity?.trim();
    if (!actor || !e) return 0;
    return this.db
      .prepare(`DELETE FROM structured_facts WHERE actor_id = ? AND entity = ?`)
      .run(actor, e).changes;
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
