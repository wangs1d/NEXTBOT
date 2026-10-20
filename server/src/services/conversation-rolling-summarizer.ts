import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import OpenAI from "openai";

/**
 * 滚动摘要（rolling recap）增强器——「滑动窗口 + 增量摘要」裁剪策略的摘要侧。
 *
 * 背景：thread 上下文窗口有限，近期窗口裁剪会把较早期的对话压进一条 `[session-recap]`
 * 摘要。旧的正则提取只取首句，信息损失大，导致 agent 忘记关键事实、时间线错乱、
 * 追问答非所问（用户反馈的"上下文跳转"）。
 *
 * 本模块实现「LLM 增量滚动摘要」：输入已有 recap 行 + [unsummarized] 待归纳原文行 +
 * 新被丢弃的对话消息，由 LLM **只为「待归纳原文 + 新对话」生成新摘要行**（已有行不经
 * LLM 重发，由调用方原样保留合并），模拟人类记忆机制——保留用户偏好/事实/尚未兑现的
 * 承诺/决策/时间线，丢弃琐碎细节（已由任务库承接的提醒/日程类轮次与已兑现承诺均属琐碎）。
 *
 * 与现有记忆架构（agentic-memory 召回、KV 摘要、海马体图谱）并行互补：滚动摘要负责
 * 「上下文窗口内的短期→中期连续性」，外部记忆负责「长期召回」，turn WAL/journal
 * 负责「全量归档与检索兜底」。
 *
 * 关键钉（key pins，混合式上下文策略的中间层）：最终注入 = [历史摘要]（全局脉络压缩，
 * 可被时间分层裁剪）+ [关键钉]（不可忘的事实，逐字保留）+ 最近 K 轮原文 + 当前 Query。
 * LLM 每批除摘要行外还可输出 `[关键钉]` 节（尚未兑现的承诺/约定/硬性约束/重要偏好/关键决定，
 * 每批最多 maxPins 条）；钉与已有钉合并后只增不改，不参与摘要的时间分层压缩，
 * 超预算才淘汰最旧（最旧事实通常已沉淀进摘要区）。详见 parseRecapSummaryOutput / mergeKeyPins。
 *
 * 契约（2026-09-05 漂移修复，必须与 chat-thread-store.enhanceRecap 的合并逻辑对齐）：
 * - 返回值是「新增摘要行」，不是全量 recap；
 * - 已有行若交由 LLM 重发，小模型改写会合并/曲解/脑补事实（与 recall-compressor
 *   去 LLM 化同源的幻觉注入口），且每次折叠都在上一版输出上改写，错误会随轮次
 *   复利传播（实测："七点提醒我开线上会议" 被逐步改写成 "七点半线上会议"）；
 * - 失败降级：任何异常返回 null，调用方保留已有摘要行与待归纳区（不影响对话主链路）。
 */

export type RecapSummarizerContext = {
  /** 已有摘要行（已 strip 前缀；仅供去重参考，禁止复述/改写） */
  existingLines: string[];
  /** 已有关键钉（不可忘事实；仅供去重参考，禁止复述/改写） */
  pinLines?: string[];
  /** [unsummarized] 待归纳原文行（尚未被摘要过，需吸收进新摘要行） */
  pendingLines?: string[];
  /** 本次滑动窗口溢出、需要被吸收进摘要的历史消息 */
  droppedMessages: ChatCompletionMessageParam[];
  /** 会话标识（token 审计归属维度；可选，兼容旧调用方） */
  sessionId?: string;
};

/** 摘要器输出：普通摘要行 + 新关键钉（mock 摘要器可只返回 string[]，见 normalize）。 */
export type RecapSummaryResult = { lines: string[]; pins: string[] };

export type RecapSummarizer = (
  ctx: RecapSummarizerContext,
) => Promise<string[] | RecapSummaryResult | null>;

/** 兼容两种返回形态：旧式 string[]（无钉）与新式 RecapSummaryResult。 */
export function normalizeRecapSummaryResult(
  result: string[] | RecapSummaryResult | null | undefined,
): RecapSummaryResult | null {
  if (!result) return null;
  if (Array.isArray(result)) return { lines: result, pins: [] };
  if (Array.isArray(result.lines) || Array.isArray(result.pins)) {
    return { lines: result.lines ?? [], pins: result.pins ?? [] };
  }
  return null;
}

const DEFAULT_MODEL = "gpt-4.1-mini";
/** 单批摘要行上限默认值（新对话 + 待归纳原文吸收；可用环境变量覆盖） */
const DEFAULT_MAX_LINES = 30;
const DEFAULT_MAX_LINE_CHARS = 160;
/** 单批关键钉上限默认值（不可忘事实，宁缺勿滥；可用环境变量覆盖） */
const DEFAULT_MAX_PINS = 3;

