/**
 * Agent 专用虚拟浏览器服务（有状态会话池）。
 *
 * 在服务端后台启动 Playwright 无头浏览器，维持有状态会话（sessionId → Page），
 * 支持 open / click / type / scroll / screenshot / extract_text / wait_for / close
 * 八个原子操作，让 Agent 能在浏览器中完成多步操作流程。
 *
 * 安全护栏（不依赖 agentAccessMode，沙箱下也可用）：
 *   1. 任意 https URL 允许 open（http 仅限 localhost），所有操作走审计日志
 *   2. 对 browser-session-sites 白名单内站点，自动注入用户已授权的 Cookie
 *   3. 会话绑定 actorId，跨用户隔离；sessionId 不可预测（randomUUID）
 *   4. 会话 TTL（默认 10 分钟）+ LRU 上限（默认 8 个），超时/超量自动清理
 *   5. Playwright 动态加载，未安装时优雅降级并返回明确错误
 */
import { randomUUID } from "crypto";

import type { Browser, BrowserContext, Page } from "playwright";

import { resolveActorId } from "../agent/actor-id.js";
import type { AuditService } from "./audit-service.js";
import type { BrowserSessionService } from "./browser-session-service.js";
import { resolveSiteIdFromUrl } from "./browser-session-sites.js";
import type { ImportedBrowserCookie } from "./browser-session-types.js";
import { detectLoginPage } from "./shopping-platforms/login-gate.js";
import type { QrAssistService } from "./qr-assist-service.js";
import type { ToolContext } from "../tools/tool-registry.js";

// ─── 环境变量 ──────────────────────────────────────────────────────────────

/** 会话空闲 TTL（毫秒），默认 10 分钟。 */
function getSessionTtlMs(): number {
  const v = Number.parseInt(process.env.AGENT_BROWSER_SESSION_TTL_MS ?? "600000", 10);
  return Number.isFinite(v) && v > 0 ? v : 600_000;
}

/** 最大并发会话数，默认 8。 */
function getMaxSessions(): number {
  const v = Number.parseInt(process.env.AGENT_BROWSER_MAX_SESSIONS ?? "8", 10);
  return Number.isFinite(v) && v > 0 ? v : 8;
}

/** 页面导航超时（毫秒），默认 30 秒。 */
function getNavTimeoutMs(): number {
  const v = Number.parseInt(process.env.AGENT_BROWSER_NAV_TIMEOUT_MS ?? "30000", 10);
  return Number.isFinite(v) && v > 0 ? v : 30_000;
}

/** 单次操作（click/type 等）超时（毫秒），默认 15 秒。 */
function getActionTimeoutMs(): number {
  const v = Number.parseInt(process.env.AGENT_BROWSER_ACTION_TIMEOUT_MS ?? "15000", 10);
  return Number.isFinite(v) && v > 0 ? v : 15_000;
}

// ─── 常量 ──────────────────────────────────────────────────────────────────

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

const DEFAULT_VIEWPORT = { width: 1280, height: 720 } as const;

/** extract_text 返回的文本截断上限（字符）。 */
const TEXT_BUDGET = 4000;

/** extract_text 附带的 ariaSnapshot 紧凑元素行数上限（每行 ~10 token）。 */
const INTERACTIVE_BUDGET = 300;

/** screenshot base64 截断上限（字符），避免 tool loop token 膨胀。 */
const SCREENSHOT_BASE64_BUDGET = 2000;

// ─── 类型 ──────────────────────────────────────────────────────────────────

/** 服务返回的通用结构。 */
export type AgentBrowserResult =
  | ({ ok: true } & Record<string, unknown>)
  | { ok: false; error: string; retryable?: boolean };

/** 存活的浏览器会话。 */
interface AgentBrowserSession {
  sessionId: string;
  actorId: string;
  browser: Browser;
  context: BrowserContext;
  page: Page;
  currentUrl: string;
  createdAt: number;
  lastActivityAt: number;
  closed: boolean;
}

// ─── Playwright 动态加载 ───────────────────────────────────────────────────

async function loadPlaywright(): Promise<typeof import("playwright") | null> {
  try {
    return await import("playwright");
  } catch {
    return null;
  }
}

// ─── Cookie 转换（参照 browser-page-fetch.ts / shopping-order-service.ts）───

