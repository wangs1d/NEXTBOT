/**
 * 内置 Calendar 工具：在对话中把「定时提醒 / 日程」落到服务端 `ScheduleTaskService`，
 * 与 Web 聊天里用自然语言建日程、`/chat/schedule-draft` 同源解析（`calendar.create_from_text`）。
 */
import { resolveActorId } from "../agent/actor-id.js";
import { isAlarmLikeReminderText, repeatRuleFromRecurrence, type ScheduleRecurrence } from "../services/alarm-clock/alarm-intent.js";
import type { AlarmClockService } from "../services/alarm-clock/alarm-clock-service.js";
import type { ScheduleConflictService } from "../services/schedule-conflict-service.js";
import { buildConflictToolResult, precheckCreateConflict } from "../services/schedule-conflict-service.js";
import type { ScheduleIntentService } from "../services/schedule-intent-service.js";
import type { ScheduleDraft } from "../services/schedule-intent-service.js";
import type { CreateScheduleTaskInput, ScheduleTaskService } from "../services/schedule-task-service.js";
import { describeRemindPlan } from "../services/schedule-reminder-policy.js";
import {
  normalizeDurationMinutes,
  normalizeRemindBeforeMinutes,
  parseScheduleTaskCategory,
} from "../services/schedule-task-service.js";
import { toolResultFromScheduleParse } from "./schedule-create-guard.js";
import type { ToolRegistry } from "./tool-registry.js";

