/**
 * L1 语义意图分类调用（2026-10-07 契约化重构：结构化调用的第一个完整消费者）。
 *
 * 职责收敛：本文件只做路由特有三件事——prompt 组装、intent JSON 解析、
 * 顺带情绪/话题辅助分析（与意图 JSON 同体输出，省一次每轮 LLM 调用）。
 * 调用参数（预算/超时/json mode）、超时竞速、网关式重试全部委托
 * {@link structuredCall} 契约助手——换路由模型时这些行为按 provider
 * 能力档案自适应，本文件零改动。
 */
import type { ExternalChatProvider } from "../external-model/types.js";
import { structuredCall } from "../external-model/structured-call.js";
import { resolveRouteCallParams } from "../external-model/provider-profiles.js";
import type { RouteDecision } from "./task-router.js";
import { parseIntentJson, type IntentLabel } from "./intent-router.js";

export function buildRoutePrompt(
  text: string,
  recentUserTurns: string[],
  activeTasksSummary?: string,
  dialogStateLines: string[] = [],
): string {
  const lines: string[] = [
    "你是双面架构的意图路由器。对话面对话直答（零工具）；任务面在后台真正调用工具把事办完。你的任务只有一个：判断这条用户消息的意图标签。",
    "",
    '只输出一个 JSON 对象，格式：{"intent":"标签","confidence":0.0到1.0,"evidence":["片段"],"sentiment":<-1到1的小数，用户情绪>,"tags":[<最多3个情绪标签>],"topics":[<1-3个话题关键词>],"search_query":"<搜索词>","understanding":{"is_follow_up":布尔,"reference":"锚定","recall_intent":布尔,"memory_instruction":布尔,"personal_fact":布尔,"schedule_query":布尔,"travel_query":布尔,"action_negation":布尔}}。不要输出任何其他字符。',
    "intent 必须且只能取以下封闭集之一：",
    "- chat：纯对话。寒暄、情绪、观点交流、评价、闲聊追问，凭常识或已有上下文就能答的内容。问你的近况/想法/感受也是 chat。陈述关于自己的事实（真名/称呼/偏好）也是 chat。",
    "- knowledge_qa：常识/知识问答（不依赖实时信息，如原理、历史、解释）。",
    "- realtime_lookup：需要外部**公开网络**实时信息——新闻、某人（公众人物/他人）近况、最新消息、价格行情、热搜、比分、排片等，答准了必须现查的。",
    "- weather_query：查天气——实况/今天冷不冷/会不会下雨/气温/湿度/风力/穿衣建议/未来几天趋势，需要实时气象数据。系统有专属天气工具（自动定位直查），不走网页搜索。",
    "- personal_data_query：查**用户自己的**数据——我的/我自己的日程、提醒、订单、快递、钱包余额、账单、消息、通话、相册照片、设备状态等。这类走系统内工具直查，绝不联网搜索。",
    "- media_retrieval：找图片/照片/视频/壁纸/表情包。",
    "- travel_planning：规划旅行行程——去某地玩几天的行程安排/旅游攻略/路线规划（含对规划中的行程补充目的地、天数、偏好）。",
    "- action_write：写数据/有副作用的操作——创建或修改日程提醒、发消息、下单、支付等。「X点提醒我Y」「定个闹钟」「帮我设置…」都是 action_write，绝不能判成 chat。但用户**明确拒绝或取消**某类写操作（「别再提醒我开会」「不用给我下单了」）不是 action_write——那是 chat（口头应一声）或在要求管理已有提醒。",
    "- multi_step_task：多步操作、操作软件/电脑/设备、或以上都没贴切的办事请求。",
    "- meta_capability：询问你能做什么/系统状态。",
    "",
    "判定要点：",
    "- 实时信息类哪怕没有「查/搜」字样（如「刘浩存最近的消息」「今天A股怎么样」「比特币现在什么价」）也是 realtime_lookup。",
    "- 「我的订单/我的日程/我钱包」这类**用户本人数据**是 personal_data_query，不是 realtime_lookup——哪怕它也「需要现查」，查的地方是系统内数据不是公开网络。",
    "- 天气查询是 weather_query（不是 realtime_lookup——天气有专属工具直办，不需要网页搜索）；感叹天气（「今天天气真好」）是 chat。",
    "- 用户明确说「不要联网/别搜索/不用上网」时：按消息本来的知识属性判（能凭常识答→chat 或 knowledge_qa），绝不判 realtime_lookup 和 weather_query。",
    "- confidence 表达你对标签判断的把握；判不准就给低分（<0.5），系统会自动走保守平面，不会出错。",
    "- intent=realtime_lookup 时 search_query 必填：结合最近对话解决指代（如「我老婆」指代哪个具体人名、「那家店」是哪家），生成一句完整、具体、可直接搜索的中文查询词；其他 intent 一律给空字符串。",
    "- intent=weather_query 时 search_query 恒为空字符串（天气由系统专属工具按自动定位直查，位置不需要用户提供，也不需要网页搜索词）。",
    "- 「帮我规划去X玩N天」「X旅游攻略」「周末去X怎么玩」「去X自由行」是 travel_planning；只问「X有什么好玩的/适合几月去」这类知识问答是 knowledge_qa；过问已派发的行程任务进度是 chat。",
    "- intent=travel_planning 时 search_query 恒为空字符串（调用参数由系统代码从用户原话构造，不需要模型生成搜索词）。",
    "- evidence 字段（2026-10-12 证据锚定契约）：intent 为 media_retrieval / realtime_lookup / weather_query / action_write 时必填——从**当前用户消息原文**中逐字摘出 1-3 个支撑该标签的片段（media 摘表示找图/找视频诉求的词，realtime 摘需要现查的内容，weather_query 摘天气诉求词如「天气/下雨/穿什么」，action_write 摘明确的动作诉求词）。当前消息里摘不出支撑片段 = 标签不成立，请改判；系统会代码校验片段确实出自当前消息，造假片段会被作废。其他 intent 一律省略 evidence。",
    "- 话题继承收口：短承接语（「娱乐圈的」「再来点」）仅当 understanding.is_follow_up=true 且上一轮对话状态显示话题尚未完结（如照片还没找够）时才按继承话题判；用户在陈述个人事实、确认偏好、提出新请求时，永远按当前消息本身判——上一轮搜过图、交付过照片，不代表本轮还要图。",
    "- 承接上一轮媒体交付的短承接语（「再来点」「多来几张」「还有吗」）判 media_retrieval，绝不判 realtime_lookup——媒体追加诉求走图片/视频搜索，不是网页搜索（「上一轮对话状态」里已列出的 search_images/照片交付就是媒体话题的标志）。",
    "- sentiment/tags/topics 是顺带分析（情绪与话题），省略不报错，但尽量都给。",
    "- understanding 是顺带的语境理解标记（省略不报错，但尽量都给），按用户消息本身判定：",
    "  - is_follow_up：本条是否承接上一轮的短追问/应答（「然后呢」「那个方案呢」「你确定吗」）。独立的新话题、新请求、新问题一律 false。",
    "  - reference：本条话头锚定什么——none=独立新话题；prev_assistant=在回应你上一条说的内容；prev_user_request=回应用户自己上一条请求；earlier_session=明确指向更早的会话或记忆（如「上次说的那个」）。",
    "  - recall_intent：用户想找回/回忆更早聊过的内容（「上次聊的」「之前说的那个」）。",
    "  - memory_instruction：用户要求你记住或忘掉某信息。",
    "  - personal_fact：用户在陈述关于自己的事实（名字/称呼/身份/家人/住所/计划）。",
    "  - schedule_query：本轮在问用户自己的日程/提醒/安排。",
    "  - travel_query：本轮在问行程/旅行规划相关的事。",
    "  - action_negation：用户在明确拒绝/取消某类写操作（「别再提醒我」「不用下单了」），而不是在提出写请求。",
    "",
  ];
  if (activeTasksSummary?.trim()) {
    lines.push("当前正在后台执行的任务（若本消息是在修正/取消这些任务，按其话题判意图）：");
    lines.push(activeTasksSummary.trim());
    lines.push("⚠️ 只是过问进度（「怎么样了/好了没/有结果了吗/还要多久」）→ 判 chat：");
    lines.push("任务结果会由系统自动回到对话里，本轮口头应一声即可，绝不再派新任务。");
    lines.push("");
  }
  if (dialogStateLines.length > 0) {
    // 结构化对话状态（2026-10-12 架构收敛）：上一轮的意图 + 真实执行过的工具
    // ——分类器终于看得到执行者做过的事，不再从 user 原文里猜「刚才发生了什么」。
    lines.push("上一轮对话状态（短承接/继承话题判定的唯一依据；列出的工具结果已交付给用户）：");
    for (const line of dialogStateLines) lines.push(line);
    lines.push("");
  } else if (recentUserTurns.length > 0) {
    lines.push("最近对话（最旧在前，仅供理解话题）：");
    for (const turn of recentUserTurns.slice(-4)) {
      lines.push(`- ${turn}`);
    }
    lines.push("");
  }
  lines.push(`用户消息：${text}`);
  return lines.join("\n");
}

