import { randomUUID } from "crypto";

import type { Page } from "playwright";

import { resolveActorId } from "../agent/actor-id.js";
import { redactCredentials } from "../security/redact.js";
import type { AuditService } from "./audit-service.js";
import type { AlipayBotService } from "./alipay-bot-service.js";
import type { BrowserSessionService } from "./browser-session-service.js";
import { BROWSER_SESSION_SITES, type BrowserSessionSiteId } from "./browser-session-sites.js";
import type { ImportedBrowserCookie } from "./browser-session-types.js";
import { CAPTURE_CONSENT_ALL_SITES } from "./browser-session-types.js";
import { isBrowserSessionSiteId } from "./browser-session-sites.js";
import { parseCookieHeaderText } from "./cookie-text-parser.js";
import { startBrowserPreviewStream, type BrowserPreviewHandle } from "./browser-preview-stream.js";
import {
  localDateKey,
  mapPlatformStatusText,
  newShoppingOrderId,
  type ShoppingOrderStore,
  type StoredShoppingOrder,
} from "./shopping-order-store.js";
import {
  BrowserPageUnavailableError,
  BrowserRuntime,
  detectHumanRequired,
  detectLoginPage,
  getLoginCookieMarkerNames,
  getLoginWaitMs,
  hasLoginCookieMarker,
  hasLoginCookieMarkerNames,
  isPlatformLoggedIn,
  waitForLogin,
  type BrowserPageLease,
  type HumanRequiredDetection,
} from "./browser-runtime/index.js";
import { QrAssistService } from "./qr-assist-service.js";
import { getShoppingPlatformAdapter, listSupportedPlatforms } from "./shopping-platforms/index.js";
import type {
  CheckoutSnapshot,
  OrderStatus,
  ProductSummary,
  SearchFilters,
  ShoppingPlatformAdapter,
} from "./shopping-platforms/index.js";
import { SharedBrowserCdpGateway } from "./shared-browser/cdp-gateway.js";
import { SharedBrowserCoordinator } from "./shared-browser-coordinator.js";
import { extractWithSelfHeal, parseVisionProducts, semanticExtractProducts } from "./shopping-platforms/self-heal.js";
import type { ToolContext } from "../tools/tool-registry.js";

/** 单笔金额上限（CNY）。可用 SHOPPING_ORDER_MAX_AMOUNT_<平台大写>_CNY 按平台覆盖（演出票等高价类目调高）。 */
function getMaxAmountCny(platform?: string): number {
  if (platform) {
    const perPlatform = Number.parseInt(
      process.env[`SHOPPING_ORDER_MAX_AMOUNT_${platform.toUpperCase()}_CNY`] ?? "",
      10,
    );
    if (Number.isFinite(perPlatform) && perPlatform > 0) return perPlatform;
  }
  const v = Number.parseInt(process.env.SHOPPING_ORDER_MAX_AMOUNT_CNY ?? "5000", 10);
  return Number.isFinite(v) && v > 0 ? v : 5000;
}

/** 单日累计下单预算（CNY），阶段一校验：当日已提交金额 + 本单总价 不得超此阈值。 */
function getDailyBudgetCny(): number {
  const v = Number.parseInt(process.env.SHOPPING_ORDER_DAILY_BUDGET_CNY ?? "10000", 10);
  return Number.isFinite(v) && v > 0 ? v : 10000;
}

/** 确认 token TTL（毫秒）。 */
function getConfirmationTtlMs(): number {
  const v = Number.parseInt(process.env.SHOPPING_ORDER_CONFIRMATION_TTL_MS ?? "300000", 10);
  return Number.isFinite(v) && v > 0 ? v : 300_000;
}

/** Playwright Cookie → ImportedBrowserCookie（过滤非法 value；expires≤0 的会话 Cookie 存 undefined）。 */
function toImportedCookies(
  raw: Array<{
    name: string;
    value: string;
    domain?: string;
    path?: string;
    expires?: number;
    httpOnly?: boolean;
    secure?: boolean;
    sameSite?: string;
  }>,
): ImportedBrowserCookie[] {
  return raw
    .filter((c) => c.name && c.value && !/[;,\s"\\]/.test(c.value))
    .map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain || undefined,
      path: c.path || undefined,
      expires: typeof c.expires === "number" && c.expires > 0 ? c.expires : undefined,
      httpOnly: c.httpOnly || undefined,
      secure: c.secure || undefined,
      sameSite: c.sameSite || undefined,
    }));
}

/** 阶段一存活的 Playwright Page + 上下文，供阶段二复用。 */
interface ActiveSession {
  platform: string;
  actorId: string;
  item: string;
  quantity: number;
  snapshot: CheckoutSnapshot;
  // 持有 page 与 context 的关闭句柄
  close: () => Promise<void>;
  closed: boolean;
  expiresAt: number;
}

/**
 * 卡内扫码登录会话：二维码推进那张卡里，页面 lease 必须留着等用户扫。
 *
 * 不能像原来那样「截图 → 关页面 → 让用户说一句我扫了」：扫码后的登录态是
 * 浏览器页面自己轮询拿到的，页面一关 Cookie 就丢，用户白扫。
 */
interface PendingLogin {
  token: string;
  actorId: string;
  platform: string;
  targetUrl: string;
  lease: BrowserPageLease;
  expiresAt: number;
  closed: boolean;
}

/** 两阶段确认的待确认记录。 */
interface PendingConfirmation {
  token: string;
  platform: string;
  actorId: string;
  item: string;
  quantity: number;
  snapshot: CheckoutSnapshot;
  session?: ActiveSession;
  expiresAt: number;
}

/** 服务返回的通用结构。 */
export type ShoppingOrderResult =
  | { ok: true; summary: string } & Record<string, unknown>
  | {
      ok: false;
      error: string;
      retryable?: boolean;
      /** 订单无收银台链接时置位，引导用户去平台 App 支付 */
      needManualPayment?: boolean;
      paymentUrl?: string;
      /** 登录等待超时/需要登录时携带二维码截图地址（供卡片渲染与 LLM 转述） */
      loginRequired?: { platform: string; imageUrl?: string };
      /**
       * 「只有用户本人能做」的硬信号（登录墙 / 验证码）。
       * 搜索为空或超时**不会**自动置位——只有 detectHumanRequired 命中才置位，
       * 避免把「没搜到商品」误当成需要登录。
       */
      humanRequired?: { platform: string; reason: "login" | "captcha"; evidence?: string };
    };

/**
 * 购物/下单编排服务。
 *
 * 页面执行策略（内置浏览器优先 + 无头兜底）：
 * - 客户端在线且开启调试端口时，经 CDP 在用户可见的内置浏览器（WebView2）里
 *   新开标签页执行——登录态即用户自身，免 Cookie 导入，操作全程可见可接管；
 * - 否则回退服务端无头 Chromium + 已导入授权 Cookie；
 * - 无 Cookie 且二维码可呈现（聊天在线）时，允许匿名打开 + 扫码登录门：
 *   检测到登录页 → 截二维码推送聊天 → 等待扫码（SHOPPING_LOGIN_WAIT_MS，
 *   默认 120s）→ 自动继续原流程。
 *
 * 安全护栏：
 * - 平台白名单（getAdapter 返回 null 即拒绝）
 * - 金额上限（SHOPPING_ORDER_MAX_AMOUNT_CNY 默认 5000）
 * - 两阶段确认 token 5 分钟 TTL
 * - 审计日志（每次操作落 AuditService，含 browserMode）
 */

/** 各平台登录页直连地址：force 登录交接时绕过商品页直接截码用。 */
const PLATFORM_LOGIN_URLS: Record<string, string> = {
  jd: "https://passport.jd.com/new/login.aspx",
  taobao: "https://login.taobao.com/member/login.jhtml",
  tmall: "https://login.tmall.com/",
  suning: "https://passport.suning.com/ids/login",
  pdd: "https://mobile.yangkeduo.com/login.html",
  douyin: "https://www.douyin.com/login",
};

/**
 * 只对这些平台「直达登录页」——云端实测（2026-11-20）：
 *   · 拼多多：直达 3.4s，走搜索页 9.9s（差 3 倍，明显赚）
 *   · 京东：直达 goto 2.4~4.9s（passport 页面重且波动大），走搜索页稳定
 *     6.2s；直达两次测量 7.0s / 8.3s，**没有变快**，所以不切。
 * 结论：只给实测更快的站点开直达，别一刀切（截图快慢取决于对方站点本身）。
 */
const DIRECT_LOGIN_ENTRY_PLATFORMS = new Set<string>(["pdd"]);

/** 取该平台的首选入口：实测更快的站点直达登录页，其余仍走搜索页。 */
function platformEntryUrl(platform: string, searchUrl: string): string {
  if (!DIRECT_LOGIN_ENTRY_PLATFORMS.has(platform)) return searchUrl;
  return PLATFORM_LOGIN_URLS[platform] ?? searchUrl;
}

export class ShoppingOrderService {
  private readonly pendingConfirmations = new Map<string, PendingConfirmation>();
  /**
   * 卡内扫码登录会话（2026-11-06）：二维码在**那张卡里**展示，页面必须留在
   * 这里不释放——扫码成功是浏览器页面自己轮询出来的登录态，页面一关 Cookie
   * 就没了。所以会话持有 lease，check 时读 Cookie 落库后才释放。
   */
  private readonly pendingLogins = new Map<string, PendingLogin>();
  /** 已弹过「保存登录态」统一征询的 actor（本进程内每人只问一次，不按平台重复问） */
  private readonly askedLoginConsent = new Set<string>();
  /** 定期清理过期 token + 关闭存活 Page */
  private cleanupTimer: NodeJS.Timeout | null = null;
  /** 页面获取器（内置浏览器优先 + 无头兜底）；未注入时以缺省依赖构造（单测兼容） */
  private readonly browserExecutor: BrowserRuntime;
  /** 通用二维码/图片推送（登录页截图等）；未注入时按 imageStore 构造（单测兼容） */
  private readonly qrAssist: QrAssistService;
  /**
   * 登录墙预检顺手截下的二维码（key=`actor:platform`，TTL 90s）。
   *
   * 预检本来就已经导航到登录页并确认「要登录」——那一刻就是最鲜活的码。以前
   * 推码阶段会把每家的登录页重新开一遍（再导航一次 + 再撞一次风控），云端实测
   * 单家 5~8s，一轮三四家就吃掉整个工具时间预算，重导航失败还会让用户「被通
   * 知去扫码却一张码都没收到」。现在预检命中即截码缓存，推码阶段直接复用。
   */
  private readonly loginProbePngs = new Map<string, { png: Buffer; at: number }>();
  /**
   * 推码后**留驻等扫码**的页面（key=`actor:platform`）。
   *
   * 为什么必须留（2026-11-20 用户反馈「点进 App 没反应 / 扫了也没登录」）：
   * 平台登录页靠页面里的 JS 轮询 `check` 接口，用户扫码确认后由轮询把登录
   * Cookie 写进浏览器。截完码就把页面关了，扫码确认就永远落不回浏览器——
   * 用户看到的是「App 里点了确认，回来还是没登录」。留驻到码过期为止。
   */
  private readonly qrWaitPages = new Map<
    string,
    { lease: BrowserPageLease; timer: NodeJS.Timeout; preview?: BrowserPreviewHandle }
  >();

  constructor(
    private readonly deps: {
      browserSessionService: BrowserSessionService;
      audit?: AuditService;
      /** 本地订单表（落库 + 单日预算统计）。未注入时退化为纯平台侧下单（无本地记录）。 */
      store?: ShoppingOrderStore;
      /** 支付宝钱包通道（shopping.pay.* 收银台代付）。未注入时 pay 工具返回明确错误。 */
      alipayBot?: AlipayBotService;
      /** 页面获取器。缺省用新建 coordinator/gateway（shared 不可用 → 直接走无头）。 */
      browserExecutor?: BrowserRuntime;
      /** 图片落盘（登录/支付二维码截图）。缺省时只推 URL 不可用，依赖浏览器可见性。 */
      imageStore?: { savePng(actorId: string, png: Buffer): Promise<string> };
      /** 通用二维码推送服务。缺省时按 imageStore 构造。 */
      qrAssist?: QrAssistService;
      /**
       * 「保存登录态」征询通道（2026-10-25 用户拍板：存 Cookie 须用户同意）。
       * 未表态时经此向客户端弹征询条；缺省时跳过捕获（宁可不存）。
       * siteId 传 "*" 表示统一征询：一次答复对所有平台生效（2026-11-02 用户要求
       * 「不要换一个平台就问一次」）。
       */
      askSaveLoginConsent?: (actorId: string, siteId: string, siteLabel: string) => void;
      /**
       * 需要用户本人动手（扫码登录 / 完成验证码）时交给长流程 handoff（建等待步 +
       * 页面留在可见浏览器），而不是把平台标成「没有数据」就收工。
       * platforms 是同一轮里命中 human-required 的平台：上层统一一次交接，不逐平台弹。
       * 普通「没搜到商品 / 网络超时」不触发本回调。缺省时退回原来的纯报错。
       */
      onUserActionRequired?: (info: {
        actorId: string;
        sessionId: string;
        platforms: string[];
        platformLabels: string[];
        reason: "login" | "captcha";
      }) => void;
      /**
       * 视觉兜底抽取（可插拔，2026-11-02 自愈管线第三层）：CSS 与语义锚点都
       * 抓空时，把搜索页截图交给视觉模型抽结构化商品 JSON（原始文本，
       * 由 parseVisionProducts 宽容解析）。须同时满足
       * SHOPPING_VISION_HEALING=1 才生效；未注入则管线止于语义层。
       * 回执为模型原文（可能带围栏/说明文字），解析失败按空结果处理。
       */
      visionExtract?: (input: {
        screenshotBase64: string;
        platform: string;
        query: string;
        limit: number;
      }) => Promise<string | null>;
    },
  ) {
    this.browserExecutor =
      deps.browserExecutor ??
      new BrowserRuntime({
        coordinator: new SharedBrowserCoordinator(),
        gateway: new SharedBrowserCdpGateway(),
        browserSessionService: deps.browserSessionService,
      });
    this.qrAssist = deps.qrAssist ?? new QrAssistService({ imageStore: deps.imageStore });
    // 每 60 秒清理一次过期确认 + 关闭存活 Page
    this.cleanupTimer = setInterval(() => this.cleanupExpired(), 60_000);
    this.cleanupTimer.unref?.();
  }

