// Agent Body Center —— VestibularApparatus 前庭器/平衡器官
//
// 职责（纯感知，无下行工具）：
//  1. 维护 Agent 在多设备上的"渲染存在"状态（哪台设备正在显示球形身体 / 当前情绪）
//  2. 设备上下线时切换渲染主体，发布 body.vestibular.device_switch 信号
//  3. 提供 where_am_i / vestibular.devices 两种 sense 查询
//
// 注：embodiment.* 下行控制工具链已整体移除（LLM 不再驱动身体），本模块仅保留感知职责。
//
// 设计原则：
//  - 不持有 LLM，所有智能判断在 BrainCenter 侧
//  - BodyBus 信号 fire-and-forget
//  - EmbodimentMood 类型复用 agent-embodiment.ts，不重复造轮子

import type { BodyBus } from "./body-bus.js";
import type {
  BodyAction,
  BodyActionResult,
  BodyModuleLike,
  BodyModuleSnapshot,
  BodySenseQuery,
  BodySenseResult,
} from "./types.js";
import type { EmbodimentMood } from "../services/agent-embodiment.js";

// ---- 外观接口（解耦具体 WsConnectionRegistry）--

/** WsConnectionRegistry 的最小外观：只需 trySend 即可 */
export interface WsRegistryLike {
  trySend(sessionId: string, json: string): boolean;
}

/** VestibularApparatus 构造依赖 */
export interface VestibularApparatusDeps {
  bodyBus: BodyBus;
  wsRegistry?: WsRegistryLike;
}

// ---- 设备存在状态 ------------------------------------------------------

/** 单台设备上 Agent 形象的渲染状态 */
export interface DevicePresence {
  /** 设备 id，如 "desktop" / "phone" / "glasses" / "tablet" */
  deviceId: string;
  /** 设备大类，与 device-bus DeviceKind 对齐 */
  kind: string;
  /** 是否在线 */
  online: boolean;
  /** 该设备是否正在渲染 agent 形象 */
  rendering: boolean;
  /** 当前情绪基调 */
  mood: EmbodimentMood;
  /** 屏幕短文案 */
  caption: string | null;
  /** 屏幕归一化坐标（window_place 用），0-1 */
  screenX?: number;
  screenY?: number;
  /** 3D 场景坐标（roam/move 用） */
  x?: number;
  y?: number;
  z?: number;
  /** 最后更新时间 ISO */
  lastUpdatedAt: string;
}

// ---- 辅助函数 ----------------------------------------------------------

/** 当前 ISO 时间戳 */
function nowIso(): string {
  return new Date().toISOString();
}

// ---- VestibularApparatus 主类 --------------------------------------------

/**
 * 前庭器/平衡器官 —— 维护 Agent 在多设备上的渲染存在与位置。
 *
 * 与人体前庭神经对照：
 *  - 人耳前庭掌管平衡 / 空间定位
 *  - Agent 前庭掌管"我此刻在哪台设备上 / 在屏幕哪个位置 / 是什么姿态"
 */
export class VestibularApparatus implements BodyModuleLike {
  readonly name = "vestibular" as const;
  readonly label = "前庭器/平衡器官";
  readonly tools: string[] = [];

  private readonly bodyBus: BodyBus;
  private readonly wsRegistry: WsRegistryLike | null;

  /** 已知设备表：deviceId -> DevicePresence。初始含 desktop / phone 两条 */
  private readonly devices = new Map<string, DevicePresence>();

  /** 模块是否已启动 */
  private started = false;

  /** 最近一次活动时间（ISO），无活动时为 null */
  private lastActivityAt: string | null = null;

  constructor(deps: VestibularApparatusDeps) {
    this.bodyBus = deps.bodyBus;
    this.wsRegistry = deps.wsRegistry ?? null;

    // 初始化 desktop / phone 两条占位记录
    const now = nowIso();
    this.devices.set("desktop", {
      deviceId: "desktop",
      kind: "desktop",
      online: true,
      rendering: true,
      mood: "idle",
      caption: null,
      lastUpdatedAt: now,
    });
    this.devices.set("phone", {
      deviceId: "phone",
      kind: "phone",
      online: true,
      rendering: false,
      mood: "idle",
      caption: null,
      lastUpdatedAt: now,
    });
  }

  // ─── 生命周期 ────────────────────────────────────────────────

  /**
   * 启动模块（标记 started=true）。
   */
  async start(): Promise<void> {
    if (this.started) {
      console.log("[VestibularApparatus] 已启动，跳过重复 start");
      return;
    }
    console.log("[VestibularApparatus] 正在启动...");
    this.started = true;
    console.log("[VestibularApparatus] 启动完成");
  }

  /**
   * 停止模块：标记 started=false。
   */
  async stop(): Promise<void> {
    if (!this.started) {
      console.log("[VestibularApparatus] 未启动，跳过 stop");
      return;
    }
    console.log("[VestibularApparatus] 正在停止...");
    this.started = false;
    console.log("[VestibularApparatus] 已停止");
  }

  // ─── 动作执行 ────────────────────────────────────────────────

  /**
   * Vestibular 为纯感知模块（无任何下行工具）。
   * 保留 act 以满足 BodyModuleLike 接口；万一被路由到时优雅返回。
   */
  async act(action: BodyAction): Promise<BodyActionResult> {
    return {
      ok: false,
      result: {},
      errorMessage: `vestibular is sense-only; tool not routed here: ${action.tool ?? "(none)"}`,
    };
  }

  // ─── 感官查询 ────────────────────────────────────────────────

