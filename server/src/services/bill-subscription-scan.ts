// 订阅与续费扫描（2026-11-16 动态 tab 改版）。
//
// 用户诉求：「扫描绑定账号的自动续费，帮用户省钱」——注意边界：
//   · 不登录任何第三方账号，只读台账里已经入账的账单/短信；
//   · 结论只基于可解释的事实：扣款次数、金额、同类重叠、金额变化；
//   · 「取消」只给官方路径，不代操作。
//
// 识别口径（与设计稿一致）：
//   · 标题/原文命中「连续包月 / 自动续费 / 包月 / 订阅 / 会员 / VIP」等关键词；
//   · 近 90 天内同商户、同金额至少 2 次扣款；
//   · 金额为空或「记错了」的账单不参与。
import type { BillParcelEntry } from "./bill-parcel-ledger.js";

export type SubscriptionCategory = "video" | "music" | "cloud" | "other";
export type SubscriptionSuggestion = "keep" | "cancel" | "review";

export type SubscriptionItem = {
  /** 稳定 id：名称+金额（同一订阅多次扣款归并） */
  id: string;
  name: string;
  amount: number;
  /** 周期：目前只识别月付（账单里能确定的粒度） */
  cycle: "month";
  /** 下次扣款（按上次 + 30 天推算，已过期则顺延到未来） */
  nextChargeAt: number;
  lastChargedAt: number;
  firstChargedAt: number;
  /** 近 90 天已扣次数 */
  chargedCount: number;
  category: SubscriptionCategory;
  suggestion: SubscriptionSuggestion;
  /** 一句人话理由（没有可省项时为空） */
  reason: string;
  /** 取消后每年可省（元）；仅 cancel 时有值 */
  annualSaving: number;
  /** 官方取消路径（不代操作） */
  cancelPath: string;
  /** 续费前提醒时刻（未设置 = null） */
  remindAt?: number | null;
};

export type SubscriptionAlert = {
  id: string;
  kind: "overlap" | "priceUp";
  title: string;
  detail: string;
};

export type SubscriptionScanResult = {
  count: number;
  /** 每月固定支出合计（各项最新金额之和） */
  monthlyTotal: number;
  /** 最近一次扣款日 */
  nextChargeAt: number | null;
  /** 预计每月可省 */
  savingsPerMonth: number;
  items: SubscriptionItem[];
  alerts: SubscriptionAlert[];
};

const SUBSCRIPTION_PATTERN =
  /(连续包月|自动续费|自动扣费|续费|包月|包年|年度订阅|订阅|会员|VIP|iCloud|云存储|网盘|存储空间)/i;

const MERCHANT_PATTERNS: ReadonlyArray<{ name: string; re: RegExp; category: SubscriptionCategory }> = [
  { name: "爱奇艺", re: /爱奇艺|iQIYI/i, category: "video" },
  { name: "腾讯视频", re: /腾讯视频/, category: "video" },
  { name: "优酷", re: /优酷|Youku/i, category: "video" },
  { name: "芒果TV", re: /芒果TV|芒果tv/, category: "video" },
  { name: "哔哩哔哩", re: /哔哩哔哩|bilibili|B站/i, category: "video" },
  { name: "Netflix", re: /Netflix/i, category: "video" },
  { name: "网易云音乐", re: /网易云音乐|网易云/, category: "music" },
  { name: "QQ音乐", re: /QQ音乐|酷狗|酷我/, category: "music" },
  { name: "Spotify", re: /Spotify/i, category: "music" },
  { name: "Apple Music", re: /Apple\s*Music/i, category: "music" },
  { name: "iCloud+", re: /iCloud|苹果云/i, category: "cloud" },
  { name: "百度网盘", re: /百度网盘|百度云/, category: "cloud" },
  { name: "阿里云盘", re: /阿里云盘|夸克网盘|坚果云/, category: "cloud" },
  { name: "WPS 会员", re: /WPS/i, category: "other" },
  { name: "Microsoft 365", re: /Microsoft\s*365|Office\s*365/i, category: "other" },
  { name: "京东 PLUS", re: /京东\s*PLUS|京东PLUS/i, category: "other" },
];

