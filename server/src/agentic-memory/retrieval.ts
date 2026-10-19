import type { Memory } from "mem0ai/oss";

import {
  getAgenticMemoryTopK,
  getAgenticMemorySearchTopK,
  getHighSignalBoost,
  getMemoryImportanceBoost,
  getTimeDecayHalfLifeHours,
  isMemoryReinforcementEnabled,
} from "./env.js";
import { getMemoryReinforcementStore } from "./memory-reinforcement.js";
import { dedupeMemoryLines, semanticFingerprint } from "../services/memory-record-utils.js";
import {
  extractTemporalIntent,
  temporalIntentFactorForItem,
} from "../agent/memory-temporal-intent.js";
import {
  getRerankMode,
  recordRerankDecision,
  rerankCandidates,
  shouldRerankAdaptive,
  type RerankDeps,
} from "./rerank-cross-encoder.js";

interface Mem0SearchItem {
  id: string;
  memory: string;
  score?: number;
  metadata?: Record<string, unknown>;
  createdAt?: string;
  updatedAt?: string;
}

interface Mem0SearchResult {
  results: Mem0SearchItem[];
}

interface ScoredItem {
  item: Mem0SearchItem;
  rawScore: number;
  ageHours: number;
  highSignal: boolean;
}

/**
 * 结构化召回候选：直接携带时间戳与元数据，供 MemoryCortex/MemoryArbitrator
 * 做单层（按 domain τ 的）时间衰减与统一重排。
 * 此前 agentic 通道走「格式化文本 → 正则解析」往返，时间戳粒度退化到
 * 刚刚/小时/天，且在检索层多扣一次全局半衰期（与仲裁器的 domain 衰减重复）。
 */
export interface AgenticMemoryCandidate {
  content: string;
  score: number;
  highSignal: boolean;
  /** 记忆原始创建时间（ISO），缺失时缺省 */
  timestamp?: string;
  source?: string;
  context?: string;
}

function contextMatches(
  rawContext: unknown,
  want: "main" | "notes" | "any",
): boolean {
  if (want === "any") return true;
  // 旧数据 / 无 context 字段视为 "main"
  if (rawContext === undefined || rawContext === null) return want === "main";
  return rawContext === want;
}

function ageHoursOf(item: Mem0SearchItem, now: number): number {
  const ts = item.createdAt ?? item.updatedAt;
  if (typeof ts !== "string") return 0;
  const parsed = Date.parse(ts);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, (now - parsed) / 3_600_000);
}

function freshnessLabel(ageHours: number): string {
  return ageHours < 1
    ? "刚刚"
    : ageHours < 24
      ? `${Math.round(ageHours)}h前`
      : `${Math.round(ageHours / 24)}d前`;
}

/**
 * 召回时效因子（2026-10-19 时间认知补齐）：
 * 文本注入路径（buildRecallWithContext）此前只把「多久以前」写进标签给人看，
 * 排序完全不吃时间——同一主题的新旧两条等分时，旧的那条可能先注入，模型
 * 就拿旧值作答。这里给一个与仲裁器同口径的**软**调制（下限 0.75），
 * 半衰期内几乎不扣分、久远的缓慢下沉，不伤重要旧事实的召回。
 *
 * 半衰期取 AGENT_MEMORY_TIME_DECAY_HALF_LIFE_H（默认 72h）；≤0 视为关闭。
 * 注意：searchStructured 路径**不**在此加衰减——那条路交给 MemoryArbitrator
 * 的 recencyFactor 单层处理，避免重复压制（见 AgenticMemoryCandidate 注释）。
 */
const RECENCY_FLOOR = 0.75;

/** kill switch：AGENT_MEMORY_RECENCY_DECAY_ENABLED=0 时检索完全不看时间（旧行为） */
function isRecencyDecayEnabled(): boolean {
  const raw = process.env.AGENT_MEMORY_RECENCY_DECAY_ENABLED?.trim();
  if (raw === undefined || raw === "") return true;
  return raw !== "0" && raw.toLowerCase() !== "false";
}

