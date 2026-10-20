import OpenAI from "openai";


export type MemoryDecision = "remember" | "reject" | "overwrite" | "decay";

export type MemorySemanticClass =
  | "stable_preference"
  | "stable_identity"
  | "stable_constraint"
  | "mutable_fact"
  | "commitment_or_todo"
  | "temporary_context"
  | "small_talk"
  | "low_signal_noise";

export type MemoryDecisionResult = {
  decision: MemoryDecision;
  confidence: number;
  semanticClass: MemorySemanticClass;
  reasons: string[];
  /**
   * 连续重要性分（0-1）：由 decision 基线 + confidence 微调推导，落库进
   * metadata.importance，供检索加权与 TTL 豁免（补齐"只有布尔 highSignal"的缺口）。
   */
  importance: number;
};

export type MemoryDecisionContext = {
  actorId?: string;
  source?: string;
  userText?: string;
  assistantText?: string;
  heuristicHint?: MemoryDecision;
};

const SMALL_TALK_RE =
  /^(好|好的|嗯|哦|哈|哈哈|收到|知道了|行|可以|ok|okay|thanks|thank you|早安|晚安|拜拜|在吗|好的收到)[!！。.\s]*$/i;
const STABLE_PREFERENCE_RE =
  /喜欢|不喜欢|讨厌|偏好|习惯|总是|从不|口味|风格|常用|倾向|prefer|favorite/i;
const STABLE_IDENTITY_RE =
  /生日|纪念日|住在|学校|公司|职业|工作是|家人|宠物|名字|身份|城市|地址/i;
const STABLE_CONSTRAINT_RE =
  /禁忌|不要|别|不能|避免|忌口|过敏|敏感|必须|务必|长期|固定|默认/i;
const MUTABLE_FACT_RE =
  /现在|以后|改成|更新|不再|从今天起|最新|改为|变成|目前|如今|以后都|后续|new|update/i;
const COMMITMENT_RE =
  /承诺|结论|提醒|计划|待办|待办项|记住|记得|别忘|帮我记着|约定|下次|需要跟进/i;
const TEMPORARY_RE =
  /今天|刚刚|刚才|这一轮|这次|临时|稍后|待会|一下|短期|先这样|回头|明天再说|本次|这个会话/i;
const RISK_RE = /密码|授权|转账|删除|注销|风险|诈骗|异常|隐私|敏感/i;

function normalizedLength(text: string): number {
  return text.replace(/\s+/g, "").length;
}

function buildResult(
  decision: MemoryDecision,
  confidence: number,
  semanticClass: MemorySemanticClass,
  reasons: string[],
): MemoryDecisionResult {
  const conf = Math.max(0, Math.min(1, confidence));
  return {
    decision,
    confidence: conf,
    semanticClass,
    reasons: reasons.slice(0, 6),
    importance: deriveImportance(decision, conf),
  };
}

/**
 * decision 基线 + confidence 偏移 → 连续重要性分。
 * 基线：remember=0.75 / overwrite=0.7 / decay=0.3 / reject=0.1；
 * 高置信向上下各偏移最多 ±span（remember 0.98 → ≈0.95，低置信 remember 不顶格）。
 */
function deriveImportance(decision: MemoryDecision, confidence: number): number {
  const base =
    decision === "remember" ? 0.75
    : decision === "overwrite" ? 0.7
    : decision === "decay" ? 0.3
    : 0.1;
  const span = decision === "reject" ? 0.05 : 0.2;
  return Math.max(0, Math.min(1, base + (confidence - 0.5) * span));
}