/**
 * 解析路由输出里顺带携带的情绪/话题辅助分析（缺省/解析失败返回 undefined，
 * 消费方回退独立情绪分析调用）。
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
 * 解析路由输出里顺带携带的语境理解标记（2026-10-09 词表判定退役的语义层替代）。
 * 缺省/解析失败返回 undefined——消费方一律按「无特殊处理」（最小注入）执行：
 * 误注入=串台，漏注入=少点可选上下文，代价不对称，保守方向明确。
 */
export function parseUnderstanding(
  raw: string | undefined | null,
): RouteDecision["understanding"] {
  if (!raw) return undefined;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  try {
    const obj = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
    const u = (obj.understanding ?? {}) as Record<string, unknown>;
    const bool = (v: unknown): boolean => v === true || v === "true";
    const refRaw = typeof u.reference === "string" ? u.reference.trim() : "";
    const reference = (
      ["none", "prev_assistant", "prev_user_request", "earlier_session"] as const
    ).includes(refRaw as never)
      ? (refRaw as "none" | "prev_assistant" | "prev_user_request" | "earlier_session")
      : "none";
    const understanding = {
      isFollowUp: bool(u.is_follow_up ?? u.isFollowUp),
      reference,
      recallIntent: bool(u.recall_intent ?? u.recallIntent),
      memoryInstruction: bool(u.memory_instruction ?? u.memoryInstruction),
      personalFact: bool(u.personal_fact ?? u.personalFact),
      scheduleQuery: bool(u.schedule_query ?? u.scheduleQuery),
      travelQuery: bool(u.travel_query ?? u.travelQuery),
      actionNegation: bool(u.action_negation ?? u.actionNegation),
    };
    const hasSignal =
      understanding.isFollowUp ||
      understanding.reference !== "none" ||
      understanding.recallIntent ||
      understanding.memoryInstruction ||
      understanding.personalFact ||
      understanding.scheduleQuery ||
      understanding.travelQuery ||
      understanding.actionNegation;
    // 全 false 时省字段：缺省即「无特殊处理」，语义等价
    return hasSignal ? understanding : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 解析路由输出里的证据锚定片段（2026-10-12 证据锚定契约）。
 * media_retrieval / realtime_lookup / action_write 要求模型从当前用户消息
 * 逐字摘出支撑片段；L2 代码校验「片段确实出自当前消息」，造假/摘不出即标签
 * 作废。返回空数组 = 模型未给（宽容：历史输出兼容，不因 schema 缺字段降级）。
 */
export function parseEvidenceJson(raw: string | undefined | null): string[] {
  if (!raw) return [];
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return [];
  try {
    const obj = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
    const rawEvidence = obj.evidence;
    const items = Array.isArray(rawEvidence)
      ? rawEvidence
      : typeof rawEvidence === "string" && rawEvidence.trim()
        ? [rawEvidence]
        : [];
    return items
      .map((e) => String(e).trim())
      .filter(Boolean)
      .slice(0, 3);
  } catch {
    return [];
  }
}

export type IntentRouteCall =
  | {
      ok: true;
      /** L1 意图判定（intent 已过封闭集校验） */
      intent: { intent: IntentLabel; confidence: number };
      /** 顺带情绪/话题辅助分析（缺省 undefined，消费方回退独立情绪分析） */
      auxAnalysis: RouteDecision["auxAnalysis"] | undefined;
      /** 顺带语境理解标记（追问锚定/记忆/日程/旅行；缺省 undefined = 无特殊处理） */
      understanding: RouteDecision["understanding"];
      /** 原始输出（realtime 轮 search_query 二次提取用） */
      raw: string;
      attempts: number;
    }
  | {
      ok: false;
      reason: "provider_disabled" | "timeout" | "call_error" | "unparseable";
      attempts: number;
    };

/**
 * L1 结构化意图分类：预算/超时/json mode 按路由 provider 能力档案自适应，
 * 超时/坏输出/异常网关式重试（细节见 structured-call）。永不抛错。
 *
 * 唯一偏离默认契约处：**超时不重试**。路由是主回复前的同步前置门，超时意味着
 * 请求仍卡在服务端——原参立刻重试几乎必然再超时，实测把一次 5000ms 超时翻倍成
 * 10000ms 空等后仍然失败（L1 分类失败→保守降级任务面）。而本层自带确定性兜底
 * （conservativeFallback），不用为「再试一次」付第二个 timeout。坏输出与调用
 * 异常的重试保留（那才是瞬态抖动语义）。
 */
export async function classifyIntentByLlm(
  provider: ExternalChatProvider,
  routeSessionId: string,
  text: string,
  recentUserTurns: string[] = [],
  activeTasksSummary?: string,
  dialogStateLines: string[] = [],
): Promise<IntentRouteCall> {
  const prompt = buildRoutePrompt(text, recentUserTurns, activeTasksSummary, dialogStateLines);
  const { maxOutputTokens, timeoutMs, jsonMode } = resolveRouteCallParams(provider);
  const result = await structuredCall<{ intent: IntentLabel; confidence: number }>(
    provider,
    routeSessionId,
    prompt,
    {
      label: "intent_route",
      maxOutputTokens,
      timeoutMs,
      jsonMode,
      retryOnTimeout: false,
      parse: (raw) => parseIntentJson(raw),
    },
  );
  if (!result.ok) {
    return { ok: false, reason: result.reason, attempts: result.attempts };
  }
  return {
    ok: true,
    intent: result.value,
    auxAnalysis: parseAuxAnalysis(result.raw),
    understanding: parseUnderstanding(result.raw),
    raw: result.raw,
    attempts: result.attempts,
  };
}
