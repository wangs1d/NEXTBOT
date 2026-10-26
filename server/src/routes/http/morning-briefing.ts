import type { FastifyInstance } from "fastify";

import {
  MorningBriefingService,
  type MorningBriefingDeps,
} from "../../services/morning-briefing-service.js";

export function registerMorningBriefingRoutes(
  app: FastifyInstance,
  deps?: MorningBriefingDeps,
): void {
  app.get("/api/morning-briefing", async (request, reply) => {
    const query = request.query as {
      sessionId?: string;
      format?: string;
      includeInProgressTravel?: string;
    };
    const { sessionId, format } = query;
    if (!sessionId) {
      return reply.code(400).send({ ok: false, error: "sessionId required" });
    }
    // 在途行程段只给手机端：手机端显式带 includeInProgressTravel=1，
    // 电脑端不传 → 晨报里不出现正在走的那段行程。
    const options = {
      includeInProgressTravel:
        query.includeInProgressTravel === "1" ||
        query.includeInProgressTravel === "true",
    };
    // llmComplete（口语润色）必须注入，客户端启动简报走本路由，
    // 播报稿口径要与调度推送路径一致
    const service = new MorningBriefingService(deps);
    if (format === "narration") {
      const narration = await service.narrateBriefing(sessionId, options);
      return { ok: true, ...narration };
    }
    const briefing = await service.generateBriefing(sessionId, options);
    return { ok: true, briefing };
  });
}
