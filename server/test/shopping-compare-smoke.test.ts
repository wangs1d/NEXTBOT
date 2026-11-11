/**
 * shopping-compare 能力模块安全冒烟测试。
 *
 * 验证逻辑（只读零副作用，不触网）：
 *   1. 工具 schema（3 个工具名 + 参数结构）
 *   2. ToolRegistry 注册
 *   3. 标题归一化 / 规格 token / Dice 相似度
 *   4. 跨平台同款分组（同款聚合 + 异款隔离）
 *   5. 降价监控：add/remove/list、平台校验、到价命中去重
 *   6. ShoppingOrderStore：落库/查重/单日金额累计/状态映射
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ShoppingCompareService,
  diceSimilarity,
  extractSpecTokens,
  groupSameProducts,
  normalizeTitle,
  type TaggedProduct,
} from "../src/services/shopping-compare-service.js";
import {
  ShoppingOrderStore,
  localDateKey,
  mapPlatformStatusText,
  newShoppingOrderId,
} from "../src/services/shopping-order-store.js";
import {
  SHOPPING_COMPARE_CHAT_TOOLS,
  SHOPPING_COMPARE_INTENT_RULES,
  registerShoppingCompareTools,
} from "../src/tools/capability-modules/shopping-compare/index.js";
import type { ShoppingOrderService } from "../src/services/shopping-order-service.js";
import type { ToolContext, ToolHandler, ToolRegistry } from "../src/tools/tool-registry.js";

class MockRegistry {
  readonly handlers = new Map<string, ToolHandler>();
  register(name: string, handler: ToolHandler): void {
    this.handlers.set(name, handler);
  }
}

/** stub：只实现比价服务用到的 ShoppingOrderService 方法。 */
function stubOrderService(platforms = ["taobao", "jd"]): ShoppingOrderService {
  return {
    listSupportedPlatforms: () => platforms,
  } as unknown as ShoppingOrderService;
}

function makeCtx(): ToolContext {
  return { sessionId: "test-session-compare", userId: "test-user-compare" };
}

function tag(platform: string, title: string, price?: number): TaggedProduct {
  return { platform, product: { title, price, url: `https://${platform}.com/x` } };
}

test("SHOPPING_COMPARE_CHAT_TOOLS 是单个复合工具，action 覆盖比价/调研/监控", () => {
  const names = SHOPPING_COMPARE_CHAT_TOOLS
    .map((t) => (t.type === "function" ? t.function?.name : null))
    .filter((n): n is string => Boolean(n));
  assert.deepEqual(names, ["shopping.compare"]);
  const tool = SHOPPING_COMPARE_CHAT_TOOLS[0];
  assert.equal(tool?.type, "function");
  assert.ok(tool?.function.description?.length);
  const params = tool?.function.parameters as
    | { required?: string[]; additionalProperties?: boolean; properties?: Record<string, { enum?: string[] }> }
    | undefined;
  assert.equal(params?.additionalProperties, false);
  assert.deepEqual(params?.required, ["action"]);
  assert.deepEqual(params?.properties?.action?.enum, [
    "prices",
    "research",
    "watch_add",
    "watch_remove",
    "watch_list",
  ]);
});

test("registerShoppingCompareTools 只注册 1 个复合工具", () => {
  const registry = new MockRegistry();
  const service = {} as ShoppingCompareService;
  registerShoppingCompareTools(registry as unknown as ToolRegistry, { shoppingCompareService: service });
  assert.equal(registry.handlers.size, 1);
  assert.ok(registry.handlers.has("shopping.compare"));
});

test("SHOPPING_COMPARE_INTENT_RULES 合并为单条规则，保留下单负例", () => {
  const rules = SHOPPING_COMPARE_INTENT_RULES;
  assert.equal(rules.length, 1);
  assert.equal((rules[0] as { exact?: string }).exact, "shopping.compare");
  const meta = rules[0]?.metadata;
  assert.ok(meta?.negativeAliases?.some((a) => /下单|购买/.test(a)));
  assert.ok(meta?.aliases?.some((a) => /比价/.test(a)));
  assert.ok(meta?.aliases?.some((a) => /降价/.test(a)));
  assert.ok(meta?.aliases?.some((a) => /保险/.test(a)));
});

