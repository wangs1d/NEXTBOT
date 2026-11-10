/**
 * 图片相关性 VLM 重排（P0-2，2026-11-08）。
 *
 * 背景：主对话模型切到 glm-5.3-flash 后不支持视觉，`image-caption` 整链跳过，
 * 于是「图片转存成功」等价于「图片内容正确」，爬虫跑偏时灯塔/地图/素材图会
 * 顶着人物 query 直接展示给用户。
 *
 * 本模块提供**独立于主模型**的像素级复核：用智谱视觉模型（默认 glm-4v-flash，
 * 与 ZHIPU_API_KEY 同源）逐张判断候选图是否与 query 主题相符，把相符的排到前面。
 *
 * 设计约束（保证「用户一定能拿到图片」）：
 *  - 只重排、不删除，返回数组长度恒等于输入长度；
 *  - 任何失败（未配置 key / 超时 / 读图失败 / 解析失败 / HTTP 错误）静默降级，
 *    原序返回，绝不把结果清空；
 *  - 并行逐张调用（GLM-4V 系列多图输入兼容性不稳），总耗时由 timeoutMs 卡死。
 *
 * 开关：IMAGE_VLM_RERANK_ENABLED=0 关闭；IMAGE_VLM_API_KEY / _MODEL / _BASE_URL
 * 可覆盖，缺省复用 ZHIPU_API_KEY / ZHIPU_BASE_URL。
 */

import { loadImageBytes } from "./image-caption-service.js";

type ImageItemLike = {
  title: string;
  mediaUrl?: string;
  thumbnailUrl?: string;
  pageUrl?: string;
};

export type VlmRerankResult<T> = {
  items: T[];
  applied: boolean;
  reason?: string;
};

const DEFAULT_BASE_URL = "https://open.bigmodel.cn/api/paas/v4";
const DEFAULT_MODEL = "glm-4v-flash";
/** 一次最多看几张：控制视觉 token 与整体延迟 */
const MAX_VLM_IMAGES = 3;

function resolveConfig(): { apiKey: string; baseUrl: string; model: string } | null {
  if ((process.env.IMAGE_VLM_RERANK_ENABLED ?? "1").trim() === "0") return null;
  const apiKey = (process.env.IMAGE_VLM_API_KEY ?? process.env.ZHIPU_API_KEY ?? "").trim();
  if (!apiKey) return null;
  let baseUrl = (process.env.IMAGE_VLM_BASE_URL ?? process.env.ZHIPU_BASE_URL ?? DEFAULT_BASE_URL)
    .trim()
    .replace(/\/+$/, "");
  if (!baseUrl) baseUrl = DEFAULT_BASE_URL;
  const model = (process.env.IMAGE_VLM_MODEL ?? DEFAULT_MODEL).trim() || DEFAULT_MODEL;
  return { apiKey, baseUrl, model };
}

function endpoint(baseUrl: string): string {
  return baseUrl.endsWith("/chat/completions") ? baseUrl : `${baseUrl}/chat/completions`;
}

/** 单张图二分类：1=与主题相符，0=跑偏（风景/地图/截图/水印素材/无关题材）。 */
async function scoreOne(
  item: ImageItemLike,
  query: string,
  cfg: { apiKey: string; baseUrl: string; model: string },
  timeoutMs: number,
): Promise<number> {
  const url = (item.mediaUrl || item.thumbnailUrl || "").trim();
  if (!url) return 0;
  const img = await loadImageBytes(url);
  if (!img) return 0;
  const prompt =
    `判断这张图片是否与搜索主题「${query.slice(0, 60)}」相符：` +
    "图中主体应是该人物/事物的真实照片，而不是风景、地图、文档截图、带水印的素材图或完全无关的题材。" +
    "只回答一个字符：1=相符，0=不符。";
  const res = await fetch(endpoint(cfg.baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify({
      model: cfg.model,
      max_tokens: 4,
      messages: [{
        role: "user",
        content: [
          { type: "image_url", image_url: { url: `data:${img.mime};base64,${img.base64}` } },
          { type: "text", text: prompt },
        ],
      }],
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) return 0;
  const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const text = String(json.choices?.[0]?.message?.content ?? "");
  return text.includes("1") ? 1 : 0;
}

/**
 * 像素级复核重排。稳定排序：判为相符的候选前移，其余保持原顺序。
 * 失败时返回 { items: 原数组, applied: false }。
 */
export async function rerankImagesByVlm<T extends ImageItemLike>(
  items: T[],
  query: string,
  timeoutMs = 2_200,
): Promise<VlmRerankResult<T>> {
  if (items.length === 0) return { items, applied: true, reason: "empty" };
  const cfg = resolveConfig();
  if (!cfg) return { items, applied: false, reason: "disabled-or-no-key" };

  const head = items.slice(0, MAX_VLM_IMAGES);
  let scores: number[];
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // 整体硬限时：读图 + N 次 VLM 调用共用一个预算，避免拖过 search_images 的 12s 工具预算。
    const work = Promise.all(
      head.map(async (it) => {
        try {
          return await scoreOne(it, query, cfg, timeoutMs);
        } catch {
          return 0;
        }
      }),
    );
    scores = await Promise.race([
      work,
      new Promise<number[]>((resolve) => {
        timer = setTimeout(() => resolve(head.map(() => 0)), timeoutMs);
      }),
    ]);
  } catch {
    return { items, applied: false, reason: "vlm-failed" };
  } finally {
    if (timer) clearTimeout(timer);
  }

  if (scores.every((s) => s === 0)) {
    return { items, applied: true, reason: "all-irrelevant-keep-order" };
  }
  const order = head.map((it, i) => ({ it, i, score: scores[i] ?? 0 }));
  order.sort((a, b) => b.score - a.score || a.i - b.i);
  return {
    items: [...order.map((x) => x.it), ...items.slice(MAX_VLM_IMAGES)],
    applied: true,
    reason: "reranked",
  };
}
