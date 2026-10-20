import type { Memory } from "mem0ai/oss";
import OpenAI from "openai";
import { actorIdVariants } from "./actor-key.js";

import {
  getMemoryTTLDays,
  getMemoryTTLTemporaryDays,
  getMemoryArchiveRetentionDays,
  getLifecycleIntervalMin,
  getDedupSimilarityThreshold,
  getDedupMaxChecksPerCycle,
  getAgenticMemoryLlmModel,
  getMemoryLlmReviewBatchSize,
  getMemoryLlmReviewIntervalHours,
  isMemoryLlmReviewEnabled,
  isMemoryReinforcementEnabled,
  resolveOpenAiApiKey,
} from "./env.js";
import type { MemoryReinforcementStore } from "./memory-reinforcement.js";

interface Mem0MemoryItem {
  id: string;
  memory: string;
  metadata?: Record<string, unknown>;
  createdAt?: string;
  updatedAt?: string;
  score?: number;
}

interface Mem0GetAllResult {
  results: Mem0MemoryItem[];
}

interface Mem0SearchResult {
  results?: Array<{ id: string; score?: number; metadata?: Record<string, unknown> }>;
}

export type Mem0DeletedNotifier = (deletedIds: string[]) => void;

export type LifecycleCycleResult = {
  /** 本轮新归档数（两阶段第一阶段；等于 archived，保留字段名兼容旧调用方） */
  pruned: number;
  /** 本轮新归档数（可恢复，未物理删除） */
  archived: number;
  /** 本轮物理删除的到期归档数（两阶段第二阶段） */
  purged: number;
  /** 语义去重合并（物理删除）数 */
  merged: number;
  /** LLM 审查覆盖的条数（0=本轮未到审查窗口/未启用） */
  llmReviewed: number;
  /** getAll 扫描总条数（含已归档未物理删的） */
  scanned: number;
};

/** getAll 拉取上限；命中上限说明可能被截断（告警，下轮继续从新扫描） */
const GET_ALL_TOP_K = 10_000;

/** 缺失 importance 的旧数据按中性分处理（不加分不减分） */
const NEUTRAL_IMPORTANCE = 0.5;

/** lifecycle_kv 表的键名（去重游标 / LLM 审查时间戳，进程重启不再重置） */
const KV_DEDUP_CURSOR = "lifecycle.dedup_cursor_ms";
const KV_LLM_REVIEW_LAST = "lifecycle.llm_review_last_ms";

function importanceOf(item: Mem0MemoryItem): number {
  const raw = Number(item.metadata?.importance);
  if (Number.isFinite(raw)) return Math.max(0, Math.min(1, raw));
  // 旧数据无连续分：高信号按 0.85，其余中性
  return item.metadata?.highSignal === true ? 0.85 : NEUTRAL_IMPORTANCE;
}

function semanticClassOf(item: Mem0MemoryItem): string {
  const raw = item.metadata?.memorySemanticClass;
  return typeof raw === "string" ? raw : "";
}

function actorIdOf(item: Mem0MemoryItem): string {
  const a = item.metadata?.actorId;
  if (typeof a === "string" && a) return a;
  const u = item.metadata?.user_id;
  return typeof u === "string" ? u : "";
}

/**
 * 核心事实豁免 TTL（设计「核心事实 TTL=永久」）：
 * importance ≥ 0.8，或 stable_* 语义类（stable_preference/identity/constraint）。
 * 旧数据无语义类时由 highSignal→0.85 兜住。
 */
function isPermanentMemory(item: Mem0MemoryItem): boolean {
  return importanceOf(item) >= 0.8 || semanticClassOf(item).startsWith("stable_");
}

function effectiveTimestamp(item: Mem0MemoryItem): number {
  const created = parseTimestamp(item.createdAt);
  const updated = parseTimestamp(item.updatedAt);
  return Math.max(created, updated);
}

