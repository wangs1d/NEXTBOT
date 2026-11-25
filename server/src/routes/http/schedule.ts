import { randomUUID } from "crypto";
import type { FastifyInstance } from "fastify";
import {
  isTriviaTask,
  type ScheduleTaskRecord,
} from "../../services/schedule-task-service.js";
import {
  getScheduleHabitStore,
  isPlausibleSleepStartHour,
  isPlausibleWakeHour,
  parseSleepRoutine,
} from "../../services/schedule-habit-store.js";
import { getPresenceFootprintStore } from "../../rhythm/presence-footprint-store.js";
import {
  scheduleTaskCreateBodySchema,
  scheduleTaskListQuerySchema,
  scheduleTaskRunsQuerySchema,
  scheduleTaskUpdateBodySchema,
} from "../../schemas/api.js";
import type { HttpRouteDeps } from "./types.js";

/** 习惯打卡条目（内存存储）。checkins 为打卡时刻的 ISO 字符串列表。 */
type Habit = {
  id: string;
  sessionId: string;
  title: string;
  frequency: string;
  target?: number;
  createdAt: string;
  checkins: string[];
};

/** 模块级内存存储：habitId -> Habit。 */
const habitStore = new Map<string, Habit>();

type TodayScheduleItem = {
  id: string;
  title: string;
  startAt: string;
  notes?: string;
  completed: boolean;
};

function dayRangeFromQuery(fromRaw?: string, toRaw?: string): { from: string; to: string } {
  if (fromRaw && toRaw) {
    return { from: fromRaw, to: toRaw };
  }
  const now = new Date();
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  end.setMilliseconds(end.getMilliseconds() - 1);
  return { from: start.toISOString(), to: end.toISOString() };
}

function getTaskDisplayTime(task: ScheduleTaskRecord): string {
  if (task.status === "completed") {
    return task.lastRunAt ?? task.runAt;
  }
  return task.nextRunAt ?? task.runAt;
}

function toTodayScheduleItem(task: ScheduleTaskRecord): TodayScheduleItem {
  const title = task.reminderMessage?.trim() || task.title?.trim() || task.description;
  return {
    id: task.taskId,
    title,
    startAt: getTaskDisplayTime(task),
    notes: task.description,
    completed: task.status === "completed",
  };
}

/** 取 ISO 字符串对应的本地日期（YYYY-MM-DD）。 */
function isoToDateKey(iso: string): string {
  return iso.slice(0, 10);
}

/**
 * 计算连续打卡天数：从今日向前回溯，遇到无打卡的日期即停止。
 * 若今日未打卡但昨日打卡，则从昨日开始计数（保证「连续至最近」语义）。
 */
function computeStreak(checkins: string[]): number {
  const dateSet = new Set(checkins.map(isoToDateKey));
  if (dateSet.size === 0) return 0;
  let streak = 0;
  const cursor = new Date();
  // 若今日未打卡，则从昨日开始计数
  if (!dateSet.has(isoToDateKey(cursor.toISOString()))) {
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }
  while (dateSet.has(isoToDateKey(cursor.toISOString()))) {
    streak += 1;
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }
  return streak;
}

