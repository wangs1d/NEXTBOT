/**
 * 当日 RAM digest：为 prompt 注入「今天聊了什么」的轻量上下文（查询相关性行优先）。
 *
 * 记忆架构收敛（2026-08）：
 * - 长期归档职责已移除——原 tickArchive/archiveDayForTodayImmediately 会把 digest
 *   再灌一遍 narrativeMemory 长期图，与 NightlyMemoryTaskService.consolidateDailyJournals
 *   （journal → 长期图）对同批当天对话双写，是长期记忆重复/陈旧的来源之一。
 *   当天对话的长期固化统一走 journal 单一入口；
 * - 本服务仅保留 RAM/磁盘层面的当日摘要：observeTurn 写入、prompt 读取、失忆清理。
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveDataPath } from "../config/data-dir.js";

import { writeJsonAtomic } from "../storage/atomic-json.js";

import {
  getCalendarDay,
  getShortTermMemoryConfig,
  type ShortTermMemoryConfig,
} from "./short-term-memory-config.js";
import {
  dedupeMemoryLines,
  limitLinesByChars,
  semanticFingerprint,
  unifiedMemoryScore,
} from "./memory-record-utils.js";
import { redactSensitiveText } from "../utils/redact.js";

type DigestRecord = {
  day: string;
  actorId: string;
  text: string;
  turnCount: number;
  updatedAt: string;
  archived?: boolean;
  keyLines?: string[];
  recentTurns?: string[];
  summaryLayer?: string[];
};

type PersistedShape = {
  digests: Record<string, DigestRecord>;
};

function digestKey(actorId: string, day: string): string {
  return `${actorId}::${day}`;
}

/**
 * 摘要卫生（P1）：今日摘要只作背景，不是待办清单。此前 digest 逐字回灌 agent
 * 自己的问句，模型把「未答问题」当成待推进事项，于是每轮换说法反复追问
 * （真机事故：凌晨四点半「你还不睡？」被复读多轮）。这里明确口径——问句留在
 * ①原文窗口/情景日志，摘要侧只提供历史事实，不复述也不追问。
 */
const DIGEST_BACKGROUND_HEADER =
  "（今日对话历史摘要，仅作背景：不是待办清单；其中早已问过但未获回答的问题不要复述、不要追问，除非用户本轮主动提起。行内角色标记：`用户=` 是用户原话，`Agent=` 是 Agent 自己说过的话，两者不可混用）";

function firstLine(text: string, maxLen: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (!t) return "";
  return t.length > maxLen ? `${t.slice(0, maxLen)}...` : t;
}

function compactDigestField(text: string, maxLen: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (!t) return "";
  return t.length > maxLen ? `${t.slice(0, maxLen)}...` : t;
}

function materializeDigestText(rec: DigestRecord): string {
  const layered = [
    ...(rec.summaryLayer ?? []),
    ...(rec.keyLines ?? []),
    ...(rec.recentTurns ?? []),
  ]
    .map((line) => line.trim())
    .filter(Boolean);
  if (layered.length > 0) {
    return layered.join("\n");
  }
  return rec.text?.trim() ?? "";
}

function compressDigestLines(lines: string[]): string[] {
  if (lines.length === 0) return [];
  const compacted = dedupeMemoryLines(lines.map((line) => formatDigestPromptLine(line)), {
    preferLatest: true,
  });
  return compacted.slice(-10);
}

function formatDigestPromptLine(line: string): string {
  const rememberMatch = line.match(/^\[用户要求记住\]\s*(.+)$/);
  if (rememberMatch?.[1]) {
    return `- mem|${compactDigestField(rememberMatch[1], 80)}`;
  }

  const conclusionMatch = line.match(/^\[Agent 承诺\/结论\]\s*(.+)$/);
  if (conclusionMatch?.[1]) {
    return `- agent|${compactDigestField(conclusionMatch[1], 80)}`;
  }

  const turnMatch = line.match(/^\[(\d{2}:\d{2})\]\s*用户:\s*(.+?)\s*\|\s*Agent:\s*(.+)$/);
  if (turnMatch) {
    const [, timeLabel, userText, assistantText] = turnMatch;
    // 问句保真：助手侧含问句时放宽截断并保留问号——问句是原文窗口的一部分，
    // 摘要把问句截成半句陈述会让模型误以为话题被结束、或反过来复述追问。
    const hasQuestion = /[？?]/.test(assistantText);
    return `- turn|${timeLabel}|用户=${compactDigestField(userText, 36)}|Agent=${compactDigestField(
      assistantText,
      hasQuestion ? 60 : 36,
    )}`;
  }

  return `- note|${compactDigestField(line, 96)}`;
}