export function recencyFactor(ageHours: number, halfLifeHours: number): number {
  if (!Number.isFinite(ageHours) || ageHours <= 0) return 1;
  if (!Number.isFinite(halfLifeHours) || halfLifeHours <= 0) return 1;
  const decay = Math.pow(0.5, ageHours / halfLifeHours);
  return RECENCY_FLOOR + (1 - RECENCY_FLOOR) * decay;
}

/**
 * 重要性连续分（0-1）的检索加权因子：1 + (importance - 0.5) × boost。
 * importance=0.5（含缺失/旧数据）不增不减；高分上浮、低分下压。boost=0 关闭。
 */
function importanceFactor(item: Mem0SearchItem, boost: number): number {
  if (boost <= 0) return 1;
  const raw = Number(item.metadata?.importance);
  const importance = Number.isFinite(raw) ? Math.max(0, Math.min(1, raw)) : 0.5;
  return 1 + (importance - 0.5) * boost;
}

/**
 * 档案实体信号 + 状态标签（2026-10-19 P1）。
 *
 * entity 信号：Mem0 OSS 检索本身没有实体通道，但结构化档案里就有最可靠的实体
 * （称呼/公司/居住地/技术栈的值）。query 命中某个档案实体、且记忆条目也含该
 * 实体时，给一个确定性加分——这正是"问人名/项目名召回不稳"的原因。
 *
 * 状态标签：条目带 factFields 标签且**不含当前值、只含历史值**时，它描述的是
 * 已失效的旧状态。A-TMA 的 "ghost memory" 结论是：存储里有状态，但答案仍可能
 * 用错，状态标签必须一路带进模型看到的证据包。所以这里直接标在行首。
 */
interface FactContext {
  /** 档案实体值（长度 ≥2，用于 entity 命中加分） */
  entityValues: string[];
  /** 单个条目的状态标签："" | "[当前]" | "[已失效]" */
  tagOf: (item: Mem0SearchItem) => string;
  /** 被软抑制的文案片段（命中则标「勿主动提」，不删条目） */
  mutedKeys: string[];
}

async function loadFactContext(actorId: string): Promise<FactContext> {
  let mutedKeys: string[] = [];
  try {
    const { peekMemorySuppressionStore } = await import("./memory-suppression.js");
    mutedKeys = peekMemorySuppressionStore()?.textKeys(actorId) ?? [];
  } catch {
    mutedKeys = [];
  }
  try {
    const { getMemoryComponents } = await import("./index.js");
    const comps = getMemoryComponents();
    const store = comps.factStore;
    if (!store) return { entityValues: [], tagOf: () => "", mutedKeys };
    const actives = store.getActiveFacts(actorId);
    // 实体池（P1-4 扩容）：档案字段值之外，把理解档案的 topic 也算实体——
    // 那是用户对话里的核心称谓/主题词（"老婆""K3 模型"），专名覆盖比档案广。
    let entityValues = [...new Set(actives.map((f) => f.value.trim()))].filter(
      (v) => v.length >= 2,
    );
    try {
      const topics = comps.understandingStore?.getActiveUnderstandings(actorId) ?? [];
      for (const note of topics) {
        const t = note.topic?.trim();
        if (t && t.length >= 2) entityValues.push(t);
      }
    } catch {
      /* 理解档案未装配 → 只用档案值 */
    }
    entityValues = [...new Set(entityValues)];
    const currentByField = new Map(actives.map((f) => [f.field, f.value]));
    const historyCache = new Map<string, readonly string[]>();

    return {
      entityValues,
      mutedKeys,
      tagOf: (item) => {
        const raw = item.metadata?.factFields;
        if (typeof raw !== "string" || !raw.trim()) return "";
        const fields = raw
          .split(/[,，]/)
          .map((s) => s.trim())
          .filter(Boolean);
        if (fields.length === 0) return "";
        const text = item.memory ?? "";
        for (const field of fields) {
          const current = currentByField.get(field);
          if (current && text.includes(current)) return "[当前]";
        }
        for (const field of fields) {
          let known = historyCache.get(field);
          if (!known) {
            known = store.getAllValuesForField(actorId, field);
            historyCache.set(field, known);
          }
          if (known.some((v) => v.length >= 2 && text.includes(v))) return "[已失效]";
        }
        return "";
      },
    };
  } catch {
    return { entityValues: [], tagOf: () => "", mutedKeys };
  }
}

