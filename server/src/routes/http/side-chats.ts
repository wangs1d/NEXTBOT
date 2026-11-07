// HTTP 路由：手机端侧边栏「旁聊」（2026-11-07）。
//
// 旁聊 = 独立上下文的新会话：线程键 `side:<actor>:<id>` 与主会话物理隔离，
// 主会话消息完全不受影响。注册表只存标题/时间，消息正文在线程里。
//
// 端点：
//  - GET    /api/side-chats?actorId=&q=      列表（标题 + 实时预览/条数/最近时间）
//  - POST   /api/side-chats {actorId,title}  新建
//  - PATCH  /api/side-chats {actorId,id,title} 重命名
//  - DELETE /api/side-chats?actorId=&id=     删除（同时清空该线程）
import type { FastifyInstance } from "fastify";

import {
  parseMessageTimestamp,
  readMessageTimestampPrefix,
  getChatThreadStore,
} from "../../external-model/chat-thread-store.js";
import { readMessageTimestampMeta } from "../../external-model/chat-thread-ts-meta.js";
import { sideChatSessionId } from "../../agent/master-chat-session.js";
import { getSideChatRegistry } from "../../services/side-chat-registry.js";

interface ThreadSummary {
  preview: string;
  messageCount: number;
  lastAt: number | null;
}

type ThreadMsg = NonNullable<
  ReturnType<ReturnType<typeof getChatThreadStore>["peekThread"]>
>[number];

/** 从线程消息里派生预览/条数/最后时间（只读，异常静默降级为空）。 */
function threadSummary(sessionId: string): ThreadSummary {
  let msgs: ThreadMsg[] = [];
  try {
    msgs = getChatThreadStore().peekThread(sessionId) ?? [];
  } catch {
    return { preview: "", messageCount: 0, lastAt: null };
  }
  let preview = "";
  let count = 0;
  let lastAt: number | null = null;
  for (const msg of msgs) {
    if (!msg || (msg.role !== "user" && msg.role !== "assistant")) continue;
    const content =
      typeof msg.content === "string"
        ? msg.content
        : Array.isArray(msg.content)
          ? msg.content
              .filter(
                (p): p is { type: "text"; text: string } =>
                  !!p &&
                  typeof p === "object" &&
                  (p as { type?: string }).type === "text" &&
                  typeof (p as { text?: unknown }).text === "string",
              )
              .map((p) => p.text)
              .join("\n")
          : "";
    const text = (readMessageTimestampPrefix(content)?.rest ?? content).trim();
    if (!text || text.startsWith("[session-recap]")) continue;
    count += 1;
    preview = text.replace(/\s+/g, " ").slice(0, 90);
    const ts = readMessageTimestampMeta(msg) ?? parseMessageTimestamp(content);
    if (ts) lastAt = ts.getTime();
  }
  return { preview, messageCount: count, lastAt };
}

export function registerSideChatRoutes(app: FastifyInstance): void {
  const registry = getSideChatRegistry();

  app.get<{ Querystring: { actorId?: string; q?: string } }>(
    "/api/side-chats",
    async (request, reply) => {
      const actorId = String(request.query?.actorId ?? "").trim();
      if (!actorId) {
        return reply.code(400).send({ ok: false, error: "actorId required" });
      }
      const q = String(request.query?.q ?? "").trim().toLowerCase();
      const entries = await registry.list(actorId);
      const chats = entries.map((entry) => {
        const summary = threadSummary(sideChatSessionId(actorId, entry.id));
        return {
          id: entry.id,
          sessionId: sideChatSessionId(actorId, entry.id),
          title: entry.title,
          preview: summary.preview,
          messageCount: summary.messageCount,
          createdAt: entry.createdAt,
          updatedAt:
            summary.lastAt != null
              ? new Date(summary.lastAt).toISOString()
              : entry.updatedAt,
        };
      });
      const filtered = q
        ? chats.filter(
            (c) => c.title.toLowerCase().includes(q) || c.preview.toLowerCase().includes(q),
          )
        : chats;
      filtered.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
      return { ok: true, actorId, chats: filtered };
    },
  );

  app.post<{ Body: { actorId?: string; title?: string } }>(
    "/api/side-chats",
    async (request, reply) => {
      const body = request.body ?? {};
      const actorId = String(body.actorId ?? "").trim();
      if (!actorId) {
        return reply.code(400).send({ ok: false, error: "actorId required" });
      }
      const entry = await registry.create(actorId, body.title);
      return {
        ok: true,
        chat: {
          id: entry.id,
          sessionId: sideChatSessionId(actorId, entry.id),
          title: entry.title,
          preview: "",
          messageCount: 0,
          createdAt: entry.createdAt,
          updatedAt: entry.updatedAt,
        },
      };
    },
  );

  app.patch<{ Body: { actorId?: string; id?: string; title?: string } }>(
    "/api/side-chats",
    async (request, reply) => {
      const body = request.body ?? {};
      const actorId = String(body.actorId ?? "").trim();
      const id = String(body.id ?? "").trim();
      if (!actorId || !id) {
        return reply.code(400).send({ ok: false, error: "actorId and id required" });
      }
      const entry = await registry.rename(actorId, id, body.title);
      if (!entry) {
        return reply.code(404).send({ ok: false, error: "chat not found or empty title" });
      }
      return {
        ok: true,
        chat: {
          id: entry.id,
          sessionId: sideChatSessionId(actorId, entry.id),
          title: entry.title,
          createdAt: entry.createdAt,
          updatedAt: entry.updatedAt,
        },
      };
    },
  );

  app.delete<{ Querystring: { actorId?: string; id?: string } }>(
    "/api/side-chats",
    async (request, reply) => {
      const actorId = String(request.query?.actorId ?? "").trim();
      const id = String(request.query?.id ?? "").trim();
      if (!actorId || !id) {
        return reply.code(400).send({ ok: false, error: "actorId and id required" });
      }
      const removed = await registry.remove(actorId, id);
      if (!removed) {
        return reply.code(404).send({ ok: false, error: "chat not found" });
      }
      // 线程本体一并清掉：删旁聊 = 删会话（主会话线程不受影响）。
      try {
        getChatThreadStore().clearSession(sideChatSessionId(actorId, id));
      } catch {
        /* 线程清理失败不阻断注册表删除 */
      }
      return { ok: true };
    },
  );
}
