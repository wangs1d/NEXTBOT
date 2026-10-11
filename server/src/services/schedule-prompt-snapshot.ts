import type { ScheduleTaskService } from "./schedule-task-service.js";

const RECURRENCE_LABEL: Record<string, string> = {
  none: "单次",
  daily: "每天",
  weekly: "每周",
  yearly: "每年",
};

/**
 * 构建日程快照（注入门槛由调用方裁决：L1 路由 understanding.schedule_query /
 * 追问轮）。原 SCHEDULE_RECALL_RE / SCHEDULE_FAR_RANGE_RE 词表判定已退役——
 * 「用户这轮在不在问日程、要看多远」归模型判定，本模块只负责执行。
 */
export function buildSchedulePromptSnapshot(
  scheduleTaskService: ScheduleTaskService,
  sessionId: string,
  extended: boolean,
): string {
  const now = Date.now();
  const horizonDays = extended ? 7 : 1;
  const maxItems = extended ? 5 : 3;
  const from = new Date(now).toISOString();
  const to = new Date(now + horizonDays * 86_400_000).toISOString();
  const tasks = scheduleTaskService.listTasksBySession(sessionId, { from, to });
  const rangeLabel = extended ? `${horizonDays}d` : "today";

  if (tasks.length === 0) {
    return `SCH|range=${rangeLabel}|count=0`;
  }

  const lines = tasks.slice(0, maxItems).map((task) => {
    const when = task.nextRunAt ?? task.runAt;
    const recurrence = RECURRENCE_LABEL[task.recurrence] ?? task.recurrence;
    const title = task.reminderMessage?.trim() || task.title;
    return `- ${when}|${recurrence}|${title}`;
  });

  const hiddenCount = tasks.length - lines.length;
  const header = `SCH|range=${rangeLabel}|count=${tasks.length}|shown=${lines.length}|more=${Math.max(0, hiddenCount)}`;

  return [
    header,
    ...lines,
  ]
    .filter(Boolean)
    .join("\n");
}
