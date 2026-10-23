import { getDataDir } from "../../config/data-dir.js";
import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join, resolve as resolvePath, sep } from "node:path";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Multipart } from "@fastify/multipart";
import sharp from "sharp";

import { resolveActorId, ANONYMOUS_ACTOR_ID } from "../../agent/actor-id.js";
import { sanitizeActorKey } from "../../agentic-memory/actor-key.js";
import { writeJsonAtomic } from "../../storage/atomic-json.js";

/** `@fastify/multipart` 注册后 `request.parts()` 可用。 */
type MultipartRequest = FastifyRequest & {
  parts: () => AsyncIterable<Multipart>;
};

/**
 * 用户头像 HTTP 路由（用户自己设置头像；与 agentProfile.avatarUrl 无关）：
 *   - `POST /api/user/avatar?userId=`              上传头像（multipart/form-data，服务端归一 512 方图 webp）
 *   - `GET  /api/user/avatar?userId=`              查询当前头像路径（无头像时 avatarPath=null）
 *   - `GET  /agent/avatars/:actorId/:fileName`     静态拉流（与 /agent/images 同模式，公开可读）
 *
 * 设计要点：
 *   - 身份只认 `query.userId`：ACCESS_AUTH_REQUIRED=1 时被周界 hook 钉死为
 *     token 归属用户（multipart body 不是 JSON 对象，hook 钉不到，故不走 body 通道）。
 *   - 落盘 `data/avatars/<sanitizeActorKey(actorId)>/`，每次上传生成新 uuid 文件名
 *     ——URL 随内容变化，配合 immutable 缓存无钉死问题；旧文件写入成功后删除。
 *   - 上传即归一：任意可解析图片 → 512×512 cover 方图 webp（attention 策略优先
 *     对焦显著区域），客户端无需裁剪 UI。
 */
