import type { PhoneBridgeCoordinator } from "../services/phone-bridge-coordinator.js";
import { resolveActorId } from "../agent/actor-id.js";
import type { ToolContext, ToolRegistry } from "./tool-registry.js";

export type PhoneBridgeToolsDeps = {
  bridge: PhoneBridgeCoordinator;
  /**
   * 通话记录入库 feeder（可选，晚绑定）：phone.call_log 拉取成功后回灌
   * call_log 流 → SourceStore 落盘，重启后历史通话仍可跨源检索。
   * bootstrap 里 proactivitySensors 创建晚于工具注册，经 ref holder 回填。
   */
  callLogFeed?: (signal: {
    actorId?: string;
    at: number;
    fingerprint: string;
    salience: "high" | "medium" | "low";
    delta?: string;
    payload?: Record<string, unknown>;
  }) => void;
};

function mustBeOnline(ctx: ToolContext): string {
  if (!ctx.phoneBridgeOnline) {
    return "phone bridge is not online";
  }
  const actorId = resolveActorId(ctx);
  if (!actorId) {
    return "actorId is missing";
  }
  return "";
}

/** 大陆与常见国际紧急号码：Agent 永远不允许代拨，误触发一律拒绝 */
const EMERGENCY_NUMBERS = new Set([
  "110",
  "119",
  "120",
  "122",
  "112",
  "114",
  "999",
  "911",
  "000",
]);

/**
 * 拨号号码归一化与安全校验：仅保留数字与 `+`（国际区号前缀），
 * 拒绝紧急号码与明显不合法的长度。返回 null 表示拒绝拨打。
 */
export function normalizeDialNumber(raw: string): string | null {
  const digits = raw.trim().replace(/[^\d+]/g, "");
  const bare = digits.replace(/\+/g, "");
  if (!bare || EMERGENCY_NUMBERS.has(bare)) return null;
  // 5 位下限：短号（如 10086/95588）放行；20 位上限：E.164 最长 15 位 + 冗余
  if (bare.length < 5 || bare.length > 20) return null;
  return digits;
}

/**
 * `phone.dial` 同轮去重：同一轮（chatUserMessageId）+ 同一被叫只拨一次。
 * 跨轮（用户说「再打一次」）重新放行；chatUserMessageId 缺失时退化为
 * sessionId + 30s 短窗口，避免完全无界。模式照抄 agent-phone-tools.ts。
 */
const DIAL_DEDUP_TTL_MS = 30_000;
const dialDedupCache = new Map<string, number>();

function cleanDialDedupCache(): void {
  const now = Date.now();
  for (const [key, ts] of dialDedupCache) {
    if (now - ts > DIAL_DEDUP_TTL_MS) dialDedupCache.delete(key);
  }
}

