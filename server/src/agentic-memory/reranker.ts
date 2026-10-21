/**
 * 召回精排器（Cross-Encoder / LLM Reranker，P1）。
 *
 * 粗排（向量 + RRF 融合）快但不准：embedding 的余弦相似度是「分别编码」，
 * 无法建模 query 与记忆间的细粒度交互（否定词、多条件交叉、话题漂移）。
 * 精排对 (query, candidate) 对做**联合打分**，是检索流水线里性价比最高的
 * 精度提升点——本模块把它插在注入前（MemoryCortex.finalizeRecallItems）。
 *
 * 双档实现（AGENT_MEMORY_RERANKER，默认 off）：
 *   - llm：复用对话 LLM 做 listwise 打分——一次调用给全部候选打 0-1 相关分，
 *     零基建，同时承担「召回后验证」（低分条目由调用方按阈值丢弃）；
 *   - api：专用 rerank 端点（bge-reranker-v2-m3 等，Jina/Cohere 风格
 *     POST {model, query, documents} → {results:[{index, relevance_score}]}）。
 *
 * 降级纪律（与 computeEmbedding 同款）：超时/无 key/解析失败/端点错误一律
 * 返回 null，调用方透传原序——精排是增强，绝不阻塞召回主链路。
 */

import OpenAI from "openai";

import {
  getAgenticMemoryLlmModel,
  getMemoryRerankerApiKey,
  getMemoryRerankerEndpoint,
  getMemoryRerankerMode,
  getMemoryRerankerModel,
  getMemoryRerankerTimeoutMs,
  resolveAgenticMemoryLlmBaseUrl,
  resolveOpenAiApiKey,
  type MemoryRerankerMode,
} from "./env.js";
import { bypassChatRequestExtras } from "../external-model/resolve-provider.js";
import { auditChatCompletion } from "../services/llm-token-audit.js";

/** 单条精排结果：候选下标 → 相关分（0-1） */
export interface RerankScore {
  index: number;
  relevance: number;
}

/** 最小 LLM 客户端外观（与 unified-extractor.UnifiedLlmClient 同形，测试注入 fake） */
export interface RerankLlmClient {
  chat: {
    completions: {
      create(args: {
        model: string;
        temperature: number;
        messages: Array<{ role: string; content: string }>;
      }): Promise<{ choices?: Array<{ message?: { content?: string } }> }>;
    };
  };
}

export interface RerankOptions {
  mode?: MemoryRerankerMode;
  timeoutMs?: number;
  model?: string;
  /** LLM 档客户端（测试注入 fake；生产不传，内部按 key 构造） */
  client?: RerankLlmClient;
}

/** 告警节流：精排降级属预期路径，避免每轮召回刷日志 */
let lastWarnAt = 0;
function warnThrottled(message: string): void {
  const now = Date.now();
  if (now - lastWarnAt < 60_000) return;
  lastWarnAt = now;
  console.warn(message);
}

const SYSTEM_PROMPT = [
  "你是记忆召回相关性评判器。给定用户 Query 与若干编号候选记忆，",
  "对每条候选独立打相关性分（0=完全无关，0.5=沾边，1=直接回答/强相关）。",
  "只输出严格 JSON（不要任何其他文字）：",
  '{"scores":[{"index":1,"score":0.0},{"index":2,"score":0.8},...]}',
  "必须覆盖全部候选，index 与输入编号一致。",
].join("\n");

/** 从 LLM 输出剥 JSON（容忍 ``` 围栏与前后杂文） */
function parseScoresOutput(output: string): Array<{ index: number; score: number }> | null {
  const fenced = output.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1]! : output;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(body.slice(start, end + 1));
  } catch {
    return null;
  }
  const arr = (raw as { scores?: unknown })?.scores;
  if (!Array.isArray(arr)) return null;
  const out: Array<{ index: number; score: number }> = [];
  for (const item of arr) {
    const index = Number((item as { index?: unknown })?.index);
    const score = Number((item as { score?: unknown })?.score);
    if (!Number.isInteger(index) || index < 1 || !Number.isFinite(score)) continue;
    out.push({ index, score: Math.max(0, Math.min(1, score)) });
  }
  return out.length > 0 ? out : null;
}

