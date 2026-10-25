import type { FastifyInstance } from "fastify";
import { ServerEventType } from "../../protocol.js";
import { MorningBriefingService } from "../../services/morning-briefing-service.js";
import type { MorningBriefingDeps } from "../../services/morning-briefing-service.js";
import { getUserPreferences } from "./user-preferences.js";
import { markMorningBriefingDelivered } from "./user-preferences.js";
import type { HttpRouteDeps } from "./types.js";

/**
 * 测试专用：手动触发一次早间简报 WS 事件。
 *
 * 用途：补齐调度器订阅挂载链路前，先验证客户端卡片渲染是否 OK。
 * 调用方式：POST /api/test/trigger-briefing，body { sessionId?: string, mode?: "voice"|"window"|"card" }
 *
 * 生产环境应通过 MorningBriefingScheduler 的 subscribe + tick 触发。
 * 注意：必须用装配层注入的完整依赖（天气/日程/笔记/记忆）构服务——
 * 手动预览的简报内容要与调度路径完全一致，否则卡片永远只剩问候语。
 */
export function registerBriefingTestRoutes(
  app: FastifyInstance,
  deps: Pick<
    HttpRouteDeps,
    | "wsConnectionRegistry"
    | "agentMemorySyncService"
    | "weatherService"
    | "weatherPrefsService"
    | "scheduleTaskService"
    | "notesService"
  > & {
    requestClientLocation?: MorningBriefingDeps["requestClientLocation"];
    /** 口语润色（与调度/启动简报路径同源，保证预览口径一致） */
    llmComplete?: MorningBriefingDeps["llmComplete"];
  },
): void {
  app.post("/api/test/trigger-briefing", async (request, reply) => {
    const wsRegistry = deps.wsConnectionRegistry;
    if (!wsRegistry) {
      return reply.code(503).send({ ok: false, error: "wsConnectionRegistry 未注入" });
    }

    const body = (request.body ?? {}) as {
      sessionId?: string;
      mode?: "voice" | "window" | "card";
    };
    const sessionId = body.sessionId?.trim();
    if (!sessionId) {
      return reply.code(400).send({ ok: false, error: "sessionId required" });
    }
    const mode = body.mode ?? "card";

    const briefingDeps: MorningBriefingDeps = {
      getSessionPrefs: (sid) => getUserPreferences(sid),
      agentMemorySyncService: deps.agentMemorySyncService,
      weatherService: deps.weatherService,
      weatherPrefsService: deps.weatherPrefsService,
      scheduleTaskService: deps.scheduleTaskService,
      notesService: deps.notesService,
      requestClientLocation: deps.requestClientLocation,
      llmComplete: deps.llmComplete,
    };
    const service = new MorningBriefingService(briefingDeps);
    const narration = await service.narrateBriefing(sessionId);

    const sent = wsRegistry.trySend(
      sessionId,
      JSON.stringify({
        type: ServerEventType.MorningBriefing,
        payload: {
          sessionId,
          mode,
          narrationText: narration.narrationText,
          briefing: narration.briefing,
        },
      }),
    );

    if (sent) {
      markMorningBriefingDelivered(sessionId, "scheduled");
    }

    return {
      ok: true,
      delivered: sent,
      mode,
      sessionId,
      briefing: narration.briefing,
      narrationText: narration.narrationText,
    };
  });
}

/**
 * 测试专用：手动触发一次明日速览（晚间 digest）WS 事件。
 *
 * 调用方式：POST /api/test/trigger-evening-digest，body { sessionId?: string,
 * previewDate?: string }——previewDate（YYYY-MM-DD，被预告的那天）为跨零点
 * 补推用：昨晚的卡没送达、过了零点才补时传昨晚口径的「明天」，行程/天气/
 * 日期标签都会按那天对齐（DDL 块因实时扫描时点错位而省略）；不传 = 实时生成。
 * 走的是调度器同款路径（同一个 EveningDigestService 实例 + 同一种 WS 事件），
 * 所以预览出来的卡片内容、文案口径与到点自动推送一致；不等 next tick、
 * 也不写 lastSentDay，当天到点仍会正常再推一次。
 */
export function registerEveningDigestTestRoutes(
  app: FastifyInstance,
  deps: Pick<HttpRouteDeps, "wsConnectionRegistry" | "eveningDigestService">,
): void {
  const service = deps.eveningDigestService;
  if (!service) return;
  app.post("/api/test/trigger-evening-digest", async (request, reply) => {
    const wsRegistry = deps.wsConnectionRegistry;
    if (!wsRegistry) {
      return reply.code(503).send({ ok: false, error: "wsConnectionRegistry 未注入" });
    }
    const body = (request.body ?? {}) as { sessionId?: string; previewDate?: string };
    const online = wsRegistry.connectedSessionIds();
    // 不传 sessionId 时取当前在线的第一个 session（明日速览只认在线的那一位）
    const sessionId = body.sessionId?.trim() || online[0] || "";
    if (!sessionId) {
      return reply.code(400).send({ ok: false, error: "无在线 session，且未指定 sessionId" });
    }

    const digest = await service.generateDigest(sessionId, { previewDate: body.previewDate });
    const sent = wsRegistry.trySend(
      sessionId,
      JSON.stringify({
        type: ServerEventType.EveningDigest,
        payload: { sessionId, narrationText: digest.narrationText, digest },
      }),
    );

    return {
      ok: true,
      delivered: sent,
      sessionId,
      onlineSessions: online,
      narrationText: digest.narrationText,
      digest,
    };
  });
}
