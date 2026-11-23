// 在场判定：多端连接引用计数 + 最近活跃 → active / idle / offline
// 电脑端 + 手机端互通：任一设备在线即算在线（fan-out 由 WsConnectionRegistry 承担），
// 全部设备掉线才算 offline。
//
// 手机状态（2026-11-23 M1）：前台服务让手机 WS 常连，「连着」不等于「人在」。
// 手机经主连接上报 client.presence_state（亮灭屏/解锁/通话/勿扰/充电），这里做三件事：
//   1. 解锁中（interactive）视为一次用户活动 → 刷新 lastActivity（active/idle 判定沿用原逻辑）；
//   2. 通话中 / 系统勿扰 → phoneQuietReason 给管道一个「此刻别打扰」的理由，
//      非必达提案延后重判（见 ProactivePipeline.applyPhoneQuiet）；
//   3. phoneGrade 把「手机此刻的状态」折成打断成本（需求文档 §3.7 成本表），
//      供 arbiter-v2 与 reach-decision 用——修掉 R1「只用手机的用户，锁屏揣兜里
//      也被桌面的 idle=0 当成最佳时机」。
// 状态超过 PHONE_STATE_TTL_MS 未刷新视为过期（App 被杀/断连后不让旧状态一直挡消息）。
import type { PresenceState } from "./pipeline-types.js";
import { PHONE_GRADE_COST, type PhoneGrade } from "./phone-presence.js";

/** 手机最近一次上报的状态（只存最新一份，不落盘：重启后等手机重连再报） */
export type PhoneState = {
  /** 解锁且在用（用户正拿着手机） */
  interactive: boolean;
  screenOn: boolean;
  inCall: boolean;
  /** 系统勿扰模式开启 */
  dnd: boolean;
  charging: boolean;
  /** 上报时刻 ms */
  at: number;
  /** 本次锁屏起点 ms（screenOn 由 true→false 时记下；亮屏即清空） */
  lockedSince: number | null;
  /** 最近一次「解锁在用」时刻 ms */
  lastInteractiveAt: number | null;
};

/** 一条主动消息该在哪个端弹系统横幅（null = 不指定，各端按原逻辑自决） */
export type BannerSurface = "mobile" | "desktop";

export type PresenceServiceDeps = {
  /**
   * 该账号当前在线的设备类别（装配层注入 WsConnectionRegistry）。
   * 未注入 = 不区分端（单端语义，分级只走手机信号）。
   */
  onlineDeviceClasses?: (actorId: string) => string[];
  /**
   * 最近 10 分钟内有**真人业务活动**的那一端（装配层注入
   * `registry.mostRecentActiveDeviceClass`；手机心跳不算，见 ws/connection.ts 的
   * client.presence_state 分支）。null/未注入 = 不知道人在哪一端。
   */
  attendedDeviceClass?: (actorId: string) => string | null;
};

/**
 * 本地日期键（YYYY-MM-DD）：不能用 toISOString 的 UTC 日期——UTC+8 的早上 8 点前
 * UTC 还是「昨天」，按 UTC 切「当天首次解锁」会把今天算成昨天。
 */
function localDayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export class PresenceService {
  /** 超过该时长无交互视为 idle */
  static readonly IDLE_AFTER_MS = 10 * 60 * 1000;
  /** 手机状态有效期：客户端每次状态变化即报 + 前台服务每 10 分钟心跳一次，30 分钟没刷新即作废 */
  static readonly PHONE_STATE_TTL_MS = 30 * 60 * 1000;
  /** 「解锁中、最近 2min 有交互」= phone_active（需求文档 §3.7 表格原口径） */
  static readonly PHONE_ACTIVE_WINDOW_MS = 2 * 60 * 1000;
  /** 锁屏 < 15min = phone_recent */
  static readonly PHONE_RECENT_WINDOW_MS = 15 * 60 * 1000;
  /** 夜间 + 充电 + 锁屏 ≥ 30min = sleeping */
  static readonly SLEEP_LOCKED_MIN_MS = 30 * 60 * 1000;

  /** actorId → 在线设备数（引用计数：任一设备在线即在线） */
  private readonly deviceCount = new Map<string, number>();

  /** actorId → 最近活跃时刻（任一设备的交互都刷新） */
  private readonly lastActivity = new Map<string, number>();

  /** actorId → 手机最近状态 */
  private readonly phone = new Map<string, PhoneState>();
  /** 当天首次解锁（actorId → 本地日期 + 时刻）：§3.4 早安槽的触发条件 */
  private readonly firstUnlockOfDay = new Map<string, { date: string; at: number }>();

  constructor(private readonly deps: PresenceServiceDeps = {}) {}

  markConnected(actorId: string, at = Date.now()): void {
    this.deviceCount.set(actorId, (this.deviceCount.get(actorId) ?? 0) + 1);
    this.lastActivity.set(actorId, at);
  }

  markDisconnected(actorId: string): void {
    const n = this.deviceCount.get(actorId) ?? 0;
    if (n <= 1) this.deviceCount.delete(actorId);
    else this.deviceCount.set(actorId, n - 1);
  }

  noteActivity(actorId: string, at = Date.now()): void {
    if (this.deviceCount.has(actorId)) this.lastActivity.set(actorId, at);
  }

  /** 记录手机上报的状态；解锁在用顺带算一次活动 */
  notePhoneState(actorId: string, s: Omit<PhoneState, "at" | "lockedSince" | "lastInteractiveAt">, at = Date.now()): void {
    if (!actorId) return;
    const prev = this.phone.get(actorId);
    this.phone.set(actorId, {
      ...s,
      at,
      // 只在「亮屏 → 灭屏」的跃迁上记起点；持续灭屏期间的心跳不把起点推到当下
      lockedSince: s.screenOn ? null : (prev && !prev.screenOn ? prev.lockedSince : at),
      lastInteractiveAt: s.interactive ? at : (prev?.lastInteractiveAt ?? null),
    });
    if (s.interactive) {
      this.noteActivity(actorId, at);
      // 当天首次解锁（§3.4 早安的触发条件）：只在第一次落，后续解锁不刷新
      const key = localDayKey(at);
      const hit = this.firstUnlockOfDay.get(actorId);
      if (!hit || hit.date !== key) this.firstUnlockOfDay.set(actorId, { date: key, at });
    }
  }

  /**
   * 当天首次解锁时刻（ms）；今天还没解锁 / 从来没有过手机状态 → null。
   * 只活在内存里：重启后等手机重连再报，早安最坏是晚一点播，不会重复播
   * （当日去重在 prefs.morningBriefing.deliveredAt 那一侧）。
   */
  firstUnlockToday(actorId: string, now = Date.now()): number | null {
    const hit = this.firstUnlockOfDay.get(actorId);
    return hit && hit.date === localDayKey(now) ? hit.at : null;
  }

  /** 此刻是否拿得到这个用户的手机状态（过期/从未上报 = false，早安因此不拦） */
  hasPhoneSignal(actorId: string, now = Date.now()): boolean {
    return this.phoneState(actorId, now) !== null;
  }

  /** 未过期的手机状态（过期/从未上报返回 null） */
  phoneState(actorId: string, now = Date.now()): PhoneState | null {
    const s = this.phone.get(actorId);
    if (!s) return null;
    if (now - s.at > PresenceService.PHONE_STATE_TTL_MS) {
      this.phone.delete(actorId);
      return null;
    }
    return s;
  }

  /**
   * 手机时机分级（§3.7）：把原始状态收敛成一个可比较的档位。
   * 优先级从严到宽：通话 > 勿扰 > 睡眠 > 在用 > 刚锁屏 > 锁屏中。
   * 从未上报/状态过期 → null（手机侧没有任何可信信号，不参与判断）。
   */
  phoneGrade(actorId: string, now = Date.now()): { grade: PhoneGrade; cost: number } | null {
    const s = this.phoneState(actorId, now);
    if (!s) return null;
    const hour = new Date(now).getHours();
    const lockedMin = s.lockedSince === null ? 0 : now - s.lockedSince;
    const recentlyInteractive =
      s.interactive ||
      (s.lastInteractiveAt !== null && now - s.lastInteractiveAt <= PresenceService.PHONE_ACTIVE_WINDOW_MS);
    const grade: PhoneGrade = s.inCall
      ? "in_call"
      : s.dnd
        ? "dnd"
        : isNightHour(hour) && s.charging && lockedMin >= PresenceService.SLEEP_LOCKED_MIN_MS
          ? "sleeping"
          : recentlyInteractive
            ? "phone_active"
            : lockedMin < PresenceService.PHONE_RECENT_WINDOW_MS
              ? "phone_recent"
              : "phone_away";
    return { grade, cost: PHONE_GRADE_COST[grade] };
  }

  /** 手机此刻不宜打扰的理由（通话中优先于勿扰）；没有理由返回 null */
  phoneQuietReason(actorId: string, now = Date.now()): "in_call" | "dnd" | null {
    const g = this.phoneGrade(actorId, now);
    return g?.grade === "in_call" ? "in_call" : g?.grade === "dnd" ? "dnd" : null;
  }

  isOnline(actorId: string): boolean {
    return (this.deviceCount.get(actorId) ?? 0) > 0;
  }

  lastActivityAt(actorId: string): number | null {
    return this.lastActivity.get(actorId) ?? null;
  }

  listOnline(): string[] {
    return [...this.deviceCount.keys()];
  }

  getPresence(actorId: string, now = Date.now()): PresenceState {
    if (!this.isOnline(actorId)) return "offline";
    const last = this.lastActivity.get(actorId);
    return last !== undefined && now - last <= PresenceService.IDLE_AFTER_MS ? "active" : "idle";
  }

  /**
   * 这条主动消息该在哪个端弹系统横幅（§3.7「多端时取打断成本最低的那一端」）。
   *
   * 只在**两端都在线**时给结论：单端没有选择余地（保持现有 fan-out 语义不变，
   * 也就不会动到桌面/手机各自的既有触达行为）。两端都在时看人此刻在哪一端：
   *   手机解锁在用 → 手机；否则桌面最近有真人业务活动 → 桌面；
   *   两端都没动静 → 手机（至少能落在通知栏里等人回来看）。
   * 手机状态过期（App 被杀）时返回 null——不指定，各端按原逻辑自决。
   */
  bannerSurface(actorId: string, now = Date.now()): BannerSurface | null {
    const classes = this.deps.onlineDeviceClasses?.(actorId);
    if (!classes?.includes("mobile") || !classes.includes("desktop")) return null;
    const phone = this.phoneGrade(actorId, now);
    if (!phone) return null;
    if (phone.grade === "phone_active") return "mobile";
    return this.deps.attendedDeviceClass?.(actorId) === "desktop" ? "desktop" : "mobile";
  }

  /** 桌面端是否在线；null = 装配层没注入设备类别（调用方按「不知道」处理） */
  desktopOnline(actorId: string): boolean | null {
    const classes = this.deps.onlineDeviceClasses?.(actorId);
    if (!classes) return null;
    return classes.includes("desktop");
  }

  /** 诊断用：当前可见的时机信号 */
  timingSnapshot(actorId: string, now = Date.now()): Record<string, unknown> {
    return {
      presence: this.getPresence(actorId, now),
      online: this.isOnline(actorId),
      devices: this.deps.onlineDeviceClasses?.(actorId) ?? null,
      attended: this.deps.attendedDeviceClass?.(actorId) ?? null,
      phone: this.phoneGrade(actorId, now),
      bannerOn: this.bannerSurface(actorId, now),
    };
  }
}

/** 睡眠判定的「夜间」窗口：22:00–06:59。与主动消息静默时段（quiet-hours）解耦——
 *  那是「别发」的配置，这里是「这个人大概在睡觉」的生理窗口，各自可独立调整。 */
function isNightHour(hour: number): boolean {
  return hour >= 22 || hour < 7;
}

export type { PhoneGrade };
