/**
 * 购物比价能力模块（capability-module）。
 *
 * 与 shopping-order 同结构，导出：
 *   - `SHOPPING_COMPARE_CHAT_TOOLS`         LLM 工具 schema（1 个复合工具 shopping.compare）
 *   - `SHOPPING_COMPARE_INTENT_RULES`       意图元数据（接 BM25 调权）
 *   - `SHOPPING_COMPARE_CATEGORY_MAPPING`   关键词分类映射
 *   - `registerShoppingCompareTools`        注册到 ToolRegistry
 *
 * 核心定位：只读零副作用的「买前比价」——跨平台同款聚合、保险/服务调研对比、
 * 降价监控提醒。下单走 shopping.order.*，本模块不产生任何订单或支付。
 */
import { SHOPPING_COMPARE_CHAT_TOOLS } from "./chat-tools.js";
import { registerShoppingCompareTools } from "./handlers.js";
import type { ShoppingCompareModuleDeps } from "./handlers.js";
import { SHOPPING_COMPARE_INTENT_RULES, SHOPPING_COMPARE_CATEGORY_MAPPING } from "./intent.js";

export { SHOPPING_COMPARE_CHAT_TOOLS } from "./chat-tools.js";
export { SHOPPING_COMPARE_INTENT_RULES, SHOPPING_COMPARE_CATEGORY_MAPPING } from "./intent.js";
export { registerShoppingCompareTools, type ShoppingCompareModuleDeps } from "./handlers.js";
