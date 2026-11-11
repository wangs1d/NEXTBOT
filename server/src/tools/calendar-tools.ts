/**
 * 内置 Calendar 工具：在对话中把「定时提醒 / 日程」落到服务端 `ScheduleTaskService`。
 *
 * 单一写入入口（2026-11-01 用户拍板）：模型侧只有 `calendar.create` 一个创建工具。
 * text 优先走确定性解析（`ScheduleIntentService.parseForCreate`），无 text 时走结构化
 * 字段；提醒/日程/天气/agent_task 都落同一条「冲突预检 → 补闹钟 → createTask」路径，
 * 不再出现同一句话经两个工具各建一条提醒的情况（见 schedule-task-service 幂等判重）。
 */
import { resolveActorId } from "../agent/actor-id.js";
import { primarySubjectOf } from "../proactivity/discovery-layer.js";
import type { ScheduleAssertionStore } from "../proactivity/branches/schedule-assertion-store.js";
import { repeatRuleFromRecurrence, type ScheduleRecurrence } from "../services/alarm-clock/alarm-intent.js";
import type { AlarmClockService } from "../services/alarm-clock/alarm-clock-service.js";
import type { ScheduleConflictService } from "../services/schedule-conflict-service.js";
import { buildConflictToolResult, precheckCreateConflict } from "../services/schedule-conflict-service.js";
import type { ScheduleIntentService } from "../services/schedule-intent-service.js";
import type { ScheduleDraft } from "../services/schedule-intent-service.js";
import type {
  CreateScheduleTaskInput,
  ScheduleTaskRecord,
  ScheduleTaskService,
} from "../services/schedule-task-service.js";
import {
  normalizeDurationMinutes,
  normalizeRemindBeforeMinutes,
  parseScheduleTaskCategory,
} from "../services/schedule-task-service.js";
import { toolResultFromScheduleParse } from "./schedule-create-guard.js";
import type { ToolContext, ToolRegistry } from "./tool-registry.js";

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
  if (today) return `今天 ${timeStr}`;
  const dateStr = d.toLocaleDateString("zh-CN", {
    timeZone: timezone,
    month: "numeric",
    day: "numeric",
  });
  // 日期与时刻之间要有分隔：此前直连拼成「11/611:00」，模型会照抄给用户
  return `${dateStr} ${timeStr}`;
}

/** 0–59 的中文读法：11→十一、20→二十、45→四十五 */
function cnNum(n: number): string {
  const d = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九"];
  if (n < 10) return d[n];
  if (n < 20) return `十${n % 10 === 0 ? "" : d[n % 10]}`;
  return `${d[Math.floor(n / 10)]}十${n % 10 === 0 ? "" : d[n % 10]}`;
}

/** 按用户时区取出年月日时分（不依赖服务器本地时区） */
function localPartsOf(iso: string, timezone: string) {
  const d = new Date(iso);
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    })
      .formatToParts(d)
      .map((p) => [p.type, p.value]),
  );
  const rawHour = Number(parts.hour);
  return {
    y: Number(parts.year),
    m: Number(parts.month),
    d: Number(parts.day),
    hour: rawHour === 24 ? 0 : rawHour,
    minute: Number(parts.minute),
  };
}

/**
 * 口语化时间（2026-11-05）：回执给模型的是「明天上午十一点」这种能直接说出口的
 * 说法，而不是 `11/6 11:00`。前一种模型能自然嵌进句子，后一种只能照抄成
 * 「明天 11:00 会提醒你」——像系统播报，没有活人感。
 *
 * 只用于**对话转述**；客户端展示仍用 `formatNextRunAtLocal`（结构化、不随口语变）。
 */
