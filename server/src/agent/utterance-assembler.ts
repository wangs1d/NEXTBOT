/**
 * UtteranceAssembler —— 发言模型（2026-10-09 定稿，重复回复根源修复）
 *
 * 背景（事故形态）：一次用户消息「以后叫我王爷」在客户端出现两条助手消息：
 * 「好的王爷，记下了。」+「好的王爷，已经记上啦。」
 *
 * 根因不是模型复读，而是系统缺少「发言（Utterance）」这一层抽象：
 *   1. 工具调用前的**过程话**与工具执行后的**结论**都走"面向用户发言"的同一出口
 *      （openai-compatible-tool-loop.ts 的波内直推 + 工具波前导话透出）；
 *   2. 展示身份（messageId）由分泡器**按段**分配（bubble-tracker.ts），
 *      于是一段文本 = 一条消息；
 *   3. 客户端按 messageId 建条目，每个泡独立成条（独立头像/名字）。
 *
 * 本模块把概念拆开并强制不变量（每个不变量都有单测对应，见
 * test/utterance-assembler.test.ts）：
 *   I1 一 turn 一发言：一个 turn 只产生一条 utterance（身份 = utteranceId）。
 *   I2 多波同源：turn 内所有面向用户的文本只能追加到同一 utterance，不得新开身份。
 *   I3 过程话不独立成言：过程话是 utterance 的一个分段（或按策略裁掉），不单独成言。
 *   I4 分段不改变身份：分段数量不改变 utterance 身份（展示侧多泡同条）。
 *   I5 turn 级幂等：由调用方（入口去重 + 落库幂等）保证，见 WS handler 与 ChatThreadStore。
 *
 * 角色划分是**时间性**的，不依赖工具语义猜测：任何在"本轮首个工具开始执行"之前
 * 产出的文本 = 过程话（preamble），之后产出的文本 = 结论（conclusion）。
 * 结算（settle）在过程话与结论**语义等价或过程话无实质内容**时裁掉过程话，
 * 由展示侧塌缩成单条发言（复用既有 finalTextReplacesStream 通道）。
 *
 * 纯逻辑模块：不碰 socket、不碰存储，可独立单测。
 */
import { normalizeSentence, stripSentencesAlreadySaid } from "../utils/text.js";
import { isBookkeepingOnlyToolSet } from "./synthesis-strategy.js";

/** 分段角色：过程话 / 结论 / 补充（确定性收口补推的残差等） */
export type UtteranceSegmentRole = "preamble" | "conclusion" | "supplement";

/** 塌缩原因（用于日志与回归断言） */
export type UtteranceCollapseReason =
  | "none"
  | "preamble_equals_conclusion"
  | "preamble_non_substantive_in_bookkeeping";

export interface UtteranceSegment {
  /** 展示分段序号（自 1 起，对应客户端气泡序） */
  index: number;
  role: UtteranceSegmentRole;
  text: string;
}

export interface UtteranceSettlement {
  utteranceId: string;
  /** 全部登记分段（含被裁掉的，便于观测与回归） */
  segments: UtteranceSegment[];
  /** 定稿保留的分段（塌缩时不含过程话） */
  kept: UtteranceSegment[];
  /** 被裁掉的分段序号 */
  droppedSegmentIndexes: number[];
  /** 是否要求展示侧塌缩为单条发言 */
  collapse: boolean;
  collapseReason: UtteranceCollapseReason;
  /** 本轮是否只有记账型工具（无真实检索内容） */
  bookkeepingOnly: boolean;
}

/** 标点 / 符号 / emoji：语义比较前剥离（形态差异不算差异）。 */
const NOISE_RE =
  /[\s，,。.！!？?；;：:、"'“”‘’`（）()【】\[\]{}<>《》〈〉—\-–~·…*+=|\\/@#$%^&_]/gu;
const EMOJI_RE = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{2190}-\u{21FF}]/gu;

/** 语义比较用的归一形式：去空白、小写、去标点、去 emoji。 */
export function normalizeForCompare(text: string): string {
  return normalizeSentence(text).replace(NOISE_RE, "").replace(EMOJI_RE, "");
}