function toPlaywrightCookies(
  pageUrl: string,
  cookies: ImportedBrowserCookie[],
): Array<{
  name: string;
  value: string;
  domain: string;
  path: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "Strict" | "Lax" | "None";
}> {
  let defaultHost = "";
  try {
    defaultHost = new URL(pageUrl).hostname;
  } catch {
    /* ignore */
  }
  return cookies.map((c) => {
    const domain = (c.domain ?? defaultHost).replace(/^\./, "");
    return {
      name: c.name,
      value: c.value,
      domain: domain.startsWith(".") ? domain : `.${domain}`,
      path: c.path ?? "/",
      expires: c.expires,
      httpOnly: c.httpOnly,
      secure: c.secure,
      sameSite: normalizeSameSite(c.sameSite),
    };
  });
}

function normalizeSameSite(raw?: string): "Strict" | "Lax" | "None" | undefined {
  if (!raw) return undefined;
  const s = raw.toLowerCase();
  if (s === "strict") return "Strict";
  if (s === "lax") return "Lax";
  if (s === "none") return "None";
  return undefined;
}

// ─── URL 安全校验 ──────────────────────────────────────────────────────────

/**
 * 校验 URL 是否允许打开。
 * - https 任意 URL 允许
 * - http 仅允许 localhost / 127.0.0.1 / 0.0.0.0（本地开发场景）
 */
function isUrlAllowed(rawUrl: string): { ok: boolean; error?: string } {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { ok: false, error: `URL 格式无效: ${rawUrl}` };
  }
  if (parsed.protocol === "https:") return { ok: true };
  if (parsed.protocol === "http:") {
    const host = parsed.hostname.toLowerCase();
    if (host === "localhost" || host === "127.0.0.1" || host === "0.0.0.0" || host === "::1") {
      return { ok: true };
    }
    return { ok: false, error: "http URL 仅允许 localhost；外部站点须使用 https" };
  }
  return { ok: false, error: `不支持的协议: ${parsed.protocol}（仅 http/https）` };
}

// ─── 服务主体 ──────────────────────────────────────────────────────────────

/**
 * Agent 虚拟浏览器服务。
 *
 * 维持有状态会话池，每个会话绑定一个 actorId，跨用户隔离。
 * 会话 TTL + LRU 上限自动清理，避免资源泄漏。
 */
