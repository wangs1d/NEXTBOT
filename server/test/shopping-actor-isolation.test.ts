/**
 * 跨用户隔离回归（2026-11-20）。
 *
 * 用户口径：「浏览器本来就该按用户隔离，登录态 Cookie 也是按用户隔离」。
 * 这里把「拿别人的 token 也不该生效」钉死——token 是随机 UUID，但"难猜"
 * 不是隔离：卡片会被转发、日志会带出 token、多端同账号也不该互相顶掉。
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { BrowserSessionService } from "../src/services/browser-session-service.js";
import { ShoppingOrderService } from "../src/services/shopping-order-service.js";
import type { BrowserRuntime } from "../src/services/browser-runtime/browser-runtime.js";

process.env.QR_CAPTURE_FAST = "1";

const FAKE_JD_COOKIES = [
  { name: "pt_pin", value: "u1", domain: ".jd.com", path: "/", expires: -1, httpOnly: true, secure: true },
];

function makeFakePage() {
  return {
    url: () => "https://passport.jd.com/new/login.aspx",
    waitForTimeout: async () => {},
    evaluate: async () => false,
    $: async () => null,
    screenshot: async () => Buffer.alloc(32, 7),
    context: () => ({ cookies: async () => FAKE_JD_COOKIES.map((c) => ({ ...c })) }),
  };
}

function makeFakeExecutor() {
  const acquirePage = async () => ({
    page: makeFakePage(),
    mode: "headless" as const,
    release: async () => {},
  });
  return { acquirePage } as unknown as BrowserRuntime;
}

async function withTempDataDir<T>(fn: () => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "shopping-isolation-"));
  const prev = process.env.BROWSER_SESSION_DATA_DIR;
  process.env.BROWSER_SESSION_DATA_DIR = dir;
  try {
    return await fn();
  } finally {
    if (prev == null) delete process.env.BROWSER_SESSION_DATA_DIR;
    else process.env.BROWSER_SESSION_DATA_DIR = prev;
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

test("别人的登录 token 不能校验、也不能替他落库", async () => {
  await withTempDataDir(async () => {
    const sessionService = new BrowserSessionService();
    const service = new ShoppingOrderService({
      browserSessionService: sessionService,
      browserExecutor: makeFakeExecutor(),
      imageStore: { savePng: async () => "/agent/images/x.png" },
    });

    const ownerCtx = { sessionId: "s-owner", userId: "u-owner" };
    const handoff = await service.beginLoginHandoff(ownerCtx, "jd", "https://item.jd.com/1.html", {
      force: true,
    });
    assert.equal(handoff.ok, true);
    const token = "token" in handoff ? handoff.token : undefined;
    assert.ok(token);

    // 另一个用户拿着同一个 token：一律当「已失效」，不泄露存在性
    const otherCtx = { sessionId: "s-other", userId: "u-other" };
    const checked = await service.checkLoginHandoff(otherCtx, token);
    assert.equal(checked.ok, false);
    assert.match(checked.ok === false ? checked.error : "", /失效/);

    // 更不能替别人同意 + 落库
    const settled = await service.settleLoginConsent(otherCtx, token, true);
    assert.equal(settled.ok, false);
    assert.equal(await sessionService.getCaptureConsent("u-other", "jd"), "ask");

    // 本人可以正常走
    const own = await service.checkLoginHandoff(ownerCtx, token);
    assert.equal(own.ok, true);
  });
});

test("没有 token 归属时不会把别人的 Cookie 写进自己账号", async () => {
  await withTempDataDir(async () => {
    const sessionService = new BrowserSessionService();
    const service = new ShoppingOrderService({
      browserSessionService: sessionService,
      browserExecutor: makeFakeExecutor(),
      imageStore: { savePng: async () => "/agent/images/x.png" },
    });
    // 直接给 u-other 授权，但从未有过登录会话：库里不该凭空出现 jd 的 Cookie
    await sessionService.setCaptureConsent("u-other", "jd", true);
    assert.equal(await service.hasLoginCookies({ sessionId: "s2", userId: "u-other" }, "jd"), false);
  });
});
