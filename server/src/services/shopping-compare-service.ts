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

/**
 * 一轮比价的「待登录会话」（2026-11-13 P1）。
 *
 * 为什么需要它：登录闸门把任务挂起后，用户是在**卡片里**完成登录的（扫码 /
 * 跳过这家 / 让二维码重推），这些动作都不经过模型。如果不留住「这一轮要比
 * 什么、哪几家待登录、哪家被跳过了」，卡片就没法自己把这一轮续跑完——
 * 只能退回去让用户再说一句「我扫好了」，多一轮往返，还容易漏。
 */
export interface PendingCompareSession {
  id: string;
  actorId: string;
  /** 会话 id（与 actorId 一起定位唯一一轮） */
  sessionId: string;
  query: string;
  /** 续跑时要沿用的取价参数 */
  opts: {
    maxPrice?: number;
    sort?: "default" | "price_asc" | "price_desc" | "sales";
    limit?: number;
  };
  /** 本轮参与比价的全部平台 */
  platforms: string[];
  /** 需要用户登录的平台 */
  loginPlatforms: string[];
  /** 用户主动「跳过这家」的平台 */
  skipped: string[];
  /** 已推给用户的登录二维码（platform → 图片地址 + 点码深链），跳过一家后重发其余 */
  qrItems: Array<{ platform: string; platformLabel: string; qrImage: string; qrLink?: string; qrLinkFallback?: string }>;
  createdAt: number;
  expiresAt: number;
}

/** 待登录会话的存活时长：二维码本身约 2–5 分钟失效，给 20 分钟余量够用户从容处理。 */
const PENDING_COMPARE_TTL_MS = 20 * 60 * 1000;

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

/**
 * 布尔型 env（2026-11-13）：开关型配置要能显式关掉（"0"/"false"/"off"），
 * 不能像 [readEnvInt] 那样把 0 当无效值回退到默认值——否则「关掉批量模式」
 * 这个操作根本做不到。
 */
function readEnvBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  const v = raw.trim().toLowerCase();
  if (v === "0" || v === "false" || v === "off" || v === "no") return false;
  if (v === "1" || v === "true" || v === "on" || v === "yes") return true;
  return fallback;
}

