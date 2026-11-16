// 动作意图 HTTP 路由（2026-11-13「通知即界面」）——通知栏按钮的执行入口。
//
// POST /api/action-intents/execute   执行一个动作（通知栏点按钮 → 这里）
//        body: { token, input?, actorId? }
//        token 是签发时就绑定好的**一次性凭据**——它本身就是授权，
//        不依赖「App 还活着」「WS 还连着」「用户登录着」。
// GET  /api/action-intents/:intentId 查一条意图的状态（回执/诊断用）
//
// 安全模型：
//   · token = HMAC-SHA256 签名（见 action-intent-service.ts），不可伪造、不可猜
//   · 过期即拒：通知可能被几小时后才看到，超期的按钮不执行（而不是静默作废）
//   · 幂等：同一 action 连点两次只执行一次（第二次返回上次结果，不是错误）
//   · 归属：请求带得出稳定身份时必须与意图归属一致；匿名/占位身份放行
//     （本地单用户部署 + 后台 isolate 回调没有登录态，不能因此把按钮打死）
import type { FastifyInstance } from "fastify";

import { isEphemeralActorId, resolveActorId } from "../../agent/actor-id.js";
import type { ActionIntentService } from "../../proactivity/action-intent-service.js";

export interface ActionIntentRouteDeps {
  actionIntentService: ActionIntentService;
}

export function registerActionIntentRoutes(app: FastifyInstance, deps: ActionIntentRouteDeps): void {
  const { actionIntentService } = deps;

  /** POST /api/action-intents/execute：通知栏按钮 → 执行 */
  app.post("/api/action-intents/execute", async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const token = typeof body.token === "string" ? body.token.trim() : "";
    if (!token) return reply.code(400).send({ ok: false, error: "缺少 token" });

    const input = typeof body.input === "string" ? body.input : undefined;
    const claimedActorId = resolveActorId({
      userId: typeof body.userId === "string" ? body.userId : undefined,
      sessionId: typeof body.sessionId === "string" ? body.sessionId : "",
    });
    // 请求带得出稳定身份且与意图归属不符 → 拒绝（token 外流到别人手里的防线）
    if (!isEphemeralActorId(claimedActorId)) {
      const intent = actionIntentService.get(decodeIntentIdFromToken(token));
      if (intent && intent.actorId !== claimedActorId) {
        return reply.code(403).send({ ok: false, error: "这个动作不属于当前账号" });
      }
    }

    const outcome = await actionIntentService.execute(token, {
      ...(input !== undefined ? { input } : {}),
    });
    if (!outcome.ok) {
      const status = outcome.code === "expired" || outcome.code === "cancelled" ? 410 : 400;
      return reply.code(status).send({
        ok: false,
        code: outcome.code,
        error: outcome.error,
        ...(outcome.intent ? { intentId: outcome.intent.intentId } : {}),
      });
    }
    return {
      ok: true,
      intentId: outcome.intent.intentId,
      actionId: outcome.action.actionId,
      alreadyExecuted: outcome.alreadyExecuted,
      message: outcome.result.message,
      ...(outcome.result.detail ? { detail: outcome.result.detail } : {}),
    };
  });

  /** GET /api/action-intents/:intentId：查意图状态（回执 / 诊断） */
  app.get("/api/action-intents/:intentId", async (request, reply) => {
    const { intentId } = request.params as { intentId: string };
    const intent = actionIntentService.get(intentId);
    if (!intent) return reply.code(404).send({ ok: false, error: "意图不存在或已清理" });
    const query = request.query as { userId?: string; sessionId?: string };
    const actorId = resolveActorId({ userId: query.userId, sessionId: query.sessionId ?? "" });
    if (!isEphemeralActorId(actorId) && intent.actorId !== actorId) {
      return reply.code(403).send({ ok: false, error: "这个动作不属于当前账号" });
    }
    return {
      ok: true,
      intent: {
        intentId: intent.intentId,
        kind: intent.kind,
        title: intent.title,
        body: intent.body,
        risk: intent.risk,
        state: intent.state,
        createdAt: intent.createdAt,
        expiresAt: intent.expiresAt,
        executedActions: intent.executedActions,
        ...(intent.lastResult ? { lastResult: intent.lastResult } : {}),
      },
    };
  });
}

/**
 * 从 token 里解出 intentId（**不验签**，只用于归属预检）。
 * 真正的授权在 execute 内部做验签；这里解错只会导致归属预检放行/拒绝的判断偏差，
 * 不会绕过验签——execute 里还会再解一次并比对 intent。
 */
function decodeIntentIdFromToken(token: string): string {
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "ai1") return "";
  try {
    const parsed = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as { i?: string };
    return typeof parsed.i === "string" ? parsed.i : "";
  } catch {
    return "";
  }
}
