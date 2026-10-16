import type { FastifyInstance } from "fastify";

import { resolveActorId } from "../../agent/actor-id.js";
import { resolvePrimaryChatSessionId } from "../../agent/master-chat-session.js";
import {
  getChatThreadStore,
  parseMessageTimestamp,
  readMessageTimestampPrefix,
} from "../../external-model/chat-thread-store.js";
import { readUserMessageClientId } from "../../external-model/chat-thread-client-id.js";
import { readMessageTimestampMeta } from "../../external-model/chat-thread-ts-meta.js";
import { isRecapEchoText } from "../../external-model/chat-thread-store.js";
import { readActorTranscript } from "../../services/wal-transcript.js";
import type { ExternalChatProvider } from "../../external-model/types.js";
import { getAgentRuntimeConfig } from "../../agent/agent-runtime-config.js";
import type { AgentMemorySyncService } from "../../services/agent-memory-sync-service.js";
import { clearAllMemoryForActor } from "../../services/memory-clear-service.js";

/**
 * 用户数据管理路由：删除全部聊天记录 + 清空 Agent 记忆 / 删除单轮对话。
 * 供客户端“删除全部聊天”与“删除这一轮”按钮调用。
 */
export function registerChatDataRoutes(
  app: FastifyInstance,
  deps: { externalChat?: ExternalChatProvider | null; agentMemorySyncService: AgentMemorySyncService },
): void {
  app.post<{ Body: { userId?: string; sessionId?: string } }>(
    "/api/chat-data/clear-all",
    async (request, reply) => {
      const body = request.body ?? {};
      const actorId = resolveActorId({
        userId: body.userId,
        sessionId: body.sessionId ?? "",
      });
      if (!actorId) {
        return reply.code(400).send({ ok: false, message: "missing userId or sessionId" });
      }

      const cleared = await clearAllMemoryForActor(actorId, deps);

      return {
        ok: true,
        cleared,
      };
    },
  );

  /**
   * 删除「一整轮对话」（用户提问 + Agent 该轮的全部回复）。
   *
   * 只从对话线程里摘掉这一轮，其余历史上下文与 Agent 记忆全部保留——与
   * clear-all 的全量清空是两条完全不同的路径。客户端「删除」按钮此前只能发
   * `chat.clear_history`（= clearAllMemoryForActor），删一条即忘掉全部历史，
   * 本接口是那条误伤路径的精准替代。
   */
  app.post<{
    Body: { userId?: string; sessionId?: string; messageId?: string; text?: string };
  }>(
    "/api/chat-data/delete-turn",
    async (request, reply) => {
      const body = request.body ?? {};
      const actorId = resolveActorId({
        userId: body.userId,
        sessionId: body.sessionId ?? "",
      });
      if (!actorId) {
        return reply.code(400).send({ ok: false, message: "missing userId or sessionId" });
      }
      const messageId = body.messageId?.trim();
      if (!messageId) {
        return reply.code(400).send({ ok: false, message: "missing messageId" });
      }

      // text 可选：被删消息的原文。仅用于本功能上线前落盘的旧线程（没有 clientMessageId
      // 字段，重启后按 id 定位不到）——服务端只在唯一命中时才按文本兜底定位。
      const fallbackText = typeof body.text === "string" ? body.text.slice(0, 4000) : undefined;

      const masterOn = getAgentRuntimeConfig().masterDelegation.enabled;
      const result = getChatThreadStore().deleteTurn(
        resolvePrimaryChatSessionId(actorId, masterOn),
        messageId,
        fallbackText,
      );

      return {
        ok: result.ok,
        reason: result.reason,
        removed: result.removed ?? 0,
      };
    },
  );

  /**
   * 最近对话线程历史（跨端漫游用，2026-10-08）：手机端等第二设备连接后拉取
   * 共享线程的最近一段（模型上下文同源），把本机缺失的对话轮回填本地。
   *
   * - 只读：peekThread 不创建空线程；线程消息剥掉 [ts:] 帧还原纯正文 + 真实时间戳。
   * - user 消息附带 clientMessageId（客户端 messageId），供客户端按 id 精确去重。
   * - [session-recap] 摘要块与 tool/system 消息不下发（均为模型内部素材，不是气泡）。
   * - `full=1`（2026-10-12 P1）：改从 turn WAL（全量轮次原文日志）反解完整聊天
   *   转史下发——线程是滑动窗口 + 摘要，只适合喂模型；聊天记录的权威源是 WAL，
   *   换设备/清数据后也能回全量。客户端按 clientMessageId + 用户原文锚去重，
   *   与线程口径的回填走同一套合并逻辑。
   */
  app.get<{ Querystring: { userId?: string; sessionId?: string; limit?: string; full?: string } }>(
    "/api/chat-data/history",
    async (request, reply) => {
      const query = request.query ?? {};
      const actorId = resolveActorId({
        userId: query.userId,
        sessionId: query.sessionId ?? "",
      });
      if (!actorId) {
        return reply.code(400).send({ ok: false, message: "missing userId or sessionId" });
      }
      const limitRaw = Number.parseInt(query.limit ?? "", 10);
      const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 200) : 50;

      if (query.full === "1") {
        const turns = await readActorTranscript(actorId);
        const messages: Array<{
          role: "user" | "assistant";
          text: string;
          ts: number | null;
          clientMessageId?: string;
        }> = [];
        for (const turn of turns) {
          if (turn.userText) {
            const item: {
              role: "user" | "assistant";
              text: string;
              ts: number | null;
              clientMessageId?: string;
            } = { role: "user", text: turn.userText.slice(0, 8000), ts: turn.ts };
            if (turn.clientMessageId) item.clientMessageId = turn.clientMessageId;
            messages.push(item);
          }
          if (turn.assistantText) {
            messages.push({
              role: "assistant",
              text: turn.assistantText.slice(0, 8000),
              // 同轮 user/assistant 共享同一 ts（同一毫秒）会让客户端渲染层
              // 的不稳定排序随机翻序（回复冒到提问上面）——assistant 恒 +1ms
              // 保证「问在上、答在下」的次序在一切排序下确定（2026-10-16）。
              ts: turn.ts == null ? null : turn.ts + 1,
            });
          }
        }
        return {
          ok: true,
          actorId,
          sessionId: actorId,
          source: "wal",
          messages: messages.slice(-limit),
        };
      }

      const masterOn = getAgentRuntimeConfig().masterDelegation.enabled;
      const threadKey = resolvePrimaryChatSessionId(actorId, masterOn);
      const msgs = getChatThreadStore().peekThread(threadKey) ?? [];

      const messages: Array<{
        role: "user" | "assistant";
        text: string;
        ts: number | null;
        clientMessageId?: string;
      }> = [];
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
        const parsed = readMessageTimestampPrefix(content);
        const text = (parsed?.rest ?? content).trim();
        if (!text || text.startsWith("[session-recap]")) continue;
        // recap 回显（无标签的摘要复述残体）不是对话气泡，不下发（2026-10-12）。
        if (isRecapEchoText(text)) continue;
        // P1 通道分离配套（2026-10-12 回归修复）：新消息的时刻在 metadata `__ts`，
        // 正文已无 [ts:] 帧——只解析正文会让 2026-10-11 之后的所有消息 ts=null，
        // 客户端漫游回填全部按「现在」落位，时间排序/去重全乱。
        const ts = readMessageTimestampMeta(msg) ?? parseMessageTimestamp(content);
        const item: {
          role: "user" | "assistant";
          text: string;
          ts: number | null;
          clientMessageId?: string;
        } = {
          role: msg.role,
          text: text.slice(0, 8000),
          ts: ts ? ts.getTime() : null,
        };
        if (msg.role === "user") {
          const clientId = readUserMessageClientId(msg);
          if (clientId) item.clientMessageId = clientId;
        }
        messages.push(item);
      }

      return {
        ok: true,
        actorId,
        sessionId: threadKey,
        messages: messages.slice(-limit),
      };
    },
  );
}