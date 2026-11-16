/**
 * 用户事实主库（User Fact Store）—— 事实级唯一存储（canonical semantic facts）
 *
 * 解决的问题：此前"用户住在杭州"这类稳定事实同时落在 Mem0 / humanLike 记忆图 /
 * KV 结构化槽位 / USER_PROFILE.md 四个库，更新时机和覆盖逻辑各不相同——
 * 更新类事实（搬家、换工作）需要各库分别覆盖，任何一库漏更就自相矛盾。
 *
 * 架构定位（2026-11-13 收敛后）：
 *   每轮对话 →（档案字段类直接落 structured_facts 权威库，本库不收）
 *   夜间巩固 → 认不出标准档案字段的长尾事实落本库 upsertFact
 *              （subject 归一 + provenance + 置信度，冲突即替换）
 *   消费方   → proactivity 偏好变更触发器（getFacts(kind="preference)"）
 *
 * 本库**不进 prompt**——prompt 的事实块只读 structured_facts 权威库。
 * 档案字段类事实（称呼/居住地/职业/配偶…）在写入与加载两侧都被拒收/清扫：
 *   - upsertFact 拒收（detectProfileFieldFromText 命中）；
 *   - load 清扫存量（subject 命中 LEGACY_PROFILE_SUBJECT_RE 或值可识别为
 *     档案字段）——老实例写进去的「我是王哥」「用户已婚，妻子是X」在
 *     第一次读取时自动退场，权威库已有同语义字段，零信息损失。
 *
 * 设计要点：
 * - 主键 = kind + 归一化 subject（"喜欢X"取宾语、"我住在X"取地点、"我是X"取身份），
 *   同主键新值替换旧值而不是累积——跨会话"越来越了解你"且不自相矛盾；
 * - 每条事实带 sources（来源链路）与 confidence，可审计可回溯；
 * - 持久化 per-actor JSON 文件（data/user-facts/<actorId>.json），写路径串行队列；
 * - 派生同步只做归并：与事实冲突的旧槽位行被替换，未提升的近期捕获行保留。
 */

import { getDataDir } from "../config/data-dir.js";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { detectProfileFieldFromText } from "../memory/fact-vocabulary.js";

export type UserFactKind = "preference" | "identity" | "constraint" | "fact";

export interface UserFact {
  /** `${kind}:${subject}` 的 sha1 前 16 位 */
  id: string;
  kind: UserFactKind;
  /** 归一化主语/槽位（如 "居住地"、"项目"、"简洁回答"） */
  subject: string;
  /** 事实陈述（第三人称/无主语短句，由抽取/巩固侧语义改写保证，本层不做正则剥字） */
  value: string;
  /** 0-1，多次观察取最大值 */
  confidence: number;
  /** 被观察到的次数（同 subject 重复出现说明稳定） */
  seenCount: number;
  /** 来源链路（最多保留 3 条） */
  sources: string[];
  /**
   * 冲突裁决退场的旧值（M3：同 subject 新值胜出时，旧值置 rejected 并保留审计）。
   * 裁决优先级：显式纠正 > 新近 > 置信度 > 证据数。
   */
  retiredValues?: Array<{ value: string; status: "rejected"; retiredAt: string; reason?: string }>;
  createdAt: string;
  updatedAt: string;
}

export interface UserFactUpsertInput {
  kind: UserFactKind;
  value: string;
  source?: string;
  confidence?: number;
}

interface FactFileShape {
  version: 1;
  updatedAt: string;
  facts: UserFact[];
}

