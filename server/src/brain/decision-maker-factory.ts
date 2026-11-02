// Agent Brain Center — LLM 决策器工厂（可插拔决策器入口）
//
// 职责：把散落在 bootstrap 装配代码中的 LLM 决策器实现集中到此文件，
// 通过工厂函数创建，让"换大脑"时这些决策器也能同步替换或重新配置。
//
// 决策器：
//   1. EndToEndDecisionMaker — 主动开口决策（ProactionCortex 注入）
//   2. DelegateJudge — 任务委派判断（PlannerCortex 注入）
//
// 设计原则：
//   - 工厂返回已有接口类型（EndToEndDecisionMaker / DelegateJudge）
//   - 默认实现与原 bootstrap 内联实现完全等价（向后兼容）
//   - 未来换大脑时可整体替换为 AGI 驱动的决策器实现

import type { EndToEndDecisionMaker } from "./proaction-cortex.js";
import type { DelegateJudge, SubAgentType } from "./planner-cortex.js";
import type { BrainDecisionAction } from "./types.js";
import { createExternalChatProviderFromEnv } from "../external-model/index.js";
import type { ExternalChatProvider } from "../external-model/types.js";

// ============================================================
// EndToEndDecisionMaker 默认实现
// ============================================================

/**
 * 创建默认的端到端主动开口决策器。
 *
 * 行为与原 bootstrap 内联实现完全等价：
 *   - 一次 LLM 完成"要不要说+说什么+要不要顺手做事"
 *   - 支持环境控制动作输出（calendar.create / smart_home.scene）
 *   - LLM 失败 → speak=false 兜底
 */
export function createDefaultEndToEndDecisionMaker(): EndToEndDecisionMaker {
  return {
    async decide(signal, ctx) {
      const memBrief = ctx.recentMemories.map((m) => `- ${m.content}`).join("\n").slice(0, 800) || "（无）";
      const activity = ctx.userActivity ? `用户当前：${ctx.userActivity.activity}` : "用户状态未知";
      const workingCtx = ctx.workingMemoryBrief?.trim()
        ? `\n当前在聊：${ctx.workingMemoryBrief.trim().slice(0, 80)}\n（如果与信号相关可以自然衔接，不相关就别硬扯）`
        : "";
      const recentConv = ctx.recentConversation?.trim()
        ? `\n用户最近实时对话：\n${ctx.recentConversation.trim().slice(0, 600)}\n（关键参考：用户当前在聊什么。如果信号与当前话题无关，不要强行扯回旧话题）`
        : "";
      const prompt =
        `你是主动开口决策器。像真人一样一气呵成判断"要不要说+说什么+要不要顺手做事"。\n\n` +
        `信号：${signal.kind} - ${signal.title}${signal.summary ? `\n摘要：${signal.summary}` : ""}\n` +
        `重要性：${signal.importance ?? "medium"}\n` +
        `价值评分：${ctx.valueScore.toFixed(1)} / 打扰评分：${ctx.disturbScore.toFixed(1)}\n` +
        `用户活动状态：${activity}\n` +
        `最近对话记忆：\n${memBrief}\n` +
        `最近已开口次数：${ctx.recentDecisions.length}${workingCtx}${recentConv}\n\n` +
        `判断是否要主动开口告诉用户这个信号，如果要，给出自然的话术。\n` +
        `注意：如果用户当前正在聊的话题与信号无关，不要强行把话题扯回信号内容。\n` +
        `同时判断是否需要顺手执行环境控制动作（如出行→建日程、深夜→晚安场景）。\n` +
        `可用工具：calendar.create(args:{title,description,runAt?})、smart_home.scene(args:{action:"activate",scene_name})。\n` +
        `只输出 JSON：{"speak": true/false, "message": "话术或空", "reason": "简短理由", "actions": [{"tool":"工具名","args":{...},"reason":"原因"}]}\n` +
        `actions 可为空数组。仅在信号明显匹配工具场景时才填。`;
      let raw = "";
      try {
        const provider = createExternalChatProviderFromEnv();
        if (!provider) throw new Error("no_chat_provider");
        await provider.streamCompletion(
          `e2e-proaction:${signal.actorId}:${Date.now()}`,
          { text: prompt },
          (delta) => { raw += delta; },
          undefined,
          { ephemeralTurn: true, disableThinking: true, maxThreadMessages: 0 },
        );
      } catch (e) {
        return { speak: false, message: "", reason: `llm_failed:${String(e).slice(0, 60)}` };
      }
      const match = raw.match(/\{[\s\S]*\}/);
      if (!match) return { speak: false, message: "", reason: "no_json" };
      try {
        const parsed = JSON.parse(match[0]);
        const actions: BrainDecisionAction[] = [];
        if (Array.isArray(parsed.actions)) {
          for (const a of parsed.actions) {
            if (a && typeof a === "object" && typeof a.tool === "string") {
              actions.push({
                tool: a.tool,
                args: (a.args && typeof a.args === "object") ? a.args as Record<string, unknown> : {},
                reason: typeof a.reason === "string" ? a.reason : "",
              });
            }
          }
        }
        return {
          speak: parsed.speak === true,
          message: typeof parsed.message === "string" ? parsed.message : "",
          reason: typeof parsed.reason === "string" ? parsed.reason : "",
          actions: actions.length > 0 ? actions : undefined,
        };
      } catch {
        return { speak: false, message: "", reason: "parse_failed" };
      }
    },
  };
}

