import type { ComputeQuotaService } from "../services/compute-quota-service.js";
import type { EvolutionLoopService } from "../services/evolution-loop-service.js";
import type { UserPersonalizationService } from "../services/user-personalization/user-personalization-service.js";
import type { NarrativeMemoryPort } from "../services/narrative-memory-port.js";
import type { TrajectorySkillPromotionService } from "../services/trajectory-skill-promotion-service.js";
import type { TaskExecutionPlan } from "./plan-execute-loop.js";
import { getAgentRuntimeConfig } from "./agent-runtime-config.js";
import { detectMemorySignals } from "./memory-signal.js";
import type { TurnUnderstanding } from "./task-router.js";
import { getShortTermMemoryConfig } from "../services/short-term-memory-config.js";
import { getDailyDigestService } from "../services/daily-digest-service.js";
import { getTurnWalService } from "../services/turn-wal-service.js";
import type { AgentMemorySyncService } from "../services/agent-memory-sync-service.js";
import { getMemoryManagerService } from "../services/memory-manager-service.js";
import { isKvSummaryMinimal } from "../config/memory-env.js";
import { inferMemoryTopic } from "./memory-topic.js";
import { decideMemoryWrite } from "../services/memory-decision-engine.js";
import { getConversationTimelineService } from "../services/conversation-timeline.js";
import { isNotesChatSessionId, isIncognitoChatSessionId } from "./master-chat-session.js";
import type { ShortTermMemoryGatewayService } from "../services/short-term-memory-gateway.js";
import { getMemoryConsolidationService } from "../services/memory-consolidation-service.js";
import { getScheduleHabitStore } from "../services/schedule-habit-store.js";
import { getPresenceFootprintStore } from "../rhythm/presence-footprint-store.js";
import { isEphemeralActorId } from "./actor-id.js";

export type FinalizeTurnInput = {
  actorId: string;
  userText: string;
  assistantText: string;
  /** 当前会话 sessionId；用于区分主会话 vs 笔记会话的记忆上下文。 */
  sessionId?: string;
  modelCallsConsumed?: number;
  planExecuteUsed?: boolean;
  pePlan?: TaskExecutionPlan | null;
  peExhausted?: boolean;
  messageId?: string;
  /** 本轮语义理解标记（L1 路由产出）：memory_instruction 驱动写入候选的「用户要求记住」信号。 */
  understanding?: TurnUnderstanding;
};

export type FinalizeTurnResult = {
  quotaSuffix?: string;
};

/**
 * 每轮对话前后统一钩子：记忆召回、写入、配额、进化环。
 */
export class TurnLifecycle {
  private readonly stmConfig = getShortTermMemoryConfig();

  constructor(
    private readonly deps: {
      narrativeMemory: NarrativeMemoryPort | null;
      computeQuotaService: ComputeQuotaService | null;
      evolutionLoopService: EvolutionLoopService | null;
      userPersonalizationService: UserPersonalizationService | null;
      agentMemorySyncService: AgentMemorySyncService | null;
      shortTermMemoryGateway: ShortTermMemoryGatewayService | null;
      /** 用户画像聚合器（惰性取：构造序晚于 BrainCenter 装配） */
      getUserProfileAggregator?: () => {
        observeTurn(
          actorId: string,
          userText: string,
          assistantText: string,
          opts?: { highSignal?: boolean },
        ): void;
      } | null;
    },
  ) {}

  async prepareNarrativeRecall(actorId: string, text: string): Promise<string | undefined> {
    // 召回触发判定已由调用方（agent-core narrowMemoryCue，模型标记驱动）单点
    // 承担——本方法不再内部二次词表门控（此前三处独立评估正则白名单，改一处漏两处）。
    if (!this.deps.narrativeMemory) return undefined;
    const timeoutMs = getAgentRuntimeConfig().memoryPrompt.narrativeRecallTimeoutMs;
    try {
      const nr = await Promise.race([
        this.deps.narrativeMemory.buildNarrativeRecall(actorId, text),
        new Promise<string>((_, reject) => {
          setTimeout(() => reject(new Error("narrative recall timeout")), timeoutMs);
        }),
      ]);
      return nr.trim() ? nr : undefined;
    } catch {
      return undefined;
    }
  }

