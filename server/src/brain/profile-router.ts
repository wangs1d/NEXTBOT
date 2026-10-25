/**
 * ProfileRouter（画像 v2 统一输出单点，2026-10-23）。
 *
 * 三视图 + 一张意图路由表：
 *   - query(actorId, tags)：按类取（structured_facts category 直查）——策略层
 *     与 profile.query 工具的取数口（"要知道作息就去 rhythm 类取"）。
 *   - snapshot(actorId, {intent, tokenBudget})：主对话瘦身全量——恒带层
 *     （identity/comms/aversion）+ 按意图路由层 + 近期变化，token 预算裁剪。
 *     替代 prompt-context-builder 的画像全量拼块。
 *   - brief(actorId)：浅层风格摘要（user-style-brief 收编为视图之一）。
 *
 * 纪律：
 *   - 宁缺勿错：无数据返回 null/空，调用方回退无画像行为，绝不编造；
 *   - 敏感类（health）不进 snapshot 自动注入——只能被显式 query 取（用户主动
 *     提起该话题时由意图路由带入，从"靠提示词自觉"变成"路由层结构性保证"）；
 *   - TTL 缓存（类级读缓存，画像更新有延迟容忍）。
 */
import { taxonomyTagFor, TAG_LABELS, type ProfileTag } from "../agentic-memory/field-taxonomy.js";
import type { StructuredFact } from "../agentic-memory/structured-fact-store.js";
import { createUserStyleBrief, type UserStyleBriefReader } from "./user-style-brief.js";

/** 主对话恒带层（放稳定前缀，保前缀缓存命中） */
export const SNAPSHOT_CONSTANT_TAGS: ProfileTag[] = ["identity", "comms", "aversion"];
/** 敏感类：永不进 snapshot 自动注入 */
export const SENSITIVE_TAGS: ProfileTag[] = ["health"];
/** 意图族 → 路由类（确定性映射；未知意图回退空 = 只有恒带层） */
const INTENT_TAG_ROUTES: Record<string, ProfileTag[]> = {
  schedule: ["rhythm"],
  reminder: ["rhythm"],
  deadline: ["goals", "rhythm"],
  chat: ["preference"],
  companion: ["preference"],
  spending: ["spending"],
  finance: ["spending"],
  relations: ["relations"],
  messaging: ["relations"],
  travel: ["preference", "spending"],
  work: ["rhythm", "goals"],
};

export function routeIntentTags(intent?: string): ProfileTag[] {
  const key = String(intent ?? "").trim().toLowerCase();
  return INTENT_TAG_ROUTES[key] ?? [];
}

/**
 * 从用户本轮文本粗分类意图族（零 LLM 词表路由；命中不了返回 undefined =
 * 只注入恒带层）。这是"动态路由"的第一级——按本轮任务取需要的画像类。
 */
export function classifyIntentFromText(text: string): string | undefined {
  const t = String(text ?? "");
  if (/(作业|截止|提交|答辩|考试|deadline|due|交报告)/.test(t)) return "deadline";
  if (/(提醒|闹钟|日程|开会|安排|几点|待办|约会|日程表|出行|出门)/.test(t)) return "schedule";
  if (/(买|价格|降价|降到|便宜|账单|花销|预算|订阅|优惠券|下单|比价)/.test(t)) return "spending";
  if (/(我妈|我爸|我老婆|我老公|朋友|闺蜜|帮我问|发消息给|转告|同事|导师|老板)/.test(t)) return "relations";
  if (/(打电话|通话|呼叫我)/.test(t)) return "companion";
  if (/(出去|喝一杯|吃什么|附近|推荐|想玩|周末去)/.test(t)) return "travel";
  return undefined;
}

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

export type ProfileSnapshot = {
  /** 恒带层行（identity/comms/aversion） */
  constant: string;
  /** 按意图路由的行（无路由意图为空串） */
  routed: string;
  /** 检索命中了多少类（观测用） */
  tagsUsed: ProfileTag[];
  /** 估算 token（中文 ≈ 字符/1.5，粗口径仅用于预算裁剪与对比报告） */
  estTokens: number;
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
   * 原话里出现的字段名 → 直接召回其类。这是三级召回时机里精度最高的一级
   * （用户直提 > 意图词表路由）。
   */
  matchFieldsInText?: (actorId: string, text: string) => StructuredFact[];
  /** 字段或值命中（T2 直提信号的完整版：值匹配兜住"不吃→香菜"这类反查） */
  matchFactsInText?: (actorId: string, text: string) => StructuredFact[];
  /** 画像全文读取（brief 视图的数据源，UserProfileAggregator.readProfile） */
  readProfile: (actorId: string) => Promise<string>;
  now?: () => number;
  /** 缓存 TTL（毫秒），缺省 5 分钟 */
  ttlMs?: number;
};

