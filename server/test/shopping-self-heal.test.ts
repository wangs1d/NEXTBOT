/**
 * 自愈取数管线单测（shopping-platforms/self-heal.ts）。
 *
 * 覆盖：
 *   1. 层级顺序：css 命中即返回，不再走后续层
 *   2. css 抓空 → 滚动重试 → 语义层兜底
 *   3. 全部落空 → 视觉层（注入时）兜底；未注入则止于语义层
 *   4. 单层抛异常不中断管线
 *   5. parseVisionProducts 纯函数：围栏容忍/字段校验/去重/上限
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { extractWithSelfHeal, parseVisionProducts } from "../src/services/shopping-platforms/self-heal.js";
import type { ProductSummary } from "../src/services/shopping-platforms/types.js";

const P = (title: string, price: number): ProductSummary => ({ title, price, currency: "CNY" });

// extractWithSelfHeal 只在 css_retry 层调用 page（scrollAndSettle），
// 测试里给一个最小假 Page（方法全部 no-op / 返回空）。
const fakePage = {
  evaluate: async () => undefined,
  waitForTimeout: async () => undefined,
} as unknown as Parameters<typeof extractWithSelfHeal>[0];

test("自愈：CSS 命中即返回，不走语义/视觉层", async () => {
  let semanticCalls = 0;
  let visionCalls = 0;
  const res = await extractWithSelfHeal(fakePage, {
    cssExtract: async () => [P("CSS 商品", 99)],
    semanticExtract: async () => {
      semanticCalls += 1;
      return [P("语义商品", 88)];
    },
    visionExtract: async () => {
      visionCalls += 1;
      return [P("视觉商品", 77)];
    },
  });
  assert.deepEqual(res.products, [P("CSS 商品", 99)]);
  assert.deepEqual(res.attempts, ["css"]);
  assert.equal(semanticCalls, 0, "CSS 命中时语义层不应被调用");
  assert.equal(visionCalls, 0, "CSS 命中时视觉层不应被调用");
});

test("自愈：CSS 两次抓空 → 语义层兜底命中", async () => {
  let cssCalls = 0;
  const res = await extractWithSelfHeal(fakePage, {
    cssExtract: async () => {
      cssCalls += 1;
      return [];
    },
    semanticExtract: async () => [P("语义兜底商品", 66)],
  });
  assert.deepEqual(res.products, [P("语义兜底商品", 66)]);
  assert.deepEqual(res.attempts, ["css", "css_retry", "semantic"], `实际：${res.attempts.join(">")}`);
  assert.equal(cssCalls, 2, "CSS 应该被重试一次（懒加载自愈）");
});

test("自愈：全部结构化层落空 → 视觉层兜底；未注入视觉则止于语义层", async () => {
  const empty = async (): Promise<ProductSummary[]> => [];
  const withVision = await extractWithSelfHeal(fakePage, {
    cssExtract: empty,
    semanticExtract: empty,
    visionExtract: async () => [P("视觉兜底商品", 55)],
  });
  assert.deepEqual(withVision.products, [P("视觉兜底商品", 55)]);
  assert.deepEqual(withVision.attempts, ["css", "css_retry", "semantic", "vision"]);

  const withoutVision = await extractWithSelfHeal(fakePage, {
    cssExtract: empty,
    semanticExtract: empty,
  });
  assert.deepEqual(withoutVision.products, []);
  assert.deepEqual(withoutVision.attempts, ["css", "css_retry", "semantic"], "未注入视觉层不得假装走过");
});

test("自愈：单层抛异常不中断管线（css 抛错 → 语义层仍被尝试）", async () => {
  const res = await extractWithSelfHeal(fakePage, {
    cssExtract: async () => {
      throw new Error("selector exploded");
    },
    semanticExtract: async () => [P("语义层救场", 33)],
  });
  assert.deepEqual(res.products, [P("语义层救场", 33)]);
  assert.ok(res.attempts.includes("semantic"));
});

test("parseVisionProducts：容忍围栏与说明文字，字段校验 + 去重 + 上限", () => {
  const raw = [
    "模型说明：以下是解析结果",
    "```json",
    JSON.stringify([
      { title: "红牛维生素功能饮料250ml*24罐", price: 118 },
      { title: "红牛维生素功能饮料250ml*24罐", price: 120 }, // 重复 → 去重
      { title: "x", price: 10 }, // 标题太短 → 丢弃
      { title: "负价商品", price: -5 }, // 非法价 → 丢弃
      { title: "字符串价商品", price: "45.8" }, // 数字字符串 → 接受
      { title: "天价商品", price: 99_999_999 }, // 超上限 → 丢弃
    ]),
    "```",
    "以上仅供参考",
  ].join("\n");
  const products = parseVisionProducts(raw, 10);
  assert.equal(products.length, 2);
  assert.equal(products[0]!.title, "红牛维生素功能饮料250ml*24罐");
  assert.equal(products[0]!.price, 118);
  assert.equal(products[1]!.title, "字符串价商品");
  assert.equal(products[1]!.price, 45.8);

  // limit 截断
  const truncated = parseVisionProducts(JSON.stringify([{ title: "A商品", price: 1 }, { title: "B商品", price: 2 }]), 1);
  assert.equal(truncated.length, 1);

  // 非法输入 → 空数组不抛
  assert.deepEqual(parseVisionProducts("不是 JSON", 5), []);
  assert.deepEqual(parseVisionProducts("", 5), []);
});
