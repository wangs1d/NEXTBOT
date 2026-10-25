import { getDataDir } from "../config/data-dir.js";
import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, writeFile, stat } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";

import type { ImageGenerationProvider, ImageGenerationResult, ImageGenerateInput } from "./image-generation-providers.js";
import { OpenAICompatibleImageProvider, GeminiImageProvider } from "./image-generation-providers.js";

/**
 * 图像生成服务：调用 LLM 提供商的图像接口生成图片，
 * 落盘到本地 `data/images/{actorId}/{imageId}.png` 后返回可访问 URL。
 *
 * 设计要点：
 *   - 与社交动态 / 语音消息独立目录，便于按能力域管理
 *   - 文生图走 OpenAI 兼容通道（key 复用对话 OPENAI_API_KEY）；
 *     图生图（输入参考图，照片风格化用）走 Gemini 图像模型（GEMINI_API_KEY，Nano Banana 系）
 *   - 图片下载/落盘到本地，避免上游链接 24h 过期问题
 *   - HTTP 拉流走 `/agent/images/:actorId/:fileName`（与 voice-messages 同模式）
 */
export class ImageGenerationService {
  private readonly storageRoot: string;
  private readonly providers: ImageGenerationProvider[] = [];

  constructor(opts: {
    storageRoot?: string;
    providers?: ImageGenerationProvider[];
  } = {}) {
    this.storageRoot = opts.storageRoot ?? join(getDataDir(), "images");
    // 默认装载内置 provider（未配置对应 key 则各自跳过）
    const openaiCompat = new OpenAICompatibleImageProvider();
    if (openaiCompat.isEnabled()) this.providers.push(openaiCompat);
    const gemini = new GeminiImageProvider();
    if (gemini.isEnabled()) this.providers.push(gemini);
    // 允许外部注入额外 provider
    if (opts.providers) this.providers.push(...opts.providers);
  }

  isEnabled(): boolean {
    return this.providers.length > 0;
  }

  /**
   * 合成图片并落盘。
   *
   * @returns 成功返回 `{ ok, imageUrl, model, seed? }`；
   *          失败返回 `{ ok: false, error }`。
   */
  async generate(
    prompt: string,
    actorId: string,
    options: {
      model?: string;
      imageSize?: string;
      batchSize?: number;
    } = {},
  ): Promise<{ ok: true; imageUrl: string; model: string; seed?: number; revisedPrompt?: string } | { ok: false; error: string }> {
    if (!this.isEnabled()) {
      return { ok: false, error: "图像生成未配置：服务端需 OPENAI_API_KEY（OpenAI 兼容 images 接口）" };
    }
    if (!prompt.trim()) {
      return { ok: false, error: "prompt 不能为空" };
    }

    // 按优先级尝试 provider
    let lastError = "所有图像生成 provider 都失败";
    for (const provider of this.providers) {
      try {
        const result: ImageGenerationResult = await provider.generate({
          prompt,
          model: options.model,
          imageSize: options.imageSize,
          batchSize: options.batchSize ?? 1,
        });
        // 落盘第一张图到本地
        const localUrl = await this.storeFirstImage(result.images[0], actorId);
        return {
          ok: true,
          imageUrl: localUrl,
          model: result.model,
          seed: result.images[0].seed,
          revisedPrompt: result.images[0].revisedPrompt,
        };
      } catch (e) {
        lastError = e instanceof Error ? e.message : String(e);
        console.warn(`[ImageGenerationService] provider ${provider.name} failed: ${lastError}`);
        // 继续尝试下一个 provider
      }
    }
    return { ok: false, error: lastError };
  }

  /**
   * 图生图：以输入参考图为底进行风格化重绘并落盘（照片风格化等内置能力用）。
   *
   * 仅会命中声明了 `supportsImageInput()` 的 provider（当前为 Gemini 图像模型）；
   * 未配置时返回明确的错误信息。
   */
  async generateFromImage(
    input: ImageGenerateInput,
    prompt: string,
    actorId: string,
    options: {
      model?: string;
      aspectRatio?: string;
    } = {},
  ): Promise<{ ok: true; imageUrl: string; model: string; seed?: number; revisedPrompt?: string } | { ok: false; error: string }> {
    if (!input?.dataBase64?.trim()) {
      return { ok: false, error: "图生图缺少输入图片数据" };
    }
    if (!input.mimeType.startsWith("image/")) {
      return { ok: false, error: `图生图输入必须是图片类型，收到 ${input.mimeType}` };
    }
    if (!prompt.trim()) {
      return { ok: false, error: "prompt 不能为空" };
    }
    const capable = this.providers.filter((p) => p.supportsImageInput?.() === true);
    if (capable.length === 0) {
      return { ok: false, error: "图生图未配置：服务端需 GEMINI_API_KEY（Gemini 图像模型 / Nano Banana）" };
    }

    let lastError = "所有图生图 provider 都失败";
    for (const provider of capable) {
      try {
        const result = await provider.generate({
          prompt,
          model: options.model,
          aspectRatio: options.aspectRatio,
          image: input,
        });
        const localUrl = await this.storeFirstImage(result.images[0], actorId);
        return {
          ok: true,
          imageUrl: localUrl,
          model: result.model,
          seed: result.images[0].seed,
          revisedPrompt: result.images[0].revisedPrompt,
        };
      } catch (e) {
        lastError = e instanceof Error ? e.message : String(e);
        console.warn(`[ImageGenerationService] img2img provider ${provider.name} failed: ${lastError}`);
      }
    }
    return { ok: false, error: lastError };
  }

