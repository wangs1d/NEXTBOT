// Agent Body Center —— HomeostasisCore 稳态核心（内脏）
//
// 职责：聚合身体稳态指标 —— 电量 / 位置 / 算力配额 / 负载 / 疲劳度 / 情绪 / 饥饿度，
// 并在指标越过阈值时通过 BodyBus 发布告警信号。
//
// P0-3 重构要点：
//  - fatigue 基于活动量（近期 LLM 调用 + 信号密度），不再纯线性时间模型
//  - mood 维度迁回 HomeostasisCore（权威源），VestibularApparatus 保留 mood 作为渲染态
//  - 新增 hunger 维度（算力/能量消耗率），>0.8 发布 hunger_high 信号
//  - 订阅 BodyBus 信号（body.action.executed/failed）估算活动量
//
// 与其他 BodyModule 不同：纯聚合服务，tools=[]，不直接接受动作。
// BrainCenter 通过 BodyCenter.state() 读取 BodyState，HomeostasisCore 是其权威数据源。
//
// 设计原则：
//  1. 子系统缺失时优雅降级（保持上次值或默认值），不抛异常
//  2. setInterval 必须 unref() 避免阻塞进程退出
//  3. async/await，无 callback
//  4. 阈值告警去重：batteryLowEmitted / quotaLowEmitted / hungerHighEmitted 防止重复发布
//  5. BodyBus 不可用时仍能工作（降级到纯轮询，活动量估算回退到 0）

import type { BodyBus } from "./body-bus.js";
import type {
  BodyAction,
  BodyActionResult,
  BodyModuleLike,
  BodyModuleSnapshot,
  BodySenseQuery,
  BodySenseResult,
  BodyState,
  BodyToolRegistry,
} from "./types.js";
import { BODY_SIGNAL_KIND } from "./types.js";

// ---- 外观接口（本地解耦）------------------------------------------------

/**
 * 算力配额外观接口。
 *
 * 与 services/compute-quota-service.ts 的 ComputeQuotaService 解耦，
 * 仅暴露 HomeostasisCore 需要的最小协议面。具体实现可由装配阶段适配。
 */
export interface ComputeQuotaLike {
  /** 获取当前可用配额比例 0-1 */
  getQuota(): Promise<number> | number;
  /** 获取当前负载 0-1（可选） */
  getCurrentLoad?(): Promise<number> | number;
  /** 消耗一定量配额（可选） */
  consume?(amount: number): Promise<void>;
}

/**
 * 用户位置外观接口。
 *
 * 与 services/user-location-service.ts 解耦，仅暴露 getLocation 协议面。
 */
export interface UserLocationLike {
  /** 获取用户当前位置信息；无定位时返回 null */
  getLocation(): Promise<{
    city?: string;
    region?: string;
    country?: string;
    latitude?: number;
    longitude?: number;
  } | null>;
}

/**
 * 设备注册表外观接口。
 *
 * 与 device-bus/device-registry.ts 的 DeviceRegistry 解耦，
 * 仅暴露 listByCapability + invoke 协议面（结构兼容即可）。
 */
export interface DeviceRegistryLike {
  /** 按能力列出设备（可选） */
  listByCapability?(cap: string): Array<{ deviceId: string; kind: string }>;
  /** 调用设备 action */
  invoke(
    deviceId: string,
    action: string,
    params: Record<string, unknown>,
  ): Promise<{ ok: boolean; result?: unknown }>;
}

// ---- 情绪类型 ------------------------------------------------------------

/**
 * 情绪基调（与 EmbodimentMood 结构兼容，避免 body 层直接依赖 services 层）。
 *
 * HomeostasisCore 维护的 mood 是权威源；VestibularApparatus.mood 保留为渲染态
 * （前端展示用），body-gateway 优先取 homeostasis 的 mood，fallback 到 vestibular。
 */
export type MoodKind = "idle" | "listening" | "thinking" | "happy" | "alert";

// ---- 依赖参数 ------------------------------------------------------------

/**
 * HomeostasisCore 构造依赖。
 */
export interface HomeostasisCoreDeps {
  bodyBus: BodyBus;
  computeQuotaService?: ComputeQuotaLike;
  userLocationService?: UserLocationLike;
  deviceRegistry?: DeviceRegistryLike;
  /** 电量告警阈值，默认 0.2 */
  batteryLowThreshold?: number;
  /** 配额告警阈值，默认 0.1 */
  quotaLowThreshold?: number;
  /** 饥饿告警阈值，默认 0.8 */
  hungerHighThreshold?: number;
  /** 轮询间隔（ms），默认 60000 */
  pollIntervalMs?: number;
}

