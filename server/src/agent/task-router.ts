/**
 * 任务路由类型与高精度闲聊短路（2026-09-05 双面架构，根源化收敛）。
 *
 * 设计契约（不再使用话题关键词做路由）：
 *   - "这轮需不需要工具"由 L1 语义意图分类器判定（llm-task-router），
 *     语义理解天然泛化到未出现过的表达（"比特币多少钱"无需价格词表）。
 *   - 本模块只保留两类话题无关的确定性信号：
 *       1) 高精度纯闲聊短路（锚定全文匹配的寒暄/口头禅——这类句子结构上
 *          不可能需要工具，可安全直答零成本）；
 *       2) 降级路径的保守原则（无法语义判定时，除高精度闲聊外一律落任务面——
 *          错放对话面 = 零工具静默失败，错放任务面只是慢一点）。
 *   - 判错的纠错不在路由层，而在执行出口：TurnOutcomeGate（任务面续波）与
 *     对话面误判转任务（agent-core），路由不需要一次判对。
 */

import { TASK_PLANE_FALLBACK_BUDGET, routePlanForIntent } from "./intent-router.js";

/** 执行车道：chat=对话面（直答/前台工具直办）；task=任务面（后台执行）。 */
export type LlmExecutionMode = "chat" | "task";

export type TurnPlane = import("./intent-router.js").TurnPlane;
export type TurnCapability = import("./intent-router.js").TurnCapability;
export type TurnTier = import("./intent-router.js").TurnTier;

/** 本轮话头锚定目标（语义理解，模型判定）。 */
export type TurnReference =
  | "none" // 独立新话题/新请求
  | "prev_assistant" // 承接 agent 上一条回复
  | "prev_user_request" // 回应用户自己上一条请求
  | "earlier_session"; // 明确指向更早的会话/记忆

/**
 * 每轮语义理解标记——原 isAmbiguousFollowUpMessage / SCHEDULE_RECALL_RE /
 * travel 词表等硬编码判定的语义层替代（2026-10-09）。
 * 由 L1 路由 LLM 与意图同体产出；字段缺省一律按 false 处理。
 */
export type TurnUnderstanding = {
  /** 本轮是否为承接上文的短追问/应答（「然后呢」「那个方案呢」「你确定吗」）。 */
  isFollowUp: boolean;
  /** 本轮话头锚定什么。 */
  reference: TurnReference;
  /** 用户显式想衔接/回忆更早的对话或记忆（「上次说的」「之前聊的」）。 */
  recallIntent: boolean;
  /** 用户要求记住或忘掉某信息。 */
  memoryInstruction: boolean;
  /** 用户在陈述关于自己的事实（名字/身份/家人/住所/计划）。 */
  personalFact: boolean;
  /** 本轮在问自己的日程/提醒/安排。 */
  scheduleQuery: boolean;
  /** 本轮在问行程/旅行规划相关。 */
  travelQuery: boolean;
  /**
   * 用户在明确拒绝/取消某类写操作（2026-10-12 真机探针实证：「以后别提醒我
   * 开会的事」被 L1 以 0.92 置信判成 action_write——而出口闸会强迫调工具
   * "完成动作"，有创建垃圾提醒的实际风险）。L2 一致性校验消费：
   * action_write + actionNegation = 自相矛盾 → 降级 chat。
   */
  actionNegation: boolean;
};