export function registerPhoneBridgeTools(registry: ToolRegistry, deps: PhoneBridgeToolsDeps) {
  registry.register("phone.battery", async (_params, ctx: ToolContext) => {
    const actorId = resolveActorId(ctx);
    const err = mustBeOnline(ctx);
    if (err) return { ok: false, error: err };
    return deps.bridge.invoke(actorId, "battery", {});
  });

  registry.register("phone.notifications", async (params, ctx: ToolContext) => {
    const actorId = resolveActorId(ctx);
    const err = mustBeOnline(ctx);
    if (err) return { ok: false, error: err };
    return deps.bridge.invoke(actorId, "notifications", { limit: params.limit ?? 20 });
  });

  registry.register("phone.camera_capture", async (params, ctx: ToolContext) => {
    const actorId = resolveActorId(ctx);
    const err = mustBeOnline(ctx);
    if (err) return { ok: false, error: err };
    return deps.bridge.invoke(actorId, "camera_capture", { camera: params.camera ?? "back" });
  });

  registry.register("phone.screen_record", async (params, ctx: ToolContext) => {
    const actorId = resolveActorId(ctx);
    const err = mustBeOnline(ctx);
    if (err) return { ok: false, error: err };
    return deps.bridge.invoke(actorId, "screen_record", { durationSec: params.durationSec ?? 15 });
  });

  registry.register("phone.locate", async (_params, ctx: ToolContext) => {
    const actorId = resolveActorId(ctx);
    const err = mustBeOnline(ctx);
    if (err) return { ok: false, error: err };
    return deps.bridge.invoke(actorId, "locate", {});
  });

  registry.register("phone.ring", async (params, ctx: ToolContext) => {
    const actorId = resolveActorId(ctx);
    const err = mustBeOnline(ctx);
    if (err) return { ok: false, error: err };
    return deps.bridge.invoke(actorId, "ring", {
      reason: params.reason ?? "",
      durationSec: params.durationSec ?? 15,
      volume: params.volume ?? 100,
      vibrate: params.vibrate ?? true,
    });
  });

  registry.register("phone.sms_list", async (params, ctx: ToolContext) => {
    const actorId = resolveActorId(ctx);
    const err = mustBeOnline(ctx);
    if (err) return { ok: false, error: err };
    return deps.bridge.invoke(actorId, "sms_list", { limit: params.limit ?? 20 });
  });

  registry.register("phone.call_log", async (params, ctx: ToolContext) => {
    const actorId = resolveActorId(ctx);
    const err = mustBeOnline(ctx);
    if (err) return { ok: false, error: err };
    const result = await deps.bridge.invoke(actorId, "call_log", { limit: params.limit ?? 20 });
    // 拉取成功即回灌入库（静默，salience=low；fingerprint 幂等去重），
    // 让通话记录参与跨源检索与历史查询，而不是只活在这一次对话里。
    if (result.ok === true && deps.callLogFeed) {
      try {
        feedCallLog(deps.callLogFeed, actorId, result);
      } catch (e) {
        console.warn(`[CallLog] 入库失败（忽略）: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    return result;
  });

  registry.register("phone.dial", async (params, ctx: ToolContext) => {
    const actorId = resolveActorId(ctx);
    const err = mustBeOnline(ctx);
    if (err) return { ok: false, error: err };

    const raw = String(params.number ?? params.phoneNumber ?? "").trim();
    if (!raw) return { ok: false, error: "缺少 number（被叫号码）" };
    const number = normalizeDialNumber(raw);
    if (!number) {
      return {
        ok: false,
        error: `号码不合法或为紧急号码，已拒绝拨打：${raw}`,
      };
    }

    // 同轮去重：防模型一轮内重复拨打同一号码
    cleanDialDedupCache();
    const roundId = ctx.chatUserMessageId || ctx.sessionId;
    const dedupKey = `${actorId}:${roundId}:${number}`;
    const lastAt = dialDedupCache.get(dedupKey);
    const now = Date.now();
    if (lastAt && now - lastAt < DIAL_DEDUP_TTL_MS) {
      return {
        ok: true,
        deduped: true,
        dialed: number,
        summary: "(同轮重复调用已拦截) 本轮已拨打过该号码。",
      };
    }

    const result = await deps.bridge.invoke(actorId, "dial", {
      number,
      contactName: String(params.contactName ?? "").trim(),
      reason: String(params.reason ?? "").trim(),
      // direct=手机端确认弹窗后直接拨出；draft=仅预填拨号盘，用户手动按键
      mode: params.mode === "draft" ? "draft" : "direct",
    });

    if (result.ok) {
      dialDedupCache.set(dedupKey, now);
    }
    return { ...result, summary: summarizeDialState(result) };
  });
}

/**
 * 通话记录回灌 call_log 流。端侧回执形态防御式解析：
 * calls/items 数组，字段 number|phone|address、name、type、duration、date|ts。
 * fingerprint = 号码|方向|时间，同一条通话重复拉取不会重复入库。
 * 导出供后台定时同步复用（同一条链路，同一套去重）。
 */
export function feedCallLog(
  feed: NonNullable<PhoneBridgeToolsDeps["callLogFeed"]>,
  actorId: string,
  result: Record<string, unknown>,
): void {
  const raw = Array.isArray(result.calls)
    ? result.calls
    : Array.isArray(result.items)
      ? result.items
      : [];
  const now = Date.now();
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const entry = item as Record<string, unknown>;
    const number = String(entry.number ?? entry.phone ?? entry.address ?? "").trim();
    if (!number) continue;
    const name = String(entry.name ?? "").trim();
    const type = String(entry.type ?? entry.callType ?? "").trim();
    const atMs = Number(entry.date ?? entry.ts ?? entry.timestamp ?? 0);
    const at = Number.isFinite(atMs) && atMs > 0 ? atMs : now;
    const durationSec = Number(entry.duration ?? 0) || 0;
    const typeLabel =
      /missed|未接/i.test(type) ? "未接"
      : /outgoing|out|去电|拨/i.test(type) ? "去电"
      : /incoming|in|来电/i.test(type) ? "来电"
      : type || "通话";
    feed({
      actorId,
      at,
      fingerprint: `call:${actorId}:${number}:${typeLabel}:${at}`,
      salience: "low",
      delta: name
        ? `与 ${name}（${number}）的${typeLabel}通话`
        : `与 ${number} 的${typeLabel}通话`,
      payload: { number, name, type: typeLabel, durationSec, date: new Date(at).toISOString() },
    });
  }
}

/** 把手机端回执的 state 翻译成模型可直接引用的一句话结果 */
function summarizeDialState(result: Record<string, unknown>): string {
  const state = String(result.state ?? "");
  if (state === "cancelled") {
    return "手机端确认被取消（用户拒绝或超时未确认），未拨出。";
  }
  if (!result.ok) {
    return `拨号未完成：${String(result.error ?? state ?? "手机端异常")}。不要回复用户「做不到」，可提示用户在手机上确认或稍后再试。`;
  }
  switch (state) {
    case "dialing":
      return "已在手机上确认并拨出，正在呼叫对方。";
    case "dialer_opened":
      return "已打开手机拨号盘并填好号码，等用户按下拨号键即拨出。";
    case "no_dialer":
      return "手机上没有可用的拨号应用，未拨出。";
    default:
      return "拨号请求已送达手机。";
  }
}