const MAX_FACTS = 200;

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeSubject(text: string): string {
  return text
    .trim()
    .replace(/[\s，。；！？、,.;:!?'""''「」『』（）()\[\]【】~～]/g, "")
    .slice(0, 12);
}

/**
 * 从事实文本提取归一化 subject（冲突归并的 key）。
 * - preference：取"喜欢/讨厌/习惯"后的宾语（"喜欢简洁的回答" → "简洁的回答"）；
 * - identity："我是X" → "身份"（身份变化应互相替换）；
 * - constraint：取"不要/不能/忌"后的宾语；
 * - fact：居住地/项目/职业归类，其余取归一化文本前 12 字。
 */
export function extractFactSubject(kind: UserFactKind, text: string): string {
  const t = text.trim();
  if (kind === "preference") {
    const m = t.match(/(?:喜欢|偏好|不喜欢|讨厌|习惯)(?:上|)?([^，。；！？,.;!?\s]{1,12})/);
    if (m?.[1]) return normalizeSubject(m[1]);
    return normalizeSubject(t) || "通用偏好";
  }
  if (kind === "identity") {
    return "身份";
  }
  if (kind === "constraint") {
    const m = t.match(/(?:不要|不能|别|避免|忌|过敏)(?:吃|喝)?([^，。；！？,.;!?\s]{1,12})/);
    if (m?.[1]) return normalizeSubject(m[1]);
    return normalizeSubject(t) || "通用约束";
  }
  // fact
  if (/^我是/.test(t)) return "身份";
  const loc = t.match(/(?:我住在|住在|定居在?)([\u4e00-\u9fa5a-zA-Z]{2,12})/);
  if (loc?.[1]) return "居住地";
  if (/(?:我的项目|我在做|我在开发|项目是)/.test(t)) return "项目";
  if (/(?:我的职业|我的工作是|我在).{0,6}(?:工作|上班)/.test(t)) return "职业";
  // 亲密关系单值主题（root fix）：「我的老婆是X」「我的未来老婆是X」「X才是正主」
  // 等表述归一到同一 subject，值变化时 latest-wins 替换，不再按字面各存一条
  if (
    /(?:我的|未来的?|自家的)(?:老婆|媳妇|妻子|夫人|爱人|未婚妻|未婚夫|对象|正主|女朋友|女友|男朋友|男友)|(?:老婆|媳妇|妻子|未婚妻|对象|正主)(?:是|叫|才是)/.test(
      t,
    )
  ) {
    return "配偶/伴侣";
  }
  return normalizeSubject(t) || "其他";
}

function factId(kind: UserFactKind, subject: string): string {
  return createHash("sha1").update(`${kind}:${subject}`).digest("hex").slice(0, 16);
}

function sanitizeSegment(actorId: string): string {
  return actorId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64) || "anonymous";
}

/**
 * 旧词表 subject 的档案字段判定（存量清扫用，2026-11-13）。
 *
 * 夜间巩固改走权威库之前，本库曾用一套自己的 subject（身份/居住地/配偶/伴侣…）
 * 存过档案字段类事实——现在这些字段的唯一权威是 structured_facts，存量副本
 * 在 load 时自动退场。只按 subject 前缀判（保守）：认不出的一律保留，
 * 宁可多留一条长尾事实，也不误删真实信息。
 */
const LEGACY_PROFILE_SUBJECT_RE =
  /^(?:身份|姓名|名字|称呼|昵称|居住地|住址|所在|定居|职业|职务|岗位|行业|配偶|伴侣|婚姻|生日|出生|学历|学校|毕业|公司|单位|雇主|技术栈|技术方向|编程语言)/;

/** 是否为「权威库已持有同语义字段」的档案字段副本（加载时清扫）。 */
export function isLegacyProfileFact(fact: Pick<UserFact, "subject" | "value">): boolean {
  const subj = (fact.subject || "").trim();
  if (subj && LEGACY_PROFILE_SUBJECT_RE.test(subj)) return true;
  // subject 缺失/不像档案字段时，再从值里认一次（「我叫X」「用户住在X」等句式）
  return detectProfileFieldFromText(fact.value) !== null;
}

export class UserFactStore {
  private readonly cache = new Map<string, FactFileShape>();
  private readonly writeChains = new Map<string, Promise<void>>();

  constructor(private readonly dir: string = join(getDataDir(), "user-facts")) {}

  private filePath(actorId: string): string {
    return join(this.dir, `${sanitizeSegment(actorId)}.json`);
  }

  private async load(actorId: string): Promise<FactFileShape> {
    const cached = this.cache.get(actorId);
    if (cached) return cached;
    let shape: FactFileShape = { version: 1, updatedAt: nowIso(), facts: [] };
    try {
      const raw = await readFile(this.filePath(actorId), "utf-8");
      const parsed = JSON.parse(raw) as Partial<FactFileShape>;
      if (Array.isArray(parsed.facts)) {
        shape = {
          version: 1,
          updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : nowIso(),
          facts: parsed.facts.filter(
            (f): f is UserFact =>
              !!f &&
              typeof f.id === "string" &&
              typeof f.kind === "string" &&
              typeof f.value === "string" &&
              f.value.trim().length > 0,
          ),
        };
      }
    } catch {
      /* 文件不存在或损坏 → 空库起步 */
    }
    // 存量档案字段副本清扫（2026-11-13）：老实例写进去的「我是王哥」「用户
    // 已婚，妻子是X」等条目，权威库（structured_facts）已持有同语义字段，
    // 第一次读取时自动退场并写回——此后每次加载都是干净的。
    const kept = shape.facts.filter((f) => !isLegacyProfileFact(f));
    if (kept.length !== shape.facts.length) {
      const removed = shape.facts.length - kept.length;
      shape = { ...shape, facts: kept, updatedAt: nowIso() };
      console.log(
        `[UserFactStore] 清扫档案字段副本 ${removed} 条（权威归 structured_facts）：actor=${actorId}`,
      );
      this.persist(actorId, shape);
    }
    this.cache.set(actorId, shape);
    return shape;
  }

  private persist(actorId: string, shape: FactFileShape): void {
    const prev = this.writeChains.get(actorId) ?? Promise.resolve();
    const next = prev
      .then(async () => {
        const path = this.filePath(actorId);
        await mkdir(dirname(path), { recursive: true });
        const tmp = `${path}.tmp`;
        await writeFile(tmp, JSON.stringify(shape, null, 2), "utf-8");
        await rename(tmp, path);
      })
      .catch((err) => {
        console.log(`[UserFactStore] persist failed for ${actorId}: ${err}`);
      });
    this.writeChains.set(actorId, next);
  }

  /** 等待所有待写盘完成（测试与关停用）。 */
  async flush(actorId?: string): Promise<void> {
    if (actorId) {
      await this.writeChains.get(actorId);
      return;
    }
    await Promise.all([...this.writeChains.values()]);
  }

  /**
   * 写入/更新一条事实：同 kind+subject 的新值替换旧值（latest-wins），
   * seenCount 递增、confidence 取最大、sources 追加去重（cap 3）。
   *
   * 2026-11-13（词表统一）：标准档案字段（称呼/职业/居住地/技术栈/生日/
   * 公司/学历）**不收**——它们的唯一权威是 structured_facts。本库只装长尾
   * 事实。此前两边各存一份、字段名还不一样（「身份」vs「称呼」），召回时
   * 自相矛盾。现在这里直接拒收，由调用方改写权威库。
   */
  async upsertFact(actorId: string, input: UserFactUpsertInput): Promise<UserFact | null> {
    const value = input.value?.trim();
    if (!value) return null;
    const profile = detectProfileFieldFromText(value);
    if (profile) {
      console.warn(
        `[UserFactStore] 拒收档案字段类事实（权威归 structured_facts）：${profile.field}=${profile.value}` +
          `（原文：${value.slice(0, 40)}）`,
      );
      return null;
    }
    const kind = input.kind;
    const subject = extractFactSubject(kind, value);
    const id = factId(kind, subject);
    const shape = await this.load(actorId);

    const now = nowIso();
    const existing = shape.facts.find((f) => f.id === id);
    if (existing) {
      if (existing.value.trim() !== value) {
        // 同 subject 新值胜出：旧值退场置 rejected（保留审计，不静默丢弃）。
        existing.retiredValues = [
          ...(existing.retiredValues ?? []),
          { value: existing.value, status: "rejected" as const, retiredAt: now, reason: input.source },
        ].slice(-3);
      }
      existing.value = value;
      existing.confidence = Math.max(existing.confidence, input.confidence ?? 0.7);
      existing.seenCount += 1;
      existing.updatedAt = now;
      if (input.source && !existing.sources.includes(input.source)) {
        existing.sources.push(input.source);
        if (existing.sources.length > 3) existing.sources = existing.sources.slice(-3);
      }
      this.persist(actorId, shape);
      return existing;
    }

    const fact: UserFact = {
      id,
      kind,
      subject,
      value,
      confidence: Math.max(0, Math.min(1, input.confidence ?? 0.7)),
      seenCount: 1,
      sources: input.source ? [input.source] : [],
      createdAt: now,
      updatedAt: now,
    };
    shape.facts.push(fact);
    // 容量上限：按 updatedAt 淘汰最旧
    if (shape.facts.length > MAX_FACTS) {
      shape.facts.sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
      shape.facts = shape.facts.slice(-MAX_FACTS);
    }
    shape.updatedAt = now;
    this.persist(actorId, shape);
    return fact;
  }

  async getFacts(
    actorId: string,
    opts?: { kind?: UserFactKind; limit?: number },
  ): Promise<UserFact[]> {
    const shape = await this.load(actorId);
    let facts = [...shape.facts];
    if (opts?.kind) facts = facts.filter((f) => f.kind === opts.kind);
    facts.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return typeof opts?.limit === "number" ? facts.slice(0, opts.limit) : facts;
  }

  async stats(actorId: string): Promise<{ total: number; byKind: Record<string, number> }> {
    const facts = await this.getFacts(actorId);
    const byKind: Record<string, number> = {};
    for (const f of facts) byKind[f.kind] = (byKind[f.kind] ?? 0) + 1;
    return { total: facts.length, byKind };
  }
}