// ---- 主类 ----------------------------------------------------------------

/**
 * HomeostasisCore —— 稳态核心（内脏）。
 *
 * 维护身体稳态指标：电量 / 位置 / 算力配额 / 负载 / 疲劳度。
 * 周期性轮询 3 个可选子系统（computeQuotaService / userLocationService / deviceRegistry），
 * 聚合后写入内部状态，并在阈值越过时通过 BodyBus 发布告警信号。
 *
 * 对外：
 *  - BodyCenter.state() 通过 getState() 读取 BodyState 权威值
 *  - sense("state") / sense("homeostasis.battery") / sense("homeostasis.quota") 查询
 *  - snapshot() 包含 metadata（battery/location/quota/load/fatigue）
 *  - tools=[]，act() 永远返回 ok=false（纯聚合服务）
 */
export class HomeostasisCore implements BodyModuleLike {
  readonly name = "homeostasis" as const;
  readonly label = "稳态核心（内脏）";
  /** 纯聚合服务，不直接暴露工具 */
  readonly tools: string[] = [];

  // ---- 外部依赖 ----
  private readonly bodyBus: BodyBus;
  private readonly computeQuotaService: ComputeQuotaLike | null;
  private readonly userLocationService: UserLocationLike | null;
  private readonly deviceRegistry: DeviceRegistryLike | null;

  // ---- 阈值与轮询参数 ----
  private readonly batteryLowThreshold: number;
  private readonly quotaLowThreshold: number;
  private readonly hungerHighThreshold: number;
  private readonly pollIntervalMs: number;

  // ---- 内部状态 ----
  /** 电量 0-1（聚合各设备电量均值，默认 1） */
  private battery: number = 1;
  /** 当前位置（最新位置字符串；无定位时为 null） */
  private location: string | null = null;
  /** 算力配额 0-1（默认 1） */
  private quota: number = 1;
  /** 当前负载 0-1（默认 0） */
  private load: number = 0;
  /** 疲劳度 0-1（基于活动量+运行时长，HomeostasisCore 维护） */
  private fatigue: number = 0;
  /** 启动时间（ISO timestamp，用于计算 fatigue 次要因子） */
  private startedAt: string = new Date(0).toISOString();
  /** 启动时间戳（ms，用于 fatigue 计算的内部辅助字段） */
  private startedAtMs: number = 0;

  // ---- P0-3 新增：情绪维度 ----
  /** 当前情绪基调（权威源，body-gateway 优先取此值） */
  private mood: MoodKind = "idle";
  /** 情绪效价 0-1（0=消极 / 1=积极） */
  private moodValence: number = 0.5;

  // ---- P0-3 新增：饥饿维度 ----
  /** 饥饿度 0-1（算力/能量消耗率；>hungerHighThreshold 发布告警） */
  private hunger: number = 0;

  // ---- P0-3 新增：活动量追踪（来自 BodyBus 信号订阅） ----
  /** 近期动作执行次数（body.action.executed 计数，每轮 pollOnce 后重置） */
  private recentActionCount: number = 0;
  /** 近期信号时间戳列表（ms，用于计算信号密度，prune 到 5 分钟窗口） */
  private recentSignalTimes: number[] = [];

  // ---- 风险点2：高负载冷却机制 ----
  // 当 fatigue ≥ COOLDOWN_ENTER_THRESHOLD 时进入冷却期，活动量因子衰减 70%，
  // 让疲劳增速放缓（模拟人体肾上腺素后的代偿期），避免 1-2 小时内迅速达极限。
  // 冷却期持续到 fatigue 降到 COOLDOWN_EXIT_THRESHOLD 以下才退出。
  private inCooldown: boolean = false;
  private readonly COOLDOWN_ENTER_THRESHOLD = 0.85;
  private readonly COOLDOWN_EXIT_THRESHOLD = 0.5;
  private readonly COOLDOWN_ACTIVITY_FACTOR = 0.3; // 冷却期活动量衰减到 30%

  // ---- 告警去重标记 ----
  private batteryLowEmitted = false;
  private quotaLowEmitted = false;
  private hungerHighEmitted = false;

  // ---- 最近一台电量设备 id（用于告警 payload） ----
  private lastBatteryDeviceId: string | null = null;

