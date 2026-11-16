/**
 * 通知栏动作执行器（2026-11-13「通知即界面」）。
 *
 * 这里把 actionId 接到**真实的管道能力**上——每个按钮按下去都必须真的改变某个状态，
 * 否则就是骗人的按钮（用户点「取消续费」，结果什么都没发生，这比没有按钮更糟）。
 *
 * 五个动作全部零 LLM：
 *   proactivity.acknowledge  好就这么办 → 记 accepted（频控自适应据此回升）+ 回执
 *   proactivity.snooze       稍后再说   → 提案重新入队，30 分钟后重投
 *   proactivity.dismiss      不用了     → 记 dismissed（负反馈即时冷却）+ 回执
 *   proactivity.approve      就这么办   → ask_first 提案：走确认批准（**真的执行**）
 *   proactivity.decline      先不用     → ask_first 提案：关闭确认
 */
import type { ActionIntentService } from "./action-intent-service.js";
import { NOTIFY_ACTION } from "./notification-actions.js";
import type { ProactiveProposal } from "./pipeline-types.js";

export type NotificationExecutorDeps = {
  /** 主动管道（执行动作的落点：回执/outcome/提案重投/确认推进） */
  pipeline: {
    recordOutcome: (deliveryId: string, outcome: "accepted" | "dismissed" | "snoozed") => boolean;
    requeueProposal: (proposal: ProactiveProposal, deliverAfter: number) => boolean;
    resolveConfirmationByKind: (
      actorId: string,
      kind: string,
      approved: boolean,
    ) => { ok: boolean; message: string };
  } | null;
};

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

export function registerNotificationActionExecutors(
  actionIntents: ActionIntentService,
  deps: NotificationExecutorDeps,
): void {
  const { pipeline } = deps;

  /** 收下：告诉系统「这条有用」（频控回升），不给任何副作用 */
  actionIntents.registerExecutor(NOTIFY_ACTION.acknowledge, ({ intent, action }) => {
    if (intent.deliveryId) {
      pipeline?.recordOutcome(intent.deliveryId, "accepted");
    }
    const title = str(action.payload?.title) || intent.title;
    return { ok: true, message: `好，${title}就这么定了` };
  });

  /** 稍后再说：把这条提案重新入队，delayMs 后重投 */
  actionIntents.registerExecutor(NOTIFY_ACTION.snooze, ({ intent, action }) => {
    const proposal = action.payload?.proposal as ProactiveProposal | undefined;
    const delayMs = typeof action.payload?.delayMs === "number" ? action.payload.delayMs : 30 * 60_000;
    if (!proposal) {
      return { ok: false, message: "这条已经过期了，没法再推迟" };
    }
    if (!pipeline) {
      return { ok: false, message: "执行通道未装配" };
    }
    const at = Date.now() + delayMs;
    const ok = pipeline.requeueProposal(proposal, at);
    if (intent.deliveryId) pipeline.recordOutcome(intent.deliveryId, "snoozed");
    if (!ok) {
      return { ok: false, message: "这件事已经在队列里了，我到点再说" };
    }
    const minutes = Math.max(1, Math.round(delayMs / 60_000));
    return { ok: true, message: `好，${minutes} 分钟后再提醒你` };
  });

  /** 不用了：记一次负反馈（频控即时降温），不再重投 */
  actionIntents.registerExecutor(NOTIFY_ACTION.dismiss, ({ intent }) => {
    if (intent.deliveryId) {
      pipeline?.recordOutcome(intent.deliveryId, "dismissed");
    }
    return { ok: true, message: "好，不再提这件事" };
  });

  /** 批准：ask_first 提案真的执行（与对话里回「可以」同一条路） */
  actionIntents.registerExecutor(NOTIFY_ACTION.approve, ({ intent, action }) => {
    const kind = str(action.payload?.kind) || intent.kind;
    if (!pipeline) return { ok: false, message: "执行通道未装配" };
    return pipeline.resolveConfirmationByKind(intent.actorId, kind, true);
  });

  /** 拒绝：关闭这条确认 */
  actionIntents.registerExecutor(NOTIFY_ACTION.decline, ({ intent, action }) => {
    const kind = str(action.payload?.kind) || intent.kind;
    if (!pipeline) return { ok: false, message: "执行通道未装配" };
    return pipeline.resolveConfirmationByKind(intent.actorId, kind, false);
  });
}
