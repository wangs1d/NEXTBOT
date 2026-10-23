/**
 * 识图回复的照片卡（Coze 式「一图一句」确定性绑定）。
 *
 * 用户需求（2026-09-15）：识图/拍照轮次的回复不再走「🔍徽标 + 结论 + 要点」
 * 的散文形态，而是**每张照片下面只有一句对当前照片的介绍**。
 * 风格修正（2026-09-16 用户反馈）：介绍要传达**照片中的感觉**（光线、氛围、
 * 情绪），不是「女子穿什么」式的外观/穿搭清单——由 caption 提示词约束。
 *
 * 机制（与 mediaCards 的 caption 链路同构，代码确定性生成、不依赖 LLM 正文）：
 *   1. 本轮用户发来的 visionFrames（base64 帧，此前从不落盘）逐张落盘到
 *      data/images/{actorId}/，得到 /agent/images/{actorId}/... 可访问 URL；
 *   2. 复用 image-caption-service 的 VLM 批量看图，为每张生成一句描述
 *      （支持 locationHint 拍摄位置参考）；
 *   3. 以 [IMAGE_RESULT_START]{items:[{url,caption}]}[IMAGE_RESULT_END]
 *      结构化块附着在 [RENDER_AS:image_result] 回复上——照片与描述作为
 *      结构化数据绑定下发，客户端按「照片卡片 + 下方描述」渲染，
 *      不再展示「结论强调条 + 要点正文」。
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getDataDir } from "../config/data-dir.js";

import type { VisionFrame } from "../external-model/types.js";
import { captionMediaCards, type CaptionOptions } from "./image-caption-service.js";
import type { MediaCardItem } from "./tool-result-processor.js";

/** 识图照片项：照片 URL + 该照片自己的描述（可为空，客户端只渲染有值的） */
export interface VisionPhotoItem {
  url: string;
  caption: string;
}

/** 结构化标记（v1 文本传输，与 AGENT_RESULT_CARD 同语义） */
export const IMAGE_RESULT_START = "[IMAGE_RESULT_START]";
export const IMAGE_RESULT_END = "[IMAGE_RESULT_END]";

/** 帧落盘子目录（位于统一数据目录下，与 image-files 路由的 images/ 约定一致） */
const IMAGES_DIR = "images";

function extForMime(mimeType: string | undefined): string {
  const m = (mimeType ?? "").toLowerCase();
  if (m.includes("png")) return ".png";
  if (m.includes("webp")) return ".webp";
  if (m.includes("gif")) return ".gif";
  return ".jpg";
}

/**
 * 把本轮 visionFrames 落盘，返回可访问 URL（/agent/images/{actorId}/{file}）。
 * 单帧失败跳过（不影响其他帧）；全部失败返回空数组。
 */
export async function persistVisionFrames(
  actorId: string,
  frames: VisionFrame[],
  baseDir: string = getDataDir(),
): Promise<string[]> {
  const safeActor = actorId.replace(/[^A-Za-z0-9_-]/g, "");
  if (!safeActor || frames.length === 0) return [];
  const dir = join(baseDir, IMAGES_DIR, safeActor);
  let created = false;
  const urls: string[] = [];
  const stamp = Date.now();
  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i];
    const base64 = (frame?.dataBase64 ?? "").trim();
    if (!base64) continue;
    try {
      if (!created) {
        await mkdir(dir, { recursive: true });
        created = true;
      }
      const fileName = `vision-${stamp}-${i}${extForMime(frame.mimeType)}`;
      await writeFile(join(dir, fileName), Buffer.from(base64, "base64"));
      urls.push(`/agent/images/${safeActor}/${fileName}`);
    } catch {
      // 单帧落盘失败：跳过，宁缺毋滥
    }
  }
  return urls;
}

/**
 * 构建识图照片卡：落盘 + VLM 逐张描述。
 * caption 生成失败/超时/未配置视觉模型 → caption 为空串（照片照常下发）。
 */
export async function buildVisionPhotoCards(opts: {
  actorId: string;
  frames: VisionFrame[];
  /** 拍摄位置参考（如「上海市徐汇区」），仅在画面一致时 caption 才会带出 */
  locationHint?: string;
  /** 帧落盘根目录（测试注入用） */
  baseDir?: string;
  /** 人格参照（本轮用户原话 + agent 已说出口的正文），caption 用 agent 自己的口吻写 */
  voice?: { userText?: string; replyText?: string };
  /** caption 生成注入点（测试注入用） */
  captioner?: (cards: MediaCardItem[], timeoutMs: number) => Promise<string[]>;
  timeoutMs?: number;
}): Promise<VisionPhotoItem[]> {
  const urls = await persistVisionFrames(opts.actorId, opts.frames, opts.baseDir);
  if (urls.length === 0) return [];

  const cards: MediaCardItem[] = urls.map((url) => ({
    type: "image",
    title: "",
    thumbnailUrl: url,
    mediaUrl: url,
  }));

  const captionOpts: CaptionOptions = { locationHint: opts.locationHint, voice: opts.voice };
  if (opts.captioner) captionOpts.describeFn = opts.captioner;
  if (opts.timeoutMs != null) captionOpts.timeoutMs = opts.timeoutMs;
  try {
    await captionMediaCards(cards, captionOpts);
  } catch {
    // caption 失败不阻塞照片下发（客户端只渲染有 caption 的描述行）
  }

  return cards.map((c) => ({
    url: (c.thumbnailUrl || c.mediaUrl || "").trim(),
    caption: (c.caption ?? "").trim(),
  }));
}

/** 构建结构化照片卡块：[IMAGE_RESULT_START]{items:[{url,caption}]}[END] */
export function buildImageResultBlock(items: VisionPhotoItem[]): string {
  const payload = JSON.stringify({
    items: items.map((it) => ({ url: it.url, caption: it.caption })),
  });
  return `${IMAGE_RESULT_START}\n${payload}\n${IMAGE_RESULT_END}`;
}

/**
 * 把照片卡块附着到识图回复上（确定性，重复防护）。
 * 附着位置：[RENDER_AS:image_result] 行之后（紧跟形态声明，客户端最先解析）；
 * 无该行时附着在文本最前面。已存在照片卡块时不重复附着。
 */
export function attachImageResultPhotos(
  text: string,
  items: VisionPhotoItem[],
): string {
  if (items.length === 0) return text;
  if (text.includes(IMAGE_RESULT_START)) return text;
  const block = buildImageResultBlock(items);
  const trimmed = text.trim();
  const renderAsRe = /^(\[RENDER_AS:image_result\][^\n]*\n)/;
  const m = trimmed.match(renderAsRe);
  if (m) {
    return `${m[1]}\n${block}\n\n${trimmed.slice(m[1].length).trim()}`.trim();
  }
  return `${block}\n\n${trimmed}`.trim();
}