export function formatNextRunAtSpoken(
  iso: string | null | undefined,
  timezone: string,
): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const t = localPartsOf(iso, timezone);
  const now = localPartsOf(new Date().toISOString(), timezone);
  const dayIndex = (p: { y: number; m: number; d: number }) =>
    Math.floor(Date.UTC(p.y, p.m - 1, p.d) / 86_400_000);
  const diff = dayIndex(t) - dayIndex(now);

  const evening = t.hour >= 18;
  let dayWord: string;
  if (diff === 0) dayWord = evening ? "今晚" : "今天";
  else if (diff === 1) dayWord = evening ? "明晚" : "明天";
  else if (diff === 2) dayWord = evening ? "后天晚上" : "后天";
  else if (diff === 3) dayWord = "大后天";
  else dayWord = `${t.m}月${t.d}日`;

  let prefix = dayWord;
  // 「今晚/明晚」已自带时段，不再叠加；其余按钟点补时段词
  if (!dayWord.endsWith("晚")) {
    const session =
      t.hour < 5 ? "凌晨" : t.hour < 8 ? "早上" : t.hour < 12 ? "上午" : t.hour === 12 ? "中午" : t.hour < 18 ? "下午" : "晚上";
    prefix = dayWord + session;
    // 「今天早上」→「今早」、「明天早上」→「明早」更像人话
    if (session === "早上" && diff === 0) prefix = "今早";
    else if (session === "早上" && diff === 1) prefix = "明早";
  }

  const hourWord = t.hour === 0 ? "零" : cnNum(t.hour % 12 === 0 ? 12 : t.hour % 12);
  // 「零点三十分」而不是「零点半」：凌晨说「半」听着别扭
  const minuteWord =
    t.minute === 0
      ? "点"
      : t.minute === 30 && t.hour !== 0
        ? "点半"
        : `点${t.minute < 10 ? "零" : ""}${cnNum(t.minute)}分`;
  return `${prefix}${hourWord}${minuteWord}`;
}

/**
 * 提前提醒的**性质清单**（2026-11-05 用户二次定调：不要任何成句台词）。
 *
 * 上一版这里返回的是 `advanceHint: "到点前还会再提醒你一次"`——一句成文的话。
 * 用户明确否掉：「不需要你硬编码，让 agent 自己知道就行，它结合上下文会说」。
 * 所以这里只暴露枚举事实（departure=出发前、evening_before=前一晚），
 * 不给句子、不给时刻、不给段数；要不要提、怎么提，全交给模型。
 */
