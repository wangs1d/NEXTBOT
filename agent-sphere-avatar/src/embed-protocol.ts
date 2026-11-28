/**
 * Agent Sphere 宿主协议 — 单一事实来源
 *
 * 桌宠 overlay 页面与宿主环境之间传递具身指令：
 * - 同页 CustomEvent（bridge/agent-bridge.ts）
 * - postMessage（宿主父级转发，useEmbodimentCommandRelay）
 * - PAI 服务端 WS 直推（agent.embodiment.command）
 *
 * 旧 iframe 网页嵌入（embed）协议已随 Embed 模式移除。
 */
import type {
  AgentMood,
  EmbodimentCommand,
  EmbodimentCommandAction,
} from "./types/agent";

/** postMessage / CustomEvent 命名空间前缀 */
export const SPHERE_NS = "agent-sphere" as const;

/** 兼容 PAI 服务端直推 */
export const PAI_EMBODIMENT_COMMAND = "agent.embodiment.command" as const;

/** 宿主 → 页面 */
export const SPHERE_HOST_MSG = {
  command: `${SPHERE_NS}:command`,
} as const;

/** 同页 CustomEvent（bridge/agent-bridge.ts 使用） */
export const SPHERE_DOM_EVENT = {
  mood: `${SPHERE_NS}:set-mood`,
  energy: `${SPHERE_NS}:set-energy`,
  caption: `${SPHERE_NS}:set-caption`,
  command: SPHERE_HOST_MSG.command,
} as const;

/** 宿主 → 页面 具身指令 */
export type SphereCommandMessage = EmbodimentCommand & {
  type: typeof SPHERE_HOST_MSG.command | typeof PAI_EMBODIMENT_COMMAND;
};

const COMMAND_ACTIONS: ReadonlySet<EmbodimentCommandAction> = new Set([
  "roam",
  "move",
  "stop",
  "window_roam",
  "window_place",
  "query_state",
  "excite",
]);

function isSphereCommandAction(
  action: unknown,
): action is EmbodimentCommandAction {
  return typeof action === "string" && COMMAND_ACTIONS.has(action as EmbodimentCommandAction);
}

/** 解析宿主 postMessage 为具身指令 */
export function parseHostCommand(data: unknown): EmbodimentCommand | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  if (
    d.type !== SPHERE_HOST_MSG.command &&
    d.type !== PAI_EMBODIMENT_COMMAND
  ) {
    return null;
  }
  if (!isSphereCommandAction(d.action)) return null;

  return {
    action: d.action,
    x: typeof d.x === "number" ? d.x : undefined,
    y: typeof d.y === "number" ? d.y : undefined,
    z: typeof d.z === "number" ? d.z : undefined,
    strength: typeof d.strength === "number" ? d.strength : undefined,
    mood: d.mood as AgentMood | undefined,
    energy: typeof d.energy === "number" ? d.energy : undefined,
    caption:
      d.caption === null
        ? null
        : d.caption
          ? String(d.caption)
          : undefined,
    source: d.source ? String(d.source) : undefined,
  };
}
