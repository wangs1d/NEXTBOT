/**
 * cdp-gateway 面板页锁定（2026-10-28 根因修复）契约测试。
 *
 * 锁住的行为：进程内多个 WebView2 目标共用一个 remote-debugging 端点时，
 * pickMarkedPanelPage 必须按注入标记（window.__NB_SHARED_PANEL__）唯一定位
 * 用户可见的内置浏览器面板页——旧的「挑 about:blank 页」启发式会把光球
 * （NavigateToString 页同样报 about:blank）误认成面板，goto 全落在看不见
 * 的目标上，用户面板永远停在主页。
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { Page } from "playwright";

const { pickMarkedPanelPage } = await import(
  "../src/services/shared-browser/cdp-gateway.js"
);

type FakePageSpec = {
  name: string;
  marked?: boolean;
  url?: string;
  closed?: boolean;
  evalThrows?: boolean;
};

function fakePage(spec: FakePageSpec): Page {
  return {
    isClosed: () => spec.closed === true,
    url: () => spec.url ?? "about:blank",
    evaluate: async () => {
      if (spec.evalThrows) throw new Error("Execution context was destroyed");
      return spec.marked === true;
    },
  } as unknown as Page;
}

test("多目标下按注入标记锁定面板页（光球 about:blank 不再被误抓）", async () => {
  const ball = fakePage({ name: "ball", url: "about:blank" });
  const video = fakePage({ name: "video", url: "file:///C:/app/video.html" });
  const panel = fakePage({ name: "panel", marked: true, url: "about:blank" });
  const picked = await pickMarkedPanelPage([ball, video, panel]);
  assert.equal(picked, panel);
});

test("面板页已导航到真实站点时仍按标记命中", async () => {
  const ball = fakePage({ name: "ball", url: "about:blank" });
  const panel = fakePage({
    name: "panel",
    marked: true,
    url: "https://cart.taobao.com/",
  });
  const picked = await pickMarkedPanelPage([ball, panel]);
  assert.equal(picked, panel);
});

test("无标记页面时返回 null（调用方退回 URL 启发式）", async () => {
  const ball = fakePage({ name: "ball", url: "about:blank" });
  const picked = await pickMarkedPanelPage([ball]);
  assert.equal(picked, null);
});

test("跳过已关闭与执行环境异常的候选", async () => {
  const closed = fakePage({ name: "closed", marked: true, closed: true });
  const destroyed = fakePage({ name: "destroyed", marked: true, evalThrows: true });
  const panel = fakePage({ name: "panel", marked: true, url: "about:blank" });
  const picked = await pickMarkedPanelPage([closed, destroyed, panel]);
  assert.equal(picked, panel);
});
