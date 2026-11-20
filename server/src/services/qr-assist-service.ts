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
  ): Promise<Array<{ platform: string; label: string; imageUrl: string; width?: number; height?: number; qrLink?: string; qrLinkFallback?: string; issuedAt: number }>> {
    const saved: Array<{ platform: string; label: string; imageUrl: string; width?: number; height?: number; qrLink?: string; qrLinkFallback?: string; issuedAt: number }> = [];
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
          // 出码时刻（2026-11-20）：客户端据此倒计时，快过期/已过期时点码
          // 先换新码再跳——否则用户点进 App 只会看到「二维码已失效」。
          issuedAt: Date.now(),
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
  ): Promise<Map<string, { imageUrl: string; qrLink?: string; qrLinkFallback?: string; issuedAt: number }>> {
    const pushed = new Map<string, { imageUrl: string; qrLink?: string; qrLinkFallback?: string; issuedAt: number }>();
    if (!ctx.pushMediaCards || !this.deps.imageStore) return pushed;
    const actorId = ctx.userId ?? ctx.sessionId;
    // 逐张落盘（每家一张独立 PNG），收集 URL
    const saved: Array<{ platform: string; label: string; imageUrl: string; issuedAt: number; dims?: { width: number; height: number }; qrLink?: string; qrLinkFallback?: string }> = [];
    for (const item of items) {
      if (!item.png) continue;
      try {
        const imageUrl = await this.deps.imageStore.savePng(actorId, item.png, ctx.sessionId, {
          libraryHidden: true,
        });
        const dims = pngDimensions(item.png);
        const link = await qrAppLink(item.png, item.platform);
        const issuedAt = Date.now();
        saved.push({
          platform: item.platform,
          label: item.label,
          imageUrl,
          issuedAt,
          ...(dims ? { dims } : {}),
          ...(link ?? {}),
        });
        pushed.set(item.platform, {
          imageUrl,
          issuedAt,
          ...(link.qrLink ? { qrLink: link.qrLink } : {}),
          ...(link.qrLinkFallback ? { qrLinkFallback: link.qrLinkFallback } : {}),
        });
      } catch {
        /* 单张失败不阻断其余 */
      }
    }
    if (saved.length === 0) {
      console.log("[qr] 批量推码：没有可推的二维码（截图全失败）");
      return pushed;
    }

    // 多平台：一张 shopping_login 卡，卡内 N 个平台分区各一张码。
    // 客户端 ShoppingLoginCard 支持 qrItems 多码版式（单码时行为不变）。
    //
    // 注意：**只有一家也要走这张卡**（2026-11-13 P1）。以前只有一家时推的是
    // 一张裸二维码图——用户看得见码，却没有「跳过这家 / 重新出码 / 继续比价」
    // 的入口，只能回到对话里说一句话，整条「登录完再统一交付」的链路就断了。
    if (saved.length > 0) {
      const sent = ctx.pushMediaCards([
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
                issuedAt: s.issuedAt,
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
      // 送达确认（2026-11-19）：回调返回 false = 回合已收口/连接失效，卡片
      // 只落了盘没送到用户眼前。此时必须按「没推」回执，绝不能报成已推送。
      if (sent === false) {
        console.log(
          `[qr] 登录卡未能实时送达（回合已收口/连接失效）：${saved
            .map((s) => s.platform)
            .join(",")}`,
        );
        return new Map();
      }
      console.log(
        `[qr] 登录卡已推送：${saved.map((s) => `${s.platform}(${s.imageUrl})`).join(" ")}`,
      );
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
    if (!ctx.pushMediaCards || !this.deps.imageStore) {
      console.log("[qr] 推卡不可用：缺少聊天通道或图片服务");
      return null;
    }
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
    // 送达确认（2026-11-19）：stale/连接失效时回调返回 false——这时「已推送」
    // 是假的，调用方必须按失败处理，否则模型会把没送到的东西说成已送到。
    const sent = ctx.pushMediaCards([card]);
    if (sent === false) {
      console.log(`[qr] 卡片未能实时送达（回合已收口/连接失效）：${meta.title} ${imageUrl}`);
      return null;
    }
    console.log(`[qr] 卡片已推送：${meta.title} ${imageUrl} ${png.length}B`);
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

/** 已知购物平台的 App URL scheme（深链透传判定）。
 * 码内容本身就是 scheme 时原样交给 App（码是平台自己生成的，最可靠）。 */
const APP_SCHEME_RE =
  /^(?:taobao|tbopen|tmall|jd|openapp\.jdmobile|pinduoduo|pdd|pddopen|snssdk1128|aweme|imeituan|dianping|damai|maoyan|suning|smzdm):\/\//i;

/**
 * 解码内容 → App 深链（点码登录，2026-11-14）。
 *
 * · 本身就是平台 App scheme（taobao:// 等）→ 原样透传；
 * · https URL → 按平台包一层 App scheme（App 打开同一个 URL，走的还是
 *   平台自己的登录确认页，不引入新风控）；
 * · 纯 token 串 / 没有已知 scheme 的平台 → null，不渲染「点码登录」按钮。
 *
 * 所有平台同一条规则：**绝不把原 https 当 link 或 fallback 返回**。
 * url_launcher 用 externalApplication 打开 https 一定成功（起来的是浏览器），
 * 用户看到的是平台「下载 App」落地页——拼多多 2026-11-20 真机就是这样被带到
 * 下载页的。返回 null 后客户端退回「保存二维码 → 相册扫码」，至少不会送错地方。
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
      };
    case "jd":
      return {
        link: `openapp.jdmobile://virtual?params=${encodeURIComponent(
          JSON.stringify({ category: "jump", des: "url", url: text }),
        )}`,
      };
    case "pdd":
      // 拼多多扫码登录的码内容是
      // https://mobile.yangkeduo.com/down_scan.html?secret_key=…&pdd_biz_scene=AUTH_LOGIN
      // （云端实测解码所得）。App 的 scheme 支持「宿主 + 原样 https 路径」：
      //   pinduoduo://com.xunmeng.pinduoduo/https://mobile.yangkeduo.com/…
      // 直接开 https 只会落到「打开拼多多APP」下载页（真机事故），所以两个
      // 候选都是 App scheme，浏览器不作为兜底。
      return {
        link: `pinduoduo://com.xunmeng.pinduoduo/${text}`,
        fallback: `pddopen://?h5Url=${encodeURIComponent(text)}`,
      };
    default:
      return null;
  }
}

/** 解码 + 转深链一步到位：返回 { qrLink, qrLinkFallback? }（失败空对象）。 */
async function qrAppLink(
  png: Buffer,
  platform: string,
): Promise<{ qrLink?: string; qrLinkFallback?: string }> {
  const content = await decodeQrLink(png);
  if (!content) {
    console.log(`[qr] ${platform || "?"} 码解码失败，无点码深链（扫码兜底）`);
    return {};
  }
  // 解码内容落日志（2026-11-20）：「点码进 App 没出登录确认页」要靠码内容
  // 取证——是 token URL、下载落地页还是纯 scheme，各平台修法不同。
  console.log(
    `[qr] ${platform || "?"} 码内容: ${content.length > 160 ? `${content.slice(0, 160)}…` : content}`,
  );
  const link = toAppLaunchLink(platform, content);
  if (!link) {
    console.log(`[qr] ${platform || "?"} 码内容无已知 scheme 映射，不渲染点码按钮`);
    return {};
  }
  return link ? { qrLink: link.link, ...(link.fallback ? { qrLinkFallback: link.fallback } : {}) } : {};
}

/**
 * 给截下来的二维码补静区（quiet zone）+ 保证最小分辨率。
 *
 * 平台登录页的码图紧贴元素边界（云端实测拼多多 qr-code-box 350×350，四边
 * 零白边）；二维码标准要求四周至少 4 个模块宽的白边，缺了它相册扫码/截屏
 * 扫码经常直接判「没找到二维码」。这里按边长 10% 补白（≈4~6 个模块），并
 * 把小码用最近邻**整数倍**放大到 ≥480px——整数倍保证每个模块像素宽一致，
 * 截图放大后边缘不被插值糊掉。
 */
async function addQuietZone(png: Buffer): Promise<Buffer> {
  try {
    const meta = await sharp(png).metadata();
    const w = meta.width ?? 0;
    const h = meta.height ?? 0;
    if (!w || !h) return png;
    const side = Math.max(w, h);
    const margin = Math.max(16, Math.round(side * 0.1));
    let img = sharp(png).flatten({ background: "#ffffff" });
    if (side < 480) {
      const factor = Math.ceil(480 / side);
      img = img.resize(w * factor, h * factor, { kernel: "nearest" });
    }
    return await img
      .extend({
        top: margin,
        bottom: margin,
        left: margin,
        right: margin,
        background: "#ffffff",
      })
      .png()
      .toBuffer();
  } catch {
    return png;
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
  // 单测里页面是桩（evaluate 恒 false），等满会白烧十几秒：走快速通道。
  const fast = process.env.QR_CAPTURE_FAST === "1";

  // 先**立刻找一次**（2026-11-20 提速）：京东/淘宝登录页首屏就带码，
  // 先等「页面渲染完成」纯属白等 2~3 秒。找到就返回，找不到再按下面的
  // 渲染/切换流程走。
  const direct = await captureQrElement(page);
  if (direct) return direct;
  if (fast) return page.screenshot({ type: "png" });

  // 刚 domcontentloaded 的瞬间可能还没画完：给 600ms 再看一眼
  await page.waitForTimeout(600).catch(() => {});
  const second = await captureQrElement(page);
  if (second) return second;

  // 还没码：等页面「真的有内容」——拼多多移动站是 uni-app，domcontentloaded
  // 之后还要 2~4 秒才画出登录方式（这一刻整屏纯白，截出来只有 5KB）。
  await waitForPageSettled(page, 3_500);
  const third = await captureQrElement(page);
  if (third) return third;

  // 没找到码：绝大多数平台默认停在「手机登录/验证码登录」，二维码要先切 tab
  // 才渲染。切过去之后轮询等码出现（拼多多点完会先转圈 2~4 秒才画出码）。
  const deadline = Date.now() + (fast ? 0 : 12_000);
  let lastSwitchAt = 0;
  while (Date.now() < deadline) {
    if (Date.now() - lastSwitchAt > 3_500) {
      lastSwitchAt = Date.now();
      await switchToScanLogin(page);
    }
    await page.waitForTimeout(700).catch(() => {});
    const hit = await captureQrElement(page);
    if (hit) return hit;
    if (isPageClosed(page)) break;
  }
  return page.screenshot({ type: "png" });
}

/** 页面是否已关闭（测试桩可能没有 isClosed，别让它在热路径上抛错）。 */
function isPageClosed(page: Page): boolean {
  try {
    return typeof page.isClosed === "function" ? page.isClosed() : false;
  } catch {
    return false;
  }
}

/**
 * 等页面渲染出实质内容（body 有文本 + 元素数够）。
 *
 * SPA/uni-app 的 domcontentloaded 只代表 HTML 到了，壳子还是空的；此时截图
 * 会得到一张白图。轮询到「看起来有内容」或超时为止（超时直接放行，不阻塞）。
 */
async function waitForPageSettled(page: Page, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ready = await page
      .evaluate(() => {
        const text = (document.body?.innerText ?? "").trim();
        return text.length > 20 && document.querySelectorAll("*").length > 30;
      })
      .catch(() => false);
    if (ready) return;
    if (isPageClosed(page)) return;
    await page.waitForTimeout(350).catch(() => {});
  }
}

async function switchToScanLogin(page: Page): Promise<boolean> {
  // 各家的入口文案与形态差异很大（2026-11-19 云端实测）：
  //   · 拼多多：登录方式选择页一颗大按钮「扫码登录」（520×68）
  //   · 淘宝：密码登录弹窗右上角「扫码登录更安全」
  //   · 京东：默认就是扫码，不需要点
  // 判定放宽成「短文本含扫码 + 尺寸像按钮/标签」，先完全匹配再包含匹配。
  // 点击必须走 Playwright 的**真实点击**——移动站/React 页面常只认真实
  // 输入事件（dispatchEvent 点了没反应，2026-11-19 实测拼多多就是这种）。
  const marked = await page
    .evaluate(() => {
      const exact = /^(扫码登录|二维码登录|扫码|扫一扫登录|APP扫码登录)$/;
      const loose = /(扫码登录|二维码登录|扫一扫登录)/;
      const forbidden = /(密码登录|短信登录|手机登录|忘记密码)/;
      // 用 * 全量扫（2026-11-19 云端实测）：拼多多移动站是 uni-app，
      // 页面元素是 <uni-view>/<uni-text> 这类自定义标签，固定选择器
      // a/button/div/span 一个都匹配不到——云端「找不到扫码入口」的真身。
      const all = Array.from(document.querySelectorAll<HTMLElement>("*")).slice(0, 4000);
      const nodes = all.filter((el) => {
        const text = (el.textContent ?? "").trim();
        if (!text || text.length > 12) return false;
        if (forbidden.test(text)) return false;
        const rect = el.getBoundingClientRect();
        if (rect.width < 8 || rect.height < 8) return false;
        if (rect.width > 640 || rect.height > 140) return false;
        const style = window.getComputedStyle(el);
        return style.visibility !== "hidden" && style.display !== "none";
      });
      // 大元素优先（真入口是按钮/tab，纯文字 span 往往是它的子节点）。
      // 排序函数必须内联匿名：tsx/esbuild keepNames 会给具名函数注入 __name，
      // 序列化进浏览器后直接 ReferenceError（同 spec-extract 的坑）。
      const exactHits = nodes
        .filter((el) => exact.test((el.textContent ?? "").trim()))
        .sort((a, b) => {
          const ra = a.getBoundingClientRect();
          const rb = b.getBoundingClientRect();
          return rb.width * rb.height - ra.width * ra.height;
        });
      const looseHits = nodes
        .filter((el) => loose.test((el.textContent ?? "").trim()))
        .sort((a, b) => {
          const ra = a.getBoundingClientRect();
          const rb = b.getBoundingClientRect();
          return rb.width * rb.height - ra.width * ra.height;
        });
      const pick = exactHits[0] ?? looseHits[0];
      if (!pick) return false;
      document
        .querySelectorAll("[data-pa-scan-tab]")
        .forEach((el) => el.removeAttribute("data-pa-scan-tab"));
      pick.setAttribute("data-pa-scan-tab", "1");
      return true;
    })
    .catch(() => false);

  if (!marked) return false;
  const handle = await page.$("[data-pa-scan-tab='1']").catch(() => null);
  if (!handle) return false;
  try {
    // force：页面常有透明遮罩/浮层，可操作性检查会判「不可点」（云端拼多多
    // 就是这种），但事件派发到元素本身是有效的。
    await handle.click({ timeout: 3_000, force: true });
    return true;
  } catch {
    // 被浮层遮挡/判定不可点时，直接在元素中心点一下（淘宝的入口就属于这种）
    const box = await handle.boundingBox().catch(() => null);
    if (box) {
      await page
        .mouse.click(box.x + box.width / 2, box.y + box.height / 2)
        .catch(() => {});
      return true;
    }
    // 被遮挡/不可点：退回事件派发（部分站点只监听冒泡的 click）
    const fallback = await page
      .evaluate(() => {
        const el = document.querySelector<HTMLElement>("[data-pa-scan-tab='1']");
        if (!el) return false;
        el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
        el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
        el.click();
        return true;
      })
      .catch(() => false);
    return fallback;
  } finally {
    await handle.dispose().catch(() => {});
  }
}

/**
 * 在当前页找「能扫的码」并截图。
 *
 * 2026-11-19 真机教训：只按「看起来像二维码」挑元素不够——拼多多/淘宝的码
 * 外面套着更大的容器（qr-code-wrapper 399×399），按面积/类名评分会把容器
 * 选中，截出来带一圈白边和 logo，肉眼能扫、程序解不出，卡片上的「点码登录」
 * 也就没有深链可给。现在改成**按评分取前几个候选，逐个截图并真正解码验证**，
 * 返回第一张解得出来的；都解不出才退回最高分那张（扫码兜底仍在）。
 */
async function captureQrElement(page: Page): Promise<Buffer | null> {
  const mark = "data-pa-qr-target";
  const count = await page
    .evaluate((markAttr: string) => {
      const viewportArea = window.innerWidth * window.innerHeight;
      const nodes = Array.from(
        document.querySelectorAll<HTMLElement>(
          "img, canvas, svg, [class*='qr'], [class*='QR'], [id*='qr'], [id*='QR']",
        ),
      );
      const scored: Array<{ el: HTMLElement; score: number }> = [];
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
        // 尺寸越接近常见码（180~320px）越可信：超大容器带白边/logo 反而解不出
        const side = Math.min(rect.width, rect.height);
        if (side > 360) score *= 0.6;
        scored.push({ el, score });
      }
      scored.sort((a, b) => b.score - a.score);
      const picked = scored.slice(0, 4);
      document
        .querySelectorAll(`[${markAttr}]`)
        .forEach((el) => el.removeAttribute(markAttr));
      picked.forEach((item, i) => item.el.setAttribute(markAttr, String(i + 1)));
      if (picked[0]) picked[0].el.scrollIntoView({ block: "center", inline: "center" });
      return picked.length;
    }, mark)
    .catch(() => 0);

  if (!count) return null;
  // 等一帧布局与（懒加载的）码图绘制
  await page.waitForTimeout(250).catch(() => {});

  let fallback: Buffer | null = null;
  for (let i = 1; i <= count; i += 1) {
    const handle = await page.$(`[${mark}="${i}"]`).catch(() => null);
    if (!handle) continue;
    const raw = await handle.screenshot({ type: "png" }).catch(() => null);
    await handle.dispose().catch(() => {});
    if (!raw) continue;
    // 补静区后再交付：元素截图紧贴码边，零白边的码在相册扫码/截屏扫码时
    // 普遍识别失败（2026-11-20 用户真机：截了图也扫不了）。
    const buf = await addQuietZone(raw);
    if (!fallback) fallback = buf;
    // 真正解一次：解得出说明这张图就是码本身（不是套着码的容器）
    if (await decodeQrLink(buf)) {
      await clearQrMarks(page, mark);
      return buf;
    }
  }
  await clearQrMarks(page, mark);
  return fallback;
}

/** 清掉候选标记（下一轮重新计算）。 */
async function clearQrMarks(page: Page, mark: string): Promise<void> {
  await page
    .evaluate((m: string) => {
      document.querySelectorAll(`[${m}]`).forEach((el) => el.removeAttribute(m));
    }, mark)
    .catch(() => {});
}
