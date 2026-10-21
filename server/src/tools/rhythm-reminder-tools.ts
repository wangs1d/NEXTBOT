// 工具：care.rhythm_reminder —— 节律提醒预设模板（Task 19 健康关怀）
//
// 喝水/睡觉/运动三类预设模板：默认不创建任何提醒，用户对话中明确说
// 「每天提醒我喝水」「到点提醒我睡觉」「开启运动提醒」时由 LLM 调本工具开启。
//
// 到点链路（复用现有服务编排，不新建子系统）：
//   开启 → ScheduleTaskService 每日 reminder 任务（kind=reminder, recurrence=daily）
//   → 到点 tick 触发 → reminderHandler（WS 推送 + Task 18 已接通的 proactivity
//   speak 主动发起）→ 用户收到提醒。
//   关闭 → 按 description 标记 [节律提醒:{preset}] 删除对应日程任务。
//
// 安全性：只操作当前 actor 自己的日程任务（按 sessionId 过滤），删除严格限定
// 在节律标记前缀内，不会误删用户手动创建的提醒。
import type { ScheduleTaskService } from "../services/schedule-task-service.js";
import { RHYTHM_MARK } from "../services/schedule-task-service.js";
import { resolveActorId } from "../agent/actor-id.js";
import type { ToolRegistry } from "./tool-registry.js";
import type { ChatCompletionTool } from "openai/resources/chat/completions";

/** 节律提醒预设模板（时间可被用户覆盖；message 为到点播报文案） */
export const RHYTHM_PRESETS: Record<
  string,
  { label: string; times: string[]; message: string }
> = {
  water: {
    label: "喝水",
    times: ["10:00", "15:00", "20:00"],
    message: "记得喝口水～别忙起来就忘了",
  },
  sleep: {
    label: "睡觉",
    times: ["23:00"],
    message: "夜深了，收拾收拾准备睡吧，明天才有好状态",
  },
  exercise: {
    label: "运动",
    times: ["18:30"],
    message: "到运动时间啦，活动活动筋骨，出出汗",
  },
};

/** 节律任务标记前缀（RHYTHM_MARK 定义并导出自 schedule-task-service；写入 description，disable 时精准匹配删除） */

/**
 * care.rhythm_reminder 的 LLM 工具声明（并入 getBuiltinAgentChatTools）。
 */
export const RHYTHM_REMINDER_CHAT_TOOLS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "care.rhythm_reminder",
      description: [
        "生活习惯节律提醒（每天循环提醒）：喝水提醒、睡觉提醒、运动提醒三类健康习惯预设，按固定时刻每天重复。",
        "何时用：用户要「每天提醒我喝水」「每天多喝水」「到点提醒我睡觉/每天提醒我睡觉」「开启运动提醒」这类无具体日期、每天循环的习惯提醒时，调本工具 action=enable 开启（preset=water/sleep/exercise，times 可自定义时刻数组，如 [\"09:00\",\"14:00\"]）；",
        "何时不用：单次提醒或有明确日期时间的日程用 reminder.plan / calendar.create_from_text。用户说「别提醒我喝水了」「关掉睡觉提醒」时用 action=disable；action=list 查看各预设开关状态。",
      ].join(" "),
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["enable", "disable", "list"],
            description: "操作类型：enable 开启预设、disable 关闭预设、list 查看状态",
          },
          preset: {
            type: "string",
            enum: ["water", "sleep", "exercise"],
            description: "预设：water 喝水 / sleep 睡觉 / exercise 运动；enable/disable 必填",
          },
          times: {
            type: "array",
            items: { type: "string" },
            description:
              "自定义提醒时刻（可选，HH:mm 格式）。如 [\"09:00\",\"13:00\",\"19:00\"]；不传用预设默认时刻",
          },
        },
        required: ["action"],
        additionalProperties: false,
      },
    },
  },
];

/** 校验 HH:mm 时刻格式 */
function isValidTime(t: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(t);
}

/** 计算某时刻下一次触发时间（今天已过则顺延到明天） */
function nextOccurrence(hhmm: string, now = new Date()): Date {
  const [h, m] = hhmm.split(":").map(Number);
  const at = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m, 0, 0);
  if (at.getTime() <= now.getTime()) {
    at.setDate(at.getDate() + 1);
  }
  return at;
}

