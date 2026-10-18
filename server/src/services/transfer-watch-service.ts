/**
 * 接驳提醒调度器（travel-upgrade-plan P2，travel-transfer-watch）。
 *
 * 职责：扫描全部行程的交通大段（高铁/航班），按票面时刻动态倒推触发点，
 * 到点产出接驳提醒（「到站前要不要预约一辆滴滴？」），由装配层经 WS 推送
 * 手机端确认卡；用户确认后 Agent 走 ride_hailing.quote → book(scheduleAt)
 * 真实下单（滴滴官方 MCP 已接入）。
 *
 * 触发模型（动态提前量，不是拍脑袋固定值）：
 *   - train arrival：到站前 30 分钟（用户拍板口径：到达前半小时左右）
 *   - flight arrival：落地前 45 分钟（飞行末段手机仍可收 WS；落地后离线补投
 *     由 proactivePipeline must 层兜底——好友消息已有 replayed 重连补投先例）
 *   - departure（返程去机场/车站）：出发前 90 分钟（含路况与取票余量），
 *     且经 UserTimingService 动态反算——若提醒点落在用户起床前（睡梦中的
 *     提醒只会被忽略），顶到「起床后 30 分钟」再发，文案切换时间紧版本；
 *     早班车（出发本身早于起床后 30 分钟）说明用户前一晚就知晓要早起，
 *     照常按 90 分钟提前量发（宁可吵醒也别误车）
 *   - 无票面时刻的段：行程首日 08:00 提醒补充车次/航班时间（只提醒一次，
 *     绝不构造假时刻）
 *
 * 防打扰边界：
 *   - 每段每相位只问一次（内存 sent 表；重启后最多重问一次，宁重勿失——
 *     接驳是时点性刚需，错过窗口提醒就没意义了）
 *   - 用户确认/拒绝后经 TravelPlanStore.setTransferPickupState 落盘，永不再问
 *   - 自驾用户（画像 drives_own_car=self_drive）由上游不写入 transferSegments，
 *     调度器不再判画像（单一职责）
 *   - 静默时段不适用：交通到站不存在"改时间"，照发
 *
 * 调度模式参考 EveningDigestScheduler：每分钟 tick、单 timer、异常吞掉不阻断。
 */
import type { TravelTransferSegment } from "../skills/travel-planning/travel-plan-store.js";

export interface TransferReminderPayload {
  planId: string;
  /** 规划会话（推送目标；行程未带 sessionId 时为 undefined，装配层跳过推送并记日志） */
  sessionId?: string;
  destination: string;
  segment: TravelTransferSegment;
  /** 距到达/出发的分钟数（约数，文案用） */
  minutesUntil: number;
  /** 面向用户的提醒文案（确定性模板，零 LLM） */
  message: string;
  /** 相位标识（pre_arrival / pre_departure / missing_time），去重用 */
  phase: 'pre_arrival' | 'pre_departure' | 'missing_time';
}

export type TransferWatchDeps = {
  /** 行程数据口：全部含交通段的行程 */
  listPlans: () => Array<{
    planId: string;
    sessionId?: string;
    destination: string;
    startDate?: string;
    transferSegments?: TravelTransferSegment[];
  }>;
  /** 提醒产出回调（装配层负责 WS 直推 + 不在线走 proactivePipeline must 兜底） */
  onReminder: (payload: TransferReminderPayload) => void | Promise<void>;
  /** 状态落盘口：用户确认/拒绝后写回行程段（装配层接 TravelPlanStore） */
  setPickupState?: (planId: string, segmentNo: string, state: 'confirmed' | 'dismissed') => boolean;
  /**
   * 学到的习惯起床时刻（小时小数；装配层转接 UserTimingService.wakeHour，
   * 未学出为 null）。出发提醒用它动态反算最晚出发提醒时刻：提醒点不早于
   * 起床后 30 分钟——睡梦中的提醒只会被忽略。未注入/未学出则回退固定提前量。
   */
  getWakeHour?: (actorId: string) => number | null;
  /** now 注入（测试用；缺省取系统时间） */
  now?: () => Date;
};

