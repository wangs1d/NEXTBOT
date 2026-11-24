/**
 * 到点提醒的手机系统推送出口（2026-11-24 定稿：删除全部落流补投兜底）。
 *
 * 历史：到点提醒曾走「入队 missed-reminders.json → 手机 WS 重连补投落流」，
 * 并先记账再升级系统推送，理由是「华为受理≠送达，推送丢了补投是唯一形态」。
 * 实测副作用：手机 WS 频繁重连（code 1006）时，24h 内的历史提醒被反复补进
 * 对话流，用户看到的全是「已经发过的兜底」。
 *
 * 现在：手机系统推送已接入并作为**唯一**送达通道。到点手机不在线 → 直接推，
 * 成功即完成，失败即丢弃——不入队、不重连补投、不重试。副作用是推送失败时
 * 那条提醒横幅和对话流都没有；这是用户明确接受的取舍（三条兜底全删）。
 *
 * 保留 reminderStableMessageId：手机在线直投的消息仍需要稳定 id，客户端按
 * (sessionId, messageId) upsert 本地历史（在线直投本身只到一次，不需要补投）。
 */

export type ReminderPushInput = {
  actorId: string;
  taskId: string;
  title: string;
  message: string;
  /** 到点触发时刻 ISO，仅用于日志/追踪，系统推送不展示原时间 */
  runAt: string;
  preReminder: boolean;
};

export type ReminderPushDeps = {
  push: (input: {
    actorId: string;
    title: string;
    body: string;
    importance: string;
    kind: string;
    deliveryId: string;
  }) => Promise<{ ok: boolean; provider?: string; reason?: string }>;
  now?: () => number;
};

/** 提醒消息的稳定 messageId（与触发身份 taskId+runAt 绑定，跨通道一致） */
export function reminderStableMessageId(taskId: string, runAt: string, preReminder: boolean): string {
  return `reminder-${taskId}:${runAt}${preReminder ? ":pre" : ""}`;
}

/**
 * 到点手机不在场 → 直接走系统推送，失败即丢弃。无队列、无重连补投。
 * 返回是否推送受理成功（仅供日志，调用方不据此做二次投递）。
 */
export async function pushReminderDirectly(
  deps: ReminderPushDeps,
  input: ReminderPushInput,
): Promise<boolean> {
  const clock = deps.now ?? (() => Date.now());
  const deliveryId = `dp_${clock().toString(36)}_rr_${input.taskId.slice(-6)}`;
  const result = await deps.push({
    actorId: input.actorId,
    title: input.title || "提醒",
    body: input.message,
    importance: input.preReminder ? "medium" : "high",
    kind: "schedule_reminder",
    deliveryId,
  });
  if (!result.ok) {
    console.log(
      `[ReminderPush] 系统推送失败（丢弃，不补投）taskId=${input.taskId} reason=${result.reason ?? "unknown"}`,
    );
  }
  return result.ok;
}
