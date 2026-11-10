/**
 * 展示效果（display effects）契约。
 *
 * 服务端展示路由（server/src/services/display-effect-router.ts）按「工具
 * 信号 + 内容信号」从下列类型中选出 cardType，随 [AGENT_RESULT_CARD] 载荷
 * 下发；客户端（Flutter display_effects/ 模块 + agent_result_card.dart）
 * 按同名字符串分发到对应效果组件。本文件是两端共享的唯一枚举源——
 * 新增效果先在此登记，再同步路由器与前端组件，防止「服务端新增了、
 * 前端静默落通用卡」的漂移。
 */

/** 全部展示效果类型；空串 = 通用列表卡（前端默认）。 */
export type DisplayEffectType =
  | "weather" // 天气卡（工具：weather.*）
  | "schedule" // 日程卡（工具：calendar/schedule）
  | "wallet" // 钱包卡（工具：wallet.*）
  | "order" // 订单卡（工具：order/payment/alipay）
  | "file" // 文件卡（工具：file）
  | "media" // 媒体图廊卡（工具：search_images/search_videos 等）
  | "compare" // A/B 双图对比滑杆（工具：compare/pk；或内容含对比词 + 图片）
  | "comparison_table" // 文本 A/B 对比双栏卡（内容：A/B 标签条目成对出现）
  | "timeline" // 时间轴卡（工具：plan/timeline；或条目以时间开头）
  | "progress" // 文字进度条卡（内容：百分比/分数占多数）
  | "steps" // 数字步骤卡（内容：第X步/Step N/数字. 开头占多数）
  | "metric" // 数据面板卡（内容：全部为「标签：数值」）
  | "carousel" // 轮播横滑卡（内容：多数条目内嵌图片 URL）
  | "chips" // 标签/徽章行（内容：全部为短标签）
  | "fold_list" // 折叠列表卡（内容：≥8 条长清单）
  | "quote" // 引用强调卡（markdown 引用块 / 引用式单句结论）
  | "travel_itinerary" // 旅游行程卡（工具：travel.*；前端以独立界面打开）
  | "travel_requirement" // 需求确认卡（工具回执声明 needInput 时下发，点选回传）
  | "reminder_confirm" // 提醒确认卡（工具：calendar.create；只读、卡内多行）
  | "";

/** 展示效果类型的运行时清单（与 DisplayEffectType 逐一对应，供漂移测试）。 */
export const DISPLAY_EFFECT_TYPES = [
  "weather",
  "schedule",
  "wallet",
  "order",
  "file",
  "media",
  "compare",
  "comparison_table",
  "timeline",
  "progress",
  "steps",
  "metric",
  "carousel",
  "chips",
  "fold_list",
  "quote",
  "travel_itinerary",
  "travel_requirement",
  "reminder_confirm",
  "",
] as const satisfies readonly DisplayEffectType[];
