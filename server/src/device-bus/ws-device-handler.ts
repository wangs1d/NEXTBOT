/**
 * WS 设备事件路由器
 *
 * 把 ws/connection.ts 收到的 device.* 事件路由到 DeviceRegistry / 对应适配器。
 * 设计目标：ws/connection.ts 只需在 message handler 顶部加一个 device.* 分支，
 * 其余逻辑都封装在这里。
 *
 * 职责：
 *  1. device.register  → 校验 token + 创建 DeviceConnection + DeviceRegistry.register
 *  2. device.invoke_result → 路由到对应 adapter.handleInvokeResult
 *  3. device.stream_data   → 路由到对应 adapter.handleStreamData
 *  4. device.event         → 路由到对应 adapter.handleDeviceEvent
 *  5. device.capabilities_update → 更新 descriptor + 广播
 *  6. device.unregister / socket close → DeviceRegistry.unregister + adapter.dispose
 *
 * 鉴权策略（复用现有 token，不引入新环境变量）：
 *  - kind=phone   → PhoneBridgeCoordinator.verifyRegisterToken
 *  - kind=glasses/tablet/watch → 复用 PHONE_BRIDGE_TOKEN（移动设备族）
 *  - kind=home    → 本地服务，不走 WS（在 bootstrap 直接注册）
 *  - kind=camera  → DEVICE_BUS_TOKEN（Phase 4 引入）
 *  - 无 token 模式（requiresRegisterToken()=false）允许任意注册
 */
import type { AuditService } from "../services/audit-service.js";
import type { PhoneBridgeCoordinator } from "../services/phone-bridge-coordinator.js";
import type { DevicePairingService } from "../services/device-pairing-service.js";
import { ClientEventType, ServerEventType } from "../protocol.js";
import type { DeviceRegistry } from "./device-registry.js";
import type { DeviceAdapter, DeviceConnection } from "./device-adapter.js";
import type {
  CapabilityDeclaration,
  DeviceDescriptor,
  DeviceKind,
} from "./device-model.js";
import type { WsRemoteAdapter } from "./adapters/ws-remote-adapter.js";

/**
 * WS socket 的最小接口约束。
 * 不直接依赖 ws 库的 WebSocket 类型，避免与 fastify websocket 插件的 socket 类型冲突。
 * fastify / ws / 自定义 socket 只要满足这三个方法即可复用本路由器。
 */
export interface DeviceSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  readyState?: number;
}

/** 远程设备 kind → 使用的 token 校验器。 */
type TokenVerifier = (token: string | undefined) => boolean;

export interface DeviceWsHandlerDeps {
  deviceRegistry: DeviceRegistry;
  auditService: AuditService;
  phoneBridgeCoordinator: PhoneBridgeCoordinator;
  /** 配对服务（可选）：用于校验 deviceId 是否已绑定到 register 时的 ownerUserId */
  devicePairingService?: DevicePairingService;
  log?: {
    info: (msg: string, ctx?: Record<string, unknown>) => void;
    warn: (msg: string, ctx?: Record<string, unknown>) => void;
  };
}

/** 每个 socket 上的设备绑定（socket 关闭时用于清理）。 */
interface SocketDeviceBinding {
  deviceId: string;
  ownerUserId: string;
  adapter?: DeviceAdapter; // WsRemoteAdapter 实例（用于直接 handle*）
}

/** socket → 该 socket 上注册的设备绑定。一个 socket 只承载一台设备（与 device.register 一一对应）。 */
const socketBindings = new WeakMap<DeviceSocket, SocketDeviceBinding>();

/** 把 socket 包装成 DeviceConnection。 */
function wrapConnection(socket: DeviceSocket): DeviceConnection {
  return {
    send: (event, payload) => {
      try {
        socket.send(JSON.stringify({ type: event, payload }));
        return true;
      } catch {
        return false;
      }
    },
    close: (code, reason) => {
      try {
        socket.close(code ?? 1000, reason ?? "device_bus");
      } catch {
        // ignore
      }
    },
    readyState: socket.readyState,
  };
}

/** 按 kind 解析 token 校验器；返回 null 表示该 kind 不需要 token（或本地服务）。 */
function resolveTokenVerifier(
  kind: DeviceKind,
  deps: DeviceWsHandlerDeps,
): TokenVerifier | null {
  const { phoneBridgeCoordinator } = deps;
  switch (kind) {
    case "phone":
    case "tablet":
    case "watch":
    case "glasses":
      // 移动设备族复用 PHONE_BRIDGE_TOKEN
      if (!phoneBridgeCoordinator.isBridgeFeatureEnabled()) return null;
      if (!phoneBridgeCoordinator.requiresRegisterToken()) return null;
      return (token) => phoneBridgeCoordinator.verifyRegisterToken(token ?? "");
    case "camera":
    case "vehicle":
    case "speaker":
    case "generic":
      // Phase 4 引入 DEVICE_BUS_TOKEN；当前先放行
      return null;
    case "home":
      // 本地服务不走 WS
      return null;
    default:
      return null;
  }
}

