import OpenAI from "openai";
import type { Memory } from "mem0ai/oss";

import {
  resolveOpenAiApiKey,
  getAgenticMemoryLlmModel,
  getCommitmentExtractScope,
} from "./env.js";
import { decideMemoryWrite } from "../services/memory-decision-engine.js";
import { isEphemeralActorId, warnEphemeralActorMemoryBlocked } from "../agent/actor-id.js";
import { gateLtmWrite } from "./ltm-write-gate.js";
import {
  extractUnified,
  isMemoryUnifiedExtractEnabled,
  type UnifiedExtraction,
  type UnifiedUnderstanding,
  type UnifiedLlmClient,
} from "./unified-extractor.js";

/** Mem0 add(infer:true) 抽取出的单条记忆 */
export interface Mem0WrittenItem {
  id: string;
  memory: string;
  metadata?: Record<string, unknown>;
}

/**
 * Mem0 落库完成事件（写入钩子入参）。
 * 方案 B（账本落账）、方案 C（承诺自动提取）、方案 D（溯源登记）都从此处取数——
 * 复用 Mem0 infer 的抽取结果，不额外调 LLM。
 * unified 路径（P1-6）额外携带 commitments/corrections/facts（同一次 LLM 的产物，
 * 钩子直接消费，省掉 commitment-extractor 的第二次调用）。
 */
export interface Mem0WriteEvent {
  actorId: string;
  sourceId: string;
  context: "main" | "notes";
  highSignal: boolean;
  /** Mem0 infer/unified 抽取结果（含记忆 id，供账本/溯源关联） */
  results: Mem0WrittenItem[];
  /** 统一抽取路径携带：承诺识别结果（钩子直接 ingestExtracted，不再调 LLM） */
  commitments?: import("./commitment-board.js").ExtractedCommitment[];
  /** 统一抽取路径携带：用户纠正（钩子走 supersession + 溯源级联） */
  corrections?: import("./unified-extractor.js").UnifiedCorrection[];
  /** 统一抽取路径携带：对话理解（钩子走理解档案 topic 级 upsert + 演变历史） */
  understandings?: UnifiedUnderstanding[];
  /** 统一抽取路径携带：结构化事实（钩子走事实库字段级 latest-wins upsert） */
  facts?: import("./unified-extractor.js").UnifiedFact[];
  /** 统一抽取路径携带：用户明确要求忘掉的档案字段（钩子走字段级 supersede） */
  forget?: string[];
  /** 统一抽取路径携带：角色→人名指代映射（钩子走事实库 指代·role 字段落库） */
  referents?: import("./unified-extractor.js").UnifiedReferent[];
}

export type Mem0WriteHook = (event: Mem0WriteEvent) => void;

/** 低信号统一写入者接管后的投递口（memory-consolidation-service，bootstrap 接线） */
export type LowSignalSink = (entry: {
  actorId: string;
  sourceId: string;
  text: string;
  context: "main" | "notes";
}) => void;

function extractKeyLowSignalLines(text: string): string[] {
  return text
    .split(/\n+/)
    .map((line) => line.trim())
    .filter((line) =>
      /\[.*\]|喜欢|不喜欢|讨厌|偏好|记住|提醒|承诺|决定|计划|待办|重要|生日|纪念日/i.test(
        line,
      ),
    )
    .slice(0, 6);
}

export class AgenticMemoryIngestService {
  private lowSignalSink: LowSignalSink | null = null;
  private writeHooks: Mem0WriteHook[] = [];
  /** 统一抽取 LLM 客户端（测试注入 fake；生产为 null 走内部 OpenAI 构造） */
  private extractionClient: UnifiedLlmClient | null = null;

  constructor(private readonly memory: Memory) {}

  /** 注入统一抽取客户端（e2e 测试用；生产不调用） */
  setExtractionClient(client: UnifiedLlmClient | null): void {
    this.extractionClient = client;
  }

  /**
   * 注入统一写入者接管口。设置后低信号内容不再走内置内存缓冲，
   * 而是投递给 memory-consolidation-service 的候选队列（唯一整合链路）；
   * 未设置（统一写入者关闭/测试）时保持原缓冲行为。
   */
  setLowSignalSink(sink: LowSignalSink | null): void {
    this.lowSignalSink = sink;
  }

