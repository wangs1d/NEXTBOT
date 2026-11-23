// 今日看板路由（2026-11-23 需求 §5.2/§5.3）
//
// GET /api/widget/today —— 常驻通知与桌面小组件共用的唯一数据源。
// 排序、文案、脱敏都在服务端算完（见 services/today-board.ts）：客户端拿到什么就贴什么，
// Android/iOS/小组件不再各拼一套业务逻辑。
//
// 离线兜底由客户端负责：拉到的最后一份落 SharedPreferences，断网时显示它 + 更新时间。
import type { FastifyInstance } from "fastify";

import { resolveActorId } from "../../agent/actor-id.js";
import { buildTodayBoard, type TodayBoardDeps } from "../../services/today-board.js";

export type TodayBoardRouteDeps = {
  scheduleTasks: TodayBoardDeps["scheduleTasks"];
  ledger?: TodayBoardDeps["ledger"];
  /** 「完成」按钮凭据签发器（与 WS 推送同一实例：小组件和状态栏共用一枚 token） */
  intents?: TodayBoardDeps["intents"];
};

export function registerTodayBoardRoutes(app: FastifyInstance, deps: TodayBoardRouteDeps): void {
  app.get("/api/widget/today", async (request) => {
    const q = request.query as { userId?: string; sessionId?: string };
    const actorId = resolveActorId({ userId: q.userId, sessionId: q.sessionId ?? "" });
    return buildTodayBoard(
      {
        scheduleTasks: deps.scheduleTasks,
        ledger: deps.ledger ?? null,
        intents: deps.intents ?? null,
      },
      actorId,
    );
  });
}
