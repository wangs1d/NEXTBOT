// Agent Body Center — 核心类型定义
//
// 与 brain/types.ts 对称：定义身体中心（BodyCenter）对外/对内的统一类型。
// 8 个 BodyModule 的抽象、动作/信号/状态/快照、反射弧判定与感官查询。

/**
 * BodyModule 标识种类。
 *
 * 与人体器官对照：
 *  - eye         眼（视觉）：截屏 / 摄像头 / VLM 描述
 *  - ear         耳（听觉）：phone-bridge / voice-message 入站音频到达
 *  - skin        皮肤（体感）：智能家居 / 设备传感器（纯感知，无下行工具）
 *  - vestibular  前庭器（平衡）：多设备渲染状态（纯感知，无下行工具）
 *  - homeostasis 稳态（内脏）：电量 / 位置 / 算力配额 / 负载 / 疲劳度
 *  - reflex      反射弧（脊髓反射）：硬安全门，rm -rf / format 等直接 DENY
 *
 * 注：hand（运动执行器）/ mouth（发声）已移除——下行工具执行统一由
 *     capability-modules 与 tools/*.ts 直接注册到 ToolRegistry，
 *     经 BodyGateway fallback 兜底，不再有器官门面。
 */
export type BodyModuleKind =
  | "eye"         // 眼（原 visual）
  | "ear"         // 耳（原 auditory）
  | "skin"        // 皮肤（原 somato）
  | "vestibular"  // 前庭器（保留）
  | "homeostasis" // 内脏（保留）
  | "reflex"      // 反射弧（保留）
  | "rhythm"      // 节律感知（生物钟）：连续工作 / 深夜活跃检测
  // ---- 信号发布源（非真实 BodyModule，仅用于 BodySignal.module 标识）----
  // "action" 标识来自 brain 层 ActionExecutor 的工具执行反馈信号；
  // 不会注册到 BodyGateway/BodyCenter，仅作为 BodySignal.module 合法值。
  | "action";

/**
 * 身体动作（与 brain 的 BrainDecisionAction 对应，但加入 actorId/source/id 上下文）。
 *
 * 由 BrainCenter.ActionExecutor 委托到 BodyGateway.execute(action) 时构造。
 */
export interface BodyAction {
  /** 工具名，如 "desktop.visual.run_task" / "tts.speak" */
  tool: string;
  /** 工具参数 */
  args: Record<string, unknown>;
  /** 触发该动作的 actor id（可选，用于审计/路由上下文） */
  actorId?: string;
  /** 动作来源标识，如 "proaction" / "cognize" / "planner" / "external" */
  source?: string;
  /** 动作唯一 id（可选，便于审计与幂等） */
  id?: string;
}

/**
 * 身体动作执行结果。
 *
 * - ok=true：执行成功，result 携带工具产出
 * - ok=false + refused=true：被反射弧拒绝（硬危险动作，未经 LLM）
 * - ok=false + errorMessage：执行异常
 */
export interface BodyActionResult {
  ok: boolean;
  /** 工具产出（成功时）或错误上下文（失败时） */
  result: Record<string, unknown>;
  /** 是否被反射弧拒绝 */
  refused?: boolean;
  /** 拒绝原因（refused=true 时填） */
  reason?: string;
  /** 执行异常信息（ok=false 且非拒绝时填） */
  errorMessage?: string;
  /** 执行耗时（ms） */
  durationMs?: number;
}

/**
 * 身体内部信号（BodyBus 上流转的消息单元）。
 *
 * BodyModule 在状态变化时发布到 BodyBus；BrainCenter 的 SensoryCortex /
 * AwarenessCortex 通过 SynapseBus 桥接订阅 body.* 主题。
 *
 * 信号 kind 命名空间（统一前缀 `body.`）：
 *  - body.action.executed / body.action.failed            — ActionExecutor 工具执行反馈（brain→body 闭环）
 *  - body.homeostasis.battery_low / quota_low / hunger_high — 稳态阈值告警
 *  - body.vestibular.device_switch                        — 前庭器设备切换
 *  - body.skin.device_change / sensor_reading / ...        — 皮肤感知
 *  - body.eye.frame / body.ear.transcript                 — 感官通路
 */
