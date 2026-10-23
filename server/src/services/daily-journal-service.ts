/**
 * 当日对话日志（Daily Journal）—— 记忆架构重构写入层
 *
 * 设计原则（白天只写不捞）：
 * - 每轮对话结束，把「规则精简行」（时间戳 + 角色 + 精简内容 + 事实提取）
 *   追加写入当日 md 文件：data/journal/{actorId}/journal-YYYYMMDD.md；
 * - 同一天多 session 追加写同一文件，时间戳天然区分；
 * - 当天的问题只对这一个文件做零-embedding 词法检索（searchToday）；
 * - 夜晚固化（NightlyMemoryTaskService）消费未固化日志 → 入长期记忆图
 *   → 标记已固化（consolidated.json 记录已处理日期）→ 删除对应 md 原始对话，
 *     实现短期/长期隔离：md 只承载「未固化的当天记忆」，固化后改由图谱/KV 长期召回。
 *
 * 写入零 LLM、零 embedding：事实提取复用 STM gateway 同款正则
 * （USER_FACT_RE / USER_PREFERENCE_RE / ASSISTANT_COMMITMENT_RE）。
 */

import { getDataDir } from "../config/data-dir.js";
import { mkdir, readFile, writeFile, appendFile, readdir, unlink } from "node:fs/promises";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { sanitizeActorKey } from "../agentic-memory/actor-key.js";

/** 单行内容截断（精简记录，防失控长文本） */
const JOURNAL_MAX_LINE_CHARS = 160;
/** 当日检索命中行上限（直接对应注入 prompt 的 token 费用） */
const JOURNAL_SEARCH_K = 6;
/** 检索命中总字符预算 */
const JOURNAL_SEARCH_CHAR_BUDGET = 700;
/** 保留最近 N 天日志文件（磁盘有界） */
const JOURNAL_RETENTION_DAYS = 45;
/** appendTurn 幂等防抖窗口：同一 actor+session+同一首句在窗口内重复写入视为同一轮（防多路径双写） */
const APPEND_DEDUP_WINDOW_MS = 30_000;

const USER_PREFERENCE_RE = /喜欢|讨厌|偏好|习惯|不要|别|禁忌|生日|纪念日|remember|prefer/i;
const USER_FACT_RE = /我是|我在做|我最近在|我的项目|我正在|我计划|我住在|我需要|我叫|我在.*工作/i;
const ASSISTANT_COMMITMENT_RE = /我会|我将|已经帮你|已为你|稍后|接下来|我帮你|i will|i'll/i;

export type JournalHit = {
  /** YYYY-MM-DD（对应 journal 文件名日期） */
  dateKey: string;
  /** HH:mm 时间戳 */
  time: string;
  role: "user" | "assistant" | "fact";
  text: string;
};

function nowShanghai(): Date {
  return new Date();
}