  // ---- 生命周期 ----
  private online = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastActivityAt: string | null = null;

  // ---- BodyBus 订阅取消函数（stop 时清理） ----
  private unsubscribers: Array<() => void> = [];

  constructor(deps: HomeostasisCoreDeps) {
    this.bodyBus = deps.bodyBus;
    this.computeQuotaService = deps.computeQuotaService ?? null;
    this.userLocationService = deps.userLocationService ?? null;
    this.deviceRegistry = deps.deviceRegistry ?? null;
    this.batteryLowThreshold = deps.batteryLowThreshold ?? 0.2;
    this.quotaLowThreshold = deps.quotaLowThreshold ?? 0.1;
    this.hungerHighThreshold = deps.hungerHighThreshold ?? 0.8;
    this.pollIntervalMs = deps.pollIntervalMs ?? 60_000;
  }

  // ---- 生命周期 ----

  /**
   * 启动稳态核心：标记 online，记录启动时间，订阅 BodyBus 信号，启动周期轮询定时器。
   * 定时器调用 unref() 避免阻塞进程退出。首次启动立即轮询一次，
   * 避免等一个完整 interval 才有数据。
   *
   * P0-3：订阅 body.action.executed / body.action.failed 信号，
   * 用于估算活动量（fatigue/hunger 依赖）。
   * 订阅失败不阻断启动（降级到纯轮询模式，活动量估算回退到 0）。
   */
  async start(): Promise<void> {
    if (this.online) {
      console.log("[HomeostasisCore] 已启动，跳过重复 start");
      return;
    }
    console.log("[HomeostasisCore] 正在启动...");
    this.online = true;
    this.startedAt = new Date().toISOString();
    this.startedAtMs = Date.now();
    this.lastActivityAt = this.startedAt;

    // P0-3：订阅 BodyBus 信号（活动量估算 + 环境感知联动）
    this.subscribeBodyBusSignals();

    // 首次立即轮询一次，避免等一个完整 interval 才有数据
    try {
      await this.pollOnce();
    } catch (err) {
      console.log(`[HomeostasisCore] 首次轮询失败（不阻断启动）: ${err}`);
    }

    this.timer = setInterval(() => {
      // fire-and-forget；异常在 pollOnce 内捕获
      void this.pollOnce().catch((err) => {
        console.log(`[HomeostasisCore] 轮询异常: ${err}`);
      });
    }, this.pollIntervalMs);
    // unref：定时器不阻止 Node 进程退出
    this.timer.unref();

    console.log("[HomeostasisCore] 启动完成");
  }

  /**
   * 停止稳态核心：清理定时器，取消 BodyBus 订阅，标记 offline。
   */
  async stop(): Promise<void> {
    if (!this.online) {
      console.log("[HomeostasisCore] 未启动，跳过 stop");
      return;
    }
    console.log("[HomeostasisCore] 正在停止...");
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    // P0-3：取消所有 BodyBus 订阅
    for (const unsub of this.unsubscribers) {
      try {
        unsub();
      } catch {
        // 取消订阅失败不阻断
      }
    }
    this.unsubscribers = [];
    this.online = false;
    console.log("[HomeostasisCore] 已停止");
  }

  // ---- 动作执行（纯聚合服务，不接受动作） ----

  /**
   * HomeostasisCore 是纯聚合服务，tools=[]，不直接接受任何动作。
   * 所有 act 调用统一返回 ok=false。
   */
  async act(_action: BodyAction): Promise<BodyActionResult> {
    return {
      ok: false,
      result: {},
      errorMessage: "homeostasis does not accept actions",
    };
  }

  // ---- 感官查询 ----

