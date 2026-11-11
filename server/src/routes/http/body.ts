// Agent Body Center —— HTTP 路由
import type { FastifyInstance } from "fastify";
import type { HttpRouteDeps } from "./types.js";
import type { BodyAction } from "../../body/types.js";
import type { ReflexPattern } from "../../body/reflex-arc.js";

/**
 * 注册 Body Center 相关的 HTTP 路由。
 * - GET  /body/state              全部身体模块状态快照
 * - GET  /body/where_am_i         查询当前具身位置
 * - GET  /body/modules            所有 BodyModule 及其工具清单
 * - POST /body/act                注入 BodyAction 走完整反射+执行流水线
 * - POST /body/reflex/patterns    热加载新危险模式
 * - GET  /body/reflex/patterns    列出所有反射模式
 *
 * bodyCenter 为 null（未启用）时，每个端点返回 503 + not enabled。
 * reflexArc 为 null 时，/body/reflex/patterns 端点返回 503 + not configured。
 */
export function registerBodyRoutes(app: FastifyInstance, deps: HttpRouteDeps): void {
  // 全部身体模块状态快照
  app.get("/body/state", async (_request, reply) => {
    try {
      if (!deps.bodyCenter) {
        return reply.code(503).send({ ok: false, error: "Body Center not enabled" });
      }
      const snap = deps.bodyCenter.snapshot();
      return reply.send({ ok: true, ...snap });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.code(500).send({ ok: false, error: message });
    }
  });

  // 查询当前具身位置
  app.get("/body/where_am_i", async (request, reply) => {
    try {
      if (!deps.bodyCenter) {
        return reply.code(503).send({ ok: false, error: "Body Center not enabled" });
      }
      const rawActorId = (request.query as { actorId?: string }).actorId;
      const actorId =
        typeof rawActorId === "string" && rawActorId.trim() ? rawActorId.trim() : undefined;
      const result = await deps.bodyCenter.sense({ kind: "where_am_i", actorId });
      return reply.send({
        ok: result.ok,
        ...result.data,
        errorMessage: result.errorMessage,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.code(500).send({ ok: false, error: message });
    }
  });

  // 所有 BodyModule 及其工具清单
  app.get("/body/modules", async (_request, reply) => {
    try {
      if (!deps.bodyCenter) {
        return reply.code(503).send({ ok: false, error: "Body Center not enabled" });
      }
      const snap = deps.bodyCenter.snapshot();
      return reply.send({ ok: true, modules: snap.modules });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.code(500).send({ ok: false, error: message });
    }
  });

  // 注入 BodyAction 走完整反射+执行流水线
  app.post("/body/act", async (request, reply) => {
    try {
      if (!deps.bodyCenter) {
        return reply.code(503).send({ ok: false, error: "Body Center not enabled" });
      }
      const body = (request.body ?? {}) as Record<string, unknown>;
      const tool = typeof body.tool === "string" ? body.tool.trim() : "";
      if (!tool) {
        return reply.code(400).send({ ok: false, error: "missing or invalid tool" });
      }
      const args =
        typeof body.args === "object" && body.args !== null && !Array.isArray(body.args)
          ? (body.args as Record<string, unknown>)
          : {};
      // `actorId` 已被周界钉成裁决身份；调试要指定别的 actor 用 targetActorId。
      const rawActor = body.targetActorId ?? body.actorId;
      const actorId = typeof rawActor === "string" ? rawActor : undefined;
      const source = typeof body.source === "string" ? body.source : "external";
      const action: BodyAction = { tool, args, actorId, source };
      const result = await deps.bodyCenter.act(action);
      return reply.send({
        ok: result.ok,
        result: result.result,
        refused: result.refused,
        errorMessage: result.errorMessage,
        durationMs: result.durationMs,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.code(500).send({ ok: false, error: message });
    }
  });

  // 热加载新危险模式
  app.post("/body/reflex/patterns", async (request, reply) => {
    try {
      if (!deps.reflexArc) {
        return reply.code(503).send({ ok: false, error: "reflex arc not configured" });
      }
      const body = (request.body ?? {}) as Record<string, unknown>;
      const id = typeof body.id === "string" ? body.id.trim() : "";
      // HTTP/JSON 通道只能传字符串 pattern；RegExp 由内部代码构造
      const pattern = typeof body.pattern === "string" ? body.pattern : "";
      if (!id || !pattern) {
        return reply.code(400).send({ ok: false, error: "missing id or pattern" });
      }
      const tool = typeof body.tool === "string" && body.tool.trim() ? body.tool.trim() : undefined;
      const reason = typeof body.reason === "string" ? body.reason : "user pattern";
      const severity: ReflexPattern["severity"] =
        body.severity === "high_risk" ? "high_risk" : "deny";
      const reflexPattern: ReflexPattern = {
        id,
        pattern,
        tool,
        reason,
        severity,
        source: "user",
      };
      deps.reflexArc.registerPattern(reflexPattern);
      return reply.send({ ok: true, id });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.code(500).send({ ok: false, error: message });
    }
  });

  // 列出所有反射模式
  app.get("/body/reflex/patterns", async (_request, reply) => {
    try {
      if (!deps.reflexArc) {
        return reply.code(503).send({ ok: false, error: "reflex arc not configured" });
      }
      return reply.send({ ok: true, patterns: deps.reflexArc.listPatterns() });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.code(500).send({ ok: false, error: message });
    }
  });
}
