/**
 * 浏览器报价源：无头浏览器代查商家站点 → 解析页面文本 → 报价。
 *
 * 站点差异用配置隔离：
 *   - buildUrl：QuoteRequest → 查询页 URL
 *   - parseText：页面正文文本 → TravelQuote[]
 *
 * 诚实边界：解析出的价格标 priceSource=scraped，note 必须说明「页面代查，以平台实价为准」；
 * 解析失败/无数据返回空 quotes，绝不编造。需要登录态的站点由 agent_browser 注入
 * 用户已授权 Cookie（白名单站点），未登录时多数站点仍可展示公开报价。
 *
 * 站点适配器（携程/飞猪/12306…）在 bootstrap 注册，本文件保持通用。
 */

import type { ToolContext } from "../../../tools/tool-registry.js";
import type {
  QuoteRequest,
  QuoteSource,
  QuoteSourceResult,
  QuoteType,
  TravelQuote,
} from "./quote-source.js";

/** AgentBrowserService 最小依赖面（open/extractText/close）。 */
export interface BrowserResultLike {
  ok: boolean;
  sessionId?: unknown;
  text?: unknown;
  error?: unknown;
}

export interface BrowserRunner {
  open(
    ctx: ToolContext,
    url: string,
    opts?: { waitUntil?: "load" | "domcontentloaded" | "networkidle"; timeout?: number },
  ): Promise<BrowserResultLike>;
  extractText(ctx: ToolContext, sessionId: string, selector?: string): Promise<BrowserResultLike>;
  close(ctx: ToolContext, sessionId: string): Promise<unknown>;
}

export interface BrowserQuoteSourceConfig {
  /** 源标识（建议 `browser.<site>`） */
  id: string;
  label: string;
  supports(type: QuoteType): boolean;
  /** QuoteRequest → 查询页 URL；返回 null = 本源跳过 */
  buildUrl(req: QuoteRequest): string | null;
  /** 页面正文 → 报价数组（解析失败返回 []） */
  parseText(text: string, req: QuoteRequest): TravelQuote[];
  /** 打开后额外等待毫秒（给 SPA 渲染时间，默认 1500） */
  settleMs?: number;
}

function sleep(ms: number): Promise<void> {
  // 不 unref：本定时器永远被 await，必须持有事件循环直到兑现——
  // unref 会让「sleep 是唯一挂起工作时」事件循环提前排空，await 永远悬空
  // （Node 22 测试环境确定性复现：进程收摊、用例被取消）。
  return new Promise((r) => {
    setTimeout(r, ms);
  });
}

export class BrowserQuoteSource implements QuoteSource {
  readonly id: string;
  readonly label: string;

  constructor(
    private readonly browser: BrowserRunner,
    private readonly config: BrowserQuoteSourceConfig,
  ) {
    this.id = config.id;
    this.label = config.label;
  }

  supports(type: QuoteType): boolean {
    return this.config.supports(type);
  }

  async fetch(req: QuoteRequest, ctx: ToolContext): Promise<QuoteSourceResult> {
    const url = this.config.buildUrl(req);
    if (!url) return { ok: true, quotes: [], note: `${this.label} 不处理该查询` };

    const opened = await this.browser.open(ctx, url, { waitUntil: "domcontentloaded" });
    const sessionId = typeof opened.sessionId === "string" ? opened.sessionId : "";
    if (!opened.ok || !sessionId) {
      return { ok: false, error: `${this.label} 打开失败：${typeof opened.error === "string" ? opened.error : "未知"}` };
    }
    try {
      await sleep(this.config.settleMs ?? 1_500);
      const extracted = await this.browser.extractText(ctx, sessionId);
      const text = typeof extracted.text === "string" ? extracted.text : "";
      if (!extracted.ok || !text) {
        return { ok: false, error: `${this.label} 取文本失败：${typeof extracted.error === "string" ? extracted.error : "空页面"}` };
      }
      const quotes = this.config
        .parseText(text, req)
        .map((q) => ({
          ...q,
          priceSource: "scraped" as const,
          note: q.note ?? `${this.label} 页面代查，以平台实价为准`,
        }));
      return {
        ok: true,
        quotes,
        note: quotes.length > 0 ? undefined : `${this.label} 未解析到报价（页面结构变化或需登录）`,
      };
    } finally {
      await this.browser.close(ctx, sessionId).catch(() => {});
    }
  }
}
