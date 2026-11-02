/**
 * agent_browser 通用层测试（不启动真实浏览器）：
 *   - 内置浏览器在线时优先走可见面板（不启 Playwright 无头）
 *   - 撞登录墙 / 验证码 → human-required handoff（同一会话同一理由只弹一次）
 *   - close 释放面板租约（页面留痕）
 */
import assert from "node:assert/strict";
import test from "node:test";

import type { Page } from "playwright";

import { AgentBrowserService } from "../src/services/agent-browser-service.js";
import type { BrowserRuntime, BrowserPageLease } from "../src/services/browser-runtime/index.js";
import { BrowserSessionService } from "../src/services/browser-session-service.js";
import type { ToolContext } from "../src/tools/tool-registry.js";

/** 可变页面状态：url + 正文（模拟点击后跳到验证页）。 */
function makeFakePage(state: { url: string; body: string }) {
  return {
    setDefaultTimeout: () => {},
    url: () => state.url,
    title: async () => "测试页",
    evaluate: async (_fn: unknown, arg?: unknown) => (arg ? null : state.body),
    click: async () => {
      // 点击后落到验证码页
      state.url = "https://search.jd.com/Search?keyword=x";
      state.body = "请完成安全验证 拖动滑块完成拼图";
    },
    isClosed: () => false,
  } as unknown as Page;
}

test("agent_browser.open：内置浏览器优先；登录墙触发一次通用 handoff", async () => {
  const state = { url: "https://passport.jd.com/new/login.aspx", body: "" };
  const page = makeFakePage(state);
  let released = 0;
  let openedUrl = "";
  const lease: BrowserPageLease = {
    page,
    mode: "shared",
    release: async () => {
      released += 1;
    },
  };
  const runtime = {
    canUseSharedBrowser: () => true,
    tryOpenSharedPage: async (_actorId: string, url: string) => {
      openedUrl = url;
      return lease;
    },
  } as unknown as BrowserRuntime;

  const handoffs: Array<Record<string, unknown>> = [];
  const service = new AgentBrowserService({
    browserSessionService: new BrowserSessionService(),
    runtime,
    onHumanRequired: (info) => handoffs.push(info as unknown as Record<string, unknown>),
  });
  const ctx: ToolContext = { sessionId: "chat-s1", userId: "u1" };
  try {
    const opened = await service.open(ctx, state.url);
    assert.equal(opened.ok, true);
    const openedRec = opened as unknown as Record<string, unknown>;
    assert.equal(openedRec.browserMode, "shared", "内置浏览器在线时必须走可见面板");
    assert.equal(openedUrl, state.url);
    const human = openedRec.humanRequired as { reason?: string } | undefined;
    assert.equal(human?.reason, "login");
    assert.equal(handoffs.length, 1, "登录墙只交接一次");
    assert.deepEqual(handoffs[0]!.siteLabels, ["京东"]);
    assert.equal(handoffs[0]!.sessionId, "chat-s1", "交接用的是聊天会话 id，不是浏览器 sessionId");
    assert.equal(handoffs[0]!.reason, "login");

    // 点击后落到验证码页 → 再交接一次（理由变化，不是重复打扰）
    const sessionId = String(openedRec.sessionId);
    const clicked = await service.click(ctx, sessionId, "#submit");
    assert.equal(clicked.ok, true);
    const clipped = (clicked as unknown as Record<string, unknown>).humanRequired as
      | { reason?: string }
      | undefined;
    assert.equal(clipped?.reason, "captcha");
    assert.equal(handoffs.length, 2);
    assert.equal(handoffs[1]!.reason, "captcha");

    // 同理由不再重复弹
    await service.click(ctx, sessionId, "#submit-again");
    assert.equal(handoffs.length, 2, "同一会话同一理由只弹一次");

    await service.close(ctx, sessionId);
    assert.equal(released, 1, "close 释放面板租约");
  } finally {
    await service.dispose();
  }
});