// ============================================================
// DelegateJudge 默认实现
// ============================================================

/**
 * 创建默认的任务委派判断器。
 *
 * 行为与原 bootstrap 内联实现完全等价：
 *   - 边界情况（步骤数>阈值但规则未命中委派关键词）时调 LLM 做语义判断
 *   - LLM 失败 → 抛错（由调用方降级到纯规则 shouldDelegate）
 */
export function createDefaultDelegateJudge(): DelegateJudge {
  return {
    async judge(params) {
      const { userMessage, ruleHint } = params;
      const hint = ruleHint
        ? `\n规则预筛提示：步骤数=${ruleHint.stepCount}，命中关键词=[${ruleHint.matchedKeywords.join(",")}]，白名单命中=${ruleHint.whitelistHit}`
        : "";
      const prompt =
        `你是任务委派判断器。判断用户消息是否需要委派给子 Agent 处理。\n\n` +
        `子 Agent 类型：\n` +
        `  - tech：桌面操作/自动化/RPA/系统配置/浏览器操作\n` +
        `  - info：深度调研/对比/比价/评测/多步搜索整合\n` +
        `  - life：订餐/购物/预订/打车/下单等生活服务\n\n` +
        `用户消息：${userMessage}${hint}\n\n` +
        `判断规则：\n` +
        `  - 简单寒暄/知识问答/查天气/查时间 → delegate=false\n` +
        `  - 单步简单操作 → delegate=false\n` +
        `  - 复杂多步任务/深度调研/桌面自动化/生活服务下单 → delegate=true 并选 agentType\n\n` +
        `只输出 JSON：{"delegate": true/false, "agentType": "tech|info|life或null", "reason": "简短理由", "confidence": 0.0-1.0}`;
      let raw = "";
      try {
        const provider = createExternalChatProviderFromEnv();
        if (!provider) throw new Error("no_chat_provider");
        await provider.streamCompletion(
          `delegate-judge:${params.actorId ?? "default"}:${Date.now()}`,
          { text: prompt },
          (delta) => { raw += delta; },
          undefined,
          { ephemeralTurn: true, disableThinking: true, maxThreadMessages: 0 },
        );
      } catch (e) {
        throw new Error(`delegate_judge_llm_failed:${String(e).slice(0, 60)}`);
      }
      const match = raw.match(/\{[\s\S]*\}/);
      if (!match) throw new Error("delegate_judge_no_json");
      try {
        const parsed = JSON.parse(match[0]);
        const delegate = parsed.delegate === true;
        const agentTypeRaw = typeof parsed.agentType === "string" ? parsed.agentType : "";
        const agentType =
          agentTypeRaw === "tech" || agentTypeRaw === "info" || agentTypeRaw === "life"
            ? (agentTypeRaw as SubAgentType)
            : undefined;
        const confidence = typeof parsed.confidence === "number"
          ? Math.max(0, Math.min(1, parsed.confidence))
          : 0.5;
        return {
          delegate,
          agentType: delegate ? agentType : undefined,
          reason: typeof parsed.reason === "string" ? parsed.reason : "",
          confidence,
        };
      } catch {
        throw new Error("delegate_judge_parse_failed");
      }
    },
  };
}

// ============================================================
// 决策器集合工厂（一次性创建全部决策器）
// ============================================================

/**
 * 决策器集合：EndToEndDecisionMaker + DelegateJudge。
 *
 * bootstrap 调用 createDecisionMakersFromEnv() 一次性获取全部决策器，
 * 未来"换大脑"时可整体替换为 AGI 驱动的决策器实现。
 */
export interface DecisionMakerSet {
  endToEndMaker: EndToEndDecisionMaker;
  delegateJudge: DelegateJudge;
}

/**
 * 创建全部 LLM 决策器集合。
 *
 * 注：TopicExtractor 已于 2026-11-01 整段删除（主题词对回复无必要，
 * 主模型/recap 从短期记忆上下文即可把握话题；实测每轮恒定 2s 超时且空输出）。
 */
export function createDecisionMakersFromEnv(
  _externalChat?: ExternalChatProvider | null,
): DecisionMakerSet {
  return {
    endToEndMaker: createDefaultEndToEndDecisionMaker(),
    delegateJudge: createDefaultDelegateJudge(),
  };
}
