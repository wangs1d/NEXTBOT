/**
 * home_service.* 工具意图元数据 + 关键词分类映射。
 *
 * 边界区分：
 *   - shopping.order.*（实物购物，非上门服务）
 *   - restaurant.*（餐厅到店用餐）
 *   - smart_home.*（自有设备控制）
 */
import type { ToolIntentRule } from "../../tool-search/intent-metadata.js";

export const HOME_SERVICES_INTENT_RULES: ToolIntentRule[] = [
  {
    prefix: "home_service.",
    metadata: {
      aliases: [
        "home service", "housekeeping", "cleaning service", "maid", "handyman", "movers",
        "家政", "保洁", "小时工", "清洁", "打扫", "深度保洁", "开荒",
        "维修", "水管", "疏通", "搬家", "搬家公司",
        "上门美发", "上门美甲", "宠物上门", "上门喂猫", "遛狗",
      ],
      negativeAliases: [
        "shopping", "buy", "groceries", "errand", "takeout",
        "买东西", "网购", "跑腿", "代买", "外卖",
        "smart home", "light", "空调开关", "智能设备",
        "restaurant", "reservation", "restaurant reservation", "订餐厅", "订位",
      ],
      examples: [
        "帮我约一个周六上午的深度保洁",
        "找个小时工打扫一下厨房",
        "下水道堵了，找个疏通的师傅",
        "下个月搬家，帮我订辆搬家车",
        "出差三天，找个人上门喂猫",
        "book a deep cleaning for saturday",
      ],
      negativeExamples: [
        "帮我买瓶洗洁精",
        "打开客厅的灯",
        "订一家周六晚上的餐厅",
      ],
    },
  },
  {
    exact: "home_service.search",
    metadata: {
      aliases: ["find cleaner", "cleaning price", "家政价格", "保洁多少钱", "套餐", "找师傅"],
      examples: ["深度保洁多少钱", "搬家车大概什么价位"],
      negativeExamples: ["确认下单", "改期到周日"],
    },
  },
  {
    exact: "home_service.book",
    metadata: {
      aliases: ["book cleaning", "schedule cleaning", "book handyman", "预订保洁", "预约家政", "确认预约"],
      examples: ["就选4小时深度保洁，周六上午", "确认，订这个套餐"],
      negativeExamples: ["保洁多少钱", "取消预约"],
    },
  },
  {
    exact: "home_service.reschedule",
    metadata: {
      aliases: ["reschedule", "change time", "改时间", "改期", "换到周日", "推迟到下周"],
      examples: ["保洁改到周日下午", "搬家改期到下个月一号"],
      negativeExamples: ["取消保洁", "保洁到几点"],
    },
  },
  {
    exact: "home_service.cancel",
    metadata: {
      aliases: ["cancel cleaning", "cancel booking", "取消保洁", "取消预约", "不要了"],
      examples: ["取消周六的保洁", "预约的师傅不用来了"],
      negativeExamples: ["改到周日", "查一下订单"],
    },
  },
];

export const HOME_SERVICES_CATEGORY_MAPPING: { name: string; keywords: string[] } = {
  name: "home_services",
  keywords: [
    "home service", "housekeeping", "cleaning", "maid", "handyman", "moving", "movers",
    "家政", "保洁", "小时工", "清洁工", "打扫卫生", "开荒保洁", "深度保洁",
    "上门维修", "维修师傅", "疏通管道", "搬家", "搬家公司",
    "上门美发", "上门美甲", "宠物上门", "上门喂养", "遛狗",
  ],
};
