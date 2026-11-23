// 「钱的月报」——动态页账单区块顶部的 {月份}小结 卡数据源（PRD §9，2026-11-24）。
//
// **为什么不自己写一份合计**：验收口径是"与 ledger 明细合计一致（误差 0）"。
// 只要这里另起一处 `reduce(sum)`，它就永远可能和台账的口径漂开（四舍五入位数、
// 空金额是否计入、窗口两端含不含……）。所以本模块**只做窗口切分与呈现组装**，
// 每一个金额都出自 `BillParcelLedger.summary()`——与动态页下方明细、与
// bill_parcel.summary 工具同一份聚合代码。summary() 为此新增了绝对区间入参
// （from/to ms），自然月与滚动 30 天走的正是同一条循环。
//
// 订阅/续费段复用 SubscriptionAuditService 的既有识别（confirmed 记录 +
// periodDays + lastChargedAt/nextRenewalDate），不另做续费检测；预告按周期平移到
// 目标月，月付/周付/年付走**日历步进**而非 30 天乘法——后者会让"每月 5 日扣款"
// 在两个月后漂到 3 日，违反"预告与实际扣款日偏差 ≤ 1 天"。
//
// 主动推送文案（pushText）与卡片内容**物理分离**：卡片带金额，推送只写
// 「11月账单小结好了」。PRD 在这条上是加粗的，因此不把两者共用一个字符串。
import type { BillParcelLargest, BillParcelLedger } from "./bill-parcel-ledger.js";
import type { SubscriptionRecord, SubscriptionStatus } from "./subscription-audit-service.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/** 月报卡数据（`/api/dynamics` 的 `monthly` 字段即此形状） */
export type MonthlyBillSummary = {
  /** 目标月 YYYY-MM */
  month: string;
  /** 展示用「11月」 */
  monthLabel: string;
  /** true = 每月 1 日锚定的上一整月（完整版）；false = 本月进行中 */
  complete: boolean;
  /** 统计窗口 ms（含两端） */
  from: number;
  to: number;
  totals: {
    count: number;
    amountCount: number;
    totalAmount: number;
    /** count - amountCount：识别到内容但没提到金额的笔数 */
    missingAmount: number;
    /** amountCount / count（0~1；无条目为 0） */
    coverage: number;
  };
  previous: { month: string; totalAmount: number; count: number } | null;
  mom: {
    direction: "up" | "down" | "flat";
    deltaAmount: number;
    /** 相对上月的变化比例（上月为 0 时 null，此时不给百分比） */
    ratio: number | null;
  };
  topCategories: Array<{ type: string; count: number; amount: number; ratio: number }>;
  largest: BillParcelLargest | null;
  subscriptions: {
    chargedCount: number;
    chargedAmount: number;
    charged: Array<{ merchant: string; amount: number; chargedAt: number }>;
    /** 下月预计扣款（预告） */
    forecastCount: number;
    forecastAmount: number;
    forecast: Array<{
      merchant: string;
      amount: number;
      expectedAt: number;
      periodDays: number;
    }>;
    /** 确认订阅折算月成本 */
    monthlyCost: number;
  };
  /** 覆盖率提示（低覆盖时「有 X 笔没识别到金额」） */
  coverageHint: string;
  /** 主动推送文案：只有月份，绝不含金额 */
  pushText: string;
};

export type MonthlyBillSummaryDeps = {
  ledger: BillParcelLedger;
  /** 订阅盘点（既有续费识别的持有者；未注入时订阅段为空） */
  subscriptionAudit?: {
    listSubscriptions(
      actorId: string,
      statuses?: SubscriptionStatus[],
    ): Promise<SubscriptionRecord[]>;
  } | null;
  /** 测试注入时钟 */
  now?: () => Date;
};

/** 自然月窗口（本地时区） */
export type MonthWindow = {
  month: string;
  monthLabel: string;
  monthNumber: number;
  /** 月首 00:00:00.000 ms */
  from: number;
  /** 月末 23:59:59.999 ms（与 summary 的 `<= to` 闭区间口径对齐） */
  to: number;
  /** 上一个自然月（环比基准） */
  prev: { month: string; monthLabel: string; from: number; to: number };
  /** 下一个自然月（续费预告窗口） */
  next: { month: string; monthLabel: string; from: number; to: number };
  /** 每月 1 日 → true：小结切上一整月完整版 */
  complete: boolean;
};

/**
 * 取月报窗口：**平时看本月进行中，每月 1 日看上月完整版**（PRD §9 位置条）。
 *
 * 判据用"本地日 == 1"而不是"跨过了月末"：后者需要一个上次运行时刻的持久化状态，
 * 而重启会把它抹掉——1 日当天无论重启几次都该显示上月。
 */