export class AgentBrowserService {
  private readonly sessions = new Map<string, AgentBrowserSession>();
  private cleanupTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly deps: {
      browserSessionService: BrowserSessionService;
      audit?: AuditService;
      /** 通用二维码推送：打开站点撞登录页时自动推二维码到聊天（best-effort）。 */
      qrAssist?: QrAssistService;
    },
  ) {
    this.cleanupTimer = setInterval(() => this.cleanupExpired(), 60_000);
    this.cleanupTimer.unref?.();
  }

  /** 主动销毁：关闭所有存活会话。 */
  async dispose(): Promise<void> {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    for (const session of this.sessions.values()) {
      await this.closeSession(session).catch(() => {});
    }
    this.sessions.clear();
  }

  // ─── 8 个原子操作 ────────────────────────────────────────────────────────

  /** 打开 URL，返回 sessionId。 */
  async open(
    ctx: ToolContext,
    url: string,
    opts?: {
      viewport?: { width: number; height: number };
      waitUntil?: "load" | "domcontentloaded" | "networkidle";
      timeout?: number;
    },
  ): Promise<AgentBrowserResult> {
    const actorId = resolveActorId(ctx);
    const trimmedUrl = String(url ?? "").trim();
    if (!trimmedUrl) return { ok: false, error: "缺少 url" };

    const urlCheck = isUrlAllowed(trimmedUrl);
    if (!urlCheck.ok) return { ok: false, error: urlCheck.error! };

    const pw = await loadPlaywright();
    if (!pw) {
      return {
        ok: false,
        error: "Playwright 未安装。请在 server 目录执行: npm install playwright && npx playwright install chromium",
        retryable: false,
      };
    }

    const { chromium } = pw;
    const browser = await chromium.launch({
      headless: true,
      args: ["--disable-blink-features=AutomationControlled"],
    });

    try {
      const viewport = opts?.viewport ?? DEFAULT_VIEWPORT;
      const context = await browser.newContext({
        userAgent: USER_AGENT,
        locale: "zh-CN",
        viewport: { width: viewport.width, height: viewport.height },
      });

      // 对白名单站点，尝试注入用户已授权的 Cookie
      const siteId = resolveSiteIdFromUrl(trimmedUrl);
      let cookieInjected = false;
      if (siteId) {
        try {
          const cookies = await this.deps.browserSessionService.getCookiesForAgent(actorId, siteId);
          if (cookies && cookies.length > 0) {
            await context.addCookies(toPlaywrightCookies(trimmedUrl, cookies));
            cookieInjected = true;
          }
        } catch {
          // 未授权 / 未导入 Cookie —— 以未登录状态访问，不报错
        }
      }

      const page = await context.newPage();
      page.setDefaultTimeout(getActionTimeoutMs());
      const timeout = opts?.timeout ?? getNavTimeoutMs();
      const waitUntil = opts?.waitUntil ?? "domcontentloaded";

      await page.goto(trimmedUrl, { waitUntil, timeout });

      const sessionId = randomUUID();
      const now = Date.now();
      const session: AgentBrowserSession = {
        sessionId,
        actorId,
        browser,
        context,
        page,
        currentUrl: page.url(),
        createdAt: now,
        lastActivityAt: now,
        closed: false,
      };

      // LRU 上限保护：超量时关闭最老会话
      this.enforceMaxSessions();

      this.sessions.set(sessionId, session);

      // 新标签页跟随：购物/商品链接普遍 target=_blank 开新 tab，
      // 下单等多步任务必须让会话操作跟随进入新 tab（session.page 切到最新活动页）。
      context.on("page", (popup) => {
        popup.setDefaultTimeout(getActionTimeoutMs());
        session.page = popup;
        session.currentUrl = popup.url();
      });

      const title = await page.title().catch(() => "");

      // 通用「需要扫码自动推」：白名单站点撞登录页时，登录二维码自动推到聊天
      // （不阻塞会话——Agent 可继续描述页面或等用户扫码后重试）
      let loginQrImageUrl: string | undefined;
      if (siteId && this.deps.qrAssist) {
        const login = await detectLoginPage(siteId, page).catch(() => ({ isLogin: false }));
        if (login.isLogin) {
          loginQrImageUrl =
            (await this.deps.qrAssist
              .pushPageCard(
                ctx,
                {
                  title: "打开网页需要登录",
                  caption: "登录页二维码已推给你，扫码后让我重新打开即可带上登录态",
                },
                page,
              )
              .catch(() => undefined)) ?? undefined;
        }
      }

      await this.audit(ctx, "open", sessionId, {
        url: trimmedUrl,
        siteId: siteId ?? undefined,
        cookieInjected,
        title,
        loginQrPushed: Boolean(loginQrImageUrl),
      });

      return {
        ok: true,
        sessionId,
        url: page.url(),
        title,
        cookieInjected,
        siteId: siteId ?? undefined,
        ...(loginQrImageUrl ? { loginQrImageUrl } : {}),
        hint: loginQrImageUrl
          ? "该站点需要登录，已把登录二维码推送到聊天；用户扫码后重新执行操作即可。"
          : cookieInjected
            ? undefined
            : siteId
              ? `检测到 ${siteId} 站点但用户未导入/授权 Cookie，以未登录状态访问。如需登录态操作，引导用户在设置中导入 Cookie 并开启 agentAllowed。`
              : undefined,
      };
    } catch (e) {
      await browser.close().catch(() => {});
      const message = e instanceof Error ? e.message : String(e);
      return {
        ok: false,
        error: message.includes("Executable doesn't exist")
          ? `${message} — 请执行: npx playwright install chromium`
          : message,
        retryable: true,
      };
    }
  }

  /** 点击元素。 */
  async click(
    ctx: ToolContext,
    sessionId: string,
    selector: string,
    opts?: { timeout?: number; button?: "left" | "right"; doubleClick?: boolean },
  ): Promise<AgentBrowserResult> {
    const session = this.getSessionForActor(ctx, sessionId);
    if (!session) return { ok: false, error: "会话不存在或已过期" };

    const sel = String(selector ?? "").trim();
    if (!sel) return { ok: false, error: "缺少 selector" };

    try {
      const timeout = opts?.timeout ?? getActionTimeoutMs();
      await session.page.click(sel, {
        timeout,
        button: opts?.button ?? "left",
        clickCount: opts?.doubleClick ? 2 : 1,
      });
      this.touch(session);
      await this.audit(ctx, "click", sessionId, { selector: sel, url: session.currentUrl });
      return { ok: true, url: session.page.url(), selector: sel };
    } catch (e) {
      return { ok: false, error: this.formatPlaywrightError(e), retryable: true };
    }
  }

  /** 在输入框中输入文本。 */
  async type(
    ctx: ToolContext,
    sessionId: string,
    selector: string,
    text: string,
    opts?: { append?: boolean; delay?: number; clear?: boolean },
  ): Promise<AgentBrowserResult> {
    const session = this.getSessionForActor(ctx, sessionId);
    if (!session) return { ok: false, error: "会话不存在或已过期" };

    const sel = String(selector ?? "").trim();
    if (!sel) return { ok: false, error: "缺少 selector" };
    const value = String(text ?? "");
    if (value.length === 0) return { ok: false, error: "缺少 text" };

    try {
      const append = opts?.append ?? false;
      const locator = session.page.locator(sel);
      if (!append) {
        // fill 模式：替换整个输入框内容
        await locator.fill(value, { timeout: getActionTimeoutMs() });
      } else {
        // 追加模式：可选先清空，再逐字符输入
        if (opts?.clear) {
          await locator.fill("", { timeout: getActionTimeoutMs() });
        }
        await locator.pressSequentially(value, {
          delay: opts?.delay ?? 0,
          timeout: getActionTimeoutMs(),
        });
      }
      this.touch(session);
      await this.audit(ctx, "type", sessionId, {
        selector: sel,
        textLength: value.length,
        append,
      });
      return { ok: true, selector: sel, textLength: value.length };
    } catch (e) {
      return { ok: false, error: this.formatPlaywrightError(e), retryable: true };
    }
  }

  /** 滚动页面。 */
  async scroll(
    ctx: ToolContext,
    sessionId: string,
    opts?: { x?: number; y?: number; deltaY?: number; selector?: string },
  ): Promise<AgentBrowserResult> {
    const session = this.getSessionForActor(ctx, sessionId);
    if (!session) return { ok: false, error: "会话不存在或已过期" };

    try {
      if (opts?.selector) {
        // 滚动到指定元素
        await session.page.locator(opts.selector).scrollIntoViewIfNeeded({
          timeout: getActionTimeoutMs(),
        });
      } else if (typeof opts?.deltaY === "number") {
        // 相对滚动
        await session.page.mouse.wheel(0, opts.deltaY);
      } else {
        // 滚动到绝对坐标
        const x = opts?.x ?? 0;
        const y = opts?.y ?? 0;
        await session.page.evaluate(([sx, sy]) => window.scrollTo(sx, sy), [x, y] as const);
      }
      this.touch(session);
      await this.audit(ctx, "scroll", sessionId, {
        mode: opts?.selector ? "to_element" : typeof opts?.deltaY === "number" ? "delta" : "absolute",
        url: session.currentUrl,
      });
      return { ok: true, url: session.page.url() };
    } catch (e) {
      return { ok: false, error: this.formatPlaywrightError(e), retryable: true };
    }
  }

  /** 截图，返回 base64（JPEG 压缩）。 */
  async screenshot(
    ctx: ToolContext,
    sessionId: string,
    opts?: { fullPage?: boolean; selector?: string; quality?: number },
  ): Promise<AgentBrowserResult> {
    const session = this.getSessionForActor(ctx, sessionId);
    if (!session) return { ok: false, error: "会话不存在或已过期" };

    try {
      const quality = Math.min(Math.max(opts?.quality ?? 70, 20), 90);
      const buffer = opts?.selector
        ? await session.page.locator(opts.selector).screenshot({
            type: "jpeg",
            quality,
            timeout: getActionTimeoutMs(),
          })
        : await session.page.screenshot({
            type: "jpeg",
            quality,
            fullPage: opts?.fullPage ?? false,
            timeout: getActionTimeoutMs(),
          });

      this.touch(session);
      const base64 = buffer.toString("base64");
      // 截断 base64 避免工具回路 token 膨胀；完整截图可通过 vision 能力或后续文件路由获取
      const truncated = base64.length > SCREENSHOT_BASE64_BUDGET
        ? base64.slice(0, SCREENSHOT_BASE64_BUDGET) + "...[truncated]"
        : base64;

      await this.audit(ctx, "screenshot", sessionId, {
        fullPage: opts?.fullPage ?? false,
        hasSelector: Boolean(opts?.selector),
        bytes: buffer.length,
      });

      return {
        ok: true,
        imageBase64: truncated,
        truncated: base64.length > SCREENSHOT_BASE64_BUDGET,
        fullSizeBytes: buffer.length,
        format: "jpeg",
        url: session.page.url(),
        hint: base64.length > SCREENSHOT_BASE64_BUDGET
          ? "截图较大已截断，完整视觉信息建议用 extract_text 获取页面结构。"
          : undefined,
      };
    } catch (e) {
      return { ok: false, error: this.formatPlaywrightError(e), retryable: true };
    }
  }

  /**
   * ariaSnapshot(mode=ai) YAML → 紧凑可交互元素行（Node 侧解析，无 evaluate 闭包陷阱）。
   *
   * 输入（Playwright mode:"ai"）：
   *   - navigation [ref=e2]:
   *     - link "链接一" [ref=e3] [cursor=pointer]:
   *       - /url: /1
   *   - button "领券购买" [ref=e5]
   *
   * 输出（每行 ~10 token，供 LLM 直接阅读并把 ref 传给 click/type）：
   *   e2 navigation
   *   e3 link "链接一"
   *   e5 button "领券购买"
   *
   * 仅保留可交互角色 + heading（页面语义文本已由正文 text 覆盖）；
   * 丢弃 /url 子行与 cursor 标记；行数上限 INTERACTIVE_BUDGET。
   */
  private compactAriaSnapshot(snapshot: string): string {
    const KEEP_ROLES = new Set([
      "button", "link", "textbox", "searchbox", "checkbox", "radio", "combobox",
      "menuitem", "menuitemcheckbox", "menuitemradio", "tab", "option", "slider",
      "switch", "img", "heading", "listbox", "treeitem", "spinbutton",
    ]);
    const DROP_MARKS = new Set(["cursor=pointer", "cursor=grab", "cursor=grabbing"]);
    const lines: string[] = [];
    for (const raw of snapshot.split("\n")) {
      // 行格式：- role "可选名称" [标记1] [标记2]:（尾冒号表示有子节点）
      const m = raw.match(/^\s*-\s+([A-Za-z][\w]*)\s*(?:"((?:[^"\\]|\\.)*)")?\s*((?:\[[^\]]+\]\s*)*):?\s*$/);
      if (!m) continue;
      const role = m[1];
      if (!KEEP_ROLES.has(role)) continue;
      const marks = (m[3] ?? "").match(/\[([^\]]+)\]/g) ?? [];
      let ref = "";
      const stateMarks: string[] = [];
      for (const mark of marks) {
        const inner = mark.slice(1, -1).trim();
        if (inner.startsWith("ref=")) ref = inner.slice(4);
        else if (!DROP_MARKS.has(inner)) stateMarks.push(inner);
      }
      const name = m[2] ? ` "${m[2]}"` : "";
      const state = stateMarks.length ? ` [${stateMarks.join("] [")}]` : "";
      lines.push(ref ? `${ref} ${role}${name}${state}` : `${role}${name}${state}`);
      if (lines.length >= INTERACTIVE_BUDGET) break;
    }
    return lines.join("\n");
  }

  /** 提取页面文本，可附带可交互元素列表。 */
  async extractText(
    ctx: ToolContext,
    sessionId: string,
    selector?: string,
    opts?: { includeInteractive?: boolean },
  ): Promise<AgentBrowserResult> {
    const session = this.getSessionForActor(ctx, sessionId);
    if (!session) return { ok: false, error: "会话不存在或已过期" };

    try {
      const includeInteractive = opts?.includeInteractive ?? true;
      const text = selector
        ? await session.page.locator(selector).innerText({ timeout: getActionTimeoutMs() })
        : await session.page.evaluate(() => document.body?.innerText ?? "");

      const trimmed = text.replace(/\s+/g, " ").trim().slice(0, TEXT_BUDGET);

      let interactive: string | undefined;
      if (includeInteractive) {
        try {
          const snapshot = await session.page.locator("body").ariaSnapshot({ mode: "ai" });
          interactive = this.compactAriaSnapshot(snapshot);
        } catch (e) {
          console.error("[agent_browser] ariaSnapshot 失败:", e instanceof Error ? e.message.slice(0, 200) : e);
          interactive = undefined;
        }
      }

      this.touch(session);
      const interactiveCount = interactive ? interactive.split("\n").length : 0;
      await this.audit(ctx, "extract_text", sessionId, {
        hasSelector: Boolean(selector),
        textLength: trimmed.length,
        interactiveCount,
      });

      return {
        ok: true,
        url: session.page.url(),
        title: await session.page.title().catch(() => ""),
        text: trimmed,
        truncated: text.length > TEXT_BUDGET,
        interactive,
        interactiveCount,
      };
    } catch (e) {
      return { ok: false, error: this.formatPlaywrightError(e), retryable: true };
    }
  }

  /** 等待元素出现。 */
  async waitFor(
    ctx: ToolContext,
    sessionId: string,
    selector: string,
    timeout?: number,
  ): Promise<AgentBrowserResult> {
    const session = this.getSessionForActor(ctx, sessionId);
    if (!session) return { ok: false, error: "会话不存在或已过期" };

    const sel = String(selector ?? "").trim();
    if (!sel) return { ok: false, error: "缺少 selector" };

    try {
      const waitTimeout = Math.min(timeout ?? getActionTimeoutMs(), 60_000);
      await session.page.waitForSelector(sel, { state: "visible", timeout: waitTimeout });
      this.touch(session);
      await this.audit(ctx, "wait_for", sessionId, { selector: sel, timeout: waitTimeout });
      return { ok: true, selector: sel, url: session.page.url() };
    } catch (e) {
      return { ok: false, error: this.formatPlaywrightError(e), retryable: true };
    }
  }

  /** 关闭会话。 */
  async close(ctx: ToolContext, sessionId: string): Promise<AgentBrowserResult> {
    const session = this.getSessionForActor(ctx, sessionId);
    if (!session) return { ok: false, error: "会话不存在或已过期" };

    await this.audit(ctx, "close", sessionId, { url: session.currentUrl });
    await this.closeSession(session);
    this.sessions.delete(sessionId);
    return { ok: true, sessionId };
  }

  // ─── 内部方法 ────────────────────────────────────────────────────────────

  /** 获取会话并校验 actorId 归属。 */
  private getSessionForActor(ctx: ToolContext, sessionId: string): AgentBrowserSession | undefined {
    const actorId = resolveActorId(ctx);
    const session = this.sessions.get(sessionId);
    if (!session || session.closed) return undefined;
    if (session.actorId !== actorId) return undefined;
    return session;
  }

  /** 更新会话最后活动时间（LRU 排序：delete + set 移到末尾）。 */
  private touch(session: AgentBrowserSession): void {
    session.lastActivityAt = Date.now();
    session.currentUrl = session.page.url();
    this.sessions.delete(session.sessionId);
    this.sessions.set(session.sessionId, session);
  }

  /** LRU 上限保护：超量时关闭最老会话。 */
  private enforceMaxSessions(): void {
    const max = getMaxSessions();
    while (this.sessions.size >= max) {
      const oldest = this.sessions.keys().next().value;
      if (!oldest) break;
      const session = this.sessions.get(oldest);
      if (session) {
        this.closeSession(session).catch(() => {});
      }
      this.sessions.delete(oldest);
    }
  }

  /** 清理过期会话（TTL）。 */
  private async cleanupExpired(): Promise<void> {
    const ttl = getSessionTtlMs();
    const now = Date.now();
    const expired: string[] = [];
    for (const [id, session] of this.sessions) {
      if (now - session.lastActivityAt > ttl) {
        expired.push(id);
      }
    }
    for (const id of expired) {
      const session = this.sessions.get(id);
      if (session) {
        await this.closeSession(session).catch(() => {});
      }
      this.sessions.delete(id);
    }
  }

  /** 关闭单个会话的浏览器资源。 */
  private async closeSession(session: AgentBrowserSession): Promise<void> {
    if (session.closed) return;
    session.closed = true;
    try {
      await session.context.close();
    } catch {
      /* ignore */
    }
    try {
      await session.browser.close();
    } catch {
      /* ignore */
    }
  }

  /** 格式化 Playwright 错误信息。 */
  private formatPlaywrightError(e: unknown): string {
    const message = e instanceof Error ? e.message : String(e);
    if (message.includes("Executable doesn't exist")) {
      return `${message} — 请执行: npx playwright install chromium`;
    }
    if (message.includes("Timeout") && message.includes("exceeded")) {
      return `操作超时: ${message}`;
    }
    if (message.includes("selector resolved to") && message.includes("no matching element")) {
      return `未找到匹配元素: ${message}`;
    }
    return message;
  }

  /** 审计日志。 */
  private async audit(
    ctx: ToolContext,
    action: string,
    sessionId: string,
    extra: Record<string, unknown>,
  ): Promise<void> {
    if (!this.deps.audit) return;
    try {
      await this.deps.audit.record({
        category: "agent_browser",
        action,
        sessionId,
        actorId: resolveActorId(ctx),
        sessionId_ctx: ctx.sessionId,
        chatUserMessageId: ctx.chatUserMessageId,
        timestamp: Date.now(),
        ...extra,
      });
    } catch {
      /* 审计失败不影响主流程 */
    }
  }
}
