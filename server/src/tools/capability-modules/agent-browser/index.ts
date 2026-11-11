/**
 * Agent 虚拟浏览器能力模块（capability-module）。
 *
 * 与 image-gen / code-sandbox / shopping-order 同结构，导出：
 *   - `AGENT_BROWSER_CHAT_TOOLS`          LLM 工具 schema（1 个复合工具 agent_browser）
 *   - `AGENT_BROWSER_INTENT_RULES`        意图元数据（接 BM25 调权）
 *   - `AGENT_BROWSER_CATEGORY_MAPPING`    关键词分类映射
 *   - `registerAgentBrowserTools`         注册到 ToolRegistry
 *
 * 启动时由 `capability-modules/index.ts` 的 `buildCapabilityModules(deps)` 统一合并到
 * `CAPABILITY_MODULES` 数组，由 `registerAllCapabilityModules` /
 * `getCapabilityModuleChatTools` 等统一消费。
 *
 * 核心定位：在服务端后台启动 Playwright 无头浏览器，维持有状态会话（sessionId），
 * 让 Agent 能在浏览器中完成多步操作流程（open → click/type/scroll → extract_text → close）。
 */
import { AGENT_BROWSER_CHAT_TOOLS } from "./chat-tools.js";
import { registerAgentBrowserTools } from "./handlers.js";
import type { AgentBrowserModuleDeps } from "./handlers.js";
import { AGENT_BROWSER_INTENT_RULES, AGENT_BROWSER_CATEGORY_MAPPING } from "./intent.js";

export { AGENT_BROWSER_CHAT_TOOLS } from "./chat-tools.js";
export { AGENT_BROWSER_INTENT_RULES, AGENT_BROWSER_CATEGORY_MAPPING } from "./intent.js";
export { registerAgentBrowserTools, type AgentBrowserModuleDeps } from "./handlers.js";
