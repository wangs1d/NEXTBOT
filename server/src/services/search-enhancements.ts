/**
 * 搜索增强模块：缓存 + RSS 健康检查 + 搜索意图识别 + 跨查询复用 + 时效性 + 质量评分
 *
 * 六个独立能力，可单独或组合使用：
 *   1. SearchCache：内存 LRU + TTL，重复查询零成本
 *   2. RssHealthMonitor：RSS 源健康检查，连续失败自动降级
 *   3. SearchIntentClassifier：识别查询意图（对比/调研/价格/最新），影响搜索策略
 *   4. SessionSearchCache：同会话内跨查询复用结果片段
 *   5. Freshness：时效性过滤、排序、日期推断（原 search-freshness.ts）
 *   6. QualityScoring + Retry：质量评分排序 + 指数退避重试
 */

import type { InfoSearchItem } from "./info-hub-service.js";

// ============================================================
// 0. 时效性常量（原 search-freshness.ts）
// ============================================================

const DEFAULT_TIMEZONE = "Asia/Shanghai";
const DEFAULT_MAX_AGE_DAYS = Number(process.env.SEARCH_MAX_ITEM_AGE_DAYS ?? 120);

const STALE_QUERY_ALLOW_RE =
  /历史|去年|往年|回顾|成立于|发展历程|发展史|是什么|百科|维基|wiki|历年|过去\d+年/i;

const RECENCY_QUERY_BOOST_RE =
  /最新|最近|今天|今日|昨晚|刚刚|实时|新闻|股价|行情|公告|热映|排片|电影|天气|价格|赛程|版本|发布|动态|头条|资讯|调研|公司|股票|\d{6}\b|20\d{2}年?\d{0,2}月?/i;

// ============================================================
// 1. SearchCache：内存 LRU + TTL
// ============================================================

type CacheEntry<T> = {
  value: T;
  expireAt: number; // 绝对过期时间戳
  createdAt: number;
};

export class SearchCache<T> {
  private readonly store = new Map<string, CacheEntry<T>>();
  private readonly maxSize: number;
  private readonly ttlMs: number;

  constructor(opts: { maxSize?: number; ttlMs?: number } = {}) {
    this.maxSize = opts.maxSize ?? 200;
    this.ttlMs = opts.ttlMs ?? 5 * 60 * 1000; // 默认 5 分钟
  }

  get(key: string): T | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expireAt) {
      this.store.delete(key);
      return undefined;
    }
    // LRU：访问时移到末尾（Map 保持插入顺序）
    this.store.delete(key);
    this.store.set(key, entry);
    return entry.value;
  }

  set(key: string, value: T, ttlMsOverride?: number): void {
    const ttl = ttlMsOverride ?? this.ttlMs;
    // 容量淘汰
    while (this.store.size >= this.maxSize) {
      const firstKey = this.store.keys().next().value;
      if (firstKey === undefined) break;
      this.store.delete(firstKey);
    }
    this.store.set(key, {
      value,
      expireAt: Date.now() + ttl,
      createdAt: Date.now(),
    });
  }

  /** 命中统计（用于测试和监控） */
  stats(): { size: number; hitCount: number; missCount: number } {
    return {
      size: this.store.size,
      hitCount: this._hitCount,
      missCount: this._missCount,
    };
  }

  private _hitCount = 0;
  private _missCount = 0;

  /** 带统计的 get */
  getWithStats(key: string): T | undefined {
    const v = this.get(key);
    if (v !== undefined) this._hitCount++;
    else this._missCount++;
    return v;
  }

  clear(): void {
    this.store.clear();
    this._hitCount = 0;
    this._missCount = 0;
  }
}

// ============================================================
// 2. RssHealthMonitor：RSS 源健康检查 + 自动降级
// ============================================================

type SourceHealth = {
  /** 连续失败次数 */
  consecutiveFailures: number;
  /** 上次成功时间戳 */
  lastSuccessAt: number;
  /** 是否被降级（连续失败超过阈值后暂停使用） */
  degraded: boolean;
  /** 降级恢复时间戳（降级后冷却期过后自动恢复） */
  degradedUntil?: number;
};

