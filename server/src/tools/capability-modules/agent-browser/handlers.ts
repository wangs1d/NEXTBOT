import type { ToolHandler, ToolContext, ToolRegistry } from "../../tool-registry.js";
import type { AgentBrowserService } from "../../../services/agent-browser-service.js";

/**
 * agent_browser.* 工具 handler 工厂集合 + 注册入口。
 *
 * 每个 handler 调用 {@link AgentBrowserService} 对应方法，统一返回：
 *   - 成功：`{ ok: true, ..., summary?: string }`
 *   - 失败：`{ ok: false, error: string, retryable?: boolean }`
 *
 * 访问模式：本模块**在沙箱模式下也可运行**，不强制要求「完全访问」。
 * 安全护栏由以下机制独立保障（不依赖 agentAccessMode）：
 *   1. URL 安全校验：https 任意 URL / http 仅 localhost
 *   2. 会话绑定 actorId 跨用户隔离；sessionId 不可预测（randomUUID）
 *   3. 会话 TTL 10 分钟 + LRU 上限 8 个自动清理
 *   4. 审计日志：所有操作记录到 audit-service（category: "agent_browser"）
 *   5. Cookie 注入仅对已授权站点（复用 browser-session 双重门禁）
 */

/** agent-browser 模块依赖（局部类型）。 */
export interface AgentBrowserModuleDeps {
  agentBrowserService: AgentBrowserService;
}

/** agent_browser.open —— 打开 URL，返回 sessionId。 */
export function createAgentBrowserOpenHandler(
  service: AgentBrowserService,
): ToolHandler {
  return async (input: Record<string, unknown>, context: ToolContext) => {
    const url = typeof input.url === "string" ? input.url.trim() : "";
    if (!url) return { ok: false, error: "缺少 url" };

    const opts: Record<string, unknown> = {};
    if (input.viewport && typeof input.viewport === "object") {
      const vp = input.viewport as Record<string, unknown>;
      const width = typeof vp.width === "number" ? vp.width : undefined;
      const height = typeof vp.height === "number" ? vp.height : undefined;
      if (width && height) opts.viewport = { width, height };
    }
    if (typeof input.waitUntil === "string") opts.waitUntil = input.waitUntil;
    if (typeof input.timeout === "number") opts.timeout = input.timeout;

    return service.open(context, url, opts);
  };
}

/** 解析元素定位入参：优先 ref（extract_text 返回的 ariaSnapshot 引用），否则 selector。 */
function resolveSelector(input: Record<string, unknown>): string {
  const ref = typeof input.ref === "string" ? input.ref.trim() : "";
  if (ref) return `aria-ref=${ref}`;
  return typeof input.selector === "string" ? input.selector : "";
}

/** agent_browser.click —— 点击元素。 */
export function createAgentBrowserClickHandler(
  service: AgentBrowserService,
): ToolHandler {
  return async (input: Record<string, unknown>, context: ToolContext) => {
    const sessionId = typeof input.sessionId === "string" ? input.sessionId.trim() : "";
    const selector = resolveSelector(input);
    if (!sessionId) return { ok: false, error: "缺少 sessionId" };
    if (!selector) return { ok: false, error: "缺少 ref 或 selector" };

    const opts: { timeout?: number; button?: "left" | "right"; doubleClick?: boolean } = {};
    if (typeof input.timeout === "number") opts.timeout = input.timeout;
    if (input.button === "left" || input.button === "right") opts.button = input.button;
    if (typeof input.doubleClick === "boolean") opts.doubleClick = input.doubleClick;

    return service.click(context, sessionId, selector, opts);
  };
}

/** agent_browser.type —— 输入文本。 */
export function createAgentBrowserTypeHandler(
  service: AgentBrowserService,
): ToolHandler {
  return async (input: Record<string, unknown>, context: ToolContext) => {
    const sessionId = typeof input.sessionId === "string" ? input.sessionId.trim() : "";
    const selector = resolveSelector(input);
    const text = typeof input.text === "string" ? input.text : "";
    if (!sessionId) return { ok: false, error: "缺少 sessionId" };
    if (!selector) return { ok: false, error: "缺少 ref 或 selector" };
    if (!text) return { ok: false, error: "缺少 text" };

    const opts: { append?: boolean; delay?: number; clear?: boolean } = {};
    if (typeof input.append === "boolean") opts.append = input.append;
    if (typeof input.delay === "number") opts.delay = input.delay;
    if (typeof input.clear === "boolean") opts.clear = input.clear;

    return service.type(context, sessionId, selector, text, opts);
  };
}

