import type { FastifyInstance } from "fastify";

import { resolveActorId } from "../../agent/actor-id.js";
import { normalizeDialNumber } from "../../tools/phone-bridge-tools.js";
import type { PhoneBridgeCoordinator } from "../../services/phone-bridge-coordinator.js";

export type PhoneBridgeHttpDeps = {
  phoneBridgeCoordinator: PhoneBridgeCoordinator;
};

/**
 * 客户端（桌面「手机」页 / 手机 App UI）可直接触发的 bridge 动作白名单。
 *
 * 与 `phone-bridge-tools.ts` 暴露给 Agent 的工具集合对齐，但**刻意不含**：
 *  - camera_capture / screen_record —— 会写盘留痕且涉及摄像头/录屏授权，
 *    只允许经 Agent 工具链按用户显式指令触发，不开放给 UI 直调；
 *  - notifications —— 手机端桥接 `_handleInvoke` 目前未实现该 action，
 *    下发只会得到 `action_not_supported`，故不列入。
 */
const CLIENT_INVOKE_ACTIONS = new Set<string>([
  "dial",
  "send_sms",
  "ring",
  "locate",
  "sms_list",
  "call_log",
  "battery",
]);

/** 身份解析：兼容旧 `actorId` 直传，否则按 `userId → sessionId` 归一（与 /device 一致）。 */
function actorFromQuery(data: {
  actorId?: string;
  userId?: string;
  sessionId?: string;
}): string {
  const direct = (data.actorId ?? "").trim();
  if (direct) return direct;
  return resolveActorId({ userId: data.userId, sessionId: data.sessionId ?? "" });
}

/** 短信收件号码归一：仅保留数字与 `+`，长度 3–20 位（短号 106 等也放行）。 */
function normalizeSmsNumber(raw: string): string | null {
  const digits = raw.trim().replace(/[^\d+]/g, "");
  const bare = digits.replace(/\+/g, "");
  if (bare.length < 3 || bare.length > 20) return null;
  return digits;
}

function asInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

export function registerPhoneBridgeRoutes(app: FastifyInstance, deps: PhoneBridgeHttpDeps): void {
  app.get<{
    Querystring: { actorId?: string; userId?: string; sessionId?: string };
  }>("/phone-bridge", async (request) => {
    const actorId = actorFromQuery(request.query);
    const payload = deps.phoneBridgeCoordinator.getSyncPayload(actorId);
    return { ok: true, ...payload };
  });

  app.get<{
    Querystring: { actorId?: string; userId?: string; sessionId?: string };
  }>("/phone-bridge/status", async (request) => {
    const actorId = actorFromQuery(request.query);
    const online = deps.phoneBridgeCoordinator.hasExecutor(actorId);
    const deviceInfo = deps.phoneBridgeCoordinator.getDeviceInfo(actorId);
    return { ok: true, phoneBridgeOnline: online, deviceInfo: deviceInfo ?? null };
  });

  /**
   * POST /phone-bridge/invoke
   *
   * 客户端 UI 直接下发一条能力指令给**已绑定的用户手机**执行（拨号/短信/响铃/
   * 定位/读取短信与通话记录等）。与 Agent 工具链共用 `PhoneBridgeCoordinator.invoke`，
   * 因此同样受「桥接在线 + 30s 超时 + 手机端确认窗」约束。
   *
   * body: { actorId? | userId?/sessionId?, action, params? }
   * 返回：透传手机端回执 `{ ok, ...result }`；失败时 `{ ok:false, error }`。
   */
  app.post<{
    Body: {
      actorId?: string;
      userId?: string;
      sessionId?: string;
      action?: string;
      params?: Record<string, unknown>;
    };
  }>("/phone-bridge/invoke", async (request, reply) => {
    const body = request.body ?? {};
    const actorId = actorFromQuery(body);
    if (!actorId || actorId === "anonymous") {
      return reply.code(400).send({ ok: false, error: "actorId required" });
    }

    const action = String(body.action ?? "").trim();
    if (!CLIENT_INVOKE_ACTIONS.has(action)) {
      return reply
        .code(400)
        .send({ ok: false, error: `action not allowed from client: ${action || "(empty)"}` });
    }

    if (!deps.phoneBridgeCoordinator.hasExecutor(actorId)) {
      return reply.code(409).send({
        ok: false,
        error: "phone bridge offline",
        message: "手机端未连接：请打开手机 App 并保持「手机桥接」开启。",
      });
    }

    const raw = (body.params ?? {}) as Record<string, unknown>;

    // 逐动作构造**受控**参数：只透传白名单字段，其余（含未知键）一律丢弃，
    // 避免 UI 端误传脏数据进手机原生层。
    let params: Record<string, unknown>;
    switch (action) {
      case "dial": {
        const number = normalizeDialNumber(String(raw.number ?? ""));
        if (!number) {
          return reply
            .code(400)
            .send({ ok: false, error: "号码不合法或为紧急号码，已拒绝拨打" });
        }
        params = {
          number,
          contactName: String(raw.contactName ?? "").trim(),
          reason: String(raw.reason ?? "").trim(),
          mode: raw.mode === "draft" ? "draft" : "direct",
        };
        break;
      }
      case "send_sms": {
        const number = normalizeSmsNumber(String(raw.number ?? ""));
        if (!number) {
          return reply.code(400).send({ ok: false, error: "收件号码不合法" });
        }
        const text = String(raw.text ?? "").trim();
        if (!text) {
          return reply.code(400).send({ ok: false, error: "短信内容不能为空" });
        }
        params = {
          number,
          text,
          contactName: String(raw.contactName ?? "").trim(),
          reason: String(raw.reason ?? "").trim(),
        };
        break;
      }
      case "ring":
        params = {
          reason: String(raw.reason ?? "").trim(),
          durationSec: asInt(raw.durationSec, 15, 1, 60),
          vibrate: raw.vibrate !== false,
        };
        break;
      case "sms_list":
      case "call_log":
        params = { limit: asInt(raw.limit, 20, 1, 100) };
        break;
      // locate / battery 无参
      default:
        params = {};
        break;
    }

    const result = await deps.phoneBridgeCoordinator.invoke(actorId, action, params);
    // 归一化 ok 为布尔：手机端/超时回执里 ok 可能缺失或非布尔。
    return reply.send({ ...result, ok: result.ok === true });
  });
}
