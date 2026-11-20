// HTTP 路由：主动触达负反馈抑制表（Task 20 统一频控框架）
//
// 提供简单的记录/查询/解除接口，供主对话链路识别负反馈后调用（也可外部
// 调试用）。持久化在 data/proactivity-suppression/{actorId}.json，由
// ProactivityHub 在每次主动发送前检查。
import type { FastifyInstance } from "fastify";

import type { ProactivitySuppressionStore } from "../../proactivity/suppression-store.js";

/** 允许的触达类别（白名单防任意 kind 注入；列表与频控 kind 对齐；
 *  greeting 仍被晨间简报 proposalKind 使用，不可删） */
const ALLOWED_KINDS = new Set([
  "greeting",
  "interest_share",
  "interest_alert",
  "followup",
  "task_celebration",
  "weather_alert",
  "life_reminder",
  "monthly_report",
]);

export function registerProactivitySuppressionRoutes(
  app: FastifyInstance,
  deps: { suppressionStore: ProactivitySuppressionStore },
): void {
  const store = deps.suppressionStore;

  // 查询某 actor 的抑制列表
  app.get("/api/proactivity/suppression", async (request, reply) => {
    const query = request.query as { actorId?: string };
    const actorId = String(query.actorId ?? "").trim();
    if (!actorId) {
      return reply.code(400).send({ ok: false, error: "actorId required" });
    }
    return { ok: true, actorId, suppressions: store.list(actorId) };
  });

  // 记录一条负反馈抑制（kind 必填；keywords 可选，空=抑制整个 kind）
  app.post("/api/proactivity/suppression", async (request, reply) => {
    const body = (request.body ?? {}) as {
      actorId?: string;
      kind?: string;
      keywords?: unknown;
      note?: string;
    };
    const actorId = String(body.actorId ?? "").trim();
    const kind = String(body.kind ?? "").trim();
    if (!actorId) {
      return reply.code(400).send({ ok: false, error: "actorId required" });
    }
    if (!kind) {
      return reply.code(400).send({ ok: false, error: "kind required" });
    }
    if (!ALLOWED_KINDS.has(kind)) {
      return reply.code(400).send({
        ok: false,
        error: `未知 kind「${kind}」，可选：${Array.from(ALLOWED_KINDS).join(", ")}`,
      });
    }
    const keywords = Array.isArray(body.keywords)
      ? body.keywords.map((k) => String(k).trim()).filter(Boolean)
      : [];
    const suppressions = await store.add(actorId, kind, keywords, body.note);
    return { ok: true, actorId, suppressions };
  });

  // 解除抑制（target=条目 id 或 kind；kind 级解除清掉该 kind 全部条目）
  app.delete("/api/proactivity/suppression", async (request, reply) => {
    const body = (request.body ?? {}) as { actorId?: string; target?: string };
    const actorId = String(body.actorId ?? "").trim();
    const target = String(body.target ?? "").trim();
    if (!actorId || !target) {
      return reply.code(400).send({ ok: false, error: "actorId and target required" });
    }
    const suppressions = await store.remove(actorId, target);
    return { ok: true, actorId, suppressions };
  });
}
