// 按需时间上下文闸（2026-10-06「时间戳不常驻 prompt」根修）。
//
// 此前每轮对话固定注入两块时间信息：【当前时间】动态块 +【对话时间轴】system 块
// （最多 24 行绝对时间）。闲聊轮用不上却每轮全价计费，且给了模型「随口报精确
// 时刻」的假锚——recap/时间轴旧时间戳被当「现在」引用（「两点差十分」事故家族）。
//
// 本闸改为按需放行：仅当本轮用户消息显式涉及时刻/日期/时长/定时动作时，
// 两块时间信息才进入 prompt；历史时间载体（线程 [ts:] 帧）存储层不动，
// 视图层剥离照旧（buildTimestampFreeLlmView）。
//
// 放行判定 + 会话保持（hold latch）：时间话题往往跨多轮（「明天三点提醒我」
// →「好」→「到点别忘」），判定命中后本会话保持放行 10 分钟，避免相邻轮在
// 「有时间块/无时间块」间抖动打碎 prefix cache。
//
// 两个消费方必须对同一轮给出同一判定，均走 resolveTimeContextAccess：
//  - abstract-chat-provider（【对话时间轴】是否注入）
//  - prompt-context-builder（【当前时间】块是否注入）

/** 放行后的会话保持时长：时间话题跨轮期间不反复开关。 */
const HOLD_MS = 10 * 60_000;

/** kill switch：置 0 恢复「每轮必注入时间信息」的旧行为。 */
function onDemandEnabled(): boolean {
  return process.env.AGENT_TIME_CONTEXT_ON_DEMAND !== "0";
}

/**
 * 显式时间信号词表（宁缺勿滥：闸的默认态是关，误开=退回常驻）。
 * - 时刻/日期询问：几点/什么时间/日期/几号/星期几…
 * - 时长跨度：多久/多少天/多少小时…
 * - 钟点锚（「八点叫我」「两点半有个会」——判断已过/今天明天需要 now）：
 *   1-23 点 + 可选 半/一刻/整/N分，或 HH:MM 数字形态
 * - 定时动作：提醒我/闹钟/叫醒/倒计时/定时
 * 「今天/明天/昨天」单独出现**不**开闸（闲聊高频词；日程/提醒语义已被
 * 钟点锚与定时动作覆盖）。
 */
const TIME_SIGNAL_RE =
  /(几点|什么时间|啥时间|多少点|现在时间|当前时间|日期|几号|多少号|星期几|周几|礼拜几)/i;
const TIME_SPAN_RE =
  /(多久|多长时间|多少天|多少年|多少个月|多少周|多少小时|多少分钟|几天|几周年)/i;
// 钟点锚三形态：带分钟后缀（任意 hour：八点半/8点20/十二点整）、裸钟点（歧义排除：
// 「一点」单独出现多为副词——「有一点」「这一点」——不放行；两点/8点/12点照常）、
// HH:MM 数字形态。
const CLOCK_ANCHOR_RE = new RegExp(
  [
    "(?:(?:[01]?\\d|2[0-3]|二十[一二三四五六七八九]?|十[一二三四五六七八九]?|[一二两三四五六七八九])点(?:半|一刻|三刻|整|[0-5]?\\d分?))",
    "(?:(?:1\\d|2[0-3]|[02-9]|二十[一二三四五六七八九]?|十[一二三四五六七八九]?|[二两三四五六七八九])点)",
    "(?:(?:[01]?\\d|2[0-3])[:：][0-5]\\d)",
  ].join("|"),
);
const TIMED_ACTION_RE = /(提醒我|闹钟|叫(?:我)?醒|叫我起床|倒计时|定时|截到|截止)/i;
const TIME_EN_RE = /\b(what time|what day|what'?s the date|how long)\b/i;

/**
 * 回忆 / 时间指涉（2026-10-19 时间认知补齐）：
 * 用户谈过去经历、旧事、变化（"我以前住浙江""上次说的那个""后来搬家了"）时，
 * 必须知道「这些话分别发生在什么时候」，否则会把旧时刻当成现状、把多年前的事
 * 当这两天的。这类轮次放行【对话时间轴】——按需闸的默认态仍是关，只扩触发面。
 */
const PAST_RECALL_RE =
  /(以前|之前|原来|曾经|从前|过去|那天|那次|上次|当年|小时候|上学时|读书时|大学时|刚工作|前段时间|前几天|上个月|去年|前年|搬家|迁居|换工作|跳槽|后来|used to|previously|last time)/i;

/** 本轮用户消息是否显式需要时间上下文。 */
export function turnRequestsTimeContext(userText: string | undefined): boolean {
  const t = userText?.trim() ?? "";
  if (!t) return false;
  return (
    TIME_SIGNAL_RE.test(t) ||
    TIME_SPAN_RE.test(t) ||
    CLOCK_ANCHOR_RE.test(t) ||
    TIMED_ACTION_RE.test(t) ||
    TIME_EN_RE.test(t) ||
    PAST_RECALL_RE.test(t)
  );
}

/** 会话保持表：key → 放行截止时刻。 */
const holdUntil = new Map<string, number>();
const HOLD_MAP_MAX = 512;

function pruneHolds(now: number): void {
  if (holdUntil.size < 64) return;
  for (const [k, exp] of holdUntil) {
    if (exp <= now) holdUntil.delete(k);
  }
  if (holdUntil.size > HOLD_MAP_MAX) {
    // 极端堆积防御：全清（代价只是一次缓存冷启动，不丢正确性）。
    holdUntil.clear();
  }
}

/**
 * 本轮是否放行时间上下文（两个消费方每轮各调一次，判定含副作用：
 * 命中信号或保持期内都会续写保持截止时刻）。
 * @param key 会话键（主聊天 = actorId = 线程 sessionId）
 */
export function resolveTimeContextAccess(
  key: string,
  userText: string | undefined,
  now: Date = new Date(),
): boolean {
  if (!onDemandEnabled()) return true;
  const nowMs = now.getTime();
  pruneHolds(nowMs);
  if (turnRequestsTimeContext(userText)) {
    holdUntil.set(key, nowMs + HOLD_MS);
    return true;
  }
  const exp = holdUntil.get(key);
  if (exp !== undefined && exp > nowMs) {
    holdUntil.set(key, nowMs + HOLD_MS); // 保持期内滑动续期
    return true;
  }
  return false;
}

/** 仅测试用：清空保持表。 */
export function resetTimeContextHoldForTests(): void {
  holdUntil.clear();
}