/** 判断事件是否属于 device.* 协议族。 */
export function isDeviceEvent(eventType: string): boolean {
  return eventType.startsWith("device.");
}

/**
 * 处理 device.* 事件。
 * 返回 true 表示已处理；false 表示不是 device.* 事件或处理失败需要上层兜底。
 */
export async function handleDeviceWsEvent(
  socket: DeviceSocket,
  event: { type: string; payload: Record<string, unknown> },
  deps: DeviceWsHandlerDeps,
): Promise<boolean> {
  if (!isDeviceEvent(event.type)) return false;

  switch (event.type) {
    case ClientEventType.DeviceRegister:
      await handleRegister(socket, event.payload, deps);
      return true;
    case ClientEventType.DeviceUnregister:
      await handleUnregister(socket, event.payload, deps);
      return true;
    case ClientEventType.DeviceHeartbeat:
      handleHeartbeat(socket, event.payload, deps);
      return true;
    case ClientEventType.DeviceInvokeResult:
      handleInvokeResult(socket, event.payload, deps);
      return true;
    case ClientEventType.DeviceStreamData:
      handleStreamData(socket, event.payload, deps);
      return true;
    case ClientEventType.DeviceEvent:
      handleDeviceEvent(socket, event.payload, deps);
      return true;
    case ClientEventType.DeviceCapabilitiesUpdate:
      handleCapabilitiesUpdate(socket, event.payload, deps);
      return true;
    default:
      // 未识别的 device.* 事件
      sendError(socket, "UNKNOWN_DEVICE_EVENT", `未知设备事件: ${event.type}`);
      return true;
  }
}

/** socket 关闭时清理设备绑定。ws/connection.ts 在 close 回调中调用。 */
export async function handleDeviceWsClose(socket: DeviceSocket, deps: DeviceWsHandlerDeps): Promise<void> {
  const binding = socketBindings.get(socket);
  if (!binding) return;
  socketBindings.delete(socket);
  await deps.deviceRegistry.unregister(binding.deviceId, "socket_closed");
  deps.log?.info("device offline (socket closed)", {
    deviceId: binding.deviceId,
    ownerUserId: binding.ownerUserId,
  });
}

// ---------- 各事件处理 ----------

async function handleRegister(
  socket: DeviceSocket,
  payload: Record<string, unknown>,
  deps: DeviceWsHandlerDeps,
): Promise<void> {
  const deviceId = String(payload.deviceId ?? "").trim();
  const kind = String(payload.kind ?? "").trim() as DeviceKind;
  const ownerUserId = String(payload.ownerUserId ?? "").trim();
  const name = String(payload.name ?? "").trim() || `${kind}:${deviceId}`;
  const token = payload.token == null ? undefined : String(payload.token).trim();
  const capabilitiesRaw = Array.isArray(payload.capabilities) ? payload.capabilities : [];
  const metadata = (payload.metadata && typeof payload.metadata === "object")
    ? payload.metadata as Record<string, unknown>
    : undefined;

  if (!deviceId || !kind || !ownerUserId) {
    sendError(socket, "BAD_DEVICE_REGISTER", "deviceId / kind / ownerUserId 必填");
    return;
  }

  // token 校验
  const verifier = resolveTokenVerifier(kind, deps);
  if (verifier && !verifier(token)) {
    sendError(
      socket,
      "DEVICE_TOKEN_REJECTED",
      `kind=${kind} 的 token 校验失败（请检查 PHONE_BRIDGE_TOKEN 配置）`,
    );
    return;
  }

  // 配对关系校验：若 deviceId 已绑定到某 owner，但 register 时的 ownerUserId 不一致 → 拒绝
  // （未配对过的设备放行，兼容首次注册 + 系统设备如 home:default）
  if (deps.devicePairingService) {
    const binding = deps.devicePairingService.getBinding(deviceId);
    if (binding && binding.ownerUserId !== ownerUserId) {
      sendError(
        socket,
        "DEVICE_OWNER_MISMATCH",
        `设备 ${deviceId} 已绑定到用户 ${binding.ownerUserId}，无法以 ${ownerUserId} 身份注册`,
      );
      return;
    }
  }

  const capabilities: CapabilityDeclaration[] = capabilitiesRaw
    .filter((c): c is Record<string, unknown> => Boolean(c) && typeof c === "object")
    .map((c) => ({
      id: String(c.id ?? ""),
      actions: Array.isArray(c.actions) ? c.actions.map(String) : undefined,
      streams: Array.isArray(c.streams) ? c.streams.map(String) : undefined,
      properties: c.properties && typeof c.properties === "object"
        ? c.properties as Record<string, unknown>
        : undefined,
    }))
    .filter((c) => c.id);

  const descriptor: DeviceDescriptor = {
    deviceId,
    kind,
    name,
    ownerUserId,
    capabilities,
    status: "online",
    lastSeenAt: Date.now(),
    connectionKind: "websocket",
    metadata,
  };

  const connection = wrapConnection(socket);

  try {
    const registered = await deps.deviceRegistry.register(descriptor, connection);
    // 取出 adapter 用于后续 handle* 路由
    const adapter = deps.deviceRegistry.getAdapter(registered.deviceId);
    socketBindings.set(socket, {
      deviceId: registered.deviceId,
      ownerUserId: registered.ownerUserId,
      adapter,
    });
    socket.send(JSON.stringify({
      type: ServerEventType.DeviceRegisterAck,
      payload: {
        ok: true,
        deviceId: registered.deviceId,
        kind: registered.kind,
        capabilities: registered.capabilities,
      },
    }));
    await deps.auditService.record({
      type: ClientEventType.DeviceRegister,
      sessionId: ownerUserId,
      deviceId,
      kind,
    });
    deps.log?.info("device online", { deviceId, kind, ownerUserId });
  } catch (err) {
    sendError(
      socket,
      "DEVICE_REGISTER_FAILED",
      err instanceof Error ? err.message : String(err),
    );
  }
}

