import type { ClientLocationWire } from "../types/client-location.js";

/**
 * runtime → 外壳方向的反向推送端口。
 *
 * 分层约束：Agent runtime 一侧不允许直接持有客户端 socket
 * （`WsConnectionRegistry` 属于 gateway 的传输层）。所有「Agent 命令客户端」
 * 的流量（具身补丁、媒体控制、语音播报、虚拟电话、surface.dismiss 等）
 * 必须经本端口发出。同进程模式下由 gateway 直接注入 registry
 * （结构兼容）；拆进程后由 gateway 侧 WS 链路适配器实现同一接口。
 */
export type ClientPushPort = {
  /**
   * 向该 actor 的全部在线设备投递一条 JSON 文本帧（`{type, payload}` 信封），
   * 任一设备送达即返回 true；无在线连接或全部失败返回 false。
   */
  trySend(actorId: string, data: string): boolean;
  /** 该 actor 是否有任一在线客户端连接 */
  isOnline(actorId: string): boolean;
};

/**
 * runtime → 客户端按需请求实时位置的端口（`agent.location_request` /
 * `client.location_report` 闭环）。gateway 侧负责向在线客户端发请求并等待
 * 带 jobId 的回传；无在线客户端或超时返回 null。
 */
export type ClientLocationPort = {
  requestLocation(actorId: string, reason?: string): Promise<ClientLocationWire | null>;
};
