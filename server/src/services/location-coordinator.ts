/**
 * 位置协调器：服务端「按需」向客户端请求实时位置。
 *
 * 采用 invoke/pending/complete 模式：
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
  getLocationLastKnownMaxAgeMs,
  getLocationReportIntervalSec,
  getLocationReuseWindowMs,
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
  /** 本次请求下发给的全部连接（多设备 fan-out；任一端回包即完成） */
  sockets: Set<WsSendLike>;
};

type CachedLocation = {
  payload: ClientLocationWire;
  at: number;
  /** 写入该 fix 的设备类别：问「我在哪」时代码端 fix 不如手机 GPS 可信 */
  device?: "mobile" | "desktop";
};

/** {@link LocationCoordinator.getLastKnown} 的返回：位置 + 距写入的毫秒龄期。 */
export type LastKnownLocation = ClientLocationWire & { ageMs: number };

/**
 * 按需定位的精度/新鲜度要求（2026-11-14）。
 *
 * 缺省沿用全局复用窗口（15 分钟）：天气等场景坐标旧一点无所谓。但用户问
 * 「我在哪」「离我多远」时，15 分钟前的缓存就是错的答案——调用方传入
 * `maxAgeMs`/`maxAccuracyMeters`，不达标就绕过缓存、现场向客户端拉 GPS。
 */
export type LocationRequestOptions = {
  /** 缓存最多允许多旧（毫秒）；缺省 cacheTtlMs */
  maxAgeMs?: number;
  /** 缓存的水平精度上限（米）；超过则重新定位。无精度元数据时不拦截 */
  maxAccuracyMeters?: number;
};

export class LocationCoordinator {
  /**
   * actor → 全部在线连接（2026-11-13 修：此前是 actor → 单 socket）。
   *
   * 单 socket 模型在多设备下会**互相踩**：手机聊天 WS 与桌面根 WS 都对同一
   * actorId 绑定时，后连的那条覆盖先连的那条；先连的断开时按 socket 匹配
   * 摘除——但 map 里已经没有它了，于是手机端的位置通道被桌面端"带下线"，
   * 表现为「手机明明在线，Agent 却再也拿不到位置、围栏同步也发不过去」。
   *
   * 现在与 {@link WsConnectionRegistry} 同构：每个 actor 保留全部连接，
   * 逐条摘除、fan-out 发送、任一端在线即算在线。
   */
  private readonly sockets = new Map<string, Set<WsSendLike>>();
  /**
   * socket → 设备类别（2026-11-14）：手机与电脑同时在线时，位置请求优先只发
   * 手机。PC 的「定位」常来自 WiFi/网络推断（几百米到几公里），手机 GPS 才是
   * 用户此刻站的地方；谁先回包用谁会让桌面端把手机端的精度带偏。
   * 无类别信息的旧客户端仍走 fan-out（两端都发，先到先用）。
   */
  private readonly socketClass = new WeakMap<WsSendLike, "mobile" | "desktop">();
  private readonly pending = new Map<string, PendingRequest>();
  private readonly cache = new Map<string, CachedLocation>();
  private lastKnownProvider:
    | ((actorId: string) => { payload: ClientLocationWire; at: number } | null)
    | null = null;

  /** 缓存新鲜度：此窗口内的位置直接复用，不重复请求客户端。 */
  private readonly cacheTtlMs: number;
  /** 请求客户端回包的最大等待时间，超时返回 null（工具可回退到 city 参数）。 */
  private readonly requestTimeoutMs: number;
  /** 持续定位配置（env 决定，进程级不变） */
  private readonly trackingConfig: LocationTrackingConfig;

  constructor(opts?: { cacheTtlMs?: number; requestTimeoutMs?: number }) {
    this.cacheTtlMs = opts?.cacheTtlMs ?? getLocationReuseWindowMs();
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
    return this.onlineSockets(actorId).length > 0;
  }

