import type { Page } from "playwright";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import sharp from "sharp";

import type { ToolContext, ToolMediaCard } from "../tools/tool-registry.js";

/**
 * jsQR 是 CJS 包且 d.ts 的 `export default` 在 NodeNext 下互操作有坑
 * （default import 会绑定到整个模块命名空间而非函数），干脆用 createRequire
 * 显式加载——ESM/tsx 两种运行环境都稳定拿到函数本体。
 */
const requireCjs = createRequire(import.meta.url);
const jsQR = requireCjs("jsqr") as (
  data: Uint8ClampedArray,
  width: number,
  height: number,
  providedOptions?: { inversionAttempts?: "dontInvert" | "onlyInvert" | "attemptBoth" | "invertFirst" },
) => { data: string } | null;

/**
 * 通用二维码/图片推送服务（「需要扫码的环节自动推」）。
 *
 * 任何服务端流程（购物登录、支付收银台、钱包绑定、微信接入、agent_browser
 * 撞登录页……）只要手里有二维码——页面截图、dataURL、本地 PNG 文件或原始
 * Buffer——一行调用即可把图片卡实时推到聊天流（chat.media_ready 通道，
 * 客户端现成渲染）。图片统一落盘到 data/images/{actorId}/ 并走
 * /agent/images/ 静态路由，持久可回看。
 *
 * 全程 best-effort：无聊天流上下文（ctx.pushMediaCards 为空）、图片服务未
 * 装配或落盘失败都返回 null，绝不抛错影响主流程。
 */
export class QrAssistService {
  constructor(
    private readonly deps: {
      /** PNG 落盘 + /agent/images/ 相对路径返回；未注入时推卡不可用。 */
      imageStore?: {
        savePng(
          actorId: string,
          png: Buffer,
          sessionId?: string,
          opts?: { libraryHidden?: boolean },
        ): Promise<string>;
      };
    } = {},
  ) {}

  /**
   * 只截二维码 PNG buffer，**不落盘不推流**：供批量推码自行组卡用。
   *
   * 截「能扫的码」而不是页面顶部——登录页的二维码普遍在首屏折叠线以下，
   * 直接 page.screenshot() 截到的是 logo +「扫码登录」按钮（2026-11-06 真机取证）。
   */
  async captureQrPng(page: Page): Promise<Buffer | null> {
    try {
      return await captureQrFocused(page);
    } catch {
      return null;
    }
  }

  /**
   * 只截图落盘、**不推聊天流**：返回 imageUrl + 深链（购物登录卡「点码登录」）。
   *
   * 与 pushPageCard 的差别在出口——卡内扫码走 card.update，二维码是那张卡的
   * 一部分，再往聊天流里塞一张独立图片卡就会变成两条消息（正是要避免的）。
   *
   * 点码登录（2026-11-14）：顺手把码解码出内嵌 URL 并转成 App 深链，单家登录卡
   * 据此渲染「点码登录」按钮。解码失败 qrLink 为空——按钮不渲染，扫码兜底不变。
   */
  async savePageQrPng(
    ctx: ToolContext,
    page: Page,
    platform?: string,
  ): Promise<{ imageUrl: string; qrLink?: string; qrLinkFallback?: string } | null> {
    if (!this.deps.imageStore) return null;
    try {
      const png = await captureQrFocused(page);
      if (!png) return null;
      const imageUrl = await this.deps.imageStore.savePng(
        ctx.userId ?? ctx.sessionId,
        png,
        ctx.sessionId,
        { libraryHidden: true },
      );
      const link = await qrAppLink(png, platform ?? "");
      return { imageUrl, ...(link ?? {}) };
    } catch {
      return null;
    }
  }

  /** 推送页面截图（如登录页/收银台上的二维码），返回 imageUrl（失败 null）。 */
  async pushPageCard(
    ctx: ToolContext,
    meta: { title: string; caption?: string },
    page: Page,  ): Promise<string | null> {
    try {
      const png = await captureQrFocused(page);
      return await this.pushCard(ctx, meta, png);
    } catch {
      return null;
    }
  }

