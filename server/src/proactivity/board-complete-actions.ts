// 常驻通知「下一件事完成」按钮的凭据签发（2026-11-23 需求 §5.2）
//
// 看板每小时、每次任务变更、每次按钮执行后都会重算一次。如果每次都新登一条动作意图，
// 状态栏那条通知的按钮就一直是新 token、而 action-intents.json 里堆满同一条日程的
// 重复意图。这里按 actor 缓存：同一件「下一件事」在有效期内复用同一枚 token，
// 事项变了（换日程 / 完成 / 过期）才签新的。
//
// 复用不等于放宽：token 背后是既有的 schedule.complete 执行器，
// 它自己核对任务归属（session 必须是 intent.actorId），过期由 store 统一收口。
import { NOTIFY_ACTION } from "./notification-actions.js";
import type { ActionIntentService } from "./action-intent-service.js";
import type { TodayBoardAction } from "../services/today-board.js";

/** 剩余有效期不足 30 分钟就提前换一枚，避免按钮在用户眼前变成死键 */
const RENEW_MARGIN_MS = 30 * 60_000;

export class BoardCompleteActions {
  private readonly cache = new Map<
    string,
    { taskId: string; action: TodayBoardAction; expiresAt: number }
  >();

  constructor(
    private readonly svc: Pick<ActionIntentService, "register" | "renderForClient">,
    private readonly now: () => number = () => Date.now(),
  ) {}

  completeAction(
    actorId: string,
    task: { taskId: string; title: string },
  ): TodayBoardAction | null {
    if (!actorId || !task.taskId) return null;
    const at = this.now();
    const hit = this.cache.get(actorId);
    if (hit && hit.taskId === task.taskId && hit.expiresAt > at + RENEW_MARGIN_MS) return hit.action;

    const intent = this.svc.register({
      actorId,
      kind: "today_board",
      title: `完成「${task.title}」`,
      body: "常驻通知上的「完成」按钮",
      risk: "L0",
      actions: [
        {
          actionId: NOTIFY_ACTION.scheduleComplete,
          label: "完成",
          kind: "execute",
          payload: { kind: "today_board", title: task.title, ref: task.taskId },
        },
      ],
    });
    const rendered = this.svc.renderForClient(intent);
    const signed = rendered.actions[0];
    if (!signed) return null;
    const action: TodayBoardAction = {
      actionId: signed.actionId,
      label: signed.label,
      token: signed.token,
    };
    this.cache.set(actorId, { taskId: task.taskId, action, expiresAt: rendered.expiresAt });
    return action;
  }

  /** 该账号当前缓存的 token（回执后据此判断要不要重签）；诊断与单测用 */
  peek(actorId: string): TodayBoardAction | null {
    return this.cache.get(actorId)?.action ?? null;
  }
}