  ingestTurnArchive(
    actorId: string,
    userText: string,
    assistantText: string,
    context: "main" | "notes" = "main",
    memoryInstruction = false,
    personalFact = false,
  ): void {
    // #3 写入精度：不再把整段 "Turn archive | user…| assistant…" 原文灌进长期记忆图
    // （那是噪声/串台源）。只抽取高价值原子片段（用户要求记住 / Agent 承诺/结论）；
    // 无高价值信号时只落一行极短的"用户意图主干"，再交整合链路裁决是否值得保留。
    // 完整轮次仍由 turn-wal / daily-digest / chat-threads 独立留存，不回落到长期图谱。
    const signal = detectMemorySignals(userText, assistantText, memoryInstruction, personalFact);
    const body = buildTurnArchiveSnapshot(userText, assistantText, signal);
    if (!body) return;

    // 统一写入者：候选只入队，裁决/回声过滤/supersession/落库都在整合链路单点完成
    const consolidation = getMemoryConsolidationService();
    if (consolidation) {
      consolidation.submitCandidate({
        actorId,
        text: body,
        source: "chat:turn_archive",
        context,
        highSignal: signal.isHighSignal,
        createdAt: new Date().toISOString(),
        topicHint: inferMemoryTopic(userText),
      });
      return;
    }

    if (!this.deps.narrativeMemory) return;
    void (async () => {
      const decision = await decideMemoryWrite(body, {
        actorId,
        source: "chat:turn_archive",
        userText,
        assistantText,
        heuristicHint: "decay",
      });
      await this.deps.narrativeMemory?.ingest(actorId, body, "chat:turn_archive", {
        highSignal: decision.decision === "remember" || decision.decision === "overwrite",
        context,
      });
    })().catch(() => {});
  }

  ingestFastPath(actorId: string, lines: string[], context: "main" | "notes" = "main", topicHint?: string): void {
    if (lines.length === 0) return;

    // 统一写入者：每条高信号原子行一个候选；KV summary 行由整合链路统一落
    const consolidation = getMemoryConsolidationService();
    if (consolidation) {
      const now = new Date().toISOString();
      for (const line of lines) {
        consolidation.submitCandidate({
          actorId,
          text: line,
          source: "chat:fast_path",
          context,
          highSignal: true,
          createdAt: now,
          topicHint,
        });
      }
      return;
    }

    if (!this.deps.narrativeMemory) return;
    const body = lines.join("\n");
    void (async () => {
      const decision = await decideMemoryWrite(body, {
        actorId,
        source: "chat:fast_path",
        heuristicHint: "remember",
      });
      await this.deps.narrativeMemory?.ingest(actorId, body, "chat:fast_path", {
        highSignal: decision.decision === "remember" || decision.decision === "overwrite",
        context,
      });
    })().catch(() => {});
  }

  finalizeTurn(input: FinalizeTurnInput): FinalizeTurnResult {
    const full = input.assistantText.trim();
    // 隐身会话（incognito: 前缀）：画像观察整体跳过——聊可以，画像不长
    const incognito = isIncognitoChatSessionId(input.sessionId);
    // 作息自述捕获（分级提醒的冷启动习惯源）：用户说「我一般1点半睡8点起」即入档，
    // 确定性规则抽取、零 LLM；隐身会话跳过（画像不长），临时 actor 不落盘。
    if (!incognito && !isEphemeralActorId(input.actorId)) {
      // 在场足迹：用户发消息 = 人在线。与工具调用一起构成作息的被动观察源，
      // 作息由 agent 自己观察得出，文本抽取只作补充。
      getPresenceFootprintStore()?.record(input.actorId);
      getScheduleHabitStore()?.captureFromUserText(input.actorId, input.userText);
    }
    if (!full) {
      // 空回复轮也喂画像聚合器：用户半边仍入队（与原 brain-center 阶段3.6.1 行为对齐）
      if (!incognito) {
        this.deps.getUserProfileAggregator?.()?.observeTurn(input.actorId, input.userText, "");
      }
      return this.applyQuota(input);
    }

    const memoryInstruction = input.understanding?.memoryInstruction === true;
    const personalFact = input.understanding?.personalFact === true;
    const signal = detectMemorySignals(input.userText, full, memoryInstruction, personalFact);
    const ts = new Date().toISOString();
    const memContext: "main" | "notes" = isNotesChatSessionId(input.sessionId) ? "notes" : "main";

    void getTurnWalService()
      .append({
        ts,
        actorId: input.actorId,
        userText: input.userText,
        assistantText: full,
        highSignal: signal.isHighSignal,
        messageId: input.messageId,
        planExecuteUsed: input.planExecuteUsed,
        context: memContext,
      })
      .catch(() => {});

    getDailyDigestService().observeTurn(input.actorId, input.userText, full, {
      priorityLines: signal.isHighSignal ? signal.extractLines : undefined,
    });

    if (this.deps.agentMemorySyncService && this.deps.shortTermMemoryGateway && input.sessionId) {
      const mission = this.deps.shortTermMemoryGateway.getTaskState(input.sessionId).conversationMemory?.currentMission ?? null;
      this.deps.agentMemorySyncService.setCurrentMission(input.actorId, mission);
    }

    if (signal.isHighSignal) {
      // 高信号原子行：统一写入者启用时同时覆盖长期图（Mem0/海马体）与
      // KV summary 行两个出口（每候选一次决策，替代旧 fast-path + KV 双链路双决策）；
      // 未启用时走 ingestFastPath 旧链路 + 下方 KV fast-path 直写。
      this.ingestFastPath(input.actorId, signal.extractLines, memContext, inferMemoryTopic(input.userText));
      if (!getMemoryConsolidationService() && this.deps.agentMemorySyncService && !isKvSummaryMinimal()) {
        void (async () => {
          for (const line of signal.extractLines) {
            const decision = await decideMemoryWrite(line, {
              actorId: input.actorId,
              source: "memory_summary:fast_path",
              userText: input.userText,
              assistantText: full,
              heuristicHint: "remember",
            });
            this.deps.agentMemorySyncService?.appendMemorySummaryLine(
              input.actorId,
              `[fast-path][${decision.decision}][${decision.semanticClass}] ${line}`,
              inferMemoryTopic(input.userText),
            );
          }
        })().catch(() => {});
      }
    }

    this.deps.agentMemorySyncService?.reconcileStructuredMemoryAfterTurn(
      input.actorId,
      input.userText,
      full,
    );

    const deferArchive =
      this.stmConfig.mode === "enhanced" &&
      (this.stmConfig.deferTurnArchive || signal.isHighSignal);
    if (!deferArchive) {
      this.ingestTurnArchive(
        input.actorId,
        input.userText,
        full,
        memContext,
        memoryInstruction,
        personalFact,
      );
    }

    this.deps.evolutionLoopService?.onAssistantDone(input.actorId, input.userText, full);
    this.deps.userPersonalizationService?.observeTurn(input.actorId, input.userText, full);
    // 用户画像聚合器观察（2026-09-29 从 brain-center 阶段3.6.1 迁入）：
    // 这里拿得到真实助手全文（原位 cognitive.response 恒空串，画像只见用户半边）；
    // 且任务面轮次也开始喂画像。highSignal 供抽取 token 闸预筛。隐身会话跳过。
    if (!incognito) {
      this.deps.getUserProfileAggregator?.()?.observeTurn(input.actorId, input.userText, full, {
        highSignal: signal.isHighSignal,
      });
    }

    getMemoryManagerService()?.onTurnCompleted(input.actorId, input.sessionId, input.userText, full);

    // 对话时间线：主对话轮次计入时间线（笔记会话不算用户对话），首次对话事实落长期记忆。
    if (!input.sessionId || !isNotesChatSessionId(input.sessionId)) {
      getConversationTimelineService()?.recordTurn(input.actorId);
    }

    return this.applyQuota(input);
  }