export type RouteDecision = {
  reasons: string[];
  /** 是否需要对回复做短句分段（对话面分段，任务面信息性内容不分段）。 */
  segmentable: boolean;
  /** 语义路由识别的意图标签 + 置信度（降级路径可能缺省）。 */
  intent?: import("./intent-router.js").IntentLabel;
  confidence?: number;
  /** 执行平面：chat=对话面零工具直答；task=任务面后台执行。 */
  plane: TurnPlane;
  /** 任务面能力束（对话面为空数组）。 */
  capabilities: TurnCapability[];
  /** 任务面工具波预算（对话面 0）。 */
  budget: number;
  /** 模型档位。 */
  tier: TurnTier;
  /**
   * 每轮语义理解标记（2026-10-09 词表判定退役）：追问锚定/记忆召回/日程/旅行
   * 等语境判定由 L1 路由 LLM 与意图同体产出——「这轮在问什么、指什么」归模型，
   * 代码只按标记执行注入路由表。路由失败/未产出时缺省，消费方一律按
   * 「无特殊处理」（最小注入）执行：误注入=串台，漏注入=少点可选上下文，
   * 代价不对称，保守方向明确。
   */
  understanding?: TurnUnderstanding;
  /**
   * 语义路由顺带产出的轻量情绪/话题分析（与每轮路由 LLM 调用合并，
   * 省掉 MoodInferenceService 的独立每轮调用）。路由超时/降级/未产出时缺省，
   * 消费方（agent-core → mood-inference-service.ingestRouteAux）缺省时回退独立分析。
   */
  auxAnalysis?: {
    sentimentScore: number;
    emotionTags: string[];
    topics: string[];
  };
  /**
   * realtime_lookup 时由路由器生成的完整搜索查询词（结合最近对话解决指代，
   * 如「我老婆最近在那呢」→「刘浩存 最近 行程」）。供前置检索（扣子式
   * search-before-LLM）确定性执行；其他 intent / 路由降级时缺省。
   */
  searchQuery?: string;
  /**
   * travel_planning 时由路由器代码构造的行程请求参数（2026-10-10 P1，与
   * searchQuery/媒体查询词同构的确定性半边）：input 恒为用户原话，
   * destination/days 为代码可抽取的结构化增量。agent-core 据此确定性预执行
   * travel.plan-itinerary；destination 抽不出时不预执行（避免空参必然失败）。
   */
  travelPlanRequest?: import("./realtime-search-query.js").TravelPlanRequest;
};

/**
 * 计划续跑轮的路由决策（2026-10-19 handoff）。
 *
 * 用户点「我已完成，继续下一步」时，这轮**不需要猜意图**：手里有一条没走完的
 * 计划，且刚刚确认完一步，语义上就是「继续执行 multi_step_task」。走确定性
 * 路由比拿按钮文案去问分类器更稳——文案是 UI 文案，以后改一个字就会换平面。
 *
 * 注意：这里只是「平面/预算」的确定性，不决定模型做什么；具体下一步由注入的
 * 【当前任务步骤】块 + 用户回执共同决定。
 */
export function buildPlanContinuationDecision(): RouteDecision {
  return {
    reasons: ["plan_continuation"],
    // 任务面不做聊天气泡分段（与其它任务面轮一致）
    segmentable: false,
    intent: "multi_step_task",
    confidence: 1,
    ...routePlanForIntent("multi_step_task"),
  };
}

/** 由车道派生词法级执行计划（降级路径用）。 */
export function planFieldsForLane(lane: LlmExecutionMode): {  plane: TurnPlane;
  capabilities: TurnCapability[];
  budget: number;
  tier: TurnTier;
} {
  return lane === "task"
    ? {
        plane: "task",
        capabilities: ["full"],
        budget: TASK_PLANE_FALLBACK_BUDGET,
        tier: "flash",
      }
    : { plane: "chat", capabilities: [], budget: 0, tier: "flash" };
}

/* ────────────────────────────────────────────────────────────
 * 前台自决模式（2026-09-05 引入，2026-09-07 退役为「触发权威」）
 *
 * 失败模式已被实证：前台模型收到 task.dispatch/search_web schema 仍口头
 * 推脱（"这条路不通/翻不到"），触发是概率事件，出口词表闸永远慢一步。
 * 2026-09-07 前置路由门：「要不要办事」由 routeTurnByLlm 在主回复之前判定，
 * plane=task 由程序层确定性路由到任务执行器。前台白名单里的 task.dispatch
 * 保留为分类假阴性的安全网（+ 出口诚实闸/闪避闸兜底），不再是唯一触发路径。
 * isForegroundDispatchMode 现仅控制：标签协议灰度与前台人格指引选择。
 * ──────────────────────────────────────────────────────────── */

export function isForegroundDispatchMode(): boolean {
  const raw = process.env.AGENT_FOREGROUND_DISPATCH?.trim().toLowerCase();
  return raw !== "0" && raw !== "off" && raw !== "false";
}

