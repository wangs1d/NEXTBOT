/**
 * shopping-compare 平台池准入策略测试（2026-11-12 改版回归锁）。
 *
 * 背景：手机端比价曾被投诉「只有苏宁、淘宝连登录二维码都不推」。根因：
 *   1. 缺省池只放 authMode=anonymous 平台；
 *   2. 用户显式点名全是登录平台时整体回退到免登录平台，登录墙永远碰不到。
 *
 * 本文件锁定改版后的行为：
 *   - 缺省轮 = 免登录平台 + 已有 Cookie 平台 + 无登录态的主流登录平台探测
 *     （tmall 与淘宝同 SSO 不重复探测，短等待 SHOPPING_COMPARE_LOGIN_PROBE_WAIT_MS）；
 *   - **推码预算：一轮只推一张二维码**（2026-11-12 用户拍板）——登录族平台
 *     串行取数，首个撞墙/验证平台用掉预算，其余登录平台延后不取数；
 *   - 显式点名全 login 且无 Cookie：**不再回退**——点名平台照常尝试（推码），
 *     同时并入免登录平台保底出价；
 *   - 回执如实透传 loginRequired / loginQrImage / handoff / retryHint。
 *
 * 只测服务层编排逻辑：searchProduct 打桩，不触网、不开浏览器。
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ShoppingCompareService,
} from "../src/services/shopping-compare-service.js";
import type { ShoppingOrderService } from "../src/services/shopping-order-service.js";
import type { ToolContext } from "../src/tools/tool-registry.js";

/** searchProduct 调用记录（用于断言平台池与 innerOpts）。 */
interface SearchCall {
  platform: string;
  innerOpts?: { preferHeadless?: boolean; loginWaitMs?: number; suppressHandoff?: boolean };
}

interface StubProduct {
  title: string;
  price: number;
}

interface StubBehavior {
  /** 正常出价的平台 → 商品（标题需含 query 才能过同款闸） */
  okPlatforms?: Record<string, StubProduct[]>;
  /** 登录墙平台 → 回执（默认带 imageUrl 模拟推码成功） */
  loginPlatforms?: string[];
  /** 空结果平台（reason=no_data 路径） */
  emptyPlatforms?: string[];
}

function makeStubOrderService(
  supported: string[],
  behavior: StubBehavior,
  calls: SearchCall[],
  cookiePlatforms: string[] = [],
): ShoppingOrderService {
  return {
    listSupportedPlatforms: () => supported,
    listPlatformsWithCookies: async (_actorId: string, platforms: string[]) =>
      platforms.filter((p) => cookiePlatforms.includes(p)),
    canUseVisibleBrowser: () => false,
    searchProduct: async (
      _ctx: ToolContext,
      platform: string,
      _query: string,
      _filters?: unknown,
      innerOpts?: { preferHeadless?: boolean; loginWaitMs?: number; suppressHandoff?: boolean },
    ) => {
      calls.push({ platform, innerOpts });
      if (behavior.loginPlatforms?.includes(platform)) {
        return {
          ok: false,
          error: "登录超时。已把登录二维码推送到聊天。",
          retryable: true,
          loginRequired: { platform, imageUrl: `/agent/images/${platform}-qr.png` },
        };
      }
      if (behavior.emptyPlatforms?.includes(platform)) {
        return { ok: true, summary: "未找到商品", products: [], platform };
      }
      const products = behavior.okPlatforms?.[platform];
      if (products) {
        return { ok: true, summary: `找到 ${products.length} 个商品`, products, platform };
      }
      return { ok: false, error: `平台 ${platform} 无 mock 行为`, retryable: false };
    },
  } as unknown as ShoppingOrderService;
}

function makeCtx(): ToolContext {
  return { sessionId: "test-session-pool", userId: "test-user-pool" } as ToolContext;
}