  /** 主动销毁：关闭所有存活 Page。 */
  async dispose(): Promise<void> {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    for (const pending of this.pendingConfirmations.values()) {
      if (pending.session && !pending.session.closed) {
        await pending.session.close().catch(() => {});
      }
    }
    this.pendingConfirmations.clear();
  }

  /** 列出已实现的平台（供 handler 做参数校验）。 */
  listSupportedPlatforms(): string[] {
    return listSupportedPlatforms();
  }

  /** 用户可见内置浏览器是否可用（客户端在线 + CDP 端点已上报）。 */
  canUseVisibleBrowser(ctx: ToolContext): boolean {
    return this.browserExecutor.canUseSharedBrowser(resolveActorId(ctx));
  }

  /**
   * 这批平台里，哪些该用户**已有可用授权 Cookie**（即能免扫码取价）。
   *
   * 用途：比价缺省集合收窄——手机端没有可视浏览器，把没登录态的平台塞进
   * 缺省只会整轮变成登录交接。登录过的平台仍值得带上（能读到真价）。
   * 逐平台查 Cookie，任何异常都当「没有」处理（只影响是否纳入缺省，不报错）。
   */
  async listPlatformsWithCookies(actorId: string, platforms: string[]): Promise<string[]> {
    const out: string[] = [];
    for (const platform of platforms) {
      try {
        const cookies = await this.deps.browserSessionService.getCookiesForAgent(
          actorId,
          platform as BrowserSessionSiteId,
        );
        if (cookies.length > 0) out.push(platform);
      } catch {
        /* 未授权/未导入 = 没登录态 */
      }
    }
    return out;
  }

  /**
   * 交接图片统一推送：登录二维码 / 验证页截图都推到聊天（手机端没有可视浏览器），
   * 无头与可见浏览器都走这里。失败只丢增强，不影响工具结果。
   */
  private async pushHumanCard(
    ctx: ToolContext,
    page: Page,
    platform: string,
    reason: "login" | "captcha",
  ): Promise<string | undefined> {
    const label = this.platformLabel(platform);
    return (
      (await this.qrAssist
        .pushPageCard(
          ctx,
          reason === "login"
            ? { title: `请扫码登录${label}`, caption: "扫码后自动继续；若二维码失效，回复后我会重新发起" }
            : { title: `请完成安全验证${label}`, caption: "验证页截图已推给你，完成后回复我继续" },
          page,
        )
        .catch(() => undefined)) ?? undefined
    );
  }

  // ============ 页面租约 + 登录门（内置浏览器优先 + 无头兜底） ============

  /** 平台显示名（京东/淘宝/…），未收录时回退 platform 标识。 */
  private platformLabel(platform: string): string {
    return BROWSER_SESSION_SITES[platform as BrowserSessionSiteId]?.label ?? platform;
  }

  /**
   * 把「需要用户本人动手」交给长流程 handoff。reason：
   *   - login   ：页面被拦到登录页（要扫码登录）；
   *   - captcha ：页面要求完成安全验证（滑块/验证码）。
   * 只由 human-required 硬信号触发；普通空结果/超时不交人。
   * 交接是增强不是依赖：失败不影响工具结果照常返回。
   */
  private notifyUserAction(
    ctx: ToolContext,
    platforms: string[],
    reason: "login" | "captcha",
  ): void {
    const ids = Array.from(new Set(platforms.map((p) => String(p).trim()).filter(Boolean)));
    if (ids.length === 0) return;
    try {
      this.deps.onUserActionRequired?.({
        actorId: resolveActorId(ctx),
        sessionId: ctx.sessionId,
        platforms: ids,
        platformLabels: ids.map((p) => this.platformLabel(p)),
        reason,
      });
    } catch {
      /* 交接失败只丢增强，工具结果里的指引照常返回 */
    }
  }

  /**
   * 上层（比价/推荐取数）把本轮命中 human-required（登录墙/验证码）的平台
   * 统一交给用户一次：不逐平台弹交接条，也不各自建等待步。
   */
  requestUserHandoff(
    ctx: ToolContext,
    platforms: string[],
    reason: "login" | "captcha" = "login",
  ): void {
    this.notifyUserAction(ctx, platforms, reason);
  }

  /**
   * 统一页面执行壳：获取租约（shared 优先/无头兜底）→ 稳定等待 → 登录门 → run → 释放。
   * Cookie 软获取：有则注入（headless 免扫码），未导入/未授权不再硬拒（内置浏览器路径不需要）。
   */
  private async withShoppingPage(
    ctx: ToolContext,
    platform: string,
    targetUrl: string,
    run: (page: Page, mode: "shared" | "headless") => Promise<ShoppingOrderResult>,
    opts: {
      interactiveLogin?: boolean;
      /** Playwright+Cookie 优先（比价/后台取数，防排队拖死工具预算）。 */
      preferHeadless?: boolean;
      /** 扫码等待上限（只读取数用短等：超时立刻走登录交接，不占着工具预算干等）。 */
      loginWaitMs?: number;
      /**
       * 抑制本层自动交接：上层（比价）要把多个失败平台合成**一次**统一 handoff，
       * 逐平台各建等待步会互相挤掉。
       */
      suppressHandoff?: boolean;
      /**
       * 匿名站点允许「无 Cookie 也开浏览器」。由 adapter.authMode 派生：
       * 苏宁/什么值得买这类页面对匿名访客直接返回真实价格，没有 Cookie 不是
       * 缺点，不该被 no_cookie 门禁挡住（否则手机端离线/无 Cookie 时
       * 一条报价也拿不到）。
       */
      allowAnonymous?: boolean;
      /** 页面获取不可用时的自定义兜底（如 track 回退本地订单记录）。 */
      onUnavailable?: (err: BrowserPageUnavailableError) => ShoppingOrderResult;
      /**
       * 跳过登录门（只读且不需要登录态的取数用）。
       *
       * 京东详情页对匿名访客会弹登录浮层——"能看商品、但 detectLoginPage 判为登录"。
       * 读规格这种只读动作如果走登录门，会白等 120 秒扫码，什么也没读到。
       * 跳过后读不到就返回空，由调用方直接去结算（那一步才真正需要登录）。
       */
      skipLoginGate?: boolean;
    } = {},
  ): Promise<ShoppingOrderResult> {
    const actorId = resolveActorId(ctx);
    // 先收割上一轮遗留的扫码登录会话（超时后用户才扫码的场景）：
    // 已登录 → Cookie 落库，下面 getCookieAndSiteId 当轮就能取到。
    await this.harvestPendingLogins(ctx, actorId, platform);
    const tStart = Date.now();
    let cookies: ImportedBrowserCookie[] = [];
    const cookieResult = await this.getCookieAndSiteId(actorId, platform);
    if (cookieResult.ok) cookies = cookieResult.cookies;
    const tCookies = Date.now();

    const interactiveLogin = opts.interactiveLogin ?? ctx.pushMediaCards != null;
    let lease: BrowserPageLease;
    try {
      lease = await this.browserExecutor.acquirePage(actorId, targetUrl, {
        siteId: platform,
        cookies,
        interactiveLogin,
        preferHeadless: opts.preferHeadless === true,
        allowAnonymous: opts.allowAnonymous === true,
      });
    } catch (err) {
      if (err instanceof BrowserPageUnavailableError) {
        return opts.onUnavailable
          ? opts.onUnavailable(err)
          : { ok: false, error: err.message, retryable: false };
      }
      throw err;
    }
    const tAcquire = Date.now();
    // 云端浏览器工作画面（2026-11-14）：无头通道没有可见面板，页面画面要推给
    // 客户端悬浮窗——手机端靠它看 Agent 在翻哪个页面（比价/搜索/下单/查单全走
    // 这里，一次接线覆盖购物全族）。shared 模式页面本就在用户眼前（桌面面板），
    // 不重复推流。
    const preview: BrowserPreviewHandle | null =
      lease.mode === "headless"
        ? startBrowserPreviewStream(ctx, lease.page, { mode: lease.mode, sessionId: `shop-${platform}-${tAcquire}` })
        : null;
    // 登录门超时会把 lease 转入 pendingLogins（二维码继续存活），此时
    // finally 不能再 release——页面归 pendingLogins 会话管。
    let leaseTransferred = false;

    try {
      // 落页稳定后再过登录门（SPA/跳转需要时间）
      await lease.page.waitForTimeout(2_500).catch(() => {});
      const tSettle = Date.now();
      const gate = opts.skipLoginGate
        ? null
        : await this.ensureLoggedIn(ctx, lease, platform, targetUrl, opts.loginWaitMs, opts.suppressHandoff === true, () => {
            leaseTransferred = true;
          });
      const tGate = Date.now();
      if (gate) {
        console.log(`[shop-timing] ${platform} mode=${lease.mode} cookies=${tCookies - tStart} acquire=${tAcquire - tCookies} settle=${tSettle - tAcquire} gate=${tGate - tSettle} login=blocked`);
        return gate;
      }
      const result = await run(lease.page, lease.mode);
      const tRun = Date.now();
      // 登录态捕获（一次登录一直使用）：shared=用户本人在内置浏览器的登录态（视为授权）；
      // headless=运行期平台刷新的 Cookie 回写更新（授权只升不降，不删除）。
      await this.persistLoginCookies(
        ctx,
        lease.page,
        platform,
        targetUrl,
        lease.mode === "shared" ? "shared_login" : "headless_refresh",
        lease.mode === "shared" ? { agentAllowed: true } : {},
      );
      console.log(
        `[shop-timing] ${platform} mode=${lease.mode} cookies=${tCookies - tStart} acquire=${tAcquire - tCookies} settle=${tSettle - tAcquire} gate=${tGate - tSettle} run=${tRun - tGate} persist=${Date.now() - tRun}`,
      );
      return result;
    } finally {
      // 页面转交 pendingLogins（等用户扫码）时**不收流**：登录页还活着，用户
      // 要一直看得到 Agent 停在哪一步，直到最终回复给出来（2026-11-19 用户
      // 要求「浏览器框到最后信息给出再关闭，不要一 handoff 就关」）。
      if (!leaseTransferred) {
        preview?.stop();
        await lease.release();
      }
    }
  }

  /**
   * 登录门：命中登录页 → 截二维码落盘 → 经 ctx.pushMediaCards 推聊天卡片
   * （shared 模式浏览器本身也可见）→ 等待扫码后自动继续。
   * 无需登录返回 null；等待超时返回结构化失败（含 loginRequired.imageUrl）。
   */
  private async ensureLoggedIn(
    ctx: ToolContext,
    lease: BrowserPageLease,
    platform: string,
    targetUrl: string,
    loginWaitMs?: number,
    suppressHandoff = false,
    /** 超时后 lease 转入 pendingLogins 时回调（调用方据此跳过 finally release）。 */
    onLeaseTransferred?: () => void,
  ): Promise<ShoppingOrderResult | null> {
    // 两次检测：部分平台（如京东）登录跳转由 JS 延迟触发，落页稳定后再补检一次
    let det = await detectLoginPage(platform, lease.page);
    if (!det.isLogin) {
      await lease.page.waitForTimeout(1_500).catch(() => {});
      det = await detectLoginPage(platform, lease.page);
    }
    if (!det.isLogin) return null;

    const label = this.platformLabel(platform);
    const waitMs = loginWaitMs ?? getLoginWaitMs();
    // 通用二维码推送：登录页截图 → 落盘 → 聊天卡片（best-effort）
    const imageUrl = await this.qrAssist.pushPageCard(
      ctx,
      {
        title: `请扫码登录${label}`,
        caption: `扫码后自动继续，最长等待 ${Math.round(waitMs / 1000)} 秒`,
      },
      lease.page,
    );

    await this.audit(ctx, "login_gate", platform, {
      mode: lease.mode,
      reason: det.reason,
      imageUrl,
      pushed: Boolean(imageUrl),
    });

    const wait = await waitForLogin(platform, lease.page, targetUrl, { timeoutMs: waitMs });
    if (!wait.ok) {
      // 2026-11-06 修「超时后用户才扫码，扫了没人接」：超时不再释放页面——
      // lease 转入 pendingLogins 续命 5 分钟，聊天里那张二维码仍然有效。
      // 用户随后回复任意一句，下一次工具执行先经 harvestPendingLogins 把
      // 登录态收下来接着跑原任务，不用重新扫码。
      const actorId = resolveActorId(ctx);
      if (onLeaseTransferred) {
        const token = randomUUID();
        this.pendingLogins.set(token, {
          token,
          actorId,
          platform,
          targetUrl,
          lease,
          expiresAt: Date.now() + 5 * 60_000,
          closed: false,
        });
        onLeaseTransferred();
      }
      // 登录是用户本人的动作：可见浏览器交给长流程 handoff（页面留在登录页）；
      // 无头通道（手机端）没有面板，二维码/截图已推到聊天，等用户回复后重试即可。
      if (!suppressHandoff && lease.mode === "shared") this.notifyUserAction(ctx, [platform], "login");
      return {
        ok: false,
        error:
          lease.mode === "shared"
            ? `${wait.error}。已在内置浏览器打开${label}登录页，登录完成后告诉我一声即可继续`
            : imageUrl
              ? `${wait.error}。已把${label}登录二维码推送到聊天。如果用户说已经扫码确认了，直接继续原任务（服务端会自动接上已登录的会话），不要重新出码；用户说没扫才重新发起`
              : `${wait.error}。登录二维码无法推送到聊天（客户端不在线或图片服务未装配），请稍后重试`,
        retryable: true,
        loginRequired: { platform, imageUrl: imageUrl ?? undefined },
      };
    }

    // 扫码登录成功：立即捕获登录态（一次登录一直使用——之后无头兜底免重复扫码）
    await this.persistLoginCookies(ctx, lease.page, platform, targetUrl, "scan_login", {
      agentAllowed: true,
    });
    return null;
  }

