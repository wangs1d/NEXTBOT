/**
 * 预订订单本地存储（JSON 文件，风格对齐 travel-ticket-store / travel-plan-store）。
 *
 * - 本地 orderId（bkg_*） ↔ provider 订单号的映射与状态快照
 * - 单日累计金额统计（单日限额用）
 * - file 为 null 时纯内存（测试用）
 * - 写入原子化（tmp + rename），并发写串行化
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

import { BOOKING_TERMINAL_STATUSES, type BookingDomain, type BookingOrderStatus } from "./booking-provider.js";

/** 本地时区日期键（YYYY-MM-DD）：单日限额的统计窗口，与 createdAt 的 UTC 前缀区分。 */
export function localDateKey(d: Date): string {
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
}

export interface StoredBookingOrder {
  /** 本地订单 id：bkg_<ts36>_<rand> */
  orderId: string;
  actorId: string;
  domain: BookingDomain;
  provider: string;
  providerOrderId: string | null;
  title: string;
  amountCny: number | null;
  status: BookingOrderStatus;
  /** 服务发生时间（ISO） */
  scheduleAt: string | null;
  /** 承诺板 deadline（ISO） */
  deadline: string | null;
  /** 域特定下单参数（pickup/dropoff/serviceType/covers…） */
  params: Record<string, unknown>;
  /** 平台支付链接（用户手动支付） */
  paymentUrl: string | null;
  /** （已废弃）原承诺板关联 id，承诺板下线后恒为 null；保留字段兼容存量订单 */
  commitmentId: string | null;
  /** 模拟模式订单标记 */
  simulated: boolean;
  createdAt: string;
  updatedAt: string;
  /**
   * 单日限额统计的日期键（本地时区 YYYY-MM-DD，= 创建时刻的本地日期）。
   * 旧数据缺省时回退到 createdAt 的 UTC 前缀（存在至多一个时区偏移的误差）。
   */
  dateKey?: string;
}

export function newBookingOrderId(now = new Date()): string {
  return `bkg_${now.getTime().toString(36)}_${randomBytes(4).toString("hex")}`;
}

export interface BookingOrderListFilter {
  domain?: BookingDomain;
  /** 缺省 = 全部状态 */
  statuses?: BookingOrderStatus[];
  includeFinished?: boolean;
  limit?: number;
}

export class BookingOrderStore {
  private orders = new Map<string, StoredBookingOrder>();
  private writeChain: Promise<void> = Promise.resolve();
  private loaded = false;

  constructor(private readonly file: string | null = null) {}

  private async ensureLoaded(): Promise<void> {
    if (this.loaded || !this.file) return;
    this.loaded = true;
    try {
      if (existsSync(this.file)) {
        const raw = await readFile(this.file, "utf8");
        const parsed = JSON.parse(raw) as { orders?: StoredBookingOrder[] };
        for (const order of parsed.orders ?? []) {
          if (order?.orderId) this.orders.set(order.orderId, order);
        }
      }
    } catch {
      // 损坏文件：从空开始（与 travel-plan-store 容错策略一致）
    }
  }

  private persist(): void {
    if (!this.file) return;
    const file = this.file;
    const payload = JSON.stringify({ orders: [...this.orders.values()] }, null, 2);
    this.writeChain = this.writeChain.then(async () => {
      await mkdir(dirname(file), { recursive: true });
      const tmp = join(dirname(file), `.${basename(file)}.${randomBytes(4).toString("hex")}.tmp`);
      await writeFile(tmp, payload, "utf8");
      await rename(tmp, file);
    }).catch((err) => {
      // 写盘失败必须可见：订单文件是单日限额的统计依据，静默丢写会让限额失真
      console.warn("[BookingOrderStore] 订单写盘失败", err);
    });
  }

  async create(order: StoredBookingOrder): Promise<StoredBookingOrder> {
    await this.ensureLoaded();
    this.orders.set(order.orderId, order);
    this.persist();
    return order;
  }

  async get(orderId: string): Promise<StoredBookingOrder | null> {
    await this.ensureLoaded();
    return this.orders.get(orderId) ?? null;
  }

  async update(orderId: string, patch: Partial<StoredBookingOrder>): Promise<StoredBookingOrder | null> {
    await this.ensureLoaded();
    const existing = this.orders.get(orderId);
    if (!existing) return null;
    const updated: StoredBookingOrder = { ...existing, ...patch, orderId, updatedAt: new Date().toISOString() };
    this.orders.set(orderId, updated);
    this.persist();
    return updated;
  }

  async listByActor(actorId: string, filter: BookingOrderListFilter = {}): Promise<StoredBookingOrder[]> {
    await this.ensureLoaded();
    const includeFinished = filter.includeFinished ?? false;
    const out: StoredBookingOrder[] = [];
    // 新 → 旧
    const entries = [...this.orders.values()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    for (const order of entries) {
      if (order.actorId !== actorId) continue;
      if (filter.domain && order.domain !== filter.domain) continue;
      if (!includeFinished && BOOKING_TERMINAL_STATUSES.has(order.status)) continue;
      if (filter.statuses && !filter.statuses.includes(order.status)) continue;
      out.push(order);
      if (filter.limit && out.length >= filter.limit) break;
    }
    return out;
  }

  /** 等待在途写入全部落盘（测试/停机前调用）。 */
  async flush(): Promise<void> {
    await this.writeChain;
  }

  /**
   * 某 actor 在指定日期键（本地时区 YYYY-MM-DD）成功发起的订单金额合计。
   * cancelled / failed 不计；amountCny 为 null 计 0（以平台为准的订单）。
   * 优先读落库时打标的 dateKey，旧数据回退 createdAt 的 UTC 前缀。
   */
  async sumAmountOnDate(actorId: string, dateKey: string): Promise<number> {
    await this.ensureLoaded();
    let sum = 0;
    for (const order of this.orders.values()) {
      if (order.actorId !== actorId) continue;
      if (order.status === "cancelled" || order.status === "failed") continue;
      if ((order.dateKey ?? order.createdAt.slice(0, 10)) !== dateKey) continue;
      sum += order.amountCny ?? 0;
    }
    return sum;
  }
}
