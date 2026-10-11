/**
 * L1 语义意图分类 + L2 路由决策（2026-09-05 前后台架构，根源化收敛）。
 *
 * 契约（classify-then-route，2026-09-07 前置路由门）：
 *   L1 结构化意图分类器（一次小模型调用）：只输出封闭标签集内的
 *      {"intent","confidence"} JSON，并顺带产出情绪/话题辅助分析
 *      （与 MoodInferenceService 的每轮独立分析调用合并，省一次调用）。
 *   L2 路由决策层（纯代码）：意图→执行计划查 intent-router 路由表。
 *   本函数是**每轮必跑的前置门**：「要不要办事」由这里语义判定，plane=task 的
 *   派发触发由程序层（agent-core）确定性执行——不再依赖前台模型自觉调
 *   task.dispatch（2026-09-06 前台自决模式的失败模式：模型收到工具却推脱，
 *   出口词表闸永远慢一步）。
 *
 * 已删除（2026-09-05 前后台架构收敛）：
 *   - L0 高精度闲聊短路 / L0.5 显式写动作词法安全网：词表是打地鼠的根源。
 *   - 低置信 fail-safe（confidence<0.55 强转任务面）：误判代价对称
 *     （task 面误判=多派一次后台，chat 面误判=出口自检重跑），无需 conservatism。
 *
 * 工程约束：
 *   - L1 调用走结构化契约（2026-10-07 契约化重构）：prompt 组装与 JSON 解析在
 *     route-llm-call，参数/超时/json mode 按路由 provider 能力档案自适应，
 *     网关式重试（超时/坏输出原参重试、异常去参重试）在 structured-call——
 *     本文件收敛为纯编排：缓存 → L1 分类 → L2 代码裁决 → 指代消解；
 *   - 失败/超时/不可解析 → 保守降级（高精度闲聊外一律任务面，遗留模式语义）；
 *   - 同 (文本+上下文) 结果缓存 5 分钟：消息批处理重入、agent-core 复用 WS 决策时不重复计费；
 *   - 使用独立路由会话（llm-route:: 前缀），不污染聊天线程上下文。
 */
import type { ExternalChatProvider } from "../external-model/types.js";
import { isHighPrecisionChatText, type RouteDecision } from "./task-router.js";
import { TASK_PLANE_FALLBACK_BUDGET } from "./intent-router.js";
import { composeMediaSearchQuery, composeRealtimeSearchQuery, composeTravelPlanRequest } from "./realtime-search-query.js";
import { classifyIntentByLlm } from "./route-llm-call.js";
import {
  isIntentLabel,
  routePlanForIntent,
  type IntentLabel,
} from "./intent-router.js";

const CACHE_TTL_MS = 5 * 60_000;
const CACHE_MAX = 300;
const ROUTE_SESSION_PREFIX = "llm-route::";

const routeCache = new Map<string, { decision: RouteDecision; at: number }>();

function cacheGet(key: string): RouteDecision | undefined {
  const hit = routeCache.get(key);
  if (!hit) return undefined;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    routeCache.delete(key);
    return undefined;
  }
  return hit.decision;
}

function cacheSet(key: string, decision: RouteDecision): void {
  if (routeCache.size >= CACHE_MAX) {
    const oldest = routeCache.keys().next().value;
    if (oldest !== undefined) routeCache.delete(oldest);
  }
  routeCache.set(key, { decision, at: Date.now() });
}

function chatDecision(reason: string): RouteDecision {
  return {
    reasons: [reason],
    segmentable: true,
    intent: "chat",
    confidence: 0.9,
    plane: "chat",
    capabilities: [],
    budget: 0,
    tier: "flash",
  };
}


/** 提取路由 JSON 里的 search_query（realtime_lookup 专用；缺省返回 undefined）。导出供回归测试。 */
export function extractRouteSearchQuery(raw: string | undefined | null): string | undefined {
  if (!raw) return undefined;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  try {
    const obj = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
    const q = typeof obj.search_query === "string" ? obj.search_query.trim() : "";
    // 对齐主流 agent（2026-09-13）：查询词全量透传，不设代码截断层——长度质量
    // 由模型自决（训练对齐）+ 搜索后端自限（超限由引擎报错/自行处理）承担，
    // 与 ChatGPT/Claude 的 web_search 同构；代码静默切半句反而破坏查询语义。
    return q || undefined;
  } catch {
    return undefined;
  }
}

/* ── 保守降级 ──
 * 路由失败时的兜底：高精度闲聊外一律任务面（无话题词表——保守原则本身就是兜底）。
 * 前置门语义下错放任务面只是慢一点，错放对话面=零工具静默失败，两者不对称。
 */