export function resolveMonthlyWindow(now: Date): MonthWindow {
  const y = now.getFullYear();
  const m = now.getMonth();
  const anchoredToPrev = now.getDate() === 1;
  // 1 日 → 目标月 = 上一整月；其余 → 本月
  const ty = anchoredToPrev ? (m === 0 ? y - 1 : y) : y;
  const tm = anchoredToPrev ? (m === 0 ? 11 : m - 1) : m;
  const w = (yy: number, mm: number) => ({
    month: `${yy}-${String(mm + 1).padStart(2, "0")}`,
    monthLabel: `${mm + 1}月`,
    monthNumber: mm + 1,
    from: new Date(yy, mm, 1, 0, 0, 0, 0).getTime(),
    to: new Date(yy, mm + 1, 0, 23, 59, 59, 999).getTime(),
  });
  const cur = w(ty, tm);
  const prevStart = new Date(ty, tm - 1, 1);
  const nextStart = new Date(ty, tm + 1, 1);
  return {
    ...cur,
    complete: anchoredToPrev,
    prev: {
      month: `${prevStart.getFullYear()}-${String(prevStart.getMonth() + 1).padStart(2, "0")}`,
      monthLabel: `${prevStart.getMonth() + 1}月`,
      from: prevStart.getTime(),
      to: new Date(prevStart.getFullYear(), prevStart.getMonth() + 1, 0, 23, 59, 59, 999).getTime(),
    },
    next: {
      month: `${nextStart.getFullYear()}-${String(nextStart.getMonth() + 1).padStart(2, "0")}`,
      monthLabel: `${nextStart.getMonth() + 1}月`,
      from: nextStart.getTime(),
      to: new Date(nextStart.getFullYear(), nextStart.getMonth() + 1, 0, 23, 59, 59, 999).getTime(),
    },
  };
}

/**
 * 推送文案（PRD 加粗要求：**不带金额**）。
 *
 * 只吃月份数字——调用方拿不到任何金额参数，从签名上就不可能把金额漏进通知里。
 */
export function buildMonthlyPushText(monthNumber: number): string {
  return `${monthNumber}月账单小结好了`;
}

/** `YYYY-MM-DD` → 本地当日 00:00 ms（不用 Date.parse：它按 UTC 解析，东八区会整体偏 8h） */
function parseDayLocal(iso: string | undefined | null): number | null {
  if (!iso) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso.trim());
  if (!m) {
    const t = Date.parse(iso);
    return Number.isFinite(t) ? t : null;
  }
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
}

/** 按周期平移日期：月/周/年走日历步进，其余按天 */
function shiftByPeriod(ms: number, periodDays: number, n: number): number {
  const d = new Date(ms);
  if (periodDays >= 28 && periodDays <= 31) {
    // 保持"每月同一天"：1/31 步进一个月落到 2/28 而不是 3/3
    const day = d.getDate();
    const r = new Date(d.getFullYear(), d.getMonth() + n, 1);
    const lastDay = new Date(r.getFullYear(), r.getMonth() + 1, 0).getDate();
    r.setDate(Math.min(day, lastDay));
    return r.getTime();
  }
  if (periodDays >= 364 && periodDays <= 366) {
    return new Date(d.getFullYear() + n, d.getMonth(), d.getDate(), d.getHours(), d.getMinutes()).getTime();
  }
  if (periodDays >= 6 && periodDays <= 8) {
    return ms + n * 7 * DAY_MS;
  }
  return ms + n * periodDays * DAY_MS;
}

/** 周期起点（优先 nextRenewalDate，其次 lastChargedAt + 一期） */
function renewalAnchorMs(sub: SubscriptionRecord): number | null {
  const next = parseDayLocal(sub.nextRenewalDate);
  if (next != null) return next;
  const last = parseDayLocal(sub.lastChargedAt);
  if (last == null) return null;
  return shiftByPeriod(last, Math.max(1, sub.periodDays), 1);
}

/**
 * 把某条订阅的扣款日平移到 [windowFrom, windowTo] 内。
 * 落在窗口外（例如季度付这个月不扣）返回 null——不硬凑一条预告。
 */
export function projectRenewalIntoWindow(
  sub: SubscriptionRecord,
  windowFrom: number,
  windowTo: number,
): number | null {
  const anchor = renewalAnchorMs(sub);
  if (anchor == null) return null;
  const periodDays = Math.max(1, sub.periodDays || 30);
  // 向前/向后步进直到落进窗口；400 步封顶（365 天周期 × 一年窗口绰绰有余）
  let ms = anchor;
  let steps = 0;
  while (ms < windowFrom && steps < 400) {
    steps += 1;
    ms = shiftByPeriod(anchor, periodDays, steps);
  }
  if (ms <= windowTo) return ms;
  // anchor 在窗口之后：往回找本期是否已扣过
  ms = anchor;
  steps = 0;
  while (ms > windowTo && steps < 400) {
    steps += 1;
    ms = shiftByPeriod(anchor, periodDays, -steps);
  }
  return ms >= windowFrom && ms <= windowTo ? ms : null;
}

