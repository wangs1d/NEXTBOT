import { readFile } from "node:fs/promises";

import OpenAI from "openai";

import type { ImageAsset, PictureKit } from "@private-ai-agent/picture";

import { resolvePrimaryLlmClientConfig, bypassChatRequestExtras } from "../external-model/resolve-provider.js";
import { modelSupportsVision } from "../external-model/vision-support.js";
import { auditChatCompletion } from "./llm-token-audit.js";

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * 照片视觉分析管线（照片墙「贴墙」A 面智能层）。
 *
 * 给没有地点/描述的照片补视觉理解：一句氛围短句（caption）、场景类型、
 * 从画面线索推断的地点（place）。结果写回 ImageAsset.analysis 并随
 * index.json 持久化——一次性成本，贴墙布局与聊天媒体卡都直接复用。
 *
 * 降级策略（宁可没有，不可错位）：
 *   - 主模型不支持视觉 / 未配置密钥 / 调用失败 → 单张跳过，不写 analysis，
 *     照片仍按 EXIF/上传时间贴墙，只是没有地点与短句。
 *   - place 只在画面可辨认（地标/店招/文字线索）时才填，推断不了留空。
 *
 * 成本控制：批量看图（一次 VLM 调用 ≤6 张）、单次调用上限（limit）、
 * 压缩到宽 640 再注入；由墙页/工具显式触发，不静默烧 token。
 */

/** 单张图注入前的压缩宽（控制视觉 token） */
const ANALYSIS_IMAGE_WIDTH = 640;

/** 一次 VLM 调用最多看的图数（保证第 i 句 = 第 i 张图的顺序对应） */
const BATCH_SIZE = 6;

/** 单张分析超时（批量调用整体预算 = 覆盖张数 × 单张预算，封顶 60s） */
const ANALYSIS_TIMEOUT_MS = 45_000;

export interface PhotoAnalysisResult {
  analyzed: number;
  failed: number;
  remaining: number;
}

/** 解析 EXIF GPS 度分秒（"31 deg 13' 22.32\" N"）→ 十进制度；解析不了返回 null */
export function parseExifGps(value: string | undefined, ref: string | undefined): number | null {
  if (!value) return null;
  const m = value.match(/([\d.]+)\s*deg\s*([\d.]+)?'?\s*([\d.]+)?/i);
  if (!m) return null;
  const deg = Number(m[1]);
  const min = Number(m[2] ?? 0);
  const sec = Number(m[3] ?? 0);
  if (!Number.isFinite(deg)) return null;
  let decimal = deg + min / 60 + sec / 3600;
  const hemisphere = (ref ?? "").trim().toUpperCase();
  if (hemisphere === "S" || hemisphere === "W") decimal = -decimal;
  return Math.round(decimal * 1e6) / 1e6;
}

function exifGps(asset: ImageAsset): { latitude: number; longitude: number } | null {
  const lat = parseExifGps(asset.exif?.["GPS Latitude"], asset.exif?.["GPS Latitude Ref"]);
  const lng = parseExifGps(asset.exif?.["GPS Longitude"], asset.exif?.["GPS Longitude Ref"]);
  if (lat === null || lng === null) return null;
  return { latitude: lat, longitude: lng };
}

/** 读原图并压缩（宽 ≤640 JPEG）；失败返回 null（该张跳过） */
async function loadCompressedImage(filePath: string): Promise<string | null> {
  try {
    const buf = await readFile(filePath);
    const { default: sharp } = await import("sharp");
    const out = await sharp(buf, { animated: false })
      .rotate()
      .resize({ width: ANALYSIS_IMAGE_WIDTH, withoutEnlargement: true })
      .jpeg({ quality: 80 })
      .toBuffer();
    return out.toString("base64");
  } catch {
    return null;
  }
}

interface PhotoAnalysisItem {
  scene: string;
  place: string;
  caption: string;
}

/** 解析 VLM 的 JSON（容忍围栏），返回定长数组；缺项为 null 字段 */
function parseAnalysisArray(raw: string, expected: number): Array<PhotoAnalysisItem | null> {
  const out: Array<PhotoAnalysisItem | null> = new Array(expected).fill(null);
  if (!raw) return out;
  let text = raw.trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) text = fenced[1].trim();
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start >= 0 && end > start) text = text.slice(start, end + 1);
  try {
    const list = JSON.parse(text) as unknown;
    if (!Array.isArray(list)) return out;
    for (let i = 0; i < expected && i < list.length; i++) {
      const item = list[i] as Record<string, unknown> | null;
      if (!item || typeof item !== "object") continue;
      const scene = String(item.scene ?? "").trim().slice(0, 24);
      const place = String(item.place ?? "").trim().slice(0, 24);
      const caption = String(item.caption ?? "").trim().replace(/[：:—–、，,；;]+$/u, "").slice(0, 40);
      out[i] = { scene, place, caption };
    }
  } catch {
    // JSON 损坏：整批放弃（全 null），调用方按失败计
  }
  return out;
}

/** VLM 看图注入点（测试可替换） */
export type PhotoAnalyzeFn = (
  images: string[],
  timeoutMs: number,
) => Promise<Array<PhotoAnalysisItem | null>>;

