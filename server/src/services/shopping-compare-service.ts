/**
 * 购物比价服务（跨平台同款聚合 + 降价监控）。
 *
 * 取数只走 Playwright + 已授权 Cookie（内置浏览器兜底）：对同一关键词并行搜
 * 多平台，做同款归一聚合：
 *   - 标题归一化（去营销词/规格截断）+ 规格 token（容量/克重/型号）提取
 *   - 组内 Dice 相似度判定同款；低置信组标注「疑似同款」，不静默合并
 *   - 输出按价格升序的分组报价 + 全局最低价
 *
 * 附带能力：
 *   - 降价监控（price watch）：add/remove/list + 后台 tick 定时复查，
 *     到价经 onPriceAlert 回调主动推送（装配层接 ProactivityHub.submitIntent）
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
import { BROWSER_SESSION_SITES, type BrowserSessionSiteId } from "./browser-session-sites.js";
import { getLoginWaitMs } from "./browser-runtime/human-gate.js";
import { listDefaultComparePlatforms, listLoginRequiredL1Platforms } from "./shopping-platforms/index.js";
import type { ShoppingOrderService } from "./shopping-order-service.js";
import type { ProductSummary } from "./shopping-platforms/index.js";

// ─────────────────────────── 类型 ───────────────────────────

/** 单平台取数结果；loginRequired = 平台把页面拦到登录页（需用户本人登录） */
interface PlatformQuotes {
  products: ProductSummary[];
  error?: string;
  loginRequired?: boolean;
  /** 登录二维码真的落盘并推到聊天时的图片地址（推失败则无此字段）。 */
  loginQrImage?: string;
  /** 浏览器层给出的 human-required 硬信号（登录墙 / 验证码） */
  humanRequired?: { reason: "login" | "captcha"; evidence?: string };
}

/** 平台显示名（京东/拼多多…），未收录时回退平台标识。 */
function platformLabel(platform: string): string {
  return BROWSER_SESSION_SITES[platform as BrowserSessionSiteId]?.label ?? platform;
}

/**
 * 登录二维码「真的推出去了」的地址。
 * 只有工具回执带回 imageUrl 才算推送成功——不能拿「客户端在线」当已推送，
 * 否则会出现「服务端说二维码已推到聊天、用户一张也没收到」的空口承诺。
 */
function loginQrOf(res: unknown): string | undefined {
  const lr = (res as { loginRequired?: unknown } | null)?.loginRequired;
  if (!lr || typeof lr !== "object") return undefined;
  const url = (lr as { imageUrl?: unknown }).imageUrl;
  return typeof url === "string" && url.trim() ? url.trim() : undefined;
}

/** 单平台一条报价 */
export interface CompareOffer {
  platform: string;
  title: string;
  priceCny: number | null;
  shop?: string;
  url?: string;
  itemId?: string;
  /** 商品主图（浏览器抓取未提取时缺省） */
  imageUrl?: string;
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
  /** 组规格 token（容量/数量/型号；跨组可比性判定用） */
  specTokens: string[];
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
  /**
   * 「最低价」组的下标；null = 各组规格不一致（如 2 罐 vs 24 瓶），不构成同规格比价，
   * 展示端不得打「最低价」章、文案不得宣称最低价。
   */
  bestIndex: number | null;
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
}