  /**
   * 感官查询。
   *
   * 支持的 query.kind：
   *  - "state"：返回完整稳态状态（battery/location/quota/load/fatigue/mood/hunger/valence）
   *  - "homeostasis.battery"：仅返回电量 + 阈值 + low 标记
   *  - "homeostasis.quota"：仅返回配额 + 阈值 + low 标记
   *  - "homeostasis.mood"：仅返回情绪基调 + 效价
   *  - "homeostasis.hunger"：仅返回饥饿度 + 阈值 + high 标记
   *
   * 其他 kind 返回 ok=false + "unknown_query_kind"。
   */
  async sense(query: BodySenseQuery): Promise<BodySenseResult> {
    const kind = query.kind;
    if (kind === "state") {
      return {
        ok: true,
        data: {
          battery: this.battery,
          location: this.location,
          quota: this.quota,
          load: this.load,
          fatigue: this.fatigue,
          mood: this.mood,
          hunger: this.hunger,
          valence: this.moodValence,
        },
        module: "homeostasis",
      };
    }
    if (kind === "homeostasis.battery") {
      return {
        ok: true,
        data: {
          battery: this.battery,
          threshold: this.batteryLowThreshold,
          low: this.battery < this.batteryLowThreshold,
        },
        module: "homeostasis",
      };
    }
    if (kind === "homeostasis.quota") {
      return {
        ok: true,
        data: {
          quota: this.quota,
          threshold: this.quotaLowThreshold,
          low: this.quota < this.quotaLowThreshold,
        },
        module: "homeostasis",
      };
    }
    if (kind === "homeostasis.mood") {
      return {
        ok: true,
        data: {
          mood: this.mood,
          valence: this.moodValence,
        },
        module: "homeostasis",
      };
    }
    if (kind === "homeostasis.hunger") {
      return {
        ok: true,
        data: {
          hunger: this.hunger,
          threshold: this.hungerHighThreshold,
          high: this.hunger > this.hungerHighThreshold,
        },
        module: "homeostasis",
      };
    }
    return {
      ok: false,
      data: { error: "unknown_query_kind" },
      module: "homeostasis",
      errorMessage: `unknown_query_kind:${kind}`,
    };
  }

  // ---- 快照 ----

  /**
   * 模块快照：标准字段 + metadata（battery/location/quota/load/fatigue/mood/hunger/valence）。
   * BodyGateway.snapshot 通过 metadata 聚合 BodyState。
   *
   * P0-3：metadata 新增 mood/hunger/valence，让 body-gateway 能从 homeostasis 快照
   * 提取 mood（权威源），而非仅依赖 vestibular 的渲染态 mood。
   */
  snapshot(): BodyModuleSnapshot {
    return {
      name: "homeostasis",
      label: this.label,
      tools: this.tools,
      online: this.online,
      subsystems: this.collectSubsystems(),
      lastActivityAt: this.lastActivityAt,
      metadata: {
        battery: this.battery,
        location: this.location,
        quota: this.quota,
        load: this.load,
        fatigue: this.fatigue,
        mood: this.mood,
        hunger: this.hunger,
        valence: this.moodValence,
      },
    };
  }

  // ---- 工具注册（tools=[]，无工具可注册） ----

  /**
   * HomeostasisCore 不暴露工具，注册方法留空。
   */
  registerTools(_registry: BodyToolRegistry): void {
    // 纯聚合服务，无工具可注册
  }

  // ---- 公开方法：供 BodyCenter.state() 聚合调用 ----

  /**
   * 返回当前稳态状态（BodyState 权威值）。
   * BodyCenter.state() 可直接读取此方法返回值。
   *
   * P0-3：新增 mood/hunger/valence 字段（只增不删，保持接口兼容）。
   * mood 是权威源，body-gateway 优先取此值；vestibular 的 mood 作为 fallback。
   */
  getState(): BodyState {
    return {
      battery: this.battery,
      location: this.location ?? undefined,
      quota: this.quota,
      load: this.load,
      fatigue: this.fatigue,
      mood: this.mood,
      hunger: this.hunger,
      valence: this.moodValence,
    };
  }

  // ---- 内部：轮询 ------------------------------------------------------------

  /**
   * 单次轮询：依次更新 quota / location / battery / fatigue / load / mood / hunger，
   * 然后触发阈值检查。
   *
   * P0-3：新增 refreshMood / refreshHunger；refreshFatigue 重构为基于活动量。
   * 子系统缺失或调用异常时优雅降级（保持上次值或默认值）。
   */
  private async pollOnce(): Promise<void> {
    // 1. 算力配额
    await this.refreshQuota();
    // 2. 用户位置
    await this.refreshLocation();
    // 3. 设备电量（聚合）
    await this.refreshBattery();
    // 4. 疲劳度（P0-3：基于活动量 + 运行时长次要因子）
    this.refreshFatigue();
    // 5. 负载
    await this.refreshLoad();
    // 6. P0-3 新增：饥饿度（基于活动量增长）
    this.refreshHunger();
    // 7. P0-3 新增：情绪基调（基于生理 + 活动 + 效价）
    this.refreshMood();

    this.lastActivityAt = new Date().toISOString();

    // 8. 阈值检查（含 hunger）
    this.checkThresholds();

    // 9. 重置近期动作计数（下一轮重新累计）
    this.recentActionCount = 0;
  }

