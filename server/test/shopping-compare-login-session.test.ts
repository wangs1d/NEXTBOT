/**
 * 比价登录会话（2026-11-13 P1）回归测试。
 *
 * P1 要解决的三件事，全在这条链路上闭环：
 *   1. 「跳过这家」——用户放弃某个待登录平台，其余照常比；
 *   2. 「补齐待登录平台」——卡上常驻待登录清单，剩余平台逐家可见；
 *   3. 「二维码失效重推」——码过期时原地换新码，不在聊天里堆第二张码。
 *
 * 外加整条链路的收口：登录处理完 → 同批次统一取价 → 一次性交付比价卡
 * （中途不出半成品答案）。
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { WebSocket } from "ws";

import { ShoppingCompareService } from "../src/services/shopping-compare-service.js";
import type { ShoppingOrderService } from "../src/services/shopping-order-service.js";
import { handleCardActionEvent } from "../src/ws/handlers/card-action.js";

// ─────────────────────────── 测试脚手架 ───────────────────────────

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

function makeCtx() {
  return { sessionId: "s-p1", userId: "u-p1" };
}

const PRODUCT_TITLE = "Sony WH-1000XM5 头戴降噪耳机";

/**
 * 假购物服务：
 *   · cookies 里有的平台 = 已登录（能取到价）
 *   · jd / taobao / pdd 是登录类平台，没 cookie 就撞登录墙
 *   · suning / smzdm 匿名可读
 */
function makeStubOrderService(state: {
  cookies: Set<string>;
  fetched: string[];
  refreshed: string[];
  pushed: string[][];
}) {
  const prices: Record<string, number> = {
    suning: 1899,
    smzdm: 1950,
    jd: 1888,
    taobao: 1875,
    pdd: 1869,
  };
  const urls: Record<string, string> = {
    suning: "https://suning.com/xm5",
    smzdm: "https://smzdm.com/xm5",
    jd: "https://jd.com/xm5",
    taobao: "https://taobao.com/xm5",
    pdd: "https://pdd.com/xm5",
  };
  const service = {
    listSupportedPlatforms: () => ["jd", "taobao", "pdd", "suning", "smzdm"],
    listPlatformsWithCookies: async (_actorId: string, platforms: string[]) =>
      platforms.filter((p) => state.cookies.has(p)),
    canUseVisibleBrowser: () => false,
    checkMultiPlatformLogin: async (_ctx: unknown, platforms: string[]) => {
      const ready = platforms.filter((p) => state.cookies.has(p));
      return {
        ready,
        pending: platforms.filter((p) => !state.cookies.has(p)),
      };
    },
    probeLoginWall: async (_ctx: unknown, platform: string) => {
      const needsLogin = ["jd", "taobao", "pdd"].includes(platform);
      if (!needsLogin || state.cookies.has(platform)) {
        return { required: false };
      }
      return { required: true, reason: "login" as const };
    },
    pushBatchLoginQrs: async (_ctx: unknown, platforms: string[]) => {
      state.pushed.push([...platforms]);
      return new Map(platforms.map((p) => [p, `/agent/images/${p}-qr.png`]));
    },
    captureBatchLoginQrs: async (_ctx: unknown, platforms: string[]) => {
      state.refreshed.push([...platforms]);
      return platforms.map((p) => ({
        platform: p,
        label: p === "jd" ? "京东" : p === "taobao" ? "淘宝" : p,
        imageUrl: `/agent/images/${p}-qr-fresh.png`,
      }));
    },
    searchProduct: async (_ctx: unknown, platform: string) => {
      state.fetched.push(platform);
      if (["jd", "taobao", "pdd"].includes(platform) && !state.cookies.has(platform)) {
        return { ok: false, error: "需要登录", loginRequired: { platform } };
      }
      return {
        ok: true,
        summary: "ok",
        platform,
        products: [
          {
            title: PRODUCT_TITLE,
            price: prices[platform] ?? 1999,
            shop: `${platform} 自营`,
            url: urls[platform] ?? `https://${platform}.com/xm5`,
          },
        ],
      };
    },
  };
  return service as unknown as ShoppingOrderService;
}

async function withService<T>(
  fn: (
    service: ShoppingCompareService,
    state: { cookies: Set<string>; fetched: string[]; refreshed: string[]; pushed: string[][] },
  ) => Promise<T>,
): Promise<T> {
  const dataDir = await mkdtemp(join(tmpdir(), "npc-p1-"));
  const state = {
    cookies: new Set<string>(),
    fetched: [] as string[],
    refreshed: [] as string[],
    pushed: [] as string[][],
  };
  const service = new ShoppingCompareService({
    shoppingOrderService: makeStubOrderService(state),
    dataDir,
  });
  try {
    return await fn(service, state);
  } finally {
    await service.flush();
    await rm(dataDir, { recursive: true, force: true });
  }
}

