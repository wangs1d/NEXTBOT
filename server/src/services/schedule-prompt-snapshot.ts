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

/** 「刚到点」回看窗口：已打完的单次提醒保留 12 小时，超窗彻底出快照。 */
const RECENT_DONE_WINDOW_MS = 12 * 60 * 60_000;
const RECENT_DONE_MAX = 2;

/**
 * 构建单条日程快照行：ISO 绝对时间（权威锚）+ 任务时区 HH:MM + 剩余时间/状态
 * + 周期 + 事项。剩余时间每轮按当前真实时钟现算，模型任何轮次引用提醒都有
 * 权威时间可对照（2026-11-05「七分钟后那觉」复读事故的根治项之一）。
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
 * 刚打完的单次提醒行（已完成 + 本地钟点）：2026-11-07「五点二十」事故根治项。
 * 此前待触发视角只看 active，提醒一打完就从快照消失——历史轮里模型自己说错的
 * 时间（UTC 钟点误当本地「五点二十」）失去对照物，后续轮照搬错话得出
 * 「两点五十才睡、五点二十睡、九点起」的自相矛盾。把 12 小时内到点的提醒
 * 连同权威本地时间留在快照末尾，模型随时能拿它顶掉历史里的错误说法。
 */
function buildRecentDoneLine(task: ScheduleTaskRecord): string {
  const when = task.runAt || task.nextRunAt || "";
  const title = task.reminderMessage?.trim() || task.title;
  const localClock = formatLocalClock(when, task.timezone);
  const clockPart = localClock ? `，本地 ${localClock} 已响过` : "，已响过";
  return `- ${when}|单次|已完成${clockPart}|${title}`;
}

/**
 * 【时间感知·日程态】通用快照（2026-11-05 二轮泛化，数据驱动、无场景开关）：
 * 只要有待触发的日程/提醒，每轮注入权威快照（绝对触发时间 + 每轮现算剩余时间），
 * 任何轮次引用提醒都有权威时间可对照；没有待触发事项则不注入（零开销）。
 * 不再按「是否在问日程/是否追问/是否临近」开闸——那是打补丁，换个场景就漏。
 *
 * 待触发视角（extended=false）：active 任务按触发时刻升序取最近 3 条，单次任务
 * 不限时间跨度（三年后的手术也该被引用到），周期任务取下一次实例；12 小时内
 * 刚到点的单次提醒以「已完成」行附在末尾（历史轮说错的时间需要权威对照物，
 * 2026-11-07「五点二十」事故根治项）。
 * extended=true（schedule_query 明确查询视角）：7 天视野最多 5 条，含已完成。
 * 空态：extended=false 返回 ""（调用方省略注入）；extended=true 仍返回 count=0
 * （明确告诉模型「近 7 天没有日程」也是有效回答）。
 */
export function buildSchedulePromptSnapshot(
  scheduleTaskService: ScheduleTaskService,
  sessionId: string,
  extended: boolean,
): string {
  const now = Date.now();
  const maxItems = extended ? 5 : 3;

  let tasks: ScheduleTaskRecord[];
  let recentDone: ScheduleTaskRecord[] = [];
  if (extended) {
    // 查询视角：近 7 天（含已完成，问「我最近有什么安排」时已完成项也有对照价值）
    const from = new Date(now).toISOString();
    const to = new Date(now + 7 * 86_400_000).toISOString();
    tasks = scheduleTaskService.listTasksBySession(sessionId, { from, to });
  } else {
    // 待触发视角：所有未来单次 + 周期任务下一次实例（单次不限跨度、周期默认
    // 展开 7 天），仅 active，按触发时刻升序取最近几条。from 回拨 12h：
    // listTasksBySession 缺省 from=now 会把已完成项整体滤掉，刚响过的提醒
    // 必须留在候选里（见下方 recentDone）。
    const all = scheduleTaskService.listTasksBySession(sessionId, {
      from: new Date(now - RECENT_DONE_WINDOW_MS).toISOString(),
    });
    tasks = all.filter((task) => task.status === "active");
    // 刚到点的单次提醒（12h 内）保留为「已完成」行：历史轮里说错的时间
    // 需要一个权威对照物（2026-11-07「五点二十」事故根治项）。
    recentDone = all
      .filter(
        (task) =>
          task.status === "completed" &&
          task.recurrence === "none",
      )
      .map((task) => ({ task, at: new Date(task.lastRunAt || task.runAt).getTime() }))
      .filter(({ at }) => Number.isFinite(at) && at > 0 && now - at <= RECENT_DONE_WINDOW_MS)
      .sort((a, b) => b.at - a.at)
      .slice(0, RECENT_DONE_MAX)
      .map(({ task }) => task);
  }

  if (tasks.length === 0 && recentDone.length === 0) {
    return extended ? "SCH|range=7d|count=0" : "";
  }

  const lines = tasks.slice(0, maxItems).map((task) => buildSnapshotLine(task, now));
  if (recentDone.length > 0) {
    lines.push(...recentDone.map(buildRecentDoneLine));
  }

  const hiddenCount = tasks.length - Math.min(tasks.length, maxItems);
  const header = extended
    ? `SCH|range=7d|count=${tasks.length}|shown=${lines.length - recentDone.length}|more=${Math.max(0, hiddenCount)}`
    : `SCH|pending|count=${tasks.length}|shown=${Math.min(tasks.length, maxItems)}|more=${Math.max(0, hiddenCount)}`;

  return [
    header,
    ...lines,
    // 引用纪律：剩余时间是本轮实时算的，模型引用提醒以本块为准，禁止复读历史对话
    // 里的相对措辞（「七分钟后」这类）。
    "（以上为日程/提醒权威快照，剩余时间按本轮实时计算；引用提醒时间以此块为准，禁止照搬历史对话里的相对说法" +
      (recentDone.length > 0
        ? "。末尾「已完成」行是刚响过的提醒及其真实本地时间——历史对话里对它的任何说法与此冲突时，以此块为准"
        : "") +
      "）",
  ]
    .filter(Boolean)
    .join("\n");
}