  /**
   * 更新 quota：调用 computeQuotaService.getQuota()。
   * 缺失或异常时保持上次值。
   */
  private async refreshQuota(): Promise<void> {
    if (!this.computeQuotaService) {
      return;
    }
    try {
      const v = await this.computeQuotaService.getQuota();
      if (typeof v === "number" && Number.isFinite(v)) {
        this.quota = clamp01(v);
      }
    } catch (err) {
      console.log(`[HomeostasisCore] refreshQuota 异常（保持上次值）: ${err}`);
    }
  }

  /**
   * 更新 location：调用 userLocationService.getLocation()。
   * 缺失或异常时保持上次值；返回 null 时也保持上次值（不主动清空）。
   */
  private async refreshLocation(): Promise<void> {
    if (!this.userLocationService) {
      return;
    }
    try {
      const info = await this.userLocationService.getLocation();
      if (!info) {
        return;
      }
      this.location = formatLocation(info);
    } catch (err) {
      console.log(`[HomeostasisCore] refreshLocation 异常（保持上次值）: ${err}`);
    }
  }

  /**
   * 更新 battery：通过 deviceRegistry 列出具备 sensor.battery 能力的设备，
   * 逐个调用 sensor.battery.read，取均值。
   * 缺失或异常时保持上次值。
   */
  private async refreshBattery(): Promise<void> {
    if (!this.deviceRegistry) {
      return;
    }
    if (typeof this.deviceRegistry.listByCapability !== "function") {
      return;
    }
    try {
      const devices = this.deviceRegistry.listByCapability("sensor.battery") ?? [];
      if (devices.length === 0) {
        return;
      }
      const levels: number[] = [];
      let lastDeviceId: string | null = null;
      for (const dev of devices) {
        try {
          const res = await this.deviceRegistry.invoke(
            dev.deviceId,
            "sensor.battery.read",
            {},
          );
          if (!res?.ok) {
            continue;
          }
          const level = extractBatteryLevel(res.result);
          if (typeof level === "number" && Number.isFinite(level)) {
            levels.push(clamp01(level));
            lastDeviceId = dev.deviceId;
          }
        } catch (err) {
          console.log(
            `[HomeostasisCore] refreshBattery 设备调用失败 deviceId=${dev.deviceId}: ${err}`,
          );
        }
      }
      if (levels.length > 0) {
        const sum = levels.reduce((a, b) => a + b, 0);
        this.battery = clamp01(sum / levels.length);
        this.lastBatteryDeviceId = lastDeviceId;
      }
    } catch (err) {
      console.log(`[HomeostasisCore] refreshBattery 异常（保持上次值）: ${err}`);
    }
  }

  /**
   * 更新 fatigue：P0-3 重构为基于活动量的非线性模型 + 风险点2 高负载冷却机制。
   *
   * 活动量（activityLevel 0-1）由两个因子加权：
   *  - 近期 LLM/工具调用次数（0.6 权重）：recentActionCount / 20，上限 1
   *  - 信号密度（0.4 权重）：近 5 分钟 BodyBus 信号数 / 100，上限 1
   *
   * 疲劳增长/恢复规则（每次 poll，默认 60s 间隔）：
   *  - activityLevel > 0.2：fatigue += activityLevel * 0.01（活动量越高增长越快）
   *  - activityLevel <= 0.2：fatigue -= 0.004（空闲时缓慢恢复）
   *  - 运行时长次要因子：超过 4 小时后每小时额外 +0.003（避免长期运行无疲劳）
   *
   * 风险点2 高负载冷却机制：
   *  - fatigue ≥ 0.85 时进入冷却期，活动量因子衰减到 30%（增速大幅放缓）
   *  - 冷却期持续到 fatigue 降到 0.5 以下才退出（迟滞区间防抖动）
   *  - 冷却期内增长系数从 0.01 降到 0.003，避免 1-2 小时内迅速达极限
   *
   * 最终值 clamp 到 [0, 1]。
   */
  private refreshFatigue(): void {
    let activityLevel = this.computeActivityLevel();
    const elapsedMs = this.startedAtMs ? Date.now() - this.startedAtMs : 0;
    const elapsedHours = elapsedMs / (60 * 60 * 1000);

    // 风险点2：高负载冷却期——fatigue 达到进入阈值后衰减活动量因子，放缓增速
    if (this.inCooldown) {
      activityLevel *= this.COOLDOWN_ACTIVITY_FACTOR;
    }

    let delta: number;
    if (activityLevel > 0.2) {
      // 活动量高 → fatigue 增长；冷却期内使用更低的增长系数
      const growthRate = this.inCooldown ? 0.003 : 0.01;
      delta = activityLevel * growthRate;
    } else {
      // 空闲 → 缓慢恢复
      delta = -0.004;
    }

    // 运行时长次要因子：超过 4 小时后缓慢增加疲劳
    if (elapsedHours > 4) {
      delta += 0.003;
    }

    this.fatigue = clamp01(this.fatigue + delta);

    // 冷却期状态机迁移（迟滞区间防抖动）
    if (!this.inCooldown && this.fatigue >= this.COOLDOWN_ENTER_THRESHOLD) {
      this.inCooldown = true;
      console.log("[HomeostasisCore] 进入高负载冷却期（fatigue 增速放缓）");
    } else if (this.inCooldown && this.fatigue < this.COOLDOWN_EXIT_THRESHOLD) {
      this.inCooldown = false;
      console.log("[HomeostasisCore] 退出高负载冷却期（疲劳已恢复）");
    }
  }

