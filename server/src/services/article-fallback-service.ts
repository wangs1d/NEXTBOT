/**
 * article-fallback-service.ts — 「搜索引擎只返回文章链接」时的兜底抽取
 *
 * 背景（2026-10-14）：以人物/主题为查询词时，搜索引擎返回的是文章页而非图片直链，
 * 且正文搜索往往只给 snippet。本模块把文章页拉下来后做两件事：
 *   1) 从 HTML 抠出真实图片地址（多属性 + 懒加载 + 查询参数内嵌 + 正文容器收敛）
 *   2) 抽取并清洗正文，产出结构化字段（标题/发布时间/作者/段落）
 *
 * 设计约束（对齐服务端既有契约）：
 *   - 无全局状态；HTTP 与时钟均注入（禁 Date.now()/无参 new Date()，用 now()）
 *   - 超时以 deadlineAt（epoch ms）表达，由调用方按自身预算下发
 *   - 本模块只负责「解析 + 抓取文本」，不碰图片存储（存储走既有 materialize 链路）
 *
 * 接入点（尚未接线，需先定两件事：时钟来源、开关默认值）：
 *   - 图片侧：`UpstreamSearchService.searchImages()` —— 在「search-api 图片源」与
 *     「cn.bing.com 图片页兜底」都拿不到图时，走本模块：
 *       searchWeb(keyword) 取文章 URL → harvestImageCandidates(urls, { deadlineAt })
 *       → 把候选 URL 交给既有 materializeImageResults 转存（不要另起下载链路）
 *     预算：仅在已失败分支追加，deadline 建议直接复用 IMAGE_FETCH_TIMEOUT_MS(5s)。
 *     注意：该类当前没有注入时钟（只有 infoHubService），需先按铁律补 now: () => Date。
 *   - 信息侧：`InfoHubService.readWebpage()` 返回值补上 publishedAt/paragraphs
 *     （标题防模板污染、GBK 解码、正文容器收敛都在本模块内已实现）。
 *
 * 实战踩过的坑（已内置，勿删）：
 *   1) 网易 nimg.ws.126.net/?url=...jpg&thumbnail=660x... 无路径后缀 → 去 thumbnail 才是原图
 *   2) 腾讯 inews.gtimg.com/news_bt/<id>/641 无后缀 → 末尾数字是宽度，换 /0 取原图
 *   3) 新浪图集真图藏在 iframe src="...?p=http://n.sinaimg.cn/...jpg"，只扫 <img> 会 0 命中
 *   4) 论坛(discuz) 原图在 zoomfile= 而非 src（src 只是缩略图）
 *   5) WordPress -300x207 之类是缩略图变体，需归一化去重
 *   6) 站点多为 GBK/Big5，必须按 charset 解码，否则标题正文全乱码
 *   7) 抽图必须先收敛到正文容器，否则推荐流/侧栏配图大量混入
 *   8) 论坛站会返回「JS 跳回自身」的一次性挑战页，需借 cookie 二次请求
 */

/** 与 global fetch 响应同形的最小接口（便于测试替换） */
export interface FetchResponseLike {
  status: number;
  url: string;
  headers: { get(name: string): string | null };
  arrayBuffer(): Promise<ArrayBuffer>;
}

export type FetchLike = (
  url: string,
  init: { headers: Record<string, string>; redirect: "follow"; signal?: AbortSignal },
) => Promise<FetchResponseLike>;

export interface ArticleFallbackOptions {
  /** 站点级 Referer（默认用文章自身 URL，防盗链站点需要） */
  referer?: string;
  /** 截止时间（epoch ms）。调用方按自身超时预算下发；到点即停止后续网络动作 */
  deadlineAt?: number;
  /** 单次请求超时，默认 8s */
  timeoutMs?: number;
  /** 单篇最多返回多少张候选图，默认 40 */
  maxImages?: number;
}

export interface ExtractedArticle {
  url: string;
  site: string;
  title: string | null;
  summary: string | null;
  publishedAt: string | null;
  author: string | null;
  paragraphs: string[];
  text: string;
}

export interface ImageCandidate {
  url: string;
  /** 归一化去重键（去掉尺寸变体/处理参数后的实体标识） */
  key: string;
  /** 越大越可能是正文原图 */
  weight: number;
}