  /**
   * 批量登录二维码推送（2026-11-13 P0-2）：一次把**所有**待登录平台的
   * 二维码推给用户（合并成一张多平台登录卡），而不是撞墙一家推一家。
   *
   * 用户投诉：「说让我补京东的登录之后再补」——一次一张的预算让用户要扫三轮
   * 才能比完。对齐主流 agent：需要用户本人做的环节一次交齐。
   *
   * 每个平台独立开一个页面探登录墙并截二维码（不等待扫码），
   * 返回真正推出去的 platform→{imageUrl, qrLink} 映射（深链供点码登录按钮）。
   */
  async pushBatchLoginQrs(
    ctx: ToolContext,
    platforms: string[],
    query: string,
  ): Promise<Map<string, { imageUrl: string; qrLink?: string; qrLinkFallback?: string; issuedAt: number }>> {
    const items = await this.captureBatchLoginPngs(ctx, platforms, query);
    if (items.length === 0) return new Map<string, { imageUrl: string; qrLink?: string; qrLinkFallback?: string; issuedAt: number }>();
    const labels = items.map((i) => i.label);
    return await this.qrAssist.pushBatchQrCards(
      ctx,
      items,
      {
        title:
          items.length === 1
            ? `请登录${labels[0]}`
            : `请登录（${labels.join("、")}）`,
        // 文案只留一句（2026-11-19 用户：卡片里重复说明太多）：点码能启 App
        // 这件事由按钮本身承载，不必在正文再讲一遍「不用存图」。
        caption: items.length === 1 ? "点码或扫码登录，完了我接着比价" : "任意扫一个，登录完我接着比",
      },
    );
  }

  /**
   * 只抓码、**不推流**（2026-11-13 P1：二维码失效重推）。
   *
   * 登录二维码有有效期（平台侧一般 2–5 分钟），用户扫得慢、或者中途切走
   * 都会导致码失效。这时要**重新出一张码并原地换掉旧卡**，而不是再推一张
   * 新卡进聊天流（聊天里堆两张码，用户分不清哪张能用）。
   *
   * 返回每家的码地址（已落盘，可直接塞进 card.update 的 qrItems）。
   */
  async captureBatchLoginQrs(
    ctx: ToolContext,
    platforms: string[],
    query: string,
  ): Promise<Array<{ platform: string; label: string; imageUrl: string; width?: number; height?: number; qrLink?: string; qrLinkFallback?: string; issuedAt: number }>> {
    const items = await this.captureBatchLoginPngs(ctx, platforms, query);
    if (items.length === 0) return [];
    return await this.qrAssist.saveBatchQrPngs(ctx, items);
  }

  /**
   * 批量探登录墙 + 截二维码的公共实现（推流版与重推版共用）。
   *
   * 每家独立开页面：登录跳转常由 JS 延迟触发，落页稳定后再判一次；
   * 不是登录页（匿名可读 / 已登录）→ 不出码，直接跳过这家。
   */
  private async captureBatchLoginPngs(
    ctx: ToolContext,
    platforms: string[],
    query: string,
  ): Promise<Array<{ platform: string; label: string; png: Buffer | null }>> {
    const items: Array<{ platform: string; label: string; png: Buffer | null }> = [];
    if (platforms.length === 0) return items;
    const actorId = resolveActorId(ctx);
    for (const platform of platforms) {
      const adapter = this.requireAdapter(platform);
      if (!adapter) continue;
      const label = this.platformLabel(platform);
      // 1) 预检刚截到的码优先：同一次登录页、码还新鲜（90s 内），直接用。
      //    但**必须有留驻页在轮询这张码**（2026-11-20）：码 PNG 只是图，
      //    扫码后的「同意登录」要靠留驻页轮询 token 才能落成 Cookie——
      //    页面不在（预检页已过期释放/旧进程遗留），这张码就是死码，
      //    用户扫了也白扫。此时弃缓存，走下面的重开页路径出一张活码。
      const cached = this.takeCachedLoginPng(actorId, platform);
      if (cached && this.qrWaitPages.has(`${actorId}:${platform}`)) {
        items.push({ platform, label, png: cached });
        console.log(`[shop-qr] ${platform} 复用预检二维码 ${cached.length}B（留驻页在轮询）`);
        continue;
      }
      // 2) 没缓存才重新开页面探一次（续跑/重推码路径）。
      let lease: BrowserPageLease | null = null;
      let preview: BrowserPreviewHandle | null = null;
      try {
        const cookieResult = await this.getCookieAndSiteId(actorId, platform);
        lease = await this.browserExecutor.acquirePage(
          actorId,
          platformEntryUrl(platform, adapter.searchUrl(query, {})),
          {
            siteId: platform,
            cookies: cookieResult.ok ? cookieResult.cookies : [],
            interactiveLogin: ctx.pushMediaCards != null,
            preferHeadless: true,
            allowAnonymous: true,
          },
        );
        // 出码过程也推到手机悬浮窗：用户能亲眼看到「登录页长什么样」，
        // 而不是只收到一张孤零零的二维码。
        if (lease.mode === "headless") {
          preview = startBrowserPreviewStream(ctx, lease.page, {
            mode: lease.mode,
            sessionId: `qr-${platform}-${Date.now()}`,
          });
        }
        // 落页稳定（直达登录页后 800ms 足够；真正的渲染等待在 captureQrFocused 里）
        await lease.page.waitForTimeout(800).catch(() => {});
        const det = await detectLoginPage(platform, lease.page);
        if (!det.isLogin) {
          // 没撞登录墙（可能匿名可读或已登录）→ 不需要推码
          console.log(`[shop-qr] ${platform} 未撞登录墙，不出码`);
          await lease.release().catch(() => {});
          lease = null;
          continue;
        }
        const png = await this.qrAssist.captureQrPng(lease.page);
        console.log(
          `[shop-qr] ${platform} 撞登录墙（${det.reason ?? "?"}），截图 ${png ? `${png.length}B` : "失败"}`,
        );
        items.push({ platform, label, png });
        // 截到码就把页面留驻到码过期：扫码后的确认要靠页面轮询才落 Cookie
        if (png) {
          this.holdQrPage(ctx, actorId, platform, lease);
          lease = null; // 交给留驻逻辑管，finally 不再 release
        }
      } catch (err) {
        // 探不到就如实记一笔，不阻断其余平台——但绝不能悄悄失败（用户会收到
        // 「二维码已推送」却一张没有，2026-11-19 真机事故）。
        console.log(
          `[shop-qr] ${platform} 出码失败：${err instanceof Error ? err.message.slice(0, 160) : String(err)}`,
        );
      } finally {
        preview?.stop();
        if (lease) await lease.release().catch(() => {});
      }
    }
    return items;
  }

  /** 预检命中登录墙时顺手截码入缓存（best-effort，失败不影响预检结论）。 */
  private async captureQrIntoCache(
    actorId: string,
    platform: string,
    page: Page,
  ): Promise<void> {
    try {
      const png = await this.qrAssist.captureQrPng(page);
      if (!png) {
        console.log(`[shop-qr] ${platform} 预检截码失败（页面无码/截图异常）`);
        return;
      }
      this.loginProbePngs.set(`${actorId}:${platform}`, { png, at: Date.now() });
      console.log(`[shop-qr] ${platform} 预检已截码 ${png.length}B（推码阶段直接复用）`);
    } catch (err) {
      console.log(
        `[shop-qr] ${platform} 预检截码异常：${err instanceof Error ? err.message.slice(0, 120) : String(err)}`,
      );
    }
  }

  /**
   * 登录会话归属校验（2026-11-20）。
   *
   * token 虽然是随机 UUID，但「只靠难猜」不是隔离：卡片可能被转发、日志可能
   * 带出 token、多端同账号时也不该互相顶掉。这里强制 session.actorId 必须等于
   * 当前请求的用户，否则一律当作「已失效」（不泄露是否存在别人的会话）。
   */
  private ownLoginSession(ctx: ToolContext, token: string): PendingLogin | null {
    const session = this.pendingLogins.get(token);
    if (!session || session.closed) return null;
    if (session.actorId !== resolveActorId(ctx)) {
      console.warn(
        `[shop-login] 登录会话归属不符，已拒绝：token=${token.slice(0, 8)}… 持有者=${session.actorId}`,
      );
      return null;
    }
    return session;
  }

  /**
   * 留驻一个「已出码」的登录页，等用户扫码（TTL 到点自动关）。
   *
   * 页面里的 JS 轮询是扫码生效的唯一通道：关了页面，用户的「确认登录」不会
   * 落到浏览器，下一步校验必然说「还没识别到登录」。
   *
   * 画面同步续上（2026-11-20）：留驻期间继续向手机端推预览帧，节奏放稀
   * （画面是静止的登录页）。否则用户扫码那几十秒里悬浮窗「无帧超时」熄灭，
   * 看起来像 Agent 已经收工——用户要求「整件事做完才关」。
   */
  private holdQrPage(
    ctx: ToolContext,
    actorId: string,
    platform: string,
    lease: BrowserPageLease,
  ): void {
    const key = `${actorId}:${platform}`;
    const prev = this.qrWaitPages.get(key);
    if (prev) {
      clearTimeout(prev.timer);
      prev.preview?.stop();
      void prev.lease.release().catch(() => {});
    }
    // TTL（2026-11-20 对齐）：客户端登录卡的二维码倒计时是 150s（ShoppingLoginCard
    // _qrTtlMs），留驻页必须**活过**倒计时——用户在倒计时内扫码，平台侧码仍有效、
    // 页面仍在轮询；旧值 120s 比客户端还短 30s，用户扫晚一点页面已经没了，
    // 「同意登录」落不下来，点「我扫好了」永远说没识别到。
    const ttlMs = Math.max(210_000, getLoginWaitMs());
    const preview =
      lease.mode === "headless"
        ? startBrowserPreviewStream(ctx, lease.page, {
            mode: lease.mode,
            sessionId: `qr-hold-${platform}-${Date.now()}`,
            intervalMs: 4_000,
            maxLifetimeMs: ttlMs + 30_000,
            sendEndOnStop: true,
          })
        : undefined;
    const timer = setTimeout(() => {
      this.qrWaitPages.delete(key);
      preview?.stop();
      void lease.release().catch(() => {});
      console.log(`[shop-qr] ${platform} 留驻页面已释放（${Math.round(ttlMs / 1000)}s 到期）`);
    }, ttlMs);
    timer.unref?.();
    this.qrWaitPages.set(key, { lease, timer, preview });
    console.log(`[shop-qr] ${platform} 页面留驻 ${Math.round(ttlMs / 1000)}s 等扫码`);
  }

  /** 用户已登录成功后，立刻释放这家留驻的等待页（不再白占内存）。 */
  private releaseQrPage(actorId: string, platform: string): void {
    const key = `${actorId}:${platform}`;
    const held = this.qrWaitPages.get(key);
    if (!held) return;
    clearTimeout(held.timer);
    this.qrWaitPages.delete(key);
    held.preview?.stop();
    void held.lease.release().catch(() => {});
  }

  /**
   * 留驻页是否已离开登录页（无 Cookie 标记平台的登录判定兜底，2026-11-20）。
   *
   * 语义与 checkLoginHandoff 的 URL 逃逸一致：扫码确认成功后登录页会跳转，
   * detectLoginPage 判不出登录页 = 已登录。页面不在留驻（已释放/从未留驻）
   * 或已关闭 → 判不了，返回 false（如实报 pending，不猜）。
   */
  private async heldQrPageLeftLogin(
    actorId: string,
    platform: string,
  ): Promise<boolean> {
    const held = this.qrWaitPages.get(`${actorId}:${platform}`);
    if (!held || held.lease.page.isClosed()) return false;
    try {
      const det = await detectLoginPage(platform, held.lease.page);
      return !det.isLogin;
    } catch {
      return false;
    }
  }

  /** 取预检缓存的码（90s 内有效，取走即删）。 */
  private takeCachedLoginPng(actorId: string, platform: string): Buffer | null {
    const key = `${actorId}:${platform}`;
    const hit = this.loginProbePngs.get(key);
    if (!hit) return null;
    this.loginProbePngs.delete(key);
    if (Date.now() - hit.at > 90_000) return null;
    return hit.png;
  }

