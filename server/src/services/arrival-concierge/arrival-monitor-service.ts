import type { ProactiveOutboundMessageService } from "../proactive-outbound-message-service.js";
import type { MessagePlatformGateway } from "../message-platform-gateway.js";
import type { EmailSmsService } from "../email-sms-service.js";
import {
  travelTicketStore,
  type StoredTravelTicket,
} from "../../skills/travel-planning/travel-ticket-store.js";
import { parseLooseTime, TRIP_STAGE_LABELS, type TripStage, type TripStatusProvider, type TripStatusQuery, type TripStatusSnapshot } from "./types.js";
import { PickupSender } from "./pickup-sender.js";
import { ManualScheduleProvider } from "./providers/manual-schedule-provider.js";

/**
 * 到站管家 —— 航班/高铁到站监控 + 接站通知 + 到站打车提案。
 *
 * 数据源：票夹（travelTicketStore）里「未过期机票/火车票」，票面含
 * 到达时间即可建立监控（travel.arrival-monitor 开关控制）。
 *
 * 监控节奏（每 tick 扫描，对每张票在到达窗口内按 pollInterval 节流查询）：
 *   窗口：[到达前 3 小时, 到达后 2 小时]
 *   阶段：scheduled → departed（过出发时间）→ approaching（到达-45min）
 *         → landed（实际到达 / 定位围栏命中）→ settled（到达后 2h）
 *
 * 阶段动作（每阶段只触发一次，幂等记录在 ticket.arrivalMonitoring.notifiedStages）：
 *   approaching → 通知用户行程动态（延误/提前/预计到达）
 *   landed      → ①接站：有 pickupContact 时发送通知（autoSend 直发，
 *                 否则先给用户过目草稿）②到站约车：arrivalRideOptIn 时
 *                 提案约车（真实下单走统一预订层 ride 域，需用户确认）
 *
 * 外发边界：给「接站人」发消息是外向行为——autoSend=false 时一律先出
 * 草稿由用户确认（travel.pickup-send）；autoSend=true 是用户在录入时
 * 明确授权过的免确认直发。
 */

const APPROACHING_WINDOW_MIN = 45;
/** 无实时动态时：票面到达时间已过该分钟数 → 视为已到达（定位兜底可提前）。 */
const SCHEDULED_LANDED_GRACE_MIN = 15;
const SETTLED_AFTER_LANDED_MIN = 120;
const DEFAULT_TICKET_POLL_MS = 5 * 60_000;

export interface ArrivalMonitorDeps {
  outbound: ProactiveOutboundMessageService;
  providers: TripStatusProvider[];
  emailSms: EmailSmsService | null;
  platformGateway: MessagePlatformGateway | null;
  /** 可选：给定位兜底用（未接动态 API 时，用户手机到达车站附近 → landed） */
  getLocation?: ((actorId: string) => { latitude: number; longitude: number; label?: string } | null) | null;
  pollIntervalMs?: number;
  tickMs?: number;
  now?: () => Date;
}

interface PendingPickupDraft {
  draftId: string;
  actorId: string;
  ticketId: string;
  text: string;
  contactName: string;
  createdAt: number;
}

export class ArrivalMonitorService {
  private readonly deps: Required<Pick<ArrivalMonitorDeps, "pollIntervalMs" | "tickMs">> & ArrivalMonitorDeps;
  private readonly pickupSender: PickupSender;
  private readonly pendingPickups = new Map<string, PendingPickupDraft>();
  private readonly stageCache = new Map<string, TripStage>();
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;

  constructor(deps: ArrivalMonitorDeps) {
    this.deps = {
      ...deps,
      pollIntervalMs: deps.pollIntervalMs ?? DEFAULT_TICKET_POLL_MS,
      tickMs: deps.tickMs ?? 60_000,
    };
    this.pickupSender = new PickupSender(deps.emailSms, deps.platformGateway);
  }

  // ------------------------------------------------------------------ //
  // 生命周期
  // ------------------------------------------------------------------ //

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.deps.tickMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  // ------------------------------------------------------------------ //
  // 工具面 API
  // ------------------------------------------------------------------ //