export class RssHealthMonitor {
  private readonly health = new Map<string, SourceHealth>();
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;
  private readonly permanentThreshold: number;

  constructor(opts: { failureThreshold?: number; cooldownMs?: number; permanentThreshold?: number } = {}) {
    this.failureThreshold = opts.failureThreshold ?? 3; // 连续失败 3 次降级
    this.cooldownMs = opts.cooldownMs ?? 10 * 60 * 1000; // 降级 10 分钟
    // 连续失败超过该阈值视为「死源」永久降级，不再反复重试占用配额（直到某次成功才恢复）
    this.permanentThreshold = opts.permanentThreshold ?? 8;
  }

  /** 记录成功 */
  recordSuccess(source: string): void {
    this.health.set(source, {
      consecutiveFailures: 0,
      lastSuccessAt: Date.now(),
      degraded: false,
      degradedUntil: undefined,
    });
  }

  /** 记录失败，返回是否触发降级。冷却期随失败次数指数拉长；超过阈值后永久降级。 */
  recordFailure(source: string): boolean {
    const prev = this.health.get(source) ?? {
      consecutiveFailures: 0,
      lastSuccessAt: 0,
      degraded: false,
    };
    const consecutiveFailures = prev.consecutiveFailures + 1;
    const permanent = consecutiveFailures >= this.permanentThreshold;
    // 指数冷却：10m → 20m → 40m → …上限 2 小时；死源则永久
    const escalated = Math.min(this.cooldownMs * Math.pow(2, Math.max(0, consecutiveFailures - this.failureThreshold)), 2 * 60 * 60 * 1000);
    const degraded = permanent || consecutiveFailures >= this.failureThreshold;
    this.health.set(source, {
      consecutiveFailures,
      lastSuccessAt: prev.lastSuccessAt,
      degraded,
      degradedUntil: degraded ? (permanent ? Number.POSITIVE_INFINITY : Date.now() + escalated) : undefined,
    });
    return degraded;
  }

  /** 判断源是否可用（未降级或冷却期已过 / 死源已恢复） */
  isAvailable(source: string): boolean {
    const h = this.health.get(source);
    if (!h || !h.degraded) return true;
    // 永久降级的死源：不自动恢复，需 recordSuccess 手动恢复
    if (h.degradedUntil === Number.POSITIVE_INFINITY) return false;
    // 冷却期过后自动恢复
    if (h.degradedUntil && Date.now() > h.degradedUntil) {
      h.degraded = false;
      h.consecutiveFailures = 0;
      h.degradedUntil = undefined;
      return true;
    }
    return false;
  }

  /** 过滤出可用的源列表 */
  filterAvailable<T extends { source: string; url: string }>(sources: T[]): T[] {
    return sources.filter((s) => this.isAvailable(s.source));
  }

  /** 健康状态快照（用于测试和监控） */
  snapshot(): Record<string, SourceHealth> {
    const out: Record<string, SourceHealth> = {};
    for (const [k, v] of this.health) out[k] = { ...v };
    return out;
  }
}

// ============================================================
// 3. SearchIntentClassifier：搜索意图识别
// ============================================================

export type SearchIntent =
  | "latest" // 最新/最近/今日/新闻
  | "compare" // 对比/VS
  | "research" // 调研/了解/分析/介绍
  | "price" // 价格/报价/多少钱
  | "definition" // 是什么/什么是/解释
  | "general"; // 通用

export type IntentAnalysis = {
  intent: SearchIntent;
  /** 建议的 limit */
  suggestedLimit?: number;
  /** 是否需要强制联网 */
  requiresFreshWeb: boolean;
};

const INTENT_PATTERNS: Array<{ intent: SearchIntent; re: RegExp }> = [
  { intent: "latest", re: /最新|最近|今日|今天|现在|目前|刚刚|新闻|事件|发生|breaking|news|event|latest|recent|current|today/i },
  { intent: "compare", re: /对比|比较|VS|vs|哪个好|区别|差异|优缺点/i },
  { intent: "price", re: /价格|报价|多少钱|价位|售价|费用|cost|price|how much/i },
  // definition 必须在 research 之前判断（"什么是X"是定义查询，不是调研）
  { intent: "definition", re: /是什么|什么是|什么意思|定义|含义|definition|meaning/i },
  { intent: "research", re: /调研|了解|分析|介绍|怎么样|如何|解释|百科|review|introduce|explain|what is/i },
];

