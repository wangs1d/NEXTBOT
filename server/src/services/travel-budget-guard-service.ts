/**
 * 行程预算守门（travel 双端⑥）：「订单金额 + 预算档 → 超支进晚间摘要」。
 *
 * 判定口径（宁缺毋滥，任一前提缺失直接返回 null 不硬算）：
 * - 用户今日在行程中：travelPlanStore 里 sessionId 匹配且 startDate ≤ 今天 ≤ endDate
 *   的行程（取最新一份；预算守门只对「正在旅行」这件事负责）
 * - 行程有预算档：StoredTravelPlan.budgetTier（规划时 TripPreferences.budget 存档，
 *   用户没说预算 = 没有档位 = 不守门）
 * - 当日消费：BookingOrderStore.sumAmountOnDate（cancelled/failed 天然不计，
 *   amountCny=null 计 0）；只统计旅行相关域——travel（行程预订）+ ride（行程中
 *   打车），restaurant/home_service 是日常消费不算进旅行预算
 *
 * 超支 = 当日消费 > 档位日上限（low 300 / mid 800 / high 2000，常量表可调）。
 * 消费聚合零 LLM；文案在晚间摘要（EveningDigestService）侧生成。
 */

import type { BookingOrderStore } from "./booking/booking-order-store.js";
import type { StoredTravelPlan } from "../skills/travel-planning/travel-plan-store.js";

/** 预算档位 → 每日消费上限（元）。行程级预算 = 日上限 × 天数。 */
export const BUDGET_DAILY_CAP_CNY: Record<'low' | 'mid' | 'high', number> = {
  low: 300,
  mid: 800,
  high: 2000,
};

/** 计入旅行预算的订单域：行程预订 + 行程中打车 */
const TRIP_BUDGET_DOMAINS = new Set(["travel", "ride"]);

export interface TravelBudgetAlert {
  /** 目的地（「成都 3 天行程今天第 2 天」类文案用） */
  destination: string;
  /** 今天是行程第几天（1 基）与总天数 */
  dayIndex: number;
  totalDays: number;
  /** 当日已消费（元，booking 订单合计） */
  spentToday: number;
  /** 档位日上限（元） */
  dailyCap: number;
  /** 超支比例（spentToday / dailyCap，≥1） */
  ratio: number;
}

export type TravelBudgetGuardDeps = {
  travelPlanStore: { get: (planId: string) => StoredTravelPlan | null; listSummaries: (limit?: number) => Array<{ planId: string; sessionId?: string }> };
  bookingOrderStore: Pick<BookingOrderStore, "listByActor">;
};

export class TravelBudgetGuardService {
  constructor(private readonly deps: TravelBudgetGuardDeps) {}

  /**
   * 检查用户今日是否旅行超支。无进行中行程 / 无预算档 / 未超支 → null。
   * 供晚间摘要（EveningDigestDeps.travelBudgetProvider）按 sessionId 取数。
   */
  async checkBudget(sessionId: string, now = new Date()): Promise<TravelBudgetAlert | null> {
    if (!sessionId) return null;
    const todayKey = localDateKey(now);
    const plan = this.findActivePlan(sessionId, todayKey);
    if (!plan) return null;
    const tier = plan.budgetTier;
    if (!tier) return null;
    const dailyCap = BUDGET_DAILY_CAP_CNY[tier];
    const spentToday = await this.sumTripSpendToday(sessionId, todayKey);
    if (spentToday <= dailyCap) return null;
    return {
      destination: plan.destination,
      dayIndex: dayIndexOf(plan, todayKey),
      totalDays: dayCount(plan),
      spentToday,
      dailyCap,
      ratio: spentToday / dailyCap,
    };
  }

  /** 今日进行中的行程：sessionId 匹配 + 日期落在行程区间内，取最新保存的一份 */
  private findActivePlan(sessionId: string, todayKey: string): StoredTravelPlan | null {
    let best: StoredTravelPlan | null = null;
    for (const s of this.deps.travelPlanStore.listSummaries(50)) {
      if (!s.sessionId || s.sessionId !== sessionId) continue;
      const plan = this.deps.travelPlanStore.get(s.planId);
      if (!plan?.startDate || !plan.endDate) continue;
      if (plan.startDate <= todayKey && todayKey <= plan.endDate) {
        if (!best || (plan.createdAt ?? 0) > (best.createdAt ?? 0)) best = plan;
      }
    }
    return best;
  }

  /** 当日旅行消费：逐单过滤旅行域再合计（sumAmountOnDate 不分域，这里自算） */
  private async sumTripSpendToday(sessionId: string, todayKey: string): Promise<number> {
    try {
      const orders = await this.deps.bookingOrderStore.listByActor(sessionId, {
        includeFinished: true,
        limit: 200,
      });
      let sum = 0;
      for (const o of orders) {
        if (!TRIP_BUDGET_DOMAINS.has(o.domain)) continue;
        if (o.status === "cancelled" || o.status === "failed") continue;
        if ((o.dateKey ?? o.createdAt.slice(0, 10)) !== todayKey) continue;
        sum += o.amountCny ?? 0;
      }
      return Math.round(sum * 100) / 100;
    } catch {
      return 0;
    }
  }
}

/** 本地时区日期键（YYYY-MM-DD），与 BookingOrderStore.localDateKey 同口径 */
function localDateKey(d: Date): string {
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
}

/** 今天是行程第几天（1 基；日期串字典序比较，start 日 = 第 1 天） */
function dayIndexOf(plan: StoredTravelPlan, todayKey: string): number {
  const start = Date.parse(`${plan.startDate}T00:00:00`);
  const today = Date.parse(`${todayKey}T00:00:00`);
  if (!Number.isFinite(start) || !Number.isFinite(today)) return 1;
  return Math.max(1, Math.round((today - start) / 86_400_000) + 1);
}

function dayCount(plan: StoredTravelPlan): number {
  const start = Date.parse(`${plan.startDate}T00:00:00`);
  const end = Date.parse(`${plan.endDate}T00:00:00`);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return plan.days.length || 1;
  return Math.max(1, Math.round((end - start) / 86_400_000) + 1);
}
