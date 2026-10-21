import type { FastifyInstance } from "fastify";
import OpenAI from "openai";

import {
  resolvePrimaryLlmClientConfig,
  bypassChatRequestExtras,
} from "../../external-model/resolve-provider.js";
import { modelSupportsVision } from "../../external-model/vision-support.js";
import { auditChatCompletion } from "../../services/llm-token-audit.js";

/**
 * 在座检测端点（电脑开机简报门禁）。
 *
 * 用途：桌面端开机时若开启了「简报前检测在座」，用摄像头抓拍一帧发给本端点，
 * 由视觉模型判断「用户是否正坐在电脑前」——在座才播报早间简报；
 * 无摄像头/未授权的设备不调用本端点，开机直接播报。
 *
 * 隐私：图片仅在内存中用于本次判定，不落盘、不留存、不进记忆。
 *
 * 判定链路与 image-caption-service 同源：主对话模型（支持视觉时）单次调用，
 * 严格 JSON 输出。未配置视觉模型/调用失败 → ok:false（客户端视为「无法判定」，
 * 失败放行，不阻塞简报）。
 */

/** 图片 base64 上限（约 4MB 解码后 ~5.3MB，摄像头一帧远小于此） */
const IMAGE_BASE64_MAX = 5_600_000;
/** 单次判定超时：门禁在开机链路上轮询调用，必须快速返回 */
const DETECT_TIMEOUT_MS = 12_000;

const PRESENCE_SYSTEM_PROMPT = [
  "你是电脑前的在座检测器。给你一张电脑摄像头拍下的画面，判断用户是否正坐在电脑前。",
  "",
  "判定 true：画面中能清晰看到至少一个人（脸部或上半身）。",
  "判定 false：画面里没有人、只有空椅子/背景、画面被遮挡或过曝/过暗无法判断。",
  "",
  '只输出 JSON：{"present": true} 或 {"present": false}，不要输出任何其他文字。',
].join("\n");

/** 在座判定结果：ok=false 表示无法判定（客户端失败放行） */
export interface PresenceVerdict {
  ok: boolean;
  present?: boolean;
  reason?: string;
}

/**
 * 解析视觉模型输出为布尔在座判定（容忍 ```json 围栏与前后杂文本）。
 * 解析不出 true/false 返回 null。
 */
export function parsePresenceVerdict(raw: string): boolean | null {
  let text = (raw ?? "").trim();
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) text = fenced[1].trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) text = text.slice(start, end + 1);
  try {
    const parsed = JSON.parse(text) as { present?: unknown };
    if (typeof parsed?.present === "boolean") return parsed.present;
    if (parsed?.present === "true") return true;
    if (parsed?.present === "false") return false;
  } catch {
    // fall through to bare-token fallback
  }
  // 裸 true/false 输出兜底
  if (/^\s*true\s*$/i.test(text)) return true;
  if (/^\s*false\s*$/i.test(text)) return false;
  return null;
}

/** 视觉模型不可用（未配置/不支持视觉）——与调用异常区分开供客户端归因 */
class VisionUnavailableError extends Error {}

/** 默认 VLM 调用器：主对话模型（支持视觉时）单次调用 */
async function defaultVlmCaller(image: {
  base64: string;
  mimeType: string;
}): Promise<string> {
  const cfg = resolvePrimaryLlmClientConfig();
  if (!cfg || !cfg.model || !modelSupportsVision(cfg.model)) {
    throw new VisionUnavailableError();
  }
  const client = new OpenAI({
    apiKey: cfg.apiKey,
    baseURL: cfg.baseURL,
    timeout: DETECT_TIMEOUT_MS,
    maxRetries: 0,
  });
  const resp = await client.chat.completions.create({
    model: cfg.model,
    messages: [
      { role: "system", content: PRESENCE_SYSTEM_PROMPT },
      {
        role: "user",
        content: [
          { type: "text", text: "判断这张摄像头画面里是否有人坐在电脑前。" },
          {
            type: "image_url",
            image_url: { url: `data:${image.mimeType};base64,${image.base64}` },
          },
        ],
      },
    ],
    temperature: 0,
    ...bypassChatRequestExtras(),
  });
  // 视觉类只计文本规模：base64 图片无法按字符折算 token，且避免二次拼接大字符串
  auditChatCompletion({
    stage: "vision_presence",
    messages: [
      { role: "system", content: PRESENCE_SYSTEM_PROMPT },
      { role: "user", content: [{ type: "text", text: "判断这张摄像头画面里是否有人坐在电脑前。" }] },
    ],
    completion: resp,
    model: cfg.model,
  });
  return (resp.choices?.[0]?.message?.content ?? "").trim();
}

/**
 * 摄像头帧在座判定。
 * `callVlm` 可注入替身（测试）；默认走主对话视觉模型。
 */
export async function detectPersonAtDesk(
  input: {
    imageBase64: string;
    mimeType?: string;
  },
  callVlm: (image: { base64: string; mimeType: string }) => Promise<string> = defaultVlmCaller,
): Promise<PresenceVerdict> {
  const imageBase64 = (input.imageBase64 ?? "").trim();
  if (!imageBase64) {
    return { ok: false, reason: "imageBase64 required" };
  }
  if (imageBase64.length > IMAGE_BASE64_MAX) {
    return { ok: false, reason: "image too large" };
  }
  const mimeType = /^image\/(jpeg|png|webp)$/.test(input.mimeType ?? "")
    ? (input.mimeType as string)
    : "image/jpeg";

  try {
    const raw = await callVlm({ base64: imageBase64, mimeType });
    const present = parsePresenceVerdict(raw);
    if (present === null) {
      return { ok: false, reason: "unparsable_verdict" };
    }
    return { ok: true, present };
  } catch (err) {
    if (err instanceof VisionUnavailableError) {
      return { ok: false, reason: "vision_model_unavailable" };
    }
    return {
      ok: false,
      reason: `vlm_error:${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export function registerPresenceDetectRoutes(app: FastifyInstance): void {
  app.post("/api/presence/detect", async (request, reply) => {
    const body = (request.body ?? {}) as {
      sessionId?: string;
      imageBase64?: string;
      mimeType?: string;
    };
    if (!body.imageBase64) {
      return reply.code(400).send({ ok: false, error: "imageBase64 required" });
    }
    const verdict = await detectPersonAtDesk({
      imageBase64: body.imageBase64,
      mimeType: body.mimeType,
    });
    if (!verdict.ok) {
      // 无法判定（未配置视觉模型/调用失败）→ 200 + ok:false，客户端失败放行
      return { ok: false, reason: verdict.reason };
    }
    return { ok: true, present: verdict.present };
  });
}
