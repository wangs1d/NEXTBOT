import type { FastifyInstance } from "fastify";

import {
  chatMessageCopyBodySchema,
  chatMessageEditBodySchema,
  chatScheduleDraftBodySchema,
  chatSkillEnabledBodySchema,
  chatSkillsQuerySchema,
} from "../../schemas/api.js";
import { prefersChatWebHtml, readChatWebIndexHtml } from "./chat-web.js";
import type { HttpRouteDeps } from "./types.js";
import { ServerEventType } from "../../protocol.js";
import { getChatThreadStore } from "../../external-model/chat-thread-store.js";
import { parseAgentAccessMode } from "../../agent/agent-access-mode.js";
import {
  normalizeReplyCardLayout,
  stripRenderHintDeclarations,
  extractNextUpSuggestions,
} from "../../services/reply-envelope.js";
import { stripResidualRenderDeclarations } from "../../services/tool-result-processor.js";
import { createStreamMarkerGuard } from "../../utils/stream-marker-guard.js";

function resolveActorKey(q: Record<string, unknown> | undefined): string | undefined {
  const userId = typeof q?.userId === "string" ? q.userId : undefined;
  const sessionId = typeof q?.sessionId === "string" ? q.sessionId : undefined;
  return userId?.trim() || sessionId?.trim() || undefined;
}

function buildToolsResponse(
  deps: Pick<HttpRouteDeps, "toolRegistry" | "skillManager" | "worldService">,
  sessionId?: string,
) {
  const { toolRegistry, skillManager, worldService } = deps;
  const skillNames = new Set(skillManager.list(true).map((s) => s.name));
  /** 代码注册的工具（含 `agent.*` 等），排除与 Skill 同名的条目。 */
  const codeTools = toolRegistry.list().filter((name) => !skillNames.has(name));
  let skills = skillManager.list(true);
  const sid = sessionId?.trim();
  if (sid) {
    const owned = new Set(worldService.getOrCreateRoom(sid, sid).ownedSkillIds);
    skills = skills.filter((s) => s.kind !== "community" || owned.has(s.name));
  }
  return {
    tools: codeTools,
    skills: skills.map((s) => ({
      name: s.name,
      displayName: s.displayName,
      description: s.description,
      version: s.version,
      tags: s.tags,
      icon: s.icon,
      kind: s.kind,
    })),
  };
}

/**
 * 当前 Actor 可见的全部 Skill（含已禁用）；与 `/chat/tools` 相同的社区技能过滤规则。
 */
function buildSkillsLibraryResponse(
  deps: Pick<HttpRouteDeps, "skillManager" | "worldService">,
  actorKey?: string,
) {
  const { skillManager, worldService } = deps;
  let manifests = skillManager.list(false);
  const sid = actorKey?.trim();
  if (sid) {
    const owned = new Set(worldService.getOrCreateRoom(sid, sid).ownedSkillIds);
    manifests = manifests.filter((s) => s.kind !== "community" || owned.has(s.name));
  } else {
    manifests = manifests.filter((s) => s.kind !== "community");
  }
  const enabledCount = manifests.filter((s) => s.enabled !== false).length;
  return {
    ok: true as const,
    actorScoped: Boolean(sid),
    items: manifests.map((s) => {
      const kind = s.kind ?? "builtin";
      return {
        name: s.name,
        displayName: s.displayName,
        description: s.description,
        version: s.version,
        tags: s.tags,
        icon: s.icon,
        kind,
        enabled: s.enabled !== false,
        source: kind === "community" ? ("community" as const) : ("builtin" as const),
        sourceLabel: kind === "community" ? "技能商店" : "内置",
      };
    }),
    stats: {
      total: manifests.length,
      enabled: enabledCount,
      disabled: manifests.length - enabledCount,
    },
  };
}

/**
 * 聊天主域：工具/Skill 列表、入口元数据；WebSocket 仍为根路径 `/ws`。
 * 保留 `GET /tools` 与主域 `GET /chat/tools` 行为一致（兼容旧客户端）。
 */
