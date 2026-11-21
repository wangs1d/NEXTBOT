/**
 * 多平台登录判定闸门回归测试（2026-11-21）。
 *
 * 用户反馈「手机显示登录了、云端浏览器没变化」——根因是 checkMultiPlatformLogin
 * 用「留驻页 URL 离开登录页」就判成功，而扫码落地页 down_scan.html / 风控跳转
 * 都会让页面跳走，context 里其实没有登录 Cookie（无 PDDUserID）。
 *
 * 修复：有正向 Cookie marker 的平台（pdd/jd/taobao…）必须读到真实登录 Cookie
 * 才算就绪；URL 逃逸只对「本来就没有 marker」的平台保留兜底。
 */
import assert from "node:assert/strict";
import test from "node:test";

import { ShoppingOrderService } from "../src/services/shopping-order-service.js";

type Cookie = { name: string; value: string; domain: string; path: string };

function makeService(opts: {
  cookieNames: string[];
  pageLeftLogin: boolean;
}): ShoppingOrderService {
  const cookies: Cookie[] = opts.cookieNames.map((name) => ({
    name,
    value: "v",
    domain: ".yangkeduo.com",
    path: "/",
  }));
  const browserExecutor = {
    readContextCookies: async () => cookies,
  };
  const browserSessionService = {
    getCookiesForAgent: async () => [], // 库里没有 → 逼判定走 context 实时路径
    getCaptureConsent: async () => "unset",
    updateCookiesFromLogin: async () => {},
  };
  // heldQrPageLeftLogin 依赖 qrWaitPages 里的 lease；注入一个假 lease + 假 page
  const heldPage = {
    isClosed: () => false,
    url: () => (opts.pageLeftLogin ? "https://mobile.yangkeduo.com/down_scan.html" : "https://mobile.yangkeduo.com/login.html"),
    evaluate: async () => "请用拼多多App扫码登录",
  };
  const svc = new ShoppingOrderService({
    browserSessionService: browserSessionService as never,
    browserExecutor: browserExecutor as never,
  });
  // 注入留驻页：holdQrPage 的 key = `${actorId}:${platform}`
  (svc as unknown as { qrWaitPages: Map<string, unknown> }).qrWaitPages.set(
    "u-t:pdd",
    {
      lease: { page: heldPage, release: async () => {} },
      timer: { unref: () => {} },
      preview: undefined,
    },
  );
  return svc;
}

const ctx = { sessionId: "s", userId: "u-t" } as never;

test("pdd 有 marker：页面跳走但 context 无登录 Cookie → 判未登录（不误报成功）", async () => {
  const svc = makeService({ cookieNames: ["api_uid", "_nano_fp"], pageLeftLogin: true });
  const res = await svc.checkMultiPlatformLogin(ctx, ["pdd"]);
  assert.deepEqual(res.ready, [], "无 PDDUserID → 不能因为页面跳走就判成功");
  assert.deepEqual(res.pending, ["pdd"]);
});

test("pdd 有 marker：context 读到 PDDUserID → 判已登录", async () => {
  const svc = makeService({ cookieNames: ["api_uid", "PDDUserID"], pageLeftLogin: false });
  const res = await svc.checkMultiPlatformLogin(ctx, ["pdd"]);
  assert.deepEqual(res.ready, ["pdd"], "真实登录 Cookie 命中 → 就绪");
  assert.deepEqual(res.pending, []);
});

test("无 marker 平台：页面跳走仍可兜底判已登录（保留旧语义）", async () => {
  const svc = makeService({ cookieNames: ["some_anon_cookie"], pageLeftLogin: true });
  // dianping 无 LOGIN_COOKIE_MARKERS，注入它的留驻页
  (svc as unknown as { qrWaitPages: Map<string, unknown> }).qrWaitPages.set(
    "u-t:dianping",
    {
      lease: {
        page: {
          isClosed: () => false,
          url: () => "https://www.dianping.com/",
          evaluate: async () => "",
        },
        release: async () => {},
      },
      timer: { unref: () => {} },
      preview: undefined,
    },
  );
  const res = await svc.checkMultiPlatformLogin(ctx, ["dianping"]);
  assert.deepEqual(res.ready, ["dianping"], "无 marker 平台靠 URL 逃逸兜底");
});

test("pdd 有 marker：页面还在登录页且无 Cookie → 判未登录", async () => {
  const svc = makeService({ cookieNames: [], pageLeftLogin: false });
  const res = await svc.checkMultiPlatformLogin(ctx, ["pdd"]);
  assert.deepEqual(res.ready, []);
  assert.deepEqual(res.pending, ["pdd"]);
});
