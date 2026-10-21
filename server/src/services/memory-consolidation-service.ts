/**
 * 统一记忆写入者（四路合一，2026-09）。
 *
 * 此前对话内容到持久记忆有四条并行写入链路（turn-lifecycle 高信号 fast-path、
 * turn_archive、低信号 Mem0 缓冲、KV fast-path 行），各自触发、各自裁决、各自
 * 落库——同一事实可能同时进 Mem0 / 海马体 / KV 三份副本，且高信号路径在
 * turn-lifecycle 与 agentic ingestHighSignal 各决策一次（双重 LLM 调用）。
 *
 * 收敛后（借鉴 OpenClaw 2.0 Grounded Dreaming 的单写入者结构）：
 *  - 所有对话衍生的写入（含 memory-cortex 低信号路径）只作为「候选」进入本队列；
 *  - 唯一的整合链路在本服务：回声过滤 → 裁决（每候选一次）→ 摘要（低信号合并）
 *    → supersession 退役 → 单一出口 writeDecided（海马体 + Mem0 + KV）；
 *  - 用户显式驱动的写入（memory-cortex.ingest 高信号、brain 工具）保持直写，
 *    不进队列——与 OpenClaw「直接请求立即写入」一致。
 *
 * 失败语义：按候选/桶粒度隔离重试（attempts 计数封顶 MAX_FLUSH_ATTEMPTS 次，
 * 防毒候选无限重跑重复烧 LLM token），不再整批回灌。
 */
import type { Memory } from "mem0ai/oss";
import OpenAI from "openai";

import type { NarrativeMemoryPort } from "./narrative-memory-port.js";
import type { AgentMemorySyncService } from "./agent-memory-sync-service.js";
import type { MemoryDecisionResult } from "./memory-decision-engine.js";
import { decideMemoryWrite } from "./memory-decision-engine.js";
import { isMemoryEcho } from "./memory-echo-guard.js";
import { semanticFingerprint } from "./memory-record-utils.js";
import { writeJsonAtomic } from "../storage/atomic-json.js";
import {
  extractUnified,
  isMemoryUnifiedExtractEnabled,
  isProfileExtractHint,
  type UnifiedExtraction,
  type UnifiedLlmClient,
} from "../agentic-memory/unified-extractor.js";
import {
  resolveOpenAiApiKey,
  getAgenticMemoryLlmModel,
  getLowSignalBufferMaxItems,
  getLowSignalBufferMaxChars,
} from "../agentic-memory/env.js";

export type MemoryCandidate = {
  actorId: string;
  text: string;
  /** 产生候选的链路：chat:turn_archive / chat:fast_path / cortex:low_signal ... */
  source: string;
  context: "main" | "notes";
  highSignal: boolean;
  createdAt: string;
  /** KV summary 行的话题提示（沿用 inferMemoryTopic 产物） */
  topicHint?: string;
  /** 整合失败回灌次数（封顶后丢弃，防毒候选无限重跑） */
  attempts?: number;
};

type DecidedCandidate = {
  candidate: MemoryCandidate;
  decision: MemoryDecisionResult;
  /** 低信号合并摘要后 text 已被替换 */
  text: string;
  /**
   * 统一抽取产物（decide 融合后回填）。存在时 egress 走 writeDecided(unified)
   * ——抽取产物直存（infer:false）且 facts/commitments/corrections 驱动
   * 事实注册表等下游，不再让 Mem0 二次 LLM 抽取。
   */
  unified?: UnifiedExtraction;
};

type PersistedQueue = { candidates: MemoryCandidate[] };

const MAX_CANDIDATE_TEXT_CHARS = 12_000;
const MAX_QUEUE_SIZE = 500;

function clampText(text: string): string {
  return text.length > MAX_CANDIDATE_TEXT_CHARS ? `${text.slice(0, MAX_CANDIDATE_TEXT_CHARS)}...` : text;
}

function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

