/**
 * 手动导入 Cookie 链路回归测试（2026-11-21）。
 *
 * 扫码授权被平台风控拦死（拼多多不向无头浏览器兑现登录态），登录入口改为
 * 「用户在自己浏览器导出 Cookie → 粘贴导入 → 问是否保存 → 保存永久使用 /
 * 仅本次」。这里锁三段：
 *   1. parseCookieHeaderText：三种粘贴形态（Header 串 / Cookie: 前缀 /
 *      JSON 数组）与错误路径；
 *   2. prepareCookieImport：登录标记软校验（没登录标记不放进「保存」卡）；
 *   3. applyCookieImport：save=true 落库并授权（getCookiesForAgent 立即可用，
 *      比价免扫码）；save=false 不落库、灌 context。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseCookieHeaderText } from "../src/services/cookie-text-parser.js";
import { ShoppingOrderService } from "../src/services/shopping-order-service.js";
import { BrowserSessionService } from "../src/services/browser-session-service.js";
import { handleCardActionEvent } from "../src/ws/handlers/card-action.js";

// ---------- 1. 文本解析 ----------

test("parse：标准 Header 串（k=v; k2=v2）", () => {
  const res = parseCookieHeaderText("api_uid=a1; PDDUserID=U123; _nano_fp=nfp");
  assert.ok(res.ok);
  if (!res.ok) return;
  assert.deepEqual(
    res.cookies.map((c) => c.name),
    ["api_uid", "PDDUserID", "_nano_fp"],
  );
  assert.equal(res.cookies[1].value, "U123");
});

test("parse：带 Cookie: 前缀 + 多行", () => {
  const res = parseCookieHeaderText("Cookie: a=1; b=2\n;c=3");
  assert.ok(res.ok);
  if (!res.ok) return;
  assert.deepEqual(
    res.cookies.map((c) => c.name),
    ["a", "b", "c"],
  );
});

test("parse：value 里带等号（按第一个 = 切）", () => {
  const res = parseCookieHeaderText("token=abc=def=ghi");
  assert.ok(res.ok);
  if (!res.ok) return;
  assert.equal(res.cookies[0].value, "abc=def=ghi");
});

test("parse：Cookie 导出插件的 JSON 数组", () => {
  const res = parseCookieHeaderText(
    '[{"name":"PDDUserID","value":"U9","domain":".yangkeduo.com"},{"name":"api_uid","value":"x"}]',
  );
  assert.ok(res.ok);
  if (!res.ok) return;
  assert.equal(res.cookies.length, 2);
  assert.equal(res.cookies[0].domain, ".yangkeduo.com");
});

test("parse：空串 / 纯垃圾 → 可读报错", () => {
  const empty = parseCookieHeaderText("   ");
  assert.ok(!empty.ok);
  const garbage = parseCookieHeaderText("这不是cookie内容。");
  assert.ok(!garbage.ok);
  if (!garbage.ok) {
    assert.ok(garbage.error.includes("k=v"), "报错要指引正确格式");
  }
});

// ---------- 2/3. ShoppingOrderService 校验与应用 ----------

const ACTOR = "u-import";

function makeService(opts: {
  sessionService: BrowserSessionService;
  primeCalls?: Array<{ actorId: string; siteId: string; url: string; cookies: number }>;
}): ShoppingOrderService {
  const browserExecutor = {
    primeContextCookies: async (actorId: string, siteId: string, url: string, cookies: unknown[]) => {
      opts.primeCalls?.push({ actorId, siteId, url, cookies: cookies.length });
      return true;
    },
  };
  return new ShoppingOrderService({
    browserSessionService: opts.sessionService as never,
    browserExecutor: browserExecutor as never,
  });
}

test("prepare：含 PDDUserID → 软校验通过并点名登录标记", () => {
  const svc = makeService({ sessionService: new BrowserSessionService() });
  const res = svc.prepareCookieImport("pdd", "api_uid=x; PDDUserID=U1");
  assert.ok(res.ok);
  if (!res.ok) return;
  assert.equal(res.markerFound, true);
  assert.deepEqual(res.markerNames, ["PDDUserID"]);
  assert.equal(res.cookies.length, 2);
});

test("prepare：无登录标记 → markerFound=false（不进「保存」卡）", () => {
  const svc = makeService({ sessionService: new BrowserSessionService() });
  const res = svc.prepareCookieImport("pdd", "api_uid=x; _nano_fp=y");
  assert.ok(res.ok);
  if (!res.ok) return;
  assert.equal(res.markerFound, false, "没登录态的 Cookie 不能被当成登录态保存");
});

test("apply save=true：落库 + 立即授权，getCookiesForAgent 可用", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cookie-import-"));
  process.env.BROWSER_SESSION_DATA_DIR = dir;
  try {
    const sessionService = new BrowserSessionService();
    const svc = makeService({ sessionService });
    const prepared = svc.prepareCookieImport("pdd", "api_uid=x; PDDUserID=U1");
    assert.ok(prepared.ok);
    if (!prepared.ok) return;
    const applied = await svc.applyCookieImport(ACTOR, "pdd", prepared.cookies, true);
    assert.ok(applied.ok);
    if (!applied.ok) return;
    assert.equal(applied.saved, true);
    // 比价链路消费口：授权 Cookie 立即可取
    const got = await sessionService.getCookiesForAgent(ACTOR, "pdd");
    assert.deepEqual(
      got.map((c) => c.name),
      ["api_uid", "PDDUserID"],
    );
    const statuses = await sessionService.listStatuses(ACTOR);
    const pdd = statuses.find((s) => s.siteId === "pdd");
    assert.equal(pdd?.agentAllowed, true, "导入即授权（用户本人的导入动作即授权）");
    assert.equal(pdd?.hasCookies, true);
  } finally {
    delete process.env.BROWSER_SESSION_DATA_DIR;
  }
});

test("apply save=false：不落库，灌 context（primeContextCookies）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cookie-import-"));
  process.env.BROWSER_SESSION_DATA_DIR = dir;
  const primeCalls: Array<{ actorId: string; siteId: string; url: string; cookies: number }> = [];
  try {
    const sessionService = new BrowserSessionService();
    const svc = makeService({ sessionService, primeCalls });
    const prepared = svc.prepareCookieImport("pdd", "api_uid=x; PDDUserID=U1");
    assert.ok(prepared.ok);
    if (!prepared.ok) return;
    const applied = await svc.applyCookieImport(ACTOR, "pdd", prepared.cookies, false);
    assert.ok(applied.ok);
    if (!applied.ok) return;
    assert.equal(applied.saved, false);
    assert.equal(primeCalls.length, 1);
    assert.equal(primeCalls[0].actorId, ACTOR);
    assert.equal(primeCalls[0].siteId, "pdd");
    assert.equal(primeCalls[0].cookies, 2);
    // 库里必须是空的（「仅本次」的语义边界）
    const statuses = await sessionService.listStatuses(ACTOR);
    const pdd = statuses.find((s) => s.siteId === "pdd");
    assert.equal(pdd?.hasCookies, false);
  } finally {
    delete process.env.BROWSER_SESSION_DATA_DIR;
  }
});

test("apply：不支持的平台 → 明确报错", async () => {
  const svc = makeService({ sessionService: new BrowserSessionService() });
  const applied = await svc.applyCookieImport(ACTOR, "not-a-site", [{ name: "a", value: "1" }], true);
  assert.ok(!applied.ok);
});

// ---------- 4. 统一保存闸（2026-11-21 用户定稿）----------
//
// 「是否保存」收敛成一张专门的统一授权卡：问一次「允许保存登录 Cookie 吗」，
// 同意 → 写全局授权键（CAPTURE_CONSENT_ALL_SITES），之后所有平台、所有登录
// 方式（导入 / 扫码 / 内置浏览器）的登录态都默认保存、不再逐次询问。

test("consent：未表态 → ask（弹统一授权卡）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cookie-consent-"));
  process.env.BROWSER_SESSION_DATA_DIR = dir;
  try {
    const sessionService = new BrowserSessionService();
    const svc = makeService({ sessionService });
    assert.equal(await svc.getCookieSaveConsent(ACTOR, "pdd"), "ask");
    assert.equal(await svc.getCookieSaveConsent(ACTOR, "jd"), "ask");
  } finally {
    delete process.env.BROWSER_SESSION_DATA_DIR;
  }
});

test("consent：同意一次 → 全局键生效，所有平台 allow（与扫码登录同一把闸）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cookie-consent-"));
  process.env.BROWSER_SESSION_DATA_DIR = dir;
  try {
    const sessionService = new BrowserSessionService();
    const svc = makeService({ sessionService });
    await svc.recordCookieSaveConsent(ACTOR, true);
    assert.equal(await svc.getCookieSaveConsent(ACTOR, "pdd"), "allow");
    assert.equal(await svc.getCookieSaveConsent(ACTOR, "jd"), "allow", "答一次对所有平台生效");
    assert.equal(await svc.getCookieSaveConsent(ACTOR, "taobao"), "allow");
    // 与扫码登录共闸：browserSessionService 原口读出来也是 allow
    assert.equal(await sessionService.getCaptureConsent(ACTOR, "meituan"), "allow");
  } finally {
    delete process.env.BROWSER_SESSION_DATA_DIR;
  }
});

test("consent：拒绝 → deny（不保存也不再问）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cookie-consent-"));
  process.env.BROWSER_SESSION_DATA_DIR = dir;
  try {
    const sessionService = new BrowserSessionService();
    const svc = makeService({ sessionService });
    await svc.recordCookieSaveConsent(ACTOR, false);
    assert.equal(await svc.getCookieSaveConsent(ACTOR, "pdd"), "deny");
    assert.equal(await svc.getCookieSaveConsent(ACTOR, "jd"), "deny");
  } finally {
    delete process.env.BROWSER_SESSION_DATA_DIR;
  }
});

// ---------- 5. 卡内动作线协议（handleCardActionEvent）----------

function makeFakeSocket() {
  const sent: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const socket = {
    send: (raw: string) => {
      sent.push(JSON.parse(raw) as { type: string; payload: Record<string, unknown> });
    },
  } as unknown as import("ws").WebSocket;
  return { socket, sent };
}

test("线协议：未表态首次导入 → 统一授权卡；同意 → 默认保存 + 全局闸打开", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cookie-wire-"));
  process.env.BROWSER_SESSION_DATA_DIR = dir;
  try {
    const sessionService = new BrowserSessionService();
    const svc = makeService({ sessionService });
    const actorId = "u-import-gate";

    // 1) 首次导入：consent 停在 ask → 回统一授权卡（不是逐次的「是否保存」小卡）
    const { socket, sent } = makeFakeSocket();
    const handled1 = await handleCardActionEvent(
      { socket, boundActorId: actorId, sendUnifiedError: () => {} },
      {
        messageId: "msg-1",
        cardId: "card-1",
        actionId: "shopping.login.import",
        payload: { platform: "pdd", cookieText: "api_uid=x; PDDUserID=U1" },
      },
      { shoppingOrderService: svc },
    );
    assert.equal(handled1, true);
    const gate = sent[0];
    assert.ok(gate, "首次导入应回统一授权卡");
    const gateShopping = (gate.payload.card as Record<string, { shopping?: Record<string, unknown> }>)
      ?.extra?.shopping;
    assert.equal(gateShopping?.primaryAction, "shopping.login.import.consent");
    assert.equal(gateShopping?.secondaryAction, "shopping.login.import.consent");

    // 2) 点「同意」：全局授权键落库 + 本次默认保存 + 回就绪卡
    const handled2 = await handleCardActionEvent(
      { socket, boundActorId: actorId, sendUnifiedError: () => {} },
      {
        messageId: "msg-1",
        cardId: "card-1",
        actionId: "shopping.login.import.consent",
        payload: { platform: "pdd", allow: true },
      },
      { shoppingOrderService: svc },
    );
    assert.equal(handled2, true);
    const ready = sent[1];
    assert.ok(ready, "同意后应回就绪卡");
    assert.equal(ready.payload.ok, true);
    // 统一闸：答一次对所有平台生效（扫码登录同闸，不再各问各的）
    assert.equal(await svc.getCookieSaveConsent(actorId, "jd"), "allow");
    assert.equal(await sessionService.getCaptureConsent(actorId, "taobao"), "allow");
    // 本次 Cookie 已落库并授权，比价免扫码
    const got = await sessionService.getCookiesForAgent(actorId, "pdd");
    assert.ok(got.length >= 2, "同意后本次 Cookie 应已落库");

    // 3) 再次导入：consent 已 allow → 不再问，直接默认保存（一次往返出就绪卡）
    const sentCountBefore = sent.length;
    await handleCardActionEvent(
      { socket, boundActorId: actorId, sendUnifiedError: () => {} },
      {
        messageId: "msg-2",
        cardId: "card-2",
        actionId: "shopping.login.import",
        payload: { platform: "jd", cookieText: "pt_pin=u2; thrift=c1" },
      },
      { shoppingOrderService: svc },
    );
    assert.equal(sent.length, sentCountBefore + 1, "已同意后不应再弹询问卡");
    const auto = sent[sent.length - 1];
    const autoShopping = (auto.payload.card as Record<string, { shopping?: Record<string, unknown> }>)
      ?.extra?.shopping;
    assert.match(String(autoShopping?.note ?? ""), /统一保存闸已开/);
    const jdCookies = await sessionService.getCookiesForAgent(actorId, "jd");
    assert.ok(jdCookies.length >= 2, "已同意后导入直接默认保存");
  } finally {
    delete process.env.BROWSER_SESSION_DATA_DIR;
  }
});

test("线协议：统一授权卡点「仅本次」→ 只应用、不落任何授权（下次仍会问）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cookie-wire-once-"));
  process.env.BROWSER_SESSION_DATA_DIR = dir;
  try {
    const sessionService = new BrowserSessionService();
    const svc = makeService({ sessionService });
    const actorId = "u-import-once";

    const { socket, sent } = makeFakeSocket();
    await handleCardActionEvent(
      { socket, boundActorId: actorId, sendUnifiedError: () => {} },
      {
        messageId: "msg-1",
        cardId: "card-1",
        actionId: "shopping.login.import",
        payload: { platform: "pdd", cookieText: "api_uid=x; PDDUserID=U1" },
      },
      { shoppingOrderService: svc },
    );
    await handleCardActionEvent(
      { socket, boundActorId: actorId, sendUnifiedError: () => {} },
      {
        messageId: "msg-1",
        cardId: "card-1",
        actionId: "shopping.login.import.consent",
        payload: { platform: "pdd", allow: false },
      },
      { shoppingOrderService: svc },
    );
    // consent 原样保留 ask（下次导入还会问），Cookie 只灌 context 不落库
    assert.equal(await svc.getCookieSaveConsent(actorId, "pdd"), "ask");
    assert.equal(await sessionService.getCaptureConsent(actorId, "pdd"), "ask");
    const statuses = await sessionService.listStatuses(actorId);
    const pdd = statuses.find((s) => s.siteId === "pdd");
    assert.equal(pdd?.hasCookies, false, "「仅本次」不落库");
    assert.equal(sent.length, 2);
  } finally {
    delete process.env.BROWSER_SESSION_DATA_DIR;
  }
});
