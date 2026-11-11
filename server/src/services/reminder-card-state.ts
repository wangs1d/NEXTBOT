/**
 * 提醒确认卡状态机（2026-11-07 用户拍板）：修改 / 取消**刷新原卡**，不追加新卡。
 *
 * 服务端记住「哪个 taskId 的卡在哪条消息里」；本轮 update/delete 成功回执到达
 * 后按 messageId 推 card.update，客户端已有原地换卡链路（mobile_chat_controller
 * `_applyCardUpdate` 以 text 里的卡标记块为唯一真相源，替换后同步落盘）。
 *
 * 边界：内存态。进程重启后不再追刷历史卡（历史卡保持 created），但**绝不追加
 * 新卡**——符合「不追加」拍板；要跨重启一致再把 entry 落进 chat-thread-store。
 * 日程条目删除由 calendar.delete_task 在数据层完成，手机端日程页 refresh() 自然
 * 不再出现，无需在对话链路里另做一次删除。
 */

import type { TurnEffect } from "../render/types.js";
import {
  reminderRowFromReceipt,
  type ReminderConfirmRow,
} from "../render/scenes/reminder-confirm.scene.js";

interface ReminderCardEntry {
  messageId: string;
  card: Record<string, unknown>;
  taskIds: string[];
}

const entries = new Map<string, ReminderCardEntry>();

function key(actorId: string, taskId: string): string {
  return `${actorId}:${taskId}`;
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function reminderOf(card: Record<string, unknown>): Record<string, unknown> | null {
  const extra = card.extra;
  if (!extra || typeof extra !== "object" || Array.isArray(extra)) return null;
  const reminder = (extra as Record<string, unknown>).reminder;
  if (!reminder || typeof reminder !== "object" || Array.isArray(reminder)) return null;
  return reminder as Record<string, unknown>;
}

/** done 阶段登记本轮新建的确认卡（按 taskId 索引，供后续原地刷新）。 */
export function rememberReminderCards(
  actorId: string,
  messageId: string,
  cards: ReadonlyArray<Record<string, unknown>>,
): void {
  if (!actorId || !messageId) return;
  for (const card of cards) {
    if (card.cardType !== "reminder_confirm") continue;
    const reminder = reminderOf(card);
    const rawTaskIds = reminder?.taskIds;
    const taskIds = Array.isArray(rawTaskIds)
      ? rawTaskIds.filter((x): x is string => typeof x === "string" && x.length > 0)
      : [];
    if (taskIds.length === 0) continue;
    const entry: ReminderCardEntry = { messageId, card: clone(card), taskIds };
    for (const taskId of taskIds) entries.set(key(actorId, taskId), entry);
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** 本轮若有修改/删除成功回执，构造 card.update 的新卡载荷；否则返回 null。 */
export function buildReminderCardUpdate(
  actorId: string,
  effects: ReadonlyArray<TurnEffect>,
): { messageId: string; card: Record<string, unknown> } | null {
  for (const effect of effects) {
    if (effect.status !== "ok" || !effect.result) continue;
    const isDelete = effect.result.action === "delete_task";
    const isUpdate = effect.result.action === "update_task";
    if (!isDelete && !isUpdate) continue;

    const taskId = str(effect.result.taskId);
    const entry = entries.get(key(actorId, taskId));
    if (!entry) continue;

    const card = clone(entry.card);
    const reminder = reminderOf(card);
    if (!reminder) continue;

    const cancelled =
      isDelete || str(effect.result.status) === "cancelled" || effect.result.status === "cancelled";
    const rowStatus: "cancelled" | "updated" = cancelled ? "cancelled" : "updated";
    const rows = Array.isArray(reminder.rows)
      ? reminder.rows.filter(isRecord).map((r) => clone(r))
      : [];
    const freshRow = reminderRowFromReceipt(effect.result);
    let matched = false;
    for (const row of rows) {
      if (str(row.taskId) !== taskId) continue;
      matched = true;
      if (!cancelled && freshRow) {
        row.label = freshRow.label;
        row.time = freshRow.time;
        row.title = freshRow.title;
        row.at = freshRow.at;
      }
      row.status = rowStatus;
    }
    if (!matched) continue;

    // 单行卡直接改整卡状态；多行卡保留「已定好 N 条提醒」，只把命中行标灰。
    if (rows.length === 1) {
      reminder.status = rowStatus;
      card.title = cancelled ? "已取消提醒" : "已改为提醒";
    } else {
      reminder.status = "updated";
    }
    reminder.rows = rows as unknown as ReminderConfirmRow[];
    card.items = rows
      .filter(isRecord)
      .map((r) => ({ type: "text" as const, text: `${str(r.label)} ${str(r.time)} · ${str(r.title)}` }));
    // 每次刷新都把最新载荷写回索引，连续改两次不会用旧卡做基底
    for (const id of entry.taskIds) {
      entries.set(key(actorId, id), { messageId: entry.messageId, card: clone(card), taskIds: entry.taskIds });
    }
    return { messageId: entry.messageId, card };
  }
  return null;
}
