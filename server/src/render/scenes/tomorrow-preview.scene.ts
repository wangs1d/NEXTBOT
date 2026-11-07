/**
 * 明日预览场景（2026-11-05）：睡前备忘 / 「明天什么安排」的固定版式。
 *
 * 此前这份内容完全靠模型组织：同样一份行程数据，模型每轮排出来的版式都不同，
 * 漏项与重复的投诉都来自这里。现在改成**数据驱动渲染**：
 *   EveningDigest 载荷 → 固定 markdown 版式（行程 / 天气 / 到期 / 近期）
 * 模型不参与排版，最多在末尾补一句口语提醒。
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
  if (head) lines.push(head);
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

/**
 * 确定性渲染明日预览正文。同一份载荷多次调用字节一致（无时间、无随机），
 * 这是「版式可控」的可测定义。
 */
export function renderTomorrowPreviewMarkdown(digest: PreviewDigestLike): string {
  const date = formatPreviewDate(digest.date);
  const blocks: string[] = [];
  blocks.push(date ? `## 明天 · ${date}` : "## 明天");

  const schedule = scheduleLines(digest);
  blocks.push(["**行程**", ...schedule].join("\n"));

  const weather = weatherLines(digest);
  if (weather.length > 0) blocks.push(["**天气**", ...weather].join("\n"));

  const deadlines = bulletLines(digest.deadlineReminders, (item) => {
    const title = str(item.title);
    const due = str(item.dueAt) || str(item.date);
    if (!title) return "";
    return due ? `${title}（${due} 到期）` : title;
  });
  if (deadlines.length > 0) blocks.push(["**明天到期**", ...deadlines].join("\n"));

  const important = bulletLines(digest.importantDays, (item) => {
    const label = str(item.label) || str(item.title);
    const days = num(item.daysUntil);
    if (!label) return "";
    return days != null ? `${label}（还有 ${days} 天）` : label;
  });
  if (important.length > 0) blocks.push(["**近期**", ...important].join("\n"));

  return blocks.join("\n\n");
}

const PREVIEW_INTENT = /明天|明日|明早|明晚|预告|什么安排|有啥安排|安排什么/;

export const tomorrowPreviewScene: RenderScene = {
  id: "tomorrow_preview",
  label: "明日预览",
  priority: 90,
  phase: "pre",
  produces: {
    forms: ["structured"],
    rewritesText: true,
    promptBoundary: TOMORROW_PREVIEW_BOUNDARY,
  },
  contract: "行程/天气/穿衣/到期由系统按固定版式渲染；正文不重排，只补一句口语提醒。",

  detect(ctx: SceneContext): SceneMatch | null {
    const digest = ctx.payloads?.eveningDigest as PreviewDigestLike | undefined;
    if (!digest || typeof digest !== "object") return null;
    const explicit = ctx.payloads?.tomorrowPreview === true;
    if (!explicit && !PREVIEW_INTENT.test(ctx.userText ?? "")) return null;
    const count = Array.isArray(digest.tomorrowSchedule) ? digest.tomorrowSchedule.length : 0;
    return { reason: `${explicit ? "显式预览" : "用户问明日安排"}，载荷 ${count} 条行程` };
  },

  plan(ctx, match) {
    const digest = ctx.payloads?.eveningDigest as PreviewDigestLike;
    return {
      sceneId: this.id,
      label: this.label,
      cards: [],
      bodyForm: "markdown",
      text: renderTomorrowPreviewMarkdown(digest),
      promptFragment: TOMORROW_PREVIEW_BOUNDARY,
      constraints: ["正文即渲染结果", "不重复行程条目", "不自行改版式"],
      reason: match.reason,
    };
  },
};