/**
 * 短确认（ack）句式：这类话在任何一轮都不承载新信息。
 * 「好的王爷，记下了。」「已经记上啦」「收到」「嗯」。
 */
const ACK_RE =
  /^(好的?|嗯+|哦+|行|可以|收到|明白|了解|知道|记下|记上|记住|记住了|已(经)?(记|写|更新|记录|存|改)|好嘞|没问题|搞定|okay?|ok|gotit|sure)/;

/**
 * 过程话句式：只描述"我要去做某事"，不承载外部信息。
 * 只在记账轮参与塌缩判定——检索轮的过程话有价值（用户不必干等），必须保留。
 *
 * 判定 = 剥掉主语/帮衬词前缀后，剩下的第一个动词是行动动词，且文本里
 * 没有具体信息（不出现数字）。"我帮您查一下" → 过程话；
 * "我改了你的日程，明天 10 点开会" → 有具体信息，不算。
 */
const PROCESS_TALK_PREFIX_RE =
  /^(?:好的?|嗯|那么|那|先|这就|马上|稍等|等等|我|让|帮|给|替|你|您|为|来|去)+/;
const PROCESS_TALK_VERB_RE =
  /^(?:看|查|翻|找|调|更新|改|写|记|处理|确认|核实|安排|整理|搜|弄|加上|去掉)/;
const DIGIT_RE = /\d/;

/** 短确认判定：归一后不超过阈值且命中确认句式。 */
export function isAckLike(text: string, maxChars = 30): boolean {
  const n = normalizeForCompare(text);
  if (!n) return false;
  if (n.length > maxChars) return false;
  if (/[?？]/.test(text)) return false;
  return ACK_RE.test(n);
}

/** 过程话判定：只描述动作、不承载具体信息。 */
export function isProcessTalk(text: string, maxChars = 24): boolean {
  const n = normalizeForCompare(text);
  if (!n) return false;
  if (n.length > maxChars) return false;
  if (/[?？]/.test(text)) return false;
  if (DIGIT_RE.test(n)) return false;
  return PROCESS_TALK_VERB_RE.test(n.replace(PROCESS_TALK_PREFIX_RE, ""));
}

