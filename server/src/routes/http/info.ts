import type { FastifyInstance } from "fastify";
import { resolveActorId } from "../../agent/actor-id.js";
import {
  infoNewsQuerySchema,
  infoReadBodySchema,
  infoSearchQuerySchema,
  infoTrackCreateBodySchema,
  infoTrackListQuerySchema,
  infoTrackRunBodySchema,
} from "../../schemas/api.js";
import type { HttpRouteDeps } from "./types.js";

export function registerInfoRoutes(app: FastifyInstance, deps: HttpRouteDeps): void {
  const { infoHubService, scheduleTaskService } = deps;

  app.get("/info", async () => ({
    domain: "info",
    endpoints: ["/info/search", "/info/news", "/info/read", "/info/track/topics"],
  }));

  app.get("/info/search", async (request, reply) => {
    const parsed = infoSearchQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    }
    const items = await infoHubService.search(parsed.data.q, parsed.data.limit ?? 8);
    return { ok: true, items };
  });

  app.get("/info/news", async (request, reply) => {
    const parsed = infoNewsQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    }
    const items = await infoHubService.fetchNews(parsed.data.topic, parsed.data.limit ?? 8);
    return { ok: true, items };
  });

  app.post("/info/read", async (request, reply) => {
    const parsed = infoReadBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    }
    try {
      const article = await infoHubService.readWebpage(parsed.data.url);
      return { ok: true, article };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return reply.code(400).send({ ok: false, message });
    }
  });

  app.get("/info/track/topics", async (request, reply) => {
    const parsed = infoTrackListQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    }
    const actorId = resolveActorId({
      userId: parsed.data.userId,
      sessionId: parsed.data.sessionId,
    });
    const topics = infoHubService.listTopicsBySession(parsed.data.sessionId, actorId);
    return { ok: true, topics };
  });

  app.post("/info/track/topics", async (request, reply) => {
    const parsed = infoTrackCreateBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    }
    try {
      const actorId = resolveActorId({
        userId: parsed.data.userId,
        sessionId: parsed.data.sessionId,
      });
      const runAt = parsed.data.runAt
        ? new Date(parsed.data.runAt).toISOString()
        : new Date(Date.now() + 15 * 60_000).toISOString();
      const scheduleTask = await scheduleTaskService.createTask({
        sessionId: parsed.data.sessionId,
        title: `追踪话题: ${parsed.data.name}`,
        description: `自动追踪话题 ${parsed.data.name}，关键词：${parsed.data.keywords.join(", ")}`,
        kind: "action",
        runAt,
        recurrence: parsed.data.recurrence ?? "daily",
        timezone: "Asia/Shanghai",
        action: {
          url: "http://127.0.0.1:3000/info/track/run",
          method: "POST",
          body: {
            sessionId: parsed.data.sessionId,
            actorId,
            mode: "keywords",
            keywords: parsed.data.keywords,
            name: parsed.data.name,
          },
        },
      });
      const topic = await infoHubService.createTopic({
        sessionId: parsed.data.sessionId,
        actorId,
        name: parsed.data.name,
        keywords: parsed.data.keywords,
        scheduleTaskId: scheduleTask.taskId,
      });
      return { ok: true, topic, scheduleTask };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return reply.code(400).send({ ok: false, message });
    }
  });

  app.post("/info/track/run", async (request, reply) => {
    const parsed = infoTrackRunBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    }
    try {
      if (parsed.data.topicId) {
        // 定时任务自调用时带 actorId（创建时写入 action.body），普通请求按鉴权身份解析
        const actorId = resolveActorId({
          userId: parsed.data.userId ?? parsed.data.actorId,
          sessionId: parsed.data.sessionId ?? "",
        });
        const result = await infoHubService.runTopic(parsed.data.topicId, actorId);
        return { ok: true, ...result };
      }
      const keywords = (parsed.data.keywords ?? []).map((k) => k.trim()).filter(Boolean);
      const query = keywords.join(" ");
      const [news, docs] = await Promise.all([
        infoHubService.fetchNews(query, 6),
        infoHubService.search(query, 6),
      ]);
      return {
        ok: true,
        topic: {
          sessionId: parsed.data.sessionId ?? "",
          name: parsed.data.name ?? query,
          keywords,
        },
        items: [...news, ...docs].slice(0, 10),
      };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return reply.code(400).send({ ok: false, message });
    }
  });
}
