import type { NarrativeMemoryPort } from "./narrative-memory-port.js";
import type { AgentMemorySyncService } from "./agent-memory-sync-service.js";
import { getNightlyMemoryTaskService } from "./nightly-memory-task-service.js";
import { getDailyJournalService, DailyJournalService } from "./daily-journal-service.js";
import { join } from "node:path";
import { writeJsonAtomic } from "../storage/atomic-json.js";
import { dedupeMemoryLines, limitLinesByChars, semanticFingerprint } from "./memory-record-utils.js";
import { getShortTermMemoryGatewayService } from "./short-term-memory-gateway.js";
import { fetchOpenAiCompatibleEmbedding, resolveEmbeddingModel } from "./openai-embedding-client.js";

/**
 * 真向量 cosine 相似度（替代 human-like-memory 里的假 cosineLikeScore）。
 * 用于 forgotten 行的 embedding 语义匹配。
 */
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

export type MemoryManagerConfig = {
  enabled: boolean;
  consolidationIntervalMs: number;
  maxSummaryChars: number;
  profileUpdateThreshold: number;
  /** 单窗口在线固化阈值：白天 pending queue 积累到该条数时立即触发整理 */
  onlineConsolidationThreshold: number;
  /** 日间在线巩固开关：默认 false，LLM 评分只留夜间 dreaming 一次（env: AGENT_MEMORY_DAY_CONSOLIDATION） */
  dayConsolidationEnabled: boolean;
};

export type MemoryConsolidationResult = {
  entriesMerged: number;
  entriesRemoved: number;
  summaryUpdated: boolean;
  timestamp: string;
  rememberedCount: number;
  fadedCount: number;
};

export type UserProfileSnapshot = {
  preferences: Record<string, string[]>;
  frequentTopics: string[];
  recentIntentions: string[];
  riskFlags: string[];
  lastUpdated: string;
  version: number;
};

export type MemoryContinuitySnapshot = {
  stableLines: string[];
  fadingLines: string[];
  forgottenLines: string[];
  forgottenArchiveLines?: string[];
  temporalHighlights: string[];
  lastSleepAt: string;
  lastUpdatedAt: string;
};

export type RelationshipMemorySnapshot = {
  lines: string[];
  lastUpdatedAt: string;
};

export type LifeThemeMemorySnapshot = {
  themes: string[];
  lastUpdatedAt: string;
};

export type DreamPhaseSnapshot = {
  replayLines: string[];
  reinforcedLines: string[];
  mergedThemes: string[];
  fadedNoise: string[];
  lastUpdatedAt: string;
};

const DEFAULT_CONFIG: MemoryManagerConfig = {
  enabled: true,
  consolidationIntervalMs: 10 * 60 * 1000,
  maxSummaryChars: 16_000,
  profileUpdateThreshold: 3,
  // 单窗口长会话在线固化：白天 pending queue 积累 ≥15 条立即触发整理
  onlineConsolidationThreshold: 15,
  // 日间在线巩固开关（2026-09-12 token 治理）：默认关闭——LLM 评分（scoreLinesWithLlm）
  // 只在夜间 dreaming（consolidateNow 由 nightly-memory-task 触发）执行一次。
  // 白天 journal 行持续累积，当日事实由 journalRecall/STM 直接进 prompt，不依赖
  // memory_summary 刷新；日间整理对 agent 当天可见性没有增量收益，只产生
  // 全量 16k 字符重复评分开销。置 1 恢复旧的日间在线巩固行为。
  dayConsolidationEnabled: false,
};

function loadConfig(): MemoryManagerConfig {
  const raw = process.env.MEMORY_MANAGER_ENABLED;
  const enabled = raw !== undefined ? !(raw === "0" || raw.toLowerCase() === "false") : true;
  const dayRaw = process.env.AGENT_MEMORY_DAY_CONSOLIDATION?.trim().toLowerCase();
  const dayConsolidationEnabled = dayRaw ? ["1", "true", "yes", "on"].includes(dayRaw) : DEFAULT_CONFIG.dayConsolidationEnabled;
  return {
    ...DEFAULT_CONFIG,
    enabled,
    dayConsolidationEnabled,
    consolidationIntervalMs:
      Number.parseInt(process.env.MEMORY_MANAGER_CONSOLIDATION_INTERVAL_MS ?? "", 10) ||
      DEFAULT_CONFIG.consolidationIntervalMs,
    profileUpdateThreshold:
      Number.parseInt(process.env.MEMORY_MANAGER_PROFILE_THRESHOLD ?? "", 10) ||
      DEFAULT_CONFIG.profileUpdateThreshold,
    onlineConsolidationThreshold:
      Number.parseInt(process.env.MEMORY_MANAGER_ONLINE_CONSOLIDATION_THRESHOLD ?? "", 10) ||
      DEFAULT_CONFIG.onlineConsolidationThreshold,
  };
}

function formatRelativeAgeLabel(ageHours: number): string {
  if (ageHours < 1) return "just now";
  if (ageHours < 24) return `${Math.floor(ageHours)}h ago`;
  if (ageHours < 24 * 7) return `${Math.floor(ageHours / 24)}d ago`;
  if (ageHours < 24 * 30) return `${Math.floor(ageHours / (24 * 7))}w ago`;
  return `${Math.floor(ageHours / (24 * 30))}mo ago`;
}

/**
 * 中文相对时间标签，供 temporalHighlights 使用。
 * 跨天时输出「N天前」格式，与 getYesterdayHighlightForPrompt 的正则 ^(\d+)天前[:：] 对齐。
 */
function formatRelativeAgeLabelCn(ageHours: number): string {
  if (ageHours < 1) return "刚刚";
  if (ageHours < 24) return `今天${Math.floor(ageHours)}h前`;
  const days = Math.floor(ageHours / 24);
  if (days < 7) return `${days}天前`;
  if (days < 30) return `${Math.floor(days / 7)}周前`;
  return `${Math.floor(days / 30)}月前`;
}

function stripTimestampPrefix(line: string): string {
  return line.replace(/^\[[^\]]+\]\s*/, "").trim();
}

export class MemoryManagerService {
  private readonly config: MemoryManagerConfig;
  private readonly consolidationTimers = new Map<string, NodeJS.Timeout>();
  private readonly turnCounters = new Map<string, number>();
  private readonly pendingProfiles = new Map<string, UserProfileSnapshot>();
  private readonly continuitySnapshots = new Map<string, MemoryContinuitySnapshot>();
  private readonly relationshipSnapshots = new Map<string, RelationshipMemorySnapshot>();
  private readonly lifeThemeSnapshots = new Map<string, LifeThemeMemorySnapshot>();
  private readonly dreamSnapshots = new Map<string, DreamPhaseSnapshot>();

