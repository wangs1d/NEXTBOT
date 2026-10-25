/**
 * 商品决策页内存载荷存储（比价卡 → 决策页链路的数据面）。
 *
 * 模式与 travel-map 的行程载荷存储一致：比价完成（ShoppingCompareService
 * onCompareResult 回调）时把 CompareResult 存进来，决策页以 ?id= 同源取回
 * 渲染。数据不落盘、随进程生命周期存亡（比价可随时重跑，无需持久化）。
 */

export interface ShoppingDecisionPayload {
  actorId?: string;
  query: string;
  platforms?: string[];
  searchedPlatforms?: string[];
  groups?: Array<{
    normalizedTitle?: string;
    matchType?: "exact" | "similar";
    confidence?: number;
    minPriceCny?: number | null;
    imageUrl?: string;
    offers?: Array<{
      platform?: string;
      title?: string;
      priceCny?: number | null;
      shop?: string;
      url?: string;
      imageUrl?: string;
      fetchedAt?: number;
    }>;
  }>;
  bestOffer?: {
    platform?: string;
    title?: string;
    priceCny?: number | null;
    url?: string;
    shop?: string;
  } | null;
  /** 抓取时刻（ms） */
  fetchedAt?: number;
}

interface StoredPage {
  payload: ShoppingDecisionPayload;
  createdAt: number;
}

const pages = new Map<string, StoredPage>();

/** 容量与时效约束（与 travel-plans 同策略）：最多 32 份、每份 24h 过期（懒清理） */
const MAX_PAGES = 32;
const PAGE_TTL_MS = 24 * 60 * 60 * 1000;

function prunePages(): void {
  const now = Date.now();
  for (const [id, item] of pages) {
    if (now - item.createdAt > PAGE_TTL_MS) pages.delete(id);
  }
  while (pages.size > MAX_PAGES) {
    let oldestId = "";
    let oldestAt = Number.POSITIVE_INFINITY;
    for (const [id, item] of pages) {
      if (item.createdAt < oldestAt) {
        oldestAt = item.createdAt;
        oldestId = id;
      }
    }
    if (!oldestId) break;
    pages.delete(oldestId);
  }
}

/** 存一份比价结果，返回取数 id（决策页 URL 用） */
export function recordShoppingDecisionPage(payload: ShoppingDecisionPayload): string {
  prunePages();
  const id =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID().replace(/-/g, "").slice(0, 16)
      : `dp${Date.now().toString(16)}${Math.random().toString(16).slice(2, 10)}`;
  pages.set(id, { payload, createdAt: Date.now() });
  return id;
}

/** 取回一份比价结果；不存在/已过期返回 null */
export function getShoppingDecisionPage(id: string): ShoppingDecisionPayload | null {
  const item = pages.get(id);
  if (!item) return null;
  if (Date.now() - item.createdAt > PAGE_TTL_MS) {
    pages.delete(id);
    return null;
  }
  return item.payload;
}

/** 测试用：当前存储份数 */
export function shoppingDecisionPageCount(): number {
  return pages.size;
}
