import type { ScheduleTaskService, ScheduleTaskRecord } from "./schedule-task-service.js";

const RECURRENCE_LABEL: Record<string, string> = {
  none: "单次",
  daily: "每天",
  weekly: "每周",
  yearly: "每年",
};

const STATUS_LABEL: Record<string, string> = {
  completed: "已完成",
  paused: "已暂停",
  failed: "失败",
};

/** 剩余时间人话标签：模型引用提醒时用它换算「还剩多久」，禁止复读历史轮的相对措辞。 */
function formatRemainingLabel(ms: number): string {
  if (ms <= 0) return "已到点";
  if (ms <= 60_000) return "还剩不到1分钟";
  const min = Math.round(ms / 60_000);
  if (min < 60) return `还剩约${min}分钟`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h >= 48) return `还剩约${Math.round(h / 24)}天`;
  return m ? `还剩约${h}小时${m}分钟` : `还剩约${h}小时`;
}

/** 任务触发时刻在任务时区下的 HH:MM 本地时间（时区非法回退服务器本地）。 */
function formatLocalClock(iso: string, timezone?: string): string {
  const at = new Date(iso);
  if (!Number.isFinite(at.getTime())) return "";
  try {
    return new Intl.DateTimeFormat("zh-CN", {
      timeZone: timezone || undefined,
      hour: "2-digit",
      minute: "2-digit",
      // zh-CN + hour12:false 在部分 Node 版本会落 h24（午夜显示 24:00），强制 h23
      hourCycle: "h23",
    }).format(at);
  } catch {
    return "";
  }
}

/**
 * 构建单条日程快照行：ISO 绝对时间（权威锚）+ 任务时区 HH:MM + 剩余时间/状态
 * + 周期 + 事项。剩余时间每轮按当前真实时钟现算，模型任何轮次引用提醒都有
 * 权威时间可对照。
 */
function buildSnapshotLine(task: ScheduleTaskRecord, nowMs: number): string {
  const when = task.nextRunAt ?? task.runAt;
  const recurrence = RECURRENCE_LABEL[task.recurrence] ?? task.recurrence;
  const title = task.reminderMessage?.trim() || task.title;
  const localClock = formatLocalClock(when, task.timezone);
  let human: string;
  if (task.status !== "active") {
    human = STATUS_LABEL[task.status] ?? task.status;
  } else {
    const remaining = new Date(when).getTime() - nowMs;
    const remainingLabel = formatRemainingLabel(remaining);
    human = localClock ? `${localClock} ${remainingLabel}` : remainingLabel;
  }
  return `- ${when}|${recurrence}|${human}|${title}`;
}

/**
 * 【时间感知·日程态】通用快照（2026-11-16 根修「过期提醒污染上下文」）：
 *
 * 只注入「待触发」的 active 任务——触发时刻仍在未来。已响过/已完成/已过期的
 * 提醒一律不进上下文（TTL 在注入点生效，用完即出）。此前实现会把 12 小时内
 * 已完成的单次提醒以「已完成」行留在快照里，等于把过期提醒当上下文持续喂给
 * 模型：早上 8 点响过的提醒，到了晚上被历史话术复活成「明早八点」。现在过期
 * 数据不再自动注入；模型需要核对历史提醒时，用 calendar action=list_tasks
 * 传过去时间的 from 主动查询（按需取数，不污染每轮上下文）。
 *
 * 待触发视角（extended=false）：active 任务按触发时刻升序取最近 3 条，单次任务
 * 不限时间跨度（三年后的手术也该被引用到），周期任务取下一次实例。
 * extended=true（schedule_query 明确查询视角）：7 天视野最多 5 条。
 * 空态：extended=false 返回 ""（调用方省略注入，零开销）；extended=true 返回
 * count=0 并提示历史提醒走工具查询（明确告诉模型「近 7 天没有待触发日程」）。
 */
export function buildSchedulePromptSnapshot(
  scheduleTaskService: ScheduleTaskService,
  sessionId: string,
  extended: boolean,
  options?: { now?: number },
): string {
  const now = options?.now ?? Date.now();
  const maxItems = extended ? 5 : 3;

  let tasks: ScheduleTaskRecord[];
  if (extended) {
    // 查询视角：近 7 天（from=now，过期项同样不注入）
    const from = new Date(now).toISOString();
    const to = new Date(now + 7 * 86_400_000).toISOString();
    tasks = scheduleTaskService.listTasksBySession(sessionId, { from, to });
  } else {
    // 待触发视角：from=now 直接把已过期/已完成项滤掉（listTasksBySession 缺省
    // from=now 也走这条），只留触发时刻在未来的 active 任务。
    tasks = scheduleTaskService
      .listTasksBySession(sessionId, { from: new Date(now).toISOString() })
      .filter((task) => task.status === "active");
  }

  if (tasks.length === 0) {
    return extended
      ? "SCH|range=7d|count=0（近 7 天无待触发日程；已响过或已过期的提醒不在上下文，核对请用 calendar action=list_tasks 把 from 设为过去时间）"
      : "";
  }

  const lines = tasks.slice(0, maxItems).map((task) => buildSnapshotLine(task, now));
  const hiddenCount = tasks.length - Math.min(tasks.length, maxItems);
  const header = extended
    ? `SCH|range=7d|count=${tasks.length}|shown=${lines.length}|more=${Math.max(0, hiddenCount)}`
    : `SCH|pending|count=${tasks.length}|shown=${Math.min(tasks.length, maxItems)}|more=${Math.max(0, hiddenCount)}`;

  return [
    header,
    ...lines,
    // 引用纪律：剩余时间是本轮实时算的，模型引用提醒以本块为准，禁止复读历史对话
    // 里的相对措辞（「七分钟后」这类）。
    "（以上为待触发日程/提醒权威快照，剩余时间按本轮实时计算；引用提醒时间以此块为准，禁止照搬历史对话里的相对说法。已响过/已过期的提醒不在本块，属于过去事件，别再当未来安排复述）",
  ].join("\n");
}
