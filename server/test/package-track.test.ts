/**
 * 包裹聚合底层单测（2026-10-26）。
 *
 * 覆盖：
 *   1. 线索提取：强形态/弱形态运单号、状态、取件码、手机后四位
 *   2. 误报防线：11 位手机号、订单号语境、外卖通知、无语境数字串一律不生成包裹
 *   3. 登记表：创建/跃迁/回退拒绝/跨来源合并/取件码孪生归并/落盘往返
 *   4. 丰桥 provider：未配置与跨承运商白名单的 fail-closed 语义
 *   5. 工具面：无数据如实说无、手动补录、手机号只留后四位
 *   6. 接入面：入站消息 → 实体 + 一次性信号；重复入站不再发信号
 *
 * 测试封闭：临时目录 + 注入时钟，无网络（丰桥未配置，请求分支根本不会发出）。
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { Signal } from "../src/proactivity/sensors/types.js";
import { extractPackageClue, normalizeTrackingNo } from "../src/services/package-track/express-extract.js";
import { PackageStore } from "../src/services/package-track/package-store.js";
import { createPackageIntake } from "../src/services/package-track/package-intake.js";
import { SfQiaoProvider, buildSfSign, selectProvider } from "../src/services/package-track/express-provider.js";
import {
  createPackageAddHandler,
  createPackageBindPhoneHandler,
  createPackageListHandler,
  createPackageTrackHandler,
} from "../src/tools/package-tools.js";
import type { ToolContext } from "../src/tools/tool-registry.js";

const ACTOR = "tester@qq.com";
/** 裸邮箱 actor 不能被渠道 scoped 剥号规则切坏（CHANNEL_SCOPE_RE 不吃点号，此处锁死） */
const CTX = { sessionId: "sess-1", userId: ACTOR } as ToolContext;

const T0 = Date.UTC(2026, 9, 26, 4, 0, 0);

function clue(platform: string, text: string, title = "") {
  return extractPackageClue({ platform, text, title });
}

// ───────────────────────── 1. 提取 ─────────────────────────

test("extract - 顺丰强形态单号 + 派送状态", () => {
  const c = clue(
    "generic",
    "【顺丰速运】运单号 SF1234567890123 已揽收，快递员正在为您派送，请保持电话畅通",
    "顺丰速运",
  );
  assert.ok(c);
  assert.equal(c!.trackingNo, "SF1234567890123");
  assert.equal(c!.courierCode, "SF");
  assert.equal(c!.courierName, "顺丰速运");
  // 「已揽收」rank2 与「派送中」rank5 同时出现，取当前态高档
  assert.equal(c!.status, "delivering");
});

test("extract - 驿站取件码短信：待取件 + 码 + 单号 + 手机后四位", () => {
  const c = clue(
    "sms",
    "【中通快递】您的快件已到达阳光花园驿站，运单号 7812345678901，取件码 3-2-1145，联系手机 138****6688",
  );
  assert.ok(c);
  assert.equal(c!.trackingNo, "7812345678901");
  assert.equal(c!.courierCode, "ZTO");
  assert.equal(c!.status, "awaiting_pickup");
  assert.equal(c!.pickupCode, "3-2-1145");
  assert.equal(c!.phoneTail, "6688");
});

test("extract - 弱形态纯数字必须过物流语境门", () => {
  const ok = clue("generic", "菜鸟提醒：您的包裹 4651234567890 已到达北京转运中心");
  assert.ok(ok);
  assert.equal(ok!.trackingNo, "4651234567890");
  assert.equal(ok!.status, "arrived");

  const noContext = clue("generic", "系统提示：本次交易金额 4651234567890 元已到账");
  assert.equal(noContext, null);
});

test("extract - 极兔/圆通/京东强形态识别承运商", () => {
  const jt = clue("generic", "【极兔速递】快递单号 JT5123456789012 派送中");
  assert.equal(jt!.courierCode, "JT");
  // 圆通单号位数不定，靠 YT 前缀式收口（纯数字窗口会漏掉 11 位形态）
  const yto = clue("generic", "【圆通速递】运单号 YT1234567890 运输中");
  assert.equal(yto!.courierCode, "YTO");
  const jd = clue("generic", "京东物流：您的包裹 JDVA12345678901 已发出，运输中");
  assert.equal(jd!.courierCode, "JD");
  assert.equal(jd!.status, "in_transit");
});

// ───────────────────────── 2. 误报防线 ─────────────────────────