  /**
   * 注册 Mem0 落库后钩子（方案 B/C/D 的统一取数口）。
   * 钩子抛错不影响主写入链路。
   */
  addWriteHook(hook: Mem0WriteHook): void {
    this.writeHooks.push(hook);
  }

  private fireWriteHooks(event: Mem0WriteEvent): void {
    for (const hook of this.writeHooks) {
      try {
        hook(event);
      } catch (err) {
        console.error("[agentic-memory] write hook failed（忽略）:", err);
      }
    }
  }

  /**
   * 兼容旧调用（默认 context=main）。新调用请显式传 context 区分主会话 vs 笔记会话。
   */
  async ingestText(
    actorId: string,
    sourceId: string,
    text: string,
    opts?: { highSignal?: boolean; context?: "main" | "notes" },
  ): Promise<void> {
    // v3 写入门：任务态/提醒回执/协议残留不入长期链路（含低信号承诺抽取——
    // 任务快照里抽不出真实承诺，只产噪音）
    const gateVerdict = gateLtmWrite(text, sourceId);
    if (!gateVerdict.admit) {
      console.log(`[ltm-gate] 拒绝 ingestText(${gateVerdict.reason}) source=${sourceId}: ${text.slice(0, 60)}`);
      return;
    }
    const t = gateVerdict.cleaned;
    if (!t || t.length < 4) return;

    // 匿名身份治理：无稳定身份的对话不进长期记忆（共享桶 = 跨请求串台源）
    if (isEphemeralActorId(actorId)) {
      warnEphemeralActorMemoryBlocked(actorId, "Mem0 长期记忆写入");
      return;
    }

    const context = opts?.context ?? "main";

    if (opts?.highSignal) {
      await this.ingestHighSignal(actorId, sourceId, t, context);
      return;
    }

    // P0-2 承诺捕获与记忆路由解耦：低信号文本（临时上下文/decay）不值得长期
    // 存储，但里面的承诺/值得形成的理解照样要抓——"明天发你"是 decay 记忆 +
    // 真承诺，"我老婆是刘浩存"是闲聊语气 + 一条对用户的理解（粉丝式称呼）。
    // fire-and-forget 抽取（无词表预筛，识别交给 LLM），只消费
    // commitments/corrections/understandings，不阻塞低信号缓冲主链路。
    if (
      context === "main" &&
      isMemoryUnifiedExtractEnabled() &&
      getCommitmentExtractScope() === "all"
    ) {
      void extractUnified(t, { client: this.extractionClient ?? undefined })
        .then((orphan) => {
          if (!orphan) return;
          if (
            orphan.commitments.length === 0 &&
            orphan.corrections.length === 0 &&
            orphan.understandings.length === 0 &&
            orphan.facts.length === 0 &&
            orphan.forget.length === 0
          ) {
            return;
          }
          this.fireWriteHooks({
            actorId,
            sourceId,
            context,
            highSignal: false,
            results: [],
            commitments: orphan.commitments.length > 0 ? orphan.commitments : undefined,
            corrections: orphan.corrections.length > 0 ? orphan.corrections : undefined,
            understandings:
              orphan.understandings.length > 0 ? orphan.understandings : undefined,
            facts: orphan.facts.length > 0 ? orphan.facts : undefined,
            forget: orphan.forget.length > 0 ? orphan.forget : undefined,
            referents: orphan.referents.length > 0 ? orphan.referents : undefined,
          });
        })
        .catch((err) =>
          console.warn(
            "[agentic-memory] 低信号承诺抽取失败（忽略）:",
            err instanceof Error ? err.message : err,
          ),
        );
    }

    if (this.lowSignalSink) {
      this.lowSignalSink({ actorId, sourceId, text: t, context });
      return;
    }

    // 统一写入者未接管（AGENT_MEMORY_CONSOLIDATION_ENABLED=0 / 测试）：
    // 原内置内存缓冲（10 条/8000 字/30s 定时摘要）已删除——与
    // memory-consolidation-service 逐字重复的双轨遗留。降级为直写 Mem0
    // （infer:true，decay 语义），由生命周期遗忘机制回收。
    await this.writeDecidedDetailed(actorId, sourceId, t, context, false).catch((err) => {
      console.error("[agentic-memory] 低信号直写失败（忽略）:", err);
    });
  }

