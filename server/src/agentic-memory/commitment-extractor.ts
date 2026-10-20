/**
 * 方案 C 主通道（回退路径）：对话承诺自动提取（LLM）。
 *
 * 统一抽取（unified-extractor）关闭/失败时的独立承诺识别：单次 LLM 调用输出
 * 结构化 JSON。无词表预筛——口语承诺无法穷举，路由判断交给 LLM；
 * 4 字下限为纯卫生闸（挡"好的/哈哈"）。
 *
 * 置信度分级落板由 CommitmentBoard.ingestExtracted 执行（>0.8 直接创建 /
 * 0.5-0.8 待确认 / <0.5 候选池）。本模块只负责「识别」，不负责「裁决」。
 * 无可用 API key 时返回空数组（不阻塞、不报错——显式工具通道不受影响）。
 */

import OpenAI from "openai";

import { getAgenticMemoryLlmModel, resolveOpenAiApiKey } from "./env.js";
import type { ExtractedCommitment } from "./commitment-board.js";
import type { UnifiedLlmClient } from "./unified-extractor.js";

const SYSTEM_PROMPT = [
  "你是承诺识别器。从对话文本中识别「某方对另一方做出的、可兑现的承诺」",
  "（如：我明天把报告发给你 / 用户说我周五前转账 / 供应商说下周交付）。",
  "只输出真正的承诺，排除：意愿表达（我想…）、假设（如果…就…）、已完成的事、纯日程安排。",
  "输出严格 JSON 数组（可为空 []），每个元素：",
  '{"text":"承诺内容（第三人称陈述）","committedBy":"user|agent|third_party",',
  '"deadline":"ISO 8601 时间或 null","confidence":0到1的小数,"evidence":"原文中最能支撑该承诺的片段"}',
  "相对时间（明天/下周三）必须换算为绝对 ISO 时间。无法确定截止时间时 deadline 为 null。",
  "只输出 JSON，不要任何其他文字。",
].join("\n");

interface RawExtracted {
  text?: unknown;
  committedBy?: unknown;
  deadline?: unknown;
  confidence?: unknown;
  evidence?: unknown;
}

function normalizeExtracted(raw: RawExtracted, now: Date): ExtractedCommitment | null {
  const text = typeof raw.text === "string" ? raw.text.trim() : "";
  if (!text || text.length < 4) return null;

  const committedBy =
    raw.committedBy === "user" || raw.committedBy === "agent" || raw.committedBy === "third_party"
      ? raw.committedBy
      : null;
  if (!committedBy) return null;

  let deadline: string | null = null;
  if (typeof raw.deadline === "string" && raw.deadline.trim() && !/^null$/i.test(raw.deadline.trim())) {
    const ts = Date.parse(raw.deadline);
    if (Number.isFinite(ts)) deadline = new Date(ts).toISOString();
  }

  const confidenceRaw = Number(raw.confidence);
  const confidence = Number.isFinite(confidenceRaw)
    ? Math.max(0, Math.min(1, confidenceRaw))
    : 0;

  const evidence = typeof raw.evidence === "string" ? raw.evidence.trim() : "";
  if (!evidence) return null; // 用户约束：自动提取必须带证据

  void now;
  return { text, committedBy, deadline, confidence, evidence };
}

/** 从 LLM 输出中剥出 JSON 数组（容忍 ```json 围栏与前后杂文） */
function parseJsonArray(output: string): RawExtracted[] {
  const fenced = output.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1]! : output;
  const start = body.indexOf("[");
  const end = body.lastIndexOf("]");
  if (start === -1 || end === -1 || end <= start) return [];
  try {
    const parsed = JSON.parse(body.slice(start, end + 1));
    return Array.isArray(parsed) ? (parsed as RawExtracted[]) : [];
  } catch {
    return [];
  }
}

/**
 * 从文本中提取承诺。任何失败（无 key / LLM 错误 / 输出不可解析）都返回空数组，
 * 不向上抛错——承诺提取是记忆写入的旁路增益，不能影响主链路。
 */
export async function extractCommitments(
  text: string,
  opts?: { now?: Date; model?: string; client?: UnifiedLlmClient; actorId?: string; sessionId?: string },
): Promise<ExtractedCommitment[]> {
  const body = text.trim();
  if (!body || body.length < 4) return [];

  const apiKey = resolveOpenAiApiKey();
  if (!apiKey && !opts?.client) return [];

  try {
    const openai = opts?.client ?? new OpenAI({ apiKey, maxRetries: 1 });
    const now = opts?.now ?? new Date();
    const response = await openai.chat.completions.create({
      model: opts?.model ?? getAgenticMemoryLlmModel(),
      temperature: 0,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: `当前时间：${now.toISOString()}\n\n对话文本：\n${body.slice(0, 8000)}`,
        },
      ],
    });
    const output = response.choices?.[0]?.message?.content?.trim() ?? "";
    if (!output) return [];

    const { recordLlmUsageByChars } = await import("../services/llm-token-audit.js");
    recordLlmUsageByChars({
      stage: "commitment_extract",
      inputChars: body.length,
      outputChars: output.length,
      model: opts?.model ?? getAgenticMemoryLlmModel(),
      actorId: opts?.actorId,
      sessionId: opts?.sessionId,
    });

    return parseJsonArray(output)
      .map((raw) => normalizeExtracted(raw, now))
      .filter((item): item is ExtractedCommitment => item !== null);
  } catch (err) {
    console.warn(
      "[commitment-extractor] LLM 识别失败（返回空）:",
      err instanceof Error ? err.message : err,
    );
    return [];
  }
}