  /** 推送二维码图片（dataURL / 本地文件路径 / 原始 PNG Buffer 任一来源）。 */
  async pushQrImage(
    ctx: ToolContext,
    meta: { title: string; caption?: string },
    image: { dataUrl?: string; filePath?: string; png?: Buffer },
  ): Promise<string | null> {
    try {
      const png = await resolvePngBuffer(image);
      if (!png) return null;
      return await this.pushCard(ctx, meta, png);
    } catch {
      return null;
    }
  }

  /**
   * 批量二维码**只落盘、不推卡**（2026-11-13 P1：二维码失效重推）。
   *
   * 与 [pushBatchQrCards] 的差别：那个会把一张新卡推进聊天流（多一条消息），
   * 这个只把码落盘拿到地址，由调用方决定是「原地换卡」（card.update）还是
   * 「推一张新卡」。二维码过期后要重推时，必须走原地换卡——否则聊天里会
   * 堆着两张二维码卡，用户分不清哪张是新的。
   *
   * 点码登录：每张码顺手解码出 App 深链（qrLink），重推的卡上按钮照常可用。
   */
  async saveBatchQrPngs(
    ctx: ToolContext,
    items: Array<{ platform: string; label: string; png: Buffer | null }>,
  ): Promise<Array<{ platform: string; label: string; imageUrl: string; width?: number; height?: number; qrLink?: string; qrLinkFallback?: string }>> {
    const saved: Array<{ platform: string; label: string; imageUrl: string; width?: number; height?: number; qrLink?: string; qrLinkFallback?: string }> = [];
    if (!this.deps.imageStore) return saved;
    const actorId = ctx.userId ?? ctx.sessionId;
    for (const item of items) {
      if (!item.png) continue;
      try {
        const imageUrl = await this.deps.imageStore.savePng(actorId, item.png, ctx.sessionId, {
          libraryHidden: true,
        });
        const dims = pngDimensions(item.png);
        const link = await qrAppLink(item.png, item.platform);
        saved.push({
          platform: item.platform,
          label: item.label,
          imageUrl,
          ...(dims ? { width: dims.width, height: dims.height } : {}),
          ...(link ?? {}),
        });
      } catch {
        /* 单张失败不阻断其余 */
      }
    }
    return saved;
  }