export interface ShoppingCompareServiceDeps {
  shoppingOrderService: ShoppingOrderService;
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
   * 本轮有平台命中 human-required（登录墙/验证码）且可见浏览器可用：把这些平台
   * **一次**交给用户（长流程 handoff，建等待步 + 页面留在可见浏览器）。
   * 普通空结果/超时不会触发。回调异常/未注入不影响比价主流程，只在回执里如实标注。
   */
  onUserActionRequired?: (info: {
    actorId: string;
    sessionId: string;
    platforms: string[];
    platformLabels: string[];
    reason: "login" | "captcha";
  }) => void;
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
  /**
   * 商品主图落地（下载外部图 → 本服务静态路径 `/agent/images/...`）。
   * 必需性说明：手机端是**云端浏览器取价、聊天里看图**，外部平台图源普遍带
   * 防盗链/协议相对地址/WebP，客户端直连会大面积加载失败；这里统一转成本机
   * PNG 再给卡片，客户端只跟自己的服务端打交道。未注入时保留原始 URL（降级）。
   */
  imageStore?: {
    downloadAndStorePng(
      remoteUrl: string,
      actorId: string,
      timeoutMs?: number,
      sessionId?: string,
      opts?: { libraryHidden?: boolean },
    ): Promise<string>;
  };
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

/** 带平台归属的商品（跨平台聚合的输入单元） */
export interface TaggedProduct {
  platform: string;
  product: ProductSummary;
  /** 抓取时刻（ms） */
  fetchedAt?: number;
}

/**
 * 把跨平台商品列表聚成同款分组。
 * 贪心：按价格升序遍历；规格 token 不一致或无法验证时不并组，其余比 Dice 达阈值并入。
 */
export function groupSameProducts(items: TaggedProduct[]): CompareGroup[] {
  const sorted = [...items].sort(
    (a, b) => (a.product.price ?? Number.MAX_SAFE_INTEGER) - (b.product.price ?? Number.MAX_SAFE_INTEGER),
  );
  const groups: Array<{ rep: ProductSummary; repNorm: string; repSpecs: Set<string>; offers: CompareOffer[]; confidence: number; exact: boolean }> = [];

  for (const { platform, product: p, fetchedAt } of sorted) {
    const norm = normalizeTitle(p.title);
    const specs = new Set(extractSpecTokens(p.title));
    let placed = false;
    for (const g of groups) {
      // 规格 token 必须可验证一致才可并组：两边都有但不一致 → 不同规格；
      // 一边有一边没有 → 规格无法验证。都宁可拆开，不冒充同款比价。
      const specsMatch =
        g.repSpecs.size > 0 &&
        specs.size > 0 &&
        g.repSpecs.size === specs.size &&
        [...g.repSpecs].every((s) => specs.has(s));
      if (g.repSpecs.size > 0 || specs.size > 0) {
        if (!specsMatch) continue;
      }
      const sim = specsMatch ? 0.7 : diceSimilarity(g.repNorm, norm);
      if (sim >= SAME_PRODUCT_DICE_THRESHOLD) {
        g.offers.push(toOffer(platform, p, fetchedAt));
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
        offers: [toOffer(platform, p, fetchedAt)],
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
      specTokens: [...g.repSpecs],
      offers: g.offers,
    };
  });
}

/**
 * 从查询里提「拉丁主词」（英文/型号），用于丢弃平台搜索页里的无关推荐。
 * 搜「AirPods Pro 2」时苏宁会回漫步者/HUAWEI 耳机——那是相关推荐，不是同款。
 */
export function latinCoreToken(query: string): string {
  const lowered = query.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, " ").trim();
  const latin = lowered
    .split(/\s+/)
    .filter((t) => /[a-z0-9]/.test(t) && t.length >= 2)
    .sort((a, b) => b.length - a.length);
  return latin[0] ?? "";
}

/**
 * 从查询里提「中文主词」（品牌/品名首段），用于挡掉同类不同牌的结果。
 * 搜「蒙牛纯牛奶」时苏宁会回伊利——规格一样、牌子不同，不能当同款比价。
 */
const GENERIC_CN_WORDS = new Set([
  "女生", "男生", "适合", "推荐", "便宜", "好用", "新款", "正品",
  "官方", "旗舰", "包邮", "特价", "家用", "大容量", "学生", "儿童",
]);

