/**
 * 图像生成 provider 抽象 + 具体实现。
 *
 * 与 TTS 体系同模式：抽象接口 + 多个 provider，按优先级链路回退。
 * 当前实现：
 *   - {@link OpenAICompatibleImageProvider}：OpenAI 兼容 images/generations 端点
 *     （key 复用对话 OPENAI_API_KEY；端点不支持 images 接口时优雅报错；仅文生图）
 *   - {@link GeminiImageProvider}：Gemini 原生图像模型（Nano Banana），
 *     `generateContent` 端点，支持文生图与**图生图**（输入参考图）
 */

/** 图生图的输入参考图（base64 编码的原始图片数据）。 */
export interface ImageGenerateInput {
  mimeType: string;
  dataBase64: string;
}

export interface ImageGenerateRequest {
  prompt: string;
  model?: string;
  imageSize?: string;
  batchSize?: number;
  /** 图生图：输入参考图。不支持的 provider 收到该字段应直接抛错，由服务层回退下一个 provider。 */
  image?: ImageGenerateInput;
  /** 输出宽高比（Gemini 系支持："1:1" / "3:4" / "4:3" / "9:16" / "16:9" 等；文生图 provider 忽略）。 */
  aspectRatio?: string;
}

export interface ImageGenerationResult {
  model: string;
  images: Array<{
    /** 上游公网 URL（OpenAI 兼容系返回）。 */
    url?: string;
    /** 上游直接返回的 base64 图片数据（Gemini 图像系返回）。 */
    base64?: string;
    revisedPrompt?: string;
    seed?: number;
  }>;
}

export interface ImageGenerationProvider {
  readonly name: string;
  isEnabled(): boolean;
  /** 是否支持图生图（带 image 输入）。缺省视为不支持。 */
  supportsImageInput?(): boolean;
  generate(req: ImageGenerateRequest): Promise<ImageGenerationResult>;
}

/**
 * OpenAI 兼容 image generation provider。
 *
 * 端点：`POST {baseUrl}/images/generations`，鉴权 `Authorization: Bearer ${apiKey}`。
 * key 复用对话渠道（OPENAI_API_KEY）；端点可经 IMAGE_GEN_BASE_URL 覆盖，
 * 模型可经 IMAGE_GEN_MODEL 覆盖（默认 dall-e-3）。
 */
export class OpenAICompatibleImageProvider implements ImageGenerationProvider {
  readonly name = "openai-compatible";
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor() {
    this.apiKey = process.env.OPENAI_API_KEY ?? "";
    this.baseUrl = (
      process.env.IMAGE_GEN_BASE_URL?.trim() ||
      process.env.OPENAI_BASE_URL?.trim() ||
      "https://api.openai.com/v1"
    ).replace(/\/+$/, "");
  }

  isEnabled(): boolean {
    return this.apiKey.length > 0;
  }

  async generate(req: ImageGenerateRequest): Promise<ImageGenerationResult> {
    if (!this.isEnabled()) {
      throw new Error("OPENAI_API_KEY 未配置");
    }
    if (req.image) {
      // images/generations 端点没有图片输入位，明确报错让服务层回退到支持的 provider
      throw new Error("openai-compatible provider 不支持图生图（无图片输入通道）");
    }
    const model = req.model ?? process.env.IMAGE_GEN_MODEL?.trim() ?? "dall-e-3";
    const imageSize = req.imageSize ?? "1024x1024";
    const batchSize = Math.max(1, Math.min(4, req.batchSize ?? 1));

    const res = await fetch(`${this.baseUrl}/images/generations`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model,
        prompt: req.prompt,
        size: imageSize,
        n: batchSize,
      }),
      signal: AbortSignal.timeout(60_000),
    });

    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(`图像生成失败：HTTP ${res.status} ${txt.slice(0, 200)}`);
    }

    const data = (await res.json()) as {
      data?: Array<{ url?: string; revised_prompt?: string }>;
      images?: Array<{ url?: string; revised_prompt?: string }>;
    };
    // 兼容两种返回格式（OpenAI 标准 data[] / 部分聚合云 images[]）
    const images = (data.data ?? data.images ?? []).map((img) => ({
      url: img.url ?? "",
      revisedPrompt: img.revised_prompt,
    })).filter((img) => (img.url ?? "").length > 0);

    if (images.length === 0) {
      throw new Error("图像生成返回空图片列表");
    }

    return { model, images };
  }
}

