/**
 * 手机端卡内扫码登录 → 同意卡 → Cookie 落库 回归测试（2026-11-10）。
 *
 * 背景：手机端没有内置浏览器（桌面 WebView2 专属），登录的唯一通道是
 * card.action 卡链：比价卡「就这家」→ shopping.place.start → 登录卡（码内嵌）
 * → shopping.login.check → 同意卡（保存/不保存）→ shopping.login.consent
 * → settleLoginConsent。这条链路**不依赖桌面桥**（consent 走 ToolContext 的
 * actorId，不走 SharedBrowserCoordinator 的 executor socket），本测试用假
 * 浏览器执行器（headless lease）证明：
 *   1. 无桌面桥时 beginLoginHandoff 照常出码（headless 截码）；
 *   2. checkLoginHandoff 首次扫码 → needsConsent=true（consent 停在 ask，
 *      不静默落库——2026-10-25 拍板：存 Cookie 须用户同意）；
 *   3. 用户点「保存登录」→ 统一授权落库（ALL_SITES）+ 本次 Cookie 落库，
 *      hasLoginCookies 立即为 true（下一单免扫码）；
 *   4. card.action 线协议：save=false 的答复不落库、consent 仍是 ask，
 *      且递归续跑原动作（回登录卡）而不是把用户晾在原地。
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { WebSocket } from "ws";

import { BrowserSessionService } from "../src/services/browser-session-service.js";
import { ShoppingOrderService } from "../src/services/shopping-order-service.js";
import type { BrowserRuntime } from "../src/services/browser-runtime/browser-runtime.js";
import { handleCardActionEvent } from "../src/ws/handlers/card-action.js";

// ---------- 假浏览器层（headless lease，页面恒为京东登录页） ----------

const FAKE_JD_COOKIES = [
  {
    name: "pt_pin",
    value: "testuser",
    domain: ".jd.com",
    path: "/",
    expires: -1,
    httpOnly: true,
    secure: true,
    sameSite: "None" as const,
  },
];

type RecordedCall = { method: string; args: unknown[] };

function makeFakePage() {
  const calls: RecordedCall[] = [];
  const page = {
    url: () => "https://passport.jd.com/new/login.aspx",
    waitForTimeout: async () => {},
    // captureQrFocused / detectLoginPage 的 evaluate：找不到码元素（走整屏截图兜底）
    evaluate: async () => false,
    $: async () => null,
    screenshot: async () => Buffer.alloc(32, 7),
    context: () => ({
      cookies: async (_url?: string) => FAKE_JD_COOKIES.map((c) => ({ ...c })),
    }),
    _calls: calls,
  };
  return page;
}

function makeFakeExecutor() {
  const releases: number[] = [];
  const acquirePage = async () => {
    const page = makeFakePage();
    return {
      page,
      mode: "headless" as const,
      release: async () => {
        releases.push(1);
      },
    };
  };
  return {
    runtime: { acquirePage } as unknown as BrowserRuntime,
    releases,
  };
}

function makeCtx() {
  return { sessionId: "s-consent", userId: "u-consent-mobile" };
}

async function withTempDataDir<T>(fn: () => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "shopping-consent-"));
  const prev = process.env.BROWSER_SESSION_DATA_DIR;
  process.env.BROWSER_SESSION_DATA_DIR = dir;
  try {
    return await fn();
  } finally {
    if (prev == null) delete process.env.BROWSER_SESSION_DATA_DIR;
    else process.env.BROWSER_SESSION_DATA_DIR = prev;
    await rm(dir, { recursive: true, force: true });
  }
}

type SentFrame = { type: string; payload: Record<string, unknown> };

function makeFakeSocket() {
  const sent: SentFrame[] = [];
  const socket = {
    send: (raw: string) => {
      sent.push(JSON.parse(raw) as SentFrame);
    },
  } as unknown as WebSocket;
  return { socket, sent };
}

test("无桌面桥：卡内扫码 → 同意卡 → 保存后统一授权 + Cookie 落库 + 免扫码", async () => {
  await withTempDataDir(async () => {
    const sessionService = new BrowserSessionService();
    const { runtime } = makeFakeExecutor();
    const service = new ShoppingOrderService({
      browserSessionService: sessionService,
      browserExecutor: runtime,
      imageStore: {
        savePng: async () => "/agent/images/test-qr.png",
      },
      // 故意不传 askSaveLoginConsent：模拟手机端（桌面桥不在线，弹条发不出去）
    });
    const ctx = makeCtx();
    const actorId = ctx.userId!;

    // 1) 卡内下单 → 未登录 → 卡内出码（headless 截码，不依赖任何客户端桥）
    const handoff = await service.beginLoginHandoff(
      ctx,
      "jd",
      "https://item.jd.com/1000.html",
      { force: true },
    );
    assert.equal(handoff.ok, true);
    if (!("token" in handoff) || !handoff.token) {
      assert.fail("应返回 pendingLogin token");
    }
    assert.ok(handoff.imageUrl, "headless 登录页应截到二维码供卡内展示");

    // 2) 首次扫码：consent 仍是 ask → 只确认登录、不落库，转同意卡
    const checked = await service.checkLoginHandoff(ctx, handoff.token);
    assert.deepEqual(checked, { ok: true, needsConsent: true });
    assert.equal(await sessionService.getCaptureConsent(actorId, "jd"), "ask");
    assert.equal(await service.hasLoginCookies(ctx, "jd"), false);

    // 3) 用户点「保存登录」（card.action 的 settleLoginConsent）：
    //    统一授权（ALL_SITES）落库 + 本次 Cookie 落库
    const settled = await service.settleLoginConsent(ctx, handoff.token, true);
    assert.deepEqual(settled, { ok: true });
    assert.equal(await sessionService.getCaptureConsent(actorId, "jd"), "allow");
    assert.equal(
      await sessionService.getCaptureConsent(actorId, "taobao"),
      "allow",
      "统一授权对所有平台生效",
    );
    assert.equal(await service.hasLoginCookies(ctx, "jd"), true, "保存后本平台免扫码");

    await service.dispose();
  });
});

test("card.action 线协议：不保存 → consent 仍是 ask，原动作续跑回登录卡", async () => {
  await withTempDataDir(async () => {
    const sessionService = new BrowserSessionService();
    const { runtime } = makeFakeExecutor();
    const service = new ShoppingOrderService({
      browserSessionService: sessionService,
      browserExecutor: runtime,
      imageStore: {
        savePng: async () => "/agent/images/test-qr.png",
      },
    });
    const ctx = makeCtx();
    const actorId = ctx.userId!;

    const handoff = await service.beginLoginHandoff(
      ctx,
      "jd",
      "https://item.jd.com/1000.html",
      { force: true },
    );
    assert.equal(handoff.ok, true);
    if (!("token" in handoff) || !handoff.token) assert.fail("应返回 token");
    const token = handoff.token;

    const checked = await service.checkLoginHandoff(ctx, token);
    assert.deepEqual(checked, { ok: true, needsConsent: true });

    const { socket, sent } = makeFakeSocket();
    const handled = await handleCardActionEvent(
      { socket, boundActorId: actorId, sendUnifiedError: () => {} },
      {
        messageId: "msg-1",
        cardId: "card-1",
        actionId: "shopping.login.consent",
        payload: {
          token,
          save: false,
          platform: "jd",
          item: "https://item.jd.com/1000.html",
          quantity: 1,
          nextAction: "shopping.place.start",
        },
      },
      { shoppingOrderService: service },
    );
    assert.equal(handled, true);

    const first = sent[0];
    assert.ok(first, "应回 card.update");
    assert.equal(first.type, "card.update");
    assert.equal(first.payload.ok, true);
    // 不保存：consent 原样保留（下次登录还会问），Cookie 不落库
    assert.equal(await sessionService.getCaptureConsent(actorId, "jd"), "ask");
    assert.equal(await service.hasLoginCookies(ctx, "jd"), false);

    await service.dispose();
  });
});