  /**
   * 批量推送多张二维码（2026-11-13 P0-2）：一次把**所有**需要登录的平台
   * 的二维码推给用户，而不是撞墙一家推一家。
   *
   * 用户投诉：「说让我补京东的登录之后再补」——一次一张的预算让用户要扫三轮
   * 才能比完。对齐主流 agent（Grok Bot / Muse / ChatGPT Agent）：需要用户
   * 本人做的环节一次交齐，扫完直接续跑。
   *
   * 落地形态：**一张**多平台登录卡（卡内 N 个平台分区，每个分区一张码），
   * 不是 N 条消息——一次交互把该交的东西交完，用户扫任意一张即全部放行。
   * 返回各平台对应的 imageUrl（供服务端记账「哪家的码真的推出去了」）。
   *
   * 点码登录（2026-11-14）：每张码解码出内嵌 URL 转 App 深链写进 qrItems，
   * 手机端据此渲染「点码登录」按钮——点了直接拉起对应 App 确认，不用相机扫。
   * 返回值带每家的深链（qrLink），供调用方记账/重发时保留按钮。
   */
  async pushBatchQrCards(
    ctx: ToolContext,
    items: Array<{ platform: string; label: string; png: Buffer | null }>,
    meta: { title: string; caption?: string },
  ): Promise<Map<string, { imageUrl: string; qrLink?: string; qrLinkFallback?: string }>> {
    const pushed = new Map<string, { imageUrl: string; qrLink?: string; qrLinkFallback?: string }>();
    if (!ctx.pushMediaCards || !this.deps.imageStore) return pushed;
    const actorId = ctx.userId ?? ctx.sessionId;
    // 逐张落盘（每家一张独立 PNG），收集 URL
    const saved: Array<{ platform: string; label: string; imageUrl: string; dims?: { width: number; height: number }; qrLink?: string; qrLinkFallback?: string }> = [];
    for (const item of items) {
      if (!item.png) continue;
      try {
        const imageUrl = await this.deps.imageStore.savePng(actorId, item.png, ctx.sessionId, {
          libraryHidden: true,
        });
        const dims = pngDimensions(item.png);
        const link = await qrAppLink(item.png, item.platform);
        saved.push({
          platform: item.platform,
          label: item.label,
          imageUrl,
          ...(dims ? { dims } : {}),
          ...(link ?? {}),
        });
        pushed.set(item.platform, {
          imageUrl,
          ...(link.qrLink ? { qrLink: link.qrLink } : {}),
          ...(link.qrLinkFallback ? { qrLinkFallback: link.qrLinkFallback } : {}),
        });
      } catch {
        /* 单张失败不阻断其余 */
      }
    }
    if (saved.length === 0) return pushed;

    // 多平台：一张 shopping_login 卡，卡内 N 个平台分区各一张码。
    // 客户端 ShoppingLoginCard 支持 qrItems 多码版式（单码时行为不变）。
    //
    // 注意：**只有一家也要走这张卡**（2026-11-13 P1）。以前只有一家时推的是
    // 一张裸二维码图——用户看得见码，却没有「跳过这家 / 重新出码 / 继续比价」
    // 的入口，只能回到对话里说一句话，整条「登录完再统一交付」的链路就断了。
    if (saved.length > 0) {
      ctx.pushMediaCards([
        {
          type: "card",
          cardType: "shopping_login",
          title: meta.title,
          items: [],
          ...(meta.caption ? { footer: meta.caption } : {}),
          extra: {
            shopping: {
              stage: "login",
              title: meta.title,
              multiLogin: saved.length > 1,
              qrItems: saved.map((s) => ({
                platform: s.platform,
                platformLabel: s.label,
                qrImage: s.imageUrl,
                ...(s.qrLink ? { qrLink: s.qrLink } : {}),
                ...(s.qrLinkFallback ? { qrLinkFallback: s.qrLinkFallback } : {}),
                ...(s.dims ? { width: s.dims.width, height: s.dims.height } : {}),
              })),
              note: meta.caption ?? "用对应平台的 App 扫下面任意一个码，扫完我会自动继续比价",
              primaryLabel: "我扫好了",
              secondaryLabel: "先不比了",
              primaryAction: "shopping.login.check",
              secondaryAction: "local.dismiss",
              actions: { platforms: saved.map((s) => s.platform) },
            },
          },
        } as unknown as ToolMediaCard,
      ]);
      return pushed;
    }
    return pushed;
  }

  /** 统一出口：落盘 → 组卡 → 经 ctx.pushMediaCards 推聊天流。 */
  private async pushCard(
    ctx: ToolContext,
    meta: { title: string; caption?: string },
    png: Buffer,
  ): Promise<string | null> {
    if (!ctx.pushMediaCards || !this.deps.imageStore) return null;
    const actorId = ctx.userId ?? ctx.sessionId;
    // 扫码/登录/支付截图属于工具性图片，只服务当前对话，不进资料库。
    const imageUrl = await this.deps.imageStore.savePng(actorId, png, ctx.sessionId, {
      libraryHidden: true,
    });
    // mediaType=qr + 真实像素宽高：客户端按「完整露出」版式渲染二维码
    // （contain + 白底），并拿到 1:1 自然宽高比——不再按 3:4 兜底把方码裁掉。
    const dims = pngDimensions(png);
    const card: ToolMediaCard = {
      type: "image",
      title: meta.title,
      thumbnailUrl: imageUrl,
      mediaUrl: imageUrl,
      mediaType: "qr",
      ...(dims ? { width: dims.width, height: dims.height } : {}),
      ...(meta.caption ? { caption: meta.caption } : {}),
    };
    ctx.pushMediaCards([card]);
    return imageUrl;
  }
}