test("normalizeTitle strips marketing noise; extractSpecTokens finds specs", () => {
  const n = normalizeTitle("【天猫正品】伊利 纯牛奶 250ml*24盒/箱 2026新款 包邮");
  assert.ok(!n.includes("正品"), `营销词未剔除：${n}`);
  assert.ok(n.includes("伊利"), `品牌应保留：${n}`);
  const specs = extractSpecTokens("伊利纯牛奶250ml*24盒 整箱");
  assert.ok(specs.includes("250ml"), `容量规格应提取：${specs.join(",")}`);
  assert.ok(specs.some((s) => s.includes("24")), `数量规格应提取：${specs.join(",")}`);
});

test("diceSimilarity: identical=1, unrelated low", () => {
  assert.equal(diceSimilarity("伊利纯牛奶 250ml", "伊利 纯牛奶 250ml"), 1);
  const sim = diceSimilarity("伊利纯牛奶 250ml*24盒", "苹果 iPhone 15 Pro 手机");
  assert.ok(sim < 0.3, `无关商品相似度应低：${sim}`);
});

test("groupSameProducts groups same product across platforms and separates different ones", () => {
  const items: TaggedProduct[] = [
    tag("taobao", "【旗舰店】戴森吹风机 HD08 紫红色 正品包邮", 3299),
    tag("jd", "戴森吹风机 HD08 紫红色", 3199),
    tag("pdd", "益禾堂 纸吸管 100支装", 9.9),
  ];
  const groups = groupSameProducts(items);
  assert.equal(groups.length, 2, `应分 2 组（同款聚合 + 异款隔离）：${JSON.stringify(groups.map((g) => g.normalizedTitle))}`);
  // 戴森组：两平台报价，最低 3199（jd）
  const dyson = groups.find((g) => g.normalizedTitle.includes("hd08")) ?? groups.find((g) => g.offers.length === 2);
  assert.ok(dyson, "应存在 2 报价的戴森组");
  assert.equal(dyson!.offers.length, 2);
  assert.equal(dyson!.minPriceCny, 3199);
  assert.equal(dyson!.offers[0]?.platform, "jd", "组内按价格升序，jd 3199 在前");
});

test("groupSameProducts：数量规格不一致不并组（2罐 vs 24瓶）", () => {
  const items: TaggedProduct[] = [
    tag("taobao", "红牛维生素功能饮料250ml*2罐装 中国红牛", 21),
    tag("jd", "红牛维生素功能饮料250ml*24瓶 整箱装", 118),
  ];
  const groups = groupSameProducts(items);
  assert.equal(groups.length, 2, `规格冲突不得归入同组：${JSON.stringify(groups.map((g) => g.specTokens))}`);
});

test("groupSameProducts：单边无规格不并组（无法验证同数量）", () => {
  const items: TaggedProduct[] = [
    tag("taobao", "红牛维生素功能饮料", 8),
    tag("jd", "红牛维生素功能饮料250ml*2罐装", 21),
  ];
  const groups = groupSameProducts(items);
  assert.equal(groups.length, 2, `规格无法验证宁可拆开：${JSON.stringify(groups.map((g) => g.specTokens))}`);
});

