import { resolveActorId } from "../../../agent/actor-id.js";
import { isSensitiveTypedText } from "../../../services/agent-task-safety.js";
import type { ToolHandler, ToolRegistry } from "../../tool-registry.js";
import type { SharedBrowserCoordinator } from "../../../services/shared-browser-coordinator.js";
import type { SharedBrowserCdpGateway } from "../../../services/shared-browser/cdp-gateway.js";
import { classifySharedBrowserInvoke } from "../../../services/shared-browser/risk.js";

/**
 * shared_browser.* 工具 handler 集合 + 注册入口。
 *
 * 执行端不在服务端，而在客户端（Flutter Windows）的 WebView2 浏览器里：
 * handler 把动作经 SharedBrowserCoordinator 转发到用户当前打开的浏览器，
 * 用户与 Agent 共用同一个页面（用户的登录态、Cookie 天然可用）。
 *
 * 安全：
 *   - 协调器内部对每次 invoke/done/failed/timeout 写审计日志（category "shared_browser"）
 *   - 浏览器在线检查前置（离线时立即失败，不排队）
 *   - click/type 经 classifySharedBrowserInvoke 分级，高风险动作携带 gate
 *     下发，客户端弹确认条，用户允许才执行
 */
export interface SharedBrowserModuleDeps {
  sharedBrowserCoordinator: SharedBrowserCoordinator;
  /** 可信输入网关（CDP 桥）；未启用时 trusted 工具自动回退注入路径。 */
  sharedBrowserCdpGateway?: SharedBrowserCdpGateway;
}

function offlineResult() {
  return {
    ok: false,
    error:
      "共用浏览器未连接（客户端未打开内置浏览器，或当前是手机端等无可见浏览器的设备）。" +
      "浏览器/网页任务请改用 agent_browser.*，在服务端远端浏览器执行。",
    retryable: false,
  };
}

function createInvokeHandler(
  coordinator: SharedBrowserCoordinator,
  action: string,
  buildParams: (input: Record<string, unknown>) => Record<string, unknown>,
  validate?: (input: Record<string, unknown>) => string | null,
  opts?: {
    /** 需要过风险分级确认门的动作（click/type）。 */
    gated?: boolean;
  },
): ToolHandler {
  return async (input: Record<string, unknown>, context) => {
    const invalid = validate?.(input);
    if (invalid) return { ok: false, error: invalid };

    const actorId = resolveActorId(context);
    if (!coordinator.hasExecutor(actorId)) return offlineResult();

    const params = buildParams(input);
    let gate;
    if (opts?.gated) {
      const assessed = classifySharedBrowserInvoke(action, params, {
        url: coordinator.lastUrl(actorId),
      });
      if (assessed.level === "high") gate = assessed;
    }
    return coordinator.invoke(actorId, action, params, { gate });
  };
}

/**
 * 注册 shared-browser 全部工具到 ToolRegistry。
 *
 * 调用方：`capability-modules/index.ts` 的 `buildCapabilityModules` 闭包。
 */