/** 高铁到站前触发提前量（分钟） */
export const TRAIN_LEAD_MIN = 30;
/** 航班落地前触发提前量（分钟；末段仍有网，落地补投靠管道） */
export const FLIGHT_LEAD_MIN = 45;
/** 返程出发提前量（分钟）：酒店→车站余量 + 路况波动 */
export const DEPARTURE_LEAD_MIN = 90;
/** 错过窗口不补发的容忍期（分钟）：窗口过后 10 分钟内仍可发，再晚就静默 */
export const WINDOW_TOLERANCE_MIN = 10;
/** 无时刻段的降级提醒时刻（行程首日 08:00） */
export const MISSING_TIME_HOUR = 8;
/** 起床后可出门的基准偏移（分钟）：出发提醒不早于起床后 30 分钟 */
export const WAKE_READY_OFFSET_MIN = 30;

const TYPE_LABEL: Record<TravelTransferSegment['type'], string> = {
  train: '高铁',
  flight: '航班',
};

export class TransferWatchService {
  private timer: NodeJS.Timeout | null = null;
  /** 已提醒表：`planId:no:phase` → true（内存；重启重问一次可接受，宁重勿失） */
  private readonly sent = new Set<string>();

  constructor(private readonly deps: TransferWatchDeps) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick().catch(() => {}), 60_000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** 供测试：单次扫描（生产由 start() 的 interval 驱动） */
  async tick(now: Date = this.deps.now?.() ?? new Date()): Promise<void> {
    for (const plan of this.deps.listPlans()) {
      for (const seg of plan.transferSegments ?? []) {
        if (seg.pickupConfirmed || seg.pickupDismissed) continue;
        const timing = this.pendingPhase(plan, seg, now);
        if (!timing) continue;
        const key = `${plan.planId}:${seg.no}:${timing.phase}`;
        if (this.sent.has(key)) continue;
        this.sent.add(key);
        await this.deps.onReminder({
          planId: plan.planId,
          sessionId: plan.sessionId,
          destination: plan.destination,
          segment: seg,
          minutesUntil: timing.phase === 'pre_departure' ? timing.lead : this.leadOf(seg),
          message: this.renderMessage(plan.destination, seg, timing.phase, timing.tight),
          phase: timing.phase,
        });
      }
    }
  }

  /** 用户侧接驳应答落盘（装配层把确认卡按钮结果接进来） */
  applyPickupAnswer(planId: string, segmentNo: string, accepted: boolean): boolean {
    return this.deps.setPickupState?.(planId, segmentNo, accepted ? 'confirmed' : 'dismissed') ?? false;
  }

  // ────────────────────────── 内部 ──────────────────────────

  /** 该段当前是否有待发相位；有则返回相位 + 有效提前量 + 是否时间紧 */
  private pendingPhase(
    plan: { startDate?: string; sessionId?: string },
    seg: TravelTransferSegment,
    now: Date,
  ): { phase: TransferReminderPayload['phase']; lead: number; tight: boolean } | null {
    // 无票面时刻：行程首日 08:00 提醒补充时间
    if (!seg.arrTime && !seg.depTime) {
      if (!plan.startDate) return null;
      const at = new Date(`${plan.startDate}T${String(MISSING_TIME_HOUR).padStart(2, '0')}:00:00`);
      if (Number.isNaN(at.getTime())) return null;
      return now.getTime() >= at.getTime() ? { phase: 'missing_time', lead: 0, tight: false } : null;
    }
    const refIso = seg.role === 'departure' ? seg.depTime : (seg.arrTime || seg.depTime);
    if (!refIso) return null;
    const refAt = new Date(refIso).getTime();
    if (!Number.isFinite(refAt)) return null;
    const timing = seg.role === 'departure'
      ? this.departureLead(plan, refAt)
      : { lead: this.leadOf(seg), tight: false };
    const diffMin = (refAt - now.getTime()) / 60_000;
    // 窗口：提前量 ≤ 剩余时间 ≤ 提前量+容忍（错过太久不补发，防止几天后突袭）
    return diffMin <= timing.lead && diffMin >= timing.lead - WINDOW_TOLERANCE_MIN
      ? { phase: seg.role === 'departure' ? 'pre_departure' : 'pre_arrival', ...timing }
      : null;
  }