  /** 开启某张票的到站监控（显式 opt-in）。 */
  enable(ticketId: string, actorId: string): { ok: boolean; summary: string } {
    const t = travelTicketStore.get(ticketId, actorId);
    if (!t) return { ok: false, summary: `票 ${ticketId} 不存在` };
    if (t.type === "hotel") return { ok: false, summary: "酒店订单没有到站监控，只有入住提醒" };
    if (!t.arriveTime && !t.departTime) return { ok: false, summary: "该票缺少出发/到达时间，无法建立监控" };
    const provider = this.resolveProvider(t.type === "flight" ? "flight" : "train");
    travelTicketStore.save({
      ...t,
      actorId: t.actorId ?? actorId,
      arrivalMonitoring: {
        ...(t.arrivalMonitoring ?? {}),
        enabled: true,
        provider: provider?.key,
      },
    });
    return {
      ok: true,
      summary: `已开启到站监控（${provider?.label ?? "票面时间"}）。${
        provider?.key === "manual-schedule"
          ? "提示：未配置实时动态 API（VARIFLIGHT/JUHE_TRAIN），将按票面时间 + 设备定位兜底。"
          : ""
      }`,
    };
  }

  disable(ticketId: string, actorId?: string): { ok: boolean; summary: string } {
    const t = travelTicketStore.get(ticketId, actorId);
    if (!t) return { ok: false, summary: `票 ${ticketId} 不存在` };
    travelTicketStore.save({
      ...t,
      arrivalMonitoring: { ...(t.arrivalMonitoring ?? {}), enabled: false },
    });
    return { ok: true, summary: "已关闭该票的到站监控" };
  }

  /** 当前快照（工具查询用；不落 notifiedStages）。 */
  async getSnapshot(
    ticketId: string,
    actorId?: string,
  ): Promise<{ ok: boolean; summary: string; snapshot?: TripStatusSnapshot }> {
    const t = travelTicketStore.get(ticketId, actorId);
    if (!t) return { ok: false, summary: `票 ${ticketId} 不存在` };
    if (t.type === "hotel") return { ok: false, summary: "酒店订单没有行程动态" };
    const snapshot = await this.queryStatus(t);
    if (!snapshot) return { ok: false, summary: "暂无法获取行程动态（缺少到达时间）" };
    return {
      ok: true,
      summary: this.describeSnapshot(t, snapshot),
      snapshot,
    };
  }

  /** 设置/更新接站人。 */
  setPickupContact(
    ticketId: string,
    actorId: string,
    contact: { name: string; phone?: string; channel?: "sms" | "wechat" | "qq" | "feishu"; channelTarget?: string; autoSend: boolean },
  ): { ok: boolean; summary: string } {
    const t = travelTicketStore.get(ticketId, actorId);
    if (!t) return { ok: false, summary: `票 ${ticketId} 不存在` };
    if (!contact.name?.trim()) return { ok: false, summary: "缺少接站人姓名" };
    if (!contact.phone && !contact.channelTarget) {
      return { ok: false, summary: "至少要一个联系方式：手机号（短信）或平台会话 id（微信/QQ/飞书）" };
    }
    travelTicketStore.save({
      ...t,
      actorId: t.actorId ?? actorId,
      pickupContact: {
        name: contact.name.trim(),
        phone: contact.phone?.trim() || undefined,
        channel: contact.channel,
        channelTarget: contact.channelTarget?.trim() || undefined,
        autoSend: contact.autoSend === true,
      },
    });
    return {
      ok: true,
      summary: `接站人已设为 ${contact.name}（${contact.autoSend ? "到站时直接发送" : "到站时先给你过目草稿再发"}）`,
    };
  }

  /** 立即发送接站通知（用户确认草稿 / 直接调用）。 */
  async sendPickupNow(
    ticketId: string,
    actorId: string,
  ): Promise<{ ok: boolean; summary: string }> {
    const t = travelTicketStore.get(ticketId, actorId);
    if (!t) return { ok: false, summary: `票 ${ticketId} 不存在` };
    if (!t.pickupContact) return { ok: false, summary: "先设置接站人（travel.pickup-set）" };
    const snapshot = await this.queryStatus(t);
    const text = composePickupMessage(t, snapshot);
    const result = await this.pickupSender.send(t.pickupContact, text, t.actorId ?? actorId);
    if (result.ok) {
      this.markStageNotified(t, snapshot?.stage ?? "approaching", "pickup_sent");
    }
    return { ok: result.ok, summary: result.summary };
  }

  /** 取走一条待确认接站草稿（一次性）。 */
  consumePickupDraft(draftId: string, actorId: string): PendingPickupDraft | null {
    const draft = this.pendingPickups.get(draftId);
    if (!draft || draft.actorId !== actorId) return null;
    this.pendingPickups.delete(draftId);
    return draft;
  }

  /** 供 travel.arrival-ride 工具取行程目的描述（须属于本人）。 */
  getTicket(ticketId: string, actorId?: string): StoredTravelTicket | null {
    return travelTicketStore.get(ticketId, actorId);
  }