// ─────────────────────────── 用例 ───────────────────────────

/**
 * 登录闸门挂起时，这一轮必须被**记住**——卡上的「跳过这家 / 重新出码 /
 * 继续比价」全靠它续跑。
 */
test("P1 登录闸门挂起 → 记住待登录比价会话（含已推的二维码）", async () => {
  await withService(async (service, state) => {
    const res = (await service.comparePrices(makeCtx(), "Sony WH-1000XM5", {
      platforms: ["jd", "taobao", "suning"],
    })) as Record<string, unknown>;

    assert.equal(res.ok, false, "命中登录墙时不得产出报价");
    assert.equal(res.awaitingLogin, true);

    const session = service.getPendingCompare(makeCtx());
    assert.ok(session, "应记住这一轮待登录比价");
    assert.equal(session!.query, "Sony WH-1000XM5");
    assert.deepEqual(session!.loginPlatforms, ["jd", "taobao"]);
    assert.deepEqual(session!.skipped, []);
    assert.equal(session!.qrItems.length, 2, "两家待登录 → 两张码");
    assert.ok(state.pushed[0]?.includes("jd"), "应一次推齐所有待登录平台的码");
    assert.ok(state.pushed[0]?.includes("taobao"), "应一次推齐所有待登录平台的码");
  });
});

/** 「跳过这家」：跳过的平台不再等，其余照常。 */
test("P1 跳过一家 → 会话记账 + 卡上撤掉这家，其余保留", async () => {
  await withService(async (service) => {
    await service.comparePrices(makeCtx(), "Sony WH-1000XM5", {
      platforms: ["jd", "taobao", "suning"],
    });

    const skipped = service.skipLoginPlatform(makeCtx(), "jd");
    assert.ok(skipped, "应能跳过");
    assert.deepEqual(skipped!.skipped, ["jd"]);
    assert.deepEqual(skipped!.remaining, ["taobao"], "淘宝还要等登录");

    // 幂等：再跳一次不会重复记账
    const again = service.skipLoginPlatform(makeCtx(), "jd");
    assert.deepEqual(again!.skipped, ["jd"]);
  });
});

/**
 * 「跳过这家」走 card.action：卡上被跳过的那家要撤掉，其余平台的码保留。
 */
test("P1 card.action 跳过这家 → 卡原地换掉（不含被跳过的平台）", async () => {
  await withService(async (service) => {
    await service.comparePrices(makeCtx(), "Sony WH-1000XM5", {
      platforms: ["jd", "taobao", "suning"],
    });

    const { socket, sent } = makeFakeSocket();
    await handleCardActionEvent(
      { socket, boundActorId: "u-p1", sendUnifiedError: () => {} },
      {
        messageId: "msg-1",
        cardId: "card-1",
        actionId: "shopping.login.skip",
        payload: { platform: "jd", platforms: ["jd", "taobao"] },
      },
      { shoppingOrderService: makeStubOrderService({ cookies: new Set(), fetched: [], refreshed: [], pushed: [] }), shoppingCompareService: service },
    );

    assert.equal(sent.length, 1);
    const body = sent[0]!.payload as Record<string, unknown>;
    assert.equal(body.ok, true, `应换出新卡：${JSON.stringify(body)}`);
    const card = body.card as Record<string, unknown>;
    const extra = card.extra as Record<string, Record<string, unknown>>;
    const shopping = extra.shopping!;
    const qrItems = shopping.qrItems as Array<Record<string, string>>;
    assert.deepEqual(
      qrItems.map((q) => q.platform),
      ["taobao"],
      "被跳过的平台应从卡上撤掉",
    );
    const pending = shopping.pendingPlatforms as Array<Record<string, string>>;
    assert.deepEqual(pending.map((q) => q.platform), ["taobao"]);
  });
});

/**
 * 二维码失效重推：原地换新码，**不推第二张卡进聊天流**。
 */
