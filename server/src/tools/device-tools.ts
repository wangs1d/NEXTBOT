/**
 * 终端互连平台 —— LLM 工具暴露
 *
 * 把 DeviceRegistry 的能力暴露给 Agent / LLM：
 *  - device.list    列出当前用户的所有在线设备 + 能力清单
 *  - device.use     调用某设备的某 action（如 phone.camera.take_photo）
 *  - device.stream  打开某设备的某条流（如 camera.video 返回 RTSP URL）
 *
 * agent.migrate_to（Agent 跨设备迁移）涉及 Agent 状态序列化，留待后续阶段。
 *
 * 工具上下文：通过 ToolContext.sessionId / userId 解析 actorId，
 * 只能看到/调用 actorId 自己的设备（home:default 这种 ownerUserId=system 的全局设备所有人可见）。
 */
import type { ChatCompletionTool } from "openai/resources/chat/completions";
import type { DeviceRegistry } from "../device-bus/device-registry.js";
import type { DevicePairingService } from "../services/device-pairing-service.js";
import type { ToolRegistry } from "./tool-registry.js";
import { resolveActorId } from "../agent/actor-id.js";

export const DEVICE_CHAT_TOOLS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "device.list",
      description:
        "列出当前用户的所有在线终端设备及其能力清单。用户问「我有哪些设备」「设备状态」「能控制什么」时调用。" +
        "返回设备名、kind（phone/tablet/glasses/camera/home 等）、在线状态、能力清单（capabilities）。" +
        "home:default 是全局智能家居网关，所有用户共享。",
      parameters: {
        type: "object",
        properties: {
          only_online: {
            type: "boolean",
            description: "是否只返回在线设备，默认 true",
          },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "device.use",
      description:
        "调用某台设备的某个能力。如 device.use('phone:abc', 'camera.take_photo') 拍照、" +
        "device.use('home:default', 'actuator.light.turn_on', {entityId:'light.keting'}) 开灯、" +
        "device.use('camera:xyz', 'camera.take_photo') 拍照。" +
        "可用的 action 在 device.list 返回的 capabilities[].actions 里。",
      parameters: {
        type: "object",
        properties: {
          device_id: {
            type: "string",
            description: "设备 ID，从 device.list 结果中选取（如 phone:abc123 / home:default / camera:xyz）",
          },
          action: {
            type: "string",
            description: "要调用的 action，形如 'camera.take_photo' / 'actuator.light.turn_on' / 'screen_capture.screenshot'",
          },
          params: {
            type: "object",
            description: "action 的参数（如 {entityId:'light.keting'} / {brightness:128}）。无参数时省略。",
            additionalProperties: true,
          },
        },
        required: ["device_id", "action"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "device.stream",
      description:
        "打开某台设备的某条数据流（视频/音频/传感器）。当前实现只返回流 URL（如 RTSP），" +
        "由前端用播放器拉取；server 不解码媒体流。" +
        "如 device.stream('camera:front', 'video') 返回 rtsp://... URL。",
      parameters: {
        type: "object",
        properties: {
          device_id: {
            type: "string",
            description: "设备 ID",
          },
          stream_type: {
            type: "string",
            description: "流类型，如 'video' / 'audio' / 'snapshot' / 'screen'。从 device.list 的 capabilities[].streams 中选取。",
          },
        },
        required: ["device_id", "stream_type"],
        additionalProperties: false,
      },
    },
  },
];

export function registerDeviceTools(
  registry: ToolRegistry,
  deviceRegistry: DeviceRegistry,
  devicePairingService: DevicePairingService,
): void {
  // device.list：列出当前用户的设备
  registry.register("device.list", async (input, context) => {
    const actorId = resolveActorId(context);
    const onlyOnline = input.only_online !== false; // 默认 true
    try {
      // 1. 已配对的设备（持久化记录）
      const bindings = devicePairingService.listDevices(actorId);
      // 2. DeviceRegistry 中的实时状态
      const onlineDescriptors = deviceRegistry.listByOwner(actorId);
      // 3. 全局共享设备（ownerUserId=system，如 home:default）
      const systemDevices = deviceRegistry.listByOwner("system");
      const onlineMap = new Map(
        [...onlineDescriptors, ...systemDevices].map((d) => [d.deviceId, d]),
      );

      const devices = bindings.map((b) => {
        const online = onlineMap.get(b.deviceId);
        return {
          deviceId: b.deviceId,
          kind: b.kind,
          name: b.name,
          boundAt: b.boundAt,
          metadata: b.metadata,
          online: online?.status === "online",
          status: online?.status ?? "offline",
          lastSeenAt: online?.lastSeenAt,
          capabilities: online?.capabilities ?? [],
        };
      });
      // 追加全局共享设备（home:default 等，未在 bindings 中但用户可见）
      for (const desc of systemDevices) {
        if (devices.some((d) => d.deviceId === desc.deviceId)) continue;
        devices.push({
          deviceId: desc.deviceId,
          kind: desc.kind,
          name: desc.name,
          boundAt: desc.lastSeenAt,
          metadata: desc.metadata,
          online: desc.status === "online",
          status: desc.status,
          lastSeenAt: desc.lastSeenAt,
          capabilities: desc.capabilities,
        });
      }
      const filtered = onlyOnline ? devices.filter((d) => d.online) : devices;
      return {
        ok: true,
        ownerUserId: actorId,
        deviceCount: filtered.length,
        devices: filtered,
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, error: msg };
    }
  });

  // device.use：调用设备的某 action
  registry.register("device.use", async (input, context) => {
    const actorId = resolveActorId(context);
    const deviceId = String(input.device_id ?? "").trim();
    const action = String(input.action ?? "").trim();
    if (!deviceId || !action) {
      return { ok: false, error: "device_id 和 action 必填" };
    }
    try {
      // 权限校验：设备必须属于当前用户，或是全局共享设备（owner=system）
      const desc = deviceRegistry.get(deviceId);
      if (!desc) {
        return { ok: false, error: `设备 ${deviceId} 未注册或离线` };
      }
      if (desc.ownerUserId !== actorId && desc.ownerUserId !== "system") {
        return { ok: false, error: `无权调用他人设备 ${deviceId}` };
      }
      const params = (input.params && typeof input.params === "object")
        ? input.params as Record<string, unknown>
        : {};
      const result = await deviceRegistry.invoke(deviceId, action, params);
      return {
        ok: result.ok,
        deviceId,
        action,
        data: result.data,
        error: result.error,
        elapsedMs: result.elapsedMs,
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, error: msg };
    }
  });

  // device.stream：打开设备的某条流（当前只返回流 URL，不消费 AsyncIterable）
  registry.register("device.stream", async (input, context) => {
    const actorId = resolveActorId(context);
    const deviceId = String(input.device_id ?? "").trim();
    const streamType = String(input.stream_type ?? "").trim();
    if (!deviceId || !streamType) {
      return { ok: false, error: "device_id 和 stream_type 必填" };
    }
    try {
      const desc = deviceRegistry.get(deviceId);
      if (!desc) {
        return { ok: false, error: `设备 ${deviceId} 未注册或离线` };
      }
      if (desc.ownerUserId !== actorId && desc.ownerUserId !== "system") {
        return { ok: false, error: `无权访问他人设备 ${deviceId} 的流` };
      }
      // 用 openStream 拿到第一条 chunk（通常是流 URL 或首帧）
      const opened = deviceRegistry.openStream(deviceId, { type: streamType, stream: streamType });
      if (!opened.ok || !opened.stream) {
        return { ok: false, error: opened.error?.message ?? "打开流失败" };
      }
      // 只取第一条有效 chunk（LLM 工具是同步语义，不能消费长流）
      let firstChunk: { kind: string; data?: unknown; error?: { code: string; message: string } } | null = null;
      for await (const chunk of opened.stream) {
        if (chunk.kind === "error") {
          firstChunk = { kind: chunk.kind, error: chunk.error };
          break;
        }
        if (chunk.kind === "end") break;
        firstChunk = { kind: chunk.kind, data: chunk.data };
        break; // 只取第一条
      }
      return {
        ok: true,
        deviceId,
        streamType,
        streamId: opened.streamId,
        firstChunk,
        note: "如需持续拉流，请用 streamId 通过 WS device.stream_data 事件消费",
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, error: msg };
    }
  });
}
