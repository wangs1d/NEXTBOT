import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Multipart } from "@fastify/multipart";

import { resolveActorId } from "../../agent/actor-id.js";
import type { VoiceMessageService } from "../../services/voice-message-service.js";

/** `@fastify/multipart` 注册后 `request.parts()` 可用。 */
type MultipartRequest = FastifyRequest & {
  parts: () => AsyncIterable<Multipart>;
};

/**
 * 语音消息 HTTP 路由：
 *   - `POST /agent/voice/messages/upload`        用户端上传录音（multipart/form-data）
 *   - `GET  /agent/voice/messages/:actorId/:fileName`  静态拉流（agent / 用户均可读）
 *
 * 设计要点：
 *   - 与 socialFeedService 解耦（独立目录 `data/voice-messages/`）。
 *   - 文件名严格校验（UUID.mp3），防穿越。
 *   - 上传走 multipart 优先（节省 33% 体积），JSON Base64 为兜底。
 */
export function registerVoiceMessageRoutes(
  app: FastifyInstance,
  deps: {
    voiceMessageService: VoiceMessageService;
  },
): void {
  const { voiceMessageService } = deps;

  /**
   * 用户端上传录音：multipart/form-data
   * 字段：sessionId / userId（二选一） + durationMs（可选）
   * 文件字段：file（mp3）
   * 返回：{ ok, mediaUrl, msgId, durationMs }
   */
  app.post("/agent/voice/messages/upload", async (request, reply) => {
    const req = request as MultipartRequest;
    if (typeof req.parts !== "function") {
      return reply.code(400).send({ ok: false, reason: "MULTIPART_NOT_REGISTERED" });
    }

    let sessionId = "";
    let userId = "";
    let durationMsStr = "";
    let uploadBuf: Buffer | null = null;
    let uploadMime = "audio/mpeg";

    try {
      for await (const part of req.parts()) {
        if (part.type === "file") {
          if (uploadBuf === null) {
            uploadBuf = await part.toBuffer();
            uploadMime = part.mimetype || "audio/mpeg";
          }
        } else {
          const value = String(part.value ?? "");
          if (part.fieldname === "sessionId") sessionId = value;
          else if (part.fieldname === "userId") userId = value;
          else if (part.fieldname === "durationMs") durationMsStr = value;
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return reply.code(400).send({ ok: false, reason: "MULTIPART_PARSE_FAILED", message: msg });
    }

    if (!uploadBuf || uploadBuf.length === 0) {
      return reply.code(400).send({ ok: false, reason: "MISSING_FILE" });
    }
    const actorId = resolveActorId({ userId: userId || undefined, sessionId: sessionId || "" });
    if (!actorId) {
      return reply.code(400).send({ ok: false, reason: "MISSING_ACTOR" });
    }
    if (!uploadMime.toLowerCase().includes("audio") && !uploadMime.toLowerCase().includes("mpeg")) {
      return reply.code(400).send({ ok: false, reason: "NOT_AUDIO" });
    }

    const durationMs = durationMsStr ? Number.parseInt(durationMsStr, 10) : undefined;
    const result = await voiceMessageService.storeUploaded(uploadBuf, actorId, durationMs);
    if (!result.ok) {
      return reply.code(400).send(result);
    }
    return { ok: true, mediaUrl: result.mediaUrl, msgId: result.msgId, durationMs: result.durationMs };
  });

  /**
   * 静态拉流：`GET /agent/voice/messages/:actorId/:fileName`
   * 支持范围请求（HTTP Range）由 fastify-sendfile 或手动处理；当前简单 send(stream)。
   */
  app.get<{ Params: { actorId: string; fileName: string } }>(
    "/agent/voice/messages/:actorId/:fileName",
    async (request, reply) => {
      const { actorId, fileName } = request.params;
      const fullPath = voiceMessageService.resolveFilePath(actorId, fileName);
      if (!fullPath) {
        return reply.code(404).send({ ok: false, reason: "NOT_FOUND" });
      }
      void reply.header("Content-Type", "audio/mpeg");
      void reply.header("Cache-Control", "public, max-age=86400");
      void reply.header("Accept-Ranges", "bytes");
      return reply.send(createReadStream(fullPath));
    },
  );
}