/** query 命中档案实体、条目也含该实体 → 确定性加分（最多 +2 个实体，+15%/个） */
function entityOverlapFactor(query: string, item: Mem0SearchItem, entities: string[]): number {
  if (entities.length === 0) return 1;
  const text = item.memory ?? "";
  let hit = 0;
  for (const e of entities) {
    if (hit >= 2) break;
    if (query.includes(e) && text.includes(e)) hit += 1;
  }
  return 1 + hit * 0.15;
}

/**
 * 精排依赖的懒加载（避免 retrieval ⇄ resolve-provider 的模块初始化循环）。
 * 无 key / 无配置 → null，调用方跳过精排。
 */
async function resolveRerankDeps(): Promise<RerankDeps | null> {
  try {
    const [{ default: OpenAI }, provider, env] = await Promise.all([
      import("openai"),
      import("../external-model/resolve-provider.js"),
      import("./env.js"),
    ]);
    const cfg = provider.resolvePrimaryLlmClientConfig();
    const apiKey = env.resolveOpenAiApiKey();
    if (!cfg || !apiKey) return null;
    const client = new OpenAI({ apiKey, baseURL: cfg.baseURL, maxRetries: 0 });
    return {
      client: client as unknown as RerankDeps["client"],
      model: env.getAgenticMemoryLlmModel(),
    };
  } catch {
    return null;
  }
}

function buildSearchFilters(  actorId: string,
  context: "main" | "notes" | "any",
): Record<string, unknown> {
  const filters: Record<string, unknown> = { user_id: actorId };
  // 仅 notes 做下推：Qdrant/本地 store 均支持任意 payload 字段过滤，notes 大时
  // 不再白占 topK。main 不下推——旧数据 payload 无 context 字段，需靠后置
  // contextMatches 的「缺省视为 main」兼容逻辑兜住，不能在向量层把旧记忆排除掉。
  if (context === "notes") filters.context = "notes";
  return filters;
}

export class AgenticMemoryRetrievalService {
  constructor(private readonly memory: Memory) {}

  /**
   * 召回命中强化（fire-and-forget 语义）：把最终注入上下文的记忆 id 写入
   * 侧表（access_count+1、last_access_at 刷新），供 lifecycle TTL 豁免使用。
   * 强化存储不可用/关闭时静默跳过。
   */
  private touchRecalled(actorId: string, items: Mem0SearchItem[]): void {
    if (!isMemoryReinforcementEnabled() || items.length === 0) return;
    const store = getMemoryReinforcementStore();
    if (!store) return;
    try {
      store.touch(items.map((item) => item.id).filter(Boolean), actorId);
    } catch (err) {
      console.warn("[agentic-memory] recall touch 失败（忽略）:", err);
    }
  }

  /**
   * 过滤已归档记忆（两阶段遗忘）：向量库记录尚存、侧表已标 archived_at 的
   * 不再召回。bridge 融合召回也经由本服务的 searchStructured，此处过滤即全覆盖。
   */
  private filterArchived(items: Mem0SearchItem[]): Mem0SearchItem[] {
    if (!isMemoryReinforcementEnabled() || items.length === 0) return items;
    const store = getMemoryReinforcementStore();
    if (!store) return items;
    try {
      const archived = store.getArchivedIds(items.map((item) => item.id).filter(Boolean));
      if (archived.size === 0) return items;
      return items.filter((item) => !archived.has(item.id));
    } catch {
      return items;
    }
  }

  /**
   * 主流程使用的召回。默认仅查询 context=main（不混入笔记上下文）。
   * 跨上下文查询走 {@link buildCrossContextRecall}。
   *
   * 注意：本方法只做「原始分 × 高信号加成」的粗排与去重，
   * 不再做时间衰减——时间衰减统一由 MemoryArbitrator 按 domain τ 施加，
   * 避免稳定事实被两层衰减重复压制。
   */
  async buildRecall(actorId: string, queryText: string): Promise<string> {
    return this.buildRecallWithContext(actorId, queryText, { context: "main" });
  }