export function registerScheduleRoutes(app: FastifyInstance, deps: HttpRouteDeps): void {
  const { scheduleTaskService } = deps;

  app.get("/schedule", async () => ({
    domain: "schedule",
    tasksPath: "/schedule/tasks",
    runsPath: "/schedule/runs",
  }));

  app.get("/schedule/tasks", async (request, reply) => {
    const parsed = scheduleTaskListQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    }
    const { sessionId, from, to } = parsed.data;
    // occurrences：窗口内每一次触发时刻（2026-11-24）。客户端据此在设置提醒的当下
    // 就把重复提醒的每一天都渲染出来，而不是只画 nextRunAt 那一条。
    const tasks = scheduleTaskService.listTaskViewsBySession(sessionId, { from, to });
    return { ok: true, tasks };
  });

  app.post("/schedule/tasks", async (request, reply) => {
    const parsed = scheduleTaskCreateBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    }
    try {
      const task = await scheduleTaskService.createTask(parsed.data);
      return { ok: true, task };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return reply.code(400).send({ ok: false, message });
    }
  });

  app.patch<{ Params: { taskId: string } }>("/schedule/tasks/:taskId", async (request, reply) => {
    const parsed = scheduleTaskUpdateBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    }
    try {
      const task = await scheduleTaskService.updateTask(request.params.taskId, parsed.data);
      return { ok: true, task };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return reply.code(400).send({ ok: false, message });
    }
  });

  app.delete<{ Params: { taskId: string } }>("/schedule/tasks/:taskId", async (request, reply) => {
    try {
      await scheduleTaskService.deleteTask(request.params.taskId);
      return { ok: true };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return reply.code(400).send({ ok: false, message });
    }
  });

  // ── 实例层：跳过某一次 / 单次改期（2026-11-25）──────────────────────
  // 「这周三不去」不该删整条提醒；这里只动一个实例，规则与其余天数不变。
  app.post<{ Params: { taskId: string } }>(
    "/schedule/tasks/:taskId/occurrences/skip",
    async (request, reply) => {
      const at = String((request.body as { at?: unknown } | undefined)?.at ?? "").trim();
      if (!at) return reply.code(400).send({ ok: false, error: "at required" });
      try {
        const task = await scheduleTaskService.skipOccurrence(request.params.taskId, at);
        return { ok: true, task };
      } catch (e) {
        return reply.code(400).send({ ok: false, message: e instanceof Error ? e.message : String(e) });
      }
    },
  );

  app.post<{ Params: { taskId: string } }>(
    "/schedule/tasks/:taskId/occurrences/reschedule",
    async (request, reply) => {
      const body = (request.body ?? {}) as { originalAt?: unknown; at?: unknown };
      const originalAt = String(body.originalAt ?? "").trim();
      const at = String(body.at ?? "").trim();
      if (!originalAt || !at) {
        return reply.code(400).send({ ok: false, error: "originalAt and at required" });
      }
      try {
        const task = await scheduleTaskService.rescheduleOccurrence(
          request.params.taskId,
          originalAt,
          at,
        );
        return { ok: true, task };
      } catch (e) {
        return reply.code(400).send({ ok: false, message: e instanceof Error ? e.message : String(e) });
      }
    },
  );

  app.delete<{ Params: { taskId: string } }>(
    "/schedule/tasks/:taskId/occurrences",
    async (request, reply) => {
      try {
        const task = await scheduleTaskService.clearOccurrenceExceptions(request.params.taskId);
        return { ok: true, task };
      } catch (e) {
        return reply.code(400).send({ ok: false, message: e instanceof Error ? e.message : String(e) });
      }
    },
  );

  app.post<{ Params: { taskId: string } }>(
    "/schedule/tasks/:taskId/trigger",
    async (request, reply) => {
      try {
        await scheduleTaskService.triggerNow(request.params.taskId);
        return { ok: true };
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return reply.code(400).send({ ok: false, message });
      }
    },
  );

  app.post<{ Params: { token: string } }>(
    "/schedule/webhook/:token",
    async (request, reply) => {
      try {
        const task = await scheduleTaskService.triggerByWebhookToken(request.params.token);
        return { ok: true, task };
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return reply.code(400).send({ ok: false, message });
      }
    },
  );

  app.get("/schedule/runs", async (request, reply) => {
    const parsed = scheduleTaskRunsQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    }
    const runs = scheduleTaskService.listRuns(parsed.data.taskId, parsed.data.limit ?? 20);
    return { ok: true, runs };
  });

  app.get("/api/schedule/today", async (request, reply) => {
    const query = request.query as { sessionId?: unknown; from?: unknown; to?: unknown };
    const sessionId = String(query.sessionId ?? "").trim();
    if (!sessionId) {
      return reply.code(400).send({ ok: false, error: "sessionId required" });
    }
    const { from, to } = dayRangeFromQuery(
      typeof query.from === "string" ? query.from : undefined,
      typeof query.to === "string" ? query.to : undefined,
    );
    // 琐事类提醒（喝水/睡觉等 trivia 分类、旧数据节律标记）只做后台到点推送，不进「今日安排」
    return scheduleTaskService
      .listTasksBySession(sessionId, { from, to })
      .filter((task) => !isTriviaTask(task))
      .map(toTodayScheduleItem);
  });

  app.post("/api/schedule/habit", async (request, reply) => {
    const body = (request.body ?? {}) as {
      sessionId?: unknown;
      title?: unknown;
      frequency?: unknown;
      target?: unknown;
    };
    const sessionId = String(body.sessionId ?? "").trim();
    if (!sessionId) {
      return reply.code(400).send({ ok: false, error: "sessionId required" });
    }
    const title = String(body.title ?? "").trim();
    if (!title) {
      return reply.code(400).send({ ok: false, error: "title required" });
    }
    const frequency = String(body.frequency ?? "daily").trim();
    if (frequency !== "daily" && frequency !== "weekly") {
      return reply.code(400).send({ ok: false, error: "frequency must be 'daily' or 'weekly'" });
    }
    const targetRaw = body.target;
    const target =
      typeof targetRaw === "number" && Number.isFinite(targetRaw) && targetRaw > 0
        ? targetRaw
        : undefined;
    const habit: Habit = {
      id: randomUUID(),
      sessionId,
      title,
      frequency,
      target,
      createdAt: new Date().toISOString(),
      checkins: [],
    };
    habitStore.set(habit.id, habit);
    return reply.code(201).send({ ok: true, habit });
  });

  app.get("/api/schedule/habits", async (request, reply) => {
    const sessionId = String((request.query as { sessionId?: string }).sessionId ?? "").trim();
    if (!sessionId) {
      return reply.code(400).send({ ok: false, error: "sessionId required" });
    }
    const habits = Array.from(habitStore.values()).filter((h) => h.sessionId === sessionId);
    return { ok: true, habits, count: habits.length };
  });

  app.post<{ Params: { id: string } }>("/api/schedule/habit/:id/checkin", async (request, reply) => {
    const habit = habitStore.get(request.params.id);
    if (!habit) {
      return reply.code(404).send({ ok: false, error: "habit not found" });
    }
    const body = (request.body ?? {}) as { sessionId?: unknown };
    const sessionId = String(body.sessionId ?? "").trim();
    if (!sessionId) {
      return reply.code(400).send({ ok: false, error: "sessionId required" });
    }
    if (habit.sessionId !== sessionId) {
      return reply.code(403).send({ ok: false, error: "habit does not belong to this session" });
    }
    const nowIso = new Date().toISOString();
    const todayKey = isoToDateKey(nowIso);
    // 同一天重复打卡仅记一次
    if (!habit.checkins.some((c) => isoToDateKey(c) === todayKey)) {
      habit.checkins.push(nowIso);
    }
    const streak = computeStreak(habit.checkins);
    return { ok: true, habit, streak };
  });

  app.get<{ Params: { id: string } }>("/api/schedule/habit/:id/streak", async (request, reply) => {
    const habit = habitStore.get(request.params.id);
    if (!habit) {
      return reply.code(404).send({ ok: false, error: "habit not found" });
    }
    const sessionId = String((request.query as { sessionId?: string }).sessionId ?? "").trim();
    if (!sessionId) {
      return reply.code(400).send({ ok: false, error: "sessionId required" });
    }
    if (habit.sessionId !== sessionId) {
      return reply.code(403).send({ ok: false, error: "habit does not belong to this session" });
    }
    const streak = computeStreak(habit.checkins);
    return { ok: true, streak, totalCheckins: habit.checkins.length };
  });

  // ── 作息偏好（分级提醒的冷启动习惯源）────────────────────────────────
  // 用户在设置里填一次「平时几点睡、几点起」，策略层即按此个性化睡前备忘与
  // 起床闹钟（无需等连续多晚的被动睡眠样本）。也接受原文 text 走确定性解析。
  app.get("/api/schedule/sleep-routine", async (request, reply) => {
    const store = getScheduleHabitStore();
    if (!store) return reply.code(503).send({ ok: false, error: "habit store unavailable" });
    const sessionId = String((request.query as { sessionId?: string }).sessionId ?? "").trim();
    if (!sessionId) return reply.code(400).send({ ok: false, error: "sessionId required" });

    // 被动观察：agent 记录「你什么时候在线」推出来的作息（零文本抽取）。
    // 设置页据此如实告知用户：作息是观察来的、观察了几晚、还差什么。
    const footprint = getPresenceFootprintStore();
    const derived = footprint?.deriveSleepWindow(sessionId, { lookbackDays: 14 }) ?? null;
    const observed = footprint
      ? {
          sleepStartHour: derived?.sleepStartHour ?? null,
          wakeHour: derived?.wakeHour ?? null,
          nightCount: derived?.nightCount ?? 0,
          dayCount: footprint.listDays(sessionId).length,
          // 入睡点推得出来才算「观察到了」；差几晚也如实告诉前端，好提示用户
          enoughNights: (derived?.nightCount ?? 0) >= 3,
        }
      : null;

    return { ok: true, routine: store.get(sessionId), observed };
  });

  app.put("/api/schedule/sleep-routine", async (request, reply) => {
    const store = getScheduleHabitStore();
    if (!store) return reply.code(503).send({ ok: false, error: "habit store unavailable" });
    const body = (request.body ?? {}) as {
      sessionId?: unknown;
      sleepStartHour?: unknown;
      wakeHour?: unknown;
      text?: unknown;
    };
    const sessionId = String(body.sessionId ?? "").trim();
    if (!sessionId) return reply.code(400).send({ ok: false, error: "sessionId required" });

    let parsed: { sleepStartHour: number; wakeHour: number } | null = null;
    if (typeof body.text === "string" && body.text.trim()) {
      parsed = parseSleepRoutine(body.text);
      if (!parsed) return reply.code(400).send({ ok: false, error: "text_unparsed" });
    } else {
      const sleepStartHour = Number(body.sleepStartHour);
      const wakeHour = Number(body.wakeHour);
      if (!isPlausibleSleepStartHour(sleepStartHour)) {
        return reply.code(400).send({ ok: false, error: "invalid_sleep_start_hour" });
      }
      if (!isPlausibleWakeHour(wakeHour)) {
        return reply.code(400).send({ ok: false, error: "invalid_wake_hour" });
      }
      parsed = { sleepStartHour, wakeHour };
    }
    const routine = store.set(sessionId, parsed, "explicit");
    return { ok: true, routine };
  });

  app.delete("/api/schedule/sleep-routine", async (request, reply) => {
    const store = getScheduleHabitStore();
    if (!store) return reply.code(503).send({ ok: false, error: "habit store unavailable" });
    const sessionId = String((request.query as { sessionId?: string }).sessionId ?? "").trim();
    if (!sessionId) return reply.code(400).send({ ok: false, error: "sessionId required" });
    return { ok: true, cleared: store.clear(sessionId) };
  });
}
