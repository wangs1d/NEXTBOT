/**
 * SharedBrowserCoordinator 单测：
 *   - 离线调用立即失败（不排队、不抛错）
 *   - invoke/result 按 jobId + actorId + socket 三重配对
 *   - 超时兜底（retryable=true）
 *   - socket 断开清理挂起任务 + 解绑
 *   - 绑定校验：不匹配的 actorId/socket 无法提交结果
 */
import assert from "node:assert/strict";
import test from "node:test";

import { SharedBrowserCoordinator } from "../src/services/shared-browser-coordinator.js";
import type { WsSendLike } from "../src/services/shared-browser-coordinator.js";

function fakeSocket(sent: object[] = []): WsSendLike & { sent: object[] } {
  const socket = {
    sent,
    send(data: string) {
      sent.push(JSON.parse(data));
    },
  };
  return socket as WsSendLike & { sent: object[] };
}

test("offline invoke fails fast with clear error", async () => {
  const c = new SharedBrowserCoordinator();
  const r = await c.invoke("actor-1", "navigate", { url: "https://example.com" });
  assert.equal(r.ok, false);
  assert.match(String(r.error), /offline/);
  assert.equal(c.hasExecutor("actor-1"), false);
});

test("invoke sends payload and result pairs by jobId", async () => {
  const c = new SharedBrowserCoordinator();
  const sent: object[] = [];
  const socket = fakeSocket(sent);
  c.bindExecutor("actor-1", socket);

  const pending = c.invoke("actor-1", "read_page", { includeInteractive: true }, { timeoutMs: 5000 });
  assert.equal(sent.length, 1);
  const frame = sent[0] as { type: string; payload: { jobId: string; action: string; params: Record<string, unknown> } };
  assert.equal(frame.type, "shared.browser.invoke");
  assert.equal(frame.payload.action, "read_page");
  assert.equal(frame.payload.params.includeInteractive, true);

  const delivered = c.completeFromSocket("actor-1", socket, frame.payload.jobId, {
    ok: true,
    url: "https://example.com/",
    title: "Example",
  });
  assert.equal(delivered, true);
  const result = await pending;
  assert.equal(result.ok, true);
  assert.equal(result.title, "Example");
});

test("completeFromSocket rejects mismatched actor or socket", async () => {
  const c = new SharedBrowserCoordinator();
  const socket = fakeSocket();
  c.bindExecutor("actor-1", socket);

  const pending = c.invoke("actor-1", "click", {}, 5000);
  const jobId = (socket.sent[0] as { payload: { jobId: string } }).payload.jobId;

  // 错误 socket / 错误 actor / 未知 jobId 都必须拒绝
  assert.equal(c.completeFromSocket("actor-1", fakeSocket(), jobId, { ok: true }), false);
  assert.equal(c.completeFromSocket("actor-2", socket, jobId, { ok: true }), false);
  assert.equal(c.completeFromSocket("actor-1", socket, "no-such-job", { ok: true }), false);

  assert.equal(c.completeFromSocket("actor-1", socket, jobId, { ok: true }), true);
  assert.equal((await pending).ok, true);
});

test("invoke times out with retryable error", async () => {
  const c = new SharedBrowserCoordinator();
  c.bindExecutor("actor-1", fakeSocket());
  const result = await c.invoke("actor-1", "navigate", { url: "https://example.com" }, 30);
  assert.equal(result.ok, false);
  assert.match(String(result.error), /timeout/);
  assert.equal(result.retryable, true);
});

test("socket disconnect unbinds and fails pending jobs", async () => {
  const c = new SharedBrowserCoordinator();
  const socket = fakeSocket();
  c.bindExecutor("actor-1", socket);

  const pending = c.invoke("actor-1", "type", { text: "hi" }, 30_000);
  assert.equal(c.unbindIfSocket("actor-1", socket), true);
  const result = await pending;
  assert.equal(result.ok, false);
  assert.match(String(result.error), /disconnect/);
  assert.equal(c.hasExecutor("actor-1"), false);
  // 重复解绑返回 false
  assert.equal(c.unbindIfSocket("actor-1", socket), false);
});

