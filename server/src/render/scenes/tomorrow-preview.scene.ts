/**
 * 明日预览场景（2026-11-05 建立；2026-11-09 改为事实注入）。
 *
 * 此前这份内容完全靠模型组织：同样一份行程数据，模型每轮排出来的版式都不同，
 * 漏项与重复的投诉都来自这里。第一版解法是服务端把整段正文渲染好、出口替换
 * （rewritesText）。用户 2026-11-09 指令：不要专门改写——**把事实交给模型，
 * 让它自己回答**。于是本场景现在只做两件事：
 *   1. 生成前把 EveningDigest 序列化成事实行注入 prompt（promptBoundaryFor）；
 *   2. 出口声明正文形态为 markdown（不再产 text、不再接管正文）。
 * 数据仍然只来自载荷，模型不许编造未列出的行程/天气项。
 *
 * 触发条件（严格）：
 *   - 调用方注入 `payloads.eveningDigest`（只有持有该数据的通道会注入）；
 *   - 且用户确实在问明日安排（或调用方显式置 `payloads.tomorrowPreview === true`）。
 * 没有载荷就绝不命中——不会凭空给每个提问塞一张预览。
 */

import type { RenderScene, SceneContext, SceneMatch } from "./types.js";
import { TOMORROW_PREVIEW_BOUNDARY } from "./prompts.js";

export interface PreviewScheduleItem {
  title?: unknown;
  time?: unknown;
}

export interface PreviewWeather {
  text?: unknown;
  minC?: unknown;
  maxC?: unknown;
  rainWindowLabel?: unknown;
  alerts?: unknown;
}

/** 场景只依赖字段形状，不依赖 EveningDigest 类（避免服务层反向耦合） */
export interface PreviewDigestLike {
  date?: unknown;
  tomorrowSchedule?: unknown;
  tomorrowWeather?: unknown;
  deadlineReminders?: unknown;
  importantDays?: unknown;
}

const CHINESE_WEEKDAY = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** "2026-11-06" → "11月6日 周五"；解析不了原样返回 */
export function formatPreviewDate(raw: unknown): string {
  const text = str(raw);
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
  if (!m) return text;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const weekday = CHINESE_WEEKDAY[new Date(Date.UTC(year, month - 1, day)).getUTCDay()];
  return `${month}月${day}日 ${weekday}`;
}

/**
 * 明日日期标签：`digest.date` 是**今天**的本地日期键，明天 = +1 天。
 * 2026-11-09 修的错位：此前直接把 date 当「明天」用，模型会跟着说错日期。
 */
export function formatTomorrowLabel(raw: unknown): string {
  const text = str(raw);
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
  if (!m) return "";
  const dt = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + 1));
  return `${dt.getUTCMonth() + 1}月${dt.getUTCDate()}日 ${CHINESE_WEEKDAY[dt.getUTCDay()]}`;
}

function scheduleLines(digest: PreviewDigestLike): string[] {
  const items = Array.isArray(digest.tomorrowSchedule) ? digest.tomorrowSchedule : [];
  const lines: string[] = [];
  for (const raw of items) {
    const item = (raw ?? {}) as PreviewScheduleItem;
    const title = str(item.title);
    if (!title) continue;
    const time = str(item.time);
    lines.push(time ? `- ${time} ${title}` : `- ${title}`);
  }
  return lines.length > 0 ? lines : ["- 明天没有排日程"];
}

function weatherLines(digest: PreviewDigestLike): string[] {
  const weather = (digest.tomorrowWeather ?? null) as PreviewWeather | null;
  if (!weather) return [];
  const text = str(weather.text);
  const min = num(weather.minC);
  const max = num(weather.maxC);
  const range = min != null && max != null ? `${min}–${max}℃` : "";
  const head = [text, range].filter(Boolean).join(" ");
  const lines: string[] = [];
  if (head) lines.push(`天气：${head}`);
  const rain = str(weather.rainWindowLabel);
  if (rain) lines.push(`降雨集中在 ${rain}`);
  if (Array.isArray(weather.alerts)) {
    const alerts = weather.alerts.map((a) => str(a)).filter(Boolean);
    if (alerts.length > 0) lines.push(`预警：${alerts.join("、")}`);
  }
  return lines;
}

function bulletLines(raw: unknown, pick: (item: Record<string, unknown>) => string): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const line = pick(entry as Record<string, unknown>).trim();
    if (line) out.push(`- ${line}`);
  }
  return out;
}

/** 解析到期串：支持 `2026-11-10T18:00:00Z`（只取字面时分）与 `11-10`（无年份） */
function parseDue(raw: string): { y: number | null; mo: number; d: number; hh: string } | null {
  const text = raw.trim();
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s](\d{1,2}):(\d{2}))?/.exec(text);
  if (iso) {
    return {
      y: Number(iso[1]),
      mo: Number(iso[2]),
      d: Number(iso[3]),
      hh: iso[4] ? `${iso[4].padStart(2, "0")}:${iso[5]}` : "",
    };
  }
  const md = /^(\d{1,2})-(\d{1,2})$/.exec(text);
  if (md) return { y: null, mo: Number(md[1]), d: Number(md[2]), hh: "" };
  return null;
}

/**
 * 到期时刻说人话（2026-11-09）：以前把 ISO 原串塞进 prompt，模型要么照抄
 * `2026-11-10T18:00:00Z`，要么自己换算错。这里统一成「明天 18:00 到期」
 * 「今天到期」「3 天后 09:30 到期」，日期基准取 digest.date（今天）。
 */
