/**
 * Gateway 层统一出口：Agent 执行链的工具/技能/MCP 资源路由收口。
 *
 * 调用方约定：
 *   - import { agentGateway } from "../gateway/index.js"（或具体子模块）
 *   - 不直接 import tools/tool-search —— tool-search 是 gateway 的对接层实现细节
 */

export {
  prepareTools,
  executeBridge,
  searchResources,
  routeRender,
} from "./agent-gateway.js";

export {
  needsToolChoiceRequired,
  turnSuggestsToolNeed,
  resolveExplicitActionTool,
} from "./forced-tool.js";

export {
  recordGatewayTrace,
  listGatewayTraces,
  getGatewayTraceStats,
  type GatewayTracePhase,
  type GatewayTraceRecord,
} from "./gateway-trace.js";

// 常用下游工具的重导出（调用方无需感知 tool-search 内部路径）
export {
  CORE_TOOL_LIBRARY,
  classifyToolExposureTier,
  estimateToolsSchemaTokens,
  isCoreToolRegistryName,
  isToolSearchBridgeName,
  invalidateFullCatalogCache,
  type DeferredToolCatalog,
  type ResidentToolInfo,
  type ToolExposureTier,
  type ToolSearchBridgeResult,
  type ToolSearchPreparedTurn,
} from "../tools/tool-search/index.js";
