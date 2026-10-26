/**
 * 晚间 digest 调度器（Task 15 场景A 生活节律）。
 *
 * 调度模式参考 MorningBriefingScheduler：每分钟 tick，对已订阅 session
 * 到点触发一次晚间 digest。
 *
 * 推送时刻（2026-10-16 动态学习定调，用户拍板）：不再固定 21 点整，按优先级：
 *   1. env EVENING_DIGEST_HOUR 显式设置 → 锁死该整点（运维覆盖口径，
 *      可用 EVENING_DIGEST_MINUTE 细调分钟，默认 0）
 *   2. 节律学习（bedtimeHourOf，装配层接 Task 20 RhythmCore.learnedBedtimeHour）
 *      → 习惯就寝前 30 分钟，钳位 [20:00, 23:30]
 *   3. 都没有（样本不足/未接节律）→ 默认 21:00
 *
 * 发送规则（2026-10-27 用户拍板，简单口径）：到点那一分钟发一次，一天只发
 * 一次，过点不补发。lastSentDay 只做同一分钟内双 tick 的护栏（interval 漂移
 * 时同一分钟可能跑两个 tick），不落盘——服务重启不在推送分钟内就什么都不发。
 */

import type { EveningDigest, EveningDigestService } from "./evening-digest-service.js";

type SchedulerDeps = {
  digestService: EveningDigestService;
  onDigestTriggered: (sessionId: string, digest: EveningDigest) => void | Promise<void>;
  /**
   * 习惯就寝时刻取用口（小时小数，可 >24 表示次日凌晨；样本不足为 null）。
   * 装配层接 RhythmCore.learnedBedtimeHour（当日最后活跃样本中位数，
   * 凌晨 0-5 点折算前一晚；有效就寝样本门槛 2 夜）。
   */
  bedtimeHourOf?: (sessionId: string) => number | null;
};

/** 动态推送时刻钳位：不早于 20:00、不晚于 23:30（再晚的睡前提醒没有意义） */
const LEARNED_TRIGGER_RANGE_MIN: [number, number] = [20 * 60, 23 * 60 + 30];
/** 提前量：就寝前 30 分钟推送，别顶到用户脸上 */
const BEDTIME_LEAD_MINUTES = 30;
/** 学习缺位（样本不足/未接节律）时的默认推送时刻 21:00 */
const DEFAULT_TRIGGER_MINUTES = 21 * 60;

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

export class EveningDigestScheduler {
  private timer: NodeJS.Timeout | null = null;
  private readonly subscribedSessions = new Set<string>();
  /** 当日已发标记：sessionId → 日期（YYYY-MM-DD），保证一天只发一次 */
  private readonly lastSentDay = new Map<string, string>();

  constructor(private readonly deps: SchedulerDeps) {}

  /**
   * 某 session 的推送时刻（当日分钟数 0-1439）：env 锁死 > 就寝前 30 分钟
   * （钳位晚间区间）> 默认 21:00。bedtimeHourOf 是同步内存中位数
   * （RhythmCore），每 tick 直算不缓存，节律画像更新当晚即生效。
   */
  private triggerMinutesOf(sessionId: string): number {
    const envHour = Number(process.env.EVENING_DIGEST_HOUR);
    if (Number.isFinite(envHour) && envHour >= 0 && envHour <= 23) {
      const envMinute = Number(process.env.EVENING_DIGEST_MINUTE);
      const minute =
        Number.isFinite(envMinute) && envMinute >= 0 && envMinute <= 59 ? envMinute : 0;
      return envHour * 60 + minute;
    }
    const bedtimeHour = this.deps.bedtimeHourOf?.(sessionId) ?? null;
    if (bedtimeHour !== null && Number.isFinite(bedtimeHour)) {
      return clamp(
        Math.round(bedtimeHour * 60) - BEDTIME_LEAD_MINUTES,
        LEARNED_TRIGGER_RANGE_MIN[0],
        LEARNED_TRIGGER_RANGE_MIN[1],
      );
    }
    return DEFAULT_TRIGGER_MINUTES;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(
      () => this.tick().catch(() => {}),
      60_000,
    );
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  subscribe(sessionId: string): void {
    this.subscribedSessions.add(sessionId);
  }

  unsubscribe(sessionId: string): void {
    this.subscribedSessions.delete(sessionId);
  }

  private async tick(): Promise<void> {
    const now = new Date();
    const nowMinutes = now.getHours() * 60 + now.getMinutes();
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;

    for (const sessionId of this.subscribedSessions) {
      // 一天只发一次；到点那一分钟才发，过点不补发
      if (this.lastSentDay.get(sessionId) === today) continue;
      if (nowMinutes !== this.triggerMinutesOf(sessionId)) continue;
      this.lastSentDay.set(sessionId, today);
      try {
        const digest = await this.deps.digestService.generateDigest(sessionId);
        await this.deps.onDigestTriggered(sessionId, digest);
      } catch {
        // 单个 session 失败忽略，不阻断其他 session；当日不再重试
      }
    }
  }
}
