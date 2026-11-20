import { resolveActorId } from "../agent/actor-id.js";
import { isExplicitPhoneCallRequest } from "../agent/phone-call-intent.js";
import type { VirtualPhoneRingStyle } from "../services/virtual-phone-service.js";
import type { VirtualPhoneService } from "../services/virtual-phone-service.js";
import type { ToolRegistry } from "./tool-registry.js";
import type { ReachDecisionService } from "../proactivity/reach-decision-service.js";
import { IMPORTANCE_STAKES } from "../proactivity/reach-decision.js";
import type { ProactiveImportance } from "../proactivity/pipeline-types.js";

/** 模型自报 importance 只映射到价值 stakes，绝不映射到 must bypass。 */
const CALL_IMPORTANCES = new Set(["low", "medium", "high", "critical"]);
function callStakes(raw: unknown): number {
  const v = String(raw ?? "").trim().toLowerCase();
  const importance = (CALL_IMPORTANCES.has(v) ? v : "medium") as ProactiveImportance;
  return IMPORTANCE_STAKES[importance];
}

/**
 * `phone.call_user` 同轮内去重：同一 chatUserMessageId + 同一被叫只打一次。
 * 跨轮（用户主动说「再打一次」/「打一次确认」）必须真的能响铃。
 * chatUserMessageId 缺失时回退到 sessionId + 30s 短窗口防重试，避免完全无界。
 */
const CALL_USER_DEDUP_TTL_MS = 30_000; // 30s 内同 round 重复去重；跨 round 重新放行
const callUserDedupCache = new Map<string, { result: Record<string, unknown>; ts: number }>();

function cleanCallUserDedupCache(): void {
  const now = Date.now();
  for (const [key, entry] of callUserDedupCache) {
    if (now - entry.ts > CALL_USER_DEDUP_TTL_MS) {
      callUserDedupCache.delete(key);
    }
  }
}

export function registerAgentPhoneTools(
  registry: ToolRegistry,
  phone: VirtualPhoneService,
  reachDecision?: ReachDecisionService,
): void {
  registry.register("phone.ensure_my_number", async (_input, context) => {
    const actorId = resolveActorId(context);
    const number = await phone.ensureNumber(actorId);
    return {
      ok: true,
      actorId,
      virtualPhone: number,
      summary: `您的虚拟号码为 ${number}（登记在本 Agent 名下，与您共用）。其他 Agent 可拨打此号联系您（配对规则同中继）。`,
    };
  });

  registry.register("phone.call_user", async (input, context) => {
    const actorId = resolveActorId(context);
    const toUserId = String(input.toUserId ?? input.userId ?? context.userId ?? context.sessionId ?? "").trim();
    const spokenMessage = String(input.spokenMessage ?? input.message ?? input.transcript ?? "").trim();
    const ringStyleRaw = String(input.ringStyle ?? "peer").trim().toLowerCase();
    const ringStyle: VirtualPhoneRingStyle =
      ringStyleRaw === "reminder" ? "reminder" : "peer";

    if (!toUserId) throw new Error("缺少 toUserId / userId（被叫用户标识）");
    if (!spokenMessage) throw new Error("缺少 spokenMessage（用户将听到的语音内容）");

    // ── 主动触达决策闸门（phone.call_user）──
    // 来电是最重通道（振铃 + 占用注意力），准入门槛最高。
    // 用户显式要求打电话 → 绕过；agent 自主呼出 → 必须挣得 phone 通道。
    // 反馈/上下文按被叫用户（真正被打断的人）取样，而非主叫 Agent。
    // 未注入决策服务时保持旧行为（向后兼容）。
    if (reachDecision && !isExplicitPhoneCallRequest(context.userText ?? "")) {
      const decision = reachDecision.decide({
        actorId: toUserId,
        kind: "agent_phone_call",
        // 固定 medium：模型不能靠自报 importance=critical 拿到 must 旁路
        importance: "medium",
        requestedChannel: "phone",
        value: {
          // 由模型声明的事关程度挣得 phone 通道；不给 must 旁路（防 self-report 架空闸门）
          stakes: callStakes(input.importance),
          urgency: ringStyle === "reminder" ? 0.6 : 0.4,
          beneficiary: 0.9,
        },
      });
      const phoneAllowed = decision.action === "send_now" && decision.channel === "phone";
      if (!phoneAllowed) {
        return {
          ok: false,
          suppressedByReachDecision: true,
          action: decision.action,
          channel: decision.channel,
          reason: decision.reason,
          utility: decision.utility,
          acceptance: decision.p,
          hint: `主动来电被触达决策抑制（${decision.action}${decision.channel ? `/${decision.channel}` : ""}: ${decision.reason}）。请改用文本或普通语音消息回复，不要复述本提示。`,
          summary: `主动来电被触达决策抑制，请改用文本或语音消息。`,
        };
      }
    }

    // 号码注册制门禁：主叫 Agent 必须已申领站内号码才能呼出
    if (!phone.getPhoneForActor(actorId)) {
      return {
        ok: false,
        retryable: false,
        error:
          "尚未申领站内号码，无法呼出。请向用户说明需要先办理：用户明确同意后调用 phone.ensure_my_number 申领，再重试本次呼叫。",
      };
    }

    // 去重：同一轮（chatUserMessageId）+ 同一被叫只打一次
    // 跨轮（用户下一句「再打一次」）必须真的能响铃
    cleanCallUserDedupCache();
    const roundId = context.chatUserMessageId || context.sessionId;
    const dedupKey = `${roundId}:${toUserId}`;
    const cached = callUserDedupCache.get(dedupKey);
    if (cached) {
      return {
        ...cached.result,
        deduped: true,
        summary: `(同轮重复调用已拦截) ${cached.result.summary ?? ""}`,
      };
    }

    const result = await phone.callUser({
      fromActorId: actorId,
      toUserId,
      transcript: spokenMessage,
      ringStyle,
    });

    const response: Record<string, unknown> = {};
    if (!result.ok) {
      return {
        ok: false,
        error: result.error ?? "呼叫用户失败",
        retryable: true,
        hint: "电话功能暂时不可用，可能是网络或配置问题，稍后可重试。不要回复用户「做不到」「无法拨号」等否定性表述。",
      };
    }

    response.ok = true;
    response.callId = result.callId;
    response.pushed = result.pushed;
    response.toUserId = result.toUserId;
    response.fromPhone = result.fromPhone;
    response.summary = result.pushed
        ? "已向用户推送虚拟来电（含TTS语音），用户可在客户端接听并回复。"
        : "通话请求已发出但用户当前离线（未连接 WebSocket），上线后可收到。这不是功能缺失，是网络状态问题。";

    // 来电成功也计入被叫用户的突发窗口：与语音条共用 BURST_BREAKER 频控口径。
    // 按被叫记账（与决策取样一致）。记账是旁路，失败不影响呼叫结果。
    try {
      reachDecision?.recordVoiceDelivery(toUserId);
    } catch {
      /* burst accounting is best-effort */
    }

    // 写入缓存
    callUserDedupCache.set(dedupKey, { result: response, ts: Date.now() });

    return response;
  });
}
