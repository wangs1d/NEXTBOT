/** 会写入 ScheduleTaskService 的日程/提醒工具（注册名）。2026-11-11 复合为单入口 `calendar`。 */
export const SCHEDULE_CREATE_TOOL_NAMES = new Set(["calendar"]);

export const SCHEDULE_MUTATION_TOOL_NAMES = new Set(["calendar"]);

export function isScheduleCreateToolName(toolName: string): boolean {
  const n = toolName.trim();
  if (SCHEDULE_CREATE_TOOL_NAMES.has(n)) return true;
  const normalized = n.replace(/_/g, ".");
  return SCHEDULE_CREATE_TOOL_NAMES.has(normalized);
}

export function isScheduleMutationToolName(toolName: string): boolean {
  const n = toolName.trim();
  if (SCHEDULE_MUTATION_TOOL_NAMES.has(n)) return true;
  const normalized = n.replace(/_/g, ".");
  return SCHEDULE_MUTATION_TOOL_NAMES.has(normalized);
}
