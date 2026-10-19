// 常驻传感层（SensorFabric）—— 统一信号类型定义。
//
// 设计目标（对应 docs 五层主动性架构 L1）：任何物理/数字数据源（桌面窗口、日程、
// 消息、 rhythm、财务、兴趣、天气、未来的家居/手机/电子产品）都以同一格式产出
// Signal，进 SensorKernel 统一去重、落盘、分发。全部零 LLM。
//
// 后续接入物理设备时只需实现 ProactiveSensor（轮询型）或注册 feeder（推送型），
// 不改动评估器与仲裁层。

/** 信号流（物理设备接入时在此扩展，如 "home" / "phone" / "wearable"） */
export type SignalStream =
  | "presence"
  | "conversation"
  | "screen"
  | "schedule"
  | "message"
  | "rhythm"
  | "finance"
  | "interest"
  | "weather"
  | "device"
  | "goal"
  | "file"
  | "clipboard"
  // ─── 外部信源收编（2026-10-10）：邮件/购物/位置 三条此前各自轮询、
  // 未进统一内核的流。补齐后 SensorStream 覆盖 Muse 的「跨源汇聚」全集。
  | "mail"
  | "shopping"
  | "location"
  /**
   * 共享发现流（2026-10-19）：跨层「发现」的统一落点。
   *
   * 病根是每条会开口的链路各存各的（传感原料 / 目标板 / 会话拆步），彼此无共同
   * 键 —— 邮件说"提到搬家"、GoalRunner 说"搬家卡在第 3 步等确认"，两句话谁都读
   * 不到对方，于是同一个目标被两层各说一遍。
   *
   * 修法不是新加一个存储，而是**复用已有的 SourceStore**：发现也作为信号进同一条
   * 总线，靠 `payload.subject`（共同键：目标=goalId，其余=actorId+主体词）把它绑到
   * 一起，白拿指纹去重、按天分区、实体倒排与保留期。
   */
  | "finding";

export type SignalSalience = "high" | "medium" | "low";

/** 传感层统一信号：一切下游（评估器/仲裁/LLM 观察流）只消费这个形状 */
export type Signal = {
  stream: SignalStream;
  /** 归属用户（多设备/家庭场景；缺省由评估器链 defaultActorId 兜底） */
  actorId?: string;
  /** 信号时刻 ms */
  at: number;
  /** 流内去重指纹（同一指纹在窗口期内不重复分发） */
  fingerprint: string;
  salience: SignalSalience;
  /** 状态变化的自然语言描述（零 LLM 模板拼接，评估器/观察流直接可读） */
  delta?: string;
  /** 结构化载荷（screen kind / nextEventMin / 发件人……由传感器定义） */
  payload?: Record<string, unknown>;
};

/**
 * 传感器接口。
 *  - pollIntervalMs > 0：内核按间隔轮询 collect()
 *  - pollIntervalMs = 0：纯推送型（feeder）——外部事件源经 kernel.emit() 推入，
 *    collect 不会被调用；注册 feeder 是为了健康面板与生命周期统一。
 */
export interface ProactiveSensor {
  id: string;
  stream: SignalStream;
  pollIntervalMs: number;
  /** 拉取自 since 以来的新信号（feeder 型返回 []） */
  collect(since: number): Promise<Signal[]> | Signal[];
}

/** 传感器健康状态（/api/proactivity/sensors 面板数据源） */
export type SensorHealth = {
  sensorId: string;
  stream: SignalStream;
  mode: "poll" | "feeder";
  pollIntervalMs: number;
  lastOkAt: number | null;
  lastFailAt: number | null;
  consecutiveFails: number;
  emitted: number;
  /** 连续失败 ≥3 熔断：暂停轮询 10 分钟后半开重试 */
  tripped: boolean;
  lastError?: string;
};

/** 屏幕专注分类（screen_sensor 产出；仲裁层打断成本的核心输入） */
export type ScreenFocusKind =
  | "coding"
  | "terminal"
  | "meeting"
  | "video"
  | "music"
  | "browsing"
  | "office"
  | "chat"
  | "game"
  | "idle"
  | "absent";