function conservativeFallback(text: string, reason: string): RouteDecision {
  if (isHighPrecisionChatText(text)) {
    return chatDecision(`${reason}:high_precision_chat`);
  }
  return {
    reasons: [`${reason}:conservative_task_plane`],
    segmentable: false,
    plane: "task",
    capabilities: ["full"],
    budget: TASK_PLANE_FALLBACK_BUDGET,
    tier: "flash",
  };
}

/**
 * 解析路由输出里顺带携带的情绪/话题辅助分析（缺省/解析失败返回 undefined，
 * 消费方回退独立情绪分析调用）。与意图 JSON 同体输出，省一次每轮 LLM 调用。
 */
function parseAuxAnalysis(
  raw: string | undefined | null,
): RouteDecision["auxAnalysis"] | undefined {
  if (!raw) return undefined;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  try {
    const obj = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
    const score = Number(obj.sentiment);
    if (!Number.isFinite(score)) return undefined;
    const tags = Array.isArray(obj.tags)
      ? obj.tags.map((t) => String(t)).filter(Boolean).slice(0, 3)
      : [];
    const topics = Array.isArray(obj.topics)
      ? obj.topics.map((t) => String(t).trim()).filter(Boolean).slice(0, 3)
      : [];
    return {
      sentimentScore: Math.max(-1, Math.min(1, score)),
      emotionTags: tags,
      topics,
    };
  } catch {
    return undefined;
  }
}

/**
 * 三层路由唯一权威入口。任何异常都不抛出——最坏情况保守降级为任务面。
 *
 * @param activeTasksSummary 当前会话后台活跃任务摘要（TaskHub 提供），
 *        让路由器把"怎么样了/改成明天"这类消息按任务话题分类。
 * @param entityContextLines 代码侧指代消解语料（2026-09-13）：记忆档案/profile
 *        行 + 全角色最近线程消息。只供 realtime 轮 search_query 的实体频次
 *        统计（composeRealtimeSearchQuery）使用，不进任何 prompt；因此取数
 *        窗口可以比 recentUserTurns 宽得多。参与路由缓存键（消解结果随语料变化）。
 */
