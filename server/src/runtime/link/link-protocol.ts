import type { EventEnvelope } from "@nextbot/agent-protocol";

/**
 * runtime 链路线缆协议（gateway/外壳 ⇄ runtime 进程，WS 承载）。
 *
 * 与客户端协议（{@link EventEnvelope}）区分：链路是可信内网通道，采用
 * req/res + ev 三种帧；req 携带 correlationId，流式回调以 ev 帧回推，
 * 最终结果以 res/err 帧收尾。杀掉 runtime 重启后，gateway 重连即可恢复，
 * 未完成的 turn 以 err 帧收尾（调用方按失败处理）。
 */

/** 链路请求帧：method 见 {@link RUNTIME_LINK_METHODS}。 */
export type LinkRequest = {
  kind: "req";
  id: string;
  method: string;
  params: Record<string, unknown>;
};

/** 链路事件帧：流式回调回推（id 对应引发它的 req）。 */
export type LinkEvent = {
  kind: "ev";
  id: string;
  /** HandleUserMessageOptions 回调名（如 onAssistantDelta） */
  cb: string;
  args: unknown[];
};

/** 链路应答帧：成功。 */
export type LinkResponse = {
  kind: "res";
  id: string;
  ok: true;
  result: unknown;
};

/** 链路应答帧：失败 / turn 中断 / 链路级错误。 */
export type LinkError = {
  kind: "err";
  id: string;
  ok: false;
  message: string;
};

export type LinkFrame = LinkRequest | LinkEvent | LinkResponse | LinkError;

export const RUNTIME_LINK_METHODS = {
  Health: "runtime.health",
  HandleUserMessage: "runtime.handleUserMessage",
  RouteTurn: "runtime.routeTurn",
  RunToolIfNeeded: "runtime.runToolIfNeeded",
  ResumeAutonomousTasks: "runtime.resumeAutonomousTasks",
  AbortTurn: "runtime.abortTurn",
} as const;

/** runtime 进程持有的「actorId → 进行中 turn」注册表：abort 帧按 actor 定位 AbortController。 */
export type ActiveTurnRegistry = {
  /** 记录进行中的 turn；turn 结束（含失败）后自动清理 */
  track(actorId: string, controller: AbortController): void;
  abort(actorId: string): boolean;
};

export function createActiveTurnRegistry(): ActiveTurnRegistry {
  const active = new Map<string, Set<AbortController>>();
  return {
    track(actorId, controller) {
      let set = active.get(actorId);
      if (!set) {
        set = new Set();
        active.set(actorId, set);
      }
      set.add(controller);
      const cleanup = () => {
        set?.delete(controller);
        if (set && set.size === 0) active.delete(actorId);
      };
      controller.signal.addEventListener("abort", cleanup, { once: true });
    },
    abort(actorId) {
      const set = active.get(actorId);
      if (!set || set.size === 0) return false;
      let aborted = false;
      for (const controller of [...set]) {
        controller.abort();
        aborted = true;
      }
      return aborted;
    },
  };
}

/** 解析链路帧（JSON 文本 → 强类型；无法解析返回 null）。 */
export function parseLinkFrame(raw: string): LinkFrame | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const frame = parsed as Record<string, unknown>;
  if (frame.kind === "req" && typeof frame.id === "string" && typeof frame.method === "string") {
    return { kind: "req", id: frame.id, method: frame.method, params: (frame.params ?? {}) as Record<string, unknown> };
  }
  if (frame.kind === "ev" && typeof frame.id === "string" && typeof frame.cb === "string") {
    return { kind: "ev", id: frame.id, cb: frame.cb, args: (frame.args ?? []) as unknown[] };
  }
  if (frame.kind === "res" && typeof frame.id === "string") {
    return { kind: "res", id: frame.id, ok: true, result: frame.result };
  }
  if (frame.kind === "err" && typeof frame.id === "string" && typeof frame.message === "string") {
    return { kind: "err", id: frame.id, ok: false, message: frame.message };
  }
  return null;
}
