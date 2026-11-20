/**
 * ride_hailing.* 工具意图元数据 + 关键词分类映射。
 *
 * 2026-11-20 起模型面是复合入口 `ride_hailing`（action 分流），原细分名仍保留
 * 执行器；前缀用裸名以同时覆盖复合名与历史细分名。
 *
 * 边界区分（negativeAliases / negativeExamples）：
 *   - shopping.order.*（电商购物，非网约车）
 *   - travel.compute-route / travel.departure-advice（路线查询/出发建议，不下单）
 *   - wallet.*（记账）
 */
import type { ToolIntentRule } from "../../tool-search/intent-metadata.js";

export const RIDE_HAILING_INTENT_RULES: ToolIntentRule[] = [
  {
    prefix: "ride_hailing",
    metadata: {
      aliases: [
        "ride", "ride hailing", "taxi", "cab", "call a cab", "book a ride", "uber", "didi",
        "打车", "叫车", "网约车", "滴滴", "高德打车", "叫个车", "来个车", "接我", "送我去",
        "去机场", "去车站", "预约用车", "接机", "送机",
      ],
      negativeAliases: [
        "errand", "delivery", "takeout", "groceries",
        "跑腿", "代买", "代购", "外卖", "点餐", "取快递",
        "bus route", "地铁路线", "怎么走", "路线规划",
        "balance", "record expense",
      ],
      examples: [
        "帮我叫个车去首都机场",
        "打车去北京南站多少钱",
        "晚上八点预约一辆舒适型的车",
        "帮我查一下刚才那个打车订单",
        "叫的车怎么还没到",
        "cancel my ride",
      ],
      negativeExamples: [
        "帮我跑腿买杯咖啡",
        "从国贸到机场怎么走",
        "记一下这笔打车消费",
      ],
    },
  },
  {
    exact: "ride_hailing.quote",
    metadata: {
      aliases: [
        "fare estimate", "ride quote", "taxi price", "how much is a ride",
        "估价", "报价", "车费", "多少钱", "预估价",
      ],
      examples: [
        "打车去国贸大概多少钱",
        "经济型和商务型差多少",
        "estimate fare to the airport",
      ],
      negativeExamples: ["直接帮我叫车", "取消刚叫的车"],
    },
  },
  {
    exact: "ride_hailing.book",
    metadata: {
      aliases: [
        "book ride", "order taxi", "hail a cab", "confirm ride",
        "下单叫车", "叫车", "确认叫车", "派单",
      ],
      examples: [
        "就选舒适型，帮我叫车",
        "确认，下单吧",
        "book the economy ride",
      ],
      negativeExamples: ["查一下车费", "取消订单"],
    },
  },
  {
    exact: "ride_hailing.status",
    metadata: {
      aliases: [
        "ride status", "where is my driver", "driver info", "plate number",
        "订单状态", "司机到哪了", "车牌", "司机信息", "行程状态",
      ],
      examples: [
        "司机到了吗",
        "查一下我的打车订单",
        "车牌号是多少",
      ],
      negativeExamples: ["帮我叫车", "取消这个订单"],
    },
  },
  {
    exact: "ride_hailing.cancel",
    metadata: {
      aliases: ["cancel ride", "cancel taxi", "不要车了", "取消用车", "取消叫车", "取消这个行程"],
      examples: ["取消刚才叫的车", "行程不要了", "cancel my ride"],
      negativeExamples: ["司机到哪了", "再叫一辆"],
    },
  },
];

export const RIDE_HAILING_CATEGORY_MAPPING: { name: string; keywords: string[] } = {
  name: "ride_hailing",
  keywords: [
    "ride", "taxi", "cab", "uber", "didi", "chauffeur",
    "打车", "叫车", "网约车", "滴滴", "出租车", "专车", "快车",
    "接机", "送机", "预约用车", "叫个车", "行程", "司机", "车牌",
    "去机场", "去火车站", "去车站",
  ],
};
