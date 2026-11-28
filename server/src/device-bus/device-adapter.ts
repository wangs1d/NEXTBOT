/**
 * 设备适配器接口 —— 把不同厂商 / 协议的终端包装成统一的调用面。
 *
 * 适配器职责：
 *  1. 在设备注册时把厂商能力翻译成 CapabilityDeclaration[]
 *  2. 把 device.invoke(action, params) 路由到具体协议（WS 消息 / HTTP / 本地服务调用）
 *  3. 把厂商事件流（如 RTSP 视频帧）翻译成 DeviceStreamChunk
 *  4. 设备下线时释放资源（取消订阅、关闭流、归还定时器）
 *
 * 适配器不负责鉴权（DeviceRegistry 在 register 前已校验 ownerUserId / token），
 * 也不负责广播上下线（DeviceRegistry 触发 hook，由 ws 层订阅推送）。
 */
import type {
  CapabilityDeclaration,
  DeviceDescriptor,
  DeviceInvokeResult,
  DeviceKind,
  DeviceStreamChunk,
} from "./device-model.js";

/** 适配器构造参数。descriptor 由 DeviceRegistry 在 register 时传入。 */
export interface DeviceAdapterInit {
  descriptor: DeviceDescriptor;
  /** 远程设备的连接句柄；本地服务适配器可为 undefined。 */
  connection?: DeviceConnection;
}

/**
 * 设备适配器 —— 一个实例对应一台已注册设备。
 *
 * 实现可以是：
 *  - WS 远程适配器（phone/desktop/glasses）：通过 connection.send 下发 invoke，监听 result
 *  - HTTP 适配器（camera/ONVIF）：每次 invoke 走 HTTP 请求
 */
export interface DeviceAdapter {
  /** 适配器实例对应的 deviceId（与 descriptor.deviceId 一致）。 */
  readonly deviceId: string;
  /** 该适配器服务的设备大类。 */
  readonly kind: DeviceKind;

  /**
   * 初始化适配器：绑定连接、订阅事件、拉取初始能力清单。
   * 失败应抛错，DeviceRegistry 会回滚注册。
   */
  initialize(init: DeviceAdapterInit): Promise<void> | void;

  /**
   * 调用设备的某个 action。
   *  - action 形如 "camera.take_photo" / "actuator.light.turn_on"
   *  - 适配器负责把 action 翻译成具体协议消息
   *  - 超时由适配器内部约定（建议 30s），超时返回 ok=false + TIMEOUT
   */
  invoke(action: string, params: Record<string, unknown>): Promise<DeviceInvokeResult>;

  /**
   * 打开一条数据流（视频 / 音频 / 传感器流）。
   *  - streamId 由调用方传入，适配器需保证在该流关闭前唯一
   *  - 适配器返回 AsyncIterable，DeviceRegistry 转发给调用方
   *  - 不支持流的设备返回空 iterable + end chunk
   */
  openStream(
    streamId: string,
    params: Record<string, unknown>,
  ): AsyncIterable<DeviceStreamChunk>;

  /**
   * 设备主动上报事件（如电量变化、按钮按下、移动侦测）。
   * 适配器实现 event 钩子；DeviceRegistry 会转发给订阅者。
   * 不支持事件上报的设备返回 undefined 即可。
   */
  events?: AsyncIterable<{ type: string; payload: Record<string, unknown> }>;

  /** 释放资源：取消订阅、关闭流、清理定时器。DeviceRegistry 在 unregister 时调用。 */
  dispose(): Promise<void> | void;
}

/**
 * 设备连接句柄 —— 适配器与远程设备通信的抽象。
 * WS 适配器包一层 socket；HTTP 适配器可不实现 send，只用 fetch。
 */
export interface DeviceConnection {
  /** 向设备下发一条事件。返回 false 表示连接已断开。 */
  send(event: string, payload: Record<string, unknown>): boolean;
  /** 关闭连接（可选）。 */
  close?(code?: number, reason?: string): void;
  /** 当前 readyState；1 = OPEN。undefined 视为始终 open（本地服务）。 */
  readyState?: number;
}

/**
 * 适配器工厂 —— 每种设备大类对应一个工厂，注册到 AdapterRegistry。
 * 工厂接收 descriptor + connection，返回适配器实例。
 * 这样做是为了让 DeviceRegistry 不硬编码各适配器的构造逻辑。
 */
export type DeviceAdapterFactory = (init: DeviceAdapterInit) => DeviceAdapter;

/** 适配器静态能力声明 —— 工厂在 register 时声明该类设备默认具备的能力。 */
export interface AdapterStaticInfo {
  kind: DeviceKind;
  /** 默认能力清单；descriptor.capabilities 会与默认值取并集。 */
  defaultCapabilities: CapabilityDeclaration[];
  /** 是否要求 connection（远程设备 = true，本地服务 = false）。 */
  requiresConnection: boolean;
}
