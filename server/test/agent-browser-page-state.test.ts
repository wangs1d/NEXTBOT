/**
 * agent_browser 观察回路测试（不启动真实浏览器）：
 * 主流循环的「行动+观察合一 / 错误+状态一起回喂」：
 *   - open 回执自带 pageState（url/title，快照失败时 interactive 缺省不阻塞）
 *   - click 成功 → 回执带 pageState（页面已跳转后的新状态）+ 行动观察合一 hint
 *   - click 失败（retryable）→ 错误 + pageState 一起回喂（自纠正回路）
 *   - 会话级错误（会话不存在）不带 pageState
 */
import assert from "node:assert/strict";
import test from "node:test";

import type { Page } from "playwright";

import { AgentBrowserService } from "../src/services/agent-browser-service.js";
import type { BrowserRuntime, BrowserPageLease } from "../src/services/browser-runtime/index.js";
import { BrowserSessionService } from "../src/services/browser-session-service.js";
import type { ToolContext } from "../src/tools/tool-registry.js";

/** 可变页面状态：url + 正文；可注入 click 抛错（模拟元素不存在/超时）。 */
function makeFakePage(
  state: { url: string; body: string },
  opts?: { clickError?: Error },
) {
  return {
    setDefaultTimeout: () => {},
    url: () => state.url,
    title: async () => "测试页",
    evaluate: async (_fn: unknown, arg?: unknown) => (arg ? null : state.body),
    click: async () => {
      if (opts?.clickError) throw opts.clickError;
      // 点击后跳转到结果页
      state.url = "https://www.example.com/result?q=x";
      state.body = "搜索结果页";
    },
    isClosed: () => false,
  } as unknown as Page;
}

/** 起一个内置浏览器在线的 service（lease 模式，不碰 Playwright）。 */
function makeService(page: Page): AgentBrowserService {
  const lease: BrowserPageLease = {
    page,
    mode: "shared",
    release: async () => {},
  };
  const runtime = {
    canUseSharedBrowser: () => true,
    tryOpenSharedPage: async () => lease,
  } as unknown as BrowserRuntime;
  return new AgentBrowserService({
    browserSessionService: new BrowserSessionService(),
    runtime,
  });
}

const ctx: ToolContext = { sessionId: "chat-s1", userId: "u1" };

test("open 回执自带 pageState（打开即观察）", async () => {
  const state = { url: "https://www.example.com/", body: "首页" };
  const service = makeService(makeFakePage(state));
  try {
    const opened = await service.open(ctx, state.url);
    assert.equal(opened.ok, true);
    const rec = opened as unknown as Record<string, unknown>;
    const pageState = rec.pageState as { url?: string; title?: string } | undefined;
    assert.ok(pageState, "open 回执必须带 pageState");
    assert.equal(pageState.url, state.url);
    assert.equal(pageState.title, "测试页");
  } finally {
    await service.dispose();
  }
});

test("click 成功回执带跳转后的 pageState（行动+观察合一）", async () => {
  const state = { url: "https://www.example.com/", body: "首页" };
  const service = makeService(makeFakePage(state));
  try {
    const opened = await service.open(ctx, state.url);
    assert.equal(opened.ok, true);
    const sessionId = String((opened as unknown as Record<string, unknown>).sessionId);

    const clicked = await service.click(ctx, sessionId, "#submit");
    assert.equal(clicked.ok, true);
    const rec = clicked as unknown as Record<string, unknown>;
    const pageState = rec.pageState as { url?: string } | undefined;
    assert.ok(pageState, "click 成功回执必须带 pageState");
    assert.equal(pageState.url, "https://www.example.com/result?q=x", "pageState 是跳转后的新页面");
    const hint = String(rec.hint ?? "");
    assert.ok(hint.includes("pageState"), "成功 hint 指引直接用 ref 继续");
  } finally {
    await service.dispose();
  }
});

test("click 失败：错误 + pageState 一起回喂（自纠正回路）", async () => {
  const state = { url: "https://www.example.com/", body: "首页" };
  const service = makeService(
    makeFakePage(state, { clickError: new Error("Timeout 15000ms exceeded waiting for #missing") }),
  );
  try {
    const opened = await service.open(ctx, state.url);
    assert.equal(opened.ok, true);
    const sessionId = String((opened as unknown as Record<string, unknown>).sessionId);

    const clicked = await service.click(ctx, sessionId, "#missing");
    assert.equal(clicked.ok, false);
    const rec = clicked as unknown as Record<string, unknown>;
    assert.ok(rec.error, "失败回执带错误原因");
    assert.equal(rec.retryable, true);
    assert.ok(rec.pageState, "自纠正回路：失败回执必须附当前页面元素表");
    const hint = String(rec.hint ?? "");
    assert.ok(hint.includes("ref"), "失败 hint 指引换 ref 重试而非盲试");
  } finally {
    await service.dispose();
  }
});

test("会话级错误（会话不存在）不带 pageState", async () => {
  const state = { url: "https://www.example.com/", body: "首页" };
  const service = makeService(makeFakePage(state));
  try {
    const clicked = await service.click(ctx, "no-such-session", "#x");
    assert.equal(clicked.ok, false);
    const rec = clicked as unknown as Record<string, unknown>;
    assert.equal(rec.pageState, undefined, "没有会话就没有可观察的页面");
  } finally {
    await service.dispose();
  }
});