export function cnCoreToken(query: string): string {
  const cn = query.replace(/[a-zA-Z0-9\s]+/g, " ").replace(/[^\u4e00-\u9fa5\s]/g, " ").trim();
  const first = (cn.split(/\s+/)[0] ?? "").trim();
  if (first.length < 2) return "";
  const core = first.slice(0, 2);
  return GENERIC_CN_WORDS.has(core) ? "" : core;
}

/**
 * 配件词：查询说的是主体（AirPods），搜索页会把保护套/贴膜一起返回。
 * 配件不是同款商品，价格差一个数量级，混进来会被标成「最合适」——
 * 真机事故：搜 AirPods 比价卡第一张是「磁吸式耳机套 ¥76.4 · 最合适」。
 * 只在**查询本身没提配件**时才拦（用户搜「AirPods 保护套」时要的正是它）。
 */
const ACCESSORY_WORDS = [
  "保护套", "保护壳", "耳机套", "保护膜", "贴膜", "钢化膜", "收纳盒", "收纳包",
  "防尘", "挂绳", "手机壳", "表带", "数据线", "充电线", "充电器", "转接头", "支架",
  "耳机帽", "耳塞套", "替换套",
];

function isAccessoryTitle(title: string, query: string): boolean {
  const q = query.toLowerCase();
  return ACCESSORY_WORDS.some((w) => title.includes(w) && !q.includes(w));
}

/**
 * 同款相关性闸：平台搜索页返回的「相关推荐」不是同款，进比价卡只会污染结果
 * （实测：搜 AirPods 出漫步者耳机、搜蒙牛出伊利、值得买出耳机推荐文章）。
 *
 * 丢弃规则：
 *   1) 没有价格 —— 连价都读不到，列出来会让用户以为有货；
 *   2) 配件（保护套/贴膜…）而当次查询没要配件；
 *   3) 查询里有品牌主词（拉丁/中文）时，标题必须全部命中；
 *   4) 都没有主词时，退回归一化标题 Dice ≥ 0.3（中文长查询不能靠包含式匹配）。
 */
export function filterSameProduct(query: string, products: ProductSummary[]): ProductSummary[] {
  const latin = latinCoreToken(query);
  const cn = cnCoreToken(query);
  const normQuery = normalizeTitle(query);
  return products.filter((p) => {
    if (p.price == null) return false;
    if (isAccessoryTitle(p.title, query)) return false;
    const title = p.title.toLowerCase();
    // 有主词就全部要命中：搜「蒙牛纯牛奶 250ml」时，伊利虽然也含 250ml，
    // 但没有「蒙牛」，是另一个牌子的同规格商品，不能混进同款比价。
    const checks: boolean[] = [];
    if (latin.length >= 2) checks.push(title.includes(latin));
    if (cn.length >= 2) checks.push(p.title.includes(cn));
    if (checks.length > 0) return checks.every(Boolean);
    return diceSimilarity(normQuery, normalizeTitle(p.title)) >= 0.3;
  });
}

function toOffer(platform: string, p: ProductSummary, fetchedAt?: number): CompareOffer {
  return {
    platform,
    title: p.title,
    priceCny: p.price ?? null,
    shop: p.shop,
    url: p.url,
    itemId: p.itemId,
    ...(p.imageUrl ? { imageUrl: p.imageUrl } : {}),
    ...(fetchedAt ? { fetchedAt } : {}),
  };
}

// ─────────────────────────── 持久化（watch） ───────────────────────────