function deadlineDesc(item: Record<string, unknown>, digest: PreviewDigestLike): string {
  if (item.overdue === true) return "已过点";
  const raw = str(item.dueAt) || str(item.date);
  if (!raw) return "";
  const due = parseDue(raw);
  if (!due) return `${raw} 到期`;
  const base = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(str(digest.date));
  const year = due.y ?? (base ? Number(base[1]) : null);
  let dayDiff = num(item.dayDiff);
  if (dayDiff == null && year != null && base) {
    const dueUTC = Date.UTC(year, due.mo - 1, due.d);
    const baseUTC = Date.UTC(Number(base[1]), Number(base[2]) - 1, Number(base[3]));
    dayDiff = Math.round((dueUTC - baseUTC) / 86_400_000);
  }
  const withTime = (day: string) => (due.hh ? `${day} ${due.hh} 到期` : `${day}到期`);
  if (dayDiff === 0) return withTime("今天");
  if (dayDiff === 1) return withTime("明天");
  if (dayDiff != null && dayDiff > 1) return withTime(`${dayDiff} 天后`);
  if (dayDiff != null && dayDiff < 0) return "已过点";
  const absolute = formatPreviewDate(raw);
  return absolute ? withTime(absolute) : `${raw} 到期`;
}

/**
 * 把明日预览载荷序列化成给模型看的事实块（大体框架，不是版式）。
 *
 * 2026-11-09 用户定稿：**不要版式固定**——正文由模型自己写，这里只给
 * 「日期 / 行程 / 天气 / 到期 / 近期」五个事实段做骨架，模型照着讲，
 * 不必也不该照抄成排版。同一份载荷多次调用字节一致（无时间、无随机）。
 */
export function renderTomorrowPreviewFacts(digest: PreviewDigestLike): string {
  const tomorrow = formatTomorrowLabel(digest.date);
  const lines: string[] = [tomorrow ? `日期：明天 ${tomorrow}` : "日期：明天"];

  lines.push("行程：", ...scheduleLines(digest));

  const weather = weatherLines(digest);
  if (weather.length > 0) lines.push(...weather);

  const deadlines = bulletLines(digest.deadlineReminders, (item) => {
    const title = str(item.title);
    if (!title) return "";
    const desc = deadlineDesc(item, digest);
    return desc ? `${title}（${desc}）` : title;
  });
  if (deadlines.length > 0) lines.push("明天到期：", ...deadlines);

  const important = bulletLines(digest.importantDays, (item) => {
    // 与客户端 EveningDigestCard 同一口径：name + 「的生日 / 的纪念日」
    const name = str(item.name);
    const type = str(item.type);
    const composed = name
      ? `${name}的${type === "anniversary" ? "纪念日" : type === "custom" ? "特殊日子" : "生日"}`
      : "";
    const label = str(item.label) || composed || str(item.title);
    const days = num(item.daysUntil);
    if (!label) return "";
    if (days === 0) return `${label}（就是今天）`;
    if (days === 1) return `${label}（明天）`;
    return days != null ? `${label}（还有 ${days} 天）` : label;
  });
  if (important.length > 0) lines.push("近期重要日子：", ...important);

  return lines.join("\n");
}

const PREVIEW_INTENT = /明天|明日|明早|明晚|预告|什么安排|有啥安排|安排什么/;

export const tomorrowPreviewScene: RenderScene = {
  id: "tomorrow_preview",
  label: "明日预览",
  priority: 90,
  phase: "pre",
  produces: {
    forms: ["structured"],
    singleBubble: true,
    promptBoundary: TOMORROW_PREVIEW_BOUNDARY,
  },
  contract: "行程/天气/到期/近期由系统作为事实注入 prompt；正文由模型一次写成，服务端不重排不替换。",

  detect(ctx: SceneContext): SceneMatch | null {
    const digest = ctx.payloads?.eveningDigest as PreviewDigestLike | undefined;
    if (!digest || typeof digest !== "object") return null;
    const explicit = ctx.payloads?.tomorrowPreview === true;
    if (!explicit && !PREVIEW_INTENT.test(ctx.userText ?? "")) return null;
    const count = Array.isArray(digest.tomorrowSchedule) ? digest.tomorrowSchedule.length : 0;
    return { reason: `${explicit ? "显式预览" : "用户问明日安排"}，载荷 ${count} 条行程` };
  },

  /** 生成前把明天的真实数据喂给模型：这是本场景对回答的唯一贡献 */
  promptBoundaryFor(ctx: SceneContext): string | undefined {
    const digest = ctx.payloads?.eveningDigest as PreviewDigestLike | undefined;
    if (!digest || typeof digest !== "object") return undefined;
    return `【本轮事实·明日预览】\n${renderTomorrowPreviewFacts(digest)}`;
  },

  plan(ctx, match) {
    const digest = ctx.payloads?.eveningDigest as PreviewDigestLike;
    return {
      sceneId: this.id,
      label: this.label,
      cards: [],
      bodyForm: "markdown",
      promptFragment: TOMORROW_PREVIEW_BOUNDARY,
      constraints: ["行程/天气/到期来自载荷", "正文由模型自己写", "不得编造未列出的项"],
      reason: match.reason,
    };
  },
};
