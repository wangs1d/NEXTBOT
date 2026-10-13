// ProactivityHub —— 过劳关怀干预触发器
//
// body.rhythm.overwork_detected（连续工作 ≥阈值 或 深夜活跃 ≥阈值）触发：
//  mode=act+speak 复合干预——
//   act：搜并播放轻音乐 + 排下一个晚间休息提醒（静默后台执行）
//   speak：发布 overwork_care 信号告知用户做了什么（现有 ProactionCortex 闭环生成话术）
//
// 2026-10-12 修订（实盘反馈：检测文案失实 + 休息提醒时间排错）：
//  1. 按 payload.reason 分叉——深夜活跃触发不再伪造「连续工作 N 小时」叙事，
//     summary 如实说「深夜活跃 N 次」；连续工作触发才说工作时长。
//  2. 休息提醒时刻纯作息驱动，零硬编码默认值：
//     - 目标时刻 = 习惯就寝前 1h（rhythm 学习基线，clamp 20:00-次日 01:00 仅作安全轨）
//     - 「下一个未过的晚间时刻」：今天未到排今晚、已过排明天
//       （凌晨触发时旧逻辑 setDate(+1) 会把「今晚休息」排到 42 小时后）
//     - 作息基线未学会（<2 个有效夜晚）→ 这次不排提醒、不猜时间
//  3. description / summary 的「今晚/明晚」按 runAt 实际日期动态生成，不再写死。
import type { ProactiveActStep, ProactiveIntent } from "../proactivity-types.js";

/** body.rhythm.overwork_detected 信号的 payload 形态（rhythm-core 发布） */
export type OverworkRhythmPayload = {
  /** 连续工作小时数（0 表示未达连续阈值，靠深夜计数触发） */
  continuousWorkHours?: number;
  /** 当日深夜活跃次数（去抖后） */
  lateNightActiveCount?: number;
  /** 触发原因（rhythm-core 发布；旧信号缺省时下游按工作时长推导） */
  reason?: "continuous_work" | "late_night_active";
  /** 学习到的习惯就寝时刻（小时小数，可 >24 表示次日凌晨；样本不足为 null） */
  learnedBedtimeHour?: number | null;
  detectedAt?: string;
};

/** 休息提醒目标时刻的约束区间（小时）：20:00 ~ 次日 01:00 */
const REST_TARGET_HOUR_RANGE: [number, number] = [20, 25];

/**
 * 计算下一个「未过」的指定时刻（本地时间）。
 * 目标时刻今天还没到 → 排今天；已过（含凌晨触发场景）→ 排明天。
 * 输出带本地时区偏移的 ISO（与 ScheduleTaskService 的解析约定一致）。
 */
export function nextEveningRunAt(now: Date = new Date(), targetHour = 20): string {
  const hour = Math.floor(targetHour);
  const minute = Math.round((targetHour - hour) * 60);
  // targetHour ≥ 24（次日零点后）：显式折算到 +1 天，setHours(24) 会溢出语义不明
  const dayShift = Math.floor(hour / 24);
  const d = new Date(now);
  d.setDate(d.getDate() + dayShift);
  d.setHours(hour % 24, minute, 0, 0);
  if (d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1);
  const offsetMin = -d.getTimezoneOffset();
  const sign = offsetMin >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMin);
  const hh = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}T${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}${sign}${hh}:${mm}`;
}

/** 习惯就寝时刻 → 休息提醒目标时刻：就寝前 1h，clamp 到晚间区间。
 *  直接减 1（不折算 >24）：就寝 25.5（凌晨 1:30）→ 提醒 24.5（00:30），语义一致。
 *  无基线（null）→ 返回 null：作息还没学会，不猜时间、不排提醒（纯作息驱动）。 */
export function restTargetHourFromBedtime(bedtimeHour: number | null | undefined): number | null {
  if (bedtimeHour === null || bedtimeHour === undefined || !Number.isFinite(bedtimeHour)) {
    return null;
  }
  return clamp(bedtimeHour - 1, REST_TARGET_HOUR_RANGE[0], REST_TARGET_HOUR_RANGE[1]);
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

/** runAt 与 now 的日期差 → 「今晚/明晚」（跨天恰好 1 天；异常时回退「稍后」） */
function eveningLabel(runAtIso: string, now: Date): string {
  const runDay = Number(runAtIso.slice(8, 10));
  const todayDay = now.getDate();
  if (runDay === todayDay) return "今晚";
  if (runDay === todayDay + 1 || (todayDay > 20 && runDay <= 5)) return "明晚";
  return "稍后";
}

/** 过劳干预意图：act（放音乐 + 排休息日程）+ speak 告知 */
export function buildOverworkIntent(
  actorId: string,
  payload: OverworkRhythmPayload | undefined,
  now: Date = new Date(),
): ProactiveIntent {
  const workHours = payload?.continuousWorkHours ?? 0;
  const lateNights = payload?.lateNightActiveCount ?? 0;
  const reason: "continuous_work" | "late_night_active" =
    payload?.reason ?? (workHours >= 3 ? "continuous_work" : "late_night_active");

  // 提醒时刻完全由学习的作息决定：就寝前 1h、取下一个未过的该时刻。
  // 作息还没学会（null）→ 不排提醒、不猜时间；学会后随 14 天滚动窗口动态跟随。
  const targetHour = restTargetHourFromBedtime(payload?.learnedBedtimeHour);
  const runAt = targetHour !== null ? nextEveningRunAt(now, targetHour) : null;
  const when = runAt ? eveningLabel(runAt, now) : null;

  const steps: ProactiveActStep[] = [
    {
      tool: "media.search",
      args: { query: "轻音乐 放松", limit: 3 },
    },
    {
      // 从第 0 步（media.search）结果取第一条播放
      tool: "media.play",
      args: {},
      fromStep: 0,
    },
  ];
  if (runAt) {
    const calendarDescription =
      reason === "late_night_active"
        ? `Agent 检测到深夜活跃，主动安排的休息提醒：按你的作息在就寝前提醒，${when}这个点放下屏幕，放松一下。`
        : `Agent 检测到连续工作较久，主动安排的休息提醒：按你的作息在就寝前提醒，${when}这个点早点收工，放松一下。`;
    steps.push({
      tool: "calendar.create_task",
      args: {
        kind: "reminder",
        title: "休息提醒",
        shortTitle: "该休息啦",
        description: calendarDescription,
        runAt,
      },
    });
  }

  const careLine =
    reason === "late_night_active"
      ? `深夜活跃 ${lateNights} 次。`
      : `连续工作了约 ${workHours} 小时。`;
  const actLine = runAt
    ? `Agent 已放了一首轻音乐、并按你的作息给${when}排了休息提醒。`
    : `Agent 已放了一首轻音乐。（作息基线还没学会，这次没猜时间排提醒）`;
  const summary =
    `${careLine}${actLine}基于此简短告知用户：像朋友一样心疼一句，顺便说你放了歌${runAt ? "/排了提醒" : ""}，别说教。`;

  return {
    actorId,
    kind: "overwork_care",
    importance: "high",
    title: "用户连续加班/深夜活跃，主动关怀干预",
    summary,
    mode: "act",
    actArgs: steps,
    source: "rhythm",
    // 直达车道模板数据（零 LLM 话术）：按 reason 传真实上下文，模板不再编数字
    templateData:
      reason === "late_night_active"
        ? { reason, count: lateNights }
        : { reason, hours: Math.round(workHours * 10) / 10 },
  };
}