/** 将 ISO UTC 时间字符串格式化为用户可读的本地时间描述 */
export function formatNextRunAtLocal(iso: string | null | undefined, timezone: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const now = new Date();
  const diffMs = d.getTime() - now.getTime();
  // 90秒内：显示相对时间
  if (diffMs > 0 && diffMs < 90_000) {
    const sec = Math.max(1, Math.round(diffMs / 1000));
    if (sec < 60) return `${sec}秒后`;
    return `${Math.round(sec / 60)}分钟后`;
  }
  // 使用 Intl 显式按用户时区格式化，避免服务器本地时区偏差
  const pad = (n: number) => String(n).padStart(2, "0");
  const timeStr = d.toLocaleString("zh-CN", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const today = (() => {
    const nowLocal = new Date(new Date().toLocaleString("en-US", { timeZone: timezone }));
    const targetLocal = new Date(d.toLocaleString("en-US", { timeZone: timezone }));
    return (
      nowLocal.getFullYear() === targetLocal.getFullYear() &&
      nowLocal.getMonth() === targetLocal.getMonth() &&
      nowLocal.getDate() === targetLocal.getDate()
    );
  })();
  if (today) return `今天${timeStr}`;
  const dateStr = d.toLocaleDateString("zh-CN", {
    timeZone: timezone,
    month: "numeric",
    day: "numeric",
  });
  return `${dateStr}${timeStr}`;
}

export function buildScheduleCreateInput(
  draft: ScheduleDraft,
  sessionId: string,
  timezone: string,
): CreateScheduleTaskInput {
  const tz = timezone.trim() || "Asia/Shanghai";
  if (draft.kind === "reminder") {
    return {
      sessionId,
      shortTitle: draft.shortTitle?.trim() || undefined,
      description: draft.description,
      kind: "reminder",
      category: draft.category,
      runAt: draft.runAt,
      recurrence: draft.recurrence,
      timezone: tz,
      reminderMessage: draft.reminderMessage?.trim() || draft.description,
      durationMinutes: draft.durationMinutes,
      location: draft.location?.trim() || undefined,
      remindBeforeMinutes: draft.remindBeforeMinutes,
    };
  }
  if (draft.kind === "action") {
    if (!draft.action?.url) {
      throw new Error("动作任务缺少 action.url");
    }
    return {
      sessionId,
      title: draft.title,
      shortTitle: draft.shortTitle?.trim() || undefined,
      description: draft.description,
      kind: "action",
      category: draft.category,
      runAt: draft.runAt,
      recurrence: draft.recurrence,
      timezone: tz,
      action: draft.action,
      durationMinutes: draft.durationMinutes,
    };
  }
  return {
    sessionId,
    title: draft.title,
    shortTitle: draft.shortTitle?.trim() || undefined,
    description: draft.description,
    kind: "weather_brief",
    category: draft.category,
    runAt: draft.runAt,
    recurrence: draft.recurrence,
    timezone: tz,
    durationMinutes: draft.durationMinutes,
  };
}

/**
 * 闹钟类提醒（「明早7点叫我起床」）在日程任务之外补建真闹钟（kind=alarm）。
 *
 * 日程任务照常创建（今日安排/编辑/删除生态不动）；真闹钟经 alarm-clock 链路
 * alarm.sync 下发到手机端本地精确调度（AlarmManager，杀进程也响）。
 * 幂等由 AlarmStore.findDuplicate（同 label 同 fireAt ±60s）兜底，口头重复不炸双响。
 *
 * 返回建好的闹钟摘要；不满足条件（非闹钟类 / 服务未装配 / 时间已过 / yearly 重复）
 * 返回 null，调用方按纯日程提醒转述。
 */
export function createLinkedAlarmIfAlarmLike(
  getAlarmClockService: (() => AlarmClockService | null) | undefined,
  input: { text: string; label: string; runAt: string; recurrence: string; actorId: string },
): { alarmId: string; nextFireAt: string | null; repeatRule: string | null; label: string } | null {
  const alarmClockService = getAlarmClockService?.();
  if (!alarmClockService) return null;
  // 时间语义必须成立：过去时刻/非法时间不建闹钟（日程层自会给出自己的报错路径）
  const fireMs = new Date(input.runAt).getTime();
  if (!Number.isFinite(fireMs) || fireMs <= Date.now()) return null;
  if (!isAlarmLikeReminderText(input.text)) return null;
  const { rule, ok } = repeatRuleFromRecurrence(input.recurrence as ScheduleRecurrence);
  if (!ok) return null;
  const label = input.label.trim().slice(0, 24) || "闹钟";
  try {
    const { alarm } = alarmClockService.createAlarm({
      actorId: input.actorId,
      label,
      kind: "alarm",
      fireAt: input.runAt,
      repeatRule: rule,
      source: "agent",
    });
    return { alarmId: alarm.id, nextFireAt: alarm.nextFireAt ?? null, repeatRule: rule, label };
  } catch {
    // 闹钟链路任何异常都不阻断日程创建：退化为纯提醒（与旧行为一致）
    return null;
  }
}

export function registerCalendarTools(
  registry: ToolRegistry,
  scheduleTaskService: ScheduleTaskService,
  scheduleIntentService: ScheduleIntentService,
  conflictService?: ScheduleConflictService,
  /** 闹钟服务懒取用器：闹钟服务在装配序列后段构造，用 getter 解耦创建顺序 */
  getAlarmClockService?: () => AlarmClockService | null,
): void {
  registry.register("calendar.create_from_text", async (input, context) => {
    const text = String(input.text ?? "").trim();
    if (!text) return { ok: false, error: "text 不能为空" };
    const sessionId = resolveActorId(context);
    const tz = String(input.timezone ?? "Asia/Shanghai").trim() || "Asia/Shanghai";
    const forceCreate = input.forceCreate === true;

    // 重复创建由 ScheduleTaskService.createTask 幂等兜底（同会话同内容同时间签名
    // 返回已有任务），工具侧不再维护独立的去重缓存。

    const parsed = await scheduleIntentService.parseForCreate(
      sessionId,
      text,
      { userTimezone: context.clientLocation?.timezone?.trim() || tz },
    );
    const guarded = toolResultFromScheduleParse(parsed);
    if (!guarded.proceed) {
      return guarded.result;
    }
    const draft = guarded.draft;
    try {
      // 冲突预检（程序层确定性检测）：有冲突且未 forceCreate → 不创建，回冲突详情
      if (conflictService) {
        const conflictResult = precheckCreateConflict(conflictService, {
          sessionId,
          runAt: draft.runAt,
          durationMinutes: draft.durationMinutes,
          category: draft.category,
          timezone: tz,
          forceCreate,
        });
        if (conflictResult) return conflictResult;
      }
      const payload = buildScheduleCreateInput(draft, sessionId, tz);
      const task = await scheduleTaskService.createTask(payload);
      // 闹钟类提醒补建真闹钟（本地精确响铃主路）；日程任务照常，双链并存
      const linkedAlarm = createLinkedAlarmIfAlarmLike(getAlarmClockService, {
        text: `${text} ${draft.description}`,
        label: draft.shortTitle?.trim() || draft.title?.trim() || draft.reminderMessage?.trim() || draft.description,
        runAt: draft.runAt,
        recurrence: draft.recurrence,
        actorId: sessionId,
      });
      const response = {
        ok: true,
        matched: true,
        summary: linkedAlarm ? "闹钟已设置（手机端到点响铃）" : "日程已写入",
        taskId: task.taskId,
        ...(linkedAlarm ? { alarmId: linkedAlarm.alarmId, alarmNextFireAt: linkedAlarm.nextFireAt } : {}),
        title: task.reminderMessage || task.title,
        shortTitle: task.shortTitle,
        kind: task.kind,
        category: task.category,
        nextRunAt: task.nextRunAt,
        nextRunAtLocal: formatNextRunAtLocal(task.nextRunAt, tz),
        durationMinutes: task.durationMinutes,
        location: task.location,
        remindBeforeMinutes: task.remindBeforeMinutes,
        remindPlan: describeRemindPlan(task),
        recurrence: task.recurrence,
        reminderMessage: task.reminderMessage,
      };
      return response;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, error: msg };
    }
  });

  registry.register("calendar.create_task", async (input, context) => {
    const sessionId = resolveActorId(context);
    const title = String(input.title ?? "").trim();
    const shortTitle = String(input.shortTitle ?? "").trim() || undefined;
    const description = String(input.description ?? "").trim();
    const runAt = String(input.runAt ?? "").trim();
    const kindRaw = String(input.kind ?? "reminder").trim();
    const recurrenceRaw = String(input.recurrence ?? "none").trim();
    const timezone = String(input.timezone ?? "Asia/Shanghai").trim() || "Asia/Shanghai";
    const category = parseScheduleTaskCategory(input.category);
    if (!description || !runAt) {
      return { ok: false, error: "description、runAt（ISO 时间字符串）必填" };
    }
    if (
      kindRaw !== "reminder" &&
      kindRaw !== "action" &&
      kindRaw !== "weather_brief" &&
      kindRaw !== "agent_task"
    ) {
      return { ok: false, error: "kind 须为 reminder、action、weather_brief 或 agent_task" };
    }
    if (!["none", "daily", "weekly", "yearly"].includes(recurrenceRaw)) {
      return { ok: false, error: "recurrence 须为 none、daily、weekly 或 yearly" };
    }
    if (kindRaw !== "reminder" && !title) {
      return { ok: false, error: "非提醒类型需要提供 title" };
    }
    const recurrence = recurrenceRaw as "none" | "daily" | "weekly" | "yearly";
    const durationMinutes = normalizeDurationMinutes(input.durationMinutes);
    const remindBeforeMinutes = normalizeRemindBeforeMinutes(input.remindBeforeMinutes);
    const forceCreate = input.forceCreate === true;

    try {
      // 冲突预检（程序层确定性检测）：有冲突且未 forceCreate → 不创建，回冲突详情
      if (conflictService) {
        const conflictResult = precheckCreateConflict(conflictService, {
          sessionId,
          runAt,
          durationMinutes,
          category,
          timezone,
          forceCreate,
        });
        if (conflictResult) return conflictResult;
      }
      if (kindRaw === "reminder") {
        const reminderMessage = String(input.reminderMessage ?? description).trim();
        const location = String(input.location ?? "").trim() || undefined;
        const task = await scheduleTaskService.createTask({
          sessionId,
          title: title || undefined,
          shortTitle,
          description,
          kind: "reminder",
          category,
          runAt,
          recurrence,
          timezone,
          reminderMessage,
          durationMinutes,
          location,
          remindBeforeMinutes,
        });
        // 闹钟类提醒补建真闹钟（本地精确响铃主路）；日程任务照常，双链并存
        const linkedAlarm = createLinkedAlarmIfAlarmLike(getAlarmClockService, {
          text: `${title} ${description} ${reminderMessage}`,
          label: shortTitle || task.shortTitle || task.reminderMessage || task.title || description,
          runAt: task.nextRunAt ?? runAt,
          recurrence,
          actorId: sessionId,
        });
        const response = {
          ok: true,
          matched: true,
          summary: linkedAlarm ? "闹钟已设置（手机端到点响铃）" : "提醒已写入日程",
          taskId: task.taskId,
          ...(linkedAlarm ? { alarmId: linkedAlarm.alarmId, alarmNextFireAt: linkedAlarm.nextFireAt } : {}),
          title: task.reminderMessage || task.title,
          shortTitle: task.shortTitle,
          kind: task.kind,
          category: task.category,
          nextRunAt: task.nextRunAt,
          nextRunAtLocal: formatNextRunAtLocal(task.nextRunAt, timezone),
          durationMinutes: task.durationMinutes,
          location: task.location,
          remindBeforeMinutes: task.remindBeforeMinutes,
          remindPlan: describeRemindPlan(task),
          recurrence: task.recurrence,
          reminderMessage: task.reminderMessage,
        };
        return response;
      }
      if (kindRaw === "weather_brief") {
        const task = await scheduleTaskService.createTask({
          sessionId,
          title,
          shortTitle,
          description,
          kind: "weather_brief",
          category,
          runAt,
          recurrence,
          timezone,
        });
        const response = {
          ok: true,
          matched: true,
          summary: "日程已写入",
          taskId: task.taskId,
          title: task.title,
          shortTitle: task.shortTitle,
          kind: task.kind,
          category: task.category,
          nextRunAt: task.nextRunAt,
          nextRunAtLocal: formatNextRunAtLocal(task.nextRunAt, timezone),
          recurrence: task.recurrence,
        };
        return response;
      }
      if (kindRaw === "agent_task") {
        const agentTaskIn = input.agentTask as Record<string, unknown> | undefined;
        const prompt = String(input.prompt ?? agentTaskIn?.prompt ?? description).trim();
        if (!prompt) return { ok: false, error: "agent_task 任务需要提供 prompt 或 agentTask.prompt" };
        const accessModeRaw = String(agentTaskIn?.accessMode ?? input.accessMode ?? "sandbox").trim();
        const accessMode = accessModeRaw === "full" ? "full" : "sandbox";
        const task = await scheduleTaskService.createTask({
          sessionId,
          title,
          shortTitle,
          description,
          kind: "agent_task",
          category,
          runAt,
          recurrence,
          timezone,
          agentTask: { prompt, accessMode },
        });
        const response = {
          ok: true,
          matched: true,
          summary: "Agent 自动化任务已写入日程",
          taskId: task.taskId,
          title: task.title,
          shortTitle: task.shortTitle,
          kind: task.kind,
          category: task.category,
          nextRunAt: task.nextRunAt,
          nextRunAtLocal: formatNextRunAtLocal(task.nextRunAt, timezone),
          recurrence: task.recurrence,
        };
        return response;
      }
      const actionIn = input.action as Record<string, unknown> | undefined;
      const url = String(actionIn?.url ?? input.actionUrl ?? "").trim();
      if (!url) return { ok: false, error: "action 任务需提供 action.url 或 actionUrl" };
      const methodRaw = String(actionIn?.method ?? input.actionMethod ?? "POST").toUpperCase();
      const method = ["GET", "POST", "PUT", "PATCH", "DELETE"].includes(methodRaw)
        ? (methodRaw as "GET" | "POST" | "PUT" | "PATCH" | "DELETE")
        : "POST";
      const task = await scheduleTaskService.createTask({
        sessionId,
        title,
        shortTitle,
        description,
        kind: "action",
        category,
        runAt,
        recurrence,
        timezone,
        action: { url, method, body: actionIn?.body },
      });
      const response = {
        ok: true,
        matched: true,
        summary: "日程已写入",
        taskId: task.taskId,
        title: task.title,
        shortTitle: task.shortTitle,
        kind: task.kind,
        category: task.category,
        nextRunAt: task.nextRunAt,
        nextRunAtLocal: formatNextRunAtLocal(task.nextRunAt, timezone),
        recurrence: task.recurrence,
      };
      return response;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, error: msg };
    }
  });

  registry.register("calendar.list_tasks", async (input, context) => {
    const sessionId = resolveActorId(context);
    const now = Date.now();
    const from =
      input.from != null && String(input.from).trim()
        ? String(input.from).trim()
        : new Date(now).toISOString();
    const to =
      input.to != null && String(input.to).trim()
        ? String(input.to).trim()
        : new Date(now + 120 * 86400000).toISOString();
    const tasks = scheduleTaskService.listTasksBySession(sessionId, { from, to });
    return {
      ok: true,
      from,
      to,
      count: tasks.length,
      tasks: tasks.map((t) => ({
        taskId: t.taskId,
        title: t.kind === "reminder" ? (t.reminderMessage || t.title) : t.title,
        kind: t.kind,
        status: t.status,
        recurrence: t.recurrence,
        nextRunAt: t.nextRunAt,
        runAt: t.runAt,
        timezone: t.timezone,
      })),
    };
  });

  registry.register("calendar.delete_task", async (input, context) => {
    const taskId = String(input.taskId ?? "").trim();
    if (!taskId) {
      return { ok: false, error: "taskId 不能为空" };
    }
    try {
      await scheduleTaskService.deleteTask(taskId);
      return { ok: true, summary: "日程已删除", taskId };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, error: msg };
    }
  });

  registry.register("calendar.update_task", async (input, context) => {
    const sessionId = resolveActorId(context);
    const taskId = String(input.taskId ?? "").trim();
    if (!taskId) return { ok: false, error: "taskId 不能为空（来自 calendar.list_tasks）" };
    const existing = scheduleTaskService.getTask(taskId);
    if (!existing || existing.sessionId !== sessionId) {
      return { ok: false, error: `日程 ${taskId} 不存在` };
    }
    const timezone = String(input.timezone ?? existing.timezone ?? "Asia/Shanghai").trim() || "Asia/Shanghai";
    const runAt = input.runAt != null && String(input.runAt).trim() ? String(input.runAt).trim() : undefined;
    const recurrenceRaw = input.recurrence != null ? String(input.recurrence).trim() : undefined;
    if (recurrenceRaw && !["none", "daily", "weekly", "yearly"].includes(recurrenceRaw)) {
      return { ok: false, error: "recurrence 须为 none、daily、weekly 或 yearly" };
    }
    const durationMinutes =
      input.durationMinutes !== undefined ? normalizeDurationMinutes(input.durationMinutes) : undefined;
    const category =
      input.category !== undefined ? parseScheduleTaskCategory(input.category) : undefined;

    try {
      // 改期冲突预检：仅当新时间/新时长实际变化时检测
      if (
        conflictService &&
        (runAt || durationMinutes !== undefined) &&
        input.forceCreate !== true
      ) {
        const conflictResult = precheckCreateConflict(conflictService, {
          sessionId,
          runAt: runAt ?? existing.nextRunAt ?? existing.runAt,
          durationMinutes: durationMinutes ?? existing.durationMinutes,
          category: category ?? existing.category,
          timezone,
          excludeTaskId: taskId,
        });
        if (conflictResult) return conflictResult;
      }
      const task = await scheduleTaskService.updateTask(taskId, {
        title: input.title != null ? String(input.title) : undefined,
        shortTitle: input.shortTitle != null ? String(input.shortTitle) : undefined,
        description: input.description != null ? String(input.description) : undefined,
        reminderMessage: input.reminderMessage != null ? String(input.reminderMessage) : undefined,
        category,
        recurrence: recurrenceRaw as "none" | "daily" | "weekly" | "yearly" | undefined,
        runAt,
        timezone: input.timezone != null ? timezone : undefined,
        durationMinutes,
        remindBeforeMinutes:
          input.remindBeforeMinutes !== undefined
            ? normalizeRemindBeforeMinutes(input.remindBeforeMinutes)
            : undefined,
        location: input.location != null ? String(input.location).trim() || undefined : undefined,
        status:
          input.status === "active" || input.status === "paused" || input.status === "cancelled"
            ? input.status
            : undefined,
      });
      return {
        ok: true,
        matched: true,
        summary: "日程已更新",
        taskId: task.taskId,
        title: task.reminderMessage || task.title,
        shortTitle: task.shortTitle,
        kind: task.kind,
        category: task.category,
        status: task.status,
        nextRunAt: task.nextRunAt,
        nextRunAtLocal: formatNextRunAtLocal(task.nextRunAt, timezone),
        durationMinutes: task.durationMinutes,
        location: task.location,
        remindBeforeMinutes: task.remindBeforeMinutes,
        remindPlan: describeRemindPlan(task),
        recurrence: task.recurrence,
        reminderMessage: task.reminderMessage,
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, error: msg };
    }
  });

  registry.register("calendar.find_free_slots", async (input, context) => {
    if (!conflictService) return { ok: false, error: "空闲时段查询未启用" };
    const sessionId = resolveActorId(context);
    const durationMinutes = Number(input.durationMinutes ?? 60);
    if (!Number.isFinite(durationMinutes) || durationMinutes <= 0) {
      return { ok: false, error: "durationMinutes 须为正整数（分钟）" };
    }
    const tz =
      String(input.timezone ?? context.clientLocation?.timezone ?? "Asia/Shanghai").trim() ||
      "Asia/Shanghai";
    const dailyWindowRaw = input.dailyWindow as Record<string, unknown> | undefined;
    const slots = conflictService.findFreeSlots({
      sessionId,
      durationMinutes: Math.round(durationMinutes),
      from: input.from != null && String(input.from).trim() ? String(input.from).trim() : undefined,
      to: input.to != null && String(input.to).trim() ? String(input.to).trim() : undefined,
      timezone: tz,
      dailyWindow:
        dailyWindowRaw && typeof dailyWindowRaw.start === "string" && typeof dailyWindowRaw.end === "string"
          ? { start: dailyWindowRaw.start, end: dailyWindowRaw.end }
          : undefined,
      excludeTaskId:
        input.excludeTaskId != null && String(input.excludeTaskId).trim()
          ? String(input.excludeTaskId).trim()
          : undefined,
      limit: Number.isFinite(Number(input.limit)) ? Number(input.limit) : undefined,
    });
    return {
      ok: true,
      summary: slots.length > 0 ? `找到 ${slots.length} 个空闲时段` : "范围内没有足够长的空闲时段",
      durationMinutes: Math.round(durationMinutes),
      timezone: tz,
      slots: slots.map((s) => ({
        startAt: s.startAt,
        endAt: s.endAt,
        startLocal: formatNextRunAtLocal(s.startAt, tz),
        endLocal: new Date(s.endAt).toLocaleString("zh-CN", {
          timeZone: tz,
          month: "numeric",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        }),
        durationMinutes: s.durationMinutes,
      })),
      hint:
        slots.length > 0
          ? "把空闲时段转述给用户（用 startLocal/endLocal 展示），由用户选择后再创建或改期。"
          : "没有可用空闲时段时，如实告知用户并询问是否缩小范围、缩短时长或改天。",
    };
  });

  // 批量创建（课表/排班表/会议日程等一次性导入场景）：逐条走与 create_task 相同的
  // 冲突预检与幂等创建；部分失败不影响其余条目，逐条结果回传给模型转述。
  registry.register("calendar.batch_create", async (input, context) => {
    const sessionId = resolveActorId(context);
    const timezone = String(input.timezone ?? "Asia/Shanghai").trim() || "Asia/Shanghai";
    const forceCreate = input.forceCreate === true;
    const rawItems = Array.isArray(input.items) ? (input.items as Array<Record<string, unknown>>) : [];
    if (rawItems.length === 0) {
      return { ok: false, error: "items 必填：至少一条 {description, runAt}（runAt 为 ISO 时间字符串）" };
    }
    if (rawItems.length > 60) {
      return { ok: false, error: `单次最多批量创建 60 条，收到 ${rawItems.length} 条；请拆分调用` };
    }
    const results: Array<Record<string, unknown>> = [];
    let created = 0;
    let skipped = 0;
    let failed = 0;
    for (let i = 0; i < rawItems.length; i++) {
      const raw = rawItems[i] ?? {};
      const description = String(raw.description ?? "").trim();
      const runAt = String(raw.runAt ?? "").trim();
      const itemLabel = description ? `「${description.slice(0, 20)}」` : `第 ${i + 1} 条`;
      if (!description || !runAt) {
        failed += 1;
        results.push({ index: i, description, ok: false, error: "description、runAt（ISO 时间字符串）必填" });
        continue;
      }
      const recurrenceRaw = String(raw.recurrence ?? "none").trim();
      if (!["none", "daily", "weekly", "yearly"].includes(recurrenceRaw)) {
        failed += 1;
        results.push({ index: i, description, ok: false, error: "recurrence 须为 none、daily、weekly 或 yearly" });
        continue;
      }
      const category = parseScheduleTaskCategory(raw.category) ?? "itinerary";
      const durationMinutes = normalizeDurationMinutes(raw.durationMinutes);
      const remindBeforeMinutes = normalizeRemindBeforeMinutes(raw.remindBeforeMinutes);
      const location = String(raw.location ?? "").trim() || undefined;
      try {
        if (conflictService) {
          const conflictResult = precheckCreateConflict(conflictService, {
            sessionId,
            runAt,
            durationMinutes,
            category,
            timezone,
            forceCreate,
          });
          if (conflictResult) {
            skipped += 1;
            results.push({ index: i, description, ok: false, skipped: true, conflict: conflictResult });
            continue;
          }
        }
        const task = await scheduleTaskService.createTask({
          sessionId,
          title: String(raw.title ?? "").trim() || undefined,
          shortTitle: String(raw.shortTitle ?? "").trim() || undefined,
          description,
          kind: "reminder",
          category,
          runAt,
          recurrence: recurrenceRaw as "none" | "daily" | "weekly" | "yearly",
          timezone,
          reminderMessage: String(raw.reminderMessage ?? description).trim(),
          durationMinutes,
          location,
          remindBeforeMinutes,
        });
        results.push({
          index: i,
          description,
          ok: true,
          taskId: task.taskId,
          nextRunAt: task.nextRunAt,
          nextRunAtLocal: formatNextRunAtLocal(task.nextRunAt, timezone),
          durationMinutes: task.durationMinutes,
          remindPlan: describeRemindPlan(task),
        });
        created += 1;
      } catch (e) {
        failed += 1;
        results.push({ index: i, description: itemLabel, ok: false, error: e instanceof Error ? e.message : String(e) });
      }
    }
    return {
      ok: failed === 0,
      summary: `批量创建完成：成功 ${created} 条${skipped > 0 ? `，冲突跳过 ${skipped} 条` : ""}${failed > 0 ? `，失败 ${failed} 条` : ""}。请逐条转述（用 nextRunAtLocal 展示时间），冲突与失败条目如实说明，不要声称全部成功。`,
      created,
      skipped,
      failed,
      results,
    };
  });
}