export function classifySearchIntent(query: string): IntentAnalysis {
  const q = query.trim();

  // 识别意图
  let intent: SearchIntent = "general";
  for (const { intent: i, re } of INTENT_PATTERNS) {
    if (re.test(q)) {
      intent = i;
      break;
    }
  }

  // 建议参数
  const suggestedLimit =
    intent === "latest" ? 16 :
    intent === "compare" ? 16 :
    intent === "research" ? 14 :
    intent === "price" ? 12 :
    undefined;

  const requiresFreshWeb =
    intent === "latest" ||
    intent === "price" ||
    /最新|最近|今日|现在|价格|报价|news|latest|price/i.test(q);

  // 不再提取实体/关键词（机械断句代码已删除）：query 由 LLM 组织、原样透传给
  // 搜索引擎，意图识别只服务于建议条数与时效性判定。
  return { intent, suggestedLimit, requiresFreshWeb };
}

// ============================================================
// 4. SessionSearchCache：同会话内跨查询复用
// ============================================================

type SessionEntry = {
  query: string;
  items: InfoSearchItem[];
  fetchedAt: number;
  /** 提取的关键词，用于后续相似查询匹配 */
  keywords: string[];
};

export class SessionSearchCache {
  private readonly sessions = new Map<string, SessionEntry[]>();
  private readonly maxEntriesPerSession: number;
  private readonly maxAgeMs: number;
  private readonly similarityThreshold: number;

  constructor(opts: { maxEntriesPerSession?: number; maxAgeMs?: number; similarityThreshold?: number } = {}) {
    this.maxEntriesPerSession = opts.maxEntriesPerSession ?? 10;
    this.maxAgeMs = opts.maxAgeMs ?? 30 * 60 * 1000; // 30 分钟
    this.similarityThreshold = opts.similarityThreshold ?? 0.5; // 提高阈值，避免不相关查询返回旧结果
  }

  /** 记录一次搜索结果 */
  record(sessionId: string, query: string, items: InfoSearchItem[]): void {
    const entries = this.sessions.get(sessionId) ?? [];
    const keywords = extractKeywords(query);
    entries.push({ query, items, fetchedAt: Date.now(), keywords });

    // 容量淘汰 + 过期清理
    const now = Date.now();
    const kept = entries
      .filter((e) => now - e.fetchedAt < this.maxAgeMs)
      .slice(-this.maxEntriesPerSession);
    this.sessions.set(sessionId, kept);
  }

  /** 查找可复用的结果：相似度 >= 阈值时返回 */
  findReusable(sessionId: string, query: string): InfoSearchItem[] | undefined {
    const entries = this.sessions.get(sessionId);
    if (!entries || entries.length === 0) return undefined;

    const queryKeywords = extractKeywords(query);
    if (queryKeywords.length === 0) return undefined;

    let bestMatch: { items: InfoSearchItem[]; score: number } | undefined;
    for (const entry of entries) {
      const score = jaccardSimilarity(queryKeywords, entry.keywords);
      if (score >= this.similarityThreshold) {
        if (!bestMatch || score > bestMatch.score) {
          bestMatch = { items: entry.items, score };
        }
      }
    }
    return bestMatch?.items;
  }

  clear(sessionId?: string): void {
    if (sessionId) this.sessions.delete(sessionId);
    else this.sessions.clear();
  }
}

function extractKeywords(query: string): string[] {
  const q = query.trim().toLowerCase();
  // 1. 按空格和标点切分
  const words = q
    .split(/[\s,，、。；;:：/|?？!！]+/)
    .map((w) => w.trim())
    .filter((w) => w.length >= 2);
  // 2. 中文连续段（2-6 字，更细粒度，提高相似查询匹配率）
  const cnRuns = [...q.matchAll(/[\u4e00-\u9fff]{2,6}/gu)].map((m) => m[0]);
  // 3. 英文词
  const enWords = [...q.matchAll(/\b[a-z]{2,}\b/gi)].map((m) => m[0].toLowerCase());
  return [...new Set([...words, ...cnRuns, ...enWords])];
}

