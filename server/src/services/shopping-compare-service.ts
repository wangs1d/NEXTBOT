/**
 * 购物比价服务（跨平台同款聚合 + 降价监控）。
 *
 * 复用 ShoppingOrderService 的平台搜索链路（Playwright + Cookie 双门禁 +
 * 平台白名单），对同一关键词并行搜多平台，做同款归一聚合：
 *   - 标题归一化（去营销词/规格截断）+ 规格 token（容量/克重/型号）提取
 *   - 组内 Dice 相似度判定同款；低置信组标注「疑似同款」，不静默合并
 *   - 输出按价格升序的分组报价 + 全局最低价
 *
 * 附带能力：
 *   - 降价监控（price watch）：add/remove/list + 后台 tick 定时复查，
 *     到价经 onPriceAlert 回调主动推送（装配层接 ProactivityHub.submitIntent）
 *   - 价格历史：data/shopping/price-history.json 追加记录（走势查询用）
 *
 * 安全性：全部只读（搜索/读价），不产生任何订单或支付副作用；
 * 平台访问复用 shopping-order 的 Cookie 门禁与审计。
 */
import { getDataDir } from "../config/data-dir.js";
import { randomUUID } from "crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { resolveActorId } from "../agent/actor-id.js";
import { redactCredentials } from "../security/redact.js";
import type { ToolContext } from "../tools/tool-registry.js";
import type { ShoppingOrderService } from "./shopping-order-service.js";
import type { OfficialPriceGateway } from "./shopping-platforms/official-price-source.js";
import type { ProductSummary } from "./shopping-platforms/index.js";

// ─────────────────────────── 类型 ───────────────────────────

/** 报价来源：official_api=联盟 API（零用户操作）；browser=Playwright+用户 Cookie 兜底 */
export type OfferSource = "official_api" | "browser";

/** 单平台一条报价 */
export interface CompareOffer {
  platform: string;
  title: string;
  priceCny: number | null;
  shop?: string;
  url?: string;
  itemId?: string;
  /** 商品主图（联盟 API 官方图源；浏览器抓取未提取时缺省） */
  imageUrl?: string;
  /** 数据来源（比价卡呈现须注明数据源与时效） */
  source?: OfferSource;
  /** 抓取时刻（ms） */
  fetchedAt?: number;
}

/** 同款分组 */
export interface CompareGroup {
  /** 组内归一化标题（代表成员） */
  normalizedTitle: string;
  /** exact=归一化后完全一致；similar=Dice 相似度达阈值（疑似同款） */
  matchType: "exact" | "similar";
  /** 同款置信度 0~1（组内与代表成员的最高相似度） */
  confidence: number;
  minPriceCny: number | null;
  /** 组代表图（组内首个带官方主图的报价；比价卡缩略图/决策页主图用） */
  imageUrl?: string;
  offers: CompareOffer[];
}

/** 比价结果 */
export interface CompareResult {
  query: string;
  platforms: string[];
  /** 实际返回了结果的平台 */
  searchedPlatforms: string[];
  groups: CompareGroup[];
  bestOffer: CompareOffer | null;
}

/** 一条降价监控 */
export interface PriceWatch {
  id: string;
  actorId: string;
  query: string;
  platform: string;
  /** 降价目标（CNY），当前价 ≤ 目标时触发提醒 */
  targetPrice: number;
  lastPriceCny: number | null;
  lastCheckedAt: number | null;
  /** 上次推送时的价格（同价位不重复推；新低价需低于此价 2% 以上） */
  lastNotifiedPrice: number | null;
  createdAt: number;
  enabled: boolean;
}

/** 一次到价命中 */
export interface PriceWatchHit {
  watch: PriceWatch;
  priceCny: number;
  title: string;
  url?: string;
  /** 命中价来源（official_api/browser） */
  source?: OfferSource;
}

