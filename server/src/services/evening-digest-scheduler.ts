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
 * 一次；2026-11-05 加补发兜底——过点 30 分钟内（服务器短暂离线/重启错过
 * 触发分钟）照常发，超窗不补（当晚彻底没开机就当天丢失，远端部署后不存在）。
 * lastSentDay 落盘 <dataDir>/evening-digest-sent.json（at-most-once：先标记
 * 再发送，重启后同一天绝不重发），内存 Map 只做热路径缓存。
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getDataDir } from "../config/data-dir.js";
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
/** 过点补发窗口：错过触发分钟后 30 分钟内仍补发，超窗视为当天放弃 */
const CATCHUP_WINDOW_MIN = 30;
/** lastSentDay 落盘文件（sessionId → YYYY-MM-DD），跨重启防同一天重发 */
const SENT_DAY_FILE = "evening-digest-sent.json";

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

export class EveningDigestScheduler {
  private timer: NodeJS.Timeout | null = null;
  private readonly subscribedSessions = new Set<string>();
  /** 当日已发标记：sessionId → 日期（YYYY-MM-DD），保证一天只发一次（内存缓存） */
  private readonly lastSentDay = new Map<string, string>();
  /** 落盘懒加载标记：首次读/写时从磁盘回灌，重启后同一天不重发 */
  private sentDayLoaded = false;
  /**
   * 最近一次生成的 digest（sessionId → 载荷，仅当日有效）。
   *
   * 用途（2026-11-05 接生产投递）：用户白天主动问「明天什么安排」时，聊天出口
   * 直接拿这份数据喂渲染场景（tomorrow_preview），不必再跑一次天气/日程查询，
   * 也不会因为生成慢把回复卡住。跨日自动失效——预览永远指向「明天」。
   */
  private readonly lastDigests = new Map<string, EveningDigest>();

  constructor(private readonly deps: SchedulerDeps) {}

  /**
   * 测试进程（npm run test*）禁用落盘：与 data-dir 的 isTestProcess 同口径，
   * 否则同日多次跑测试会被磁盘标记互相污染（用例断言「未发」直接翻车）。
   */
  private get persistenceEnabled(): boolean {
    return !/^test/.test(process.env.npm_lifecycle_event ?? "");
  }

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
    const today = this.todayOf(now);

    for (const sessionId of this.subscribedSessions) {
      // 一天只发一次；到点那一分钟发，过点 30 分钟内补发，超窗不补
      if (this.sentDayOf(sessionId) === today) continue;
      const missed = nowMinutes - this.triggerMinutesOf(sessionId);
      if (!(missed === 0 || (missed > 0 && missed <= CATCHUP_WINDOW_MIN))) continue;
      // at-most-once：先落盘标记再发送——中途崩溃/重启同一天也绝不重发；
      // 发送侧离线由 onDigestTriggered 的 proactive 管道 must 层兜底必达
      this.markSentDay(sessionId, today);
      try {
        console.log(
          `[EveningDigest] 到点推送 sessionId=${sessionId}${missed > 0 ? `（过点 ${missed} 分钟补发）` : ""}`,
        );
        const digest = await this.deps.digestService.generateDigest(sessionId);
        this.rememberDigest(sessionId, digest);
        await this.deps.onDigestTriggered(sessionId, digest);
      } catch (err) {
        // 单个 session 失败忽略，不阻断其他 session；当日不再重试。
        // 但必须留痕（2026-11-06）：静默吞掉曾让「标记已写、卡没送达」无迹可循
        console.log(`[EveningDigest] 推送失败 sessionId=${sessionId}: ${err}`);
      }
    }
  }

  /** 当日日期（YYYY-MM-DD，服务器本地时区） */
  private todayOf(now = new Date()): string {
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  }

  /**
   * 记下最近一次生成的 digest（供聊天出口消费）。
   * 只保留内存，不落盘：这是当日态数据，重启后由下一次生成/reconnect 补。
   */
  rememberDigest(sessionId: string, digest: EveningDigest): void {
    this.lastDigests.set(sessionId, digest);
  }

  /** 取当日最近一次 digest；跨日（date ≠ 今天）视为无——预览必须指向「明天」 */
  latestDigest(sessionId: string): EveningDigest | undefined {
    const digest = this.lastDigests.get(sessionId);
    if (!digest) return undefined;
    if (digest.date !== this.todayOf()) {
      this.lastDigests.delete(sessionId);
      return undefined;
    }
    return digest;
  }

  /** 已发标记读取：首次访问从落盘回灌（重启后同一天不重发的关键） */
  private sentDayOf(sessionId: string): string | undefined {
    if (!this.sentDayLoaded) {
      this.sentDayLoaded = true;
      if (this.persistenceEnabled) {
        try {
          const raw = JSON.parse(
            readFileSync(join(getDataDir(), SENT_DAY_FILE), "utf8"),
          ) as Record<string, string>;
          for (const [sid, day] of Object.entries(raw)) this.lastSentDay.set(sid, day);
        } catch {
          /* 首次运行/文件缺失/损坏：从空表开始 */
        }
      }
    }
    return this.lastSentDay.get(sessionId);
  }

  /** 已发标记写入：内存 + 落盘同步双写（文件极小，同步写无压力） */
  private writeSentDay(sessionId: string, day: string): void {
    void this.sentDayOf(sessionId); // 确保落盘状态先回灌，避免覆盖丢失其他 session 的标记
    this.lastSentDay.set(sessionId, day);
    if (!this.persistenceEnabled) return;
    try {
      writeFileSync(
        join(getDataDir(), SENT_DAY_FILE),
        JSON.stringify(Object.fromEntries(this.lastSentDay), null, 2),
      );
    } catch {
      /* 磁盘异常：内存标记仍在，最多进程重启后同天重发一次，可接受 */
    }
  }

  /**
   * 指定日期占用推送额度（公开给跨零点补发路径使用）。
   *
   * 缺陷背景（2026-11-05 实证，2026-11-06 修复）：凌晨（<6 点）手动补推
   * 「昨晚的卡」时，markSentToday 落的是**新日历日**——当晚的到点推送被
   * 这份标记吞掉，用户一整晚什么都收不到。凌晨补推替代的是「昨晚」的
   * 推送，额度应落到昨天；今天晚上的推送预览的是「明天」，内容不同，
   * 不该被抑制。
   */
  markSentDay(sessionId: string, day: string): void {
    this.writeSentDay(sessionId, day);
  }

  /**
   * 手动触发路径占用当日推送额度（2026-11-05）：/api/test/trigger-evening-digest
   * 带 markSent=true 时调用——补发即正式送达，当天到点不再重复推。
   */
  markSentToday(sessionId: string): void {
    this.writeSentDay(sessionId, this.todayOf());
  }
}