test("re-bind overwrites stale executor socket", async () => {
  const c = new SharedBrowserCoordinator();
  const oldSocket = fakeSocket();
  const newSocket = fakeSocket();
  c.bindExecutor("actor-1", oldSocket);
  c.bindExecutor("actor-1", newSocket);

  const pending = c.invoke("actor-1", "scroll", {}, 5000);
  // invoke 只发新 socket；拿新 jobId 用旧 socket 提交必须被拒
  const newJobId = (newSocket.sent[0] as { payload: { jobId: string } }).payload.jobId;
  assert.equal(c.completeFromSocket("actor-1", oldSocket, newJobId, { ok: true }), false);
  assert.equal(c.completeFromSocket("actor-1", newSocket, newJobId, { ok: true }), true);
  assert.equal((await pending).ok, true);
});

// ── 风险确认门（gate）与 CDP 端点登记 ──────────────────────────────

test("high-risk click attaches gate; low-risk invoke omits it", async () => {
  const c = new SharedBrowserCoordinator();
  const sent: object[] = [];
  const socket = fakeSocket(sent);
  c.bindExecutor("actor-1", socket);

  const pending = c.invoke(
    "actor-1",
    "click",
    { text: "提交订单" },
    { gate: { level: "high", reason: "目标疑似提交/支付类操作", targetSummary: "提交订单" } },
  );
  const frame = sent[0] as { payload: { gate?: Record<string, unknown> } };
  assert.equal(frame.payload.gate?.required, true);
  assert.equal(frame.payload.gate?.level, "high");
  c.completeFromSocket("actor-1", socket, (frame as never as { payload: { jobId: string } }).payload.jobId, { ok: true });
  await pending;

  sent.length = 0;
  const pending2 = c.invoke("actor-1", "click", { text: "下一页" });
  const frame2 = sent[0] as { payload: { gate?: unknown } };
  assert.equal(frame2.payload.gate, undefined);
  c.completeFromSocket("actor-1", socket, (frame2 as never as { payload: { jobId: string } }).payload.jobId, { ok: true });
  await pending2;
});

test("timeout audit path: invoke timeout resolves retryable", async () => {
  const c = new SharedBrowserCoordinator();
  const socket = fakeSocket();
  c.bindExecutor("actor-1", socket);
  const pending = c.invoke("actor-1", "read_page", {}, { timeoutMs: 30 });
  const r = await pending;
  assert.equal(r.ok, false);
  assert.match(String(r.error), /timeout/);
  assert.equal(r.retryable, true);
});

test("cdp endpoint set/get and cleared on unbind", async () => {
  const c = new SharedBrowserCoordinator();
  const socket = fakeSocket();
  c.bindExecutor("actor-1", socket);
  c.setCdpEndpoint("actor-1", "http://127.0.0.1:9222");
  assert.equal(c.cdpEndpoint("actor-1"), "http://127.0.0.1:9222");
  c.setCdpEndpoint("actor-1", ""); // 空串 = 清除
  assert.equal(c.cdpEndpoint("actor-1"), "");
  c.setCdpEndpoint("actor-1", "http://127.0.0.1:9223");
  c.unbindIfSocket("actor-1", socket);
  assert.equal(c.cdpEndpoint("actor-1"), "");
});

test("lastUrlSnapshot 带汇报时刻；about: 不记", () => {
  const c = new SharedBrowserCoordinator();
  const sent: object[] = [];
  const socket = fakeSocket(sent);
  c.bindExecutor("actor-1", socket);
  assert.equal(c.lastUrlSnapshot("actor-1"), null, "无上报返回 null");

  const before = Date.now();
  const job = c.invoke("actor-1", "navigate", { url: "https://www.fliggy.com/hotel/detail?id=1" }, { timeoutMs: 5000 });
  const frame = sent[0] as { payload: { jobId: string } };
  c.completeFromSocket("actor-1", socket, frame.payload.jobId, {
    ok: true,
    url: "https://www.fliggy.com/hotel/detail?id=1",
    title: "详情",
  });
  void job;
  const snapshot = c.lastUrlSnapshot("actor-1");
  assert.equal(snapshot?.url, "https://www.fliggy.com/hotel/detail?id=1");
  assert.ok((snapshot?.at ?? 0) >= before, "汇报时刻已记录");

  const job2 = c.invoke("actor-1", "navigate", { url: "about:blank" }, { timeoutMs: 5000 });
  const frame2 = sent[1] as { payload: { jobId: string } };
  c.completeFromSocket("actor-1", socket, frame2.payload.jobId, { ok: true, url: "about:blank" });
  void job2;
  assert.equal(c.lastUrl("actor-1"), "https://www.fliggy.com/hotel/detail?id=1", "about: 不覆盖真实页");
  socket;
});