function classifyHeuristically(text: string, context: MemoryDecisionContext): MemoryDecisionResult {
  const t = text.trim();
  const len = normalizedLength(t);

  if (!t || len < 6) {
    return buildResult("reject", 0.98, "low_signal_noise", ["too_short"]);
  }
  if (SMALL_TALK_RE.test(t)) {
    return buildResult("reject", 0.99, "small_talk", ["small_talk"]);
  }
  if (MUTABLE_FACT_RE.test(t) && (STABLE_PREFERENCE_RE.test(t) || STABLE_IDENTITY_RE.test(t))) {
    return buildResult("overwrite", 0.94, "mutable_fact", ["mutable_fact_update"]);
  }
  if (RISK_RE.test(t) && !TEMPORARY_RE.test(t)) {
    return buildResult("remember", 0.93, "stable_constraint", ["risk_or_sensitive_constraint"]);
  }
  if (STABLE_CONSTRAINT_RE.test(t) && !TEMPORARY_RE.test(t)) {
    return buildResult("remember", 0.91, "stable_constraint", ["long_term_constraint"]);
  }
  if (STABLE_PREFERENCE_RE.test(t) && !TEMPORARY_RE.test(t)) {
    return buildResult("remember", 0.89, "stable_preference", ["stable_preference"]);
  }
  if (STABLE_IDENTITY_RE.test(t) && !TEMPORARY_RE.test(t)) {
    return buildResult("remember", 0.88, "stable_identity", ["stable_identity"]);
  }
  if (COMMITMENT_RE.test(t) && !TEMPORARY_RE.test(t)) {
    return buildResult("remember", 0.84, "commitment_or_todo", ["commitment_or_followup"]);
  }
  if (TEMPORARY_RE.test(t)) {
    return buildResult("decay", 0.86, "temporary_context", ["temporary_context"]);
  }
  if (len < 24) {
    return buildResult("reject", 0.82, "low_signal_noise", ["low_information_density"]);
  }
  if (context.heuristicHint === "remember") {
    return buildResult("remember", 0.68, "commitment_or_todo", ["hinted_by_pipeline"]);
  }
  if (context.heuristicHint === "overwrite") {
    return buildResult("overwrite", 0.68, "mutable_fact", ["hinted_by_pipeline"]);
  }
  return buildResult("decay", 0.66, "temporary_context", ["default_decay"]);
}

function shouldTrustHeuristic(result: MemoryDecisionResult): boolean {
  if (result.decision === "reject" && result.confidence >= 0.96) return true;
  if (result.decision === "overwrite" && result.confidence >= 0.92) return true;
  if (result.decision === "remember" && result.confidence >= 0.9) return true;
  if (result.decision === "decay" && result.confidence >= 0.86) return true;
  return false;
}

