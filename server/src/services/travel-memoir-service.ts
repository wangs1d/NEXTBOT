/**
 * 行后旅行回忆录聚合（travel 双端⑦）：「足迹 + 订单 + 账本 + 照片 → 长页数据」。
 *
 * 数据源（全部真实落库数据，宁缺毋滥——任一源缺失该块就空，页面隐藏该节）：
 * - 足迹：StoredTravelPlan.visits（导航「已到达」时 travel-plan-store.recordVisit
 *   落盘的站点点位）。没有导航记录的站点只按计划行程展示，不冒充「已打卡」。
 * - 订单：BookingOrderStore（travel+ride 域、非取消/失败、dateKey 落在行程区间）
 * - 账本：FinanceDeepService（行程区间内支出合计 + 分类聚合）
 * - 照片：StoredDayItem.images（规划/补图链路已落盘为本地资产的真实 URL）
 *
 * 输出经 GET /travel-map/memoir/data?planId= 下发给 memoir.html 长页。
 * 铁律：坐标（经纬度）不进任何输出字段；金额/条目全部来自真实数据。
 */

import type { StoredTravelPlan } from "../skills/travel-planning/travel-plan-store.js";
import type { BookingOrderStore } from "./booking/booking-order-store.js";
import type { FinanceDeepService, FinanceCategory } from "./finance-deep-service.js";

/** 计入行程账单的订单域：行程预订 + 行程中打车（与预算守门⑥同口径） */
const TRIP_ORDER_DOMAINS = new Set(["travel", "ride"]);

export interface MemoirStop {
  name: string;
  type: string;
  address: string;
  priceInfo: string;
  /** 已落盘的本地图片 URL（无则空数组） */
  images: string[];
  /** 是否有真实到访记录（导航 arrive 落盘） */
  visited: boolean;
  /** 到达时刻（毫秒；仅 visited 时有） */
  arrivedAt: number | null;
}

export interface MemoirDay {
  date: string;
  stops: MemoirStop[];
}

export interface MemoirOrder {
  title: string;
  provider: string;
  amountCny: number | null;
  status: string;
  dateKey: string;
}

export interface MemoirLedger {
  totalExpense: number;
  count: number;
  byCategory: Array<{ category: FinanceCategory; total: number }>;
}

export interface TravelMemoir {
  planId: string;
  destination: string;
  title: string;
  intro: string;
  startDate: string;
  endDate: string;
  coverImage: string;
  persona: { id: string; label: string; desc: string } | null;
  days: MemoirDay[];
  stats: {
    totalStops: number;
    visitedCount: number;
    photoCount: number;
    orderCount: number;
    orderTotal: number;
  };
  orders: MemoirOrder[];
  ledger: MemoirLedger | null;
}

export type TravelMemoirDeps = {
  travelPlanStore: { get: (planId: string) => StoredTravelPlan | null };
  bookingOrderStore?: Pick<BookingOrderStore, "listByActor"> | null;
  financeDeepService?: Pick<FinanceDeepService, "getTransactions"> | null;
};

export class TravelMemoirService {
  constructor(private readonly deps: TravelMemoirDeps) {}

  /** 聚合回忆录数据；行程不存在 → null。任何数据源异常只降级该块，不整体失败。 */
  async build(planId: string, now = new Date()): Promise<TravelMemoir | null> {
    const plan = this.deps.travelPlanStore.get(planId);
    if (!plan) return null;

    const visitMap = new Map<string, number>();
    for (const v of plan.visits ?? []) {
      visitMap.set(`${v.day}:${v.stop}`, v.arrivedAt);
    }

    let photoCount = 0;
    let visitedCount = 0;
    let totalStops = 0;
    const days: MemoirDay[] = (plan.days ?? []).map((day, dayIdx) => ({
      date: day.date ?? "",
      stops: (day.items ?? []).map((item, stopIdx) => {
        const images = (item.images ?? []).filter((u) => typeof u === "string" && u.trim());
        photoCount += images.length;
        const arrivedAt = visitMap.get(`${dayIdx}:${stopIdx}`) ?? null;
        if (arrivedAt != null) visitedCount += 1;
        totalStops += 1;
        return {
          name: item.name ?? "",
          type: item.type ?? "",
          address: item.address ?? "",
          priceInfo: item.priceInfo ?? "",
          images,
          visited: arrivedAt != null,
          arrivedAt,
        };
      }),
    }));

    const orders = await this.fetchOrders(plan, now).catch(() => []);
    const ledger = await this.fetchLedger(plan).catch(() => null);

    return {
      planId: plan.planId,
      destination: plan.destination ?? "",
      title: plan.title ?? "",
      intro: plan.intro ?? "",
      startDate: plan.startDate ?? "",
      endDate: plan.endDate ?? "",
      coverImage: plan.coverImage ?? "",
      persona: plan.persona ?? null,
      days,
      stats: {
        totalStops,
        visitedCount,
        photoCount,
        orderCount: orders.length,
        orderTotal: orders.reduce((s, o) => s + (o.amountCny ?? 0), 0),
      },
      orders,
      ledger,
    };
  }