  /**
   * 感官查询。
   *
   * 支持的 query.kind：
   *  - "where_am_i"        -> 当前正在渲染的设备状态（rendering=true 的第一个）
   *  - "vestibular.devices"-> 所有 DevicePresence 列表
   */
  async sense(query: BodySenseQuery): Promise<BodySenseResult> {
    const kind = query.kind;
    if (kind === "where_am_i" || kind.startsWith("where_am_i")) {
      const device = this.getCurrentRenderingDevice();
      if (!device) {
        return {
          ok: false,
          data: { error: "no_rendering_device" },
          module: "vestibular",
          errorMessage: "no_rendering_device",
        };
      }
      return {
        ok: true,
        data: {
          device: device.deviceId,
          screenX: device.screenX,
          screenY: device.screenY,
          mood: device.mood,
          caption: device.caption,
          rendering: device.rendering,
        },
        module: "vestibular",
      };
    }
    if (kind === "vestibular.devices" || kind.startsWith("vestibular.devices")) {
      return {
        ok: true,
        data: { devices: this.listDevices() },
        module: "vestibular",
      };
    }
    return {
      ok: false,
      data: { error: `unknown_query:${kind}` },
      module: "vestibular",
      errorMessage: `unknown_query:${kind}`,
    };
  }

  // ─── 快照 ────────────────────────────────────────────────────

  /**
   * 模块快照。
   *
   * metadata 字段含：
   *  - devices: 全部 DevicePresence 列表
   *  - currentDevice: 当前渲染设备 id（供 BodyGateway 聚合到 state.currentDevice）
   *  - mood: 当前渲染设备 mood（P0-3: 渲染态/fallback；权威 mood 来源已迁至 HomeostasisCore，
   *          body-gateway 在 homeostasis mood 不可用时取此值）
   *  - rendering: 是否正在渲染（供 BodyGateway 聚合到 state.rendering）
   */
  snapshot(): BodyModuleSnapshot {
    const renderingDevice = this.getCurrentRenderingDevice();
    return {
      name: "vestibular",
      label: this.label,
      tools: [...this.tools],
      online: this.started,
      subsystems: [],
      lastActivityAt: this.lastActivityAt,
      metadata: {
        devices: this.listDevices(),
        currentDevice: renderingDevice?.deviceId,
        mood: renderingDevice?.mood,
        rendering: Boolean(renderingDevice?.rendering),
      },
    };
  }

  // ─── 设备上下线（供 device-bus 调用） ─────────────────────────

  /**
   * 设备上线时调用。
   * - 已存在：刷新 online=true / kind
   * - 新设备：插入一条 online 但 rendering=false 的记录
   */
  onDeviceOnline(deviceId: string, kind: string): void {
    const existing = this.devices.get(deviceId);
    const now = nowIso();
    if (existing) {
      existing.online = true;
      existing.kind = kind;
      existing.lastUpdatedAt = now;
      return;
    }
    this.devices.set(deviceId, {
      deviceId,
      kind,
      online: true,
      rendering: false,
      mood: "idle",
      caption: null,
      lastUpdatedAt: now,
    });
  }

  /**
   * 设备下线时调用。
   * - 若下线设备正在 rendering：把 rendering 标志迁移到下一个 online 设备
   * - 同时转移 mood / caption 到新设备
   * - 发布 body.vestibular.device_switch 信号（含 fromDevice / toDevice / mood / caption）
   */
  onDeviceOffline(deviceId: string): void {
    const cur = this.devices.get(deviceId);
    if (!cur) return;
    const wasRendering = cur.rendering;
    cur.online = false;
    cur.rendering = false;
    cur.lastUpdatedAt = nowIso();

    if (!wasRendering) return;

    // 找下一个 online 且非当前的设备作为渲染主体
    let next: DevicePresence | null = null;
    for (const d of this.devices.values()) {
      if (d.deviceId === deviceId) continue;
      if (d.online) {
        next = d;
        break;
      }
    }
    if (!next) {
      // 没有备选设备：仅发布信号，标记当前无渲染
      this.publishDeviceSwitch(deviceId, null, cur.mood, cur.caption);
      return;
    }
    next.rendering = true;
    next.mood = cur.mood;
    next.caption = cur.caption;
    next.lastUpdatedAt = nowIso();
    this.lastActivityAt = nowIso();
    this.publishDeviceSwitch(deviceId, next.deviceId, cur.mood, cur.caption);
  }

  /** 返回当前正在渲染的设备（rendering=true 的第一个），无则 null */
  getCurrentRenderingDevice(): DevicePresence | null {
    for (const d of this.devices.values()) {
      if (d.rendering && d.online) return d;
    }
    // 退化：online 但 rendering 标志丢失时返回第一个 online 设备
    for (const d of this.devices.values()) {
      if (d.online) return d;
    }
    return null;
  }

  // ─── 内部工具 ────────────────────────────────────────────────

  /** 列出所有 DevicePresence（浅拷贝，避免外部篡改） */
  private listDevices(): DevicePresence[] {
    return Array.from(this.devices.values()).map((d) => ({ ...d }));
  }

  /** 发布 body.vestibular.device_switch 信号 */
  private publishDeviceSwitch(
    fromDevice: string,
    toDevice: string | null,
    mood: EmbodimentMood,
    caption: string | null,
  ): void {
    this.bodyBus.publish({
      kind: "body.vestibular.device_switch",
      module: "vestibular",
      payload: {
        fromDevice,
        toDevice,
        mood,
        caption,
      },
      timestamp: nowIso(),
    });
  }
}
