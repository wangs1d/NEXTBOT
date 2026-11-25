/**
 * 闹钟意图辅助：recurrence → RRULE 映射（纯代码确定性逻辑，无 LLM）。
 *
 * 历史（2026-10-13 P0 接线）：聊天里「明早7点叫我起床」此前只走日程提醒链
 * （schedule-task → schedule.reminder_fired 应用内通知，App 杀进程就不响），
 * 真正会响铃的本地闹钟引擎（Android AlarmManager + AlarmRingService）没有创建入口。
 *
 * 意图判定废除正则文本匹配，交给模型 —— calendar.create schema 的 alarmIntent 字段。
 * 2026-11-23 口径放宽（用户实测「明确要求用闹钟仍弹窗」后定调）：从「仅睡觉叫醒」
 * 扩到「用户明确说闹钟/叫醒/响铃」（含「定个 8 点闹钟」「用闹钟提醒我」）；只有没提
 * 闹钟字样的纯提醒不建。本模块只保留确定性保护：recurrence → RRULE 子集映射
 * （yearly 不支持 → 回退日程提醒，不给错语义的响铃）。
 */

export type ScheduleRecurrence = "none" | "daily" | "weekly" | "yearly" | "cron";

const DOW_CODES = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"] as const;

/**
 * cron（固定时刻 + 星期限制）→ 闹钟 RRULE。
 *
 * 只接受「分/时都是单值、日/月为 *」的形态：一天多次（步长、逗号列表）或跨月规则
 * 用单个 fireAt 表达不了，宁可 ok=false 回退纯日程提醒，也不给错语义的响铃。
 * 「每天除周一」（`0 11 * * 2-7`）正是这个形态 → FREQ=WEEKLY;BYDAY=TU,WE,TH,FR,SA,SU。
 */
export function repeatRuleFromCron(cronExpression: string): { rule: string | null; ok: boolean } {
  const fields = cronExpression.trim().split(/\s+/);
  if (fields.length !== 5) return { rule: null, ok: false };
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields;
  if (!/^\d{1,2}$/.test(minute!) || !/^\d{1,2}$/.test(hour!)) return { rule: null, ok: false };
  if (dayOfMonth !== "*" || month !== "*") return { rule: null, ok: false };
  const days = parseCronDayOfWeek(dayOfWeek!);
  if (!days) return { rule: null, ok: false };
  if (days.size === 7) return { rule: "RRULE:FREQ=DAILY", ok: true };
  const byday = [...days]
    .sort((a, b) => a - b)
    .map((d) => DOW_CODES[d])
    .join(",");
  return { rule: `RRULE:FREQ=WEEKLY;BYDAY=${byday}`, ok: true };
}

/** cron 第 5 段 → 星期集合（0=周日…6=周六；7 归一为 0）。非法返回 null。 */
function parseCronDayOfWeek(expr: string): Set<number> | null {
  const out = new Set<number>();
  for (const rawPart of expr.split(",")) {
    const part = rawPart.trim();
    if (!part) return null;
    const m = part.match(/^(\d{1,2})(?:-(\d{1,2}))?$/);
    if (!m) return null;
    const start = Number(m[1]);
    const end = m[2] ? Number(m[2]) : start;
    if (start > 7 || end > 7 || start > end) return null;
    for (let v = start; v <= end; v += 1) out.add(v === 7 ? 0 : v);
  }
  return out.size > 0 ? out : null;
}

/**
 * 日程 recurrence → 闹钟 RRULE。
 * alarm-rrule 子集只支持 FREQ=DAILY|WEEKLY|MONTHLY；yearly / 无法映射的 cron
 * → ok=false，调用方跳过闹钟创建（宁可回退日程提醒，也不给错语义的响铃）。
 */
export function repeatRuleFromRecurrence(
  recurrence: ScheduleRecurrence,
  cronExpression?: string,
): { rule: string | null; ok: boolean } {
  switch (recurrence) {
    case "daily":
      return { rule: "RRULE:FREQ=DAILY", ok: true };
    case "weekly":
      return { rule: "RRULE:FREQ=WEEKLY", ok: true };
    case "none":
      return { rule: null, ok: true };
    case "cron": {
      const cron = cronExpression?.trim();
      return cron ? repeatRuleFromCron(cron) : { rule: null, ok: false };
    }
    case "yearly":
      // alarm-rrule 子集不支持 YEARLY；回退日程提醒链
      return { rule: null, ok: false };
  }
}