  /** 行程区间内的真实订单（travel+ride 域；取消/失败不算） */
  private async fetchOrders(plan: StoredTravelPlan, now: Date): Promise<MemoirOrder[]> {
    const store = this.deps.bookingOrderStore;
    const sessionId = plan.sessionId;
    if (!store || !sessionId || !plan.startDate || !plan.endDate) return [];
    const orders = await store.listByActor(sessionId, { includeFinished: true, limit: 200 });
    const todayKey = localDateKey(now);
    const endKey = plan.endDate < todayKey ? plan.endDate : todayKey; // 进行中行程只统计已发生的日期
    return orders
      .filter((o) => TRIP_ORDER_DOMAINS.has(o.domain))
      .filter((o) => o.status !== "cancelled" && o.status !== "failed")
      .filter((o) => {
        const key = o.dateKey ?? o.createdAt.slice(0, 10);
        return key >= plan.startDate && key <= endKey;
      })
      .sort((a, b) => (a.dateKey ?? "").localeCompare(b.dateKey ?? ""))
      .map((o) => ({
        title: o.title ?? "",
        provider: o.provider ?? "",
        amountCny: o.amountCny,
        status: o.status,
        dateKey: o.dateKey ?? o.createdAt.slice(0, 10),
      }));
  }

  /** 行程区间内的账本支出（FinanceDeep 交易流水；无数据返回 null 整节隐藏） */
  private async fetchLedger(plan: StoredTravelPlan): Promise<MemoirLedger | null> {
    const finance = this.deps.financeDeepService;
    const sessionId = plan.sessionId;
    if (!finance || !sessionId || !plan.startDate || !plan.endDate) return null;
    const txs = finance.getTransactions(
      sessionId,
      `${plan.startDate}T00:00:00`,
      `${plan.endDate}T23:59:59`,
    );
    const expenses = txs.filter((t) => t.type === "expense");
    if (expenses.length === 0) return null;
    const catMap = new Map<FinanceCategory, number>();
    let total = 0;
    for (const t of expenses) {
      total += t.amount;
      catMap.set(t.category, (catMap.get(t.category) ?? 0) + t.amount);
    }
    const byCategory = [...catMap.entries()]
      .map(([category, t]) => ({ category, total: t }))
      .sort((a, b) => b.total - a.total)
      .slice(0, 4);
    return { totalExpense: Math.round(total * 100) / 100, count: expenses.length, byCategory };
  }
}

function localDateKey(d: Date): string {
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
}

/**
 * 进程级单例：travel-map 路由直接取用；订单库/账本服务由装配层 configure
 * 注入（bootstrap 持有真实实例，避免同文件双实例读写不一致）。未注入时
 * 对应块为空——回忆录仍可用（足迹/照片不依赖注入）。
 */
class ConfigurableMemoirService {
  private inner: TravelMemoirService | null = null;

  configure(deps: TravelMemoirDeps): void {
    this.inner = new TravelMemoirService(deps);
  }

  build(planId: string): Promise<TravelMemoir | null> {
    if (!this.inner) return Promise.resolve(null);
    return this.inner.build(planId);
  }
}

export const travelMemoir = new ConfigurableMemoirService();