export interface BodySignal {
  /** 信号类型，如 "body.eye.frame" / "body.homeostasis.battery_low" */
  kind: string;
  /** 信号负载 */
  payload: Record<string, unknown>;
  /** 发布该信号的 BodyModule */
  module: BodyModuleKind;
  /** 关联的 actor id（可选） */
  actorId?: string;
  /** ISO timestamp */
  timestamp: string;
}

// ---- 信号 kind 常量（便于订阅方引用，避免硬编码字符串拼写错误）------------

/**
 * ActionExecutor 工具执行反馈信号 kind。
 *
 * P0-2 工具执行反馈闭环：ActionExecutor.execute 成功/失败后通过 BodyBus
 * 发布对应信号，让下一轮 cognize 能感知上一轮执行了什么。
 */
export const BODY_SIGNAL_KIND = {
  /** ActionExecutor 工具执行成功（含 tool/actorId/result摘要/success:true） */
  ACTION_EXECUTED: "body.action.executed",
  /** ActionExecutor 工具执行失败（含 tool/actorId/error/success:false） */
  ACTION_FAILED: "body.action.failed",
  /** 稳态：电量低于阈值 */
  HOMEOSTASIS_BATTERY_LOW: "body.homeostasis.battery_low",
  /** 稳态：算力配额低于阈值 */
  HOMEOSTASIS_QUOTA_LOW: "body.homeostasis.quota_low",
  /** 稳态：饥饿度高于阈值 */
  HOMEOSTASIS_HUNGER_HIGH: "body.homeostasis.hunger_high",
} as const;

/**
 * 身体内部状态聚合。
 *
 * 由各 BodyModule 的子状态聚合而成，HomeostasisCore 主导维护。
 * LLM 调用 body.state 工具时返回此对象。
 */
export interface BodyState {
  /** 电量 0-1（来自 HomeostasisCore 聚合各设备 sensor.battery） */
  battery?: number;
  /** 当前地理位置（如 "Shanghai" / GPS 字符串） */
  location?: string;
  /** 算力配额 0-1（ComputeQuotaService 报告） */
  quota?: number;
  /** 当前负载 0-1 */
  load?: number;
  /** 疲劳度 0-1（基于活动量+运行时长，HomeostasisCore 维护） */
  fatigue?: number;
  /** 当前正在渲染 agent 身体的设备 id（如 "desktop" / "phone" / "glasses"） */
  currentDevice?: string;
  /**
   * 当前情绪基调（权威来源：HomeostasisCore；fallback：VestibularApparatus 渲染态）。
   * 取值：idle / listening / thinking / happy / alert
   */
  mood?: string;
  /** 是否正在渲染 3D 具身（VestibularApparatus 维护） */
  rendering?: boolean;
  /** 饥饿度 0-1（算力/能量消耗率，HomeostasisCore 维护；>0.8 触发 hunger_high 告警） */
  hunger?: number;
  /** 情绪效价 0-1（0=消极 / 1=积极，HomeostasisCore 维护） */
  valence?: number;
}

/**
 * BodyModule 快照。
 *
 * 用于 BodyGateway.snapshot() 聚合返回，以及 body.list_modules 工具响应。
 */
export interface BodyModuleSnapshot {
  /** 模块标识 */
  name: BodyModuleKind;
  /** 中文标签，如 "手（运动执行器）" */
  label: string;
  /** 该模块挂载的工具名列表 */
  tools: string[];
  /** 模块是否在线（start 成功且未 stop） */
  online: boolean;
  /** 子系统标识列表（如 ["desktop-visual-port", "agent-browser"]） */
  subsystems: string[];
  /** 最近一次活动时间（ISO timestamp，无活动时为 null） */
  lastActivityAt: string | null;
  /** 额外元数据（可选） */
  metadata?: Record<string, unknown>;
}

/**
 * 反射弧判定结果。
 *
 * ReflexArc.check(action) 的返回值：
 *  - allow：放行，交 BodyModule.act 执行
 *  - deny：硬拒绝，BodyGateway 直接返回 refused=true
 */