  private async ingestHighSignal(
    actorId: string,
    sourceId: string,
    body: string,
    context: "main" | "notes",
  ): Promise<void> {
    // P1-6 统一抽取：决策 + 记忆 + 承诺 + 纠正 + 事实 一次 LLM 完成（原最多 3 次调用）。
    // 返回 null（无 key/失败）时整体回退旧三段路径。
    const unified = isMemoryUnifiedExtractEnabled()
      ? await extractUnified(body, { client: this.extractionClient ?? undefined })
      : null;
    if (unified) {
      await this.persistUnifiedExtraction(actorId, sourceId, unified, context, true, body);
      return;
    }

    const decision = await decideMemoryWrite(body, {
      actorId,
      source: sourceId,
      heuristicHint: "remember",
    });

    // 写入决策真正拦截：reject 的内容不落库（此前决策只写 metadata，无否决权）
    if (decision.decision === "reject") return;

    await this.writeDecidedDetailed(actorId, sourceId, body, context, true, {
      memoryDecision: decision.decision,
      memorySemanticClass: decision.semanticClass,
      importance: decision.importance,
    });
  }

  /**
   * 统一抽取产物直存（所有 unified 路径共用的落库核心）：
   *   - memories 以 infer:false 直存（抽取已在 extractUnified 完成，Mem0 不再二次调 LLM）；
 *   - 落库后 fire 钩子，携带 results + understandings + commitments + corrections + facts——
 *     bootstrap 钩子据此做账本落账 / 理解档案 upsert（含演变历史）/ 承诺落板 / 纠正级联 / 事实库更新；
   *   - decision=reject 时记忆不落库，但承诺/纠正/理解仍经钩子落地（P0-2 解耦语义）；
   *   - memories 为空且非 reject 时回退 fallbackText（高信号=原句；整合路径传截断后的合并文本）。
   * 供 ingestHighSignal 与 memory-consolidation-service（统一写入者）复用。
   */
  async persistUnifiedExtraction(
    actorId: string,
    sourceId: string,
    extraction: UnifiedExtraction,
    context: "main" | "notes",
    highSignal: boolean,
    fallbackText?: string,
    extraMetadata?: Record<string, unknown>,
  ): Promise<Mem0WrittenItem[]> {
    if (isEphemeralActorId(actorId)) {
      warnEphemeralActorMemoryBlocked(actorId, "Mem0 长期记忆写入");
      return [];
    }

    const understandings =
      extraction.understandings.length > 0 ? extraction.understandings : undefined;
    const commitments =
      extraction.commitments.length > 0 ? extraction.commitments : undefined;
    const corrections =
      extraction.corrections.length > 0 ? extraction.corrections : undefined;
    const facts = extraction.facts.length > 0 ? extraction.facts : undefined;
    // forget 防御性取值：测试/旧调用方手工构造的 extraction 可能缺该字段
    const forget = (extraction.forget?.length ?? 0) > 0 ? extraction.forget : undefined;
    const referents = extraction.referents && extraction.referents.length > 0 ? extraction.referents : undefined;

    if (extraction.decision === "reject") {
      // 被拒存：results 为空（账本不落 claim），但承诺/纠正/理解/事实仍要落地
      if (understandings || commitments || corrections || facts || forget || referents) {
        this.fireWriteHooks({
          actorId,
          sourceId,
          context,
          highSignal,
          results: [],
          commitments,
          corrections,
          understandings,
          facts,
          forget,
          referents,
        });
      }
      return [];
    }

    const memories =
      extraction.memories.length > 0
        ? extraction.memories
        : fallbackText
          ? [fallbackText]
          : [];
    const results: Mem0WrittenItem[] = [];
    for (const item of memories) {
      // v3 写入门：任务态/一次性提醒/协议残留/回声体在入口即拒（此前靠生命周期
      // 遗忘回收，实测 327 条里 41 条化石——出口收口后不再产生新污染）
      const verdict = gateLtmWrite(item, sourceId);
      if (!verdict.admit) {
        console.log(`[ltm-gate] 拒绝 Mem0 写入(${verdict.reason}) source=${sourceId}: ${item.slice(0, 60)}`);
        continue;
      }
      const trimmed = verdict.cleaned.length > 12_000 ? `${verdict.cleaned.slice(0, 12_000)}...` : verdict.cleaned;
      try {
        const addResult = (await this.memory.add([{ role: "user", content: trimmed }], {
          userId: actorId,
          metadata: {
            source: sourceId,
            actorId,
            context,
            highSignal,
            memoryDecision: extraction.decision,
            // 连续重要性分（0-1）：检索加权与 TTL 豁免的依据（unified 缺省按 decision 推导）
            importance: extraction.importance ?? (extraction.decision === "remember" ? 0.7 : 0.3),
            ...(extraction.semanticClass
              ? { memorySemanticClass: extraction.semanticClass }
              : {}),
            extractSource: "unified",
            ...extraMetadata,
          },
          // 统一抽取已完成记忆改写，Mem0 侧直存，不再进 infer 的 LLM
          infer: false,
        })) as unknown as { results?: Mem0WrittenItem[] };
        // infer:false 时 Mem0 返回的条目文本即原文；缺 id 的条目跳过钩子关联
        for (const r of addResult?.results ?? []) {
          if (r?.id) results.push(r);
        }
      } catch (err) {
        console.error("[agentic-memory] unified 直存失败（跳过该条）:", err);
      }
    }
    // Mem0 全部写入失败但承诺/纠正/理解/事实存在时也要触发钩子（不随存储失败丢失）
    if (results.length > 0 || understandings || commitments || corrections || facts || forget || referents) {
      this.fireWriteHooks({
        actorId,
        sourceId,
        context,
        highSignal,
        results,
        commitments,
        corrections,
        understandings,
        facts,
        forget,
        referents,
      });
    }
    return results;
  }

