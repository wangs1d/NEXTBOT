import type { CDPSession, Page } from "playwright";

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
const PREVIEW_INTERVAL_MS = 1_100;
/** 单页寿命上限：页面通常几十秒内就释放，兜底防僵尸流。 */
const PREVIEW_MAX_LIFETIME_MS = 120_000;
/** 单帧截图超时：跳转中页面会卡住截图，超时直接跳过本帧。 */
const PREVIEW_CAPTURE_TIMEOUT_MS = 3_000;
/** JPEG 质量：悬浮窗只有 ~200px 宽，低质量足够且省流量。 */
const PREVIEW_QUALITY = 45;
/**
 * 单帧最长边（像素）。
 *
 * 2026-11-19：原来推的是整幅 1280×900 q40（单帧 60~120KB base64），比价一轮
 * 30 帧轻松上 2~3MB——手机端弱网下 WS 直接被撑断（真机日志 code=1006），
 * 用户看到的是「画面停住 + 后续二维码一张没收到」。悬浮窗只有 200px 宽，
 * 缩到 720 宽画质无感，单帧降到 20~30KB。
 */
const PREVIEW_MAX_WIDTH = 720;

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
  opts: {
    action?: string;
    mode?: string;
    sessionId?: string;
    /** 截帧间隔（默认 1.1s）。留驻等扫码的登录页画面静止，用更稀的节奏省流量。 */
    intervalMs?: number;
    /** 推流寿命上限（默认 120s）。留驻页面要与页面存活期对齐。 */
    maxLifetimeMs?: number;
    /**
     * 停止时补一帧 action="end"：客户端据此立即熄灭悬浮窗，而不是等
     * 「无帧超时」——留驻登录页收起时用户已经能看到结果了。
     */
    sendEndOnStop?: boolean;
  } = {},
): BrowserPreviewHandle {
  const push = ctx.pushBrowserPreview;
  const action = (opts.action ?? "").trim() || "stream";
  const sessionId = opts.sessionId ?? `preview-${Date.now()}`;
  const intervalMs = opts.intervalMs ?? PREVIEW_INTERVAL_MS;
  const maxLifetimeMs = opts.maxLifetimeMs ?? PREVIEW_MAX_LIFETIME_MS;
  const startedAt = Date.now();
  let stopped = false;
  let busy = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let cdp: CDPSession | null = null;

  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    const c = cdp;
    cdp = null;
    if (c) void c.detach().catch(() => {});
    if (opts.sendEndOnStop && push && !isPageClosed(page)) {
      try {
        push({
          sessionId,
          action: "end",
          url: page.url(),
          imageBase64: "",
          mode: opts.mode ?? "headless",
        });
      } catch {
        /* 连接已断：端上收不到 end，无帧超时兜底熄灭 */
      }
    }
  };

  // 没有推送通道（程序化调用 / 桌面端不发）——直接给空句柄，不空转。
  if (!push) return { stop };

  /**
   * 抓一帧（缩放到最长边 720）。
   *
   * 优先 CDP captureScreenshot 的 clip.scale：服务端就把画面缩小，省的是
   * WS 带宽（客户端再缩没用）。CDP 不可用（老版本/断开）回退整幅截图。
   */
  const capture = async (): Promise<Buffer | null> => {
    const viewport = page.viewportSize();
    if (!cdp) {
      cdp = await page.context().newCDPSession(page).catch(() => null);
    }
    if (cdp && viewport) {
      const scale = Math.min(1, PREVIEW_MAX_WIDTH / Math.max(1, viewport.width));
      const shot = await cdp
        .send("Page.captureScreenshot", {
          format: "jpeg",
          quality: PREVIEW_QUALITY,
          ...(scale < 1
            ? { clip: { x: 0, y: 0, width: viewport.width, height: viewport.height, scale } }
            : {}),
        })
        .catch(() => null);
      if (shot?.data) return Buffer.from(shot.data, "base64");
      // 本帧 CDP 失败：丢掉句柄，下帧重建（页面可能刚跳转过）
      const stale = cdp;
      cdp = null;
      void stale.detach().catch(() => {});
    }
    return page.screenshot({ type: "jpeg", quality: PREVIEW_QUALITY }).catch(() => null);
  };

  const tick = async (): Promise<void> => {
    if (stopped) return;
    if (!push || page.isClosed() || Date.now() - startedAt > maxLifetimeMs) {
      stop();
      return;
    }
    if (!busy) {
      busy = true;
      try {
        const data: Buffer | null = await Promise.race([
          capture(),
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
      timer = setTimeout(() => void tick(), intervalMs);
      timer.unref?.();
    }
  };

  void tick();
  return { stop };
}

/** 页面是否已关闭（推送 end 帧前用；isClosed 在个别桩对象上可能缺失）。 */
function isPageClosed(page: Page): boolean {
  try {
    return typeof page.isClosed === "function" ? page.isClosed() : false;
  } catch {
    return false;
  }
}
