/**
 * 数据入口（Ingest）——把「图片 → 文字」接到真实的视觉模型上。
 *
 * 为什么不复用主对话的 chat 通道：`streamCompletion` 的 userTurn 只接受 text
 * （见 ws/handlers/pet-reaction.ts 的接口约定），图片要进模型得走 provider 内部的
 * VisionFrame 注入，那条路是给"用户聊天时发图"设计的，不适合服务端主动调。
 * 这里直接走 OpenAI 兼容的 chat/completions，输入一张图，返回一段文字。
 *
 * 三个诚实约定：
 *   1. 解析不到可用配置 → 返回 null（不装配），capability() 如实报 vision:false。
 *   2. 当前的模型不支持 image_url → 也返回 null。纯文本模型传图必 400，
 *      与其让用户等 30 秒再看到"请求失败"，不如入口处就说"没有可用的视觉模型"。
 *   3. 网络/接口失败 → 抛出带原因的错误，由 extractImage 转成用户可读文案。
 */

import { modelSupportsVision } from "../external-model/vision-support.js";
import type { IngestVisionExtract } from "./ingest-extractors.js";
import { resolveDesktopVisualVlmConfig } from "./desktop-visual-vlm-config.js";

/** 单次读图的硬超时：截图上传来是用户在现场等，30s 已经够宽容。 */
const VISION_TIMEOUT_MS = 30_000;

export function createIngestVisionExtract(
  env: NodeJS.ProcessEnv = process.env,
): IngestVisionExtract | null {
  const cfg = resolveDesktopVisualVlmConfig(env);
  if (!cfg || !cfg.apiKey) return null;
  if (!modelSupportsVision(cfg.model)) return null;

  // baseUrl 已被 resolveDesktopVisualVlmConfig 去掉 /v1 后缀
  const endpoint = `${cfg.baseUrl}/v1/chat/completions`;

  return async (imageBase64: string, mimeType: string, prompt: string): Promise<string> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), VISION_TIMEOUT_MS);
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${cfg.apiKey}`,
        },
        body: JSON.stringify({
          model: cfg.model,
          temperature: 0,
          max_tokens: 2000,
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: prompt },
                {
                  type: "image_url",
                  image_url: { url: `data:${mimeType};base64,${imageBase64}` },
                },
              ],
            },
          ],
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`视觉模型返回 ${res.status}${body ? `：${body.slice(0, 200)}` : ""}`);
      }
      const json = (await res.json()) as {
        choices?: Array<{ message?: { content?: unknown } }>;
      };
      const content = json.choices?.[0]?.message?.content;
      if (typeof content === "string") return content;
      // 少数 provider 返回 content 数组（分块），拼起来
      if (Array.isArray(content)) {
        return content
          .map((part) =>
            part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
              ? (part as { text: string }).text
              : "",
          )
          .join("");
      }
      throw new Error("视觉模型没有返回文本内容");
    } catch (e) {
      if (e instanceof Error && e.name === "AbortError") {
        throw new Error(`读图超时（${VISION_TIMEOUT_MS}ms）`);
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  };
}
