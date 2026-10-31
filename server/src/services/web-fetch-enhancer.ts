/**
 * 增强型网页抓取模块
 *
 * 三级 fallback 策略，按优先级：
 *   1. @mozilla/readability：本地 npm 包，基于 Firefox 阅读模式内核，从已抓取 HTML
 *      智能提取正文，无网络开销，token 消耗低（默认主提取器）
 *   2. 原生正则 htmlToText（由调用方提供）：兜底
 *   3. Jina Reader（r.jina.ai）：可选，需代理或海外环境，env JINA_READER_ENABLED=1 启用
 *
 * 设计目标：
 *   - 速度：Readability 纯本地解析，~50ms，比 playwright 快 100 倍以上
 *   - token：返回干净纯文本，无导航/广告/脚本噪声，比正则解析降低 30-50%
 *   - 容错：任一环节失败自动降级，保证可用性
 *
 * 注意：Jina Reader 默认禁用，因为国内网络无法直达 r.jina.ai。
 *       如在海外环境部署，设置 env JINA_READER_ENABLED=1 可启用。
 */

import iconv from "iconv-lite";

// PDF 解析：动态 import 避免非 PDF 场景的额外开销
async function getPdfParser(): Promise<typeof import("pdf-parse") | null> {
  try {
    return await import("pdf-parse");
  } catch {
    return null;
  }
}

export type EnhancedFetchOptions = {
  userAgent: string;
  /** 单次请求超时，默认 8000ms */
  timeoutMs?: number;
  /** 是否启用 Jina Reader，默认 false（国内不可达），env JINA_READER_ENABLED=1 可启用 */
  enableJina?: boolean;
  /** 是否启用 Readability，默认 true */
  enableReadability?: boolean;
};

export type EnhancedFetchResult = {
  text: string;
  title: string;
  /** 实际使用的提取器：jina | readability | raw */
  extractor: "jina" | "readability" | "raw";
  /** 原始 HTML（仅 readability/raw 路径有，jina 路径为空） */
  html: string;
  durationMs: number;
};

const JINA_READER_BASE = "https://r.jina.ai";
const DEFAULT_TIMEOUT_MS = 8_000;

/**
 * 抓取并提取网页正文。
 * 调用方可传入 fallbackHtmlExtractor 用于第二级兜底（通常是现有 htmlToText）。
 */
export async function fetchWebPageEnhanced(
  url: string,
  options: EnhancedFetchOptions,
  fallbackHtmlExtractor?: (html: string) => string,
): Promise<EnhancedFetchResult> {
  const start = Date.now();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // Jina Reader 默认禁用（国内不可达），仅在显式启用或 env JINA_READER_ENABLED=1 时启用
  const enableJina = options.enableJina ?? (process.env.JINA_READER_ENABLED === "1");
  const enableReadability = options.enableReadability ?? true;

  // 抓取原始 HTML（Jina Reader 启用时先尝试 Jina，否则直接抓 HTML）
  if (enableJina) {
    try {
      const jina = await fetchViaJinaReader(url, options.userAgent, timeoutMs);
      if (jina.text && jina.text.trim().length >= 200) {
        return {
          text: jina.text,
          title: jina.title,
          extractor: "jina",
          html: "",
          durationMs: Date.now() - start,
        };
      }
    } catch {
      // 降级到 HTML 抓取
    }
  }

  // 抓取原始响应（HTML 或 PDF）
  let html = "";
  let contentType = "";
  let buffer: ArrayBuffer | null = null;
  try {
    const raw = await fetchRawResponse(url, options.userAgent, timeoutMs);
    html = raw.text;
    contentType = raw.contentType;
    buffer = raw.buffer;
  } catch {
    // 抓取失败，返回空
    return {
      text: "",
      title: "",
      extractor: "raw",
      html: "",
      durationMs: Date.now() - start,
    };
  }

  // PDF 检测：Content-Type 或 URL 后缀判断
  const isPdf =
    /application\/pdf/i.test(contentType) ||
    /\.pdf(\?|$)/i.test(url) ||
    (buffer && buffer.byteLength >= 4 && new Uint8Array(buffer.slice(0, 4)).join(",") === "37,80,68,70"); // %PDF
  if (isPdf && buffer) {
    try {
      const pdfText = await parsePdf(buffer);
      if (pdfText && pdfText.trim().length >= 50) {
        return {
          text: pdfText,
          title: extractTitleFromUrl(url),
          extractor: "readability", // 复用 readability 标记表示"已智能提取"
          html: "",
          durationMs: Date.now() - start,
        };
      }
    } catch {
      // PDF 解析失败，降级
    }
  }

  // 第 1 级：Readability（主提取器）
  if (enableReadability) {
    try {
      const readability = await extractWithReadability(html, url);
      // 阈值 100：Readability 对非文章页可能返回空或极短内容，此时降级到正则
      if (readability.text && readability.text.trim().length >= 100) {
        return {
          text: readability.text,
          title: readability.title,
          extractor: "readability",
          html,
          durationMs: Date.now() - start,
        };
      }
    } catch {
      // 降级到正则
    }
  }

  // 第 2 级：正则兜底
  const text = fallbackHtmlExtractor ? fallbackHtmlExtractor(html) : html;
  const title = extractTitleFromHtml(html);
  return {
    text,
    title,
    extractor: "raw",
    html,
    durationMs: Date.now() - start,
  };
}