  /**
   * 更新 load：优先用 computeQuotaService.getCurrentLoad()；
   * 缺失时保持上次值（默认 0）。
   *
   * 注：后续可接入 active task 计数估算负载，当前以 getCurrentLoad 为权威源。
   */
  private async refreshLoad(): Promise<void> {
    if (!this.computeQuotaService) {
      return;
    }
    if (typeof this.computeQuotaService.getCurrentLoad !== "function") {
      return;
    }
    try {
      const v = await this.computeQuotaService.getCurrentLoad();
      if (typeof v === "number" && Number.isFinite(v)) {
        this.load = clamp01(v);
      }
    } catch (err) {
      console.log(`[HomeostasisCore] refreshLoad 异常（保持上次值）: ${err}`);
    }
  }

  // ---- P0-3 新增：情绪 / 饥饿 / 活动量 ----------------------------------------

  /**
   * 计算当前活动量水平（0-1）。
   *
   * 两因子加权：
   *  - 近期动作执行次数（0.6 权重）：min(recentActionCount / 20, 1)
   *  - 信号密度（0.4 权重）：min(近5分钟信号数 / 100, 1)
   *
   * BodyBus 不可用时（无订阅），recentActionCount 为 0，
   * 信号密度回退到 BodyBus.getRecentSignals 查询（若可用）。
   */
  private computeActivityLevel(): number {
    const actionFactor = Math.min(this.recentActionCount / 20, 1);
    const signalDensity = this.computeSignalDensity();
    return clamp01(actionFactor * 0.6 + signalDensity * 0.4);
  }

  /**
   * 计算近 5 分钟信号密度（BodyBus 信号数量）。
   *
   * 优先使用 BodyBus.getRecentSignals() 查询历史窗口（覆盖所有 body.* 信号），
   * 叠加订阅追踪的 recentSignalTimes（防止 getRecentSignals 窗口裁剪过快）。
   * 取两者最大值作为密度估计，归一化到 0-1（/100）。
   */
  private computeSignalDensity(): number {
    const fiveMinAgo = Date.now() - 5 * 60 * 1000;

    // 方式 1：从 BodyBus 历史窗口查询
    let busCount = 0;
    try {
      const recent = this.bodyBus.getRecentSignals(200);
      for (const sig of recent) {
        const t = Date.parse(sig.timestamp);
        if (Number.isFinite(t) && t >= fiveMinAgo) {
          busCount++;
        }
      }
    } catch {
      // BodyBus 不可用时静默
    }

    // 方式 2：从订阅追踪的时间戳列表查询
    let trackedCount = 0;
    for (const t of this.recentSignalTimes) {
      if (t >= fiveMinAgo) {
        trackedCount++;
      }
    }

    const count = Math.max(busCount, trackedCount);
    return Math.min(count / 100, 1);
  }