test("watch add/list/remove with platform validation and persistence", async () => {
  const dir = await mkdtemp(join(tmpdir(), "shopping-compare-"));
  try {
    const service = new ShoppingCompareService({
      shoppingOrderService: stubOrderService(),
      dataDir: dir,
    });
    const watches = await service.addWatch("actor-a", "iPhone 15", "taobao", 4500);
    assert.equal(watches.length, 1);
    assert.equal(watches[0]?.query, "iPhone 15");

    // 不支持的平台拒绝
    await assert.rejects(() => service.addWatch("actor-a", "iPhone 15", "damai", 4500), /暂不支持/);
    // 非法目标价拒绝
    await assert.rejects(() => service.addWatch("actor-a", "iPhone 15", "taobao", -1), /targetPrice/);

    // 同名合并（更新目标价，不新增）
    const merged = await service.addWatch("actor-a", "iphone 15", "taobao", 4000);
    assert.equal(merged.length, 1);
    assert.equal(merged[0]?.targetPrice, 4000);

    // 按 id 移除
    const id = watches[0]?.id ?? "";
    const afterRemove = await service.removeWatch("actor-a", id);
    assert.equal(afterRemove.length, 0);
    await service.flush();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("checkWatch triggers onPriceAlert below target and dedupes same price", async () => {
  const dir = await mkdtemp(join(tmpdir(), "shopping-compare-"));
  try {
    const alerts: Array<{ actorId: string; price: number }> = [];
    let currentPrice = 4499;
    const stub = {
      listSupportedPlatforms: () => ["taobao"],
      searchProduct: async () => ({
        ok: true,
        summary: "ok",
        products: [{ title: "iPhone 15 128g", price: currentPrice, url: "https://taobao.com/x" }],
      }),
    } as unknown as ShoppingOrderService;
    const service = new ShoppingCompareService({
      shoppingOrderService: stub,
      dataDir: dir,
    });
    service.setOnPriceAlert((actorId, _watch, hit) => {
      alerts.push({ actorId, price: hit.priceCny });
    });
    await service.addWatch("actor-a", "iPhone 15", "taobao", 4500);
    const [watch] = service.listWatches("actor-a");

    // 第一次：4499 ≤ 4500 → 命中
    assert.equal(await service.checkWatch(watch!), true);
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0]?.price, 4499);

    // 同价位（4499 仍在）→ 不重复推
    assert.equal(await service.checkWatch(watch!), false);
    assert.equal(alerts.length, 1);

    // 新低价 4300 → 再次命中
    currentPrice = 4300;
    assert.equal(await service.checkWatch(watch!), true);
    assert.equal(alerts.length, 2);
    assert.equal(alerts[1]?.price, 4300);

    // 高于目标价 → 不推
    currentPrice = 4999;
    assert.equal(await service.checkWatch(watch!), false);
    assert.equal(alerts.length, 2);
    await service.flush();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ShoppingOrderStore: create/findByPlatformOrder/sumAmountOnDate/status mapping", async () => {
  const store = new ShoppingOrderStore(null); // 纯内存
  const now = new Date();
  const order = await store.create({
    orderId: newShoppingOrderId(now),
    actorId: "actor-a",
    platform: "taobao",
    platformOrderId: "123456789",
    title: "测试商品",
    quantity: 2,
    amountCny: 199.8,
    status: "pending_payment",
    addressSummary: null,
    paymentUrl: null,
    checkoutUrl: null,
    note: null,
    dateKey: localDateKey(now),
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  });

  assert.ok((await store.get(order.orderId)));
  assert.equal((await store.findByPlatformOrder("actor-a", "taobao", "123456789"))?.orderId, order.orderId);
  assert.equal(await store.findByPlatformOrder("actor-b", "taobao", "123456789"), null, "跨 actor 不串");

  // 单日累计
  const dayKey = localDateKey(now);
  assert.equal(await store.sumAmountOnDate("actor-a", dayKey), 199.8);
  // 取消后不计入
  await store.update(order.orderId, { status: "cancelled" });
  assert.equal(await store.sumAmountOnDate("actor-a", dayKey), 0);

  // 平台状态文案 → 本地状态映射
  assert.equal(mapPlatformStatusText("等待买家付款"), "pending_payment");
  assert.equal(mapPlatformStatusText("已发货，运输中"), "shipped");
  assert.equal(mapPlatformStatusText("交易成功"), "completed");
  assert.equal(mapPlatformStatusText("交易关闭"), "cancelled");
  assert.equal(mapPlatformStatusText("未知文案xyz"), null);
});
