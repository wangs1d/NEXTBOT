import { randomUUID } from "node:crypto";

import type { AuditService } from "./audit-service.js";
import type { SharedBrowserRiskAssessment } from "./shared-browser/risk.js";

/**
 * 共用浏览器桥协调器（用户与 Agent 共用同一个客户端内嵌浏览器）。
 *
 * 浏览器本体是客户端（Flutter Windows）里的 WebView2：用户在「常用工具 → 浏览器」
 * 里正常浏览，Agent 经 shared_browser.* 工具下发动作，由本协调器经聊天主通道
 * WS 转发到客户端执行（navigate/click/type/scroll/read_page 等），结果按
 * jobId 配对回传。客户端登录态天然可用，无需 Cookie 导入。
 *
 * 通道契约：
 *   - 绑定：客户端 session.init 带 `browserBridge: true`（聊天主连接自身即执行器）
 *   - 下发：server → client `shared.browser.invoke` { jobId, action, params, gate? }
 *   - 回传：client → server `browser.bridge.result` { jobId, ...result }
 *   - 信息：client → server `browser.bridge.info` { endpoint }（CDP 桥端点，可选）
 *   - 清理：socket 断开时解绑并快速失败所有挂起任务
 *
 * 安全：
 *   - 所有 invoke 写审计日志（AuditService，category "shared_browser"），
 *     回执补记耗时与结果（成功/失败/拒绝）
 *   - 风险分级（classifySharedBrowserInvoke）判定为 high 的动作经 gate 字段
 *     下发，客户端弹确认条，用户允许才执行（确认门在客户端，ws 通道本身已认证）
 *   - timeout 兜底防止工具循环挂起
 */

export type WsSendLike = {
  send(data: string): void;
  readyState?: number;
};

export type SharedBrowserResult = {
  ok: boolean;
  [key: string]: unknown;
};

export interface SharedBrowserInvokeOptions {
  timeoutMs?: number;
  /** 高风险确认门（risk.ts 分级结果；required=true 时客户端先弹确认条）。 */
  gate?: SharedBrowserRiskAssessment;
}

type PendingJob = {
  resolve: (r: SharedBrowserResult) => void;
  timer: NodeJS.Timeout;
  socket: WsSendLike;
  jobId: string;
  actorId: string;
  action: string;
  startedAt: number;
};

function safeSend(socket: WsSendLike, payload: object) {
  try {
    if (socket.readyState !== undefined && socket.readyState > 1) return;
    socket.send(JSON.stringify(payload));
  } catch {
    // ignore
  }
}

export class SharedBrowserCoordinator {
  private readonly executors = new Map<string, WsSendLike>();
  private readonly pending = new Map<string, PendingJob>();

  /** 各执行端最近上报的页面 URL（风险分级用；browser.bridge.result 附带）。 */
  private readonly lastUrls = new Map<string, string>();

  /** 各执行端上报的 CDP 调试端点（trusted 工具用；默认空 = CDP 桥未开启）。 */
  private readonly cdpEndpoints = new Map<string, string>();

  /** 审计；缺省时跳过（单测场景）。 */
  constructor(private readonly audit?: AuditService) {}

  /** session.init 带 browserBridge:true 时由 ws 连接层调用（幂等，重连即重绑）。 */
  bindExecutor(actorId: string, socket: WsSendLike) {
    this.executors.set(actorId, socket);
  }

  unbindIfSocket(actorId: string, socket: WsSendLike): boolean {
    if (this.executors.get(actorId) !== socket) return false;
    this.executors.delete(actorId);
    this.cdpEndpoints.delete(actorId);
    for (const [id, job] of this.pending.entries()) {
      if (job.socket === socket) {
        clearTimeout(job.timer);
        job.resolve({ ok: false, error: "socket disconnected" });
        this.pending.delete(id);
      }
    }
    return true;
  }

  /** Agent 工具下发前判断共用浏览器是否在线。 */
  hasExecutor(actorId: string): boolean {
    return this.executors.has(actorId);
  }

  /** 执行端最近上报的页面 URL（无上报时为空串）。 */
  lastUrl(actorId: string): string {
    return this.lastUrls.get(actorId) ?? "";
  }