function envNum(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

export type MemoryConsolidationDeps = {
  narrative: NarrativeMemoryPort | null;
  kvSync: AgentMemorySyncService | null;
  /** Mem0 实例，供 supersession 语义检索/退役；缺省跳过退役 */
  memory: Memory | null;
  filePath?: string;
};

export class MemoryConsolidationService {
  private queue: MemoryCandidate[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  readonly debounceMs: number;
  private readonly supersedeSimilarity: number;
  private readonly filePath: string;
  private loaded = false;
  /** 统一抽取 LLM 客户端（测试注入 fake；生产为 null 走内部 OpenAI 构造） */
  private unifiedClient: UnifiedLlmClient | null = null;
  /** 当前画像快照读取口（bootstrap 接线到 UserProfileAggregator） */
  private profileSnapshot: ((actorId: string) => Promise<string | null>) | null = null;

  constructor(private readonly deps: MemoryConsolidationDeps) {
    this.debounceMs = envNum("AGENT_MEMORY_CONSOLIDATION_DEBOUNCE_MS", 30_000);
    this.supersedeSimilarity = envNum("AGENT_MEMORY_SUPERSEDE_SIMILARITY", 0.8);
    this.filePath =
      deps.filePath ??
      (process.env.AGENT_MEMORY_CANDIDATES_FILE?.trim() ||
        `${process.cwd()}/data/memory-candidates.json`);
  }

  /** 注入统一抽取客户端（测试用；生产不调用） */
  setUnifiedClient(client: UnifiedLlmClient | null): void {
    this.unifiedClient = client;
  }

  /**
   * 注入当前画像快照读取口（bootstrap 接线到 UserProfileAggregator）。
   * 注入后，统一抽取这一次调用会捎带 profileOps（画像与记忆/承诺/事实同一次 LLM），
   * 画像因此不再单独发调用。未注入时行为与旧版一致（不请求画像操作）。
   */
  setProfileSnapshotProvider(fn: ((actorId: string) => Promise<string | null>) | null): void {
    this.profileSnapshot = fn;
  }

  /**
   * 判断本次抽取是否捎带画像：高信号轮或命中个人陈述预筛才带当前画像，
   * 普通闲聊不增加 prompt 体积。读画像失败按空画像处理，不阻断记忆主链路。
   */
  private async resolveProfileContext(
    actorId: string,
    text: string,
    highSignal: boolean,
  ): Promise<{ currentProfile: string } | undefined> {
    if (!this.profileSnapshot) return undefined;
    if (!highSignal && !isProfileExtractHint(text)) return undefined;
    const currentProfile = await this.profileSnapshot(actorId).catch(() => null);
    return { currentProfile: currentProfile ?? "" };
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const { readFile } = await import("node:fs/promises");
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as PersistedQueue;
      if (Array.isArray(parsed?.candidates)) {
        this.queue = parsed.candidates.filter(
          (c) => c && typeof c.actorId === "string" && typeof c.text === "string",
        );
      }
    } catch {
      // 首次运行/文件缺失：空队列启动
    }
  }

  /**
   * 提交一条写入候选。指纹去重（同 actor 同内容的重复候选只保留一份），
   * 并调度防抖整合。永不抛出——候选生产方（turn-lifecycle 等）不允许被写入链路阻塞。
   */
  submitCandidate(candidate: MemoryCandidate): void {
    const text = candidate.text?.trim();
    if (!text || text.length < 4) return;
    if (!candidate.actorId) return;

    if (this.queue.length >= MAX_QUEUE_SIZE) {
      this.queue.splice(0, this.queue.length - MAX_QUEUE_SIZE);
    }
    const fp = semanticFingerprint(text);
    const dup = this.queue.find(
      (c) => c.actorId === candidate.actorId && semanticFingerprint(c.text) === fp,
    );
    if (dup) return;

    this.queue.push({
      ...candidate,
      text: clampText(text),
      createdAt: candidate.createdAt || new Date().toISOString(),
    });
    void this.persistQueue();

    // 消息数阈值触发：队列攒够（条数/字符数达阈值，env 迁移自原 ingest 内置缓冲）
    // 立即整合，不等 30s 防抖——高频对话时降低记忆入库延迟。
    const totalChars = this.queue.reduce((sum, c) => sum + c.text.length, 0);
    if (this.queue.length >= getLowSignalBufferMaxItems() || totalChars >= getLowSignalBufferMaxChars()) {
      if (this.flushTimer) {
        clearTimeout(this.flushTimer);
        this.flushTimer = null;
      }
      void this.flushAll().catch(() => {});
      return;
    }

    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        void this.flushAll().catch(() => {});
      }, this.debounceMs);
      this.flushTimer.unref();
    }
  }

  /** 立即整合所有 actor 的待处理候选（防抖触发 / 关停 / 测试用）。 */
  async flushAll(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    const actorIds = [...new Set(this.queue.map((c) => c.actorId))];
    for (const actorId of actorIds) {
      await this.flushActor(actorId).catch((err) => {
        console.error("[memory-consolidation] flushActor failed:", err);
      });
    }
  }

  pendingCount(actorId?: string): number {
    return actorId ? this.queue.filter((c) => c.actorId === actorId).length : this.queue.length;
  }

  /** 立即整合单个 actor 的候选（会话结束/WS 断开触发，不等防抖）。 */
  async flushForActor(actorId: string): Promise<void> {
    if (this.pendingCount(actorId) === 0) return;
    await this.flushActor(actorId).catch((err) => {
      console.error("[memory-consolidation] flushForActor failed:", err);
    });
  }

  /** 单个候选/桶的最大整合尝试次数：超过后丢弃并告警（防毒候选每次 flush 重跑 LLM） */
  private static readonly MAX_FLUSH_ATTEMPTS = 3;

  /** 失败候选按次数回灌；达到上限的丢弃（保留时间序，排到队首优先重试）。 */
  private requeueFailed(candidates: MemoryCandidate[], reason: string): void {
    const requeued: MemoryCandidate[] = [];
    for (const c of candidates) {
      const attempts = (c.attempts ?? 0) + 1;
      if (attempts >= MemoryConsolidationService.MAX_FLUSH_ATTEMPTS) {
        console.error(
          `[memory-consolidation] 候选连续 ${attempts} 次整合失败，丢弃（source=${c.source}）: ${reason}`,
        );
        continue;
      }
      requeued.push({ ...c, attempts });
    }
    if (requeued.length > 0) {
      this.queue = [...requeued, ...this.queue];
      void this.persistQueue();
    }
  }

  private async flushActor(actorId: string): Promise<void> {
    const batch = this.queue.filter((c) => c.actorId === actorId);
    if (batch.length === 0) return;
    // 先出队再处理；失败按候选/桶粒度回灌（attempts 封顶），不再整批重跑已成功的 LLM 抽取
    this.queue = this.queue.filter((c) => c.actorId !== actorId);
    void this.persistQueue();

    const failed: MemoryCandidate[] = [];
    const decided: DecidedCandidate[] = [];

    // 回声过滤：注入过的记忆被模型复述的候选不入库
    const accepted = batch.filter((c) => !isMemoryEcho(actorId, c.text));

    // 统一抽取协议（高低信号同轨，消灭「低信号事实必须命中关键词才被
    // 结构化对待」的双轨根因）：高信号逐条抽取；低信号按 context 分桶
    // 合并后一次抽取（抽取产物 memories 即压缩后的独立陈述，不再单独摘要）。
    // 抽取不可用（无 key/LLM 失败）时回退旧路径：高信号 decideMemoryWrite、
    // 低信号 summarizeLowSignal + 启发式裁决。
    const high = accepted.filter((c) => c.highSignal);
    for (const candidate of high) {
      try {
        const profileContext = isMemoryUnifiedExtractEnabled()
          ? await this.resolveProfileContext(actorId, candidate.text, true)
          : undefined;
        const unified = isMemoryUnifiedExtractEnabled()
          ? await extractUnified(candidate.text, {
              client: this.unifiedClient ?? undefined,
              actorId,
              ...(profileContext ? { profileContext } : {}),
            })
          : null;
        if (unified) {
          decided.push({
            candidate,
            decision: unifiedDecisionResult(unified),
            text: candidate.text,
            unified,
          });
        } else {
          const decision = await decideMemoryWrite(candidate.text, {
            actorId,
            source: candidate.source,
            heuristicHint: "remember",
          });
          decided.push({ candidate, decision, text: candidate.text });
        }
      } catch (err) {
        failed.push(candidate);
        console.warn(
          "[memory-consolidation] 高信号候选整合失败（单独回灌）:",
          err instanceof Error ? err.message : err,
        );
      }
    }

    const low = accepted.filter((c) => !c.highSignal);
    const lowByContext = new Map<"main" | "notes", MemoryCandidate[]>();
    for (const candidate of low) {
      const arr = lowByContext.get(candidate.context) ?? [];
      arr.push(candidate);
      lowByContext.set(candidate.context, arr);
    }
    for (const [context, items] of lowByContext) {
      const sorted = [...items].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      const combined = sorted.map((e) => `[${e.source}] ${e.text}`).join("\n\n---\n\n");
      if (combined.length < 20) continue;

      try {
        const profileContext = isMemoryUnifiedExtractEnabled()
          ? await this.resolveProfileContext(actorId, combined, false)
          : undefined;
        const unified = isMemoryUnifiedExtractEnabled()
          ? await extractUnified(combined, {
              client: this.unifiedClient ?? undefined,
              actorId,
              ...(profileContext ? { profileContext } : {}),
            })
          : null;
        if (unified) {
          const persistedText =
            unified.memories.length > 0
              ? unified.memories.join("\n")
              : combined.slice(0, 2000);
          decided.push({
            candidate: { ...sorted[0]!, text: persistedText },
            decision: unifiedDecisionResult(unified),
            text: persistedText,
            unified,
          });
          continue;
        }

        const summarized = await this.summarizeLowSignal(actorId, combined);
        const decision = await decideMemoryWrite(
          summarized,
          { actorId, source: "chat:low_signal_summary", heuristicHint: "decay" },
          { allowLlm: false },
        );
        decided.push({
          candidate: { ...sorted[0]!, text: summarized },
          decision,
          text: summarized,
        });
      } catch (err) {
        failed.push(...items);
        console.warn(
          "[memory-consolidation] 低信号桶整合失败（桶内候选回灌）:",
          err instanceof Error ? err.message : err,
        );
      }
    }

    if (decided.length > 0) {
      try {
        const egressFailed = await this.egress(actorId, decided);
        failed.push(...egressFailed);
      } catch (err) {
        // egress 整体异常（不应发生：内部已逐候选隔离）：全部候选回灌
        failed.push(...decided.map((d) => d.candidate));
        console.error("[memory-consolidation] egress 异常（候选已回灌待重试）:", err);
      }
    }

    if (failed.length > 0) {
      this.requeueFailed(failed, "flush");
    }
  }

  /** 唯一落库出口：海马体 + Mem0（经 narrative port）+ KV summary 行。返回写失败需回灌的候选。 */
  private async egress(actorId: string, decided: DecidedCandidate[]): Promise<MemoryCandidate[]> {
    const egressFailed: MemoryCandidate[] = [];
    // Supersession：overwrite/mutable_fact 语义的候选先退役语义重合的旧记忆
    for (const d of decided) {
      if (d.decision.decision === "overwrite" || d.decision.semanticClass === "mutable_fact") {
        await this.retireSuperseded(actorId, d.text);
      }
    }

    // unified 候选逐条直存（understandings/commitments/corrections/facts 经钩子驱动下游）。
    // reject 且无旁路数据（承诺/纠正/理解/事实）的候选整体跳过；reject 但携带
    // 旁路数据的仍要走 writeDecided——persistUnifiedExtraction 的 reject 分支
    // 只触发钩子、不落记忆（P0-2 解耦语义：被拒存的闲聊里的承诺/理解照样要抓）。
    for (const d of decided) {
      if (!d.unified) continue;
      const hasSideData =
        d.unified.understandings.length > 0 ||
        d.unified.commitments.length > 0 ||
        d.unified.corrections.length > 0 ||
        d.unified.facts.length > 0 ||
        (d.unified.profileOps?.length ?? 0) > 0;
      if (d.decision.decision === "reject" && !hasSideData) continue;
      try {
        await this.deps.narrative!.writeDecided(
          actorId,
          d.text,
          d.candidate.source,
          { context: d.candidate.context, highSignal: d.candidate.highSignal },
          d.unified,
        );
      } catch (err) {
        egressFailed.push(d.candidate);
        console.warn(
          "[memory-consolidation] unified 候选落库失败（单独回灌）:",
          err instanceof Error ? err.message : err,
        );
      }
    }

    // 旧路径（unified 不可用回退）候选：非 reject 的整批一次 writeDecided
    const legacy = decided.filter((d) => !d.unified && d.decision.decision !== "reject");
    if (legacy.length > 0 && this.deps.narrative) {
      const body = legacy.map((d) => d.text).join("\n");
      const context = legacy[0]!.candidate.context;
      try {
        await this.deps.narrative.writeDecided(actorId, body, legacy[0]!.candidate.source, {
          context,
          highSignal: true,
        });
      } catch (err) {
        egressFailed.push(...legacy.map((d) => d.candidate));
        console.warn(
          "[memory-consolidation] legacy 批量落库失败（候选回灌）:",
          err instanceof Error ? err.message : err,
        );
      }
    }

    // KV summary 行：fast_path 候选沿用旧行为——无论决策结果都落一行（记录决策）；
    // 其他来源仅 remember/overwrite 时落行。KV 行失败只告警不回灌（非记忆本体）。
    if (this.deps.kvSync) {
      for (const d of decided) {
        const isFastPath = d.candidate.source === "chat:fast_path";
        if (!isFastPath && d.decision.decision === "reject") continue;
        try {
          this.deps.kvSync.appendMemorySummaryLine(
            actorId,
            `[fast-path][${d.decision.decision}][${d.decision.semanticClass}] ${d.candidate.text}`,
            d.candidate.topicHint,
          );
        } catch (err) {
          console.warn(
            "[memory-consolidation] KV summary 行写入失败（忽略）:",
            err instanceof Error ? err.message : err,
          );
        }
      }
    }
    return egressFailed;
  }

  /**
   * Supersession：新事实（overwrite/mutable_fact）到来时，语义重合的旧记忆
   * 退役（删除），而非靠 Jaccard 字面去重或任由新旧并存——过期偏好并存时
   * 模型会拿旧值作答。高信号稳定约束不自动退役，防一次误判抹掉长期约束。
   */
  private async retireSuperseded(actorId: string, text: string): Promise<string[]> {
    const memory = this.deps.memory;
    if (!memory) return [];
    try {
      const result = (await memory.search(text, {
        filters: { user_id: actorId },
        topK: 8,
      })) as unknown as {
        results?: Array<{ id: string; score?: number; metadata?: Record<string, unknown> }>;
      };
      const retired: string[] = [];
      for (const item of result.results ?? []) {
        const score = item.score ?? 0;
        if (score < this.supersedeSimilarity) continue;
        if (
          item.metadata?.highSignal === true &&
          item.metadata?.memorySemanticClass === "stable_constraint"
        ) {
          continue;
        }
        await memory.delete(item.id).catch(() => {});
        retired.push(item.id);
      }
      if (retired.length > 0) {
        console.info(
          `[memory-consolidation] superseded ${retired.length} old memories for actor ${actorId}`,
        );
      }
      return retired;
    } catch {
      return [];
    }
  }

  private async summarizeLowSignal(actorId: string, text: string): Promise<string> {
    const apiKey = resolveOpenAiApiKey();
    const keyLines = extractKeyLowSignalLines(text);
    if (!apiKey) {
      return [...keyLines, text.slice(0, 3000)].filter(Boolean).join("\n");
    }

    try {
      // maxRetries:1：SDK 默认 2 次静默重试会让瞬时失败双倍烧 token
      const openai = new OpenAI({ apiKey, maxRetries: 1 });
      const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
        {
          role: "system",
          content:
            "你是信息摘要器。把多轮低信号对话压缩成简洁中文摘要，保留关键事实、偏好、决定与待办，删除寒暄和无信息量内容。输出纯文本，500字内。",
        },
        { role: "user", content: text },
      ];
      const response = await openai.chat.completions.create({
        model: getAgenticMemoryLlmModel(),
        temperature: 0.3,
        messages,
      });
      const summary = response.choices[0]?.message?.content?.trim() || text.slice(0, 3000);
      const { recordLlmUsageByChars } = await import("./llm-token-audit.js");
      recordLlmUsageByChars({
        stage: "memory_flush_summarize",
        inputChars: JSON.stringify(messages).length,
        outputChars: summary.length,
        model: getAgenticMemoryLlmModel(),
        actorId,
      });
      return [...keyLines, summary].filter(Boolean).join("\n");
    } catch {
      return [...keyLines, text.slice(0, 3000)].filter(Boolean).join("\n");
    }
  }

  private async persistQueue(): Promise<void> {
    try {
      await writeJsonAtomic(this.filePath, { candidates: this.queue } satisfies PersistedQueue);
    } catch (err) {
      console.warn("[memory-consolidation] queue persist failed:", err);
    }
  }
}