export class ShoppingCompareService {
  private readonly watches = new Map<string, PriceWatch>();
  /**
   * 待登录的比价会话（2026-11-13 P1）：登录闸门挂起后留给卡片动作续跑用的
   * 凭据。key = `${actorId}::${sessionId}`（同一会话只保留最近一轮）。
   */
  private readonly pendingCompares = new Map<string, PendingCompareSession>();
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
  /** 缺省轮首次比价的登录探测平台数：一次做齐多平台登录建档（2026-11-12）。 */
  private readonly loginProbeCount = readEnvInt("SHOPPING_COMPARE_LOGIN_PROBE_COUNT", 3);
  /**
   * 登录批量模式（2026-11-13 P0-2，默认开）：一次把本轮**所有**需要登录的
   * 平台推码（合并成一张登录卡），而不是撞墙一家推一家。
   *
   * 用户投诉：「说让我补京东的登录之后再补」——一次一张的预算让用户要扫三轮
   * 才能比完。对齐主流 agent（Grok Bot / Muse / ChatGPT Agent）的做法：
   * 需要用户本人做的环节**一次交齐**，用户处理完直接续跑。
   * 关掉（=0）则退回旧的「一次一张」行为，便于灰度对比。
   */
  private readonly loginBatchMode = readEnvBool("SHOPPING_COMPARE_LOGIN_BATCH", true);
  /**
   * 预检登录墙（2026-11-13 P0-1，默认开）：取价**之前**先探出所有要登录的
   * 平台，一次推码、等用户登录完，再统一取价、一次性交付。
   * 关掉则退回旧的「边取边撞墙」行为。
   */
  private readonly preflightLoginMode = readEnvBool("SHOPPING_COMPARE_PREFLIGHT", true);
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
   * 登录态预检（2026-11-13 P0-1）：**只探测登录墙，不取价**。
   *
   * 现状问题：登录态是「取价时顺手撞出来的」，所以永远半路撞墙——先交一份
   * 半成品答案，再让用户补登录（用户投诉：说让我补京东登录之后再补）。
   *
   * 改成两段式：先把所有待登录平台一次性探出来并推码（合并成一张登录卡），
   * 等用户扫码登录完，再统一取价、一次性交付。
   *
   * 只探登录墙（不抓商品）：用 adapter 的搜索页 URL 走一次导航，判登录页。
   * 命中即登记 needsLogin；不命中则该平台匿名可读，直接进取价队列。
   */
  private async preflightLogin(
    ctx: ToolContext,
    platforms: string[],
    query: string,
    opts: { preferVisible?: boolean } = {},
  ): Promise<{ needsLogin: string[]; ready: string[] }> {
    const needsLogin: string[] = [];
    const ready: string[] = [];
    const service = this.deps.shoppingOrderService;
    for (const platform of platforms) {
      // 已有授权 Cookie 的平台不必探（登录态确定）。
      // 注意：这里用 try/catch 而非 .catch()——被替换/裁剪过的 service 实现
      // 可能**同步**抛（方法不存在时是 TypeError），.catch() 抓不到同步抛出。
      let hasCookie = false;
      try {
        const list = await service.listPlatformsWithCookies(resolveActorId(ctx), [platform]);
        hasCookie = Array.isArray(list) && list.includes(platform);
      } catch {
        hasCookie = false;
      }
      if (hasCookie) {
        ready.push(platform);
        continue;
      }
      try {
        const probe = await service.probeLoginWall(ctx, platform, query, {
          preferVisible: opts.preferVisible,
        });
        if (probe?.required) needsLogin.push(platform);
        else ready.push(platform);
      } catch {
        // 探测失败不当登录墙：交给取价阶段的真实结果判定
        ready.push(platform);
      }
    }
    return { needsLogin, ready };
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
      /**
       * 覆盖登录等待时长。缺省轮的登录探测平台用短等待：推码确认送达后
       * 快速转 pendingLogins 后台续命（二维码仍有效，用户扫码后下一轮收割），
       * 不让一次没人在场的扫码把整轮比价拖住两分钟。
       */
      loginWaitMsOverride?: number;
    } = {},
  ): Promise<PlatformQuotes> {
    const limit = Math.min(Math.max(opts.limit ?? 5, 1), 10);
    // 无头通道下二维码是用户登录的唯一入口：能推聊天时给足扫码时间，
    // 否则二维码刚推出去页面就被释放，手机端等于没有登录能力。
    const canReceiveQr = ctx.pushMediaCards != null;
    const loginWaitMs = opts.loginWaitMsOverride
      ?? (opts.preferVisible === true || !canReceiveQr
        ? 20_000
        : Math.max(20_000, getLoginWaitMs()));
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
    opts: {
      platforms?: string[];
      maxPrice?: number;
      sort?: "default" | "price_asc" | "price_desc" | "sales";
      limit?: number;
      /**
       * 续跑参数（2026-11-13 P1）：登录闸门挂起后，用户在卡片里登录/跳过后
       * 再续跑这一轮时传入。存在即表示「这是续跑」——
       *   · assumeLogin：已知仍需登录的平台（不再进闸门，直接记入「未取到」）
       *   · skipped：用户主动「跳过这家」的平台（记入「未取到」，原因=已跳过）
       */
      pending?: { assumeLogin?: string[]; skipped?: string[] };
    } = {},
  ): Promise<
    | ({ ok: true; summary: string } & CompareResult & Record<string, unknown>)
    | {
        ok: false;
        error: string;
        retryable?: boolean;
        /**
         * 本轮因登录墙挂起，**尚未产出任何报价**（2026-11-13 P0-3）。
         * 模型据此知道不能先给半个答案，只能让用户扫码后继续。
         */
        awaitingLogin?: boolean;
        loginRequired?: {
          platform: string;
          label: string;
          platforms?: string[];
          platformLabels?: string[];
          pushedLabels?: string[];
        };
        handoff?: {
          platforms: string[];
          labels: string[];
          reason: "login" | "captcha";
          instruction: string;
          doneAction: string;
        };
        unavailablePlatforms?: Array<Record<string, unknown>>;
        retryHint?: string;
      }
  > {
    const actorId = resolveActorId(ctx);
    const q = query.trim();
    if (!q) return { ok: false, error: "缺少 query（比价关键词）" };
    // 续跑模式（2026-11-13 P1）：这一轮是登录闸门挂起后被卡片动作续跑的。
    // 平台池在原轮已经定好，续跑时**不再扩池**、也不再走「点名的都是登录平台
    // 就塞免登录平台保底」那套——否则会把用户明确跳过的平台又塞回来。
    const pending = opts.pending;
    const isResume = pending != null;
    const assumeLoginSet = new Set(pending?.assumeLogin ?? []);
    const skippedSet = new Set(pending?.skipped ?? []);
    const supported = this.deps.shoppingOrderService.listSupportedPlatforms();
    // 免登录平台（苏宁/什么值得买）：匿名能读到真实价，是每轮比价的保底出价来源。
    // 列表由 adapter.category 派生（见 listDefaultComparePlatforms），非手写数组。
    // 本地生活（美团/大众点评）与演出票务不参与商品比价缺省——它们不卖标准
    // 商品，混进来只会白搜一轮还挤掉拼多多等真正可比的平台。
    const defaultPlatforms = listDefaultComparePlatforms().filter((p) => supported.includes(p));
    // 缺省轮平台池 = 免登录平台 + 该用户**已有授权 Cookie** 的登录类平台
    // （淘宝/京东/拼多多…）+ **首次比价一次做齐的多平台登录探测**（2026-11-12
    // 二次改版，见下）。用户显式指定平台时按用户说的来（哪怕要登录）。
    const isDefaultRound = !opts.platforms?.length;
    let platformPool = opts.platforms?.length ? opts.platforms : defaultPlatforms;
    const loginCandidates = listLoginRequiredL1Platforms().filter((p) => supported.includes(p));
    let loginProbePlatforms: string[] = [];
    if (isDefaultRound) {
      const loggedIn = await this.deps.shoppingOrderService
        .listPlatformsWithCookies(actorId, loginCandidates)
        .catch(() => [] as string[]);
      platformPool = [...defaultPlatforms, ...loggedIn];
      // 登录探测：用户还没有登录态的主流登录平台**一次带上多家**（注册表序，
      // 默认前 3 家）。第一次比价就是登录建档的时机：各自把登录二维码推到聊天
      // （手机端唯一登录入口），用户一次扫完，Cookie 落库后以后每轮比价自动
      // 带上这些平台的实时价——而不是「比一次扫一次」。撞墙推码、短等待、
      // 超时转 pendingLogins 下一轮收割，免登录平台照常保底出价。
      loginProbePlatforms = loginCandidates
        // tmall 与淘宝同账号同 SSO，淘宝搜索结果本就覆盖天猫店（offers 常直接
        // 出现天猫商品），单独探测只会多一张重复的码；tmall 已有 Cookie 时
        // 照常走 loggedIn 并入池，不受此影响。
        .filter((p) => p !== "tmall")
        .filter((p) => !loggedIn.includes(p))
        .slice(0, this.loginProbeCount);
      platformPool.push(...loginProbePlatforms);
    }
    const requestedRaw = platformPool
      .map((p) => p.trim())
      .filter(Boolean);
    let requested = [...new Set(requestedRaw)].slice(0, this.maxPlatforms);
    // 登录探测平台不参与截断：免登录 + 已登录平台照常进池，探测平台追加在
    // 尾部（无头通道并行取数，多两三个探测页成本可控；换首次建档的体验值）。
    if (loginProbePlatforms.length > 0) {
      const missing = loginProbePlatforms.filter((p) => !requested.includes(p));
      if (missing.length > 0) {
        requested = [...requested.slice(0, this.maxPlatforms), ...missing];
      }
    }
    if (requested.length === 0) return { ok: false, error: "未指定有效平台" };
    const unsupported = requested.filter((p) => !supported.includes(p));
    if (unsupported.length === requested.length) {
      return { ok: false, error: `平台 ${unsupported.join("/")} 暂不支持。已实现：${supported.join("/")}` };
    }

    // 用户显式点名的平台**全是需要登录态**而且该用户一个都没登录时（2026-11-12
    // 改版）：**不再整体回退到免登录平台**——原实现会把 requested 整个替换成
    // 免登录平台，登录墙永远碰不到，二维码永远不会推（用户投诉的根因）。
    // 现改为：点名的平台照常进池尝试（撞墙即推码），同时并入免登录平台保底
    // 出价——「有价」与「能登录」两者兼得，回执里说明清楚即可。
    let loginFallbackNote = "";
    const loginPlatforms = new Set(listLoginRequiredL1Platforms());
    if (
      !isDefaultRound &&
      !isResume &&
      requested.every((p) => loginPlatforms.has(p)) &&
      defaultPlatforms.length > 0
    ) {
      const withCookies = await this.deps.shoppingOrderService
        .listPlatformsWithCookies(actorId, requested)
        .catch(() => [] as string[]);
      if (withCookies.length === 0) {
        const requestedLabels = requested.map(platformLabel).join("、");
        // 点名登录平台**不再截断**、保底平台追加在尾部：截断会让「首次比价登录
        // 多平台建档」少推码（实测模型常一次填 taobao/tmall/jd/pdd 四家，截到 2 家
        // 只推 2 张码）；而「保底被挤光 → 整轮零报价」的教训靠追加而非挤占来解决。
        // 无头通道并行取数，多两三个探测页成本可控。
        const extra = defaultPlatforms.filter((p) => !requested.includes(p)).slice(0, 2);
        if (extra.length > 0) {
          requested = [...requested, ...extra];
          loginFallbackNote =
            `${requestedLabels}要登录才能读价，这轮先尝试（一次只推一张登录二维码，其余等你扫完我再逐个接入），同时用免登录平台保底先比：`;
        }
      }
    }

    // 取各平台报价（单平台失败不拖垮整体）。
    // 客户端在线 → 在用户可见的内置浏览器里串行跑（面板只有一个，全程可见）；
    // 否则无头并行（Playwright + 已授权 Cookie，不抢面板）。
    const visible = this.deps.shoppingOrderService.canUseVisibleBrowser(ctx);
    const fetchOpts = { ...opts, preferVisible: visible };
    // 缺省轮登录探测平台的扫码等待：推码确认后快速交回（后台 pendingLogins 续命），
    // 不让一次没人在场的扫码把整轮比价拖住两分钟。可用 env 调整。
    const probeWaitMs = readEnvInt("SHOPPING_COMPARE_LOGIN_PROBE_WAIT_MS", 30_000);
    const waitOverrideFor = (platform: string): number | undefined =>
      isDefaultRound && loginProbePlatforms.includes(platform) ? probeWaitMs : undefined;

    // ── 推码预算（2026-11-12 用户拍板：**一次只推一张二维码**）──
    // 登录族平台（需要登录态的，含已有 Cookie 的）全部**串行**取数：第一个
    // 真正撞上登录墙/验证码并推送交接卡的平台用掉本轮预算，之后的登录平台
    // **不再取数**、如实延后到下一轮（用户完成扫码后逐个接入）——避免一轮
    // 把聊天刷成码墙。免登录平台不受预算约束，照常（并行/串行）取数保底。
    let qrBudgetUsed = false;
    const deferredLoginPlatforms: string[] = [];
    const loginQueue = requested.filter((p) => loginPlatforms.has(p));
    const nonLoginPlatforms = requested.filter((p) => !loginPlatforms.has(p));

    // 续跑分流（2026-11-13 P1）：
    //   · 用户「跳过这家」的平台 → 不取价，记入「未取到（已跳过）」
    //   · 已知仍需登录的平台 → 不取价，记入「未取到（需要登录）」
    // 这两类平台**不进预检、不进闸门**：用户已经表过态了，再拦一次就是
    // 「不让人把流程走完」。
    const bypassPlatforms = new Set<string>([...assumeLoginSet, ...skippedSet]);
    const probeQueue = loginQueue.filter((p) => !bypassPlatforms.has(p));
    const fetchNonLoginPlatforms = nonLoginPlatforms.filter((p) => !skippedSet.has(p));

    const outcomes: Array<{ platform: string; quotes: PlatformQuotes }> = [];
    let handoffPending = false;
    const tryFetch = async (platform: string, preferVisible: boolean): Promise<void> => {
      const waitOverride = waitOverrideFor(platform);
      try {
        outcomes.push({
          platform,
          quotes: await this.fetchPlatformQuotes(ctx, platform, q, {
            ...fetchOpts,
            preferVisible,
            ...(waitOverride ? { loginWaitMsOverride: waitOverride } : {}),
          }),
        });
      } catch (reason) {
        outcomes.push({
          platform,
          quotes: { products: [], error: reason instanceof Error ? reason.message : String(reason) },
        });
      }
    };

    // ── P0-1 预检登录墙（2026-11-13）──
    // 取价**之前**先探出所有要登录的平台。为什么必须前置：
    // 旧流程是「边取边撞墙」——免登录平台取完价就返回 ok:true，LLM 拿到数据
    // 直接总结输出，用户看到的是**半成品答案**（+一句"京东要登录，之后补"）。
    // 前置预检让「登录」成为任务的第一阶段而不是中途打断。
    const preflight = this.preflightLoginMode
      ? await this.preflightLogin(ctx, probeQueue, q, { preferVisible: visible })
      : { needsLogin: [] as string[], ready: probeQueue };
    const preflightBlocked = preflight.needsLogin.length > 0 && !isResume;

    // 续跑模式（2026-11-13 P1）：用户已经表过态了（登录过/跳过），这一轮
    // **不再被闸门拦住**。预检发现仍需登录的平台 → 归入「未取到」清单，
    // 由卡片如实呈现，不打断整轮交付。
    if (isResume) {
      for (const p of preflight.needsLogin) bypassPlatforms.add(p);
    }

    // ── P0-3 登录闸门（2026-11-13）──
    // 预检探到需要登录的平台 → **先推码、挂起任务**，不取价、不交答案。
    //
    // 为什么必须在这里拦（旧位置在取价之后，是错的）：旧流程是「边取边撞墙」
    // ——免登录平台取完价就返回 ok:true，LLM 拿到数据直接总结输出，用户看到
    // 半成品答案 +「京东要登录，之后补」。用户要的是「先给二维码，等登录完
    // 再一次性交付」——所以闸门必须在**任何取价之前**。
    if (preflightBlocked && preflight.needsLogin.length > 0) {
      const labels = preflight.needsLogin.map((p) => platformLabel(p));
      // 批量推码：一次把要登录的几家全推出去（合并成一张多平台登录卡），
      // 用户扫任意一张即可全部放行——不再「补完京东再说淘宝」。
      // 用 try/catch 而非 .catch()：service 实现可能同步抛（方法缺失等）。
      let pushed = new Map<string, { imageUrl: string; qrLink?: string; qrLinkFallback?: string }>();
      try {
        const result = await this.deps.shoppingOrderService.pushBatchLoginQrs(
          ctx,
          preflight.needsLogin,
          q,
        );
        if (result) pushed = result;
      } catch (err) {
        console.log(`[ShoppingCompare] 批量推码失败（忽略）: ${err}`);
      }
      const pushedLabels = preflight.needsLogin
        .filter((p) => pushed.has(p))
        .map((p) => platformLabel(p));
      // 记住这一轮（2026-11-13 P1）：卡片里的「跳过这家 / 重新出码 / 继续比价」
      // 都要靠它续跑——不记的话，卡片只能把用户推回对话里再说一遍。
      this.rememberPendingCompare(ctx, {
        query: q,
        opts: {
          ...(opts.maxPrice != null ? { maxPrice: opts.maxPrice } : {}),
          ...(opts.sort ? { sort: opts.sort } : {}),
          ...(opts.limit != null ? { limit: opts.limit } : {}),
        },
        platforms: requested,
        loginPlatforms: preflight.needsLogin,
        skipped: [],
        qrItems: preflight.needsLogin
          .filter((p) => pushed.has(p))
          .map((p) => {
            const q = pushed.get(p)!;
            return {
              platform: p,
              platformLabel: platformLabel(p),
              qrImage: q.imageUrl,
              ...(q.qrLink ? { qrLink: q.qrLink } : {}),
              ...(q.qrLinkFallback ? { qrLinkFallback: q.qrLinkFallback } : {}),
            };
          }),
      });
      // 可见浏览器在线：页面留给用户现场登录（长流程 handoff）
      if (visible) {
        try {
          this.deps.onUserActionRequired?.({
            actorId,
            sessionId: ctx.sessionId,
            platforms: preflight.needsLogin,
            platformLabels: labels,
            reason: "login",
          });
        } catch (err) {
          console.log(`[ShoppingCompare] 用户交接失败（忽略）: ${err}`);
        }
      }
      const canReceive = pushedLabels.length > 0;
      const waitSeconds = Math.round(Math.max(20_000, getLoginWaitMs()) / 1000);
      const instruction = canReceive
        ? `${pushedLabels.join("、")}的登录二维码已推到聊天${pushedLabels.length > 1 ? "（扫任意一个即可）" : ""}` +
          `（最长等待约 ${waitSeconds} 秒）。请扫码登录，登录完我会自动把${labels.join("、")}的价格一起补齐，给你完整的比价结果。`
        : `${labels.join("、")}需要你本人登录才能取价，但这轮二维码没能推到聊天（客户端不在线或图片服务未装配）。请稍后重试比价。`;
      return {
        ok: false,
        error: `「${q}」比价进行中：${instruction}`,
        retryable: true,
        // 明确标记：本轮尚未产出任何报价，模型不得编造价格
        awaitingLogin: true,
        loginRequired: {
          platform: preflight.needsLogin[0]!,
          label: platformLabel(preflight.needsLogin[0]!),
          platforms: preflight.needsLogin,
          platformLabels: labels,
          ...(pushedLabels.length > 0 ? { pushedLabels } : {}),
        },
        handoff: {
          platforms: preflight.needsLogin,
          labels,
          reason: "login" as const,
          instruction,
          doneAction: "我已完成",
        },
      };
    }

    // 免登录平台先取价：它们是本轮报价主体，不该被登录等待拖住。
    if (visible) {
      // 可见面板只有一个：被登录墙/验证码拦住的平台留在面板上等用户操作，
      // 其余平台回落**无头**通道继续取数（不抢面板），最后仍合并成一次交接。
      for (const platform of fetchNonLoginPlatforms) {
        await tryFetch(platform, !handoffPending);
        const last = outcomes[outcomes.length - 1]?.quotes;
        if (last?.loginRequired || last?.humanRequired) handoffPending = true;
      }
    } else {
      const settled = await Promise.allSettled(
        fetchNonLoginPlatforms.map(async (platform) => ({
          platform,
          quotes: await this.fetchPlatformQuotes(ctx, platform, q, fetchOpts),
        })),
      );
      for (const s of settled) {
        if (s.status === "fulfilled") outcomes.push(s.value);
      }
    }

    // 登录族平台串行过推码预算：撞墙即停（后续延后），没撞墙（匿名可读或
    // 已有 Cookie 正常出价）则继续下一家。
    //
    // 2026-11-13 P0-2 改版：预算不再是「一张」，而是**本轮 needsLogin 的全部
    // 平台**——用户投诉「说让我补京东的登录之后再补」，一次只推一张导致用户
    // 要扫三轮才能比完。现在一次把要登录的几家全推出去（合并成一张登录卡，
    // 卡内分区展示），用户扫任意一张即可全部放行。
    //
    // 2026-11-13 P1：队列换成 probeQueue——续跑时「用户跳过的 / 仍需登录的」
    // 已经在 bypassPlatforms 里，不该再被推码打扰。
    for (const platform of preflight.ready) {
      if (qrBudgetUsed && !this.loginBatchMode) {
        deferredLoginPlatforms.push(platform);
        continue;
      }
      await tryFetch(platform, visible && !handoffPending);
      const quotes = outcomes[outcomes.length - 1]?.quotes;
      if (quotes?.loginRequired || quotes?.humanRequired || quotes?.loginQrImage) {
        qrBudgetUsed = true;
        handoffPending = true;
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
      /** skipped = 用户主动「跳过这家」（2026-11-13 P1） */
      reason: "login" | "captcha" | "no_data" | "skipped";
      humanRequired: boolean;
      detail?: string;
    }> = [];
    const loginPendingPlatforms: string[] = [];
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
      if (quotes.loginRequired) loginPendingPlatforms.push(platform);
      if (quotes.loginQrImage) qrPushedLabels.push(platformLabel(platform));
      if (quotes.error) failedPlatforms.push(`${platformLabel(platform)}（${platform}）：${quotes.error}`);
    }

    // 续跑时没进取价队列的平台（2026-11-13 P1）：如实进「未取到」清单。
    //   · 用户点过「跳过这家」→ 原因=已跳过（不是平台的问题，是用户的选择）
    //   · 已知仍需登录 → 原因=需要登录（用户已表过态，不再打断整轮交付）
    for (const platform of bypassPlatforms) {
      if (searchedPlatforms.includes(platform)) continue;
      if (unavailable.some((u) => u.platform === platform)) continue;
      const skipped = skippedSet.has(platform);
      unavailable.push({
        platform,
        label: platformLabel(platform),
        reason: skipped ? "skipped" : "login",
        humanRequired: false,
        detail: skipped ? "用户选择跳过这家" : "需要登录（尚未完成）",
      });
    }

    // 普通失败（无匹配/读取失败）平台的自主兜底衔接：对齐主流「固定脚本 →
    // 智能体兜底」——结构化取价失败不等于任务失败，指引模型用通用多步浏览器
    // 自主打开搜索页提取（撞登录墙/验证码会自动推码交接），而不是把
    // 「没抓到」当结论收工。这是回执数据（不是 prompt）：模型读到才知道有这条路。
    const noDataForRetry = unavailable.filter((u) => u.reason === "no_data");
    const retryHint = noDataForRetry.length > 0
      ? `${noDataForRetry.map((u) => u.label).join("、")}未取到结构化报价（无匹配或页面读取失败）。` +
        "如用户坚持要这几家的价格，可改用通用多步浏览器操作自主打开其搜索页逐步提取" +
        "（撞登录墙/验证码会自动推码交接），不要直接告知用户无法比价。"
      : undefined;

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
      // 续跑时平台全被用户跳过 → 如实说「没有要比的平台」，别拿「登录态失效」
      // 这种误导性的诊断去搪塞（用户是自己选的）。
      const allSkipped =
        isResume &&
        unavailable.length > 0 &&
        unavailable.every((u) => u.reason === "skipped");
      return {
        ok: false,
        error: allSkipped
          ? `「${q}」这一轮没有要比价平台了——你把要登录的几家都跳过了。` +
            "想继续的话重新说一次要比的东西，我重新来一轮。"
          : `${loginFallbackNote}所有平台均未返回「${q}」的结果。` +
            (handoff
              ? handoff.instruction
              : failedPlatforms.length
                ? `失败详情：${failedPlatforms.join("；")}`
                : "可能登录态失效，请检查 Cookie 导入与授权"),
        retryable: true,
        ...(unavailable.length > 0 ? { unavailablePlatforms: unavailable } : {}),
        ...(handoff ? { handoff } : {}),
        ...(retryHint ? { retryHint } : {}),
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
    const loginText = loginPendingPlatforms.length > 0
      ? `；${loginPendingPlatforms.map(platformLabel).join("、")}需要登录，扫码登录后回复我，我接着把价补上`
      : "";
    // 推码预算用尽后延后的登录平台：如实说明「一轮只推一张码」，用户完成
    // 本轮扫码后下一轮逐个接入（pendingLogins 收割后它们自动并入常规池）。
    const deferredText = deferredLoginPlatforms.length > 0
      ? `；${deferredLoginPlatforms.map(platformLabel).join("、")}这轮先不推码（一次只推一个），你完成上面的扫码后我再逐个接入`
      : "";
    // 首次比价登录建档：真实推了码的探测平台点名说明——这是「扫码建档」
    // 的入口文案，用户扫完这张码，以后每轮比价自动带上这家的实时价；
    // 其余平台按「一次只推一张」的节奏逐轮接入。
    const onboardingLabels = isDefaultRound
      ? loginProbePlatforms.filter((p) => qrPushedLabels.includes(platformLabel(p)))
      : [];
    const onboardingNote = onboardingLabels.length >= 1
      ? `。首次比价顺手建档：${onboardingLabels.map(platformLabel).join("、")}的登录二维码已推到聊天，扫码登录后以后比价这家就有实时价（其他平台我会逐个带你登录）`
      : "";
    // 没取到数的平台分两类文案：需要用户登录/验证的（交人），与普通无匹配/读取失败的（如实说明）
    // 用户「跳过这家」的平台不算「没取到报价」——单独一句话说明，不混进失败清单。
    const noDataLabels = unavailable
      .filter((u) => !u.humanRequired && u.reason !== "skipped")
      .map((u) => u.label);
    const noDataText = noDataLabels.length
      ? `；${noDataLabels.join("、")}这次没取到报价（无匹配或读取失败）`
      : "";
    const verifyLabels = needHuman.filter((u) => u.reason === "captcha").map((u) => u.label);
    const verifyText = verifyLabels.length
      ? `；${verifyLabels.join("、")}需要完成安全验证，验证完我接着补价`
      : "";

    // ── P0-4 收齐闸门 + 事实清单（2026-11-13）──
    // 服务端**自己**生成一份事实清单交给 LLM，LLM 的职责被压缩为「复述这份
    // 清单 + 给结论」，不再负责「组织比价」。
    //
    // 为什么必须服务端生成：用户投诉「话都没说清楚说什么淘宝，没有搜索到
    // 报价，那价格哪来的」——旧流程把各平台报价塞进一个 summary 字符串，
    // LLM 拿到后自行组织，就可能把 A 平台的价格说成 B 平台的。事实清单把
    // 「哪个平台、什么价、什么链接、什么时候抓的」逐条钉死，模型没有自由
    // 发挥空间；没取到价的平台在清单里显式列为「未取到」，模型无从编造。
    const quotedPlatforms = new Set(searchedPlatforms);
    const factsQuoted: string[] = [];
    for (const g of groups) {
      const offer = g.offers[0];
      if (!offer) continue;
      const label = platformLabel(offer.platform);
      const price = offer.priceCny != null ? `¥${offer.priceCny}` : "价格待查";
      const shop = offer.shop ? `（${offer.shop}）` : "";
      const url = offer.url ? ` ${offer.url}` : "";
      factsQuoted.push(`- ${label} ${price} ${offer.title}${shop}${url}`);
    }
    const factsMissing: string[] = [];
    for (const u of unavailable) {
      const why =
        u.reason === "login"
          ? "需要登录（未完成）"
          : u.reason === "captcha"
            ? "需要安全验证（未完成）"
            : u.reason === "skipped"
              ? "用户选择跳过这家（不参与本轮比价）"
              : "未取到报价（无匹配或读取失败）";
      factsMissing.push(`- ${u.label}：${why}`);
    }
    for (const p of deferredLoginPlatforms) {
      factsMissing.push(`- ${platformLabel(p)}：本轮未取价（待上一家登录完成后接入）`);
    }
    const factSheet = [
      "【已取到报价】",
      ...(factsQuoted.length > 0 ? factsQuoted : ["- （无）"]),
      "【未取到报价的平台】",
      ...(factsMissing.length > 0 ? factsMissing : ["- （无）"]),
      "【约束】只能复述上面清单里的价格；清单里没有的平台绝对不要给出价格；" +
      "不要为未取到报价的平台估算或编造价格。",
    ].join("\n");

    // 收齐闸门：required 里没被满足的（既没报价、也不是明确的登录待办）必须
    // 在交付里显式呈现，不能让 LLM 用一句「部分平台没取到价」糊过去。
    // 用户主动跳过的平台**不算缺口**——那是用户的选择，不该被算成「没比到」。
    const skippedPlatforms = unavailable.filter((u) => u.reason === "skipped");
    const countedUnavailable = unavailable.filter((u) => u.reason !== "skipped");
    const effectiveRequested = Math.max(1, requested.length - skippedPlatforms.length);
    const satisfied = quotedPlatforms.size + countedUnavailable.length;
    const coverage = effectiveRequested > 0 ? Math.min(1, satisfied / effectiveRequested) : 1;
    const missingCount = Math.max(0, effectiveRequested - satisfied);
    const coverageNote =
      missingCount === 0
        ? `已比价 ${searchedPlatforms.length} 家`
        : `已比价 ${searchedPlatforms.length} 家，${missingCount} 家未取到报价`;
    const skippedNote =
      skippedPlatforms.length > 0
        ? `（用户已跳过 ${skippedPlatforms.map((u) => u.label).join("、")}）`
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
      summary:
        `${loginFallbackNote}「${q}」${coverageNote}${skippedNote}，聚合出 ${groups.length} 组报价${bestText}` +
        `${loginText}${onboardingNote}${deferredText}${verifyText}${noDataText}\n${factSheet}`,
      query: q,
      platforms: requested,
      searchedPlatforms,
      groups,
      bestOffer,
      bestIndex,
      fetchedAt,
      // 事实清单：模型复述的依据（每条报价带平台/链接/抓取时刻）
      factSheet,
      quotedPlatforms: [...quotedPlatforms],
      missingPlatforms: unavailable.map((u) => ({
        platform: u.platform,
        label: u.label,
        reason: u.reason,
      })),
      coverage,
      ...(loginPendingPlatforms.length > 0
        ? { loginRequired: { platform: loginPendingPlatforms[0], label: platformLabel(loginPendingPlatforms[0]) } }
        : {}),
      ...(unavailable.length > 0 ? { unavailablePlatforms: unavailable } : {}),
      ...(handoff ? { handoff } : {}),
      ...(retryHint ? { retryHint } : {}),
      ...(decisionPageUrl ? { decisionPageUrl } : {}),
    };
  }

  // ---- 待登录比价会话（2026-11-13 P1）：卡片动作续跑用 ----

  /**
   * 会话定位键：**只用 actorId**。
   *
   * 为什么不用 chat sessionId：比价工具跑在对话轮里（ctx.sessionId = 聊天
   * 会话 id），而卡内动作走 card.action 通道（那边只有 boundActorId，拿不到
   * 聊天会话 id）。按 `${actorId}::${sessionId}` 存，两边永远对不上——卡上的
   * 「跳过这家 / 继续比价」会一律报「登录会话已过期」。按 actor 存就稳了：
   * 一个人同一时刻只有一轮待登录比价。
   */
  private pendingKey(actorId: string): string {
    return actorId;
  }

  /** 记住一轮被登录闸门挂起的比价（闸门命中时调用）。 */
  private rememberPendingCompare(
    ctx: ToolContext,
    input: {
      query: string;
      opts: PendingCompareSession["opts"];
      platforms: string[];
      loginPlatforms: string[];
      skipped: string[];
      qrItems: PendingCompareSession["qrItems"];
    },
  ): PendingCompareSession {
    const actorId = resolveActorId(ctx);
    const sessionId = ctx.sessionId || actorId;
    const now = Date.now();
    const session: PendingCompareSession = {
      id: randomUUID(),
      actorId,
      sessionId,
      query: input.query,
      opts: input.opts,
      platforms: input.platforms,
      loginPlatforms: input.loginPlatforms,
      skipped: input.skipped,
      qrItems: input.qrItems,
      createdAt: now,
      expiresAt: now + PENDING_COMPARE_TTL_MS,
    };
    this.pendingCompares.set(this.pendingKey(actorId), session);
    return session;
  }

  /**
   * 取当前会话的待登录比价（没有或已过期返回 null）。
   *
   * 过期即删：二维码早就失效了，再续跑也只会拿到「这家还没登录」，
   * 不如让用户重新发起一轮。
   */
  getPendingCompare(ctx: ToolContext): PendingCompareSession | null {
    const actorId = resolveActorId(ctx);
    const key = this.pendingKey(actorId);
    const session = this.pendingCompares.get(key);
    if (!session) return null;
    if (Date.now() > session.expiresAt) {
      this.pendingCompares.delete(key);
      return null;
    }
    return session;
  }

  /**
   * 更新待登录会话里的二维码（2026-11-13 P1：失效重推后调用）。
   *
   * 换图不动平台名单；点码深链（qrLink）跟着新码一起换。
   */
  updatePendingQrImages(
    ctx: ToolContext,
    images: Array<{ platform: string; imageUrl: string; qrLink?: string; qrLinkFallback?: string }>,
  ): PendingCompareSession | null {
    const session = this.getPendingCompare(ctx);
    if (!session) return null;
    const map = new Map(session.qrItems.map((q) => [q.platform, q]));
    for (const img of images) {
      if (!img.platform || !img.imageUrl) continue;
      map.set(img.platform, {
        platform: img.platform,
        platformLabel: platformLabel(img.platform),
        qrImage: img.imageUrl,
        ...(img.qrLink ? { qrLink: img.qrLink } : {}),
        ...(img.qrLinkFallback ? { qrLinkFallback: img.qrLinkFallback } : {}),
      });
    }
    session.qrItems = [...map.values()];
    this.pendingCompares.set(this.pendingKey(session.actorId), session);
    return session;
  }

  /**
   * 「跳过这家」（2026-11-13 P1）：用户放弃某个待登录平台。
   *
   * 语义要严格：跳过**只是不再等这家**，不是「这家没有价」——续跑时它会
   * 出现在「未取到报价」清单里（原因=已跳过），模型不得替它编价。
   */
  skipLoginPlatform(
    ctx: ToolContext,
    platform: string,
  ): {
    session: PendingCompareSession;
    skipped: string[];
    /** 还剩哪些待登录平台（跳过之后） */
    remaining: string[];
  } | null {
    const session = this.getPendingCompare(ctx);
    if (!session) return null;
    const p = platform.trim();
    if (p && !session.skipped.includes(p)) session.skipped.push(p);
    const remaining = session.loginPlatforms.filter((x) => !session.skipped.includes(x));
    this.pendingCompares.set(this.pendingKey(session.actorId), session);
    return { session, skipped: [...session.skipped], remaining };
  }

  /**
   * 续跑：登录（和跳过）都处理完后，**统一取价、一次性交付**。
   *
   * 这就是用户要的那条链路：预检登录态 → 推齐二维码 → 等用户处理 → 同批次
   * 统一取价 → 事实清单校验 → 横向轮播卡一次性交付，中间不出半成品答案。
   *
   * 返回值与 comparePrices 的成功形状一致（可直接喂给卡面 builder）。
   */
  async resumeCompareAfterLogin(
    ctx: ToolContext,
    opts: { skipPending?: boolean } = {},
  ): Promise<
    | { ok: true; result: Record<string, unknown> }
    | { ok: false; error: string; stillWaiting?: boolean }
  > {
    const session = this.getPendingCompare(ctx);
    if (!session) {
      return { ok: false, error: "这次比价的登录会话已经过期了，重新说一次要比的东西就行" };
    }
    // 哪些平台现在真的登录好了（以已授权 Cookie 为准）
    const loginReady = await this.deps.shoppingOrderService
      .listPlatformsWithCookies(session.actorId, session.loginPlatforms)
      .catch(() => [] as string[]);
    const readySet = new Set(loginReady);
    // 仍需登录的（用户没扫 / 没扫成功）——它们不打断整轮，但要如实进清单
    let stillNeedLogin = session.loginPlatforms.filter(
      (p) => !readySet.has(p) && !session.skipped.includes(p),
    );
    if (readySet.size === 0 && stillNeedLogin.length > 0 && session.skipped.length === 0) {
      // 一家都没登录成：先别急着交半成品（用户还在扫），如实说还在等
      return {
        ok: false,
        error: "还没检测到登录成功——请扫卡片上的二维码，扫完再点一次「我扫好了」",
        stillWaiting: true,
      };
    }
    // 「先比已登录的」：用户明确表态剩下的不等了 → 记成跳过（不是缺价）
    if (opts.skipPending) {
      for (const p of stillNeedLogin) {
        if (!session.skipped.includes(p)) session.skipped.push(p);
      }
      stillNeedLogin = [];
    }
    const platforms = session.platforms.filter((p) => !session.skipped.includes(p));
    if (platforms.length === 0) {
      // 全被跳过了：没有要比价的平台，如实说，别拿别的话搪塞
      this.pendingCompares.delete(this.pendingKey(session.actorId));
      return {
        ok: false,
        error: `「${session.query}」这一轮没有要比价的平台了——要登录的几家都被跳过了。重新说一次要比的东西，我再来一轮。`,
      };
    }
    const result = await this.comparePrices(ctx, session.query, {
      platforms,
      ...session.opts,
      pending: { assumeLogin: stillNeedLogin, skipped: [...session.skipped] },
    });
    if (!result.ok) {
      return {
        ok: false,
        error: String((result as { error?: unknown }).error ?? "比价没跑通"),
      };
    }
    // 本轮已交付：从待登录会话里摘掉（避免下一轮误续跑）
    this.pendingCompares.delete(this.pendingKey(session.actorId));
    return { ok: true, result: result as unknown as Record<string, unknown> };
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
