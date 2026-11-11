import { getDataDir } from "../config/data-dir.js";
import type { MemoryManagerService } from "./memory-manager-service.js";
import type { AgentMemorySyncService } from "./agent-memory-sync-service.js";
import type { NarrativeMemoryPort } from "./narrative-memory-port.js";
import type { UnifiedExtraction } from "../agentic-memory/unified-extractor.js";
import { getDailyJournalService } from "./daily-journal-service.js";
import { getDailyDigestService } from "./daily-digest-service.js";
import { getShortTermMemoryGatewayService } from "./short-term-memory-gateway.js";
import { resolvePrimaryLlmClientConfig, bypassChatRequestExtras } from "../external-model/resolve-provider.js";
import { UserFactStore } from "./user-fact-store.js";
import OpenAI from "openai";
import { mkdir } from "node:fs/promises";
import { mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";

import { writeJsonAtomic } from "../storage/atomic-json.js";
import { maybeRunSoulReflection } from "../agent/soul-store.js";
import { auditChatCompletion } from "./llm-token-audit.js";
import {
  isProfileWriteBatchMode,
  getDefaultProfileConsolidator,
  type ProfileConsolidationStats,
} from "./profile-write-scheduler.js";

export type NightlySleepAgentReport = {
  runAt: string;
  actorIds: string[];
  /**
   * 当日 journal 固化计数（含工具结果事件行）：用于确认事件结果是否真的进了
   * 长期记忆；本轮无固化内容时缺省。
   */
  journalFixation?: {
    actors: number;
    lines: number;
    eventLines: number;
    failed: number;
  };
  /**
   * 夜间结构化抽取的质量/成本指标（M4）：一次 LLM 调用产出的 op 数、
   * 被拒 op（无证据/非法）、冲突裁决数、重复事实数。
   */
  extraction?: {
    llmCalls: number;
    factsApplied: number;
    conflictsResolved: number;
    rejectedOps: number;
    duplicates: number;
    themes: number;
  };
  reports: Array<{
    actorId: string;
    dailyCleanupCount: number;
    weeklyMergedCount: number;
    monthlyAbstractedCount: number;
    consistencyFlagCount: number;
    knowledgePromotedCount: number;
    compressionRate: number;
    estimatedRecallPrecision: number;
    plannedActions: number;
    executedActions: number;
    stageReports: Array<{
      stage: string;
      changed: number;
      notes: string[];
    }>;
  }>;
};

export type NightModeConfig = {
  enabled: boolean;
  nightStartHour: number;
  nightEndHour: number;
  timezone: string;
  consolidationBatchSize: number;
};

const DEFAULT_CONFIG: NightModeConfig = {
  enabled: true,
  nightStartHour: 23,
  nightEndHour: 6,
  timezone: "Asia/Shanghai",
  consolidationBatchSize: 50,
};

/**
 * 固化噪音行过滤（P2-6）：U/A 闲聊/语气填充行不进入长期记忆，避免固化噪音污染召回。
 * 高信号行（prefer/fact/commit）不过滤；用户实义陈述与助手有效回答保留。
 */
const CONSOLIDATE_NOISE_RE =
  /^(?:嗯+|哦+|噢+|啊+|诶+|哎|哈|嘿|哟|哦哦|嗯嗯|好的?|好嘞|好滴|好呀|好耶|行|可以|知道了|明白|收到|了解|懂了|是的?|对(?:的|呀|吧)?|没错|随便|没啥|没事|无妨|拜拜|再见|晚安|早上好|下午好|晚上好|你好|嗨|呵呵+|嘿嘿+|哈哈+|算了|好吧|行吧|就这样|没了|没有|不知道|不清楚|不晓得|谢谢(?:你|您)?|多谢|感谢|不用了|别客气|不客气|好的谢谢|可以可以|okk?|okay|sure|yeah|yes|no|thx|thanks?)[。！？!?~,.，\s]*$/i;

/** 内容去掉句读后过短且无实义（如"好的。""嗯""哈哈"）也视为噪音 */
export function isNoiseLogLine(role: string, content: string): boolean {
  if (role === "fact" || role === "prefer" || role === "commit") return false;
  const text = content.replace(/\s+/g, "").replace(/[，。！？!?、；;,.\s]/g, "");
  if (!text) return true;
  return CONSOLIDATE_NOISE_RE.test(content) || text.length <= 1;
}

/** 事实文本归一（去空白/句读、小写），用于批内与跨批去重 */
function normalizeFactText(text: string): string {
  return text.replace(/\s+/g, "").replace(/[，。！？!?、；;,.\s]/g, "").toLowerCase();
}

/**
 * M1-④：无 LLM 时的确定性事实兜底。
 *
 * 白天 journal 已给高信号行打了 fact/prefer/commit 角色标签（写入侧规则
 * 抽取，零模型）。夜间直接按标签落库，保证「没有模型也能固化事实」。
 */
export function deriveDeterministicFacts(transcript: string): {
  facts: Array<{ kind: "preference" | "fact" | "commitment"; text: string }>;
  duplicates: number;
} {
  const kindMap = { prefer: "preference", fact: "fact", commit: "commitment" } as const;
  const seen = new Set<string>();
  const facts: Array<{ kind: "preference" | "fact" | "commitment"; text: string }> = [];
  let duplicates = 0;
  for (const line of transcript.split("\n")) {
    const m = line.match(/^\[[^\]]*\s(fact|prefer|commit)\]\s*(.+)$/);
    if (!m) continue;
    const kind = kindMap[m[1] as keyof typeof kindMap];
    const text = m[2]!.trim().slice(0, 200);
    if (!text) continue;
    const key = `${kind}|${normalizeFactText(text)}`;
    if (seen.has(key)) {
      duplicates += 1;
      continue;
    }
    seen.add(key);
    facts.push({ kind, text });
  }
  return { facts: facts.slice(0, 24), duplicates };
}

function loadNightConfig(): NightModeConfig {
  return {
    ...DEFAULT_CONFIG,
    enabled: process.env.NIGHT_MEMORY_MODE !== "0",
    nightStartHour:
      Number.parseInt(process.env.NIGHT_START_HOUR ?? "", 10) || DEFAULT_CONFIG.nightStartHour,
    nightEndHour:
      Number.parseInt(process.env.NIGHT_END_HOUR ?? "", 10) || DEFAULT_CONFIG.nightEndHour,
  };
}

export class NightlyMemoryTaskService {
  private readonly config: NightModeConfig;
  private schedulerTimer: NodeJS.Timeout | null = null;
  private isNightMode = false;
  /**
   * per-actor 夜间处理水位线（actorId → 已处理日 key）。
   *
   * 原实现是全局 lastProcessedDay：任一 actor 触发后当天其余 actor 全被
   * 挡住；晚睡/后进入 sleeping 的 actor 只能等次日补跑。改为逐 actor 水位，
   * 每个 actor 独立补跑自己的当日 journal。
   */
  private lastProcessedDayByActor = new Map<string, string>();
  /** 正在处理中的 actor（防止同一 actor 的夜间任务并发重入） */
  private readonly actorsInFlight = new Set<string>();
  private memoryManager: MemoryManagerService | null = null;
  private factStore: UserFactStore | null = null;
  private memorySync: AgentMemorySyncService | null = null;
  private narrativeMemory: NarrativeMemoryPort | null = null;
  /**
   * AwarenessCortex 引用（可选）。
   * 注入后，dreaming 触发条件从"仅时间窗"升级为"时间窗 + sleeping 状态"双条件，
   * 避免用户深夜还在密集对话时强行触发 dreaming 造成竞态。
   *
   * 动态窗口扩展（2026-10-16 接口统一）：夜间窗口从 UserTimingService
   * 统一取用口取（多源：节律活跃学习 > 在场足迹 > 会话睡眠窗口），
   * 不再直连 AwarenessCortex.getLearnedSleepWindow。
   */
  private userTiming: {
    sleepWindow(actorId: string): { startHour: number; endHour: number; sampleCount: number } | null;
  } | null = null;
  /** AwarenessCortex（dreaming 触发用：observe 轮询活动状态；窗口取数已移交 UserTimingService） */
  private awarenessCortex: {
    observe(actorId: string): { activity: string } | null;
  } | null = null;
  /**
   * 记录已触发 dreaming 的 actor，避免同一夜间重复触发。
   * key: actorId, value: 当晚首次触发时间 ISO。
   */
  private dreamingTriggeredActors = new Map<string, string>();
  private readonly reportFilePath =
    process.env.AGENT_MEMORY_SLEEP_REPORT_FILE?.trim() ??
    join(getDataDir(), "nightly-memory-reports.json");
  private latestReport: NightlySleepAgentReport | null = null;
  /** 本轮 journal 固化计数（runNightTasks 开始时清零） */
  private lastJournalFixation: NightlySleepAgentReport["journalFixation"] | null = null;
  /** 本轮结构化抽取指标（M4 报告用） */
  private lastExtractionMetrics: NonNullable<NightlySleepAgentReport["extraction"]> | null = null;
  private recentReports: NightlySleepAgentReport[] = [];