  /**
   * 出发段有效提前量（UserTimingService 动态反算最晚出发提醒时刻）。
   * base = 票面出发 − 90 分钟；若 base 落在用户起床前、且出发本身在起床后
   * 30 分钟之后 → 提醒顶到「起床后 30 分钟」，提前量收缩为剩余时间并标记
   * 时间紧（文案切换）；其余场景（未学出作息 / 正常白天 / 早班车）回退固定 90 分钟。
   */
  private departureLead(
    plan: { sessionId?: string },
    depAt: number,
  ): { lead: number; tight: boolean } {
    const wake = this.deps.getWakeHour?.(plan.sessionId ?? '') ?? null;
    if (wake === null || !Number.isFinite(wake)) {
      return { lead: DEPARTURE_LEAD_MIN, tight: false };
    }
    const d = new Date(depAt);
    d.setHours(0, 0, 0, 0);
    const wakeReadyAt = d.getTime() + wake * 60 * 60_000 + WAKE_READY_OFFSET_MIN * 60_000;
    if (!Number.isFinite(wakeReadyAt)) return { lead: DEPARTURE_LEAD_MIN, tight: false };
    const baseAt = depAt - DEPARTURE_LEAD_MIN * 60_000;
    if (baseAt >= wakeReadyAt || depAt <= wakeReadyAt) {
      // 正常白天出发 / 早班车（用户前一晚已知晓要早起）：固定提前量照发
      return { lead: DEPARTURE_LEAD_MIN, tight: false };
    }
    const lead = Math.round((depAt - wakeReadyAt) / 60_000);
    return lead > 0 ? { lead, tight: true } : { lead: DEPARTURE_LEAD_MIN, tight: false };
  }

  private leadOf(seg: TravelTransferSegment): number {
    return seg.type === 'flight' ? FLIGHT_LEAD_MIN : TRAIN_LEAD_MIN;
  }

  /** 确定性文案（零 LLM；语气克制，只问一次） */
  private renderMessage(
    destination: string,
    seg: TravelTransferSegment,
    phase: TransferReminderPayload['phase'],
    tight = false,
  ): string {
    const label = TYPE_LABEL[seg.type] || '行程';
    if (phase === 'missing_time') {
      return `你${destination}行程里有${label} ${seg.no}，但我还不知道具体时刻——把到达时间发我，到点我可以帮你预约接驳的滴滴。`;
    }
    if (phase === 'pre_departure') {
      if (tight) {
        // 作息反算版：提醒被顶到起床后（原定提醒点在睡梦中），剩余时间紧
        return `${label} ${seg.no} 很快就要发车了${seg.from ? `，该动身去${seg.from}了` : ''}——收拾一下就出发吧。需要我帮你叫一辆车吗？`;
      }
      return `${label} ${seg.no} 还有约 ${DEPARTURE_LEAD_MIN} 分钟就该出发去${seg.role === 'departure' ? '车站' : ''}${seg.to ? `（前往 ${seg.to}）` : ''}了。需要我帮你叫一辆车吗？`;
    }
    const target = seg.to || destination;
    return `${label} ${seg.no} 大约 ${this.leadOf(seg)} 分钟后到站。需要我帮你预约从${seg.from && seg.from !== '出发地' ? seg.from : '车站'}去${target}的滴滴吗？`;
  }
}
