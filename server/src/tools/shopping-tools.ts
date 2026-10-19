/**
 * order.status —— 订单状态查询（2026-10-19，handoff probe 的查询半边）。
 *
 * **只读跨源采集库，不现打外部接口。**订单状态由「主动搜集数据源」持续汇入
 * （手机通知捕捉 → shopping 流 → SourceStore），本工具只做本地查询——
 * 采集到什么就报什么，库里没有就如实说没有，绝不编造。
 *
 * 为什么这样分（用户定调）：数据的进入是感知层的事（传感器/通知捕捉持续抓），
 * 模型与 probe 只消费汇聚结果。probe 场景（等外卖送达）的 expect 直接匹配
 * 本工具的返回文本（如包含「已送达」）。
 */
import type { ToolHandler, ToolRegistry } from "./tool-registry.js";
import type { SourceStore } from "../proactivity/source-store.js";
import { resolveActorId } from "../agent/actor-id.js";

export type OrderStatusToolsDeps = {
  sourceStore: SourceStore | null;
};

export function createOrderStatusHandler(deps: OrderStatusToolsDeps): ToolHandler {
  return async (_input: Record<string, unknown>, context) => {
    const store = deps.sourceStore;
    if (!store || !store.enabled()) {
      return { ok: false, error: "跨源采集库未启用（SENSOR_SOURCE_STORE=0），无法查询订单信号" };
    }
    const actorId = resolveActorId(context);
    const hits = store.byStream("shopping", { actorId, limit: 5 });
    if (hits.length === 0) {
      return {
        ok: true,
        hasSignals: false,
        summary: "采集库中暂无订单/外卖类信号（手机通知捕捉未上报过相关通知）",
        hint: "如实告知用户当前没有采集到订单动态，不要编造配送状态",
      };
    }
    return {
      ok: true,
      hasSignals: true,
      signals: hits.map((s) => ({
        at: new Date(s.at).toISOString(),
        delta: s.delta ?? "",
        platform: String(s.payload?.platform ?? ""),
      })),
      summary: hits[0]?.delta ?? "",
      hint: "按时间从新到旧列出；最新一条即当前状态。判定完成与否用最新一条",
    };
  };
}

export function registerOrderStatusTools(
  registry: ToolRegistry,
  deps: OrderStatusToolsDeps,
): void {
  registry.register("order.status", createOrderStatusHandler(deps));
}