  constructor(
    private readonly narrativeMemory: NarrativeMemoryPort | null,
    private readonly memorySync: AgentMemorySyncService | null,
    config?: Partial<MemoryManagerConfig>,
    /** 当日 journal 来源（可注入便于测试）；缺省用全局单例 */
    journal?: DailyJournalService | null,
  ) {
    this.config = { ...loadConfig(), ...config };
    this.journal = journal ?? null;
  }

  /** 当日待整理内容的唯一来源：注入的 journal 服务或全局单例 */
  private resolveJournal(): DailyJournalService | null {
    return this.journal ?? getDailyJournalService();
  }

  onTurnCompleted(actorId: string, sessionId: string | undefined, userText: string, assistantText: string): void {
    if (!this.config.enabled) return;

    // 记忆架构收敛（2026-08）：白天不再实时回喂长期记忆图，也不再在内存里
    // 自建「当日待整理队列」——原始轮次由 TurnFinalizer 统一落盘 DailyJournal，
    // 整理时（consolidateNow）直接读 journal，消除同批原始数据的第二份存储。
    // 这里只维护「今日轮数」计数器，供在线固化阈值判断。

    const prev = this.turnCounters.get(actorId) ?? 0;
    const next = prev + 1;
    this.turnCounters.set(actorId, next);
    {
      const today = this.getTodayDayKey();
      const entry = this.dailyTurnCounters.get(actorId);
      this.dailyTurnCounters.set(actorId, {
        day: today,
        count: entry && entry.day === today ? entry.count + 1 : 1,
      });
    }

    const nightlyService = getNightlyMemoryTaskService();
    const shouldDefer = nightlyService?.shouldDeferConsolidation() ?? false;
    if (shouldDefer) {
      // P1-2 单窗口长会话在线固化：白天不再无限期 defer。
      // 原策略：白天只积累 pending queue，整理要等 30min idle 或夜间 dreaming
      //   → 单窗口长会话（用户一直在线聊）当天记忆始终得不到整理，
      //     session recap 滚动压缩会丢细节，长期记忆滞后一整天。
      // 新策略：当日轮数超过 onlineConsolidationThreshold（默认 15 轮）
      //   时立即触发一次在线整理（LLM 评分 + 去重 + 写回 memory_summary），
      //   长会话每 ~15 轮巩固一次，"整理记忆能力"在会话中真实被使用。
      // 2026-09-12 token 治理：日间在线巩固默认关闭（dayConsolidationEnabled），
      //   整理/评分收敛到夜间 dreaming 一次；当日事实仍经 journalRecall/STM 进 prompt。
      const pendingCount = this.getTodayTurnCount(actorId);
      if (this.config.dayConsolidationEnabled && pendingCount >= this.config.onlineConsolidationThreshold) {
        console.log(
          `[MemoryManager] Day mode: today turns ${pendingCount} ≥ ${this.config.onlineConsolidationThreshold}，触发单窗口在线固化 for ${actorId}`,
        );
        void this.tryIdleConsolidation(actorId).catch(() => {
          /* 在线固化失败静默，等待夜间兜底 */
        });
      } else {
        console.log(`[MemoryManager] Day mode: deferring consolidation for ${actorId} (turns: ${next}, today turns: ${pendingCount})`);
      }
      return;
    }

    if (
      this.config.dayConsolidationEnabled &&
      next >= this.config.profileUpdateThreshold &&
      !this.consolidationTimers.has(actorId)
    ) {
      this.scheduleConsolidation(actorId);
    }
  }

  /** 注入的 journal 服务（可测性 DI）；null 时用全局单例 */
  private readonly journal: DailyJournalService | null;

  /**
   * 今日轮数计数器（actorId → { day, count }）：仅用于在线固化阈值判断。
   * 原始轮次内容统一由 DailyJournal 落盘（TurnFinalizer 触发），整理时直接读
   * journal——不再在内存里重复存一份原始对话（原 dailyPendingQueues 已删除）。
   */
  private dailyTurnCounters = new Map<string, { day: string; count: number }>();

  /** journal 行消费游标（actorId → { day, lines }）：记录本日已被 consolidateNow 消费的行数 */
  private journalConsumeCursor = new Map<string, { day: string; lines: number }>();