/**
 * 遗留灰度：前台文本标签协议（[dispatch:...]，默认关闭）。
 *
 * 2026-09-06 P0 修复：前台默认回归原生 function calling（task.dispatch +
 * search_web 小工具集常驻，API 结构化 tool_calls 通道）。文本协议的失败模式
 * 是"模型不写标签 = 静默零工具"，无法在协议内修复，故退役为灰度回退项。
 * 设 AGENT_FOREGROUND_TAG_PROTOCOL=1 可回退旧行为（前台零工具 + 标签协议）。
 */
export function isForegroundTagProtocolEnabled(): boolean {
  const raw = process.env.AGENT_FOREGROUND_TAG_PROTOCOL?.trim().toLowerCase();
  return raw === "1" || raw === "on" || raw === "true";
}

/* ────────────────────────────────────────────────────────────
 * 任务面双通道（2026-09-05 前后台架构，先轻后重）
 *
 * 快速通道（默认起步）：跳过 planner，可见工具 = 桥工具（tool_discover/
 * tool_call），一切业务工具由 tool router（BM25 目录）按需召回——执行侧
 * 上下文零业务 schema，Flash 档单点查证直查直答。
 * 完整通道：快速通道产出道歉式/空 → 升级 planner + 预算波 + Pro 档。
 * 判定不在路由层：失败信号是执行结果本身（isApologyStyleFallback），由
 * 派发方（dispatchBackgroundTask）裁决升级。
 * ──────────────────────────────────────────────────────────── */

/** 延迟目录桥（元工具，不算业务工具）：快速通道可见集的构成。 */
export const TASK_TOOL_BRIDGE_NAMES: ReadonlySet<string> = new Set([
  "tool_search",
  "tool_discover",
  "tool_describe",
  "tool_call",
]);

/* ────────────────────────────────────────────────────────────
 * 高精度纯闲聊短路（唯一保留的词法信号）
 *
 * 特征：锚定全文匹配（^...$）、命中即整句就是寒暄/口头禅/应答词——
 * 结构上不可能携带工具诉求，因此可以零 LLM 成本直判对话面。
 * 刻意不包含任何"话题词"（价格/天气/新闻/最新…），也不做长度+否定词
 * 的组合猜测——那类信号是词表打地鼠的根源，已全部删除。
 * ──────────────────────────────────────────────────────────── */

/** 整句问候/礼貌用语（多语言，锚定全文）。 */
const CHAT_ONLY_RE =
  /^(你好|hello|hi|hey|早上好|下午好|晚上好|谢谢|thanks|thank you|bye|再见|你是谁)[!！。.，,？?\s]*$/i;

/** 口头禅/应答词/情绪涂鸦（锚定全文）。 */
const CASUAL_CHAT_RE =
  /^(在吗|还在吗|哈哈|haha|lol|ok|okay|嗯|嗯嗯|欸|诶|哎|唉|哦|噢|喔|在|忙吗|睡了吗|吃了吗|收到|行|好|好嘞|好的|好的呀|好的呢|谢啦|谢谢啦|bye bye|晚安)[!！。.，,？?\s]*$/i;

/** 高长度上限：超长文本即使形似寒暄也不短路（防拼接绕过）。 */
const CHAT_SHORT_CIRCUIT_MAX_LEN = 16;

/**
 * 判断整条消息是否为高精度纯闲聊（可安全零工具直答）。
 * 仅供 L0 短路与降级路径使用——不承担"识别工具需求"的职责。
 */
export function isHighPrecisionChatText(text: string): boolean {
  const t = (text ?? "").trim();
  if (!t || t.length > CHAT_SHORT_CIRCUIT_MAX_LEN) return false;
  return CHAT_ONLY_RE.test(t) || CASUAL_CHAT_RE.test(t);
}

/**
 * 判断回复是否需要做短句分段。
 * 对话面（闲聊/知识问答）分段模拟真人节奏；任务面（工具/搜索结果）不分段。
 */
export function determineSegmentable(plane: TurnPlane): boolean {
  return plane === "chat";
}
