import type { BrainCenter } from "../../brain/index.js";
import type { AgentReply } from "../types.js";
import { getRuntimeKernel } from "../runtime-kernel.js";
import { TurnLifecycle } from "../turn-lifecycle.js";
import type { TaskExecutionPlan } from "../plan-execute-loop.js";
import type { ExternalChatProvider } from "../../external-model/types.js";
import type { ShortTermMemoryGatewayService } from "../../services/short-term-memory-gateway.js";
import { getDailyJournalService } from "../../services/daily-journal-service.js";
import type { TrajectorySkillPromotionService } from "../../services/trajectory-skill-promotion-service.js";
import { enforceReplyStyle, extractProtocolBlocks, detectReplyStyleViolations } from "./reply-style-guard.js";
import type { ReplyStyleLane } from "./reply-style-guard.js";
import { normalizeTraditionalToSimplified } from "../../utils/simplified-chinese.js";

export type FinishTurnMeta = {
  streamedChunks: boolean;
  modelCallsConsumed: number;
  planExecuteUsed: boolean;
  pePlan: TaskExecutionPlan | null;
  peExhausted: boolean;
  trajCap: ReturnType<TrajectorySkillPromotionService["beginCapture"]> | undefined;
  messageId?: string;
  sessionId?: string;
  /** 本轮执行车道：chat 面启用长度上限，task 面只做人格检查（默认 chat） */
  lane?: ReplyStyleLane;
  /**
   * 确认轮（2026-09-24）：本轮日历/提醒类创建工具刚成功（reminder.plan /
   * calendar.create_*，agent-core 在 onToolExecuted 里跟踪）。办妥确认不吃
   * 结构豁免，照走 chat 长度上限——废话确认排成列表也逃不过 overlong。
   */
  confirmationRound?: boolean;
};

export type TurnFinalizerDeps = {
  provider: ExternalChatProvider | null;
  turnLifecycle: TurnLifecycle;
  shortTermMemoryGateway: ShortTermMemoryGatewayService | null;
  getBrainCenter: () => BrainCenter | null;
};

/** 隔离重写臂开关：REPLY_STYLE_REWRITE=off|0|false 时只走确定性删句（默认开） */
function isStyleRewriteDisabled(): boolean {
  const raw = (process.env.REPLY_STYLE_REWRITE ?? "").trim().toLowerCase();
  return raw === "off" || raw === "0" || raw === "false";
}

export class TurnFinalizer {
  constructor(private readonly deps: TurnFinalizerDeps) {}

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
    // 确定性 1:1 字符映射整串归一。先于风格闸执行，保证后续人格检查、轨迹、
    // 记忆落盘、done 载荷看到的都是简体权威文本。
    const t2s = normalizeTraditionalToSimplified(sanitizedOutput);
    if (t2s.changed) {
      console.warn(
        `[ReplyStyleGate] 繁体收敛：整串替换为简体（${sanitizedOutput.length} 字符）`,
      );
      sanitizedOutput = t2s.text;
    }

    // 回复风格闸（2026-09-22）：人格/长度越形在此程序层强制整形，
    // 不依赖 prompt（长上下文下模型不守）。正常回复零接触；
    // 完成轨迹、记忆落盘、done 载荷用的都是整形后的文本。
    const styleGate = enforceReplyStyle(sanitizedOutput, meta.lane ?? "chat", {
      confirmationRound: meta.confirmationRound,
    });
    if (styleGate.changed) {
      console.warn(
        `[ReplyStyleGate] 越形整形（${styleGate.violations.join("+")}）：` +
          `${sanitizedOutput.length} -> ${styleGate.text.length} 字符`,
      );
      sanitizedOutput = styleGate.text;
    } else if (styleGate.violations.length > 0) {
      console.warn(
        `[ReplyStyleGate] 检出 ${styleGate.violations.join("+")} 但无可安全删除句，原文放行`,
      );
    }

    // 隔离重写臂（2026-09-22 第二层）：确定性删句保不住"同义反复"（三句话一个
    // 意思、句句都合规），对越形回复再用一次**最小上下文**微调用压缩成正常人
    // 两句——只喂草稿本身、不带会话历史（会话内 prompt 已被证伪，隔离微调单
    // 不存在"上下文太多不听话"问题）。产物必须回闸复检，不合格回退确定性结果。
    if (
      styleGate.violations.length > 0 &&
      (meta.lane ?? "chat") === "chat" &&
      !isStyleRewriteDisabled()
    ) {
      sanitizedOutput = await this.rewriteReplyBriefly(actorId, sanitizedOutput, {
        confirmationRound: meta.confirmationRound,
      });
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

    TurnLifecycle.finalizeTrajectory(meta.trajCap, trimmed, {
      planExecuteUsed: meta.planExecuteUsed,
      modelCallsApprox: meta.modelCallsConsumed,
      pePlan: meta.pePlan,
      peExhausted: meta.peExhausted,
    });

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

  /**
   * 隔离重写：把越形草稿压成"熟朋友发微信"的两句短话。
   * 只给草稿与一句话指令（无会话历史、ephemeral 不落线程），产物回闸复检——
   * 仍越形、为空、或比草稿还长，一律回退确定性整形结果（永不变差）。
   */
  private async rewriteReplyBriefly(
    actorId: string,
    draft: string,
    opts?: { confirmationRound?: boolean },
  ): Promise<string> {
    const provider = this.deps.provider;
    if (!provider?.isEnabled()) return draft;
    const { body, blocks } = extractProtocolBlocks(draft);
    try {
      const rewritten = (
        await provider.streamCompletion(
          `style-${actorId}-${Date.now()}`,
          {
            text:
              `${body}\n\n` +
              "[system hint: 把上面的回复重写成一句熟朋友发微信会说的话：最多两句短句，中文口语，直接了当。保留全部关键事实（结论、日期、数字、人名、查到/没查到）。删掉道歉、找补、能力自诉（如「我的问题在于…」）和连环提议。不要 Markdown、不要表情、不要列表。只输出重写后的回复本身。]",
          },
          () => {},
          undefined,
          {
            ephemeralTurn: true,
            disableThinking: true,
            maxThreadMessages: 2,
          },
        )
      ).trim();
      const candidate = rewritten || body;
      const residual = detectReplyStyleViolations(candidate, "chat", {
        confirmationRound: opts?.confirmationRound,
      });
      if (
        residual.length === 0 &&
        candidate.replace(/[\s*#>`~|]/g, "").length <= body.replace(/[\s*#>`~|]/g, "").length
      ) {
        console.info(
          `[ReplyStyleGate] 隔离重写生效：${body.length} -> ${candidate.length} 字符`,
        );
        return blocks.length > 0 ? `${candidate}\n\n${blocks.join("")}` : candidate;
      }
      console.warn(
        `[ReplyStyleGate] 隔离重写产物不合格（residual=${residual.join("+") || "无"}），回退确定性整形`,
      );
      return draft;
    } catch (err) {
      console.warn("[ReplyStyleGate] 隔离重写失败，用确定性整形结果:", err);
      return draft;
    }
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