  /**
   * 更新 mood：P0-3 新增，基于生理指标 + 活动量 + 效价。
   *
   * 情绪-生理耦合规则（优先级从高到低）：
   *  1. battery < 0.2 → alert（低电量告警）
   *  2. quota < 0.1 → idle（无算力资源，无法工作）
   *  3. hunger > 0.8 → alert（高饥饿，需要"进食"/补充能量）
   *  4. fatigue > 0.8 → idle（过度疲劳，需要休息）
   *  5. recentActionCount > 0 → thinking（近期有动作执行）
   *  6. 信号密度高 + battery > 0.5 → listening（接收大量输入）
   *  7. valence > 0.7 → happy（一切顺利）
   *  8. 默认 → idle
   *
   * 同时计算 moodValence（0-1，0=消极 / 1=积极）：
   *  valence = 0.3*battery + 0.2*quota + 0.2*(1-fatigue) + 0.2*(1-hunger) + 0.1*activityBonus
   */
  private refreshMood(): void {
    // 计算效价
    const activityLevel = this.computeActivityLevel();
    const activityBonus = activityLevel > 0.1 && activityLevel < 0.8 ? 0.5 : 0.3;
    this.moodValence = clamp01(
      0.3 * this.battery +
        0.2 * this.quota +
        0.2 * (1 - this.fatigue) +
        0.2 * (1 - this.hunger) +
        0.1 * activityBonus,
    );

    // 情绪-生理耦合判定（优先级从高到低）
    let newMood: MoodKind;
    if (this.battery < this.batteryLowThreshold) {
      newMood = "alert";
    } else if (this.quota < this.quotaLowThreshold) {
      newMood = "idle";
    } else if (this.hunger > this.hungerHighThreshold) {
      newMood = "alert";
    } else if (this.fatigue > 0.8) {
      newMood = "idle";
    } else if (this.recentActionCount > 0) {
      newMood = "thinking";
    } else if (activityLevel > 0.3 && this.battery > 0.5) {
      newMood = "listening";
    } else if (this.moodValence > 0.7) {
      newMood = "happy";
    } else {
      newMood = "idle";
    }

    this.mood = newMood;
  }

  /**
   * 更新 hunger：P0-3 新增，基于近期活动量增长。
   *
   * 规则（每次 poll，默认 60s 间隔）：
   *  - hunger += activityLevel * 0.01（活动量越高，饥饿增长越快）
   *  - hunger 自然衰减：hunger -= 0.002（轻微的"消化"）
   *  - 任务完成时在信号处理器中额外 hunger -= 0.1（"满足"）
   *
   * 最终值 clamp 到 [0, 1]。
   */
  private refreshHunger(): void {
    const activityLevel = this.computeActivityLevel();
    // 活动量驱动饥饿增长
    const growth = activityLevel * 0.01;
    // 自然衰减（轻微）
    const decay = 0.002;
    this.hunger = clamp01(this.hunger + growth - decay);
  }

  /**
   * P0-3 新增：订阅 BodyBus 信号，用于估算活动量 + 环境感知联动。
   *
   * 订阅的信号 kind：
   *  - body.action.executed → recentActionCount++，hunger 微增，记录信号时间
   *  - body.action.failed → 记录信号时间（失败也消耗能量）
   *
   * 订阅失败不阻断启动（降级到纯轮询）。
   * 所有 handler fire-and-forget，异常静默吞掉。
   */
  private subscribeBodyBusSignals(): void {
    const recordSignal = (): void => {
      const now = Date.now();
      this.recentSignalTimes.push(now);
      // prune：只保留近 5 分钟的时间戳
      const fiveMinAgo = now - 5 * 60 * 1000;
      this.recentSignalTimes = this.recentSignalTimes.filter((t) => t >= fiveMinAgo);
    };

    try {
      // body.action.executed → 动作计数 +1，hunger 微增
      const unsubExec = this.bodyBus.subscribe(
        BODY_SIGNAL_KIND.ACTION_EXECUTED,
        () => {
          this.recentActionCount++;
          // 每次动作执行消耗能量 → hunger 微增
          this.hunger = clamp01(this.hunger + 0.02);
          recordSignal();
        },
      );
      this.unsubscribers.push(unsubExec);

      // body.action.failed → 记录信号（失败也消耗能量）
      const unsubFailed = this.bodyBus.subscribe(
        BODY_SIGNAL_KIND.ACTION_FAILED,
        () => {
          this.hunger = clamp01(this.hunger + 0.015);
          recordSignal();
        },
      );
      this.unsubscribers.push(unsubFailed);

      console.log(
        `[HomeostasisCore] 已订阅 BodyBus 信号（action.executed/action.failed）`,
      );
    } catch (err) {
      // 订阅失败不阻断启动，降级到纯轮询模式
      console.log(`[HomeostasisCore] BodyBus 订阅失败（降级到纯轮询）: ${err}`);
    }
  }

