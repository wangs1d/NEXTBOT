/**
 * 记忆行注入卫生（2026-10-23 根修：新对话把上一次对话的具体句子带进上下文）。
 *
 * 事故形态（生产数据实证，data/agent-memory-sync.json）：
 *
 *   memory_summary =
 *     [2026-10-21T02:08:12.663Z] [topic:general] [Agent 承诺/结论] 不知道，我这儿只有你的邮箱…
 *     [11:15] Agent: [RENDER_HINT:structured] 王哥，我这些手段真不少…
 *     [15:34] Agent: 提醒已经设好了，一分钟后就会提醒你：该睡觉啦
 *     [17:36] 用户: 四分分钟后提醒我去游泳吧
 *
 * 这些行有三个结构性问题：
 *  1. 是**逐字对话**（`[时刻] 角色: 内容`），本应只存在 turn-wal/journal，长期库里
 *     没有存在权——一旦注入，模型就把旧对话当成"我们刚说过的"接着说；
 *  2. 时间标签只有钟点（`[11:15]`），没有日期——跨天混排后无法定位，模型只能
 *     默认"这是今天"，正是「所有的锚点只存在今天」的来源；
 *  3. 夹带出口协议残留（`[RENDER_HINT:structured]`），属内部渲染指令。
 *
 * 写入侧的洞已由 ltm-write-gate 补上（新数据不再产生），但**存量脏行仍在库里**。
 * 本模块是读取侧的兜底：注入视图逐行体检，命中即从视图剔除，存储一字不动
 * （与 recap 视图层加工同哲学：存储不动、视图净化、无命中时字节恒定以保 prefix cache）。
 */

/** 行首时间标签：`[11:15]` / `[11:15:30]` / `[2026-10-21T02:08:12.663Z]` / `[2026/10/08 周四 22:07]` / `[10-21 11:15]`。 */
const LEADING_TIME_LABEL_RE =
  /^\[\s*(?:\d{1,2}[:：]\d{2}(?:[:：]\d{2})?|\d{4}[-/]\d{1,2}[-/]\d{1,2}[^\]]{0,24}|\d{1,2}[-/]\d{1,2}\s+\d{1,2}[:：]\d{2})\s*\]\s*/;

/** 行首话题标签：`[topic:calendar]`。 */
const LEADING_TOPIC_LABEL_RE = /^\[\s*topic\s*:[^\]]*\]\s*/i;

/** 其他已知行首标记（保留语义、仅用于剥掉后再判角色）。 */
const LEADING_MARKER_RE =
  /^\[\s*(?:Agent\s*承诺\s*\/\s*结论|用户要求记住|用户偏好|用户事实|关键钉|fast-path|decay|reject|remember)\s*\]\s*/;

/**
 * 「Agent 原话」标记：`[Agent 承诺/结论]` 是 memory-signal 给**助手第一句**打的前缀，
 * 内容就是助手说过的话（生产数据里是「不知道，我这儿只有你的邮箱…」这类寒暄残句）。
 * 它带标记却不是事实句，注入后照样是"复述上一次对话"——按逐字对话处理。
 */
const AGENT_UTTERANCE_MARKER_RE = /^\[\s*Agent\s*承诺\s*\/\s*结论\s*\]/;

/** 逐字对话行：`用户:` / `Agent:` / `助手:` / `fact:`（生产数据里确实出现过 fact 角色）。 */
const DIALOG_LINE_RE = /^(?:用户|user|助手|assistant|Agent|AI|fact|U|A)\s*[:：]/i;

/** 出口协议 / 视图提示残留：属于内部渲染指令，不是记忆内容。 */
const RESIDUE_RE = /\[RENDER_HINT|\[NEXT_UP|\[FU\||（本块为历史摘要/;

/** 剥掉行首的标签栈（时间 → 话题 → 标记），只用于判定，不改变保留行的原文。 */
function probeOf(line: string): string {
  let probe = line.trim();
  for (let i = 0; i < 4; i++) {
    const next = probe
      .replace(LEADING_TIME_LABEL_RE, "")
      .replace(LEADING_TOPIC_LABEL_RE, "")
      .replace(LEADING_MARKER_RE, "")
      .trim();
    if (next === probe) break;
    probe = next;
  }
  return probe;
}

/**
 * 单行是否应从注入视图剔除。
 * 判据全部是结构性的（角色前缀 / 协议残留），不做语义猜测。
 */
export function isPollutedMemoryLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  if (RESIDUE_RE.test(trimmed)) return true;
  // 剥时间/话题标签后若还是「Agent 原话」标记 → 助手自己说过的话，不是事实
  const withoutStamp = trimmed
    .replace(LEADING_TIME_LABEL_RE, "")
    .replace(LEADING_TOPIC_LABEL_RE, "")
    .trim();
  if (AGENT_UTTERANCE_MARKER_RE.test(withoutStamp)) return true;
  const probe = probeOf(trimmed);
  if (!probe) return true; // 只剩标签的残行
  return DIALOG_LINE_RE.test(probe);
}

export interface MemoryLineHygieneResult {
  /** 净化后的文本；无剔除时与入参**同一字符串**（字节恒定，护 prefix cache）。 */
  text: string;
  /** 被剔除的行数（0 表示视图与存储一致） */
  dropped: number;
  /** 被剔除的行原文（诊断 / 存量清理报告复用） */
  droppedLines: string[];
}

/**
 * 记忆块级净化：逐行剔除逐字对话行与协议残留，保留其余行及其原始标签
 * （绝对时间标签是时间锚，必须保留）。
 */
export function sanitizeMemoryLinesForPrompt(raw: string | null | undefined): MemoryLineHygieneResult {
  if (typeof raw !== "string" || !raw) return { text: "", dropped: 0, droppedLines: [] };
  const lines = raw.split("\n");
  const kept: string[] = [];
  const droppedLines: string[] = [];
  for (const line of lines) {
    if (isPollutedMemoryLine(line)) {
      droppedLines.push(line);
      continue;
    }
    kept.push(line);
  }
  if (droppedLines.length === 0) return { text: raw, dropped: 0, droppedLines };
  return { text: kept.join("\n"), dropped: droppedLines.length, droppedLines };
}
