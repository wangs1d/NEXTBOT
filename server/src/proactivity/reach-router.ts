/**
 * 分级触达路由（ReachRouter）—— 「多急 × 要不要拍板」决定打扰方式，响应归一。
 *
 * 通道阶梯（打扰强度递增）：
 *   L2 chat   对话气泡（agent.proactive_message，WS 直推 + 离线推送兜底）
 *   L3 popup  弹窗卡（reminder_popup，需用户点掉）
 *   L4 phone  虚拟来电（virtualPhoneService.callUserWithRinging）
 *   L0 ledger 注意力台账（不打扰，只记「今天我做了什么」）
 *
 * 路由矩阵（用户决策 2026-09-22：要不要用户拍板决定走不走弹窗——
 *   需要决策的走桌面弹窗，不需要决策的只落右上角足迹，不打扰）：
 *   decision=confirm（花钱确认）   → chat → popup → phone*
 *   urgency=interrupt（紧急）      → popup → phone*
 *   urgency=alert + fyi（临期告知）→ chat + 足迹（不升 popup/voice）
 *   urgency=normal                → chat + 足迹（专注态延后投递）
 *   decision=none / log           → 台账 only（静默执行，晚间汇报兜底）
 *   *phone 仅 urgency=interrupt 触发（白名单克制：滥用即骚扰）
 *
 * 升级规则（双轨，且相邻两次投递至少间隔 MIN_ESCALATION_GAP_MS 防连发；
 * 仅 confirm/interrupt 记录适用——告知类阶梯止于 chat，无升级）：
 *   - 截临近轨：距 deadline <30min 升 popup、<3min 升 phone
 *   - 步进轨：无deadline压力时按阶梯固定步进（2min/4min）升级
 *   - deadline 已过仍 open → expired（确认类由 hub TTL 自行作废，这里同步状态）
 * ack 归一：对话回话、弹窗按钮、收件箱处理、通知点击都落到 AttentionStore 的
 * 同一条记录，升级计时看到 ack 即停。
 */
import type {
  AttentionChannel,
  AttentionRecord,
  AttentionStore,
  AttentionUrgency,
  AttentionDecision,
} from "./attention-store.js";
import { URGENCY_RANK } from "./attention-store.js";
import { buildAssistantTurnFrames } from "../agent/assistant-turn-publisher.js";

export type ReachInput = {
  actorId: string;
  kind: string;
  title: string;
  summary: string;
  urgency: AttentionUrgency;
  decision: AttentionDecision;
  spend?: boolean;
  /** 截止时间 ms（日程开始、确认过期等）；null=无期限 */
  deadlineAt?: number | null;
  /** 关联挂起确认（decision=confirm 时） */
  confirmId?: string;
  /**
   * 已由其他链路投递过的通道（如 schedule_upcoming 提案经管道已发 chat），
   * 记录为虚拟投递使升级从下一级开始，避免双发。
   */
  assumeDelivered?: AttentionChannel;
  /** 本事件强制跳过的通道（如会议提醒不需要 popup） */
  skipChannels?: AttentionChannel[];
  meta?: Record<string, unknown>;
};

/** 通道投递适配（全部可选：缺通道时该级跳过；返回 false=用户不在线） */
export type ReachChannelDeps = {
  sendChat?: (actorId: string, payload: Record<string, unknown>) => Promise<boolean>;
  sendPopup?: (actorId: string, payload: Record<string, unknown>) => Promise<boolean>;
  placeCall?: (actorId: string, text: string) => Promise<boolean>;
  sendPush?: (input: {
    actorId: string;
    title: string;
    body: string;
    importance: string;
    kind: string;
    deliveryId: string;
  }) => Promise<boolean>;
  recordActivity?: (input: { actorId: string; kind: string; title: string; summary: string }) => void;
  /** P2 专注降级：true=用户在专注态（normal 级延后投递，最多 30min） */
  isUserFocused?: (actorId: string) => boolean;
};

/** 升级阈值：距截止时间低于该值时允许升到对应通道。
 *  voice 语音播报级已删（2026-09-22 用户决策：本质与来电重叠）。 */
const ESCALATE_BEFORE_MS: Partial<Record<AttentionChannel, number>> = {
  popup: 30 * 60_000,
  phone: 3 * 60_000,
};

/** 步进轨：在当前级别等待多久未响应后允许升到下一级（index = 当前 level） */
const STEP_WAIT_MS = [2 * 60_000, 4 * 60_000];
/** 相邻两次投递的最小间隔（无论哪条轨触发，防连发骚扰） */
const MIN_ESCALATION_GAP_MS = 90_000;
/** 专注态下 normal 级最多延后 30min，之后照发 */
const FOCUS_DEFER_MAX_MS = 30 * 60_000;
const TICK_MS = 30_000;