  async buildRecallWithContext(
    actorId: string,
    queryText: string,
    opts: { context: "main" | "notes" | "any" },
  ): Promise<string> {
    const query = queryText.trim().replace(/\s+/g, " ");
    if (!query) return "";

    const searchTopK = getAgenticMemorySearchTopK();
    const result = (await this.memory.search(query, {
      filters: buildSearchFilters(actorId, opts.context),
      topK: searchTopK,
    })) as unknown as Mem0SearchResult;

    const items = this.filterArchived(result.results ?? []);
    if (!items.length) return "";

    const now = Date.now();
    const nowDate = new Date(now);
    const highSignalBoost = getHighSignalBoost();
    const importanceBoost = getMemoryImportanceBoost();
    const halfLifeHours = isRecencyDecayEnabled() ? getTimeDecayHalfLifeHours() : 0;
    // 时间意图 + 档案实体：都是确定性信号，解析不出来就不介入（factor=1）
    const intent = extractTemporalIntent(query, nowDate);
    const factCtx = await loadFactContext(actorId);

    const scored: ScoredItem[] = items
      .filter((item) => contextMatches(item.metadata?.context, opts.context))
      .map((item) => {
        const ageHours = ageHoursOf(item, now);
        return {
          item,
          rawScore:
            (item.score ?? 0) *
            (item.metadata?.highSignal === true ? highSignalBoost : 1) *
            importanceFactor(item, importanceBoost) *
            recencyFactor(ageHours, halfLifeHours) *
            temporalIntentFactorForItem(intent, item, nowDate) *
            entityOverlapFactor(query, item, factCtx.entityValues),
          ageHours,
          highSignal: item.metadata?.highSignal === true,
        };
      });

    if (!scored.length) return "";

    scored.sort((a, b) => b.rawScore - a.rawScore);

    const finalTopK = getAgenticMemoryTopK();
    const deduped = this.dedupeScoredItems(scored);
    let topItems = deduped.slice(0, finalTopK);

    // Cross-encoder 精排（2026-10-19）：快慢结合的关键是**门控**而不是全开全关。
    //   off      不动（零额外延迟）
    //   always   每轮都排
    //   adaptive 只在排序模糊/整体虚弱时才排（见 shouldRerankAdaptive）
    // 只调整顺序不丢弃；任何失败原样返回。
    const rerankMode = getRerankMode();
    const rerankPool = deduped.slice(0, finalTopK * 2);
    const needsRerank =
      rerankMode === "always" ||
      (rerankMode === "adaptive" && shouldRerankAdaptive(rerankPool.map((s) => s.rawScore)));
    if (rerankMode !== "off") {
      // 观测埋点（P0-3）：off 时不记——统计的是"开了之后值不值"
      recordRerankDecision({ triggered: false });
    }
    if (needsRerank && rerankPool.length > 1) {
      const rerankStart = Date.now();
      const beforeTop1 = rerankPool[0]?.item.memory;
      const deps = await resolveRerankDeps();
      if (deps) {
        const candidates = rerankPool.map((s, i) => ({ id: String(i), text: s.item.memory }));
        const reordered = await rerankCandidates(query, candidates, deps);
        const byId = new Map(rerankPool.map((s, i) => [String(i), s]));
        topItems = reordered
          .map((c) => byId.get(c.id))
          .filter((s): s is ScoredItem => Boolean(s))
          .slice(0, finalTopK);
        recordRerankDecision({
          triggered: true,
          beforeTop1,
          afterTop1: topItems[0]?.item.memory,
          latencyMs: Date.now() - rerankStart,
        });
      }
    }

    this.touchRecalled(
      actorId,
      topItems.map((s) => s.item),
    );

    const parts: string[] = [];
    for (let i = 0; i < topItems.length; i++) {
      const { item, rawScore, ageHours, highSignal } = topItems[i]!;
      const scorePercent = (rawScore * 100).toFixed(0);
      const src = typeof item.metadata?.source === "string" ? `[${item.metadata.source}]` : "";
      const ctxTag =
        opts.context === "any" && typeof item.metadata?.context === "string"
          ? ` [${item.metadata.context}]`
          : "";
      const signalTag = highSignal ? " ⭐高信号" : "";
      // 状态标签紧贴正文：证据包里必须能看出这条描述的是现状还是已失效的旧值
      const stateTag = factCtx.tagOf(item);
      // 软抑制命中：标「勿主动提」，条目照常给模型（用户问起时还要能答）
      const mutedTag = factCtx.mutedKeys.some((k) => item.memory?.includes(k)) ? "[勿主动提] " : "";
      parts.push(
        `${i + 1}. 相关度 ${scorePercent}% · ${freshnessLabel(ageHours)}${signalTag}${ctxTag}${src ? ` ${src}` : ""}` +
          `\n${mutedTag}${stateTag ? `${stateTag} ` : ""}${item.memory}`,
      );
    }

    return `以下为 Mem0 记忆图联想检索（实体链接 + 多信号融合，可跨主题串联前因后果）：\n${parts.join("\n\n")}`;
  }