export interface ShoppingCompareServiceDeps {
  shoppingOrderService: ShoppingOrderService;
  /**
   * 官方联盟 API 比价网关（2026-09-24）：配置了凭据的平台（taobao/jd/pdd）官方源
   * 优先——零用户 Cookie、服务器侧直查；未配置/失败时静默落 Playwright+Cookie 兜底。
   */
  officialPriceGateway?: OfficialPriceGateway;
  /**
   * Web 搜索（保险/服务类调研比价用）。可选：未注入时 research 返回明确错误。
   * 最小结构化接口（UpstreamSearchService.searchWeb），便于测试 mock。
   */
  upstreamSearchService?: {
    searchWeb(query: string, limit?: number): Promise<{
      provider: string;
      items: Array<{ title: string; url: string; snippet: string; source: string; publishedAt?: string }>;
      notes: string[];
    }>;
  };
  /** 持久化目录（默认 data/shopping） */
  dataDir?: string;
  /** 到价回调（装配层接 ProactivityHub.submitIntent 主动推送） */
  onPriceAlert?: (actorId: string, watch: PriceWatch, hit: PriceWatchHit) => void;
  /**
   * 比价完成回调（装配层接决策页内存存储，模式同 travel-plans）。
   * 回调返回页面 id 时，工具回执携带 decisionPageUrl 供比价卡「打开决策页」。
   * 回调异常/返回空不影响比价主流程。
   */
  onCompareResult?: (
    actorId: string,
    payload: CompareResult & { fetchedAt: number },
  ) => string | null | void;
  /** 测试注入时钟 */
  now?: () => number;
}

// ─────────────────────────── 标题归一化 / 同款判定 ───────────────────────────

// 标题归一化 / 同款判定的实现抽至 shopping-platforms/title-normalize.ts
// （比价线与推荐实时聚合线共用），此处 re-export 保持既有 import 路径兼容。

export {
  normalizeTitle,
  extractSpecTokens,
  diceSimilarity,
} from "./shopping-platforms/title-normalize.js";

import { normalizeTitle, extractSpecTokens, diceSimilarity } from "./shopping-platforms/title-normalize.js";

/** 同款判定阈值：归一化标题 Dice 相似度 */
const SAME_PRODUCT_DICE_THRESHOLD = 0.55;
/** 单用户监控条数上限 */
const MAX_WATCHES_PER_ACTOR = 30;
/** 价格历史上限（全局，防无限膨胀） */
const PRICE_HISTORY_MAX = 2000;

/** 带平台归属的商品（跨平台聚合的输入单元） */
export interface TaggedProduct {
  platform: string;
  product: ProductSummary;
  /** 数据来源（official_api/browser，缺省 browser） */
  source?: OfferSource;
  /** 抓取时刻（ms） */
  fetchedAt?: number;
}

/**
 * 把跨平台商品列表聚成同款分组。
 * 贪心：按价格升序遍历，与已有组代表比 Dice；规格 token 完全一致可加分直判 similar。
 */
export function groupSameProducts(items: TaggedProduct[]): CompareGroup[] {
  const sorted = [...items].sort(
    (a, b) => (a.product.price ?? Number.MAX_SAFE_INTEGER) - (b.product.price ?? Number.MAX_SAFE_INTEGER),
  );
  const groups: Array<{ rep: ProductSummary; repNorm: string; repSpecs: Set<string>; offers: CompareOffer[]; confidence: number; exact: boolean }> = [];

  for (const { platform, product: p, source, fetchedAt } of sorted) {
    const norm = normalizeTitle(p.title);
    const specs = new Set(extractSpecTokens(p.title));
    let placed = false;
    for (const g of groups) {
      let sim = diceSimilarity(g.repNorm, norm);
      // 规格 token 一致 → 同款强信号；规格冲突 → 直接不同款
      const specsMatch = g.repSpecs.size > 0 && specs.size > 0 && [...g.repSpecs].every((s) => specs.has(s)) && [...specs].every((s) => g.repSpecs.has(s));
      if (specsMatch) sim = Math.max(sim, 0.7);
      if (sim >= SAME_PRODUCT_DICE_THRESHOLD) {
        g.offers.push(toOffer(platform, p, source, fetchedAt));
        g.confidence = Math.max(g.confidence, sim);
        if (sim >= 0.99) g.exact = true;
        placed = true;
        break;
      }
    }
    if (!placed) {
      groups.push({
        rep: p,
        repNorm: norm,
        repSpecs: specs,
        offers: [toOffer(platform, p, source, fetchedAt)],
        confidence: 1,
        exact: true,
      });
    }
  }

  return groups.map((g) => {
    const prices = g.offers.map((o) => o.priceCny).filter((v): v is number => v != null);
    const repImage = g.offers.find((o) => o.imageUrl)?.imageUrl;
    return {
      normalizedTitle: g.repNorm,
      matchType: g.exact ? ("exact" as const) : ("similar" as const),
      confidence: Math.round(g.confidence * 100) / 100,
      minPriceCny: prices.length ? Math.min(...prices) : null,
      ...(repImage ? { imageUrl: repImage } : {}),
      offers: g.offers,
    };
  });
}