  /**
   * 获取今天的日 key（YYYY-MM-DD，基于 Asia/Shanghai 时区）。
   */
  private getTodayDayKey(): string {
    const fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Shanghai",
      year: "numeric", month: "2-digit", day: "2-digit",
    });
    return fmt.format(new Date()); // 输出 YYYY-MM-DD
  }

  private getTodayTurnCount(actorId: string): number {
    const today = this.getTodayDayKey();
    const entry = this.dailyTurnCounters.get(actorId);
    return entry && entry.day === today ? entry.count : 0;
  }

  private static readonly STOP_WORDS = new Set([
    "的", "了", "是", "在", "我", "你", "他", "她", "它", "们", "这", "那", "有", "不", "就",
    "都", "也", "还", "又", "要", "会", "能", "把", "给", "让", "被", "和", "与", "或", "但",
    "今天", "昨天", "明天", "现在", "之前", "以后", "可以", "什么", "怎么", "为什么",
    "the", "a", "an", "is", "are", "was", "were", "i", "you", "he", "she", "it", "we", "they",
    "this", "that", "do", "does", "did", "will", "would", "can", "could", "should",
  ]);

  private extractTopicWords(text: string): string[] {
    // 简单分词：英文按词 + 中文按 2-gram 滑动窗口，过滤停用词和短词
    const words: string[] = [];
    // 英文词
    const enMatches = text.toLowerCase().match(/[a-z]{3,}/g) ?? [];
    for (const w of enMatches) {
      if (!MemoryManagerService.STOP_WORDS.has(w)) words.push(w);
    }
    // 中文：先提取连续中文片段，再做 2-gram 滑动窗口
    // 这样"我买的股票涨了"会切出"我买"、"买的"、"的股"、"股票"、"票涨"、"涨了"
    // 高频共现的"股票"能被正确统计
    const chineseSegments = text.match(/[\u4e00-\u9fa5]+/g) ?? [];
    for (const seg of chineseSegments) {
      // 整段（2-6 字）作为主题候选
      if (seg.length >= 2 && seg.length <= 6 && !MemoryManagerService.STOP_WORDS.has(seg)) {
        words.push(seg.toLowerCase());
      }
      // 2-gram 滑动窗口（捕获共同子串）
      for (let i = 0; i < seg.length - 1; i++) {
        const gram = seg.substring(i, i + 2);
        if (!MemoryManagerService.STOP_WORDS.has(gram)) {
          words.push(gram.toLowerCase());
        }
      }
    }
    return words;
  }

  /**
   * 消费当日 journal 行（自游标起），返回供 LLM 整理的文本与用户侧文本。
   * journal 行不删除（夜间固化同用），靠游标记录已消费位置，跨天自动重置。
   */
  private async consumeTodayJournalLines(
    actorId: string,
  ): Promise<{ text: string; userText: string }> {
    const today = this.getTodayDayKey();
    const cursor = this.journalConsumeCursor.get(actorId);
    const from = cursor && cursor.day === today ? cursor.lines : 0;

    const hits =
      (await this.resolveJournal()?.readTodayLines(actorId).catch(() => [])) ?? [];
    this.journalConsumeCursor.set(actorId, { day: today, lines: Math.max(from, hits.length) });

    const consumed = hits.slice(from);
    if (consumed.length === 0) return { text: "", userText: "" };

    const formatRole = (role: string): string =>
      role === "user" ? "用户" : role === "assistant" ? "Agent" : role;
    const text = consumed
      .map((h) => `[${h.time}] ${formatRole(h.role)}: ${h.text}`)
      .join("\n");
    // 话题频次统计只用用户侧行（U/fact/prefer 行在 readTodayLines 中归为 user/fact），
    // 避免 assistant 文本污染词频
    const userText = consumed
      .filter((h) => h.role === "user" || h.role === "fact")
      .map((h) => h.text)
      .join("\n");
    return { text, userText };
  }

  /**
   * 获取当天 top N 高频话题词（用于 consolidate 加分）。
   * 从本次消费的 journal 用户侧行即时统计，只返回出现 >=2 次的词，按频次降序。
   */
  private getTopDailyTopics(userText: string, topN = 5): string[] {
    if (!userText) return [];
    const freq = new Map<string, number>();
    for (const w of this.extractTopicWords(userText)) {
      freq.set(w, (freq.get(w) ?? 0) + 1);
    }
    return [...freq.entries()]
      .filter(([, count]) => count >= 2)
      .sort((a, b) => b[1] - a[1])
      .slice(0, topN)
      .map(([word]) => word);
  }

  async consolidateNow(actorId: string): Promise<MemoryConsolidationResult> {
    const result: MemoryConsolidationResult = {
      entriesMerged: 0,
      entriesRemoved: 0,
      summaryUpdated: false,
      timestamp: new Date().toISOString(),
      rememberedCount: 0,
      fadedCount: 0,
    };

    if (!this.memorySync) return result;

    let lastRetention: Awaited<ReturnType<MemoryManagerService["evaluateMemoryRetention"]>> | null =
      null;
    try {
      const { revision, entries } = this.memorySync.getSnapshot(actorId, [
        "memory_summary",
        "memory_summary_forgotten",
      ]);
      let raw = typeof entries.memory_summary === "string" ? entries.memory_summary : "";

      // 缺口 2 修复 → journal 统一来源：当天待整理内容直接读当日 journal 行
      // （自上次消费游标起），追加到 raw 顶部，确保 dreaming/在线固化优先整理当天内容。
      // 原实现自建 RAM 队列存一份原始轮次，与 DailyJournal 双写同批数据，已删除。
      const dailyPending = await this.consumeTodayJournalLines(actorId);
      if (dailyPending.text) {
        const todayKey = this.getTodayDayKey();
        const dailyBlock = `\n[当日待整理 ${todayKey}]\n${dailyPending.text}\n[/当日待整理]\n`;
        raw = dailyBlock + raw;
        console.log(`[MemoryManager] consolidateNow: 注入当日 journal 行 ${dailyPending.text.split("\n").length} 条到 ${actorId}`);
      }

      if (!raw || raw.length < 50) return result;
      const forgottenRaw =
        typeof entries.memory_summary_forgotten === "string"
          ? entries.memory_summary_forgotten
          : "";

      const lines = raw.split("\n").filter((line) => line.trim().length > 0);
      if (lines.length <= 2) return result;

      const consolidated = this.deduplicateLines(lines);
      result.entriesMerged = lines.length - consolidated.length;

      // 建议 3：取当天高频话题词，传给评分函数给"用户重复问过的话题"加分
      const topTopics = this.getTopDailyTopics(dailyPending.userText);
      if (topTopics.length > 0) {
        console.log(`[MemoryManager] consolidateNow: 当天高频话题加分 ${topTopics.length} 词 → ${actorId}`);
      }
      const retention = await this.evaluateMemoryRetention(consolidated, forgottenRaw, topTopics);
      lastRetention = retention;
      result.entriesRemoved = retention.forgotten.length;
      result.rememberedCount = retention.remembered.length;
      result.fadedCount = retention.faded.length;

      if (result.entriesMerged > 0 || result.entriesRemoved > 0) {
        const newSummary = limitLinesByChars(
          dedupeMemoryLines([...retention.remembered, ...retention.faded], {
            preferLatest: true,
          }),
          this.config.maxSummaryChars,
          { preserveTail: true },
        ).kept.join("\n");
        const forgottenArchive = limitLinesByChars(
          retention.forgottenArchive,
          this.config.maxSummaryChars * 2,
          { preserveTail: true },
        ).kept.join("\n");
        const patchResult = await this.memorySync.applyPatch(actorId, revision, [
          { key: "memory_summary", op: "put", value: newSummary },
          { key: "memory_summary_forgotten", op: "put", value: forgottenArchive },
        ]);
        result.summaryUpdated = patchResult.ok;
      }
    } catch {
      /* fire-and-forget */
    }

    await this.synthesizeProfile(actorId);
    if (lastRetention) {
      this.updateContinuitySnapshot(actorId, lastRetention);
      this.updateRelationshipSnapshot(actorId, lastRetention.remembered);
      this.updateLifeThemeSnapshot(actorId, lastRetention.remembered);
      this.updateDreamSnapshot(actorId, lastRetention);
      if (this.narrativeMemory) {
        await this.performDreamRehearsal(actorId, lastRetention);
      }
    }
    // 画像维护不放这里：画像由对话内统一抽取（LLM 一次调用捎带 profileOps）
    // 确定性落位写入；mem0/扣子等主流做法同样不在记忆整理阶段整文重写画像，
    // 否则每轮整理都会重复调用一次大模型。
    this.turnCounters.set(actorId, 0);
    return result;
  }

  /**
   * forgotten 自动恢复：把命中的 forgotten 行移回 memory_summary。
   *
   * 场景：recall 命中 memory_summary_forgotten 中的行且与当前 query 相关时调用。
   * 实现：原子读取当前 memory_summary + memory_summary_forgotten，
   * 把指定行从 forgotten 移到 summary（去重），通过 applyPatch 写回。
   */
  async restoreForgottenLines(actorId: string, lines: string[]): Promise<void> {
    if (!this.memorySync || lines.length === 0) return;
    try {
      const { revision, entries } = this.memorySync.getSnapshot(actorId, [
        "memory_summary",
        "memory_summary_forgotten",
      ]);
      const currentSummary = typeof entries.memory_summary === "string" ? entries.memory_summary : "";
      const currentForgotten = typeof entries.memory_summary_forgotten === "string" ? entries.memory_summary_forgotten : "";

      const summaryLines = currentSummary.split("\n").filter((l) => l.trim());
      const forgottenLines = currentForgotten.split("\n").filter((l) => l.trim());

      // 把命中的行从 forgotten 摘除，加到 summary（去重）
      const matchedSet = new Set(lines.map((l) => l.trim()).filter(Boolean));
      const remainingForgotten = forgottenLines.filter((l) => !matchedSet.has(l.trim()));
      const restored = lines.filter((l) => {
        const trimmed = l.trim();
        return trimmed && !summaryLines.some((s) => s.trim() === trimmed);
      });
      if (restored.length === 0) return;

      const newSummary = [...summaryLines, ...restored].join("\n");
      const newForgotten = remainingForgotten.join("\n");

      await this.memorySync.applyPatch(actorId, revision, [
        { key: "memory_summary", op: "put", value: newSummary },
        { key: "memory_summary_forgotten", op: "put", value: newForgotten },
      ]);
      console.log(`[MemoryManager] forgotten 自动恢复: ${restored.length} 行移回 memory_summary (${actorId})`);
    } catch (err) {
      console.log(`[MemoryManager] restoreForgottenLines 失败: ${err}`);
    }
  }

  /**
   * forgotten 行 embedding 缓存：key = 行文本指纹，value = 向量。
   * 30 分钟过期，避免 forgotten 内容变化后用旧向量。
   */
  private forgottenEmbeddingCache = new Map<string, { vector: number[]; ts: number }>();
  private static readonly FORGOTTEN_EMBEDDING_TTL_MS = 30 * 60 * 1000;
  private static readonly FORGOTTEN_SEMANTIC_THRESHOLD = 0.7;

  /**
   * 语义化 forgotten 召回（零 LLM）：
   * 1. 路径 A（首选）：embedding cosine 相似度 > 0.7
   * 2. 路径 B（降级）：关键词子串匹配（embedding 不可用或无命中时）
   * 检索阶段不调用 LLM——召回在每轮对话主链路上，按轮次付费的语义判断
   * 属架构性滥用（主流记忆系统只用向量/关键词检索）。
   * 返回与 query 语义相关的 forgotten 行（最多 5 条）。
   */
  async recallForgottenSemantic(actorId: string, query: string): Promise<string[]> {
    if (!this.memorySync) return [];
    try {
      const { entries } = this.memorySync.getSnapshot(actorId, ["memory_summary_forgotten"]);
      const forgottenRaw = entries.memory_summary_forgotten;
      if (typeof forgottenRaw !== "string" || !forgottenRaw.trim()) return [];

      const forgottenLines = forgottenRaw.split("\n").filter((l) => l.trim());
      if (forgottenLines.length === 0) return [];

      // 路径 A：embedding 语义检索（必须用 Embedding 专用 key，对话 LLM key 会 401）
      const apiKey =
        process.env.AGENT_EMBEDDING_API_KEY?.trim() || process.env.OPENAI_API_KEY?.trim();
      const embeddingModel = resolveEmbeddingModel();
      if (apiKey) {
        const embeddingHits = await this.recallForgottenByEmbedding(
          query, forgottenLines, apiKey, embeddingModel,
        );
        if (embeddingHits.length > 0) {
          console.log(`[MemoryManager] forgotten embedding 召回 ${embeddingHits.length} 行 (${actorId})`);
          return embeddingHits;
        }
      }

      // 路径 B：embedding 不可用或无命中 → 关键词匹配兜底（零 LLM）
      return this.recallForgottenByKeyword(query, forgottenLines);
    } catch (err) {
      console.log(`[MemoryManager] recallForgottenSemantic 失败: ${err}`);
      return [];
    }
  }

  /** 路径 A：embedding cosine 相似度检索 */
  private async recallForgottenByEmbedding(
    query: string,
    lines: string[],
    apiKey: string,
    model: string,
  ): Promise<string[]> {
    try {
      const queryVec = await fetchOpenAiCompatibleEmbedding({ apiKey, model, input: query });
      const now = Date.now();
      const scored: { line: string; sim: number }[] = [];

      for (const line of lines) {
        // 查缓存
        const cacheKey = semanticFingerprint(line) || line.slice(0, 64);
        const cached = this.forgottenEmbeddingCache.get(cacheKey);
        let vec: number[];
        if (cached && now - cached.ts < MemoryManagerService.FORGOTTEN_EMBEDDING_TTL_MS) {
          vec = cached.vector;
        } else {
          const r = await fetchOpenAiCompatibleEmbedding({ apiKey, model, input: line });
          vec = r.vector;
          this.forgottenEmbeddingCache.set(cacheKey, { vector: vec, ts: now });
        }
        const sim = cosineSimilarity(queryVec.vector, vec);
        if (sim >= MemoryManagerService.FORGOTTEN_SEMANTIC_THRESHOLD) {
          scored.push({ line, sim });
        }
      }

      return scored.sort((a, b) => b.sim - a.sim).slice(0, 5).map((s) => s.line);
    } catch (err) {
      console.log(`[MemoryManager] recallForgottenByEmbedding 失败: ${err}`);
      return [];
    }
  }

  /** 路径 B：关键词子串匹配（embedding 不可用/无命中时的确定性兜底） */
  private recallForgottenByKeyword(query: string, lines: string[]): string[] {
    // 中文用 2-gram 滑动窗口切分（"我想喝咖啡" → "我想"、"想喝"、"喝咖"、"咖啡"）
    // 避免整句被当成一个词导致子串匹配失败
    const queryWords: string[] = [];
    const segments = query.split(/[\s,，。！？!?\n]+/).filter((s) => s.trim());
    for (const seg of segments) {
      if (seg.length >= 2 && seg.length <= 4) {
        queryWords.push(seg.toLowerCase());
      } else if (seg.length > 4) {
        // 长句用 2-gram 切分
        for (let i = 0; i < seg.length - 1; i++) {
          queryWords.push(seg.substring(i, i + 2).toLowerCase());
        }
      }
    }
    if (queryWords.length === 0) return [];
    return lines
      .filter((line) => {
        const lower = line.toLowerCase();
        return queryWords.some((w) => lower.includes(w));
      })
      .slice(0, 5);
  }

  getUserProfile(actorId: string): UserProfileSnapshot | null {
    return this.pendingProfiles.get(actorId) ?? null;
  }

  getProfileForPrompt(actorId: string): string | null {
    const profile = this.pendingProfiles.get(actorId);
    if (!profile || Object.keys(profile.preferences).length === 0) return null;

    const parts: string[] = ["【用户长期画像 — 后台记忆管理服务自动生成】"];
    if (profile.frequentTopics.length > 0) {
      parts.push(`高频话题: ${profile.frequentTopics.join("、")}`);
    }
    for (const [key, values] of Object.entries(profile.preferences)) {
      if (values.length > 0) {
        parts.push(`${key}: ${values.join("；")}`);
      }
    }
    if (profile.recentIntentions.length > 0) {
      parts.push(`近期意图: ${profile.recentIntentions.join("、")}`);
    }
    return parts.join("\n");
  }

  getContinuityForPrompt(actorId: string): string | null {
    const snapshot = this.continuitySnapshots.get(actorId);
    if (!snapshot) return null;

    const parts = [
      "【记忆连续性】系统会在夜间整理、压缩并逐渐遗忘低价值内容，高价值内容会保留更久。",
      snapshot.stableLines.length > 0 ? `长期保留: ${snapshot.stableLines.slice(0, 6).join("；")}` : "",
      snapshot.fadingLines.length > 0 ? `正在淡化: ${snapshot.fadingLines.slice(0, 4).join("；")}` : "",
      snapshot.forgottenLines.length > 0 ? `最近淡忘: ${snapshot.forgottenLines.slice(0, 4).join("；")}` : "",
      snapshot.temporalHighlights.length > 0
        ? `时间节律: ${snapshot.temporalHighlights.slice(0, 4).join("；")}`
        : "",
      `最近整理: ${snapshot.lastSleepAt}`,
    ].filter(Boolean);
    return parts.join("\n");
  }

  /**
   * 主动跨天 recall（优化 2）：从 temporalHighlights 中提取"昨天/前天"的关键事件。
   *
   * 场景：用户前天说"后天要去玩"，今天提及时 agent 能关联记忆。
   * temporalHighlights 格式为"N天前: 内容片段"，筛 1-3 天前的行注入 prompt，
   * 让 LLM 不依赖当前 query 也能看到最近跨天事件。
   */
  getYesterdayHighlightForPrompt(actorId: string): string | null {
    const snapshot = this.continuitySnapshots.get(actorId);
    if (!snapshot || snapshot.temporalHighlights.length === 0) return null;

    // 筛"昨天"/"前天"/"2-3 天前"的行（格式如 "1天前: xxx" / "2天前: xxx"）
    const recentDays = snapshot.temporalHighlights.filter((line) => {
      const m = line.match(/^(\d+)天前[:：]/);
      return m && Number.parseInt(m[1], 10) >= 1 && Number.parseInt(m[1], 10) <= 3;
    });

    if (recentDays.length === 0) return null;
    return `【跨天事件回顾】${recentDays.slice(0, 4).join("；")}`;
  }

  getRelationshipMemoryForPrompt(actorId: string): string | null {
    const snapshot = this.relationshipSnapshots.get(actorId);
    if (!snapshot || snapshot.lines.length === 0) return null;
    // Phase 6.2 修正：保留 6 行。关系记忆是用户与 Agent 关系的连续性核心，
    // 行数减少会丢失较早的关系节点（如"首次信任建立"、"共同经历 X"），
    // 这些是长期关系记忆不可丢失的部分。压缩交给 compactPromptBlock 的 char 上限处理。
    return `【关系记忆】${snapshot.lines.slice(0, 6).join("；")}`;
  }

  getLifeThemeMemoryForPrompt(actorId: string): string | null {
    const snapshot = this.lifeThemeSnapshots.get(actorId);
    if (!snapshot || snapshot.themes.length === 0) return null;
    // Phase 6.2：6 → 4 行。生活主题是背景性上下文，4 个最相关主题已足够。
    return `【生活主题】${snapshot.themes.slice(0, 4).join("；")}`;
  }

  getDreamMemoryForPrompt(actorId: string): string | null {
    const snapshot = this.dreamSnapshots.get(actorId);
    if (!snapshot) return null;

    // 缺口 5 修复：dreamMemory 从"整理元信息"重构为"昨夜梦境叙事"
    // 原格式："重放: X；强化: Y；主题合并: Z"（机械式，LLM 难以利用）
    // 新格式：叙事化文本，如"昨夜你聊到 X、Y，已合并为 Z；橘猫话题反复出现，已强化"
    // 让 LLM 能像人类回忆梦境一样引用整理结果
    const narrative = this.generateDreamNarrative(snapshot);
    return narrative;
  }

  /**
   * 生成梦境叙事文本（优化 4：职责收窄为跨主题关联）。
   *
   * 原 generateDreamNarrative 只是"复述要点"，和 memory_summary 高度重叠。
   * 新版强调"跨主题关联"：从 remembered/faded 中找不同主题的交叉点，
   * 生成"X 和 Y 似乎有关联"式的洞察，让 LLM 能像人类梦境一样做创造性关联。
   */
  private generateDreamNarrative(snapshot: { replayLines: string[]; reinforcedLines: string[]; mergedThemes: string[]; fadedNoise: string[]; lastUpdatedAt: string }): string {
    const date = new Date(snapshot.lastUpdatedAt);
    const dateStr = `${date.getMonth() + 1}月${date.getDate()}日`;

    const parts: string[] = [];
    parts.push(`【昨夜梦境叙事 ${dateStr}】`);

    // 跨主题关联：从 mergedThemes 中两两配对，生成"X 与 Y 可能有关联"
    // 这是 dreaming 区别于 memory_summary 的核心价值——做创造性关联而非复述
    if (snapshot.mergedThemes.length >= 2) {
      const themes = snapshot.mergedThemes.slice(0, 4).filter((t) => t.trim().length > 0);
      const associations: string[] = [];
      for (let i = 0; i < themes.length - 1; i++) {
        for (let j = i + 1; j < themes.length; j++) {
          if (themes[i] !== themes[j]) {
            associations.push(`${themes[i]} ↔ ${themes[j]}`);
          }
        }
      }
      if (associations.length > 0) {
        parts.push(`梦境浮现的关联：${associations.slice(0, 3).join("；")}`);
      }
    } else if (snapshot.mergedThemes.length > 0) {
      // 退化：只有一个主题时，仍输出但不做关联
      const themes = snapshot.mergedThemes.slice(0, 2).filter((t) => t.trim().length > 0);
      parts.push(`核心主题：${themes.join("、")}`);
    }

    // 强化：反复出现的记忆（像"总是想起的事情"），只保留与 memory_summary 不重叠的
    if (snapshot.reinforcedLines.length > 0) {
      const reinforcedItems = snapshot.reinforcedLines.slice(0, 3).map((line) => {
        return line.replace(/^\[[^\]]+\]\s*/, "").slice(0, 60);
      });
      parts.push(`反复出现、已深化的记忆：${reinforcedItems.join("、")}`);
    }

    // 消散噪音：已淡化的低价值内容（像"想不起来的梦的碎片"）
    if (snapshot.fadedNoise.length > 0) {
      const noiseItems = snapshot.fadedNoise.slice(0, 2).map((line) => {
        return line.replace(/^\[[^\]]+\]\s*/, "").slice(0, 40);
      });
      parts.push(`已逐渐淡忘的：${noiseItems.join("、")}`);
    }

    return parts.join("\n");
  }

  async shutdown(): Promise<void> {
    for (const [actorId, timer] of this.consolidationTimers) {
      clearTimeout(timer);
      this.consolidationTimers.delete(actorId);
      await this.consolidateNow(actorId);
    }
  }

  private scheduleConsolidation(actorId: string): void {
    if (this.consolidationTimers.has(actorId)) return;

    const timer = setTimeout(async () => {
      this.consolidationTimers.delete(actorId);
      await this.consolidateNow(actorId);
    }, this.config.consolidationIntervalMs);

    this.consolidationTimers.set(actorId, timer);
    timer.unref?.();
  }

  /**
   * 白天 idle 轻量整理：用户离开 30min+ 后，即使白天也触发一次记忆整理。
   * 仿人：人类发呆/午休时也会无意识整理近期记忆，不必等到深度睡眠。
   * 以当日 journal 实际内容为门槛（轮数计数器只是触发启发），无可整理内容直接跳过。
   */
  async tryIdleConsolidation(actorId: string): Promise<boolean> {
    // 2026-09-12 token 治理：日间 idle 整理默认关闭（brain-stem idle sweep 等
    // 调用方在此统一被拦），LLM 评分只留夜间 dreaming。置
    // AGENT_MEMORY_DAY_CONSOLIDATION=1 恢复日间整理。
    if (!this.config.dayConsolidationEnabled) return false;
    const hits =
      (await this.resolveJournal()?.readTodayLines(actorId).catch(() => [])) ?? [];
    if (hits.length === 0) return false;

    console.log(
      `[MemoryManager] Daytime idle consolidation for ${actorId} (${hits.length} journal lines)`,
    );
    try {
      await this.consolidateNow(actorId);
      return true;
    } catch (err) {
      console.error(`[MemoryManager] Idle consolidation failed for ${actorId}:`, err);
      return false;
    }
  }

  private deduplicateLines(lines: string[]): string[] {
    return dedupeMemoryLines(lines, { preferLatest: true });
  }

  private isHighValueEntry(line: string): boolean {
    const highValuePatterns = [
      /\[用户要求记住\]/,
      /\[Agent 承诺\/结论\]/,
      /\[fast-path\]/,
      /用户画像/,
      /偏好|喜欢|讨厌|禁忌|生日|纪念日|重要/i,
      /世界账户|购买技能/,
    ];
    return highValuePatterns.some((pattern) => pattern.test(line));
  }

  private async evaluateMemoryRetention(
    lines: string[],
    forgottenRaw: string,
    topTopics: string[] = [],
  ): Promise<{
    remembered: string[];
    faded: string[];
    forgotten: string[];
    forgottenArchive: string[];
  }> {
    const now = Date.now();
    // 确定性语义分：时间衰减 + 高价值信号正则（夜间零 LLM）。
    // 原实现把整份 memory_summary 交给 LLM 逐行评分，一次就是上万输入 token，
    // 且每晚对每个历史 actor 重跑；留存判定并不需要语义模型——衰减曲线和
    // 高价值信号已能覆盖"稳定偏好/事实留下、寒暄淡出"的需求。
    const semanticScores = lines.map((line) => this.heuristicSemanticScore(line));
    const scored = lines.map((line, index) => ({
      line,
      ...this.scoreMemoryLine(line, now, semanticScores[index] ?? 0.5, topTopics),
    }));

    const remembered = scored
      .filter((item) => item.score >= 1.15)
      .sort((a, b) => b.score - a.score || b.ts - a.ts)
      .slice(0, 32)
      .map((item) => item.line);

    const faded = scored
      .filter((item) => item.score >= 0.45 && item.score < 1.15)
      .sort((a, b) => b.score - a.score || b.ts - a.ts)
      .slice(0, 24)
      .map((item) => item.line);

    const forgotten = scored
      .filter((item) => item.score < 0.45)
      .map((item) => item.line)
      .slice(0, 32);

    const forgottenArchive = dedupeMemoryLines(
      [
        ...(forgottenRaw ? forgottenRaw.split("\n").filter(Boolean) : []),
        ...forgotten,
      ],
      { preferLatest: true },
    );

    return { remembered, faded, forgotten, forgottenArchive };
  }

  private scoreMemoryLine(line: string, now: number, semanticScore: number, topTopics: string[] = []): { score: number; ts: number } {
    const match = line.match(/\[(\d{4}-\d{2}-\d{2}T[\d:.]+Z?)\]/);
    const ts = match?.[1] ? Date.parse(match[1]) : now;
    const safeTs = Number.isFinite(ts) ? ts : now;
    const ageHours = Math.max(0, (now - safeTs) / 3_600_000);

    let score = Math.exp(-ageHours / 96);
    score += semanticScore * 0.8;
    if (line.includes("【关系线程】")) score += 0.45;
    if (this.isHighValueEntry(line)) score += 1.15;
    if (/\[fast-path\]|\[Agent 承诺\/结论\]/.test(line)) score += 0.6;
    if (/记住|偏好|喜欢|讨厌|禁忌|生日|纪念|重要/.test(line)) score += 0.4;
    if (/股票|买入|卖出|仓位|止损|止盈|工作|加班|夜里|健康|家人|提醒/.test(line)) score += 0.25;
    // 建议 3：用户当天重复提到的话题加分（最多 +0.3）
    if (topTopics.length > 0) {
      const lower = line.toLowerCase();
      const hitCount = topTopics.filter((t) => lower.includes(t.toLowerCase())).length;
      if (hitCount > 0) score += Math.min(0.3, hitCount * 0.15);
    }
    if (ageHours <= 6) score += 0.28;
    else if (ageHours <= 24) score += 0.18;
    else if (ageHours >= 24 * 14) score -= 0.12;
    if (ageHours > 168) score -= this.isHighValueEntry(line) ? 0.06 : 0.22;

    return { score, ts: safeTs };
  }

  private buildTemporalHighlights(lines: string[]): string[] {
    const now = Date.now();
    return lines
      .slice(0, 12)
      .map((line) => {
        const match = line.match(/\[(\d{4}-\d{2}-\d{2}T[\d:.]+Z?)\]/);
        const ts = match?.[1] ? Date.parse(match[1]) : Number.NaN;
        if (!Number.isFinite(ts)) return null;
        const ageHours = Math.max(0, (now - ts) / 3_600_000);
        const date = new Date(ts);
        const dateStr = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
        const label = formatRelativeAgeLabelCn(ageHours);
        return `${label}: ${dateStr} | ${stripTimestampPrefix(line).slice(0, 64)}`;
      })
      .filter((line): line is string => Boolean(line));
  }

  private updateContinuitySnapshot(
    actorId: string,
    retention: {
      remembered: string[];
      faded: string[];
      forgotten: string[];
      forgottenArchive: string[];
    },
  ): void {
    this.continuitySnapshots.set(actorId, {
      stableLines: retention.remembered,
      fadingLines: retention.faded,
      forgottenLines: retention.forgotten,
      forgottenArchiveLines: retention.forgottenArchive.slice(-8),
      temporalHighlights: this.buildTemporalHighlights([
        ...retention.remembered,
        ...retention.faded,
      ]),
      lastSleepAt: new Date().toISOString(),
      lastUpdatedAt: new Date().toISOString(),
    });
  }

  private updateRelationshipSnapshot(actorId: string, remembered: string[]): void {
    const relationshipLines = remembered.filter((line) => {
      return /陪|关心|鼓励|调侃|默契|信任|支持|晚安|辛苦|安慰/i.test(line);
    });
    this.relationshipSnapshots.set(actorId, {
      lines: relationshipLines.slice(0, 8),
      lastUpdatedAt: new Date().toISOString(),
    });
  }

  private updateLifeThemeSnapshot(actorId: string, remembered: string[]): void {
    const themes = remembered
      .map((line) => this.extractTopic(line))
      .filter((topic) => topic && topic.length >= 2);
    this.lifeThemeSnapshots.set(actorId, {
      themes: [...new Set(themes)].slice(0, 10),
      lastUpdatedAt: new Date().toISOString(),
    });
  }

  private updateDreamSnapshot(
    actorId: string,
    retention: {
      remembered: string[];
      faded: string[];
      forgotten: string[];
      forgottenArchive: string[];
    },
  ): void {
    const replayLines = [...retention.remembered.slice(0, 6), ...retention.faded.slice(0, 4)];
    const reinforcedLines = this.pickReinforcedLines(replayLines, retention.faded);
    const mergedThemes = [...new Set(replayLines.map((line) => this.extractTopic(line)).filter(Boolean))].slice(0, 8);
    const fadedNoise = retention.forgotten.slice(0, 6);
    this.dreamSnapshots.set(actorId, {
      replayLines,
      reinforcedLines,
      mergedThemes,
      fadedNoise,
      lastUpdatedAt: new Date().toISOString(),
    });
  }

  private pickReinforcedLines(primary: string[], secondary: string[]): string[] {
    const buckets = new Map<string, { line: string; count: number }>();
    const ingest = (line: string): void => {
      const key = semanticFingerprint(line) || stripTimestampPrefix(line).toLowerCase();
      if (!key) return;
      const existing = buckets.get(key);
      if (existing) {
        existing.count += 1;
      } else {
        buckets.set(key, { line, count: 1 });
      }
    };

    for (const line of primary) ingest(line);
    for (const line of secondary) ingest(line);

    return [...buckets.values()]
      .filter((entry) => entry.count >= 2 || this.isHighValueEntry(entry.line))
      .sort((a, b) => b.count - a.count || b.line.length - a.line.length)
      .slice(0, 8)
      .map((entry) => entry.line);
  }

  private async performDreamRehearsal(
    actorId: string,
    retention: {
      remembered: string[];
      faded: string[];
      forgotten: string[];
      forgottenArchive: string[];
    },
  ): Promise<void> {
    // 2026-09-12 token 治理：rehearsal 行跨夜去重。memory_summary 的 remembered/faded
    // 集合夜间之间高度重叠，原实现每晚把同一批 dream 行重新 ingest（每行一次
    // extractUnified LLM 调用，且在 Mem0 侧产生重复记忆再靠生命周期审查清理）。
    // 现按行指纹只强化一次，跨夜零重复开销；新进入 remembered/faded 的行仍正常强化。
    await this.loadDreamRehearsalState();
    const replayLines = [...retention.remembered.slice(0, 6), ...retention.faded.slice(0, 3)];
    const reinforcedLines = this.pickReinforcedLines(replayLines, retention.faded);
    const mergedThemes = [...new Set(replayLines.map((line) => this.extractTopic(line)).filter(Boolean))];
    const fadedNoise = retention.forgotten.slice(0, 4);

    for (const line of replayLines) {
      await this.ingestDreamLineOnce(actorId, `dream:replay | ${line}`, "memory:dream_replay", true);
    }

    for (const line of reinforcedLines) {
      await this.ingestDreamLineOnce(actorId, `dream:reinforce | ${line}`, "memory:dream_reinforce", true);
    }

    if (mergedThemes.length > 0) {
      await this.ingestDreamLineOnce(
        actorId,
        `dream:theme_merge | ${mergedThemes.slice(0, 6).join(" | ")}`,
        "memory:dream_theme_merge",
        true,
      );
    }

    for (const line of fadedNoise) {
      await this.ingestDreamLineOnce(actorId, `dream:fade | ${line}`, "memory:dream_fade", false);
    }

    void this.persistDreamRehearsalState();
  }

  /** dream rehearsal 已强化行状态（actorId → 行指纹 → 首次强化日期），持久化到 data/ */
  private dreamRehearsed = new Map<string, Map<string, string>>();
  private dreamRehearsedLoadPromise: Promise<void> | null = null;

  private get dreamRehearsalStatePath(): string {
    return join(process.cwd(), "data", "dream-rehearsal-state.json");
  }

  /** 每 actor 保留的已强化指纹上限（Map 保插入序，超限裁最旧） */
  private static readonly DREAM_REHEARSAL_MAX_FINGERPRINTS = 400;

  private loadDreamRehearsalState(): Promise<void> {
    if (this.dreamRehearsedLoadPromise) return this.dreamRehearsedLoadPromise;
    this.dreamRehearsedLoadPromise = (async () => {
      try {
        const { readFile } = await import("node:fs/promises");
        const raw = await readFile(this.dreamRehearsalStatePath, "utf8");
        const parsed = JSON.parse(raw) as { actors?: Record<string, [string, string][]> };
        for (const [id, entries] of Object.entries(parsed.actors ?? {})) {
          this.dreamRehearsed.set(id, new Map(entries));
        }
      } catch {
        // 首次运行/文件缺失：空状态启动
      }
    })();
    return this.dreamRehearsedLoadPromise;
  }

  private async persistDreamRehearsalState(): Promise<void> {
    try {
      const actors: Record<string, [string, string][]> = {};
      for (const [actorId, entries] of this.dreamRehearsed) {
        actors[actorId] = [...entries];
      }
      await writeJsonAtomic(this.dreamRehearsalStatePath, { version: 1, actors });
    } catch (err) {
      console.warn("[MemoryManager] dream rehearsal state persist failed:", err);
    }
  }

  /** 单行 dream ingest：同一行（指纹相同）跨夜只 ingest 一次，之后的夜晚静默跳过。 */
  private async ingestDreamLineOnce(
    actorId: string,
    text: string,
    kind: "memory:dream_replay" | "memory:dream_reinforce" | "memory:dream_theme_merge" | "memory:dream_fade",
    highSignal: boolean,
  ): Promise<void> {
    const fp = semanticFingerprint(text) || text.slice(0, 64);
    if (this.dreamRehearsed.get(actorId)?.has(fp)) return;

    await this.narrativeMemory
      ?.ingest(actorId, text, kind, { highSignal })
      .catch(() => {});

    let seen = this.dreamRehearsed.get(actorId);
    if (!seen) {
      seen = new Map();
      this.dreamRehearsed.set(actorId, seen);
    }
    seen.set(fp, this.getTodayDayKey());
    const max = MemoryManagerService.DREAM_REHEARSAL_MAX_FINGERPRINTS;
    if (seen.size > max) {
      const excess = seen.size - max;
      let removed = 0;
      for (const key of seen.keys()) {
        seen.delete(key);
        if (++removed >= excess) break;
      }
    }
  }

  private async synthesizeProfile(actorId: string): Promise<void> {
    if (!this.memorySync) return;

    try {
      const { entries } = this.memorySync.getSnapshot(actorId, ["memory_summary"]);
      const raw = typeof entries.memory_summary === "string" ? entries.memory_summary : "";
      if (!raw || raw.length < 100) return;

      const profile = this.extractProfileFromRaw(raw);
      profile.version = (this.pendingProfiles.get(actorId)?.version ?? 0) + 1;
      profile.lastUpdated = new Date().toISOString();
      this.pendingProfiles.set(actorId, profile);

      if (this.narrativeMemory && Object.keys(profile.preferences).length > 0) {
        const profileText = this.formatProfileAsText(profile);
        await this.narrativeMemory
          .ingest(actorId, profileText, "memory:user_profile", { highSignal: true })
          .catch(() => {});
      }
    } catch {
      /* fire-and-forget */
    }
  }

  private heuristicSemanticScore(line: string): number {
    let score = 0.35;
    if (this.isHighValueEntry(line)) score += 0.3;
    if (/\[fast-path\]|\[Agent 承诺\/结论\]/.test(line)) score += 0.15;
    if (/偏好|喜欢|讨厌|禁忌|生日|纪念|提醒|决定|计划|习惯/.test(line)) score += 0.2;
    if (semanticFingerprint(line).split(" ").length >= 4) score += 0.05;
    return Math.min(1, score);
  }

  private extractProfileFromRaw(raw: string): UserProfileSnapshot {
    const profile: UserProfileSnapshot = {
      preferences: {},
      frequentTopics: [],
      recentIntentions: [],
      riskFlags: [],
      lastUpdated: "",
      version: 0,
    };

    const topicCounts = new Map<string, number>();
    const intentionPatterns = /(我会|我想|计划|打算|准备|要)([^。\n]{2,30})/g;
    const preferencePatterns = /(喜欢|讨厌|不喜欢|偏好|习惯|经常|总是|从不|不要|别)([^。\n]{2,40})/g;
    const riskPatterns = /(大额|密码|删除|注销|授权|转账|可疑|异常|防盗|诈骗|钓鱼)/g;

    let match: RegExpExecArray | null;
    while ((match = intentionPatterns.exec(raw)) !== null) {
      const intention = `${match[1]}${match[2]}`;
      profile.recentIntentions.push(intention.slice(0, 60));
      const topic = this.extractTopic(intention);
      topicCounts.set(topic, (topicCounts.get(topic) ?? 0) + 1);
    }

    while ((match = preferencePatterns.exec(raw)) !== null) {
      const category = match[1];
      const value = match[2].trim();
      if (!profile.preferences[category]) profile.preferences[category] = [];
      if (!profile.preferences[category].includes(value)) {
        profile.preferences[category].push(value.slice(0, 80));
      }
      const topic = this.extractTopic(value);
      topicCounts.set(topic, (topicCounts.get(topic) ?? 0) + 1);
    }

    while ((match = riskPatterns.exec(raw)) !== null) {
      const flag = match[1].trim();
      if (!profile.riskFlags.includes(flag)) {
        profile.riskFlags.push(flag);
      }
    }

    profile.frequentTopics = [...topicCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([topic]) => topic);

    profile.recentIntentions = [...new Set(profile.recentIntentions)].slice(-6);
    profile.riskFlags = [...new Set(profile.riskFlags)].slice(-5);

    return profile;
  }

  private extractTopic(text: string): string {
    const keywords = text.match(/[\u4e00-\u9fff]{2,}/g);
    if (keywords && keywords.length > 0) return keywords[0];
    return text.split(/[\s，。！？、]/)[0]?.trim().slice(0, 10) ?? "general";
  }

  private formatProfileAsText(profile: UserProfileSnapshot): string {
    const parts: string[] = [`用户画像 v${profile.version} (${profile.lastUpdated})`];
    if (profile.frequentTopics.length > 0) {
      parts.push(`关注领域: ${profile.frequentTopics.join("、")}`);
    }
    for (const [category, values] of Object.entries(profile.preferences)) {
      if (values.length > 0) {
        parts.push(`${category}: ${values.slice(0, 3).join("；")}`);
      }
    }
    return parts.join("\n");
  }
}

let singleton: MemoryManagerService | null = null;

export function getMemoryManagerService(): MemoryManagerService | null {
  return singleton;
}

export function initMemoryManagerService(
  narrativeMemory: NarrativeMemoryPort | null,
  memorySync: AgentMemorySyncService | null,
  config?: Partial<MemoryManagerConfig>,
): MemoryManagerService | null {
  const cfg = loadConfig();
  if (!cfg.enabled) {
    singleton = null;
    return null;
  }
  singleton = new MemoryManagerService(narrativeMemory, memorySync, config);
  return singleton;
}