const REPORT_DAYS = 90;
const MONTH_MS = 30 * 24 * 60 * 60 * 1000;

/** 取消路径：只给官方入口，不代操作 */
const CANCEL_PATH: Record<SubscriptionCategory, string> = {
  video: "打开对应视频 App → 我的 → 会员中心 → 管理自动续费 → 关闭",
  music: "打开对应音乐 App → 我的 → 会员中心 → 自动续费管理 → 关闭",
  cloud: "打开系统设置或对应网盘 App → 订阅/会员 → 管理订阅 → 取消",
  other: "在对应 App 的会员/订阅页关闭自动续费，或到应用商店订阅管理中取消",
};

/**
 * 扫描订阅。
 *
 * @param entries 账单条目（调用方已按 actor / 时间窗过滤；这里会再按 90 天收窄）
 * @param opts.now 时钟（测试注入）
 * @param opts.filter 过滤掉用户已忽略的订阅（id 与结果一致）
 */
export function scanSubscriptions(
  entries: readonly BillParcelEntry[],
  opts: {
    now?: number;
    filter?: (item: SubscriptionItem) => boolean;
    reminders?: Record<string, number>;
  } = {},
): SubscriptionScanResult {
  const now = opts.now ?? Date.now();
  const since = now - REPORT_DAYS * 24 * 60 * 60 * 1000;
  const candidates = entries.filter(
    (e) =>
      e.category === "bill" &&
      e.billStatus !== "wrong" &&
      e.archivedAt == null &&
      e.amount != null &&
      e.amount > 0 &&
      e.occurredAt >= since &&
      e.occurredAt <= now &&
      SUBSCRIPTION_PATTERN.test(`${e.title}\n${e.excerpt}`),
  );

  type Bucket = {
    name: string;
    amount: number;
    category: SubscriptionCategory;
    dates: number[];
  };
  const buckets = new Map<string, Bucket>();
  for (const e of candidates) {
    const detected = detectMerchant(`${e.title}\n${e.excerpt}`);
    const name = detected?.name ?? fallbackName(e);
    const category = detected?.category ?? "other";
    const amount = e.amount as number;
    const key = `${name}|${amount.toFixed(2)}`;
    const cur = buckets.get(key) ?? { name, amount, category, dates: [] };
    cur.dates.push(e.occurredAt);
    buckets.set(key, cur);
  }

  const items: SubscriptionItem[] = [];
  for (const [key, b] of buckets) {
    // 至少 2 次扣款才认定为「续费中」——单笔带"会员"的消费不足以推断订阅
    if (b.dates.length < 2) continue;
    const dates = b.dates.slice().sort((a, c) => a - c);
    const last = dates[dates.length - 1] as number;
    const first = dates[0] as number;
    items.push({
      id: `sub:${hash(key)}`,
      name: b.name,
      amount: round2(b.amount),
      cycle: "month",
      nextChargeAt: nextMonthly(last, now),
      lastChargedAt: last,
      firstChargedAt: first,
      chargedCount: dates.length,
      category: b.category,
      suggestion: "keep",
      reason: "",
      annualSaving: 0,
      cancelPath: CANCEL_PATH[b.category],
      remindAt: opts.reminders?.[`sub:${hash(key)}`] ?? null,
    });
  }

  // —— 同类重叠：视频/音乐/云存储各保留一个，其余标记可取消 ——
  const alerts: SubscriptionAlert[] = [];
  for (const category of ["video", "music", "cloud", "other"] as SubscriptionCategory[]) {
    const group = items.filter((i) => i.category === category);
    if (group.length < 2) continue;
    group.sort((a, b) => b.amount - a.amount);
    const drop = group[0] as SubscriptionItem;
    drop.suggestion = "cancel";
    drop.reason = `同类别有 ${group.length} 个重叠订阅，保留其中一个即可`;
    drop.annualSaving = round2(drop.amount * 12);
    alerts.push({
      id: `alert:overlap:${category}`,
      kind: "overlap",
      title: `${categoryLabel(category)}存在 ${group.length} 个重叠订阅`,
      detail: group.map((g) => g.name).join(" + ") + " · 建议合并",
    });
  }

  // —— 涨价：同名订阅的历史金额不同，且最新更高 ——
  const byName = new Map<string, BillParcelEntry[]>();
  for (const e of candidates) {
    const name = detectMerchant(`${e.title}\n${e.excerpt}`)?.name ?? fallbackName(e);
    const arr = byName.get(name) ?? [];
    arr.push(e);
    byName.set(name, arr);
  }
  for (const [name, list] of byName) {
    if (list.length < 2) continue;
    const sorted = list.slice().sort((a, b) => a.occurredAt - b.occurredAt);
    const firstAmount = sorted[0]?.amount ?? 0;
    const lastAmount = sorted[sorted.length - 1]?.amount ?? 0;
    if (lastAmount <= firstAmount) continue;
    alerts.push({
      id: `alert:price:${hash(name)}`,
      kind: "priceUp",
      title: `${name}从 ¥${round2(firstAmount)} 涨到 ¥${round2(lastAmount)}`,
      detail: `最近一次扣款 ${fmtDay(sorted[sorted.length - 1]?.occurredAt ?? now)} · 可在设置中降级`,
    });
    for (const item of items) {
      if (item.name !== name) continue;
      if (item.suggestion === "keep") item.suggestion = "review";
      if (!item.reason) item.reason = `价格从 ¥${round2(firstAmount)} 涨到 ¥${round2(lastAmount)}`;
    }
  }

  items.sort((a, b) => a.nextChargeAt - b.nextChargeAt || b.amount - a.amount);
  const visible = opts.filter ? items.filter((i) => opts.filter?.(i) !== false) : items;
  const monthlyTotal = round2(visible.reduce((sum, i) => sum + i.amount, 0));
  const savingsPerMonth = round2(
    visible.filter((i) => i.suggestion === "cancel").reduce((sum, i) => sum + i.amount, 0),
  );
  const nextChargeAt = visible.length > 0 ? Math.min(...visible.map((i) => i.nextChargeAt)) : null;

  return {
    count: visible.length,
    monthlyTotal,
    nextChargeAt,
    savingsPerMonth,
    items: visible,
    alerts,
  };
}

