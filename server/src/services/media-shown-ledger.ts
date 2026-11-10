/**
 * 会话级「已经给用户看过的图」账本（2026-11-09）。
 *
 * 背景（用户真机反馈）：「搜索可以了，但要求再搜索（再来几张）时会返回几张前面
 * 已经返回过的照片」。原因不是本地有图库缓存，而是**同一个 query 每次现场抓取
 * 回来的结果集是稳定的**：实测间隔 65s 抓两次，35 条完全相同、0 条新增（换 query
 * 才 0 重合）。单轮只展示 4 张，同一 query 追轮自然又排到同一批 top-N。
 *
 * 契约：
 *  - 按 sessionId 记账（无 sessionId 的调用方——旅行 POI、商品图——不参与去重）；
 *  - 账本键 = 原图路径 + 文件名哈希（同图不同尺寸变体共用文件名）+ 来源页&标题，
 *    URL 一律归一化去掉 query/hash；本地化后的 `/agent/images/...` 不参与；
 *  - 只记账、只过滤，不改查询词、不追加生成——零 LLM，确定性；
 *  - TTL 30 分钟 + 会话数上限，进程内 Map，无持久化（跨会话不需要记）。
 */

/** 账本保留时长：同一会话 30 分钟内「再来几张」去重生效，过期后允许重复。 */
const LEDGER_TTL_MS = 30 * 60 * 1000;
/** 最多保留多少个会话的账本（防止长跑进程内存无界增长）。 */
const MAX_SESSIONS = 200;

type LedgerEntry = { keys: Set<string>; touchedAt: number };

const ledger = new Map<string, LedgerEntry>();

/** URL 归一化：去 query/hash、host 小写；本地转存路径不参与去重。 */
export function mediaShownKey(rawUrl: string | undefined): string {
  const raw = String(rawUrl ?? "").trim();
  if (!raw) return "";
  // 本地转存后的 PNG 每张都是新文件，按它去重等于不去重
  if (raw.startsWith("/agent/images/")) return "";
  try {
    const u = new URL(raw);
    u.search = "";
    u.hash = "";
    return `${u.host.toLowerCase()}${u.pathname}`.replace(/\/+$/, "");
  } catch {
    return raw;
  }
}

/** 一条媒体结果的账本键：原始图 URL 优先，退来源页 URL。 */
export function mediaItemShownKey(item: {
  pageUrl?: string;
  mediaUrl?: string;
  thumbnailUrl?: string;
}): string {
  const fromMedia = mediaShownKey(item.mediaUrl);
  if (fromMedia) return fromMedia;
  const fromThumb = mediaShownKey(item.thumbnailUrl);
  if (fromThumb) return fromThumb;
  return mediaShownKey(item.pageUrl);
}

/**
 * 一条媒体结果的全部账本键。
 *
 * 判同图的依据是**图片本身**，不是来源页：同一张照片会被不同 query 召回成不同
 * 的 CDN 地址（新浪的 `w640h952` / `w2000h3333` 尺寸变体共用同一文件名哈希），
 * 而同一个来源页会挂多张不同的照片。所以：
 *   - 有原图 URL 时：用「完整路径」+「文件名」两个键（文件名够长、像哈希/时间戳
 *     才参与，避免 `image.jpg` 这种通用名把无关图归并）；
 *   - 没有原图 URL（只有来源页）时：才退化成按来源页判重。
 * 任一键命中即视为「看过」。
 */
export function mediaItemShownKeys(item: {
  pageUrl?: string;
  mediaUrl?: string;
  thumbnailUrl?: string;
  title?: string;
}): string[] {
  const media = mediaShownKey(item.mediaUrl) || mediaShownKey(item.thumbnailUrl);
  const page = mediaShownKey(item.pageUrl);
  const keys = new Set<string>();
  if (media) {
    keys.add(`path:${media}`);
    const base = media.split("/").pop() ?? "";
    // 通用文件名（image.jpg / 1.jpg）不参与文件名判重，否则会大面积误杀
    if (base.length >= 12 && /\d/.test(base)) keys.add(`img:${base}`);
  }
  if (!media && page) keys.add(`page:${page}`);
  // 同一来源页 + 同一标题 = 图库结果集里的同一条目（哪怕 CDN 给了不同尺寸/别名的
  // 图地址，用户看到的仍是「同一条链接的同一张图」）。有标题时同时记这条键，
  // 这是「再来几张又出现同一张」的最后一道网。
  const title = String(item.title ?? "").trim();
  if (page && title) keys.add(`src:${page}##${title}`);
  return [...keys];
}

function prune(now: number): void {
  for (const [sid, entry] of ledger) {
    if (now - entry.touchedAt > LEDGER_TTL_MS) ledger.delete(sid);
  }
  while (ledger.size > MAX_SESSIONS) {
    const oldest = ledger.keys().next().value;
    if (oldest === undefined) break;
    ledger.delete(oldest);
  }
}

function entryFor(sessionId: string, now: number): LedgerEntry {
  let entry = ledger.get(sessionId);
  if (!entry) {
    entry = { keys: new Set(), touchedAt: now };
    ledger.set(sessionId, entry);
  }
  entry.touchedAt = now;
  return entry;
}

/** 过滤掉本会话已经展示过的图；sessionId 为空 → 原样返回（不参与去重）。 */
export function filterUnseenMedia<T extends { pageUrl?: string; mediaUrl?: string; thumbnailUrl?: string; title?: string }>(
  sessionId: string | undefined,
  items: readonly T[],
  now: number = Date.now(),
): T[] {
  const sid = String(sessionId ?? "").trim();
  if (!sid || items.length === 0) return [...items];
  prune(now);
  const entry = ledger.get(sid);
  if (!entry || entry.keys.size === 0) return [...items];
  return items.filter((item) => {
    const keys = mediaItemShownKeys(item);
    return keys.length === 0 || !keys.some((k) => entry.keys.has(k));
  });
}

/** 记录这些图已经展示给用户（调用方在真正返回前记账）。 */
export function rememberShownMedia(
  sessionId: string | undefined,
  items: readonly { pageUrl?: string; mediaUrl?: string; thumbnailUrl?: string; title?: string }[],
  now: number = Date.now(),
): void {
  const sid = String(sessionId ?? "").trim();
  if (!sid || items.length === 0) return;
  prune(now);
  const entry = entryFor(sid, now);
  for (const item of items) {
    for (const key of mediaItemShownKeys(item)) entry.keys.add(key);
  }
}

/** 测试用：清空账本（生产代码不要调用）。 */
export function resetMediaShownLedgerForTests(): void {
  ledger.clear();
}
