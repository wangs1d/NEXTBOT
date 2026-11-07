/**
 * 提醒确认场景（2026-11-07 用户拍板「方案 A」）：calendar.create 成功回执
 * → 一张只读确认卡，卡内多行、一轮一张。
 *
 * 三条硬规则：
 *   R1 只认成功回执：没有 taskId / nextRunAt / title / timezone 就不出卡，
 *      澄清轮、失败轮、超时轮一律 0 张卡（正文承担说明）。
 *   R2 零模型排版：时间、事项、状态全部来自回执，模型不写槽位、不看版式；
 *      正文只作前导，不复述卡内条目（promptFragment 只写内容边界）。
 *   R3 幂等去重：直跑回执与工具循环捕获可能同时进 effects，按 taskId 去重，
 *      一轮多条合并成一张卡；rows 全量下发，界面一次只渲染一条、上下轮动
 *      （2026-11-07 用户拍板：多条不全铺开，邻项隐隐渐隐）。
 *
 * 卡片不放 actions：手机端 message_body_renderer 见 actions 非空会把整张卡
 * 换成通用按钮卡，时间/事项/状态行会全丢（购物卡事故根因）。
 */

import type { TurnEffect } from "../types.js";
import type { RenderScene, SceneContext, SceneMatch } from "./types.js";
import { REMINDER_CONFIRM_BOUNDARY } from "./prompts.js";

const CREATE_TOOL = "calendar.create";

/** 时间口径：设备时区是工具入参，回执里带回来，渲染层不猜、不用服务端兜底。 */
const DAY_PREFIXES = ["大后天", "明早", "今早", "明晚", "今晚", "明天", "后天", "今天"];
const REPEAT_LABEL: Record<string, string> = {
  daily: "每天",
  weekly: "每周",
  yearly: "每年",
};

export interface ReminderConfirmRow {
  label: string;
  time: string;
  title: string;
  at: string;
  taskId: string;
}

export interface ReminderConfirmPayload {
  cardType: "reminder_confirm";
  title: string;
  items: Array<{ type: "text"; text: string }>;
  footer: string;
  actions: [];
  extra: {
    reminder: {
      status: "created" | "updated" | "cancelled" | "fired";
      rows: ReminderConfirmRow[];
      total: number;
      taskIds: string[];
      timezone: string;
      recurrences: string[];
    };
  };
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/** 用有参 new Date + 设备时区算本地钟点；禁无参 new Date()/Date.now()。 */
function localClock(iso: string, timezone: string): { time: string; weekday: string; monthDay: string } {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return { time: "", weekday: "", monthDay: "" };
    const time = new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(d);
    const parts = new Intl.DateTimeFormat("zh-CN", {
      timeZone: timezone,
      weekday: "short",
      month: "numeric",
      day: "numeric",
    }).formatToParts(d);
    const pick = (type: string): string => parts.find((p) => p.type === type)?.value ?? "";
    return { time, weekday: pick("weekday"), monthDay: `${pick("month")}月${pick("day")}日` };
  } catch {
    // 时区非法 / 时刻非法：不出卡，绝不退回 UTC 冒充设备时间
    return { time: "", weekday: "", monthDay: "" };
  }
}

/** 相对日沿用工具已按设备时区算好的 whenSpoken 前缀，渲染层不重算「明早」。 */
function dayLabel(whenSpoken: string, clock: { weekday: string; monthDay: string }): string {
  const hit = DAY_PREFIXES.find((p) => whenSpoken.startsWith(p));
  if (hit) return hit;
  const md = whenSpoken.match(/^(\d+月\d+日)/);
  if (md) return md[1];
  return clock.monthDay || clock.weekday;
}

/**
 * 单条回执 → 一行事实。导出给状态机复用（改期/取消时按同一口径重算，
 * 不另写一套时间格式）。事实不全（尤其时区）就返回 null：宁可没有卡，
 * 也不展示猜出来的时间。
 */
export function reminderRowFromReceipt(result: Record<string, unknown>): ReminderConfirmRow | null {
  if (result.ok === false) return null;
  const taskId = str(result.taskId);
  const at = str(result.nextRunAt) || str(result.runAt);
  const title = str(result.reminderMessage) || str(result.title);
  const timezone = str(result.timezone);
  if (!taskId || !at || !title || !timezone) return null;
  const clock = localClock(at, timezone);
  if (!clock.time) return null;
  return {
    label: dayLabel(str(result.whenSpoken), clock),
    time: clock.time,
    title,
    at,
    taskId,
  };
}

