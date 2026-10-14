import { randomUUID } from "node:crypto";

import { parseAgentAccessMode, type AgentAccessMode } from "../agent/agent-access-mode.js";
import type { ClientLocationWire } from "../types/client-location.js";
import type { RuntimeFacade } from "../runtime/runtime-facade.js";
import { formatScheduleToolResultForUser } from "../tools/schedule-user-reply.js";
import { getToolResultProcessor } from "./tool-result-processor.js";
import { stripMarkersToPlainText } from "./reply-envelope.js";
import { dedupeAdjacentLines, normalizeDashTypos } from "../utils/text.js";
import { isApologyStyleFallback } from "../external-model/fallback-texts.js";

export type ChatTurnInput = {
  text: string;
  messageId?: string;
  userId?: string;
  agentAccessMode?: AgentAccessMode;
  /** 与 App 一致：记忆、工具、Master Agent、人设 */
  preferFullPipeline?: boolean;
  clientLocation?: ClientLocationWire;
  /**
   * 渠道渲染能力（链路统一的出口协商）：rich=保留卡片标记由 App 渲染；
   * plain=富管线出卡后在出口降级为纯文本（微信桥等）。默认 plain（历史行为）。
   */
  capability?: "rich" | "plain";
};

export type ChatTurnResult = {
  ok: true;
  finalText: string;
  messageId: string;
  /** 可选：TTS 合成的音频数据（用于微信桥接等需要推送语音的场景） */
  ttsAudio?: { format: string; base64: string } | null;
  /** 可选：标记此回复是否为提醒类（用于微信端特殊渲染） */
  reminderType?: "popup" | "tts_alarm" | "phone_call" | null;
};

export type ChatTurnError = {
  ok: false;
  message: string;
};

/**
 * 与 WebSocket `chat.user_message` 共用 AgentCore 路径（工具、记忆、Master Agent、人设），
 * 供微信消息桥等无 WS 客户端调用。
 */

/** 将工具执行结果转为可读文本 */
function stringifyToolResult(result: Record<string, unknown>): string {
  if (!result) return "";

  // 字符串直接返回
  if (typeof result === "string") return result;

  // 带 items 数组的搜索/列表类结果
  if (Array.isArray(result.items)) {
    return (result.items as unknown[])
      .map((item) => {
        if (!item || typeof item !== "object") return String(item ?? "");
        const obj = item as Record<string, unknown>;
        return [obj.title, obj.snippet, obj.content, obj.summary, obj.description]
          .filter((v): v is string => typeof v === "string")
          .join("\n");
      })
      .filter(Boolean)
      .join("\n\n");
  }

  // 带 content / summary 字段
  if (typeof result.content === "string") return result.content;
  if (typeof result.summary === "string") return result.summary;

  for (const field of ["text", "body", "description", "snippet"] as const) {
    if (typeof result[field] === "string") return result[field];
  }

  try {
    return JSON.stringify(result, null, 2);
  } catch {
    return String(result);
  }
}
export async function runChatTurnForActor(
  runtime: RuntimeFacade,
  actorId: string,
  input: ChatTurnInput,
): Promise<ChatTurnResult | ChatTurnError> {
  const text = input.text.trim();
  if (!text) {
    return { ok: false, message: "消息内容为空" };
  }

  const messageId = input.messageId?.trim() || `wechat-bridge-${randomUUID()}`;
  const userId = input.userId?.trim() || actorId;
  const agentAccessMode = parseAgentAccessMode(input.agentAccessMode);

  try {
    const reply = await runtime.handleUserMessage(actorId, text, {
      chatUserMessageId: messageId,
      userId,
      agentAccessMode,
      preferFullPipeline: input.preferFullPipeline ?? true,
      clientLocation: input.clientLocation,
    });

    let toolResult: { ok: boolean; result?: Record<string, unknown> } | undefined;
    if (reply.toolName && reply.toolInput) {
      toolResult = reply.toolResult
        ? { ok: true, result: reply.toolResult }
        : await runtime.runToolIfNeeded(actorId, reply, {
            chatUserMessageId: messageId,
            userId,
            agentAccessMode,
          });
    }

    const scheduleOutcome =
      reply.toolName && toolResult?.result
        ? formatScheduleToolResultForUser(reply.toolName, toolResult.result)
        : null;

    /** 非调度类工具的结果文本：当 Provider 不支持内联 tool loop 时，
     *  LLM 仅输出过程描述（如"正在搜索…"），实际内容在 toolResult 中 */
    const rawToolResultText =
      reply.toolName && toolResult?.ok && toolResult.result && !scheduleOutcome
        ? stringifyToolResult(toolResult.result)
        : "";

    let finalText: string;
    if (rawToolResultText) {
      // 源头修复：LLM 在主循环里已经看过工具结果并把结论整合进 reply.text，
      // 这里再把工具原文拼到回复后面，就会出现"网上没查到 + 搜索结果没查到"这种
      // 主题一致但字面不完全重合的重复段落。前 40 字 includes 判定太弱，会漏掉。
      // 改为：LLM 已给出非 apology 真实回复 → 只用 reply.text；只有 LLM 回复为空
      // 或为 apology 时才用工具结果兜底，避免从源头产出重复内容。
      const processText = reply.text.trim();
      const llmAnswered =
        processText.length > 0 && !isApologyStyleFallback(processText);
      if (llmAnswered) {
        finalText = processText;
      } else {
        finalText = rawToolResultText;
      }
    } else {
      // 不再用 apology 兜底文案：空回复时返回空串，让 UI 不显示虚假内容。
      // agent-core 已在 finishLlmTurn 中尝试过 emergencyRegenerate。
      finalText =
        scheduleOutcome?.trim() ||
        reply.text.trim() ||
        "";
    }

    // 折叠相邻的重复行（同 WS 路径）：避免 LLM 把工具前导与最终回复写成同一句。
    finalText = dedupeAdjacentLines(finalText);

    // 链路统一（根因修正）：不再与 WS 主链路各跑一套。这里跑同一条富管线
    // （L1 工具绑定 / L2 模型声明卡 / L3 规则路由，含模型卡片块校验），
    // 纯文本渠道在出口用 stripMarkersToPlainText 降级序列化——
    // "决策一次，按渠道能力编码"，替代旧的 plainTextMode 双跑两遍。
    const capability = input.capability ?? "plain";
    finalText = getToolResultProcessor().processAssistantText(finalText, {
      userText: text,
      toolName: reply.toolName,
      toolResult:
        toolResult?.ok && toolResult.result
          ? (toolResult.result as Record<string, unknown>)
          : undefined,
    });
    if (capability === "plain") {
      finalText = stripMarkersToPlainText(finalText);
      finalText = normalizeDashTypos(finalText);
      finalText = dedupeAdjacentLines(finalText);
      finalText = getToolResultProcessor().processAssistantText(finalText, {
        plainTextMode: true,
        userText: text,
      });
    }

    return { ok: true, finalText, messageId };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[chat-turn-runner] failed:", err);
    return { ok: false, message: msg };
  }
}