function parseIntEnv(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function loadRecapSummarizerBudget(): { maxLines: number; maxLineChars: number; maxPins: number } {
  return {
    maxLines: parseIntEnv(process.env.AGENT_RECAP_SUMMARY_MAX_LINES, DEFAULT_MAX_LINES),
    maxLineChars: parseIntEnv(process.env.AGENT_RECAP_SUMMARY_MAX_LINE_CHARS, DEFAULT_MAX_LINE_CHARS),
    maxPins: parseIntEnv(process.env.AGENT_RECAP_SUMMARY_MAX_PINS, DEFAULT_MAX_PINS),
  };
}

const WEEKDAY_CN = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"] as const;

/** 摘要行的绝对时间标签（不含秒，省预算）：`2026/09/04 周四 14:32`。 */
export function formatRecapStamp(at: Date): string {
  const pad = (n: number) => (n < 10 ? `0${n}` : String(n));
  const date = `${at.getFullYear()}/${pad(at.getMonth() + 1)}/${pad(at.getDate())}`;
  const weekday = WEEKDAY_CN[at.getDay()] ?? "";
  const time = `${pad(at.getHours())}:${pad(at.getMinutes())}`;
  return `${date} ${weekday} ${time}`;
}

/** 从消息正文首行解析 `[ts:YYYY-MM-DD HH:MM:SS|...]` 帧（本地复制，避免与 store 循环依赖）。 */
function parseTsFrameDate(content: string | null | undefined): Date | null {
  if (!content) return null;
  const m = content.match(/\[ts:(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}):\d{2}\|/);
  if (!m?.[1]) return null;
  const ts = Date.parse(`${m[1]}T${m[2]!}:00`);
  return Number.isNaN(ts) ? null : new Date(ts);
}

/** 从消息里提取可进摘要的文本（跳过 tool 结果、空 content、已有 recap）。 */
export function extractSummarizableText(msg: ChatCompletionMessageParam): string {
  if (msg.role === "tool") return "";
  if (typeof msg.content !== "string") return "";
  let text = msg.content.trim();
  // 去时间戳前缀 [ts:...]
  text = text.replace(/^\[ts:[^\]]+\]\n?/, "").trim();
  // 跳过 recap 自身与工具残留
  if (!text || text.startsWith("[session-recap]") || text.startsWith("[tool_calls]")) return "";
  const role = msg.role === "assistant" ? "assistant" : "user";
  return `${role}: ${text}`;
}

/** 把对话消息序列化为 LLM 输入文本：每行带绝对时间戳，限制总长防 prompt 爆炸。 */
function serializeDroppedMessages(messages: ChatCompletionMessageParam[], maxChars = 8000): string {
  const lines: string[] = [];
  let total = 0;
  for (const msg of messages) {
    const line = extractSummarizableText(msg);
    if (!line) continue;
    const ts = typeof msg.content === "string" ? parseTsFrameDate(msg.content) : null;
    const stamped = ts ? `[${formatRecapStamp(ts)}] ${line}` : line;
    if (total + stamped.length > maxChars) break;
    lines.push(stamped);
    total += stamped.length;
  }
  return lines.join("\n");
}