const DEFAULT_TTL_MS = 5 * 60_000;
/** 中文 token 粗估：1 token ≈ 1.5 字符（同模型族内一致即可，用于预算裁剪与对比） */
function estTokens(text: string): number {
  return Math.ceil(text.length / 1.5);
}

function factLine(f: StructuredFact): ProfileFactLine {
  const tag = (f.category as ProfileTag) || taxonomyTagFor(f.field);
  return { field: f.field, value: f.value, tag, label: TAG_LABELS[tag] ?? tag, updatedAt: f.updatedAt };
}

function renderLines(lines: ProfileFactLine[]): string {
  return lines.map((l) => `${l.field}:${l.value}`).join("\n");
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

  /**
   * 主对话视图：恒带层 + 按意图路由层，token 预算裁剪。
   * health 类结构性排除（只能显式 query）；无画像返回 null（回退无画像行为）。
   */
  snapshot(
    actorId: string,
    opts: { intent?: string; tokenBudget?: number; now?: Date } = {},
  ): ProfileSnapshot | null {
    const budget = opts.tokenBudget ?? 800;
    const routedTags = routeIntentTags(opts.intent).filter((t) => !SENSITIVE_TAGS.includes(t));
    const constantFacts = this.factsFor(actorId, SNAPSHOT_CONSTANT_TAGS);
    if (constantFacts.length === 0 && routedTags.length === 0) return null;

    const constantLines = constantFacts.map(factLine);
    let routedLines: ProfileFactLine[] = [];
    if (routedTags.length > 0) {
      const routedFacts = this.factsFor(actorId, routedTags);
      const routedSet = new Set(constantFacts.map((f) => f.id));
      routedLines = routedFacts.filter((f) => !routedSet.has(f.id)).map(factLine);
    }

    // 预算裁剪：恒带层优先保全（前缀缓存友好），路由层按预算填充
    let constantText = renderLines(constantLines);
    let used = estTokens(constantText);
    const keptRouted: ProfileFactLine[] = [];
    for (const line of routedLines) {
      const lineTokens = estTokens(`${line.field}:${line.value}`);
      if (used + lineTokens > budget) continue;
      keptRouted.push(line);
      used += lineTokens;
    }
    // 恒带层自身超预算：按行裁剪（保 identity 优先级——行序已是 updated_at 倒序，
    // 这里简单按行裁到预算内）
    if (used > budget) {
      const lines = constantText.split("\n");
      const kept: string[] = [];
      let t = 0;
      for (const line of lines) {
        const lt = estTokens(line);
        if (t + lt > budget) break;
        kept.push(line);
        t += lt;
      }
      constantText = kept.join("\n");
      used = t;
    }

    const tagsUsed = [
      ...new Set([...constantLines, ...keptRouted].map((l) => l.tag)),
    ] as ProfileTag[];
    const routedText = renderLines(keptRouted);
    const total = `${constantText}\n${routedText}`.trim();
    if (!total) return null;
    return { constant: constantText, routed: routedText, tagsUsed, estTokens: estTokens(total) };
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

// ─────────────── 召回时机（三级合并） ───────────────

/**
 * 一轮对话的召回类集合 = 三级时机合并：
 *   T0 恒带层（每轮）：identity/comms/aversion——私人管家的底线认知；
 *   T1 意图路由（任务信号）：本轮在办什么任务 → 取该任务需要的类；
 *   T2 字段命中（直提信号）：用户原话里出现画像字段名（"咖啡还喝拿铁吗"）→
 *      直接召回该字段所在类——词表路由漏掉时这张网兜住，精度最高。
 * health 敏感类结构性排除（只能 profile.query 显式取）。
 * fieldHits 返回本轮命中的字段名（诊断/评测用）。
 */
export function recallTagsForTurn(
  router: ProfileRouter | null,
  actorId: string,
  text: string,
  opts: { intent?: string } = {},
): { categories: ProfileTag[]; fieldHits: string[] } {
  const intent = opts.intent ?? classifyIntentFromText(text);
  const intentTags = routeIntentTags(intent);
  const fieldHits: string[] = [];
  const hitTags = new Set<ProfileTag>();
  try {
    const hits =
      router?.deps.matchFactsInText?.(actorId, text) ??
      router?.deps.matchFieldsInText?.(actorId, text) ??
      [];
    for (const f of hits) {
      fieldHits.push(f.field);
      hitTags.add((f.category as ProfileTag) || taxonomyTagFor(f.field));
    }
  } catch {
    /* 字段命中信号失败不影响主路由 */
  }
  const categories = [
    ...new Set([...SNAPSHOT_CONSTANT_TAGS, ...intentTags, ...hitTags]),
  ].filter((t) => !SENSITIVE_TAGS.includes(t));
  return { categories, fieldHits };
}
