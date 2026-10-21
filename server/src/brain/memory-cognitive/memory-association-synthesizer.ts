/**
 * 记忆联想合成器（Memory Association Synthesizer）
 *
 * 增强记忆联想性：对一次召回的多段记忆（≥2 条）用 LLM 即时合成"跨记忆的新关联"。
 *
 * 背景：现有联想图谱 spread 只在已存的 MemoryEdge 上做图扩散（不调 LLM），
 * 推理引擎 inferFromClues 用 RegExp+模板生成结论（LLM 仅参与"学规则"）。
 * 两者都无法即时发现"多段记忆之间的隐含关联"。本模块补上这一层：
 *
 * - 输入：召回的前 N 条记忆（content + score）+ 当前 query
 * - 输出：LLM 生成的跨记忆关联结论（严格 JSON，含 confidence 与 reasoning）
 * - 消费：MemoryCortex.recall 命中 ≥2 条时异步触发；高置信结论回灌 humanLike
 *   记忆图（作为 associated 知识节点），后续轮次可被召回——形成"联想闭环"。
 *
 * 安全约束：
 * - LLM 只负责生成"候选关联"，回灌前必须 confidence ≥ minConfidence（默认 0.65）；
 * - 结论以「联想推测」身份入库（metadata.associated=true），与确证事实区分；
 * - 任何异常返回 null，调用方静默降级，不阻塞 recall 主链路。
 */

import OpenAI from "openai";

import { resolvePrimaryLlmClientConfig, bypassChatRequestExtras } from "../../external-model/resolve-provider.js";
import { getModelForTask, TaskTier } from "../../config/model-routing.js";
import { auditChatCompletion } from "../../services/llm-token-audit.js";

export interface MemoryAssociation {
  conclusion: string;
  confidence: number;
  reasoning: string;
}

export interface AssociationSynthesizerConfig {
  enabled: boolean;
  model: string;
  /** 回灌 humanLike 的置信度阈值（低于此值只记录不入库）。 */
  minConfidence: number;
  /** 每次最多分析的记忆条数。 */
  maxItems: number;
  maxTokens: number;
}

export function loadAssociationSynthesizerConfig(): AssociationSynthesizerConfig {
  const enabledRaw = process.env.MEMORY_ASSOCIATION_ENABLED;
  return {
    enabled:
      enabledRaw === undefined ? true : !(enabledRaw === "0" || enabledRaw.toLowerCase() === "false"),
    // 默认走 MINI 档（跟随主模型，MODEL_MINI env 可统一切小模型）
    model:
      process.env.MEMORY_ASSOCIATION_MODEL?.trim() ||
      getModelForTask(TaskTier.MINI) ||
      resolvePrimaryLlmClientConfig()?.model ||
      "gpt-4.1-mini",
    minConfidence: parseFloatEnv(process.env.MEMORY_ASSOCIATION_MIN_CONFIDENCE, 0.65),
    maxItems: parseIntEnv(process.env.MEMORY_ASSOCIATION_MAX_ITEMS, 5),
    maxTokens: parseIntEnv(process.env.MEMORY_ASSOCIATION_MAX_TOKENS, 500),
  };
}

function parseFloatEnv(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = parseFloat(raw);
  return Number.isFinite(n) ? n : fallback;
}

function parseIntEnv(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

/** 解析 LLM 输出的 JSON（容忍代码块围栏与多余文本）。 */
export function parseAssociationsFromLlmOutput(output: string): MemoryAssociation[] {
  if (!output) return [];
  const cleaned = output.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  if (!cleaned) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    // 尝试截取第一个 {...} 块
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start < 0 || end <= start) return [];
    try {
      parsed = JSON.parse(cleaned.slice(start, end + 1));
    } catch {
      return [];
    }
  }

  if (!parsed || typeof parsed !== "object") return [];
  const rawList = (parsed as { associations?: unknown }).associations;
  if (!Array.isArray(rawList)) return [];

  const seen: string[] = [];
  const result: MemoryAssociation[] = [];
  for (const raw of rawList) {
    if (!raw || typeof raw !== "object") continue;
    const o = raw as Record<string, unknown>;
    const conclusion = typeof o.conclusion === "string" ? o.conclusion.trim() : "";
    if (!conclusion || conclusion.length < 6) continue;
    const confidence = clamp01(typeof o.confidence === "number" ? o.confidence : 0.5);
    const reasoning = typeof o.reasoning === "string" ? o.reasoning.trim() : "";
    const key = conclusion.slice(0, 40);
    // 前缀重叠去重：LLM 常输出"同一结论不同结尾"的近似重复，按前缀判重
    if (seen.some((existing) => key.startsWith(existing) || existing.startsWith(key))) continue;
    seen.push(key);
    result.push({ conclusion, confidence, reasoning });
  }
  return result;
}