  /**
   * 登录态捕获（「一次登录一直使用」）：把当前页面上下文中该平台域的 Cookie
   * 加密落库。按 targetUrl 限定范围——shared 模式经 CDP 连的是用户真实浏览器
   * profile，不限定范围会抓到所有站点的 Cookie。授权语义见
   * BrowserSessionService.updateCookiesFromLogin（只升不降）。失败静默：
   * 捕获是增强不是依赖，不影响主流程。
   */
  private async persistLoginCookies(
    ctx: ToolContext,
    page: Page,
    platform: string,
    targetUrl: string,
    source: "scan_login" | "shared_login" | "headless_refresh",
    opts: { agentAllowed?: boolean } = {},
  ): Promise<void> {
    // 保存须用户同意（与主流做法一致）：deny=不存；未表态=弹统一的征询条 + 本轮不存
    //（同意后下一轮起静默保存）。2026-11-02：统一问一次覆盖所有平台，不换平台再问。
    const consentActor = resolveActorId(ctx);
    const consent = await this.deps.browserSessionService.getCaptureConsent(consentActor, platform);
    if (consent === "deny") return;
    if (consent === "ask") {
      // 每人每轮只弹一次统一征询条：重复弹出会挤掉浏览器状态条
      if (!this.askedLoginConsent.has(consentActor)) {
        this.askedLoginConsent.add(consentActor);
        this.deps.askSaveLoginConsent?.(consentActor, CAPTURE_CONSENT_ALL_SITES, "购物平台");
      }
      return;
    }
    try {
      const raw = await page.context().cookies(targetUrl);
      const mapped = toImportedCookies(raw);
      if (mapped.length === 0) return;
      await this.deps.browserSessionService.updateCookiesFromLogin(
        resolveActorId(ctx),
        platform,
        mapped,
        opts,
      );
      await this.audit(ctx, "cookies_persisted", platform, { source, count: mapped.length });
    } catch {
      /* 捕获失败不影响主流程（下次成功执行会再捕获） */
    }
  }

  /**
   * 登录墙探针（2026-11-13 P0-1）：**只判断「这家能不能匿名读到价」，
   * 不抓商品、不推码、不等待**。
   *
   * 用途：比价等需要「一次性收齐所有平台」的批量任务，必须在取价**之前**
   * 就知道哪些平台要登录——否则必然半路撞墙、先交半成品答案（用户投诉：
   * 「说让我补京东的登录之后再补」）。
   *
   * 判定顺序：
   * 1. 已有授权 Cookie → 直接放行（登录态确定，无需探）。
   * 2. 匿名站点（authMode=anonymous）→ 直接放行。
   * 3. 导航到搜索页 → detectLoginPage 判登录墙（登录页 + 扫码登录特征）。
   *
   * 探测失败一律当「不拦」（放行给取价阶段用真实结果判定），宁可多跑一次
   * 也不能因为探针抖动把平台误判成要登录。
   */
  async probeLoginWall(
    ctx: ToolContext,
    platform: string,
    query: string,
    opts: { preferVisible?: boolean } = {},
  ): Promise<{ required: boolean; reason?: "login" | "captcha"; evidence?: string }> {
    const adapter = this.requireAdapter(platform);
    if (!adapter) return { required: false };
    // 匿名可读的平台：不存在登录墙
    if (adapter.authMode === "anonymous") return { required: false };

    const actorId = resolveActorId(ctx);
    // 已有授权 Cookie → 登录态确定
    const withCookie = await this.listPlatformsWithCookies(actorId, [platform])
      .then((list) => list.includes(platform))
      .catch(() => false);
    if (withCookie) return { required: false };

    let lease: BrowserPageLease | null = null;
    // 探针也是一次真实的云端浏览器导航：顺手推画面，客户端从比价一开始就有东西看。
    let preview: BrowserPreviewHandle | null = null;
    try {
      const cookieResult = await this.getCookieAndSiteId(actorId, platform);
      lease = await this.browserExecutor.acquirePage(
        actorId,
        // 登录族平台直达登录页：比「搜索页 → 302 登录」少两次重定向
        platformEntryUrl(platform, adapter.searchUrl(query, {})),
        {
          siteId: platform,
          cookies: cookieResult.ok ? cookieResult.cookies : [],
          interactiveLogin: ctx.pushMediaCards != null,
          preferHeadless: opts.preferVisible !== true,
          allowAnonymous: true,
        },
      );
      if (lease.mode === "headless") {
        preview = startBrowserPreviewStream(ctx, lease.page, {
          mode: lease.mode,
          sessionId: `probe-${platform}-${Date.now()}`,
        });
      }
      // 落页稳定后再判一次（约 700ms：直达登录页时 URL 已能定论）
      await lease.page.waitForTimeout(700).catch(() => {});
      const det = await detectLoginPage(platform, lease.page);
      if (det.isLogin) {
        // 命中即截码（现成的登录页，别浪费）：推码阶段直接复用，省一次重导航。
        await this.captureQrIntoCache(actorId, platform, lease.page);
        // 留驻页面（2026-11-20 修「扫码同意了仍显示未登录」的根因）：
        // 预检截完码就把页面放掉，推码阶段命中缓存复用 PNG 时又不开新页——
        // 用户扫的那张码背后**没有任何页面在轮询 token**，手机上的「同意登录」
        // 永远不会落成浏览器 Cookie，「我扫好了」必然失败。这里把探针页
        // 原地留驻（页面上就是刚截的那张码，token 一一对应），推码阶段
        // 缓存命中时直接搭这趟车。
        const heldPng = this.loginProbePngs.get(`${actorId}:${platform}`)?.png ?? null;
        if (ctx.pushMediaCards != null && heldPng) {
          this.holdQrPage(ctx, actorId, platform, lease);
          lease = null; // 交给留驻逻辑管，finally 不再 release
        }
        return { required: true, reason: "login", evidence: det.reason };
      }
      return { required: false };
    } catch {
      // 探针失败不当登录墙
      return { required: false };
    } finally {
      preview?.stop();
      if (lease) await lease.release().catch(() => {});
    }
  }