  private applyQuota(input: FinalizeTurnInput): FinalizeTurnResult {
    const units = getAgentRuntimeConfig().quota.unitsPerModelCall;
    const modelCalls = Math.max(1, input.modelCallsConsumed ?? 1);
    if (!this.deps.computeQuotaService || !Number.isFinite(units) || units <= 0) {
      return {};
    }

    const totalConsume = units * modelCalls;
    const adj = this.deps.computeQuotaService.adjust(input.actorId, "consume", totalConsume);
    if (!adj.ok) {
      return {
        quotaSuffix: `（提示：算力配额不足，本次按 ${modelCalls} 次模型调用未扣减共 ${totalConsume} 单位；请扩大 COMPUTE_QUOTA_DEFAULT_UNITS 或释放预留。）`,
      };
    }
    return {};
  }

  /** 轨迹晋升捕获收尾（与 finalizeTurn 分离，便于传入 trajCap 实例） */
  static finalizeTrajectory(
    trajCap: ReturnType<TrajectorySkillPromotionService["beginCapture"]> | undefined,
    assistantText: string,
    meta: {
      planExecuteUsed: boolean;
      modelCallsApprox: number;
      pePlan: TaskExecutionPlan | null;
      peExhausted: boolean;
    },
  ): void {
    if (!trajCap) return;
    trajCap.observePePlan(meta.pePlan);
    trajCap.observeSelfCheck(
      meta.planExecuteUsed
        ? meta.peExhausted
          ? "自检未通过或已达到最大重试"
          : "PE 自检通过或未触发重试阈值"
        : "单轮工具环路径",
      meta.planExecuteUsed ? !meta.peExhausted : undefined,
    );
    void trajCap
      .finalizeEvolution(assistantText, {
        planExecuteEnabled: meta.planExecuteUsed,
        modelCallsApprox: meta.modelCallsApprox,
        pePlan: meta.pePlan,
        peExhaustedRetries: meta.peExhausted,
      })
      .catch(() => {});
  }
}

/**
 * #3 写入精度：把一轮对话压成"高价值原子片段"。有显式记忆信号时只保留
 * 那些原子行；否则只留一行用户意图主干（≤120 字），避免把整段 assistant
 * 输出灌进长期记忆图（噪声/串台源）。低价值闲聊大概率不会被 decideMemoryWrite
 * 判为 remember，从而不落长期图谱。
 */
function buildTurnArchiveSnapshot(
  userText: string,
  assistantText: string,
  signal: ReturnType<typeof detectMemorySignals>,
): string {
  if (signal.extractLines.length > 0) {
    return signal.extractLines.join("\n");
  }
  const user = userText.trim().replace(/\s+/g, " ");
  if (!user) return "";
  return `Turn | user: ${user.slice(0, 120)}`;
}