async function handleUnregister(
  socket: DeviceSocket,
  payload: Record<string, unknown>,
  deps: DeviceWsHandlerDeps,
): Promise<void> {
  const binding = socketBindings.get(socket);
  if (!binding) return;
  const deviceId = String(payload.deviceId ?? binding.deviceId);
  socketBindings.delete(socket);
  await deps.deviceRegistry.unregister(deviceId, "client_unregister");
}

function handleHeartbeat(
  socket: DeviceSocket,
  payload: Record<string, unknown>,
  deps: DeviceWsHandlerDeps,
): void {
  const binding = socketBindings.get(socket);
  if (!binding) return;
  deps.deviceRegistry.heartbeat(binding.deviceId);
}

function handleInvokeResult(
  socket: DeviceSocket,
  payload: Record<string, unknown>,
  deps: DeviceWsHandlerDeps,
): void {
  const binding = socketBindings.get(socket);
  if (!binding) return;
  const jobId = String(payload.jobId ?? "").trim();
  if (!jobId) return;
  const adapter = binding.adapter as WsRemoteAdapter | undefined;
  adapter?.handleInvokeResult(jobId, {
    ok: payload.ok !== false,
    data: payload.data,
    error: payload.error as { code: string; message: string } | undefined,
    elapsedMs: typeof payload.elapsedMs === "number" ? payload.elapsedMs : undefined,
  });
}

function handleStreamData(
  socket: DeviceSocket,
  payload: Record<string, unknown>,
  deps: DeviceWsHandlerDeps,
): void {
  const binding = socketBindings.get(socket);
  if (!binding) return;
  const streamId = String(payload.streamId ?? "").trim();
  if (!streamId) return;
  const adapter = binding.adapter as WsRemoteAdapter | undefined;
  const kind = String(payload.kind ?? "binary") as "binary" | "text" | "json" | "end" | "error";
  adapter?.handleStreamData(streamId, {
    streamId,
    kind,
    data: payload.data as string | Record<string, unknown> | undefined,
    error: payload.error as { code: string; message: string } | undefined,
  });
}

function handleDeviceEvent(
  socket: DeviceSocket,
  payload: Record<string, unknown>,
  deps: DeviceWsHandlerDeps,
): void {
  const binding = socketBindings.get(socket);
  if (!binding) return;
  const adapter = binding.adapter as WsRemoteAdapter | undefined;
  const type = String(payload.type ?? "").trim();
  if (!type) return;
  adapter?.handleDeviceEvent({
    type,
    payload: (payload.payload && typeof payload.payload === "object")
      ? payload.payload as Record<string, unknown>
      : {},
  });
}

function handleCapabilitiesUpdate(
  socket: DeviceSocket,
  payload: Record<string, unknown>,
  deps: DeviceWsHandlerDeps,
): void {
  // Phase 2 已实现 DeviceRegistry，但未暴露 updateCapabilities API。
  // 这里先简单记日志，Phase 5 完善。
  const binding = socketBindings.get(socket);
  if (!binding) return;
  deps.log?.info("device capabilities update (TODO)", {
    deviceId: binding.deviceId,
  });
}

// ---------- 工具 ----------

function sendError(socket: DeviceSocket, code: string, message: string): void {
  try {
    socket.send(JSON.stringify({
      type: ServerEventType.ErrorEvent,
      payload: { code, message },
    }));
  } catch {
    // ignore
  }
}
