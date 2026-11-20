/**
 * MCP 工具注册 —— 将 MCP 工具注册到 ToolRegistry
 *
 * 遵循项目 registerXxxTools 模式：
 *   export function registerMcpTools(toolRegistry, mcpClientService)
 */

import type { McpClientService, McpToolSchema } from "../services/mcp-client-service.js";
import type { ToolRegistry } from "./tool-registry.js";

/**
 * 将 MCP 工具注册到 ToolRegistry
 * 每个已发现的 MCP 工具注册为 mcp.<alias>.<tool_name>
 */
export function registerMcpTools(
  toolRegistry: ToolRegistry,
  mcpClientService: McpClientService,
): void {
  const tools = mcpClientService.listTools();

  for (const tool of tools) {
    toolRegistry.register(tool.name, async (input) => {
      const result = await mcpClientService.executeByRegistryName(tool.name, input);
      if (!result.ok) {
        return { error: result.result.error };
      }
      return result.result;
    });
  }
}

/**
 * 从已发现的 MCP 工具动态生成 ChatCompletionTool 定义
 * 遵循项目 ChatCompletionTool[] 模式
 *
 * 过滤（2026-11-20 根修）：滴滴 server（alias=didi）的工具**不暴露给 LLM**。
 * 滴滴能力已有统一抽象层 ride_hailing.*（报价推选点卡 / 两阶段确认下单 /
 * 状态追踪），若裸 mcp.didi.taxi_estimate / maps_textsearch 也可见，模型会
 * 绕过抽象层直调——起点没着落时就不会触发 ride_pickup 选点卡，退化成
 * 文字追问。handler 注册保留（registerMcpTools 不动），只是不再给模型看。
 */
export function buildMcpChatTools(mcpClientService: McpClientService): import("openai/resources/chat/completions").ChatCompletionTool[] {
  const tools = mcpClientService.listTools();
  return tools
    .filter((schema) => schema.serverAlias !== "didi")
    .map(mcpToolToChatTool);
}

/** 将单个 McpToolSchema 转换为 OpenAI ChatCompletionTool */
export function mcpToolToChatTool(schema: McpToolSchema): import("openai/resources/chat/completions").ChatCompletionTool {
  return {
    type: "function",
    function: {
      name: schema.name,
      description: schema.description,
      parameters: schema.parameters as {
        type: "object";
        properties?: Record<string, unknown>;
        required?: string[];
        additionalProperties?: boolean;
      },
    },
  };
}