function detectMerchant(text: string): { name: string; category: SubscriptionCategory } | null {
  for (const m of MERCHANT_PATTERNS) {
    if (m.re.test(text)) return { name: m.name, category: m.category };
  }
  const bracket = /【([^】]{2,20})】/.exec(text);
  if (bracket?.[1]) {
    const name = bracket[1].replace(/(科技|网络|信息|服务|有限公司|中国)$/g, "").trim();
    if (name.length >= 2) return { name, category: "other" };
  }
  return null;
}

function fallbackName(e: BillParcelEntry): string {
  if (e.billType) return e.billType;
  const first = e.title.split("·")[0]?.trim();
  return first && first.length <= 16 ? first : "订阅服务";
}

function categoryLabel(c: SubscriptionCategory): string {
  return c === "video" ? "视频会员" : c === "music" ? "音乐会员" : c === "cloud" ? "云存储" : "订阅服务";
}

/** 上次扣款 + 30 天；若已过期则按整月顺延到未来 */
function nextMonthly(last: number, now: number): number {
  let next = last + MONTH_MS;
  while (next < now) next += MONTH_MS;
  return next;
}

function fmtDay(ms: number): string {
  const d = new Date(ms);
  return `${d.getMonth() + 1}月${String(d.getDate()).padStart(2, "0")}日`;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function hash(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}
