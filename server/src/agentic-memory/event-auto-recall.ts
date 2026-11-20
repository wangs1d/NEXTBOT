/**
 * 对话面「按需」事件召回：只在模型判定用户有回溯/回忆意图、且能命中真实事件时，
 * 往动态层注一个带龄期的【事件回忆】块（≤6 行）。
 *
 * 约束：
 *  - 触发只看 TurnUnderstanding（recallIntent / reference=earlier_session）。
 *    理解缺省（路由失败）→ 零注入：误注入=翻旧账串台，漏注入=少点可选上下文；
 *  - 不进稳定前缀（每轮随话题变，进稳定层会打断前缀缓存）；
 *  - 没有命中就零注入，不制造「翻旧账」；
 *  - 只给结果行，不向用户暴露检索过程（块内自带使用口径）。
 */

import type { TurnUnderstanding } from "../agent/task-router.js";
import { isEventMemoryRecallEnabled } from "./env.js";
import { extractModelEntities } from "./event-builder.js";
import { formatEventLine } from "./event-recall.js";
import { getEventMemoryStore, type RecalledEvent } from "./event-store.js";

const LOOKBACK_DAYS = 365;
const MAX_LINES = 6;

/** 回溯语句里的领域词 → 事件类型：只做同一次召回内的检索收窄，不参与触发判定。 */
const INTENT_KINDS: Array<[RegExp, string[]]> = [
  [/比价|价格|多少钱|便宜|降价|报价/, ["price_compare"]],
  [/天气|气温|下雨|降温|穿什么/, ["weather_query"]],
  [/日程|安排|提醒|会议|约了|订了/, ["schedule_write", "schedule_query"]],
  [/行程|旅游|攻略|旅行|出游|玩了/, ["travel_plan", "travel_query"]],
  [/搜|查过|找过|看过/, ["web_search"]],
  [/打车|叫车/, ["ride"]],
  [/点过|点了|订单|买了|下单/, ["order"]],
];

/** 主事件优先：同一实体下 chat_turn 只作补充，避免闲聊行挤掉真正的动作记录。 */
function prioritize(events: RecalledEvent[]): RecalledEvent[] {
  const seen = new Set<string>();
  const deduped = events.filter((event) => {
    const key = `${event.kind}|${event.entities[0] ?? event.userText.slice(0, 20)}|${event.payload?.minPriceCny ?? ""}|${event.status}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return [...deduped].sort((a, b) => {
    const aChat = a.kind === "chat_turn" ? 1 : 0;
    const bChat = b.kind === "chat_turn" ? 1 : 0;
    if (aChat !== bChat) return aChat - bChat;
    return b.eventTime.localeCompare(a.eventTime);
  });
}

/**
 * 生成【事件回忆】块；无回溯意图、无理解或无命中返回 undefined（零注入）。
 * 纯同步 SQLite 读，µs~ms 级。
 */
export function buildEventRecallBlock(
  actorId: string,
  userText: string,
  understanding: TurnUnderstanding | undefined,
  now = Date.now(),
): string | undefined {
  if (!isEventMemoryRecallEnabled()) return undefined;
  const text = userText.trim();
  if (!text || !understanding) return undefined;
  if (!understanding.recallIntent && understanding.reference !== "earlier_session") return undefined;
  const store = getEventMemoryStore();
  if (!store) return undefined;

  const from = new Date(now - LOOKBACK_DAYS * 86_400_000).toISOString();
  const entities = extractModelEntities(text);
  let events = entities.length > 0
    ? store.recallEvents({ actorId, from, entities, limit: 12 })
    : [];
  if (events.length === 0) {
    const kinds = INTENT_KINDS.find(([re]) => re.test(text))?.[1];
    if (kinds) events = store.recallEvents({ actorId, from, kinds, limit: 12 });
  }
  if (events.length === 0) {
    events = store.recallEvents({ actorId, from, query: text, limit: 12 });
  }
  if (events.length === 0) return undefined;

  const lines = prioritize(events)
    .slice(0, MAX_LINES)
    .map((event) => formatEventLine(event, now));
  return [
    "【事件回忆】",
    "（你真实做过的事，按发生时间排列；仅用于回答用户对往事的询问，不主动翻旧账，不要提检索过程）",
    ...lines.map((line) => `- ${line}`),
  ].join("\n");
}
