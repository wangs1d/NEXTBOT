import type { Page } from "playwright";
import { readFile } from "node:fs/promises";

import type { ToolContext, ToolMediaCard } from "../tools/tool-registry.js";

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
      imageStore?: { savePng(actorId: string, png: Buffer): Promise<string> };
    } = {},
  ) {}

  /**
   * 只截图落盘、**不推聊天流**：返回 imageUrl 供卡内展示（购物登录卡）。
   *
   * 与 pushPageCard 的差别在出口——卡内扫码走 card.update，二维码是那张卡的
   * 一部分，再往聊天流里塞一张独立图片卡就会变成两条消息（正是要避免的）。
   */
  async savePageQrPng(ctx: ToolContext, page: Page): Promise<string | null> {
    if (!this.deps.imageStore) return null;
    try {
      const png = await captureQrFocused(page);
      if (!png) return null;
      return await this.deps.imageStore.savePng(ctx.userId ?? ctx.sessionId, png);
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

  /** 统一出口：落盘 → 组卡 → 经 ctx.pushMediaCards 推聊天流。 */
  private async pushCard(
    ctx: ToolContext,
    meta: { title: string; caption?: string },
    png: Buffer,
  ): Promise<string | null> {
    if (!ctx.pushMediaCards || !this.deps.imageStore) return null;
    const actorId = ctx.userId ?? ctx.sessionId;
    const imageUrl = await this.deps.imageStore.savePng(actorId, png);
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
