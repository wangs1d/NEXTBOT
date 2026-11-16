/**
 * ProfileRouter（画像 v2 统一输出单点）。
 *
 * 两视图 + 工具取数口：
 *   - query(actorId, tags)：按类取（structured_facts category 直查）——策略层
 *     与 profile.query 工具的取数口（"要知道作息就去 rhythm 类取"）。
 *   - brief(actorId)：浅层风格摘要（user-style-brief 收编为视图之一）。
 *
 * 按需注入（2026-11-12 根修）：主对话的画像注入不再走本文件的类级路由——
 * 意图词表（classifyIntentFromText / INTENT_TAG_ROUTES / routeIntentTags）与
 * identity 类恒带层（SNAPSHOT_CONSTANT_TAGS）整体退役。词表永远追不上语言的
 * 自然变化（「多少岁」漏出 /多大|年龄|几岁/ 即现行案例），恒带全量则是
 * 「问年龄连带报名字」的结构性根因。业界共识（Mem0/Zep/ChatGPT）：读取是
 * query 条件的。现行通道：
 *   - T2 字面命中 + T3 语义召回：见 brain/profile-semantic-recall.ts
 *     （轮前预取 + buildUserFactsBlock 同步打分），命中才注入、未命中零注入；
 *   - Agent 自查：profile.query 工具（本类 query()，Letta 型兜底通道）；
 *   - 恒带只保留「称呼」单字段（SNAPSHOT_CONSTANT_FIELDS）——每轮回复都要
 *     用它称呼用户，这是 Letta core memory 量级的合理常驻。
 *
 * 纪律：
 *   - 宁缺勿错：无数据返回 null/空，调用方回退无画像行为，绝不编造；
 *   - 敏感类（health）不进自动注入——只能被用户直提或 profile.query 显式取；
 *   - TTL 缓存（类级读缓存，画像更新有延迟容忍）。
 */
import { taxonomyTagFor, TAG_LABELS, type ProfileTag } from "../agentic-memory/field-taxonomy.js";
import type { StructuredFact } from "../agentic-memory/structured-fact-store.js";
import { createUserStyleBrief, type UserStyleBriefReader } from "./user-style-brief.js";

/**
 * 主对话恒带字段（2026-11-12 从「identity/comms/aversion 三类全量」收缩）：
 * 只有称呼是每轮回复都必需的（怎么称呼用户）——Letta core memory 量级的
 * 合理常驻；生日/职业/居住地等全部改走 query 相关性召回，未命中零注入。
 */
export const SNAPSHOT_CONSTANT_FIELDS: readonly string[] = ["称呼"];
/** 敏感类：永不进自动注入 */
export const SENSITIVE_TAGS: ProfileTag[] = ["health"];

/** 共享单点（bootstrap 装配；prompt-context-builder / 工具层取用） */
let sharedRouter: ProfileRouter | null = null;
export function setProfileRouter(router: ProfileRouter | null): void {
  sharedRouter = router;
}
export function getProfileRouter(): ProfileRouter | null {
  return sharedRouter;
}

export type ProfileFactLine = {
  field: string;
  value: string;
  tag: ProfileTag;
  /** 展示标签（中文） */
  label: string;
  updatedAt: string;
};

export type ProfileRouterDeps = {
  factStore: {
    getActiveFactsByCategory(
      actorId: string,
      categories: readonly string[],
      entity?: string,
      limit?: number,
    ): StructuredFact[];
  };
  /**
   * 字段命中信号（可选，structured-fact-store.matchFieldsInText）：用户本轮
   * 原话里出现的字段名 → 直接召回。这是字面直提信号里精度最高的一级
   * （用户直提 > 语义召回兜底）。
   */
  matchFieldsInText?: (actorId: string, text: string) => StructuredFact[];
  /** 字段或值命中（直提信号的完整版：值匹配兜住"不吃→香菜"这类反查） */
  matchFactsInText?: (actorId: string, text: string) => StructuredFact[];
  /** 画像全文读取（brief 视图的数据源，UserProfileAggregator.readProfile） */
  readProfile: (actorId: string) => Promise<string>;
  now?: () => number;
  /** 缓存 TTL（毫秒），缺省 5 分钟 */
  ttlMs?: number;
};

const DEFAULT_TTL_MS = 5 * 60_000;

function factLine(f: StructuredFact): ProfileFactLine {
  const tag = (f.category as ProfileTag) || taxonomyTagFor(f.field);
  return { field: f.field, value: f.value, tag, label: TAG_LABELS[tag] ?? tag, updatedAt: f.updatedAt };
}

export class ProfileRouter {
  private readonly ttl: number;
  private readonly now: () => number;
  private readonly factCache = new Map<string, { at: number; facts: StructuredFact[] }>();
  private readonly briefReader: UserStyleBriefReader;

  constructor(readonly deps: ProfileRouterDeps) {
    this.ttl = deps.ttlMs ?? DEFAULT_TTL_MS;
    this.now = deps.now ?? (() => Date.now());
    this.briefReader = createUserStyleBrief({ readProfile: deps.readProfile, now: this.now });
  }

  /** 按类取（多类合并，按更新时间倒序）。 */
  query(
    actorId: string,
    tags: ProfileTag | ProfileTag[],
    opts: { limit?: number } = {},
  ): ProfileFactLine[] {
    const wanted = (Array.isArray(tags) ? tags : [tags]).filter(Boolean) as ProfileTag[];
    if (!actorId || wanted.length === 0) return [];
    const facts = this.factsFor(actorId, wanted);
    return facts.map(factLine);
  }

  /** 浅层风格摘要（旁路话术视图，user-style-brief 收编）。 */
  brief(actorId: string): Promise<string | null> {
    return this.briefReader(actorId);
  }

  /** 隐私级联：清空类级读缓存（fact store 的 purge 由调用方直连）。 */
  invalidate(actorId?: string): void {
    if (!actorId) {
      this.factCache.clear();
      return;
    }
    for (const key of [...this.factCache.keys()]) {
      if (key.startsWith(`${actorId}|`)) this.factCache.delete(key);
    }
  }

  private factsFor(actorId: string, tags: ProfileTag[]): StructuredFact[] {
    const key = `${actorId}|${[...tags].sort().join(",")}`;
    const hit = this.factCache.get(key);
    if (hit && this.now() - hit.at < this.ttl) return hit.facts;
    const facts = this.deps.factStore.getActiveFactsByCategory(actorId, tags, "user", 60);
    this.factCache.set(key, { at: this.now(), facts });
    return facts;
  }
}