function collectRows(effects: ReadonlyArray<TurnEffect>): ReminderConfirmRow[] {
  const seen = new Set<string>();
  const rows: ReminderConfirmRow[] = [];
  for (const effect of effects) {
    if (effect.tool !== CREATE_TOOL || effect.status !== "ok" || !effect.result) continue;
    const row = reminderRowFromReceipt(effect.result);
    if (!row || seen.has(row.taskId)) continue;
    seen.add(row.taskId);
    rows.push(row);
  }
  return rows;
}

function collectFacts(effects: ReadonlyArray<TurnEffect>): { recurrences: string[]; timezone: string } {
  const recurrences: string[] = [];
  let timezone = "";
  for (const effect of effects) {
    if (effect.tool !== CREATE_TOOL || effect.status !== "ok" || !effect.result) continue;
    const recurrence = str(effect.result.recurrence);
    if (recurrence && recurrence !== "none" && !recurrences.includes(recurrence)) {
      recurrences.push(recurrence);
    }
    if (!timezone) timezone = str(effect.result.timezone);
  }
  return { recurrences, timezone };
}

/** 脚注只在重复规则 / 跨时区时出现；一次性 + 设备本地时区不显示。 */
function buildFooter(facts: { recurrences: string[]; timezone: string }, deviceTimezone?: string): string {
  const parts: string[] = [];
  if (facts.recurrences.length > 0) {
    parts.push(facts.recurrences.map((r) => REPEAT_LABEL[r] ?? r).join("、"));
  }
  if (deviceTimezone && facts.timezone && deviceTimezone !== facts.timezone) {
    parts.push(`按 ${facts.timezone}`);
  }
  return parts.join(" · ");
}

/**
 * 纯函数：回执 → 确认卡载荷。供场景、测试、探针共用（唯一事实源）。
 * deviceTimezone 由调用方经 SceneContext.payloads 注入；缺省时只按重复规则判脚注。
 */
export function buildReminderConfirmPayload(
  effects: ReadonlyArray<TurnEffect>,
  deviceTimezone?: string,
): ReminderConfirmPayload | null {
  const rows = collectRows(effects);
  if (rows.length === 0) return null;
  const facts = collectFacts(effects);
  return {
    cardType: "reminder_confirm",
    title: rows.length === 1 ? "已定好提醒" : `已定好 ${rows.length} 条提醒`,
    // items 与 extra.reminder.rows 同源：applyCards 要求 items 非空才建卡，
    // 同时保证老客户端（通用列表卡）回看历史消息时也能看到全部事实。
    // 移动端新卡只读 rows 做轮动，界面一次只渲染一条，不铺开全部条目。
    items: rows.map((r) => ({ type: "text", text: `${r.label} ${r.time} · ${r.title}` })),
    footer: buildFooter(facts, deviceTimezone),
    actions: [],
    extra: {
      reminder: {
        status: "created",
        rows,
        total: rows.length,
        taskIds: rows.map((r) => r.taskId),
        timezone: facts.timezone,
        recurrences: facts.recurrences,
      },
    },
  };
}

export const reminderConfirmScene: RenderScene = {
  id: "reminder_confirm",
  label: "提醒确认卡",
  priority: 75,
  phase: "pre",
  produces: {
    cardTypes: ["reminder_confirm"],
    promptBoundary: REMINDER_CONFIRM_BOUNDARY,
  },
  contract:
    "卡只从 calendar.create 成功回执产出；按 taskId 去重，一轮一张；" +
    "rows 全量下发，界面一次只渲染一条、上下轮动且邻项渐隐，不做折叠收口；" +
    "时间/事项原样取回执，正文不复述；失败与澄清轮不出卡；actions 恒为空。",

  detect(ctx: SceneContext): SceneMatch | null {
    const rows = collectRows(ctx.effects ?? []);
    if (rows.length === 0) return null;
    return { reason: `${rows.length} 条提醒创建回执` };
  },

  plan(ctx, match) {
    const deviceTimezone =
      typeof ctx.payloads?.deviceTimezone === "string" ? ctx.payloads.deviceTimezone : undefined;
    const payload = buildReminderConfirmPayload(ctx.effects ?? [], deviceTimezone);
    if (!payload) {
      return {
        sceneId: this.id,
        label: this.label,
        cards: [],
        bodyForm: "plain",
        promptFragment: REMINDER_CONFIRM_BOUNDARY,
        constraints: ["回执事实不全不出卡"],
        reason: match.reason,
      };
    }
    return {
      sceneId: this.id,
      label: this.label,
      cards: [{ kind: "card", topic: "reminder_confirm", payload: payload as unknown as Record<string, unknown> }],
      bodyForm: "plain",
      promptFragment: REMINDER_CONFIRM_BOUNDARY,
      constraints: ["正文不复述卡内时间与事项", "一轮只出一张卡", "卡内不放 actions"],
      reason: match.reason,
    };
  },
};