/** Top N 类目（按金额降序；summary.bills.byType 已是这个序） */
function pickTopCategories(
  byType: Array<{ type: string; count: number; amount: number }>,
  totalAmount: number,
  limit = 3,
): MonthlyBillSummary["topCategories"] {
  return byType
    .filter((c) => c.amount > 0)
    .sort((a, b) => b.amount - a.amount || b.count - a.count)
    .slice(0, limit)
    .map((c) => ({
      type: c.type,
      count: c.count,
      amount: c.amount,
      ratio: totalAmount > 0 ? Math.round((c.amount / totalAmount) * 1000) / 1000 : 0,
    }));
}

/**
 * 组装月报卡。异步只因为订阅段要读盘（subscriptions.json）；
 * 台账侧全程同步内存，不新增 IO。
 */
export async function buildMonthlyBillSummary(
  deps: MonthlyBillSummaryDeps,
  actorId: string,
  nowOverride?: Date,
): Promise<MonthlyBillSummary> {
  const now = nowOverride ?? deps.now?.() ?? new Date();
  const w = resolveMonthlyWindow(now);

  // —— 合计：本月 / 上月各切一个自然月窗口，聚合交给 summary ——
  const cur = deps.ledger.summary({ actorId, from: w.from, to: w.to });
  const prev = deps.ledger.summary({ actorId, from: w.prev.from, to: w.prev.to });

  const totalAmount = cur.bills.totalAmount;
  const prevAmount = prev.bills.totalAmount;
  const delta = Math.round((totalAmount - prevAmount) * 100) / 100;
  const missingAmount = Math.max(0, cur.bills.count - cur.bills.amountCount);

  // —— 订阅 / 自动续费：本月已扣 + 下月预计扣款 ——
  const subs: MonthlyBillSummary["subscriptions"] = {
    chargedCount: 0,
    chargedAmount: 0,
    charged: [],
    forecastCount: 0,
    forecastAmount: 0,
    forecast: [],
    monthlyCost: 0,
  };
  if (deps.subscriptionAudit) {
    try {
      const confirmed = await deps.subscriptionAudit.listSubscriptions(actorId, [
        "confirmed" as SubscriptionStatus,
      ]);
      for (const s of confirmed) {
        subs.monthlyCost += (s.amount / Math.max(1, s.periodDays)) * 30;
        const chargedMs = parseDayLocal(s.lastChargedAt);
        if (chargedMs != null && chargedMs >= w.from && chargedMs <= w.to) {
          subs.charged.push({ merchant: s.merchant, amount: s.amount, chargedAt: chargedMs });
          subs.chargedAmount += s.amount;
        }
        const expected = projectRenewalIntoWindow(s, w.next.from, w.next.to);
        if (expected != null) {
          subs.forecast.push({
            merchant: s.merchant,
            amount: s.amount,
            expectedAt: expected,
            periodDays: s.periodDays,
          });
          subs.forecastAmount += s.amount;
        }
      }
      subs.chargedCount = subs.charged.length;
      subs.chargedAmount = Math.round(subs.chargedAmount * 100) / 100;
      subs.forecastCount = subs.forecast.length;
      subs.forecastAmount = Math.round(subs.forecastAmount * 100) / 100;
      subs.monthlyCost = Math.round(subs.monthlyCost * 100) / 100;
      subs.charged.sort((a, b) => b.chargedAt - a.chargedAt);
      subs.forecast.sort((a, b) => a.expectedAt - b.expectedAt);
    } catch (err) {
      console.log(`[MonthlyBillSummary] 订阅段取数失败（忽略，卡片其余照常）: ${err}`);
    }
  }

  return {
    month: w.month,
    monthLabel: w.monthLabel,
    complete: w.complete,
    from: w.from,
    to: w.to,
    totals: {
      count: cur.bills.count,
      amountCount: cur.bills.amountCount,
      totalAmount,
      missingAmount,
      coverage:
        cur.bills.count > 0
          ? Math.round((cur.bills.amountCount / cur.bills.count) * 1000) / 1000
          : 0,
    },
    previous: { month: w.prev.month, totalAmount: prevAmount, count: prev.bills.count },
    mom: {
      direction: delta > 0.005 ? "up" : delta < -0.005 ? "down" : "flat",
      deltaAmount: Math.abs(delta),
      ratio: prevAmount > 0 ? Math.round((delta / prevAmount) * 1000) / 1000 : null,
    },
    topCategories: pickTopCategories(cur.bills.byType, totalAmount),
    largest: cur.bills.largest,
    subscriptions: subs,
    coverageHint:
      missingAmount > 0
        ? `有 ${missingAmount} 笔没识别到金额`
        : cur.bills.count > 0
          ? "金额都已识别"
          : "这个月还没有识别到账单",
    pushText: buildMonthlyPushText(w.monthNumber),
  };
}