async function llmDecision(
  text: string,
  context: MemoryDecisionContext,
  heuristic: MemoryDecisionResult,
): Promise<MemoryDecisionResult | null> {
  // 惰性导入：本模块处于 capability-modules → agentic-memory 的静态链上，
  // 静态引 resolve-provider 会构成 resolve-provider → providers → abstract-chat-provider
  // 的 module-init 循环（2026-09-25 冷启动崩溃），与下方 llm-token-audit 同款处理。
  const { resolvePrimaryLlmClientConfig, bypassChatRequestExtras } = await import(
    "../external-model/resolve-provider.js"
  );
  const llm = resolvePrimaryLlmClientConfig();
  if (!llm) return null;

  try {
    const openai = new OpenAI({ apiKey: llm.apiKey, baseURL: llm.baseURL, maxRetries: 1 });
    // Token 审计：序列化 messages 估算输入规模
    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      {
        role: "system",
        content:
          "Decide whether text should enter durable user memory. Use this taxonomy: stable_preference, stable_identity, stable_constraint, mutable_fact, commitment_or_todo, temporary_context, small_talk, low_signal_noise. Map taxonomy to decisions strictly: stable_preference/stable_identity/stable_constraint/commitment_or_todo => remember; mutable_fact => overwrite; temporary_context => decay; small_talk/low_signal_noise => reject. Favor reject/decay unless the text clearly helps future conversations beyond this session. Return JSON only: {\"decision\":\"remember|reject|overwrite|decay\",\"semanticClass\":\"...\",\"confidence\":0-1,\"reasons\":[...]}",
      },
      {
        role: "user",
        content: JSON.stringify({
          text,
          context,
          heuristic,
          guidance: {
            keep: [
              "stable user preferences",
              "durable identity facts",
              "long-term constraints and risks",
              "commitments requiring future follow-up",
            ],
            reject: [
              "greetings and acknowledgements",
              "low-information chat",
              "single-turn filler",
            ],
            decay: [
              "session-local temporary details",
              "time-bounded plans unless explicitly long-term",
            ],
            overwrite: ["updated preference or fact replacing previous value"],
          },
        }),
      },
    ];
    const auditInputChars = JSON.stringify(messages).length;
    const response = await openai.chat.completions.create({
      model: process.env.AGENT_MEMORY_DECISION_MODEL?.trim() || llm.model || "gpt-4.1-mini",
      temperature: 0,
      response_format: { type: "json_object" },
      messages,
      ...bypassChatRequestExtras(),
    });

    const content = response.choices[0]?.message?.content?.trim();
    if (!content) return null;
    // Token 审计：记忆写决策是每轮可能触发的旁路，量级可观，单独记账
    const { recordLlmUsageByChars } = await import("./llm-token-audit.js");
    recordLlmUsageByChars({
      stage: "memory_write_decision",
      inputChars: auditInputChars,
      outputChars: content.length,
      model: process.env.AGENT_MEMORY_DECISION_MODEL?.trim() || llm.model || "gpt-4.1-mini",
      actorId: context.actorId,
    });
    const parsed = JSON.parse(content) as Partial<MemoryDecisionResult>;
    const decision = parsed.decision;
    const semanticClass = parsed.semanticClass;
    if (
      decision !== "remember" &&
      decision !== "reject" &&
      decision !== "overwrite" &&
      decision !== "decay"
    ) {
      return null;
    }
    const validClass: MemorySemanticClass[] = [
      "stable_preference",
      "stable_identity",
      "stable_constraint",
      "mutable_fact",
      "commitment_or_todo",
      "temporary_context",
      "small_talk",
      "low_signal_noise",
    ];
    if (!semanticClass || !validClass.includes(semanticClass)) {
      return null;
    }
    return buildResult(
      decision,
      typeof parsed.confidence === "number" && Number.isFinite(parsed.confidence)
        ? parsed.confidence
        : 0.5,
      semanticClass,
      Array.isArray(parsed.reasons)
        ? parsed.reasons.filter((item): item is string => typeof item === "string")
        : [],
    );
  } catch {
    return null;
  }
}

function mergeDecision(
  heuristic: MemoryDecisionResult,
  llm: MemoryDecisionResult | null,
): MemoryDecisionResult {
  if (!llm) return heuristic;
  if (shouldTrustHeuristic(heuristic)) return heuristic;
  if (llm.confidence >= 0.75) return llm;
  if (heuristic.decision === llm.decision) {
    return buildResult(
      heuristic.decision,
      Math.max(heuristic.confidence, llm.confidence),
      llm.semanticClass,
      [...heuristic.reasons, ...llm.reasons],
    );
  }
  if (heuristic.decision === "reject" && llm.decision === "remember" && heuristic.confidence >= 0.8) {
    return heuristic;
  }
  if (heuristic.decision === "decay" && llm.decision === "remember" && llm.confidence < 0.85) {
    return heuristic;
  }
  return llm.confidence >= heuristic.confidence ? llm : heuristic;
}

/**
 * 写入决策主入口：启发式先行，置信不足时 LLM 复判融合。
 * opts.allowLlm = false 时只用启发式（供已有 LLM 产物的路径复用，
 * 如低信号摘要后的落库裁决——摘要本身已是 LLM 输出，无需再花一次调用复判）。
 */
export async function decideMemoryWrite(
  text: string,
  context: MemoryDecisionContext = {},
  opts?: { allowLlm?: boolean },
): Promise<MemoryDecisionResult> {
  const heuristic = classifyHeuristically(text, context);
  if (opts?.allowLlm === false) return heuristic;
  const llm = shouldTrustHeuristic(heuristic) ? null : await llmDecision(text, context, heuristic);
  return mergeDecision(heuristic, llm);
}
