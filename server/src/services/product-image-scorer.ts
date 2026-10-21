/**
 * 商品图 VLM 质检选图（推荐线图片第二优先级的「选图裁判」）。
 *
 * 语境：推荐候选缺官方主图时走网搜补图，但通用网搜图常混入人群场景图、
 * 带大片促销文字/水印的营销图、多商品拼图——都不能单独展示产品。本模块
 * 一次 VLM 调用给 N 张候选图打分，选出最适合作为「商品主体图」的一张；
 * VLM 不可用/超时/输出非法时返回 null，调用方取第 1 张兜底（不阻断推荐）。
 *
 * 与 image-caption-service 同源：同一个主模型配置（resolvePrimaryLlmClientConfig
 * + modelSupportsVision），同一套本地直读/远程限时下载取图（loadImageBytes）。
 */

import OpenAI from "openai";

import { loadImageBytes } from "./image-caption-service.js";
import { resolvePrimaryLlmClientConfig, bypassChatRequestExtras } from "../external-model/resolve-provider.js";
import { modelSupportsVision } from "../external-model/vision-support.js";
import { auditChatCompletion } from "./llm-token-audit.js";

export interface ProductImageCandidate {
  /** 可被 loadImageBytes 读取的图地址（本地 /agent/images/... 或远程 URL） */
  url: string;
}

export type ProductImageScore = {
  bestIndex: number;
  scores: Array<{ index: number; score: number; why: string }>;
};

const SCORE_TIMEOUT_MS = 6_000;

/**
 * 对候选图打分并选出最佳「商品主体图」。
 * 全部候选得分 ≤0、VLM 不可用或调用失败时返回 null（调用方取首图兜底）。
 * describeFn 仅供测试注入（绕过真实 VLM 调用）。
 */
export async function pickBestProductImage(
  candidates: ProductImageCandidate[],
  opts: {
    productName?: string;
    timeoutMs?: number;
    describeFn?: (images: string[], productName: string) => Promise<string>;
  } = {},
): Promise<ProductImageScore | null> {
  const urls = candidates.map((c) => String(c.url ?? "").trim()).filter(Boolean);
  if (urls.length === 0) return null;

  const productName = String(opts.productName ?? "").trim();

  let raw: string;
  if (opts.describeFn) {
    try {
      raw = await opts.describeFn(urls, productName);
    } catch {
      return null; // VLM 失败 → 调用方取首图兜底，不阻断推荐
    }
  } else {
    const cfg = resolvePrimaryLlmClientConfig();
    if (!cfg || !cfg.model || !modelSupportsVision(cfg.model)) return null;

    const images: Array<{ base64: string; mime: string }> = [];
    for (const url of urls) {
      const img = await loadImageBytes(url);
      if (!img) return null; // 与 caption 同纪律：保不了顺序一致性就整批放弃
      images.push(img);
    }

    const timeoutMs = opts.timeoutMs ?? SCORE_TIMEOUT_MS;
    const client = new OpenAI({
      apiKey: cfg.apiKey,
      baseURL: cfg.baseURL,
      timeout: timeoutMs,
      maxRetries: 0,
    });
    const content: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [
      {
        type: "text",
        text: `下面按顺序给出 ${images.length} 张候选商品图${productName ? `（商品：${productName}）` : ""}，请为每张打分。`,
      },
      ...images.map((img) => ({
        type: "image_url" as const,
        image_url: { url: `data:${img.mime};base64,${img.base64}` },
      })),
    ];
    const scorerSystem = [
      "你是电商推荐的「商品图质检员」。判断每张图是否适合单独展示该商品（作为推荐卡的主图）。",
      "评分标准（0-10 整数）：",
      "+ 白底/纯色背景、商品居中完整：8-10；普通商品实拍图且商品是画面主体：5-7。",
      "- 大段促销文字/水印/价格标签贴图：-4；多商品拼图或对比图：-3；人群/生活场景为主、商品是配角：-3；截图/新闻图/与商品无关：0。",
      "只输出 JSON：{\"scores\":[{\"i\":0,\"score\":8,\"why\":\"白底主体图\"},...]}，i 对应图片顺序（0 起），数组长度等于图片张数；不要输出 JSON 以外的任何文字。",
    ].join("\n");
    const resp = await client.chat.completions.create({
      model: cfg.model,
      messages: [
        { role: "system", content: scorerSystem },
        { role: "user", content },
      ],
      temperature: 0.1,
      ...bypassChatRequestExtras(),
    });
    auditChatCompletion({
      stage: "vision_product",
      messages: [
        { role: "system", content: scorerSystem },
        { role: "user", content },
      ],
      completion: resp,
      model: cfg.model,
    });
    raw = (resp.choices?.[0]?.message?.content ?? "").trim();
  }

  return parseScoreResponse(raw, urls.length);
}

/** 解析打分 JSON（容忍围栏/杂文本）；非法输出返回 null。 */
export function parseScoreResponse(raw: string, expected: number): ProductImageScore | null {
  if (!raw) return null;
  let text = raw.trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) text = fenced[1].trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) text = text.slice(start, end + 1);
  let parsed: { scores?: unknown };
  try {
    parsed = JSON.parse(text) as { scores?: unknown };
  } catch {
    return null;
  }
  const list = Array.isArray(parsed?.scores) ? parsed.scores : [];
  const scores: ProductImageScore["scores"] = [];
  for (const item of list) {
    if (typeof item !== "object" || item === null) continue;
    const idx = (item as { i?: unknown }).i;
    const score = (item as { score?: unknown }).score;
    if (typeof idx !== "number" || idx < 0 || idx >= expected) continue;
    if (typeof score !== "number" || !Number.isFinite(score)) continue;
    scores.push({
      index: idx,
      score: Math.round(score),
      why: String((item as { why?: unknown }).why ?? "").slice(0, 40),
    });
  }
  if (scores.length === 0) return null;
  // 兜底：模型漏打的图记 0 分，保证 bestIndex 有全量候选可比
  const byIndex = new Map(scores.map((s) => [s.index, s]));
  const full = Array.from({ length: expected }, (_, i) => byIndex.get(i) ?? { index: i, score: 0, why: "未评估" });
  const best = full.reduce((acc, s) => (s.score > acc.score ? s : acc), full[0]!);
  if (!best || best.score <= 0) return null;
  return { bestIndex: best.index, scores: full };
}