/** 默认 VLM 批量看图实现（与主对话同源 provider） */
function defaultAnalyzeFn(images: string[], timeoutMs: number): Promise<Array<PhotoAnalysisItem | null>> {
  return (async () => {
    const cfg = resolvePrimaryLlmClientConfig();
    if (!cfg || !cfg.model || !modelSupportsVision(cfg.model)) {
      throw new Error("主模型不支持视觉或未配置");
    }
    const client = new OpenAI({
      apiKey: cfg.apiKey,
      baseURL: cfg.baseURL,
      timeout: timeoutMs,
      maxRetries: 0,
    });
    const content: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [
      {
        type: "text",
        text: [
          `下面按顺序给出 ${images.length} 张照片，请逐张输出 JSON 数组，每项字段：`,
          `{"scene":"场景类型（室内/室外/城市/自然/聚会/美食/截图/文档 等，≤8字）","place":"地点（仅当画面可辨认——地标/店招/文字线索——才填，如「大理古城」；辨认不了填空串，禁止编造）","caption":"一句氛围短句（12~30字，写光线/色调/情绪的瞬间感；禁止穿搭清单式罗列；不带前缀不带编号）"}`,
          ``,
          `只输出 JSON 数组，长度必须等于 ${images.length}，顺序与图片顺序一致。`,
        ].join("\n"),
      },
    ];
    for (const base64 of images) {
      content.push({
        type: "image_url",
        image_url: { url: `data:image/jpeg;base64,${base64}` },
      });
    }
    const resp = await client.chat.completions.create({
      model: cfg.model,
      messages: [
        { role: "system", content: "你是照片整理助手，输出严格的 JSON。" },
        { role: "user", content },
      ],
      temperature: 0.3,
      ...bypassChatRequestExtras(),
    });
    auditChatCompletion({
      stage: "vision_photo",
      messages: [
        { role: "system", content: "你是照片整理助手，输出严格的 JSON。" },
        { role: "user", content },
      ],
      completion: resp,
      model: cfg.model,
    });
    return parseAnalysisArray(resp.choices?.[0]?.message?.content ?? "", images.length);
  })();
}

/**
 * 分析图库里缺分析结果的照片（新照片优先），结果写回资产索引。
 *
 * @returns analyzed/failed/remaining；provider 不可用或全部失败时
 *          analyzed=0，调用方展示引导文案。
 */
export async function analyzePendingPhotos(
  pictureKit: PictureKit,
  opts: {
    /** 本次最多分析张数（默认 12，控制成本） */
    limit?: number;
    /** VLM 注入点（测试用） */
    analyzeFn?: PhotoAnalyzeFn;
    /** 单次调用看图张数（测试可调小） */
    batchSize?: number;
  } = {},
): Promise<PhotoAnalysisResult> {
  const limit = Math.max(1, Math.min(60, opts.limit ?? 12));
  const batchSize = Math.max(1, Math.min(BATCH_SIZE, opts.batchSize ?? BATCH_SIZE));
  const analyze = opts.analyzeFn ?? defaultAnalyzeFn;

  const all = pictureKit.store.listAll();
  const pending = all
    .filter((a) => !a.analysis?.analyzedAt)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .slice(0, limit);
  const remaining = all.filter((a) => !a.analysis?.analyzedAt).length - pending.length;

  let analyzed = 0;
  let failed = 0;

  for (let i = 0; i < pending.length; i += batchSize) {
    const batch = pending.slice(i, i + batchSize);
    const images: string[] = [];
    const loadedAssets: ImageAsset[] = [];
    for (const asset of batch) {
      const img = await loadCompressedImage(asset.filePath);
      if (img !== null) {
        images.push(img);
        loadedAssets.push(asset);
      } else {
        failed += 1;
      }
    }
    if (images.length === 0) continue;

    let items: Array<PhotoAnalysisItem | null>;
    try {
      items = await analyze(images, ANALYSIS_TIMEOUT_MS);
    } catch (err) {
      console.info(
        `[photo-analysis] 批量看图失败（跳过 ${images.length} 张）: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      failed += images.length;
      continue;
    }

    for (let j = 0; j < loadedAssets.length; j++) {
      const asset = loadedAssets[j]!;
      const item = items[j];
      const gps = exifGps(asset);
      await pictureKit.store.setAnalysis(asset.id, {
        scene: item?.scene || null,
        place: item?.place || null,
        caption: item?.caption || null,
        analyzedAt: nowIso(),
        ...(gps ? { latitude: gps.latitude, longitude: gps.longitude } : {}),
      });
      analyzed += 1;
    }
  }

  const after = pictureKit.store.listAll().filter((a) => !a.analysis?.analyzedAt).length;
  return { analyzed, failed, remaining: after };
}

/** 路由侧便捷查询：还有多少张待分析 */
export function countPendingAnalysis(pictureKit: PictureKit): number {
  return pictureKit.store.listAll().filter((a) => !a.analysis?.analyzedAt).length;
}

/** 测试/调试用：确认目录拼接语义（与 pictureKit rootDir 约定一致） */
export function analysisIndexInfo(pictureKit: PictureKit): { rootDir: string; count: number } {
  return { rootDir: pictureKit.store.rootDir, count: pictureKit.store.listAll().length };
}