export interface ReflexVerdict {
  verdict: "allow" | "deny";
  /** 拒绝原因（deny 时填，如 "destructive operation"） */
  reason?: string;
  /** 命中的 DENY_PATTERN 字符串（deny 时填，便于审计） */
  matchedPattern?: string;
  /** 严重程度（deny=硬拒绝，high_risk=默认拒绝需审批） */
  severity?: "deny" | "high_risk";
}

/**
 * 身体感官查询。
 *
 * BrainCenter.cognize 阶段 1 / BrainStem 周期扫描 / body.where_am_i 工具
 * 都通过 BodyGateway.sense(query) 拉取身体当前感知。
 */
export interface BodySenseQuery {
  /** 查询类型，如 "where_am_i" / "eye.desktop_frame" / "ear.transcript" */
  kind: string;
  /** 关联的 actor id（可选） */
  actorId?: string;
  /** 路由到哪个 BodyModule（可选；不传时 BodyGateway 按 kind 前缀路由） */
  module?: BodyModuleKind;
  /** 查询参数（可选） */
  params?: Record<string, unknown>;
}

/**
 * 身体感官查询结果。
 */
export interface BodySenseResult {
  ok: boolean;
  /** 感知数据（如 { device, x, y, mood, rendering }） */
  data: Record<string, unknown>;
  /** 实际响应的 BodyModule（可选） */
  module?: BodyModuleKind;
  /** 错误信息（ok=false 时填） */
  errorMessage?: string;
}

/**
 * 工具注册表外观（BodyModule.registerTools 入参）。
 *
 * 与 brain/action-executor.ts 的 ToolRegistryLike 解耦，仅暴露 register 方法。
 * BodyModule 通过此接口把自己的工具挂到外部 ToolRegistry，handler 内部委托 this.act()。
 */
export interface BodyToolRegistry {
  register(
    name: string,
    handler: (input: Record<string, unknown>) => Promise<Record<string, unknown>>,
  ): void;
}

/**
 * BodyModule 外观接口。
 *
 * 8 个具体 BodyModule（Eye / Ear / Skin /
 * VestibularApparatus / HomeostasisCore / ReflexArc / RhythmCore）均实现此接口。
 *
 * 设计原则（与 brain 的 CortexLike 一致）：
 *  - start/stop 可选，缺失时 BodyCenter 跳过
 *  - act/sense/snapshot 必填
 *  - registerTools 可选，装配阶段调用把工具挂到外部 ToolRegistry
 */
export interface BodyModuleLike {
  /** 模块标识 */
  readonly name: BodyModuleKind;
  /** 中文标签 */
  readonly label: string;
  /** 该模块负责的工具名列表 */
  readonly tools: string[];
  /** 启动模块（可选，缺失时视为无需启动） */
  start?(): Promise<void>;
  /** 停止模块（可选） */
  stop?(): Promise<void>;
  /** 执行动作 */
  act(action: BodyAction): Promise<BodyActionResult>;
  /** 感官查询 */
  sense(query: BodySenseQuery): Promise<BodySenseResult>;
  /** 模块快照 */
  snapshot(): BodyModuleSnapshot;
  /** 把工具挂到外部 ToolRegistry（可选，由装配阶段调用） */
  registerTools?(registry: BodyToolRegistry): void;
}

/**
 * BodyGateway 外观接口。
 *
 * BrainCenter 持有 BodyGatewayLike 引用即可，不依赖具体 BodyGateway 实现。
 * 与 brain 的 ActionExecutor + ToolRegistryLike 设计对称。
 */
export interface BodyGatewayLike {
  /** 执行动作（先过反射弧，再路由到 BodyModule.act） */
  execute(action: BodyAction): Promise<BodyActionResult>;
  /** 感官查询（路由到 BodyModule.sense） */
  sense(query: BodySenseQuery): Promise<BodySenseResult>;
  /** 全量快照（各模块 + 身体状态聚合） */
  snapshot(): { modules: BodyModuleSnapshot[]; state: BodyState };
  /**
   * 判断某工具是否已下沉到 BodyGateway。
   *
   * Task 12 工具下沉后，调用方（agent-core.ts 主路径 / ActionExecutor）据此
   * 决定走 BodyGateway.execute 还是 fallback 到 toolRegistry.execute。
   */
  hasRoute(tool: string): boolean;
}
