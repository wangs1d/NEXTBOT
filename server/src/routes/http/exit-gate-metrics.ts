/**
 * 出口闸触发率看板路由（/metrics/exit-gate）。
 *
 * 架构文档 L4 的运营闭环入口：某道 gateReason 触发率持续偏高 ⇒ 回去改工具
 * 描述/常驻准入/prompt，**不许再加闸**（红线）。数据由
 * external-model/exit-gate-metrics.ts 进程内采集，按日落盘 30 天。
 */
import type { FastifyInstance } from "fastify";

import { snapshotExitGateMetrics } from "../../external-model/exit-gate-metrics.js";

export function registerExitGateMetricsRoutes(app: FastifyInstance): void {
  /** GET /metrics/exit-gate — 闸触发率快照（本进程累计 + 触发率排行） */
  app.get("/metrics/exit-gate", async () => {
    const snap = snapshotExitGateMetrics();
    return {
      ok: true,
      ...snap,
      hint:
        "触发率持续偏高的 reason ⇒ 上游有病：改工具描述/常驻准入/prompt，不加闸（架构文档红线 6/7）。",
    };
  });
}