/**
 * 中文查询切词（P4 检索统一的一部分）：旧实现用 `[\u4e00-\u9fff]{2,}` 贪婪匹配，
 * 无空格的中文整句会变成一个超长 term——只有原文逐字包含整句时才命中，
 * 摘要召回事实上长期失效。改为 2 字滑窗，过滤纯虚词组合与疑问词。
 */
const CJK_STOP_CHARS = new Set([
  "的", "了", "是", "在", "和", "与", "我", "你", "他", "她", "它", "们",
  "要", "有", "吗", "呢", "啊", "吧", "这", "那", "个", "就", "都", "也",
  "很", "把", "被", "给", "对", "着", "过", "还", "又", "去", "来", "说",
]);
const CJK_STOP_TERMS = new Set(["什么", "怎么", "如何", "一下", "可以", "是不", "有没"]);

function extractQueryTerms(text: string): string[] {
  const terms = new Set<string>();
  for (const run of text.toLowerCase().match(/[\u4e00-\u9fff]+/g) ?? []) {
    if (run.length === 2) {
      if (!CJK_STOP_TERMS.has(run)) terms.add(run);
      continue;
    }
    for (let i = 0; i + 2 <= run.length; i += 1) {
      const gram = run.slice(i, i + 2);
      if (CJK_STOP_TERMS.has(gram)) continue;
      if ([...gram].every((ch) => CJK_STOP_CHARS.has(ch))) continue;
      terms.add(gram);
    }
  }
  for (const word of text.toLowerCase().match(/[a-z]{3,}/g) ?? []) terms.add(word);
  return Array.from(terms).slice(0, 24);
}

function scoreDigestLine(
  line: string,
  queryTerms: string[],
  recencyRank: number,
  totalLines: number,
): number {
  if (queryTerms.length === 0) return 0;

  const lower = line.toLowerCase();
  let score = 0;
  let matched = false;
  for (const term of queryTerms) {
    if (lower.includes(term)) {
      score += term.length >= 4 ? 2 : 1;
      matched = true;
    }
  }

  if (/\[用户要求记住\]|\[Agent 承诺\/结论\]/.test(line)) {
    score += 2.5;
  }

  // 无实际词面命中的行不注入（未命中零 token）。
  if (!matched) return 0;

  // 统一排序口径（P4）：相关度 × 时效 × 置信度。摘要行没有逐行时间戳，
  // 用行位置换算"越靠后越新"的近似时效，与记忆图/情景检索共用同一打分函数。
  const relevance = Math.min(1, score / 4);
  const recency01 = totalLines <= 1 ? 1 : recencyRank / Math.max(totalLines - 1, 1);
  const ageDays = (1 - recency01) * 0.5;
  return unifiedMemoryScore({
    relevance,
    updatedAt: Date.now() - ageDays * 86_400_000,
    confidence: 0.7,
  });
}

export class DailyDigestService {
  private readonly config: ShortTermMemoryConfig;
  private readonly filePath: string;
  private data: PersistedShape = { digests: {} };
  private persistChain: Promise<void> = Promise.resolve();

  constructor(config?: ShortTermMemoryConfig) {
    this.config = config ?? getShortTermMemoryConfig();
    this.filePath = resolveDataPath(this.config.digestFile);
  }