interface WatchFileShape { watches?: PriceWatch[] }

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
  private readonly dataDir: string;
  private readonly watchWriter: JsonFileWriter;
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
   * 把比价结果里的外部主图落成本机静态图（`/agent/images/...`）。
   *
   * 为什么必须做：手机端没有可视浏览器，卡片里那张「真实照片」只能由服务端
   * 取回来再发给客户端。外部图源普遍有防盗链/协议相对地址/WebP，客户端直连
   * 会大面积空白——用户看到的就是「有价格没图」。
   *
   * 边界：限 12 张、并发 3、单张 8s；任何失败保留原始 URL，绝不因为图挂了
   * 让整轮比价失败（图是增强，不是结果）。
   */
  private async localizeGroupImages(actorId: string, groups: CompareGroup[]): Promise<void> {
    const store = this.deps.imageStore;
    if (!store) return;
    const cache = new Map<string, string>();
    const tasks: Array<() => Promise<void>> = [];
    for (const g of groups) {
      for (const o of g.offers) {
        const remote = o.imageUrl;
        if (!remote || !/^https?:\/\//.test(remote)) continue;
        tasks.push(async () => {
          let local = cache.get(remote);
          if (!local) {
            try {
              // 商品图只服务比价卡片，不进资料库（购物数据不参与「对话产出」归档）。
              local = await store.downloadAndStorePng(remote, actorId, 8_000, undefined, {
                libraryHidden: true,
              });
              cache.set(remote, local);
            } catch {
              return; // 落地失败：保留原 URL
            }
          }
          o.imageUrl = local;
        });
      }
    }
    if (tasks.length === 0) return;
    const capped = tasks.slice(0, 12);
    for (let i = 0; i < capped.length; i += 3) {
      await Promise.allSettled(capped.slice(i, i + 3).map((run) => run()));
    }
    // 组代表图是 groupSameProducts 时的快照，offer 换成本地图后要重算
    for (const g of groups) {
      const rep = g.offers.find((o) => o.imageUrl)?.imageUrl;
      if (rep) g.imageUrl = rep;
    }
  }

  /**
   * 单平台取报价：客户端在线时在**用户可见的内置浏览器**里真跑一遍
   * （页面导航/翻页/读数全程可见，用户能看到 agent 在干什么），
   * 内置浏览器不可用才回落 Playwright + 已授权 Cookie 的无头通道。
   */
  private async fetchPlatformQuotes(
    ctx: ToolContext,
    platform: string,
    query: string,
    opts: {
      maxPrice?: number;
      sort?: "default" | "price_asc" | "price_desc" | "sales";
      limit?: number;
      /** 内置浏览器可用时占着唯一面板，必须串行取数 */
      preferVisible?: boolean;
    } = {},
  ): Promise<PlatformQuotes> {
    const limit = Math.min(Math.max(opts.limit ?? 5, 1), 10);
    // 无头通道下二维码是用户登录的唯一入口：能推聊天时给足扫码时间，
    // 否则二维码刚推出去页面就被释放，手机端等于没有登录能力。
    const canReceiveQr = ctx.pushMediaCards != null;
    const loginWaitMs = opts.preferVisible === true || !canReceiveQr
      ? 20_000
      : Math.max(20_000, getLoginWaitMs());
    const res = await this.deps.shoppingOrderService.searchProduct(
      ctx,
      platform,
      query,
      {
        maxPrice: opts.maxPrice,
        sort: opts.sort ?? "price_asc",
        limit,
      },
      // 只读取数不占着工具预算等扫码：超时立刻交回登录 handoff，
      // 用户登录后由长流程续跑。逐平台的交接先抑制，等本轮汇总后统一交一次。
      { preferHeadless: opts.preferVisible !== true, loginWaitMs, suppressHandoff: true },
    );
    if (!res.ok) {
      const human = (res as { humanRequired?: { reason: "login" | "captcha"; evidence?: string } }).humanRequired;
      const qr = loginQrOf(res);
      return {
        products: [],
        error: redactCredentials(String((res as { error?: string }).error ?? "未知错误")),
        ...((res as { loginRequired?: unknown }).loginRequired ? { loginRequired: true } : {}),
        ...(qr ? { loginQrImage: qr } : {}),
        ...(human ? { humanRequired: human } : {}),
      };
    }
    const products = (res as { products?: ProductSummary[] }).products ?? [];
    if (products.length === 0) {
      // 空结果不算「查到了 0 个报价」：把原因（未登录/结构变更/无匹配）如实放进失败清单；
      // 浏览器层若已判到 human-required（登录墙/验证码），一并透传，供上层统一交接。
      const summary = String((res as { summary?: string }).summary ?? "").trim();
      const human = (res as { humanRequired?: { reason: "login" | "captcha"; evidence?: string } }).humanRequired;
      const qr = loginQrOf(res);
      return {
        products: [],
        error: summary || "未解析到商品（页面结构可能变更）",
        ...(qr ? { loginQrImage: qr } : {}),
        ...(human ? { humanRequired: human } : {}),
      };
    }
    return { products };
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
    // 缺省平台：综合电商（淘宝/天猫/京东/拼多多/抖音）∩ 已实现 adapter。
    // 列表由 adapter.category 派生（见 listDefaultComparePlatforms），非手写数组。
    // 本地生活（美团/大众点评）与演出票务不参与商品比价缺省——它们不卖标准
    // 商品，混进来只会白搜一轮还挤掉拼多多等真正可比的平台。
    const defaultPlatforms = listDefaultComparePlatforms().filter((p) => supported.includes(p));
    // 缺省集合 = 匿名可读真实价的平台（苏宁/什么值得买）+ 该用户**已有授权 Cookie**
    // 的登录类平台（淘宝/京东/拼多多…）。没登录态的平台不塞进缺省：手机端没有可视
    // 浏览器，塞进去只会整轮变成登录交接、一个价也拿不到。
    // 用户显式指定平台时按用户说的来（哪怕要登录）。
    let platformPool = opts.platforms?.length ? opts.platforms : defaultPlatforms;
    if (!opts.platforms?.length) {
      const loggedIn = await this.deps.shoppingOrderService
        .listPlatformsWithCookies(actorId, listLoginRequiredL1Platforms().filter((p) => supported.includes(p)))
        .catch(() => [] as string[]);
      platformPool = [...defaultPlatforms, ...loggedIn];
    }
    let requested = platformPool
      .map((p) => p.trim())
      .filter(Boolean)
      .slice(0, this.maxPlatforms);
    if (requested.length === 0) return { ok: false, error: "未指定有效平台" };
    const unsupported = requested.filter((p) => !supported.includes(p));
    if (unsupported.length === requested.length) {
      return { ok: false, error: `平台 ${unsupported.join("/")} 暂不支持。已实现：${supported.join("/")}` };
    }

    // 显式指定的平台**全是需要登录态**而且该用户一个都没登录时，这一轮注定
    // 只能出登录二维码（手机端尤其显著：模型自己填了 jd/pdd，用户等半天只等到
    // 一个扫码页）。这里先按免登录平台给出一轮真实报价，并在回执里说清楚
    // 「你要的那几家需要登录，这轮先用能读的平台比」——有价总比全是码有用，
    // 登录后下一轮自然覆盖到那几家。
    let loginFallbackNote = "";
    const loginPlatforms = new Set(listLoginRequiredL1Platforms());
    if (
      requested.length > 0 &&
      requested.every((p) => loginPlatforms.has(p)) &&
      defaultPlatforms.length > 0
    ) {
      const withCookies = await this.deps.shoppingOrderService
        .listPlatformsWithCookies(actorId, requested)
        .catch(() => [] as string[]);
      if (withCookies.length === 0) {
        loginFallbackNote =
          `${requested.map(platformLabel).join("、")}要登录才能读价，这轮先用免登录平台给你比：`;
        requested = defaultPlatforms.slice(0, this.maxPlatforms);
      }
    }

    // 取各平台报价（单平台失败不拖垮整体）。
    // 客户端在线 → 在用户可见的内置浏览器里串行跑（面板只有一个，全程可见）；
    // 否则无头并行（Playwright + 已授权 Cookie，不抢面板）。
    const visible = this.deps.shoppingOrderService.canUseVisibleBrowser(ctx);
    const fetchOpts = { ...opts, preferVisible: visible };
    const outcomes: Array<{ platform: string; quotes: PlatformQuotes }> = [];
    if (visible) {
      // 可见面板只有一个：某平台被登录墙/验证码拦住后，面板必须留在该页面等
      // 用户操作（最后统一 handoff）。此前直接 break，排在被墙平台之后的平台
      // 连尝试都没有——这是「比价只拿到一家」的主要代码层根因。
      // 现改为：被墙平台记入 pendingHandoff，其余平台回落**无头**通道继续取数
      // （无头不抢面板，登录页得以保留），最后仍合并成一次交接。
      let handoffPending = false;
      for (const platform of requested) {
        try {
          outcomes.push({
            platform,
            quotes: await this.fetchPlatformQuotes(ctx, platform, q, {
              ...fetchOpts,
              preferVisible: !handoffPending,
            }),
          });
        } catch (reason) {
          outcomes.push({
            platform,
            quotes: { products: [], error: reason instanceof Error ? reason.message : String(reason) },
          });
        }
        const last = outcomes[outcomes.length - 1]?.quotes;
        if (last?.loginRequired || last?.humanRequired) handoffPending = true;
      }
    } else {
      const settled = await Promise.allSettled(
        requested.map(async (platform) => ({
          platform,
          quotes: await this.fetchPlatformQuotes(ctx, platform, q, fetchOpts),
        })),
      );
      for (const s of settled) {
        if (s.status === "fulfilled") outcomes.push(s.value);
      }
    }

    const tagged: TaggedProduct[] = [];
    const searchedPlatforms: string[] = [];
    const failedPlatforms: string[] = [];
    /**
     * 没取到数的平台。只有 humanRequired=true 的才交人（登录墙/验证码）；
     * 普通空结果/读取失败只如实说明，不触发 handoff（主流 Agent 的约定）。
     */
    const unavailable: Array<{
      platform: string;
      label: string;
      reason: "login" | "captcha" | "no_data";
      humanRequired: boolean;
      detail?: string;
    }> = [];
    let loginPending: string | null = null;
    /** 登录二维码确实推到了聊天的平台（按真实推送结果记账，不按「在线」猜）。 */
    const qrPushedLabels: string[] = [];
    for (const { platform, quotes } of outcomes) {
      // 同款相关性闸：搜索页的「相关推荐」不是同款（搜 AirPods 出漫步者），
      // 直接进卡只会让用户以为我们比错了东西。过滤后为空 = 这家没有同款。
      const relevant = quotes.products.length > 0 ? filterSameProduct(q, quotes.products) : [];
      if (relevant.length > 0) {
        searchedPlatforms.push(platform);
        const fetchedAt = Date.now();
        for (const p of relevant) {
          tagged.push({ platform, product: p, fetchedAt });
        }
        continue;
      }
      const reason: "login" | "captcha" | "no_data" = quotes.loginRequired
        ? "login"
        : quotes.humanRequired?.reason ?? "no_data";
      unavailable.push({
        platform,
        label: platformLabel(platform),
        reason,
        humanRequired: reason !== "no_data",
        ...(quotes.error ? { detail: quotes.error } : {}),
      });
      if (quotes.loginRequired) loginPending = platform;
      if (quotes.loginQrImage) qrPushedLabels.push(platformLabel(platform));
      if (quotes.error) failedPlatforms.push(`${platformLabel(platform)}（${platform}）：${quotes.error}`);
    }

    // 只有浏览器层判到 human-required（登录墙/验证码）才把执行权交给用户；
    // 一轮里有多个这样的平台时合并成**一次**交接。普通失败不打扰用户。
    const needHuman = unavailable.filter((u) => u.humanRequired);
    const needUserReason: "login" | "captcha" =
      needHuman.some((u) => u.reason === "login") ? "login" : "captcha";
    const needUserLabels = needHuman.map((u) => u.label);
    let handoff:
      | {
          platforms: string[];
          labels: string[];
          reason: "login" | "captcha";
          instruction: string;
          doneAction: string;
        }
      | undefined;
    if (needHuman.length > 0) {
      // 可见浏览器在线：页面留在登录/验证页，交用户现场操作（长流程等待步）。
      // 无头通道（手机端/面板不可用）：二维码是唯一登录入口，能推聊天时已推到聊天，
      // 等待窗口也按 SHOPPING_LOGIN_WAIT_MS 留足；只有推不了图时才引导用户开浏览器。
      const canReceiveQr = qrPushedLabels.length > 0;
      const waitSeconds = Math.round(Math.max(20_000, getLoginWaitMs()) / 1000);
      const qrTargets = qrPushedLabels.length > 0 ? `${qrPushedLabels.join("、")}的登录二维码已推到聊天` : "";
      const instruction = visible
        ? (needUserReason === "login"
            ? `已在内置浏览器打开${needUserLabels.join("、")}的页面：需要扫码登录的平台请先登录，完成后点「我已完成」，我接着把价补上。`
            : `${needUserLabels.join("、")}需要完成安全验证（滑块/验证码）：页面已停在浏览器里，验证完点「我已完成」，我接着把价补上。`)
        : canReceiveQr
          ? (needUserReason === "login"
              ? `${qrTargets}（最长等待约 ${waitSeconds} 秒），请在手机上扫码登录，完成后回复「我已完成」，我接着把价补上；若二维码已失效，回复后我会重新发起并再推一次。`
              : `${qrTargets}，请按提示完成验证后回复「我已完成」，我接着把价补上。`)
          : `${needUserLabels.join("、")}需要你本人登录才能取价，但这轮二维码没能推到聊天（客户端不在线或图片服务未装配）。请稍后重试比价，我会重新发起并再推一次。`;
      if (visible) {
        try {
          this.deps.onUserActionRequired?.({
            actorId,
            sessionId: ctx.sessionId,
            platforms: needHuman.map((u) => u.platform),
            platformLabels: needUserLabels,
            reason: needUserReason,
          });
        } catch (err) {
          console.log(`[ShoppingCompare] 用户交接失败（忽略）: ${err}`);
        }
      }
      handoff = {
        platforms: needHuman.map((u) => u.platform),
        labels: needUserLabels,
        reason: needUserReason,
        instruction,
        doneAction: "我已完成",
      };
    }

    if (tagged.length === 0) {
      return {
        ok: false,
        error:
          `${loginFallbackNote}所有平台均未返回「${q}」的结果。` +
          (handoff
            ? handoff.instruction
            : failedPlatforms.length
              ? `失败详情：${failedPlatforms.join("；")}`
              : "可能登录态失效，请检查 Cookie 导入与授权"),
        retryable: true,
        ...(unavailable.length > 0 ? { unavailablePlatforms: unavailable } : {}),
        ...(handoff ? { handoff } : {}),
      };
    }

    // 跨平台同款归一聚合（组内 offers 已按价格升序）
    const groups = groupSameProducts(tagged);
    // 主图落地：外部图源（防盗链/协议相对/WebP）→ 本机 PNG 静态路径。
    // 手机端是「云端浏览器取价、聊天里看图」，客户端只跟自己服务端取图，
    // 不去直连京东/苏宁/值得买的图床。失败保留原 URL（卡片仍有可视图）。
    await this.localizeGroupImages(actorId, groups);
    // 按组内最低价升序
    groups.sort((a, b) => (a.minPriceCny ?? Number.MAX_SAFE_INTEGER) - (b.minPriceCny ?? Number.MAX_SAFE_INTEGER));

    // 跨组可比性：数字规格 token（数量/容量，如 2罐 vs 24瓶）必须各组完全一致，
    // 型号 token 互为子集即可（写法繁简）；任一组无规格而他组有 → 无法验证同数量；
    // 全部组都无规格时无从冲突，维持 Dice 归一原判。不可比只列报价，不宣称「最低价」。
    const digitSpecs = (ts: string[]) => ts.filter((s) => /^\d/.test(s));
    const letterSpecs = (ts: string[]) => ts.filter((s) => !/^\d/.test(s));
    const pairComparable = (a: string[], b: string[]) =>
      digitSpecs(a).join("|") === digitSpecs(b).join("|") &&
      (letterSpecs(a).every((s) => letterSpecs(b).includes(s)) ||
        letterSpecs(b).every((s) => letterSpecs(a).includes(s)));
    const anySpec = groups.some((g) => g.specTokens.length > 0);
    const comparable =
      groups.length > 1 &&
      (!anySpec ||
        (groups.every((g) => g.specTokens.length > 0) &&
          groups.every((g, i) =>
            groups.every((h, j) => j >= i || pairComparable(g.specTokens, h.specTokens)),
          )));
    const bestIndex = comparable ? 0 : null;

    const bestOffer: CompareOffer | null = groups[0]?.offers[0] ?? null;

    const platformSummary = searchedPlatforms.join("/");
    const bestText =
      comparable && bestOffer?.priceCny != null ? `，同规格最低 ¥${bestOffer.priceCny}（${bestOffer.platform}）` : "";
    const loginText = loginPending
      ? `；${platformLabel(loginPending)}需要登录，登录完我接着把${platformLabel(loginPending)}的价补上`
      : "";
    // 没取到数的平台分两类文案：需要用户登录/验证的（交人），与普通无匹配/读取失败的（如实说明）
    const noDataLabels = unavailable.filter((u) => !u.humanRequired).map((u) => u.label);
    const noDataText = noDataLabels.length
      ? `；${noDataLabels.join("、")}这次没取到报价（无匹配或读取失败）`
      : "";
    const verifyLabels = needHuman.filter((u) => u.reason === "captcha").map((u) => u.label);
    const verifyText = verifyLabels.length
      ? `；${verifyLabels.join("、")}需要完成安全验证，验证完我接着补价`
      : "";

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
        bestIndex,
        fetchedAt,
      });
      if (pageId) decisionPageUrl = `/shopping/decision-page?id=${encodeURIComponent(pageId)}`;
    } catch (err) {
      console.log(`[ShoppingCompare] 决策页存档失败（忽略）: ${err}`);
    }

    return {
      ok: true,
      summary: `${loginFallbackNote}「${q}」跨 ${platformSummary || requested.length} 个平台聚合出 ${groups.length} 组报价${bestText}${loginText}${verifyText}${noDataText}`,
      query: q,
      platforms: requested,
      searchedPlatforms,
      groups,
      bestOffer,
      bestIndex,
      fetchedAt,
      ...(loginPending ? { loginRequired: { platform: loginPending, label: platformLabel(loginPending) } } : {}),
      ...(unavailable.length > 0 ? { unavailablePlatforms: unavailable } : {}),
      ...(handoff ? { handoff } : {}),
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

  /** 单条监控检查；到价且为新低价时回调 onPriceAlert。 */
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
        });
      } catch (err) {
        console.log(`[ShoppingCompare] onPriceAlert 回调异常（忽略）: ${err}`);
      }
    }
    this.watches.set(watch.id, watch);
    this.persistWatches();
    return isBelowTarget && isNewLow;
  }

  // ---- 内部 ----

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    const watchFile = join(this.dataDirOf(), "price-watches.json");
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
  }

  private dataDirOf(): string {
    return this.dataDir;
  }

  private persistWatches(): void {
    this.watchWriter.write({ watches: Array.from(this.watches.values()) });
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
    await this.watchWriter.flush();
  }
}
