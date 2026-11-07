/**
 * 免登录取价源（手机端云端浏览器链路）单元测试。
 *
 * 背景：手机端没有可视浏览器，比价必须靠服务端无头 chromium。而淘宝/京东/
 * 拼多多在无登录态下整站被拦登录页，缺省集合若仍放这几家，链路一开跑就只能
 * 出登录二维码、一个价也拿不到。这里钉住三件事：
 *   1. 缺省比价集合只含「匿名可读真实价」的平台；
 *   2. 平台搜索页的相关推荐不能混进比价结果（搜 AirPods 出漫步者耳机）；
 *   3. 爆料价源在卡片上必须标明「非结算实时价」，不能当成官方现价。
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  filterSameProduct,
  latinCoreToken,
} from "../src/services/shopping-compare-service.js";
import {
  listDefaultComparePlatforms,
  listLoginRequiredL1Platforms,
  listSupportedPlatforms,
} from "../src/services/shopping-platforms/index.js";
import { buildToolCard } from "../src/services/tool-card-registry.js";
import { applyCards } from "../src/render/cards.js";
import type { ProductSummary } from "../src/services/shopping-platforms/types.js";

test("缺省比价集合只含匿名可读平台（苏宁/什么值得买），登录平台另列", () => {
  const defaults = listDefaultComparePlatforms();
  assert.deepEqual(defaults.sort(), ["smzdm", "suning"]);
  // 登录类平台不在缺省里，但仍是「可实现平台」——用户显式指定时照常可用
  const loginOnly = listLoginRequiredL1Platforms();
  for (const p of ["taobao", "tmall", "jd", "pdd", "douyin"]) {
    assert.ok(loginOnly.includes(p), `${p} 应标为需要登录态`);
    assert.ok(!defaults.includes(p), `${p} 不应出现在缺省比价集合`);
    assert.ok(listSupportedPlatforms().includes(p), `${p} 仍应可用（显式指定）`);
  }
});

test("latinCoreToken 取最长的字母数字词（型号/品牌）", () => {
  assert.equal(latinCoreToken("AirPods Pro 2"), "airpods");
  assert.equal(latinCoreToken("伊利纯牛奶 250ml*24盒"), "250ml");
  assert.equal(latinCoreToken("保温杯"), "");
});

test("filterSameProduct 丢弃相关推荐与无价条目", () => {
  const products: ProductSummary[] = [
    // 同款（标题含 airpods）
    { title: "百亿补贴：Apple AirPods Pro 2 入耳式降噪蓝牙耳机", price: 1099 },
    // 相关推荐：漫步者耳机，与 AirPods 无关
    { title: "EDIFIER/漫步者 G1 Pro头戴式耳机游戏电竞耳麦", price: 119 },
    // 同款但没读到价 → 丢弃
    { title: "Apple AirPods Pro 2 港版", price: undefined },
    // 相关文章，无价
    { title: "airpods pro2 苹果党必备产品", price: undefined },
  ];
  const kept = filterSameProduct("AirPods Pro 2", products);
  assert.equal(kept.length, 1);
  assert.equal(kept[0]!.price, 1099);
});

test("filterSameProduct 挡掉配件（搜 AirPods 不出耳机套）", () => {
  const products: ProductSummary[] = [
    { title: "磁吸式耳机套 亿色 适用 AirPods Pro3", price: 76.4 },
    { title: "国家补贴、今日必买：苹果 AirPods Pro 3 无线降噪", price: 1022 },
  ];
  const kept = filterSameProduct("AirPods Pro", products);
  assert.deepEqual(kept.map((p) => p.price), [1022]);
  // 用户明确要配件时不拦（查询里点名了配件词）
  const keptAcc = filterSameProduct("AirPods Pro 耳机套", products);
  assert.deepEqual(keptAcc.map((p) => p.price), [76.4]);
});

test("filterSameProduct 挡掉同类不同品牌（搜蒙牛不出伊利）", () => {
  const products: ProductSummary[] = [
    { title: "蒙牛全脂纯牛奶 250ml*24盒", price: 81.5 },
    { title: "[9月生产]伊利纯牛奶250ml*24盒*2箱严选牧场", price: 110.4 },
  ];
  const kept = filterSameProduct("蒙牛纯牛奶 250ml*24盒", products);
  assert.deepEqual(kept.map((p) => p.price), [81.5]);
});


test("filterSameProduct 中文长查询靠相似度兜住，不被包含式匹配全灭", () => {
  const products: ProductSummary[] = [
    { title: "伊利纯牛奶 250ml*24盒 整箱", price: 55.2 },
    { title: "伊利金典纯牛奶250ml*24盒整箱环保装", price: 37.03 },
    { title: "伊利 纯牛奶250ml*21盒/箱 全脂牛奶", price: 48.3 },
  ];
  const kept = filterSameProduct("伊利纯牛奶 250ml*24盒", products);
  assert.ok(kept.length >= 2, `应保留同款，实际保留 ${kept.length} 条`);
});

test("比价卡：含什么值得买时必须标注「非结算实时价」", () => {
  const card = buildToolCard("shopping.compare.prices", {
    ok: true,
    query: "AirPods Pro 2",
    platforms: ["smzdm"],
    searchedPlatforms: ["smzdm"],
    bestIndex: 0,
    groups: [
      {
        normalizedTitle: "apple airpods pro 2",
        matchType: "exact",
        confidence: 1,
        minPriceCny: 1099,
        specTokens: [],
        offers: [
          {
            platform: "smzdm",
            title: "百亿补贴：Apple AirPods Pro 2",
            priceCny: 1099,
            url: "https://www.smzdm.com/p/1/",
            imageUrl: "/agent/images/a/1.png",
          },
        ],
      },
    ],
  });
  assert.ok(card, "应出比价卡");
  assert.match(card!.footer ?? "", /什么值得买/);
  assert.match(card!.footer ?? "", /非结算实时价/);
  const shopping = (card!.extra as { shopping?: { items?: Array<Record<string, unknown>> } }).shopping;
  assert.equal(shopping?.items?.[0]?.image, "/agent/images/a/1.png");
  assert.equal(shopping?.items?.[0]?.platformLabel, "什么值得买");
});

test("比价卡：纯实时价源不出现爆料价说明", () => {
  const card = buildToolCard("shopping.compare.prices", {
    ok: true,
    query: "伊利纯牛奶",
    platforms: ["suning"],
    searchedPlatforms: ["suning"],
    bestIndex: 0,
    groups: [
      {
        normalizedTitle: "伊利纯牛奶",
        matchType: "exact",
        confidence: 1,
        minPriceCny: 48.3,
        specTokens: [],
        offers: [{ platform: "suning", title: "伊利纯牛奶 250ml*24盒", priceCny: 48.3 }],
      },
    ],
  });
  assert.ok(card);
  assert.doesNotMatch(card!.footer ?? "", /爆料价/);
});

test("同 cardType 不重复建卡（done 阶段兜底补卡不会叠两张比价卡）", () => {
  const payload = {
    title: "比价结果：AirPods Pro 2",
    items: [{ type: "num", text: "¥1099 [什么值得买] AirPods Pro 2" }],
    cardType: "price_compare",
    extra: { shopping: { stage: "candidates", items: [{ title: "x", price: 1099 }] } },
  };
  const already = `正文\n[AGENT_RESULT_CARD_START]\n${JSON.stringify(payload)}\n[AGENT_RESULT_CARD_END]`;
  const applied = applyCards(already, {
    cards: [{ kind: "card", topic: "price_compare", payload }],
    body: { form: "plain", reason: "test" },
    reason: "test",
    scene: { id: "tool_cards", label: "工具卡面", reason: "test" },
  } as never);
  const count = applied.text.split("[AGENT_RESULT_CARD_START]").length - 1;
  assert.equal(count, 1, "已有同类型卡时不应再追加一张");
});
