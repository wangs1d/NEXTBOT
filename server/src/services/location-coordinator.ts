/**
 * 位置协调器：服务端「按需」向客户端请求实时位置。
 *
 * 与 DesktopBridgeCoordinator 的 invoke/pending/complete 模式一致：
 *  - Agent 需要位置时（如 weather.get_local 工具执行）调用 `requestLocation`，
 *    服务端通过 WS 下发 `agent.location_request`（携带 jobId），等待客户端回包。
 *  - 客户端收到后拉取 GPS 并回传 `client.location_report`，
 *    服务端 resolve 挂起的 Promise 并写入 actor 级缓存。
 *  - 天气面板等客户端主动上报（无 jobId）时只写缓存，供后续 prompt/工具复用。
 *
 * 不主动请求：普通聊天消息不再附带位置，位置只在 Agent 真正需要时才产生一次 GPS 开销。
 *
 * 持续模式（位置方案 A）：LOCATION_TRACKING_MODE=continuous 时，WS 绑定
 * socket 后向客户端下发 `agent.location_tracking_config`（mode + intervalSec），
 * 客户端按间隔定时上报（source:"continuous"），服务端经 LocationIngestPipeline
 * 写位置历史 / 判围栏 / 触发主动性。默认 ondemand（隐私优先）。
 */
import { randomUUID } from "node:crypto";

import {
  getLocationReportIntervalSec,
  getLocationTrackingMode,
  type LocationTrackingMode,
} from "../config/location-env.js";
import { ServerEventType } from "../protocol.js";
import { parseClientLocation, type ClientLocationWire } from "../types/client-location.js";

export type WsSendLike = {
  send(data: string): void;
  readyState?: number;
};

/** 持续定位配置（下发 `agent.location_tracking_config` 的载荷） */
export type LocationTrackingConfig = {
  mode: LocationTrackingMode;
  intervalSec: number;
};

type PendingRequest = {
  resolve: (loc: ClientLocationWire | null) => void;
  timer: NodeJS.Timeout;
  socket: WsSendLike;
};

type CachedLocation = {
  payload: ClientLocationWire;
  at: number;
};

export class LocationCoordinator {
  private readonly sockets = new Map<string, WsSendLike>();
  private readonly pending = new Map<string, PendingRequest>();
  private readonly cache = new Map<string, CachedLocation>();

  /** 缓存新鲜度：此窗口内的位置直接复用，不重复请求客户端。 */
  private readonly cacheTtlMs: number;
  /** 请求客户端回包的最大等待时间，超时返回 null（工具可回退到 city 参数）。 */
  private readonly requestTimeoutMs: number;
  /** 持续定位配置（env 决定，进程级不变） */
  private readonly trackingConfig: LocationTrackingConfig;

  constructor(opts?: { cacheTtlMs?: number; requestTimeoutMs?: number }) {
    this.cacheTtlMs = opts?.cacheTtlMs ?? 60_000;
    // 2026-10-08 定位修复：6s 等不到手机冷启动 GPS（geolocator timeLimit 20s），
    // 天气/时钟工具按需定位恒超时 → agent 退回旧缓存或记忆城市（「得不到真实定位」）。
    // 12s 覆盖绝大多数 GPS fix（客户端已改为纯坐标秒回，不再叠加 12s 逆地理 HTTP）。
    this.requestTimeoutMs = opts?.requestTimeoutMs ?? 12_000;
    this.trackingConfig = {
      mode: getLocationTrackingMode(),
      intervalSec: getLocationReportIntervalSec(),
    };
  }

  /** 当前追踪模式配置（WS 层绑定 socket 后据此下发客户端）。 */
  getTrackingConfig(): LocationTrackingConfig {
    return { ...this.trackingConfig };
  }

  /** 是否开启了持续上报模式。 */
  isContinuousTrackingEnabled(): boolean {
    return this.trackingConfig.mode === "continuous";
  }

  /** 持续模式下向客户端下发定时上报配置（ondemand 模式不发，客户端无定时器）。 */
  sendTrackingConfig(socket: WsSendLike): boolean {
    if (!this.isContinuousTrackingEnabled()) return false;
    try {
      socket.send(
        JSON.stringify({
          type: ServerEventType.LocationTrackingConfig,
          payload: { ...this.trackingConfig },
        }),
      );
      return true;
    } catch {
      return false;
    }
  }

  hasSocket(actorId: string): boolean {
    const s = this.sockets.get(actorId);
    if (!s) return false;
    return s.readyState === undefined || s.readyState === 1;
  }

  bindSocket(actorId: string, socket: WsSendLike): void {
    this.sockets.set(actorId, socket);
  }

  unbindSocket(socket: WsSendLike): void {
    const removed: string[] = [];
    for (const [actorId, s] of this.sockets) {
      if (s === socket) {
        this.sockets.delete(actorId);
        removed.push(actorId);
      }
    }
    // 该连接挂起的请求全部按失败处理，避免 Promise 悬空。
    for (const [jobId, p] of this.pending) {
      if (p.socket === socket) {
        clearTimeout(p.timer);
        this.pending.delete(jobId);
        p.resolve(null);
      }
    }
  }

