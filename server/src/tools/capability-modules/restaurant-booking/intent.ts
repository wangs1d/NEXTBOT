/**
 * restaurant.* 工具意图元数据 + 关键词分类映射。
 *
 * 边界区分：
 *   - shopping.order.place（外卖/购物）
 *   - home_service.*（上门家政）
 *   - travel.search-poi（旅行 POI 探索，非订座）
 */
import type { ToolIntentRule } from "../../tool-search/intent-metadata.js";

export const RESTAURANT_BOOKING_INTENT_RULES: ToolIntentRule[] = [
  {
    prefix: "restaurant.",
    metadata: {
      aliases: [
        "restaurant", "dining", "reservation", "book a table", "table for",
        "订餐厅", "餐厅预订", "订座", "订位", "位子", "占座",
        "附近好吃的", "吃什么", "聚餐", "请客吃饭", "找家餐厅",
      ],
      negativeAliases: [
        "takeout", "delivery", "waimai", "errand",
        "外卖", "跑腿", "代买", "打包",
        "cleaning", "housekeeping", "家政", "保洁",
        "itinerary", "attractions", "travel guide", "行程", "景点", "攻略",
      ],
      examples: [
        "帮我订今晚7点4个人的餐厅",
        "附近有什么好吃的江浙菜",
        "周六中午订个包间，8个人",
        "取消今晚的餐厅预订",
        "book a table for four tonight",
      ],
      negativeExamples: [
        "点一份外卖",
        "找个保洁阿姨",
        "帮我做个东京五日游行程",
      ],
    },
  },
  {
    exact: "restaurant.search",
    metadata: {
      aliases: ["find restaurant", "restaurant nearby", "recommend restaurant", "找餐厅", "推荐餐厅", "附近美食"],
      examples: ["附近有什么本帮菜", "推荐一家适合约会的餐厅"],
      negativeExamples: ["确认订座", "取消预订"],
    },
  },
  {
    exact: "restaurant.book",
    metadata: {
      aliases: ["book table", "reserve table", "make reservation", "订座", "确认订位", "下订"],
      examples: ["就订这家，今晚7点4人", "确认，订包间"],
      negativeExamples: ["这家人均多少", "取消订单"],
    },
  },
  {
    exact: "restaurant.status",
    metadata: {
      aliases: ["reservation status", "check booking", "预订状态", "订座信息", "订的餐厅"],
      examples: ["我订的餐厅是几点", "查一下订座状态"],
      negativeExamples: ["帮我订座", "取消订座"],
    },
  },
  {
    exact: "restaurant.cancel",
    metadata: {
      aliases: ["cancel reservation", "cancel table", "取消订座", "取消预订", "不去吃了"],
      examples: ["今晚的餐厅取消掉", "位子不要了"],
      negativeExamples: ["改到明天晚上", "查一下预订"],
    },
  },
];

export const RESTAURANT_BOOKING_CATEGORY_MAPPING: { name: string; keywords: string[] } = {
  name: "restaurant_booking",
  keywords: [
    "restaurant", "dining", "reservation", "table", "opentable",
    "餐厅", "餐馆", "订座", "订位", "包间", "聚餐", "宴请",
    "附近美食", "好吃的", "吃什么", "菜系", "江浙菜", "火锅", "日料", "西餐",
  ],
};
