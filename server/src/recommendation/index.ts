/**
 * 购物建议能力（runtime 内置，非独立入口）。
 *
 * 触发路径：主聊天中用户表达购物/选品诉求 → 主 Agent 调用 shopping.suggest
 * 工具 → handler 经本模块引擎从自有商品库确定性产出结构化建议 →
 * tool-card-registry 直出内联卡（二分化对比 / 单候选面板）。
 *
 * 后期整体搬入 Agent World 做生态功能：核心（suggest-engine/product-catalog/
 * seed-products）零宿主依赖，卡片协议为跨端契约。
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { ProductCatalog } from "./product-catalog.js";
import { buildSuggestion } from "./suggest-engine.js";

export type { SuggestCandidate, SuggestCompare, SuggestResult, SuggestVideo } from "./suggest-engine.js";
export { buildSuggestion } from "./suggest-engine.js";
export { ProductCatalog } from "./product-catalog.js";
export type { ProductRecord } from "./product-catalog.js";
export { registerRecommendationRoutes, type RecommendationRouteDeps } from "./http.js";

/** 创建商品库（数据目录由宿主决定；首次访问自动播种种子数据） */
export function createRecommendationCatalog(dataDir: string): ProductCatalog {
  mkdirSync(dataDir, { recursive: true });
  return new ProductCatalog(dataDir);
}

export { buildAdvisorSuggestionText } from "./suggest-text.js";
export {
  aggregateXiaohongshuUgc,
  parseUgcPosts,
  summarizeUgc,
  type UgcSearchDeps,
} from "./ugc-aggregator.js";
export type { SuggestUgc, SuggestUgcPost } from "./suggest-engine.js";
