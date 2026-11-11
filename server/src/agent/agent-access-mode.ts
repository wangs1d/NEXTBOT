import type { ChatCompletionTool } from "openai/resources/chat/completions";

import { BROWSER_SANDBOX_RESTRICTED_CHAT_TOOLS } from "../tools/browser-session-chat-tools.js";
import { DESKTOP_VISUAL_CHAT_TOOL_DEFINITIONS } from "../tools/desktop-visual-chat-tools.js";
import { PHONE_BRIDGE_CHAT_TOOL_DEFINITIONS } from "../tools/phone-bridge-chat-tools.js";

/**
 * 客户端 `chat.user_message.agentAccessMode`。
 *
 * 历史上曾区分 `sandbox` / `full` 两档权限：沙箱下屏蔽 desktop.visual.*、
 * phone.* 等高权限工具。现已废弃沙箱模式，
 * Agent 始终以最高权限运行；保留联合类型与 `parseAgentAccessMode` 仅用于
 * 兼容旧客户端仍会发送 `"sandbox"` 字段的线上协议。
 */
export type AgentAccessMode = "sandbox" | "full";

const FULL_ACCESS_MODE: AgentAccessMode = "full";

/** 用于 system prompt 幂等追加 */
export const AGENT_ACCESS_MODE_SYSTEM_MARKER = "【访问权限】";

/** Agent 始终以最高权限运行；此函数仅为协议兼容保留，恒返回 `full`。 */
export function parseAgentAccessMode(raw: unknown): AgentAccessMode {
  return FULL_ACCESS_MODE;
}

/** 沙箱模式已废弃，恒返回 false。 */
export function isSandboxMode(_mode: AgentAccessMode): boolean {
  return false;
}

export function isToolAllowedInAccessMode(
  _toolName: string,
  _mode: AgentAccessMode,
  ctx?: ChatToolsAccessContext,
): boolean {
  // 沙箱已废弃，所有工具默认放行；桥接在线性仅用于补发工具定义，不影响放行判定。
  return true;
}

/** 电脑桥接在线时可用的桌面工具（手机↔PC 通信路径）。 */
export const DESKTOP_BRIDGE_TOOL_NAMES = new Set<string>([
  "desktop.visual.screenshot",
  "desktop.visual.run_task",
]);

export type ChatToolsAccessContext = {
  /** 与手机相同 userId 的电脑桥接 WebSocket 是否在线 */
  desktopBridgeOnline?: boolean;
  /** 与当前 actorId 对应的手机桥接 WebSocket 是否在线 */
  phoneBridgeOnline?: boolean;
};

export function isDesktopBridgeToolName(toolName: string): boolean {
  return DESKTOP_BRIDGE_TOOL_NAMES.has(toolName);
}

/** 桥接在线时向模型补发的桌面工具定义。 */
export function getDesktopBridgeChatTools(): ChatCompletionTool[] {
  return [...DESKTOP_VISUAL_CHAT_TOOL_DEFINITIONS];
}

/** 手机桥接在线时可用的手机工具。 */
export const PHONE_BRIDGE_TOOL_NAMES = new Set<string>([
  "phone.battery",
  "phone.notifications",
  "phone.camera_capture",
  "phone.screen_record",
  "phone.locate",
  "phone.ring",
  "phone.sms_list",
  "phone.call_log",
  "phone.dial",
]);

export function isPhoneBridgeToolName(toolName: string): boolean {
  return PHONE_BRIDGE_TOOL_NAMES.has(toolName);
}

/** 桥接在线时向模型补发的手机工具定义。 */
export function getPhoneBridgeChatTools(): ChatCompletionTool[] {
  return [...PHONE_BRIDGE_CHAT_TOOL_DEFINITIONS];
}

/** 完全访问时应补发给模型的工具定义（含 desktop.visual.* 等高权限工具）。 */
export function getSandboxRestrictedChatTools(): ChatCompletionTool[] {
  return [
    ...DESKTOP_VISUAL_CHAT_TOOL_DEFINITIONS,
    ...BROWSER_SANDBOX_RESTRICTED_CHAT_TOOLS,
  ];
}

function chatToolRegistryName(tool: ChatCompletionTool): string | undefined {
  return tool.type === "function" ? tool.function?.name : undefined;
}

/** 工具调用被拒的提示文案。沙箱已废弃，仅剩桥接未在线的提示。 */
export function sandboxDeniedToolMessage(toolName: string): string {
  if (isDesktopBridgeToolName(toolName)) {
    return `无法调用「${toolName}」：电脑桥接未在线。请在本机运行 desktop-visual 桥接（userId 与手机一致），并保持连接。`;
  }
  if (isPhoneBridgeToolName(toolName)) {
    return `无法调用「${toolName}」：手机桥接未在线。请在手机端 App 保持登录并启用桥接连接。`;
  }
  return `无法调用「${toolName}」：对应桥接未在线或服务端能力未启用。`;
}

