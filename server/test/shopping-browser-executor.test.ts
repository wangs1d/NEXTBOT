/**
 * 购物页面获取器 + 登录门 单元测试。
 *
 * 验证（不依赖真实客户端）：
 *   1. canUseSharedBrowser 三重条件（网关开关/执行端在线/CDP 端点上报）
 *   2. shared 可用时 acquirePage 走内置浏览器路径，release 只关标签页
 *   3. shared 不可用 + 无 Cookie + 不允许交互式登录 → 抛 no_cookie（不启动浏览器）
 *   4. preferHeadless 且无 Cookie → 回落 shared 可见浏览器
 *   5. 登录页 URL 启发式（jd passport 命中 / 订单页不命中 / 正文关键词兜底）
 *   5. waitForLogin：扫码后（URL 离开登录域）自动落回目标页
 *   6. Cookie value 非法字符提前报错（RFC 6265）
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { Page } from "playwright";

import { BrowserSessionService } from "../src/services/browser-session-service.js";
import { SharedBrowserCoordinator } from "../src/services/shared-browser-coordinator.js";
import { SharedBrowserCdpGateway } from "../src/services/shared-browser/cdp-gateway.js";
import {
  ShoppingBrowserExecutor,
  ShoppingPageUnavailableError,
} from "../src/services/shopping-platforms/browser-executor.js";
import {
  detectLoginPage,
  waitForLogin,
} from "../src/services/shopping-platforms/login-gate.js";

/** 可注入假行为的网关（绕过真实 CDP 连接）。 */
class FakeGateway extends SharedBrowserCdpGateway {
  openedUrls: string[] = [];
  closedCount = 0;
  private fakePage: Page;

  constructor(private readonly shouldConnect = true) {
    // available 与 shouldConnect 同源：false 即"总开关未开/桥不可用"
    super(shouldConnect);
    this.fakePage = {
      url: () => this.openedUrls[this.openedUrls.length - 1] ?? "about:blank",
      evaluate: async () => "",
      waitForTimeout: async () => {},
      goto: async () => null,
      isClosed: () => false,
      close: async () => {},
    } as unknown as Page;
  }

  async connect(): Promise<boolean> {
    return this.shouldConnect;
  }

  async openPage(url: string): Promise<Page> {
    this.openedUrls.push(url);
    return this.fakePage;
  }

  async closePage(): Promise<void> {
    this.closedCount += 1;
  }
}

/** 构造 executor 及其依赖（shared 是否可用由参数控制）。 */
function makeExecutor(opts: { sharedAvailable?: boolean } = {}) {
  const coordinator = new SharedBrowserCoordinator();
  const gateway = new FakeGateway(opts.sharedAvailable ?? false);
  const browserSessionService = new BrowserSessionService();
  const executor = new ShoppingBrowserExecutor({
    coordinator,
    gateway: gateway as unknown as SharedBrowserCdpGateway,
    browserSessionService,
  });
  return { coordinator, gateway, executor, browserSessionService };
}

test("canUseSharedBrowser requires gateway available + executor bound + cdp endpoint", async () => {
  const { coordinator, gateway, executor } = makeExecutor({ sharedAvailable: true });
  const actor = "u-shared-check";

  assert.equal(executor.canUseSharedBrowser(actor), false, "未绑定执行端时不可用");

  coordinator.bindExecutor(actor, { send: () => {} });
  assert.equal(executor.canUseSharedBrowser(actor), false, "绑定但未上报 CDP 端点时不可用");

  coordinator.setCdpEndpoint(actor, "http://127.0.0.1:9222");
  assert.equal(executor.canUseSharedBrowser(actor), true, "三重条件齐备后可用");

  const disabled = makeExecutor({ sharedAvailable: false });
  disabled.coordinator.bindExecutor(actor, { send: () => {} });
  disabled.coordinator.setCdpEndpoint(actor, "http://127.0.0.1:9222");
  assert.equal(
    (disabled.gateway as unknown as SharedBrowserCdpGateway).available,
    false,
    "SHARED_BROWSER_CDP_ENABLED 未开时 gateway.available=false",
  );
});

