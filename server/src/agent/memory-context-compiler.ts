/**
 * 记忆上下文编译器（读侧唯一裁决）。
 *
 * 目标形态：所有记忆候选块 → 三个编译块，总量 1200 字（中文近似 1 字 ≈ 1 token）：
 *   - 当前状态 ≤500：称呼/城市/沟通偏好/禁忌等当前值，来源权威 facts > 理解 >
 *     关系 > 画像，跨源同值只出现一次；
 *   - 在办 ≤300：未完成任务/承诺最多 3 条，每条带龄期；
 *   - 按需回忆 ≤400：事件/叙事召回最多 5 行，只在召回闸放行时才有内容。
 *
 * 上游各块（userFacts / userUnderstanding / lifeRelations / userProfile* /
 * memorySummary / memoryCommitments / memoryOpenLoops / eventRecall /
 * narrativeRecall / activeGoals）编译后一律清空——它们只是候选源，不是注入位。
 * 超预算整块丢弃（回忆 → 在办 → 当前状态逐级让位），不做半截截断。
 */

import type { AgentPromptMemoryContext } from "../external-model/types.js";
import { semanticFingerprint } from "../services/memory-record-utils.js";

type MemoryTextField = {
  [K in keyof AgentPromptMemoryContext]-?: AgentPromptMemoryContext[K] extends string | undefined
    ? string extends NonNullable<AgentPromptMemoryContext[K]>
      ? K
      : never
    : never;
}[keyof AgentPromptMemoryContext];

type MemoryField = MemoryTextField;

export const MEMORY_COMPILED_BLOCKS = {
  currentState: "memoryCurrentState",
  pending: "memoryPending",
  recall: "memoryRecall",
} as const satisfies Record<string, MemoryField>;

/** 三块总预算；单块上限写死（1200 = 500 + 300 + 400）。 */
const TOTAL_BUDGET_CHARS = 1200;
const STATE_BUDGET_CHARS = 500;
const PENDING_BUDGET_CHARS = 300;
const RECALL_BUDGET_CHARS = 400;

const PENDING_MAX_ITEMS = 3;
const RECALL_MAX_LINES = 5;
const ENTRY_MAX_CHARS = 140;

/** 编译前的候选源；顺序即权威序（先占先得，后出现同值被丢弃）。 */
const STATE_SOURCES: ReadonlyArray<{ field: MemoryField; maxLines: number }> = [
  { field: "userFacts", maxLines: 10 },
  { field: "userUnderstanding", maxLines: 6 },
  { field: "lifeRelations", maxLines: 4 },
  { field: "userProfileSummary", maxLines: 8 },
  { field: "userProfile", maxLines: 4 },
];

const PENDING_SOURCES: readonly MemoryField[] = [
  "memoryOpenLoops",
  "memoryCommitments",
  "activeGoals",
];

const RECALL_SOURCES: readonly MemoryField[] = [
  "tailFactsRecall",
  "eventRecall",
  "narrativeRecall",
];

/** 编译完成后必须清空的候选字段（防止旧渲染路径二次注入）。 */
const CONSUMED_FIELDS: readonly MemoryField[] = [
  ...STATE_SOURCES.map((s) => s.field),
  "memorySummary",
  "memoryPreferences",
  "memoryFacts",
  ...PENDING_SOURCES,
  ...RECALL_SOURCES,
];

/** 当前状态里不成立的条目：历史值/计划值不属于「现状」，留给事实库按需查。 */
const NON_CURRENT_MARKERS = /〔历史〕|〔计划〕|〔原计划〕|〔当前未知〕/;