export function registerUserAvatarRoutes(app: FastifyInstance, deps?: { rootDir?: string }): void {
  const rootDir = deps?.rootDir?.trim() || process.env.USER_AVATAR_DIR?.trim() || join(getDataDir(), "avatars");
  const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
  const FILE_NAME_RE = /^[A-Za-z0-9_-]+\.webp$/;

  const actorDir = (actorId: string): string => join(rootDir, sanitizeActorKey(actorId));
  const metaPath = (actorId: string): string => join(actorDir(actorId), "current.json");

  /** 从 query 取身份；缺失/匿名哨兵 → null（调用方 400）。 */
  function actorFromQuery(request: FastifyRequest): string | null {
    const query = (request.query ?? {}) as { userId?: string };
    const actorId = resolveActorId({ userId: query.userId, sessionId: "" });
    return actorId === ANONYMOUS_ACTOR_ID ? null : actorId;
  }

  /** 读当前头像 meta；文件已被外力删除时视为无头像并顺手清掉 meta。 */
  async function readCurrent(actorId: string): Promise<{ fileName: string; updatedAt: string } | null> {
    let raw: string;
    try {
      raw = await readFile(metaPath(actorId), "utf8");
    } catch {
      return null;
    }
    try {
      const meta = JSON.parse(raw) as { fileName?: string; updatedAt?: string };
      const fileName = typeof meta.fileName === "string" ? meta.fileName : "";
      if (!FILE_NAME_RE.test(fileName)) return null;
      await readFile(join(actorDir(actorId), fileName));
      return { fileName, updatedAt: meta.updatedAt ?? "" };
    } catch {
      return null;
    }
  }

  app.post("/api/user/avatar", async (request, reply) => {
    const actorId = actorFromQuery(request);
    if (!actorId) {
      return reply.code(400).send({ ok: false, error: "缺少 userId" });
    }

    const req = request as MultipartRequest;
    if (typeof req.parts !== "function") {
      return reply.code(400).send({ ok: false, error: "MULTIPART_NOT_REGISTERED" });
    }
    let uploadBuf: Buffer | null = null;
    try {
      for await (const part of req.parts()) {
        if (part.type === "file" && uploadBuf === null) {
          uploadBuf = await part.toBuffer();
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return reply.code(400).send({ ok: false, error: `MULTIPART_PARSE_FAILED: ${msg}` });
    }
    if (!uploadBuf || uploadBuf.length === 0) {
      return reply.code(400).send({ ok: false, error: "缺少文件字段 file" });
    }
    if (uploadBuf.length > MAX_UPLOAD_BYTES) {
      return reply.code(400).send({ ok: false, error: "图片超过 10MB 上限" });
    }

    let webp: Buffer;
    try {
      // metadata 可解析即认为是图片（jpg/png/webp/gif/bmp 等统一放行，归一出口收敛为 webp）
      const meta = await sharp(uploadBuf).metadata();
      if (!meta.width || !meta.height) throw new Error("无有效尺寸");
      webp = await sharp(uploadBuf)
        .resize(512, 512, { fit: "cover", position: "attention" })
        .webp({ quality: 85 })
        .toBuffer();
    } catch {
      return reply.code(400).send({ ok: false, error: "无法解析的图片文件" });
    }

    // 先记旧文件名（meta 马上要被覆盖，过后就找不到了）
    const previous = await readCurrent(actorId);

    const fileName = `${randomUUID()}.webp`;
    const dir = actorDir(actorId);
    await mkdir(dir, { recursive: true });
    // 新文件是全新 uuid 名，无覆盖风险；先落文件再更新 meta，崩溃最坏留下孤儿文件
    await writeFile(join(dir, fileName), webp);
    const updatedAt = new Date().toISOString();
    await writeJsonAtomic(metaPath(actorId), { fileName, updatedAt });

    // 删旧头像（meta 更新成功后）。这里 await 而非 fire-and-forget：
    // 本地 unlink 是毫秒级，等它落地能让「上传返回 ⇒ 旧文件已不存在」成为
    // 确定事实（调用方/测试不用猜时序）；删除失败仍忽略，不影响本次结果。
    if (previous) {
      try {
        await unlink(join(dir, previous.fileName));
      } catch {
        /* 旧文件被占用/已不在：留个孤儿文件，后续上传自然覆盖 */
      }
    }

    return {
      ok: true,
      avatarPath: `/agent/avatars/${sanitizeActorKey(actorId)}/${fileName}`,
      updatedAt,
    };
  });

  app.get("/api/user/avatar", async (request, reply) => {
    const actorId = actorFromQuery(request);
    if (!actorId) {
      return reply.code(400).send({ ok: false, error: "缺少 userId" });
    }
    const current = await readCurrent(actorId);
    if (!current) {
      return { ok: true, avatarPath: null };
    }
    return {
      ok: true,
      avatarPath: `/agent/avatars/${sanitizeActorKey(actorId)}/${current.fileName}`,
      updatedAt: current.updatedAt,
    };
  });

  app.get<{ Params: { actorId: string; fileName: string } }>(
    "/agent/avatars/:actorId/:fileName",
    async (request, reply) => {
      const { actorId, fileName } = request.params;
      if (!FILE_NAME_RE.test(fileName)) {
        return reply.code(404).send({ ok: false, error: "NOT_FOUND" });
      }
      // 双保险：白名单之外这里再校验解析结果不逃出根目录
      const rootAbs = resolvePath(rootDir);
      const fullPath = resolvePath(actorDir(actorId), fileName);
      if (fullPath !== rootAbs && !fullPath.startsWith(rootAbs + sep)) {
        return reply.code(404).send({ ok: false, error: "NOT_FOUND" });
      }
      try {
        await readFile(fullPath);
      } catch {
        return reply.code(404).send({ ok: false, error: "NOT_FOUND" });
      }
      void reply.header("Content-Type", "image/webp");
      void reply.header("Cache-Control", "public, max-age=2592000, immutable");
      void reply.header("Accept-Ranges", "bytes");
      return reply.send(createReadStream(fullPath));
    },
  );
}