export function registerSharedBrowserTools(
  registry: ToolRegistry,
  deps: SharedBrowserModuleDeps,
): void {
  const { sharedBrowserCoordinator: coordinator } = deps;

  registry.register(
    "shared_browser.navigate",
    createInvokeHandler(coordinator, "navigate", (input) => ({
      url: String(input.url ?? "").trim(),
    }), (input) => (String(input.url ?? "").trim() ? null : "缺少 url")),
  );

  registry.register(
    "shared_browser.control",
    createInvokeHandler(coordinator, "control", (input) => ({
      action: String(input.action ?? ""),
    }), (input) => {
      const action = String(input.action ?? "");
      return ["back", "forward", "reload", "stop", "home"].includes(action)
        ? null
        : "action 须为 back/forward/reload/stop/home 之一";
    }),
  );

  registry.register(
    "shared_browser.click",
    createInvokeHandler(coordinator, "click", (input) => ({
      ref: typeof input.ref === "string" ? input.ref : undefined,
      selector: typeof input.selector === "string" ? input.selector : undefined,
      text: typeof input.text === "string" ? input.text : undefined,
      index: typeof input.index === "number" ? input.index : undefined,
      waitTimeoutMs: typeof input.waitTimeoutMs === "number" ? input.waitTimeoutMs : undefined,
    }), (input) =>
      (typeof input.ref === "string" && input.ref.trim())
      || (typeof input.selector === "string" && input.selector.trim())
      || (typeof input.text === "string" && input.text.trim())
      || typeof input.index === "number"
        ? null
        : "ref / selector / text / index 至少传一个（优先用 read_page 返回的 ref）", { gated: true }),
  );

  registry.register(
    "shared_browser.type",
    createInvokeHandler(coordinator, "type", (input) => ({
      ref: typeof input.ref === "string" ? input.ref : undefined,
      selector: typeof input.selector === "string" ? input.selector : undefined,
      text: String(input.text ?? ""),
      submit: input.submit === true,
      clear: input.clear !== false,
    }), (input) => (String(input.text ?? "") ? null : "缺少 text"), { gated: true }),
  );

  registry.register(
    "shared_browser.scroll",
    createInvokeHandler(coordinator, "scroll", (input) => ({
      deltaY: typeof input.deltaY === "number" ? input.deltaY : undefined,
      to: typeof input.to === "string" ? input.to : undefined,
    })),
  );

  registry.register(
    "shared_browser.read_page",
    createInvokeHandler(coordinator, "read_page", (input) => ({
      selector: typeof input.selector === "string" && input.selector.trim()
        ? input.selector
        : undefined,
      includeInteractive: input.includeInteractive !== false,
      maxChars: typeof input.maxChars === "number" ? input.maxChars : undefined,
      offset: typeof input.offset === "number" ? input.offset : undefined,
      elementLimit: typeof input.elementLimit === "number" ? input.elementLimit : undefined,
    })),
  );

  registry.register(
    "shared_browser.export_state",
    createInvokeHandler(coordinator, "export_state", () => ({})),
  );

  // 只读探测（handoff 自动检测专用，2026-11-02）：窥视当前面板页是否仍被
  // 登录墙/验证码拦着——不导航、不抢面板槽位、不注入任何脚本。TaskPlanProbeRunner
  // 按步级 gap 轮询它，命中「墙已清除」即自动收回执行权续跑（用户不用点按钮）。
  registry.register("shared_browser.panel_state", async (input, context) => {
    const gateway = deps.sharedBrowserCdpGateway;
    if (!gateway) return { ok: false, error: "CDP 网关未装配", blocked: true };
    const actorId = resolveActorId(context);
    if (!coordinator.hasExecutor(actorId)) {
      return { ok: false, error: "共用浏览器未连接", blocked: true };
    }
    const siteId = typeof input.siteId === "string" ? input.siteId.trim() : "";
    const state = await gateway.peekPanelState(siteId);
    if (!state.ok) return { ...state, blocked: true };
    return {
      ok: true,
      url: state.url,
      blocked: state.blocked === true,
      ...(state.reason ? { reason: state.reason } : {}),
      ...(state.evidence ? { evidence: state.evidence } : {}),
    };
  });

  registry.register(
    "shared_browser.trusted",
    // 可信输入（CDP 桥）：客户端开启调试端口且服务端总开关打开时，
    // 用 Playwright 直连用户浏览器派发 isTrusted=true 的真实输入；
    // 否则回退注入路径（isTrusted=false 合成事件）并在结果里注明。
    async (input, context) => {
      const action = String(input.action ?? "");
      if (!["click", "type"].includes(action)) {
        return { ok: false, error: "action 须为 click/type" };
      }
      if (!String(input.text ?? input.selector ?? "").trim()) {
        return { ok: false, error: "text / selector 至少传一个" };
      }
      if (action === "type" && !String(input.text ?? "").trim()) {
        return { ok: false, error: "可信输入须提供 text" };
      }
      // 敏感输入门（2026-09-19 P1-1）：与 desktop.run_input type 同口径——
      // 可信输入是 isTrusted=true 的真实键盘事件，金融/个人敏感信息一律不代打。
      if (action === "type") {
        const sens = isSensitiveTypedText(String(input.text ?? ""));
        if (sens.sensitive) {
          return {
            ok: false,
            error: `可信输入被安全门拦截：${sens.reason}。`,
          };
        }
      }
      const actorId = resolveActorId(context);
      if (!coordinator.hasExecutor(actorId)) return offlineResult();

      const gateway = deps.sharedBrowserCdpGateway;
      const endpoint = coordinator.cdpEndpoint(actorId);
      if (gateway?.available && endpoint) {
        await gateway.connect(endpoint);
        const result = action === "click"
          ? await gateway.click({
              text: typeof input.text === "string" ? input.text : undefined,
              selector: typeof input.selector === "string" ? input.selector : undefined,
              timeoutMs: typeof input.timeoutMs === "number" ? input.timeoutMs : undefined,
            })
          : await gateway.type({
              text: String(input.text ?? ""),
              selector: typeof input.selector === "string" ? input.selector : undefined,
              submit: input.submit === true,
              timeoutMs: typeof input.timeoutMs === "number" ? input.timeoutMs : undefined,
            });
        if (result.ok) {
          return { ok: true, trusted: true, note: "真实输入事件（isTrusted=true），抗风控" };
        }
        // CDP 失败 → 落回注入路径，附上失败原因
        const fallback = await coordinator.invoke(actorId, action, {
          text: typeof input.text === "string" ? input.text : undefined,
          selector: typeof input.selector === "string" ? input.selector : undefined,
          submit: input.submit === true,
        });
        return { ...fallback, trusted: false, trustedError: result.error };
      }

      const fallback = await coordinator.invoke(actorId, action, {
        text: typeof input.text === "string" ? input.text : undefined,
        selector: typeof input.selector === "string" ? input.selector : undefined,
        submit: input.submit === true,
      });
      return {
        ...fallback,
        trusted: false,
        note: gateway?.available
          ? "客户端未开启 CDP 调试端口，已回退为普通注入点击"
          : "服务端未启用 CDP 桥（SHARED_BROWSER_CDP_ENABLED=1），已回退为普通注入点击",
      };
    },
  );
}