/** 阶梯矩阵（见文件头）；phone 级仅 interrupt 到达。
 *  告知类（alert/normal，无需拍板）阶梯止于 chat——不升弹窗/语音（用户决策
 *  2026-09-22：需要用户决策的才走桌面弹窗，其余进右上角足迹）。 */
export function ladderFor(urgency: AttentionUrgency, decision: AttentionDecision): AttentionChannel[] {
  if (decision === "confirm") return ["chat", "popup", "phone"];
  if (urgency === "interrupt") return ["popup", "phone"];
  if (urgency === "alert" || urgency === "normal") return ["chat"];
  return [];
}

export class ReachRouter {
  private timer: ReturnType<typeof setInterval> | null = null;
  /** 专注态延后中的记录（id → 首次延后时间） */
  private readonly deferred = new Map<string, number>();

  constructor(
    private readonly store: AttentionStore,
    private readonly channels: ReachChannelDeps = {},
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    if (typeof this.timer.unref === "function") this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * 触达入口：落台账 → 按矩阵投递初始通道。返回注意力记录（含 id 供 ack）。
   * decision=none/log 的静默事件只进台账并立即闭合（不进「未决事项」）。
   */
  async route(input: ReachInput): Promise<AttentionRecord> {
    const record = this.store.create({
      ...input,
      // skipChannels 需要跨 tick 生效（tick 重建阶梯时读取）
      meta: input.skipChannels?.length
        ? { ...input.meta, skipChannels: input.skipChannels }
        : input.meta,
    });

    const ladder = ladderFor(input.urgency, input.decision).filter(
      (ch) => !(input.skipChannels ?? []).includes(ch),
    );

    if (ladder.length === 0) {
      this.channels.recordActivity?.({
        actorId: input.actorId,
        kind: input.kind,
        title: input.title,
        summary: input.summary,
      });
      this.store.ack(record.id, "ledger");
      return this.store.get(record.id) ?? record;
    }

    // 不需要拍板的告知类（alert/normal）：chat 之外落右上角足迹兜底——
    // 对话气泡易错过，足迹恒可见（用户决策 2026-09-22）
    if (input.decision !== "confirm" && input.urgency !== "interrupt") {
      this.channels.recordActivity?.({
        actorId: input.actorId,
        kind: input.kind,
        title: input.title,
        summary: input.summary,
      });
    }

    // 已由其他链路投递的通道记为虚拟投递（升级从下一级开始）
    if (input.assumeDelivered) {
      const assumedLevel = ladder.indexOf(input.assumeDelivered);
      if (assumedLevel >= 0) {
        this.store.recordDelivery(record.id, input.assumeDelivered, assumedLevel, "assumed:external");
      }
    }

    // 首级已投递过（assume 覆盖第 0 级）时不重发
    const record0 = this.store.get(record.id) ?? record;
    if (record0.level >= 0) return record0;

    // P2 专注降级：normal 级且用户在专注态 → 延后（tick 里恢复投递）
    const focused = this.channels.isUserFocused?.(input.actorId) === true;
    if (focused && input.urgency === "normal") {
      this.deferred.set(record.id, Date.now());
      return record0;
    }

    await this.deliverAt(record0, ladder, 0);
    return this.store.get(record.id) ?? record0;
  }

  /** ack 归一：任何界面的用户回应都调这里 */
  ack(id: string, via: string): AttentionRecord | undefined {
    this.deferred.delete(id);
    return this.store.ack(id, via);
  }

  /** hub 确认解析后同步闭合关联记录 */
  resolveByConfirmId(confirmId: string, note?: string): AttentionRecord | undefined {
    const found = this.store.getByConfirmId(confirmId);
    if (!found) return undefined;
    this.deferred.delete(found.id);
    return this.store.resolve(found.id, note ?? "已解决");
  }

  // ------------------------------------------------------------------ //
  // 内部：投递与升级
  // ------------------------------------------------------------------ //

  private async deliverAt(record: AttentionRecord, ladder: AttentionChannel[], level: number): Promise<void> {
    const channel = ladder[level];
    if (!channel) return;
    // phone 白名单克制：非 interrupt 一律跳过（不推进 level，避免卡死阶梯）
    if (channel === "phone" && record.urgency !== "interrupt") {
      await this.deliverAt(record, ladder, level + 1);
      return;
    }
    const detail = await this.deliverChannel(record, channel);
    this.store.recordDelivery(record.id, channel, level, detail);
  }

  private async deliverChannel(record: AttentionRecord, channel: AttentionChannel): Promise<string> {
    const { actorId } = record;
    const shortSummary = record.summary.slice(0, 160);
    try {
      switch (channel) {
        case "chat": {
          // 与对话回复同一套出口（2026-11-25）：done + bubbles，不再发单泡。
          const built = buildAssistantTurnFrames({
            sessionId: actorId,
            traceId: `attention-${record.id}`,
            finalText: record.summary,
            proactive: {
              deliveryId: `attention_${record.id}`,
              title: record.title,
              kind: `attention:${record.kind}`,
              why: `attention:${record.kind}`,
              importance: record.urgency === "interrupt" ? "high" : "medium",
            },
          });
          let sent = false;
          for (const frame of built.frames) {
            sent = (await this.channels.sendChat?.(actorId, JSON.parse(frame))) ?? false;
          }
          if (!sent) {
            // 用户不在线：离线推送兜底
            await this.sendPushFor(record, "high");
            return "offline_pushed";
          }
          return "delivered";
        }
        case "popup": {
          const sent =
            (await this.channels.sendPopup?.(actorId, {
              type: "reminder_popup",
              title: record.title,
              message: record.summary,
              priority: record.urgency === "interrupt" ? "critical" : "high",
              showConfirmButton: true,
              confirmText: "知道了",
              attentionId: record.id,
            })) ?? false;
          if (!sent) {
            await this.sendPushFor(record, "high");
            return "offline_pushed";
          }
          return "delivered";
        }
        case "phone": {
          const sent = (await this.channels.placeCall?.(actorId, `${record.title}。${shortSummary}`)) ?? false;
          return sent ? "delivered" : "failed:call_rejected";
        }
        default:
          return "skipped";
      }
    } catch (err) {
      return `failed:${err instanceof Error ? err.message : String(err)}`;
    }
  }

  private async sendPushFor(record: AttentionRecord, importance: string): Promise<void> {
    try {
      await this.channels.sendPush?.({
        actorId: record.actorId,
        title: record.title,
        body: record.summary.slice(0, 160),
        importance: record.urgency === "interrupt" ? "critical" : importance,
        kind: record.kind,
        deliveryId: record.id,
      });
    } catch {
      // 推送失败不阻塞主流程（台账里已可见）
    }
  }

  /**
   * 升级 tick（30s）：
   *  - 专注延后的 normal 记录：出焦或延后超 30min 时投递
   *  - open 记录：截止临近（临期轨）或步进超时（步进轨），且距上次投递
   *    超过最小间隔 → 投递下一级通道
   *  - 截止已过仍 open → expired
   */
  async tick(): Promise<void> {
    const now = Date.now();
    // 专注延后恢复
    for (const [id, since] of this.deferred) {
      const record = this.store.get(id);
      if (!record || record.state !== "open") {
        this.deferred.delete(id);
        continue;
      }
      const stillFocused = this.channels.isUserFocused?.(record.actorId) === true;
      if (!stillFocused || now - since > FOCUS_DEFER_MAX_MS) {
        this.deferred.delete(id);
        const ladder = ladderFor(record.urgency, record.decision);
        if (record.level < 0) await this.deliverAt(record, ladder, 0);
      }
    }

    for (const record of this.store.listAllOpen()) {
      if (record.decision === "none") continue;
      const skipped = Array.isArray(record.meta?.skipChannels)
        ? (record.meta?.skipChannels as string[])
        : [];
      const ladder = ladderFor(record.urgency, record.decision).filter(
        (ch) => ch !== "phone" || record.urgency === "interrupt",
      ).filter((ch) => !skipped.includes(ch));
      const nextLevel = record.level + 1;
      const nextChannel = ladder[nextLevel];
      if (!nextChannel) continue;

      const deadline = record.deadlineAt;
      if (deadline != null && deadline <= now) {
        this.store.expire(record.id, "已超时未处理");
        continue;
      }

      const lastDeliveryAt = record.deliveries[record.deliveries.length - 1]?.at ?? record.createdAt;
      // 全局防连发间隔
      if (now - lastDeliveryAt < MIN_ESCALATION_GAP_MS) continue;

      // 临期轨：距截止低于该通道阈值
      const threshold = ESCALATE_BEFORE_MS[nextChannel];
      const nearDeadline = deadline != null && threshold != null && deadline - now <= threshold;
      // 步进轨：当前级别等待超时
      const stepWait = STEP_WAIT_MS[Math.min(record.level, STEP_WAIT_MS.length - 1)] ?? STEP_WAIT_MS[0];
      const stepTimedOut = now - lastDeliveryAt >= stepWait;
      if (!nearDeadline && !stepTimedOut) continue;

      await this.deliverAt(record, ladder, nextLevel);
    }
  }
}

/** 紧迫度比较（调用方做 urgency 升格判定用，如重要性映射） */
export function urgencyAtLeast(a: AttentionUrgency, b: AttentionUrgency): boolean {
  return URGENCY_RANK[a] >= URGENCY_RANK[b];
}
