/**
 * 行程票务统一存储（单例，进程内缓存 + 磁盘落盘）
 *
 * 职责：用户从短信 / 邮件 / 手动录入的机票、火车票、酒店订单，agent 通过
 * travel.parse-ticket 提取为结构化字段后在这里统一归档，形成「票夹」：
 *   - travel.list-tickets 列出未过期票务（到站提醒、行程问答的数据源）
 *   - travel.get-ticket 按 ticketId 回查明细
 *
 * 存储：data/travel-tickets/{ticketId}.json 单文件单票，
 * 进程内 Map 索引 + 惰性磁盘读；写入同步刷盘（票务录入是低频事件）。
 */
import { getDataDir } from "../../config/data-dir.js";
import fs from "node:fs";
import path from "node:path";

/** 到站接站人（到站监控触发「通知来接」时使用）。 */
export interface TicketPickupContact {
  /** 联系人姓名（消息称呼用） */
  name: string;
  /** 手机号（短信通道） */
  phone?: string;
  /** 微信/飞书/QQ 会话 id（对应平台桥发送；wechat 平台需微信 Claw 或桥接已配） */
  channel?: "sms" | "wechat" | "qq" | "feishu";
  /** 平台桥的会话/接收 id（channel 为 wechat/qq/feishu 时必填） */
  channelTarget?: string;
  /** 到站时是否免确认直接发送（false = 每次先给用户过目草稿） */
  autoSend: boolean;
}

/** 到站监控运行时状态（arrival-monitor-service 维护，落盘防重启丢状态）。 */
export interface TicketArrivalMonitoring {
  enabled: boolean;
  /** 使用的状态 provider（缺省自动选择） */
  provider?: string;
  /** 最近快照（provider 返回原文节选） */
  lastStage?: string;
  lastStatusText?: string;
  lastCheckedAt?: string;
  /** 已触发过的阶段（approaching / landed 通知各只发一次） */
  notifiedStages?: string[];
}

/** 票务类型 */
export type TicketType = "flight" | "train" | "hotel";

/** 票务来源 */
export type TicketSource = "sms" | "email" | "manual";

export interface StoredTravelTicket {
  /** 票 ID（ticket-<ts>） */
  ticketId: string;
  type: TicketType;
  /** 来源：短信 / 邮件 / 手动 */
  source: TicketSource;
  /** 乘机人 / 乘车人 / 入住人 */
  passenger?: string;
  /** 航司 / 车次 / 酒店名（如「东方航空」「G1027」「亚朵酒店·成都春熙路」） */
  carrier: string;
  /** 航班号 / 订单确认号（如 MU5107、酒店确认号） */
  code?: string;
  /** 出发：机场/车站名（如「首都机场 T3」「上海虹桥站」） */
  fromStation?: string;
  /** 出发城市 */
  fromCity?: string;
  /** 到达：机场/车站名 */
  toStation?: string;
  /** 到达城市 */
  toCity?: string;
  /** 出发时间（ISO 或 "2026-09-10 08:30"） */
  departTime?: string;
  /** 到达时间 */
  arriveTime?: string;
  /** 舱位 / 席别（如「经济舱 5A」「二等座 08车12F」） */
  seat?: string;
  /** 航站楼 / 检票口 / 登机口（如「T3」「A12」） */
  gate?: string;
  // ===== 酒店专属 =====
  /** 入住日期（YYYY-MM-DD） */
  checkInDate?: string;
  /** 退房日期（YYYY-MM-DD） */
  checkOutDate?: string;
  /** 房型 */
  roomType?: string;
  /** 原始文本（短信/邮件片段，回查时还原语境用；不超过 500 字） */
  rawText?: string;
  /** 落盘时间（毫秒） */
  createdAt: number;
  /** 归属用户（到站监控/主动通知路由用；旧票缺省时由工具补记） */
  actorId?: string;
  /** 到站约车：用户已 opt-in，到站前希望 agent 提醒并协助约车 */
  arrivalRideOptIn: boolean;
  /** 到站约车提醒是否已创建（避免重复建日程） */
  arrivalRideReminderCreated?: boolean;
  /** 接站人（到站时通知谁来接；由 travel.pickup-set / 出票时录入） */
  pickupContact?: TicketPickupContact;
  /** 到站监控状态（航班/高铁动态跟踪） */
  arrivalMonitoring?: TicketArrivalMonitoring;
}

const MAX_TICKETS = 100;

class TravelTicketStore {
  private root: string;
  /** ticketId → 票（进程内缓存；磁盘为权威源，未命中惰性读） */
  private mem = new Map<string, StoredTravelTicket>();

  constructor() {
    // 测试可用 TRAVEL_TICKET_STORE_DIR 覆盖存储目录（默认 data/travel-tickets）
    this.root = path.resolve(
      process.env.TRAVEL_TICKET_STORE_DIR || path.join(getDataDir(), "travel-tickets"),
    );
    this.ensureDir(this.root);
  }