test("extract - 11 位手机号不当运单号", () => {
  assert.equal(clue("generic", "快递员联系您手机 13812345678 无人接听，请稍后重拨"), null);
});

test("extract - 订单号语境一票否决", () => {
  const c = clue("generic", "拼多多：您的订单号 123456789012345 已发货，物流信息稍后更新");
  assert.equal(c, null);
});

test("extract - 外卖/跑腿归 shopping 流，不生成包裹", () => {
  assert.equal(clue("generic", "美团外卖：骑手已取餐，预计 20 分钟送达，订单 1234567890123"), null);
  assert.equal(clue("generic", "饿了么：您的订单已送达，请及时取餐"), null);
});

test("extract - 非快递营销短信不生成包裹", () => {
  assert.equal(clue("wechat", "双十一预热开启，满 300 减 50，点击领取优惠券"), null);
});

test("extract - 单号大写归一（同一件不因大小写分裂）", () => {
  assert.equal(normalizeTrackingNo(" sf1234567890123 "), "SF1234567890123");
  const lower = clue("sms", "顺丰运单号 sf1234567890123 已签收");
  assert.equal(lower!.trackingNo, "SF1234567890123");
});

// ───────────────────────── 3. 登记表 ─────────────────────────

test("store - 创建 / 跃迁 / 回退拒绝 / 重复 noop", async () => {
  const store = new PackageStore(null);
  const a = clue("generic", "【顺丰速运】运单号 SF7000000000001 已揽收")!;
  const created = await store.ingestPackageClue(ACTOR, a, T0);
  assert.equal(created.kind, "created");
  assert.equal(created.package.status, "picked_up");

  const up = await store.ingestPackageClue(
    ACTOR,
    clue("generic", "【顺丰速运】SF7000000000001 派送中，快递员张师傅")!,
    T0 + 60_000,
  );
  assert.equal(up.kind, "transition");
  assert.equal((up.kind === "transition" ? up.from : null), "picked_up");

  // 营销文案里的「已发货」不能把派送中的件倒回去
  const back = await store.ingestPackageClue(ACTOR, clue("generic", "SF7000000000001 商家已发货")!, T0 + 120_000);
  assert.equal(back.kind, "noop");
  assert.equal(back.package.status, "delivering");

  // 完全相同的一条重复推送：不产生变化也不该再播报
  const dup = await store.ingestPackageClue(ACTOR, a, T0 + 180_000);
  assert.equal(dup.kind, "noop");
});

test("store - 退回发生在签收之后仍要覆盖终态", async () => {
  const store = new PackageStore(null);
  await store.ingestPackageClue(ACTOR, clue("generic", "圆通速递 运单号 YT12345678901 已签收")!, T0);
  const back = await store.ingestPackageClue(
    ACTOR,
    clue("generic", "圆通速递 YT12345678901 快件异常，已按寄件人要求退回")!,
    T0 + 60_000,
  );
  assert.equal(back.kind, "transition");
  assert.equal(back.package.status, "exception");
});

test("store - 同单号跨来源合并成一个实体", async () => {
  const store = new PackageStore(null);
  await store.ingestPackageClue(ACTOR, clue("generic", "菜鸟裹裹：运单号 SF7000000000009 运输中")!, T0);
  const second = await store.ingestPackageClue(
    ACTOR,
    clue("sms", "【顺丰速运】您的快件 SF7000000000009 仍在运输中，已发往上海")!,
    T0 + 60_000,
  );
  // 状态没变但来源多了一条 → enriched（不是 noop）
  assert.equal(second.kind, "enriched");
  assert.deepEqual(second.package.sourcePlatforms.sort(), ["generic", "sms"]);
  const all = await store.listPackages(ACTOR, { includeFinished: true });
  assert.equal(all.length, 1);
});

test("store - 取件码实体在补到运单号后归并，不留双卡", async () => {
  const store = new PackageStore(null);
  const pickupOnly = clue("sms", "【韵达速递】您的快件已存放至丰巢柜，取件码 889900，请尽快取件")!;
  assert.equal(pickupOnly.trackingNo, null);
  await store.ingestPackageClue(ACTOR, pickupOnly, T0);
  assert.equal((await store.listPackages(ACTOR, { includeFinished: true })).length, 1);

  const withNo = clue("generic", "菜鸟裹裹：韵达速递 4651234567891 已入柜，取件码 889900")!;
  await store.ingestPackageClue(ACTOR, withNo, T0 + 60_000);
  const merged = await store.listPackages(ACTOR, { includeFinished: true });
  assert.equal(merged.length, 1, "取件码孪生实体应被运单号实体吸收");
  assert.equal(merged[0]!.trackingNo, "4651234567891");
  assert.ok(merged[0]!.sourcePlatforms.includes("sms"));
});