/**
 * 按访问模式过滤工具。沙箱已废弃，恒返回原始工具集（不再剔除任何工具）。
 */
export function filterChatToolsForAccessMode(
  tools: ChatCompletionTool[],
  _mode: AgentAccessMode,
  _ctx?: ChatToolsAccessContext,
): ChatCompletionTool[] {
  return tools;
}

/**
 * 按访问模式生成最终下发给模型的 tools。
 *
 * 沙箱已废弃，Agent 始终为完全访问：补全全部高权限工具定义。
 * 桥接在线时同样会补发对应工具，但与访问模式无关。
 */
export function mergeChatToolsForAccessMode(
  tools: ChatCompletionTool[],
  _mode: AgentAccessMode,
  _ctx?: ChatToolsAccessContext,
): ChatCompletionTool[] {
  const base = tools;
  const present = new Set(
    base.map((tool) => chatToolRegistryName(tool)).filter((name): name is string => Boolean(name)),
  );
  const pool = getSandboxRestrictedChatTools();
  const extras = pool.filter((tool) => {
    const name = chatToolRegistryName(tool);
    return Boolean(name && !present.has(name));
  });
  return extras.length > 0 ? [...base, ...extras] : base;
}

/** 注入 system / 子 Agent prompt：让模型知晓当前轮次的访问权限与桥接状态。 */
export function buildAgentAccessModeSystemSuffix(
  _mode: AgentAccessMode,
  ctx?: ChatToolsAccessContext,
): string {
  if (ctx?.desktopBridgeOnline && ctx?.phoneBridgeOnline) {
    return `

${AGENT_ACCESS_MODE_SYSTEM_MARKER} · 完全访问 + 电脑桥接 + 手机桥接（均在线）
Agent 已开启完全访问，可调用 desktop.visual.screenshot / desktop.visual.run_task、远程控制真实手机（phone.*）等高权限工具。
电脑桥接与手机桥接均已在线，涉及用户手机的操作（查电量、定位、响铃、同步短信/通话记录等）请优先调用 phone.* 工具。
远程拨打电话（phone，action=call）属敏感操作：拨打前必须在对话中向用户确认被叫号码与意图，未经确认不得调用。
执行转账、真实消费、桌面自动化、远程拍照等敏感操作前仍须征得用户明确同意。`;
  }

  if (ctx?.desktopBridgeOnline) {
    return `

${AGENT_ACCESS_MODE_SYSTEM_MARKER} · 完全访问 + 电脑桥接（在线）
可调用桌面操控等高权限工具。
电脑桥接已在线（与手机同 userId）。
执行转账、真实消费等敏感操作前须征得用户明确同意。`;
  }

  if (ctx?.phoneBridgeOnline) {
    return `

${AGENT_ACCESS_MODE_SYSTEM_MARKER} · 完全访问 + 手机桥接（在线）
Agent 已开启完全访问，可调用 desktop.visual.*、phone.* 等高权限工具。
用户真实手机已连接，涉及用户手机的操作请优先调用 phone.* 工具（电量、通知、定位、响铃、短信、通话记录等）。
远程拨打电话（phone，action=call）属敏感操作：拨打前必须在对话中向用户确认被叫号码与意图，未经确认不得调用。
执行转账、真实消费、远程拍照等敏感操作前仍须征得用户明确同意。`;
  }

  return `

${AGENT_ACCESS_MODE_SYSTEM_MARKER} · 完全访问（已开启）
可调用桌面操控、远程控制真实手机（phone.*）等高权限工具。
执行转账、真实消费等敏感操作前仍须征得用户明确同意。`;
}

/** 子 Agent / 能力查询用的简短一行说明 */
export function buildAgentAccessModePromptLine(
  _mode: AgentAccessMode,
  ctx?: ChatToolsAccessContext,
): string {
  if (ctx?.desktopBridgeOnline && ctx?.phoneBridgeOnline) {
    return "【本轮权限】完全访问 + 电脑桥接 + 手机桥接在线：desktop.visual.* 与 phone.* 均可用。";
  }
  if (ctx?.desktopBridgeOnline) {
    return "【本轮权限】完全访问 + 电脑桥接在线：desktop.visual.screenshot / run_task 可用；截屏请调用 screenshot。";
  }
  if (ctx?.phoneBridgeOnline) {
    return "【本轮权限】完全访问 + 手机桥接在线：phone.* 远程控制真实手机可用。";
  }
  return "【本轮权限】完全访问：高权限工具已开放，敏感操作仍须用户同意。";
}

export function appendAgentAccessModeSystemSuffix(
  systemContent: string,
  mode: AgentAccessMode,
  ctx?: ChatToolsAccessContext,
): string {
  if (systemContent.includes(AGENT_ACCESS_MODE_SYSTEM_MARKER)) return systemContent;
  return systemContent + buildAgentAccessModeSystemSuffix(mode, ctx);
}
