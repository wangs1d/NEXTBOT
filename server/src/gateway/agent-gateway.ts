/**
 * AgentGateway — 统一资源路由网关（唯一收口）。
 *
 * 所有工具/技能/MCP 资源的「准备、检索、桥接执行」都经由本模块发起，
 * 底层委托：
 *   - tool-search/：延迟目录（deferred catalog 构建 + 进程内 adaptive 检索 + 桥接执行）
 *   - gateway/forced-tool.ts：办事信号供给（只作出口对账授权，不再事前强制）
 *
 * 网关职责：
 *   1. prepareTools：core/deferred 工具切分 + tool_discover 桥注入（trace: tool_prepare）
 *   2. executeBridge：tool_discover / tool_call 桥接执行（trace: bridge_execute）
 *   3. searchResources：直接检索延迟目录（诊断/管理端，trace: resource_search）
 *
 * 2026-10-22：resolveForcedTool（事实型问题强制 tool_choice）已退役——请求层
 * 恒 auto，确定性全部后移到工具循环的出口对账闸（不预测，只验证）。
 *
 * 调用方一律 import gateway（不直接 import tool-search），保证路由行为可追踪、可治理。
 */

import type { ChatCompletionTool } from "openai/resources/chat/completions";

import {
  classifyRenderHint,
  type RenderHint,
  type RenderHintContext,
} from "../services/render-hint-service.js";
import {
  executeToolSearchBridge,
  prepareToolsWithToolSearch,
  type DeferredToolCatalog,
  type ResidentToolInfo,
  type ToolSearchBridgeResult,
  type ToolSearchPreparedTurn,
} from "../tools/tool-search/index.js";
import { adaptiveSearchDeferredTools, type AdaptiveDeferredToolSearchMatch } from "../tools/tool-search/adaptive-catalog.js";
import { recordGatewayTrace } from "./gateway-trace.js";

let _traceCounter = 0;

function nextTraceId(): string {
  _traceCounter += 1;
  return `gw-${Date.now().toString(36)}-${_traceCounter}`;
}

function traced<T>(
  phase: "tool_prepare" | "forced_tool" | "bridge_execute" | "resource_search",
  decision: string,
  reasons: string[],
  fn: () => T,
): T {
  const traceId = nextTraceId();
  const startedAt = Date.now();
  try {
    const result = fn();
    recordGatewayTrace({
      traceId,
      phase,
      decision,
      reasons,
      durationMs: Date.now() - startedAt,
      timestamp: startedAt,
    });
    return result;
  } catch (error) {
    recordGatewayTrace({
      traceId,
      phase,
      decision: `${decision} (failed)`,
      reasons: [...reasons, error instanceof Error ? error.message : String(error)],
      durationMs: Date.now() - startedAt,
      timestamp: startedAt,
    });
    throw error;
  }
}

async function tracedAsync<T>(
  phase: "tool_prepare" | "forced_tool" | "bridge_execute" | "resource_search",
  decision: string,
  reasons: string[],
  fn: () => Promise<T>,
): Promise<T> {
  const traceId = nextTraceId();
  const startedAt = Date.now();
  try {
    const result = await fn();
    recordGatewayTrace({
      traceId,
      phase,
      decision,
      reasons,
      durationMs: Date.now() - startedAt,
      timestamp: startedAt,
    });
    return result;
  } catch (error) {
    recordGatewayTrace({
      traceId,
      phase,
      decision: `${decision} (failed)`,
      reasons: [...reasons, error instanceof Error ? error.message : String(error)],
      durationMs: Date.now() - startedAt,
      timestamp: startedAt,
    });
    throw error;
  }
}

/**
 * 工具准备：core 工具直接暴露，其余进 deferred catalog（由 tool-router 召回），
 * 激活时注入 tool_discover / tool_call 桥接工具。
 *
 * 传入 userText 时执行意图预召回：top-1 高置信度延迟工具直接注入 visibleTools，
 * 省去 LLM 的 tool_discover 发现往返（对话面/任务面均受益）。
 */
export async function prepareTools(
  visibleCandidateTools: ChatCompletionTool[],
  searchableSourceTools: ChatCompletionTool[] = visibleCandidateTools,
): Promise<ToolSearchPreparedTurn> {
  const traceId = nextTraceId();
  const startedAt = Date.now();
  try {
    // 2026-10-01 S2 预召回退役：轻任务束（路由确定性投影）与域信号预载覆盖其
    // 全部价值场景，能力面经域卡+域拉取可达，投机检索不再有存在必要。
    const prepared = prepareToolsWithToolSearch(visibleCandidateTools, searchableSourceTools);
    recordGatewayTrace({
      traceId,
      phase: "tool_prepare",
      decision: `visible=${prepared.visibleTools.length} deferred=${prepared.deferredToolCount}`,
      reasons: prepared.toolSearchActive
        ? ["延迟目录激活（能力面经域卡+域拉取可达）"]
        : ["延迟目录未激活（小工具集/阈值未达）"],
      durationMs: Date.now() - startedAt,
      timestamp: startedAt,
    });
    return prepared;
  } catch (error) {
    recordGatewayTrace({
      traceId,
      phase: "tool_prepare",
      decision: "tool_prepare (failed)",
      reasons: [error instanceof Error ? error.message : String(error)],
      durationMs: Date.now() - startedAt,
      timestamp: startedAt,
    });
    throw error;
  }
}

/**
 * 桥接工具执行：tool_discover（搜索/加载延迟工具 schema）与 tool_call（执行）。
 * 检索后端为进程内 adaptive 管线（意图路由 → 混合召回 → 自适应 top-p → 图扩展 → 重排）。
 */
export function executeBridge(
  bridgeName: string,
  args: Record<string, unknown>,
  catalog: DeferredToolCatalog,
  residentTools?: ResidentToolInfo[],
): Promise<ToolSearchBridgeResult> {
  return tracedAsync(
    "bridge_execute",
    `bridge=${bridgeName}`,
    [`catalog=${catalog.entries.length}`],
    () => executeToolSearchBridge(bridgeName, args, catalog, residentTools),
  );
}

/**
 * 直接检索延迟目录（不经 LLM 桥接）：管理端/诊断端用。
 * 正常对话流程走 executeBridge("tool_discover", ...)。
 */
export function searchResources(
  catalog: DeferredToolCatalog,
  query: string,
  limit: number,
  options?: { includeSchema?: boolean; tenantId?: string; agentContextHash?: string },
): Promise<AdaptiveDeferredToolSearchMatch[]> {
  return tracedAsync(
    "resource_search",
    `query=${query.slice(0, 40)} limit=${limit}`,
    ["tool-router 混合检索"],
    () => adaptiveSearchDeferredTools(catalog, query, limit, options),
  );
}

/**
 * 渲染路由：assistant 文本的渲染形态判定（卡片/摘要/brief/结构化/纯文本）。
 * 包装 classifyRenderHint 并记录 trace（phase: render_route）。
 */
export function routeRender(text: string, ctx?: RenderHintContext): RenderHint {
  const startedAt = Date.now();
  const hint = classifyRenderHint(text, ctx);
  recordGatewayTrace({
    traceId: nextTraceId(),
    phase: "render_route",
    decision: `type=${hint.type}`,
    reasons: [hint.reason],
    durationMs: Date.now() - startedAt,
    timestamp: startedAt,
  });
  return hint;
}