  /** 读缓存（不考虑新鲜度），供 prompt 注入等只读场景。 */
  getCached(actorId: string): ClientLocationWire | null {
    const hit = this.cache.get(actorId);
    if (!hit) return null;
    return hit.payload;
  }

  /** 读缓存并带写入时间：prompt 注入据此标注「定位于 N 分钟前」，避免把旧位置当实时。 */
  getCachedWithTime(actorId: string): { payload: ClientLocationWire; at: number } | null {
    const hit = this.cache.get(actorId);
    if (!hit) return null;
    return { payload: hit.payload, at: hit.at };
  }

  /** 读新鲜缓存：窗口期内返回，否则返回 null。 */
  getFreshCached(actorId: string): ClientLocationWire | null {
    const hit = this.cache.get(actorId);
    if (!hit) return null;
    if (Date.now() - hit.at > this.cacheTtlMs) return null;
    return hit.payload;
  }

  /**
   * 跨 actor 取最近一次定位（单用户个人 agent 语义：手机/桌面多端在线时取最新上报）。
   * 供没有 actorId 的 HTTP 会话（如旅游规划 plan-session）被动读位置用——
   * 只读缓存，绝不向客户端要 GPS。超过 maxAgeMs 视为过期返回 null。
   */
  getLatest(
    maxAgeMs = 48 * 60 * 60 * 1000,
  ): { actorId: string; payload: ClientLocationWire; at: number } | null {
    let best: { actorId: string; payload: ClientLocationWire; at: number } | null = null;
    for (const [actorId, hit] of this.cache) {
      if (Date.now() - hit.at > maxAgeMs) continue;
      if (!best || hit.at > best.at) best = { actorId, payload: hit.payload, at: hit.at };
    }
    return best;
  }

  /**
   * 按需请求实时位置。优先复用新鲜缓存；缓存过期或缺失时向客户端下发
   * `agent.location_request` 并等待回包，超时返回 null。
   */
  requestLocation(actorId: string, reason?: string): Promise<ClientLocationWire | null> {
    const fresh = this.getFreshCached(actorId);
    if (fresh) return Promise.resolve(fresh);

    const socket = this.sockets.get(actorId);
    if (!socket || !this.hasSocket(actorId)) return Promise.resolve(null);

    const jobId = randomUUID();
    return new Promise<ClientLocationWire | null>((resolve) => {
      const timer = setTimeout(() => {
        if (!this.pending.has(jobId)) return;
        this.pending.delete(jobId);
        // 超时侧日志：请求已下发但手机没回包（权限被拒/GPS 冷启动超预算/旧版 App 未重装）
        console.log(
          `[location-coordinator] 按需定位超时(${this.requestTimeoutMs}ms) actor=${actorId} reason=${reason ?? "-"}` +
            ` → 工具将拿不到实时坐标，可能回退旧缓存或反问用户`,
        );
        resolve(null);
      }, this.requestTimeoutMs);
      this.pending.set(jobId, { socket, timer, resolve });
      try {
        socket.send(
          JSON.stringify({
            type: ServerEventType.LocationRequest,
            payload: { jobId, ...(reason ? { reason } : {}) },
          }),
        );
      } catch {
        clearTimeout(timer);
        this.pending.delete(jobId);
        resolve(null);
      }
    });
  }

  /**
   * 处理客户端 `client.location_report`：
   *  - 携带 jobId：resolve 对应挂起请求（须校验 socket 归属）
   *  - 无 jobId：仅写缓存（天气面板等主动上报）
   * 返回 true 表示已消费。
   */
  completeFromSocket(
    socket: WsSendLike,
    actorId: string,
    payload: Record<string, unknown>,
  ): boolean {
    const loc = parseClientLocation(payload);
    if (loc) {
      this.cache.set(actorId, { payload: loc, at: Date.now() });
      // 真机定位链路可观测（2026-10-08）：这是「手机上报了什么坐标」的唯一一手证据，
      // 定位答错的排查从这里开始——坐标对而答错=LLM/逆地理问题；坐标错=手机 GPS 问题。
      const pendingHit = String(payload.jobId ?? "").trim() ? "按需回包" : "主动上报";
      console.log(
        `[location-coordinator] ${pendingHit} actor=${actorId} ` +
          `lat=${loc.latitude?.toFixed(5) ?? "?"} lon=${loc.longitude?.toFixed(5) ?? "?"} ` +
          `label=${loc.label ?? "-"} tz=${loc.timezone ?? "-"}`,
      );
    }
    const jobId = String(payload.jobId ?? "").trim();
    if (!jobId) return true; // 纯上报：已写缓存
    const p = this.pending.get(jobId);
    if (!p || p.socket !== socket) return false;
    clearTimeout(p.timer);
    this.pending.delete(jobId);
    p.resolve(loc ?? null);
    return true;
  }
}