  /** 该 actor 的全部在线连接（readyState 正常者）。 */
  private onlineSockets(actorId: string): WsSendLike[] {
    const set = this.sockets.get(actorId);
    if (!set || set.size === 0) return [];
    const out: WsSendLike[] = [];
    for (const s of set) {
      if (s.readyState === undefined || s.readyState === 1) out.push(s);
    }
    return out;
  }

  /** 绑定（幂等：同一 socket 重复绑定只登记一次）。deviceClass 用于定位源优选。 */
  bindSocket(
    actorId: string,
    socket: WsSendLike,
    deviceClass?: "mobile" | "desktop",
  ): void {
    let set = this.sockets.get(actorId);
    if (!set) {
      set = new Set();
      this.sockets.set(actorId, set);
    }
    set.add(socket);
    if (deviceClass) this.socketClass.set(socket, deviceClass);
  }

  /**
   * 向该 actor 的在线连接推送一条事件（围栏同步等非位置事件复用本协调器
   * 持有的 actor→socket 绑定，避免再造一份连接表）。
   * **全端 fan-out**：手机与桌面都在线时两端都收（围栏同步尤其需要——
   * 手机端要注册系统围栏，桌面端收着也只是无害回执）。
   * 无在线连接/全部发送失败返回 false，调用方静默即可（下次连接会重新下发）。
   */
  sendEventToActor(actorId: string, type: string, payload: unknown): boolean {
    const sockets = this.onlineSockets(actorId);
    if (sockets.length === 0) return false;
    const data = JSON.stringify({ type, payload });
    let delivered = false;
    for (const socket of sockets) {
      try {
        socket.send(data);
        delivered = true;
      } catch {
        /* 半开连接 send 可能抛错：跳过，其余连接照常 */
      }
    }
    return delivered;
  }

