import { getDataDir } from "../../config/data-dir.js";
import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { FastifyInstance, FastifyRequest } from "fastify";

/**
 * 手机桥接拍照/录屏产物上传与查看路由。
 *
 * - POST /phone-bridge/captures?actorId=xxx&ext=jpg&token=xxx
 *   body 为二进制（application/octet-stream）：手机端拍照/录屏后经 HTTP 上传，
 *   服务端落盘 data/captures/{actorId}/，返回相对 url 供 agent 拉取查看。
 * - GET /phone-bridge/captures/:actorId/:file?token=xxx
 *   按原文件流式返回（图片/视频内容识别消费）。
 *
 * 鉴权：与手机桥接注册同一 PHONE_BRIDGE_TOKEN；未配置 token 时拒绝
 * （上传是写盘操作，不做无鉴权开放）。
 */

const ALLOWED_EXT = new Set(["jpg", "jpeg", "png", "mp4"]);
const MAX_UPLOAD_BYTES = 64 * 1024 * 1024; // 录屏 60s 上限约 20MB，留冗余

function tokenOk(request: FastifyRequest): boolean {
  const expected = process.env.PHONE_BRIDGE_TOKEN?.trim() ?? "";
  if (!expected) return false;
  const queryToken = String((request.query as Record<string, unknown>).token ?? "").trim();
  const headerToken =
    String(request.headers.authorization ?? "").replace(/^Bearer\s+/i, "").trim();
  const provided = queryToken || headerToken;
  return provided.length > 0 && provided === expected;
}

export type PhoneBridgeCaptureDeps = {
  /** 落盘根目录，缺省 data/captures（cwd=server/） */
  rootDir?: string;
};

export function registerPhoneBridgeCaptureRoutes(
  app: FastifyInstance,
  deps: PhoneBridgeCaptureDeps = {},
): void {
  // 手机端以 application/octet-stream 上传二进制：注册 buffer 解析器（bodyLimit 64MB
  // 覆盖默认 1MB，匹配录屏 60s 的产物大小上限）
  app.addContentTypeParser(
    "application/octet-stream",
    { parseAs: "buffer", bodyLimit: MAX_UPLOAD_BYTES },
    (_request, body, done) => {
      done(null, body);
    },
  );

  const rootDir = deps.rootDir ?? path.join(getDataDir(), "captures");

  app.post<{
    Querystring: { actorId?: string; ext?: string; kind?: string; token?: string };
  }>("/phone-bridge/captures", async (request, reply) => {
    if (!tokenOk(request)) {
      return reply.code(403).send({ ok: false, error: "forbidden" });
    }
    const actorId = String(request.query.actorId ?? "").trim().slice(0, 128);
    if (!actorId) {
      return reply.code(400).send({ ok: false, error: "actorId required" });
    }
    const extRaw = String(request.query.ext ?? "jpg").toLowerCase().replace(/^\./, "");
    const ext = ALLOWED_EXT.has(extRaw) ? extRaw : "jpg";
    const body = request.body;
    if (!Buffer.isBuffer(body)) {
      return reply.code(400).send({ ok: false, error: "binary body expected (octet-stream)" });
    }
    if (body.length === 0 || body.length > MAX_UPLOAD_BYTES) {
      return reply.code(413).send({ ok: false, error: `body size out of range: ${body.length}` });
    }
    const dir = path.join(rootDir, actorId.replace(/[^\w.-]/g, "_"));
    await mkdir(dir, { recursive: true });
    const fileName = `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}.${ext}`;
    await writeFile(path.join(dir, fileName), body);
    return {
      ok: true,
      file: fileName,
      url: `/phone-bridge/captures/${path.basename(dir)}/${fileName}?token=${encodeURIComponent(String(request.query.token ?? ""))}`,
    };
  });

  app.get<{
    Params: { actorId: string; file: string };
    Querystring: { token?: string };
  }>("/phone-bridge/captures/:actorId/:file", async (request, reply) => {
    if (!tokenOk(request)) {
      return reply.code(403).send({ ok: false, error: "forbidden" });
    }
    const actorId = request.params.actorId.replace(/[^\w.-]/g, "_");
    const file = path.basename(request.params.file);
    const filePath = path.join(rootDir, actorId, file);
    try {
      const stream = createReadStream(filePath);
      const contentType = file.endsWith(".mp4") ? "video/mp4" : "image/jpeg";
      return reply.header("content-type", contentType).send(stream);
    } catch {
      return reply.code(404).send({ ok: false, error: "not found" });
    }
  });
}
