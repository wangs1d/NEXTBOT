/**
 * shopping.compare.* 工具意图元数据 + 关键词分类映射。
 *
 * `SHOPPING_COMPARE_INTENT_RULES` 接 BM25 调权；`SHOPPING_COMPARE_CATEGORY_MAPPING`
 * 供 `TOOL_CATEGORY_MAPPINGS` 合并（关键词命中时把本模块工具注入候选分类）。
 *
 * 边界区分（negativeAliases / negativeExamples）：
 *   - shopping.order.place（真实下单，本模块只读零副作用）
 *   - shopping.suggest（单平台建议，本模块跨平台聚合）
 *   - finance.deep / 记账（消费记录，不是比价）
 */
import type { ToolIntentRule } from "../../tool-search/intent-metadata.js";

export const SHOPPING_COMPARE_INTENT_RULES: ToolIntentRule[] = [
  {
    prefix: "shopping.compare.",
    metadata: {
      aliases: [
        "compare price", "price compare", "price comparison", "best price", "cheapest",
        "compare insurance", "quote comparison", "price drop alert", "price watch",
        "比价", "价格对比", "对比价格", "哪家便宜", "哪个平台便宜", "最低价", " cheapest",
        "哪买便宜", "哪里买便宜", "在哪买便宜", "哪儿买便宜", "哪买划算", "哪里便宜", "哪个最便宜", "哪家最便宜",
        "降价", "降价提醒", "到价提醒", "便宜的", "货比三家", "保险对比", "服务对比",
      ],
      negativeAliases: [
        "place order", "buy", "checkout", "purchase", "下单", "购买", "帮我买", "结算",
        "record expense", "bookkeeping", "记账", "消费记录",
        "suggest", "推荐买什么",
      ],
      examples: [
        "帮我比价 iPhone 15",
        "伊利纯牛奶哪个平台便宜",
        "买之前帮我对比一下价格",
        "帮我对比一下百万医疗险哪家好",
        "这台手机降到 5000 以内提醒我",
        "compare price for airpods pro across platforms",
      ],
      negativeExamples: [
        "帮我在淘宝下单买箱牛奶",
        "记一下这笔消费",
        "帮我推荐买什么手机",
      ],
    },
  },
  {
    exact: "shopping.compare.prices",
    metadata: {
      aliases: [
        "跨平台比价", "多平台比价", "同款比价", "比价", "价格对比", "哪个便宜", "哪家便宜", "最低价",
        "哪买便宜", "哪里买便宜", "在哪买便宜", "哪儿买便宜", "哪买划算", "哪里便宜",
      ],
      examples: [
        "帮我比价一下戴森吹风机",
        "这个扫地机器人在京东和淘宝哪个便宜",
        "compare prices for dyson supersonic",
      ],
      negativeExamples: [
        "帮我在京东下单这个吹风机",
        "帮我对比一下保险产品条款",
      ],
    },
  },
  {
    exact: "shopping.compare.research",
    metadata: {
      aliases: [
        "保险对比", "保险比价", "服务对比", "套餐对比", "调研对比", "条款对比",
        "百万医疗险对比", "宽带对比", "话费套餐对比", "会员对比",
      ],
      examples: [
        "帮我对比一下好医保和平安e生保",
        "移动联通电信哪个套餐划算，帮我调研下",
        "比较一下视频会员各平台价格",
      ],
      negativeExamples: [
        "帮我比价 iPhone 15",
        "在淘宝搜一下牛奶",
      ],
    },
  },
  {
    exact: "shopping.compare.watch",
    metadata: {
      aliases: [
        "降价提醒", "降价监控", "到价提醒", "价格监控", "盯着价格", "降了告诉我",
        "price drop alert", "watch price",
      ],
      examples: [
        "AirPods Pro 降到 1500 以内告诉我",
        "帮我盯着这个显卡的价格，降了提醒我",
        "不要再提醒我电脑降价了",
      ],
      negativeExamples: [
        "现在这个商品多少钱", // 即时查价走 compare.prices
        "下单买这个",
      ],
    },
  },
];

export const SHOPPING_COMPARE_CATEGORY_MAPPING: { name: string; keywords: string[] } = {
  name: "shopping_compare",
  keywords: [
    "compare", "comparison", "price compare", "cheapest", "best price", "price drop", "price watch",
    "比价", "价格对比", "对比价格", "哪家便宜", "哪个便宜", "哪个平台便宜", "最低价",
    "哪买便宜", "哪里买便宜", "在哪买便宜", "哪儿买便宜", "哪买划算", "哪里便宜", "哪个最便宜", "哪家最便宜",
    "降价", "降价提醒", "到价提醒", "货比三家",
    "保险对比", "保险比价", "套餐对比", "服务对比", "条款对比", "医疗险对比", "宽带对比",
    "盯着价格", "降了告诉我",
  ],
};
