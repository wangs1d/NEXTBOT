/**
 * 闹钟意图辅助：recurrence → RRULE 映射（纯代码确定性逻辑，无 LLM）。
 *
 * 历史（2026-10-13 P0 接线）：聊天里「明早7点叫我起床」此前只走日程提醒链
 * （schedule-task → schedule.reminder_fired 应用内通知，App 杀进程就不响），
 * 真正会响铃的本地闹钟引擎（Android AlarmManager + AlarmRingService）没有创建入口。
 *
 * 2026-11-09 用户定调改版：是否建真闹钟的意图判定废除正则文本匹配，交给模型 ——
 * calendar.create schema 新增 alarmIntent 字段，唯一覆盖「睡觉叫醒」一种情形
 * （「定个闹钟」等无睡觉语境的表述不建）。本模块只保留确定性保护：
 * recurrence → RRULE 子集映射（yearly 不支持 → 回退日程提醒，不给错语义的响铃）。
 */

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
