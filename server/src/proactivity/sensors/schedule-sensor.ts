// 日程感知传感器（schedule_sensor）—— 持续追踪"下一个要发生的事"。
//
// 轮询 ScheduleTaskService 全量任务 → 计算今日/下一个待运行任务 →
// 与上次快照比对，变化才产出 Signal（payload.nextEventMin 供仲裁层直读）。
// 零 LLM；临近日程的分档事件由评估器链（meeting_soon）承接，这里只管状态追踪。
import type { ScheduleTaskRecord } from "../../services/schedule-task-service.js";
import type { ProactiveSensor, Signal } from "./types.js";

export const SCHEDULE_POLL_MS = 5 * 60_000;

export type ScheduleSensorOptions = {
  listTasks: () => ScheduleTaskRecord[];
  pollIntervalMs?: number;
  nowFn?: () => number;
};

export class ScheduleSensor implements ProactiveSensor {
  readonly id = "schedule_upcoming";
  readonly stream = "schedule" as const;
  readonly pollIntervalMs: number;
  private lastFp = "";
  private lastNext: { min: number; title: string } | null = null;
  private readonly nowFn: () => number;

  constructor(private readonly opts: ScheduleSensorOptions) {
    this.pollIntervalMs = opts.pollIntervalMs ?? SCHEDULE_POLL_MS;
    this.nowFn = opts.nowFn ?? Date.now;
  }

  /** 距下一个任务的分钟数（仲裁层 ContextSnapshot 直读；null = 今天没有日程） */
  latest(): { min: number; title: string } | null {
    return this.lastNext;
  }

  collect(_since: number): Signal[] {
    const now = this.nowFn();
    // 只看还在跑的：completed 的 nextRunAt 已为 null，paused 是用户主动停的，
    // 拿它们算"下一个日程"会给出一个不会发生的事。
    const tasks = this.opts.listTasks().filter((t) => t.status === "active");
    const upcoming = tasks
      .map((t) => {
        // **重复任务（weekly/daily）必须读 nextRunAt**：runAt 是首次触发时刻，
        // 第一次响过之后它就成了过去，用 runAt 会让"每周三的课"在第二周起
        // 从世界板上彻底消失（meeting_soon 再也不认它）。
        const raw = t.nextRunAt ?? t.runAt;
        const runAt = typeof raw === "number" ? raw : Date.parse(String(raw));
        return Number.isFinite(runAt) ? { title: t.title, runAt } : null;
      })
      .filter((v): v is { title: string; runAt: number } => v !== null)
      .filter((v) => v.runAt > now)
      .sort((a, b) => a.runAt - b.runAt);

    const next = upcoming[0] ?? null;
    const min = next ? Math.round((next.runAt - now) / 60_000) : -1;
    this.lastNext = next ? { min, title: next.title } : null;

    // 指纹：未来 24h 内任务集合（含时间），变化才产出
    const horizon = now + 24 * 3600_000;
    const fpSource = upcoming
      .filter((v) => v.runAt <= horizon)
      .map((v) => `${v.title}@${v.runAt}`)
      .sort()
      .join("|");
    if (fpSource === this.lastFp) return [];
    const changed = this.lastFp !== "";
    this.lastFp = fpSource;
    return [
      {
        stream: this.stream,
        at: now,
        fingerprint: `schedule:${fpSource}`,
        salience: changed ? "medium" : "low",
        delta: next
          ? changed
            ? `日程有变：最近的是「${next.title}」（${min <= 0 ? "马上" : `${min} 分钟后`}）`
            : `下一个日程：「${next.title}」（${min <= 0 ? "马上" : `${min} 分钟后`}）`
          : "未来 24 小时没有日程",
        payload: { nextEventMin: next ? min : null, nextTitle: next?.title ?? "", nextRunAt: next?.runAt ?? null },
      },
    ];
  }
}