test("acquirePage uses shared browser when available; release closes only the tab", async () => {
  const { coordinator, gateway, executor } = makeExecutor({ sharedAvailable: true });
  const actor = "u-shared-lease";
  coordinator.bindExecutor(actor, { send: () => {} });
  coordinator.setCdpEndpoint(actor, "http://127.0.0.1:9222");

  const lease = await executor.acquirePage(actor, "jd", "https://order.jd.com/center/list.action");
  assert.equal(lease.mode, "shared");
  assert.equal(gateway.openedUrls[0], "https://order.jd.com/center/list.action");

  await lease.release();
  assert.equal(gateway.closedCount, 1, "shared release 只关闭自己开的标签页");
});

test("acquirePage throws no_cookie before launching browser when no cookie and not interactive", async () => {
  const { executor } = makeExecutor({ sharedAvailable: false });
  await assert.rejects(
    executor.acquirePage("u-no-cookie", "jd", "https://order.jd.com/center/list.action", {
      interactiveLogin: false,
    }),
    (err: unknown) => {
      assert.ok(err instanceof ShoppingPageUnavailableError);
      assert.equal((err as ShoppingPageUnavailableError).kind, "no_cookie");
      assert.match(err.message, /未导入 jd 的 Cookie/);
      assert.match(err.message, /内置浏览器/);
      return true;
    },
  );
});

test("preferHeadless 且无 Cookie 时回落 shared 可见浏览器", async () => {
  const { coordinator, gateway, executor } = makeExecutor({ sharedAvailable: true });
  const actor = "u-prefer-headless";
  coordinator.bindExecutor(actor, { send: () => {} });
  coordinator.setCdpEndpoint(actor, "http://127.0.0.1:9222");

  const lease = await executor.acquirePage(actor, "jd", "https://search.jd.com/Search?keyword=x", {
    preferHeadless: true,
    interactiveLogin: false,
  });
  assert.equal(lease.mode, "shared");
  assert.equal(gateway.openedUrls[0], "https://search.jd.com/Search?keyword=x");
  await lease.release();
});

test("detectLoginPage URL heuristics (jd login page vs order page) + body keyword fallback", async () => {
  const loginPage = {
    url: () => "https://passport.jd.com/new/login.aspx?ReturnUrl=https%3A%2F%2Forder.jd.com",
    evaluate: async () => "",
  } as unknown as Page;
  const det = await detectLoginPage("jd", loginPage);
  assert.equal(det.isLogin, true);

  const orderPage = {
    url: () => "https://order.jd.com/center/list.action",
    evaluate: async () => "我的订单 全部订单 待收货",
  } as unknown as Page;
  assert.equal((await detectLoginPage("jd", orderPage)).isLogin, false);

  const bodyLoginPage = {
    url: () => "https://misc.example.com/gate",
    evaluate: async () => "京东APP扫码登录 打开 京东APP 点左上角扫一扫",
  } as unknown as Page;
  const det3 = await detectLoginPage("jd", bodyLoginPage);
  assert.equal(det3.isLogin, true);
  assert.match(det3.reason ?? "", /扫码登录/);
});

test("waitForLogin resumes to target url after user scans (url leaves login domain)", async () => {
  let polls = 0;
  let target = "";
  const page = {
    url: () => (polls < 2 ? "https://passport.jd.com/new/login.aspx" : "https://home.jd.com/"),
    evaluate: async () => "",
    waitForTimeout: async () => {
      polls += 1;
    },
    goto: async (url: string) => {
      target = url;
      return null;
    },
  } as unknown as Page;
  const res = await waitForLogin("jd", page, "https://order.jd.com/center/list.action", {
    timeoutMs: 5_000,
    intervalMs: 10,
  });
  assert.equal(res.ok, true);
  assert.equal(target, "https://order.jd.com/center/list.action", "登录成功后落回目标页");
});