function jaccardSimilarity(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  let intersection = 0;
  for (const x of setA) if (setB.has(x)) intersection++;
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

// ============================================================
// 5. 时效性：日期解析 + 新鲜度过滤/排序（原 search-freshness.ts）
// ============================================================

export type SearchAnchorNow = {
  iso: string;
  year: number;
  month: number;
  day: number;
  label: string;
};

export function getSearchAnchorNow(timezone = DEFAULT_TIMEZONE): SearchAnchorNow {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: timezone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }).formatToParts(now);
  const year = Number(parts.find((p) => p.type === "year")?.value ?? now.getUTCFullYear());
  const month = Number(parts.find((p) => p.type === "month")?.value ?? 1);
  const day = Number(parts.find((p) => p.type === "day")?.value ?? 1);
  const label = `${year}年${month}月${day}日`;
  return { iso: now.toISOString(), year, month, day, label };
}

export function queryAllowsStaleResults(query: string): boolean {
  return STALE_QUERY_ALLOW_RE.test(query);
}

export function shouldBoostQueryRecency(query: string): boolean {
  if (queryAllowsStaleResults(query)) return false;
  const trimmed = query.trim();
  if (!trimmed) return false;
  const intent = classifySearchIntent(trimmed);
  return intent.requiresFreshWeb || RECENCY_QUERY_BOOST_RE.test(trimmed);
}

/** 为必应检索前置「年月 / 最新」变体，提高实时结果占比。 */
export function prependRecencyQueryVariants(variants: string[], query: string): string[] {
  if (!shouldBoostQueryRecency(query)) return variants;
  const anchor = getSearchAnchorNow();
  const ym = `${anchor.year}年${anchor.month}月`;
  const core = variants.find((v) => v.length > 0) ?? query.trim();
  const boosted = [
    `${core} ${ym}`,
    `${core} 最新`,
    ...variants,
  ];
  return [...new Set(boosted.map((v) => v.trim()).filter(Boolean))];
}

export function parsePublishedAtMs(raw?: string): number | undefined {
  if (!raw?.trim()) return undefined;
  const text = raw.trim();
  const direct = Date.parse(text);
  if (Number.isFinite(direct)) return direct;

  const cn = text.match(/(\d{1,2})\s*(\d{1,2})月\s*(\d{4})/);
  if (cn) {
    const d = new Date(Number(cn[3]), Number(cn[2]) - 1, Number(cn[1]));
    if (Number.isFinite(d.getTime())) return d.getTime();
  }

  const cn2 = text.match(/(\d{4})年(\d{1,2})月(\d{1,2})日?/);
  if (cn2) {
    const d = new Date(Number(cn2[1]), Number(cn2[2]) - 1, Number(cn2[3]));
    if (Number.isFinite(d.getTime())) return d.getTime();
  }

  return undefined;
}

export function inferPublishedAtMsFromUrl(url: string): number | undefined {
  // /20261105/ 或 /2026-11-05/ 目录式（原有）
  const slash = url.match(/\/(20\d{2})(\d{2})(\d{2})\//);
  if (slash) {
    const d = new Date(Number(slash[1]), Number(slash[2]) - 1, Number(slash[3]));
    if (Number.isFinite(d.getTime())) return d.getTime();
  }
  const dashed = url.match(/\/(20\d{2})-(\d{2})-(\d{2})\//);
  if (dashed) {
    const d = new Date(Number(dashed[1]), Number(dashed[2]) - 1, Number(dashed[3]));
    if (Number.isFinite(d.getTime())) return d.getTime();
  }
  // /2026/11/5/ 斜杠分段式（门户 CMS 常见）
  const seg = url.match(/\/(20\d{2})\/(\d{1,2})\/(\d{1,2})(?:\/|\b)/);
  if (seg) {
    const month = Number(seg[2]);
    const day = Number(seg[3]);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      const d = new Date(Number(seg[1]), month - 1, day);
      if (Number.isFinite(d.getTime())) return d.getTime();
    }
  }
  // URL 任意位置的连续 8 位日期（如 date=20261105、news20261105001.html）。
  // 月份/日期带合法域校验，避免把订单号、ID 当日期。
  const flat = url.match(/(20\d{2})(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])/);
  if (flat) {
    const d = new Date(Number(flat[1]), Number(flat[2]) - 1, Number(flat[3]));
    if (Number.isFinite(d.getTime())) return d.getTime();
  }
  return undefined;
}

