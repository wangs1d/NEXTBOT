import type { VisionFrame, VisionSourceKind } from "../external-model/types.js";
import { assertVisionPullUrlAllowed } from "./url-allow.js";
import { sniffImageMimeFromBuffer } from "./mime-from-buffer.js";
import { sanitizeVisionFramesFromWire } from "./sanitize-vision-frames.js";

function envMs(name: string, fallback: number): number {
  const n = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function envBytes(name: string, fallback: number): number {
  const n = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * 服务端 HTTP(S) 拉取单帧图像（摄像头快照 URL、MJPEG 单帧服务端返回整张图片字节流等）。
 * 返回已通过 {@link sanitizeVisionFramesFromWire} 的 {@link VisionFrame}。
 */
export async function fetchHttpVisionFrame(
  urlStr: string,
  sourceKind: VisionSourceKind,
  sourceId?: string,
): Promise<VisionFrame> {
  const timeoutMs = Math.min(120_000, envMs("AGENT_VISION_HTTP_PULL_TIMEOUT_MS", 20_000));
  const maxBytes = Math.min(24 * 1024 * 1024, envBytes("AGENT_VISION_HTTP_PULL_MAX_BYTES", 6 * 1024 * 1024));

  let url: URL;
  try {
    url = new URL(urlStr);
  } catch {
    throw new Error("VISION_PULL_BAD_URL");
  }
  assertVisionPullUrlAllowed(url);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(urlStr, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        Accept: "image/*,*/*;q=0.8",
        "User-Agent": "Nextbot-VisionPull/1.0",
      },
    });
    if (!res.ok) {
      throw new Error(`VISION_PULL_HTTP_${res.status}`);
    }
    const ct = res.headers.get("content-type") ?? undefined;
    const lenHdr = res.headers.get("content-length");
    if (lenHdr) {
      const n = Number.parseInt(lenHdr, 10);
      if (Number.isFinite(n) && n > maxBytes) {
        throw new Error("VISION_PULL_TOO_LARGE");
      }
    }
    const buf = Buffer.from(await readBodyWithCap(res.body, maxBytes));
    const mime = sniffImageMimeFromBuffer(buf, ct);
    const sanitized = sanitizeVisionFramesFromWire([
      {
        sourceKind,
        mimeType: mime,
        dataBase64: buf.toString("base64"),
        ...(sourceId?.trim() ? { sourceId: sourceId.trim().slice(0, 160) } : {}),
        capturedAt: new Date().toISOString(),
      },
    ]);
    if (!sanitized?.[0]) {
      throw new Error("VISION_PULL_SANITIZE_FAILED");
    }
    return sanitized[0];
  } finally {
    clearTimeout(timer);
  }
}

async function readBodyWithCap(body: ReadableStream<Uint8Array> | null, maxBytes: number): Promise<Uint8Array> {
  if (!body) {
    return new Uint8Array();
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.length) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        throw new Error("VISION_PULL_TOO_LARGE");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock?.();
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}