  constructor(config?: Partial<NightModeConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  setDependencies(
    memoryManager: MemoryManagerService | null,
    memorySync: AgentMemorySyncService | null,
    narrativeMemory?: NarrativeMemoryPort | null,
  ): void {
    this.memoryManager = memoryManager;
    this.memorySync = memorySync;
    this.narrativeMemory = narrativeMemory ?? null;
  }

  /**
   * 注入 AwarenessCortex（缺口 3 修复）。
   *
   * 注入后：
   * - tick() 在夜间会检测每个 actor 的 sleeping 状态
   * - 只对处于 sleeping 状态的 actor 触发 dreaming
   * - 保留"昼夜切换兜底"：若用户整夜不睡，夜→昼切换时补跑
   * （动态夜间窗口 2026-10-16 起改走 setUserTiming 注入的统一取用口）
   */
  setAwarenessCortex(
    svc: {
      observe(actorId: string): { activity: string } | null;
    } | null,
  ): void {
    this.awarenessCortex = svc;
    console.log(
      `[NightlyMemory] ${svc ? "已注入 AwarenessCortex（dreaming 双条件触发已启用）" : "AwarenessCortex 已清除"}`,
    );
  }

  /** 注入用户时刻统一取用口（夜间模式动态窗口的数据来源，2026-10-16 接口统一） */
  setUserTiming(
    svc: {
      sleepWindow(actorId: string): { startHour: number; endHour: number; sampleCount: number } | null;
    } | null,
  ): void {
    this.userTiming = svc;
  }

  startScheduler(): void {
    if (!this.config.enabled || this.schedulerTimer) return;

    this.updateNightMode();
    this.schedulerTimer = setInterval(() => this.tick(), 60_000);
    console.log(
      `[NightlyMemory] Scheduler started. Night mode: ${this.config.nightStartHour}:00-${this.config.nightEndHour}:00 (${this.config.timezone})`,
    );
  }

  stopScheduler(): void {
    if (this.schedulerTimer) {
      clearInterval(this.schedulerTimer);
      this.schedulerTimer = null;
    }
  }

  isInNightMode(): boolean {
    return this.isNightMode;
  }

  getLatestReport(): NightlySleepAgentReport | null {
    return this.latestReport;
  }

  getRecentReports(): NightlySleepAgentReport[] {
    return [...this.recentReports];
  }

  shouldDeferConsolidation(): boolean {
    return this.config.enabled && !this.isNightMode;
  }

  async forceRunNightTasks(): Promise<{
    consolidated: boolean;
    archived: boolean;
    synced: boolean;
    slotResync?: Record<string, { facts: number; preferences: number; keptRecent: number }>;
    /** ⑥ 巩固流水线收尾统计（关闭的悬空问句 / 生成的一日回顾条数 / 遗忘衰减扫描） */
    pipeline?: {
      recaps: number;
      questionsClosed: number;
      decay?: { scanned: number; decayed: number; pruned: number };
    };
    error?: string;
  }> {
    const result = {
      consolidated: false,
      archived: false,
      synced: false,
      slotResync: undefined as
        | Record<string, { facts: number; preferences: number; keptRecent: number }>
        | undefined,
      pipeline: undefined as
        | {
            recaps: number;
            questionsClosed: number;
            decay?: { scanned: number; decayed: number; pruned: number };
          }
        | undefined,
      error: undefined as string | undefined,
    };
    this.lastJournalFixation = null;

    try {
      // 记忆架构收敛：原「DailyDigest 归档 → 长期图」已移除——与下方
      // consolidateDailyJournals（journal → 长期图）对同批当天对话双写长期记忆，
      // 白天只写 journal 一份原始流水，夜间固化单一入口。
      result.archived = true;

      // 派生视图强制重同步（确定性，零 LLM）：让事实主库的习惯门槛/保鲜规则
      // 立即作用于 KV 槽位（2026-11-07 习惯画像定稿）。放在最前——即使后续
      // LLM 巩固阶段缓慢/失败，槽位也已与主库收敛；数据手术后的立即收敛口。
      result.slotResync = await this.resyncDerivedSlotsForAllActors();

      await this.extractFactsFromJournals();
      await this.consolidateUserProfiles();
      // 顺序修复（M1-②）：memory_summary 巩固必须先读当天 journal 行；
      // consolidateDailyJournals 固化成功后会删除 journal md，放到后面就再也读不到。
      await this.consolidateSummaries();
      await this.consolidateDailyJournals();
      result.pipeline = await this.runDreamPhase();
      result.consolidated = true;

      await this.syncToLongTermStorage();
      result.synced = true;
    } catch (err) {
      result.error = err instanceof Error ? err.message : String(err);
      console.error("[NightlyMemory] Force run failed:", err);
    }

    return result;
  }

  private tick(): void {
    const wasNight = this.isNightMode;
    this.updateNightMode();

    if (!wasNight && this.isNightMode) {
      // 昼→夜 切换：不再立即触发，而是等待 sleeping 状态（缺口 3 修复）
      // 若未注入 awarenessCortex，则回退到原立即触发行为（向后兼容）
      if (!this.awarenessCortex) {
        console.log("[NightlyMemory] Night mode activated (无 awarenessCortex，回退立即触发)");
        this.runNightTasks().catch((err) => {
          console.error("[NightlyMemory] Night tasks failed:", err);
        });
      } else {
        console.log("[NightlyMemory] Night mode activated, waiting for sleeping state to trigger dreaming...");
        // 进入夜间时清空已触发记录，让新夜晚的 sleeping 重新触发
        this.dreamingTriggeredActors.clear();
      }
    }

    // 缺口 3 修复：夜间每分钟检测 sleeping 状态，逐 actor 触发 dreaming
    if (this.isNightMode && this.awarenessCortex) {
      this.checkSleepingAndTriggerDreaming().catch((err) => {
        console.error("[NightlyMemory] Sleeping-triggered dreaming failed:", err);
      });
    }

    if (wasNight && !this.isNightMode) {
      // 夜→昼 切换：兜底补跑（若整夜未触发）
      if (this.hasDueActors()) {
        console.log("[NightlyMemory] Day mode activated, running missed night tasks as fallback");
        this.runNightTasks().catch((err) => {
          console.error("[NightlyMemory] Fallback night tasks failed:", err);
        });
      } else {
        console.log("[NightlyMemory] Day mode activated, night tasks already processed");
      }
    }

    this.checkMidnightRollover();
  }

  /**
   * 检查每个 actor 的 sleeping 状态，对首次进入 sleeping 的 actor 触发 dreaming。
   *
   * - 注入了 awarenessCortex 才生效
   * - 每个 actor 每晚只触发一次（dreamingTriggeredActors 去重）
   * - sleeping 判定由 awareness-cortex.ts 完成（30min 无桌面活动 + 23:00-6:00）
   */
  private async checkSleepingAndTriggerDreaming(): Promise<void> {
    if (!this.awarenessCortex) return;
    const today = this.getTodayKey();
    // 新一天开始时清空已触发记录。
    // 注意：这里存的是 getTodayKey()（服务器本地日期），不能再存 UTC ISO 再
    // slice(0,10) 比——服务器在 Asia/Shanghai 时，凌晨 00:00-08:00 的 UTC 日期
    // 是前一天，两边永远不等 → 每分钟 clear 一次 → 「entered sleeping」日志
    // 每分钟刷一轮、observe() 白跑（2026-11-11 排查发现）。
    if (this.dreamingTriggeredActors.size > 0) {
      const firstTriggerDay = this.dreamingTriggeredActors.values().next().value;
      if (firstTriggerDay !== undefined && firstTriggerDay !== today) {
        this.dreamingTriggeredActors.clear();
      }
    }

    const actorIds = this.getAllActorIds();
    for (const actorId of actorIds) {
      if (this.dreamingTriggeredActors.has(actorId)) continue;
      try {
        const state = this.awarenessCortex.observe(actorId);
        if (state?.activity === "sleeping") {
          console.log(`[NightlyMemory] Actor ${actorId} entered sleeping, triggering dreaming...`);
          this.dreamingTriggeredActors.set(actorId, today);
          // 逐 actor 触发：只处理该 actor 的当日流水，后睡者独立补跑，
          // 不再被其他 actor 的全局水位线挡住（M1-①）。
          await this.runNightTasks([actorId]);
        }
      } catch (err) {
        // observe 失败不阻塞其他 actor
        console.log(`[NightlyMemory] observe(${actorId}) failed: ${err}`);
      }
    }
  }

  /**
   * 判定当前是否处于夜间模式。
   *
   * 动态窗口优先级（2026-10-16 接口统一）：
   * 1. UserTimingService.sleepWindow 学到的个性化窗口（多源合并：节律活跃
   *    学习 > 在场足迹 > 会话睡眠窗口，样本门槛由各源自行把关）
   * 2. 否则回退到 config.nightStartHour/nightEndHour（默认 23-6 或 env 配置）
   *
   * 多 actor 场景：只要有任一 actor 学习到个性化窗口，就采用该窗口。
   * （通常一个主机只有一个主用户，多 actor 时取第一个有效的即可）
   */
  private updateNightMode(): void {
    const now = new Date();
    // 使用分钟精度判定，避免 23:30 进入 sleeping 但整点判定还在白天的问题
    const hourStr = new Intl.DateTimeFormat("en-US", {
      timeZone: this.config.timezone,
      hour: "numeric",
      minute: "numeric",
      hour12: false,
    }).format(now);
    const [h, m] = hourStr.split(":").map(Number);
    const hourDecimal = h + m / 60;

    // 尝试获取动态学习到的窗口（统一取用口）
    let startHour = this.config.nightStartHour;
    let endHour = this.config.nightEndHour;
    let usingDynamic = false;
    if (this.userTiming) {
      for (const actorId of this.getAllActorIds()) {
        const learned = this.userTiming.sleepWindow(actorId);
        if (learned) {
          startHour = learned.startHour;
          endHour = learned.endHour;
          usingDynamic = true;
          break;
        }
      }
    }

    // 跨天窗口（start > end，如 23.5→6.25）：hour >= start OR hour < end
    // 同天窗口（start < end，如 13→14 午休）：start <= hour < end
    if (startHour > endHour) {
      this.isNightMode = hourDecimal >= startHour || hourDecimal < endHour;
    } else {
      this.isNightMode = hourDecimal >= startHour && hourDecimal < endHour;
    }

    // 动态窗口切换日志（仅在切换时打印一次，避免每分钟刷屏）
    if (usingDynamic && !this.loggedDynamicWindow) {
      console.log(
        `[NightlyMemory] 动态睡眠窗口已启用：${startHour.toFixed(2)}→${endHour.toFixed(2)}（基于用户习惯学习）`,
      );
      this.loggedDynamicWindow = true;
    } else if (!usingDynamic && this.loggedDynamicWindow) {
      console.log(
        `[NightlyMemory] 回退默认睡眠窗口：${startHour}:00→${endHour}:00（学习样本不足）`,
      );
      this.loggedDynamicWindow = false;
    }
  }
  private loggedDynamicWindow = false;

  /**
   * 夜间任务主入口。actorIds 缺省处理全部 actor；传参时只处理这些 actor
   * （sleeping 逐 actor 触发用）。每个 actor 有独立当日水位线，重复触发是幂等的。
   */
  private async runNightTasks(actorIds?: string[]): Promise<void> {
    const today = this.getTodayKey();
    const candidates = (actorIds ?? this.getAllActorIds()).filter(
      (id) => this.lastProcessedDayByActor.get(id) !== today && !this.actorsInFlight.has(id),
    );
    if (candidates.length === 0) return;

    // 先占位避免并发重入；失败时回滚，允许下一次补跑
    for (const id of candidates) this.actorsInFlight.add(id);
    this.lastJournalFixation = null;

    console.log(`[NightlyMemory] Running night tasks for ${candidates.join(",")} (${today})`);

    try {
      // 巩固管线（episodic → semantic）：journal 固化前先把日志批处理成稳定事实
      // （写入结构化槽位，latest-wins 归并）。夜间常规只有这一次 LLM 调用；
      // 无 LLM 时退化为 journal fact/prefer/commit 标签行的确定性落库（M1-④）。
      await this.extractFactsFromJournals(candidates);
      await this.consolidateUserProfiles(candidates);
      await this.runSoulReflectionIfDue(candidates);
      // 顺序修复（M1-②）：摘要巩固读 journal 必须在 journal 删除之前。
      await this.consolidateSummaries(candidates);
      await this.consolidateDailyJournals(candidates);
      await this.runDreamPhase(candidates);
      // M3：提交后不变量自检（同 kind+subject 不得双 active / active 必须有非空证据值）。
      await this.auditFactStoreInvariants(candidates);
      await this.syncToLongTermStorage(candidates);
      await this.cleanupOldStorage();
      for (const id of candidates) {
        this.lastProcessedDayByActor.set(id, today);
        this.actorsInFlight.delete(id);
      }
      console.log("[NightlyMemory] All night tasks completed successfully");
    } catch (err) {
      for (const id of candidates) this.actorsInFlight.delete(id);
      console.error("[NightlyMemory] Night tasks error:", err);
    }
  }

  /** 是否存在今天尚未处理的 actor（昼夜切换兜底 / 调度判定用） */
  private hasDueActors(): boolean {
    const today = this.getTodayKey();
    return this.getAllActorIds().some(
      (id) => this.lastProcessedDayByActor.get(id) !== today && !this.actorsInFlight.has(id),
    );
  }

  /**
   * M3 提交后不变量自检（确定性，零 LLM）：
   * - 同一 kind+subject 槽位不得同时存在两条活跃事实；
   * - 活跃事实必须有非空的值（证据）。
   * 只审计告警，不做自动改写——异常暴露给报告/日志，避免静默双写漂移。
   */
  private async auditFactStoreInvariants(actorIds: string[]): Promise<void> {
    try {
      const store = this.getFactStore();
      for (const actorId of actorIds) {
        const facts = await store.getFacts(actorId);
        const seen = new Set<string>();
        let anomalies = 0;
        for (const fact of facts) {
          const key = `${fact.kind}:${fact.subject}`;
          if (seen.has(key)) anomalies += 1;
          seen.add(key);
          if (!fact.value.trim()) anomalies += 1;
        }
        if (anomalies > 0) {
          console.warn(
            `[NightlyMemory] 不变量自检: actor=${actorId} 发现 ${anomalies} 条异常（双 active / 空证据）`,
          );
        }
      }
    } catch (err) {
      console.warn("[NightlyMemory] 不变量自检失败:", err);
    }
  }

  /**
   * memory_summary 巩固（原 runDreamPhase 内的 consolidateNow 循环，提前到
   * journal 固化之前）。独立成方法是为了保证读 journal 的顺序正确。
   */
  private async consolidateSummaries(actorIds?: string[]): Promise<void> {
    const candidates = actorIds ?? this.getAllActorIds();
    for (const actorId of candidates.slice(0, this.config.consolidationBatchSize)) {
      try {
        const result = await this.memoryManager?.consolidateNow(actorId);
        if (result && (result.entriesMerged > 0 || result.entriesRemoved > 0)) {
          console.log(
            `[NightlyMemory] Summary consolidation actor=${actorId} merged=${result.entriesMerged} removed=${result.entriesRemoved} remembered=${result.rememberedCount} faded=${result.fadedCount}`,
          );
        }
      } catch (err) {
        console.error(`[NightlyMemory] Summary consolidation failed for ${actorId}:`, err);
      }
    }
  }

  /**
   * 灵魂周级反思：复用夜间事实提炼阶段拼好的精简流水（零额外读盘）。
   * 周级门禁在 soul-store 内部（changelog 最近一条 ≥7 天才调 LLM），
   * 每周最多一次；LLM 缺失/失败静默跳过，绝不影响后续固化阶段。
   */
  private async runSoulReflectionIfDue(actorIds?: string[]): Promise<void> {
    const journal = getDailyJournalService();
    if (!journal) return;
    try {
      for (const actorId of actorIds ?? this.getAllActorIds()) {
        const built = await this.buildNightlyTranscript(journal, actorId);
        if (!built) continue;
        const soul = await maybeRunSoulReflection({ transcript: built.transcript });
        if (soul.applied) {
          console.log(`[NightlyMemory] Soul reflection applied (${soul.reason})`);
        }
        // M1-⑥：原 return 让多 actor 时只处理第一个；改为继续遍历（soul-store
        // 自带 7 天门禁，后续 actor 不会产生额外 LLM 调用）。
      }
    } catch (err) {
      console.error("[NightlyMemory] Soul reflection failed:", err);
    }
  }

  /** 从未固化 journal 行拼装精简流水（夜间事实提炼 / 灵魂反思共用） */
  private async buildNightlyTranscript(
    journal: NonNullable<ReturnType<typeof getDailyJournalService>>,
    actorId: string,
  ): Promise<{ transcript: string; observedOn: string } | null> {
    const unconsolidated = await journal.getUnconsolidatedLines(actorId);
    if (unconsolidated.length === 0) return null;

    const transcriptLines: string[] = [];
    let observedOn: string | null = null;
    for (const { dateKey, lines } of unconsolidated) {
      // 观察日 = 本批日志覆盖的最大日历日（跨天补跑时一次调用只记 1 天证据，
      // 保守口径：习惯多日门槛靠不同「运行日」累积，不因一次补跑灌水）
      if (/^\d{4}-\d{2}-\d{2}/.test(dateKey)) {
        const day = dateKey.slice(0, 10);
        if (!observedOn || day > observedOn) observedOn = day;
      }
      for (const line of lines) {
        const m = line.match(/^- \[(\d{2}:\d{2})\]\s*(.*)$/);
        if (!m) continue;
        const roleMatch = m[2]!.match(/^(?:(\S+)\s+)?(U|A|fact|prefer|commit):\s*(.+)$/);
        if (!roleMatch) continue;
        const role = roleMatch[2]!;
        const content = roleMatch[3]!.slice(0, 300);
        if (isNoiseLogLine(role, content)) continue;
        transcriptLines.push(`[${dateKey} ${m[1]} ${role}] ${content}`);
      }
    }
    if (transcriptLines.length < 4) return null;
    return {
      transcript: transcriptLines.slice(-120).join("\n"),
      observedOn: observedOn ?? new Date().toISOString().slice(0, 10),
    };
  }

  /**
   * 当日对话日志固化（记忆架构重构核心环节）：
   * - 消费 DailyJournal 未固化日志行（含跨天补跑——服务器隔夜未开机也能追上）；
   * - 写入 narrative 长期记忆（journal:consolidate 来源，偏好/事实行高信号）；
   * - 固化完成后标记已处理并删除对应 md（内容已入 LTM，文件只承载未固化当天记忆）。
   */
  private async consolidateDailyJournals(actorIds?: string[]): Promise<void> {
    const journal = getDailyJournalService();
    if (!journal || !this.narrativeMemory) return;

    const targets = actorIds ?? this.getAllActorIds();
    let totalIngested = 0;
    let totalEventLines = 0;
    let totalFailed = 0;
    let consolidatedActors = 0;

    for (const actorId of targets) {
      try {
        const unconsolidated = await journal.getUnconsolidatedLines(actorId);
        if (unconsolidated.length === 0) continue;

        const dateKeys: string[] = [];
        const consumedTurnIds: string[] = [];
        const failedDates = new Set<string>();
        let eventLines = 0;
        let failed = 0;
        for (const { dateKey, lines, turnIds } of unconsolidated) {
          let ingested = 0;
          let noiseSkipped = 0;
          for (const line of lines) {
            // 行格式: - [HH:mm] sessId? U|A|fact|prefer|commit: content
            const m = line.match(/^- \[(\d{2}:\d{2})\]\s*(.*)$/);
            if (!m) continue;
            const time = m[1]!;
            const body = m[2]!;
            const roleMatch = body.match(/^(?:(\S+)\s+)?(U|A|fact|prefer|commit):\s*(.+)$/);
            if (!roleMatch) continue;
            const role = roleMatch[2]!;
            const content = roleMatch[3]!;
            // 事件行带 `e-<key>` 短标记：还原来源事件 id，LTM 条目保留可追溯性
            const journalToken = roleMatch[1] ?? "";
            const provenance =
              role === "fact" && /^e-[\w-]+$/.test(journalToken)
                ? { sourceEventIds: [`evt:${actorId}:${journalToken.slice(2)}`] }
                : {};
            // P2-6：U/A 闲聊/语气填充行不固化（fact/prefer/commit 恒保留）
            if (isNoiseLogLine(role, content)) {
              noiseSkipped += 1;
              continue;
            }
            const roleLabel = role === "U" ? "用户" : role === "A" ? "助手" : role;
            const isEventLine = provenance.sourceEventIds !== undefined;
            const highSignal = role === "prefer" || role === "fact" || role === "commit";
            // 2026-09-12 token 治理（P0-A）：固化行直存（infer:false），不再逐行二次抽取。
            // 同批对话内容白天已由统一写入者 extractUnified 抽取过并写入同一存储；夜间
            // 逐行 ingest 每行再触发一次 extractUnified 属纯重复（产生的重复记忆还要靠
            // 次日 24h 生命周期审查再花 LLM 清理）。固化的价值是 episodic 时间线——
            // 原文直存即可；语义提升由 extractFactsFromJournals 的整批事实提炼承担。
            const fixationText = `[日志固化 ${dateKey} ${time}·${roleLabel}] ${content}`;
            const fixationExtraction: UnifiedExtraction = {
              decision: highSignal ? "remember" : "decay",
              memories: [fixationText],
              corrections: [],
              understandings: [],
              facts: [],
              forget: [],
              referents: [],
              // 工具结果事件跨情境价值低于用户陈述：低一档，按生命周期正常淡出
              importance: isEventLine ? 0.5 : highSignal ? 0.7 : 0.3,
            };
            try {
              const outcome = await this.narrativeMemory!.writeDecided(
                actorId,
                fixationText,
                "journal:consolidate",
                { context: "main", highSignal, ...provenance },
                fixationExtraction,
              );
              // 只有真正落库（或未配置落库侧）才允许后续删除 journal 原文
              if (outcome === undefined || outcome.persisted) {
                ingested += 1;
                if (isEventLine) eventLines += 1;
              } else {
                failed += 1;
                failedDates.add(dateKey);
                console.error(
                  `[NightlyMemory] journal 行固化未落库（保留原文待重试）: actor=${actorId} date=${dateKey}`,
                );
              }
            } catch (err) {
              failed += 1;
              failedDates.add(dateKey);
              console.log(`[NightlyMemory] journal 行固化失败（跳过该行）: ${err}`);
            }
          }
          // 当天存在任何未落库的行时，整天都不标记已固化，避免删除后不可重试。
          // 纯噪音轮次（全部被 isNoiseLogLine 过滤）同样视为已消费，否则永远 pending。
          if ((ingested > 0 || noiseSkipped > 0 || lines.length === 0) && !failedDates.has(dateKey)) {
            dateKeys.push(dateKey);
            consumedTurnIds.push(...turnIds);
          }
          totalIngested += ingested;
        }
        totalEventLines += eventLines;
        totalFailed += failed;

        if (failedDates.size > 0) {
          // 失败日期保持 pending：turns 原文不丢，outbox 记录 attempts 供次日重试
          journal.recordConsolidationFailure(
            actorId,
            [...failedDates],
            "journal line consolidation failed",
          );
        }

        if (dateKeys.length > 0) {
          await journal.markConsolidated(actorId, dateKeys, consumedTurnIds);
          consolidatedActors += 1;
          console.log(
            `[NightlyMemory] journal 固化: actor=${actorId} dates=${dateKeys.join(",")} 已入长期记忆`,
          );
        }
      } catch (err) {
        console.error(`[NightlyMemory] journal consolidation failed for ${actorId}:`, err);
      }
    }

    if (totalIngested > 0) {
      this.lastJournalFixation = {
        actors: consolidatedActors,
        lines: totalIngested,
        eventLines: totalEventLines,
        failed: totalFailed,
      };
      console.log(
        `[NightlyMemory] journal consolidation total ingested: ${totalIngested} lines` +
          (totalEventLines > 0 ? `（事件行 ${totalEventLines}）` : "") +
          (totalFailed > 0 ? `，失败 ${totalFailed}` : ""),
      );
    } else if (totalFailed > 0) {
      // 全部未落库：保留原文，但要把失败暴露出来，避免静默
      this.lastJournalFixation = {
        actors: consolidatedActors,
        lines: 0,
        eventLines: totalEventLines,
        failed: totalFailed,
      };
      console.error(
        `[NightlyMemory] journal consolidation 全部未落库，原文已保留待重试：失败 ${totalFailed} 行`,
      );
    } else {
      this.lastJournalFixation = null;
    }
  }

  /**
   * ⑥ 巩固流水线收尾（一次跑完，2026-11-08）。
   *
   * 与现有 dreaming 共用同一入口，不新建独立巩固器：
   *   日结摘要（digest）→ 事实升格（extractFactsFromJournals 已在上游完成）
   *   → 关闭悬空问句（STM 会话状态槽）→ 一句话回顾（digest summaryLayer）
   *
   * 问句本体不删除：①原文窗口与情景日志里的 agent 问句保持原样，这里只清
   * 「待追问」标记，保证夜间之后不会跨天复读同一个问题。
   */
  private async runConsolidationPipeline(actorIds?: string[]): Promise<{
    recaps: number;
    questionsClosed: number;
    decay: { scanned: number; decayed: number; pruned: number };
  }> {
    const questionsClosed = getShortTermMemoryGatewayService()?.closePendingQuestions() ?? 0;
    const targets = actorIds ?? this.getAllActorIds();

    const digest = getDailyDigestService();
    let recaps = 0;
    for (const actorId of targets) {
      try {
        if (digest.consolidateDayRecap(actorId)) recaps += 1;
      } catch (err) {
        console.error(`[NightlyMemory] day recap failed for ${actorId}:`, err);
      }
    }

    // P2 遗忘曲线收尾：巩固之后统一跑一次衰减/剪枝（共享曲线 + 访问频率 + 情绪显著度）。
    // 通过注入的 decayRunner 调用 MemoryForgettingController，避免 nightly ⇄ brain 循环依赖。
    const decay = { scanned: 0, decayed: 0, pruned: 0 };
    if (this.decayRunner) {
      try {
        const stats = await this.decayRunner(targets);
        decay.scanned = stats.scanned;
        decay.decayed = stats.decayed;
        decay.pruned = stats.pruned;
      } catch (err) {
        console.error("[NightlyMemory] decay sweep failed (ignored):", err);
      }
    }

    console.log(
      `[NightlyMemory] Consolidation pipeline: questionsClosed=${questionsClosed} recaps=${recaps} ` +
        `decay(scanned=${decay.scanned}/decayed=${decay.decayed}/pruned=${decay.pruned})`,
    );
    return { recaps, questionsClosed, decay };
  }

  /** 注入遗忘衰减扫描（create-app-services 注册 MemoryForgettingController 时接线） */
  setDecayRunner(
    fn:
      | ((actorIds: string[]) => Promise<{ scanned: number; decayed: number; pruned: number }>)
      | null,
  ): void {
    this.decayRunner = fn;
  }

  private decayRunner:
    | ((actorIds: string[]) => Promise<{ scanned: number; decayed: number; pruned: number }>)
    | null = null;

  /** 事实主库（懒初始化；可用 USER_FACT_STORE_DIR 覆盖存储目录，测试注入用） */
  getFactStore(): UserFactStore {
    if (!this.factStore) {
      const dir = process.env.USER_FACT_STORE_DIR?.trim();
      this.factStore = dir ? new UserFactStore(dir) : new UserFactStore();
    }
    return this.factStore;
  }

  /**
   * 计划到期扫描（独立入口，2026-10-19 P0 修复）。
   *
   * 之前挂在 extractFactsFromJournals 的 actor 循环里，被该方法开头两道早退
   * （!journal / !llm）挡住——没有 LLM 配置的环境计划**永远不会 lapsed**，
   * 防线形同虚设。本方法无任何早退：所有登记 actor 无条件扫一遍。
   *
   * 调用时机：夜间任务 + 服务启动补扫（进程白天重启也不漏一天）。
   * @returns 本轮降级为 lapsed 的计划条数
   */
  async runPlanSweepForAllActors(now: Date = new Date()): Promise<number> {
    let total = 0;
    try {
      const structured = await this.getStructuredFactStore();
      if (!structured) return 0;
      for (const actorId of this.getAllActorIds()) {
        try {
          total += structured.sweepUpcomingPlans(actorId, now);
        } catch (err) {
          console.warn(`[NightlyMemory] 计划到期扫描失败（跳过该 actor） ${actorId}:`, err);
        }
      }
    } catch (err) {
      console.warn("[NightlyMemory] 计划到期扫描整体失败（忽略）:", err);
    }
    return total;
  }

  /**
   * 结构化事实库（计划到期扫描用）。动态导入避免 nightly ⇄ agentic-memory 的
   * 静态循环；未装配时返回 null（夜间任务照常跑，不做计划扫描）。
   */
  private async getStructuredFactStore(): Promise<
    { sweepUpcomingPlans: (actorId: string, at: Date | string) => number } | null
  > {
    try {
      const { getMemoryComponents } = await import("../agentic-memory/index.js");
      return getMemoryComponents().factStore ?? null;
    } catch {
      return null;
    }
  }

  setFactStore(store: UserFactStore): void {
    this.factStore = store;
  }

  /**
   * 注入画像批抽取口（T2，2026-10-22 三层写入调度）。缺省用
   * profile-write-scheduler 的默认实现（UserProfileAggregator 唯一写入路径）。
   * 测试注入 fake 以断言 WAL 候选消费与 checkpoint 语义。
   */
  setProfileConsolidator(
    fn: ((actorId: string) => Promise<ProfileConsolidationStats>) | null,
  ): void {
    this.profileConsolidator = fn;
  }

  private profileConsolidator:
    | ((actorId: string) => Promise<ProfileConsolidationStats>)
    | null = null;

  /**
   * 画像批抽取（每 actor 每晚最多 1 次 LLM）：读 turn-wal 自 checkpoint 以来的
   * 轮次（候选优先，预算内非候选补位）→ 批量 extractUnified → 确定性落位 →
   * 推进 checkpoint。仅 batch 调度模式生效；自 checkpoint 起没有新轮次才零成本跳过。
   */
  private async consolidateUserProfiles(actorIds?: string[]): Promise<void> {
    if (!isProfileWriteBatchMode()) return;
    const consolidate = this.profileConsolidator ?? getDefaultProfileConsolidator();
    for (const actorId of actorIds ?? this.getAllActorIds()) {
      try {
        const s = await consolidate(actorId);
        if (s.processed > 0 || s.topUpProcessed > 0) {
          console.log(
            `[NightlyMemory] 画像批抽取: actor=${actorId} 候选=${s.candidates} 处理=${s.processed} ` +
              `补位=${s.topUpProcessed} ops=${s.opsCount} 旁路产物=${s.sideChannels} ` +
              `applied=${s.applied} checkpoint=${s.checkpointAdvanced ? "已推进" : "未推进"}` +
              (s.extractionFailed ? "（抽取失败，下晚重试）" : ""),
          );
        }
      } catch (err) {
        console.error(`[NightlyMemory] 画像批抽取失败（跳过该 actor） ${actorId}:`, err);
      }
    }
  }

  /**
   * 夜间事实提炼（巩固管线 episodic → semantic）：
   * 在 journal 固化前，把当日（含跨天补跑）对话日志一次性喂给 LLM，
   * 抽取"值得跨会话记住"的稳定偏好/事实/承诺，写入结构化记忆槽位
   * （AgentMemorySyncService.appendMemorySummaryLine 会按 subject/slot
   * 自动做 latest-wins 归并，旧值被新值替换而不是无限累积）。
   *
   * 设计要点：
   * - 单 actor 单次 LLM 批处理调用（替代逐条实时写入决策，便宜且质量更高）；
   * - 只处理有未固化 journal 行的 actor（buildNightlyTranscript 返回 null 直接跳过）；
   * - LLM 不可用 / 提炼失败 → 静默跳过该 actor，不影响后续固化与 dreaming；
   * - 行文本按 kind 加类型前缀，命中槽位分类正则后自动归入对应槽位。
   *
   * @returns 每个 actor 实际落库的事实条数（日志用）
   */
  private async extractFactsFromJournals(actorIds?: string[]): Promise<Map<string, number>> {
    const appliedCounts = new Map<string, number>();
    const journal = getDailyJournalService();
    if (!journal || !this.memorySync) return appliedCounts;
    const llm = resolvePrimaryLlmClientConfig();

    const metrics: NonNullable<NightlySleepAgentReport["extraction"]> = {
      llmCalls: 0,
      factsApplied: 0,
      conflictsResolved: 0,
      rejectedOps: 0,
      duplicates: 0,
      themes: 0,
    };
    this.lastExtractionMetrics = metrics;

    const targets = actorIds ?? this.getAllActorIds();
    for (const actorId of targets) {
      try {
        const built = await this.buildNightlyTranscript(journal, actorId);
        if (!built) continue;

        let facts: Array<{ kind: "preference" | "fact" | "commitment"; text: string }> = [];
        if (llm) {
          // M2：夜间唯一一次结构化 LLM 调用（facts + conflicts + themes 合并输出，
          // 每条带 evidence 行号；非法/无证据 op 丢弃）。
          const ops = await this.extractNightlyOps(llm, built.transcript);
          metrics.llmCalls += 1;
          metrics.rejectedOps += ops.rejected;
          metrics.themes += ops.themes;
          metrics.conflictsResolved += ops.conflicts.length;
          facts = [
            ...ops.facts,
            ...ops.conflicts.map((c) => ({ kind: c.kind, text: c.text })),
          ];
        }

        // M1-④：无 LLM / LLM 未产出时，用 journal 的 fact/prefer/commit 标签行
        // 确定性落库——不引入额外模型调用，保证夜间仍有事实增量。
        if (facts.length === 0) {
          const derived = deriveDeterministicFacts(built.transcript);
          metrics.duplicates += derived.duplicates;
          facts = derived.facts;
        }
        if (facts.length === 0) continue;

        // M4 去重：批内重复不再重复落库。
        const seen = new Set<string>();
        const unique: typeof facts = [];
        for (const fact of facts) {
          const key = `${fact.kind}|${normalizeFactText(fact.text)}`;
          if (seen.has(key)) {
            metrics.duplicates += 1;
            continue;
          }
          seen.add(key);
          unique.push(fact);
        }
        if (unique.length === 0) continue;

        const { canonical, kvWritten } = await this.applyNightlyFacts(
          actorId,
          unique,
          built.observedOn,
        );
        appliedCounts.set(actorId, canonical + kvWritten);
        metrics.factsApplied += canonical + kvWritten;
      } catch (err) {
        console.error(`[NightlyMemory] fact extraction failed for ${actorId}:`, err);
      }
    }
    return appliedCounts;
  }

  /** 事实落库：偏好/事实 → 事实主库，承诺/待办 → KV 槽位，最后同步派生视图。 */
  private async applyNightlyFacts(
    actorId: string,
    facts: Array<{ kind: "preference" | "fact" | "commitment"; text: string }>,
    observedOn?: string,
  ): Promise<{ canonical: number; kvWritten: number }> {
    let canonical = 0;
    let kvWritten = 0;
    for (const fact of facts) {
      const text = fact.text.trim().slice(0, 200);
      if (!text) continue;
      if (fact.kind === "preference" || fact.kind === "fact") {
        // 稳定偏好/事实 → 事实主库（subject 归一 + provenance，冲突即替换）。
        // observedOn 是习惯画像多日门槛的证据依据（2026-11-07）：单日观察的
        // 习惯断言入库但不进派生槽位，直到累计 ≥2 个不同观察日。
        await this.getFactStore().upsertFact(actorId, {
          kind: fact.kind,
          value: text,
          source: "nightly-extract",
          confidence: 0.7,
          observedOn,
        });
        canonical += 1;
      } else {
        // 承诺/待办（时效性内容）→ KV 槽位快速路径
        this.memorySync!.appendMemorySummaryLine(actorId, `承诺：${text}`, "consolidate");
        kvWritten += 1;
      }
    }
    // 派生视图同步：事实主库 → KV 结构化槽位（事实为主、槽位为视图，
    // 与事实冲突的旧行被替换，当天 per-turn 捕获的未提升行保留）
    if (canonical > 0) {
      const sync = await this.getFactStore().syncDerivedSlots(actorId, this.memorySync!);
      // 单一权威源（2026-10-09）：派生同步可能把行式事实写回 KV，随后清掉其中的
      // 档案字段副本（称呼/职业/居住地…）——这些字段的权威块由 prompt 单独注入，
      // KV 再留一份只会双写漂移。
      const strippedCopies = await this.stripProfileFieldCopiesFromKv(actorId);
      console.log(
        `[NightlyMemory] 事实提炼: actor=${actorId} 主库 ${canonical} 条` +
          `（偏好 ${sync.preferences} / 事实 ${sync.facts}），承诺 ${kvWritten} 条走 KV，` +
          `槽位保留近期行 ${sync.keptRecent}` +
          (strippedCopies > 0 ? `，清档案字段副本 ${strippedCopies} 行` : ""),
      );
    } else if (kvWritten > 0) {
      console.log(`[NightlyMemory] 事实提炼: actor=${actorId} 承诺 ${kvWritten} 条走 KV 槽位`);
    }
    return { canonical, kvWritten };
  }

  /**
   * 派生视图强制重同步（确定性，零 LLM）：把事实主库（含习惯门槛/保鲜规则）
   * 重新归并进所有 actor 的 KV 槽位，并清除被压制习惯的旧残行。
   * forceRunNightTasks 每次收尾调用——即使提取被跳过，槽位也与主库一致。
   */
  private async resyncDerivedSlotsForAllActors(): Promise<
    Record<string, { facts: number; preferences: number; keptRecent: number }>
  > {
    const out: Record<string, { facts: number; preferences: number; keptRecent: number }> = {};
    if (!this.memorySync) return out;
    for (const actorId of this.getAllActorIds()) {
      try {
        out[actorId] = await this.getFactStore().syncDerivedSlots(actorId, this.memorySync);
      } catch (err) {
        console.error(`[NightlyMemory] slot resync failed for ${actorId}:`, err);
      }
    }
    return out;
  }

  /**
   * 清理 KV 槽位里的档案字段副本（权威库已有该字段值时）。返回清掉的行数。
   * 与 profile-fact-authority 共用同一判定，保证与画像投影口径一致。
   */
  private async stripProfileFieldCopiesFromKv(actorId: string): Promise<number> {
    if (!this.memorySync) return 0;
    try {
      const { getMemoryComponents } = await import("../agentic-memory/index.js");
      const factStore = getMemoryComponents().factStore;
      if (!factStore) return 0;
      const facts = factStore.getActiveFacts(actorId);
      if (facts.length === 0) return 0;
      const { canonicalFieldMap, cleanProfileFieldCopiesFromSlot } = await import(
        "./user-personalization/profile-fact-authority.js"
      );
      const fields = new Set(canonicalFieldMap(facts).keys());
      if (fields.size === 0) return 0;
      const knownValues = new Map<string, readonly string[]>(
        [...fields].map((f) => [
          f,
          factStore.getAllValuesForField?.(actorId, f) ?? [],
        ]),
      );
      let removed = 0;
      for (const key of ["memory_facts", "memory_preferences"]) {
        const { entries } = this.memorySync.getSnapshot(actorId, [key]);
        const raw = typeof entries[key] === "string" ? (entries[key] as string) : "";
        if (!raw) continue;
        const r = cleanProfileFieldCopiesFromSlot(raw, fields, knownValues);
        if (r.changed) {
          this.memorySync.setEntry(actorId, key, r.value);
          removed += r.removed;
        }
      }
      return removed;
    } catch {
      return 0;
    }
  }

  /**
   * M2：单次结构化夜间 LLM 调用。
   *
   * 一次输出 facts + conflicts + themes，每条 op 必须带 evidence 行号
   * （对应下方带 #n 前缀的日志行）。证据缺失/越界/类型非法的 op 直接丢弃，
   * 避免模型凭空生成记忆。超长一天由 buildNightlyTranscript 的尾部截断做
   * 确定性压缩（最多 120 行 / 12k 字符），只有超长且仍有高信号时才允许补调一次。
   */
  private async extractNightlyOps(
    llm: { apiKey: string; baseURL?: string; model?: string },
    transcript: string,
  ):
    Promise<{
      facts: Array<{ kind: "preference" | "fact" | "commitment"; text: string }>;
      conflicts: Array<{ kind: "preference" | "fact"; text: string }>;
      themes: number;
      rejected: number;
    }> {
    const empty = { facts: [], conflicts: [], themes: 0, rejected: 0 };
    const openai = new OpenAI({ apiKey: llm.apiKey, baseURL: llm.baseURL, maxRetries: 1 });
    const model =
      process.env.AGENT_MEMORY_DECISION_MODEL?.trim() || llm.model || "gpt-4.1-mini";
    const lines = transcript.split("\n");
    const numbered = lines.map((line, i) => `#${i + 1} ${line}`).join("\n").slice(0, 12_000);
    const maxEvidenceId = lines.length;
    try {
      const durableSystem =
        "你是记忆巩固器。从对话日志中提取「值得跨会话长期记住」的用户信息，忽略闲聊、临时上下文和一次性任务细节。" +
        "每条日志行以 #n 标注行号。只输出 JSON：" +
        '{"facts":[{"kind":"preference|fact|commitment","text":"...","evidence":[n]}],' +
        '"conflicts":[{"kind":"preference|fact","text":"...","evidence":[n]}],' +
        "\"themes\":[{\"text\":\"...\",\"evidence\":[n]}]}，facts 最多 12 条。" +
        "evidence 必须是实际支撑该条目的日志行号；没有证据的条目一律不要输出。" +
        "规则：preference=稳定偏好/习惯（text 需含「喜欢/偏好/讨厌/习惯」等词）；" +
        "fact=稳定身份/背景事实（text 以「用户」开头或用无主语短语，如「用户住在兴义」「职业：后端开发」）；" +
        "commitment=需要后续跟进的承诺或待办（text 需含「我会/我将/计划/待办」等词）；" +
        "conflicts=与已知长期记忆矛盾的新陈述（取新值，系统按「显式纠正>新近>置信度>证据数」裁决）。" +
        "习惯纪律：单日/单次观察到的行为不得写成 preference 或带「习惯/总是/每天」字样的 fact；" +
        "设提醒/定闹钟≠事件已发生：「用户定了9点闹钟」不能推出「用户9点起床」，更不能推出作息习惯；" +
        "一次性事务（比价、下单、当次安排）不提取为 fact/preference。" +
        "text 用第三人称中文短句（以「用户」开头或无主语短语），禁止以「我/我的」开头。" +
        '没有可提取内容时返回 {"facts":[]}。';
      const response = await openai.chat.completions.create({
        model,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: durableSystem },
          { role: "user", content: numbered },
        ],
        ...bypassChatRequestExtras(),
      });
      auditChatCompletion({
        stage: "nightly_task",
        messages: [
          { role: "system", content: durableSystem },
          { role: "user", content: numbered },
        ],
        completion: response,
        model,
      });
      const content = response.choices[0]?.message?.content?.trim();
      if (!content) return empty;

      const parsed = JSON.parse(content) as {
        facts?: Array<{ kind?: string; text?: string; evidence?: unknown }>;
        conflicts?: Array<{ kind?: string; text?: string; evidence?: unknown }>;
        themes?: Array<{ text?: string; evidence?: unknown }>;
      };

      let rejected = 0;
      const validKind = (k: unknown, allowed: string[]): k is string =>
        typeof k === "string" && allowed.includes(k);
      const hasEvidence = (evidence: unknown): boolean =>
        Array.isArray(evidence) &&
        evidence.length > 0 &&
        evidence.every(
          (n) => typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= maxEvidenceId,
        );

      const facts: Array<{ kind: "preference" | "fact" | "commitment"; text: string }> = [];
      for (const f of parsed.facts ?? []) {
        if (
          f &&
          typeof f.text === "string" &&
          f.text.trim() &&
          validKind(f.kind, ["preference", "fact", "commitment"]) &&
          hasEvidence(f.evidence)
        ) {
          facts.push({ kind: f.kind as "preference" | "fact" | "commitment", text: f.text.trim() });
        } else {
          rejected += 1;
        }
      }

      const conflicts: Array<{ kind: "preference" | "fact"; text: string }> = [];
      for (const c of parsed.conflicts ?? []) {
        if (
          c &&
          typeof c.text === "string" &&
          c.text.trim() &&
          validKind(c.kind, ["preference", "fact"]) &&
          hasEvidence(c.evidence)
        ) {
          conflicts.push({ kind: c.kind as "preference" | "fact", text: c.text.trim() });
        } else {
          rejected += 1;
        }
      }

      let themes = 0;
      for (const t of parsed.themes ?? []) {
        if (t && typeof t.text === "string" && t.text.trim() && hasEvidence(t.evidence)) themes += 1;
        else rejected += 1;
      }

      return { facts: facts.slice(0, 12), conflicts, themes, rejected };
    } catch (err) {
      console.log(`[NightlyMemory] extractNightlyOps LLM 调用失败（降级为确定性兜底）: ${err}`);
      return empty;
    }
  }

  /**
   * 夜间记忆巩固（确定性，零 LLM）。
   *
   * 留存评分改由 memory-manager 的时间衰减/信号正则计算；画像是对话内
   * upsert 维护的，这里不再触发整文重写。因此即使遍历全部历史 actor，
   * 也只是本地计算，不再产生 LLM 调用。
   */
  private async runDreamPhase(actorIds?: string[]): Promise<{
    recaps: number;
    questionsClosed: number;
    decay: { scanned: number; decayed: number; pruned: number };
  }> {
    // ⑥ 巩固流水线：与 dreaming 同一入口、一次跑完（日结回顾 + 关闭悬空问句），
    // 之后才进入 cleanup → merge → reinforce → weaken 睡眠阶段。
    const pipeline = await this.runConsolidationPipeline(actorIds);

    const targets = (actorIds ?? this.getAllActorIds()).slice(
      0,
      this.config.consolidationBatchSize,
    );
    if (targets.length === 0) return pipeline;

    console.log(
      `[NightlyMemory] Sleep agent phase: cleanup -> merge -> reinforce -> weaken for ${targets.length} actors`,
    );

    // memory_summary 巩固已在 journal 固化前由 consolidateSummaries 完成；
    // 这里只跑长期记忆图的确定性睡眠阶段（cleanup/merge/promote/weaken）。
    const sleepReports = this.narrativeMemory
      ? await this.narrativeMemory.runSleepConsolidation(targets).catch((err) => {
          console.error("[NightlyMemory] Human-like sleep consolidation failed:", err);
          return null;
        })
      : null;
    const hasSleepReports = Array.isArray(sleepReports) && sleepReports.length > 0;
    if (hasSleepReports || this.lastJournalFixation) {
      await this.recordSleepAgentReport(targets, hasSleepReports ? sleepReports : [], this.lastJournalFixation);
    }
    return pipeline;
  }

  private async recordSleepAgentReport(
    actorIds: string[],
    reports: Array<{
      actorId: string;
      dailyCleanupCount: number;
      weeklyMergedCount: number;
      monthlyAbstractedCount: number;
      consistencyFlagCount: number;
      knowledgePromotedCount: number;
      compressionRate: number;
      estimatedRecallPrecision: number;
      plannedActions: number;
      executedActions: number;
      stageReports: Array<{ stage: string; changed: number; notes: string[] }>;
    }>,
    journalFixation: NightlySleepAgentReport["journalFixation"] | null = null,
  ): Promise<void> {
    const payload: NightlySleepAgentReport = {
      runAt: new Date().toISOString(),
      actorIds,
      ...(journalFixation ? { journalFixation } : {}),
      ...(this.lastExtractionMetrics ? { extraction: { ...this.lastExtractionMetrics } } : {}),
      reports,
    };
    this.latestReport = payload;
    this.recentReports.unshift(payload);
    this.recentReports = this.recentReports.slice(0, 30);

    try {
      await writeJsonAtomic(this.reportFilePath, this.recentReports);
    } catch (err) {
      console.error("[NightlyMemory] Failed to persist sleep agent report:", err);
    }
  }

  private async syncToLongTermStorage(actorIds?: string[]): Promise<void> {
    // 缺口 7 修复：真实落地长期存储同步
    // 原策略：只 getSnapshot 打日志，不写入任何长期后端
    // 新策略：把每个 actor 的 memory_summary 持久化到本地文件 data/long-term-memory/<actorId>.json
    //         作为长期归档（崩溃恢复 + 跨实例迁移的备份）
    if (!this.memorySync) return;

    try {
      console.log("[NightlyMemory] Syncing to long-term storage (local archive)");
      const targets = actorIds ?? this.getAllActorIds();
      const longTermDir = join(getDataDir(), "long-term-memory");
      try {
        mkdirSync(longTermDir, { recursive: true });
      } catch {
        // 目录已存在则忽略
      }

      let syncedCount = 0;
      for (const actorId of targets) {
        try {
          const { entries } = this.memorySync.getSnapshot(actorId, [
            "memory_summary",
            "memory_summary_forgotten",
          ]);
          const summary = typeof entries.memory_summary === "string" ? entries.memory_summary : "";
          const forgotten = typeof entries.memory_summary_forgotten === "string" ? entries.memory_summary_forgotten : "";
          if (!summary && !forgotten) continue;

          const archive = {
            actorId,
            syncedAt: new Date().toISOString(),
            memorySummary: summary,
            memorySummaryForgotten: forgotten,
          };
          const filePath = join(longTermDir, `${actorId}.json`);
          await writeJsonAtomic(filePath, archive);
          syncedCount++;
        } catch (err) {
          console.log(`[NightlyMemory] sync ${actorId} 失败: ${err}`);
        }
      }
      console.log(`[NightlyMemory] Long-term storage sync completed: ${syncedCount}/${targets.length} actors archived`);
    } catch (err) {
      console.error("[NightlyMemory] Long-term sync failed:", err);
    }
  }

  private async cleanupOldStorage(): Promise<void> {
    // 缺口 7 修复：清理过期的长期存储归档
    // 删除 30 天前的 long-term-memory 归档文件（保留近期备份）
    try {
      const longTermDir = join(getDataDir(), "long-term-memory");
      let files: string[] = [];
      try {
        files = readdirSync(longTermDir);
      } catch {
        return; // 目录不存在则跳过
      }
      const now = Date.now();
      const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 天
      let cleanedCount = 0;
      for (const file of files) {
        if (!file.endsWith(".json")) continue;
        const filePath = join(longTermDir, file);
        try {
          const stat = statSync(filePath);
          if (now - stat.mtimeMs > MAX_AGE_MS) {
            unlinkSync(filePath);
            cleanedCount++;
          }
        } catch {
          // 单文件清理失败不阻塞
        }
      }
      if (cleanedCount > 0) {
        console.log(`[NightlyMemory] Cleanup: removed ${cleanedCount} expired long-term archive files`);
      }
    } catch (err) {
      console.log(`[NightlyMemory] cleanupOldStorage 失败: ${err}`);
    }
  }

  private checkMidnightRollover(): void {
    // per-actor 水位线按「当天 key」比较，跨天自然失配并重新触发；
    // 这里只裁掉长期不再活跃 actor 的旧记录，避免 Map 无限增长。
    const today = this.getTodayKey();
    for (const [actorId, day] of this.lastProcessedDayByActor) {
      if (day !== today) this.lastProcessedDayByActor.delete(actorId);
    }
  }

  private getAllActorIds(): string[] {
    const actorIds = new Set<string>();
    for (const actorId of this.memorySync?.listSessionIds?.() ?? []) {
      if (actorId && actorId !== "system") actorIds.add(actorId);
    }
    // journal 目录兜底：digest 依赖移除后，用当日/历史 journal 目录补充 actor 列表
    for (const actorId of getDailyJournalService()?.listActorIds?.() ?? []) {
      if (actorId) actorIds.add(actorId);
    }
    return [...actorIds];
  }

  private getTodayKey(): string {
    return this.formatDateKey(new Date());
  }

  private formatDateKey(date: Date): string {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  }

  async shutdown(): Promise<void> {
    this.stopScheduler();
    if (this.isNightMode) {
      console.log("[NightlyMemory] Shutdown in night mode, running final tasks...");
      await this.forceRunNightTasks();
    }
  }
}

let singleton: NightlyMemoryTaskService | null = null;

export function getNightlyMemoryTaskService(): NightlyMemoryTaskService | null {
  return singleton;
}

export function initNightlyMemoryTaskService(
  config?: Partial<NightModeConfig>,
): NightlyMemoryTaskService | null {
  const cfg = loadNightConfig();
  if (!cfg.enabled) {
    singleton = null;
    return null;
  }
  singleton = new NightlyMemoryTaskService(config);
  return singleton;
}