function toOffer(platform: string, p: ProductSummary, source?: OfferSource, fetchedAt?: number): CompareOffer {
  return {
    platform,
    title: p.title,
    priceCny: p.price ?? null,
    shop: p.shop,
    url: p.url,
    itemId: p.itemId,
    ...(p.imageUrl ? { imageUrl: p.imageUrl } : {}),
    ...(source ? { source } : {}),
    ...(fetchedAt ? { fetchedAt } : {}),
  };
}

// ─────────────────────────── 持久化（watch + 价格历史） ───────────────────────────

interface WatchFileShape { watches?: PriceWatch[] }
/** 一条价格历史记录 */
interface PriceHistoryEntry { ts: string; actorId: string; query: string; platform: string; minPriceCny: number | null }
interface HistoryFileShape { entries?: PriceHistoryEntry[] }

/** 原子写 JSON（tmp + rename，串行化；与 booking-order-store 同策略） */
class JsonFileWriter {
  private writeChain: Promise<void> = Promise.resolve();
  constructor(private readonly file: string) {}
  write(payload: unknown): void {
    const file = this.file;
    this.writeChain = this.writeChain.then(async () => {
      await mkdir(dirname(file), { recursive: true });
      const tmp = join(dirname(file), `.${basename(file)}.${randomUUID().slice(0, 8)}.tmp`);
      await writeFile(tmp, JSON.stringify(payload, null, 2), "utf8");
      await rename(tmp, file);
    }).catch((err) => {
      console.warn(`[ShoppingCompare] 写盘失败 ${file}`, err);
    });
  }
  async flush(): Promise<void> {
    await this.writeChain;
  }
}

// ─────────────────────────── 服务 ───────────────────────────

function readEnvInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export class ShoppingCompareService {
  private readonly watches = new Map<string, PriceWatch>();
  private readonly history: PriceHistoryEntry[] = [];
  private readonly dataDir: string;
  private readonly watchWriter: JsonFileWriter;
  private readonly historyWriter: JsonFileWriter;
  private readonly clock: () => number;
  private onPriceAlert: ShoppingCompareServiceDeps["onPriceAlert"];
  private onCompareResult: ShoppingCompareServiceDeps["onCompareResult"];
  private loaded = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private started = false;
  /** 比价单平台超时由 searchProduct 控制；并行平台数上限防滥用 */
  private readonly maxPlatforms = readEnvInt("SHOPPING_COMPARE_MAX_PLATFORMS", 4);
  /** 监控复查间隔（默认 60 分钟） */
  private readonly watchTickMs = Math.max(readEnvInt("PRICE_WATCH_TICK_MS", 60 * 60 * 1000), 5 * 60 * 1000);

  constructor(private readonly deps: ShoppingCompareServiceDeps) {
    this.dataDir = deps.dataDir ?? join(getDataDir(), "shopping");
    this.watchWriter = new JsonFileWriter(join(this.dataDir, "price-watches.json"));
    this.historyWriter = new JsonFileWriter(join(this.dataDir, "price-history.json"));
    this.clock = deps.now ?? Date.now;
    this.onPriceAlert = deps.onPriceAlert;
    this.onCompareResult = deps.onCompareResult;
  }

  /** 到价回调（装配层晚接线；构造时也可注入。晚于构造是因为 ProactivityHub 后创建） */
  setOnPriceAlert(fn: NonNullable<ShoppingCompareServiceDeps["onPriceAlert"]>): void {
    (this.deps as { onPriceAlert?: ShoppingCompareServiceDeps["onPriceAlert"] }).onPriceAlert = fn;
    this.onPriceAlert = fn;
  }

  /** 比价完成回调（装配层接决策页存储；同 setOnPriceAlert 的晚接线模式） */
  setOnCompareResult(
    fn: NonNullable<ShoppingCompareServiceDeps["onCompareResult"]>,
  ): void {
    (this.deps as { onCompareResult?: ShoppingCompareServiceDeps["onCompareResult"] }).onCompareResult = fn;
    this.onCompareResult = fn;
  }

  // ---- 生命周期 ----

  /** 预载监控/历史文件（装配层 start 前调用；不调用也会在首次操作时懒加载）。 */
  async load(): Promise<void> {
    await this.ensureLoaded();
  }

  // ---- 降价监控管理（shopping.compare.watch 工具） ----

  async addWatch(actorId: string, query: string, platform: string, targetPrice: number): Promise<PriceWatch[]> {
    await this.ensureLoaded();
    const q = query.trim();
    if (q.length < 2) throw new Error("监控关键词至少 2 个字符");
    if (!(targetPrice > 0)) throw new Error("targetPrice 必须为正数（CNY）");
    const supported = this.deps.shoppingOrderService.listSupportedPlatforms();
    if (!supported.includes(platform)) {
      throw new Error(`平台「${platform}」暂不支持。已实现：${supported.join("/")}`);
    }
    const existing = Array.from(this.watches.values()).find(
      (w) => w.actorId === actorId && w.platform === platform && w.query.trim().toLowerCase() === q.toLowerCase(),
    );
    const now = this.clock();
    if (existing) {
      existing.targetPrice = targetPrice;
      existing.enabled = true;
      this.watches.set(existing.id, existing);
    } else {
      const own = Array.from(this.watches.values()).filter((w) => w.actorId === actorId);
      if (own.length >= MAX_WATCHES_PER_ACTOR) {
        throw new Error(`监控列表已满（${MAX_WATCHES_PER_ACTOR} 条），请先移除不需要的监控`);
      }
      const watch: PriceWatch = {
        id: randomUUID(),
        actorId,
        query: q,
        platform,
        targetPrice,
        lastPriceCny: null,
        lastCheckedAt: null,
        lastNotifiedPrice: null,
        createdAt: now,
        enabled: true,
      };
      this.watches.set(watch.id, watch);
    }
    this.persistWatches();
    return this.listWatches(actorId);
  }

  async removeWatch(actorId: string, target: string): Promise<PriceWatch[]> {
    await this.ensureLoaded();
    const id = this.findWatchId(actorId, target);
    if (id) {
      this.watches.delete(id);
      this.persistWatches();
    }
    return this.listWatches(actorId);
  }

  listWatches(actorId: string): PriceWatch[] {
    return Array.from(this.watches.values())
      .filter((w) => w.actorId === actorId)
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  /** 注入 prompt 的监控摘要（无监控返回 null，零注入） */
  listForPrompt(actorId: string): string | null {
    const items = this.listWatches(actorId).filter((w) => w.enabled).slice(0, 8);
    if (items.length === 0) return null;
    return items
      .map((w) => `「${w.query}」@${w.platform} 目标≤¥${w.targetPrice}${w.lastPriceCny != null ? `（当前 ¥${w.lastPriceCny}）` : ""}`)
      .join("、");
  }

  // ---- 跨平台比价（shopping.compare.prices 工具） ----

  /**
   * 单平台取报价（双通道，2026-09-24）：官方联盟 API 优先（零用户操作），
   * 未配置凭据/官方失败时落 Playwright+用户 Cookie 兜底。来源与时效随报价返回。
   */
  private async fetchPlatformQuotes(
    ctx: ToolContext,
    platform: string,
    query: string,
    opts: { maxPrice?: number; sort?: "default" | "price_asc" | "price_desc" | "sales"; limit?: number } = {},
    preferHeadless = false,
  ): Promise<{ products: Array<ProductSummary & { __source: OfferSource }>; error?: string }> {
    const limit = Math.min(Math.max(opts.limit ?? 5, 1), 10);
    const gateway = this.deps.officialPriceGateway;
    if (gateway?.isConfiguredFor(platform)) {
      const official = await gateway.search(platform, query, limit);
      if (official.ok && official.products.length > 0) {
        return {
          products: official.products.map((p) => ({ ...p, __source: "official_api" as const })),
        };
      }
      // notConfigured 理论上不达（已 isConfiguredFor）；官方失败落兜底并保留原因
      if (!official.ok && !official.notConfigured) {
        console.log(`[ShoppingCompare] 官方源 ${platform} 失败，落浏览器兜底：${official.error ?? "?"}`);
      }
    }
    const res = await this.deps.shoppingOrderService.searchProduct(
      ctx,
      platform,
      query,
      {
        maxPrice: opts.maxPrice,
        sort: opts.sort ?? "price_asc",
        limit,
      },
      { preferHeadless },
    );
    if (!res.ok) {
      return { products: [], error: redactCredentials(String((res as { error?: string }).error ?? "未知错误")) };
    }
    const products = (res as { products?: ProductSummary[] }).products ?? [];
    return { products: products.map((p) => ({ ...p, __source: "browser" as const })) };
  }

  async comparePrices(
    ctx: ToolContext,
    query: string,
    opts: { platforms?: string[]; maxPrice?: number; sort?: "default" | "price_asc" | "price_desc" | "sales"; limit?: number } = {},
  ): Promise<{ ok: true; summary: string } & CompareResult & Record<string, unknown> | { ok: false; error: string; retryable?: boolean }> {
    const actorId = resolveActorId(ctx);
    const q = query.trim();
    if (!q) return { ok: false, error: "缺少 query（比价关键词）" };
    const supported = this.deps.shoppingOrderService.listSupportedPlatforms();
    const requested = (opts.platforms?.length ? opts.platforms : supported.slice(0, this.maxPlatforms))
      .map((p) => p.trim())
      .filter(Boolean)
      .slice(0, this.maxPlatforms);
    if (requested.length === 0) return { ok: false, error: "未指定有效平台" };
    const unsupported = requested.filter((p) => !supported.includes(p));
    if (unsupported.length === requested.length) {
      return { ok: false, error: `平台 ${unsupported.join("/")} 暂不支持。已实现：${supported.join("/")}` };
    }

    // 并行取各平台报价（官方源优先/浏览器兜底在 fetchPlatformQuotes 内闭环；
    // 单平台失败不拖垮整体）
    const settled = await Promise.allSettled(
      requested.map(async (platform, i) => ({
        platform,
        // 面板页只有一个：首位平台走可见内置浏览器（用户可看可接管），
        // 其余平台直接走已授权 Cookie 的 headless 并行——排队等面板会把
        // 整轮工具预算拖爆（2026-10-25 小米 15 比价超时实测根因）。
        quotes: await this.fetchPlatformQuotes(ctx, platform, q, opts, i > 0),
      })),
    );

    const tagged: TaggedProduct[] = [];
    const searchedPlatforms: string[] = [];
    const failedPlatforms: string[] = [];
    /** 比价卡数据源说明（官方 API 平台单独注明：零 Cookie、服务器侧直查） */
    const sourceNotes: string[] = [];
    for (const s of settled) {
      if (s.status !== "fulfilled") continue;
      const { platform, quotes } = s.value;
      if (quotes.products.length > 0) {
        searchedPlatforms.push(platform);
        const fetchedAt = Date.now();
        for (const p of quotes.products) {
          tagged.push({ platform, product: p, source: p.__source, fetchedAt });
        }
        const sources = [...new Set(quotes.products.map((p) => p.__source))];
        if (sources.includes("official_api")) {
          sourceNotes.push(`${platform}=官方API`);
        }
      } else if (quotes.error) {
        failedPlatforms.push(`${platform}：${quotes.error}`);
      }
    }

    if (tagged.length === 0) {
      return {
        ok: false,
        error:
          `所有平台均未返回「${q}」的结果。` +
          (failedPlatforms.length ? `失败详情：${failedPlatforms.join("；")}` : "可能登录态失效，请检查 Cookie 导入与授权"),
        retryable: true,
      };
    }

    // 跨平台同款归一聚合（组内 offers 已按价格升序）
    const groups = groupSameProducts(tagged);
    // 按组内最低价升序
    groups.sort((a, b) => (a.minPriceCny ?? Number.MAX_SAFE_INTEGER) - (b.minPriceCny ?? Number.MAX_SAFE_INTEGER));

    const bestOffer: CompareOffer | null = groups[0]?.offers[0] ?? null;

    // 价格历史（异步落盘，不阻塞返回）
    this.appendHistory(actorId, q, bestOffer?.platform ?? searchedPlatforms[0] ?? "", bestOffer?.priceCny ?? null);

    const platformSummary = searchedPlatforms.join("/");
    const bestText = bestOffer?.priceCny != null ? `，最低 ¥${bestOffer.priceCny}（${bestOffer.platform}）` : "";
    const sourceText = sourceNotes.length > 0 ? `；数据源：${sourceNotes.join("、")}，其余为浏览器抓取` : "";

    // 决策页存档（fire-and-forget：存储失败/未装配不影响比价回执）
    const fetchedAt = Date.now();
    let decisionPageUrl: string | undefined;
    try {
      const pageId = this.onCompareResult?.(actorId, {
        query: q,
        platforms: requested,
        searchedPlatforms,
        groups,
        bestOffer,
        fetchedAt,
      });
      if (pageId) decisionPageUrl = `/shopping/decision-page?id=${encodeURIComponent(pageId)}`;
    } catch (err) {
      console.log(`[ShoppingCompare] 决策页存档失败（忽略）: ${err}`);
    }

    return {
      ok: true,
      summary: `「${q}」跨 ${platformSummary || requested.length} 个平台聚合出 ${groups.length} 组报价${bestText}${sourceText}`,
      query: q,
      platforms: requested,
      searchedPlatforms,
      groups,
      bestOffer,
      fetchedAt,
      ...(decisionPageUrl ? { decisionPageUrl } : {}),
    };
  }

  // ---- 服务/保险类调研比价（shopping.compare.research 工具） ----

  /**
   * 调研式比价：保险/服务等无法结构化抓价的领域，返回 web 检索的来源清单
   * （标题/摘要/链接），由上层 LLM 汇总成对比表。只读，零副作用。
   */
  async research(
    ctx: ToolContext,
    topic: string,
    opts: { limit?: number } = {},
  ): Promise<{
    ok: true;
    summary: string;
    topic: string;
    sources: Array<{ title: string; snippet: string; url: string; source: string; publishedAt?: string }>;
    disclaimer: string;
  } | { ok: false; error: string }> {
    const t = topic.trim();
    if (!t) return { ok: false, error: "缺少 topic（要对比的服务/保险产品）" };
    if (!this.deps.upstreamSearchService) {
      return { ok: false, error: "搜索服务未装配，无法做服务类调研比价" };
    }
    try {
      const res = await this.deps.upstreamSearchService.searchWeb(t, Math.min(Math.max(opts.limit ?? 8, 3), 12));
      const sources = res.items
        .filter((i) => i.title?.trim())
        .map((i) => ({ title: i.title, snippet: (i.snippet ?? "").slice(0, 300), url: i.url, source: i.source, publishedAt: i.publishedAt }));
      if (sources.length === 0) {
        return { ok: false, error: `「${t}」未检索到可用资料，请换更具体的关键词（如产品名+「对比/价格/条款」）` };
      }
      return {
        ok: true,
        summary: `「${t}」检索到 ${sources.length} 条资料（来源：${res.provider}）`,
        topic: t,
        sources,
        disclaimer:
          "以上为网页调研结果，仅供参考；价格/条款以官方渠道为准。" +
          "请把资料整理成对比表（方案/价格/核心保障或服务内容/注意事项）呈现给用户，并附上来源链接。",
      };
    } catch (err) {
      return { ok: false, error: `调研检索失败：${err instanceof Error ? err.message : String(err)}` };
    }
  }

  // ---- 后台监控 tick ----

  start(): void {
    if (this.started) return;
    this.started = true;
    this.timer = setInterval(() => {
      void this.checkAllWatches().catch((err) => {
        console.log(`[ShoppingCompare] 监控 tick 失败（忽略）: ${err}`);
      });
    }, this.watchTickMs);
    this.timer.unref?.();
    console.log(`[ShoppingCompare] 降价监控已启动（tick=${Math.round(this.watchTickMs / 60000)}min，监控数=${this.watches.size}）`);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.started = false;
  }

  /** 一轮全量监控检查（逐条串行，避免同时起多个浏览器）。返回触发提醒条数。 */
  async checkAllWatches(nowMs: number = this.clock()): Promise<number> {
    await this.ensureLoaded();
    const enabled = Array.from(this.watches.values()).filter((w) => w.enabled);
    if (enabled.length === 0) return 0;
    let hit = 0;
    for (const watch of enabled) {
      try {
        if (await this.checkWatch(watch, nowMs)) hit += 1;
      } catch (err) {
        console.log(`[ShoppingCompare] 监控「${watch.query}」@${watch.platform} 检查失败（跳过）: ${err}`);
      }
    }
    return hit;
  }

  /** 单条监控检查；到价且为新低价时回调 onPriceAlert。官方源优先（免 Cookie 直查）。 */
  async checkWatch(watch: PriceWatch, nowMs: number = this.clock()): Promise<boolean> {
    const ctx: ToolContext = { sessionId: "price-watch", userId: watch.actorId };
    const quotes = await this.fetchPlatformQuotes(ctx, watch.platform, watch.query, {
      sort: "price_asc",
      limit: 3,
    });
    if (quotes.products.length === 0) return false;

    // 取与关键词规格最贴合的最低价（首个结果即可：已按价格升序请求）
    const cheapest = quotes.products
      .filter((p) => p.price != null && p.price > 0)
      .sort((a, b) => (a.price ?? 0) - (b.price ?? 0))[0];
    if (!cheapest?.price) return false;

    watch.lastPriceCny = cheapest.price;
    watch.lastCheckedAt = nowMs;

    const isBelowTarget = cheapest.price <= watch.targetPrice;
    const isNewLow = watch.lastNotifiedPrice == null || cheapest.price < watch.lastNotifiedPrice * 0.98;
    if (isBelowTarget && isNewLow) {
      watch.lastNotifiedPrice = cheapest.price;
      try {
        this.onPriceAlert?.(watch.actorId, { ...watch }, {
          watch: { ...watch },
          priceCny: cheapest.price,
          title: cheapest.title,
          url: cheapest.url,
          source: cheapest.__source,
        });
      } catch (err) {
        console.log(`[ShoppingCompare] onPriceAlert 回调异常（忽略）: ${err}`);
      }
    }
    this.watches.set(watch.id, watch);
    this.persistWatches();
    return isBelowTarget && isNewLow;
  }

  // ---- 价格历史 ----

  /** 读取某 actor 某 keyword 的历史价格序列（时间升序）。 */
  async getPriceHistory(actorId: string, query: string): Promise<Array<{ ts: string; minPriceCny: number | null; platform: string }>> {
    await this.ensureLoaded();
    const q = query.trim();
    return this.history
      .filter((e) => e.actorId === actorId && e.query === q)
      .map((e) => ({ ts: e.ts, minPriceCny: e.minPriceCny, platform: e.platform }));
  }

  // ---- 内部 ----

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    const watchFile = join(this.dataDirOf(), "price-watches.json");
    const historyFile = join(this.dataDirOf(), "price-history.json");
    try {
      if (existsSync(watchFile)) {
        const parsed = JSON.parse(await readFile(watchFile, "utf8")) as WatchFileShape;
        for (const w of parsed.watches ?? []) {
          if (w?.id && w?.actorId && w?.query) this.watches.set(w.id, w);
        }
      }
    } catch (err) {
      console.warn("[ShoppingCompare] 监控文件损坏，从空开始", err);
    }
    try {
      if (existsSync(historyFile)) {
        const parsed = JSON.parse(await readFile(historyFile, "utf8")) as HistoryFileShape;
        this.history.push(...(parsed.entries ?? []).slice(-PRICE_HISTORY_MAX));
      }
    } catch (err) {
      console.warn("[ShoppingCompare] 价格历史文件损坏，从空开始", err);
    }
  }

  private dataDirOf(): string {
    return this.dataDir;
  }

  private persistWatches(): void {
    this.watchWriter.write({ watches: Array.from(this.watches.values()) });
  }

  private appendHistory(actorId: string, query: string, platform: string, minPriceCny: number | null): void {
    this.history.push({ ts: new Date().toISOString(), actorId, query, platform, minPriceCny });
    if (this.history.length > PRICE_HISTORY_MAX) this.history.splice(0, this.history.length - PRICE_HISTORY_MAX);
    this.historyWriter.write({ entries: this.history });
  }

  private findWatchId(actorId: string, target: string): string | null {
    const byId = this.watches.get(target);
    if (byId && byId.actorId === actorId) return byId.id;
    const t = target.trim().toLowerCase();
    const byName = Array.from(this.watches.values()).find(
      (w) => w.actorId === actorId && (w.query.toLowerCase() === t || w.id.toLowerCase() === t),
    );
    return byName?.id ?? null;
  }

  /** 测试/停机前：等待落盘完成 */
  async flush(): Promise<void> {
    await Promise.all([this.watchWriter.flush(), this.historyWriter.flush()]);
  }
}