test("waitForLogin times out with readable error", async () => {
  const page = {
    url: () => "https://passport.jd.com/new/login.aspx",
    evaluate: async () => "",
    waitForTimeout: async () => {},
  } as unknown as Page;
  const res = await waitForLogin("jd", page, "https://order.jd.com", { timeoutMs: 120, intervalMs: 30 });
  assert.equal(res.ok, false);
  assert.match(res.error ?? "", /等待扫码登录超时/);
});

test("importCookies rejects invalid cookie value chars with readable error", async () => {
  const dir = await mkdtemp(join(tmpdir(), "browser-session-invalid-"));
  const prev = process.env.BROWSER_SESSION_DATA_DIR;
  process.env.BROWSER_SESSION_DATA_DIR = dir;
  try {
    const service = new BrowserSessionService();
    await assert.rejects(
      service.importCookies("u-invalid", "jd", [
        { name: "pt_pin", value: "test_user; path=/" },
      ] as never),
      (err: unknown) => {
        assert.match(err instanceof Error ? err.message : String(err), /非法字符|导出格式/);
        return true;
      },
    );
  } finally {
    if (prev == null) delete process.env.BROWSER_SESSION_DATA_DIR;
    else process.env.BROWSER_SESSION_DATA_DIR = prev;
    await rm(dir, { recursive: true, force: true });
  }
});

test("updateCookiesFromLogin: scan creates authorized row; refresh never downgrades; explicit true upgrades", async () => {
  const dir = await mkdtemp(join(tmpdir(), "browser-session-capture-"));
  const prev = process.env.BROWSER_SESSION_DATA_DIR;
  process.env.BROWSER_SESSION_DATA_DIR = dir;
  try {
    const service = new BrowserSessionService();
    const sample = [{ name: "pt_key", value: "AAJgSAMPLE", domain: ".jd.com", path: "/" }];

    // 1) 扫码捕获（新行 + 显式授权）→ agentAllowed=true
    await service.updateCookiesFromLogin("u-perm", "jd", sample, { agentAllowed: true });
    // 2) 运行期刷新回写（不传 opts）→ 授权保持，Cookie 刷新，绝不被重置
    await service.updateCookiesFromLogin("u-perm", "jd", [
      { name: "pt_key", value: "AAJgREFRESHED", domain: ".jd.com", path: "/" },
    ]);
    let jd = (await service.listStatuses("u-perm")).find((s) => s.siteId === "jd");
    assert.equal(jd?.agentAllowed, true, "刷新回写不得降级已授权状态");
    assert.equal(jd?.hasCookies, true);
    const cookies = await service.getCookiesForAgent("u-perm", "jd");
    assert.ok(cookies.some((c) => c.name === "pt_key" && c.value === "AAJgREFRESHED"), "刷新后的 Cookie 可读");

    // 3) 手动导入但未授权的行 → 捕获不带 opts 不得静默升权
    await service.importCookies("u-noauth", "jd", sample);
    await service.updateCookiesFromLogin("u-noauth", "jd", sample);
    jd = (await service.listStatuses("u-noauth")).find((s) => s.siteId === "jd");
    assert.equal(jd?.agentAllowed, false, "未授权行不得被捕获静默升权");

    // 4) 显式传 true 才升权（用户扫码/本人登录场景由调用方保证）
    await service.updateCookiesFromLogin("u-noauth", "jd", sample, { agentAllowed: true });
    jd = (await service.listStatuses("u-noauth")).find((s) => s.siteId === "jd");
    assert.equal(jd?.agentAllowed, true, "显式授权后升级为 true");
  } finally {
    if (prev == null) delete process.env.BROWSER_SESSION_DATA_DIR;
    else process.env.BROWSER_SESSION_DATA_DIR = prev;
    await rm(dir, { recursive: true, force: true });
  }
});