async function makeService(stub: ShoppingOrderService) {
  const dir = await mkdtemp(join(tmpdir(), "shopping-compare-pool-"));
  const service = new ShoppingCompareService({ shoppingOrderService: stub, dataDir: dir });
  return { service, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

const SUPPORTED = ["taobao", "suning", "smzdm"];
const QUERY = "伊利纯牛奶";
const okProduct = (platform: string): StubProduct => ({
  title: `伊利纯牛奶250ml*24盒 整箱（${platform}）`,
  price: 55,
});

test("缺省轮：免登录平台 + 登录探测平台（淘宝推码），探测平台用短等待", async () => {
  const calls: SearchCall[] = [];
  const stub = makeStubOrderService(SUPPORTED, {
    okPlatforms: { suning: [okProduct("suning")], smzdm: [okProduct("smzdm")] },
    loginPlatforms: ["taobao"],
  }, calls);
  const { service, cleanup } = await makeService(stub);
  try {
    const res = (await service.comparePrices(makeCtx(), QUERY, {})) as Record<string, unknown>;
    const platforms = calls.map((c) => c.platform).sort();
    assert.deepEqual(platforms, ["smzdm", "suning", "taobao"], `三平台都应被尝试：${platforms.join(",")}`);

    // 登录探测平台用短等待（缺省 30s），免登录平台走常规 20s（无推送通道）
    const taobaoCall = calls.find((c) => c.platform === "taobao");
    assert.equal(taobaoCall?.innerOpts?.loginWaitMs, 30_000, "探测平台应使用 30s 短等待");
    const suningCall = calls.find((c) => c.platform === "suning");
    assert.equal(suningCall?.innerOpts?.loginWaitMs, 20_000);

    // 回执：淘宝如实标 login + 二维码地址 + 交接指引
    const unavailable = (res.unavailablePlatforms as Array<{ platform: string; reason: string }>) ?? [];
    const taobaoUnavailable = unavailable.find((u) => u.platform === "taobao");
    assert.equal(taobaoUnavailable?.reason, "login");
    assert.equal(res.loginRequired ? (res.loginRequired as { platform?: string }).platform : undefined, "taobao");
    const handoff = res.handoff as { instruction?: string; reason?: string } | undefined;
    assert.ok(handoff, "登录墙应合成一次统一 handoff");
    assert.equal(handoff?.reason, "login");
    assert.ok(handoff?.instruction?.includes("二维码已推到聊天"), `指引应说明二维码已推：${handoff?.instruction}`);

    // 免登录平台照常出价
    const groups = res.groups as Array<{ offers: Array<{ platform: string }> }>;
    assert.ok(groups.length >= 1, "免登录平台应有报价组");
    assert.ok(groups.some((g) => g.offers.some((o) => o.platform === "suning")));
  } finally {
    await cleanup();
  }
});

test("缺省轮：已有 Cookie 的登录平台自动并入，无 Cookie 的探测平台仍带一家", async () => {
  const calls: SearchCall[] = [];
  // jd 有 Cookie、taobao 没有 → 池 = suning + smzdm + jd(Cookie) + taobao(探测)
  const stub = makeStubOrderService(
    [...SUPPORTED, "jd"],
    {
      okPlatforms: {
        suning: [okProduct("suning")],
        smzdm: [okProduct("smzdm")],
        jd: [okProduct("jd")],
      },
      loginPlatforms: ["taobao"],
    },
    calls,
    ["jd"],
  );
  const { service, cleanup } = await makeService(stub);
  try {
    await service.comparePrices(makeCtx(), QUERY, {});
    const platforms = calls.map((c) => c.platform).sort();
    assert.deepEqual(
      platforms,
      ["jd", "smzdm", "suning", "taobao"],
      `Cookie 平台并入 + 探测平台带上：${platforms.join(",")}`,
    );
  } finally {
    await cleanup();
  }
});

test("显式点名全登录平台且无 Cookie：不再回退，点名平台照试推码 + 免登录保底", async () => {
  const calls: SearchCall[] = [];
  const stub = makeStubOrderService(SUPPORTED, {
    okPlatforms: { suning: [okProduct("suning")], smzdm: [okProduct("smzdm")] },
    loginPlatforms: ["taobao"],
  }, calls);
  const { service, cleanup } = await makeService(stub);
  try {
    const res = (await service.comparePrices(makeCtx(), QUERY, { platforms: ["taobao"] })) as Record<string, unknown>;
    const platforms = calls.map((c) => c.platform).sort();
    // 旧实现此处只有 suning/smzdm（taobao 被整体替换掉）——回归锁：taobao 必须被尝试
    assert.deepEqual(platforms, ["smzdm", "suning", "taobao"], `点名平台不得被替换：${platforms.join(",")}`);

    const unavailable = (res.unavailablePlatforms as Array<{ platform: string; reason: string }>) ?? [];
    assert.equal(unavailable.find((u) => u.platform === "taobao")?.reason, "login");
    const handoff = res.handoff as { instruction?: string } | undefined;
    assert.ok(handoff?.instruction?.includes("二维码已推到聊天"));
    // 保底出价仍在
    const groups = res.groups as Array<{ offers: Array<{ platform: string }> }>;
    assert.ok(groups.some((g) => g.offers.some((o) => o.platform === "suning")));
  } finally {
    await cleanup();
  }
});

test("显式点名登录平台且已有 Cookie：只查点名平台，不并免登录保底", async () => {
  const calls: SearchCall[] = [];
  const stub = makeStubOrderService(SUPPORTED, {
    okPlatforms: { taobao: [okProduct("taobao")] },
  }, calls, ["taobao"]);
  const { service, cleanup } = await makeService(stub);
  try {
    const res = (await service.comparePrices(makeCtx(), QUERY, { platforms: ["taobao"] })) as Record<string, unknown>;
    assert.deepEqual(calls.map((c) => c.platform), ["taobao"]);
    const groups = res.groups as Array<{ offers: Array<{ platform: string }> }>;
    assert.equal(groups.length, 1);
    assert.equal(groups[0]?.offers[0]?.platform, "taobao");
  } finally {
    await cleanup();
  }
});

test("推码预算：一次只推一张码（首个撞墙平台推码后，其余登录平台延后不取数）", async () => {
  const calls: SearchCall[] = [];
  const stub = makeStubOrderService(
    ["taobao", "tmall", "jd", "pdd", "suning", "smzdm"],
    {
      okPlatforms: { suning: [okProduct("suning")], smzdm: [okProduct("smzdm")] },
      loginPlatforms: ["taobao", "jd", "pdd"],
    },
    calls,
  );
  const { service, cleanup } = await makeService(stub);
  try {
    const res = (await service.comparePrices(makeCtx(), QUERY, {})) as Record<string, unknown>;

    // 串行登录队列：taobao 排第一并撞墙 → 预算用尽 → jd/pdd 延后，不取数
    const loginCalls = calls.filter((c) => ["taobao", "jd", "pdd", "tmall"].includes(c.platform));
    assert.deepEqual(
      loginCalls.map((c) => c.platform),
      ["taobao"],
      `首个撞墙平台后应停止登录队列：${loginCalls.map((c) => c.platform).join(",")}`,
    );
    assert.equal(
      calls.find((c) => c.platform === "taobao")?.innerOpts?.loginWaitMs,
      30_000,
      "探测平台应用 30s 短等待",
    );
    // tmall 与淘宝同 SSO：不单独探测；免登录保底两家都活着
    assert.ok(!calls.some((c) => c.platform === "tmall"), "tmall 不应单独探测");
    assert.ok(calls.some((c) => c.platform === "suning") && calls.some((c) => c.platform === "smzdm"));

    // handoff 只含淘宝（一张码）；summary 说明延后节奏与建档
    const handoff = res.handoff as { labels?: string[] } | undefined;
    assert.ok(handoff, "登录墙应合成一次统一 handoff");
    assert.deepEqual(handoff?.labels, ["淘宝"], `handoff 只应有淘宝：${handoff?.labels?.join("、")}`);
    const summary = String(res.summary ?? "");
    assert.ok(summary.includes("一次只推一个"), `summary 应说明延后节奏：${summary}`);
    assert.ok(/京东、拼多多这轮先不推码/.test(summary), `summary 应点名延后平台：${summary}`);
    assert.ok(summary.includes("首次比价顺手建档"), `summary 应带建档文案：${summary}`);
    assert.ok(summary.includes("淘宝的登录二维码"), `建档文案应点名淘宝：${summary}`);
  } finally {
    await cleanup();
  }
});

test("普通空结果平台：回执带 retryHint 指引通用浏览器自主兜底", async () => {
  const calls: SearchCall[] = [];
  const stub = makeStubOrderService(SUPPORTED, {
    okPlatforms: { suning: [okProduct("suning")] },
    emptyPlatforms: ["smzdm"],
  }, calls);
  const { service, cleanup } = await makeService(stub);
  try {
    const res = (await service.comparePrices(makeCtx(), QUERY, {})) as Record<string, unknown>;
    const hint = res.retryHint as string | undefined;
    assert.ok(hint, "空结果平台应触发 retryHint");
    assert.ok(hint.includes("什么值得买"), `hint 应点名失败平台：${hint}`);
    assert.ok(hint.includes("通用多步浏览器"), `hint 应指明自主兜底路径：${hint}`);
    // 登录探测平台也带上了（缺省轮行为不变）
    assert.ok(calls.some((c) => c.platform === "taobao"));
  } finally {
    await cleanup();
  }
});