/** agent_browser.scroll —— 滚动页面。 */
export function createAgentBrowserScrollHandler(
  service: AgentBrowserService,
): ToolHandler {
  return async (input: Record<string, unknown>, context: ToolContext) => {
    const sessionId = typeof input.sessionId === "string" ? input.sessionId.trim() : "";
    if (!sessionId) return { ok: false, error: "缺少 sessionId" };

    const opts: { x?: number; y?: number; deltaY?: number; selector?: string } = {};
    if (typeof input.selector === "string" && input.selector.trim()) opts.selector = input.selector;
    if (typeof input.deltaY === "number") opts.deltaY = input.deltaY;
    if (typeof input.x === "number") opts.x = input.x;
    if (typeof input.y === "number") opts.y = input.y;

    return service.scroll(context, sessionId, opts);
  };
}

/** agent_browser.screenshot —— 截图。 */
export function createAgentBrowserScreenshotHandler(
  service: AgentBrowserService,
): ToolHandler {
  return async (input: Record<string, unknown>, context: ToolContext) => {
    const sessionId = typeof input.sessionId === "string" ? input.sessionId.trim() : "";
    if (!sessionId) return { ok: false, error: "缺少 sessionId" };

    const opts: { fullPage?: boolean; selector?: string; quality?: number } = {};
    if (typeof input.fullPage === "boolean") opts.fullPage = input.fullPage;
    if (typeof input.selector === "string" && input.selector.trim()) opts.selector = input.selector;
    if (typeof input.quality === "number") opts.quality = input.quality;

    return service.screenshot(context, sessionId, opts);
  };
}

/** agent_browser.extract_text —— 提取页面文本。 */
export function createAgentBrowserExtractTextHandler(
  service: AgentBrowserService,
): ToolHandler {
  return async (input: Record<string, unknown>, context: ToolContext) => {
    const sessionId = typeof input.sessionId === "string" ? input.sessionId.trim() : "";
    if (!sessionId) return { ok: false, error: "缺少 sessionId" };

    const selector = typeof input.selector === "string" && input.selector.trim()
      ? input.selector
      : undefined;
    const opts: { includeInteractive?: boolean } = {};
    if (typeof input.includeInteractive === "boolean") opts.includeInteractive = input.includeInteractive;

    return service.extractText(context, sessionId, selector, opts);
  };
}

/** agent_browser.wait_for —— 等待元素出现。 */
export function createAgentBrowserWaitForHandler(
  service: AgentBrowserService,
): ToolHandler {
  return async (input: Record<string, unknown>, context: ToolContext) => {
    const sessionId = typeof input.sessionId === "string" ? input.sessionId.trim() : "";
    const selector = resolveSelector(input);
    if (!sessionId) return { ok: false, error: "缺少 sessionId" };
    if (!selector) return { ok: false, error: "缺少 ref 或 selector" };

    const timeout = typeof input.timeout === "number" ? input.timeout : undefined;

    return service.waitFor(context, sessionId, selector, timeout);
  };
}

/** agent_browser.close —— 关闭会话。 */
export function createAgentBrowserCloseHandler(
  service: AgentBrowserService,
): ToolHandler {
  return async (input: Record<string, unknown>, context: ToolContext) => {
    const sessionId = typeof input.sessionId === "string" ? input.sessionId.trim() : "";
    if (!sessionId) return { ok: false, error: "缺少 sessionId" };

    return service.close(context, sessionId);
  };
}

/**
 * 注册 agent-browser 全部工具到 ToolRegistry。
 *
 * 调用方：`capability-modules/index.ts` 的 `buildCapabilityModules` 闭包，
 * 最终由 `registerAllCapabilityModules` 在启动阶段统一调用。
 */
export function registerAgentBrowserTools(
  registry: ToolRegistry,
  deps: AgentBrowserModuleDeps,
): void {
  const { agentBrowserService } = deps;
  registry.register("agent_browser.open", createAgentBrowserOpenHandler(agentBrowserService));
  registry.register("agent_browser.click", createAgentBrowserClickHandler(agentBrowserService));
  registry.register("agent_browser.type", createAgentBrowserTypeHandler(agentBrowserService));
  registry.register("agent_browser.scroll", createAgentBrowserScrollHandler(agentBrowserService));
  registry.register("agent_browser.screenshot", createAgentBrowserScreenshotHandler(agentBrowserService));
  registry.register("agent_browser.extract_text", createAgentBrowserExtractTextHandler(agentBrowserService));
  registry.register("agent_browser.wait_for", createAgentBrowserWaitForHandler(agentBrowserService));
  registry.register("agent_browser.close", createAgentBrowserCloseHandler(agentBrowserService));
}
