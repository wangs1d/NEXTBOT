import type { ToolHandler, ToolContext, ToolRegistry } from "../../tool-registry.js";
import { resolveActorId } from "../../../agent/actor-id.js";
import type { ShoppingCompareService } from "../../../services/shopping-compare-service.js";

/**
 * shopping.compare.* 工具 handler 工厂集合 + 注册入口。
 *
 * 全部只读零副作用（搜索/读价/写本地监控列表），沙箱模式下也可用。
 * 平台访问的安全护栏由 ShoppingOrderService 承担（Cookie 双门禁 + 平台白名单）。
 *
 * 注册入口见 {@link registerShoppingCompareTools}，由 `./index.ts` 的
 * CapabilityModule.register 闭包调用。
 */

/** shopping-compare 模块依赖（局部类型，避免修改全局 CapabilityModuleDeps）。 */
export interface ShoppingCompareModuleDeps {
  shoppingCompareService: ShoppingCompareService;
}

/** shopping.compare.prices —— 跨平台同款比价。 */
export function createComparePricesHandler(service: ShoppingCompareService): ToolHandler {
  return async (input: Record<string, unknown>, context: ToolContext) => {
    const query = typeof input.query === "string" ? input.query.trim() : "";
    if (!query) return { ok: false, error: "缺少 query（比价关键词）" };

    const platforms = Array.isArray(input.platforms)
      ? input.platforms.filter((p): p is string => typeof p === "string")
      : undefined;
    const maxPrice = typeof input.maxPrice === "number" && Number.isFinite(input.maxPrice) && input.maxPrice > 0
      ? input.maxPrice
      : undefined;
    const sort = typeof input.sort === "string" && ["default", "price_asc", "price_desc", "sales"].includes(input.sort)
      ? (input.sort as "default" | "price_asc" | "price_desc" | "sales")
      : undefined;
    const limit = typeof input.limit === "number" && Number.isFinite(input.limit)
      ? Math.floor(input.limit)
      : undefined;

    return service.comparePrices(context, query, { platforms, maxPrice, sort, limit });
  };
}

/** shopping.compare.research —— 保险/服务类调研比价。 */
export function createCompareResearchHandler(service: ShoppingCompareService): ToolHandler {
  return async (input: Record<string, unknown>, context: ToolContext) => {
    void context;
    const topic = typeof input.topic === "string" ? input.topic.trim() : "";
    if (!topic) return { ok: false, error: "缺少 topic（调研主题）" };
    const limit = typeof input.limit === "number" && Number.isFinite(input.limit)
      ? Math.floor(input.limit)
      : undefined;
    return service.research(context, topic, { limit });
  };
}

/** shopping.compare.watch —— 降价监控管理。 */
export function createCompareWatchHandler(service: ShoppingCompareService): ToolHandler {
  return async (input: Record<string, unknown>, context: ToolContext) => {
    const actorId = resolveActorId(context);
    const action = String(input.action ?? "").trim().toLowerCase();
    try {
      switch (action) {
        case "add": {
          const query = typeof input.query === "string" ? input.query.trim() : "";
          const platform = typeof input.platform === "string" ? input.platform.trim() : "";
          const targetPrice = typeof input.targetPrice === "number" ? input.targetPrice : NaN;
          if (!query) return { ok: false, error: "action=add 需要 query（监控关键词）" };
          if (!platform) return { ok: false, error: "action=add 需要 platform（监控平台）" };
          if (!Number.isFinite(targetPrice) || targetPrice <= 0) {
            return { ok: false, error: "action=add 需要 targetPrice（降价目标，CNY 正数）" };
          }
          const watches = await service.addWatch(actorId, query, platform, targetPrice);
          return {
            ok: true,
            summary: `已开始监控「${query}」@${platform}，降到 ¥${targetPrice} 以内会主动提醒你`,
            count: watches.length,
            watches: watches.map((w) => ({
              watchId: w.id,
              query: w.query,
              platform: w.platform,
              targetPrice: w.targetPrice,
              lastPriceCny: w.lastPriceCny,
            })),
          };
        }
        case "remove": {
          const target = typeof input.watchId === "string" ? input.watchId.trim()
            : typeof input.query === "string" ? input.query.trim() : "";
          if (!target) return { ok: false, error: "action=remove 需要 watchId 或 query（监控关键词）" };
          const watches = await service.removeWatch(actorId, target);
          return { ok: true, summary: "已移除监控", count: watches.length, watches };
        }
        case "list": {
          const watches = service.listWatches(actorId);
          if (watches.length === 0) return { ok: true, summary: "当前没有降价监控", count: 0, watches: [] };
          return {
            ok: true,
            summary: `当前有 ${watches.length} 条降价监控`,
            count: watches.length,
            watches: watches.map((w) => ({
              watchId: w.id,
              query: w.query,
              platform: w.platform,
              targetPrice: w.targetPrice,
              lastPriceCny: w.lastPriceCny,
              lastCheckedAt: w.lastCheckedAt ? new Date(w.lastCheckedAt).toISOString() : null,
            })),
          };
        }
        default:
          return {
            ok: false,
            error: `未知 action「${action || "(空)"}」。可选：add（新增监控）/ remove（移除）/ list（查看）`,
          };
      }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  };
}

/** 复合工具支持的动作（与 chat-tools 的 action 枚举保持一致）。 */
export const SHOPPING_COMPARE_ACTIONS = [
  "prices",
  "research",
  "watch_add",
  "watch_remove",
  "watch_list",
] as const;

/** watch_* 动作 → 原 watch handler 的内部 action。 */
const WATCH_ACTION_OF: Record<string, "add" | "remove" | "list"> = {
  watch_add: "add",
  watch_remove: "remove",
  watch_list: "list",
};

/**
 * shopping.compare —— 复合入口：按 `action` 分流到比价 / 调研 / 降价监控。
 *
 * 合并原因：可见工具面按函数名占槽位，3 个名字占 3 个槽位，收敛成 1 个。
 * 动作语义与回执保持不变；缺参校验仍由各动作 handler 给出具体原因。
 */
export function createShoppingCompareHandler(service: ShoppingCompareService): ToolHandler {
  const prices = createComparePricesHandler(service);
  const research = createCompareResearchHandler(service);
  const watch = createCompareWatchHandler(service);

  return async (input: Record<string, unknown>, context: ToolContext) => {
    const action = typeof input.action === "string" ? input.action.trim().toLowerCase() : "";
    if (!action) {
      return { ok: false, error: `缺少 action（可选：${SHOPPING_COMPARE_ACTIONS.join("/")}）` };
    }
    if (action === "prices") return prices(input, context);
    if (action === "research") return research(input, context);
    const watchAction = WATCH_ACTION_OF[action];
    if (watchAction) return watch({ ...input, action: watchAction }, context);
    return {
      ok: false,
      error: `未知 action「${action}」。可选：${SHOPPING_COMPARE_ACTIONS.join(" / ")}`,
    };
  };
}

/**
 * 注册 shopping-compare 复合工具到 ToolRegistry。
 *
 * 调用方：`capability-modules/index.ts` 的 `buildCapabilityModules` 闭包。
 */
export function registerShoppingCompareTools(
  registry: ToolRegistry,
  deps: ShoppingCompareModuleDeps,
): void {
  registry.register("shopping.compare", createShoppingCompareHandler(deps.shoppingCompareService));
}
