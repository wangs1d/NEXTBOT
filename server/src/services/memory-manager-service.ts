import type { NarrativeMemoryPort } from "./narrative-memory-port.js";
import type { AgentMemorySyncService } from "./agent-memory-sync-service.js";
import { getNightlyMemoryTaskService } from "./nightly-memory-task-service.js";
import { getDailyJournalService, DailyJournalService } from "./daily-journal-service.js";
import { RetentionMap, retentionMaxEntries } from "./resource-pool.js";

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

const DEFAULT_CONFIG: MemoryManagerConfig = {
  enabled: true,
  consolidationIntervalMs: 10 * 60 * 1000,
  maxSummaryChars: 16_000,
  profileUpdateThreshold: 3,
  // 单窗口长会话在线固化：白天 pending queue 积累 ≥15 条立即触发整理
  onlineConsolidationThreshold: 15,
  // 日间在线巩固开关（2026-09-12 token 治理）：默认关闭——LLM 评分
  // 只在夜间 dreaming（consolidateNow 由 nightly-memory-task 触发）执行一次。
  // 置 1 恢复旧的日间在线巩固行为。
  dayConsolidationEnabled: false,
};

/**
 * 常驻条目上限：先取 env（MEMORY_RETAIN_*），再按本机容量收紧。
 * 小机器上即便 env 写了很大的值也拿不到那么多常驻额度。
 */
function retainMax(envName: string, fallback: number): number {
  const n = Number.parseInt(process.env[envName] ?? "", 10);
  return retentionMaxEntries(Number.isFinite(n) && n > 0 ? n : fallback);
}

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

/**
 * 记忆管理器（生命周期门面）。
 *
 * KV 摘要槽（memory_summary / forgotten）已下线：白天只追加 L0 原文与候选，
 * 编译统一由夜间编译（NightlyMemoryTaskService + 编译账本）完成，当前状态由
 * ContextCompiler 从权威库重建。这里只保留触发启发（轮数/空闲）与生命周期，
 * 不再承担任何摘要读写。
 */
export class MemoryManagerService {
  private readonly config: MemoryManagerConfig;
  private readonly consolidationTimers = new Map<string, NodeJS.Timeout>();
  /** 「距上次整理已几轮」计数器：有界，淘汰只让在线固化阈值晚一点触发。 */
  private readonly turnCounters = new RetentionMap<number>("turnCounters", {
    maxEntries: retainMax("MEMORY_RETAIN_TURN_COUNTER_MAX", 2000),
    idleMs: 24 * 60 * 60 * 1000,
  });

  constructor(
    _narrativeMemory: NarrativeMemoryPort | null,
    _memorySync: AgentMemorySyncService | null,
    config?: Partial<MemoryManagerConfig>,
    /** 当日 journal 来源（可注入便于测试）；缺省用全局单例 */
    journal?: DailyJournalService | null,
  ) {
    this.config = { ...loadConfig(), ...config };
    this.journal = journal ?? null;
  }

  /** 注入的 journal 服务（可测性 DI）；null 时用全局单例 */
  private readonly journal: DailyJournalService | null;

  /** 当日待整理内容的唯一来源：注入的 journal 服务或全局单例 */
  private resolveJournal(): DailyJournalService | null {
    return this.journal ?? getDailyJournalService();
  }

  onTurnCompleted(actorId: string, _sessionId: string | undefined, _userText: string, _assistantText: string): void {
    if (!this.config.enabled) return;

    // 原始轮次由 TurnFinalizer 统一落盘 DailyJournal；这里只维护今日轮数，
    // 供在线固化阈值判断。
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
      const pendingCount = this.getTodayTurnCount(actorId);
      if (this.config.dayConsolidationEnabled && pendingCount >= this.config.onlineConsolidationThreshold) {
        void this.tryIdleConsolidation(actorId).catch(() => {
          /* 在线固化失败静默，等待夜间兜底 */
        });
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

  /**
   * 今日轮数计数器（actorId → { day, count }）：仅用于在线固化阈值判断。
   * 原始轮次内容统一由 DailyJournal 落盘（TurnFinalizer 触发）。
   */
  private dailyTurnCounters = new RetentionMap<{ day: string; count: number }>(
    "dailyTurnCounters",
    {
      maxEntries: retainMax("MEMORY_RETAIN_DAILY_TURN_MAX", 256),
      idleMs: 24 * 60 * 60 * 1000,
    },
  );

  private getTodayDayKey(): string {
    const fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Shanghai",
      year: "numeric", month: "2-digit", day: "2-digit",
    });
    return fmt.format(new Date());
  }

  private getTodayTurnCount(actorId: string): number {
    const today = this.getTodayDayKey();
    const entry = this.dailyTurnCounters.get(actorId);
    return entry && entry.day === today ? entry.count : 0;
  }

  async consolidateNow(actorId: string): Promise<MemoryConsolidationResult> {
    // 摘要槽已下线：白天只追加 L0 原文与候选，整理统一由夜间编译完成。
    this.turnCounters.set(actorId, 0);
    return {
      entriesMerged: 0,
      entriesRemoved: 0,
      summaryUpdated: false,
      timestamp: new Date().toISOString(),
      rememberedCount: 0,
      fadedCount: 0,
    };
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
   * 白天 idle 轻量整理触发：以当日 journal 实际内容为门槛（轮数计数器只是
   * 触发启发），无可整理内容直接跳过。
   */
  async tryIdleConsolidation(actorId: string): Promise<boolean> {
    // 日间在线巩固默认关闭，LLM 评分只留夜间 dreaming。
    if (!this.config.dayConsolidationEnabled) return false;
    const hits =
      (await this.resolveJournal()?.readTodayLines(actorId).catch(() => [])) ?? [];
    if (hits.length === 0) return false;
    try {
      await this.consolidateNow(actorId);
      return true;
    } catch {
      return false;
    }
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