/**
 * 解码二维码 PNG，返回内嵌文本（URL/token），失败返回 null。
 *
 * 点码登录（2026-11-14）：服务端手里的登录二维码本身就是「内嵌 URL 的图」，
 * 解码出来转成 App 深链，手机端点按钮即可拉起 App 确认登录——省掉
 * 「存图 → 开 App → 相册扫码」三步。best-effort：截图糊了/解码失败都返回
 * null，绝不影响推码主流程（扫码兜底原样保留）。
 */
export async function decodeQrLink(png: Buffer): Promise<string | null> {
  try {
    const { data, info } = await sharp(png)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const pixels = new Uint8ClampedArray(
      data.buffer,
      data.byteOffset,
      data.byteLength,
    );
    return jsQR(pixels, info.width, info.height)?.data ?? null;
  } catch {
    return null;
  }
}

/** 已知购物平台的 App URL scheme（深链透传判定）。 */
const APP_SCHEME_RE =
  /^(?:taobao|tbopen|tmall|jd|openapp\.jdmobile|pinduoduo|pdd|pddopen):\/\//i;

/**
 * 解码内容 → App 深链（点码登录，2026-11-14）。
 *
 * · 本身就是平台 App scheme（taobao:// 等）→ 原样透传；
 * · https URL → 按平台包一层 App scheme（App 打开同一个 URL，走的还是
 *   平台自己的登录确认页，不引入新风控）；
 * · 纯 token 串（App 打不开）→ null，该平台不出按钮，纯扫码兜底。
 *
 * fallback：深链打不开（未装 App / scheme 变了）时客户端改开的原地址。
 */