/** YYYY-MM-DD（Asia/Shanghai） */
function toDateKey(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

/** HH:mm（Asia/Shanghai） */
function toTimeLabel(d: Date): string {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(d);
}

function normalizeLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** 取首句并截断（精简记录：一行 = 一个语义单元） */
function firstSentence(text: string): string {
  const normalized = normalizeLine(text);
  if (!normalized) return "";
  const sentence = normalized.split(/[。！？!?\n]/)[0]?.trim() || normalized;
  return sentence.length > JOURNAL_MAX_LINE_CHARS
    ? `${sentence.slice(0, JOURNAL_MAX_LINE_CHARS - 3).trimEnd()}...`
    : sentence;
}

function splitSentences(text: string): string[] {
  return normalizeLine(text)
    .split(/(?<=[。！？!?])|[\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * 简单分词：英文按分隔符切 token；中文连续段生成 2-gram
 * （与 STM gateway 零-embedding 词法检索同策略，中文无分词器时整句会成单 token 导致匹配失败）。
 */
function tokenize(text: string): string[] {
  const normalized = normalizeLine(text).toLowerCase();
  const tokens: string[] = [];
  for (const raw of normalized.split(/[\s,.;:!?，。；：！？、/\\|()[\]{}<>]+/)) {
    const token = raw.trim();
    if (!token) continue;
    if (/[\u4e00-\u9fff]/.test(token)) {
      // 中文段：2-gram
      for (let i = 0; i < token.length - 1; i += 1) {
        tokens.push(token.slice(i, i + 2));
      }
      if (token.length === 1) tokens.push(token);
    } else if (token.length >= 2) {
      tokens.push(token);
    }
  }
  return tokens;
}

function overlapScore(left: string, right: string): number {
  const a = new Set(tokenize(left));
  const b = new Set(tokenize(right));
  if (a.size === 0 || b.size === 0) return 0;
  let hits = 0;
  for (const t of a) {
    if (b.has(t)) hits += 1;
  }
  return hits / Math.max(Math.min(a.size, b.size), 1);
}

export class DailyJournalService {
  private readonly rootDir: string;
  /** 写入串行链（保证 append 顺序） */
  private writeChain: Promise<void> = Promise.resolve();
  /** 已固化日期索引缓存：actorId → Set<dateKey> */
  private consolidatedCache = new Map<string, Set<string>>();
  /** 幂等防抖：actorId → 最近一次写入指纹（防同一轮被多条调用路径重复落盘） */
  private lastAppendGuard = new Map<
    string,
    { session: string; user: string; assistant: string; ts: number }
  >();

  constructor(rootDir?: string) {
    this.rootDir =
      rootDir ?? process.env.AGENT_JOURNAL_DIR?.trim() ?? join(getDataDir(), "journal");
  }

  private actorDir(actorId: string): string {
    // 保留 @：目录名必须能从原始 actorId 无损往返（2026-10-04 根修）——
    // 此前 @ 被净化成 _，夜间固化拿目录名当 actorId，把下划线形式写穿记忆全家。
    return join(this.rootDir, sanitizeActorKey(actorId));
  }

  private journalFile(actorId: string, dateKey: string): string {
    return join(this.actorDir(actorId), `journal-${dateKey}.md`);
  }

  private consolidatedFile(actorId: string): string {
    return join(this.actorDir(actorId), "consolidated.json");
  }

  /**
   * 每轮对话结束调用：规则精简行追加写当日 journal（fire-and-forget，不阻塞对话）。
   * 记录内容：user/assistant 首句 + 正则命中的事实/偏好/承诺原句。
   * 幂等：同一 actor+session+同一首句在 APPEND_DEDUP_WINDOW_MS 内重复调用视为同一轮，
   * 直接跳过（标准主答 / complex 后台 / parallel 续接等路径都调这里，防双写）。
   */
  appendTurn(actorId: string, sessionId: string, userText: string, assistantText: string): void {
    if (!actorId) return;
    const now = nowShanghai();
    const dateKey = toDateKey(now);
    const time = toTimeLabel(now);

    const lines: string[] = [];
    const userLine = firstSentence(userText);
    const assistantLine = firstSentence(assistantText);
    if (userLine) lines.push(`- [${time}] ${sessionId.slice(0, 8)} U: ${userLine}`);
    if (assistantLine) lines.push(`- [${time}] ${sessionId.slice(0, 8)} A: ${assistantLine}`);

    // 事实提取：偏好/事实/承诺原句（跨会话固化的数据源）
    for (const s of splitSentences(userText)) {
      const trimmed = s.slice(0, JOURNAL_MAX_LINE_CHARS);
      if (USER_FACT_RE.test(s)) lines.push(`- [${time}] fact: ${trimmed}`);
      else if (USER_PREFERENCE_RE.test(s)) lines.push(`- [${time}] prefer: ${trimmed}`);
    }
    for (const s of splitSentences(assistantText)) {
      if (ASSISTANT_COMMITMENT_RE.test(s)) {
        lines.push(`- [${time}] commit: ${s.slice(0, JOURNAL_MAX_LINE_CHARS)}`);
      }
    }

    if (lines.length === 0) return;

    // 幂等防抖：同轮（同 session + 同双首句）在窗口内重复出现 → 跳过，避免重复行污染当日检索/固化
    const guard = this.lastAppendGuard.get(actorId);
    if (
      guard &&
      guard.session === sessionId &&
      guard.user === userLine &&
      guard.assistant === assistantLine &&
      Date.now() - guard.ts < APPEND_DEDUP_WINDOW_MS
    ) {
      return;
    }
    this.lastAppendGuard.set(actorId, { session: sessionId, user: userLine, assistant: assistantLine, ts: Date.now() });

    this.writeChain = this.writeChain
      .then(async () => {
        await mkdir(this.actorDir(actorId), { recursive: true });
        await appendFile(this.journalFile(actorId, dateKey), `${lines.join("\n")}\n`, "utf8");
        await this.cleanupOldJournals(actorId).catch(() => {});
      })
      .catch((err) => {
        console.log(`[DailyJournal] appendTurn 失败（忽略）: ${err}`);
      });
  }

  /**
   * 当日词法检索（历史接口）：只扫今天的 journal 文件，返回与 query 相关度最高的行。
   * 零 embedding、零 LLM；命中即收费，未命中零开销。
   */
  async searchToday(actorId: string, query: string, k = JOURNAL_SEARCH_K): Promise<JournalHit[]> {
    return this.searchRange(actorId, query, 1, k);
  }

  /**
   * 列出有 journal 目录的 actorId（目录名经 sanitizeActorKey 净化但保留 @，
   * 邮箱 actor 可无损往返；仅作夜间固化的 actor 兜底来源，
   * 精确名单以 AgentMemorySync.listSessionIds 为准）。
   */
  listActorIds(): string[] {
    try {
      return readdirSync(this.rootDir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
    } catch {
      return [];
    }
  }

  /**
   * 读取当日 journal 的全部记录行（按时间顺序解析；Task 15 晚间 digest
   * "今日回顾"数据源）。零检索打分：晚间回顾要的是当天全貌而非相关性。
   * 今天一定未固化（固化发生在深夜/次日），无需检查 consolidated。
   */
  async readTodayLines(actorId: string): Promise<JournalHit[]> {
    if (!actorId) return [];
    const dateKey = toDateKey(new Date());
    let raw: string;
    try {
      raw = await readFile(this.journalFile(actorId, dateKey), "utf8");
    } catch {
      return [];
    }
    const hits: JournalHit[] = [];
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (!t.startsWith("- [")) continue;
      const m = t.match(/^- \[(\d{2}:\d{2})\]\s+(?:[\w-]{0,10}\s+)?(U|A|fact|prefer|commit):\s*(.+)$/);
      if (!m) continue;
      const role = m[2] === "U" ? "user" : m[2] === "A" ? "assistant" : "fact";
      hits.push({ dateKey, time: m[1]!, role: role as JournalHit["role"], text: m[3]! });
    }
    return hits;
  }

  /**
   * 近 N 天词法检索：扫最近 days 天的 journal 文件（从今天向前数），按相关度返回命中行。
   * 短期/长期隔离：已固化的日期跳过（改由长期记忆图/图谱-KV 召回兜底），只扫尚未固化的
   * 日期（今天一定未固化；跨天仅在服务器隔夜未开机、固化追不上时回退读文件）。
   * 命中行带 dateKey，调用方可按今天/昨天/日期打标签。
   */
  async searchRange(actorId: string, query: string, days = 1, k = JOURNAL_SEARCH_K): Promise<JournalHit[]> {
    const q = normalizeLine(query);
    if (!q || !actorId || days < 1) return [];

    // 短期/长期隔离（扣子式）：当天记忆由 md 文件承担，一旦被夜晚固化进长期记忆图，
    // 该日期就不再由文件层召回（改由图谱/KV 长期召回兜底）。
    // 只有「未固化」的日期才允许回退读文件——覆盖服务器隔夜未开机导致固化追不上的场景。
    const consolidated = await this.loadConsolidated(actorId);

    const dateKeys: string[] = [];
    for (let i = 0; i < days; i += 1) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const key = toDateKey(d);
      if (consolidated.has(key)) continue; // 已固化：跳过文件扫描，交由长期召回
      dateKeys.push(key);
    }

    const scored: Array<{ hit: JournalHit; score: number }> = [];
    for (const dateKey of dateKeys) {
      let raw: string;
      try {
        raw = await readFile(this.journalFile(actorId, dateKey), "utf8");
      } catch {
        continue; // 该天还没有日志
      }
      for (const line of raw.split("\n")) {
        const t = line.trim();
        if (!t.startsWith("- [")) continue;
        const m = t.match(/^- \[(\d{2}:\d{2})\]\s+(?:[\w-]{0,10}\s+)?(U|A|fact|prefer|commit):\s*(.+)$/);
        if (!m) continue;
        const role = m[2] === "U" ? "user" : m[2] === "A" ? "assistant" : "fact";
        const score = overlapScore(m[3]!, q);
        if (score > 0) {
          scored.push({ hit: { dateKey, time: m[1]!, role: role as JournalHit["role"], text: m[3]! }, score });
        }
      }
    }

    scored.sort((a, b) => {
      // 相关度优先；同分时越近（今天）越靠前
      if (b.score !== a.score) return b.score - a.score;
      return a.hit.dateKey.localeCompare(b.hit.dateKey);
    });

    const out: JournalHit[] = [];
    const seen = new Set<string>();
    let total = 0;
    for (const { hit } of scored) {
      const key = `${hit.role}|${hit.text}`;
      if (seen.has(key)) continue; // 跨天重复内容只保留一次
      if (out.length >= k || total + hit.text.length > JOURNAL_SEARCH_CHAR_BUDGET) break;
      seen.add(key);
      out.push(hit);
      total += hit.text.length;
    }
    return out;
  }

  /** 读取 actor 的已固化日期集合（懒加载缓存） */
  private async loadConsolidated(actorId: string): Promise<Set<string>> {
    const cached = this.consolidatedCache.get(actorId);
    if (cached) return cached;
    let set = new Set<string>();
    try {
      const raw = await readFile(this.consolidatedFile(actorId), "utf8");
      const parsed = JSON.parse(raw) as string[];
      if (Array.isArray(parsed)) set = new Set(parsed);
    } catch {
      /* 首次运行无文件 */
    }
    this.consolidatedCache.set(actorId, set);
    return set;
  }

  /**
   * 夜晚固化消费接口：返回所有「未固化」日志的行内容（按日期升序）。
   * 跨天未处理（服务器隔夜未开机等）也一并返回，由固化层统一补跑。
   */
  async getUnconsolidatedLines(actorId: string): Promise<Array<{ dateKey: string; lines: string[] }>> {
    let files: string[] = [];
    try {
      files = await readdir(this.actorDir(actorId));
    } catch {
      return [];
    }
    const consolidated = await this.loadConsolidated(actorId);
    const out: Array<{ dateKey: string; lines: string[] }> = [];

    for (const file of files) {
      const m = file.match(/^journal-(\d{4}-\d{2}-\d{2})\.md$/);
      if (!m) continue;
      const dateKey = m[1]!;
      if (consolidated.has(dateKey)) continue;
      try {
        const raw = await readFile(this.journalFile(actorId, dateKey), "utf8");
        const lines = raw
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => l.startsWith("- ["));
        if (lines.length > 0) out.push({ dateKey, lines });
      } catch {
        /* 单文件读取失败跳过 */
      }
    }
    out.sort((a, b) => a.dateKey.localeCompare(b.dateKey));
    return out;
  }

  /**
   * 标记日期已固化（短期/长期隔离：固化后删除 md 原始对话历史，
   * 内容已入长期记忆图，md 只承载「未固化的当天记忆」，不再留存已处理的对话）。
   * 幂等：重复标记同一日期无副作用（文件已删则跳过）。
   */
  async markConsolidated(actorId: string, dateKeys: string[]): Promise<void> {
    if (dateKeys.length === 0) return;
    const set = await this.loadConsolidated(actorId);
    for (const key of dateKeys) set.add(key);
    this.consolidatedCache.set(actorId, set);
    try {
      await mkdir(this.actorDir(actorId), { recursive: true });
      await writeFile(this.consolidatedFile(actorId), `${JSON.stringify([...set], null, 2)}\n`, "utf8");
      // 固化成功后再删 md，避免落盘失败导致已处理日期记录与文件状态不一致
      for (const key of dateKeys) {
        await unlink(this.journalFile(actorId, key)).catch(() => {});
      }
    } catch (err) {
      console.log(`[DailyJournal] markConsolidated 失败: ${err}`);
    }
  }

  /** 磁盘有界：删除超出保留期的 journal 文件（consolidated.json 同步收缩） */
  private async cleanupOldJournals(actorId: string): Promise<void> {
    const files = await readdir(this.actorDir(actorId));
    const journalFiles = files.filter((f) => /^journal-\d{4}-\d{2}-\d{2}\.md$/.test(f)).sort();
    if (journalFiles.length <= JOURNAL_RETENTION_DAYS) return;

    const { unlink } = await import("node:fs/promises");
    const toRemove = journalFiles.slice(0, journalFiles.length - JOURNAL_RETENTION_DAYS);
    for (const f of toRemove) {
      await unlink(join(this.actorDir(actorId), f)).catch(() => {});
      const m = f.match(/^journal-(\d{4}-\d{2}-\d{2})\.md$/);
      if (m) {
        const set = this.consolidatedCache.get(actorId);
        set?.delete(m[1]!);
      }
    }
  }
}

let singleton: DailyJournalService | null = null;

export function getDailyJournalService(): DailyJournalService | null {
  return singleton;
}

export function initDailyJournalService(rootDir?: string): DailyJournalService {
  if (singleton) return singleton;
  singleton = new DailyJournalService(rootDir);
  return singleton;
}