/** 与原 AgenticMemoryIngestService.extractKeyLowSignalLines 一致的高信号行提取。 */
function extractKeyLowSignalLines(text: string): string[] {
  return text
    .split(/\n+/)
    .map((line) => line.trim())
    .filter((line) =>
      /\[.*\]|喜欢|不喜欢|讨厌|偏好|记住|提醒|承诺|决定|计划|待办|重要|生日|纪念日/i.test(line),
    )
    .slice(0, 6);
}

/**
 * decision 映射：unified.decision 与 decideMemoryWrite 的四值语义对齐
 *（remember/decay/reject 直映；unified 无 overwrite，改造类语义由
 * mutable_fact + 事实注册表级联承担）。
 */
function mapUnifiedDecision(decision: UnifiedExtraction["decision"]): MemoryDecisionResult["decision"] {
  if (decision === "remember" || decision === "decay" || decision === "reject") return decision;
  return "decay";
}

/** unified 中文语义类 → MemorySemanticClass（KV 行前缀 / supersession 触发沿用同一形状） */
const UNIFIED_SEMANTIC_CLASS_MAP: Record<string, MemoryDecisionResult["semanticClass"]> = {
  事实: "mutable_fact",
  偏好: "stable_preference",
  人物: "stable_identity",
  计划: "commitment_or_todo",
  承诺: "commitment_or_todo",
  事件: "temporary_context",
  其他: "temporary_context",
};

