/**
 * 闹钟类意图识别与重复规则映射（纯代码确定性判定，无 LLM）。
 *
 * 背景（2026-10-13 P0 接线）：聊天里「明早7点叫我起床」此前只走日程提醒链
 * （schedule-task → schedule.reminder_fired 应用内通知，App 杀进程就不响），
 * 真正会响铃的本地闹钟引擎（Android AlarmManager + AlarmRingService）没有创建入口。
 *
 * 本模块给 calendar 建任务链路提供确定性的「这是闹钟类请求」判定：
 *   命中 → 日程任务照常创建（今日安排/编辑/删除生态不动），
 *          同时补建 kind=alarm 的真闹钟（alarmClockService.createAlarm →
 *          alarm.sync → 手机端写入本地闹钟库并预约精确闹钟，杀进程也响）。
 *
 * 服务端铁律：意图判定必须是确定性代码，不交给模型现场决定；
 * 判定语义与 schedule-intent-service 的起床类默认重复判定（原 isWakeAlarmLikeText，
 * L543）同源，改一处须同步另一处。
 */

/**
 * 闹钟/叫醒类意图（含口语「叫我起床」等）。
 * 与 schedule-intent-service.ts L543 保持同源；保守收窄：不含裸「叫我/喊我」
 * （「下午3点叫我开会」是会议提醒，不是闹钟）。
 */
export function isAlarmLikeReminderText(text: string): boolean {
  return /叫我起床|起床|闹钟|叫醒|定时叫|叫早/.test(text.trim());
}

export type ScheduleRecurrence = "none" | "daily" | "weekly" | "yearly";

/**
 * 日程 recurrence → 闹钟 RRULE。
 * alarm-rrule 子集只支持 FREQ=DAILY|WEEKLY|MONTHLY；yearly 不在子集内
 * → ok=false，调用方跳过闹钟创建（宁可回退日程提醒，也不给错语义的响铃）。
 */
export function repeatRuleFromRecurrence(
  recurrence: ScheduleRecurrence,
): { rule: string | null; ok: boolean } {
  switch (recurrence) {
    case "daily":
      return { rule: "RRULE:FREQ=DAILY", ok: true };
    case "weekly":
      return { rule: "RRULE:FREQ=WEEKLY", ok: true };
    case "none":
      return { rule: null, ok: true };
    case "yearly":
      // alarm-rrule 子集不支持 YEARLY；回退日程提醒链
      return { rule: null, ok: false };
  }
}