/**
 * 从标题/摘要正文推断发布时间（2026-11-06 大幅扩展）。
 *
 * 此前只认「完整年月日」，而中文资讯最常见的时间形态是**无年份日期**
 * （「11月5日收盘」）与**相对时间**（「3小时前」「昨天」）——AnySearch
 * 条目日期字段全空时，这两类正是唯一的推断来源，漏掉它们等于整个
 * 时效排序空转（实测 24 条结果 0 条有日期、排序为原样透传）。
 *
 * 优先级：显式完整日期 > 相对时间 > 无年份日期（年份由 now 推断，
 * 未来月份归上一年）。`nowMs` 缺省取当前时间（调用方可注入以保证可测）。
 */
export function inferPublishedAtMsFromText(text: string, nowMs?: number): number | undefined {
  const now = nowMs ?? Date.now();

  // 1. 完整年月日（最高置信，年份 1000-2999）：2026-11-05 / 2026.11.5 / 2026年11月5日 /
  //    1949年10月1日（历史年份必须整体识别，否则「10月1日」会被无年份推断误判成今年）
  const iso = text.match(/([12]\d{3})[-/.年](\d{1,2})[-/.月](\d{1,2})/);
  if (iso) {
    const d = new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
    if (Number.isFinite(d.getTime())) return d.getTime();
  }

  // 2. 相对时间（资讯客户端发布行的标准形态，置信度高）
  const MIN = 60_000;
  const HOUR = 3_600_000;
  const DAY = 86_400_000;
  const startOfToday = new Date(now).setHours(0, 0, 0, 0);
  const relMins = text.match(/(\d{1,3})\s*分钟前/);
  if (relMins) return now - Number(relMins[1]) * MIN;
  const relHours = text.match(/(\d{1,2})\s*小时前/);
  if (relHours) return now - Number(relHours[1]) * HOUR;
  const relDays = text.match(/(\d{1,2})\s*天前/);
  if (relDays) return now - Number(relDays[1]) * DAY;
  if (/刚刚|刚刚发布|几分钟前/.test(text)) return now - 5 * MIN;
  if (/今天|今日|今晨|今早|刚刚过去的/.test(text)) return startOfToday + 12 * HOUR;
  if (/昨晚|昨夜|昨日|昨天/.test(text)) return startOfToday + 12 * HOUR - DAY;
  if (/前天|前日/.test(text)) return startOfToday + 12 * HOUR - 2 * DAY;
  const relWeeks = text.match(/(\d{1,2})\s*周前/);
  if (relWeeks) return now - Number(relWeeks[1]) * 7 * DAY;

  // 3. 无年份日期：11月5日 / 11-05 / 11/05（不含年份时才走到这）。
  //    年份推断：月份比当前月「晚」→ 是去年的（今年还没到那个月）。
  const nowD = new Date(now);
  const md =
    text.match(/(\d{1,2})月(\d{1,2})日/) ??
    text.match(/\b(\d{1,2})-(\d{1,2})\b/) ??
    text.match(/\b(\d{1,2})\/(\d{1,2})\b/);
  if (md) {
    const month = Number(md[1]);
    const day = Number(md[2]);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      let year = nowD.getFullYear();
      if (month > nowD.getMonth() + 1) year -= 1;
      const d = new Date(year, month - 1, day);
      if (Number.isFinite(d.getTime())) return d.getTime();
    }
  }

  return undefined;
}