  /**
   * 摘除一条连接（断线时调用）。
   *
   * 逐 actor 精确移除**这一条** socket——不影响同一账号的其它设备（手机/桌面）。
   * 该连接挂起的请求全部按失败处理，避免 Promise 悬空。
   */
  unbindSocket(socket: WsSendLike): void {
    for (const [actorId, set] of [...this.sockets]) {
      if (!set.delete(socket)) continue;
      if (set.size === 0) this.sockets.delete(actorId);
    }
    for (const [jobId, p] of this.pending) {
      if (p.sockets.has(socket)) {
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
   * 按调用方要求判断缓存是否可复用（缺省=全局窗口，不看精度）。
   *
   * 问「我在哪」这类场景必须传 maxAgeMs/maxAccuracyMeters：一个 15 分钟前
   * 或 ±500m 的 fix 不能拿来回答「此刻在哪」，宁可多拉一次 GPS。
   */
  private getReusableCached(
    actorId: string,
    opts?: LocationRequestOptions,
    mobileOnline = false,
  ): ClientLocationWire | null {
    const hit = this.cache.get(actorId);
    if (!hit) return null;
    const maxAgeMs = opts?.maxAgeMs ?? this.cacheTtlMs;
    if (Date.now() - hit.at > maxAgeMs) return null;
    // 精度敏感场景（问我在哪/离我多远）：手机在线时，代码端写入的 fix 不如手机
    // GPS 可信（PC 常是 WiFi/网络推断），宁可多问一次手机。
    if (opts && mobileOnline && hit.device === "desktop") return null;
    const maxAccuracy = opts?.maxAccuracyMeters;
    const accuracy = hit.payload.accuracyMeters;
    if (maxAccuracy != null && typeof accuracy === "number" && accuracy > maxAccuracy) {
      return null;
    }
    return hit.payload;
  }

  /** 该 actor 是否有手机端在线（定位源优选用）。 */
  private hasMobileOnline(actorId: string): boolean {
    return this.onlineSockets(actorId).some((s) => this.socketClass.get(s) === "mobile");
  }

  /**
   * 注入落盘历史读取器（位置历史晚于协调器构造，引用必须包在闭包里惰性求值）。
   * 未注入时 getLastKnown 只认内存缓存。
   */
  setLastKnownProvider(
    provider: ((actorId: string) => { payload: ClientLocationWire; at: number } | null) | null,
  ): void {
    this.lastKnownProvider = provider;
  }

  /**
   * 最近一次已知位置（不要求新鲜）：内存缓存 → 落盘历史，取较新的一份。
   * 超过 `maxAgeMs` 一律 null。返回值必带 `ageMs`——调用方要如实标注龄期，
   * 不得把旧位置当实时定位透出。
   */
  getLastKnown(
    actorId: string,
    maxAgeMs = getLocationLastKnownMaxAgeMs(),
  ): LastKnownLocation | null {
    const now = Date.now();
    const mem = this.cache.get(actorId);
    const disk = mem ? null : this.lastKnownProvider?.(actorId);
    const hit = mem ?? disk;
    if (!hit) return null;
    const ageMs = now - hit.at;
    if (ageMs > maxAgeMs) return null;
    return { ...hit.payload, ageMs };
  }

  /**
   * 按需请求实时位置。优先复用该 actor 的新鲜缓存；缓存过期、精度不达标或
   * 缺失时，向该 actor 自己的**全部**在线设备下发 `agent.location_request`
   * 并等待回包。该 actor 无在线连接立即返回 null——绝不回落到「任一在线客户端」。
   * 超时返回 null（工具可回退到 city 参数）。
   *
   * 多设备 fan-out（2026-11-13）：请求发给该 actor 的每一条在线连接。
   * 桌面端没有 GPS 能力，只发给它等于问空气；手机端在线时必须能收到。
   * 谁先回包用谁的（pending 一完成即删除，后续回包自然被忽略）。
   */
  requestLocation(
    actorId: string,
    reason?: string,
    opts?: LocationRequestOptions,
  ): Promise<ClientLocationWire | null> {
    const mobileOnline = this.hasMobileOnline(actorId);
    const fresh = this.getReusableCached(actorId, opts, mobileOnline);
    if (fresh) return Promise.resolve(fresh);

    const online = this.onlineSockets(actorId);
    if (online.length === 0) return Promise.resolve(null);
    // 有手机端在线就只问手机（GPS 精度远高于 PC 的网络/WiFi 推断）；
    // 只有桌面端时照样问它（Windows 定位服务可用时也能给真实坐标）。
    const mobiles = online.filter((s) => this.socketClass.get(s) === "mobile");
    const sockets = mobiles.length > 0 ? mobiles : online;

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
      const targetSockets = new Set(sockets);
      this.pending.set(jobId, { sockets: targetSockets, timer, resolve });
      const data = JSON.stringify({
        type: ServerEventType.LocationRequest,
        payload: { jobId, ...(reason ? { reason } : {}) },
      });
      for (const socket of sockets) {
        try {
          socket.send(data);
        } catch {
          /* 半开连接 send 可能抛错：其余连接照常 */
        }
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
      this.cache.set(actorId, {
        payload: loc,
        at: Date.now(),
        device: this.socketClass.get(socket),
      });
      // 真机定位链路可观测（2026-10-08）：这是「手机上报了什么坐标」的唯一一手证据，
      // 定位答错的排查从这里开始——坐标对而答错=LLM/逆地理问题；坐标错=手机 GPS 问题。
      const pendingHit = String(payload.jobId ?? "").trim() ? "按需回包" : "主动上报";
      const device = this.socketClass.get(socket) ?? "-";
      console.log(
        `[location-coordinator] ${pendingHit} dev=${device} actor=${actorId} ` +
          `lat=${loc.latitude?.toFixed(5) ?? "?"} lon=${loc.longitude?.toFixed(5) ?? "?"} ` +
          `acc=${typeof loc.accuracyMeters === "number" ? `${Math.round(loc.accuracyMeters)}m` : "-"} ` +
          `label=${loc.label ?? "-"} tz=${loc.timezone ?? "-"}`,
      );
    }
    const jobId = String(payload.jobId ?? "").trim();
    if (!jobId) return true; // 纯上报：已写缓存
    const p = this.pending.get(jobId);
    if (!p || !p.sockets.has(socket)) return false;
    clearTimeout(p.timer);
    this.pending.delete(jobId);
    p.resolve(loc ?? null);
    return true;
  }
}