/** 两段文本是否语义等价（归一相等，或一方完全被另一方覆盖）。 */
export function isSemanticallyEquivalent(a: string, b: string): boolean {
  const na = normalizeForCompare(a);
  const nb = normalizeForCompare(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  // 句级视角：短的那段若整体被长的覆盖，视为等价复述
  const shorter = na.length <= nb.length ? a : b;
  const longer = na.length <= nb.length ? b : a;
  if (normalizeForCompare(shorter).length < 4) return false;
  return stripSentencesAlreadySaid(longer, shorter).trim() === "";
}

export interface UtteranceAssemblerOptions {
  /** 本次发言身份（= 本轮 traceId，客户端据此归组为一条消息） */
  utteranceId: string;
}

/**
 * 单个 turn 的发言装配器。生命周期：turn 开始构造 → 分段逐段登记 →
 * 工具开始执行时打过程话截止标记 → turn 结束 settle 定稿。
 */
export class UtteranceAssembler {
  private readonly segments: UtteranceSegment[] = [];
  private readonly toolNames: string[] = [];
  /** 本轮首个工具开始执行的时刻：过程话阶段在此截止 */
  private toolPhaseStarted = false;
  private nextIndex = 1;

  constructor(private readonly opts: UtteranceAssemblerOptions) {}

  get utteranceId(): string {
    return this.opts.utteranceId;
  }

  /** 已登记分段数（含被裁掉候选）。 */
  get segmentCount(): number {
    return this.segments.length;
  }

  get toolNameList(): string[] {
    return [...this.toolNames];
  }

  /** 是否只有记账型工具（无真实检索内容）。 */
  get bookkeepingOnly(): boolean {
    return isBookkeepingOnlyToolSet(this.toolNames);
  }

  /**
   * 登记一个已出站的分段。角色自动判定：
   * 首个工具开始执行之前 = preamble；之后 = conclusion；显式传入时以传入为准。
   * 返回该分段在发言内的序号（即展示分段索引）。
   */
  noteEmitted(text: string, role?: UtteranceSegmentRole): number {
    const trimmed = text.trim();
    if (!trimmed) return this.nextIndex - 1;
    const resolvedRole: UtteranceSegmentRole =
      role ?? (this.toolPhaseStarted ? "conclusion" : "preamble");
    const index = this.nextIndex++;
    this.segments.push({ index, role: resolvedRole, text: trimmed });
    return index;
  }

  /** 工具开始执行：关闭过程话阶段（此后产出均为结论）。 */
  noteToolStart(toolName: string): void {
    this.toolPhaseStarted = true;
    this.noteToolUse(toolName);
  }

  /** 工具执行完成：登记工具名（直跑路径可能只有完成回调）。 */
  noteToolExecuted(toolName: string): void {
    this.noteToolUse(toolName);
  }

  private noteToolUse(toolName: string): void {
    const name = toolName.trim();
    if (name && !this.toolNames.includes(name)) this.toolNames.push(name);
  }

  get preambleText(): string {
    return this.segments
      .filter((s) => s.role === "preamble")
      .map((s) => s.text)
      .join("");
  }

  get conclusionText(): string {
    return this.segments
      .filter((s) => s.role === "conclusion")
      .map((s) => s.text)
      .join("");
  }

  /**
   * turn 结束定稿：裁决过程话是否与结论重复（或纯属无实质内容），
   * 输出展示侧应保留的分段与是否塌缩为单条发言。
   *
   * @param finalText 本轮权威最终文本（出口收口后的 finalText）。当结论分段
   *   尚未登记（例如结论由收口链一次性写入、未经分段器）时用它兜底成结论段。
   */
  settle(finalText?: string): UtteranceSettlement {
    const preamble = this.preambleText;
    // 结论未经分段器出站（收口链一次性写入）时补登记一个结论段，保证"结论一定在"。
    // 幂等：结论已在册则不重复补（重复 settle 安全）。
    if (!this.conclusionText && finalText?.trim()) {
      this.segments.push({
        index: this.nextIndex++,
        role: "conclusion",
        text: finalText.trim(),
      });
    }
    const segments = [...this.segments];
    const conclusion = this.conclusionText;

    const bookkeepingOnly = this.bookkeepingOnly;
    let collapseReason: UtteranceCollapseReason = "none";

    if (preamble && conclusion) {
      if (isSemanticallyEquivalent(preamble, conclusion)) {
        collapseReason = "preamble_equals_conclusion";
      } else if (
        bookkeepingOnly &&
        (isAckLike(preamble) || isProcessTalk(preamble))
      ) {
        // 记账轮：本轮没有任何外部信息可承载，过程话必然是"要去记账"的过场，
        // 结论才是唯一实质内容 → 过程话裁掉（不靠按工具写 if，靠轮次性质判定）。
        collapseReason = "preamble_non_substantive_in_bookkeeping";
      }
    }

    const dropPreamble = collapseReason !== "none";
    const dropped = dropPreamble
      ? segments.filter((s) => s.role === "preamble")
      : [];
    const kept = dropPreamble
      ? segments.filter((s) => s.role !== "preamble")
      : segments;

    return {
      utteranceId: this.opts.utteranceId,
      segments,
      kept,
      droppedSegmentIndexes: dropped.map((s) => s.index),
      collapse: dropPreamble && kept.length > 0,
      collapseReason,
      bookkeepingOnly,
    };
  }

  /** 观测用单行描述（日志/回归取证）。 */
  describeSettlement(settlement: UtteranceSettlement): string {
    return (
      `[utterance] id=${settlement.utteranceId} segments=${settlement.segments.length} ` +
      `kept=${settlement.kept.length} collapse=${settlement.collapse} ` +
      `reason=${settlement.collapseReason} bookkeeping=${settlement.bookkeepingOnly} ` +
      `tools=${this.toolNames.join(",") || "-"}`
    );
  }
}
