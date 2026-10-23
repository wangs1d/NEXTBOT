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

  const imageId = `${Date.now()}-${randomUUID().slice(0, 8)}`;
  const fileName = `${imageId}.png`;
  const fullPath = join(dir, fileName);

  const downloadRes = await fetch(images[0].url, { signal: AbortSignal.timeout(30_000) });
  if (!downloadRes.ok) {
    return { ok: false, error: `下载图像失败：HTTP ${downloadRes.status}` };
  }
  const buf = Buffer.from(await downloadRes.arrayBuffer());
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
