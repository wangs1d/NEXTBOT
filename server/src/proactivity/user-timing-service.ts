/**
 * 用户时刻统一取用口（2026-10-16 用户拍板：「很多地方都是需要根据对用户的
 * 了解去动态设置时间的，不止是这一块，所以需要把这个接口统一」；归主动性
 * 模块 proactivity/——时刻取用的消费方都是主动性/定时场景）。
 *
 * 此前的散点：晚报调度器直连 RhythmCore.learnedBedtimeHour、夜间固化任务
 * 直连 AwarenessCortex.getLearnedSleepWindow、过劳干预经 body 信号 payload
 * 捎带 learnedBedtimeHour……各源数据同根（在线活跃 / 会话睡眠样本 / 在场
 * 足迹），但门槛与新鲜度不同。本服务把源注册进来，对外只暴露统一口径：
 *   - bedtimeHour / wakeHour：就寝/起床单点时刻（多源按注册序取第一个非 null）
 *   - sleepWindow：入睡-醒来窗口（夜间模式判定等窗口语义场景）
 *   - preBedtimeMinutes / postWakeMinutes：就寝前/起床后换算（lead/offset
 *     + 钳位 + 回退），供各类「到点推送」调度器直接消费
 *
 * 源注册序 = 数据质量优先级（装配层按此序注册）：
 *   1. RhythmCore（body 在线活跃学习：2 夜起学、滚动 14 夜、实时更新）
 *   2. PresenceFootprintStore（逐日在场直方图：3 有效夜起产出）
 *   3. AwarenessCortex 睡眠窗口（会话入睡/醒来样本中位数）
 *
 * 边界（重要）：
 *   - 用户显式配置（如晨报 prefs.time）不是学习源——显式选择永远优先于
 *     学习值，由各消费点自行保证「配置 > 学习 > 默认」；
 *   - env 级运维覆盖（如 EVENING_DIGEST_HOUR）同理在调度器内先行短路；
 *   - 本服务只回答「学到的用户时刻是什么」，不做业务决策；
 *   - 消费节律画像对象做决策的场景（如 reminder-rescheduler 按画像更新
 *     重排日程）不属于取数，仍走事件驱动。
 */

export interface UserTimingSource {
  /** 源名（诊断日志用） */
  readonly name: string;
  /** 习惯就寝时刻（小时小数，可 >24 表示次日凌晨；未学出为 null） */
  bedtimeHour?(actorId: string): number | null;
  /** 习惯起床时刻（小时小数；未学出为 null） */
  wakeHour?(actorId: string): number | null;
  /** 入睡-醒来窗口（夜间模式判定等窗口语义场景；未学出为 null） */
  sleepWindow?(actorId: string): UserTimingSleepWindow | null;
}

export interface UserTimingSleepWindow {
  /** 入睡时刻（小时小数，可 >24） */
  startHour: number;
  /** 醒来时刻（小时小数） */
  endHour: number;
  /** 参与学习的样本夜数 */
  sampleCount: number;
}

export interface PreBedtimeOptions {
  /** 提前量（分钟），默认 30——睡前提醒别顶到用户脸上 */
  leadMinutes?: number;
  /** 结果钳位（当日分钟数），默认 [20:00, 23:30]——晚间提醒的合理区间 */
  clampMinutes?: [number, number];
  /** 全源未学出时的回退时刻；不传则返回 null（由调用方定默认） */
  fallbackMinutes?: number;
}

export interface PostWakeOptions {
  /** 起床后偏移（分钟），默认 30 */
  offsetMinutes?: number;
  /** 结果钳位（当日分钟数），默认 [06:00, 11:00]——晨间提醒的合理区间 */
  clampMinutes?: [number, number];
  /** 全源未学出时的回退时刻；不传则返回 null */
  fallbackMinutes?: number;
}

/** 全天分钟数（跨零点折回用） */
const MINUTES_PER_DAY = 24 * 60;

