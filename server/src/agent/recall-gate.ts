/**
 * 长期记忆召回门控（Recall Gate）—— 记忆架构重构检索层
 *
 * 原则：白天「只写不捞」，长期记忆检索从「每轮默认」改为「触发式」。
 * 未触发时跳过长期记忆检索（省 token + 根治召回串台/幻觉污染）。
 *
 * 2026-10-10 词表判定退役：触发条件不再用正则词表猜语义（原 MEMORY_EXPLICIT_RE /
 * META_CONVERSATION_RECALL_RE / DATE_DEIXIS_RE / PERSONAL_FACT_RE / 窗口内指代
 * 短路——「你叫我什么？」因标点分支缺 ^ 锚被判成追问轮的教训），全部改由 L1
 * 路由 LLM 与意图同体产出的 TurnUnderstanding 承担。「这轮在问什么、指什么」
 * 归模型，本文件只做触发路由表（纯代码、无 IO、无词面判定）。
 *
 * understanding 缺省（路由失败/降级）→ 一律不触发（最小注入）：误注入=串台，
 * 漏注入=少点可选上下文，代价不对称，保守方向明确。
 *
 * 触发表（满足任一）：
 *  1. memory_instruction / recall_intent / reference=earlier_session → memory_cue
 *  2. personal_fact → personal_fact
 *  3. is_follow_up + 会话长于注入窗口 → anaphora_escalation
 *     （短会话内 LLM 从最近轮次即可消解；只有历史被截断后，"那个"才可能指向窗口外）
 *
 * 触发时检索 query 只用用户原文（禁止拼接任务/偏好/openLoops 等加料，
 * 那是召回串台的根因——检索结果永远偏向旧任务簇）。
 * 当天的问题不走长期检索，只扫当日 journal（DailyJournalService.searchToday）。
 */

import type { TurnUnderstanding } from "./task-router.js";

export type RecallGateInput = {
  /** 用户本轮原文（仅空值保护；不再做词面判定） */
  text: string;
  /** 当前 thread 非 system 消息数；< 0 表示未知（关闭指代升级判定） */
  threadMessageCount?: number;
  /** L1 路由产出的本轮语义理解标记（缺省 = 不触发，最小注入） */
  understanding?: TurnUnderstanding;
};

export type RecallGateResult = {
  /** 是否触发长期记忆检索 */
  trigger: boolean;
  reason:
    | "memory_cue" // 记忆指令 / 想衔接更早对话
    | "personal_fact" // 个人事实陈述
    | "anaphora_escalation" // 指代升级：追问轮 + 会话长于窗口，指代可能落在窗口外
    | "off"; // 未触发（默认）
};

/** 读取正整数环境变量；未设置/非法时用默认值 */
function envPositiveInt(name: string, fallback: number): number {
  const v = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

/**
 * 旧「新会话开场判定阈值」已废弃（2026-10-06 治啰嗦 P1）：new_session 触发分支
 * 已删除，AGENT_MEMORY_RECALL_NEW_SESSION_MAX_MSGS 不再读取。保留占位注释防止
 * 误恢复——跨会话衔接的正确入口是恒驻速览（结构化事实）与 brain.recall 按需检索。
 */
const ANAPHORA_ESCALATION_THREAD_MIN = envPositiveInt("AGENT_MEMORY_RECALL_ANAPHORA_MIN_MSGS", 24);

export function shouldRecallLongTerm(input: RecallGateInput): RecallGateResult {
  if (!input.text.trim()) return { trigger: false, reason: "off" };
  const u = input.understanding;
  if (!u) return { trigger: false, reason: "off" };

  if (u.memoryInstruction || u.recallIntent || u.reference === "earlier_session") {
    return { trigger: true, reason: "memory_cue" };
  }

  if (u.personalFact) {
    return { trigger: true, reason: "personal_fact" };
  }

  const count = input.threadMessageCount ?? -1;
  if (u.isFollowUp && count >= ANAPHORA_ESCALATION_THREAD_MIN) {
    return { trigger: true, reason: "anaphora_escalation" };
  }

  return { trigger: false, reason: "off" };
}