/**
 * 注册节律提醒预设工具。
 * @param toolRegistry 统一工具注册中心
 * @param scheduleTaskService 日程任务服务（真实到点链路）
 */
export function registerRhythmReminderTools(
  toolRegistry: ToolRegistry,
  scheduleTaskService: ScheduleTaskService,
): void {
  toolRegistry.register(
    "care.rhythm_reminder",
    async (input, context) => {
      const actorId = resolveActorId(context);
      const action = String(input?.action ?? "").trim().toLowerCase();
      const presetKey = String(input?.preset ?? "").trim().toLowerCase();

      try {
        switch (action) {
          case "enable": {
            const preset = RHYTHM_PRESETS[presetKey];
            if (!preset) {
              return { ok: false, error: "preset 必须为 water / sleep / exercise" };
            }
            const times = Array.isArray(input?.times)
              ? input.times.map((t) => String(t).trim()).filter(Boolean)
              : preset.times;
            if (times.length === 0 || times.some((t) => !isValidTime(t))) {
              return { ok: false, error: "times 需为 HH:mm 格式时刻数组（如 [\"09:00\",\"14:00\"]）" };
            }

            // 先清掉同预设旧任务（幂等：重复开启不叠加）
            await deleteRhythmTasks(scheduleTaskService, actorId, presetKey);

            const created: Array<{ time: string; taskId: string }> = [];
            for (const time of times) {
              const message = times.length > 1 ? `${preset.message}（${time}）` : preset.message;
              const task = await scheduleTaskService.createTask({
                sessionId: actorId,
                title: `${preset.label}提醒`,
                shortTitle: `${preset.label}提醒 ${time}`,
                description: `${RHYTHM_MARK}${presetKey}] ${preset.label}提醒 ${time}`,
                kind: "reminder",
                // 节律提醒只做后台到点推送，不进「今日安排」紧凑列表
                category: "trivia",
                runAt: nextOccurrence(time).toISOString(),
                recurrence: "daily",
                timezone: "Asia/Shanghai",
                reminderMessage: message,
              });
              created.push({ time, taskId: task.taskId });
            }
            return {
              ok: true,
              preset: presetKey,
              label: preset.label,
              times: created.map((c) => c.time),
              taskIds: created.map((c) => c.taskId),
              message: `已开启${preset.label}提醒：每天 ${times.join("、")} 到点提醒你`,
            };
          }
          case "disable": {
            const preset = RHYTHM_PRESETS[presetKey];
            if (!preset) {
              return { ok: false, error: "preset 必须为 water / sleep / exercise" };
            }
            const removed = await deleteRhythmTasks(scheduleTaskService, actorId, presetKey);
            return {
              ok: true,
              preset: presetKey,
              label: preset.label,
              removed,
              message:
                removed > 0
                  ? `已关闭${preset.label}提醒（删除 ${removed} 个定时任务）`
                  : `${preset.label}提醒本来就没开`,
            };
          }
          case "list": {
            const tasks = scheduleTaskService.listTasksBySession(actorId);
            const statuses = Object.entries(RHYTHM_PRESETS).map(([key, preset]) => {
              const marks = tasks.filter((t) => t.description.startsWith(`${RHYTHM_MARK}${key}]`));
              return {
                preset: key,
                label: preset.label,
                enabled: marks.length > 0,
                times: marks.map((t) => t.shortTitle ?? t.title ?? "").join("、"),
                defaultTimes: preset.times,
              };
            });
            return { ok: true, presets: statuses };
          }
          default:
            return {
              ok: false,
              error: `未知 action「${action || "(空)"}」。可选：enable（开启）/ disable（关闭）/ list（查看）。`,
            };
        }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
    {
      category: "life",
      sideEffect: "write",
      riskLevel: "low",
    },
  );
}

/** 删除某 actor 某预设的全部节律任务（按 description 标记精准匹配），返回删除数 */
async function deleteRhythmTasks(
  scheduleTaskService: ScheduleTaskService,
  actorId: string,
  presetKey: string,
): Promise<number> {
  const tasks = scheduleTaskService
    .listTasksBySession(actorId)
    .filter((t) => t.description.startsWith(`${RHYTHM_MARK}${presetKey}]`));
  for (const t of tasks) {
    await scheduleTaskService.deleteTask(t.taskId);
  }
  return tasks.length;
}