test("P1 二维码失效 → 原地换新码（不额外推卡）", async () => {
  await withService(async (service, state) => {
    await service.comparePrices(makeCtx(), "Sony WH-1000XM5", {
      platforms: ["jd", "taobao", "suning"],
    });

    const { socket, sent } = makeFakeSocket();
    await handleCardActionEvent(
      { socket, boundActorId: "u-p1", sendUnifiedError: () => {} },
      {
        messageId: "msg-1",
        cardId: "card-1",
        actionId: "shopping.login.refresh",
        payload: { platform: "jd", platforms: ["jd", "taobao"] },
      },
      { shoppingOrderService: makeStubOrderService(state), shoppingCompareService: service },
    );

    assert.equal(sent.length, 1, "只回一张换过的卡，不多推");
    const body = sent[0]!.payload as Record<string, unknown>;
    assert.equal(body.ok, true);
    const card = body.card as Record<string, unknown>;
    const shopping = ((card.extra as Record<string, Record<string, unknown>>).shopping)!;
    const qrItems = shopping.qrItems as Array<Record<string, string>>;
    const jd = qrItems.find((q) => q.platform === "jd");
    assert.ok(jd, "京东的码应仍在卡上");
    assert.equal(jd!.qrImage, "/agent/images/jd-qr-fresh.png", "应换成新码");
    assert.ok(state.refreshed.length > 0, "应真的重抓了码");
    // 会话里的码也要更新（续跑时卡上拿的是最新那张）
    assert.equal(
      service.getPendingCompare(makeCtx())!.qrItems.find((q) => q.platform === "jd")!.qrImage,
      "/agent/images/jd-qr-fresh.png",
    );
  });
});

/**
 * 登录完成 → 续跑：同批次统一取价、一次性交付比价卡。
 * 还没登录的那家必须**显式**出现在「未取到」清单里（模型不得替它编价）。
 */
test("P1 续跑：登录后统一取价 → 一次性交付；未登录平台显式列为未取到", async () => {
  await withService(async (service, state) => {
    await service.comparePrices(makeCtx(), "Sony WH-1000XM5", {
      platforms: ["jd", "taobao", "suning"],
    });

    // 用户只扫了京东
    state.cookies.add("jd");
    const resumed = await service.resumeCompareAfterLogin(makeCtx());
    assert.equal(resumed.ok, true, `续跑应成功：${JSON.stringify(resumed)}`);
    if (!resumed.ok) return;

    const result = resumed.result as Record<string, unknown>;
    assert.equal(result.ok, true);
    const searched = result.searchedPlatforms as string[];
    assert.ok(searched.includes("jd"), "登录后的平台应有报价");
    assert.ok(searched.includes("suning"), "免登录平台照常有报价");

    const missing = result.missingPlatforms as Array<Record<string, string>>;
    const taobao = missing.find((m) => m.platform === "taobao");
    assert.ok(taobao, "未登录的平台必须显式出现在未取到清单");
    assert.equal(taobao!.reason, "login");

    // 事实清单里也不能出现淘宝的价格
    const factSheet = String(result.factSheet);
    assert.ok(factSheet.includes("【未取到报价的平台】"));
    assert.ok(factSheet.includes("淘宝：需要登录（未完成）"), factSheet);
    assert.ok(!factSheet.includes("淘宝 ¥"), "未取到的平台不得出现价格");
  });
});

/**
 * 全部跳过 → 不用再等，直接续跑；被跳过的平台进「未取到（已跳过）」。
 */
test("P1 全部跳过 → 直接续跑交付；跳过的平台列为「已跳过」而非缺价", async () => {
  await withService(async (service, state) => {
    await service.comparePrices(makeCtx(), "Sony WH-1000XM5", {
      platforms: ["jd", "taobao", "suning"],
    });

    service.skipLoginPlatform(makeCtx(), "jd");
    service.skipLoginPlatform(makeCtx(), "taobao");

    const resumed = await service.resumeCompareAfterLogin(makeCtx());
    assert.equal(resumed.ok, true, `续跑应成功：${JSON.stringify(resumed)}`);
    if (!resumed.ok) return;

    const result = resumed.result as Record<string, unknown>;
    const missing = result.missingPlatforms as Array<Record<string, string>>;
    const jd = missing.find((m) => m.platform === "jd");
    const taobao = missing.find((m) => m.platform === "taobao");
    assert.equal(jd!.reason, "skipped");
    assert.equal(taobao!.reason, "skipped");
    // 跳过的平台不算「缺口」：覆盖度只算真正要比的那几家
    const coverage = result.coverage as number;
    assert.ok(coverage >= 1, `跳过的平台不应算缺口：coverage=${coverage}`);
    const factSheet = String(result.factSheet);
    assert.ok(factSheet.includes("用户选择跳过这家"), factSheet);
    assert.ok(!state.fetched.includes("jd"), "跳过的平台不应再去取价");
  });
});

/**
 * 「先比已登录的」：用户明确表态剩下的不等了 → 还没登录的那家记成「已跳过」
 * （是用户的选择，不是平台没价），本轮照常交付。
 */