export function registerChatRoutes(app: FastifyInstance, deps: HttpRouteDeps): void {
  const { toolRegistry, skillManager, worldService, scheduleIntentService } = deps;
  const toolsDeps = { toolRegistry, skillManager, worldService };

  app.get("/chat", async (request, reply) => {
    const accept = request.headers.accept;
    if (prefersChatWebHtml(typeof accept === "string" ? accept : accept?.[0])) {
      void reply.type("text/html; charset=utf-8");
      return readChatWebIndexHtml();
    }
    return {
      domain: "chat",
      websocketPath: "/ws",
      toolsPath: "/chat/tools",
      legacyToolsPath: "/tools",
      skillsLibraryPath: "/chat/skills",
      desktopBridgeSyncPath: "/chat/desktop-bridge/sync",
    };
  });

  app.get("/chat/desktop-bridge/sync", async (request, reply) => {
    const q = request.query as Record<string, unknown> | undefined;
    const actorKey = resolveActorKey(q);
    if (!actorKey) {
      return reply.code(400).send({ ok: false, message: "需要 userId 或 sessionId" });
    }
    const { desktopBridgeCoordinator } = deps;
    if (!desktopBridgeCoordinator.isBridgeFeatureEnabled()) {
      return {
        ok: true,
        bridgeFeatureEnabled: false,
        bridgeOnline: false,
        updatedAt: null,
        lastTask: null,
      };
    }
    const body = desktopBridgeCoordinator.getSyncPayload(actorKey);
    return { ok: true, bridgeFeatureEnabled: true, ...body };
  });

  app.get("/chat/tools", async (request) => {
    const q = request.query as Record<string, unknown> | undefined;
    return buildToolsResponse(toolsDeps, resolveActorKey(q));
  });

  app.get("/tools", async (request) => {
    const q = request.query as Record<string, unknown> | undefined;
    return buildToolsResponse(toolsDeps, resolveActorKey(q));
  });

  app.get("/chat/skills", async (request, reply) => {
    const parsed = chatSkillsQuerySchema.safeParse(request.query ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    }
    const q = parsed.data;
    const actorKey = q.userId?.trim() || q.sessionId?.trim();
    const libDeps = { skillManager, worldService };
    return buildSkillsLibraryResponse(libDeps, actorKey || undefined);
  });

  app.patch("/chat/skills/enabled", async (request, reply) => {
    const parsed = chatSkillEnabledBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    }
    const { skillName, enabled, sessionId, userId } = parsed.data;
    const actorKey = userId?.trim() || sessionId?.trim();
    const manifest = skillManager.get(skillName);
    if (!manifest) {
      return reply.code(404).send({ ok: false, message: "Skill 不存在" });
    }
    const kind = manifest.kind ?? "builtin";
    if (kind === "community") {
      if (!actorKey) {
        return reply
          .code(400)
          .send({ ok: false, message: "切换社区技能状态须带上 userId 或 sessionId" });
      }
      const owned = new Set(worldService.getOrCreateRoom(actorKey, actorKey).ownedSkillIds);
      if (!owned.has(skillName)) {
        return reply.code(403).send({ ok: false, message: "未拥有该社区技能" });
      }
    }
    skillManager.setEnabled(skillName, enabled);
    return { ok: true, skillName, enabled };
  });

  app.post("/chat/schedule-draft", async (request, reply) => {
    const parsed = chatScheduleDraftBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    }
    const intent = await scheduleIntentService.parseForCreate(
      parsed.data.sessionId,
      parsed.data.text,
    );
    if (!intent.matched) {
      if ("needsRecurrenceConfirm" in intent && intent.needsRecurrenceConfirm) {
        return {
          ok: true,
          matched: false,
          needsRecurrenceConfirm: true,
          hint: intent.hint,
          draft: intent.draft,
        };
      }
      return reply.code(200).send({ ok: true, matched: false, hint: intent.hint });
    }
    return { ok: true, matched: true, draft: intent.draft };
  });

  app.post("/chat/message/copy", async (request, reply) => {
    const parsed = chatMessageCopyBodySchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    }
    const { messageId, text, sessionId, userId } = parsed.data;
    // 复制行为的核心由前端写入剪贴板完成；这里仅做服务端审计/回执。
    // 文本由客户端提供，校验后原样回显给前端（无状态写入）。
    return {
      ok: true as const,
      messageId,
      sessionId,
      userId: userId ?? null,
      text,
      length: text.length,
    };
  });

  app.post("/chat/message/edit", async (request, reply) => {
    const parsed = chatMessageEditBodySchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    }
    const { messageId, newText, sessionId, userId, agentAccessMode } = parsed.data;
    const actorKey = userId?.trim() || sessionId.trim();

    const { runtime, wsConnectionRegistry } = deps;
    if (!runtime) {
      return reply.code(503).send({ ok: false, message: "AgentCore 未就绪" });
    }
    if (!wsConnectionRegistry?.get(actorKey)) {
      return reply.code(409).send({
        ok: false,
        message: "当前 Actor 没有在线 WebSocket，无法流式回包；请保持聊天页在前台再试",
      });
    }

    // 1) 先在服务端线程里把旧 user 消息及之后内容清掉，等会儿 provider 会用同 clientMessageId 重新 push 一次。
    const threads = getChatThreadStore();
    const removed = threads.removeUserMessageAndAfter(sessionId, messageId);
    if (!removed) {
      // 兜底：用 editUserMessage 强制覆盖；多用于旧消息（重启后丢失 clientMessageId 反向索引）场景
      const fallback = threads.editUserMessage(sessionId, "{}", messageId, newText);
      if (!fallback.ok) {
        return reply.code(404).send({
          ok: false,
          message: `未找到要编辑的消息：${fallback.reason ?? "unknown"}`,
        });
      }
    }

    // 2) 触发 Agent 重答；响应通过 WebSocket 推回（同 user_message 协议）。
    const assistantMessageId = `edit:${messageId}:${Date.now()}`;
    const accessMode = parseAgentAccessMode(agentAccessMode);
    let chunkSeq = 0;
    let editSpeechSent = false;
    // 编辑重答的 delta 此前是裸推：模型回复末尾的 [NEXT_UP_START] 块会原样闪现
    // 在气泡里（done 才替换）。与 WS 对话面同构挂流式标记 guard。
    // 2026-11-05 二轮定稿：模型仍流式生成，净化后的增量走语音数据帧；文字
    // 回复仍只由下方 ChatAssistantDone 一次性落屏（不打打字机）。
    const editStreamGuard = createStreamMarkerGuard();
    const sendEditSpeechFrame = (chunk: string, final: boolean, finalText?: string): void => {
      chunkSeq += 1;
      if (!final && chunk) editSpeechSent = true;
      wsConnectionRegistry.trySend(
        actorKey,
        JSON.stringify({
          type: ServerEventType.ChatAssistantSpeech,
          payload: {
            sessionId: actorKey,
            messageId: assistantMessageId,
            traceId: messageId,
            chunk,
            sequence: chunkSeq,
            phase: "stream",
            final,
            ...(final ? { finalText: finalText ?? "", hasIncrements: editSpeechSent } : {}),
          },
        }),
      );
    };
    void (async () => {
      try {
        const reply0 = await runtime.handleUserMessage(actorKey, newText, {
          chatUserMessageId: messageId,
          agentAccessMode: accessMode,
          onAssistantDelta: (delta) => {
            const safe = editStreamGuard.feed(delta);
            if (safe && !editStreamGuard.sawStructuredBlock) {
              sendEditSpeechFrame(safe, false);
            }
          },
        });
        const guardTail = editStreamGuard.flush();
        if (guardTail && !editStreamGuard.sawStructuredBlock) {
          sendEditSpeechFrame(guardTail, false);
        }
        // 出口收口（与 WS 对话路径同构）：剥模型声明的 RENDER_HINT/RENDER_AS
        // 残留 + 卡片版式归一化 + NEXT_UP 接续建议块剥离（2026-09-24 补：此路径
        // 此前漏接 extractNextUpSuggestions，建议块会原样透出到用户屏幕）。
        const nextUp = extractNextUpSuggestions(
          normalizeReplyCardLayout(
            stripResidualRenderDeclarations(stripRenderHintDeclarations(reply0.text)),
          ),
        );
        const replyFinalText = nextUp.text;
        // 语音流式收口：final 帧恒在 done 之前，无增量帧时用定稿全文兜底播报。
        sendEditSpeechFrame("", true, replyFinalText);
        wsConnectionRegistry.trySend(
          actorKey,
          JSON.stringify({
            type: ServerEventType.ChatAssistantDone,
            payload: {
              sessionId: actorKey,
              messageId: assistantMessageId,
              traceId: messageId,
              finalText: replyFinalText,
              toolCalls: reply0.toolName ? [reply0.toolName] : [],
              source: "chat.message_edit",
              // 接续建议随 done 下发（此前只取 .text，编辑重答永远没有胶囊）。
              ...(nextUp.followups.length > 0 ? { followups: nextUp.followups } : {}),
            },
          }),
        );
      } catch (e) {
        wsConnectionRegistry.trySend(
          actorKey,
          JSON.stringify({
            type: ServerEventType.ErrorEvent,
            payload: {
              code: "CHAT_MESSAGE_EDIT_FAILED",
              message: e instanceof Error ? e.message : String(e),
              traceId: messageId,
            },
          }),
        );
      }
    })();

    return {
      ok: true as const,
      messageId,
      newText,
      sessionId,
      userId: userId ?? null,
      assistantMessageId,
    };
  });
}