export async function routeTurnByLlm(
  externalChat: ExternalChatProvider | null,
  sessionId: string,
  text: string,
  recentUserTurns: string[] = [],
  activeTasksSummary?: string,
  entityContextLines: string[] = [],
): Promise<RouteDecision> {
  const trimmed = text.trim();
  if (!trimmed) {
    return {
      reasons: ["llm_route:empty_text"],
      segmentable: true,
      intent: "chat",
      confidence: 1,
      plane: "chat",
      capabilities: [],
      budget: 0,
      tier: "flash",
    };
  }
  const key = JSON.stringify([trimmed, recentUserTurns, entityContextLines]);
  const hit = cacheGet(key);
  if (hit) return hit;

  if (!externalChat?.isEnabled()) {
    const decision = conservativeFallback(trimmed, "llm_route_fallback:provider_disabled");
    cacheSet(key, decision);
    return decision;
  }

  // ── L1 语义分类（结构化契约，2026-10-07 契约化重构）──
  // prompt 组装/intent JSON 解析/aux 情绪分析在 route-llm-call；预算/超时/
  // json mode 按路由 provider 能力档案自适应，超时竞速与网关式重试（超时/
  // 坏输出原参重试、异常去参重试）在 structured-call——本层只消费结果，
  // 换路由模型时调用行为随档案自适应，此处零改动。
  const call = await classifyIntentByLlm(
    externalChat,
    `${ROUTE_SESSION_PREFIX}${sessionId}`,
    trimmed,
    recentUserTurns,
    activeTasksSummary,
  );
  if (!call.ok) {
    // 失败结果不缓存：provider 恢复后下一轮立即回到语义路由。
    console.warn(
      `[LlmTaskRouter] L1 分类失败（${call.reason}，attempts=${call.attempts}），保守降级任务面`,
    );
    return conservativeFallback(
      trimmed,
      call.reason === "unparseable"
        ? "llm_route_fallback:unparseable_output"
        : "llm_route_fallback:call_failed",
    );
  }

  const parsed = call.intent;
  const auxAnalysis = call.auxAnalysis;
  const understanding = call.understanding;
  const result = call.raw;
  if (!isIntentLabel(parsed.intent)) {
    const decision = conservativeFallback(trimmed, "llm_route_fallback:invalid_intent");
    cacheSet(key, decision);
    return decision;
  }

  // ── L2 路由决策层（纯代码裁决）──
  const plan = routePlanForIntent(parsed.intent);
  const reasons: string[] = [
    `llm_intent:${parsed.intent}@${parsed.confidence.toFixed(2)}`,
    `route_table:${plan.plane}/${plan.capabilities.join("+") || "none"}/b${plan.budget}/${plan.tier}`,
  ];

  const plane = plan.plane;
  const capabilities = [...plan.capabilities];
  const budget = plan.budget;
  const tier = plan.tier;

  // realtime 轮搜索词的结构性保证（2026-09-13 根修）：模型输出的 search_query
  // 只是首选来源，且**必须过代码消解**——真实测试（「她最近在那」轮）发现模型
  // 会输出「我老婆 最近 在哪」这类代词查询词（合规但没消解指代，搜索引擎拿
  // 代词只能召回无关结果）。composeRealtimeSearchQuery 对查询词做停用词剥离：
  // 有实体原样保留；纯代词/角色词则从最近对话回溯实体强制并入；模型缺省时从
  // 用户原话构造。「判 realtime → 查询词必含实体 → agent-core 必先真搜」
  // 全程代码保证，不依赖模型自觉。
  let searchQuery = extractRouteSearchQuery(result);
  let querySource: "model" | "model+entity_merge" | "fallback_composed" = searchQuery
    ? "model"
    : "fallback_composed";
  if (parsed.intent === "realtime_lookup") {
    const base = searchQuery ?? trimmed;
    const composed = composeRealtimeSearchQuery(base, [
      ...recentUserTurns,
      ...entityContextLines,
    ]);
    if (composed && composed !== base) {
      reasons.push("search_query:entity_resolved_by_code");
      if (searchQuery) querySource = "model+entity_merge";
    }
    searchQuery = composed || undefined;
    // 可观测性（2026-09-13）：查询词来源可见，兜底失手才能被监控与回归
    console.info(
      `[LlmTaskRouter] realtime search_query (${querySource}): "${searchQuery}"`,
    );
  }
  // media 轮查询词的结构性保证（2026-10-10，与 realtime 同构的根治半边）：
  // 此前 media_retrieval 只贴标签不产查询词，「要不要搜图/怎么拼查询词」全交给
  // flash 档模型现场决定 → 同一句话时而出图时而零工具直答（真实事故：马尔代夫
  // 搜图轮 03:05 出图 / 03:07 凭想象列文字清单）。现在代码剥命令词构造查询词，
  // agent-core 拿它确定性预执行媒体搜索——「判 media → 查询词必非空 → 必真搜」
  // 全程代码保证，与 realtime 的「必先搜」完全对称。
  if (parsed.intent === "media_retrieval") {
    const base = searchQuery ?? trimmed;
    searchQuery = composeMediaSearchQuery(base, [
      ...recentUserTurns,
      ...entityContextLines,
    ]);
    reasons.push("media_query:composed_by_code");
    console.info(`[LlmTaskRouter] media search_query: "${searchQuery}"`);
  }
  // travel 轮调用参数的结构性保证（2026-10-10 P1，与 media 同构）：判出
  // travel_planning 后，「用什么参数调 travel.plan-itinerary」由代码构造
  // （目的地/天数确定性抽取，input 恒为用户原话），agent-core 据此在工具循环
  // 开场确定性预执行——「判规划 → 必先出草案」不经过模型自觉。目的地抽不出
  // （纯指代轮）时 travelPlanRequest.destination 缺省 → agent-core 不预执行，
  // 回退模型自决 + 域预载可见（出口闸仍兜底）。
  let travelPlanRequest: RouteDecision["travelPlanRequest"];
  if (parsed.intent === "travel_planning") {
    travelPlanRequest = composeTravelPlanRequest(searchQuery || trimmed, [
      ...recentUserTurns,
      ...entityContextLines,
    ]);
    reasons.push("travel_plan_input:composed_by_code");
    console.info(
      `[LlmTaskRouter] travel plan request: dest="${travelPlanRequest.destination ?? "(none)"}" days=${travelPlanRequest.days ?? "?"}`,
    );
  }

  const decision: RouteDecision = {
    reasons,
    segmentable: plane === "chat",
    intent: parsed.intent,
    searchQuery,
    confidence: parsed.confidence,
    plane,
    capabilities,
    budget,
    tier,
    ...(travelPlanRequest ? { travelPlanRequest } : {}),
    ...(understanding ? { understanding } : {}),
    ...(auxAnalysis ? { auxAnalysis } : {}),
  };
  cacheSet(key, decision);
  return decision;
}

export type { IntentLabel };