/** 解析 LLM 输出为摘要行（兼容 `- 内容` 格式，去重、限长、限条数）。 */
export function parseRecapLinesFromLlmOutput(
  output: string,
  maxLines = DEFAULT_MAX_LINES,
  maxLineChars = DEFAULT_MAX_LINE_CHARS,
): string[] {
  if (!output) return [];
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const raw of output.split("\n")) {
    if (lines.length >= maxLines) break;
    let line = raw.trim().replace(/^[-*\s]+/, "").trim();
    if (!line) continue;
    if (/^```/.test(line)) continue; // 跳过代码块围栏
    if (line.length > maxLineChars) {
      line = `${line.slice(0, maxLineChars - 3).trimEnd()}...`;
    }
    if (seen.has(line)) continue;
    seen.add(line);
    lines.push(line);
  }
  return lines;
}

/** LLM 输出中「关键钉」节的标记行（`[关键钉]` 为主，兼容 ASCII 别名 `[key-pins]`）。 */
const KEY_PINS_OUTPUT_MARKER_RE = /^\[(?:关键钉|key-pins)\]/;

/**
 * 解析 LLM 输出为「摘要行 + 新关键钉」：
 * - 出现 `[关键钉]` 标记行时，其前为普通摘要行、其后为钉行（各按行解析去重限长）；
 * - 没有标记行时全部视为摘要行（小模型没学会格式时优雅降级，不产钉）。
 */
export function parseRecapSummaryOutput(
  output: string,
  maxLines = DEFAULT_MAX_LINES,
  maxLineChars = DEFAULT_MAX_LINE_CHARS,
  maxPins = DEFAULT_MAX_PINS,
): RecapSummaryResult {
  if (!output) return { lines: [], pins: [] };
  const rawLines = output.split("\n");
  const markerIdx = rawLines.findIndex((l) => KEY_PINS_OUTPUT_MARKER_RE.test(l.trim().replace(/^[-*\s]+/, "")));
  const summaryPart = markerIdx >= 0 ? rawLines.slice(0, markerIdx).join("\n") : output;
  const pinsPart = markerIdx >= 0 ? rawLines.slice(markerIdx + 1).join("\n") : "";
  return {
    lines: parseRecapLinesFromLlmOutput(summaryPart, maxLines, maxLineChars),
    pins: parseRecapLinesFromLlmOutput(pinsPart, maxPins, maxLineChars),
  };
}

/** 关键钉合并预算（行数 + 总字符；超限淘汰最旧的钉）。 */
export type KeyPinBudget = { maxLines: number; maxChars: number };

/** 关键钉预算默认值（与 chat-thread-store 的 SESSION_KEY_PINS_* 默认值保持一致）。 */
export const DEFAULT_KEY_PIN_BUDGET: KeyPinBudget = { maxLines: 10, maxChars: 1000 };

/**
 * 合并关键钉（只增不改契约）：新钉规范化后追加到已有钉之后（精确去重），
 * 行数/字符超预算时淘汰最旧（数组头部）的钉、保留最新——最旧事实通常已在钉入
 * 当批沉淀进摘要区，且全文在 turn WAL 可兜底。
 */
export function mergeKeyPins(
  existingPins: string[],
  newPins: string[],
  budget: KeyPinBudget = DEFAULT_KEY_PIN_BUDGET,
): string[] {
  const merged: string[] = [];
  const seen = new Set<string>();
  for (const src of [...existingPins, ...newPins]) {
    const line = src.replace(/\s+/g, " ").trim();
    if (!line || seen.has(line)) continue;
    seen.add(line);
    merged.push(line);
  }
  const kept: string[] = [];
  let totalChars = 0;
  for (let i = merged.length - 1; i >= 0; i--) {
    const line = merged[i]!;
    if (kept.length >= budget.maxLines || totalChars + line.length > budget.maxChars) break;
    kept.unshift(line);
    totalChars += line.length;
  }
  return kept;
}

function buildSummarizeMessages(
  ctx: RecapSummarizerContext,
  budget: { maxLines: number; maxLineChars: number; maxPins: number } = loadRecapSummarizerBudget(),
): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  const existing = ctx.existingLines.length > 0 ? ctx.existingLines.map((l) => `- ${l}`).join("\n") : "（空）";
  const existingPins =
    ctx.pinLines && ctx.pinLines.length > 0 ? ctx.pinLines.map((l) => `- ${l}`).join("\n") : "（无）";
  const pending = ctx.pendingLines && ctx.pendingLines.length > 0
    ? ctx.pendingLines.map((l) => `- ${l}`).join("\n")
    : "（无）";
  const dropped = serializeDroppedMessages(ctx.droppedMessages);
  const now = new Date();
  const pad = (n: number) => (n < 10 ? `0${n}` : String(n));
  const nowLabel = `${now.getFullYear()}/${pad(now.getMonth() + 1)}/${pad(now.getDate())} ${WEEKDAY_CN[now.getDay()]} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
  const system = [
    "你是用户的长期记忆整理器。系统以「滑动窗口 + 增量摘要」维护对话上下文：窗口外的事件由你生成摘要行，与「已有摘要」合并成滚动摘要，模拟人类长期记忆：",
    "记得关键事实、用户偏好、尚未兑现的承诺、决策与时间线，忘掉琐碎细节。已由系统任务承接的提醒/日程/定时任务轮次不算关键事实——任务库自有记录；已触发/已过期的任务与承诺一律视为琐碎细节。",
    "",
    `当前时间：${nowLabel}（仅当素材行完全没有任何时间线索时，才允许用它兜底推算；素材行自带时间标签时禁止使用当前时间——把旧事件盖成新时间戳会让同一事件被反复当成新事项，诱发 agent 重复追问已办成的事）。`,
    "",
    "任务：只针对下方「待归纳原文」与「新对话」输出新的摘要行。「已有摘要」仅用于判断哪些内容已被覆盖，禁止复述、改写或补充它。",
    "要求：",
    "1. 必须吸收「待归纳原文」与「新对话」中尚未被已有摘要覆盖的关键事实（用户偏好/事实/决策/具体时间或日期，以及尚未兑现的请求/承诺）；",
    "2. 时间、数字、金额、人名、地名必须照抄原文表述，禁止换算、补全或改写（如原文「七点」不得写成「七点半」或「19:30」）；",
    "3. 不重复、不编造；「待归纳原文」与「新对话」没有可摘要的关键事实时不输出任何内容；",
    "3.5. 同一事件只允许输出一行：素材或「已有摘要」中已存在同一事件时（即使时间标签或措辞不同，如「用户请求…」与「用户重复请求…」指同一件事），禁止再输出任何变体行；",
    `4. 每条一行，以「- 」开头，每行不超过 ${budget.maxLineChars} 字；`,
    "5. 每条必须带绝对时间标签 [YYYY/MM/DD 周X HH:MM]（时刻不明可省略时刻，日期不明标 [早期]），标签与内容之间留一个空格；标签必须取自该事件素材行自带的时间标签（照抄原文标签的日期与时刻）；",
    `6. 总共不超过 ${budget.maxLines} 行；若空间不足，压缩最旧、最琐碎的细节，绝不丢用户偏好/决定与尚未兑现的承诺（已兑现/已过期的承诺可丢）；`,
    "7. 时间线顺序：新事件在前、旧事件在后，不要乱序；",
    "8. 只输出新摘要行本身，不要任何解释、标题或代码块，也不要输出「已有摘要」中的任何一行。",
    "",
    "关键钉（不可忘的事实，输出格式）：",
    `- 摘要行之后，若存在不可忘的事实，先输出一行「[关键钉]」，其下每行以「- 」开头列出这些事实，最多 ${budget.maxPins} 条；`,
    "  什么算不可忘：用户明确要求记住的事、尚未兑现的承诺与约定、硬性约束（时间/地点/方式/数量）、重要偏好与禁忌、关键决定；",
    "  什么不算不可忘：已由系统任务承接的提醒/日程/定时任务（任务库自有记录，不进关键钉），以及已触发/已过期的任务与承诺；",
    "  关键钉会跨轮逐字长期保留（不随摘要压缩改写），时间、数字、金额、人名、地名必须照抄原文表述，并带同样的时间标签；",
    "  同一事实已在「已有关键钉」中存在时禁止重复输出（即使时间标签或措辞不同）；没有新的不可忘事实时，不要输出「[关键钉]」行。",
  ].join("\n");
  const user = [
    "已有摘要（已覆盖，仅供去重参考，禁止输出这些行）：",
    existing,
    "",
    "已有关键钉（已钉住，仅供去重参考，禁止输出这些行）：",
    existingPins,
    "",
    "待归纳原文（此前滑出窗口、尚未摘要过的原文行，需吸收进新摘要行）：",
    pending,
    "",
    "新对话（即将从窗口中折叠，需要你生成摘要）：",
    dropped || "（无有效内容）",
    "",
    "请输出新摘要行（如无可钉事实则不要输出「[关键钉]」节）：",
  ].join("\n");
  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

/**
 * 创建基于 LLM 的滚动摘要增强器（只返回新对话的增量摘要行，见模块头注释契约）。
 * - 跟随当前生效的 provider（DeepSeek / Kimi / OpenAI 等 OpenAI 兼容端点），
 *   不再硬编码模型名，避免在只支持 deepseek-v4-* 的代理下被 400 拒绝；
 *   显式入参 model / AGENT_RECAP_SUMMARIZE_MODEL 仍可覆盖。
 * - 未配置任何 provider 密钥时返回 null（关闭增强，仅保留已有 recap 行）
 * - 调用失败时返回 null（调用方保留已有 recap 行）
 */
export function createLlmRollingRecapSummarizer(opts?: {
  apiKey?: string;
  model?: string;
  maxLines?: number;
  maxLineChars?: number;
  maxPins?: number;
}): RecapSummarizer | null {
  // 快速路径：任一已配置的 provider 密钥（Moonshot / OpenAI）均可启用。
  // 具体 key/baseURL/model 在调用时懒加载 resolvePrimaryLlmClientConfig 决定，
  // 与主对话链路保持同一 provider（auto 模式下 Moonshot 优先），
  // 避免"只配 MOONSHOT_API_KEY 时摘要功能静默关闭 / OPENAI key 配 Moonshot baseURL"的错配。
  const hasAnyProviderKey =
    !!opts?.apiKey?.trim() ||
    !!process.env.MOONSHOT_API_KEY?.trim() ||
    !!process.env.OPENAI_API_KEY?.trim();
  if (!hasAnyProviderKey) return null;
  const defaultBudget = loadRecapSummarizerBudget();
  const budget = {
    maxLines: opts?.maxLines ?? defaultBudget.maxLines,
    maxLineChars: opts?.maxLineChars ?? defaultBudget.maxLineChars,
    maxPins: opts?.maxPins ?? defaultBudget.maxPins,
  };

  return async (ctx): Promise<RecapSummaryResult | null> => {
    try {
      // 懒加载避免静态循环依赖：external-model/providers → abstract-chat-provider → chat-thread-store → 本模块
      const { resolvePrimaryLlmClientConfig, bypassChatRequestExtras } =
        await import("../external-model/resolve-provider.js");
      const binding = resolvePrimaryLlmClientConfig();
      const apiKey = opts?.apiKey?.trim() || binding?.apiKey?.trim();
      if (!apiKey) return null; // 主 provider 无可用密钥（与 provider 解析对齐）
      const model =
        opts?.model?.trim() ||
        process.env.AGENT_RECAP_SUMMARIZE_MODEL?.trim() ||
        binding?.model?.trim() ||
        DEFAULT_MODEL;
      const baseURL = binding?.baseURL?.trim() || process.env.OPENAI_BASE_URL?.trim();
      // maxRetries:1：SDK 默认 2 次静默重试会让瞬时失败双倍烧 token
      const openai = new OpenAI(baseURL ? { apiKey, baseURL, maxRetries: 1 } : { apiKey, maxRetries: 1 });
      // Token 审计：串行化 prompt 估算输入规模
      const auditInput = JSON.stringify(buildSummarizeMessages(ctx));
      const response = await openai.chat.completions.create({
        model,
        temperature: 0.2,
        max_tokens: 1500,
        messages: buildSummarizeMessages(ctx, budget),
        ...bypassChatRequestExtras(),
      });
      const content = response.choices[0]?.message?.content?.trim();
      {
        // 防循环依赖：懒加载审计模块
        const { recordLlmUsageByChars } = await import("./llm-token-audit.js");
        recordLlmUsageByChars({
          stage: "rolling_summary",
          inputChars: auditInput.length,
          outputChars: content?.length ?? 0,
          model,
          sessionId: ctx.sessionId,
        });
      }
      if (!content) return null;
      const result = parseRecapSummaryOutput(content, budget.maxLines, budget.maxLineChars, budget.maxPins);
      return result.lines.length > 0 || result.pins.length > 0 ? result : null;
    } catch (err) {
      console.warn(`[RollingRecap] LLM 摘要失败（降级保留旧 recap）: ${err instanceof Error ? err.message : err}`);
      return null;
    }
  };
}

// ── 事件化分层 recap（记忆连续性优化 Phase 2）───────────────

/**
 * recap 行的时间桶。按行首时间标签分层，让"时间线不拍平"——注入时近层全量、远层可压缩。
 * 标签两种格式：
 * - 绝对（现行）：`[2026/09/04 周四 14:32]` —— 跨天分桶不失效，按真实日期对 now 计算
 * - 相对（旧数据兼容）：`[今天] / [昨天] / [N天前] / [N周前] / [N个月前]`
 */
export type RecapTimeBucket = "today" | "yesterday" | "thisWeek" | "older" | "untagged";

export const RECAP_TIME_BUCKET_ORDER: RecapTimeBucket[] = [
  "today",
  "yesterday",
  "thisWeek",
  "older",
  "untagged",
];

const RECAP_TIME_TAG_RE = /^\[(今天|昨天|(\d+)天前|(\d+)周前|(\d+)个月前)\]\s*/;
const RECAP_ABSOLUTE_TAG_RE =
  /^\[(\d{4})\/(\d{2})\/(\d{2})(?:\s+周[一二三四五六日天])?(?:\s+(\d{2}):(\d{2}))?\]\s*/;

function dayDiffDays(from: Date, to: Date): number {
  const fromDay = new Date(from.getFullYear(), from.getMonth(), from.getDate()).getTime();
  const toDay = new Date(to.getFullYear(), to.getMonth(), to.getDate()).getTime();
  return Math.round((toDay - fromDay) / 86_400_000);
}

/** 解析行首绝对时间标签为 Date；无标签返回 null。 */
export function readRecapAbsoluteTag(line: string): Date | null {
  const m = line.trim().match(RECAP_ABSOLUTE_TAG_RE);
  if (!m?.[1]) return null;
  const ts = Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4] ?? "00"}:${m[5] ?? "00"}:00`);
  return Number.isNaN(ts) ? null : new Date(ts);
}

// ── 注入层时间锚（2026-10-09）：把「距今多久」显式送到模型面前 ──────────────
//
// 病灶：recap 行自带绝对时间标签（`[2026/10/08 周四 22:07]`），但模型不会主动拿它
// 去减 now，于是把一天前说的「好饿」当「刚才」承接（时间感知缺失家族）。已有
// layerRecapLinesByBudget 只把标签用在 recap 内部排序，没有把年龄送进 prompt。
//
// 方案（对齐主流 temporal decay / explicit timestamps，且不动存储）：
// - 视图层（buildTimestampFreeLlmView）对 recap 行追加 `（约N天前）` 年龄标注；
// - **日粒度**：同一天内标注字节恒定 → 不打断 prefix cache，仅跨天刷新一次；
// - 仅作用于发往 LLM 的克隆视图，存储与解析（extractSessionRecapLines）完全不受影响；
// - 无绝对时间标签的行（标题/标记行）原样保留。

/**
 * 日粒度相对年龄标签：今天 / 约1天前 / 约N天前 / 约N周前 / 约N个月前 / 约N年前。
 * 刻意不做「N小时前」细粒度——标注随小时变化会让 recap 消息每轮变字节、打断前缀缓存；
 * 日粒度足以根治「跨天当现事」，同日内的小时差由行内绝对时刻标签承担。
 */
export function formatRecapAgeLabel(at: Date, now: Date = new Date()): string {
  const days = dayDiffDays(at, now);
  if (!Number.isFinite(days) || days <= 0) return "今天";
  if (days === 1) return "约1天前";
  if (days <= 6) return `约${days}天前`;
  if (days <= 29) return `约${Math.round(days / 7)}周前`;
  if (days <= 364) return `约${Math.round(days / 30)}个月前`;
  return `约${Math.round(days / 365)}年前`;
}

/**
 * 给 recap 块的每一行（带绝对时间标签的摘要行/待归纳行）追加日粒度年龄标注：
 *   `- [2026/10/08 周四 22:07] 用户表示好饿…`
 *   → `- [2026/10/08 周四 22:07]（约1天前）用户表示好饿…`
 * 无变化时返回原串。已带标注的行（视图二次处理）跳过，保证幂等。
 */
export function annotateRecapLinesWithAge(content: string, now: Date = new Date()): string {
  if (!content || !content.includes("[")) return content;
  let changed = false;
  const out = content.split("\n").map((line) => {
    const bullet = line.match(/^(\s*-\s*)/);
    const prefix = bullet?.[1] ?? "";
    const body = prefix ? line.slice(prefix.length) : line;
    const m = body.match(RECAP_ABSOLUTE_TAG_RE);
    if (!m) return line;
    const at = readRecapAbsoluteTag(body);
    if (!at) return line;
    const rest = body.slice(m[0].length);
    if (rest.startsWith("（")) return line; // 已有标注，幂等跳过
    const tag = m[0].trimEnd();
    const annotated = `${prefix}${tag}（${formatRecapAgeLabel(at, now)}）${rest}`;
    if (annotated === line) return line;
    changed = true;
    return annotated;
  });
  return changed ? out.join("\n") : content;
}

// ── recap 未闭环旧 open loop 的时效衰减（2026-10-09）────────────────────────
//
// 病灶：摘要器按"照抄原文表述"规则保留未兑现承诺/待办（正确），但这些未闭环项
// 一旦跨天仍留在注入上下文里，模型会把它当成"此刻仍待处理"主动承接
// （「刚才你说好饿」事故：好饿是 10-08 22:07 说的，10-09 21:38 被当现事说）。
//
// 方案（与年龄段标注同源：**日粒度 + 仅视图层 + 幂等**）：
// - 识别「未闭环线索」（尚未/还没/未决定/待定/未完成 …）；
// - 跨天（≥1 天）仍未闭环的，在该行尾部追加一句**降级指令**：仅当用户本轮
//   主动提起时才可承接，不得主动追问/翻旧账；
// - 日粒度 → 同一天内字节恒定，不打断 prefix cache（只在跨天时刷新一次）；
// - 仅作用于发往 LLM 的视图克隆，存储与解析完全不受影响。
//
// 可选更强档：RECAP_STALE_LOOP_DROP_DAYS=<天数>（默认 0=关闭）——超过该天数的
// 未闭环行直接从**视图**中剔除（存储/全文归档仍在，用户主动提起时按需回溯）。

/**
 * 未闭环线索识别（复用标注/衰减判定；纯启发式，不做语义理解）。
 * 只收「明确的未完成信号」——宁少勿多：误判会把已闭环的事实标成"待办"。
 */
const UNCLOSED_OPEN_LOOP_RE =
  /尚未|尚待|还没|还没有|没有决定|未决定|没定|待定|未完成|未完成|未解决|未兑现|待办|还没吃|没想好|要不要|正在考虑|纠结/;

/** 跨天未闭环项的注入期降级指令（静态串 → 字节稳定） */
const RECAP_STALE_LOOP_SUFFIX =
  "（该事项已跨天仍未闭环：仅当用户本轮主动提起时才可承接，不要主动追问或翻旧账。）";

/** 是否属于「未闭环线索」（尚无闭合结果/决定/兑现）。 */
export function isUnclosedOpenLoop(line: string): boolean {
  if (!line) return false;
  return UNCLOSED_OPEN_LOOP_RE.test(line);
}

/** 从 recap 行解析其绝对时间标签（支持 "- [tag] 内容" 渲染态）；无标签返回 null。 */
function readLineAbsoluteTag(line: string): Date | null {
  const bullet = line.match(/^(\s*-\s*)/);
  const body = bullet ? line.slice(bullet[1]!.length) : line;
  return readRecapAbsoluteTag(body);
}

/** 视图丢弃阈值天数（env RECAP_STALE_LOOP_DROP_DAYS；0/未设 = 只降级不丢弃） */
function staleLoopDropDays(): number {
  const n = Number.parseInt(process.env.RECAP_STALE_LOOP_DROP_DAYS ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * 对 recap 块做「未闭环旧项」时效衰减：
 * - 跨天（≥1 天）未闭环 → 行尾追加降级指令（幂等：已带该指令的行跳过）；
 * - 超过 RECAP_STALE_LOOP_DROP_DAYS 的未闭环行 → 从视图中剔除（可选档）；
 * - 无绝对时间标签 / 已闭环 / 当天事项 → 原样保留。
 * 返回原串表示无变化。
 */
export function decayStaleOpenLoops(content: string, now: Date = new Date()): string {
  if (!content || !content.includes("[")) return content;
  const dropDays = staleLoopDropDays();
  const out: string[] = [];
  let changed = false;
  for (const line of content.split("\n")) {
    if (!isUnclosedOpenLoop(line)) {
      out.push(line);
      continue;
    }
    const at = readLineAbsoluteTag(line);
    if (!at) {
      out.push(line);
      continue;
    }
    const days = dayDiffDays(at, now);
    if (days < 1) {
      out.push(line);
      continue;
    }
    if (dropDays > 0 && days >= dropDays) {
      changed = true; // 从视图剔除（存储不动）
      continue;
    }
    if (line.includes(RECAP_STALE_LOOP_SUFFIX)) {
      out.push(line);
      continue;
    }
    changed = true;
    out.push(`${line}${RECAP_STALE_LOOP_SUFFIX}`);
  }
  return changed ? out.join("\n") : content;
}

// ── recap 分类索引视图（2026-10-09 深夜）：瞬时 TTL 剔除 + 冷索引 + 策略位 ───
//
// 主流方案落地：recap 的「法律地位」从可引用叙述降级为目录/索引。污染三成分
// （原话可引用 / 相对词漂移 / 年龄不可见）在视图加工时逐项剥除，而不是注入后
// 靠模型自觉：
// - **瞬时状态**（好饿/困/累/想吃…这类当下状态）：只在在途窗口内保留，跨天直接
//   从视图剔除——模型根本没有原话素材可随口引用（根治「刚才你说好饿」）。
//   存储/全文归档不动，用户主动提起时仍可按需回溯。
// - **持久事项**（承诺/计划/决定类）：跨天未闭环的转冷索引行 + 策略位
//   「勿主动提」——上下文层管「知不知道」，能否主动提由 temporal-admission 闸管。
// - 日粒度 → 同日内字节恒定，不打断 prefix cache；幂等；仅视图层，存储不动。
//
// env：RECAP_TRANSIENT_TTL_DAYS（默认 1，0=关闭瞬时剔除）；
//      RECAP_STALE_LOOP_DROP_DAYS（沿用：未闭环超 N 天直接剔除，默认 0=只降级）。
//
// 注：decayStaleOpenLoops（上一轮的纯降级方案）保留导出供兼容/测试，
// 注入管线已由本函数取代（策略位语义覆盖降级指令，且多承担瞬时剔除）。

/** 瞬时状态识别：身体/饮食/休息的「当下状态」，而非持续事项。
 * 宁少勿多——误杀持久事项（如「在忙装修」）比漏杀代价低（漏杀只是少剔除）。 */
const RECAP_TRANSIENT_TOPIC_RE =
  /好饿|饿了|饿死|好渴|好困|好累|太累|疲惫|疲倦|犯困|想吃|想喝|想睡|想休息|想躺|馋|夜宵|点外卖|吃什么|心情不好|心情差|心情低落/;

/** 瞬时条目在注入视图中的在途窗口（天，日粒度；env RECAP_TRANSIENT_TTL_DAYS）。 */
function transientTtlDays(): number {
  const n = Number.parseInt(process.env.RECAP_TRANSIENT_TTL_DAYS ?? "", 10);
  return Number.isFinite(n) && n >= 0 ? n : 1;
}

/** 是否属于「瞬时状态类」recap 条目。 */
export function isTransientRecapTopic(line: string): boolean {
  if (!line) return false;
  return RECAP_TRANSIENT_TOPIC_RE.test(line);
}

/** 跨天未闭环持久项的策略位（静态串 → 字节稳定；幂等判据）。 */
const RECAP_STALE_POLICY_SUFFIX =
  "（跨天未闭环 · 策略:勿主动提：仅当用户本轮主动提起才可承接，不要主动追问。）";

/** 有瞬时条目被剔除时插入的聚合说明（静态串；只在真有剔除时出现，字节稳定）。 */
const RECAP_TRANSIENT_COLLAPSED_NOTE =
  "- [时效索引] 更早的瞬时状态类条目（饮食/休息/心情）已按 TTL 收起，不在本上下文中；用户主动提起时可按需检索历史原文。";

/**
 * 把 recap 块加工成「分类索引视图」：
 * 1) 瞬时状态条目：超过在途窗口（默认跨天）→ 从视图剔除（原话素材不再常驻）；
 * 2) 持久事项且跨天未闭环 → 行尾追加策略位「勿主动提」（冷索引语义）；
 * 3) 超过 RECAP_STALE_LOOP_DROP_DAYS 的未闭环项直接剔除（可选硬档）；
 * 4) 其余（已闭环 / 当日 / 无标签行）原样保留；有剔除时补一行聚合说明。
 * 幂等；返回原串表示无变化。
 */
export function indexifyRecapForLlm(content: string, now: Date = new Date()): string {
  if (!content || !content.includes("[")) return content;
  const ttl = transientTtlDays();
  const dropDays = staleLoopDropDays();
  const out: string[] = [];
  let changed = false;
  let dropped = 0;
  for (const line of content.split("\n")) {
    const at = readLineAbsoluteTag(line);
    if (!at) {
      out.push(line);
      continue;
    }
    const days = dayDiffDays(at, now);
    // 1) 瞬时状态：超过在途窗口 → 从视图剔除（存储不动）
    if (ttl > 0 && days >= ttl && isTransientRecapTopic(line)) {
      changed = true;
      dropped++;
      continue;
    }
    // 2/3) 持久未闭环：硬档剔除 或 追加策略位
    if (days >= 1 && isUnclosedOpenLoop(line)) {
      if (dropDays > 0 && days >= dropDays) {
        changed = true;
        continue;
      }
      if (!line.includes(RECAP_STALE_POLICY_SUFFIX)) {
        changed = true;
        out.push(`${line}${RECAP_STALE_POLICY_SUFFIX}`);
        continue;
      }
    }
    out.push(line);
  }
  if (dropped > 0 && !content.includes(RECAP_TRANSIENT_COLLAPSED_NOTE)) {
    out.push(RECAP_TRANSIENT_COLLAPSED_NOTE);
    changed = true;
  }
  return changed ? out.join("\n") : content;
}

/** 解析 recap 行首的时间标签（相对词原样返回）；无标签返回 null。 */
export function readRecapTimeTag(line: string): string | null {
  const trimmed = line.trim();
  const abs = trimmed.match(RECAP_ABSOLUTE_TAG_RE);
  if (abs) return abs[0].trim();
  const m = trimmed.match(RECAP_TIME_TAG_RE);
  return m ? m[0].trim() : null;
}
/**
 * 把旧数据 recap 行的相对时间标签确定性换算为绝对标签（不依赖 LLM）。
 *
 * 背景：旧版折叠行带 `[今天]/[昨天]/[N天前]` 相对标签，在折叠时刻计算后冻结落盘。
 * 跨天加载后「[今天]」实际指折叠日，与系统提示词的当前时间矛盾——模型把旧事当现事
 * 承接（「昨天聊的，今天刚开始对话还在当现事说」的病灶之一）。
 *
 * @param line recap 行（摘要行或待归纳原文行）
 * @param anchor 标签计算基准时刻：取 recap 块的 [ts:] 帧（旧版恢复线程时打的帧，
 *        近似折叠/整理时刻）。为 null 时无法换算，原样返回。
 * 已带绝对标签的行原样返回；[历史] 统一改为 [早期]。
 */
export function migrateRecapLineLabel(line: string, anchor: Date | null): string {
  // 行内容可能是渲染态（带 "- " bullet），剥掉后再匹配行首标签
  const bullet = line.match(/^(\s*-\s*)/);
  const prefix = bullet?.[1] ?? "";
  const trimmed = prefix ? line.slice(prefix.length).trim() : line.trim();
  if (RECAP_ABSOLUTE_TAG_RE.test(trimmed)) return line;
  const m = trimmed.match(RECAP_TIME_TAG_RE);
  if (!m) {
    // 旧 [历史] 标签 → [早期]（与摘要器提示词的现行措辞一致）
    if (trimmed.startsWith("[历史]")) return `${prefix}[早期]${trimmed.slice("[历史]".length)}`;
    return line;
  }
  if (!anchor) return line;
  const tag = m[1]!;
  let days = 0;
  if (tag === "今天") days = 0;
  else if (tag === "昨天") days = 1;
  else if (m[2]) days = parseInt(m[2], 10);
  else if (m[3]) days = 7 * parseInt(m[3], 10);
  else if (m[4]) days = 30 * parseInt(m[4], 10);
  const shifted = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate() - days);
  // 相对标签只精确到天，迁移时不伪造时刻：输出 [YYYY/MM/DD 周X]（时刻可省略，解析兼容）
  const pad = (n: number) => (n < 10 ? `0${n}` : String(n));
  const date = `${shifted.getFullYear()}/${pad(shifted.getMonth() + 1)}/${pad(shifted.getDate())}`;
  const weekday = WEEKDAY_CN[shifted.getDay()] ?? "";
  return `${prefix}[${date} ${weekday}] ${trimmed.slice(m[0].length)}`;
}

/**
 * 对整块 recap content 逐行做相对→绝对标签迁移（标题/前缀/[unsummarized] 标记行
 * 不匹配标签正则，逐行应用天然安全）。返回原串表示无变化。
 */
export function migrateRecapContentLabels(content: string, anchor: Date | null): string {
  if (!anchor || !content.includes("[")) return content;
  const lines = content.split("\n");
  let changed = false;
  const migrated = lines.map((line) => {
    const next = migrateRecapLineLabel(line, anchor);
    if (next !== line) changed = true;
    return next;
  });
  return changed ? migrated.join("\n") : content;
}

/** 把 recap 行归类到时间桶（绝对标签按真实日期对 now 计算，相对标签直接映射）。 */
export function bucketRecapLine(line: string, now: Date = new Date()): RecapTimeBucket {
  const trimmed = line.trim();
  const abs = readRecapAbsoluteTag(trimmed);
  if (abs) {
    const days = dayDiffDays(abs, now);
    if (days <= 0) return "today";
    if (days === 1) return "yesterday";
    if (days >= 2 && days <= 6) return "thisWeek";
    return "older";
  }
  const m = trimmed.match(RECAP_TIME_TAG_RE);
  if (!m) return "untagged";
  if (m[1] === "今天") return "today";
  if (m[1] === "昨天") return "yesterday";
  if (m[2]) {
    const days = parseInt(m[2], 10);
    if (days >= 2 && days <= 6) return "thisWeek";
    return "older";
  }
  return "older"; // [N周前]/[N个月前]
}

export type RecapLayers = Record<RecapTimeBucket, string[]>;

/**
 * 事件化分层：把 recap 行按时间标签分成 今天/昨天/本周/更早/无标签 五桶。
 * - 绝对时间标签按真实日期对 now 分桶（跨天自动归位，不产生陈旧相对词）；
 * - 输出顺序固定（today → yesterday → thisWeek → older → untagged），
 *   与 buildSessionRecapContent 的写入顺序一致，避免 recap 消息内部时间乱跳。
 */
export function layerRecapLines(lines: string[], now: Date = new Date()): RecapLayers {
  const layers: RecapLayers = { today: [], yesterday: [], thisWeek: [], older: [], untagged: [] };
  for (const line of lines) {
    const trimmed = typeof line === "string" ? line.trim() : "";
    if (!trimmed) continue;
    const bucket = bucketRecapLine(trimmed, now);
    layers[bucket].push(trimmed);
  }
  return layers;
}

/**
 * 把分层 recap 拍平为有序行（时间线顺序：今天 → 昨天 → 本周 → 更早 → 无标签）。
 * 供 buildSessionRecapContent 等写回场景使用，保证 recap 消息内部时间有序。
 */
export function flattenRecapLayers(layers: RecapLayers): string[] {
  const out: string[] = [];
  for (const bucket of RECAP_TIME_BUCKET_ORDER) {
    out.push(...layers[bucket]);
  }
  return out;
}

/**
 * 按注入预算裁剪分层 recap：近层（今天/昨天）优先全量保留，远层按需压缩。
 * 记忆连续性优先"最近的时间线"，token 紧张时牺牲更早的细节而非近因。
 *
 * @param lines 原始 recap 行（可无序，绝对/相对时间标签均可）
 * @param maxLines 裁剪后总行数上限（≤0 表示不裁剪）
 * @param compressOldest 是否压缩最远层（保留每桶头部关键行，丢弃尾部细节）
 * @param now 分桶基准时刻（默认当前时间；测试可注入）
 * @returns 按时间线顺序排列、受限后的行
 */
export function layerRecapLinesByBudget(
  lines: string[],
  maxLines = 14,
  compressOldest = true,
  now: Date = new Date(),
): string[] {
  if (maxLines <= 0) return flattenRecapLayers(layerRecapLines(lines, now));
  const layers = layerRecapLines(lines, now);
  // 近层配额：今天全量，昨天全量，本周最多 4，更早最多 3，无标签最多 3
  const quotas: Partial<Record<RecapTimeBucket, number>> = {
    today: Infinity,
    yesterday: Infinity,
    thisWeek: 4,
    older: 3,
    untagged: 3,
  };
  const kept: string[] = [];
  for (const bucket of RECAP_TIME_BUCKET_ORDER) {
    const bucketLines = layers[bucket];
    if (bucketLines.length === 0) continue;
    const quota = quotas[bucket] ?? 3;
    if (bucketLines.length <= quota) {
      kept.push(...bucketLines);
    } else {
      // 超配额：优先保留头部（更重要的早期承诺/事实），尾部压缩
      const head = bucketLines.slice(0, quota);
      kept.push(...head);
      if (compressOldest) {
        kept.push(`[${bucketHeadLabel(bucket)}] …（另有 ${bucketLines.length - quota} 条细节已压缩）`);
      }
    }
    if (kept.length >= maxLines) break;
  }
  return kept.slice(0, maxLines);
}

function bucketHeadLabel(bucket: RecapTimeBucket): string {
  switch (bucket) {
    case "today": return "今天";
    case "yesterday": return "昨天";
    case "thisWeek": return "本周";
    case "older": return "更早";
    default: return "历史";
  }
}
