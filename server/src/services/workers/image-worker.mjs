/**
 * image.generate Worker 脚本：在独立线程中调用图像生成 API + 下载图片。
 *
 * 接收 { id, type, payload } 消息，执行后返回 { id, ok, result | error }。
 * 故障隔离：API 调用异常/超时不影响主进程。
 *
 * payload: { prompt, actorId, options: { model?, imageSize?, batchSize? } }
 */

import { parentPort, workerData } from "node:worker_threads";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

// 数据目录由主进程经 workerData 注入（config/data-dir 统一解析）
const storageRoot = join(workerData.dataDir, "images");

/** 读取正整数 env，非法/缺省回落默认值。 */
function positiveInt(raw, fallback) {
  const n = Number.parseInt(String(raw ?? "").trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

async function generateImage(payload) {
  const { prompt, actorId, options = {} } = payload;
  const apiKey = process.env.OPENAI_API_KEY ?? "";
  const baseUrl = (
    process.env.IMAGE_GEN_BASE_URL?.trim() ||
    process.env.OPENAI_BASE_URL?.trim() ||
    "https://api.openai.com/v1"
  ).replace(/\/+$/, "");

  if (!apiKey) {
    return { ok: false, error: "OPENAI_API_KEY 未配置" };
  }
  if (!prompt?.trim()) {
    return { ok: false, error: "prompt 不能为空" };
  }

  const model = options.model ?? process.env.IMAGE_GEN_MODEL?.trim() ?? "dall-e-3";
  const imageSize = options.imageSize ?? "1024x1024";
  const batchSize = Math.max(1, Math.min(4, options.batchSize ?? 1));

  // 调用 OpenAI 兼容 images 接口（60s 超时）
  const res = await fetch(`${baseUrl}/images/generations`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ model, prompt, size: imageSize, n: batchSize }),
    signal: AbortSignal.timeout(60_000),
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    return { ok: false, error: `图像生成失败：HTTP ${res.status} ${txt.slice(0, 200)}` };
  }

  const data = await res.json();
  const images = (data.data ?? data.images ?? []).filter((img) => img.url?.length > 0);
  if (images.length === 0) {
    return { ok: false, error: "图像生成返回空图片列表" };
  }

  // 下载第一张图到本地（30s 超时）
  const safeActorId = actorId.replace(/[^a-zA-Z0-9_-]/g, "_") || "anonymous";
  const dir = join(storageRoot, safeActorId);
  await mkdir(dir, { recursive: true });

  const downloadRes = await fetch(images[0].url, { signal: AbortSignal.timeout(30_000) });
  if (!downloadRes.ok) {
    return { ok: false, error: `下载图像失败：HTTP ${downloadRes.status}` };
  }
  let buf = Buffer.from(await downloadRes.arrayBuffer());

  // 落盘前限幅 + 转 WebP：上游常给 4096² 的原始 PNG，单张落盘几十 MB，
  // 解码后位图 200MB+。在 worker 线程里做（不占主进程事件循环）。
  let ext = "png";
  try {
    const sharpMod = await import("sharp");
    const sharp = sharpMod.default ?? sharpMod;
    const maxEdge = positiveInt(process.env.AGENT_MEDIA_IMAGE_MAX_EDGE, 2048);
    let pipeline = sharp(buf, { animated: false, sequentialRead: true }).rotate();
    if (maxEdge > 0) {
      pipeline = pipeline.resize({ width: maxEdge, height: maxEdge, fit: "inside", withoutEnlargement: true });
    }
    const quality = Math.min(100, Math.max(40, positiveInt(process.env.AGENT_MEDIA_IMAGE_WEBP_QUALITY, 82)));
    buf = await pipeline.webp({ quality }).toBuffer();
    ext = "webp";
  } catch (e) {
    // sharp 不可用就退回原始字节（与原行为一致），不影响出图可用性
    console.warn("[image-worker] 图片转码失败，按原始字节落盘:", e?.message ?? e);
    ext = "png";
  }

  const imageId = `${Date.now()}-${randomUUID().slice(0, 8)}`;
  const fileName = `${imageId}.${ext}`;
  const fullPath = join(dir, fileName);
  await writeFile(fullPath, buf);

  return {
    ok: true,
    imageUrl: `/agent/images/${safeActorId}/${fileName}`,
    model,
    seed: images[0].seed,
    revisedPrompt: images[0].revised_prompt,
  };
}

parentPort.on("message", async (msg) => {
  const { id, payload } = msg;
  try {
    const result = await generateImage(payload);
    parentPort.postMessage({ id, ok: true, result });
  } catch (e) {
    parentPort.postMessage({ id, ok: false, error: e.message });
  }
});