const DEFAULT_USER_AGENT =
  process.env.WEB_FETCH_USER_AGENT ??
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

/** 明显不是正文配图：图标/头像/二维码/表情/广告/分享/占位图/埋点像素 */
const BAD_IMAGE =
  /(logo|avatar|qrcode|qr_|icon|iconfont|sprite|smile|emot|face\/|placeholder|loading|blank\.|spacer|watermark|share|weixin|weibo|btn_|button|_ad|advert|\/ad[s_]\d|\/deco\/|\/f2e\/|common_nav|favicon|dianzan|default_|noimage|none\.gif|online_admin|star_level|grade\/|theme\/images|assets\/images|\/static\/images|beacon|noScript|\/a\.gif|tracking|pixel|analytics)/i;
const BAD_IMAGE_BASENAME = /^(bg|background|mob|mobile|logo|logotype|icon|menu|arrow|close|tab_?|btn|spacer|blank|loading|placeholder|vote|top|header|footer|nav)/i;

/**
 * 「像图」判定：扩展名命中，或来自已知图床/CDN 的无后缀图链。
 *
 * 这条闸是「放宽抽取」的配套——抽取端要能接纳网易 `?url=…jpg`、腾讯 `/<id>/641`
 * 这类**没有路径后缀**的图链，否则全被误杀；但同样放宽就会让 `<a href="page.html#x">`
 * 这种普通链接混进来。用「扩展名 OR 已知图床」把后者挡掉，
 * 真正的质量闸门（content-type + 真实分辨率）仍留在下载端。
 */
const IMAGE_EXT_RE = /\.(jpe?g|png|webp|gif|bmp|avif)(?:[?#]|$)/i;
const IMAGE_CDN_RE =
  /(nimg\.ws\.126\.net|dingyue\.ws\.126\.net|gtimg\.com|sinaimg\.cn|toutiaoimg\.com|byteimg\.com|hdslb\.com|zhimg\.com|qpic\.cn|\/uploads?\/|[?&]url=https?%3A|[?&]image_process=|[?&]type=(?:jpg|jpeg|png|webp))/i;

/** 站点模板噪声行：导航/分享/免责/推荐/责任编辑/附件清单 之类 */
const BOILER_LINE =
  /(扫码|二维码|分享至|分享到|点击关注|关注我们|关注「|责任编辑|免责声明|免责|版权归|未经(授权|允许)|禁止转载|原标题|本文来源|阅读此文之前|麻烦您点击|微信公众号|微信扫一扫|下载客户端|客户端下载|热门推荐|相关推荐|猜你喜欢|推荐阅读|延伸阅读|上一篇|下一篇|返回顶部|广告|通讯员|举报|长按识别|声明[:：]|下载次数|附件|小黑屋|ICP备|我的收藏|查看所有收藏|版权所有|站点统计|All Rights Reserved|编辑[:：]|评论\s*\d)/;
/** 附件清单行 / 表格碎片 / 纯图名行 */
const NOISE_LINE = /(\.(jpe?g|png|webp|gif|bmp)\s*\([^)]*(KB|MB|下载次数)|^\s*\||^\s*[\w-]{20,}\.(jpe?g|png)\s*$)/i;
const CJK = /[\u4e00-\u9fa5]/;

/** 图片魔数 → 尺寸；用于「真实分辨率」判定（content-type 之外的第二道闸门） */
export function probeImageSize(buf: Buffer): { width: number; height: number; ext: string } | null {
  if (buf.length < 24) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), ext: "png" };
  }
  if (buf[0] === 0x47 && buf[1] === 0x49) {
    return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8), ext: "gif" };
  }
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let o = 2;
    while (o < buf.length - 9) {
      if (buf[o] !== 0xff) { o += 1; continue; }
      const marker = buf[o + 1];
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: buf.readUInt16BE(o + 5), width: buf.readUInt16BE(o + 7), ext: "jpg" };
      }
      o += 2 + buf.readUInt16BE(o + 2);
    }
    return { width: 0, height: 0, ext: "jpg" };
  }
  if (buf.subarray(0, 4).toString("ascii") === "RIFF" && buf.subarray(8, 12).toString("ascii") === "WEBP") {
    return { width: 0, height: 0, ext: "webp" };
  }
  return null;
}