  // ---- 内部：阈值告警 --------------------------------------------------------

  /**
   * 阈值检查：battery / quota / hunger 越过阈值时发布告警信号，
   * 恢复到安全区间时复位去重标记。
   *
   * 信号 kind：
   *  - body.homeostasis.battery_low
   *  - body.homeostasis.quota_low
   *  - body.homeostasis.hunger_high（P0-3 新增）
   *
   * 去重逻辑：batteryLowEmitted / quotaLowEmitted / hungerHighEmitted 防止重复发布；
   * 指标恢复到安全区间时复位标记，允许下次再次告警。
   */
  private checkThresholds(): void {
    // 电量检查
    if (this.battery < this.batteryLowThreshold) {
      if (!this.batteryLowEmitted) {
        this.bodyBus.publish({
          kind: BODY_SIGNAL_KIND.HOMEOSTASIS_BATTERY_LOW,
          payload: {
            battery: this.battery,
            threshold: this.batteryLowThreshold,
            deviceId: this.lastBatteryDeviceId ?? undefined,
          },
          module: "homeostasis",
          timestamp: new Date().toISOString(),
        });
        this.batteryLowEmitted = true;
      }
    } else {
      // 恢复到阈值之上：复位标记，允许下次再次告警
      this.batteryLowEmitted = false;
    }

    // 配额检查
    if (this.quota < this.quotaLowThreshold) {
      if (!this.quotaLowEmitted) {
        this.bodyBus.publish({
          kind: BODY_SIGNAL_KIND.HOMEOSTASIS_QUOTA_LOW,
          payload: {
            quota: this.quota,
            threshold: this.quotaLowThreshold,
          },
          module: "homeostasis",
          timestamp: new Date().toISOString(),
        });
        this.quotaLowEmitted = true;
      }
    } else {
      this.quotaLowEmitted = false;
    }

    // P0-3 新增：饥饿检查
    if (this.hunger > this.hungerHighThreshold) {
      if (!this.hungerHighEmitted) {
        this.bodyBus.publish({
          kind: BODY_SIGNAL_KIND.HOMEOSTASIS_HUNGER_HIGH,
          payload: {
            hunger: this.hunger,
            threshold: this.hungerHighThreshold,
          },
          module: "homeostasis",
          timestamp: new Date().toISOString(),
        });
        this.hungerHighEmitted = true;
      }
    } else {
      // 恢复到阈值之下：复位标记
      this.hungerHighEmitted = false;
    }
  }

  // ---- 内部：辅助 ------------------------------------------------------------

  /**
   * 收集当前已注入的子系统标识列表（用于 snapshot.subsystems）。
   */
  private collectSubsystems(): string[] {
    const out: string[] = [];
    if (this.computeQuotaService) out.push("compute-quota");
    if (this.userLocationService) out.push("user-location");
    if (this.deviceRegistry) out.push("device-registry");
    return out;
  }
}

// ---- 工具函数 ------------------------------------------------------------

/**
 * 把数值限制在 [0, 1] 区间。
 */
function clamp01(v: number): number {
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

/**
 * 把 UserLocationLike 返回的位置信息格式化为字符串。
 * 优先级：city > region > country > "lat,lng" > "unknown"。
 */
function formatLocation(info: {
  city?: string;
  region?: string;
  country?: string;
  latitude?: number;
  longitude?: number;
}): string {
  const parts: string[] = [];
  if (info.city) parts.push(info.city);
  if (info.region) parts.push(info.region);
  if (info.country) parts.push(info.country);
  if (parts.length > 0) {
    return parts.join(", ");
  }
  if (typeof info.latitude === "number" && typeof info.longitude === "number") {
    return `${info.latitude.toFixed(4)}, ${info.longitude.toFixed(4)}`;
  }
  return "unknown";
}

/**
 * 从 sensor.battery.read 调用结果中提取电量比例 0-1。
 * 兼容多种字段名：battery / level / value / percent。
 * percent 字段可能是 0-100，归一到 0-1。
 */
function extractBatteryLevel(result: unknown): number | null {
  if (!result || typeof result !== "object") {
    return null;
  }
  const obj = result as Record<string, unknown>;
  for (const key of ["battery", "level", "value", "percent"]) {
    const v = obj[key];
    if (typeof v === "number" && Number.isFinite(v)) {
      if (key === "percent" && v > 1) {
        return v / 100;
      }
      return v;
    }
  }
  return null;
}