function parseTimestamp(ts: string | undefined): number {
  if (typeof ts === "string") {
    const parsed = Date.parse(ts);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

const LLM_REVIEW_SYSTEM_PROMPT = [
  "你是个人记忆库的审查员。给定同一用户的一组记忆条目，找出其中明确的：",
  "① 过时（信息已被更新取代，如旧地址、旧偏好）；② 矛盾（与其他条目冲突）；③ 冗余（与另一条几乎同义）。",
  "条目若带 currentProfile 字段，那是用户档案的**当前权威值**（来自结构化事实库）：",
  "与该值冲突的条目一律按「过时」判定，尤其是居住地/职业/称呼/公司这类会变的字段。",
  "只标记有把握的条目；拿不准一律保留（宁保留不误删）。",
  '只输出 JSON：{"forget":[{"n":序号,"reason":"一句话理由"}]}；未列出的条目视为保留。',
].join("\n");

export class AgenticMemoryLifecycleService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private deletedNotifier: Mem0DeletedNotifier | null = null;
  /**
   * 语义去重增量游标：只处理 updatedAt 晚于游标的记忆（新写入/被强化的），
   * 每轮至多 getDedupMaxChecksPerCycle() 次向量检索，存量首轮逐步消化。
   * 游标持久化在 lifecycle_kv（进程重启不再归零重扫）；无持久层时退回内存态。
   */
  private dedupCursorMs = 0;
  /** LLM 审查上次执行时间（持久化，按 interval 判定是否到窗） */
  private llmReviewLastAt = 0;
  private lastCycleAt = 0;
  private lastCycleResult: LifecycleCycleResult | null = null;

  constructor(
    private readonly memory: Memory,
    private readonly reinforcement: MemoryReinforcementStore | null = null,
  ) {
    if (reinforcement) {
      const cursor = Number.parseInt(reinforcement.kvGet(KV_DEDUP_CURSOR) ?? "", 10);
      if (Number.isFinite(cursor) && cursor > 0) this.dedupCursorMs = cursor;
      const lastReview = Number.parseInt(reinforcement.kvGet(KV_LLM_REVIEW_LAST) ?? "", 10);
      if (Number.isFinite(lastReview) && lastReview > 0) this.llmReviewLastAt = lastReview;
    }
  }

  /**
   * 注入删除通知（P0-3）：TTL 物理删/去重绕过 memory-bridge 直接删 Mem0 记录，
   * bootstrap 把通知接到 bridge.handleMem0Deleted 做 linkage 调和（摘除被删 id /
   * tombstone 摘空的链接），否则 bridge_links 里会积累永远扫不完的僵尸链接。
   * 归档不删向量记录，不触发通知；到期物理删时才走 deleteConfirmed。
   */
  setDeletedNotifier(notifier: Mem0DeletedNotifier | null): void {
    this.deletedNotifier = notifier;
  }

  /** 仅对「确认删除成功」的 id 发通知 + 回收强化侧表行（删除失败不通知，防 bridge 摘空）。 */
  private async deleteConfirmed(ids: string[]): Promise<string[]> {
    const deleted: string[] = [];
    for (const id of ids) {
      try {
        await this.memory.delete(id);
        deleted.push(id);
      } catch (err) {
        console.warn(
          `[memory-lifecycle] 删除失败（跳过通知，下轮重试）: ${id}`,
          err instanceof Error ? err.message : err,
        );
      }
    }
    if (deleted.length > 0) {
      this.notifyDeleted(deleted);
      this.reinforcement?.purgeIds(deleted);
    }
    return deleted;
  }

  /** 手动删除（记忆管理端点）：与 TTL 物理删除同一条级联（bridge 调和 + 强化侧表回收） */
  async deleteByIds(ids: string[]): Promise<string[]> {
    return this.deleteConfirmed(ids);
  }

  private notifyDeleted(ids: string[]): void {
    if (ids.length === 0) return;
    try {
      this.deletedNotifier?.(ids);
    } catch (err) {
      console.warn("[memory-lifecycle] deleted notifier 失败（忽略）:", err);
    }
  }

  start(): void {
    const ttlDays = getMemoryTTLDays();
    const intervalMin = getLifecycleIntervalMin();
    if (ttlDays <= 0 || intervalMin <= 0) return;

    const intervalMs = intervalMin * 60_000;
    this.timer = setInterval(() => {
      void this.runCycle().catch((err) =>
        console.warn("[memory-lifecycle] cycle error:", err instanceof Error ? err.message : err),
      );
    }, intervalMs);
    this.timer.unref();

    console.info(
      `[memory-lifecycle] started (TTL=${ttlDays}d/temp=${getMemoryTTLTemporaryDays()}d, ` +
        `archive=${getMemoryArchiveRetentionDays()}d, llm-review=${isMemoryLlmReviewEnabled() ? `${getMemoryLlmReviewIntervalHours()}h` : "off"}, ` +
        `interval=${intervalMin}min)`,
    );
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** 观测快照：供 /api/memory/lifecycle/stats 展示遗忘是否真的在发生。 */
  getStatsSnapshot(): {
    lastCycleAt: string | null;
    lastCycle: LifecycleCycleResult | null;
    dedupCursorMs: number;
    llmReviewLastAt: string | null;
    archivedRows: number | null;
  } {
    return {
      lastCycleAt: this.lastCycleAt ? new Date(this.lastCycleAt).toISOString() : null,
      lastCycle: this.lastCycleResult,
      dedupCursorMs: this.dedupCursorMs,
      llmReviewLastAt: this.llmReviewLastAt ? new Date(this.llmReviewLastAt).toISOString() : null,
      archivedRows: this.reinforcement ? this.reinforcement.archivedCount() : null,
    };
  }

  async runCycle(): Promise<LifecycleCycleResult> {
    const startedAt = Date.now();
    // 快照先取（TTL/去重/审查共用），但物理删发生在本轮内——被删 id 需从
    // live 集合排除，否则 pruneExpired 会对已消失的向量记录重建僵尸归档行。
    const allMemories = await this.fetchAll();

    // 两阶段第二步：归档到期的向量记录物理删除（deleteConfirmed 附带 bridge 调和）
    const purgedIds = await this.purgeExpiredArchives();
    const purgedSet = new Set(purgedIds);

    // 已归档（未物理删）的记忆从本轮 TTL/去重/审查中排除——它们的遗忘已生效
    const archivedSet =
      this.reinforcement && isMemoryReinforcementEnabled()
        ? this.reinforcement.getArchivedIds((allMemories ?? []).map((m) => m.id).filter(Boolean))
        : new Set<string>();
    const liveMemories =
      allMemories
        ?.filter((m) => !archivedSet.has(m.id) && !purgedSet.has(m.id)) ?? null;

    const ttlDays = getMemoryTTLDays();
    let archivedNow = 0;
    if (ttlDays > 0 && liveMemories) {
      archivedNow = await this.pruneExpired(liveMemories, ttlDays);
    }
    let merged = 0;
    if (liveMemories) {
      merged = await this.deduplicate(liveMemories);
    }
    const llmReviewed = await this.maybeLlmReview(liveMemories);

    if (this.reinforcement) {
      this.reinforcement.kvSet(KV_DEDUP_CURSOR, String(this.dedupCursorMs));
    }

    const result: LifecycleCycleResult = {
      pruned: archivedNow,
      archived: archivedNow,
      purged: purgedIds.length,
      merged,
      llmReviewed,
      scanned: allMemories?.length ?? 0,
    };
    this.lastCycleAt = startedAt;
    this.lastCycleResult = result;
    return result;
  }

  private async fetchAll(): Promise<Mem0MemoryItem[] | null> {
    // mem0ai v3 的 getAll 强制 filters.user_id（裸 topK 必抛，2026-10-04 前本轮
    // 周期审查整体静默失效），跨 actor 扫描改为按 reinforcement 登记的 actor
    // 逐形式扫。盲区=从未被召回/归档过的记忆（其 actor 无登记行，首次召回后入列）；
    // 去重/合并/归档本来就按 actor 分组，逐 actor 扫描语义不变。
    const actorCandidates = this.reinforcement
      ? [...new Set(this.reinforcement.listActorIds().flatMap((a) => actorIdVariants(a)))]
      : [];
    if (actorCandidates.length === 0) return null;
    try {
      const allMemories: Mem0MemoryItem[] = [];
      for (const variant of actorCandidates) {
        const allResult = (await this.memory.getAll({
          topK: GET_ALL_TOP_K,
          filters: { user_id: variant },
        })) as unknown as Mem0GetAllResult;
        allMemories.push(...(allResult.results ?? []));
      }
      if (allMemories.length >= GET_ALL_TOP_K) {
        console.warn(
          `[memory-lifecycle] getAll 命中 ${GET_ALL_TOP_K} 条上限，记忆库可能被截断扫描——` +
            "建议调大 AGENT_MEMORY_LIFECYCLE_TOP_K 或依赖写入时增量去重兜底",
        );
      }
      return allMemories;
    } catch (err) {
      console.warn(
        "[memory-lifecycle] getAll 失败（本轮跳过）:",
        err instanceof Error ? err.message : err,
      );
      return null;
    }
  }

  /**
   * TTL 过期处理（两阶段遗忘第一阶段 + 分类 TTL）：
   *   - 分类 TTL：temporary_context 走 7 天档（设计「临时信息 TTL=7 天」），
   *     其余走 base TTL（默认 90 天）；stable_* 与 importance ≥ 0.8 豁免（核心事实永久）；
   *   - 有效 TTL 按重要性缩放：ttl × (0.5 + importance)，低重要性加速淡出；
   *   - 召回强化：过期判据用 max(createdAt, updatedAt, last_access_at)，且有效期按
   *     access_count 延长 ×(1 + min(count,10)×0.1)（上限 ×2，常用则牢）；
   *   - 到期先归档（archived_at，召回侧过滤，可恢复），归档超过
   *     getMemoryArchiveRetentionDays() 天后才由 purgeExpiredArchives 物理删除。
   * 强化存储关闭时退回旧路径（直接物理删除）。
   */
  private async pruneExpired(allMemories: Mem0MemoryItem[], ttlDays: number): Promise<number> {
    const now = Date.now();
    const baseTtlMs = ttlDays * 86_400_000;
    const tempTtlMs = getMemoryTTLTemporaryDays() * 86_400_000;
    const reinforcementOn = isMemoryReinforcementEnabled() && this.reinforcement;

    const candidates = allMemories.filter((mem) => !isPermanentMemory(mem));
    if (candidates.length === 0) return 0;

    const stats = reinforcementOn
      ? this.reinforcement!.getStats(candidates.map((m) => m.id))
      : null;

    const expired: Mem0MemoryItem[] = [];
    for (const mem of candidates) {
      const importance = importanceOf(mem);
      const classTtlMs = semanticClassOf(mem) === "temporary_context" ? tempTtlMs : baseTtlMs;
      let effectiveTtlMs = classTtlMs * (0.5 + importance);
      let lastAlive = effectiveTimestamp(mem);
      const s = stats?.get(mem.id);
      if (s) {
        if (s.lastAccessAt > lastAlive) lastAlive = s.lastAccessAt;
        // 高频召回延长有效期：access_count=10+ 时上限 ×2
        effectiveTtlMs *= 1 + Math.min(s.accessCount, 10) * 0.1;
      }
      if (now - lastAlive > effectiveTtlMs) expired.push(mem);
    }
    if (expired.length === 0) return 0;

    if (!reinforcementOn) {
      const deleted = await this.deleteConfirmed(expired.map((m) => m.id));
      if (deleted.length > 0) {
        console.info(
          `[memory-lifecycle] pruned ${deleted.length}/${expired.length} expired memories ` +
            `(base TTL=${ttlDays}d, importance-scaled, hard-delete fallback)`,
        );
      }
      return deleted.length;
    }

    // 按 actor 分组归档：侧表行以 actor_id 归属，purgeActor 级联回收依赖它
    const byActor = new Map<string, string[]>();
    for (const mem of expired) {
      const actorId = actorIdOf(mem);
      const group = byActor.get(actorId);
      if (group) group.push(mem.id);
      else byActor.set(actorId, [mem.id]);
    }
    let archived = 0;
    for (const [actorId, ids] of byActor) {
      archived += this.reinforcement!.archiveIds(ids, actorId, now);
    }
    if (archived > 0) {
      console.info(
        `[memory-lifecycle] archived ${archived}/${expired.length} expired memories ` +
          `(regular=${ttlDays}d/temp=${getMemoryTTLTemporaryDays()}d, access-boosted, recoverable)`,
      );
    }
    return archived;
  }

  /** 两阶段遗忘第二步：归档超过保留期的记录从向量库物理删除（可配置 0=永久保留归档）。返回删除的 id。 */
  private async purgeExpiredArchives(): Promise<string[]> {
    if (!this.reinforcement || !isMemoryReinforcementEnabled()) return [];
    const retentionDays = getMemoryArchiveRetentionDays();
    if (retentionDays <= 0) return [];
    const ids = this.reinforcement.expiredArchived(retentionDays);
    if (ids.length === 0) return [];
    const deleted = await this.deleteConfirmed(ids);
    if (deleted.length > 0) {
      console.info(
        `[memory-lifecycle] purged ${deleted.length}/${ids.length} archived memories (archived >${retentionDays}d)`,
      );
    }
    return deleted;
  }

  /**
   * 读取候选条目所属 actor 的档案当前值（字段 → 值），供 LLM 审查判「过时」。
   * 动态导入避免 index ⇄ lifecycle 静态循环；任何失败返回空表（回退旧行为）。
   */
  private async loadCurrentProfileFacts(
    items: Mem0MemoryItem[],
  ): Promise<Map<string, Record<string, string>>> {
    const out = new Map<string, Record<string, string>>();
    try {
      const { getMemoryComponents } = await import("./index.js");
      const store = getMemoryComponents().factStore;
      if (!store) return out;
      for (const item of items) {
        const actorId = actorIdOf(item);
        if (!actorId || out.has(actorId)) continue;
        const facts = store.getActiveFacts(actorId) ?? [];
        const map: Record<string, string> = {};
        for (const f of facts) map[f.field] = f.value;
        out.set(actorId, map);
      }
    } catch {
      /* 记忆组件未装配 → 不注入档案，审查按纯文本判定 */
    }
    return out;
  }

  /**
   * Mem0 库 LLM 定期审查（设计「LLM 主动遗忘」）：规则 TTL/去重判不了的
   * 「过时/矛盾/冗余」（如同义改写之外的语义重复、已被新事实取代的旧值）
   * 由 LLM 抽批复审，命中者归档（不直接删）。审查窗口按
   * AGENT_MEMORY_LLM_REVIEW_INTERVAL_H（默认 24h）判定；无 LLM 渠道时静默跳过，
   * 下轮再试。
   */
  private async maybeLlmReview(liveMemories: Mem0MemoryItem[] | null): Promise<number> {
    if (!liveMemories || liveMemories.length === 0) return 0;
    if (!isMemoryLlmReviewEnabled() || !this.reinforcement || !isMemoryReinforcementEnabled()) {
      return 0;
    }
    const now = Date.now();
    if (now - this.llmReviewLastAt < getMemoryLlmReviewIntervalHours() * 3_600_000) return 0;

    // 惰性导入：本模块经 capability-modules/memory-governance 被工具环静态引用，
    // 静态引 resolve-provider 会构成 resolve-provider → providers → abstract-chat-provider
    // 的 module-init 循环（2026-09-25 冷启动崩溃）。
    const { resolvePrimaryLlmClientConfig, bypassChatRequestExtras } = await import(
      "../external-model/resolve-provider.js"
    );
    const llmConfig = resolvePrimaryLlmClientConfig();
    const apiKey = resolveOpenAiApiKey();
    if (!llmConfig || !apiKey) return 0;

    const batchSize = getMemoryLlmReviewBatchSize();
    const stats = this.reinforcement.getStats(liveMemories.map((m) => m.id));
    // 审查优先级：最久未访问优先——高频召回的记忆大概率仍有效，不值得花额度
    const candidates = liveMemories
      .filter((mem) => !isPermanentMemory(mem))
      .map((mem) => ({
        mem,
        lastAccess: stats.get(mem.id)?.lastAccessAt || effectiveTimestamp(mem),
      }))
      .sort((a, b) => a.lastAccess - b.lastAccess)
      .slice(0, batchSize)
      .map(({ mem }) => mem);
    if (candidates.length === 0) return 0;

    let forgetIdx: number[] = [];
    try {
      const openai = new OpenAI({ apiKey, baseURL: llmConfig.baseURL, maxRetries: 1 });
      // 权威档案注入（2026-10-19 时间锚定）：把结构化事实库的**当前值**交给审查员，
      // 「旧居住地/旧职业」这类过时条目才判得准——纯看条目文本时，一条 2023 年
      // 的"住在杭州"看不出已被"住在兴义"取代。读不到档案时静默回退旧行为。
      const profileByActor = await this.loadCurrentProfileFacts(candidates);
      const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
        { role: "system", content: LLM_REVIEW_SYSTEM_PROMPT },
        {
          role: "user",
          content: JSON.stringify({
            memories: candidates.map((mem, i) => {
              const profile = profileByActor.get(actorIdOf(mem));
              return {
                n: i,
                text: mem.memory.slice(0, 160),
                importance: importanceOf(mem),
                class: semanticClassOf(mem) || "unknown",
                ...(profile && Object.keys(profile).length > 0 ? { currentProfile: profile } : {}),
              };
            }),
          }),
        },
      ];
      const auditInputChars = JSON.stringify(messages).length;
      const response = await openai.chat.completions.create({
        model: getAgenticMemoryLlmModel(),
        temperature: 0,
        response_format: { type: "json_object" },
        messages,
        ...bypassChatRequestExtras(),
      });
      const content = response.choices[0]?.message?.content?.trim();
      if (!content) return 0;
      const { recordLlmUsageByChars } = await import("../services/llm-token-audit.js");
      recordLlmUsageByChars({
        stage: "memory_llm_review",
        inputChars: auditInputChars,
        outputChars: content.length,
        model: getAgenticMemoryLlmModel(),
        actorId: candidates[0] ? actorIdOf(candidates[0]) : undefined,
      });
      const parsed = JSON.parse(content) as { forget?: Array<{ n?: unknown; reason?: unknown }> };
      if (Array.isArray(parsed.forget)) {
        const valid = parsed.forget
          .filter(
            (item) =>
              item &&
              typeof item.n === "number" &&
              Number.isInteger(item.n) &&
              item.n >= 0 &&
              item.n < candidates.length,
          )
          .map((item) => item.n as number);
        forgetIdx = [...new Set(valid)].slice(0, batchSize);
      }
    } catch (err) {
      console.warn(
        "[memory-lifecycle] LLM 审查失败（下轮重试）:",
        err instanceof Error ? err.message : err,
      );
      return 0;
    }

    if (forgetIdx.length === 0) {
      this.llmReviewLastAt = Date.now();
      this.reinforcement.kvSet(KV_LLM_REVIEW_LAST, String(this.llmReviewLastAt));
      return 0;
    }

    // 按 actor 分组归档（LLM 判弃走归档通道，可恢复，不直接物理删）
    const byActor = new Map<string, string[]>();
    for (const idx of forgetIdx) {
      const mem = candidates[idx]!;
      const actorId = actorIdOf(mem);
      const group = byActor.get(actorId);
      if (group) group.push(mem.id);
      else byActor.set(actorId, [mem.id]);
    }
    let archived = 0;
    for (const [actorId, ids] of byActor) {
      archived += this.reinforcement.archiveIds(ids, actorId);
    }
    this.llmReviewLastAt = Date.now();
    this.reinforcement.kvSet(KV_LLM_REVIEW_LAST, String(this.llmReviewLastAt));
    console.info(
      `[memory-lifecycle] llm-review: reviewed ${candidates.length}, archived ${archived} ` +
        `(outdated/contradictory/redundant, recoverable)`,
    );
    return candidates.length;
  }

  /**
   * 语义去重（embedding 向量近邻版，替代原单字+bigram Jaccard）：
   * 文本 Jaccard 对同义改写不敏感（改两个字就绕过 0.92 阈值），且 O(n²) 全表
   * 两两比对；Mem0 search 走向量库，同义重复（"喜欢喝咖啡"/"爱喝咖啡"）能正确
   * 判重。增量扫描：只处理游标之后的新记忆，每轮限次，防 embedding API 风暴。
   *
   * 保留策略：importance 高者胜；平手保新（与 supersession 语义一致）。
   * 按 actor 分组检索（search 带 user_id 过滤），天然杜绝跨用户互删；
   * 缺失 actorId 的旧数据跳过去重（宁保留不误删）。
   */
  private async deduplicate(allMemories: Mem0MemoryItem[]): Promise<number> {
    const threshold = getDedupSimilarityThreshold();
    if (threshold <= 0) return 0;

    const cycleStart = Date.now();
    const byActor = new Map<string, Mem0MemoryItem[]>();
    for (const mem of allMemories) {
      const actorId = actorIdOf(mem);
      if (!actorId) continue;
      const group = byActor.get(actorId);
      if (group) group.push(mem);
      else byActor.set(actorId, [mem]);
    }

    // 收集游标之后的待检项，按时间升序（先消化最旧的存量），全局限次
    const pending: Array<{ actorId: string; mem: Mem0MemoryItem; ts: number }> = [];
    for (const [actorId, group] of byActor) {
      for (const mem of group) {
        const ts = effectiveTimestamp(mem);
        if (ts > this.dedupCursorMs) pending.push({ actorId, mem, ts });
      }
    }
    pending.sort((a, b) => a.ts - b.ts);

    const maxChecks = getDedupMaxChecksPerCycle();
    const batch = pending.slice(0, maxChecks);

    let removed = 0;
    let processedThrough = this.dedupCursorMs;
    for (const { actorId, mem, ts } of batch) {
      processedThrough = Math.max(processedThrough, ts);
      removed += await this.dedupeOneMemory(actorId, mem, threshold);
    }

    // 游标推进到本轮最后处理的条目时间；未消化的（限次截断/失败）下轮继续。
    // 本轮完整跑完（batch 未触顶）时推进到 cycleStart，避免旧数据被反复重扫。
    this.dedupCursorMs = batch.length < maxChecks ? cycleStart : processedThrough;

    if (removed > 0) {
      console.info(`[memory-lifecycle] merged ${removed} duplicate memories (semantic)`);
    }
    return removed;
  }

  private async dedupeOneMemory(
    actorId: string,
    mem: Mem0MemoryItem,
    threshold: number,
  ): Promise<number> {
    let result: Mem0SearchResult;
    try {
      result = (await this.memory.search(mem.memory, {
        filters: { user_id: actorId },
        topK: 6,
      })) as unknown as Mem0SearchResult;
    } catch (err) {
      console.warn(
        "[memory-lifecycle] 去重检索失败（该条下轮重试）:",
        err instanceof Error ? err.message : err,
      );
      return 0;
    }

    const selfImportance = importanceOf(mem);
    const selfTs = effectiveTimestamp(mem);
    const toDelete: string[] = [];

    for (const hit of result.results ?? []) {
      if (!hit.id || hit.id === mem.id) continue;
      const sim = hit.score ?? 0;
      if (sim < threshold) continue;
      const hitImportance = Number.isFinite(Number(hit.metadata?.importance))
        ? Math.max(0, Math.min(1, Number(hit.metadata?.importance)))
        : hit.metadata?.highSignal === true
          ? 0.85
          : NEUTRAL_IMPORTANCE;
      const hitTs = Math.max(
        parseTimestamp(hit.metadata?.createdAt as string | undefined),
        parseTimestamp(hit.metadata?.updatedAt as string | undefined),
      );
      // 对方无时间戳无法比新旧：跳过该命中（宁保留不误删，原逻辑会误删对方）
      if (!hitTs) continue;

      // 保留规则：importance 高者胜；平手保新。mem 是待检方——
      // 若对方更该保留，删 mem 并终止（mem 已消失，无需再比其余命中）；
      // 若 mem 更该保留，删对方。
      const memWins =
        selfImportance > hitImportance ||
        (selfImportance === hitImportance && selfTs >= hitTs);
      if (memWins) {
        toDelete.push(hit.id);
      } else {
        toDelete.length = 0; // 不再删别人，只删自己
        toDelete.push(mem.id);
        break;
      }
    }

    if (toDelete.length === 0) return 0;
    const deleted = await this.deleteConfirmed(toDelete);
    return deleted.length;
  }
}
