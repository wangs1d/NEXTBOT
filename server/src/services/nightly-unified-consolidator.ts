/**
 * 夜间单遍巩固器（P1，2026-09-12 token 治理）。
 *
 * 夜间管路原本有两次对同一批 journal/summary 的 LLM 全量遍历：
 *   1. extractDurableFacts：整批 journal → 持久事实（episodic → semantic 提升）；
 *   2. scoreLinesWithLlm：整份 memory_summary + 当日行 → 留存评分（remember/fade/forget 依据）。
 * 本模块把两者合并为**一次结构化调用**，产出：
 *   - facts[]：写入事实主库 + KV 槽位（复用 extractFactsFromJournals 的落库逻辑）；
 *   - scores[]：按行指纹种子进 memory-manager 的评分缓存——consolidateNow 的增量
 *     评分命中缓存即 0 次 LLM 调用。
 *
 * 三种模式（env AGENT_MEMORY_NIGHTLY_MODE，默认 shadow）：
 *   - legacy：不运行本模块（纯旧管路，两遍 LLM 照旧）；
 *   - shadow：旧管路照常执行；本通道只计算并落盘对比报告（data/nightly-unified-shadow.json），
 *     不写任何记忆存储——用于切换前的一致性观察（建议 ≥7 天）；
 *   - unified：本通道产物直接采用，上述两处 LLM 调用被跳过；
 *     本通道失败（LLM 异常/解析失败）的 actor 自动回退旧路径。
 */
import OpenAI from "openai";

import { resolvePrimaryLlmClientConfig, bypassChatRequestExtras } from "../external-model/resolve-provider.js";
import { getModelForTask, TaskTier } from "../config/model-routing.js";
import { recordLlmUsageByChars } from "./llm-token-audit.js";

export type NightlyFact = { kind: "preference" | "fact" | "commitment"; text: string };

export type UnifiedNightlyOutcome = {
  actorId: string;
  facts: NightlyFact[];
  /** 行指纹 → 留存分（0-1），供 memory-manager.seedScoreCache 直接种子 */
  scores: Array<{ fp: string; score: number }>;
};

export type NightlyMode = "legacy" | "shadow" | "unified";

export function resolveNightlyMode(): NightlyMode {
  const raw = process.env.AGENT_MEMORY_NIGHTLY_MODE?.trim().toLowerCase();
  if (raw === "legacy" || raw === "shadow" || raw === "unified") return raw;
  return "shadow";
}

const MAX_TRANSCRIPT_CHARS = 10_000;
const MAX_SCORE_LINES = 60;
const MAX_LINE_CHARS = 200;
const MAX_FACTS = 12;

const VALID_KINDS = new Set(["preference", "fact", "commitment"]);

/**
 * 单次 LLM 调用：事实提升 + 新行留存评分一次完成。
 * scoreLines 的 fp 由调用方用与 consolidateNow 评分输入完全一致的行文本计算，
 * 保证种子进缓存后 consolidateNow 的指纹查找精确命中。
 * 任何失败返回 null（调用方回退旧路径）。
 */
export async function runUnifiedNightlyConsolidation(input: {
  actorId: string;
  transcript: string;
  scoreLines: Array<{ fp: string; text: string }>;
}): Promise<UnifiedNightlyOutcome | null> {
  const llm = resolvePrimaryLlmClientConfig();
  if (!llm || !input.transcript) return null;

  const lines = input.scoreLines.slice(-MAX_SCORE_LINES).map((l) => ({
    fp: l.fp,
    text: l.text.slice(0, MAX_LINE_CHARS),
  }));

  const system =
    "你是夜间记忆巩固器，一次完成两项工作。\n" +
    "工作一（facts）：从对话日志中提取「值得跨会话长期记住」的用户信息，忽略闲聊、临时上下文和一次性任务细节。" +
    "preference=稳定偏好/习惯；fact=稳定身份/背景事实；commitment=需要后续跟进的承诺或待办；" +
    "text 用第三人称中文短句（以「用户」开头或无主语短语，禁止以「我/我的」开头——第一人称条目注入 prompt 后会让模型混淆人称视角），最多 12 条。\n" +
    "工作二（scores）：对传入的 lines 逐条打留存分（0-1），衡量该行内容值得长期保留的程度：" +
    "稳定偏好/事实/承诺/风险/行动相关≈0.7-1.0，一般事件≈0.3-0.6，寒暄/临时上下文≈0.0-0.2。\n" +
    '只输出 JSON：{"facts":[{"kind":"preference|fact|commitment","text":"..."}],"scores":[{"id":"L0","score":0.8}]}，' +
    "scores 必须覆盖所有传入的行（id 原样返回）。没有可提取事实时 facts 返回空数组。";

  const user = JSON.stringify({
    transcript: input.transcript.slice(0, MAX_TRANSCRIPT_CHARS),
    lines: lines.map((l, i) => ({ id: `L${i}`, text: l.text })),
  });

  const openai = new OpenAI({ apiKey: llm.apiKey, baseURL: llm.baseURL, maxRetries: 1 });
  const model = process.env.AGENT_MEMORY_NIGHTLY_MODEL?.trim() || getModelForTask(TaskTier.MINI);
  try {
    const response = await openai.chat.completions.create({
      model,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      ...bypassChatRequestExtras(),
    });
    const content = response.choices[0]?.message?.content?.trim();
    if (!content) return null;
    const parsed = JSON.parse(content) as {
      facts?: Array<{ kind?: string; text?: string }>;
      scores?: Array<{ id?: string; score?: number }>;
    };

    const facts: NightlyFact[] = (parsed.facts ?? [])
      .filter(
        (f): f is { kind: string; text: string } =>
          !!f && typeof f.text === "string" && f.text.trim().length > 0 &&
          typeof f.kind === "string" && VALID_KINDS.has(f.kind),
      )
      .slice(0, MAX_FACTS)
      .map((f) => ({ kind: f.kind as NightlyFact["kind"], text: f.text.trim() }));

    const scores: Array<{ fp: string; score: number }> = [];
    const byId = new Map((parsed.scores ?? []).map((s) => [s.id, s.score]));
    lines.forEach((line, i) => {
      const value = byId.get(`L${i}`) ?? (parsed.scores ?? [])[i]?.score;
      if (typeof value === "number" && Number.isFinite(value)) {
        scores.push({ fp: line.fp, score: Math.max(0, Math.min(1, value)) });
      }
    });

    recordLlmUsageByChars({
      stage: "nightly_unified",
      inputChars: system.length + user.length,
      outputChars: content.length,
      model,
      actorId: input.actorId,
    });

    return { actorId: input.actorId, facts, scores };
  } catch (err) {
    console.log(`[nightly-unified] LLM 调用失败（该 actor 回退旧路径）: ${err}`);
    return null;
  }
}
