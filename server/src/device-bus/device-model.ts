/**
 * 终端互连平台 —— 设备模型
 *
 * 统一抽象手机 / 桌面 / 家居 / 摄像头 / 智能眼镜 / 平板 / 手表 / 后续扩展设备。
 * 一台设备 = (deviceId, kind, capabilities[], connection)。Agent 通过 capabilities
 * 看到所有可调用的感官 / 执行器，不关心具体厂商协议。
 *
 * 设计原则：
 *  - 能力驱动（capability-first）：设备的可调用面用统一 vocab 描述，而非按厂商枚举
 *  - 连接无关（connection-agnostic）：WS / HTTP / 本地服务都可被包成 DeviceConnection
 *  - 可扩展（open for extension）：DeviceKind / CapabilityId 都是 string union + 兜底 string
 */

/** 设备大类。新增设备类型直接追加到 union，避免引入枚举迁移成本。 */
export type DeviceKind =
  | "phone" // 手机（含桥接的真机）
  | "tablet" // 平板（复用 phone 协议）
  | "watch" // 手表 / 可穿戴
  | "desktop" // 桌面 / 笔记本
  | "home" // 智能家居网关（HomeAssistant 等）
  | "camera" // 网络摄像头 / IP Cam
  | "glasses" // 智能眼镜
  | "vehicle" // 车机
  | "speaker" // 智能音箱
  | "generic"; // 兜底：自定义设备

/**
 * 能力 vocab —— 设备能被 Agent 调用的「感官 / 执行器 / 媒体通道」。
 * 用点分命名空间，便于按前缀检索（如 sensor.* / actuator.* / media.*）。
 * 留 string 兜底，方便适配器声明私有能力而不强制改本类型。
 */
export type CapabilityId =
  // 感官输入
  | "camera" // 拍照 / 视频流
  | "microphone" // 录音
  | "screen_capture" // 屏幕截图 / 屏幕流
  | "input" // 键鼠 / 触控输入
  // 输出
  | "speaker" // 播放音频
  | "screen" // 显示画面 / UI
  | "haptic" // 震动 / 触觉反馈
  | "notification" // 系统通知
  // 传感器
  | "sensor.location"
  | "sensor.battery"
  | "sensor.temperature"
  | "sensor.humidity"
  | "sensor.motion"
  | "sensor.presence"
  // 执行器（家居为主）
  | "actuator.light"
  | "actuator.switch"
  | "actuator.climate"
  | "actuator.cover"
  | "actuator.lock"
  // 媒体流转
  | "media.display" // 把画面投到该设备
  | "media.audio" // 把音频投到该设备
  | "media.video" // 该设备能输出视频流
  // Agent 具身
  | "agent.speak" // 该设备可作为 Agent 语音出口
  | "agent.listen" // 该设备可作为 Agent 语音入口
  | "agent.see" // 该设备可作为 Agent 视觉入口
  | "agent.embodiment" // 该设备承载 Agent 3D 形象
  | string; // 兜底扩展

/** 设备当前状态。online 才可被 Agent 调用。 */
export type DeviceStatus = "online" | "offline" | "busy" | "error";

/**
 * 能力声明 —— 描述该设备具备的某项能力及其可调用面。
 *  - actions：可被 device.invoke 调用的方法名（如 camera.take_photo / camera.start_stream）
 *  - streams：可被 device.stream.open 拉取的数据流名（如 video / audio / sensor.location）
 *  - properties：能力的静态属性（如 camera.resolution = "1080p"），用于 Agent 选型
 */
export interface CapabilityDeclaration {
  id: CapabilityId;
  actions?: string[];
  streams?: string[];
  properties?: Record<string, unknown>;
}

/**
 * 设备描述符 —— 注册到 DeviceRegistry 的设备身份与能力快照。
 *  - deviceId：全局唯一，由适配器在注册时确定（如 "phone:<userId>:<androidId>"）
 *  - ownerUserId：归属用户；同一用户可有多台设备并存
 *  - connectionKind：该设备通过什么通道与 server 通信（WS / HTTP / 本地服务）
 */
export interface DeviceDescriptor {
  deviceId: string;
  kind: DeviceKind;
  name: string;
  ownerUserId: string;
  capabilities: CapabilityDeclaration[];
  status: DeviceStatus;
  lastSeenAt: number;
  /** 设备通过什么通道接入 server；适配器据此决定 invoke 走哪条链路。 */
  connectionKind: DeviceConnectionKind;
  /** 适配器自由元数据（型号 / 系统 / 电量 / 厂商等），不参与路由判定。 */
  metadata?: Record<string, unknown>;
}

/** 设备接入通道。决定适配器如何下发 invoke 与接收事件。 */
export type DeviceConnectionKind =
  | "websocket" // 长连接设备（phone / desktop / glasses / tablet / watch 桥接）
  | "http" // HTTP 拉式设备（如 ONVIF 摄像头）
  | "local_service" // server 进程内本地服务（如 smart-home-service 直接调 HA）
  | "mqtt" // MQTT 客户端（后续扩展）
  | "unknown";

/** 设备调用结果。ok=false 时 error.code 用于路由到 UI 提示。 */
export interface DeviceInvokeResult {
  ok: boolean;
  /** 设备返回的结构化数据；适配器负责把厂商协议归一成 JSON。 */
  data?: unknown;
  error?: {
    code: string;
    message: string;
  };
  /** 本次调用耗时（ms），用于审计与质量分。 */
  elapsedMs?: number;
}

/** 设备流式数据块（媒体 / 大块传感器数据）。 */
export interface DeviceStreamChunk {
  /** 流会话 id，由 openStream 返回。 */
  streamId: string;
  /** 块类型：二进制 base64 / 文本 / JSON / 结束标记。 */
  kind: "binary" | "text" | "json" | "end" | "error";
  data?: string | Record<string, unknown>;
  error?: { code: string; message: string };
}