/**
 * Jina Reader：通过 https://r.jina.ai/{url} 获取 LLM 友好的 markdown 内容。
 * 免费、无需 API key（可设置 JINA_API_KEY 提升配额）。
 */
async function fetchViaJinaReader(
  url: string,
  userAgent: string,
  timeoutMs: number,
): Promise<{ text: string; title: string }> {
  const jinaUrl = `${JINA_READER_BASE}/${url}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers: Record<string, string> = {
      "user-agent": userAgent,
      accept: "text/plain, text/markdown, application/json;q=0.9",
      "x-respond-with": "markdown",
    };
    // 可选：通过 API key 提升配额
    const apiKey = process.env.JINA_API_KEY;
    if (apiKey) {
      headers.authorization = `Bearer ${apiKey}`;
    }

    const response = await fetch(jinaUrl, {
      signal: controller.signal,
      headers,
      redirect: "follow",
    });
    if (!response.ok) {
      throw new Error(`Jina Reader 返回 ${response.status}`);
    }

    const contentType = response.headers.get("content-type") ?? "";
    // Jina Reader 默认返回 markdown 文本，可能带 Title: 前缀
    const body = await response.text();

    // 解析标题：Jina Reader 通常在正文开头返回 "Title: xxx\n\nURL: ..."
    let title = "";
    const titleMatch = body.match(/^Title:\s*(.+?)\s*$/m);
    if (titleMatch) {
      title = titleMatch[1].trim();
    }

    // 移除 Jina Reader 的元数据前缀行（Title:/URL:/Markdown Content:）
    const text = body
      .replace(/^Title:\s*.+\s*$/m, "")
      .replace(/^URL:\s*.+\s*$/m, "")
      .replace(/^Markdown Content:\s*\n*/m, "")
      .replace(/^Extracted Content:\s*\n*/m, "")
      .trim();

    return { text, title };
  } finally {
    clearTimeout(timer);
  }
}

/** 抓取原始响应（返回文本 + ArrayBuffer + Content-Type，用于 HTML/PDF 分流） */
async function fetchRawResponse(
  url: string,
  userAgent: string,
  timeoutMs: number,
): Promise<{ text: string; contentType: string; buffer: ArrayBuffer }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "user-agent": userAgent,
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,application/pdf;q=0.9,*/*;q=0.8",
        "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
      },
      redirect: "follow",
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const contentType = response.headers.get("content-type") ?? "";
    const arrayBuffer = await response.arrayBuffer();
    // 编码检测：国内网站常用 GBK/GB2312，需正确解码否则乱码
    const text = decodeWithEncoding(arrayBuffer, contentType);
    return { text, contentType, buffer: arrayBuffer };
  } finally {
    clearTimeout(timer);
  }
}

/** 根据 Content-Type 和 meta 标签检测编码并正确解码（导出供其他模块复用） */
export function decodeWithEncoding(buffer: ArrayBuffer, contentType: string): string {
  // 1. 先用 UTF-8 试解码前 2KB，用于读取 meta charset
  const headBytes = new Uint8Array(buffer.slice(0, 2048));
  const headUtf8 = new TextDecoder("utf-8", { fatal: false }).decode(headBytes);

  // 2. 检测编码优先级：Content-Type > meta charset > meta content > 默认 UTF-8
  let encoding = "";

  // Content-Type 中的 charset
  const ctMatch = contentType.match(/charset=([^\s;]+)/i);
  if (ctMatch) encoding = ctMatch[1];

  // <meta charset="xxx">
  if (!encoding) {
    const metaCharset = headUtf8.match(/<meta[^>]+charset=["']?([a-zA-Z0-9_-]+)/i);
    if (metaCharset) encoding = metaCharset[1];
  }

  // <meta http-equiv="Content-Type" content="text/html; charset=xxx">
  if (!encoding) {
    const metaHttpEquiv = headUtf8.match(/<meta[^>]+http-equiv=["']?content-type["']?[^>]+content=["']?[^"'>]*charset=([a-zA-Z0-9_-]+)/i);
    if (metaHttpEquiv) encoding = metaHttpEquiv[1];
  }

  encoding = (encoding || "utf-8").toLowerCase();

  // GBK 系列（gbk/gb2312/gb18030）需要用 iconv-lite
  if (encoding.includes("gb") || encoding === "gb2312" || encoding === "gb18030" || encoding === "gbk") {
    return iconv.decode(Buffer.from(buffer), "gbk");
  }

  // UTF-8 或其他：用 TextDecoder
  try {
    return new TextDecoder(encoding, { fatal: false }).decode(buffer);
  } catch {
    return new TextDecoder("utf-8", { fatal: false }).decode(buffer);
  }
}

/** 使用 pdf-parse 解析 PDF */
async function parsePdf(buffer: ArrayBuffer): Promise<string> {
  const pdfParse = await getPdfParser();
  if (!pdfParse) return "";
  // pdf-parse 期望 Buffer 输入
  const data = await pdfParse.default(Buffer.from(buffer));
  return (data.text ?? "").trim();
}

/** 从 URL 推断标题（用于 PDF 等无 title 标签的资源） */
function extractTitleFromUrl(url: string): string {
  try {
    const u = new URL(url);
    const last = u.pathname.split("/").pop() ?? "";
    return decodeURIComponent(last.replace(/\.pdf$/i, "").replace(/[-_]/g, " ")).trim() || u.hostname;
  } catch {
    return url;
  }
}

/** 使用 @mozilla/readability 提取正文（导出，便于离线场景测试和复用） */
export async function extractWithReadability(
  html: string,
  url: string,
): Promise<{ text: string; title: string }> {
  // jsdom（~11MB）与 readability 只在真正做正文提取时加载
  const [{ JSDOM }, { Readability }] = await Promise.all([
    import("jsdom"),
    import("@mozilla/readability"),
  ]);
  const dom = new JSDOM(html, { url });
  const reader = new Readability(dom.window.document);
  const article = reader.parse();
  if (!article) {
    return { text: "", title: "" };
  }
  // article.textContent 是纯文本；article.content 是 HTML
  // 用 textContent 减少 token 消耗
  const text = (article.textContent ?? "").trim();
  return {
    text,
    title: article.title ?? "",
  };
}

function extractTitleFromHtml(html: string): string {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!m) return "";
  return m[1]
    .replace(/\s+/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}