  async load(): Promise<void> {
    if (!this.config.digestEnabled) return;
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as PersistedShape;
      if (parsed?.digests && typeof parsed.digests === "object") {
        this.data = parsed;
        this.pruneStaleFromMemory();
      }
    } catch (e: unknown) {
      const code =
        e && typeof e === "object" && "code" in e
          ? String((e as NodeJS.ErrnoException).code)
          : "";
      if (code !== "ENOENT") throw e;
    }
  }

  getPromptDigest(actorId: string, day = getCalendarDay()): string | undefined {
    if (!this.config.digestEnabled) return undefined;
    const rec = this.data.digests[digestKey(actorId, day)];
    const raw = rec ? materializeDigestText(rec) : "";
    if (!raw.trim()) return undefined;
    const max = this.config.digestPromptMaxChars;
    const body = raw.trim();
    const payload =
      body.length > max ? `...(earlier entries truncated)\n${body.slice(-max)}` : body;
    return `${DIGEST_BACKGROUND_HEADER}\n${payload}`;
  }

  getRelevantPromptDigest(
    actorId: string,
    query: string,
    day = getCalendarDay(),
  ): string | undefined {
    if (!this.config.digestEnabled) return undefined;
    const rec = this.data.digests[digestKey(actorId, day)];
    const raw = rec ? materializeDigestText(rec) : "";
    if (!raw.trim()) return undefined;

    const lines = raw
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    if (lines.length === 0) return undefined;

    const queryTerms = extractQueryTerms(query);
    if (queryTerms.length === 0) {
      return undefined;
    }

    const ranked = lines
      .map((line, index) => ({
        line,
        index,
        score: scoreDigestLine(line, queryTerms, index, lines.length),
      }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score || b.index - a.index)
      .slice(0, 6)
      .sort((a, b) => a.index - b.index)
      .map((entry) => entry.line);

    if (ranked.length === 0) {
      return undefined;
    }

    let text = [
      `DIGEST|hits=${ranked.length}`,
      DIGEST_BACKGROUND_HEADER,
      ...ranked.map((line) => formatDigestPromptLine(line)),
    ].join("\n");
    if (text.length > this.config.digestPromptMaxChars) {
      text = `${text.slice(0, this.config.digestPromptMaxChars)}...`;
    }
    return text;
  }

  /**
   * 夜间巩固·一句话回顾（确定性，零 LLM）。
   * 把当日摘要压成一条 `- recap|日期 共 N 轮：话题…` 放在 summaryLayer 最前，
   * 便于跨天/新会话快速知道"昨天聊过什么"。只追加一条回顾行，不改写、不删除
   * ①原文窗口与问句行（用户定调：agent 自己的问句必须留在原文里）。
   */
  consolidateDayRecap(actorId: string, day = getCalendarDay()): string | null {
    if (!this.config.digestEnabled) return null;
    const rec = this.data.digests[digestKey(actorId, day)];
    if (!rec) return null;

    const topics: string[] = [];
    for (const line of rec.recentTurns ?? []) {
      const m = line.match(/用户:\s*(.+?)\s*\|\s*Agent:/);
      if (m?.[1]) topics.push(compactDigestField(m[1], 24));
    }
    for (const line of rec.keyLines ?? []) {
      // 人类不会把自己抛出的问句记成"事实/结论"：agent 侧问句只活在①原文窗口，
      // 不进入日终回顾（否则又会被当成待推进事项复读）。
      if (/^\[Agent 承诺\/结论\]/.test(line) && /[？?]/.test(line)) continue;
      const cleaned = line.replace(/^\[(?:用户要求记住|Agent 承诺\/结论)\]\s*/, "").trim();
      if (cleaned) topics.push(compactDigestField(cleaned, 24));
    }
    const uniq = Array.from(new Set(topics.filter(Boolean))).slice(-3);
    if (uniq.length === 0) return null;

    const recap = `- recap|${day.slice(5)} 共 ${rec.turnCount} 轮（用户侧话题）：${uniq.join(" / ")}`;
    rec.summaryLayer = dedupeMemoryLines([recap, ...(rec.summaryLayer ?? [])], {
      preferLatest: false,
    }).slice(-10);
    rec.text = materializeDigestText(rec);
    this.schedulePersist();
    return recap;
  }

  observeTurn(
    actorId: string,
    userText: string,
    assistantText: string,
    opts?: { priorityLines?: string[] },
  ): void {
    if (!this.config.digestEnabled) return;

    const day = getCalendarDay();
    const key = digestKey(actorId, day);
    const now = new Date().toISOString();
    const prev = this.data.digests[key];

    const timeLabel = new Intl.DateTimeFormat("zh-CN", {
      timeZone: this.config.digestTimezone,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(new Date());

    const lines: string[] = [];
    if (opts?.priorityLines?.length) {
      for (const line of opts.priorityLines) {
        lines.push(redactSensitiveText(line));
      }
    }
    lines.push(
      `[${timeLabel}] 用户: ${firstLine(userText, 120)} | Agent: ${firstLine(assistantText, 120)}`,
    );

    const nextRec: DigestRecord = prev ?? {
      day,
      actorId,
      text: "",
      turnCount: 0,
      updatedAt: now,
      keyLines: [],
      recentTurns: [],
      summaryLayer: [],
    };
    nextRec.keyLines = dedupeMemoryLines(
      [...(nextRec.keyLines ?? []), ...(opts?.priorityLines ?? []).map((line) => redactSensitiveText(line))],
      { preferLatest: true },
    ).slice(-12);
    nextRec.recentTurns = [...(nextRec.recentTurns ?? []), lines[lines.length - 1]!].slice(-24);
    this.rebalanceRecord(nextRec);
    const text = materializeDigestText(nextRec);

    this.data.digests[key] = {
      ...nextRec,
      day,
      actorId,
      text,
      turnCount: (prev?.turnCount ?? 0) + 1,
      updatedAt: now,
    };
    this.schedulePersist();
  }

  listActorIds(): string[] {
    return [...new Set(Object.values(this.data.digests).map((rec) => rec.actorId).filter(Boolean))];
  }

  /** 清空某 actor 的全部当日摘要（内存 + 持久化），用于"清空聊天/失忆"。 */
  clearActorDigests(actorId: string): number {
    let removed = 0;
    for (const key of Object.keys(this.data.digests)) {
      if (key.startsWith(`${actorId}::`)) {
        delete this.data.digests[key];
        removed++;
      }
    }
    if (removed > 0) {
      this.schedulePersist();
      console.log(`[DailyDigest] clearActorDigests 完成：删除 ${removed} 条 (actorId=${actorId})`);
    }
    return removed;
  }

  private pruneStaleFromMemory(): void {
    const today = getCalendarDay();
    const yesterday = getCalendarDay(new Date(Date.now() - 86_400_000));
    // 长期归档移除后 digest 仅服务当日/昨日 prompt 注入，超期一律滚动清理
    const keepDays = new Set([today, yesterday]);

    for (const [key, rec] of Object.entries(this.data.digests)) {
      if (!keepDays.has(rec.day)) {
        delete this.data.digests[key];
      }
    }
  }

  private rebalanceRecord(rec: DigestRecord): void {
    const keyLines = dedupeMemoryLines(rec.keyLines ?? [], { preferLatest: true }).slice(-12);
    const recentTurns = dedupeMemoryLines(rec.recentTurns ?? [], { preferLatest: true }).slice(-24);
    const summaryLayer = dedupeMemoryLines(rec.summaryLayer ?? [], { preferLatest: true }).slice(-10);

    const allLines = [...summaryLayer, ...keyLines, ...recentTurns];
    const limited = limitLinesByChars(allLines, this.config.digestMaxChars, { preserveTail: true });
    const keptSet = new Set(limited.kept.map((line) => semanticFingerprint(line) || line));
    const overflowRecent = recentTurns.filter((line) => !keptSet.has(semanticFingerprint(line) || line));
    const nextSummary = dedupeMemoryLines(
      [...summaryLayer, ...compressDigestLines(overflowRecent)],
      { preferLatest: true },
    ).slice(-10);

    const recomposed = [...nextSummary, ...keyLines, ...recentTurns];
    const trimmed = limitLinesByChars(recomposed, this.config.digestMaxChars, { preserveTail: true }).kept;
    const trimmedSet = new Set(trimmed.map((line) => semanticFingerprint(line) || line));

    rec.summaryLayer = nextSummary.filter((line) => trimmedSet.has(semanticFingerprint(line) || line));
    rec.keyLines = keyLines.filter((line) => trimmedSet.has(semanticFingerprint(line) || line));
    rec.recentTurns = recentTurns.filter((line) => trimmedSet.has(semanticFingerprint(line) || line));
    rec.text = materializeDigestText(rec);
  }

  private schedulePersist(): void {
    this.persistChain = this.persistChain.then(() => this.flushToDisk());
  }

  private async flushToDisk(): Promise<void> {
    await writeJsonAtomic(this.filePath, this.data);
  }
}

let singleton: DailyDigestService | null = null;

export function getDailyDigestService(): DailyDigestService {
  if (!singleton) singleton = new DailyDigestService();
  return singleton;
}