test("store - 落盘往返：新实例读得到上一进程的包裹", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pkg-store-"));
  try {
    const file = join(dir, "packages.json");
    const first = new PackageStore(file);
    await first.ingestPackageClue(ACTOR, clue("generic", "顺丰 SF7000000000021 派送中")!, T0);
    await first.setContactPhone(ACTOR, "13800001234", T0);
    await first.flush();

    const second = new PackageStore(file);
    const list = await second.listPackages(ACTOR);
    assert.equal(list.length, 1);
    assert.equal(list[0]!.trackingNo, "SF7000000000021");
    assert.deepEqual(await second.getContactPhone(ACTOR), { phoneTail: "1234" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("store - 列表默认不含已签收，status=all 才给", async () => {
  const store = new PackageStore(null);
  await store.ingestPackageClue(ACTOR, clue("generic", "顺丰 SF7000000000031 已签收")!, T0);
  await store.ingestPackageClue(ACTOR, clue("generic", "顺丰 SF7000000000032 运输中")!, T0);
  assert.equal((await store.listPackages(ACTOR)).length, 1);
  assert.equal((await store.listPackages(ACTOR, { includeFinished: true })).length, 2);
});

// ───────────────────────── 4. provider ─────────────────────────

test("provider - 未配置密钥时 fail-closed，不发出请求也不编轨迹", async () => {
  const provider = new SfQiaoProvider({});
  assert.equal(provider.configured(), false);
  const outcome = await provider.queryRoutes({ trackingNo: "SF123", courierCode: "SF", phoneTail: null });
  assert.equal(outcome.ok, false);
  if (!outcome.ok) {
    assert.equal(outcome.reason, "unconfigured");
    assert.match(outcome.error, /SF_QIAO_PARTNER_ID/);
  }
  assert.equal(selectProvider([provider], "SF", "SF123"), null);
});

test("provider - 跨承运商默认只放开顺丰，白名单需显式配置", () => {
  const provider = new SfQiaoProvider({ SF_QIAO_PARTNER_ID: "p", SF_QIAO_CHECK_WORD: "w" });
  assert.equal(provider.supports("SF", "SF1234567890123"), true);
  assert.equal(provider.supports("ZTO", "7812345678901"), false);
  assert.equal(provider.supports(null, "7812345678901"), false);
  // 承运商没认出来但单号是顺丰形态：允许试查
  assert.equal(provider.supports(null, "SF1234567890123"), true);

  const widened = new SfQiaoProvider({
    SF_QIAO_PARTNER_ID: "p",
    SF_QIAO_CHECK_WORD: "w",
    SF_QIAO_EXTRA_COURIERS: "zto,yd",
  });
  assert.equal(widened.supports("ZTO", "7812345678901"), true);
  assert.equal(widened.supports("YD", "4651234567891"), true);
});

test("provider - 签名可复现（Base64(MD5hex(msg+timestamp+word))）", () => {
  assert.equal(buildSfSign("msg", "1700000000", "word"), buildSfSign("msg", "1700000000", "word"));
  assert.notEqual(buildSfSign("msg", "1700000000", "word"), buildSfSign("msg", "1700000001", "word"));
});

// ───────────────────────── 5. 工具面 ─────────────────────────

test("tools - 无数据时如实说没有，不编件数", async () => {
  const store = new PackageStore(null);
  const res = await createPackageListHandler({ store, providers: [] })({}, CTX);
  assert.equal(res.ok, true);
  assert.equal(res.hasPackages, false);
  assert.match(String(res.summary), /暂无在途包裹/);
  assert.match(String(res.hint), /绝不编造/);
});

test("tools - 列出在途包裹并带出取件码", async () => {
  const store = new PackageStore(null);
  await store.ingestPackageClue(
    ACTOR,
    clue("sms", "【中通快递】运单号 7812345678901 已到驿站，取件码 3-2-1145")!,
    T0,
  );
  const res = await createPackageListHandler({ store, providers: [] })({}, CTX);
  assert.equal(res.count, 1);
  assert.match(String(res.summary), /中通快递 7812345678901 待取件，取件码 3-2-1145/);
});

test("tools - 补录：形态非法拒绝；合法入库并说明轨迹后端缺失", async () => {
  const store = new PackageStore(null);
  const add = createPackageAddHandler({ store, providers: [new SfQiaoProvider({})] });

  const bad = await add({ trackingNo: "123" }, CTX);
  assert.equal(bad.ok, false);
  assert.match(String(bad.error), /形态不合法/);

  const good = await add({ trackingNo: "sf7000000000044", phoneTail: "6688" }, CTX);
  assert.equal(good.ok, true);
  assert.equal(good.trackingNo, "SF7000000000044");
  assert.match(String(good.summary), /未配置轨迹查询后端/);
  assert.deepEqual(good.trajectory, [], "后端未配置时不得给出任何轨迹点");

  const track = await createPackageTrackHandler({ store, providers: [new SfQiaoProvider({})] })(
    { trackingNo: "SF7000000000044" },
    CTX,
  );
  assert.equal(track.found, true);
  assert.equal(track.phoneTail, "6688");
  assert.match(String(track.note), /未配置/);
});

test("tools - 查不存在的单号时不猜承运商，提示补录", async () => {
  const store = new PackageStore(null);
  const res = await createPackageTrackHandler({ store, providers: [] })({ trackingNo: "SF9999999999999" }, CTX);
  assert.equal(res.found, false);
  assert.match(String(res.hint), /package\.add/);
});

test("tools - 绑定手机号只留后四位", async () => {
  const store = new PackageStore(null);
  const bind = createPackageBindPhoneHandler({ store, providers: [] });
  const bad = await bind({ phone: "123456" }, CTX);
  assert.equal(bad.ok, false);

  const ok = await bind({ phone: "13800001234" }, CTX);
  assert.equal(ok.ok, true);
  assert.equal(ok.phoneTail, "1234");
  assert.ok(!JSON.stringify(ok).includes("13800001234"), "返回值不得回显完整手机号");

  const res = await bind({ phone: "13800005678" }, CTX);
  assert.equal(res.phoneTail, "5678");
  assert.equal((await store.getContactPhone(ACTOR))?.phoneTail, "5678", "重复绑定覆盖而非追加");
});

// ───────────────────────── 6. 接入面 ─────────────────────────

test("intake - 入站消息生成实体并发一次信号；重复入站不再发", async () => {
  const store = new PackageStore(null);
  const emitted: Array<Omit<Signal, "stream">> = [];
  const intake = createPackageIntake({
    store,
    emit: (s) => emitted.push(s),
    now: () => T0,
  });

  intake({
    actorId: ACTOR,
    platform: "generic",
    title: "菜鸟裹裹",
    text: "【顺丰速运】SF7000000000055 已揽收，正在派送中",
  });
  await new Promise((r) => setImmediate(r));
  await store.flush();

  assert.equal(emitted.length, 1);
  // 首次发现一个"派送中"的件：值得记账，但不足以高优先开口（待取件才是行动项）
  assert.equal(emitted[0]!.salience, "low");
  assert.match(emitted[0]!.delta, /顺丰速运 SF7000000000055 派送中/);
  assert.equal(emitted[0]!.actorId, ACTOR, "裸邮箱 actor 不被渠道剥号规则切坏");

  // 同一条通知被系统重复上报（同状态同来源）→ noop → 不再开口
  intake({
    actorId: ACTOR,
    platform: "generic",
    title: "菜鸟裹裹",
    text: "【顺丰速运】SF7000000000055 正在派送中",
  });
  await new Promise((r) => setImmediate(r));
  await store.flush();
  assert.equal(emitted.length, 1, "noop 不应产生第二次播报信号");

  // 跃迁到待取件 → 高优先，值得开口
  intake({
    actorId: ACTOR,
    platform: "sms",
    text: "【顺丰速运】SF7000000000055 已放入丰巢柜，取件码 654321",
  });
  await new Promise((r) => setImmediate(r));
  await store.flush();
  assert.equal(emitted.length, 2);
  assert.equal(emitted[1]!.salience, "high");
  assert.match(emitted[1]!.delta, /取件码 654321/);
});

test("intake - 非快递消息不产生任何实体", async () => {
  const store = new PackageStore(null);
  const emitted: unknown[] = [];
  const intake = createPackageIntake({ store, emit: (s) => emitted.push(s), now: () => T0 });
  intake({ actorId: ACTOR, platform: "wechat", text: "群友：明天上午十点开会，记得带方案" });
  await new Promise((r) => setImmediate(r));
  await store.flush();
  assert.equal(emitted.length, 0);
  assert.equal(store.stats().total, 0);
});