  /** 跨上下文查询（主 + 笔记）。用于主 Agent 显式查看笔记记忆。 */
  async buildCrossContextRecall(actorId: string, queryText: string): Promise<string> {
    return this.buildRecallWithContext(actorId, queryText, { context: "any" });
  }

  /**
   * 结构化召回：返回带原始时间戳的候选列表（已去重），供仲裁器统一重排。
   * MemoryCortex 主召回路径使用本方法替代「文本 → 正则解析」往返。
   */
  async searchStructured(
    actorId: string,
    queryText: string,
    opts?: { context?: "main" | "notes" | "any" },
  ): Promise<AgenticMemoryCandidate[]> {
    const query = queryText.trim().replace(/\s+/g, " ");
    if (!query) return [];

    const context: "main" | "notes" | "any" = opts?.context ?? "main";
    const searchTopK = getAgenticMemorySearchTopK();
    const result = (await this.memory.search(query, {
      filters: buildSearchFilters(actorId, context),
      topK: searchTopK,
    })) as unknown as Mem0SearchResult;

    const items = this.filterArchived(result.results ?? []).filter((item) =>
      contextMatches(item.metadata?.context, context),
    );
    if (!items.length) return [];

    const now = Date.now();
    const nowDate = new Date(now);
    const highSignalBoost = getHighSignalBoost();
    const importanceBoost = getMemoryImportanceBoost();
    // 时间意图 + 档案实体同样作用于结构化召回通道（时间衰减不在此加，
    // 仍由 MemoryArbitrator 单层处理——这里只补"用户问哪个时间段/哪个实体"）
    const intent = extractTemporalIntent(query, nowDate);
    const factCtx = await loadFactContext(actorId);

    const scored: ScoredItem[] = items.map((item) => ({
      item,
      rawScore:
        (item.score ?? 0) *
        (item.metadata?.highSignal === true ? highSignalBoost : 1) *
        importanceFactor(item, importanceBoost) *
        temporalIntentFactorForItem(intent, item, nowDate) *
        entityOverlapFactor(query, item, factCtx.entityValues),
      ageHours: ageHoursOf(item, now),
      highSignal: item.metadata?.highSignal === true,
    }));
    scored.sort((a, b) => b.rawScore - a.rawScore);

    const deduped = this.dedupeScoredItems(scored);
    this.touchRecalled(
      actorId,
      deduped.map((s) => s.item),
    );
    return deduped.map(({ item, rawScore }) => ({
      content: item.memory,
      score: rawScore,
      highSignal: item.metadata?.highSignal === true,
      ...(item.createdAt ?? item.updatedAt
        ? { timestamp: (item.createdAt ?? item.updatedAt) as string }
        : {}),
      ...(typeof item.metadata?.source === "string" ? { source: item.metadata.source } : {}),
      ...(typeof item.metadata?.context === "string" ? { context: item.metadata.context } : {}),
    }));
  }

  private dedupeScoredItems(items: ScoredItem[]): ScoredItem[] {
    const keepTexts = dedupeMemoryLines(
      items.map((item) => item.item.memory),
      { preferLatest: false },
    );
    const keep = new Set(keepTexts.map((line) => semanticFingerprint(line) || line));
    return items.filter(
      (item) => keep.has(semanticFingerprint(item.item.memory) || item.item.memory),
    );
  }
}