/** LLM listwise 打分：返回 1-based index → relevance */
async function llmRerankScores(
  query: string,
  texts: string[],
  opts: RerankOptions,
): Promise<RerankScore[] | null> {
  const apiKey = resolveOpenAiApiKey();
  if (!apiKey && !opts.client) return null;
  const listed = texts
    .map((t, i) => `${i + 1}. ${t.length > 200 ? `${t.slice(0, 200)}…` : t}`)
    .join("\n");
  try {
    const client =
      opts.client ??
      new OpenAI({ apiKey, baseURL: resolveAgenticMemoryLlmBaseUrl(), maxRetries: 1 });
    const response = await client.chat.completions.create({
      // llm 档是 chat.completions 调用，默认必须用对话模型（AGENT_AGENTIC_MEMORY_LLM_MODEL
      // → OPENAI_MODEL）；AGENT_MEMORY_RERANKER_MODEL 是 api 档的 rerank 模型名，
      // 传给对话端点会被拒（每次调用都降级）
      model: opts.model ?? getAgenticMemoryLlmModel(),
      temperature: 0,
      // 精排走 800ms 级超时预算：deepseek-flash 默认带思考链，必须显式关掉
      //（deepseek-chat 时代无需表态，bypassChatRequestExtras 按主模型自动判定）
      ...bypassChatRequestExtras(),
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: `Query：${query}\n\n候选记忆：\n${listed}` },
      ],
    });
    auditChatCompletion({
      stage: "memory_rerank",
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: `Query：${query}\n\n候选记忆：\n${listed}` },
      ],
      completion: response,
      model: opts.model ?? getAgenticMemoryLlmModel(),
    });
    const output = response.choices?.[0]?.message?.content?.trim() ?? "";
    if (!output) return null;
    const parsed = parseScoresOutput(output);
    if (!parsed) return null;
    return parsed.map((p) => ({ index: p.index - 1, relevance: p.score }));
  } catch (err) {
    warnThrottled(
      `[memory-reranker] LLM 精排失败（透传原序）: ${err instanceof Error ? err.message : err}`,
    );
    return null;
  }
}

interface ApiRerankResponse {
  results?: Array<{ index?: unknown; relevance_score?: unknown; score?: unknown }>;
}

/** api 档：Jina/Cohere 风格 /rerank 端点 */
async function apiRerankScores(
  query: string,
  texts: string[],
  opts: RerankOptions,
): Promise<RerankScore[] | null> {
  const endpoint = getMemoryRerankerEndpoint();
  if (!endpoint) return null;
  const apiKey = getMemoryRerankerApiKey();
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: opts.model ?? getMemoryRerankerModel(),
        query,
        documents: texts,
        top_n: texts.length,
      }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? getMemoryRerankerTimeoutMs()),
    });
    if (!response.ok) {
      warnThrottled(`[memory-reranker] rerank 端点 ${response.status}（透传原序）`);
      return null;
    }
    const data = (await response.json()) as ApiRerankResponse;
    const results = Array.isArray(data.results) ? data.results : null;
    if (!results || results.length === 0) return null;
    const out: RerankScore[] = [];
    for (const r of results) {
      const index = Number(r.index);
      const relevance = Number(r.relevance_score ?? r.score);
      if (!Number.isInteger(index) || index < 0 || !Number.isFinite(relevance)) continue;
      out.push({ index, relevance: Math.max(0, Math.min(1, relevance)) });
    }
    return out.length > 0 ? out : null;
  } catch (err) {
    warnThrottled(
      `[memory-reranker] rerank 端点失败（透传原序）: ${err instanceof Error ? err.message : err}`,
    );
    return null;
  }
}

/**
 * 精排入口：返回按 relevance 降序的 {index, relevance} 列表，index 为 texts 下标。
 * 任何不可用情形（off/无 key/超时/失败/解析失败）返回 null——调用方透传原序。
 * texts.length < 2 时无需精排，返回单元素恒等结果。
 */
export async function rerankTexts(
  query: string,
  texts: string[],
  opts?: RerankOptions,
): Promise<RerankScore[] | null> {
  const trimmed = query.trim();
  if (!trimmed || texts.length === 0) return null;
  if (texts.length === 1) return [{ index: 0, relevance: 1 }];

  const mode = opts?.mode ?? getMemoryRerankerMode();
  if (mode === "off") return null;
  if (mode === "api" && !getMemoryRerankerEndpoint()) return null;

  const timeoutMs = opts?.timeoutMs ?? getMemoryRerankerTimeoutMs();
  const work =
    mode === "api"
      ? apiRerankScores(trimmed, texts, { ...opts, timeoutMs })
      : llmRerankScores(trimmed, texts, opts ?? {});

  let scored: RerankScore[] | null;
  try {
    scored = await Promise.race([
      work,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
    ]);
  } catch {
    return null;
  }
  if (!scored) return null;

  // 补齐 LLM 漏打的候选（默认低分，由调用方阈值闸决定去留），按 relevance 降序
  const byIndex = new Map(scored.map((s) => [s.index, s.relevance]));
  const complete = texts.map((_, i) => ({ index: i, relevance: byIndex.get(i) ?? 0 }));
  return complete.sort((a, b) => b.relevance - a.relevance);
}