  async searchProduct(
    ctx: ToolContext,
    platform: string,
    query: string,
    filters?: SearchFilters,
    innerOpts?: { preferHeadless?: boolean; loginWaitMs?: number; suppressHandoff?: boolean },
  ): Promise<ShoppingOrderResult> {
    const adapter = this.requireAdapter(platform);
    if (!adapter) {
      return { ok: false, error: `平台「${platform}」暂不支持。已实现：${listSupportedPlatforms().join("/")}` };
    }
    const limit = Math.min(Math.max(filters?.limit ?? 5, 1), 10);
    const suppressHandoff = innerOpts?.suppressHandoff === true;

    return this.withShoppingPage(
      ctx,
      platform,
      adapter.searchUrl(query, filters),
      async (page, mode) => {
      try {
        // 自愈取数：CSS → 滚动重试 → 语义锚点 → 视觉兜底（可插拔，env 门控）。
        // 对齐主流 agentic browser 的错误恢复模式：抓空不放弃，换策略再来。
        const visionEnabled = this.deps.visionExtract != null && process.env.SHOPPING_VISION_HEALING === "1";
        const heal = await extractWithSelfHeal(page, {
          cssExtract: () => adapter.extractProducts(page, limit),
          semanticExtract: () => semanticExtractProducts(page, platform, limit),
          ...(visionEnabled && this.deps.visionExtract
            ? {
                visionExtract: async () => {
                  const shot = await page.screenshot({ type: "png", fullPage: false }).catch(() => null);
                  if (!shot) return [];
                  const raw = await this.deps.visionExtract!({
                    screenshotBase64: shot.toString("base64"),
                    platform,
                    query,
                    limit,
                  });
                  return parseVisionProducts(raw ?? "", limit);
                },
              }
            : {}),
        });
        const products = heal.products;

        // 二次过滤：maxPrice
        const filtered = filters?.maxPrice
          ? products.filter((p) => p.price == null || p.price <= (filters.maxPrice as number))
          : products;

        await this.audit(ctx, "search", platform, {
          query,
          limit,
          resultCount: filtered.length,
          browserMode: mode,
          healAttempts: heal.attempts.join(">"),
        });

        if (filtered.length === 0) {
          // 「搜索不到」不等于「需要用户」：先看页面有没有登录墙/验证码这类硬信号。
          // 只有命中才交人（对齐主流 Agent 的 human checkpoint）；普通无结果如实返回。
          // 无头通道也要检测：手机端没有可视浏览器，命中后把登录二维码/验证页截图
          // 推到聊天，用户处理完回复继续（与可见浏览器能力对齐）。
          // 注意：suppressHandoff 只抑制本层逐平台通知（比价层要合成一次统一交接），
          // 不抑制检测。
          const human: HumanRequiredDetection = await detectHumanRequired(platform, page).catch(
            () => ({ required: false }),
          );
          if (human.required && human.reason) {
            const imageUrl = await this.pushHumanCard(ctx, page, platform, human.reason);
            if (!suppressHandoff && mode === "shared") this.notifyUserAction(ctx, [platform], human.reason);
            const action = human.reason === "login" ? "登录" : "验证";
            return {
              ok: false,
              error:
                mode === "shared"
                  ? `在${platform}搜索「${query}」需要你本人完成${action}：已在内置浏览器打开页面`
                  : imageUrl
                    ? `在${platform}搜索「${query}」需要你本人完成${action}：登录二维码/验证页截图已推送到聊天，处理完回复我继续`
                    : `在${platform}搜索「${query}」需要你本人完成${action}：交接图无法推送，请稍后重试`,
              retryable: true,
              humanRequired: { platform, reason: human.reason, ...(human.evidence ? { evidence: human.evidence } : {}) },
            };
          }
          return {
            ok: true,
            summary: `在${platform}搜索「${query}」未找到商品（可能无匹配或页面结构变更）`,
            products: [],
            platform,
            query,
            hint: "若无结果，可换个关键词重试；或确认平台登录态未过期",
          };
        }

        return {
          ok: true,
          summary: `在${platform}搜索「${query}」找到 ${filtered.length} 个商品`,
          products: filtered,
          platform,
          query,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // 页面打不开/超时不自动交人：主流 Agent 只把登录墙/验证码交人。
        // 先看页面是否其实停在验证页，命中才 handoff；否则如实报错（可重试）。
        // 同上：无头通道也检测并推送交接图，suppressHandoff 只抑制逐平台通知。
        const human: HumanRequiredDetection = await detectHumanRequired(platform, page).catch(
          () => ({ required: false }),
        );
        if (human.required && human.reason) {
          await this.pushHumanCard(ctx, page, platform, human.reason);
          if (!suppressHandoff && mode === "shared") this.notifyUserAction(ctx, [platform], human.reason);
        }
        return {
          ok: false,
          error: redactCredentials(`搜索失败：${message}${message.includes("Executable doesn't exist") ? "（请在 server 目录执行: npx playwright install chromium）" : ""}`),
          retryable: /timeout|navigation/i.test(message),
          ...(human.required && human.reason
            ? { humanRequired: { platform, reason: human.reason, ...(human.evidence ? { evidence: human.evidence } : {}) } }
            : {}),
        };
      }
    }, {
      preferHeadless: innerOpts?.preferHeadless === true,
      loginWaitMs: innerOpts?.loginWaitMs,
      suppressHandoff,
      // 免登录站点（苏宁/什么值得买）不因「没有 Cookie」被门禁挡住
      allowAnonymous: adapter.authMode === "anonymous",
    });
  }

  /**
   * 读商品详情页的**全部**规格维度与选项（2026-11-06 用户要求）。
   *
   * 只读、无副作用；返回空数组表示这个商品确实没有可拆规格（或页面读不出），
   * 调用方据此直接去结算——不给用户一个空规格页，也不编造选项。
   */
  async fetchProductSpecs(
    ctx: ToolContext,
    platform: string,
    url: string,
  ): Promise<ShoppingOrderResult> {
    const adapter = this.requireAdapter(platform);
    if (!adapter) {
      return { ok: false, error: `平台「${platform}」暂不支持。已实现：${listSupportedPlatforms().join("/")}` };
    }
    const extract = adapter.extractSpecs;
    if (!extract) return { ok: false, error: "该平台暂不支持读取规格" };
    const actorId = resolveActorId(ctx);
    // 刻意**不走** withShoppingPage：那条通道带登录门（京东详情页会弹登录浮层，
    // detectLoginPage 判为登录后要白等 120 秒扫码），而读规格只是只读动作。
    // 这里直接拿一个匿名/已登录页面，读到什么算什么，读不到就返回空。
    let cookies: ImportedBrowserCookie[] = [];
    const cookieResult = await this.getCookieAndSiteId(actorId, platform);
    if (cookieResult.ok) cookies = cookieResult.cookies;
    const lease = await this.browserExecutor.acquirePage(actorId, url, {
      siteId: platform,
      cookies,
      interactiveLogin: false,
      preferHeadless: true,
      allowAnonymous: true,
    });
    const preview: BrowserPreviewHandle | null =
      lease.mode === "headless"
        ? startBrowserPreviewStream(ctx, lease.page, { mode: lease.mode })
        : null;
    try {
      await lease.page.waitForTimeout(2_000).catch(() => {});
      const specs = await extract(lease.page);
      const pageTitle = await lease.page.title().catch(() => "");
      return {
        ok: true,
        summary: specs.length > 0 ? `读到 ${specs.length} 个规格维度` : "这个商品没有可拆的规格",
        specs,
        itemTitle: pageTitle.split(/[-_|（(]/)[0]?.trim() || undefined,
      };
    } finally {
      preview?.stop();
      await lease.release();
    }
  }

  /**
   * 开始卡内扫码登录：开页 → 若落在登录页 → 二维码落盘 → **持有 lease 等用户扫**。
   *
   * 与旧链路的区别：旧链路截完图就放页面、把码推到聊天流、让用户打字说「扫了」，
   * 页面一关登录态就丢（扫码后的 Cookie 是那个页面自己轮询到的）。这里把 lease
   * 留在会话里，check 时读 Cookie 落库才算完成。
   */
  async beginLoginHandoff(
    ctx: ToolContext,
    platform: string,
    targetUrl: string,
    /**
     * force：跳过「打开商品页看是否被拦」的预检，直接去平台登录页截码。
     * 场景：苏宁这类商品页匿名能看、**结算页**才要登录的平台——预检会误判
     * 「已登录」，只有 placeOrder 真的撞了结算登录墙后才知道必须登录。
     */
    opts: { force?: boolean } = {},
  ): Promise<
    | { ok: true; alreadyLoggedIn: true }
    | { ok: true; alreadyLoggedIn: false; token: string; imageUrl: string | null; qrLink?: string; qrLinkFallback?: string }
    | { ok: false; error: string }
  > {
    const actorId = resolveActorId(ctx);
    let cookies: ImportedBrowserCookie[] = [];
    const cookieResult = await this.getCookieAndSiteId(actorId, platform);
    if (cookieResult.ok) cookies = cookieResult.cookies;
    let lease: BrowserPageLease;
    try {
      lease = await this.browserExecutor.acquirePage(actorId, targetUrl, {
        siteId: platform,
        cookies,
        interactiveLogin: false,
        preferHeadless: true,
        allowAnonymous: true,
      });
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    // 扫码登录页同样是云端浏览器画面：推给悬浮窗，用户能看到 Agent 停在哪一页等登录。
    const preview: BrowserPreviewHandle | null =
      lease.mode === "headless"
        ? startBrowserPreviewStream(ctx, lease.page, { mode: lease.mode })
        : null;
    try {
      await lease.page.waitForTimeout(2_500).catch(() => {});
      let det = await detectLoginPage(platform, lease.page);
      if (!det.isLogin && opts.force === true) {
        // 商品页匿名能看不等于已登录（结算页才要登录）：直接去平台登录页截码。
        const loginUrl = PLATFORM_LOGIN_URLS[platform];
        if (!loginUrl) {
          await lease.release();
          return { ok: false, error: `${this.platformLabel(platform)}没有已知的登录页入口` };
        }
        await lease.page.goto(loginUrl, { waitUntil: "domcontentloaded", timeout: 20_000 }).catch(() => {});
        await lease.page.waitForTimeout(2_000).catch(() => {});
        det = await detectLoginPage(platform, lease.page);
      }
      if (!det.isLogin) {
        await lease.release();
        return { ok: true, alreadyLoggedIn: true };
      }
      const pageQr = await this.qrAssist.savePageQrPng(ctx, lease.page, platform);
      const imageUrl = pageQr?.imageUrl ?? null;
      const token = randomUUID();
      this.pendingLogins.set(token, {
        token,
        actorId,
        platform,
        targetUrl,
        lease,
        expiresAt: Date.now() + getLoginWaitMs(),
        closed: false,
      });
      return {
        ok: true,
        alreadyLoggedIn: false,
        token,
        imageUrl,
        ...(pageQr?.qrLink ? { qrLink: pageQr.qrLink } : {}),
        ...(pageQr?.qrLinkFallback ? { qrLinkFallback: pageQr.qrLinkFallback } : {}),
      };
    } catch (err) {
      await lease.release().catch(() => {});
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    } finally {
      preview?.stop();
    }
  }

  /**
   * 收割上一轮遗留的扫码登录会话（2026-11-06 修「超时后扫了码没人接」）：
   * 工具超时返回后页面 lease 转入 pendingLogins 继续存活，聊天里那张二维码
   * 仍然有效。用户扫完回复任意一句，下一次工具执行先到这里把登录态收下来——
   * 已登录 → Cookie 落库并释放旧页，本轮直接带着登录态继续；没登录/已过期 →
   * 释放旧页（聊天里的旧码作废），本轮照常出新码。
   */
  private async harvestPendingLogins(
    ctx: ToolContext,
    actorId: string,
    platform: string,
  ): Promise<void> {
    for (const session of Array.from(this.pendingLogins.values())) {
      if (session.closed || session.actorId !== actorId || session.platform !== platform) continue;
      let loggedIn = false;
      try {
        const det = await detectLoginPage(session.platform, session.lease.page);
        // URL 已离开登录页，或 Cookie 带正向登录信号，都算登录成功
        loggedIn = !det.isLogin || (await isPlatformLoggedIn(session.platform, session.lease.page));
      } catch {
        loggedIn = false;
      }
      if (loggedIn) {
        await this.persistLoginCookies(
          ctx,
          session.lease.page,
          session.platform,
          session.targetUrl,
          "scan_login",
          { agentAllowed: true },
        );
      }
      await this.closeLoginSession(session);
    }
  }

  /**
   * 查卡内扫码结果：已登录 → 落 Cookie、释放页面。
   * 还没扫到返回 stillWaiting，让用户再点一次「我扫好了」。
   */
  /**
   * 多平台登录态批量校验（2026-11-13 P0-2）：多平台登录卡上用户点「我扫好了」
   * 时，逐家确认登录态——扫了哪几家就绪、哪几家还没扫，如实回报。
   *
   * 判定用**已授权 Cookie**（浏览器会话里落库的登录态），不依赖某个具体
   * 页面 lease：多平台推码时各平台页面是独立打开的，用户可能只扫了其中一个。
   */
  async checkMultiPlatformLogin(
    ctx: ToolContext,
    platforms: string[],
  ): Promise<{ ready: string[]; pending: string[] }> {
    const actorId = resolveActorId(ctx);
    const withCookie = await this.listPlatformsWithCookies(actorId, platforms)
      .catch(() => [] as string[]);
    const ready = new Set(withCookie.filter((p) => platforms.includes(p)));

    // 库里没有不代表没登录（2026-11-20 修「扫了码还说没识别到」）：
    // 多平台登录卡是截完码就关页面的，用户扫码后 Cookie 只落在常驻 context
    // 里，从未落库 → 点「我扫好了」永远 pending。这里先读 context 的实时
    // Cookie 判定，判到登录就（在用户已授权的前提下）顺手落库。
    for (const platform of platforms) {
      if (ready.has(platform)) continue;
      const cookies = await this.browserExecutor
        .readContextCookies(actorId, platform)
        .catch(() => []);
      // 诊断（2026-11-21）：只记 Cookie **名字**，不记值。用户反馈「手机显示
      // 登录、云端没变化」时，靠这行判断云端 context 到底有没有兑现登录态，
      // 以及登录后落的 Cookie 名是不是我们 marker 表里认的那几个。
      console.log(
        `[shop-login] ${platform} context Cookie 诊断：${cookies.length} 条 [${cookies.map((c) => c.name).join(", ")}]；marker=${JSON.stringify(getLoginCookieMarkerNames(platform))}`,
      );
      if (cookies.length > 0 && hasLoginCookieMarker(platform, cookies)) {
        ready.add(platform);
        this.releaseQrPage(actorId, platform);
        try {
          const consent = await this.deps.browserSessionService.getCaptureConsent(actorId, platform);
          if (consent === "allow") {
            await this.deps.browserSessionService.updateCookiesFromLogin(
              actorId,
              platform,
              cookies,
              { agentAllowed: true },
            );
            console.log(`[shop-login] ${platform} 扫码登录已生效并落库（${cookies.length} 条）`);
          } else {
            console.log(
              `[shop-login] ${platform} 扫码登录已生效（consent=${consent ?? "unset"}，本轮不落库）`,
            );
          }
        } catch {
          /* 落库失败不影响本轮判定 */
        }
        continue;
      }
      // 留驻页 URL 逃逸兜底（2026-11-21 收紧）：**只对没有 Cookie marker 的平台**
      // 生效（点评/飞猪/去哪儿等无强信号可用）。对有 marker 的平台（pdd/jd/
      // taobao…），页面跳走可能是扫码落地页 down_scan.html / 超时 / 风控跳转，
      // 并不等于拿到登录态——2026-11-21 用户「手机显示登录、云端没变化」就是
      // 被这里的假成功骗了：context 无 PDDUserID，却报「已离开登录页=成功」。
      // 这类平台必须读到真实登录 Cookie 才算，宁可如实报 pending，不猜。
      if (!hasLoginCookieMarkerNames(platform) && await this.heldQrPageLeftLogin(actorId, platform)) {
        ready.add(platform);
        this.releaseQrPage(actorId, platform);
        console.log(`[shop-login] ${platform} 扫码登录已生效（留驻页已离开登录页，无 Cookie marker 平台）`);
      } else if (hasLoginCookieMarkerNames(platform) && await this.heldQrPageLeftLogin(actorId, platform)) {
        console.log(
          `[shop-login] ${platform} 留驻页已离开登录页，但 context 无登录 Cookie marker——判为未登录（不误报成功；扫码落地页跳转/风控都会让页面跳走）`,
        );
      }
    }

    const readyList = platforms.filter((p) => ready.has(p));
    const pending = platforms.filter((p) => !ready.has(p));
    return { ready: readyList, pending };
  }

  async checkLoginHandoff(
    ctx: ToolContext,
    token: string,
  ): Promise<
    | { ok: true; needsConsent: boolean }
    | { ok: false; stillWaiting: boolean; error: string }
  > {
    const session = this.ownLoginSession(ctx, token);
    if (!session) {
      return { ok: false, stillWaiting: false, error: "这次登录已经失效了，重新点一次商品就行" };
    }
    if (Date.now() > session.expiresAt) {
      await this.closeLoginSession(session);
      return { ok: false, stillWaiting: false, error: "二维码过期了，重新点一次商品就行" };
    }
    await session.lease.page.waitForTimeout(1_200).catch(() => {});
    const det = await detectLoginPage(session.platform, session.lease.page);
    // Cookie 正向信号（2026-11-06）：扫码确认后页面常停在登录域的过渡页，
    // URL 启发式会一直误判「还没登录」；Cookie 已带登录态就该放行。
    const cookieLogin = det.isLogin
      ? await isPlatformLoggedIn(session.platform, session.lease.page)
      : false;
    if (det.isLogin && !cookieLogin) {
      return {
        ok: false,
        stillWaiting: true,
        error: "还没识别到登录——手机上扫码并确认后，再点一下「我扫好了」",
      };
    }
    // 保存 Cookie 是否要问用户（2026-11-06 用户定稿：**只问第一次**）。
    // 统一授权键（答一次对所有平台生效）：已同意 → 静默落库；已拒绝 → 不存
    // 也不再问；没表态（首次）→ 卡内询问，等用户选择。
    const consent = await this.deps.browserSessionService.getCaptureConsent(
      resolveActorId(ctx),
      session.platform,
    );
    if (consent !== "ask") {
      if (consent === "allow") {
        await this.persistLoginCookies(
          ctx,
          session.lease.page,
          session.platform,
          session.targetUrl,
          "scan_login",
          { agentAllowed: true },
        );
      }
      await this.closeLoginSession(session);
      return { ok: true, needsConsent: false };
    }
    // 首次：登录态先不落库，把会话续期 3 分钟等用户在同意卡上做选择——
    // 「保存登录」落库并记录统一授权（此后所有登录免问）；「不保存」直接放行
    // （登录态还活在匿名浏览器的 context 里，够走完这一单，回收后自然失效）。
    session.expiresAt = Math.max(session.expiresAt, Date.now() + 3 * 60_000);
    return { ok: true, needsConsent: true };
  }

  /**
   * 用户对「是否保存登录」做出选择（2026-11-06，只问第一次）：
   * save=true → 记录**统一授权**（此后所有平台登录静默保存）+ 本次落库；
   * save=false → 什么都不存也不记录（下次登录仍会问）。两种都释放会话。
   */
  async settleLoginConsent(
    ctx: ToolContext,
    token: string,
    save: boolean,
  ): Promise<{ ok: boolean; error?: string }> {
    const session = this.ownLoginSession(ctx, token);
    if (!session) {
      return { ok: false, error: "这次登录已经失效了，重新点一次商品就行" };
    }
    if (save) {
      await this.deps.browserSessionService.setCaptureConsent(
        resolveActorId(ctx),
        CAPTURE_CONSENT_ALL_SITES,
        true,
      );
      await this.persistLoginCookies(
        ctx,
        session.lease.page,
        session.platform,
        session.targetUrl,
        "scan_login",
        { agentAllowed: true },
      );
    }
    await this.closeLoginSession(session);
    return { ok: true };
  }

  private async closeLoginSession(session: PendingLogin): Promise<void> {
    if (session.closed) return;
    session.closed = true;
    this.pendingLogins.delete(session.token);
    await session.lease.release().catch(() => {});
  }

  async placeOrder(
    ctx: ToolContext,
    platform: string,
    item: string,
    quantity: number,
    confirm: boolean,
    confirmationToken?: string,
    /**
     * 用户在规格卡里选中的组合（维度名 → 选项文案）。只在阶段一生效：
     * 进结算页之前先在详情页把这几个选项点一遍，否则结算页会按默认 SKU 走，
     * 用户选了 512G 却拿到 256G 的单。
     */
    pickedSpecs?: Record<string, string>,
  ): Promise<ShoppingOrderResult> {
    const actorId = resolveActorId(ctx);

    // 阶段二：confirm=true + token
    if (confirm) {
      return this.executePlaceStage2(ctx, platform, confirmationToken);
    }

    // 阶段一：confirm=false
    return this.executePlaceStage1(ctx, platform, item, quantity, pickedSpecs);
  }

  private async executePlaceStage1(
    ctx: ToolContext,
    platform: string,
    item: string,
    quantity: number,
    pickedSpecs?: Record<string, string>,
  ): Promise<ShoppingOrderResult> {
    const actorId = resolveActorId(ctx);
    const adapter = this.requireAdapter(platform);
    if (!adapter) {
      return { ok: false, error: `平台「${platform}」暂不支持。已实现：${listSupportedPlatforms().join("/")}` };
    }
    const qty = Math.min(Math.max(quantity, 1), 99);

    // item 可以是商品 URL 或关键词描述。
    // 若是 URL，直接作为 product.url；否则需要先搜索拿到 product。
    let product: ProductSummary;
    if (/^https?:\/\//i.test(item)) {
      product = { title: "用户指定商品", url: item };
    } else {
      // 先搜索找到第一个匹配商品
      const searchResult = await this.searchProduct(ctx, platform, item, { limit: 1 });
      if (!searchResult.ok) return searchResult;
      const products = (searchResult as { products?: ProductSummary[] }).products ?? [];
      if (products.length === 0) {
        return {
          ok: false,
          error: `在${platform}未找到「${item}」相关商品，无法下单`,
          retryable: true,
        };
      }
      product = products[0];
    }

    let cookies: ImportedBrowserCookie[] = [];
    const cookieResult = await this.getCookieAndSiteId(actorId, platform);
    if (cookieResult.ok) cookies = cookieResult.cookies;

    const firstUrl = product.url ?? adapter.searchUrl(item);
    let lease: BrowserPageLease;
    try {
      lease = await this.browserExecutor.acquirePage(actorId, firstUrl, {
        siteId: platform,
        cookies,
        interactiveLogin: ctx.pushMediaCards != null,
        // 匿名可达的站点（苏宁商品页等）没有 Cookie 也要能开页：登录墙由
        // ensureLoggedIn / 结算页检测接住并转成 loginRequired，而不是在这里
        // 直接抛 no_cookie 把卡内扫码那条路堵死（手机端无内置浏览器）。
        preferHeadless: true,
        allowAnonymous: true,
      });
    } catch (err) {
      if (err instanceof BrowserPageUnavailableError) {
        return { ok: false, error: err.message, retryable: false };
      }
      throw err;
    }

    // 阶段一成功时租约转交 ActiveSession（阶段二/过期时释放）；其余路径 finally 释放
    let keepAlive = false;
    // 结算页同样是云端浏览器画面（2026-11-14）：下单流程全程可围观。
    const preview: BrowserPreviewHandle | null =
      lease.mode === "headless"
        ? startBrowserPreviewStream(ctx, lease.page, { mode: lease.mode })
        : null;
    try {
      await lease.page.waitForTimeout(2_500).catch(() => {});
      const gate = await this.ensureLoggedIn(ctx, lease, platform, firstUrl);
      if (gate) return gate;

      // 用户在规格卡里点过的组合：先在详情页把这几个选项点一遍，再进结算。
      // 点选失败不阻断下单（页面默认 SKU 继续走），但结果里带 specApplied=false，
      // 卡面必须如实说明「规格没选上，按默认规格结算」——不能默默换掉用户的选择。
      let specApplied: boolean | undefined;
      if (pickedSpecs && Object.keys(pickedSpecs).length > 0) {
        if (adapter.applySpecs) {
          const applied = await adapter
            .applySpecs(lease.page, pickedSpecs)
            .catch(() => ({ ok: false as const }));
          specApplied = applied.ok === true;
        } else {
          specApplied = false;
        }
        await lease.page.waitForTimeout(900).catch(() => {});
      }

      const snapshot = await adapter.navigateToCheckout(lease.page, product, qty);
      // 结算页往往才是真正要登录的地方（商品页匿名能看，苏宁/京东都这样）：
      // 撞墙就地返回 loginRequired，card.action 链路据此把二维码放进同一张卡，
      // 而不是甩一句「走到结算页失败」让用户点坏了似的。
      const postDet = await detectLoginPage(platform, lease.page).catch(() => ({
        isLogin: false,
        reason: "",
      }));
      if (postDet.isLogin) {
        return {
          ok: false,
          error: `${this.platformLabel(platform)}的结算页要登录后才能进`,
          retryable: true,
          loginRequired: { platform },
        };
      }
      if (!snapshot.ok) {        return { ok: false, error: snapshot.error ?? "走到结算页失败", retryable: snapshot.retryable };
      }

      // 单笔金额上限校验（平台覆盖优先，演出票等高价类目用 SHOPPING_ORDER_MAX_AMOUNT_<平台>_CNY 调高）
      if (snapshot.totalPrice != null && snapshot.totalPrice > getMaxAmountCny(platform)) {
        await this.audit(ctx, "place_blocked_amount", platform, {
          item, quantity: qty, totalPrice: snapshot.totalPrice, limit: getMaxAmountCny(platform),
        });
        return {
          ok: false,
          error: `订单总价 ¥${snapshot.totalPrice} 超过上限 ¥${getMaxAmountCny(platform)}，已拒绝提交。可调整 SHOPPING_ORDER_MAX_AMOUNT_CNY 或 SHOPPING_ORDER_MAX_AMOUNT_${platform.toUpperCase()}_CNY 环境变量。`,
          retryable: false,
        };
      }

      // 单日预算校验（当日已提交金额 + 本单总价）
      if (this.deps.store && snapshot.totalPrice != null) {
        const dateKey = localDateKey(new Date());
        const used = await this.deps.store.sumAmountOnDate(actorId, dateKey);
        if (used + snapshot.totalPrice > getDailyBudgetCny()) {
          await this.audit(ctx, "place_blocked_daily_budget", platform, {
            item, quantity: qty, totalPrice: snapshot.totalPrice, usedToday: used, dailyBudget: getDailyBudgetCny(),
          });
          return {
            ok: false,
            error: `今日已下单 ¥${used}，加上本单 ¥${snapshot.totalPrice} 将超过单日预算 ¥${getDailyBudgetCny()}，已拒绝提交。可调整 SHOPPING_ORDER_DAILY_BUDGET_CNY 环境变量。`,
            retryable: false,
          };
        }
      }

      // 生成确认 token，保留存活 Page（租约由 session.close 在阶段二/过期时释放）
      const token = randomUUID();
      const session: ActiveSession = {
        platform,
        actorId,
        item,
        quantity: qty,
        snapshot,
        closed: false,
        expiresAt: Date.now() + getConfirmationTtlMs(),
        close: async () => {
          if (session.closed) return;
          session.closed = true;
          await lease.release().catch(() => {});
        },
      };
      const pending: PendingConfirmation = {
        token,
        platform,
        actorId,
        item,
        quantity: qty,
        snapshot,
        session,
        expiresAt: session.expiresAt,
      };
      this.pendingConfirmations.set(token, pending);

      await this.audit(ctx, "place_stage1", platform, {
        item, quantity: qty, totalPrice: snapshot.totalPrice, token, browserMode: lease.mode,
      });

      const summaryParts: string[] = [
        `即将在${platform}下单`,
        snapshot.itemTitle ? `商品：${snapshot.itemTitle}` : "",
        `数量：${snapshot.quantity ?? qty}`,
        snapshot.totalPrice != null ? `总价：¥${snapshot.totalPrice}` : "",
        snapshot.addressSummary ? `收货：${snapshot.addressSummary}` : "",
      ].filter(Boolean);

      // 登录态捕获（一次登录一直使用）：与本页执行的其他路径同语义
      await this.persistLoginCookies(
        ctx,
        lease.page,
        platform,
        firstUrl,
        lease.mode === "shared" ? "shared_login" : "headless_refresh",
        lease.mode === "shared" ? { agentAllowed: true } : {},
      );

      keepAlive = true;
      return {
        ok: true,
        summary: summaryParts.join("，"),
        needsConfirmation: true,
        confirmationToken: token,
        platform,
        itemTitle: snapshot.itemTitle,
        unitPrice: snapshot.unitPrice,
        quantity: snapshot.quantity,
        totalPrice: snapshot.totalPrice,
        currency: snapshot.currency,
        addressSummary: snapshot.addressSummary,
        screenshotBase64: snapshot.screenshotBase64,
        checkoutUrl: snapshot.checkoutUrl,
        expiresInMs: getConfirmationTtlMs(),
        // 绝对到期时刻（给确认卡倒计时用）：客户端按它算剩余，不按渲染时刻起算，
        // 历史消息回看时倒计时不会重新跑。
        expiresAt: session.expiresAt,
        ...(specApplied === undefined ? {} : { specApplied }),
        hint: "请向用户复述上述摘要，得到明确同意后，带 confirm=true + confirmationToken 再调用本工具完成提交",
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: redactCredentials(`走到结算页失败：${message}`), retryable: /timeout|navigation/i.test(message) };
    } finally {
      preview?.stop();
      if (!keepAlive) await lease.release().catch(() => {});
    }
  }

  private async executePlaceStage2(
    ctx: ToolContext,
    platform: string,
    confirmationToken?: string,
  ): Promise<ShoppingOrderResult> {
    if (!confirmationToken) {
      return { ok: false, error: "阶段二缺少 confirmationToken" };
    }
    const pending = this.pendingConfirmations.get(confirmationToken);
    if (!pending || pending.actorId !== resolveActorId(ctx)) {
      // 归属不符与不存在同一文案：不泄露「别人的 token 存在」
      return { ok: false, error: "确认 token 无效或已过期，请重新发起下单（confirm=false）", retryable: true };
    }
    if (Date.now() > pending.expiresAt) {
      this.pendingConfirmations.delete(confirmationToken);
      if (pending.session && !pending.session.closed) {
        await pending.session.close().catch(() => {});
      }
      return { ok: false, error: "确认已过期，请重新发起下单（confirm=false）", retryable: true };
    }
    if (pending.platform !== platform) {
      return { ok: false, error: `平台不匹配：token 属于 ${pending.platform}，但请求平台为 ${platform}` };
    }

    const adapter = this.requireAdapter(platform);
    if (!adapter) {
      return { ok: false, error: `平台「${platform}」暂不支持` };
    }

    try {
      // 优先复用阶段一存活 Page
      let submitResult;
      if (pending.session && !pending.session.closed) {
        // 阶段一保留的 context 已关闭，但 Page 还在？实际上 context.close 会关闭 page。
        // 这里改为：阶段二重新获取页面，重新走到结算页，再提交。
        // （保持简单：不复用 Page，因为 context/page 生命周期管理复杂，重建更稳）
        await pending.session.close().catch(() => {});
      }

      let cookies: ImportedBrowserCookie[] = [];
      const cookieResult = await this.getCookieAndSiteId(pending.actorId, platform);
      if (cookieResult.ok) cookies = cookieResult.cookies;

      const product: ProductSummary = {
        title: pending.snapshot.itemTitle ?? pending.item,
        url: pending.snapshot.checkoutUrl,
      };
      const firstUrl = product.url ?? adapter.searchUrl(pending.item);
      let lease: BrowserPageLease;
      try {
        lease = await this.browserExecutor.acquirePage(pending.actorId, firstUrl, {
          siteId: platform,
          cookies,
          interactiveLogin: ctx.pushMediaCards != null,
        });
      } catch (err) {
        if (err instanceof BrowserPageUnavailableError) {
          this.pendingConfirmations.delete(confirmationToken!);
          return { ok: false, error: err.message, retryable: false };
        }
        throw err;
      }
      // 提交订单这步也在云端浏览器里：把结算/提交画面推给悬浮窗。
      const preview: BrowserPreviewHandle | null =
        lease.mode === "headless"
          ? startBrowserPreviewStream(ctx, lease.page, { mode: lease.mode })
          : null;

      try {
        await lease.page.waitForTimeout(2_500).catch(() => {});
        const gate = await this.ensureLoggedIn(ctx, lease, platform, firstUrl);
        if (gate) {
          this.pendingConfirmations.delete(confirmationToken!);
          return gate;
        }

        // 若 checkoutUrl 存在且仍有效，直接 goto 结算页；否则重新走 navigateToCheckout
        if (pending.snapshot.checkoutUrl && /^https:\/\//i.test(pending.snapshot.checkoutUrl)) {
          if (lease.page.url() !== pending.snapshot.checkoutUrl) {
            await lease.page
              .goto(pending.snapshot.checkoutUrl, { waitUntil: "domcontentloaded", timeout: 15_000 })
              .catch(() => {});
            await lease.page.waitForTimeout(2_000).catch(() => {});
          }
        } else {
          const reSnap = await adapter.navigateToCheckout(lease.page, product, pending.quantity);
          if (!reSnap.ok) {
            this.pendingConfirmations.delete(confirmationToken!);
            return { ok: false, error: reSnap.error ?? "重新走到结算页失败", retryable: reSnap.retryable };
          }
        }

        submitResult = await adapter.submitOrder(lease.page);

        // 登录态捕获（一次登录一直使用）：提交后平台的最新 Cookie 回写更新
        await this.persistLoginCookies(
          ctx,
          lease.page,
          platform,
          firstUrl,
          lease.mode === "shared" ? "shared_login" : "headless_refresh",
          lease.mode === "shared" ? { agentAllowed: true } : {},
        );
      } finally {
        preview?.stop();
        await lease.release().catch(() => {});
      }

      this.pendingConfirmations.delete(confirmationToken);

      await this.audit(ctx, "place_stage2", platform, {
        item: pending.item,
        quantity: pending.quantity,
        totalPrice: pending.snapshot.totalPrice,
        orderId: submitResult.orderId,
        ok: submitResult.ok,
      });

      if (!submitResult.ok) {
        return { ok: false, error: submitResult.error ?? "提交订单失败", retryable: submitResult.retryable };
      }

      // 落库（本地订单表是查历史/对账/单日预算的依据；平台未回吐单号时也记录）
      let localOrderId: string | undefined;
      if (this.deps.store) {
        const now = new Date();
        const stored = await this.deps.store.create({
          orderId: newShoppingOrderId(now),
          actorId: pending.actorId,
          platform,
          platformOrderId: submitResult.orderId ?? null,
          title: pending.snapshot.itemTitle ?? pending.item,
          quantity: pending.snapshot.quantity ?? pending.quantity,
          amountCny: pending.snapshot.totalPrice ?? null,
          currency: pending.snapshot.currency,
          status: "pending_payment",
          addressSummary: pending.snapshot.addressSummary ?? null,
          paymentUrl: submitResult.paymentUrl ?? null,
          checkoutUrl: pending.snapshot.checkoutUrl ?? null,
          note: submitResult.error ?? null,
          dateKey: localDateKey(now),
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
        });
        localOrderId = stored.orderId;
      }

      await this.audit(ctx, "place_persisted", platform, {
        localOrderId, orderId: submitResult.orderId, totalPrice: pending.snapshot.totalPrice,
      });

      return {
        ok: true,
        summary: `已在${platform}提交订单${submitResult.orderId ? `（订单号 ${submitResult.orderId}）` : ""}${submitResult.error ? `；${submitResult.error}` : ""}。订单待支付`,
        platform,
        orderId: submitResult.orderId,
        localOrderId,
        itemTitle: pending.snapshot.itemTitle,
        totalPrice: pending.snapshot.totalPrice,
        currency: pending.snapshot.currency,
        paymentUrl: submitResult.paymentUrl,
        note: submitResult.error ?? "订单已提交、未支付。可用 shopping.pay.check 查询支付状态；若拿到支付宝收银台链接可用 shopping.pay.submit 代付，否则请在平台 App 内完成支付。",
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: redactCredentials(`提交订单失败：${message}`), retryable: /timeout|navigation/i.test(message) };
    }
  }

  async trackOrder(
    ctx: ToolContext,
    platform: string,
    orderId?: string,
  ): Promise<ShoppingOrderResult> {
    const actorId = resolveActorId(ctx);
    const adapter = this.requireAdapter(platform);
    if (!adapter) {
      return { ok: false, error: `平台「${platform}」暂不支持。已实现：${listSupportedPlatforms().join("/")}` };
    }

    // 本地订单解析：orderId 支持本地 so_* 单号或平台单号
    let localOrder: StoredShoppingOrder | null = null;
    let platformOrderId = orderId;
    if (this.deps.store && orderId) {
      if (orderId.startsWith("so_")) {
        const found = await this.deps.store.get(orderId);
        if (!found || found.actorId !== actorId) {
          return { ok: false, error: `本地订单 ${orderId} 不存在` };
        }
        if (found.platform !== platform) {
          return { ok: false, error: `订单 ${orderId} 属于平台 ${found.platform}，与请求平台 ${platform} 不符` };
        }
        localOrder = found;
        platformOrderId = found.platformOrderId ?? undefined;
      } else {
        localOrder = await this.deps.store.findByPlatformOrder(actorId, platform, orderId);
      }
    }

    return this.withShoppingPage(
      ctx,
      platform,
      adapter.orderListUrl(),
      async (page, mode) => {
        try {
          await page.waitForTimeout(500).catch(() => {});

          const orders: OrderStatus[] = await adapter.readOrderStatus(page, platformOrderId);

          await this.audit(ctx, "track", platform, { orderId, resultCount: orders.length, browserMode: mode });

          if (orders.length === 0) {
            // 平台侧没查到：本地有记录则兜底
            if (localOrder) {
              return this.localOrderResult(platform, localOrder, "平台订单页未查到该订单（可能状态页改版或订单已归档），以下为本地记录");
            }
            return {
              ok: true,
              summary: orderId ? `未在${platform}找到订单 ${orderId}` : `在${platform}未找到订单`,
              orders: [],
              platform,
            };
          }

          // 状态回写本地（能识别的状态词才更新，避免覆盖为 null）
          if (localOrder && this.deps.store) {
            for (const o of orders) {
              if (o.orderId && o.orderId === localOrder.platformOrderId) {
                const mapped = mapPlatformStatusText(o.status ?? o.statusDesc);
                if (mapped) await this.deps.store.update(localOrder.orderId, { status: mapped });
                break;
              }
            }
          }

          // 关联本地单号到返回项
          const enriched = orders.map((o) => ({
            ...o,
            localOrderId:
              localOrder && o.orderId && o.orderId === localOrder.platformOrderId ? localOrder.orderId : undefined,
          }));

          return {
            ok: true,
            summary: `查询到 ${orders.length} 个${platform}订单`,
            orders: enriched,
            platform,
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (localOrder) {
            return this.localOrderResult(platform, localOrder, `平台查询失败（${message}），以下为本地记录`);
          }
          return { ok: false, error: `查询订单失败：${message}`, retryable: /timeout|navigation/i.test(message) };
        }
      },
      {
        onUnavailable: (err) => {
          // 页面获取不可用（无 Cookie 且内置浏览器不在线）：有本地记录时兜底返回本地快照
          if (localOrder) {
            return this.localOrderResult(platform, localOrder, "平台 Cookie 未导入/未授权且内置浏览器不在线，以下为本地记录（非实时）");
          }
          return { ok: false, error: err.message, retryable: false };
        },
      },
    );
  }

  /** 本地订单快照兜底返回（平台侧不可用时）。 */
  private localOrderResult(platform: string, order: StoredShoppingOrder, note: string): ShoppingOrderResult {
    return {
      ok: true,
      summary: `${note}：${order.title}（${order.status}${order.amountCny != null ? `/¥${order.amountCny}` : ""}）`,
      orders: [
        {
          orderId: order.platformOrderId ?? order.orderId,
          status: order.status,
          statusDesc: order.status,
          itemTitle: order.title,
          totalPrice: order.amountCny ?? undefined,
          createdAt: order.createdAt,
          logisticsSummary: order.note ?? undefined,
        } satisfies OrderStatus,
      ],
      platform,
      localOrderId: order.orderId,
      paymentUrl: order.paymentUrl,
      note,
    };
  }

  /** 列出本地订单（shopping.order.list 工具；纯本地读，零副作用）。 */
  async listOrders(
    ctx: ToolContext,
    opts: { platform?: string; includeFinished?: boolean; limit?: number } = {},
  ): Promise<ShoppingOrderResult> {
    const actorId = resolveActorId(ctx);
    if (!this.deps.store) {
      return { ok: false, error: "本地订单表未启用（未注入 ShoppingOrderStore）" };
    }
    const orders = await this.deps.store.listByActor(actorId, {
      platform: opts.platform,
      includeFinished: opts.includeFinished ?? true,
      limit: Math.min(Math.max(opts.limit ?? 10, 1), 50),
    });
    if (orders.length === 0) return { ok: true, summary: "暂无本地订单记录", orders: [], count: 0 };
    return {
      ok: true,
      summary: `共 ${orders.length} 条本地订单`,
      count: orders.length,
      orders: orders.map((o) => ({
        localOrderId: o.orderId,
        platform: o.platform,
        orderId: o.platformOrderId,
        title: o.title,
        quantity: o.quantity,
        amountCny: o.amountCny,
        status: o.status,
        paymentUrl: o.paymentUrl,
        createdAt: o.createdAt,
      })),
    };
  }

  async cancelOrder(
    ctx: ToolContext,
    platform: string,
    orderId: string,
    confirm: boolean,
    confirmationToken?: string,
  ): Promise<ShoppingOrderResult> {
    const actorId = resolveActorId(ctx);

    // 阶段二
    if (confirm) {
      const pending = confirmationToken ? this.pendingConfirmations.get(confirmationToken) : null;
      if (!pending || pending.actorId !== actorId) {
        return { ok: false, error: "取消确认 token 无效或已过期，请重新发起取消（confirm=false）", retryable: true };
      }
      if (Date.now() > pending.expiresAt) {
        this.pendingConfirmations.delete(confirmationToken!);
        if (pending.session && !pending.session.closed) await pending.session.close().catch(() => {});
        return { ok: false, error: "确认已过期，请重新发起取消", retryable: true };
      }
      // 取消不需要保留 Page，直接执行
      this.pendingConfirmations.delete(confirmationToken!);
      return this.executeCancel(ctx, platform, orderId);
    }

    // 阶段一：生成 token 返回确认摘要
    const token = randomUUID();
    this.pendingConfirmations.set(token, {
      token,
      platform,
      actorId,
      item: orderId,
      quantity: 1,
      snapshot: { ok: true, itemTitle: orderId },
      expiresAt: Date.now() + getConfirmationTtlMs(),
    });

    await this.audit(ctx, "cancel_stage1", platform, { orderId, token });

    return {
      ok: true,
      summary: `即将在${platform}取消订单 ${orderId}`,
      needsConfirmation: true,
      confirmationToken: token,
      platform,
      orderId,
      expiresInMs: getConfirmationTtlMs(),
      hint: "请向用户确认后，带 confirm=true + confirmationToken 再调用本工具完成取消",
    };
  }

  private async executeCancel(
    ctx: ToolContext,
    platform: string,
    orderId: string,
  ): Promise<ShoppingOrderResult> {
    const adapter = this.requireAdapter(platform);
    if (!adapter) return { ok: false, error: `平台「${platform}」暂不支持` };

    return this.withShoppingPage(ctx, platform, adapter.orderListUrl(), async (page, mode) => {
      try {
        await page.waitForTimeout(500).catch(() => {});

        const result = await adapter.cancelOrder(page, orderId);

        await this.audit(ctx, "cancel_stage2", platform, {
          orderId, ok: result.ok, error: result.error, browserMode: mode,
        });

        // 平台取消成功 → 同步本地订单状态（按本地单号或平台单号匹配）
        if (result.ok && this.deps.store) {
          const actorId2 = resolveActorId(ctx);
          const local = orderId.startsWith("so_")
            ? await this.deps.store.get(orderId)
            : await this.deps.store.findByPlatformOrder(actorId2, platform, orderId);
          if (local && local.actorId === actorId2) {
            await this.deps.store.update(local.orderId, { status: "cancelled" });
          }
        }

        if (!result.ok) {
          return { ok: false, error: result.error ?? "取消订单失败", retryable: result.retryable };
        }
        return {
          ok: true,
          summary: `已在${platform}取消订单 ${orderId}`,
          platform,
          orderId,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { ok: false, error: `取消订单失败：${message}`, retryable: /timeout|navigation/i.test(message) };
      }
    });
  }

  // ============ 支付（shopping.pay.*） ============

  /** 支付宝收银台链接判定（alipay-bot 收银台通道只接受 alipay.com 域的收银台链接）。 */
  private isAlipayCashierUrl(url: string): boolean {
    return /^https:\/\//i.test(url) && /(cashier|qr)\.alipay\.com/i.test(url);
  }

  /**
   * 发起收银台代付（shopping.pay.submit）。
   *
   * 只支持「下单时捕获到支付宝收银台链接」的本地订单：经用户本人支付宝钱包
   * （alipay-bot）拉起收银台，实际扣款由用户在支付宝 App 内确认。
   * 无收银台链接（绝大多数平台订单）→ 明确引导用户去平台 App 支付。
   */
  async payOrder(ctx: ToolContext, orderId: string): Promise<ShoppingOrderResult> {
    const actorId = resolveActorId(ctx);
    if (!this.deps.store) return { ok: false, error: "本地订单表未启用，无法按本地单号支付" };
    const order = orderId.startsWith("so_")
      ? await this.deps.store.get(orderId)
      : null;
    if (!order || order.actorId !== actorId) {
      return { ok: false, error: `本地订单 ${orderId} 不存在（支付只支持本地单号 so_*，可先用 shopping.order.list 查询）` };
    }
    if (order.status === "paid" || order.status === "shipped" || order.status === "completed") {
      return { ok: true, summary: `订单 ${order.orderId} 已是 ${order.status} 状态，无需重复支付`, orderId: order.orderId, status: order.status };
    }
    if (order.status === "cancelled" || order.status === "failed") {
      return { ok: false, error: `订单 ${order.orderId} 已 ${order.status}，无法支付` };
    }
    if (!order.paymentUrl) {
      return {
        ok: false,
        error:
          `订单 ${order.orderId} 没有捕获到支付宝收银台链接。` +
          `请在 ${order.platform} App 内完成支付（订单号 ${order.platformOrderId ?? "见平台订单页"}），完成后可用 shopping.pay.check 同步状态`,
        needManualPayment: true,
      };
    }
    if (!this.isAlipayCashierUrl(order.paymentUrl)) {
      return {
        ok: false,
        error:
          "订单的支付链接不是支付宝收银台（该平台使用自有收银台），agent 无法代付。" +
          "请在平台 App 内完成支付，完成后可用 shopping.pay.check 同步状态",
        paymentUrl: order.paymentUrl,
        needManualPayment: true,
      };
    }

    // 内置浏览器在线 → 直接在用户可见浏览器打开收银台（收银台二维码页面本身可见；
    // 聊天侧由 shopping.pay.submit 的确定性附卡出「支付确认」按钮卡，不走图片卡）
    const sharedLease = await this.browserExecutor.tryOpenSharedPage(actorId, order.paymentUrl).catch(() => null);
    if (sharedLease) {
      try {
        await sharedLease.page.waitForTimeout(3_000).catch(() => {});
      } finally {
        await sharedLease.release().catch(() => {});
      }

      await this.audit(ctx, "pay_shared_cashier", order.platform, {
        localOrderId: order.orderId,
        platformOrderId: order.platformOrderId,
        browserMode: "shared",
      });

      return {
        ok: true,
        summary:
          `已在内置浏览器打开「${order.title}」的支付宝收银台，请在浏览器内或支付宝 App 完成支付`,
        orderId: order.orderId,
        platform: order.platform,
        amountCny: order.amountCny,
        paymentUrl: order.paymentUrl,
        browserMode: "shared",
        hint: "支付完成后用 shopping.pay.check 确认状态并同步订单",
      };
    }

    if (!this.deps.alipayBot) {
      return { ok: false, error: "内置浏览器不在线且支付宝钱包服务未装配（alipayBot 未注入），请在平台 App 内完成支付" };
    }

    try {
      const sessionId = randomUUID();
      const intentSummary =
        `服务内容：支付${order.platform}订单「${order.title}」，` +
        `支付金额：${order.amountCny != null ? `¥${order.amountCny}` : "以收银台为准"}，支付对象：${order.platform}平台商户`;
      const res = await this.deps.alipayBot.submitPayment(sessionId, order.paymentUrl, intentSummary);
      await this.audit(ctx, "pay_submit", order.platform, {
        localOrderId: order.orderId, platformOrderId: order.platformOrderId, ok: res.ok, error: res.error,
      });
      if (!res.ok) {
        return {
          ok: false,
          error: `支付宝代付发起失败：${res.error ?? res.stderr?.slice(0, 200) ?? "未知错误"}（请确认已开通并绑定本人支付宝钱包，或在平台 App 内手动支付）`,
        };
      }
      // 通用二维码推送：CLI 产出的收银台二维码实时推到聊天流（headless 场景
      // 用户看不到浏览器页面，聊天里的二维码是唯一支付入口；best-effort）
      let qrImageUrl: string | undefined;
      if (Array.isArray(res.media) && res.media.length > 0) {
        qrImageUrl =
          (await this.qrAssist
            .pushQrImage(
              ctx,
              {
                title: `请扫码支付（${order.platform}订单）`,
                caption: `¥${order.amountCny ?? "以收银台为准"} · ${order.title}`,
              },
              { filePath: String(res.media[0]) },
            )
            .catch(() => null)) ?? undefined;
      }
      return {
        ok: true,
        summary:
          `已为你拉起「${order.title}」的支付宝收银台（¥${order.amountCny ?? "以收银台为准"}），请在支付宝 App 内确认支付` +
          `${qrImageUrl ? "，二维码已推送到聊天" : ""}`,
        orderId: order.orderId,
        platform: order.platform,
        amountCny: order.amountCny,
        ...(qrImageUrl ? { qrImageUrl } : {}),
        stdout: res.stdout.slice(0, 800),
        hint: "支付完成后用 shopping.pay.check 确认状态并同步订单",
      };
    } catch (err) {
      return { ok: false, error: `支付宝代付失败：${err instanceof Error ? err.message : String(err)}` };
    }
  }

  /**
   * 查询订单支付状态（shopping.pay.check）。
   * 支持本地单号 so_* 或平台单号；有支付宝收银台链接时先查钱包支付状态，
   * 有平台单号时再经浏览器刷新平台侧状态，最后回写本地订单表。
   */
  async checkPayment(ctx: ToolContext, orderId: string): Promise<ShoppingOrderResult> {
    const actorId = resolveActorId(ctx);
    if (!this.deps.store) return { ok: false, error: "本地订单表未启用" };
    let order: StoredShoppingOrder | null = orderId.startsWith("so_")
      ? await this.deps.store.get(orderId)
      : null;
    if (!order) {
      // 平台单号：遍历该 actor 全部订单匹配
      const all = await this.deps.store.listByActor(actorId, { limit: 100 });
      order = all.find((o) => o.platformOrderId === orderId.trim()) ?? null;
    }
    if (!order || order.actorId !== actorId) {
      return { ok: false, error: `本地订单 ${orderId} 不存在（可用 shopping.order.list 查询本地订单）` };
    }

    // 1) 支付宝收银台支付状态
    let alipayPaid: boolean | null = null;
    let alipayDetail: string | undefined;
    if (order.paymentUrl && this.isAlipayCashierUrl(order.paymentUrl) && this.deps.alipayBot) {
      try {
        const res = await this.deps.alipayBot.queryPaymentStatus({ launchUrl: order.paymentUrl });
        const text = `${res.stdout} ${res.json ? JSON.stringify(res.json) : ""}`;
        if (/已支付|支付成功|TRADE_SUCCESS|paid/i.test(text)) alipayPaid = true;
        else if (/未支付|等待|PENDING|WAIT/i.test(text)) alipayPaid = false;
        alipayDetail = res.stdout.slice(0, 300);
      } catch (err) {
        alipayDetail = `钱包查询失败：${err instanceof Error ? err.message : String(err)}`;
      }
    }

    // 2) 平台侧实时状态（浏览器刷新；失败不阻塞）
    let platformRefreshed: OrderStatus[] | undefined;
    if (order.platformOrderId) {
      const trackRes = await this.trackOrder(ctx, order.platform, order.platformOrderId);
      if (trackRes.ok) {
        platformRefreshed = (trackRes as { orders?: OrderStatus[] }).orders;
      }
    }

    // 3) 状态判定 + 回写
    let finalStatus: StoredShoppingOrder["status"] = order.status;
    if (alipayPaid === true) finalStatus = "paid";
    else if (platformRefreshed && platformRefreshed.length > 0) {
      const matched = platformRefreshed.find((o) => o.orderId === order!.platformOrderId) ?? platformRefreshed[0];
      const mapped = mapPlatformStatusText(matched?.status ?? matched?.statusDesc);
      if (mapped) finalStatus = mapped;
    }
    if (finalStatus !== order.status) {
      await this.deps.store.update(order.orderId, { status: finalStatus });
    }

    await this.audit(ctx, "pay_check", order.platform, { localOrderId: order.orderId, status: finalStatus });

    return {
      ok: true,
      summary: `订单「${order.title}」当前状态：${finalStatus}${alipayPaid === true ? "（支付宝已确认支付）" : ""}`,
      localOrderId: order.orderId,
      platform: order.platform,
      platformOrderId: order.platformOrderId,
      status: finalStatus,
      amountCny: order.amountCny,
      paymentUrl: order.paymentUrl,
      alipayDetail,
      platformOrders: platformRefreshed,
    };
  }

  // ============ 内部工具 ============

  private requireAdapter(platform: string): ShoppingPlatformAdapter | null {
    return getShoppingPlatformAdapter(platform);
  }

  /**
   * 该用户在这个平台有没有已授权的登录 Cookie（2026-11-06）。
   * 卡内下单链路用它决定「直接去结算」还是「先卡内扫码」——下单必须登录，
   * 商品页匿名能看与否无关紧要，所以判 Cookie 而不是开页检测。
   */
  async hasLoginCookies(ctx: ToolContext, platform: string): Promise<boolean> {
    const r = await this.getCookieAndSiteId(resolveActorId(ctx), platform);
    return r.ok && r.cookies.length > 0;
  }

  private async getCookieAndSiteId(
    actorId: string,
    platform: string,
  ): Promise<
    | { ok: true; cookies: ImportedBrowserCookie[]; siteId: BrowserSessionSiteId }
    | { ok: false; error: string; retryable?: boolean }
  > {
    // platform 与 siteId 同名（taobao/jd/meituan/tmall/...）
    const siteId = platform as BrowserSessionSiteId;
    try {
      const cookies = await this.deps.browserSessionService.getCookiesForAgent(actorId, siteId);
      if (cookies.length === 0) {
        return {
          ok: false,
          error:
            `未导入 ${platform} 的 Cookie。可在客户端内置浏览器登录后重试（无需 Cookie）；` +
            `或导入并授权 Cookie：POST /integrations/browser-sessions/import + POST /consent（agentAllowed=true）`,
        };
      }
      return { ok: true, cookies, siteId };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return {
        ok: false,
        error: message.includes("未授权") || message.includes("agentAllowed")
          ? message
          : `获取 ${platform} Cookie 失败：${message}`,
      };
    }
  }

  /**
   * 手动导入 Cookie · 第一步：解析 + 软校验（2026-11-21）。
   *
   * 扫码授权被平台风控拦死（拼多多只把登录态发给「看起来像真人」的浏览器，
   * 无头 context 永远拿不到 Cookie），登录入口改为「用户在自己浏览器导出
   * Cookie → 粘贴导入」。这里只解析文本并检查是否含登录标记，**不落库**——
   * 保存与否由用户在「是否保存」卡上表态后走 {@link applyCookieImport}。
   */
  prepareCookieImport(
    platform: string,
    cookieText: string,
  ):
    | { ok: true; cookies: ImportedBrowserCookie[]; markerFound: boolean; markerNames: string[] }
    | { ok: false; error: string } {
    const parsed = parseCookieHeaderText(cookieText);
    if (!parsed.ok) return parsed;
    const markerNames = getLoginCookieMarkerNames(platform);
    const found = parsed.cookies.filter((c) => markerNames.includes(c.name));
    return {
      ok: true,
      cookies: parsed.cookies,
      markerFound: markerNames.length === 0 || found.length > 0,
      markerNames: found.map((c) => c.name),
    };
  }

  /**
   * 手动导入 Cookie · 第二步：应用（用户对「是否保存」表态后调用）。
   *
   * save=true → `importCookies(agentAllowed:true)` 落库：AES 加密持久化、
   *   立即授权 Agent，之后每轮比价 `getCookiesForAgent` 自动取用，免扫码。
   * save=false → 不落库，直接灌进常驻浏览器 context：本轮比价与登录检测
   *   立刻可见，进程重启即失效。
   */
  async applyCookieImport(
    actorId: string,
    platform: string,
    cookies: ImportedBrowserCookie[],
    save: boolean,
  ): Promise<{ ok: true; saved: boolean } | { ok: false; error: string }> {
    if (!isBrowserSessionSiteId(platform)) {
      return { ok: false, error: `不支持的平台：${platform}` };
    }
    const siteId: BrowserSessionSiteId = platform;
    if (save) {
      try {
        await this.deps.browserSessionService.importCookies(actorId, siteId, cookies, {
          agentAllowed: true,
        });
        return { ok: true, saved: true };
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return { ok: false, error: `保存 Cookie 失败：${message}` };
      }
    }
    const homeUrl = BROWSER_SESSION_SITES[siteId].homeUrl;
    const primed = await this.browserExecutor
      .primeContextCookies(actorId, siteId, homeUrl, cookies)
      .catch(() => false);
    if (!primed) {
      return { ok: false, error: "云端浏览器暂时不可用，稍后再试，或选择「保存并永久使用」" };
    }
    return { ok: true, saved: false };
  }

  /**
   * 统一保存闸 · 读（2026-11-21 用户定稿）。
   *
   * 「是否保存登录 Cookie」不再是每次导入 / 每次登录各问一遍，而是一个统一
   * 闸：allow = 已同意（所有平台登录态默认保存，不再问）；deny = 已拒绝
   * （不保存也不再问）；ask = 未表态（弹统一授权卡，问这一次）。
   * 读的是 browserSessionService 的 captureConsents——与扫码登录
   * {@link checkMultiPlatformLogin}/{@link checkLoginHandoff} 用的是**同一把闸**，
   * 导入路和扫码路不会各问各的。
   */
  async getCookieSaveConsent(
    actorId: string,
    platform: string,
  ): Promise<"allow" | "deny" | "ask"> {
    return this.deps.browserSessionService.getCaptureConsent(actorId, platform);
  }

  /**
   * 统一保存闸 · 落笔：写全局授权键（{@link CAPTURE_CONSENT_ALL_SITES}），
   * 一次答复对所有平台生效（单平台的显式答复仍优先）。持久化在 actor 的
   * browser-sessions JSON 里，进程重启不丢。
   */
  async recordCookieSaveConsent(actorId: string, allowed: boolean): Promise<void> {
    await this.deps.browserSessionService.setCaptureConsent(
      actorId,
      CAPTURE_CONSENT_ALL_SITES,
      allowed,
    );
  }

  private async audit(
    ctx: ToolContext,
    action: string,
    platform: string,
    extra: Record<string, unknown>,
  ): Promise<void> {
    if (!this.deps.audit) return;
    try {
      await this.deps.audit.record({
        ts: new Date().toISOString(),
        category: "shopping_order",
        action,
        platform,
        actorId: resolveActorId(ctx),
        sessionId: ctx.sessionId,
        chatUserMessageId: ctx.chatUserMessageId,
        ...extra,
      });
    } catch {
      /* 审计失败不影响主流程 */
    }
  }

  private cleanupExpired(): void {
    const now = Date.now();
    for (const [token, pending] of this.pendingConfirmations.entries()) {
      if (now > pending.expiresAt) {
        if (pending.session && !pending.session.closed) {
          pending.session.close().catch(() => {});
        }
        this.pendingConfirmations.delete(token);
      }
    }
    // 扫码登录会话同样要清（2026-11-06 补）：过期不关会把无头浏览器实例
    // 和页面一直占着；fire-and-forget，不阻塞定时器。
    for (const [token, pending] of this.pendingLogins.entries()) {
      if (now > pending.expiresAt) {
        this.pendingLogins.delete(token);
        if (!pending.closed) {
          pending.closed = true;
          pending.lease.release().catch(() => {});
        }
      }
    }
  }
}
