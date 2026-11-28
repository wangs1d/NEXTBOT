// 离线事件统一降级（2026-11-26）：WS 不在线（或手机端不在线）时，把需要后台
// 到达的事件镜像到厂商 push 的 data-only 通道，而不是只有提醒/attention 有兜底。
//
// 边界：
//  - 只镜像白名单事件：聊天收口 / 卡片原地更新 / 明日预览 / 今日看板。心跳、遥测、桌面专属
//    控制帧一律不推，避免厂商通道被噪音打爆。
//  - 在线手机端不镜像（mobileDelivered=true）：WS 已经送达，再推就是双份打扰。
//  - 同一个稳定键 10 分钟内只推一次：重发 / 多端 fan-out / 重连补投不会重复弹。
//  - 卡片与看板是状态同步（silent:true）：只写穿、不弹系统通知。
import { createHash } from "node:crypto";

import { ServerEventType } from "@nextbot/agent-protocol";

import type { PushAttemptResult, PushInput } from "./mobile-push-service.js";
import { stripDisplayProtocol } from "../utils/stream-marker-guard.js";

export type OfflineMirrorContext = {
  actorId: string;
  data: string;
  /** 手机端是否已经有在线连接收到这一帧 */
  mobileDelivered: boolean;
};

export type OfflineEventPusherDeps = {
  push: (input: PushInput) => Promise<PushAttemptResult>;
  hasChannel: (actorId: string) => boolean;
  now?: () => number;
};

const DEDUPE_TTL_MS = 10 * 60_000;
const MIRRORED_TYPES = new Set<string>([
  ServerEventType.ChatAssistantDone,
  ServerEventType.CardUpdate,
  ServerEventType.EveningDigest,
  "agent.today_board",
]);

type MappedEvent = {
  title: string;
  body: string;
  importance: string;
  kind: string;
  deliveryId: string;
  stableKey: string;
  silent: boolean;
};

function shortHash(raw: string): string {
  return createHash("sha1").update(raw).digest("hex").slice(0, 20);
}

function summaryOf(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const text = stripDisplayProtocol(value).replace(/\s+/g, " ").trim();
  if (!text) return fallback;
  return text.slice(0, 160);
}

function mapEvent(type: string, payload: Record<string, unknown>): MappedEvent | null {
  if (type === ServerEventType.ChatAssistantDone) {
    // 主动消息的离线必达由 proactive-pipeline / attention 自己负责（带动作意图、
    // 重试与 dedupKey）。这里再镜像一次会产生第二条系统通知和第二个气泡。
    if (
      typeof payload.proactive === "object" &&
      payload.proactive !== null &&
      Object.keys(payload.proactive as Record<string, unknown>).length > 0
    ) {
      return null;
    }
    const proactive = (payload.proactive ?? {}) as Record<string, unknown>;
    const deliveryId =
      (proactive.deliveryId ?? payload.deliveryId ?? payload.traceId ?? payload.messageId ?? "")
        .toString()
        .trim();
    const messageId = (payload.messageId ?? payload.traceId ?? "").toString().trim();
    if (!deliveryId && !messageId) return null;
    return {
      title: (proactive.title ?? "").toString().trim() || "NEXTBOT",
      body: summaryOf(payload.finalText, "你有一条新回复"),
      importance: (proactive.importance ?? "high").toString(),
      kind: (proactive.kind ?? "chat").toString(),
      deliveryId: deliveryId || messageId,
      stableKey: deliveryId || `chat-${messageId}`,
      silent: false,
    };
  }
  if (type === ServerEventType.EveningDigest) {
    const digest =
      payload.digest && typeof payload.digest === "object" && !Array.isArray(payload.digest)
        ? (payload.digest as Record<string, unknown>)
        : {};
    const date = typeof digest.date === "string" ? digest.date.trim() : "";
    const stableKey =
      (payload.messageId ?? "").toString().trim() ||
      (date ? `evening-digest-${date}` : `evening-digest-${shortHash(JSON.stringify(payload))}`);
    return {
      title: "明日速览",
      body: summaryOf(payload.narrationText ?? digest.narrationText, "你的明日预览已更新"),
      importance: "medium",
      kind: "evening_digest",
      deliveryId: stableKey,
      stableKey,
      silent: false,
    };
  }
  if (type === ServerEventType.CardUpdate) {
    const messageId = (payload.messageId ?? "").toString().trim();
    if (!messageId) return null;
    const cardKey = shortHash(`${messageId}|${JSON.stringify(payload.card ?? {})}`);
    return {
      title: "NEXTBOT",
      body: "一张卡片已更新",
      importance: "low",
      kind: "chat",
      deliveryId: `card-${cardKey}`,
      stableKey: `card-${cardKey}`,
      silent: true,
    };
  }
  if (type === "agent.today_board") {
    const title = (payload.title ?? "").toString().trim() || "今日状态";
    const text = (payload.text ?? "").toString().trim();
    const updatedAt = (payload.updatedAt ?? "").toString();
    return {
      title,
      body: text || "管家在",
      importance: "low",
      kind: "reminder",
      deliveryId: `board-${shortHash(`${title}|${text}|${updatedAt}`)}`,
      stableKey: `board-${shortHash(`${title}|${text}|${updatedAt}`)}`,
      silent: true,
    };
  }
  return null;
}

/**
 * 建一个「WS 离线 → push 镜像」回调，直接挂到 WsConnectionRegistry.onOfflineEvent。
 * 返回值是给测试/诊断用的 handle，不改变 registry 的投递返回值。
 */
export function createOfflineEventPusher(deps: OfflineEventPusherDeps) {
  const now = deps.now ?? Date.now;
  const recentlyPushed = new Map<string, number>();

  function alreadyPushed(key: string): boolean {
    const at = recentlyPushed.get(key);
    if (at === undefined || now() - at > DEDUPE_TTL_MS) return false;
    return true;
  }

  function remember(key: string): void {
    for (const [k, at] of recentlyPushed) {
      if (now() - at > DEDUPE_TTL_MS) recentlyPushed.delete(k);
    }
    recentlyPushed.set(key, now());
  }

  return {
    handle(ctx: OfflineMirrorContext): void {
      if (ctx.mobileDelivered) return;
      if (!deps.hasChannel(ctx.actorId)) return;
      let frame: unknown;
      try {
        frame = JSON.parse(ctx.data);
      } catch {
        return;
      }
      if (!frame || typeof frame !== "object") return;
      const { type, payload } = frame as Record<string, unknown>;
      if (typeof type !== "string" || !MIRRORED_TYPES.has(type)) return;
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) return;
      const mapped = mapEvent(type, payload as Record<string, unknown>);
      if (!mapped || alreadyPushed(mapped.stableKey)) return;
      remember(mapped.stableKey);
      void deps
        .push({
          actorId: ctx.actorId,
          ...mapped,
          event: type,
          wire: ctx.data,
        })
        .catch(() => {
          /* push 失败保持静默：WAL / 看板 refresh 仍是兜底 */
        });
    },
  };
}