  /** 客户端经 browser.bridge.info 上报 CDP 端点（空串 = 清除）。 */
  setCdpEndpoint(actorId: string, endpoint: string) {
    const trimmed = endpoint.trim();
    if (!trimmed) this.cdpEndpoints.delete(actorId);
    else this.cdpEndpoints.set(actorId, trimmed);
  }

  cdpEndpoint(actorId: string): string {
    return this.cdpEndpoints.get(actorId) ?? "";
  }

  /**
   * 「保存登录态」征询回调（装配层接线 → BrowserSessionService.setCaptureConsent）。
   * 客户端弹条后回 browser.save_login_decision，经 connection 层转到这里。
   */
  onSaveLoginDecision?: (actorId: string, siteId: string, allowed: boolean) => void;

  /** 向客户端弹「允许保存登录态」征询条（未绑执行器时静默跳过）。 */
  askSaveLoginConsent(actorId: string, siteId: string, siteLabel: string): void {
    const socket = this.executors.get(actorId);
    if (!socket) return;
    safeSend(socket, {
      type: "shared.browser.ask_save_login",
      payload: { siteId, siteLabel },
    });
  }

  /** 客户端征询答复入口（connection 层调用）。 */
  forwardSaveLoginDecision(actorId: string, siteId: string, allowed: boolean): void {
    this.onSaveLoginDecision?.(actorId, siteId, allowed);
  }

  /** 未绑定时的调用返回立即失败（不抛错），工具层据此回退提示。 */
  invoke(
    actorId: string,
    action: string,
    params: Record<string, unknown> = {},
    options: SharedBrowserInvokeOptions = {},
  ): Promise<SharedBrowserResult> {
    const socket = this.executors.get(actorId);
    if (!socket) {
      return Promise.resolve({ ok: false, error: "shared browser bridge offline" });
    }

    const jobId = randomUUID();
    const startedAt = Date.now();
    void this.audit?.record({
      category: "shared_browser",
      action: `invoke:${action}`,
      actorId,
      jobId,
      params,
      gate: options.gate?.level === "high" ? options.gate.reason : undefined,
      timestamp: startedAt,
    }).catch(() => {});

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(jobId);
        void this.audit?.record({
          category: "shared_browser",
          action: `timeout:${action}`,
          actorId,
          jobId,
          durationMs: Date.now() - startedAt,
          timestamp: Date.now(),
        }).catch(() => {});
        resolve({ ok: false, error: "shared browser invoke timeout", retryable: true });
      }, options.timeoutMs ?? 30_000);

      this.pending.set(jobId, { resolve, timer, socket, jobId, actorId, action, startedAt });

      safeSend(socket, {
        type: "shared.browser.invoke",
        payload: {
          jobId,
          action,
          params,
          ...(options.gate?.level === "high"
            ? { gate: { required: true, ...options.gate } }
            : {}),
        },
      });
    });
  }

  completeFromSocket(
    actorId: string,
    socket: WsSendLike,
    jobId: string,
    result: SharedBrowserResult,
  ): boolean {
    const job = this.pending.get(jobId);
    if (!job || job.actorId !== actorId || job.socket !== socket) return false;

    clearTimeout(job.timer);
    this.pending.delete(jobId);
    const url = result.url;
    if (typeof url === "string" && url && !url.startsWith("about:")) {
      this.lastUrls.set(actorId, url);
    }
    if (!result.ok) {
      void this.audit?.record({
        category: "shared_browser",
        action: `failed:${job.action}`,
        actorId,
        jobId,
        error: String(result.error ?? "unknown"),
        code: result.code,
        denied: result.denied === true || undefined,
        durationMs: Date.now() - job.startedAt,
        timestamp: Date.now(),
      }).catch(() => {});
    } else {
      void this.audit?.record({
        category: "shared_browser",
        action: `done:${job.action}`,
        actorId,
        jobId,
        url,
        durationMs: Date.now() - job.startedAt,
        timestamp: Date.now(),
      }).catch(() => {});
    }
    job.resolve(result);
    return true;
  }
}