/** 行尾的推理辅助标注，编译块只需要干净的事实句。 */
function stripLineAnnotations(line: string): string {
  return line
    .replace(/\s*←\s*本轮提问相关.*$/g, "")
    .replace(/\s*〔[^〕]*〕/g, "")
    .replace(/\s*（\d{1,2}\/\d{1,2}\s*记录[^）]*）/g, "")
    .replace(/\s*（此前：[^）]*）/g, "")
    .replace(/\s*（\d{1,2}\/\d{1,2}\s*确认）/g, "")
    .replace(/\s*理解演变：.*$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isInstructionLine(text: string): boolean {
  return (
    text.startsWith("【") ||
    text.startsWith("（") ||
    text.startsWith("(") ||
    text.startsWith("#") ||
    text.startsWith(">") ||
    text.startsWith("|")
  );
}

/** 从候选块里抽条目行：支持「- x」「* x」与「字段：值」两种写法。 */
function extractEntries(block: string, maxLines: number): string[] {
  const out: string[] = [];
  for (const raw of block.split("\n")) {
    if (out.length >= maxLines) break;
    const text = raw.trim();
    if (!text || isInstructionLine(text)) continue;
    // narrativeRecall 的条目带「r12|」检索序号，注入位只留内容
    const stripped = text.replace(/^[-*]\s+/, "").replace(/^r\d+\|/, "");
    if (NON_CURRENT_MARKERS.test(stripped)) continue;
    const looksLikeField = !stripped.startsWith("**") && /[：:]/.test(stripped);
    if (stripped === text && !looksLikeField) continue;
    const clean = stripLineAnnotations(stripped);
    if (clean.length < 4 || clean.length > ENTRY_MAX_CHARS) continue;
    out.push(clean);
  }
  return out;
}

function dayStamp(now: number): string {
  const d = new Date(now);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

/** 在办条目的龄期：优先用条目自带日期（10/24、2026-10-24），没有就按天龄。 */
function withAge(item: string, now: number): string {
  if (/逾期|截止|今天|明天|昨天/.test(item)) return item;
  const iso = item.match(/\b(20\d{2})-(\d{2})-(\d{2})\b/);
  const short = item.match(/(?:^|[^\d])(\d{1,2})\/(\d{1,2})(?:[^\d]|$)/);
  let at: number | null = null;
  if (iso) {
    at = Date.parse(`${iso[1]}-${iso[2]}-${iso[3]}T00:00:00`);
  } else if (short) {
    at = Date.parse(`${new Date(now).getFullYear()}-${short[1]}-${short[2]}T00:00:00`);
  }
  if (at == null || !Number.isFinite(at)) return item;
  const days = Math.max(0, Math.floor((now - at) / 86_400_000));
  return `${item}（${days > 0 ? `${days} 天前` : "今天"}）`;
}

function joinWithinBudget(
  header: string,
  rule: string,
  lines: string[],
  budgetChars: number,
): string | undefined {
  if (lines.length === 0) return undefined;
  const head = `${header}\n${rule}`;
  const kept: string[] = [];
  let size = head.length;
  for (const line of lines) {
    const rendered = `\n- ${line}`;
    if (size + rendered.length > budgetChars) break;
    kept.push(rendered);
    size += rendered.length;
  }
  if (kept.length === 0) return undefined;
  return head + kept.join("");
}

export type CompiledMemoryContext = {
  memory: AgentPromptMemoryContext;
  /** 因总预算被丢弃的编译块（按丢弃顺序） */
  droppedFields: Array<(typeof MEMORY_COMPILED_BLOCKS)[keyof typeof MEMORY_COMPILED_BLOCKS]>;
  dedupedLines: number;
  /** 三块最终合计字符数 */
  chars: number;
  budgetChars: number;
};

/**
 * 编译记忆上下文：候选源 → 三块。输入对象不被修改。
 * 无任何候选时原样返回（零开销）。
 */
export function compileMemoryContext(
  memory: AgentPromptMemoryContext,
  now = Date.now(),
  budgetChars = TOTAL_BUDGET_CHARS,
): CompiledMemoryContext {
  const totalBudget = Math.max(0, Math.floor(budgetChars));
  const stateBudget = Math.floor(totalBudget * (STATE_BUDGET_CHARS / TOTAL_BUDGET_CHARS));
  const pendingBudget = Math.floor(totalBudget * (PENDING_BUDGET_CHARS / TOTAL_BUDGET_CHARS));
  const recallBudget = totalBudget - stateBudget - pendingBudget;
  const out: AgentPromptMemoryContext = { ...memory };
  const claimed = new Set<string>();
  let dedupedLines = 0;

  const stateLines: string[] = [];
  for (const source of STATE_SOURCES) {
    const block = out[source.field];
    if (typeof block !== "string" || !block.trim()) continue;
    for (const entry of extractEntries(block, source.maxLines)) {
      const fingerprint = semanticFingerprint(entry);
      if (fingerprint && claimed.has(fingerprint)) {
        dedupedLines += 1;
        continue;
      }
      if (fingerprint) claimed.add(fingerprint);
      stateLines.push(entry);
    }
  }

  const pendingLines: string[] = [];
  for (const field of PENDING_SOURCES) {
    const block = out[field];
    if (typeof block !== "string" || !block.trim()) continue;
    for (const entry of extractEntries(block, PENDING_MAX_ITEMS)) {
      const fingerprint = semanticFingerprint(entry);
      if (fingerprint && claimed.has(fingerprint)) {
        dedupedLines += 1;
        continue;
      }
      if (fingerprint) claimed.add(fingerprint);
      if (pendingLines.length < PENDING_MAX_ITEMS) pendingLines.push(withAge(entry, now));
    }
  }

  const recallLines: string[] = [];
  for (const field of RECALL_SOURCES) {
    const block = out[field];
    if (typeof block !== "string" || !block.trim()) continue;
    for (const entry of extractEntries(block, RECALL_MAX_LINES)) {
      const fingerprint = semanticFingerprint(entry);
      if (fingerprint && claimed.has(fingerprint)) {
        dedupedLines += 1;
        continue;
      }
      if (fingerprint) claimed.add(fingerprint);
      if (recallLines.length < RECALL_MAX_LINES) recallLines.push(entry);
    }
  }

  const currentState = joinWithinBudget(
    "【当前状态】",
    "（背景事实，不是朗读清单：只答用户问到的那一项，不连带罗列；与最新消息冲突以最新消息为准）",
    stateLines,
    stateBudget,
  );
  const pending = joinWithinBudget(
    "【在办】",
    "（未完成的事，按紧迫度排列；括号里是开始距今，用户问起时按此如实回答）",
    pendingLines,
    pendingBudget,
  );
  const recall = joinWithinBudget(
    "【按需回忆】",
    `（截至 ${dayStamp(now)} 的真实历史；仅用于回答对往事的询问，不主动翻旧账，不提检索过程）`,
    recallLines,
    recallBudget,
  );

  let [keptState, keptPending, keptRecall] = [currentState, pending, recall];
  let chars = (keptState?.length ?? 0) + (keptPending?.length ?? 0) + (keptRecall?.length ?? 0);
  const droppedFields: CompiledMemoryContext["droppedFields"] = [];
  // 总预算兜底：按「回忆 → 在办 → 当前状态」整块丢弃。
  if (chars > totalBudget && keptRecall) {
    chars -= keptRecall.length;
    droppedFields.push(MEMORY_COMPILED_BLOCKS.recall);
    keptRecall = undefined;
  }
  if (chars > totalBudget && keptPending) {
    chars -= keptPending.length;
    droppedFields.push(MEMORY_COMPILED_BLOCKS.pending);
    keptPending = undefined;
  }
  if (chars > totalBudget && keptState) {
    chars -= keptState.length;
    droppedFields.push(MEMORY_COMPILED_BLOCKS.currentState);
    keptState = undefined;
  }

  for (const field of CONSUMED_FIELDS) out[field] = undefined;
  out.memoryCurrentState = keptState;
  out.memoryPending = keptPending;
  out.memoryRecall = keptRecall;

  return { memory: out, droppedFields, dedupedLines, chars, budgetChars: totalBudget };
}