  /** 保存/覆盖票务（同步落盘；ticketId 为空时自动生成） */
  save(ticket: Omit<StoredTravelTicket, "createdAt" | "ticketId"> & { ticketId?: string; createdAt?: number }): StoredTravelTicket {
    const ticketId = ticket.ticketId?.trim() || `ticket-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    const withTs: StoredTravelTicket = {
      ...ticket,
      ticketId,
      createdAt: ticket.createdAt ?? Date.now(),
    } as StoredTravelTicket;
    this.mem.set(ticketId, withTs);
    try {
      fs.writeFileSync(this.ticketPath(ticketId), JSON.stringify(withTs), "utf8");
    } catch (err) {
      console.error("[TravelTicketStore] save failed:", err);
    }
    this.prune();
    return withTs;
  }

  /** 按 ticketId 读票：内存未命中时惰性读磁盘 */
  get(ticketId: string): StoredTravelTicket | null {
    const cached = this.mem.get(ticketId);
    if (cached) return cached;
    try {
      const raw = fs.readFileSync(this.ticketPath(ticketId), "utf8");
      const parsed = JSON.parse(raw) as StoredTravelTicket;
      if (parsed?.ticketId) {
        this.mem.set(parsed.ticketId, parsed);
        return parsed;
      }
    } catch {
      // 不存在/损坏 → null
    }
    return null;
  }

  /**
   * 去重匹配：同一类型 + 相同主码（航班号/车次/酒店确认号）+ 相同出发/入住时间
   * 视为同一张票（短信可能重复收到、邮件转发多次）。
   */
  findByCode(type: TicketType, code: string, departTime?: string): StoredTravelTicket | null {
    const key = code.trim().toUpperCase();
    if (!key) return null;
    const timeKey = (departTime ?? "").replace(/[^0-9]/g, "");
    let best: StoredTravelTicket | null = null;
    for (const t of this.listAll()) {
      if (t.type !== type) continue;
      if ((t.code ?? "").trim().toUpperCase() !== key) continue;
      if (timeKey) {
        const tTime = (t.departTime ?? t.checkInDate ?? "").replace(/[^0-9]/g, "");
        if (!tTime || !tTime.startsWith(timeKey.slice(0, 8))) continue;
      }
      if (!best || t.createdAt > best.createdAt) best = t;
    }
    return best;
  }

  /**
   * 未过期票务列表（出发/入住时间升序，最近的在前）。
   * 过期判定：机票/火车票按出发时间，酒店按退房日期；无时间的保留（人工确认）。
   */
  listUpcoming(limit = 10): StoredTravelTicket[] {
    const now = Date.now();
    const withTime = (t: StoredTravelTicket): number | null => {
      const raw = t.departTime ?? t.checkInDate ?? "";
      if (!raw) return null;
      const ts = Date.parse(raw.replace(" ", "T"));
      return Number.isNaN(ts) ? null : ts;
    };
    return this.listAll()
      .map((t) => ({ t, ts: withTime(t) }))
      .filter(({ t, ts }) => {
        if (ts == null) return true; // 无时间 → 保留待人工确认
        const expire = t.type === "hotel" ? Date.parse(`${t.checkOutDate ?? ""}T12:00:00`) : ts;
        return Number.isNaN(expire) ? true : expire > now;
      })
      .sort((a, b) => (a.ts ?? a.t.createdAt) - (b.ts ?? b.t.createdAt))
      .slice(0, Math.max(1, limit))
      .map(({ t }) => t);
  }

  /**
   * 在途 / 即将出行程（仅 flight|train，到站监控用）。
   *
   * 与 listUpcoming 的「未过期」语义不同：已出发、未到达的票恰是监控主体
   * （起飞后 listUpcoming 会把它当过期滤掉），所以这里按监控窗口筛：
   *   到达时间存在，且 到达 ≥ now-2h（落地后 2h 内仍可见），且
   *   出发时间（如有）≤ now+3h（3 小时内会出发/已出发）。
   */
  listActiveTrips(now = Date.now(), limit = 20): StoredTravelTicket[] {
    const parseTs = (raw?: string): number | null => {
      if (!raw) return null;
      const ts = Date.parse(raw.replace(" ", "T"));
      return Number.isNaN(ts) ? null : ts;
    };
    return this.listAll()
      .filter((t) => t.type !== "hotel")
      .map((t) => ({ t, departTs: parseTs(t.departTime), arriveTs: parseTs(t.arriveTime) }))
      .filter(({ departTs, arriveTs }) => {
        if (arriveTs == null) return false;
        if (arriveTs < now - 2 * 3_600_000) return false;
        if (departTs != null && departTs > now + 3 * 3_600_000) return false;
        return true;
      })
      .sort((a, b) => (a.arriveTs ?? 0) - (b.arriveTs ?? 0))
      .slice(0, Math.max(1, limit))
      .map(({ t }) => t);
  }

  /** 标记到站约车提醒已创建（幂等防重） */
  markRideReminderCreated(ticketId: string): void {
    const t = this.get(ticketId);
    if (!t) return;
    this.save({ ...t, arrivalRideReminderCreated: true });
  }

  /** 磁盘全量扫描（新→旧）。内存有值时优先内存。 */
  private listAll(): StoredTravelTicket[] {
    const merged = new Map<string, StoredTravelTicket>();
    try {
      for (const f of fs.readdirSync(this.root)) {
        if (!f.endsWith(".json")) continue;
        const t = this.get(f.replace(/\.json$/, ""));
        if (t) merged.set(t.ticketId, t);
      }
    } catch {
      // 目录不可读 → 只用内存
    }
    for (const t of this.mem.values()) merged.set(t.ticketId, t);
    return [...merged.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  /** 超限清理：只删磁盘文件（保留最近 MAX_TICKETS 份） */
  private prune(): void {
    const all = this.listAll();
    for (const t of all.slice(MAX_TICKETS)) {
      this.mem.delete(t.ticketId);
      try {
        fs.unlinkSync(this.ticketPath(t.ticketId));
      } catch {
        // ignore
      }
    }
  }

  private ticketPath(ticketId: string): string {
    const safe = ticketId.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64);
    return path.join(this.root, `${safe || "ticket"}.json`);
  }

  private ensureDir(dir: string): void {
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {
      // ignore
    }
  }
}

export const travelTicketStore = new TravelTicketStore();