export function resolveItemPublishedAtMs(
  item: InfoSearchItem,
  nowMs?: number,
): number | undefined {
  return (
    parsePublishedAtMs(item.publishedAt) ??
    inferPublishedAtMsFromUrl(item.url) ??
    inferPublishedAtMsFromText(`${item.title}\n${item.snippet}`, nowMs)
  );
}

/** 把毫秒时间戳格式化成本地日期串（YYYY-MM-DD），写入条目 publishedAt 用。 */
function formatLocalDate(ms: number): string {
  const d = new Date(ms);
  const pad = (v: number): string => String(v).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export type ApplySearchFreshnessResult = {
  items: InfoSearchItem[];
  droppedStale: number;
  sortedBy: "publishedAtDesc";
  /** 成功解析出发布时间的条目数（0 = 排序为原样透传，时效说明必须如实降级） */
  datedCount: number;
};

export function applySearchFreshness(
  items: InfoSearchItem[],
  input: { query: string; maxAgeDays?: number; nowMs?: number },
): ApplySearchFreshnessResult {
  const maxAgeDays = input.maxAgeDays ?? DEFAULT_MAX_AGE_DAYS;
  const nowMs = input.nowMs ?? Date.now();
  // 2026-09-03 改为按意图裁剪：只有 query 带时效诉求（最新/新闻/价格/天气…）时才丢旧条目；
  // 中性/知识型查询保留全部结果（仍按发布时间倒序），避免「搜历史资料被静默砍掉大半」。
  // 旧逻辑对所有非白名单 query 一刀切丢 >120 天条目，是「搜索信息不全面」的根因之一。
  const dropStale = shouldBoostQueryRecency(input.query);
  const maxAgeMs = maxAgeDays * 86_400_000;

  const enriched = items.map((item) => ({
    item,
    publishedMs: resolveItemPublishedAtMs(item, nowMs),
  }));
  const datedCount = enriched.filter((x) => x.publishedMs != null).length;

  // 2026-11-06：把推断出的日期写回条目（无显式日期时）——下游回执模型可见，
  // 「数字必须说清哪天的」纪律才有核对依据；此前推断结果只用于排序即丢，
  // 模型看到的仍是 24 条无日期结果。
  const dated = enriched.map(({ item, publishedMs }) =>
    publishedMs != null && !item.publishedAt
      ? { ...item, publishedAt: formatLocalDate(publishedMs) }
      : item,
  );

  let droppedStale = 0;
  const kept = dated
    .map((item, i) => ({ item, publishedMs: enriched[i].publishedMs }))
    .filter(({ publishedMs }) => {
      if (!dropStale) return true;
      if (publishedMs == null) return true;
      if (nowMs - publishedMs <= maxAgeMs) return true;
      droppedStale += 1;
      return false;
    });

  kept.sort((a, b) => {
    const aMs = a.publishedMs;
    const bMs = b.publishedMs;
    if (aMs != null && bMs != null) return bMs - aMs;
    if (aMs != null) return -1;
    if (bMs != null) return 1;
    return 0;
  });

  return {
    items: kept.map((x) => x.item),
    droppedStale,
    sortedBy: "publishedAtDesc",
    datedCount,
  };
}

export function formatSearchFreshnessNote(input: {
  anchor: SearchAnchorNow;
  droppedStale: number;
  maxAgeDays: number;
  datedCount?: number;
  total?: number;
}): string {
  // 2026-11-06：时效声明按「实际解析到日期的比例」如实降级——此前无条件声明
  // 「已按发布时间从新到旧排序」，上游无日期时是假话，还给了模型错误安全感。
  const dated = input.datedCount ?? 0;
  const total = input.total ?? 0;
  const parts: string[] = [`检索基准时间：${input.anchor.label}（${DEFAULT_TIMEZONE}）`];
  if (total > 0 && dated === 0) {
    parts.push(
      "结果均未标注发布时间，条目顺序为引擎原始排序（非时间序）；引用任何数字前必须核对它是哪天的，无日期条目不得当作最新数据",
    );
  } else {
    parts.push("结果已按发布时间从新到旧排序");
  }
  if (input.droppedStale > 0) {
    parts.push(`已剔除 ${input.droppedStale} 条超过 ${input.maxAgeDays} 天的旧结果`);
  }
  return parts.join("；");
}

// ============================================================
// 6. 搜索结果质量评分（相关性 + 权威度 + 时效性）
// ============================================================

// 来源权威度评分（0-1）
const SOURCE_AUTHORITY: Record<string, number> = {
  // 官方媒体（最高）
  "中国新闻网滚动": 0.95,
  "中国新闻网要闻": 0.95,
  "中国新闻网国内": 0.93,
  "中国新闻网国际": 0.93,
  "中国新闻网财经": 0.94,
  "中国新闻网社会": 0.92,
  "人民网时政": 0.94,
  "人民网国际": 0.92,
  "人民网科技": 0.92,
  "央视网": 0.95,
  "环球网": 0.90,
  "联合早报": 0.88,
  "参考消息": 0.90,
  // 科技媒体（中等）
  "36氪": 0.80,
  "IT之家": 0.78,
  // 搜索引擎（通用）
  "必应中国": 0.70,
  "GDELT": 0.65,
};

/**
 * 计算搜索结果的综合质量评分。
 * 评分公式：0.5 * 相关性 + 0.3 * 权威度 + 0.2 * 时效性
 *
 * @param item 搜索结果
 * @param query 原始查询（用于相关性计算）
 * @returns 0-1 之间的评分，越高越优
 */
export function scoreSearchItem(item: InfoSearchItem, query: string): number {
  // 1. 相关性（标题/摘要包含查询关键词的程度）
  const queryKeywords = extractKeywords(query);
  let relevance = 0;
  if (queryKeywords.length > 0) {
    const hay = `${item.title}\n${item.snippet}`.toLowerCase();
    const matched = queryKeywords.filter((k) => hay.includes(k)).length;
    relevance = matched / queryKeywords.length;
    // 标题命中加权
    const titleLower = item.title.toLowerCase();
    const titleMatched = queryKeywords.filter((k) => titleLower.includes(k)).length;
    if (titleMatched > 0) {
      relevance = Math.min(1, relevance + 0.2 * (titleMatched / queryKeywords.length));
    }
  } else {
    relevance = 0.5; // 无关键词时给中等分
  }

  // 2. 权威度
  const authority = SOURCE_AUTHORITY[item.source] ?? 0.6;

  // 3. 时效性（越新越高分，1小时内=1.0，1天内=0.8，7天内=0.5，更早=0.3，未知=0.4）
  let freshness = 0.4;
  if (item.publishedAt) {
    const ts = parsePublishedAtMs(item.publishedAt);
    if (ts) {
      const ageMin = (Date.now() - ts) / 60000;
      if (ageMin <= 60) freshness = 1.0;
      else if (ageMin <= 1440) freshness = 0.8;
      else if (ageMin <= 10080) freshness = 0.5;
      else freshness = 0.3;
    }
  }

  return 0.5 * relevance + 0.3 * authority + 0.2 * freshness;
}

/** 按质量评分排序搜索结果 */
export function sortByQuality(items: InfoSearchItem[], query: string): InfoSearchItem[] {
  return items
    .map((item) => ({ item, score: scoreSearchItem(item, query) }))
    .sort((a, b) => b.score - a.score)
    .map((x) => x.item);
}

// ============================================================
// 7. 带重试的异步执行（指数退避）
// ============================================================

/**
 * 带指数退避的重试执行。
 * 网络波动导致单次失败时自动重试，提升稳定性。
 *
 * @param fn 要执行的异步函数
 * @param opts 重试配置
 * @returns 函数返回值
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: { maxRetries?: number; baseDelayMs?: number; maxDelayMs?: number } = {},
): Promise<T> {
  const maxRetries = opts.maxRetries ?? 1;
  const baseDelayMs = opts.baseDelayMs ?? 150;
  const maxDelayMs = opts.maxDelayMs ?? 1000;

  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastError = e;
      if (attempt >= maxRetries) break;
      // 指数退避：200ms, 400ms, 800ms... 上限 maxDelayMs
      const delay = Math.min(baseDelayMs * Math.pow(2, attempt), maxDelayMs);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastError;
}
