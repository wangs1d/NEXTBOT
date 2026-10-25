/**
 * 线程级上下文污染治愈（2026-10-23）。
 *
 * 两类污染会让模型"重复设置、重复回复"，都发生在**线程正文**里：
 *
 * ① **内部子调用泄漏**（根因，已在 schedule-intent-service 修源）
 *    日程解析/提醒文案这类内部 LLM 调用曾把主聊天 sessionId 直接交给 provider，
 *    且没置 ephemeralTurn，于是内部提示词被当"用户发言"push 进主线程、
 *    内部 JSON 被当"助手发言"落库。实证（Nextbot-dev/data/chat-threads.json）：
 *
 *      user:      你是提醒文案助手。用户让助手到点提醒自己做一件事…
 *      assistant: {"shortTitle":"去游泳","reminderMessage":"到点了，快去游泳吧"}
 *
 *    下一轮主模型看到"用户让我转写提醒文案"，会再走一遍提醒流程（重复设置）
 *    或对着 JSON 再说一遍（重复回复）。
 *
 * ② **同一句用户消息相邻重复**
 *    线程里出现两条一模一样的 user 消息（一条有 __ts、一条没有，来自旧版
 *    重复 push）。模型看到同一请求说两遍，就会做两遍。
 *
 * 本模块是**结构性**清洗（不做语义猜测）：只按「内部提示词签名 + 相邻同文」
 * 两个确定判据动手，供落盘加载时一次性治愈存量（新数据由写侧保证不再产生）。
 */

const DIALOG_ROLES = new Set(["user", "assistant"]);

/** 内部子调用的提示词特征：以"你是…"开头的指令体，且带强约束输出格式。 */
const INTERNAL_PROMPT_OPEN_RE =
  /^\s*你是[^\n]{0,30}(?:助手|解析器|处理器|验收员|评估器|判断器|审核员|分类器)/;
const INTERNAL_PROMPT_CONSTRAINT_RE =
  /只返回\s*JSON|输出严格\s*JSON|不要输出\s*markdown|不要任何其他文字|若无法解析，返回/;

/** 纯 JSON 对象正文（内部子调用的典型回复形态）。 */
const BARE_JSON_RE = /^\s*\{[\s\S]{0,800}\}\s*$/;

function plainText(msg: unknown): string {
  if (!msg || typeof msg !== "object") return "";
  const content = (msg as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const part = content.find(
      (p): p is { type?: string; text?: string } =>
        !!p && typeof p === "object" && (p as { type?: string }).type === "text",
    );
    return part?.text ?? "";
  }
  return "";
}

/** 是否内部子调用的提示词（被误写进线程的"假用户发言"）。 */
export function isInternalSubCallPrompt(text: string): boolean {
  const t = (text ?? "").trim();
  if (t.length < 30) return false;
  return INTERNAL_PROMPT_OPEN_RE.test(t) && INTERNAL_PROMPT_CONSTRAINT_RE.test(t);
}

export interface ThreadPollutionReport {
  messages: unknown[];
  /** 剔除的内部子调用轮数（user 提示词 + 其后的 JSON 回复） */
  removedInternalCalls: number;
  /** 合并掉的相邻重复用户消息数 */
  removedDuplicateUserTurns: number;
}

/**
 * 线程清洗（幂等）：先剔内部子调用轮，再合并相邻同文用户消息。
 * 返回新数组；无污染时**原数组引用返回**（调用方可据此判断是否需要写回）。
 */
export function sanitizeThreadPollution(msgs: unknown[]): ThreadPollutionReport {
  if (!Array.isArray(msgs) || msgs.length === 0) {
    return { messages: msgs, removedInternalCalls: 0, removedDuplicateUserTurns: 0 };
  }

  let removedInternalCalls = 0;
  const stripped: unknown[] = [];
  for (let i = 0; i < msgs.length; i++) {
    const msg = msgs[i] as { role?: string } | null;
    if (msg?.role === "user" && isInternalSubCallPrompt(plainText(msg))) {
      removedInternalCalls++;
      // 紧随其后的纯 JSON 回复（同一次子调用的产物）一并剔除
      const next = msgs[i + 1] as { role?: string } | null;
      if (next?.role === "assistant" && BARE_JSON_RE.test(plainText(next))) {
        i++;
      }
      continue;
    }
    stripped.push(msg);
  }

  // 相邻同文用户消息：保留有 __ts 的那条（时间锚优先），另一条丢弃。
  let removedDuplicateUserTurns = 0;
  const out: unknown[] = [];
  for (let i = 0; i < stripped.length; i++) {
    const cur = stripped[i] as { role?: string } | null;
    const prevKept = out[out.length - 1] as { role?: string } | null;
    if (
      cur?.role === "user" &&
      prevKept?.role === "user" &&
      stripForCompare(plainText(prevKept)) === stripForCompare(plainText(cur)) &&
      stripForCompare(plainText(cur)).length > 0
    ) {
      removedDuplicateUserTurns++;
      const prevHasTs = !!readTs(prevKept);
      const curHasTs = !!readTs(cur);
      // 当前条有锚、前一条没有 → 用当前条替换前一条；否则保留前一条（先到先得）
      if (!prevHasTs && curHasTs) out[out.length - 1] = cur;
      continue;
    }
    out.push(cur);
  }

  const changed = removedInternalCalls > 0 || removedDuplicateUserTurns > 0;
  return {
    messages: changed ? out : msgs,
    removedInternalCalls,
    removedDuplicateUserTurns,
  };
}

function readTs(msg: unknown): string {
  const v = (msg as Record<string, unknown> | null)?.["__ts"];
  return typeof v === "string" ? v : "";
}

/** 比较用正文：去掉时间帧/时间戳前缀与空白。 */
function stripForCompare(text: string): string {
  return text
    .replace(/^\[ts:[^\]]+\]\s*/i, "")
    .replace(/^\[timeframe:[^\]]+\]\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** 便于诊断：只报数量不返回内容。 */
export function countThreadPollution(msgs: unknown[]): {
  internalCalls: number;
  duplicateUserTurns: number;
} {
  const msgsArr = Array.isArray(msgs) ? msgs : [];
  let internalCalls = 0;
  let duplicateUserTurns = 0;
  let prevUserText = "";
  let prevWasUser = false;
  for (const msg of msgsArr) {
    const m = msg as { role?: string } | null;
    if (!m || !DIALOG_ROLES.has(String(m.role))) {
      prevWasUser = false;
      continue;
    }
    const text = plainText(m);
    if (m.role === "user" && isInternalSubCallPrompt(text)) {
      internalCalls++;
      prevWasUser = false;
      continue;
    }
    if (m.role === "user") {
      const normalized = stripForCompare(text);
      if (prevWasUser && normalized && normalized === prevUserText) duplicateUserTurns++;
      prevUserText = normalized;
      prevWasUser = true;
    } else {
      prevWasUser = false;
    }
  }
  return { internalCalls, duplicateUserTurns };
}