/** unified 抽取结果 → 决策结构（egress 判定与 KV 行前缀复用 decideMemoryWrite 的形状） */
function unifiedDecisionResult(unified: UnifiedExtraction): MemoryDecisionResult {
  return {
    decision: mapUnifiedDecision(unified.decision),
    confidence: 0.9,
    semanticClass:
      (unified.semanticClass && UNIFIED_SEMANTIC_CLASS_MAP[unified.semanticClass]) ||
      (unified.decision === "decay" ? "temporary_context" : "stable_identity"),
    reasons: ["unified_extract"],
    // LLM 直出的连续分；缺省按决策推导（remember 0.75 / decay 0.3 / reject 0.1）
    importance:
      unified.importance ??
      (unified.decision === "remember" ? 0.75 : unified.decision === "decay" ? 0.3 : 0.1),
  };
}

let singleton: MemoryConsolidationService | null = null;

export function getMemoryConsolidationService(): MemoryConsolidationService | null {
  return singleton;
}

/** bootstrap 装配：依赖齐备且开关开启时启用统一写入者；否则返回 null（各链路走旧路径）。 */
export function configureMemoryConsolidation(deps: MemoryConsolidationDeps): MemoryConsolidationService | null {
  if (!envBool("AGENT_MEMORY_CONSOLIDATION_ENABLED", true)) {
    console.info("[memory-consolidation] disabled by AGENT_MEMORY_CONSOLIDATION_ENABLED");
    singleton = null;
    return null;
  }
  if (!deps.narrative) {
    console.info("[memory-consolidation] disabled: no narrative egress");
    singleton = null;
    return null;
  }
  singleton = new MemoryConsolidationService(deps);
  void singleton.load();
  console.info(
    `[memory-consolidation] unified writer ready (debounce=${singleton["debounceMs"]}ms)`,
  );
  return singleton;
}

/** 测试专用：清空单例。 */
export function resetMemoryConsolidationForTests(): void {
  singleton = null;
}