test("P1 「先比已登录的」→ 未登录平台记为已跳过，本轮照常交付", async () => {
  await withService(async (service, state) => {
    await service.comparePrices(makeCtx(), "Sony WH-1000XM5", {
      platforms: ["jd", "taobao", "suning"],
    });
    state.cookies.add("jd");

    const resumed = await service.resumeCompareAfterLogin(makeCtx(), { skipPending: true });
    assert.equal(resumed.ok, true, `续跑应成功：${JSON.stringify(resumed)}`);
    if (!resumed.ok) return;

    const result = resumed.result as Record<string, unknown>;
    const missing = result.missingPlatforms as Array<Record<string, string>>;
    const taobao = missing.find((m) => m.platform === "taobao");
    assert.equal(taobao!.reason, "skipped", "用户选择跳过的应记为 skipped");
    const searched = result.searchedPlatforms as string[];
    assert.ok(searched.includes("jd"), "已登录的平台照常有报价");
  });
});

/**
 * 全部平台被跳过 → 如实说「没有要比的平台」，不给误导性诊断，也不编价。
 */
test("P1 全部平台被跳过 → 如实说没有要比的平台", async () => {
  await withService(async (service) => {
    const res = (await service.comparePrices(makeCtx(), "Sony WH-1000XM5", {
      platforms: ["jd", "taobao", "suning"],
      pending: { assumeLogin: [], skipped: ["jd", "taobao", "suning"] },
    })) as Record<string, unknown>;
    assert.equal(res.ok, false);
    assert.ok(
      String(res.error).includes("没有要比价"),
      `应如实说明：${String(res.error)}`,
    );
    assert.ok(
      !String(res.error).includes("登录态失效"),
      "不该拿「登录态失效」搪塞用户的主动选择",
    );
  });
});

/**
 * card.action 的「继续比价」：登录后直接换出比价卡（横向轮播）。
 */
test("P1 card.action 继续比价 → 原地换成比价卡", async () => {
  await withService(async (service, state) => {
    await service.comparePrices(makeCtx(), "Sony WH-1000XM5", {
      platforms: ["jd", "suning"],
    });
    state.cookies.add("jd");

    const { socket, sent } = makeFakeSocket();
    await handleCardActionEvent(
      { socket, boundActorId: "u-p1", sendUnifiedError: () => {} },
      {
        messageId: "msg-1",
        cardId: "card-1",
        actionId: "shopping.compare.resume",
        payload: { platforms: ["jd"] },
      },
      { shoppingOrderService: makeStubOrderService(state), shoppingCompareService: service },
    );

    assert.equal(sent.length, 1);
    const body = sent[0]!.payload as Record<string, unknown>;
    assert.equal(body.ok, true, `应换出比价卡：${JSON.stringify(body)}`);
    const card = body.card as Record<string, unknown>;
    assert.equal(card.cardType, "price_compare");
    const shopping = ((card.extra as Record<string, Record<string, unknown>>).shopping)!;
    const items = shopping.items as Array<Record<string, unknown>>;
    assert.ok(items.length >= 1, "轮播卡应带商品条目");
    // 平台来源必须在（用户投诉「没标注是哪个平台的」）
    assert.ok(items.every((it) => typeof it.platformLabel === "string" && it.platformLabel), "每条报价都要带平台名");
  });
});

/**
 * 没人扫成功时：把卡换成带「重新出码 / 跳过这家」的版本，而不是只报错。
 */
test("P1 没人登录成功 → 卡换成可重新出码的版本（而不是只报错）", async () => {
  await withService(async (service, state) => {
    await service.comparePrices(makeCtx(), "Sony WH-1000XM5", {
      platforms: ["jd", "taobao", "suning"],
    });

    const { socket, sent } = makeFakeSocket();
    await handleCardActionEvent(
      { socket, boundActorId: "u-p1", sendUnifiedError: () => {} },
      {
        messageId: "msg-1",
        cardId: "card-1",
        actionId: "shopping.login.check",
        payload: { platforms: ["jd", "taobao"] },
      },
      { shoppingOrderService: makeStubOrderService(state), shoppingCompareService: service },
    );

    assert.equal(sent.length, 1);
    const body = sent[0]!.payload as Record<string, unknown>;
    assert.equal(body.ok, true, "应换出新卡而不是只报错");
    const card = body.card as Record<string, unknown>;
    const shopping = ((card.extra as Record<string, Record<string, unknown>>).shopping)!;
    assert.equal(shopping.stage, "login");
    const qrItems = shopping.qrItems as Array<Record<string, string>>;
    assert.equal(qrItems.length, 2, "两家都应重新出码");
    assert.ok(state.refreshed.length > 0, "应真的重抓了码");
  });
});
