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
 * previewDate?: string, markSent?: boolean }——previewDate（YYYY-MM-DD，被预告
 * 的那天）为跨零点补推用：昨晚的卡没送达、过了零点才补时传昨晚口径的「明天」，
 * 行程/天气/日期标签都会按那天对齐（DDL 块因实时扫描时点错位而省略）；不传 =
 * 实时生成。走的是调度器同款路径（同一个 EveningDigestService 实例 + 同一种
 * WS 事件），所以预览出来的卡片内容、文案口径与到点自动推送一致；不等
 * next tick、也不写 lastSentDay，当天到点仍会正常再推一次。
 * markSent=true（2026-11-05）反过来：补发即正式送达——占用推送额度
 * （调度器 lastSentDay 落盘），到点不再重复推，用于「昨晚漏推今晚补」场景；
 * 凌晨（<6 点）调用时额度落到昨天而非今天（2026-11-06 修复，否则吞掉当晚推送）。
 */
export function registerEveningDigestTestRoutes(
  app: FastifyInstance,
  deps: Pick<
    HttpRouteDeps,
    "wsConnectionRegistry" | "eveningDigestService" | "eveningDigestScheduler"
  >,
): void {
  const service = deps.eveningDigestService;
  if (!service) return;
  app.post("/api/test/trigger-evening-digest", async (request, reply) => {
    const wsRegistry = deps.wsConnectionRegistry;
    if (!wsRegistry) {
      return reply.code(503).send({ ok: false, error: "wsConnectionRegistry 未注入" });
    }
    const body = (request.body ?? {}) as {
      sessionId?: string;
      previewDate?: string;
      markSent?: boolean;
    };
    const online = wsRegistry.connectedSessionIds();
    // 手机端优先（2026-11-09 用户指令）：多端在线时 online[0] 会被本机桌面会话
    // 占住（实证：session-mvp-001 恒排在前，真机卡全被它吃掉）。先挑有 mobile
    // 在线的 session，一个都没有才回退首个在线；显式传 sessionId 仍最高优先。
    const mobileOnline = online.filter((id) => wsRegistry.hasDeviceClass(id, "mobile"));
    const sessionId = body.sessionId?.trim() || mobileOnline[0] || online[0] || "";
    if (!sessionId) {
      return reply.code(400).send({ ok: false, error: "无在线 session，且未指定 sessionId" });
    }
    if (body.markSent) {
      if (!deps.eveningDigestScheduler) {
        return reply.code(503).send({ ok: false, error: "eveningDigestScheduler 未注入" });
      }
      // 跨零点语义（2026-11-06 修复）：凌晨（<6 点）补推的是「昨晚的卡」，
      // 额度必须落到昨天——落今天会把今晚的到点推送一并吞掉
      //（2026-11-05 凌晨 01:43 的补发标记吞掉了当晚 21:00 推送，实证）。
      const now = new Date();
      const dayKey = (d: Date): string =>
        `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      const markDay =
        now.getHours() < 6
          ? dayKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1))
          : dayKey(now);
      deps.eveningDigestScheduler.markSentDay(sessionId, markDay);
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
      markSent: body.markSent === true,
      sessionId,
      onlineSessions: online,
      narrationText: digest.narrationText,
      digest,
    };
  });
}
