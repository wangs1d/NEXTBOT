import type { Page } from "playwright";

import type { ToolContext } from "../tools/tool-registry.js";

/**
 * 云端浏览器「工作画面」预览流（2026-11-14）。
 *
 * 手机端没有可见内置浏览器（WebView2 仅 Windows）：凡是跑在服务端无头 Chromium
 * 里的浏览器任务（agent_browser 之外，还有购物比价/搜索/下单等），都要把当前
 * 页面画面经 agent.browser.preview 推给客户端右上角悬浮窗——否则用户在手机上
 * 只看到「正在处理」，不知道 Agent 到底在翻哪个页面。
 *
 * 与 agent-browser-service 的 CDP screencast 互补：那边是 agent_browser 自己的
 * 逐帧直播；这里是通用兜底，按固定间隔截帧。页面关闭 / 任务收口 / 推送通道失效
 * 时自动停。best-effort：任何失败都静默跳过，绝不影响主流程、绝不阻塞工具回执。
 */

/** 截帧间隔（比 agent_browser 的直播稀，够表达「在动」又不压带宽）。 */
const PREVIEW_INTERVAL_MS = 900;
/** 单页寿命上限：页面通常几十秒内就释放，兜底防僵尸流。 */
const PREVIEW_MAX_LIFETIME_MS = 120_000;
/** 单帧截图超时：跳转中页面会卡住截图，超时直接跳过本帧。 */
const PREVIEW_CAPTURE_TIMEOUT_MS = 3_000;
/** JPEG 质量：悬浮窗只有 ~200px 宽，低质量足够且省流量。 */
const PREVIEW_QUALITY = 40;

export type BrowserPreviewHandle = {
  /** 停止推流（幂等；调用方在页面释放前调用）。 */
  stop: () => void;
};

/**
 * 对已在无头浏览器里导航完成的页面启动预览流。
 *
 * [opts.action] 缺省不传：保留 "stream"，让客户端继续用 tool.call 里的真实
 * 动作（prices/search/place）出标题文案，不被流帧覆盖。
 */
export function startBrowserPreviewStream(
  ctx: ToolContext,
  page: Page,
  opts: { action?: string; mode?: string; sessionId?: string } = {},
): BrowserPreviewHandle {
  const push = ctx.pushBrowserPreview;
  const action = (opts.action ?? "").trim() || "stream";
  const sessionId = opts.sessionId ?? `preview-${Date.now()}`;
  const startedAt = Date.now();
  let stopped = false;
  let busy = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const stop = (): void => {
    stopped = true;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };

  // 没有推送通道（程序化调用 / 桌面端不发）——直接给空句柄，不空转。
  if (!push) return { stop };

  const tick = async (): Promise<void> => {
    if (stopped) return;
    if (!push || page.isClosed() || Date.now() - startedAt > PREVIEW_MAX_LIFETIME_MS) {
      stop();
      return;
    }
    if (!busy) {
      busy = true;
      try {
        const data: Buffer | null = await Promise.race([
          page.screenshot({
            type: "jpeg",
            quality: PREVIEW_QUALITY,
            timeout: PREVIEW_CAPTURE_TIMEOUT_MS,
          }),
          new Promise<null>((resolve) => {
            const t = setTimeout(() => resolve(null), PREVIEW_CAPTURE_TIMEOUT_MS);
            t.unref?.();
          }),
        ]);
        if (data && data.length > 0 && !stopped) {
          // 返回 false = 回合已收口/连接失效：立即自停，不空烧。
          const alive = push({
            sessionId,
            action,
            url: page.url(),
            imageBase64: data.toString("base64"),
            mode: opts.mode ?? "headless",
          });
          if (alive === false) {
            stop();
            return;
          }
        }
      } catch {
        /* 截图失败（跳转中/已关闭）：跳过本帧，不影响任务 */
      } finally {
        busy = false;
      }
    }
    if (!stopped) {
      timer = setTimeout(() => void tick(), PREVIEW_INTERVAL_MS);
      timer.unref?.();
    }
  };

  void tick();
  return { stop };
}
