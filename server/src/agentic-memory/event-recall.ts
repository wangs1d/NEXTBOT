/**
 * 事件回忆的展示层：把 memory_events 行格式化成「什么时候做过什么、结果如何」。
 *
 * 两个消费方（memory.recall 工具 / 对话面【事件回忆】块）共用同一格式化，
 * 保证同一事件在两处措辞一致。只呈现结果，不暴露内部检索/数据库过程。
 */

import { describeMemoryAge } from "../services/memory-record-utils.js";
import type { MemoryEventRecord } from "./event-builder.js";

const KIND_LABEL: Record<string, string> = {
  price_compare: "比价",
  weather_query: "查天气",
  schedule_write: "记日程",
  schedule_query: "查日程",
  travel_plan: "排行程",
  travel_query: "旅行查询",
  web_search: "检索",
  order: "下单",
  shopping_suggest: "购物建议",
  media: "音乐",
  task_write: "办任务",
  phone_call: "电话",
  message: "消息",
  ride: "打车",
  health: "健康",
  finance: "记账",
  clock_query: "定位",
  chat_turn: "对话",
};

const STATUS_LABEL: Record<string, string> = {
  ok: "完成",
  empty: "无结果",
  failed: "失败",
  partial: "部分完成",
  invalid: "数据不可用",
};

function clip(text: string, max: number): string {
  const value = text.replace(/\s+/g, " ").trim();
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}

function formatEventTime(iso: string): string {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return iso;
  try {
    return new Intl.DateTimeFormat("zh-CN", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(date);
  } catch {
    return date.toISOString().slice(0, 16).replace("T", " ");
  }
}

function pickSubject(event: MemoryEventRecord): string {
  const payload = event.payload ?? {};
  const candidates = [payload.query, payload.topic, payload.title, payload.name, event.entities[0]];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) return clip(candidate, 40);
  }
  return clip(event.userText, 40);
}

function pickOutcome(event: MemoryEventRecord): string {
  const payload = event.payload ?? {};
  const bestOffer = payload.bestOffer as Record<string, unknown> | undefined;
  if (event.kind === "price_compare") {
    if (event.status === "invalid") {
      const suspect = typeof payload.suspect === "string" ? `（疑似${payload.suspect === "accessory" ? "配件" : payload.suspect}）` : "";
      const price = typeof payload.minPriceCny === "number" ? ` ¥${payload.minPriceCny}` : "";
      return `数据不可用${price}${suspect}`;
    }
    if (typeof payload.minPriceCny === "number") {
      const platform = typeof payload.platform === "string" ? `（${payload.platform}）` : "";
      return `最低 ¥${payload.minPriceCny}${platform}`;
    }
    if (bestOffer && typeof bestOffer.priceCny === "number") {
      const platform = typeof bestOffer.platform === "string" ? `（${bestOffer.platform}）` : "";
      return `最低 ¥${bestOffer.priceCny}${platform}`;
    }
  }
  if (event.status === "failed") {
    const error = typeof payload.error === "string" ? payload.error : event.answerText;
    return clip(error || "没有办成", 60);
  }
  if (event.status === "empty") return "没查到结果";
  const answer = event.answerText.split(/[。！？\n]/)[0] ?? "";
  // 原始 JSON 答案（工具结果直出）读不出结论，只留主题与状态，不搬 JSON 进回忆行
  if (/^\s*[{[]/.test(answer)) return "";
  return clip(answer || event.userText, 60);
}

/** 单行：`2026-10-29 16:53 比价 小米18 Pro → 数据不可用 ¥8（疑似配件）[数据不可用]（1天前）` */
export function formatEventLine(event: MemoryEventRecord, now = Date.now()): string {
  const kind = KIND_LABEL[event.kind] ?? event.kind;
  const subject = pickSubject(event);
  const outcome = pickOutcome(event);
  const status = STATUS_LABEL[event.status] ?? event.status;
  const age = describeMemoryAge(event.eventTime, now);
  const ageText = age ? `（${age}）` : "";
  const head = `${formatEventTime(event.eventTime)} ${kind} ${subject}`;
  return `${head}${outcome ? ` → ${outcome}` : ""} [${status}]${ageText}`;
}