  /** 兼容两种上游返回（公网 URL / base64 数据），统一落盘为本地 PNG。 */
  private async storeFirstImage(
    image: ImageGenerationResult["images"][number],
    actorId: string,
  ): Promise<string> {
    if (image.url) {
      return this.downloadAndStorePng(image.url, actorId);
    }
    if (image.base64) {
      return this.saveImageBuffer(actorId, Buffer.from(image.base64, "base64"));
    }
    throw new Error("上游返回的图片既无 url 也无 base64 数据");
  }

  /**
   * 把图片 buffer 统一转成 PNG 落盘（Gemini 系直接返回 base64 数据时使用），
   * 复用 data/images/{actorId}/ 目录与 /agent/images/ 静态拉流路由。
   */
  async saveImageBuffer(actorId: string, buf: Buffer): Promise<string> {
    const safeActorId = actorId.replace(/[^a-zA-Z0-9_-]/g, "_") || "anonymous";
    const dir = join(this.storageRoot, safeActorId);
    await mkdir(dir, { recursive: true });
    const fileName = `${Date.now()}-${randomUUID().slice(0, 8)}.png`;
    const png = await sharp(buf, { animated: false }).rotate().png().toBuffer();
    await writeFile(join(dir, fileName), png);
    return `/agent/images/${safeActorId}/${fileName}`;
  }

  /**
   * 把服务端已持有的 PNG 直接落盘（如购物流程登录/支付二维码截图），
   * 复用 data/images/{actorId}/ 目录与 /agent/images/ 静态拉流路由。
   * 命名规则与 resolveFilePath 校验保持一致：`{ts}-{uuid8}.png`。
   */
  async savePng(actorId: string, png: Buffer): Promise<string> {
    const safeActorId = actorId.replace(/[^a-zA-Z0-9_-]/g, "_") || "anonymous";
    const dir = join(this.storageRoot, safeActorId);
    await mkdir(dir, { recursive: true });
    const fileName = `${Date.now()}-${randomUUID().slice(0, 8)}.png`;
    await writeFile(join(dir, fileName), png);
    return `/agent/images/${safeActorId}/${fileName}`;
  }

  /** 把远程图片下载并统一转成 PNG 落盘，返回可访问的相对路径。 */
  async downloadAndStorePng(
    remoteUrl: string,
    actorId: string,
    timeoutMs = 30_000,
  ): Promise<string> {
    // actorId 限制为 [a-zA-Z0-9_-]，避免路径穿越
    const safeActorId = actorId.replace(/[^a-zA-Z0-9_-]/g, "_") || "anonymous";
    const dir = join(this.storageRoot, safeActorId);
    await mkdir(dir, { recursive: true });

    const imageId = `${Date.now()}-${randomUUID().slice(0, 8)}`;
    const fileName = `${imageId}.png`;
    const fullPath = join(dir, fileName);

    // 拉远程图（上游返回公网 URL），可传入更短的预算；默认 30s 超时防止挂起
    const res = await fetch(remoteUrl, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) {
      throw new Error(`下载图像失败：HTTP ${res.status} ${res.statusText}`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    const png = await sharp(buf, { animated: false })
      .rotate()
      .png()
      .toBuffer();
    await writeFile(fullPath, png);

    // 返回相对路径，供客户端拼接 base URL 拉流
    return `/agent/images/${safeActorId}/${fileName}`;
  }

  /** 静态拉流时校验路径并返回绝对路径；不通过返回 null。 */
  resolveFilePath(actorId: string, fileName: string): string | null {
    const safeActorId = actorId.replace(/[^a-zA-Z0-9_-]/g, "_") || "anonymous";
    // 文件名严格校验：时间戳-uuid8.png
    if (!/^\d+-[a-f0-9]{8}\.png$/.test(fileName)) return null;
    const full = join(this.storageRoot, safeActorId, fileName);
    // 路径穿越防护
    const normalized = full.normalize();
    const baseDir = join(this.storageRoot, safeActorId).normalize();
    if (!normalized.startsWith(baseDir)) return null;
    return full;
  }

  /** 静态拉流时检查文件是否存在。 */
  async fileExists(path: string): Promise<boolean> {
    try {
      const s = await stat(path);
      return s.isFile();
    } catch {
      return false;
    }
  }

  /** 提供给 HTTP 路由用：返回 readable stream。 */
  createReadStream(path: string) {
    return createReadStream(path);
  }
}