/** 按 charset 解码（坑 6：新浪等为 GBK/Big5，UTF-8 硬解会乱码） */
export function decodeHtmlBuffer(buf: Buffer, contentType?: string | null): string {
  const fromHeader = /charset=([\w-]+)/i.exec(contentType ?? "")?.[1];
  const head = buf.subarray(0, 4096).toString("latin1");
  const fromMeta = /charset\s*=\s*["']?([\w-]+)/i.exec(head)?.[1];
  const cs = (fromMeta ?? fromHeader ?? "utf-8").toLowerCase();
  const enc = /gb2312|gbk|gb18030/.test(cs) ? "gb18030" : /big5/.test(cs) ? "big5" : "utf-8";
  try {
    return new TextDecoder(enc).decode(buf);
  } catch {
    return buf.toString("utf8");
  }
}

/**
 * 图片地址归一化（坑 1/2/5）：把「缩略图/带处理参数」还原成原图，并给出跨站变体的去重键。
 */
export function normalizeImageUrl(raw: string, baseUrl: string): { url: string; key: string; isThumb: boolean } | null {
  if (typeof raw !== "string" || !raw) return null;
  const cleaned = raw.trim().replace(/^["']|["']$/g, "").replace(/&amp;/g, "&");
  if (!cleaned || /^(data:|javascript:|about:)/i.test(cleaned)) return null;
  let parsed: URL;
  try {
    parsed = new URL(cleaned, baseUrl);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(parsed.protocol)) return null;
  // 锚点链接（如图集站的 `page.html#{src0}`）不是图片地址
  if (parsed.hash) return null;
  const url = parsed.href;
  // 「扩展名 OR 已知图床」——见 IMAGE_EXT_RE 注释
  if (!IMAGE_EXT_RE.test(url) && !IMAGE_CDN_RE.test(url)) return null;

  // 坑 1：网易 —— ?url=<原图>&thumbnail=660x... ，去掉 thumbnail 才是原图
  if (/nimg\.ws\.126\.net|dingyue\.ws\.126\.net/.test(parsed.hostname)) {
    parsed.searchParams.delete("thumbnail");
    return { url: parsed.href, key: parsed.searchParams.get("url") ?? parsed.href, isThumb: false };
  }
  // 坑 2：腾讯 —— news_bt/<id>/641，末尾数字为宽度，换 /0 取原图
  const gtimg = /^(https?:\/\/[\w.-]*gtimg\.com\/(?:news_bt|om_ls)\/[^/]+)\/\d+(\?.*)?$/.exec(url);
  if (gtimg) return { url: `${gtimg[1]}/0`, key: gtimg[1], isThumb: false };
  // 新浪：k.sinaimg.cn/...jpg/w160h120hdp.jpg 是尺寸变体；n/k 用 upload 之后路径归一
  if (/sinaimg\.cn/.test(parsed.hostname)) {
    const clean = url.replace(/\.(jpe?g|png|gif|webp)\/[^/]*\.(?:jpe?g|png|gif|webp)$/i, ".$1");
    const k = /\/upload\/(.+)$/.exec(clean)?.[1] ?? clean;
    return { url: clean, key: `sina:${k}`, isThumb: false };
  }
  // 阿里 OSS 等：image_process= 为处理参数，去掉才能拿原图且不触发防盗链
  if (/[?&]image_process=/.test(url)) {
    parsed.searchParams.delete("image_process");
    return { url: parsed.href, key: parsed.href, isThumb: false };
  }
  // 坑 5：WordPress 缩略图变体 -300x207
  const wpThumb = /^(.*?)-(\d{2,4})x(\d{2,4})(\.(?:jpe?g|png|webp|gif))(\?.*)?$/i.exec(url);
  const key = wpThumb ? `${wpThumb[1]}${wpThumb[4]}` : url;
  return { url, key, isThumb: Boolean(wpThumb) };
}

/** 深度计数找配对闭标签（比正则可靠）：用于把 HTML 收敛到正文容器 */
function matchTagEnd(html: string, tagName: string, from: number): number {
  const re = new RegExp(`<${tagName}\\b|</${tagName}>`, "gi");
  re.lastIndex = from;
  let depth = 1;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    if (m[0][1] === "/") {
      depth -= 1;
      if (depth === 0) return m.index + m[0].length;
    } else {
      depth += 1;
    }
  }
  return html.length;
}

/** 坑 7：把全页 HTML 收敛到正文容器，避免推荐流/侧栏配图混入 */
export function sliceMainContainer(html: string): string {
  const patterns: RegExp[] = [
    /<div[^>]+class=["'][^"']*post_body[^"']*["'][^>]*>/i,
    /<div[^>]+class=["'][^"']*(?:article-content|article_content|post-content|entry-content|tt-article-content|syl-article-base|artical-content|post_text|rich_media_content)[^"']*["'][^>]*>/i,
    /<article\b[^>]*>/i,
    /<div[^>]+id=["'][^"']*(?:content|article|detail|post)[^"']*["'][^>]*>/i,
  ];
  for (const pattern of patterns) {
    const m = pattern.exec(html);
    if (!m) continue;
    const tag = /^<article\b/i.test(m[0]) ? "article" : "div";
    const slice = html.slice(m.index, matchTagEnd(html, tag, m.index + m[0].length));
    // 阈值别定太高：短页面/图集页的正文容器本身就可能只有一两百字符，
    // 门槛过高会整体跳过容器、退回全页（推荐流配图就混进来了）。
    if (slice.length >= 120) return slice;
  }
  return html;
}

function collectFromHtml(html: string, baseUrl: string, maxImages: number): ImageCandidate[] {
  const found = new Map<string, ImageCandidate>();
  const push = (raw: string | undefined, weight: number): void => {
    const n = normalizeImageUrl(raw ?? "", baseUrl);
    if (!n) return;
    if (BAD_IMAGE.test(n.url) || BAD_IMAGE_BASENAME.test(n.url.split("/").pop() ?? "")) return;
    const w = weight - (n.isThumb ? 4 : 0);
    const prev = found.get(n.key);
    if (!prev || w > prev.weight) found.set(n.key, { url: n.url, key: n.key, weight: w });
  };

  for (const m of html.matchAll(/<img\b[^>]*>/gi)) {
    const tag = m[0];
    const attr = (name: string): string | undefined =>
      new RegExp(`${name}\\s*=\\s*["']([^"']+)["']`, "i").exec(tag)?.[1];
    push(attr("zoomfile"), 12); // 坑 4：discuz 原图
    push(attr("file"), 10);
    push(attr("data-original"), 11);
    push(attr("data-src"), 10);
    push(attr("data-lazy-src"), 10);
    push(attr("data-echo"), 10);
    const width = Number(attr("width") ?? 0);
    push(attr("src"), width && width < 300 ? 2 : 8);
    for (const part of (attr("srcset") ?? "").split(",")) push(part.trim().split(/\s+/)[0], 7);
  }
  for (const m of html.matchAll(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>/gi)) push(m[1], 6);
  for (const m of html.matchAll(/background(?:-image)?\s*:\s*url\(\s*["']?([^"')]+)["']?\s*\)/gi)) push(m[1], 5);
  // 兜底全页扫：连 raw HTML / JS 数组里的直链也收（抽取端放宽，分辨率才是真闸门）
  for (const m of html.matchAll(/https?:\/\/[^\s"'<>()\\]+?\.(?:jpe?g|png|webp|gif|bmp)(?:\/[^\s"'<>()\\]*)?/gi)) push(m[0], 7);
  // 坑 3：新浪图集真图在查询参数里（iframe src="...?p=http://n.sinaimg.cn/...jpg"）
  for (const m of html.matchAll(/[?&](?:p|pic|url|src|img|image)=(https?%3A%2F%2F[^&"'\s]+)/gi)) {
    try {
      push(decodeURIComponent(m[1]), 7);
    } catch {
      /* 非法编码忽略 */
    }
  }
  return [...found.values()].sort((a, b) => b.weight - a.weight).slice(0, maxImages);
}

/** 抽出候选图片：先只在正文容器里找；容器太窄(<4)才回退全页 */
export function extractImageCandidates(html: string, baseUrl: string, maxImages = 40): ImageCandidate[] {
  const sliced = sliceMainContainer(html);
  if (sliced !== html) {
    const inMain = collectFromHtml(sliced, baseUrl, maxImages);
    if (inMain.length >= 4) return inMain;
  }
  return collectFromHtml(html, baseUrl, maxImages);
}

function cleanLines(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter((l) => l.length >= 12)
    .filter((l) => !BOILER_LINE.test(l))
    .filter((l) => !NOISE_LINE.test(l))
    .filter((l) => CJK.test(l) || /[a-zA-Z]{3}/.test(l));
}

function normalizeForCompare(s: string): string {
  return s.replace(/[\s\p{P}]/gu, "");
}

function charNgrams(s: string, n = 4): Set<string> {
  const set = new Set<string>();
  for (let i = 0; i + n <= s.length; i += 1) set.add(s.slice(i, i + n));
  return set;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const g of a) if (b.has(g)) inter += 1;
  return inter / (a.size + b.size - inter);
}

/** 句级近重复剔除（跨段/跨源同一句话常被反复复述） */
export function dedupeLines(lines: string[], threshold = 0.62): string[] {
  const kept: string[] = [];
  const grams: Set<string>[] = [];
  for (const line of lines) {
    const n = normalizeForCompare(line);
    if (n.length < 8) continue;
    const g = charNgrams(n, 4);
    if (grams.some((k) => jaccard(k, g) >= threshold)) continue;
    kept.push(line);
    grams.push(g);
  }
  return kept;
}

/** 正文抽取：标题（防模板污染）+ 发布时间 + 作者 + 清洗后的段落 */
export function extractArticleFromHtml(html: string, url: string): ExtractedArticle {
  const ogTitle = (/_?<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i.exec(html)?.[1] ?? "")
    .replace(/\s+/g, " ").trim();
  const h1 = (String(/<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html)?.[1] ?? ""))
    .replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  const rawTitle = (ogTitle || h1 || html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "").replace(/\s+/g, " ").trim();
  // 论坛/门户的 og:title 常是站点口号（如「传播网-传播网门户网站…」），降级到 <h1>
  const looksBoiler = !rawTitle || rawTitle.length > 60 || /(门户网站|传播网|www\.|- 今日头条$|_[^_]{0,10}新闻$)/.test(rawTitle);
  const title = looksBoiler && h1 && h1.length <= 60 ? h1 : rawTitle;

  const summary = /<meta[^>]+(?:property|name)=["'](?:og:description|description)["'][^>]+content=["']([^"']+)["']/i.exec(html)?.[1]?.trim() ?? null;

  const dateRaw =
    /"(?:datePublished|publishTime|published_time|pubDate|createTime)"\s*:\s*"([^"]+)"/i.exec(html)?.[1] ??
    /<meta[^>]+(?:property|name)=["'](?:article:published_time|og:release_date|pubdate|publishdate|date)["'][^>]+content=["']([^"']+)["']/i.exec(html)?.[1] ??
    /<time[^>]+datetime=["']([^"']+)["']/i.exec(html)?.[1] ??
    null;
  let publishedAt: string | null = null;
  const dateText = dateRaw ?? html.slice(0, 20000).match(/(20\d{2})\D{0,2}(\d{1,2})\D{0,2}(\d{1,2})/)?.slice(0, 4).slice(1).join("-") ?? null;
  if (dateText) {
    const m = /(20\d{2})\D{0,2}(\d{1,2})\D{0,2}(\d{1,2})/.exec(dateText);
    if (m) publishedAt = `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  }
  const author =
    /<meta[^>]+name=["']author["'][^>]+content=["']([^"']+)["']/i.exec(html)?.[1] ??
    /"author"\s*:\s*\{[^}]*"name"\s*:\s*"([^"]+)"/i.exec(html)?.[1] ??
    null;

  let body = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(nav|aside|footer|header|form|iframe|noscript)\b[\s\S]*?<\/\1>/gi, " ");
  const main =
    /<article[\s\S]*?<\/article>/i.exec(body)?.[0] ??
    /<div[^>]+(?:id|class)=["'][^"']*(?:post_body|article-content|article_content|post-content|entry-content|syl-article-base|artical-content|post_text|rich_media_content)[^"']*["'][^>]*>[\s\S]{200,}/i.exec(body)?.[0] ??
    body;

  const rawLines = (main.match(/<p[^>]*>[\s\S]*?<\/p>/gi) ?? [main])
    .join("\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#\d+;|&[a-z]+;/g, " ");
  const paragraphs = dedupeLines(cleanLines(rawLines));
  return {
    url,
    site: safeOrigin(url),
    title: title || null,
    summary,
    publishedAt,
    author: author ? author.trim() : null,
    paragraphs,
    text: paragraphs.join("\n\n"),
  };
}

function safeOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}

/**
 * 文章页兜底开关：**默认开启**（2026-10-14 用户定调）。
 * 设 ARTICLE_IMAGE_FALLBACK=0/false/off/no 可即时关闭，无需改码。
 */
export function isArticleImageFallbackEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = String(env.ARTICLE_IMAGE_FALLBACK ?? "").trim().toLowerCase();
  return !(v === "0" || v === "false" || v === "off" || v === "no");
}

/** readWebpage 返回正文的长度上限（沿用改造前的 1 万字约定） */
const MAX_READ_CHARS = 10_000;

export interface ArticleReadResult {
  /** 结构化抽到的标题；抽不到时为 null，由调用方兜底 */
  title: string | null;
  content: string;
  /** 仅在「采用了清洗后正文」时给出 */
  paragraphs?: string[];
  publishedAt?: string;
  author?: string;
}

/**
 * 把「原始 HTML + 通用正文文本」合成为阅读结果（信息侧兜底）。
 *
 * 通用正文文本（htmlToText 之类）作为**兜底**保留：只有当结构化抽取确实拿到了成规模的
 * 正文时才采用它。否则遇到「非 <p> 排版」的页面（表格/描述列表/自定义容器）反而会把
 * 正文掏空——这类回归很隐蔽，所以留一道长度比例安全阀（≥200 字 且 ≥兜底文本的 25%）。
 */
export function composeArticleRead(html: string, url: string, fallbackText: string): ArticleReadResult {
  const extracted = extractArticleFromHtml(html, url);
  const cleaned = extracted.paragraphs.join("\n\n");
  const base = String(fallbackText ?? "");
  const useCleaned = cleaned.length >= 200 && cleaned.length >= base.length * 0.25;
  return {
    title: extracted.title,
    // 与改造前 readWebpage 的 1 万字上限保持一致：清洗后的正文不能悄悄放大注入预算
    content: useCleaned ? cleaned.slice(0, MAX_READ_CHARS) : base,
    ...(useCleaned ? { paragraphs: extracted.paragraphs } : {}),
    ...(extracted.publishedAt ? { publishedAt: extracted.publishedAt } : {}),
    ...(extracted.author ? { author: extracted.author } : {}),
  };
}

interface RawPage {
  status: number;
  finalUrl: string;
  html: string;
}

/**
 * 抓页面：处理坑 8（discuz 返回「JS 跳回自身」的一次性挑战页，需带 cookie 二次请求）。
 */
async function fetchPage(
  url: string,
  deps: { fetchImpl: FetchLike; userAgent: string; timeoutMs: number },
  referer?: string,
): Promise<RawPage | null> {
  const jar = new Map<string, string>();
  const cookieHeader = (): string | undefined =>
    jar.size ? [...jar].map(([k, v]) => `${k}=${v}`).join("; ") : undefined;
  const doFetch = async (target: string, ref?: string): Promise<RawPage | null> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), deps.timeoutMs);
    try {
      const headers: Record<string, string> = {
        "user-agent": deps.userAgent,
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
      };
      if (ref) headers.referer = ref;
      const cookie = cookieHeader();
      if (cookie) headers.cookie = cookie;
      const response = await deps.fetchImpl(target, { headers, redirect: "follow", signal: controller.signal });
      for (const setCookie of response.headers.get("set-cookie")?.split(/,(?=[^;]+=)/) ?? []) {
        const kv = setCookie.split(";")[0];
        const i = kv.indexOf("=");
        if (i > 0) jar.set(kv.slice(0, i).trim(), kv.slice(i + 1).trim());
      }
      const buf = Buffer.from(await response.arrayBuffer());
      return { status: response.status, finalUrl: response.url || target, html: decodeHtmlBuffer(buf, response.headers.get("content-type")) };
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  };

  const first = await doFetch(url, referer);
  if (!first) return null;
  // 挑战页特征：空壳 HTML + window.location.href 跳回自身
  if (/window\.location\.href\s*=/.test(first.html) && first.html.length < 5000) {
    const m = /window\.location\.href\s*=\s*["']([^"']+)["']/.exec(first.html);
    let next = url;
    try {
      next = new URL(m?.[1] ?? url, url).href;
    } catch {
      next = url;
    }
    return (await doFetch(next, url)) ?? first;
  }
  return first;
}

/**
 * 文章页兜底抽取服务。
 *
 * 只做「抓取 + 解析」：图片交给调用方走既有转存/materalize 链路，
 * 正文交给调用方决定如何注入证据或落库。
 */
export class ArticleFallbackService {
  private readonly fetchImpl: FetchLike;
  private readonly userAgent: string;
  private readonly now: () => Date;

  constructor(deps?: { fetchImpl?: FetchLike; userAgent?: string; now?: () => Date }) {
    this.fetchImpl = deps?.fetchImpl ?? ((url, init) => fetch(url, init) as unknown as Promise<FetchResponseLike>);
    this.userAgent = deps?.userAgent ?? DEFAULT_USER_AGENT;
    this.now = deps?.now ?? (() => new Date());
  }

  private expired(deadlineAt?: number): boolean {
    return typeof deadlineAt === "number" && this.now().getTime() >= deadlineAt;
  }

  /** 抓取并抽取单篇文章 */
  async readArticle(url: string, options: ArticleFallbackOptions = {}): Promise<ExtractedArticle | null> {
    if (this.expired(options.deadlineAt)) return null;
    const page = await fetchPage(
      url,
      { fetchImpl: this.fetchImpl, userAgent: this.userAgent, timeoutMs: options.timeoutMs ?? 8000 },
      options.referer,
    );
    if (!page || page.status !== 200) return null;
    return extractArticleFromHtml(page.html, page.finalUrl || url);
  }

  /** 抓取文章并返回候选图片地址（不做下载/存储，交给调用方的转存链路） */
  async collectImageCandidates(
    url: string,
    options: ArticleFallbackOptions = {},
  ): Promise<{ article: ExtractedArticle; candidates: ImageCandidate[] } | null> {
    if (this.expired(options.deadlineAt)) return null;
    const page = await fetchPage(
      url,
      { fetchImpl: this.fetchImpl, userAgent: this.userAgent, timeoutMs: options.timeoutMs ?? 8000 },
      options.referer,
    );
    if (!page || page.status !== 200) return null;
    const article = extractArticleFromHtml(page.html, page.finalUrl || url);
    const candidates = extractImageCandidates(page.html, page.finalUrl || url, options.maxImages ?? 40);
    return { article, candidates };
  }

  /**
   * 从一批文章页里harvest图片候选（跨源按归一化键去重）。
   * 并发受 maxConcurrency 限制；deadlineAt 到点即停止后续抓取。
   */
  async harvestImageCandidates(
    articleUrls: string[],
    options: ArticleFallbackOptions & { maxConcurrency?: number } = {},
  ): Promise<Array<ImageCandidate & { articleUrl: string }>> {
    const maxConcurrency = Math.max(1, options.maxConcurrency ?? 3);
    const merged = new Map<string, ImageCandidate & { articleUrl: string }>();
    const queue = [...new Set(articleUrls)];
    const workers = Array.from({ length: Math.min(maxConcurrency, queue.length) }, async () => {
      for (;;) {
        if (this.expired(options.deadlineAt)) return;
        const next = queue.shift();
        if (!next) return;
        const result = await this.collectImageCandidates(next, options);
        if (!result) continue;
        for (const c of result.candidates) {
          const existing = merged.get(c.key);
          if (!existing || c.weight > existing.weight) merged.set(c.key, { ...c, articleUrl: next });
        }
      }
    });
    await Promise.all(workers);
    return [...merged.values()].sort((a, b) => b.weight - a.weight);
  }
}
