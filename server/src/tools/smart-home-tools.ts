import type { ChatCompletionTool } from "openai/resources/chat/completions";
import type { SmartHomeService } from "../services/smart-home-service.js";
import type { ToolRegistry } from "./tool-registry.js";

/**
 * 2026-11-11 复合：smart_home.list_devices / control_device / scene 三个名字
 * 收敛为单入口 `smart_home`，用 `action` 分流（list_devices/control_device/scene）。
 * 原 control_device 的 `action`（设备操作）改名为 `operation`，原 scene 的 `action`
 * 改名为 `scene_action`，避免与顶层的分流字段 `action` 冲突。
 */
export const SMART_HOME_CHAT_TOOLS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "smart_home",
      description:
        "HomeAssistant 智能家居统一入口（用 action 分流）。\n" +
        "action=list_devices：列出所有智能设备及其当前状态。用户问「有哪些设备」「家里设备状态」时调用。\n" +
        "action=control_device：控制设备。支持开关灯、调亮度/色温、开关插座、设置空调温度/模式、开关窗帘/卷帘等。用户说「开灯」「关空调」「窗帘打开」「灯调暗」「温度调到26」时调用。\n" +
        "action=scene：场景控制。用户说「回家模式」「离家模式」「晚安」等预设场景时调用。",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["list_devices", "control_device", "scene"],
            description: "要执行的智能家居动作。",
          },
          // action=control_device
          entity_id: {
            type: "string",
            description: "action=control_device：设备 entity_id，如 light.keting、switch.shui_hu、climate.woshi、cover.chuang_lian。从 list_devices 结果中选取。",
          },
          operation: {
            type: "string",
            enum: ["turn_on", "turn_off", "toggle", "set_brightness", "set_temperature", "set_mode", "set_position", "open_cover", "close_cover"],
            description: "action=control_device：操作类型：turn_on=开、turn_off=关、toggle=切换、set_brightness=亮度、set_temperature=温度、set_mode=模式、set_position=位置百分比、open_cover=开窗帘、close_cover=关窗帘",
          },
          value: {
            type: "number",
            description: "action=control_device：操作数值。亮度0-255、温度(°C)、位置0-100(0=关/100=全开)。仅 set_brightness/set_temperature/set_position 需要。",
          },
          mode: {
            type: "string",
            description: "action=control_device：模式名称，如 hvac_mode(cool/heat/auto/off)、fan_mode。仅 set_mode 需要。",
          },
          // action=scene
          scene_action: {
            type: "string",
            enum: ["list", "activate"],
            description: "action=scene：list=列出所有场景, activate=激活指定场景",
          },
          scene_name: {
            type: "string",
            description: "action=scene：场景名称或 entity_id（如 scene.wan_an），仅 scene_action=activate 时必填。",
          },
        },
        required: ["action"],
        additionalProperties: false,
      },
    },
  },
];

