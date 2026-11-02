/** 会写入 ScheduleTaskService 的日程/提醒工具（注册名，带点号）。 */
export const SCHEDULE_CREATE_TOOL_NAMES = new Set(["calendar.create"]);

export const SCHEDULE_MUTATION_TOOL_NAMES = new Set([
  ...SCHEDULE_CREATE_TOOL_NAMES,
  "calendar.update_task",
  "calendar.delete_task",
]);

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