function buildAssociationMessages(
  items: Array<{ content: string; score?: number }>,
  query: string,
  maxItems: number,
): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  const memoryLines = items
    .slice(0, maxItems)
    .map((it, idx) => {
      const score = typeof it.score === "number" ? ` (相关度 ${(it.score * 100).toFixed(0)}%)` : "";
      return `${idx + 1}. ${it.content}${score}`;
    })
    .join("\n");

  const system = [
    "你是记忆联想推理器。给定一批用户的历史记忆片段和当前查询，找出它们之间尚未明说的隐含关联。",
    "",
    "要求：",
    "1. 只基于给定的记忆片段与查询推理，不要编造记忆中没有的依据；",
    "2. 关联必须是“有用的新认知”（如因果、冲突、时间线衔接、偏好与行为的联系），不要复述记忆原文；",
    "3. 若记忆间没有明显关联，输出空数组 associations: []，不要强行编造；",
    "4. 每条关联给出 conclusion（一句话结论）、confidence（0-1 的把握度）、reasoning（推理依据，引用记忆片段编号）；",
    "5. 只输出严格 JSON：{\"associations\":[{\"conclusion\":\"...\",\"confidence\":0.7,\"reasoning\":\"...\"}]}",
    "6. 最多输出 3 条关联。",
  ].join("\n");
  const user = [
    "当前查询：",
    query,
    "",
    "召回的记忆片段：",
    memoryLines || "（无）",
    "",
    "请输出跨记忆关联 JSON：",
  ].join("\n");

  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

/**
 * 基于 LLM 的记忆联想合成器。
 * 无 API key 时 create 返回 null（调用方跳过，静默降级）。
 */
export class MemoryAssociationSynthesizer {
  private client: OpenAI;
  private config: AssociationSynthesizerConfig;

  constructor(config: AssociationSynthesizerConfig, apiKey: string, baseURL?: string) {
    this.config = config;
    this.client = new OpenAI(
      baseURL?.trim() ? { apiKey, baseURL: baseURL.trim(), maxRetries: 1 } : { apiKey, maxRetries: 1 },
    );
  }

  get enabled(): boolean {
    return this.config.enabled;
  }

  /**
   * 对召回记忆合成跨记忆关联。
   * @returns 高置信（≥ minConfidence）的关联结论列表；失败/无关联返回空数组。
   */
  async synthesize(
    items: Array<{ content: string; score?: number }>,
    query: string,
  ): Promise<MemoryAssociation[]> {
    if (!this.config.enabled || items.length < 2) return [];
    try {
        const assocMessages = buildAssociationMessages(items, query, this.config.maxItems);
        const response = await this.client.chat.completions.create({
          model: this.config.model,
          temperature: 0.3,
          max_tokens: this.config.maxTokens,
          messages: assocMessages,
          ...bypassChatRequestExtras(),
        });
        auditChatCompletion({
          stage: "memory_association",
          messages: assocMessages,
          completion: response,
          model: this.config.model,
        });
        const content = response.choices[0]?.message?.content?.trim();
      if (!content) return [];
      return parseAssociationsFromLlmOutput(content).filter(
        (a) => a.confidence >= this.config.minConfidence,
      );
    } catch (err) {
      console.warn(
        `[AssociationSynthesizer] LLM 联想合成失败（降级跳过）: ${err instanceof Error ? err.message : err}`,
      );
      return [];
    }
  }
}

/** 工厂：无 API key 时返回 null。 */
export function createMemoryAssociationSynthesizer(
  apiKey?: string,
): MemoryAssociationSynthesizer | null {
  const llm = resolvePrimaryLlmClientConfig();
  const key = apiKey?.trim() || llm?.apiKey?.trim() || process.env.OPENAI_API_KEY?.trim();
  if (!key) return null;
  return new MemoryAssociationSynthesizer(
    loadAssociationSynthesizerConfig(),
    key,
    llm?.baseURL?.trim() || process.env.OPENAI_BASE_URL?.trim(),
  );
}