export function registerSmartHomeTools(
  registry: ToolRegistry,
  smartHome: SmartHomeService,
): void {
  const handleListDevices = async () => {
    try {
      const states = await smartHome.getAllStates();
      const list = smartHome.formatDeviceList(states);
      return {
        ok: true,
        deviceCount: states.length,
        devices: list,
        rawStates: states.map((s) => ({
          entity_id: s.entity_id,
          state: s.state,
          friendly_name: s.attributes.friendly_name ?? null,
        })),
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, error: msg };
    }
  };

  const handleControlDevice = async (input: Record<string, unknown>) => {
    try {
      const entityId = String(input.entity_id ?? "").trim();
      const action = String(input.operation ?? "").trim();
      if (!entityId) return { ok: false, error: "entity_id 为必填项" };

      const domain = entityId.split(".")[0];
      const rawVal = input.value != null ? Number(input.value) : NaN;
      const mode = input.mode != null ? String(input.mode).trim() : undefined;

      switch (action) {
        case "turn_on": {
          const data: Record<string, unknown> = { entity_id: entityId };
          if (domain === "light" && !Number.isNaN(rawVal)) {
            data.brightness = Math.round(rawVal);
          }
          await smartHome.callService(domain, "turn_on", data);
          return { ok: true, action: "turn_on", entity_id: entityId, message: `${entityId} 已开启` };
        }
        case "turn_off":
          await smartHome.callService(domain, "turn_off", { entity_id: entityId });
          return { ok: true, action: "turn_off", entity_id: entityId, message: `${entityId} 已关闭` };
        case "toggle":
          await smartHome.callService(domain, "toggle", { entity_id: entityId });
          return { ok: true, action: "toggle", entity_id: entityId, message: `${entityId} 已切换` };
        case "set_brightness": {
          if (Number.isNaN(rawVal)) return { ok: false, error: "set_brightness 需要 value 参数（0-255）" };
          const brightness = Math.round(Math.max(0, Math.min(255, rawVal)));
          await smartHome.callService("light", "turn_on", { entity_id: entityId, brightness });
          return { ok: true, action: "set_brightness", entity_id: entityId, brightness, message: `${entityId} 亮度已调至 ${brightness}` };
        }
        case "set_temperature": {
          if (Number.isNaN(rawVal)) return { ok: false, error: "set_temperature 需要 value 参数（°C）" };
          await smartHome.callService("climate", "set_temperature", {
            entity_id: entityId,
            temperature: rawVal,
          });
          return { ok: true, action: "set_temperature", entity_id: entityId, temperature: rawVal, message: `${entityId} 温度已设置为 ${rawVal}°C` };
        }
        case "set_mode": {
          if (!mode) return { ok: false, error: "set_mode 需要 mode 参数（cool/heat/auto/off 等）" };
          await smartHome.callService("climate", "set_hvac_mode", { entity_id: entityId, hvac_mode: mode });
          return { ok: true, action: "set_mode", entity_id: entityId, mode, message: `${entityId} 模式已切换到 ${mode}` };
        }
        case "set_position": {
          if (Number.isNaN(rawVal)) return { ok: false, error: "set_position 需要 value 参数（0-100）" };
          const position = Math.round(Math.max(0, Math.min(100, rawVal)));
          await smartHome.callService("cover", "set_cover_position", { entity_id: entityId, position });
          return { ok: true, action: "set_position", entity_id: entityId, position, message: `${entityId} 位置已设至 ${position}%` };
        }
        case "open_cover":
          await smartHome.callService("cover", "open_cover", { entity_id: entityId });
          return { ok: true, action: "open_cover", entity_id: entityId, message: `${entityId} 已打开` };
        case "close_cover":
          await smartHome.callService("cover", "close_cover", { entity_id: entityId });
          return { ok: true, action: "close_cover", entity_id: entityId, message: `${entityId} 已关闭` };
        default:
          return { ok: false, error: `不支持的操作: ${action}` };
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, error: msg };
    }
  };

  const handleScene = async (input: Record<string, unknown>) => {
    try {
      const action = String(input.scene_action ?? "list").trim();
      if (action === "list") {
        const states = await smartHome.getAllStates();
        const scenes = states.filter((s) => s.entity_id.startsWith("scene."));
        const list = scenes
          .map((s) => {
            const name = (s.attributes.friendly_name as string) ?? s.entity_id;
            return `- ${name} (${s.entity_id})`;
          })
          .join("\n");
        return {
          ok: true,
          sceneCount: scenes.length,
          scenes: list || "（无场景）",
          rawScenes: scenes.map((s) => ({ entity_id: s.entity_id, friendly_name: s.attributes.friendly_name ?? null })),
        };
      }
      if (action === "activate") {
        const sceneName = String(input.scene_name ?? "").trim();
        if (!sceneName) return { ok: false, error: "activate 操作需要 scene_name 参数" };
        await smartHome.callService("scene", "turn_on", { entity_id: sceneName });
        return { ok: true, action: "activate", scene: sceneName, message: `场景「${sceneName}」已激活` };
      }
      return { ok: false, error: `不支持的 scene action: ${action}` };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, error: msg };
    }
  };

  // 2026-11-11 复合：单一入口 `smart_home`，按 action 分流。
  registry.register("smart_home", async (input) => {
    const action = String(input.action ?? "").trim();
    switch (action) {
      case "list_devices":
        return handleListDevices();
      case "control_device":
        return handleControlDevice(input);
      case "scene":
        return handleScene(input);
      default:
        return { ok: false, error: `未知 action「${action || "(空)"}」，可选值：list_devices、control_device、scene` };
    }
  });
}