function clampMinutes(n: number, [lo, hi]: [number, number]): number {
  return Math.min(hi, Math.max(lo, n));
}

/**
 * 负值折回当日（如凌晨 0:15 就寝 − 30min lead = −15 → 23:45）。
 * 正值超上限不折回：交给钳位吸收——「凌晨 1:30 就寝」的睡前提醒应钳到
 * 当晚钳位上限（23:30），而不是折回后误落清晨；避免「永不触发」的调度坑
 * 由钳位区间与调度器「分钟 ≥ 时刻」判据共同保证。
 */
function foldNegativeIntoDay(minutes: number): number {
  const rounded = Math.round(minutes);
  return rounded < 0 ? rounded + MINUTES_PER_DAY : rounded;
}

export class UserTimingService {
  private readonly sources: UserTimingSource[] = [];

  /** 注册源：按数据质量优先级顺序注册，先注册者先胜出 */
  registerSource(source: UserTimingSource): void {
    this.sources.push(source);
  }

  /** 已注册源数（诊断用） */
  get sourceCount(): number {
    return this.sources.length;
  }

  /** 按注册序取第一个非 null 值；单源抛错视为未学出，继续下一源 */
  private firstNonNull<T>(pick: (source: UserTimingSource) => T | null | undefined): T | null {
    for (const source of this.sources) {
      try {
        const v = pick(source);
        if (v !== null && v !== undefined) return v;
      } catch {
        /* 单源失败不阻断下一源 */
      }
    }
    return null;
  }

  /** 学到的习惯就寝时刻（小时小数，可 >24；多源按注册序取第一个非 null） */
  bedtimeHour(actorId: string): number | null {
    return this.firstNonNull((s) => {
      const h = s.bedtimeHour?.(actorId);
      return h !== null && h !== undefined && Number.isFinite(h) ? h : null;
    });
  }

  /** 学到的习惯起床时刻（小时小数；多源按注册序取第一个非 null） */
  wakeHour(actorId: string): number | null {
    return this.firstNonNull((s) => {
      const h = s.wakeHour?.(actorId);
      return h !== null && h !== undefined && Number.isFinite(h) ? h : null;
    });
  }

  /** 学到的入睡-醒来窗口（多源按注册序取第一个非 null） */
  sleepWindow(actorId: string): UserTimingSleepWindow | null {
    return this.firstNonNull((s) => s.sleepWindow?.(actorId) ?? null);
  }

  /**
   * 就寝前 lead 分钟的提醒时刻（当日分钟数 0-1439）。
   * 就寝跨零点（如 25.5 = 凌晨 1:30）正值超上限交给钳位吸收——提醒落在
   * 钳位区间内当晚必可触发，不会出现「目标时刻已过 24h 导致永不推送」。
   */
  preBedtimeMinutes(actorId: string, opts: PreBedtimeOptions = {}): number | null {
    const bedtime = this.bedtimeHour(actorId);
    if (bedtime === null) {
      return opts.fallbackMinutes === undefined ? null : opts.fallbackMinutes;
    }
    const lead = opts.leadMinutes ?? 30;
    const range = opts.clampMinutes ?? [20 * 60, 23 * 60 + 30];
    return clampMinutes(foldNegativeIntoDay(bedtime * 60 - lead), range);
  }

  /** 起床后 offset 分钟的提醒时刻（当日分钟数 0-1439） */
  postWakeMinutes(actorId: string, opts: PostWakeOptions = {}): number | null {
    const wake = this.wakeHour(actorId);
    if (wake === null) {
      return opts.fallbackMinutes === undefined ? null : opts.fallbackMinutes;
    }
    const offset = opts.offsetMinutes ?? 30;
    const range = opts.clampMinutes ?? [6 * 60, 11 * 60];
    return clampMinutes(foldNegativeIntoDay(wake * 60 + offset), range);
  }
}
