import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { serverRoot } from "../../config/paths.js";
import type { FastifyInstance } from "fastify";

const webRoot = resolve(serverRoot(), "web/chat");
const avatarRoot = join(webRoot, "assets", "avatar");

function contentTypeFor(file: string): string | undefined {
  const lower = file.toLowerCase();
  if (lower.endsWith(".css")) return "text/css; charset=utf-8";
  if (lower.endsWith(".js")) return "application/javascript; charset=utf-8";
  if (lower.endsWith(".html")) return "text/html; charset=utf-8";
  if (lower.endsWith(".map")) return "application/json; charset=utf-8";
  if (lower.endsWith(".svg")) return "image/svg+xml";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".woff2")) return "font/woff2";
  return undefined;
}

/** 浏览器 Accept 含 text/html 时返回聊天页 HTML（与 `GET /chat` JSON 元数据共用路径）。 */
export function prefersChatWebHtml(accept: string | undefined): boolean {
  if (!accept?.trim()) return false;
  const parts = accept.split(",").map((p) => p.trim().toLowerCase());
  let htmlQ = 0;
  let jsonQ = 0;
  for (const part of parts) {
    const [mime, ...params] = part.split(";").map((s) => s.trim());
    let q = 1;
    for (const param of params) {
      const [key, value] = param.split("=").map((s) => s.trim());
      if (key === "q" && value) {
        const parsed = Number.parseFloat(value);
        if (!Number.isNaN(parsed)) q = parsed;
      }
    }
    if (mime === "text/html" || mime === "text/*") htmlQ = Math.max(htmlQ, q);
    if (mime === "application/json" || mime === "application/*") jsonQ = Math.max(jsonQ, q);
  }
  if (htmlQ <= 0) return false;
  return htmlQ >= jsonQ;
}

export function readChatWebIndexHtml(): string {
  return readFileSync(join(webRoot, "index.html"), "utf8");
}

export function readNotesChatHtml(): string {
  return readFileSync(join(webRoot, "notes.html"), "utf8");
}

/**
 * 浏览器聊天静态资源：`/chat/assets/*`（页面本体由 `GET /chat` 按 Accept 分流）。
 */
export function registerChatWeb(app: FastifyInstance): void {
  /** Agent Sphere 3D 形象构建产物：`/chat/assets/avatar/*`（必须在 `/chat/assets/:file` 之前注册） */
  app.get<{ Params: { "*": string } }>("/chat/assets/avatar/*", async (req, reply) => {
    const raw = req.params["*"] ?? "";
    if (!raw || raw.includes("..") || !/^[a-zA-Z0-9/._-]+$/.test(raw)) {
      return reply.code(400).send("Invalid path");
    }
    const full = resolve(avatarRoot, raw);
    if (!full.startsWith(avatarRoot) || !existsSync(full)) {
      return reply.code(404).send("Not found");
    }
    const ct = contentTypeFor(raw);
    if (ct) void reply.type(ct);
    return readFileSync(full);
  });

  /** 静态文件：`/chat/assets/*` */
  app.get<{ Params: { file: string } }>("/chat/assets/:file", async (req, reply) => {
    const raw = req.params.file;
    if (!/^[a-zA-Z0-9._-]+$/.test(raw)) {
      return reply.code(400).send("Invalid path");
    }
    const full = resolve(webRoot, raw);
    if (!full.startsWith(webRoot) || !existsSync(full)) {
      return reply.code(404).send("Not found");
    }
    const ct = contentTypeFor(raw);
    if (ct) void reply.type(ct);
    return readFileSync(full);
  });

  /**
   * Vite 构建的 embed/overlay HTML 引用根路径 `/assets/*`；
   * 映射到 `server/web/chat/assets/avatar/assets/*` 以便 iframe 能加载脚本。
   */
  app.get<{ Params: { "*": string } }>("/assets/*", async (req, reply) => {
    const raw = req.params["*"] ?? "";
    if (!raw || raw.includes("..") || !/^[a-zA-Z0-9/._-]+$/.test(raw)) {
      return reply.code(400).send("Invalid path");
    }
    const full = resolve(avatarRoot, "assets", raw);
    if (!full.startsWith(resolve(avatarRoot, "assets")) || !existsSync(full)) {
      return reply.code(404).send("Not found");
    }
    const ct = contentTypeFor(raw);
    if (ct) void reply.type(ct);
    return readFileSync(full);
  });

  /**
   * 笔记对话页：与主聊天页共用 WebSocket 协议，但 `session.init` 时客户端会发送
   * `sessionId = "notes:" + actorId`，后端据此把对话记忆写入 `context=notes` 独立桶。
   */
  app.get("/chat/notes", async (_req, reply) => {
    void reply.type("text/html; charset=utf-8");
    return readNotesChatHtml();
  });
}