function advanceReminderKindsOf(task: {
  preReminders?: Array<{ stage: string }>;
}): Record<string, string[]> {
  const kinds = new Set<string>();
  for (const p of task.preReminders ?? []) {
    if (p.stage === "depart") kinds.add("departure");
    else if (p.stage === "night_before") kinds.add("evening_before");
  }
  // 已退役的 wake_alarm 等不出现在清单里
  return kinds.size > 0 ? { advanceReminderKinds: [...kinds] } : {};
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
 * 睡觉叫醒（「明早7点叫我起床」）在日程任务之外补建真闹钟（kind=alarm）。
 *
 * 2026-11-09 用户定调：废除正则文本匹配，是否建真闹钟的唯一判定 = 模型传入的
 * alarmIntent（calendar.create schema 字段），且只覆盖一种情形——睡觉叫醒；
 * 「定个闹钟」这类没有睡觉语境的表述不建。模型之外的保护仍是确定性代码：
 * 时间必须成立、RRULE 子集支持。
 *
 * 日程任务照常创建（今日安排/编辑/删除生态不动）；真闹钟经 alarm-clock 链路
 * alarm.sync 下发到手机端本地精确调度（AlarmManager，杀进程也响）。
 * 幂等由 AlarmStore.findDuplicate（同 label 同 fireAt ±60s）兜底，口头重复不炸双响。
 *
 * 返回建好的闹钟摘要；alarmIntent 非 true / 服务未装配 / 时间已过 / yearly 重复
 * 返回 null，调用方按纯日程提醒转述。
 */
export function createLinkedAlarmIfRequested(
  getAlarmClockService: (() => AlarmClockService | null) | undefined,
  input: { alarmIntent: boolean; label: string; runAt: string; recurrence: string; actorId: string },
): { alarmId: string; nextFireAt: string | null; repeatRule: string | null; label: string } | null {
  const alarmClockService = getAlarmClockService?.();
  if (!alarmClockService) return null;
  // 模型没明确表态 = 用户没要睡觉叫醒：宁缺勿滥，绝不误建会真的响铃的闹钟
  if (input.alarmIntent !== true) return null;
  // 时间语义必须成立：过去时刻/非法时间不建闹钟（日程层自会给出自己的报错路径）
  const fireMs = new Date(input.runAt).getTime();
  if (!Number.isFinite(fireMs) || fireMs <= Date.now()) return null;
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
      // 语音叫醒：服务端在建钟时由 SpeechHub 生成话术 + 预合成 mp3，随 alarm.sync
      // 下发到端侧缓存；到点本地 AlarmManager 直接播，不依赖联网。
      wakeMode: { level: "voice_talk", volumeRamp: true },
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
  /** 上传树枝日程主张库（可选）：批量导入课表/行程表时落版本链（缺省跳过） */
  assertionStore?: ScheduleAssertionStore,
): void {
  /**
   * 统一创建回执（所有 kind 同一形状）：模型只读 whenSpoken / reminderMessage
   * 即可转述，不再按入口工具记不同字段。
   *
   * 2026-11-05 用户定调（根治「系统自己配了三级提醒」旁白）：分级预告计划是**内部
   * 编排**，一律不进模型可见回执——此前透出 remindPlan（stages 含 label / fireAtLocal），
   * 确认轮又要求「把预告段转告用户」，模型只能逐条念 21:00 睡前备忘 / 9:00 起床闹钟 /
   * 10:00 该出门了，并借 schema 里的「系统自动分级」把自己说成后台。
   * 只保留 hasAdvanceReminder（是否有提前提醒）——唯一用途是防止模型说「只响一次」
   * （2026-10-25 事故），该标记内部使用，禁止向用户解释。
   */
  const buildCreateResponse = (
    task: ScheduleTaskRecord,
    timezone: string,
    summary: string,
    linkedAlarm: ReturnType<typeof createLinkedAlarmIfRequested> = null,
  ): Record<string, unknown> => ({
    ok: true,
    matched: true,
    summary: linkedAlarm ? "闹钟已设置（手机端到点响铃）" : summary,
    taskId: task.taskId,
    // 提醒确认卡的唯一事实源（2026-11-07）：时区来自设备属性/工具入参，
    // 渲染层据此把 ISO 时刻折算成「明早 07:00」，绝不猜时区；status 由
    // 状态机推进（created → updated / cancelled / fired），模型不参与排版。
    timezone,
    runAt: task.nextRunAt,
    status: "created",
    ...(linkedAlarm
      ? { alarmId: linkedAlarm.alarmId, alarmNextFireAt: linkedAlarm.nextFireAt }
      : {}),
    title: task.reminderMessage || task.title,
    shortTitle: task.shortTitle,
    kind: task.kind,
    category: task.category,
    nextRunAt: task.nextRunAt,
    // 给模型的是能直接说出口的说法（「明天上午十一点」），不是 `11/6 11:00`：
    // 机器格式会被原样抄进气泡（真机：「明天 11:00 会提醒你看牙医」）。
    whenSpoken: formatNextRunAtSpoken(task.nextRunAt, timezone),
    durationMinutes: task.durationMinutes,
    location: task.location,
    // remindBeforeMinutes 不回显（2026-11-05）：自动分级的偏移数组 [840,120,60]
    // 就是分级计划的数值形态，模型能据此算出三个时间点照念。用户显式要求的
    // 提前量模型自己传过参、本来就知道，无需回读。
    hasAdvanceReminder: (task.preReminders?.length ?? 0) > 0,
    ...advanceReminderKindsOf(task),
    recurrence: task.recurrence,
    reminderMessage: task.reminderMessage,
  });

  /** 自然语言分支：text → 确定性解析 → 冲突预检 → 补闹钟 → createTask。 */
  const createFromText = async (
    text: string,
    input: Record<string, unknown>,
    context: ToolContext,
  ): Promise<Record<string, unknown>> => {
    const sessionId = resolveActorId(context);
    const tz = String(input.timezone ?? "Asia/Shanghai").trim() || "Asia/Shanghai";
    const forceCreate = input.forceCreate === true;
    // 重复创建由 ScheduleTaskService.createTask 幂等兜底（同会话同事项同时间签名
    // 返回已有任务），工具侧不再维护独立的去重缓存。
    const parsed = await scheduleIntentService.parseForCreate(sessionId, text, {
      userTimezone: context.clientLocation?.timezone?.trim() || tz,
    });
    const guarded = toolResultFromScheduleParse(parsed);
    if (!guarded.proceed) return guarded.result;
    const draft = guarded.draft;
    try {
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
      const linkedAlarm = createLinkedAlarmIfRequested(getAlarmClockService, {
        // 睡觉叫醒判定唯一来源 = 模型填的 alarmIntent（schema 字段），服务端不做文本猜测
        alarmIntent: input.alarmIntent === true,
        label:
          draft.shortTitle?.trim() ||
          draft.title?.trim() ||
          draft.reminderMessage?.trim() ||
          draft.description,
        runAt: draft.runAt,
        recurrence: draft.recurrence,
        actorId: sessionId,
      });
      return buildCreateResponse(
        task,
        tz,
        draft.kind === "reminder" ? "提醒已写入日程" : "日程已写入",
        linkedAlarm,
      );
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  };

  /** 结构化分支：text 缺省时按字段创建（提醒/天气/agent_task/HTTP 动作）。 */
  const createFromStructured = async (
    input: Record<string, unknown>,
    context: ToolContext,
  ): Promise<Record<string, unknown>> => {
    const sessionId = resolveActorId(context);
    const title = String(input.title ?? "").trim();
    const shortTitle = String(input.shortTitle ?? "").trim() || undefined;
    const description = String(input.description ?? input.subject ?? "").trim();
    const runAt = String(input.runAt ?? "").trim();
    const kindRaw = String(input.kind ?? "reminder").trim();
    const recurrenceRaw = String(input.recurrence ?? "none").trim();
    const timezone = String(input.timezone ?? "Asia/Shanghai").trim() || "Asia/Shanghai";
    const category = parseScheduleTaskCategory(input.category);
    if (!description || !runAt) {
      return {
        ok: false,
        error: "需要 text（自然语言），或同时提供 description（事项）与 runAt（ISO 时间）",
      };
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
        const linkedAlarm = createLinkedAlarmIfRequested(getAlarmClockService, {
          alarmIntent: input.alarmIntent === true,
          label: shortTitle || task.shortTitle || task.reminderMessage || task.title || description,
          runAt: task.nextRunAt ?? runAt,
          recurrence,
          actorId: sessionId,
        });
        return buildCreateResponse(task, timezone, "提醒已写入日程", linkedAlarm);
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
        return buildCreateResponse(task, timezone, "日程已写入");
      }
      if (kindRaw === "agent_task") {
        const agentTaskIn = input.agentTask as Record<string, unknown> | undefined;
        const prompt = String(input.prompt ?? agentTaskIn?.prompt ?? description).trim();
        if (!prompt) {
          return { ok: false, error: "agent_task 任务需要提供 prompt 或 agentTask.prompt" };
        }
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
        return buildCreateResponse(task, timezone, "Agent 自动化任务已写入日程");
      }
      const actionIn = input.httpAction as Record<string, unknown> | undefined;
      const url = String(actionIn?.url ?? input.actionUrl ?? "").trim();
      if (!url) return { ok: false, error: "action 任务需提供 httpAction.url 或 actionUrl" };
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
      return buildCreateResponse(task, timezone, "日程已写入");
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  };

  // 模型侧唯一创建入口：text 优先走确定性解析，无 text 时走结构化字段。
  const handleCreate = async (input: Record<string, unknown>, context: ToolContext) => {
    const text = String(input.text ?? "").trim();
    if (text) return createFromText(text, input, context);
    return createFromStructured(input, context);
  };

  const handleListTasks = async (input: Record<string, unknown>, context: ToolContext) => {
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
  };

  const handleDeleteTask = async (input: Record<string, unknown>, context: ToolContext) => {
    const taskId = String(input.taskId ?? "").trim();
    if (!taskId) {
      return { ok: false, error: "taskId 不能为空" };
    }
    try {
      await scheduleTaskService.deleteTask(taskId);
      // 状态回执供提醒确认卡原地刷新（不追加新卡）；日程页条目已由
      // deleteTask 从数据层移除，手机端下次 refresh() 自然不再出现。
      return { ok: true, summary: "日程已删除", taskId, status: "cancelled" };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, error: msg };
    }
  };

  const handleUpdateTask = async (input: Record<string, unknown>, context: ToolContext) => {
    const sessionId = resolveActorId(context);
    const taskId = String(input.taskId ?? "").trim();
    if (!taskId) return { ok: false, error: "taskId 不能为空（来自 calendar 的 action=list_tasks）" };
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
        timezone,
        runAt: task.nextRunAt,
        whenSpoken: formatNextRunAtSpoken(task.nextRunAt, timezone),
        durationMinutes: task.durationMinutes,
        location: task.location,
        hasAdvanceReminder: (task.preReminders?.length ?? 0) > 0,
        ...advanceReminderKindsOf(task),
        recurrence: task.recurrence,
        reminderMessage: task.reminderMessage,
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, error: msg };
    }
  };

  const handleFindFreeSlots = async (input: Record<string, unknown>, context: ToolContext) => {
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
  };

  // 批量创建（课表/排班表/会议日程等一次性导入场景）：逐条走与 create_task 相同的
  // 冲突预检与幂等创建；部分失败不影响其余条目，逐条结果回传给模型转述。
  const handleBatchCreate = async (input: Record<string, unknown>, context: ToolContext) => {
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
          whenSpoken: formatNextRunAtSpoken(task.nextRunAt, timezone),
          durationMinutes: task.durationMinutes,
          hasAdvanceReminder: (task.preReminders?.length ?? 0) > 0,
          ...advanceReminderKindsOf(task),
        });
        created += 1;
      } catch (e) {
        failed += 1;
        results.push({ index: i, description: itemLabel, ok: false, error: e instanceof Error ? e.message : String(e) });
      }
    }

    // 上传树枝挂点（2026-10-22 树状架构 Phase 1）：批量导入（≥3 条或显式 sourceName）
    // 视为用户上传的课表/行程表 → 事实主张入库（版本链）。此后消息树枝的日程变动
    // 信号 × 本库主张 → 冲突检测 → 主动性板块开口（AssertionConflictWatcher）。
    // 单条/双条创建不是文档导入，不入库。失败不影响批量创建主结果。
    if (assertionStore && created > 0 && (rawItems.length >= 3 || String(input.sourceName ?? "").trim())) {
      try {
        const ingestItems = results
          .filter((r): r is (typeof results)[number] & { ok: true; taskId: string; description: string } => r.ok === true)
          .map((r) => {
            const raw = rawItems[Number(r.index)] ?? {};
            const title = String(raw.title ?? "").trim() || r.description;
            const subject = primarySubjectOf(`${title} ${r.description}`) ?? title.slice(0, 4);
            return {
              subject,
              title,
              runAt: Date.parse(String(raw.runAt ?? "")),
              durationMinutes: normalizeDurationMinutes(raw.durationMinutes),
              taskId: r.taskId,
            };
          })
          .filter((it) => it.subject.length >= 2 && Number.isFinite(it.runAt) && it.runAt > 0);
        if (ingestItems.length > 0) {
          const ingest = assertionStore.ingestDocument(sessionId, String(input.sourceName ?? "批量导入").trim(), ingestItems);
          if (ingest.documentId) {
            (results as Array<Record<string, unknown>>).push({
              assertionDocument: ingest.documentId,
              assertionVersion: ingest.version,
              assertionSuperseded: ingest.superseded,
            });
          }
        }
      } catch {
        /* 主张入库失败不影响日程创建主链路 */
      }
    }

    return {
      ok: failed === 0,
      summary: `批量创建完成：成功 ${created} 条${skipped > 0 ? `，冲突跳过 ${skipped} 条` : ""}${failed > 0 ? `，失败 ${failed} 条` : ""}。请逐条转述（时间照 whenSpoken 的口语说法讲，别念钟点数字），冲突与失败条目如实说明，不要声称全部成功。`,
      created,
      skipped,
      failed,
      results,
    };
  };

  // 2026-11-11 复合：单一入口 `calendar`，按 action 分流到原 6 个 handler。
  registry.register("calendar", async (input, context) => {
    const action = String(input.action ?? "").trim();
    switch (action) {
      case "create": {
        const r = await handleCreate(input, context);
        return { ...r, action: "create" };
      }
      case "batch_create": {
        const r = await handleBatchCreate(input, context);
        return { ...r, action: "batch_create" };
      }
      case "list_tasks": {
        const r = await handleListTasks(input, context);
        return { ...r, action: "list_tasks" };
      }
      case "delete_task": {
        const r = await handleDeleteTask(input, context);
        return { ...r, action: "delete_task" };
      }
      case "update_task": {
        const r = await handleUpdateTask(input, context);
        return { ...r, action: "update_task" };
      }
      case "find_free_slots": {
        const r = await handleFindFreeSlots(input, context);
        return { ...r, action: "find_free_slots" };
      }
      default:
        return {
          ok: false,
          error: `未知 action「${action || "(空)"}」，可选值：create、batch_create、list_tasks、delete_task、update_task、find_free_slots`,
        };
    }
  });
}