export function toAppLaunchLink(
  platform: string,
  content: string,
): { link: string; fallback?: string } | null {
  const text = content.trim();
  if (!text) return null;
  if (APP_SCHEME_RE.test(text)) return { link: text };
  if (!/^https?:\/\//i.test(text)) return null;
  switch (platform) {
    case "taobao":
    case "tmall":
      return {
        link: `tbopen://m.taobao.com/tbopen/index.html?h5Url=${encodeURIComponent(text)}`,
        fallback: text,
      };
    case "jd":
      return {
        link: `openapp.jdmobile://virtual?params=${encodeURIComponent(
          JSON.stringify({ category: "jump", des: "url", url: text }),
        )}`,
        fallback: text,
      };
    default:
      // pdd / 未知平台：暂无可靠 scheme 包装，直接给原 URL——
      // universal link 可能拉起 App，不行就系统浏览器打开。
      return { link: text };
  }
}

/** 解码 + 转深链一步到位：返回 { qrLink, qrLinkFallback? }（失败空对象）。 */
async function qrAppLink(
  png: Buffer,
  platform: string,
): Promise<{ qrLink?: string; qrLinkFallback?: string }> {
  const content = await decodeQrLink(png);
  if (!content) return {};
  const link = toAppLaunchLink(platform, content);
  return link ? { qrLink: link.link, ...(link.fallback ? { qrLinkFallback: link.fallback } : {}) } : {};
}

/**
 * 从 PNG buffer 读 IHDR 里的像素宽高（固定偏移 16/20，大端）。
 * 解析失败返回 null（调用方省略字段，客户端走兜底比例）。
 */
function pngDimensions(png: Buffer): { width: number; height: number } | null {
  try {
    if (png.length < 24 || png.toString("ascii", 12, 16) !== "IHDR") return null;
    const width = png.readUInt32BE(16);
    const height = png.readUInt32BE(20);
    return width > 0 && height > 0 ? { width, height } : null;
  } catch {
    return null;
  }
}

/** dataURL（data:image/png;base64,...）/ 本地 PNG 文件 / Buffer → Buffer。 */
async function resolvePngBuffer(
  image: { dataUrl?: string; filePath?: string; png?: Buffer },
): Promise<Buffer | null> {
  if (image.png) return image.png;
  if (image.dataUrl) {
    const commaIndex = image.dataUrl.indexOf(",");
    if (!image.dataUrl.startsWith("data:") || commaIndex < 0) return null;
    return Buffer.from(image.dataUrl.slice(commaIndex + 1), "base64");
  }
  if (image.filePath) {
    // 兼容 alipay-bot CLI 输出的 file:/// 本地路径
    const path = image.filePath.startsWith("file://")
      ? fileUrlToPath(image.filePath)
      : image.filePath;
    return await readFile(path);
  }
  return null;
}

function fileUrlToPath(fileUrl: string): string {
  // file:///C:/x/y.png → C:/x/y.png；file:///home/x.png → /home/x.png
  let p = fileUrl.slice("file://".length);
  while (p.startsWith("/")) p = p.slice(1);
  return /^[A-Za-z]:/.test(p) ? p : `/${p}`;
}

/**
 * 截「能扫的码」，而不是「页面顶部」。
 *
 * 历史事故（2026-11-06 真机取证）：登录页的二维码普遍在首屏折叠线以下，
 * 直接 page.screenshot() 截到的是 logo + 「手机登录/扫码登录」按钮，用户
 * 拿到的图里根本没有码——服务端却已宣称「二维码已推送到聊天」。
 * 这里先在页面里找最像二维码的元素（够大、接近正方形、class/alt/src 带
 * qr/code 提示），把它滚到视口中央再截屏；找不到候选才退回整屏截图。
 */
async function captureQrFocused(page: Page): Promise<Buffer> {
  const mark = "data-pa-qr-target";
  const found = await page
    .evaluate((markAttr: string) => {
      const viewportArea = window.innerWidth * window.innerHeight;
      const nodes = Array.from(
        document.querySelectorAll<HTMLElement>(
          "img, canvas, svg, [class*='qr'], [class*='QR'], [id*='qr'], [id*='QR']",
        ),
      );
      let best: HTMLElement | null = null;
      let bestScore = 0;
      for (const el of nodes) {
        const rect = el.getBoundingClientRect();
        if (rect.width < 80 || rect.height < 80) continue;
        // 整屏大图（头部 banner）不是二维码
        if (rect.width * rect.height > viewportArea * 0.75) continue;
        const style = window.getComputedStyle(el);
        if (style.visibility === "hidden" || style.display === "none") continue;
        const squareness =
          Math.min(rect.width, rect.height) / Math.max(rect.width, rect.height);
        if (squareness < 0.6) continue;
        const hint = `${el.getAttribute("alt") ?? ""} ${el.id} ${el.getAttribute("src") ?? ""} ${el.getAttribute("class") ?? ""}`.toLowerCase();
        let score = squareness * Math.min(rect.width, rect.height);
        if (/qr|erweima|scan|扫码|二维码/.test(hint)) score *= 2.5;
        if (score > bestScore) {
          bestScore = score;
          best = el;
        }
      }
      if (!best) return false;
      best.setAttribute(markAttr, "1");
      best.scrollIntoView({ block: "center", inline: "center" });
      return true;
    }, mark)
    .catch(() => false);

  if (found) {
    // 滚动后等一帧布局与（懒加载的）码图绘制
    await page.waitForTimeout(500).catch(() => {});
    // 关键：截**元素本身**，不是整屏。整屏截图里二维码只占一角，塞进卡片
    // 的方形框后肉眼根本扫不出来（真机取证：整页 1080×760，码只 170px）。
    const handle = await page.$(`[${mark}="1"]`).catch(() => null);
    if (handle) {
      const buf = await handle.screenshot({ type: "png" }).catch(() => null);
      await handle.dispose().catch(() => {});
      await page
        .evaluate((m: string) => {
          document
            .querySelectorAll(`[${m}="1"]`)
            .forEach((el) => el.removeAttribute(m));
        }, mark)
        .catch(() => {});
      if (buf) return buf;
    }
  }
  return page.screenshot({ type: "png" });
}