  // ------------------------------------------------------------------ //
  // tick 主循环
  // ------------------------------------------------------------------ //

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const now = this.deps.now?.() ?? new Date();
      // 在途/将出行程（含已出发未到达的票——listUpcoming 会把这类票按
      // 出发时间判过期滤掉，而它们恰是到站监控的主体）
      const candidates = travelTicketStore.listActiveTrips(now.getTime());
      for (const ticket of candidates) {
        if (ticket.type === "hotel") continue;
        // 无归属的票无法通知到正确的人（旧版遗留），跳过而不是猜一个用户
        if (!ticket.actorId) continue;
        const monitoring = ticket.arrivalMonitoring;
        // 未显式开启的票不做主动监控（避免误通知）；出票流程默认开启
        if (!monitoring?.enabled) continue;
        const arriveTs = parseLooseTime(ticket.arriveTime)?.getTime() ?? null;
        const departTs = parseLooseTime(ticket.departTime)?.getTime() ?? null;
        if (arriveTs == null) continue;
        // 窗口外不查询
        if (now.getTime() < arriveTs - 3 * 3600_000 || now.getTime() > arriveTs + 2 * 3600_000) continue;
        // 查询节流
        const lastChecked = monitoring.lastCheckedAt ? Date.parse(monitoring.lastCheckedAt) : 0;
        if (Number.isFinite(lastChecked) && now.getTime() - lastChecked < this.deps.pollIntervalMs) continue;

        const snapshot = await this.queryStatus(ticket);
        if (!snapshot) continue;
        // 定位兜底：无实时动态时，设备定位已到站/机场 → 提前判 landed
        if (snapshot.stage !== "landed" && snapshot.stage !== "settled" && this.locationSaysArrived(ticket)) {
          snapshot.stage = "landed";
          snapshot.statusText = `${snapshot.statusText}（设备定位已到 ${ticket.toStation ?? "到达地"}）`;
        }
        const prevStage = this.stageCache.get(ticket.ticketId);
        travelTicketStore.save({
          ...ticket,
          arrivalMonitoring: {
            ...monitoring,
            lastStage: snapshot.stage,
            lastStatusText: snapshot.statusText,
            lastCheckedAt: now.toISOString(),
          },
        });
        this.stageCache.set(ticket.ticketId, snapshot.stage);
        if (snapshot.stage !== prevStage) {
          await this.runStageActions(ticket, snapshot);
        }
      }
    } catch (err) {
      console.warn("[ArrivalMonitor] tick failed:", err);
    } finally {
      this.ticking = false;
    }
  }

  // ------------------------------------------------------------------ //
  // 状态查询与阶段推导
  // ------------------------------------------------------------------ //

  private resolveProvider(type: "flight" | "train"): TripStatusProvider | null {
    const candidates = this.deps.providers.filter((p) => p.supportedTypes.includes(type) && p.availability().ok);
    return candidates[0] ?? null;
  }

  private async queryStatus(ticket: StoredTravelTicket): Promise<TripStatusSnapshot | null> {
    const type = ticket.type === "flight" ? "flight" : "train";
    const code = ticket.code?.trim();
    if (!code) return null;
    const departDate = (ticket.departTime ?? "").slice(0, 10);
    const q: TripStatusQuery = {
      type,
      code,
      date: departDate || new Date().toISOString().slice(0, 10),
      from: ticket.fromStation,
      to: ticket.toStation,
      scheduledDepartTime: ticket.departTime,
      scheduledArriveTime: ticket.arriveTime,
    };
    const provider = this.resolveProvider(type) ?? new ManualScheduleProvider();
    const result = await provider.query(q);
    if (!result.ok) {
      // provider 失败 → 票面兜底，不让监控断线
      const fallback = await new ManualScheduleProvider().query(q);
      if (!fallback.ok) return null;
      return this.buildSnapshot(ticket, fallback, provider.key + "(fallback)");
    }
    return this.buildSnapshot(ticket, result, provider.key);
  }

  private buildSnapshot(
    ticket: StoredTravelTicket,
    result: Extract<Awaited<ReturnType<TripStatusProvider["query"]>>, { ok: true }>,
    providerKey: string,
  ): TripStatusSnapshot {
    const now = this.deps.now?.() ?? new Date();
    const scheduledArrive = ticket.arriveTime ?? null;
    const estimated = result.estimatedArriveTime ?? scheduledArrive;
    const actual = result.actualArriveTime ?? null;

    const arriveTs =
      parseLooseTime(actual, now)?.getTime() ??
      parseLooseTime(estimated ?? undefined, now)?.getTime() ??
      parseLooseTime(scheduledArrive, now)?.getTime() ??
      null;
    const departTs = parseLooseTime(ticket.departTime, now)?.getTime() ?? null;

    let stage: TripStage = "scheduled";
    if (arriveTs != null && now.getTime() >= arriveTs + SETTLED_AFTER_LANDED_MIN * 60_000) {
      stage = "settled";
    } else if (result.statusText && /到达|落地|已到/.test(result.statusText)) {
      stage = "landed";
    } else if (arriveTs != null && now.getTime() >= arriveTs + SCHEDULED_LANDED_GRACE_MIN * 60_000) {
      stage = "landed";
    } else if (arriveTs != null && now.getTime() >= arriveTs - APPROACHING_WINDOW_MIN * 60_000) {
      stage = "approaching";
    } else if (departTs != null && now.getTime() >= departTs) {
      stage = "departed";
    }

    return {
      stage,
      scheduledArriveTime: scheduledArrive,
      estimatedArriveTime: estimated,
      actualArriveTime: actual,
      delayMinutes: result.delayMinutes ?? null,
      terminal: result.terminal ?? null,
      gate: result.gate ?? null,
      statusText: result.statusText,
      provider: providerKey,
      checkedAt: now.toISOString(),
    };
  }

  /**
   * 定位兜底：设备最新定位标签与到达站/机场名归一化后双向包含即视为
   * 已到达。归一化剥掉航站楼（T2）与通用词（国际/机场/火车站/高铁站/站），
   * 让「上海虹桥国际机场」↔「上海虹桥机场 T2」这类现实命名能对上；
   * 归一化后至少 4 个字才参与匹配，避免误判。仅
   * LOCATION_TRACKING_MODE=continuous 下有持续样本可用。
   */
  private locationSaysArrived(ticket: StoredTravelTicket): boolean {
    const getLoc = this.deps.getLocation;
    if (!getLoc) return false;
    const actorId = ticket.actorId;
    if (!actorId) return false;
    const station = ticket.toStation?.trim();
    if (!station) return false;
    let loc: { latitude: number; longitude: number; label?: string } | null = null;
    try {
      loc = getLoc(actorId);
    } catch {
      return false;
    }
    const label = loc?.label?.trim();
    if (!label) return false;
    const coreStation = normalizePlace(station);
    const coreLabel = normalizePlace(label);
    if (coreStation.length < 4 || coreLabel.length < 4) return false;
    return coreLabel.includes(coreStation) || coreStation.includes(coreLabel);
  }

  private describeSnapshot(ticket: StoredTravelTicket, s: TripStatusSnapshot): string {
    const eta = s.actualArriveTime ?? s.estimatedArriveTime ?? s.scheduledArriveTime ?? "未知";
    const delay =
      s.delayMinutes == null ? "" : s.delayMinutes > 0 ? `，晚点约 ${s.delayMinutes} 分钟` : s.delayMinutes < 0 ? `，提前约 ${-s.delayMinutes} 分钟` : "，准点";
    return `【${ticket.carrier}${ticket.code ? " " + ticket.code : ""}】${TRIP_STAGE_LABELS[s.stage]}：${s.statusText}，预计到达 ${eta}${delay}${s.terminal ? `，${s.terminal}` : ""}（数据源：${s.provider}）`;
  }

  // ------------------------------------------------------------------ //
  // 阶段动作
  // ------------------------------------------------------------------ //

  private async runStageActions(ticket: StoredTravelTicket, snapshot: TripStatusSnapshot): Promise<void> {
    const actorId = ticket.actorId;
    if (!actorId) return;
    const notified = ticket.arrivalMonitoring?.notifiedStages ?? [];

    if (snapshot.stage === "approaching" && !notified.includes("approaching")) {
      const text = `${this.describeSnapshot(ticket, snapshot)}。快到了：需要我通知人来接，或帮你把回程车备好吗？`;
      this.deps.outbound.send({
        actorId,
        title: `行程动态：${ticket.carrier}${ticket.code ? " " + ticket.code : ""}`,
        text,
        reason: "anticipation:planning",
        meta: { urgency: 6, tags: ["travel", "arrival"], ticketId: ticket.ticketId },
      });
      this.markStageNotified(ticket, snapshot.stage, "approaching");
    }

    if (snapshot.stage === "landed" && !notified.includes("landed")) {
      await this.runLandedActions(ticket, snapshot, actorId);
      this.markStageNotified(ticket, snapshot.stage, "landed");
    }
  }

  private async runLandedActions(
    ticket: StoredTravelTicket,
    snapshot: TripStatusSnapshot,
    actorId: string,
  ): Promise<void> {
    // ① 接站通知
    const contact = ticket.pickupContact;
    if (contact) {
      const text = composePickupMessage(ticket, snapshot);
      if (contact.autoSend) {
        const result = await this.pickupSender.send(contact, text, actorId);
        if (!result.ok) {
          this.deps.outbound.send({
            actorId,
            title: "接站通知发送失败",
            text: `尝试通知 ${contact.name} 失败：${result.summary}。草稿如下，你可以转发或改用其他联系方式：\n${text}`,
            reason: "anticipation:follow_up",
            meta: { urgency: 7, tags: ["travel", "pickup", "failure"], ticketId: ticket.ticketId },
          });
        }
      } else {
        // 免打扰确认：出草稿，用户确认后 travel.pickup-send 真实发送
        const draftId = `pickup_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
        this.pendingPickups.set(draftId, {
          draftId,
          actorId,
          ticketId: ticket.ticketId,
          text,
          contactName: contact.name,
          createdAt: Date.now(),
        });
        this.deps.outbound.send({
          actorId,
          title: `已落地，通知 ${contact.name} 来接？`,
          text: `${text}\n（草稿 ${draftId}，回复确认后我会发送给 ${contact.name}）`,
          reason: "anticipation:care",
          meta: { urgency: 8, tags: ["travel", "pickup", "draft"], draftId, ticketId: ticket.ticketId },
        });
      }
    } else {
      this.deps.outbound.send({
        actorId,
        title: "已落地，需要通知谁来接？",
        text: `${this.describeSnapshot(ticket, snapshot)}。你没有设置接站人，告诉我姓名+手机号（或确认后用 travel.arrival-ride 帮你叫车）`,
        reason: "anticipation:care",
        meta: { urgency: 7, tags: ["travel", "pickup"], ticketId: ticket.ticketId },
      });
    }

    // ② 到站约车（opt-in 时提案；真实下单走 ride 域两阶段确认）
    if (ticket.arrivalRideOptIn) {
      this.deps.outbound.send({
        actorId,
        title: "到站约车",
        text: `你已开启到站约车。现在回复目的地（如「回家」），我直接帮你叫车（统一预订层真实下单，下单前会再和你确认价格）`,
        reason: "anticipation:planning",
        meta: { urgency: 7, tags: ["travel", "ride"], ticketId: ticket.ticketId },
      });
    }
  }

  private markStageNotified(ticket: StoredTravelTicket, _stage: TripStage, tag: string): void {
    // 重读票面最新状态，避免覆盖 tick 刚写入的 lastCheckedAt/lastStage
    const fresh = travelTicketStore.get(ticket.ticketId, ticket.actorId) ?? ticket;
    const monitoring = fresh.arrivalMonitoring ?? { enabled: true };
    const notified = monitoring.notifiedStages ?? [];
    if (!notified.includes(tag)) notified.push(tag);
    travelTicketStore.save({
      ...fresh,
      arrivalMonitoring: { ...monitoring, notifiedStages: notified },
    });
  }
}

/** 地点名归一化：剥航站楼与通用词，供定位与票面的宽松匹配。 */
function normalizePlace(raw: string): string {
  return raw
    .replace(/[Tt]\s?\d+/g, "")
    .replace(/国际机场|机场|火车站|高铁站|站/g, "")
    .replace(/国际/g, "")
    .replace(/\s+/g, "");
}

/** 接站消息文案（发给接站人的短信/消息原文）。 */
export function composePickupMessage(ticket: StoredTravelTicket, snapshot: TripStatusSnapshot | null): string {
  const who = ticket.passenger ? `${ticket.passenger} ` : "";
  const trip = `${ticket.carrier}${ticket.code ? ` ${ticket.code}` : ""}`;
  const eta = snapshot
    ? snapshot.actualArriveTime ?? snapshot.estimatedArriveTime ?? snapshot.scheduledArriveTime ?? ticket.arriveTime ?? "稍后"
    : ticket.arriveTime ?? "稍后";
  const terminal = snapshot?.terminal ? `（${snapshot.terminal}）` : ticket.gate ? `（${ticket.gate}）` : "";
  const delay =
    snapshot?.delayMinutes == null
      ? ""
      : snapshot.delayMinutes > 0
        ? `，晚点约 ${snapshot.delayMinutes} 分钟`
        : snapshot.delayMinutes < 0
          ? `，提前约 ${-snapshot.delayMinutes} 分钟`
          : "，准点";
  const station = ticket.toStation ? `到 ${ticket.toStation}` : "";
  return `【接站提醒】${who}乘坐${trip}预计 ${eta} ${station}${terminal}${delay}。请安排时间来接。— 私人管家代发`;
}
