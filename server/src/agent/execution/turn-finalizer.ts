import type { BrainCenter } from "../../brain/index.js";
import type { AgentReply } from "../types.js";
import { getRuntimeKernel } from "../runtime-kernel.js";
import { TurnLifecycle } from "../turn-lifecycle.js";
import type { TaskExecutionPlan } from "../plan-execute-loop.js";
import type { ExternalChatProvider } from "../../external-model/types.js";
import type { ShortTermMemoryGatewayService } from "../../services/short-term-memory-gateway.js";
import { getDailyJournalService } from "../../services/daily-journal-service.js";
import { normalizeTraditionalToSimplified } from "../../utils/simplified-chinese.js";

export type FinishTurnMeta = {
  streamedChunks: boolean;
  modelCallsConsumed: number;
  planExecuteUsed: boolean;
  pePlan: TaskExecutionPlan | null;
  peExhausted: boolean;
  messageId?: string;
  sessionId?: string;
};

export type TurnFinalizerDeps = {
  provider: ExternalChatProvider | null;
  turnLifecycle: TurnLifecycle;
  shortTermMemoryGateway: ShortTermMemoryGatewayService | null;
  getBrainCenter: () => BrainCenter | null;
};

export class TurnFinalizer {
  constructor(private readonly deps: TurnFinalizerDeps) {}

  /**
   * 收口原则（2026-10-13 根修定稿）：**已流式送出的文本即最终稿**。
   * 本层不再对正文做任何人格/风格/长度的程序层改写（旧 ReplyStyleGate
   * 确定性删句与隔离重写臂已整体删除——它们在流式之后换稿，是
   * 「先流式输出一段、最后给的回复不一样」的直接根源）。人格约束
   * 归 prompt 层（【说话方式】基准）；本层只保留：
   *   - 输出安全检查（brain-center 事实性安全，非文风）；
   *   - 繁→简出口正规化（确定性 1:1 字符映射，不改变措辞）；
   *   - 空回复重生（空 = 无内容可改，不构成「换稿」）；
   *   - 轨迹 / 记忆 / 日志记账。
   */
  async finish(
    actorId: string,
    userText: string,
    assistantText: string,
    meta: FinishTurnMeta,
    onAssistantDelta?: (delta: string) => void,
  ): Promise<AgentReply> {
    const outputSafety = this.deps.getBrainCenter()?.checkOutputSafety(assistantText, {
      actorId,
      sessionId: meta.sessionId,
      userText,
    });
    let sanitizedOutput = outputSafety?.sanitized ?? assistantText;

    // 繁→简出口正规化（2026-10-11）：模型偶发把地名/常用词泄成繁体（「興義」），
    // 确定性 1:1 字符映射整串归一。先于记账执行，保证轨迹、
    // 记忆落盘、done 载荷看到的都是简体权威文本。
    const t2s = normalizeTraditionalToSimplified(sanitizedOutput);
    if (t2s.changed) {
      console.warn(
        `[ReplyStyleGate] 繁体收敛：整串替换为简体（${sanitizedOutput.length} 字符）`,
      );
      sanitizedOutput = t2s.text;
    }

    const runtimeKernel = getRuntimeKernel(actorId);
    if (runtimeKernel.isMinimalMode()) {
      const postResult = runtimeKernel.postValidate(sanitizedOutput);
      if (!postResult.ok) {
        console.warn(
          `[RuntimeKernel.postValidate] output matched ${postResult.hitPatterns.length} rule(s):`,
          postResult.violations,
        );
      }
    }

    const trimmed = sanitizedOutput.trim();
    if (!trimmed) {
      const regenerated = await this.regenerateEmptyReply(actorId, userText, onAssistantDelta);
      return {
        text: regenerated,
        streamedChunks: regenerated ? meta.streamedChunks : false,
      };
    }


    const { quotaSuffix } = this.deps.turnLifecycle.finalizeTurn({
      actorId,
      userText,
      assistantText: trimmed,
      sessionId: meta.sessionId,
      modelCallsConsumed: meta.modelCallsConsumed,
      planExecuteUsed: meta.planExecuteUsed,
      pePlan: meta.pePlan,
      peExhausted: meta.peExhausted,
      messageId: meta.messageId,
    });

    if (this.deps.shortTermMemoryGateway && meta.sessionId) {
      this.deps.shortTermMemoryGateway.reconcileTaskAfterTurn(meta.sessionId, userText, trimmed);
    }

    // 当日对话日志：规则精简行落盘（零 LLM，fire-and-forget），
    // 供「当天问题扫日志」与夜晚固化消费。
    if (meta.sessionId) {
      getDailyJournalService()?.appendTurn(actorId, meta.sessionId, userText, trimmed);
    }

    return {
      text: quotaSuffix ? `${trimmed}\n\n${quotaSuffix}` : trimmed,
      streamedChunks: meta.streamedChunks,
    };
  }

  private async regenerateEmptyReply(
    actorId: string,
    userText: string,
    onAssistantDelta?: (delta: string) => void,
  ): Promise<string> {
    try {
      const provider = this.deps.provider;
      if (!provider?.isEnabled()) return "";
      console.warn("[TurnFinalizer] received empty output, regenerating once");
      const regenerateText = await provider.streamCompletion(
        `regen-${actorId}-${Date.now()}`,
        {
          text:
            `${userText}\n\n` +
            "[system hint: the previous turn produced no response text. Answer the user directly in natural language. Do not apologize and do NOT say 'not found / unable / could not / I don't have this'. Give the most helpful answer you can based on what you know, and if you lack one piece of info, name exactly what clue you need.]",
        },
        (delta) => onAssistantDelta?.(delta),
        undefined,
        {
          ephemeralTurn: true,
          disableThinking: true,
          maxThreadMessages: 4,
        },
      );
      // 反道歉指令：不再下发任何固定"未完成/没查到"道歉文案，
      // 直接返回重生成的真实内容（若仍为空，交由上层自然处理）。
      return regenerateText.trim();
    } catch (err) {
      console.error("[TurnFinalizer] regeneration failed", err);
      return "";
    }
  }
}