  /**
   * 统一写入者出口：候选已由 memory-consolidation-service 裁决过，
   * 这里直接落库（不再调 decideMemoryWrite），消除高信号路径的双重 LLM 决策。
   */
  async writeDecided(
    actorId: string,
    sourceId: string,
    body: string,
    context: "main" | "notes",
    highSignal: boolean,
  ): Promise<void> {
    await this.writeDecidedDetailed(actorId, sourceId, body, context, highSignal);
  }

  /**
   * Mem0 落库核心（所有持久写入共用）：
   *   - infer:true 由 Mem0 LLM 抽取结构化记忆条目，返回结果（含 id）
   *   - 落库成功后触发 writeHooks（方案 B 账本 / 方案 C 承诺提取 / 方案 D 溯源）
   *   - extraMetadata 供 memory-bridge 注入 graphNodeId 等跨层关联字段
   * 返回抽取结果；Mem0 未返回明细时 results 为空数组（hooks 不触发）。
   */
  async writeDecidedDetailed(
    actorId: string,
    sourceId: string,
    body: string,
    context: "main" | "notes",
    highSignal: boolean,
    extraMetadata?: Record<string, unknown>,
  ): Promise<Mem0WrittenItem[]> {
    const gateVerdict = gateLtmWrite(body, sourceId);
    if (!gateVerdict.admit) {
      console.log(`[ltm-gate] 拒绝 Mem0 infer 写入(${gateVerdict.reason}) source=${sourceId}: ${body.slice(0, 60)}`);
      return [];
    }
    const t = gateVerdict.cleaned;
    if (!t || t.length < 4) return [];

    if (isEphemeralActorId(actorId)) {
      warnEphemeralActorMemoryBlocked(actorId, "Mem0 长期记忆写入");
      return [];
    }

    const trimmed = t.length > 12_000 ? `${t.slice(0, 12_000)}...` : t;
    const addResult = (await this.memory.add([{ role: "user", content: trimmed }], {
      userId: actorId,
      metadata: {
        source: sourceId,
        actorId,
        context,
        highSignal,
        ...(highSignal ? { memoryDecision: "remember" } : { memoryDecision: "decay" }),
        // 连续重要性分缺省（infer 路径无统一抽取分数）：高信号 0.7 / 低信号 0.3，
        // 调用方可经 extraMetadata 覆盖（如 ingestHighSignal 回退路径带真实决策分）
        importance: highSignal ? 0.7 : 0.3,
        ...extraMetadata,
      },
      infer: true,
    })) as unknown as { results?: Mem0WrittenItem[] };

    const results = addResult?.results ?? [];
    if (results.length > 0) {
      this.fireWriteHooks({ actorId, sourceId, context, highSignal, results });
    }
    return results;
  }
}