/**
 * Gemini 原生图像模型 provider（Nano Banana 系）。
 *
 * 端点：`POST {baseUrl}/models/{model}:generateContent`，鉴权 `x-goog-api-key`。
 * key：GEMINI_API_KEY（回退 GOOGLE_API_KEY）；base 可经 IMAGE_GEN_GEMINI_BASE_URL 覆盖（代理/聚合云），
 * 模型可经 IMAGE_GEN_GEMINI_MODEL 覆盖（默认 gemini-2.5-flash-image，即 Nano Banana；
 * Nano Banana Pro 可配 gemini-3-pro-image-preview）。
 * 同一次请求支持文生图与图生图：带 image 时把参考图作为 inline_data part 传入。
 */
export class GeminiImageProvider implements ImageGenerationProvider {
  readonly name = "gemini-image";
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor() {
    this.apiKey = (process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY ?? "").trim();
    this.baseUrl = (
      process.env.IMAGE_GEN_GEMINI_BASE_URL?.trim() ||
      "https://generativelanguage.googleapis.com/v1beta"
    ).replace(/\/+$/, "");
  }

  isEnabled(): boolean {
    return this.apiKey.length > 0;
  }

  supportsImageInput(): boolean {
    return true;
  }

  async generate(req: ImageGenerateRequest): Promise<ImageGenerationResult> {
    if (!this.isEnabled()) {
      throw new Error("GEMINI_API_KEY 未配置");
    }
    const model = req.model ?? process.env.IMAGE_GEN_GEMINI_MODEL?.trim() ?? "gemini-2.5-flash-image";

    const parts: Array<Record<string, unknown>> = [{ text: req.prompt }];
    if (req.image) {
      parts.push({ inline_data: { mime_type: req.image.mimeType, data: req.image.dataBase64 } });
    }

    const generationConfig: Record<string, unknown> = { responseModalities: ["TEXT", "IMAGE"] };
    if (req.aspectRatio) {
      generationConfig.imageConfig = { aspectRatio: req.aspectRatio };
    }

    const res = await fetch(`${this.baseUrl}/models/${encodeURIComponent(model)}:generateContent`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": this.apiKey,
      },
      body: JSON.stringify({
        contents: [{ role: "user", parts }],
        generationConfig,
      }),
      signal: AbortSignal.timeout(120_000),
    });

    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(`Gemini 图像生成失败：HTTP ${res.status} ${txt.slice(0, 200)}`);
    }

    const data = (await res.json()) as {
      candidates?: Array<{
        content?: { parts?: Array<{ text?: string; inlineData?: { mimeType?: string; data?: string }; inline_data?: { mime_type?: string; data?: string } }> };
        finishReason?: string;
      }>;
      promptFeedback?: { blockReason?: string };
    };

    if (data.promptFeedback?.blockReason) {
      throw new Error(`Gemini 图像生成被安全策略拦截：${data.promptFeedback.blockReason}`);
    }

    const partsOut = data.candidates?.[0]?.content?.parts ?? [];
    const images = partsOut
      .map((p) => p.inlineData ?? p.inline_data)
      .filter((d): d is { mimeType?: string; data?: string; mime_type?: string } => Boolean(d?.data))
      .map((d) => ({ base64: d.data! }));

    if (images.length === 0) {
      const finishReason = data.candidates?.[0]?.finishReason ?? "unknown";
      throw new Error(`Gemini 图像生成返回空图片列表（finishReason=${finishReason}）`);
    }

    return { model, images };
  }
}
