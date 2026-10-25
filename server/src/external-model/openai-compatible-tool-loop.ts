import { getDataDir } from "../config/data-dir.js";
import type OpenAI from "openai";
import { appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  recordLlmUsageByChars,
  recordToolCompactionByChars,
  type LlmAuditStage,
  type LlmInputBreakdown,
} from "../services/llm-token-audit.js";
import { currentBlockingStep, getTaskPlanStore, taskPlanKey } from "../agent/task-plan-store.js";
import { isMediaOnlyRequest } from "../agent/realtime-search-query.js";
import { filterMediaModalityTools, filterTextSearchTools } from "../agent/web-search-consent.js";
import { classifyToolSensitivity } from "../security/sensitive-action.js";
import type {
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
  ChatCompletionTool,
} from "openai/resources/chat/completions";

import { AGENT_WORLD_CHAT_TOOLS, filterSocialChatTools } from "@nextbot/agent-world";
import { isAgentWorldSocialEnabled } from "../config/env.js";
import {
  AGENT_CAPABILITY_QUERY_CHAT_TOOLS,
  AGENT_LINK_CHAT_TOOLS,
  AGENT_RELAY_CHAT_TOOLS,
  CALENDAR_CHAT_TOOLS,
  CLOCK_CHAT_TOOLS,
  INFO_WEB_CHAT_TOOLS,
  LIFE_ASSISTANT_CHAT_TOOLS,
  PHONE_CHAT_TOOLS,
  SURFACE_CHAT_TOOLS,
  VISION_CHAT_TOOLS,
  VOICE_CHAT_TOOLS,
  WALLET_CHAT_TOOLS,
} from "./builtin-chat-tools.js";
export { VISION_SANDBOX_RESTRICTED_CHAT_TOOLS } from "./builtin-chat-tools.js";
import { AIP_CHAT_TOOLS } from "../aip/aip-chat-completion-tools.js";
import { OBS_RECALL_CHAT_TOOL } from "./builtin-chat-tools.js";
import { normalizeTraditionalToSimplified } from "../utils/simplified-chinese.js";
import { getDesktopVisualChatTools } from "../tools/desktop-visual-chat-tools.js";
import { getPhoneBridgeChatTools } from "../tools/phone-bridge-chat-tools.js";
import { MESSAGE_HUB_CHAT_TOOL_DEFINITIONS } from "../tools/message-hub-chat-tools.js";
import { BROWSER_SESSION_LIST_CHAT_TOOL } from "../tools/browser-session-chat-tools.js";
import { INTERNET_INTELLIGENCE_CHAT_TOOLS } from "../tools/internet-intelligence-chat-tools.js";
import { INTEREST_WATCH_CHAT_TOOLS } from "../tools/interest-watch-tools.js";
import { LIFE_MANAGE_CHAT_TOOLS } from "../tools/life-manage-tools.js";
import { AGENT_TASKS_CHAT_TOOLS } from "../tools/agent-tasks-tools.js";
import { RHYTHM_REMINDER_CHAT_TOOLS } from "../tools/rhythm-reminder-tools.js";
import {
  PROACTIVITY_CONFIRM_CHAT_TOOLS,
  PROACTIVITY_FEEDBACK_CHAT_TOOLS,
} from "../tools/proactivity-feedback-tools.js";
import { CARE_REMINDER_CHAT_TOOLS } from "../tools/care-reminder-tools.js";
import { AGENT_ACTIVITY_CHAT_TOOLS } from "../tools/agent-activity-tools.js";
import {
  AGENT_UPDATE_HOMEPAGE_CHAT_TOOL,
  AGENT_UPDATE_IDENTITY_CHAT_TOOL,
} from "../tools/agent-identity-tools.js";
import { GEOFENCE_CHAT_TOOLS } from "../tools/geofence-tools.js";
import { WATCH_TRACK_CHAT_TOOLS } from "../tools/watch-board-tools.js";
import { PROFILE_QUERY_CHAT_TOOLS } from "../tools/profile-query-tool.js";
import { EMBODIMENT_CHAT_TOOLS } from "../tools/embodiment-tools.js";
import { SMART_HOME_CHAT_TOOLS } from "../tools/smart-home-tools.js";
import { DEVICE_CHAT_TOOLS } from "../tools/device-tools.js";
import { SELF_PROGRAMMING_CHAT_TOOLS } from "../tools/self-programming-chat-tools.js";
import { openAiUserContentFromTurn } from "./build-user-message-content.js";
import { stripAllTimestampFrameLines } from "../utils/timestamp-frame.js";

/** prompt 诊断转储开关（2026-10-11）：环境变量 AGENT_PROMPT_TRACE=1，或 <cwd>/data/prompt-trace.flag 存在（免重启）。 */
function promptTraceEnabled(): boolean {
  if (process.env.AGENT_PROMPT_TRACE === "1") return true;
  try {
    return existsSync(join(getDataDir(), "prompt-trace.flag"));
  } catch {
    return false;
  }
}

/**
 * 截取「先回一句话」的确认语（2026-10-11）：取首句（到第一个句末标点/换行为止），
 * 超过 maxChars 时在句内最后一个逗号/顿号/分号处软截断（找不到则硬切）。
 * 用途：工具波前导话兜底推送（非流式波）只出一句确认，不把模型的思考/计划
 * 整段透给前端——「先一句话，完成后出结果」的展示契约。
 */
export function firstAckSentence(text: string, maxChars = 60): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  const first = (/^[\s\S]*?[。！？!?\n]/.exec(trimmed)?.[0] ?? trimmed).trim();
  if (first.length <= maxChars) return first;
  const head = first.slice(0, maxChars);
  const softIdx = Math.max(
    head.lastIndexOf("，"),
    head.lastIndexOf(","),
    head.lastIndexOf("、"),
    head.lastIndexOf("；"),
    head.lastIndexOf(";"),
  );
  return (softIdx > 12 ? head.slice(0, softIdx + 1) : head).trim();
}

import {
  OBS_RECALL_TOOL_NAME,
  archiveIfWorthwhile,
  buildObservationRecallHint,
  embedObsQuery,
  getObservationPack,
  type ArchivedObservation,
} from "./observation-pack.js";
import { modelSupportsVision } from "./vision-support.js";
import { getAgentRuntimeConfig } from "../agent/agent-runtime-config.js";
import { compactToolOutputForLlm } from "../tokenjuice/compactor.js";
import {
  executeBridge,
  isToolSearchBridgeName,
  prepareTools,
  searchResources,
  type ResidentToolInfo,
} from "../gateway/index.js";
import {
  getCapabilityModuleCategoryMappings,
  getCapabilityModuleChatTools,
  type CapabilityModuleDeps,
} from "../tools/capability-modules/index.js";
import { isExplicitPhoneCallRequest } from "../agent/phone-call-intent.js";
import { resolveExplicitActionTool } from "../gateway/forced-tool.js";
import { recordExitGateFire, recordTurnFinished } from "./exit-gate-metrics.js";
import { buildRecoveryHint } from "../agent/loop/tool-metadata.js";
import {
  isToolCallIdNotFoundError,
  isToolChoiceRejectedError,
  sanitizeChatMessagesForApi,
} from "./chat-thread-sanitize.js";
import {
  applyPromptCacheMessages,
  type PrefixCacheRequest,
} from "./prefix-cache.js";
import {
  fingerprintRequestHead,
  reportPrefixWatchOutcome,
} from "./prefix-watchdog.js";
import {
  adaptOpenAiChatCompletionStream,
  consumeNormalizedStream,
  materializeOpenAiToolCalls,
  StreamIdleTimeoutError,
  stripInlineThinkBlocks,
  stripInternalControlTags,
  createStreamControlTagSanitizer,
  createStreamMetaSentenceFilter,
  stripMetaSentences,
  type NormalChatChunk,
  type NormalToolCall,
  type NormalUsage,
} from "./stream-chat-helpers.js";
import type {
  ChatToolExecutionContext,
  StreamDeltaHandler,
  ToolLoopAfterBatchInfo,
  VisionFrame,
} from "./types.js";
import { executeWithToolLimit } from "../services/concurrency-limiter.js";
import {
  classifyToolFailure,
  UnifiedErrorCode,
} from "@nextbot/agent-protocol";
import {
  BOOKKEEPING_TOOL_NAMES,
  evaluateAndSelectStrategy,
  isPhotoDeliveryRound,
} from "../agent/synthesis-strategy.js";
import { isDirectFactQuery } from "../agent/direct-fact-query.js";
import {
  CHAT_LANE_CORE_NAMES,
  TASK_LANE_CORE_NAMES,
  TASK_LANE_ROUTER_FIRST_LIGHT_NAMES,
  isStaticToolArchEnabled,
  isToolRecallEnabled,
  isRouterFirstLaneTurn,
} from "./lane-tool-sets.js";
import { topToolMatchesForQuery } from "../tools/tool-search/index.js";
import { markTurnScaffold } from "./turn-scaffold.js";
import { recordTurnTrace, inferToolCallTimedOut, type ToolCallTraceEntry } from "./turn-trace.js";
import {
  fenceUntrustedToolContent,
  shouldFenceToolContent,
} from "./untrusted-content.js";
import { isHighRiskToolName } from "../services/agent-task-safety.js";

const TOOL_RESULT_VISION_INJECT_KEY = "_injectVisionUserMessage";

/**
 * 请求卡（tool_request）召回分数下限。低于预召回的 0.5：请求卡每轮仅一次、
 * 有出口检查与"如实说明"指令兜底，稍宽松换覆盖率；真实分布见
 * [openai-tool-loop] 请求卡日志，按线上数据再校准。
 */
const REQUEST_CARD_MIN_SCORE = 0.4;

/**
 * ObservationPack 总开关（SoL-Pi 借鉴）：大体积工具结果归档为 obs_N 句柄、
 * 压缩/折叠消息追加读回提示、obs_recall 分页读回。OBS_PACK_ENABLED=0 整体关闭
 * （工具 schema 一并不注入，历史提示里的句柄读回会得到「无归档」可恢复错误）。
 */
const OBS_PACK_ENABLED = process.env.OBS_PACK_ENABLED !== "0";

// 工具结果字符预算：在信息完整性和 token 节省之间取平衡。
// search_web 7000：2026-09-03 需求「检索/任务型回复要信息全面」，snippet 上限同步放宽到
// 400 字符，预算随之上调（原 5000），保证多来源标题+摘要不因截断丢细节。
// fetch_web 4500 / deep_search 6000：深读正文要支撑细节复述，截太狠等于白抓。
const TOOL_RESULT_PRESET_MAX_CHARS: Record<string, number> = {
  "search_web": 7000,
  "search_images": 1200,
  "search_videos": 1200,
  "fetch_web": 4500,
  // deep_search 返回正文，限制注入量避免整页内容灌给 LLM
  "deep_search": 6000,
  // hot_rankings 榜单项字段少，给足即可
  "hot_rankings": 1400,
  "info.search": 5000,
  "info.inspect_webpage": 1000,
  "info.navigate_site": 1200,
  "browser.session.list": 600,
  "browser.fetch_page": 1000,
  "calendar.list_tasks": 800,
  "aip.list_my_state": 800,
  "self.list_custom_skills": 800,
  "agent.query_capabilities": 900,
  "search": 5000,
  "describe": 800,
  "tool_search": 800,
  // 2026-10-01 瘦身后实测 p50 1509 字符（top-3 瘦身 schema 全保）。旧 800 预算
  // 配 4k 胖载荷=常态截断（LLM 从未见过完整结果）；现预算覆盖瘦身后载荷 → 零截断。
  "tool_discover": 1600,
  "shopping.order.search": 1500,
  "shopping.order.place": 1000,
  "shopping.order.track": 1000,
  "shopping.order.cancel": 800,
  // agent_browser.* —— extract_text 是主要信息获取工具（文本+可交互元素），给充足 budget；
  // screenshot 的 base64 已在 service 层截断到 2000 字符，budget 覆盖元数据即可。
  "agent_browser.open": 600,
  "agent_browser.click": 300,
  "agent_browser.type": 300,
  "agent_browser.scroll": 300,
  "agent_browser.screenshot": 2500,
  "agent_browser.extract_text": 5000,
  "agent_browser.wait_for": 300,
  "agent_browser.close": 200,
  // shared_browser.* —— 经 WS 桥转发到客户端浏览器执行，read_page 为主要信息获取工具
  "shared_browser.navigate": 600,
  "shared_browser.control": 300,
  "shared_browser.click": 300,
  "shared_browser.type": 300,
  "shared_browser.scroll": 300,
  "shared_browser.read_page": 5000,
  // phone_call.* —— prepare 携带确认卡 cardMarker（~600 字符）须完整回传给模型原样转发；
  // status/list/finish 返回会话快照/结果摘要，均为小体积结构化 JSON
  "phone_call.prepare": 1800,
  "phone_call.start": 700,
  "phone_call.status": 1100,
  "phone_call.finish": 1200,
  "phone_call.list": 1000,
  "phone_call.cancel": 400,
};

// strip_keys：只去掉纯元数据字段，保留 LLM 决策需要的字段。
// 注意：url 必须保留（LLM 需要判断哪些结果值得 fetch_web 深读）。
const TOOL_RESULT_STRIP_KEYS: Record<string, string[]> = {
  search_web: ["provider", "fetchedAt", "notes"],
  search_images: ["provider", "notes"],
  search_videos: ["provider", "notes"],
  deep_search: ["provider", "notes"],
  hot_rankings: ["fetchedSources", "notes"],
  fetch_web: ["url"],
  "info.inspect_webpage": ["sameHostLinks"],
  "info.navigate_site": ["startUrl"],
};

/**
 * 元工具 / 能力查询类工具：输出是结构化 JSON（工具 schema、能力清单、匹配列表），
 * 不是用户可读的自然语言内容。
 *
 * 这些工具的结果只作为 tool message 回填给 LLM 供其理解，绝不能作为面向用户的
 * 回复文本透出（历史教训：兜底逻辑曾把工具 JSON 原样拼成回复推给前端，用户看到
 * 「reminder.plan 参数 schema」「availableDomains 数组」这类内部数据）。
 */
const META_TOOL_NAMES = new Set<string>([
  "tool_discover",
  "tool_search",
  "tool_describe",
  "agent.query_capabilities",
  "self.list_custom_skills",
  "aip.list_my_state",
]);

/**
 * 上下文管线支撑工具：只回读已归档的历史结果，不产生新的外部数据。
 * 不计入「实质成功工具」数（出口自检 TurnOutcomeGate 与策略评估用），
 * 也不写入 allToolExecResults（避免读回的旧内容虚增数据质量评分）。
 */
const SUPPORT_PLUMBING_TOOLS = new Set<string>([OBS_RECALL_TOOL_NAME]);

/**
 * 派发型工具（2026-10-22 完成语义契约）：成功只代表「已排队」，**不代表办完**。
 *
 * 判定优先读结果体里的 `produces: "queued"`（工具自己声明，见 task-dispatch-tool），
 * 名字集合只是旧结果/低版本工具的兜底。出口闸据此区分「拿到了能回答用户的内容」
 * 与「只是把活派出去了」——不读任何措辞。
 */
const QUEUED_PRODUCER_TOOLS = new Set<string>(["task.dispatch"]);

/**
 * 实质工具执行判定（2026-10-13 导出，答案留存契约共用）：
 * 元工具（目录检索/桥调用）与支撑管线不改变「这轮调过工具吗」的答案——
 * 消费方：tool-loop 答案留存闸（holdAnswer）与 agent-core 的
 * reply.answerStreamHeld 记账，两处口径恒一致（同一函数，非两份词表）。
 */
export function isSubstantiveToolExecution(toolName: string): boolean {
  return !META_TOOL_NAMES.has(toolName) && !SUPPORT_PLUMBING_TOOLS.has(toolName);
}

function getToolResultBudget(toolName: string): number | undefined {
  return TOOL_RESULT_PRESET_MAX_CHARS[toolName];
}

/**
 * 任务面工具结果预算缩放（B4，2026-09-08）：后台任务的最终产物是一段总结性回复，
 * 检索类结果不需要前台快查那么高的保真度——task_plane 阶段统一按比例收缩每工具
 * 字符预算（默认 ×0.6：search_web 7000→4200、deep_search 6000→3600），前台对话面
 * 不受影响。AGENT_TASK_TOOL_BUDGET_SCALE 可调（0-1]。
 */
function resolveToolBudgetScale(stage?: string): number {
  if (!stage || !stage.startsWith("task_plane")) return 1;
  const n = Number.parseFloat(process.env.AGENT_TASK_TOOL_BUDGET_SCALE ?? "");
  return Number.isFinite(n) && n > 0 && n <= 1 ? n : 0.6;
}

function getToolResultStripKeys(toolName: string): string[] | undefined {
  return TOOL_RESULT_STRIP_KEYS[toolName];
}

// 行动宣告兜底（「只宣告未兑现→文字判定强制续波」）已于 2026-10-06 整体下线：
// 文本正则判语义误伤两次（高危闸 substring、宣告闸「别让我看」），且工具调用
// 质量已由语义路由+出口自检（服务端事实判定）承担，不再用措辞猜承诺。

function isApologyStyleFallback(text: string): boolean {
  const t = text.trim();
  if (!t) return true;
  const apologyPatterns = [
    /抱歉.*(?:无法|不能|暂时)/,
    /请稍后重试/,
    /换个(?:问法|方式)/,
    /我(?:不太|没有)?(?:清楚|了解|知道|听说过)/,
    /没(?:太|有)?(?:听过|见过|找到|搜到|查到|听清|听到|收到)/,
    /再说一遍/,
    /网络(?:那边)?(?:卡住|异常|繁忙|问题)/,
    /刚走神/, // 用户明确要求删除"哈?刚走神了"风格的兜底
    /没反应过来/, // 用户明确要求删除"没反应过来"风格的兜底
    /我这会儿/, // 用户明确要求删除"我这会儿没反应过来"风格的兜底
    // 通用"无能为力"句式（2026-09-05 出口自检话题无关化：只描述"答不了"的
    // 语言形态，不描述任何话题——话题需求由路由层语义分类承担）
    /(?:暂时|目前|现在)(?:没|无法|答不了|查不了|给不了)/,
    /没有现成(?:数据|资料|信息|结果)/,
    /(?:答不了|查不到|拿不到|给不了|掌握不到|无能为力)/,
  ];
  if (apologyPatterns.some((re) => re.test(t))) {
    // 仅当 LLM 没有在回复里整合任何事实（数字/链接/标题/日期）时，才判定为兜底
    const hasFactAnchors =
      /\d/.test(t) ||
      /https?:\/\//.test(t) ||
      /Kimi|Moonshot|月之暗面|大模型|发布|开源|参数|刷新/.test(t);
    return !hasFactAnchors;
  }
  return false;
}

/**
 * 技能声明的执行超时（`SkillMetadata.timeoutMs`）查询钩子。
 *
 * 为什么要有这层：技能声明此前**只被 `skill-sandbox` 消费**，工具循环走自己这张
 * 硬编码表 —— 两处事实源必然漂移。2026-10-12 实盘量出漂移面：**10 个技能声明了
 * 30~120s，全部被 30s 默认值钳住**，其中 `travel.plan-itinerary` 声明 120s、实测
 * 冷启动需 57s，被 30s 击杀（ok=false）→ 行程回执缺失 → 行程卡整轮缺席。
 *
 * 契约：声明是**下界**（工具作者对「这个工具需要多久」的权威陈述），本文件的硬编码
 * 档与 30s 默认值只是通用兜底；两者取大 —— 所以新增慢工具**只需在技能里声明
 * `timeoutMs`，不必再改本文件**，也就不会再出现「声明了却没生效」。
 * 未注入（极简环境/部分单测）时返回 undefined，行为与旧版一致。
 */
let declaredSkillTimeoutResolver: ((toolName: string) => number | undefined) | null = null;

/** 由 bootstrap 注入真实查询（skillManager.list(true) 的 timeoutMs）。 */
export function setDeclaredSkillTimeoutResolver(
  fn: ((toolName: string) => number | undefined) | null,
): void {
  declaredSkillTimeoutResolver = fn;
}

/** 取技能声明的执行超时（未注入/未声明/非法值 → undefined）。 */
export function resolveDeclaredSkillTimeoutMs(toolName: string): number | undefined {
  try {
    const v = declaredSkillTimeoutResolver?.(toolName);
    return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 生产同款注入器（单一事实源）：把 SkillManager 的技能声明接进超时解析。
 *
 * bootstrap 与回归单测**都调这个函数**，不各自复制 lambda —— 否则测试锁的是
 * 测试自己的写法，有人把 `list(true)` 改成 `list()`（漏掉禁用项）或改了取键
 * 方式，测试照样绿。测的就是跑的那条。
 */
export function declaredSkillTimeoutFromManager(manager: {
  list(includeDisabled?: boolean): Array<{ name: string; timeoutMs?: number }>;
}): (toolName: string) => number | undefined {
  return (toolName) => manager.list(true).find((m) => m.name === toolName)?.timeoutMs;
}

/**
 * 工具执行超时预算（对外入口）：通用兜底档 与 技能声明 取大。
 * 见 `declaredSkillTimeoutResolver` 的注释——声明是下界，兜底不得把它吃掉。
 */
export function resolveToolExecutionTimeoutMs(registryToolName: string): number {
  const base = resolveBaseToolExecutionTimeoutMs(registryToolName);
  const declared = resolveDeclaredSkillTimeoutMs(registryToolName);
  return declared !== undefined && declared > base ? declared : base;
}

/**
 * 通用兜底档（旧实现本体）：进程级默认值 + 少量「必须长于内层超时」的硬覆盖
 * + 按工具分级的 classTimeouts。技能声明由外层 `resolveToolExecutionTimeoutMs` 取大。
 */
function resolveBaseToolExecutionTimeoutMs(registryToolName: string): number {
  const fallback = Number.parseInt(process.env.TOOL_EXECUTION_TIMEOUT_MS ?? "30000", 10);
  const defaultMs = Number.isFinite(fallback) && fallback > 0 ? fallback : 30_000;
  // code.run 内部 spawn 超时上限 120s，外层需 ≥ 内层，避免外层先超时产生孤儿进程
  if (registryToolName === "code.run") {
    const sandboxMax = Number.parseInt(process.env.CODE_SANDBOX_TIMEOUT_MS ?? "30000", 10);
    const sandboxClamped = Math.min(Math.max(sandboxMax, 30_000), 120_000);
    return Math.max(defaultMs, sandboxClamped + 2_000);
  }
  // code.shell 与 code.run 同样 spawn 子进程，复用相同超时上限
  if (registryToolName === "code.shell") {
    const sandboxMax = Number.parseInt(process.env.CODE_SANDBOX_TIMEOUT_MS ?? "30000", 10);
    const sandboxClamped = Math.min(Math.max(sandboxMax, 30_000), 120_000);
    return Math.max(defaultMs, sandboxClamped + 2_000);
  }
  // shopping.order.* 走 Playwright 多步浏览器操作，耗时长，须独立超时不被 30s 默认截断
  if (registryToolName === "shopping.order.search") return 90_000;
  if (registryToolName === "shopping.order.place") return 180_000;
  if (registryToolName === "shopping.order.track") return 60_000;
  if (registryToolName === "shopping.order.cancel") return 90_000;
  // agent_browser.* 走 Playwright 无头浏览器操作，open 须启动浏览器 + 导航给充足超时，
  // wait_for 用户可设 60s 等待，其余操作默认 15s（service 层）+ 余量
  if (registryToolName === "agent_browser.open") return 60_000;
  if (registryToolName === "agent_browser.wait_for") return 65_000;
  if (registryToolName.startsWith("agent_browser.")) return 30_000;
  // shared_browser.* 经 WS 桥转发到客户端浏览器执行（含往返 + 页面加载），超时须覆盖协调器 30s
  if (registryToolName === "shared_browser.navigate") return 45_000;
  if (registryToolName.startsWith("shared_browser.")) return 35_000;
  // phone_call.start 须等手机桥 dial 回执（含手机端全屏二次确认，桥超时 45s），
  // 外层须 ≥ 桥超时；通话本体绝不放进工具调用（start 立即返回 callId+状态）
  if (registryToolName === "phone_call.start") return 60_000;
  if (registryToolName.startsWith("phone_call.")) return 20_000;
  // travel.plan-itinerary（行程规划）：冷启动（缓存未命中）要跑地理编码 + 实时
  // POI 搜索，实测 20~57s（2026-10-12 贵阳轮：解析+取数 48.9s，总计 56.7s）。
  // 技能自身声明 `timeoutMs: 120_000`（travel-planning-skills.ts），现由
  // `resolveToolExecutionTimeoutMs` 的「声明取大」机制通用兜住（同类 10 个技能一并
  // 受益）；此处保留显式档只为两件事：① 提供 `TOOL_TIMEOUT_TRAVEL_PLAN_MS` 环境变量
  // 旋钮；② 在未注入声明查询的环境（极简单测）下仍给足预算。
  // 注：必须放在 classTimeouts 之前——那张表末尾有 Math.min(classMs, defaultMs) 钳制。
  if (registryToolName === "travel.plan-itinerary") {
    const travelMs = Number.parseInt(
      process.env.TOOL_TIMEOUT_TRAVEL_PLAN_MS ?? "120000",
      10,
    );
    return Number.isFinite(travelMs) && travelMs > 0 ? travelMs : 120_000;
  }
  // 按工具类别分级超时：快工具给短超时，防止上游慢响应把整个 turn 卡到 30s
  const classTimeouts: Record<string, number> = {
    // 天气 15s（2026-10-08 定位修复）：按需定位改为真等客户端 GPS（协调器 12s 超时），
    // 8s 预算会在 GPS fix 前把工具击杀，agent 只能拿旧缓存/记忆城市答天气
    "weather": Number.parseInt(process.env.TOOL_TIMEOUT_WEATHER_MS ?? "15000", 10),
    "weather.get_local": Number.parseInt(process.env.TOOL_TIMEOUT_WEATHER_MS ?? "15000", 10),
    "search_web": Number.parseInt(process.env.TOOL_TIMEOUT_SEARCH_MS ?? "6500", 10),
    // 图片搜索独立 12s 档：内部链路是「结果页抓取 ≤5s + 图片转存硬预算 6.5s ≈ 11.5s」，
    // 按外圈 12s 设计。曾共享 search_web 的 6.5s 档，慢源查询（如「科莫多」这类图片
    // 多在境外站 CDN 的小众目的地）必被外层击杀、items 归零，LLM 只能回「搜索超时」。
    "search_images": Number.parseInt(process.env.TOOL_TIMEOUT_SEARCH_IMAGES_MS ?? "12000", 10),
    // 视频搜索双源并行（Bing 直抓 10s + B站接口 8s），6.5s 共享档会在正常返回前掐断
    "search_videos": Number.parseInt(process.env.TOOL_TIMEOUT_SEARCH_VIDEOS_MS ?? "12000", 10),
    "video.grab": Number.parseInt(process.env.TOOL_TIMEOUT_VIDEO_GRAB_MS ?? "25000", 10),
    // video.find = 搜索候选 + 并发解析可播放流，整体耗时高于单链接 grab
    "video.find": Number.parseInt(process.env.TOOL_TIMEOUT_VIDEO_FIND_MS ?? "45000", 10),
    "fetch_web": Number.parseInt(process.env.TOOL_TIMEOUT_FETCH_MS ?? "15000", 10),
    "info.inspect_webpage": Number.parseInt(process.env.TOOL_TIMEOUT_FETCH_MS ?? "15000", 10),
    "info.navigate_site": Number.parseInt(process.env.TOOL_TIMEOUT_NAVIGATE_MS ?? "20000", 10),
    "info.search": Number.parseInt(process.env.TOOL_TIMEOUT_SEARCH_MS ?? "6500", 10),
    "voice.speak": Number.parseInt(process.env.TOOL_TIMEOUT_VOICE_MS ?? "20000", 10),
    "voice.send_message": Number.parseInt(process.env.TOOL_TIMEOUT_VOICE_MS ?? "20000", 10),
    "voice.transcribe": Number.parseInt(process.env.TOOL_TIMEOUT_VOICE_MS ?? "20000", 10),
    "image.generate": Number.parseInt(process.env.TOOL_TIMEOUT_IMAGE_GEN_MS ?? "60000", 10),
  };
  const classMs = classTimeouts[registryToolName];
  if (Number.isFinite(classMs) && classMs > 0) {
    // 快工具超时不大于全局默认，避免短任务被卡到 30s
    return Math.min(classMs, defaultMs);
  }
  return defaultMs;
}

/**
 * 当轮可见 apiTools → 常驻工具描述索引（discover/describe 回退查询用）。
 * registry 名 + LLM 名双口径，模型两种写法都能命中。
 * 非 function 形态的工具（custom 等）跳过——discover 回退只描述 function 工具。
 */
function toResidentToolIndex(
  apiTools: ChatCompletionTool[],
  resolveRegistryToolName: (name: string) => string,
): ResidentToolInfo[] {
  const out: ResidentToolInfo[] = [];
  for (const t of apiTools) {
    if (t.type !== "function" || !t.function?.name) continue;
    out.push({
      name: resolveRegistryToolName(t.function.name),
      alias: t.function.name,
      description: t.function.description ?? "",
      parameters: (t.function.parameters ?? {}) as Record<string, unknown>,
    });
  }
  return out;
}

/**
 * 桥接调用（tool_discover / tool_search / tool_describe / tool_call 解析）超时上限。
 * 桥接只做检索与参数解析（真实工具执行另有 TOOL_TIMEOUT 竞速），但底层走
 * 桥接为纯进程内检索（毫秒级），此超时仅为极端情况下的兜底保险。
 * 默认 70s，env TOOL_BRIDGE_TIMEOUT_MS 可调。
 */
function resolveToolBridgeTimeoutMs(): number {
  const n = Number.parseInt(process.env.TOOL_BRIDGE_TIMEOUT_MS ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : 70_000;
}

function executeBridgeWithTimeout(
  bridgeName: string,
  args: Record<string, unknown>,
  catalog: Parameters<typeof executeBridge>[2],
  residentTools?: ResidentToolInfo[],
): Promise<Awaited<ReturnType<typeof executeBridge>>> {
  const timeoutMs = resolveToolBridgeTimeoutMs();
  return new Promise<Awaited<ReturnType<typeof executeBridge>>>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`tool bridge timeout: ${bridgeName} exceeded ${timeoutMs}ms`));
    }, timeoutMs);
    executeBridge(bridgeName, args, catalog, residentTools).then(
      (result) => {
        clearTimeout(timer);
        resolve(result);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * 工具真实超时错误（阶段0-2 修复）。
 * 此前 attemptExec 的 catch 会把任何异常都包装成 timeout: true——工具 handler 内部
 * 抛出的真实故障被谎报为「执行超时」并因此跳过重试。现在超时只由这个类型化错误
 * 表示，其余异常如实透传。
 */
class ToolExecutionTimeoutError extends Error {
  readonly isToolExecutionTimeout = true as const;
  constructor(toolName: string, timeoutMs: number) {
    super(`工具 "${toolName}" 执行超时 (${timeoutMs}ms)`);
    this.name = "ToolExecutionTimeoutError";
  }
}

export function isToolExecutionTimeoutError(err: unknown): err is ToolExecutionTimeoutError {
  return (
    err instanceof ToolExecutionTimeoutError ||
    (typeof err === "object" && err !== null && (err as { isToolExecutionTimeout?: boolean }).isToolExecutionTimeout === true)
  );
}

/**
 * 超时残留执行守卫（阶段0-1 修复）。
 * 超时 race 返回后底层工具仍在跑（handler 无 AbortSignal 可取消），此时并发限制器
 * 的信号量已释放——desktop./browser./phone. 等单飞域若立刻放行下一个调用，会与
 * 残留执行并发，破坏互斥。守卫让后续同工具调用先等待残留落定（带上限，防真挂死
 * 永久阻塞）。key = 注册表工具名。
 */
const OVERRUN_GUARD_WAIT_CAP_MS = 60_000;
const overrunToolGuards = new Map<string, Promise<void>>();

/**
 * 预算击杀后的「越界任务」守护：被杀工具仍在后台跑，注册它以便下一轮同工具调用先
 * 等它收尾（避免并发重入），并在**它真正落定时**打一条自证日志。
 *
 * 这条日志是「预算不够 vs 能力不行」的判定锚点（2026-10-12 行程卡缺席事故）：
 * 击杀瞬间只能知道「撑满了预算」，真实耗时要等后台任务落定才知道 ——
 * `实际=56674ms 预算=30000ms` 一出，结论就是「上调预算」而不是「工具坏了」。
 * 此前守卫只是静默删除，这层证据完全缺失，bug 因此藏了半个月。
 */
function registerOverrunGuard(
  toolName: string,
  toolPromise: Promise<unknown>,
  startedAt: number,
  budgetMs: number,
): void {
  const finalize = (outcome: "ok" | "fail") => {
    overrunToolGuards.delete(toolName);
    const actual = Date.now() - startedAt;
    const over = actual - budgetMs;
    try {
      console.warn(
        `[tool-budget] 击杀后真实完成 tool=${toolName} 实际=${actual}ms 预算=${budgetMs}ms ` +
          `超出=+${over}ms 结果=${outcome}` +
          (over > 0
            ? ` → 预算不足（非执行失败）：请上调技能声明 timeoutMs 或本文件的分级档`
            : " → 预算实际够用，击杀由调度抖动/去重等待造成，观察即可"),
      );
    } catch {
      /* 遥测失败静默 */
    }
  };
  const guard = toolPromise.then(
    () => finalize("ok"),
    () => finalize("fail"),
  );
  overrunToolGuards.set(toolName, guard);
}

async function awaitOverrunGuardIfAny(toolName: string): Promise<void> {
  const guard = overrunToolGuards.get(toolName);
  if (!guard) return;
  await Promise.race([
    guard,
    new Promise<void>((resolve) => {
      const t = setTimeout(resolve, OVERRUN_GUARD_WAIT_CAP_MS);
      // 守卫等待不阻塞进程退出
      t.unref?.();
    }),
  ]);
}

/**
 * 截断 JSON 的最小修复（阶段0-3）：模型输出被 max_tokens/网络截断时 arguments
 * 常是半截对象（如 `{"query": "天气` ）。按字符串/括号嵌套状态补齐引号与闭合符。
 * 只做尽力而为；修复失败由调用方走「参数不合法→让模型重发」的可恢复路径。
 * （导出仅供单元测试）
 */
export function tryRepairTruncatedJsonObject(raw: string): Record<string, unknown> | null {
  const s = raw.trim();
  if (!s.startsWith("{")) return null;
  let inString = false;
  let escaped = false;
  const stack: string[] = [];
  for (const ch of s) {
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{" || ch === "[") stack.push(ch);
    else if (ch === "}" || ch === "]") stack.pop();
  }
  let candidate = s;
  if (inString) candidate += '"';
  // 孤键截断（如 {"query": 后无值、或 "key" 后无冒号）补不齐合法值，
  // 交给下方 JSON.parse 自然判负 → 走「让模型重发」路径，不给脏参数
  for (let i = stack.length - 1; i >= 0; i--) candidate += stack[i] === "{" ? "}" : "]";
  try {
    const parsed: unknown = JSON.parse(candidate);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

/** 工具参数不合法时回填给 LLM 的可恢复错误（结构化 code + 自愈指引）。 */
function buildArgsMalformedResult(
  toolName: string,
  rawSnippet: string,
): { ok: false; result: Record<string, unknown> } {
  return {
    ok: false,
    result: {
      error:
        `工具 ${toolName} 的 arguments 不是合法 JSON（常见原因：模型输出被截断或格式错误）。` +
        `请重新完整调用 ${toolName}，确保 arguments 是一个合法的 JSON 对象后再执行。`,
      errorCode: UnifiedErrorCode.ToolArgsMalformed,
      rawArgsSnippet: rawSnippet.slice(0, 120),
    },
  };
}

/**
 * 失败工具结果的强约束 reminder。
 *
 * 为什么需要：LLM 在面对 user 期待型请求（如"打开微信"）时，训练倾向会让它
 * 即使看到 ok:false 的 tool result 也对用户宣称"已打开"，造成"假成功"。
 * 这里在 tool result content 后追加一条 system 级强约束，让 LLM 必须如实承认失败。
 *
 * P2 升级（2026-07-14）：
 * - 从硬编码 desktop.open 单例，改为调 tool-metadata.buildRecoveryHint，
 *   覆盖所有有 alternatives 的工具（desktop/web/shopping 等）。
 * - desktop.open 保留原有的兜底路径建议（跨盘符扫描/截图确认）。
 *
 * 设计原则：
 * - 仅对"用户易感知成败"或"有确定性替代"的工具生效
 * - 文案直白：禁止宣称成功 + 引用 error + 给出兜底路径
 * - 不替代 error 字段，是补充提示
 */
function buildToolFailureReminder(toolName: string, content: string): string {
  // 阶段2-2：优先按 JSON 解析 error/errorCode（compactToolOutputForLlm 产出为序列化
  // JSON 文本），解析失败再退回正则。此前纯正则抠 error 字符串，转义字符会截断匹配。
  let errSnippet = "";
  let errorCode = "";
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    if (typeof parsed?.error === "string") errSnippet = parsed.error;
    if (typeof parsed?.errorCode === "string") errorCode = parsed.errorCode;
  } catch {
    const errMatch = content.match(/"error"\s*:\s*"([^"]+)"/);
    if (errMatch) errSnippet = errMatch[1];
  }
  const errText = errSnippet ? errSnippet.slice(0, 120) : "见上方 error 字段";
  const code = classifyToolFailure(
    errorCode || errSnippet ? { error: errSnippet, errorCode: errorCode || undefined } : undefined,
  );
  // 结构化错误码前缀：LLM 提示与 metrics 共用一套词汇（TOOL_TIMEOUT / TOOL_DENIED / …）
  const codeTag = errorCode || code !== "TOOL_EXECUTION_FAILED" ? `[${errorCode || code}] ` : "";

  // 行程规划失败兜底（2026-10-12 贵阳轮实证）：travel.plan-itinerary 既无替代工具、
  // 也不在 HONEST_FAILURE_TOOLS，此前返回空提示——模型收到裸失败后自行手写逐日
  // 行程（markdown 原文直穿气泡：未经形态路由所以既没有卡片也没有地图），行程卡
  // 整轮缺席。此处明确禁止手写，要求如实报「规划未完成」并给出可重试的下一步。
  if (toolName === "travel.plan-itinerary") {
    return (
      codeTag +
      "[失败恢复] 本轮行程规划未完成（超时或数据源不可用）。禁止手写或凭记忆编造逐日行程清单、预算表——" +
      "手写内容不生成行程卡与地图，用户点不开也订不了。请如实告知用户规划未完成，并给出可重试的下一步" +
      "（稍后重试、换目的地写法、或补齐天数/偏好），不要宣称已规划好。"
    );
  }

  // 通用恢复提示（覆盖所有有 alternatives / requireHonestFailure 的工具）
  const genericHint = buildRecoveryHint(toolName, errText);
  if (genericHint) {
    // desktop.open 追加原有的具体兜底路径建议
    if (toolName === "desktop.open") {
      return (
        codeTag +
        genericHint +
        `或改用 desktop.open 重试(自动跨盘符扫描)、` +
        `desktop.visual.screenshot 截图确认当前屏幕状态后重试。`
      );
    }
    return codeTag + genericHint;
  }

  // 无 alternatives 且非 honest 的工具：不加提示（fallthrough 到原行为）
  return "";
}

/**
 * 清理消息数组中的孤立 tool 消息（tool_call_id 不匹配任何 assistant 消息的 tool_calls）。
 * 同时清理有 tool_calls 但缺少对应 tool 结果的孤立 assistant 消息。
 * 防止 Kimi/Moonshot 等 API 返回 "tool_call_id is not found" 错误。
 */
/** Moonshot `extra_body.thinking.type === "disabled"` 时须从历史消息中剥离 reasoning_content。 */
export function isThinkingDisabled(extraBody?: Record<string, unknown>): boolean {
  const thinking = extraBody?.thinking as { type?: string } | undefined;
  return thinking?.type === "disabled";
}

function repairMessagesAfterToolCallIdError(
  messages: ChatCompletionMessageParam[],
  stripReasoning: boolean,
): ChatCompletionMessageParam[] {
  const before = messages.length;
  const repaired = sanitizeChatMessagesForApi(messages, {
    stripReasoning,
    logPrefix: "[openai-tool-loop-repair]",
  });
  messages.length = 0;
  messages.push(...repaired);
  if (repaired.length !== before) {
    console.warn(
      `[openai-tool-loop] Repaired message history after tool_call_id error: ` +
      `${before} → ${repaired.length} messages`,
    );
  }
  return repaired;
}

/** Moonshot Kimi 等端点仅允许字母数字下划线连字符，将 registry 名 `a.b` 映射为 `a_b`。 */
function registryNameToApiToolName(name: string): string {
  return name.replace(/\./g, "_");
}

/**
 * 压缩 schema 文本中的冗余空白（换行/缩进→单空格）。无损：description 是给 LLM 看的
 * 自然语言，压缩空白不改变语义，但 JSON 序列化后每轮重复发送的字符数显著下降。
 */
function compactSchemaText(text: string | undefined): string | undefined {
  if (!text) return text;
  return text.replace(/\s+/g, " ").trim();
}

/**
 * 递归压缩 JSON Schema 中所有层级的 description 字符串（只动 description 键，
 * 绝不触碰 name/type/enum/const 等语义值），用于工具 schema 发送前的无损瘦身。
 */
function compactSchemaDescriptions(node: unknown): unknown {
  if (Array.isArray(node)) return node.map((v) => compactSchemaDescriptions(v));
  if (node && typeof node === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      out[k] =
        k === "description" && typeof v === "string"
          ? compactSchemaText(v)
          : compactSchemaDescriptions(v);
    }
    return out;
  }
  return node;
}

export function prepareToolsForChatApi(tools: ChatCompletionTool[]): {
  apiTools: ChatCompletionTool[];
  resolveRegistryToolName: (apiName: string) => string;
  /**
   * 请求卡转正通道：把延迟目录工具转为 API 命名形态并登记映射。
   * 必须用它而不是局部 prepareToolsForChatApi——API→注册表名映射表在循环
   * 启动时由本闭包持有，旁路转换的工具调用回写时解析不回注册表名
   * （E2E 台架 B2 场景实锤：卡加载的 smart_home.control_device 调用报未知工具）。
   */
  registerApiTool: (tool: ChatCompletionTool) => ChatCompletionTool | undefined;
} {
  const apiToRegistry = new Map<string, string>();
  const toApiTool = (tool: ChatCompletionTool): ChatCompletionTool | undefined => {
    if (tool.type !== "function" || !tool.function?.name) return undefined;
    const registryName = tool.function.name;
    const apiName = registryNameToApiToolName(registryName);
    apiToRegistry.set(apiName, registryName);
    return {
      ...tool,
      function: {
        ...tool.function,
        name: apiName,
        description: compactSchemaText(tool.function.description),
        parameters: tool.function.parameters
          ? (compactSchemaDescriptions(tool.function.parameters) as typeof tool.function.parameters)
          : tool.function.parameters,
      },
    };
  };
  const apiTools: ChatCompletionTool[] = [];
  for (const tool of tools) {
    const converted = toApiTool(tool);
    if (converted) apiTools.push(converted);
  }
  return {
    apiTools,
    resolveRegistryToolName: (apiName) => apiToRegistry.get(apiName) ?? apiName,
    registerApiTool: toApiTool,
  };
}

/**
 * 会话级工具面稳定化（排序 + 快照）。tools 数组参与服务端请求前缀哈希，
 * 数组一变（顺序或成员），前缀缓存从 tools 位置整段作废。
 *
 * ## 演进史（别重复踩坑）
 *
 * 1. **2026-10-12 P0 根修**：旧快照只存「名字→序号」，contextual/light 档每轮按
 *    userText 重筛工具集，某个**中间工具落选**即被剔除、其后全部前移 → 前缀从该处
 *    分叉（实盘指纹：跨轮 hit 只有 ~2.2K 或 0，同循环内秒级连发 76-99%；探针证明
 *    同请求连发 MiniMax 命中 ≈100%）。当时的解是**会话级单调并集**：落选工具保留、
 *    新工具只追加尾部。
 *
 * 2. **2026-10-22 修正（本段）**：并集消掉了「中间落选」，但把**每轮域预载**也吸收
 *    进并集 → 工具面在会话内单调膨胀（实测 33 → 38 → 45，schema 13,860 → 19,480
 *    字符）。膨胀本身是次要的，真正代价是**数组每一轮都在变**：分段埋点实测 tools
 *    占进入输入 51.5%（最大单段），而缓存命中率只有 29.8%；同期工具集稳定的评测
 *    会话命中 98.5%。→ 并集只是把「每轮小幅分叉」换成了「每轮持续增长 + 持续分叉」。
 *
 * ## 现行契约（lock 模式，默认）
 *
 * - 首轮把可见集**冻结**为会话基准，此后逐字节复用，**不随本轮检索结果变化**；
 * - 本轮新召回的域预载工具**不进** tools 数组，仍留在延迟目录，经 tool_request
 *   转正（转正是显式 grow，可能是本地模型唯一缺的能力，故不能顺手丢掉）；
 * - `isHidden` 只影响本次返回、**不改快照**（安全闸 / 媒体模态收敛用：等待用户
 *   操作的轮次里外部动作族不能因快照而复现）；
 * - 唯一允许的增长是 `growNames`（请求卡转正、晋升常驻）。一次增长 = 一次前缀
 *   断点，但次数有界（每会话个位数），之后重新稳定。
 *
 * 冻结基准在**被裁剪过的轮次**（纯媒体请求）不建立——否则该会话会永久丢掉网页
 * 检索族。建立失败不致命，下一轮正常轮次再建。
 *
 * 回滚：`AGENT_TOOL_FACE=union` 恢复旧的单调并集（行为等价于 2026-10-12 版本）。
 * 作用域：只有前台对话车道（main_chat*）走 lock；任务/计划车道每步工具面本就
 * 不同，冻结会直接切断多步执行，那里继续走并集。
 */
export type SessionToolFaceMode = "lock" | "union";

/** 工具面模式（默认 lock）。 */
export function resolveToolFaceMode(): SessionToolFaceMode {
  const raw = process.env.AGENT_TOOL_FACE?.trim().toLowerCase();
  return raw === "union" || raw === "legacy" ? "union" : "lock";
}

/** lock 作用域：前台对话车道。任务面 stage 一律不走（见上方说明）。 */
const TOOL_FACE_LOCK_STAGES: ReadonlySet<string> = new Set(["main_chat", "main_chat_tools"]);

export function isToolFaceLockStage(stage: string | undefined): boolean {
  return TOOL_FACE_LOCK_STAGES.has(stage?.trim() || "main_chat_tools");
}

export interface SessionToolFaceOptions {
  /** 缺省取 {@link resolveToolFaceMode}。 */
  mode?: SessionToolFaceMode;
  /** 允许吸收进会话基准的增量工具名（请求卡转正 / 晋升常驻）。仅 lock 模式生效。 */
  growNames?: ReadonlySet<string>;
  /** 本轮隐藏谓词（安全闸 / 模态收敛）。**不改快照**，只作用于本次返回。 */
  isHidden?: (name: string) => boolean;
  /** 本轮能否建立会话基准（false = 本轮工具面是被裁剪过的，不建）。缺省可建。 */
  allowFreeze?: boolean;
}

const SESSION_TOOLS_UNION_MAX = 48;
type SessionToolSnapshot = { tools: ChatCompletionTool[]; byName: Map<string, number> };
const SESSION_TOOL_ORDER = new Map<string, SessionToolSnapshot>();
const SESSION_TOOL_ORDER_MAX = 128;

function apiToolNameOf(tool: ChatCompletionTool): string {
  return tool.type === "function" ? (tool.function?.name ?? "") : "";
}

function sortedByName(tools: ChatCompletionTool[]): ChatCompletionTool[] {
  return [...tools].sort((a, b) => apiToolNameOf(a).localeCompare(apiToolNameOf(b)));
}

function snapshotOf(tools: ChatCompletionTool[]): SessionToolSnapshot {
  return { tools, byName: new Map(tools.map((t, i) => [apiToolNameOf(t), i])) };
}

function applyHidden(
  tools: ChatCompletionTool[],
  isHidden: ((name: string) => boolean) | undefined,
): ChatCompletionTool[] {
  if (!isHidden) return tools;
  const kept = tools.filter((t) => !isHidden(apiToolNameOf(t)));
  return kept.length === tools.length ? tools : kept;
}

/** 仅供测试使用：清空会话工具序快照 */
export function resetSessionToolOrderForTest(): void {
  SESSION_TOOL_ORDER.clear();
}

/** 导出供测试锁定契约（lock = 首轮冻结；union = 旧单调并集，见上方块注释）。 */
export { stabilizeToolOrderForSession };

function stabilizeToolOrderForSession(
  apiTools: ChatCompletionTool[],
  sessionId: string | undefined,
  opts: SessionToolFaceOptions = {},
): ChatCompletionTool[] {
  const sorted = sortedByName(apiTools);
  const hide = opts.isHidden;
  if (!sessionId) return applyHidden(sorted, hide);

  // LRU 淘汰 + touch（命中也续位，活跃会话不被误逐）
  if (SESSION_TOOL_ORDER.size >= SESSION_TOOL_ORDER_MAX && !SESSION_TOOL_ORDER.has(sessionId)) {
    const oldest = SESSION_TOOL_ORDER.keys().next().value as string | undefined;
    if (oldest !== undefined) SESSION_TOOL_ORDER.delete(oldest);
  }
  const existing = SESSION_TOOL_ORDER.get(sessionId);
  if (existing) {
    SESSION_TOOL_ORDER.delete(sessionId);
  }

  if (!existing) {
    // 被裁剪过的轮次（纯媒体请求）不建基准，否则整会话永久缺网页检索族。
    if (opts.allowFreeze === false) return applyHidden(sorted, hide);
    const snap = snapshotOf(sorted);
    SESSION_TOOL_ORDER.set(sessionId, snap);
    return applyHidden(snap.tools, hide);
  }

  const mode = opts.mode ?? resolveToolFaceMode();

  if (mode === "union") {
    // ── 旧行为（回滚通道）：单调并集，只增不减，超上限整表重置 ──
    const fresh = sorted.filter((t) => !existing.byName.has(apiToolNameOf(t)));
    if (fresh.length === 0) {
      SESSION_TOOL_ORDER.set(sessionId, existing);
      return applyHidden(existing.tools, hide);
    }
    if (existing.tools.length + fresh.length > SESSION_TOOLS_UNION_MAX) {
      const snap = snapshotOf(sorted);
      SESSION_TOOL_ORDER.set(sessionId, snap);
      return applyHidden(snap.tools, hide);
    }
    const tools = [...existing.tools, ...fresh];
    const byName = new Map(existing.byName);
    fresh.forEach((t, i) => byName.set(apiToolNameOf(t), existing.tools.length + i));
    const snap: SessionToolSnapshot = { tools, byName };
    SESSION_TOOL_ORDER.set(sessionId, snap);
    return applyHidden(snap.tools, hide);
  }

  // ── lock：基准即真相。本轮集合只用来识别 growNames 的增量，不参与收缩 ──
  let snap = existing;
  const grow = opts.growNames;
  if (grow && grow.size > 0) {
    const fresh = sorted.filter((t) => {
      const name = apiToolNameOf(t);
      return Boolean(name) && grow.has(name) && !existing.byName.has(name);
    });
    if (fresh.length > 0) {
      if (existing.tools.length + fresh.length > SESSION_TOOLS_UNION_MAX) {
        console.warn(
          `[openai-tool-loop] 会话工具面已达上限 ${SESSION_TOOLS_UNION_MAX}，本次不追加：${fresh
            .map(apiToolNameOf)
            .join(", ")}`,
        );
      } else {
        const tools = [...existing.tools, ...fresh];
        snap = { tools, byName: new Map(tools.map((t, i) => [apiToolNameOf(t), i])) };
        console.info(
          `[openai-tool-loop] 会话工具面 grow +${fresh.length} → ${tools.length}：${fresh
            .map(apiToolNameOf)
            .join(", ")}`,
        );
      }
    }
  }
  SESSION_TOOL_ORDER.set(sessionId, snap);
  return applyHidden(snap.tools, hide);
}

// 强制工具路由（forced tool choice）统一收口到 gateway/forced-tool.ts：
//   1. 显式电话请求 → phone_call_user
//   2. 直接时间/日期/位置问题 → clock_get_current_time（对话面轻量档跳过）
//   3. 时效性事实查询 → search_web
// 注：weather_get_local 已并入进程内延迟目录，由检索召回，不再强制路由。


/** world.* / AIP / 内置联网工具等（不含按会话合并的 Skill function 列表）。结果带模块级缓存。 */
let _builtinToolsCache: ChatCompletionTool[] | null = null;

/** 动态注入的 MCP 工具（由 bootstrap 阶段设置） */
let _mcpChatTools: ChatCompletionTool[] = [];

/** 能力模块依赖（由 bootstrap 阶段设置；为 null 时能力模块工具不并入） */
let _capabilityModuleDeps: CapabilityModuleDeps | null = null;

/** 动态注入的 Brain Center 工具（由 bootstrap 阶段设置；brain 未启用时为空数组） */
let _brainChatTools: ChatCompletionTool[] = [];

/** 动态注入的 Body Center 工具（由 bootstrap 阶段设置；body 未启用时为空数组） */
let _bodyChatTools: ChatCompletionTool[] = [];

/** 动态注入的记忆工具 schema（由 bootstrap 阶段设置；记忆网关未启用时为空数组） */
let _memoryChatTools: ChatCompletionTool[] = [];

/** 注入记忆工具 schema 列表（启动时调用一次；与 setBrainChatTools 对称） */
export function setMemoryChatTools(tools: ChatCompletionTool[]): void {
  _memoryChatTools = tools;
  _builtinToolsCache = null;
}

/** 注入 MCP ChatCompletionTool 列表（启动时调用一次） */
export function setMcpChatTools(tools: ChatCompletionTool[]): void {
  _mcpChatTools = tools;
  // 清除缓存，下次 getBuiltinAgentChatTools 调用会重新构建
  _builtinToolsCache = null;
}

/**
 * 注入能力模块依赖（启动时调用一次）。
 *
 * 注入后：
 *   - {@link getBuiltinAgentChatTools} 会把所有能力模块的 ChatCompletionTool 合并进总列表
 *   - {@link selectRelevantTools} 会把能力模块的 category mappings 合并到关键词分类
 *
 * 与 {@link setMcpChatTools} 类似，调用后清缓存重建。
 */
export function setCapabilityModuleDeps(deps: CapabilityModuleDeps): void {
  _capabilityModuleDeps = deps;
  _builtinToolsCache = null;
}

/**
 * 注入 Brain Center 工具 schema 列表（启动时调用一次）。
 *
 * 仅当 BrainCenter 启用时由 bootstrap 传入 BRAIN_TOOLS；否则保持空数组，
 * brain.* 工具不会出现在 LLM 可见工具列表中。调用后清缓存重建。
 */
export function setBrainChatTools(tools: ChatCompletionTool[]): void {
  _brainChatTools = tools;
  _builtinToolsCache = null;
}

/**
 * 注入 Body Center 工具 schema 列表（启动时调用一次）。
 *
 * 仅当 BodyCenter 启用时由 bootstrap 传入 BODY_CHAT_TOOLS；否则保持空数组，
 * body.* 工具不会出现在 LLM 可见工具列表中。调用后清缓存重建。
 */
export function setBodyChatTools(tools: ChatCompletionTool[]): void {
  _bodyChatTools = tools;
  _builtinToolsCache = null;
}

/**
 * Agent World 对话工具注入：AGENT_WORLD_SOCIAL_ENABLED（默认关闭）时仅注入
 * identity/注册/房间最小集（filterSocialChatTools 过滤 free_market/social/music
 * 社交经济域工具），开启时注入全量 AGENT_WORLD_CHAT_TOOLS，行为与现状一致。
 * 延迟求值：首次构建 builtin 工具集时读取 env（确保 .env 已加载完成）。
 */
function getAgentWorldChatToolsForLlm(): ChatCompletionTool[] {
  return isAgentWorldSocialEnabled()
    ? AGENT_WORLD_CHAT_TOOLS
    : filterSocialChatTools(AGENT_WORLD_CHAT_TOOLS);
}

export function getBuiltinAgentChatTools(): ChatCompletionTool[] {
  if (_builtinToolsCache) return _builtinToolsCache;
  const capabilityModuleTools = _capabilityModuleDeps
    ? getCapabilityModuleChatTools(_capabilityModuleDeps)
    : [];
  _builtinToolsCache = [
    ...getAgentWorldChatToolsForLlm(),
    ...AIP_CHAT_TOOLS,
    ...INFO_WEB_CHAT_TOOLS,
    ...(OBS_PACK_ENABLED ? [OBS_RECALL_CHAT_TOOL] : []),
    ...LIFE_ASSISTANT_CHAT_TOOLS,
    ...WALLET_CHAT_TOOLS,
    ...AGENT_LINK_CHAT_TOOLS,
    ...AGENT_RELAY_CHAT_TOOLS,
    ...CALENDAR_CHAT_TOOLS,
    ...PHONE_CHAT_TOOLS,
    ...VISION_CHAT_TOOLS,
    ...SURFACE_CHAT_TOOLS,
    ...VOICE_CHAT_TOOLS,
    ...CLOCK_CHAT_TOOLS,
    ...INTERNET_INTELLIGENCE_CHAT_TOOLS,
    ...INTEREST_WATCH_CHAT_TOOLS,
    ...LIFE_MANAGE_CHAT_TOOLS,
    ...AGENT_TASKS_CHAT_TOOLS,
    ...RHYTHM_REMINDER_CHAT_TOOLS,
    ...PROACTIVITY_FEEDBACK_CHAT_TOOLS,
    ...AGENT_ACTIVITY_CHAT_TOOLS,
    ...AGENT_UPDATE_IDENTITY_CHAT_TOOL,
    ...AGENT_UPDATE_HOMEPAGE_CHAT_TOOL,
    ...PROACTIVITY_CONFIRM_CHAT_TOOLS,
    ...CARE_REMINDER_CHAT_TOOLS,
    ...WATCH_TRACK_CHAT_TOOLS,
    ...PROFILE_QUERY_CHAT_TOOLS,
    ...GEOFENCE_CHAT_TOOLS,
    ...AGENT_CAPABILITY_QUERY_CHAT_TOOLS,
    ...EMBODIMENT_CHAT_TOOLS,
    ...SMART_HOME_CHAT_TOOLS,
    ...DEVICE_CHAT_TOOLS,
    ...getDesktopVisualChatTools(),
    ...getPhoneBridgeChatTools(),
    ...MESSAGE_HUB_CHAT_TOOL_DEFINITIONS,
    BROWSER_SESSION_LIST_CHAT_TOOL,
    ...SELF_PROGRAMMING_CHAT_TOOLS,
    ...capabilityModuleTools,
    ..._brainChatTools,
    ..._bodyChatTools,
    ..._memoryChatTools,
    ..._mcpChatTools,
  ];
  return _builtinToolsCache;
}

/**
 * 统一清除 builtin 工具缓存。
 *
 * 自我进化装载 / 卸载 Skill 后调用，确保下次 getBuiltinAgentChatTools()
 * 重新构建，新能力立即可见。
 */
export function invalidateBuiltinToolsCache(): void {
  _builtinToolsCache = null;
}

/**
 * 智能工具选择系统：基于用户输入上下文动态筛选相关工具，减少 Token 消耗和模型推理时间
 * 预期效果：减少 60-80% 的工具 Token，首字延迟降低 30-50%
 */

type ToolCategory = 'web' | 'calendar' | 'wallet' | 'social' | 'phone' | 'vision' | 'clock' | 'life' | 'capability' | 'desktop' | 'programming' | 'world' | 'aip' | 'embodiment' | 'smart_home' | 'mcp' | 'image' | string;

interface ToolCategoryMapping {
  category: ToolCategory;
  keywords: string[];
  toolNames: string[];
}

const TOOL_CATEGORY_MAPPINGS: ToolCategoryMapping[] = [
  {
    // 2026-08-29 C 端生活管家强化：补齐热搜/晨报口语关键词，并把 hot_rankings
    // （实时热点榜单工具，注册于 web-tools.ts）纳入本分类工具清单——此前它不在
    // 任何分类映射里，"热搜/吃瓜"命中 web 分类后 hot_rankings 也不会被召回。
    category: 'web',
    keywords: ['搜索', 'search', '网页', 'web', '网址', 'url', '链接', 'link', '查询', 'query', '新闻', 'news', '天气', 'weather', 'fetch', '浏览', 'browse', '导航', 'navigate', '图片', '图像', '照片', 'image', 'photo', '视频', 'video', '对比', '比较', '区别', '查查', '查一查', '搜一下', '八卦', '吃瓜', '爆料', '热搜', '热点', '热榜', '上热搜', '简报', '早报', '晨报', '早安', '今日要点', '近况', '怎么样了', '什么情况'],
    toolNames: ['internet.research', 'internet.live_check', 'internet.verify', 'search_web', 'search_images', 'search_images_batch', 'search_videos', 'fetch_web', 'info.inspect_webpage', 'info.navigate_site', 'hot_rankings']
  },
  {
    // 记忆检索工具化（Letta/MemGPT agentic retrieval 模式）：
    // 长期记忆召回不再只靠系统层注入，LLM 可在 PLAN 阶段自主决定调 brain.recall
    // 按需检索（结果以 tool 消息进上下文，身份隔离天然防串台）。
    // 用户提到记忆类措辞时命中，让 brain.recall / brain.remember 进入可见工具集。
    category: 'memory',
    keywords: ['记得', '回忆', '记忆', '忘了', '忘记', '上次聊', '上回聊', '之前说过', '之前提到', '提过', '聊过', 'remember', 'recall', 'memory'],
    toolNames: ['brain.recall', 'brain.remember']
  },
  {
    // 2026-08-29 C 端生活管家强化：补齐提醒类口语关键词（提醒我/别忘了/到点叫我/
    // 定个闹钟），让对话面轻量档下 reminder.plan / calendar.* 能被可靠召回。
    category: 'calendar',
    keywords: ['提醒', '提醒我', '别忘了', '到点叫我', '定个闹钟', 'reminder', '日程', 'schedule', '日历', 'calendar', '任务', 'task', '定时', 'timer', '闹钟', 'alarm', '计划', 'plan', '会议', 'meeting', '预约', 'appointment', '有空', '空闲', '改期', '冲突'],
    toolNames: ['reminder.plan', 'calendar.create_from_text', 'calendar.create_task', 'calendar.list_tasks', 'calendar.update_task', 'calendar.find_free_slots']
  },
  {
    // 2026-08-29 C 端生活管家强化：补齐支付/记账口语关键词（付钱/买单/代付/缴费/
    // 记账/花了）。注意：钱包域工具有真实资金副作用，只做关键词映射召回，
    // 不做强推（forced tool choice），最终是否调用仍由 LLM 在用户授权语境下决定。
    category: 'wallet',
    keywords: ['钱包', 'wallet', '余额', 'balance', '支付', 'pay', '转账', 'transfer', '充值', 'recharge', '付钱', '买单', '代付', '缴费', '记账', '花了', '消费', 'purchase', '交易', 'transaction', '账单', 'bill', '钱', 'money', '金额', 'amount'],
    toolNames: [
      'wallet.get_balance',
      'wallet.get_transactions',
      'wallet.transfer',
      'wallet.recharge',
      'wallet.purchase',
      'payment.create_order',
      'payment.query_order',
      'alipay.check-wallet',
      'alipay.apply-wallet',
      'alipay.submit-payment',
      'alipay.query-payment',
      'alipay.pay-402',
      'alipay.proxy-trade',
      'alipay.merchant-list',
      'alipay.merchant-order',
    ]
  },
  {
    category: 'social',
    keywords: ['好友', 'friend', '联系人', 'contact', '消息', 'message', '发送', 'send', '接收', 'receive', '请求', 'request', 'agent', 'peer', '中继', 'relay', '配对', 'pair', '未读', '微信', 'wechat', 'qq', '飞书', 'feishu', '短信', 'sms', '有人找', '回消息', '看消息', '查收'],
    toolNames: ['world.link.list_friends', 'world.link.list_friend_requests', 'world.link.send_friend_request', 'world.link.respond_friend_request', 'world.link.send_message', 'messages.overview', 'messages.list_conversations', 'messages.read_conversation', 'messages.reply', 'messages.mark_read', 'messages.suggest_reply', 'wechat.login_qr', 'wechat.login_check']
  },
  {
    category: 'phone',
    keywords: ['电话', 'phone', '拨打', 'call', '虚拟号', 'virtual', '号码', 'number', '通话', 'ring', '来电', 'call'],
    toolNames: ['phone.ensure_my_number', 'phone.call_user']
  },
  {
    category: 'vision',
    keywords: ['图像', 'image', '图片', 'picture', '视觉', 'vision', '摄像头', 'camera', '截图', 'screenshot', '画面', 'frame', '拍照', 'photo', '识别', 'recognize', '看', 'see', '观察', 'observe'],
    toolNames: ['vision.http_pull', 'vision.periodic_start', 'vision.periodic_stop', 'vision.periodic_stop_all', 'vision.periodic_list']
  },
  {
    category: 'voice',
    keywords: ['语音', 'voice', '说话', 'speak', '播报', '朗读', '读出来', '说出来', '听', 'listen', '转写', 'transcribe', '识别语音', 'asr', 'tts', '发声', '开口', '说一声', '念', '朗读', '录音', 'audio'],
    toolNames: ['voice.speak', 'voice.send_message', 'voice.transcribe']
  },
  {
    category: 'clock',
    keywords: ['时间', 'time', '日期', 'date', '时钟', 'clock', '现在', 'now', '当前', 'current', '几点', 'what time', '今天', 'today', '星期', 'week', '时区', 'timezone', 'timestamp', '时间戳'],
    toolNames: ['clock.get_current_time', 'clock.get_user_location', 'clock.get_date', 'clock.format_timestamp']
  },
  {
    category: 'life',
    keywords: ['预算', 'budget', '计算', 'calculate', '购物', 'shopping', '建议', 'suggest', '比价', 'compare', '推荐', 'recommend', '生活', 'life', '助手', 'assistant'],
    toolNames: ['budget.calculate', 'shopping.suggest']
  },
  {
    // 兴趣话题追踪：用户表达长期关注（喜欢/粉丝/常看/关注）时命中 interest.manage
    category: 'life',
    keywords: ['喜欢', 'like', '粉丝', 'fan', '关注', 'follow', '常看', '常聊', '感兴趣', 'interest', '追', '热榜', '热搜', '热点', '动态', 'updates'],
    toolNames: ['interest.manage']
  },
  {
    // Task 20 统一频控框架：用户对主动提醒/推送表达负反馈（别再提醒/别推了/
    // 太烦了）时命中 proactivity.feedback，LLM 调它写入持久抑制表。
    category: 'life',
    keywords: ['别再提醒', '别提醒', '不要提醒', '别再推', '别推', '别发了', '别再发', '别打扰', '不打扰', '太烦了', '烦死了', '安静点', '别唠叨', '别再给我', '退订', 'unsubscribe', 'suppress'],
    toolNames: ['proactivity.feedback']
  },
  {
    // Task 17 人情关系管家：提到生日/纪念日/重要日子时召回录入与查询工具
    category: 'life',
    keywords: ['生日', 'birthday', '纪念日', '周年', '重要日子', '重要日期', '谁要过生日', '记住这个日子'],
    toolNames: ['care.set_important_date', 'care.get_important_dates', 'care.delete_important_date']
  },
  {
    // 生活模型（人物关系）：用户提到家人/伴侣/朋友/同事/宠物等社会关系，
    // 或问「我妹妹叫什么」「谁是我的上司」时召回 life.manage（记住/查询关系）。
    category: 'life',
    keywords: ['妹妹', '姐姐', '哥哥', '弟弟', '老婆', '妻子', '老公', '丈夫', '爸爸', '妈妈', '父母', '儿子', '女儿', '家人', '亲戚', '闺蜜', '发小', '伴侣', '我上司', '我老板', '同事', '同学', '宠物', '我家猫', '我家狗', '我养的', 'family', 'friend', 'colleague', 'relation'],
    toolNames: ['life.manage']
  },
  {
    // 统一盯梢：用户想长期盯着某件事被主动告知时召回 watch.track
    category: 'life',
    keywords: ['帮我盯着', '盯住', '盯着点', '帮我盯着点', '持续跟踪', '帮我蹲', '降价', '降到', '打折了叫我', '便宜了叫我', '有消息了叫我', '一有动静', 'watch'],
    toolNames: ['watch.track']
  },
  {
    // 方案 D 溯源作废：用户否认说过/要求删除记忆时召回 memory.invalidate
    category: 'life',
    keywords: ['我没说过', '我没有说过', '当我没说', '记错了', '那条记忆', '删掉记忆', '作废', '那条信息是错的', '我不是那个意思', 'invalidate'],
    toolNames: ['memory.invalidate']
  },
  {
    // Task 19 健康关怀：健康数据确定性统计问答（这周跑了几次步/步数/睡眠）
    category: 'life',
    keywords: ['跑步', '跑了几次', '跑了多少', '步数', '步行', '锻炼', '健身', '运动量', '运动了几天', '睡眠时长', '体重', '健康数据', 'health'],
    toolNames: ['health.query']
  },
  {
    // Task 19 节律提醒：喝水/睡觉/运动预设模板开关（默认不创建，用户明说才开）
    category: 'life',
    keywords: ['喝水', '饮水', '睡觉提醒', '早睡提醒', '运动提醒', '节律', '久坐', '起来活动'],
    toolNames: ['care.rhythm_reminder']
  },
  {
    // Task 18 管家任务闭环：任务状态查询（我还有什么待办/之前的任务跑完了吗）
    category: 'life',
    keywords: ['待办', '还有什么任务', '任务列表', '任务进度', '跑完了吗', '进行到哪', '任务状态'],
    toolNames: ['agent.tasks.list']
  },
  {
    // 代办足迹执行类上报：用户让 Agent 办事（订/买/缴/改/约/代发）的轮次里
    // 暴露 activity.report，办完后模型自主调用落一条执行类条目（右侧「代办足迹」卡）
    category: 'life',
    keywords: ['帮我订', '帮我买', '帮我缴', '帮我约', '帮我改', '代购', '代订', '代办', '订牛奶', '缴水电', '交水电', '帮我发消息', '订花', '订餐', '挂号', '足迹'],
    toolNames: ['activity.report']
  },
  {
    category: 'capability',
    keywords: ['能力', 'capability', '功能', 'function', '能做什么', 'can you do', '帮助', 'help', '技能', 'skill', '工具', 'tool', '介绍', 'introduce', '说明', 'explain'],
    toolNames: ['agent.query_capabilities']
  },
  {
    category: 'embodiment',
    keywords: ['身体', '移动', '动一动', '走动', '逛逛', '漫游', '球形', '机器人', '挪', '飞', '兴奋', '表情', 'roam', 'move', 'body', 'embodiment'],
    toolNames: ['embodiment.observe', 'embodiment.window_place', 'embodiment.roam', 'embodiment.move', 'embodiment.stop', 'embodiment.set_state', 'embodiment.excite', 'embodiment.window_roam']
  },
  {
    // Body Center 器官层：让用户问"身体器官 / 大脑结构 / 我有哪些身体能力"时能命中 body.* 工具
    category: 'body',
    keywords: [
      '身体器官', '器官', '大脑结构', '大脑', 'brain', '身体结构', '身体能力', '身体模块',
      '我有哪些身体', '我有什么身体', '我的身体', '我在哪台设备', '我在哪里渲染',
      '眼', '耳', '皮肤', '前庭', '稳态', '反射', 'eye', 'ear', 'skin',
      '电量', 'battery', '算力配额', '负载', '疲劳度', 'fatigue',
      'body.list_modules', 'body.where_am_i', 'body.state', 'body.calibrate',
    ],
    toolNames: ['body.list_modules', 'body.where_am_i', 'body.state', 'body.calibrate']
  },
  {
    category: 'desktop',
    keywords: [
      '桌面', 'desktop', '电脑', 'computer', '屏幕', 'screen', '自动化', 'automation', '控制', 'control',
      '操作', 'operate', '点击', 'click', '键盘', 'keyboard', '鼠标', 'mouse', '截屏', '截图', '操控',
      '打开浏览器', '浏览器',
      // 2026-07-13 新增：让 LLM 在「打开微信 / 启动应用 / 发消息 / 跑命令」等场景下能命中 desktop 工具
      '打开', 'open', '启动', 'launch', '运行', 'run', '应用', 'app', '程序', 'program',
      '微信', 'wechat', 'qq', '抖音', 'douyin', '钉钉', 'dingtalk', '飞书', 'feishu', 'lark',
      '窗口', 'window', '按钮', 'button', 'uia', 'uia_query', '控件', 'control_',
      'cmd', 'powershell', 'bash', 'shell', '终端', 'terminal', '命令行',
    ],
    toolNames: [
      'desktop.visual.screenshot',
      'desktop.visual.run_task',
      'desktop.open',
      'desktop.run_preset',
      'desktop.run_shell',
      'desktop.uia_query',
    ],
  },
  {
    category: 'programming',
    keywords: ['编程', 'program', '代码', 'code', '开发', 'develop', '自我', 'self', '优化', 'optimize', '改进', 'improve', '修复', 'fix', 'bug', 'debug'],
    toolNames: [] // self-programming tools are dynamic
  },
  {
    category: 'world',
    keywords: ['世界', 'world', '社交', 'social', '市场', 'market', '点数', 'points', '积分', 'score'],
    toolNames: [] // agent world tools are dynamic
  },
  {
    category: 'aip',
    keywords: ['提案', 'proposal', '联盟', 'alliance', '冲突', 'conflict', '协议', 'protocol', 'aip', '投票', 'vote', '交易', 'trade'],
    toolNames: [] // aip tools are dynamic
  },
  {
    category: 'smart_home',
    keywords: ['灯', '灯光', '开关', '空调', '温度', '窗帘', '传感器', '设备', '家电', '家居', '智能', 'home', 'light', 'climate', 'switch', 'cover', 'sensor', '加热', '取暖', '制冷', 'cool', 'heat', 'fan', '风扇', '湿度', 'humidity', 'brightness', '亮度', '场景', 'scene', '回家', '离家', '晚安'],
    toolNames: ['smart_home.list_devices', 'smart_home.control_device', 'smart_home.scene']
  },
  {
    category: 'mcp',
    keywords: ['微博', 'weibo', '小红书', 'xiaohongshu', 'xhs', '微信', 'wechat', '抖音', 'douyin', 'mcp', '外部工具', 'external tool', '平台', 'platform', '文件', 'file', '读取', 'read', '写入', 'write', '搜索平台', 'platform search'],
    toolNames: [] as string[], // 运行时由 buildToolCategoryMappings() 动态填充
  },
];

/**
 * 构建带动态 MCP 工具名的分类映射。
 * 将已注册的 MCP 工具名注入 mcp 分类的 toolNames，
 * 使关键词筛选阶段能精确命中 MCP 工具（与内置工具行为一致）。
 */
export function buildToolCategoryMappings(
  extraMcpToolNames?: string[],
): typeof TOOL_CATEGORY_MAPPINGS {
  if (!extraMcpToolNames || extraMcpToolNames.length === 0) {
    return TOOL_CATEGORY_MAPPINGS;
  }
  return TOOL_CATEGORY_MAPPINGS.map((mapping) =>
    mapping.category === "mcp"
      ? { ...mapping, toolNames: [...extraMcpToolNames] }
      : mapping,
  );
}

const ALWAYS_INCLUDED_TOOLS = [
  'clock.get_current_time',
  'agent.query_capabilities',
  'phone.call_user',
  // ObservationPack 读回工具：压缩/折叠损失的原文按句柄分页读回（SoL-Pi 借鉴）。
  // 常驻保证会话内 schema 集稳定（不随是否出现归档而抖动，保护前缀缓存）。
  'obs_recall',
  // 接驳下单两件套（travel-upgrade-plan P2，2026-10-18 live e2e 实证）：接驳提醒
  // 确认后的后续轮（「好，就订经济型那单」「确认下单」）文本里没有打车/滴滴关键词，
  // contextual 分类召回不命中 → quote/book 从可见 schema 被裁掉，模型只能幻觉提升
  // 调用或走 tool_call 桥（桥上 ms=0 fail），两阶段确认永远走不通。时点性刚需
  // （错过到站窗口就没意义）必须 1-2 轮内走通，与 weather.get_local 常驻核心同理。
  'ride_hailing.quote',
  'ride_hailing.book',
  // 2026-09-05：escalate 哨兵工具已随车道内升级机制一起删除。
  // search_images 不再常驻：
  //   收敛误触发（2026-08-20，宁缺勿滥）——常驻会让模型在"对话前面搜过图、本轮并
  //   未要图"时仍被勾着调用。改为回落到 contextual 筛选：只有当当前轮用户意图命
  //   web/图片类别时才暴露。若模型未搜图但回复里回显了图片链接，服务端
  //   promoteImageUrlsToMedia 会确定性兜底渲染，不会退回"图显示不出来"。
  // embodiment.* 已在 CORE_TOOL_LIBRARY 的 embodiment tier 整族暴露，每轮必带，
  // 不需要再在此重复声明。
];

function extractKeywords(text: string): string[] {
  const cleaned = text.toLowerCase()
    .replace(/[^\u4e00-\u9fa5a-zA-Z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  
  const words = cleaned.split(' ').filter(w => w.length > 0);
  
  const chineseSegments: string[] = [];
  let currentChinese = '';
  
  for (const char of text) {
    if (/[\u4e00-\u9fa5]/.test(char)) {
      currentChinese += char;
      if (currentChinese.length >= 2) {
        chineseSegments.push(currentChinese);
        currentChinese = currentChinese.slice(1);
      }
    } else {
      currentChinese = '';
    }
  }
  
  return [...new Set([...words, ...chineseSegments])];
}

function detectRelevantCategoriesFrom(
  userText: string,
  mappings: typeof TOOL_CATEGORY_MAPPINGS = TOOL_CATEGORY_MAPPINGS,
): Set<ToolCategory> {
  const keywords = extractKeywords(userText);
  const relevantCategories = new Set<ToolCategory>();
  
  for (const mapping of mappings) {
    const matchCount = mapping.keywords.filter(kw => 
      keywords.some(userKw => 
        userKw.includes(kw) || kw.includes(userKw)
      )
    ).length;
    
    if (matchCount > 0) {
      relevantCategories.add(mapping.category);
    }
  }
  
  return relevantCategories;
}

/**
 * 前台对话面的能力域工具确定性注入（2026-09-19 女性关怀 E2E 发现）。
 *
 * 前台 explicit 白名单只含 task.dispatch / search_web 等基础设施（见
 * agent-core.ts getForegroundChatToolWhitelist），其余工具全部依赖模型自觉
 * 调 tool_discover 召回——轻量模型（deepseek-flash 实测）不会主动调，导致
 * 「记录经期 / SOS / 借口来电」等关键词命中的能力域在话面上完全不可达。
 *
 * 本函数在用户文本命中能力域分类关键词时，返回该域的工具 schema 供前台
 * 白名单合并注入（与 selectRelevantTools 的 category 机制同源，只取能力域，
 * 不含基础/MCP 工具）。注入≠调用：模型仍自行决定是否调用。
 */
export function selectForegroundCapabilityToolAdditions(
  userText: string | undefined,
): ChatCompletionTool[] {
  if (!userText?.trim() || !_capabilityModuleDeps) return [];
  const capabilityModuleMappings = getCapabilityModuleCategoryMappings(_capabilityModuleDeps).map(
    (m) => ({
      category: m.category as ToolCategory,
      keywords: m.keywords,
      toolNames: m.toolNames,
    }),
  );
  if (capabilityModuleMappings.length === 0) return [];
  const relevantCategories = detectRelevantCategoriesFrom(userText, capabilityModuleMappings);
  if (relevantCategories.size === 0) return [];

  const wanted = new Set<string>();
  for (const mapping of capabilityModuleMappings) {
    if (!relevantCategories.has(mapping.category)) continue;
    mapping.toolNames.forEach((name) => wanted.add(name));
  }
  if (wanted.size === 0) return [];
  // 单轮注入上限：防关键词宽泛的域（如 health）把 schema 预算打爆。
  // 排序上安全/生理域置顶（E2E 实测：宽泛词如「通知/打车」会把 email_sms、
  // shopping 等域的前景工具塞满上限，把 safety 挤出窗口——紧急域不可被挤掉）。
  const MAX_INJECTED = 14;
  const priority = (name: string): number => (name.startsWith("safety.") ? 0 : name.startsWith("period.") ? 1 : 2);
  const injected = getCapabilityModuleChatTools(_capabilityModuleDeps)
    .filter(
      (t) =>
        t.type === "function" &&
        t.function?.name &&
        wanted.has(t.function.name),
    )
    .sort((a, b) => {
      const an = a.type === "function" ? a.function.name : "";
      const bn = b.type === "function" ? b.function.name : "";
      return priority(an) - priority(bn);
    })
    .slice(0, MAX_INJECTED);
  if (injected.length > 0) {
    console.log(
      `[foreground-tools] 关键词命中，注入能力域工具: ${injected
        .map((t) => (t.type === "function" ? t.function.name : ""))
        .join(", ")}`,
    );
  }
  return injected;
}

export function selectRelevantTools(
  userText: string,
  allTools: ChatCompletionTool[],
  options?: {
    minTools?: number;
    maxTools?: number;
    includeAlwaysIncluded?: boolean;
    tokenBudget?: number;
  }
): ChatCompletionTool[] {  const minTools = options?.minTools ?? 5;
  const maxTools = options?.maxTools ?? 20;
  const includeAlwaysIncluded = options?.includeAlwaysIncluded ?? true;

  // 从 allTools 中提取 MCP 工具名，动态注入分类映射
  const mcpToolNames = allTools
    .filter((t) => {
      const fn = (t as { function?: { name?: string } }).function;
      return Boolean(fn?.name?.startsWith("mcp."));
    })
    .map((t) => (t as { function: { name: string } }).function.name);
  const baseCategoryMappings = buildToolCategoryMappings(mcpToolNames);

  // 合并能力模块注入的分类映射（如 image / file_doc / email_sms 等）
  const capabilityModuleMappings: ToolCategoryMapping[] = _capabilityModuleDeps
    ? getCapabilityModuleCategoryMappings(_capabilityModuleDeps).map((m) => ({
        category: m.category as ToolCategory,
        keywords: m.keywords,
        toolNames: m.toolNames,
      }))
    : [];
  const categoryMappings = [...baseCategoryMappings, ...capabilityModuleMappings];

  const relevantCategories = detectRelevantCategoriesFrom(userText, categoryMappings);

  const selectedToolNames = new Set<string>();

  if (includeAlwaysIncluded) {
    ALWAYS_INCLUDED_TOOLS.forEach(name => selectedToolNames.add(name));
  }

  if (isExplicitPhoneCallRequest(userText)) {
    selectedToolNames.add("phone.call_user");
  }

  for (const mapping of categoryMappings) {
    if (relevantCategories.has(mapping.category)) {
      mapping.toolNames.forEach(name => selectedToolNames.add(name));
    }
  }
  
  const filteredTools = allTools.filter((tool) => {
    if (tool.type !== "function" || !("function" in tool) || !tool.function?.name) return false;
    return selectedToolNames.has(tool.function.name);
  });
  
  if (filteredTools.length < minTools) {
    // 兜底补充工具：按"通用工具优先级"排序，而非按 allTools 原始拼接顺序
    // 避免命中很少时（如"在吗"）塞进与意图无关的工具
    const FALLBACK_PRIORITY = [
      "clock.get_current_time",
      "agent.query_capabilities",
          "search_web",
      "calendar.list_tasks",
      "wallet.get_balance",
      "phone.call_user",
    ];
    // 兜底填充黑名单：记忆工具（brain.recall/brain.remember）只能由 memory 分类
    // 关键词召回（用户显式提及记忆时）。若经兜底混进低意图轮次（如"你确定？"），
    // LLM 可能自发调用 brain.recall → 跨会话记忆灌回任务轮（串台回归向量）。
    const PADDING_EXCLUDED_TOOLS = new Set(["brain.recall", "brain.remember"]);
    const remainingTools = allTools.filter((tool) => {
      if (tool.type !== "function" || !("function" in tool) || !tool.function?.name) return false;
      if (PADDING_EXCLUDED_TOOLS.has(tool.function.name)) return false;
      return !selectedToolNames.has(tool.function.name);
    });
    // 优先级排序：FALLBACK_PRIORITY 中的按顺序排前，其余保持原序
    const priorityRank = new Map(FALLBACK_PRIORITY.map((name, idx) => [name, idx]));
    const sortedRemaining = remainingTools.sort((a, b) => {
      const aName = (a as { function?: { name?: string } }).function?.name ?? "";
      const bName = (b as { function?: { name?: string } }).function?.name ?? "";
      const aRank = priorityRank.has(aName) ? priorityRank.get(aName)! : FALLBACK_PRIORITY.length;
      const bRank = priorityRank.has(bName) ? priorityRank.get(bName)! : FALLBACK_PRIORITY.length;
      return aRank - bRank;
    });
    const needed = minTools - filteredTools.length;
    filteredTools.push(...sortedRemaining.slice(0, needed));
  }
  
  if (filteredTools.length > maxTools) {
    // 超限截断：直接取前 maxTools 个（保持类别相关性排序），不再无条件补回
    // search_images。此前这么做是为了"模型多轮里想看图就能用"，但它绕开了
    // contextual 筛选，是"历史搜图上下文导致后续误触发"的来源之一（宁缺勿滥）。
    return filteredTools.slice(0, maxTools);
  }

  return filteredTools;
}

function extractUserTextFromMessages(messages: ChatCompletionMessageParam[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === 'user') {
      if (typeof msg.content === 'string' && msg.content.trim()) {
        return msg.content.trim();
      }
      if (Array.isArray(msg.content)) {
        const textPart = msg.content.find(part => 
          part.type === 'text' && (part as { text?: string })?.text?.trim()
        );
        if (textPart && typeof textPart === 'object' && 'text' in textPart) {
          return (textPart as { text: string }).text.trim();
        }
      }
    }
  }
  return null;
}

/**
 * OpenAI 兼容 Chat Completions：流式输出 + tool_calls 多轮执行（Kimi / OpenAI 共用）。
 */
// ═══════════════════════════════════════════════════════════════════
// Plan-and-Execute 工具编排（2026-08-26 起替代已删除的 ReAct 多轮循环）
//
// 架构（每轮对话最多 3 类 LLM 调用，消除"每轮重发历史 + 全量 schema"的循环开销）：
//   ① PLAN      —— 单次带 schema 的规划调用：LLM 一次性列出本轮需要的全部工具
//                  调用（parallel_tool_calls），不再逐轮"想一步调一步"。
//   ② EXECUTE   —— 系统层并行执行全部 tool_calls，LLM 不参与调度。执行器内置
//                  轮内去重缓存（同工具+同参数只真实执行一次，用完即丢）与
//                  失败确定性重试（非超时失败自动重试 1 次）。
//   ③ SUMMARIZE —— 单次不带 schema 的汇总调用（流式）：工具结果已作为 tool
//                  消息在上下文里，不再重发工具 schema。
//
// 波次（wave）与 replan：
//   - 首个 PLAN 波次执行完毕后，若"全部成功 + 无元工具 + 强制联网已满足 +
//     未用交互式工具"，先做一次「充分性探测」（不带 schema，首行输出
//     NEED_MORE_TOOLS 可升级）；探测通过 → 直接 SUMMARIZE 收尾（2 次调用，
//     token 最省路径）。
//   - 存在失败 / 元工具（tool_search 桥接）/ 交互式工具（浏览器/桌面/代码链路）
//     时，进入带 schema 的 replan 波次（上限 maxRounds，默认
//     PLAN_EXECUTE_MAX_WAVES=4，对话面轻量档 1）：模型基于已有结果继续规划或
//     直接给出最终回答（文本回复即流式返回）。
//   - 波次耗尽仍有未收尾的工具链 → 兜底 SUMMARIZE（失败信息已在 tool 消息中）。
// ═══════════════════════════════════════════════════════════════════

/** 规划波次（plan + replan）默认上限；可用环境变量 PLAN_EXECUTE_MAX_WAVES 调整。 */
const PLAN_EXECUTE_MAX_WAVES_DEFAULT = (() => {
  const raw = Number.parseInt(process.env.PLAN_EXECUTE_MAX_WAVES ?? "", 10);
  return Number.isFinite(raw) && raw >= 1 ? raw : 4;
})();

/** 充分性探测的升级标记：汇总调用首行输出该标记表示"结果不足，需要 replan"。 */
const NEED_MORE_TOOLS_MARKER = "NEED_MORE_TOOLS";

/**
 * 规划/循环内调用的可选输出 token 上限（仅「非思考」模型生效，思考模型的 reasoning
 * 空间不被压缩）。默认**不封顶**：历史上默认 3000，长回复（多来源汇总/攻略排版）会被
 * finish_reason=length 硬截成半句且无人检查，属静默截断。
 * 环境变量 `PLAN_CALL_MAX_OUTPUT_TOKENS` 设正整数可重新启用上限；未设 / 非法 / 0 均
 * 表示不封顶（0 = 显式关闭，旧实现 `raw >= 256` 会把 0 回落成 3000，已修复）。
 */
const PLAN_CALL_MAX_OUTPUT_TOKENS: number | undefined = (() => {
  const raw = Number.parseInt(process.env.PLAN_CALL_MAX_OUTPUT_TOKENS ?? "", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : undefined;
})();

/**
 * 工具环波次是否走非流式请求。**默认流式**（2026-09-28 放流根修）：此前默认非流式
 * ——非思考模型的全部波次（含纯聊天的最终回复）都要整段生成完才一次性返回，前端
 * 无真流式可言（实测 TTFT=总耗时的 84%~92%）。改回流式后 usage（含 prefix cache
 * 计费）由 `stream_options.include_usage` 随流末 chunk 带回，token 审计不受损。
 * 设 `PLAN_NON_STREAMING=1` 可回退旧行为（应急开关）。
 */
const PLAN_NON_STREAMING = process.env.PLAN_NON_STREAMING === "1";


/** replan 历史瘦身：折叠旧波次工具结果时保留的结果要点长度（确定性截断，不经 LLM）。 */
const REPLAN_FOLD_DIGEST_CHARS = 160;

/**
 * 确定性安全截断：普通超长文本按 maxChars 截断；若截断点恰好落在 URL 中间
 * （http(s):// 已开始但未收尾），向后延伸到 URL 结束，避免 replan 规划拿到半截
 * URL 后自行脑补补齐（幻觉来源）。纯字符串操作，不经 LLM。
 */
export function safeTruncateDigest(raw: string, maxChars: number): string {
  if (raw.length <= maxChars) return raw;
  const cut = raw.slice(0, maxChars);
  const urlMatch = cut.match(/https?:\/\/\S*$/);
  if (urlMatch && urlMatch[0].length >= 10) {
    const rest = raw.slice(maxChars);
    const tail = rest.match(/^[^\s"',)}\]]*/);
    if (tail && tail[0].length > 0) {
      return cut + tail[0] + "…";
    }
  }
  return cut + "…";
}

/** summary 历史裁剪：保留最近 N 个用户回合（含其后的全部工具链），丢弃更早纯对话。 */
const SUMMARY_KEEP_USER_TURNS = 4;
/** summary 旧波折叠摘要长度：比 replan 折叠（160）更长，保住跨波对比的关键数据。 */
const SUMMARY_FOLD_DIGEST_CHARS = 400;
/** summary 历史裁剪生效的消息数阈值：短对话不裁剪（避免丢失引用上下文）。 */
const SUMMARY_TRIM_MIN_MESSAGES = 14;
/**
 * 质量保护闸：当前用户消息命中「指代早期对话」的措辞（刚才/上面/之前/继续/深入等）时，
 * 禁止 summary 历史裁剪——模型需要完整历史来消解引用，裁剪会让它失去所指对象、
 * 基于猜测作答（幻觉）。命中的概率不高，命中一次省不了多少 token，宁可保留。
 */
const SUMMARY_TRIM_REFERENCE_CUES =
  /刚才|刚刚|刚说|刚聊|前面|上面|上一条|之前|上次|上一|刚才说|上面说|前面说|继续说|接着|继续|展开|深入|再看|回顾|再说一遍/i;

/**
 * 交互式/自动化工具：结果几乎总是需要模型继续决策下一步（浏览器/桌面/代码/
 * 手机/具身链路）。这类波次不做「充分性探测」——探测大概率升级 replan，
 * 徒增一次无 schema 调用的延迟——直接进入下一轮带 schema 的 replan。
 */
const INTERACTIVE_TOOL_PREFIXES = [
  "agent_browser.",
  "desktop.",
  "code.",
  "phone.",
  "embodiment.",
  "browser.",
];

function isInteractiveToolName(name: string): boolean {
  return INTERACTIVE_TOOL_PREFIXES.some((p) => name.startsWith(p));
}

/** 工具执行结果（executeTool 的返回形状）。 */
type ToolExecOutcome = { ok: boolean; result: Record<string, unknown> };

/** 轮内去重缓存的参数键：对参数做稳定序列化（键排序），语义相同的参数命中同一键。 */
function stableArgsKey(args: Record<string, unknown>): string {
  const keys = Object.keys(args).sort();
  return keys.map((k) => `${k}=${JSON.stringify(args[k] ?? null)}`).join("&");
}

// ─── 执行压力软提示（2026-10-19 P0-B）───────────────────────────────────────
// 拆解不靠路由闸门（闸门是在信息最少的时刻猜复杂度），而靠执行中出现的
// 真实信号：连着做了几步、还在继续。命中时只在工具结果之后追加一条提醒，
// 让模型自己决定要不要把步骤写下来——判断权交给最了解上下文的那一方。
//
// 成本：闲聊轮永远凑不到 3 次工具调用 → 零触发、零 token；复杂轮多出的
// 只是一条几十字的 user 消息，且只发一次。
export const PLAN_NUDGE_THRESHOLD = 3;
const PLAN_NUDGE_TEXT =
  "[系统提示] 这件事已经连着执行了好几步。若还要继续多步，先用 plan.write 把接下来的步骤记下来" +
  "（用户能看见进度、后续也能接着做），再继续；如果马上就办完了，不用写。" +
  "其中需要用户自己动手的步骤（点外卖/购物付款/登录授权/到店取货），用 plan.set_status 置 " +
  "awaiting_confirm 并写清 handoff.instruction——停下来等他做，别替他操作。";

function planNudgeEnabled(): boolean {
  return process.env.PLAN_NUDGE_ENABLED !== "0";
}

/**
 * 尝试追加一条软提示。返回是否真的追加。
 * 已存在 TaskPlan 时不提示（已经在记了，再催就是噪音）。
 */
function tryPushPlanNudge(
  messages: ChatCompletionMessageParam[],
  planKey: string | undefined,
): boolean {
  if (!planNudgeEnabled()) return false;
  if (!planKey) return false;
  try {
    const store = getTaskPlanStore();
    if (!store) return false;
    if (store.get(planKey)) return false;
    messages.push({ role: "user", content: PLAN_NUDGE_TEXT });
    return true;
  } catch {
    return false;
  }
}

/** 判断一条 assistant 消息是否携带 tool_calls。 */
function isAssistantWithToolCalls(m: ChatCompletionMessageParam): boolean {
  if (m.role !== "assistant") return false;
  const calls = (m as { tool_calls?: unknown[] }).tool_calls;
  return Array.isArray(calls) && calls.length > 0;
}

/** 取 assistant tool_calls 的函数名列表（用于折叠摘要的标注）。 */
function assistantToolCallNames(m: ChatCompletionMessageParam): string {
  const calls = ((m as { tool_calls?: Array<{ function?: { name?: string } }> }).tool_calls ?? []).map(
    (c) => c.function?.name ?? "?",
  );
  return calls.length > 0 ? calls.join("/") : "工具";
}

/**
 * replan 历史瘦身：把「早于当前波次」的已完成工具链（assistant tool_calls + 其 tool
 * 回复）折叠为确定性摘要 user 消息，仅保留最近一个波次的完整链。replan 规划只需
 * 「上一步拿到了什么」，不必重发全部细节。折叠是确定性截断（保留工具名 + 结果要点），
 * 不经过 LLM，杜绝幻觉；最终汇总（runSchemaLessSummary）对旧波用更长的摘要预算
 * （SUMMARY_FOLD_DIGEST_CHARS）作答，尽量保住跨波取数需要的关键数据。
 *
 * B2 前缀稳定（2026-09-08）：每条旧链各自折叠为**独立的一条消息**（而非合并成一条
 * 每次重写的汇总）。折叠文本只依赖本链内容 → 一旦生成即逐字节冻结，后续波次
 * 重入时已折叠消息不变（append-only），replan 请求的前缀缓存可命中到「上一波
 * 边界」，不再被合并重写打碎在更早位置。摘要预算跟随 digestChars 参数（summary
 * 传 400，replan 默认 160）。
 *
 * ObservationPack（SoL-Pi 借鉴）：传入 obsIdForToolCall 时，旧链中被归档过的结果
 * 在折叠行尾追加句柄标注（[obs_recall id="obs_N" 可分页读回原文]），replan 模型
 * 需要旧波细节时按句柄读回，不必重新执行原工具。标注只依赖链内容 → 前缀仍冻结。
 */
export function foldOldWaveToolChains(
  msgs: ChatCompletionMessageParam[],
  digestChars: number = REPLAN_FOLD_DIGEST_CHARS,
  obsIdForToolCall?: (toolCallId: string) => string | undefined,
): ChatCompletionMessageParam[] {
  // 定位所有工具链起点；最后一个链 = 当前波次（必须原样保留）
  const chainStarts: number[] = [];
  for (let i = 0; i < msgs.length; i++) {
    if (isAssistantWithToolCalls(msgs[i])) chainStarts.push(i);
  }
  if (chainStarts.length <= 1) return msgs;
  const keepFrom = chainStarts[chainStarts.length - 1];

  const out: ChatCompletionMessageParam[] = [];
  let i = 0;
  while (i < msgs.length) {
    const m = msgs[i];
    if (!isAssistantWithToolCalls(m)) {
      out.push(m);
      i += 1;
      continue;
    }
    // 收集完整链：assistant + 紧随其后的全部 tool 消息
    const chain: ChatCompletionMessageParam[] = [m];
    let j = i + 1;
    while (j < msgs.length && msgs[j].role === "tool") {
      chain.push(msgs[j]);
      j += 1;
    }
    if (i >= keepFrom) {
      // 当前波次链：原样保留
      out.push(...chain);
    } else {
      // 旧波次链：折叠为独立、内容冻结的确定性摘要（URL 安全截断，防止规划拿半截 URL 脑补）
      const names = assistantToolCallNames(m);
      const lines: string[] = [];
      for (const tm of chain.slice(1)) {
        const raw = typeof tm.content === "string" ? tm.content : JSON.stringify(tm.content ?? "");
        const callId = (tm as { tool_call_id?: unknown }).tool_call_id;
        const obsId =
          obsIdForToolCall && typeof callId === "string" ? obsIdForToolCall(callId) : undefined;
        const obsSuffix = obsId ? ` [obs_recall id="${obsId}" 可分页读回原文]` : "";
        lines.push(`- ${names}[结果]: ${safeTruncateDigest(raw, digestChars)}${obsSuffix}`);
      }
      out.push({
        role: "user",
        content: "【历史工具结果摘要（早于当前规划轮，供参考）】\n" + lines.join(""),
      });
    }
    i = j;
  }
  return out;
}

/**
 * summary 历史裁剪：仅保留全部 system 消息 + 最近 N 个用户回合及其后的所有内容
 * （含全部工具链），丢弃更早的纯对话。工具结果永远完整保留，最终回答依赖的真实数据
 * 不丢；短对话（低于阈值）为无操作。若传入的当前用户文本命中「指代早期对话」的措辞，
 * 直接返回原历史（保护引用消解，防止上下文丢失导致的幻觉）。
 */
export function trimHistoryForSummary(
  msgs: ChatCompletionMessageParam[],
  keepUserTurns = SUMMARY_KEEP_USER_TURNS,
  protectUserText?: string,
): ChatCompletionMessageParam[] {
  if (protectUserText && SUMMARY_TRIM_REFERENCE_CUES.test(protectUserText)) {
    return msgs;
  }
  const userIdx: number[] = [];
  for (let i = 0; i < msgs.length; i++) {
    if (msgs[i].role === "user") userIdx.push(i);
  }
  if (msgs.length < SUMMARY_TRIM_MIN_MESSAGES || userIdx.length <= keepUserTurns) {
    return msgs;
  }
  const startIdx = userIdx[userIdx.length - keepUserTurns];
  const head = msgs.slice(0, startIdx).filter((m) => m.role === "system");
  return [...head, ...msgs.slice(startIdx)];
}

/** 单元素 async iterable：把非流式完整响应归一化为一个 chunk 喂给统一 consumer。 */
async function* singleChunkSource(chunk: NormalChatChunk): AsyncGenerator<NormalChatChunk> {
  yield chunk;
}

/**
 * 工具结果充分性提示：明确告诉 LLM「结果已完整」，减少不确定驱动的重复调用。
 */
function buildToolSufficiencyHint(toolName: string, content: string | undefined): string {
  if (!content || content.length < 8) return "";
  // obs_recall 的「充分」语义不同：读回本身就是分页行为，引导按 nextOffset 翻页。
  if (toolName === OBS_RECALL_TOOL_NAME) {
    return "[系统提示] 读回完成。若返回的 nextOffset 不为 null 且还需要后续内容，用该 offset 继续分页；读完即基于原文作答。";
  }
  return (
    `[系统提示] ${toolName} 的结果已完整返回，不要重复同一查询。` +
    `但若这些摘要/片段不足以覆盖用户要的细节（如具体事件经过、正文内容、多主题盘点），` +
    `应继续用 fetch_web / deep_search 深读相关链接，而不是仅凭摘要直接收尾。`
  );
}

/**
 * 照片轮回复方式提示（2026-10-06）：挂在 search_images 成功结果上，在模型读
 * 结果的当下就定住回复形态——轮内直答路径也会被对话面的「搜到结果可充分展开」
 * 许可教成「已确认的/能说的/没查到的」分节盘点（真机事故形态）。每张照片下方
 * 由 image-caption-service 自动附一句画面解读，正文无需逐张复述。
 */
const PHOTO_REPLY_HINT =
  "[系统提示] 回复方式：本轮交付是图片本身，每张照片下方会自动附一句画面解读。" +
  "正文一两句话自然引入即可，不要按主题分节盘点，不要写「已确认的/能说的/没查到的」式小节，也不要逐张复述照片内容。";

/**
 * 剥除正文中的请求卡标记（<tool_request>…</tool_request>）。
 * 静态架构下请求卡已在收尾分支被拦截续波，不会走到这里；legacy 回退模式下
 * 卡片无处理通道，标记会滞留在正文——统一剥除，防止协议标记透出到用户。
 */
function stripRequestCardTags(text: string): string {
  return text.replace(/<tool_request>[\s\S]*?<\/tool_request>/gi, "").trim();
}

export async function streamCompletionWithTools(
  client: OpenAI,
  model: string,
  messages: ChatCompletionMessageParam[],
  onDelta: StreamDeltaHandler,
  ctx: ChatToolExecutionContext,
  options?: {
    /** 规划波次上限（plan + replan 总次数）；fast 场景传 1 */
    maxRounds?: number;
    tools?: ChatCompletionTool[];
    toolSearchSourceTools?: ChatCompletionTool[];
    onAfterToolBatch?: (info: ToolLoopAfterBatchInfo) => void;
    /** Moonshot Kimi：如 `{ thinking: { type: "disabled" } }` */
    extraBody?: Record<string, unknown>;
    /**
     * 路由意图标签（来自 streamOpts.turnIntent，如 action_write）：出口检查
     * 据此确定性拦截"路由判定要动手但模型零工具尝试"的轮次。
     * 2026-09-23 扩面：realtime_lookup / media_retrieval 同样纳入（详见出口检查处）。
     */
    turnIntent?: string;
    /**
     * 本轮是否已注入前置检索证据块（【实时检索结果】）。realtime_lookup 轮
     * 证据已注入时模型零工具直答是**正确行为**（答的就是刚检索的事实），
     * 出口检查据此豁免；未注入时零工具直答才拦截（2026-09-23）。
     */
    turnEvidenceInjected?: boolean;
    /** 路由置信度（观测用，进 turn-trace 便于量化路由误判率） */
    turnRouteConfidence?: number;
    /**
     * 确定性预执行工具调用（2026-10-10，根治「搜图轮时有时无」）。
     *
     * media_retrieval 轮此前把「要不要调 search_images」交给模型现场决定，
     * 决策非确定 → 同一句话时而出图时而零工具直答凭想象描述。与 realtime 的
     * 确定性前置检索同构：路由层判媒体意图 + 代码构造查询词后，循环开场先
     * 真搜一次，结果作为 assistant(tool_calls)+tool 消息对进上下文——模型从
     * 「决策者」降级为「叙述者」，仍可追加细化调用（轮级去重挡同参重复）。
     * 工具不在本轮可见集/查询词为空时跳过（出口闸仍兜底）。
     */
    deterministicToolCalls?: Array<{ name: string; args: Record<string, unknown> }>;
    /**
     * 答案留存（2026-10-13 根修：工具轮的答案不进流式通道）。
     *
     * "after_tool_use"：本轮一旦执行过实质工具，其后所有波次的 content 一律
     * 不再经 onDelta 直推（fullText 照常累积，随返回值交 done 结构化下发）——
     * 答案与卡片同帧呈现，「先流式输出正文 → done 弹卡」的跳变从通道上根除。
     * 调工具前的确认语（先一句话）不受影响（执行发生在其后）。
     * "always"：从第一波就留存（agent-core 前置检索证据轮：检索发生在循环外，
     * 循环看不见，但答案同样基于检索事实、同样配搜索卡，通道契约一致）。
     * 缺省 = 不留存（任务面/子 Agent 等既有流式消费方行为不变）。
     */
    holdAnswer?: "after_tool_use" | "always";
    promptCache?: PrefixCacheRequest;
    requestSystemMessages?: ChatCompletionMessageParam[];
    /** volatile 动态上下文（记忆/时间等），沉底注入到最新 user 消息尾部，保护前缀缓存 */
    tailDynamicContext?: string;
    /** 输出 token 上限（对应 OpenAI 的 max_tokens）；不传则不限制 */
    maxOutputTokens?: number;
    /**
     * 中断信号：透传到循环内每次 LLM 请求（规划轮 + 总结轮）。
     * 用户发新消息 abort 旧轮时，工具分支的流式请求同样会被中断——
     * 此前只有非工具分支传了 signal，工具分支挂死时只能吃满 SDK 默认超时。
     */
    signal?: AbortSignal;
    /** Token 用量审计打点信息（可选，内部自动记录每轮输入/输出） */
    audit?: { sessionId?: string; stage?: LlmAuditStage; planKey?: string };
    /**
     * 允许吸收进会话工具面基准的工具名（注册表名）。缺省空 = 冻结后不再增长。
     *
     * 目前唯一生产来源是「晋升常驻」（近窗成功调用 ≥3 次的延迟工具）：它可能在
     * 会话中途跨过阈值，冻结会把这次晋升关在门外，要等下个会话才生效。请求卡
     * 转正在循环内部自行加入同一集合（见 faceGrowNames）。
     */
    toolFaceGrowNames?: readonly string[];
  },
): Promise<string> {
  const userText = extractUserTextFromMessages(messages) || "";
  // B4 任务面预算缩放：task_plane 阶段按比例收缩每工具结果预算（前台对话面=1 不变）
  const toolBudgetScale = resolveToolBudgetScale(options?.audit?.stage);
  const budgetForTool = (toolName: string): number | undefined => {
    const preset = getToolResultBudget(toolName);
    return preset === undefined ? undefined : Math.round(preset * toolBudgetScale);
  };
  // 2026-08-01 性能优化：从 extraBody 推断 fastProfile（对话面轻量档）。该档
  // system prompt 已注入 currentTime / userLocation / scheduleSnapshot，只影响
  // 波次预算；tool_choice 已统一 auto，不再有请求层强制（2026-10-22）。
  // fastProfile = 对话为主，system prompt 已注入 currentTime / userLocation / scheduleSnapshot，
  // 强制工具调用会多 1 次 round trip，徒增延迟。
  const fastProfile = Boolean(options?.extraBody?.fastProfile === true);
  // ObservationPack（SoL-Pi 借鉴）：大结果句柄存储。传 sessionId 时跨对话轮复用
  // （后续轮可读回此前轮归档的结果），无 sessionId 则本轮独立。
  const obsPack = getObservationPack(options?.audit?.sessionId);
  const maxWaves = Math.max(
    1,
    options?.maxRounds ?? (fastProfile ? 1 : PLAN_EXECUTE_MAX_WAVES_DEFAULT),
  );
  
  // ── handoff 工具面收缩（2026-10-19 根修，docs §10 的落地）──
  // 计划里有一步在等用户自己操作（点外卖/付款/授权）时，**外部动作类工具整族
  // 从工具面消失**——不是 prompt 劝模型"别下单"，而是让它看不见、也调不动。
  // 分级权威源是 security/sensitive-action.ts（act_external），不另造清单。
  //
  // 这不是"每轮都裁"：没有等待步时 handoffBlocking 为 null，工具面原样。
  // 能力损失的出口是显式的：把该步置 skipped/failed 即恢复（prompt 块里已经写了）。
  const planSessionKey = taskPlanKey({
    sessionId: options?.audit?.planKey ?? options?.audit?.sessionId,
  });
  const handoffBlocking = currentBlockingStep(planSessionKey);
  const isHandoffBlockedTool = (name: string): boolean =>
    Boolean(handoffBlocking) && classifyToolSensitivity(name) === "act_external";
  const keepHandoffVisible = (tools: ChatCompletionTool[]): ChatCompletionTool[] =>
    handoffBlocking ? tools.filter((t) => !isHandoffBlockedTool(apiToolNameOf(t))) : tools;

  const mergedRegistryTools = keepHandoffVisible(options?.tools ?? getBuiltinAgentChatTools());
  const handoffFilteredSourceTools = options?.toolSearchSourceTools
    ? keepHandoffVisible(options.toolSearchSourceTools)
    : undefined;
  const toolSearchPrepared = await prepareTools(mergedRegistryTools, handoffFilteredSourceTools);
  const registryTools = toolSearchPrepared.visibleTools;
  const deferredToolCatalog = toolSearchPrepared.deferredCatalog;

  if (toolSearchPrepared.toolSearchActive) {
    console.info(
      `[tool-search] active: core=${toolSearchPrepared.coreToolCount} ` +
        `deferred=${toolSearchPrepared.deferredToolCount} ` +
        `visible=${registryTools.length} (BM25 index cached per turn)`,
    );
  }

  // ── 会话工具面冻结（2026-10-22，替换 10-12 的单调并集）──
  // 旧流程把「本轮可见集」与「会话基准」做并集 → 数组每轮增长且每轮都在变，
  // 前缀缓存从 tools 位置整段作废（实测命中 29.8%；工具集稳定的会话 98.5%）。
  // 新流程：首轮冻结、此后逐字节复用；本轮新召回的域工具留在延迟目录走
  // tool_request。契约与回滚开关见 stabilizeToolOrderForSession 上方注释。
  const faceLocked = isToolFaceLockStage(options?.audit?.stage);
  // 纯媒体轮的工具面被模态收敛裁剪过（网页检索族整族剥离），不能拿来当会话
  // 基准——否则该会话永久丢掉检索能力。这类轮次只借基准、不建基准；已建基准的
  // 会话则在返回时把被裁族隐藏（不改快照，下一轮自动复原）。
  const mediaOnlyTurn = isMediaOnlyRequest(userText);
  // 2026-10-22 根修（search_movies 三样本全挂的真根因）：原实现无条件套
  // filterTextSearchTools——它内部没有媒体轮守卫，导致 search_web/fetch_web/
  // internet.*/info.*/deep_search 在【每一轮】都被藏出可见集，而媒体三件套
  // 反而常在。模型想搜却看不到搜索工具，discover 也召不回（recall 注入的还是
  // 媒体工具），只能空转后如实说「查不到」。修复：藏匿只在真媒体轮生效——
  // 非媒体轮的工具可见性完全交给常驻清单与按需发现，不做输入侧预判剥离。
  const mediaHidden = (name: string): boolean => {
    if (!mediaOnlyTurn || !name) return false;
    const probe: ChatCompletionTool = {
      type: "function",
      function: { name, description: "", parameters: { type: "object", properties: {} } },
    };
    return filterMediaModalityTools(filterTextSearchTools([probe]), userText).length === 0;
  };
  // 允许吸收进基准的增量（请求卡转正会在循环内往同一集合里加名字）。
  const faceGrowNames = new Set<string>(options?.toolFaceGrowNames ?? []);
  const faceOpts: SessionToolFaceOptions = {
    mode: faceLocked ? "lock" : "union",
    growNames: faceGrowNames,
    allowFreeze: !mediaOnlyTurn,
    isHidden: (name) => isHandoffBlockedTool(name) || mediaHidden(name),
  };
  let stableRegistryTools = stabilizeToolOrderForSession(
    registryTools,
    options?.audit?.sessionId,
    faceOpts,
  );
  const { resolveRegistryToolName, registerApiTool } = prepareToolsForChatApi([]);
  const apiFormByRegistry = new Map<string, ChatCompletionTool>();
  for (const rt of stableRegistryTools) {
    const at = registerApiTool(rt);
    if (at) apiFormByRegistry.set(apiToolNameOf(rt) ?? "", at);
  }
  // let：请求卡（tool_request）命中后按会话基准追加转正工具。
  let stableApiTools: ChatCompletionTool[] = stableRegistryTools
    .map((rt) => apiFormByRegistry.get(apiToolNameOf(rt) ?? ""))
    .filter((t): t is ChatCompletionTool => Boolean(t));
  // 首波可见集快照（acquisition 观测基准；不含波间动态转正的请求卡工具）
  const visibleAtStart = new Set(
    stableApiTools
      .map((t) => (t.type === "function" ? resolveRegistryToolName(t.function?.name ?? "") : ""))
      .filter(Boolean),
  );
  if (process.env.PA_TOOL_DEBUG === "1") {
    console.info(
      `[tool-dump] n=${stableApiTools.length} ` +
        stableApiTools.map((t) => (t.type === "function" ? t.function?.name : "")).join(","),
    );
  }
  // ── 调用即发现观测（2026-10-09 L3）──
  // 本轮经桥检索结果面出现过的延迟工具名：模型先 discover 再 call 的名字归
  // "deferred"（常规召回通道）；未检索就直呼的不可见名 = 幻觉转正
  // （hallucination_promoted，registry 层本就放行执行，这里补观测语义）。
  const bridgeSurfacedNames = new Set<string>();
  // L3 错误即检索的语料：用稳定 searchable 源（跨轮签名稳定 → BM25 catalog 缓存友好）
  const recallCorpus = handoffFilteredSourceTools ?? mergedRegistryTools;
  // L5 观测（2026-10-09 五层根修）：本轮召回链注入可见集的工具名（可见集 −
  // 静态 Core − 桥）——离线对账「预载转化率 / 晋升转化率」的基准集合。
  // 2026-10-10 ③：task 车道口径补上 router-first 轻量常驻（TASK_LANE_ROUTER_
  // FIRST_LIGHT_NAMES）——它们是确定性常驻设施，不是召回链注入，混进基准集合
  // 会稀释预载/晋升转化率（reminder.plan 等常驻工具恒"注入恒不调"，假阴性）。
  const laneCoreSet = new Set(
    (options?.audit?.stage ?? "").startsWith("task_plane")
      ? [...TASK_LANE_CORE_NAMES, ...TASK_LANE_ROUTER_FIRST_LIGHT_NAMES]
      : CHAT_LANE_CORE_NAMES,
  );
  const recallInjectedNames = [...visibleAtStart]
    .filter((n) => !laneCoreSet.has(n) && !isToolSearchBridgeName(n))
    .sort();
  const staticToolArch = isStaticToolArchEnabled();
  // ── 轮级 trace 收集（[turn-trace] 一行 JSON，见 turn-trace.ts）──
  const traceStartTs = Date.now();
  const traceToolCalls: ToolCallTraceEntry[] = [];
  const traceCallStartByCallId = new Map<string, number>();
  let traceRequestCard: { fired: boolean; loaded: string[]; blockedRisk?: string[] } | undefined;
  let traceExitGate: { fired: boolean; reason?: string } | undefined;
  let traceWavesUsed = 0;
  let lastAssistantText = "";
  const thinkingDisabled = isThinkingDisabled(options?.extraBody);
  // 累积所有工具调用结果，供 summary 调用时做数据质量评估 + 策略注入
  const allToolExecResults: Array<{
    toolName: string;
    ok: boolean;
    input?: Record<string, unknown>;
    result: Record<string, unknown>;
  }> = [];

  // ── 统一出口自检 TurnOutcomeGate（2026-09-05，话题无关）──
  // 判定不使用任何话题关键词（价格/新闻/媒体词表已随话题路由一起删除）：
  // "这轮是否需要工具"由路由层的语义分类决定，本门只负责事实核查——
  // 任务面轮次结束时有「实质成功的工具结果」才算诉求被满足；
  // 没有成功结果且收尾是道歉式/机制话（风格判定，话题无关）→ 换路续波一次。
  // 置信而答的直答（含模型凭既有知识回答）不拦截，避免空转烧 token。
  /**
   * 派发型成功（2026-10-22 完成语义契约）：工具返回了 ok，但用户要的答案还不存在。
   * 判定只看结果体/工具名，不猜措辞；`queued` 的轮次一律不算「已办完」。
   */
  const isQueuedResult = (r: { toolName: string; result: Record<string, unknown> }): boolean => {
    if ((r.result as { produces?: unknown } | null)?.produces === "queued") return true;
    // 名字兜底：allToolExecResults 存的是 wire 名（API 形态，点号已转下划线，
    // 如 task_dispatch），而 QUEUED_PRODUCER_TOOLS 用的是注册表名。此处归一化后比较。
    const registryName = r.toolName.replace(/_/g, ".");
    return QUEUED_PRODUCER_TOOLS.has(registryName) || QUEUED_PRODUCER_TOOLS.has(r.toolName);
  };
  /**
   * 有实质产出的成功工具数：元工具（能力查询/目录检索）、上下文管线支撑工具（obs_recall）、
   * 失败执行、**派发型（queued）**均不计入——「完成 = 返回了能回答用户的内容」。
   */
  const countSubstantiveOkResults = (): number =>
    allToolExecResults.filter(
      (r) =>
        r.ok &&
        !isQueuedResult(r) &&
        !META_TOOL_NAMES.has(r.toolName) &&
        !SUPPORT_PLUMBING_TOOLS.has(r.toolName),
    ).length;
  // ── 答案留存闸（2026-10-13 根修：工具轮的答案不进流式通道）──
  // 决策点唯一且确定性：本函数是唯一知道「本轮是否执行过工具」的地方。
  // 命中后波内直推（onContentDelta → onDelta → chat.assistant_chunk）对正文
  // 关闸，fullText 照常累积并随返回值交 done 与卡片同帧下发。对账细节见
  // options.holdAnswer 注释。每波求值（工具执行发生在波间，波内恒定）。
  const answerHeld = (): boolean =>
    options?.holdAnswer === "always" ||
    (options?.holdAnswer === "after_tool_use" &&
      allToolExecResults.some((r) => isSubstantiveToolExecution(r.toolName)));
  /** 出口自检：本轮收尾是否「用户诉求未满足」。null = 满足，可正常收尾。 */
  const assessTurnUnsatisfied = (finalText: string): string | null => {
    if (countSubstantiveOkResults() > 0) return null;
    // 派发型成功 ≠ 完成（2026-10-22 完成语义契约）：本轮只把活派出去了，
    // 服务端没有任何 content 类结果。与静态架构的 queued_without_content 同构。
    if (allToolExecResults.some((r) => r.ok && isQueuedResult(r))) {
      return "queued_without_content";
    }
    // 事实判定（话题无关）：任务面轮次尝试过实质工具但零成功 → 诉求未满足。
    // 任务面本身由路由层语义分类选定（声明了能力需求），"有没有真的办成"
    // 只看服务端工具执行结果，不猜话题、不看措辞。
    if (allToolExecResults.length > 0) {
      return "substantive_tools_attempted_but_none_succeeded";
    }
    // 零尝试但用户明确要求外部动作（2026-10-22，事前指定门的替代）：与静态
    // 架构出口闸同构——只看服务端有没有对应工具的执行记录，不看回复措辞。
    // 放在道歉式判定之前：道歉也不能顶替「明确要求的动作」。
    const explicitActionTool = resolveExplicitActionTool(userText);
    if (
      explicitActionTool &&
      !allToolExecResults.some((r) => r.toolName === explicitActionTool) &&
      finalText.trim()
    ) {
      return "explicit_action_no_attempt";
    }
    // 零尝试：仅当收尾是道歉式/机制话（风格判定，天然话题无关）才续波——
    // 置信的知识直答与向用户追问澄清的轮次不拦截，避免空转烧 token。
    if (isApologyStyleFallback(finalText.trim())) {
      return "no_attempt_and_hedged";
    }
    // 「零尝试 + 办事怀疑信号 + 宣称办过」词面判据已于 2026-10-22 删除：
    // 判断「该不该调工具」的权限归模型，服务端只核对账目（有没有 content 结果），
    // 不再用话题词表 + 完成态措辞反推意图。
    return null;
  };
  // 轮内去重缓存：同一工具 + 同一参数在本轮对话内只真实执行一次（用完即丢，
  // 不跨轮持久——跨轮缓存由 ctx.getCachedToolResult 的 TTL 缓存负责）。
  // 值为共享 Promise：同一波内并发出现的相同调用 await 同一个执行（含确定性重试），
  // 消除并行重复执行；失败结果落定后立即摘除，后续 replan 波次仍可重新执行。
  const turnDedupeCache = new Map<string, Promise<ToolExecOutcome>>();
  // 空正文整合兜底（2026-08-29）：模型调完工具只发 tool_calls 就收尾、零正文时，
  // 强制它基于工具结果说人话（而非把工具 JSON 原文糊给用户），只授予一次。
  let narrationEnforced = false;
  // 统一出口自检（2026-09-05 TurnOutcomeGate）：轨迹内「换路续波」只授予一次，
  // 不再区分 fast/complex 车道（2026-09-05 双面架构后只有任务面进工具循环）。
  let outcomeGateEnforced = false;
  // 请求卡（2026-09-19，MCP-Zero 式意图检索）：模型正文输出 <tool_request> 后
  // 由检索层从延迟目录转正工具，每轮最多一次。
  let requestCardUsed = false;
  const requestCardLoadedNames = new Set<string>();
  // 单一出口检查（2026-09-19 静态架构）：一轮最多续波一次。
  let exitGateEnforced = false;
  // 2026-10-22 架构定稿：全项目不再存在任何非 auto 的 tool_choice。
  // 原 forceRequiredNextWave（出口闸授权下一波 required）已彻底删除——
  // Anthropic 明确强制调用会让模型跳过 thinking、把推理挤进参数，
  // 且新模型对 any/tool 直接返 400。续波改为「auto + system 指令点名工具」。
  // 档3 委派引导状态：汇总探测报不足且命中探索型信号 → 向下一次 replan 波次
  // 前缀缓存命中统计（本调用内聚合，结束时打印一行，验证优化前后命中率变化）
  const prefixCacheStats = { hit: 0, miss: 0 };
  const accumulatePrefixCacheUsage = (usage?: NormalUsage) => {
    if (!usage) return;
    if (typeof usage.promptCacheHitTokens === "number") prefixCacheStats.hit += usage.promptCacheHitTokens;
    if (typeof usage.promptCacheMissTokens === "number") prefixCacheStats.miss += usage.promptCacheMissTokens;
  };
  const logPrefixCacheStats = () => {
    const total = prefixCacheStats.hit + prefixCacheStats.miss;
    if (total <= 0) return;
    console.info(
      `[prefix-cache] 本调用聚合: hit=${prefixCacheStats.hit} miss=${prefixCacheStats.miss} ` +
        `hitRate=${((prefixCacheStats.hit / total) * 100).toFixed(1)}%`,
    );
  };

  // 规划引导：Plan-and-Execute 要求模型在单次回复里一次性规划全部工具调用，
  // 减少串行波次（每多一波 = 多一次带 schema 的全量历史重发）。
  // 只在有工具可调时注入，纯对话场景不注入。
  // router-first 车道（可见集=桥+轻量常驻+定向保底族，业务主力在延迟目录）追加
  // 两步走引导：先 discover 后 call。口径收口在 lane-tool-sets.isRouterFirstLaneTurn
  // （轻量常驻子集/桥不计入），单点定义防漂移。
  const routerFirstLane = isRouterFirstLaneTurn(toolSearchPrepared);

  // 域卡（2026-10-01 S1 → 2026-10-22 迁出）：目录已并入 **system 段**
  // （见 abstract-chat-provider 的 domainCardsForTurn 注入点）。原因：挂在这里
  // 是一条轮内 system 消息，位置每轮后移，隐式前缀缓存永远命中不了，等于每轮
  // 全价重发 8.2k 字符；system 段是会话级冻结的，字节稳定才可命中。
  // 这里只保留「工具调用原则」（短、且随车道/任务面变化，无法冻结）。
  if (stableApiTools.length > 0) {
    // 任务面用全量 Plan-and-Execute 研究纪律；对话面瘦身（2026-10-06 治啰嗦 P2-7）：
    // 闲聊/轻查询轮用不到「一次性并行规划/换角度补搜/code.run 分段读」三条例，
    // 常驻注入对短回复是纯下行压力——只保留与对话面工具真正相关的守则。
    const taskStage = (options?.audit?.stage ?? "").startsWith("task_plane");
    const planAndExecuteRules = taskStage
      ? "1. 一次性规划：把本轮需要的所有工具调用放在同一次回复里并行发出（独立的信息需求拆成多个并行调用），不要拆成多轮串行。\n" +
        "2. 不要用完全相同的 query 重复搜索；但对比/多主题/盘点类需求，或首轮结果覆盖不全时，应换角度拆多个 query 补搜，或用 fetch_web / deep_search 深读，把信息收齐再回答，不要急着收尾。\n" +
        "3. code.run 的 stdout/stderr 如果已包含答案，不要重跑同样代码。输出被截断(truncated=true)时，改用 code.write_file 写产物再 code.read_file 分段读，不要重跑。\n"
      : "";
    // 轮内脚手架（2026-10-22）：域卡/守则只在**本轮**有意义，标记后轮末写回会跳过，
    // 否则一份 8,266 字符的域卡会常驻历史、每轮重发（实测 ≈3,200 real tokens/轮），
    // 且位置随历史漂移，跨轮前缀缓存从注入点起整段作废。
    messages.push(
      markTurnScaffold({
        role: "system",
        content:
          "工具调用原则：\n" +
          (routerFirstLane
            ? "0. 本轮业务工具都在延迟目录中（可见的只有 tool_discover）：先用 tool_discover({domain:\"域名\"}) 按上方【能力域目录】拉取该域参数 schema（或 tool_discover({query}) 做语义检索），schema 加载后下一轮直接调用对应工具。发现和执行加起来也在总波次预算内，别一次 discover 完就收尾。\n"
            : "") +
          planAndExecuteRules +
          "4. 拿到工具结果后优先直接回答用户，不要为了「确认」再调一次工具。\n" +
          "5. 图片/照片类需求用 search_images，不要用 search_web 编造图片来源（如 duitang.com 这类假域名）——前端拿不到真实图片。搜到的每张照片会由视觉模型自动生成真实画面描述并展示在照片下方，正文**不要**逐张介绍照片、不要用「第一张图/第二张图」这类指代（你看不见图片内容，写了必然对不上），也不要把图片链接复述进正文；正文只写整体性的结论、建议或补充信息。\n" +
          "6. 如果此前（含更早轮次）就任务细节向用户追问过（目的地/时间/选项/偏好等），而用户本轮给出了答案、确认或补充（哪怕只有几个字如「先去A吧」「就这个」）：不要只回一句「好的/收到/不错」——立即调用对应工具把任务真正完成，拿到结果后再回复用户。只确认不兑现 = 任务失败。" +
          (toolSearchPrepared.toolSearchActive
            ? "\n7. 当可见工具不足以完成任务时，在回复中输出 <tool_request>一句话描述你需要的能力</tool_request>（如 <tool_request>把客厅空调调到26度</tool_request>），系统会从延迟工具目录检索并加载对应工具供你下一轮直接调用（每轮最多一次）。拿到加载的工具后继续完成任务，不要只输出请求标记就停。"
            : ""),
      }),
    );
  }

  // 失败换路预算（2026-09-02）：存在失败的工具执行时，fast 追加 1 波
  // 「换工具重试」预算（如 search_images 失败 → 改 search_web/fetch_web），
  // 不挤占正常收尾预算；complex 波次充裕不追加。总上限 4，防失败循环膨胀。
  // 用闭包函数而非常量：for 条件与波次终止决策读取同一份动态预算（失败发生后生效）。
  const effectiveMaxWaves = (): number =>
    fastProfile ? Math.min(maxWaves + (allToolExecResults.some((r) => !r.ok) ? 1 : 0), 4) : maxWaves;

  // ── 确定性媒体预执行（2026-10-10 根治「搜图轮时有时无」）──
  // 执行器：单次超时竞速（与主路径同源的超时预算与 abort 语义），轮级去重
  // 共享。去重键与主路径同款格式（${toolName}::${argsKey}）——模型 wave 0 发
  // 同参 search_images 时直接复用预执行结果，不重复执行；失败结果落定即摘除
  // 去重键，后续波次仍可重试（与主路径语义一致）。
  const executeDeterministicToolCall = async (
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<ToolExecOutcome> => {
    const dedupeKey = `${toolName}::${stableArgsKey(args)}`;
    const inflight = turnDedupeCache.get(dedupeKey);
    if (inflight) return inflight;
    const TOOL_TIMEOUT_MS = resolveToolExecutionTimeoutMs(toolName);
    const run = (async (): Promise<ToolExecOutcome> => {
      await awaitOverrunGuardIfAny(toolName);
      const callAbort = new AbortController();
      // 击杀自证起点（2026-10-12）：真实耗时由守护在后台落定时上报
      const attemptStartedAt = Date.now();
      const toolPromise = ctx.executeTool(toolName, args, { signal: callAbort.signal });
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          toolPromise,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              callAbort.abort(new ToolExecutionTimeoutError(toolName, TOOL_TIMEOUT_MS));
              console.warn(
                `[tool-budget] 击杀 tool=${toolName} 预算=${TOOL_TIMEOUT_MS}ms（越界任务转后台收尾，真实耗时见同工具落定日志）`,
              );
              registerOverrunGuard(toolName, toolPromise, attemptStartedAt, TOOL_TIMEOUT_MS);
              reject(new ToolExecutionTimeoutError(toolName, TOOL_TIMEOUT_MS));
            }, TOOL_TIMEOUT_MS);
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    })();
    turnDedupeCache.set(dedupeKey, run);
    void run.then(
      (r) => {
        if (!r.ok) turnDedupeCache.delete(dedupeKey);
      },
      () => turnDedupeCache.delete(dedupeKey),
    );
    return run;
  };

  if (options?.deterministicToolCalls?.length && stableApiTools.length > 0) {
    for (let di = 0; di < options.deterministicToolCalls.length; di++) {
      const det = options.deterministicToolCalls[di];
      const detName = String(det?.name ?? "").trim();
      const detArgs = (det?.args ?? {}) as Record<string, unknown>;
      const detQuery = String(detArgs.query ?? "").trim();
      // 2026-10-10 P1 扩面：不再限定 query 形工具——travel.plan-itinerary 收
      // {input,destination,days}，任意非空参数即视为可执行（media/realtime 的
      // query 守卫语义由各自的 args 构造方保证，不受影响）。
      const detHasArgs = Object.values(detArgs).some(
        (v) => v != null && String(v).trim() !== "",
      );
      const apiName = registryNameToApiToolName(detName);
      const registryName = resolveRegistryToolName(apiName);
      // 工具必须在本轮可见集内（能力束裁剪后不可见 = 架构上不允许这轮动它）
      const visible = stableApiTools.some((t) => apiToolNameOf(t) === apiName);
      if (!detName || !visible || (!detQuery && !detHasArgs)) {
        console.info(
          `[openai-tool-loop] 确定性预执行跳过：${detName || "(空)"} visible=${visible} query="${detQuery.slice(0, 40)}" args=${detHasArgs}`,
        );
        continue;
      }
      const detStart = Date.now();
      ctx.onToolExecuteStart?.({ toolName: registryName, input: detArgs });
      let exec: ToolExecOutcome;
      try {
        exec = await executeDeterministicToolCall(registryName, detArgs);
      } catch (e) {
        exec = { ok: false, result: { error: (e as Error)?.message ?? String(e) } };
      }
      const compacted = await compactToolOutputForLlm({
        toolName: registryName,
        ok: exec.ok,
        result: exec.ok ? exec.result : { error: exec.result.error ?? exec.result },
        preferredMaxChars: budgetForTool(registryName),
        stripKeys: getToolResultStripKeys(registryName),
      });
      const detCallId = `det_${traceStartTs}_${di}`;
      // 与模型 tool_calls 相同的消息协议形态：assistant(tool_calls) + tool(result)
      messages.push({
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: detCallId,
            type: "function" as const,
            function: { name: apiName, arguments: JSON.stringify(detArgs) },
          },
        ],
      });
      const fenced = shouldFenceToolContent(registryName)
        ? fenceUntrustedToolContent(registryName, compacted.content)
        : compacted.content;
      const detPhotoHint =
        exec.ok && registryName === "search_images" ? PHOTO_REPLY_HINT : "";
      const detFailureReminder = !exec.ok
        ? buildToolFailureReminder(registryName, compacted.content)
        : "";
      const detHints = [detPhotoHint, detFailureReminder].filter(Boolean).join("\n");
      messages.push({
        role: "tool",
        tool_call_id: detCallId,
        content: detHints ? `${fenced}\n${detHints}` : fenced,
      });
      ctx.onToolExecuted?.({
        toolName: registryName,
        input: detArgs,
        ok: exec.ok,
        result: exec.result,
      });
      allToolExecResults.push({
        toolName: registryName,
        ok: exec.ok,
        input: detArgs,
        result: exec.result,
      });
      const detElapsed = Date.now() - detStart;
      const detBudgetMs = resolveToolExecutionTimeoutMs(registryName);
      traceToolCalls.push({
        name: registryName,
        ok: exec.ok,
        ms: detElapsed,
        budgetMs: detBudgetMs,
        timedOut: inferToolCallTimedOut(exec.ok, detElapsed, detBudgetMs),
        acquisition: "deterministic",
      });
      console.info(
        `[openai-tool-loop] 确定性媒体预执行：${registryName} ok=${exec.ok} ` +
          `ms=${detElapsed}${exec.ok ? "" : ` 预算=${detBudgetMs}ms（贴满即被预算击杀）`} query="${detQuery.slice(0, 40)}"`,
      );
    }
  }


  // 执行压力软提示计数（2026-10-19 P0-B）：本 loop 已执行过的工具调用数 + 有调用的波数
  let loopToolCallCount = 0;
  let wavesWithToolCalls = 0;
  let planNudgeSent = false;

  for (let wave = 0; wave < effectiveMaxWaves(); wave++) {
    traceWavesUsed = wave + 1;
    // 只在真有执行压力时出现：闲聊轮凑不到阈值 = 零触发、零 token。
    // 追加的是普通 user 消息（不改正文、不换稿），下一波自然带上。
    //
    // 判据必须是「串行依赖」而不是「调用个数」（2026-10-19 根修）：多步任务的本
    // 质是后一波依赖前一波结果；一轮里并行 4 个搜索是**一次查询的扇出**，不是四步。
    // 旧判据只看个数，会把「对比三个城市天气」这种单轮查询也催着去写计划。
    if (!planNudgeSent && wavesWithToolCalls >= 2 && loopToolCallCount >= PLAN_NUDGE_THRESHOLD) {
      if (tryPushPlanNudge(messages, planSessionKey)) planNudgeSent = true;
    }
    let retriedToolCallIdError = false;
    let stream: Awaited<ReturnType<OpenAI["chat"]["completions"]["create"]>>;
    // ③/④ 规划轮：非思考模型走非流式（协议更省、usage 确定、防正文烧 token）；
    // 思考模型（deepseek-reasoner 等）保持流式。输出上限默认不设（长回复不会被
    // max_tokens 硬截半句）；调用方显式传 maxOutputTokens 或设了
    // PLAN_CALL_MAX_OUTPUT_TOKENS（正整数）时才封顶。
    const planNonStreaming = PLAN_NON_STREAMING && thinkingDisabled;
    const planMaxTokens: number | undefined = options?.maxOutputTokens
      ? options.maxOutputTokens
      : thinkingDisabled
        ? PLAN_CALL_MAX_OUTPUT_TOKENS
        : undefined;
    // Token 用量审计：本轮发往 LLM 的输入规模（估算）
    let auditInputChars = 0;
    /**
     * 输入分段实测（2026-10-21）：把输入拆成 system / history / tools 三段。
     * 目的只有一个——回答「成本堆在哪一段」，因为瘦身只能砍最大的那一段，
     * 而 tools 与 history 的优化手段完全不同（砍工具 vs 缩历史）。
     * 只在工具循环（main_chat_tools）采集，量可控。
     */
    let auditBreakdown: LlmInputBreakdown | undefined;
    // LLM 计时（2026-09-28 延迟诊断配套）：波内 request → 首原始 chunk →
    // 首个可见 delta → 流结束，区分「API 排队/首 token 慢」与「生成长」。
    const waveTimingStart = Date.now();
    let waveFirstRaw: number | null = null;
    let waveFirstDelta: number | null = null;

    // 前缀看门狗（2026-10-12 P0 根修配套）：每次请求取分段指纹（tools/system/
    // history/tail），usage 到达后 reportPrefixWatchOutcome 自动归因——再出现
    // 命中率劣化，一条日志直击是 tools 抖动还是 system 漂移，不用人工排障。
    let headFps: ReturnType<typeof fingerprintRequestHead> | null = null;
    let reportedFps: ReturnType<typeof fingerprintRequestHead> | null = null;
    while (true) {
      // ① replan 历史瘦身：wave>0 时把早于当前波次的旧工具链折叠为确定性摘要
      //（仅保留最近波次完整链），replan 规划不必重发旧波次全部细节。
      // ObservationPack：折叠行尾追加 obs_recall 句柄标注，旧波细节可按句柄读回。
      const sanitizedMessages = sanitizeChatMessagesForApi(
        wave > 0
          ? foldOldWaveToolChains(messages, REPLAN_FOLD_DIGEST_CHARS, (callId) =>
              obsPack.idForToolCall(callId),
            )
          : messages,
        {
          stripReasoning: thinkingDisabled,
          logPrefix: "[openai-tool-loop]",
        },
      );
      const requestMessages = options?.requestSystemMessages
        ? applyPromptCacheMessages(
            sanitizedMessages,
            options.requestSystemMessages,
            options.tailDynamicContext,
          )
        : sanitizedMessages;
      headFps = fingerprintRequestHead({ tools: stableApiTools, messages: requestMessages });
      // 前缀分叉定位（PREFIX_DEBUG=1 开启，默认关）：与**本进程内上一次请求**
      // 逐条比对，直接报出「第几条消息开始不一样」。
      //
      // 为什么需要它：prefix-watchdog 只比对 tools / system 两段，而实测最大的
      // 分叉源恰恰在 messages 内部——(a) 尾部动态上下文挂在最后一条 user 上，
      // 该消息落库时是干净的，下一轮作为历史出现内容就变了；(b) [session-recap]
      // 以 system 消息插在头部且内容逐轮更新；(c) 历史被折叠/摘要后变短。
      // 三者都让「上一轮的请求」不再是「本轮请求」的前缀，而 watchdog 全看不见。
      if (process.env.PREFIX_DEBUG === "1") {
        const prev = (globalThis as any).__prevReq as
          | { texts: string[]; tools: string; sess: string }
          | undefined;
        const curTexts = requestMessages.map((m) => JSON.stringify(m));
        const curTools = JSON.stringify(stableApiTools);
        const sess = options?.audit?.sessionId ?? "-";
        let diffAt = -1;
        let reason = "";
        if (prev && prev.sess === sess) {
          if (prev.tools !== curTools) reason += "TOOLS ";
          const n = Math.min(prev.texts.length, curTexts.length);
          for (let i = 0; i < n; i++) {
            if (prev.texts[i] !== curTexts[i]) {
              diffAt = i;
              break;
            }
          }
          if (diffAt < 0 && curTexts.length < prev.texts.length) {
            diffAt = curTexts.length;
            reason += "SHRINK ";
          }
        }
        try {
          const brief = (m: ChatCompletionMessageParam | undefined): string => {
            if (!m) return "-";
            const raw = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
            return `${m.role}:${(raw ?? "").slice(0, 60).replace(/\s+/g, " ")}`;
          };
          appendFileSync(
            "data/prefix-dbg.log",
            `${new Date().toISOString()} wave=${wave} msgs=${headFps.msgCount} ` +
              `tools=${headFps.toolsHash}(${headFps.toolCount}) system=${headFps.systemHash} ` +
              `history=${headFps.historyHash} tail=${headFps.tailHash} ` +
              `diffAt=${diffAt}(${diffAt >= 0 ? (requestMessages[diffAt] as { role?: string })?.role ?? "?" : "-"}) ${reason}\n` +
              (diffAt >= 0 && prev
                ? `  prev[${diffAt}]=${brief(JSON.parse(prev.texts[diffAt] ?? "null"))}\n` +
                  `  cur [${diffAt}]=${brief(requestMessages[diffAt])}\n`
                : "") +
              // PREFIX_DEBUG_FULL=1：整条请求逐条角色+预览，定位分叉结构用
              (process.env.PREFIX_DEBUG_FULL === "1"
                ? requestMessages
                    .map((m, i) => `  #${i} ${brief(m)}`)
                    .join("\n") + "\n"
                : ""),
          );
        } catch {
          // 诊断写盘失败不影响主流程
        }
        (globalThis as any).__prevReq = {
          texts: curTexts,
          tools: curTools,
          sess,
        };
      }
      try {
      // 请求层恒为 auto（2026-10-22 定稿，唯一发射点）：所有轮次、所有波次一律
      // 交给模型自决，服务端不因任何措辞预判收紧请求约束。
      const request = {
        model,
        messages: requestMessages,
        tools: stableApiTools,
        tool_choice: "auto" as const,
          // 明确启用并行工具调用，让 LLM 在单轮内返回多个 tool_calls。
          // 配合工具描述里的并行引导，减少串行轮次。
          parallel_tool_calls: true,
          stream: planNonStreaming ? false : true,
          // 流式时随流末 chunk 带回 usage（含 DeepSeek prefix cache 命中/未命中
          // token），保住 token 审计与预算告警的数据源（非流式响应天然带 usage）。
          ...(planNonStreaming ? {} : { stream_options: { include_usage: true } }),
          ...(planMaxTokens ? { max_tokens: planMaxTokens } : {}),
          ...(options?.promptCache ?? {}),
          // ⚠️ OpenAI Node SDK v6 不识别 Python 风格的 `extra_body` 顶层字段——它会
          // 整个 body JSON.stringify 后把 `extra_body` 当作普通 key 发出去，导致
          // `thinking` 被埋到一层下，Moonshot 看不到 → k2.5 默认 thinking 仍开启
          // → 撞上 tool_choice='specified' 直接 400。直接 spread 到顶层。
          ...(options?.extraBody ?? {}),
        };
        stream = await client.chat.completions.create(
          request as Parameters<typeof client.chat.completions.create>[0],
          options?.signal ? { signal: options.signal } : undefined,
        );
        // tool_choice 恒为 auto，端点不会再因 tool_choice 拒绝请求，
        // 原 retriedToolChoice 降级分支随 required 一起删除（2026-10-22）。
        if (promptTraceEnabled()) {
          // 诊断转储（2026-10-11）：排「模型答错时间/自述泄漏」这类问题时，需要看
          // 模型实际收到的 system 与末尾消息。触发方式二选一：环境变量
          // AGENT_PROMPT_TRACE=1，或创建 <dataDir>/prompt-trace.flag（免重启开关，
          // 用完即删）。只在 tool-loop 请求处打印，量可控。
          const sys = requestMessages[0];
          const tail = requestMessages.slice(-2).map((m) => ({
            role: m.role,
            content: typeof m.content === "string" ? m.content.slice(0, 5000) : JSON.stringify(m.content)?.slice(0, 2000),
          }));
          // eslint-disable-next-line no-console
          console.log(
            `[prompt-trace] wave=${wave} model=${model} tool_choice=${JSON.stringify(request.tool_choice)} msgs=${requestMessages.length}\n` +
            `--- system(${typeof sys?.content === "string" ? sys.content.length : 0}ch) ---\n` +
            `${typeof sys?.content === "string" ? sys.content.slice(0, 9000) : JSON.stringify(sys?.content)}\n` +
            `--- tail ---\n${JSON.stringify(tail).slice(0, 12000)}`,
          );
        }
        const toolsChars = JSON.stringify(stableApiTools ?? []).length;
        auditInputChars = JSON.stringify(requestMessages).length + toolsChars;
        // 分段：只统计文本部分（与审计口径一致——多模态 base64 无法按字符折算）
        const textCharsOf = (content: unknown): number => {
          if (typeof content === "string") return content.length;
          if (Array.isArray(content)) {
            let n = 0;
            for (const part of content) {
              const p = part as { text?: unknown } | null;
              if (typeof p?.text === "string") n += p.text.length;
            }
            return n;
          }
          return 0;
        };
        let historyChars = 0;
        for (let i = 1; i < requestMessages.length; i++) {
          const m = requestMessages[i] as { content?: unknown };
          historyChars += textCharsOf(m?.content);
        }
        auditBreakdown = {
          system: textCharsOf((requestMessages[0] as { content?: unknown } | undefined)?.content),
          history: historyChars,
          tools: toolsChars,
          toolCount: stableApiTools.length,
        };
        break;
      } catch (e) {
        if (!retriedToolCallIdError && isToolCallIdNotFoundError(e)) {
          retriedToolCallIdError = true;
          repairMessagesAfterToolCallIdError(messages, thinkingDisabled);
          console.warn("[openai-tool-loop] Retrying completion after tool_call_id repair");
          continue;
        }
        // 2026-10-22：tool_choice 恒 auto，不再有「端点拒绝非 auto」的分支。
        throw e;
      }
    }

    let fullText = "";
    let fullReasoning = "";
    let finishReason: string | null = null;
    const normalizedToolCalls: NormalToolCall[] = [];
    // 本波次经净化后已直推 onDelta 的累计文本（2026-09-28 波内直推配套）：
    // 收尾全文/前导话推送时据此跳过已流过的部分，避免重复。
    let waveStreamedText = "";
    // 「先一句话后结果」闸门（2026-10-11）：本波一旦出现 tool_call 增量即关闸，
    // 此后的 content 不再直推前端——模型决定调工具后继续吐出的文本是思考/伴随话，
    // 透出去就是「先流式输出思考过程、最后被覆盖」事故的源头。关闸前已流出的
    // 文本 = 模型调工具前自然说出的确认语（先回一句话），发出后永不回收。
    let waveGateClosed = false;
    // 关闸后滞留的净化文本：最终波冲刷（补齐最终回复），工具波整段丢弃。
    let waveHeldText = "";
    // 波内直推的逐 delta 净化栈（与纯文本分支同款）：跨块控制标签状态机 +
    // 元话语整句过滤，think 块已在 consumer 咽喉剥过。
    const waveTagSanitizer = createStreamControlTagSanitizer();
    const waveMetaFilter = createStreamMetaSentenceFilter();
    // 流末尾 chunk 的 usage（可能缺失）；声明在 try 外，供块外审计使用
    let streamUsage: NormalUsage | undefined;

    try {
      if (planNonStreaming) {
        // ④ 非流式规划响应：把完整 message 归一化为单个 NormalChatChunk 走同一 consumer。
        // 内容与流式完全一致（DSML 工具调用提取、reasoning 累积都在 consumer 内完成），
        // 但协议更省、usage 更确定（含 prefix cache token）。
        const resp = stream as OpenAI.Chat.Completions.ChatCompletion;
        const choice = resp.choices?.[0];
        const msg = choice?.message;
        const usageRaw = resp.usage as OpenAI.CompletionUsage | undefined;
        const usageExtras = usageRaw as unknown as Record<string, unknown> | undefined;
        const toolCalls: NormalToolCall[] = (
          (msg?.tool_calls ?? []) as Array<{
            id?: string;
            function?: { name?: string; arguments?: string };
          }>
        ).map((tc, i) => ({
          index: i,
          id: tc.id ?? null,
          name: tc.function?.name,
          argumentsChunk: tc.function?.arguments,
        }));
        const chunk: NormalChatChunk = {
          content: typeof msg?.content === "string" && msg.content.length > 0 ? msg.content : undefined,
          reasoning: (msg as { reasoning_content?: string }).reasoning_content,
          finishReason: choice?.finish_reason ?? null,
          ...(toolCalls.length > 0 ? { toolCalls } : {}),
          ...(usageRaw
            ? {
                usage: {
                  inputTokens: usageRaw.prompt_tokens,
                  outputTokens: usageRaw.completion_tokens,
                  promptCacheHitTokens:
                    (usageExtras?.prompt_cache_hit_tokens as number | undefined) ??
                    ((usageExtras?.prompt_tokens_details as { cached_tokens?: number } | undefined)
                      ?.cached_tokens),
                  promptCacheMissTokens: usageExtras?.prompt_cache_miss_tokens as number | undefined,
                },
              }
            : {}),
        };
        const result = await consumeNormalizedStream(singleChunkSource(chunk), {
          onToolCallsComplete: (calls) => {
            for (const c of calls) normalizedToolCalls.push(c);
          },
          providerId: "openai-compatible",
          model,
        });
        fullText = result.content;
        fullReasoning = result.reasoning;
        finishReason = result.finishReason;
        streamUsage = result.usage;
      } else {
        // 流式消费走统一的 provider-agnostic helper：自动累积 content + reasoning_content
        // + tool_calls。任何 provider 的 chunk 只需先经 `adaptOpenAiChatCompletionStream`
        // 适配成 NormalChatChunk 即可。后续若要接入 Anthropic/Google，只换 adapter 即可。
        const result = await consumeNormalizedStream(
          adaptOpenAiChatCompletionStream(
            (async function* () {
              for await (
                const chunk of stream as AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>
              ) {
                if (waveFirstRaw === null) waveFirstRaw = Date.now();
                yield chunk;
              }
            })(),
          ),
          {
            onContentDelta: (d) => {
              fullText += d;
              // 波内直推（2026-09-28 放流；2026-10-11 加闸门）：content delta 经
              // 逐 delta 净化后立即推给前端，最终波/前导话不再等收尾才整段推送。
              // 闸门规则：本波出现 tool_call 增量前 → 直推（确认语打字机透出）；
              // 关闸后 → 滞留 waveHeldText（工具波丢弃、最终波冲刷），思考过程
              // 不再透出。与最终文本的分叉由 WS 层收口裁决承接。
              const clean0 = waveMetaFilter(waveTagSanitizer(d));
              if (!clean0) return;
              // 繁→简出口正规化（2026-10-11）：累计（waveStreamedText/waveHeldText）
              // 与直推用同一归一文本，1:1 等长替换不破坏闸门滞留与残差对账。
              const clean = normalizeTraditionalToSimplified(clean0).text;
              // 答案留存闸（2026-10-13 根修）：命中即不直推（fullText 已累积，
              // 返回值带全量文本交 done）。与 10-11 关闸闸门的分工：那道闸拦
              // 「调工具前的思考/伴随话」，这道闸拦「调工具后的答案本体」。
              if (answerHeld()) {
                return;
              }
              if (waveGateClosed) {
                waveHeldText += clean;
                return;
              }
              if (waveFirstDelta === null) waveFirstDelta = Date.now();
              waveStreamedText += clean;
              onDelta(clean);
            },
            onToolCallDeltaSeen: () => {
              waveGateClosed = true;
            },
            onToolCallsComplete: (calls) => {
              for (const c of calls) normalizedToolCalls.push(c);
            },
            providerId: "openai-compatible",
            model,
          },
        );
        // eslint-disable-next-line no-console
        console.info(
          `[llm-timing] tool-wave model=${model} wave=${wave} ` +
            `firstRaw=${waveFirstRaw === null ? "-" : waveFirstRaw - waveTimingStart}ms ` +
            `firstDelta=${waveFirstDelta === null ? "-" : waveFirstDelta - waveTimingStart}ms ` +
            `total=${Date.now() - waveTimingStart}ms streamed=${waveStreamedText.length} raw=${fullText.length}`,
        );
        fullText = result.content;
        fullReasoning = result.reasoning;
        finishReason = result.finishReason;
        streamUsage = result.usage;
      }
    } catch (e) {
      // 流式空闲超时：如果有 partial content 且没有 tool_calls，用 partial content 兜底。
      // tool_calls 不完整时不能兜底（会导致 LLM 收到半截 JSON 参数）。
      if (e instanceof StreamIdleTimeoutError && e.partialContent.trim() && normalizedToolCalls.length === 0) {
        // eslint-disable-next-line no-console
        console.warn(
          `[stream-idle-timeout] tool-loop model=${model} ` +
            `→ 使用 ${e.partialContent.length} 字符的 partial content 兜底`,
        );
        finishReason = "stop"; // 强制标记为正常结束
        // fullText 已通过 onContentDelta 累积，不需要额外处理
      } else {
        throw e;
      }
    }

    // 前缀缓存统计聚合（本调用内）
    accumulatePrefixCacheUsage(streamUsage);
    // 前缀看门狗归因上报：usage 到达点比对分段指纹，tools/system 变化即告警。
    // while(true) 重试会产生多次 create——以最后一次实际发出的请求为准。
    if (headFps && headFps !== reportedFps) {
      reportPrefixWatchOutcome({
        sessionId: options?.audit?.sessionId,
        stage: options?.audit?.stage,
        fingerprint: headFps,
        hitTokens: streamUsage?.promptCacheHitTokens,
        missTokens: streamUsage?.promptCacheMissTokens,
      });
      reportedFps = headFps;
    }

    // Token 用量审计：记录本轮实际 LLM 调用（工具循环内每次 round 一条），
    // 附带 API 真实返回的 usage（prompt/completion tokens）与 prefix cache 命中/未命中 token
    try {
      if (options?.audit && auditInputChars > 0) {
        recordLlmUsageByChars({
          stage: options.audit.stage ?? "main_chat_tools",
          sessionId: options.audit.sessionId,
          inputChars: auditInputChars,
          outputChars: (fullText?.length ?? 0) + (fullReasoning?.length ?? 0),
          model,
          promptCacheHitTokens: streamUsage?.promptCacheHitTokens,
          promptCacheMissTokens: streamUsage?.promptCacheMissTokens,
          ...(typeof streamUsage?.inputTokens === "number"
            ? { apiPromptTokens: streamUsage.inputTokens }
            : {}),
          ...(typeof streamUsage?.outputTokens === "number"
            ? { apiCompletionTokens: streamUsage.outputTokens }
            : {}),
          breakdown: auditBreakdown,
        });
      }
    } catch {
      /* 审计失败静默 */
    }

    // 仅把"正式回复"计入 lastAssistantText；以 tool_calls 结束的轮次中 fullText
    // 仅为思考前导话，**不进最终回复文本**（2026-10-11 闸门化：工具波透给前端的
    // 只有关闸前的单句确认语——波内直推流式透出 / 非流式波 firstAckSentence 兜底；
    // 关闸后的思考/伴随文本滞留丢弃，不再出站）。「确认语已出站、但不进最终文本」
    // 这对事实的收敛责任在展示侧：WS 层用 UtteranceAssembler（agent/utterance-assembler.ts）
    // 把确认语与结论装配成同一条发言，检索轮两段都保留（先应一句、停顿、再细说），
    // 记账轮等语义重复时裁掉确认语，避免"同一句话变成两条消息"。
    // 注意：下方收尾闸门（出口检查/出口自检/空正文兜底）命中 continue 重试前
    // 会清空本累积——重试轮「替换」上一轮文本而非拼接，否则上一轮的自语会
    // 和重试后的新答案拼成一条两句同义的回复（2026-09-09 实测事故）。
    if (finishReason !== "tool_calls" || normalizedToolCalls.length === 0) {
      lastAssistantText = (lastAssistantText ? lastAssistantText + "\n" : "") + fullText;
    }

    if (finishReason !== "tool_calls" || normalizedToolCalls.length === 0) {
      // 对话结束：返回最终回复文本。
      // 剥离 [ts:] 时间戳帧（仅供 LLM 上下文，不应展示给用户）；
      // 用容错版本，连模型复述出的残缺帧（[ts 后断行/丢冒号）一并清掉。
      let finalText = stripAllTimestampFrameLines(lastAssistantText.trim()).trim();

      // （Coze 思路）已移除图片意图"自救"prompt 注入：
      //   - 不靠正则猜意图 / 不注入 prompt 逼模型重调 search_images。
      //   - 媒体是否展示完全由「模型是否真的调用了 search_images」这一服务端事实决定，
      //     search_images 常驻可见，服务端把工具结果确定性渲染成图廊（chat-user-message.ts）。
      //   - 普通问答时模型不该调图片工具就不调，从而彻底避免误返回照片。

      // ── 请求卡（2026-09-19，MCP-Zero 式意图检索 → 轮内转正）──
      // 模型在正文输出 <tool_request>能力描述</tool_request> 表示可见工具不足以
      // 完成任务：检索层对延迟目录做语义召回，命中工具追加进本轮 tools 数组
      // （会话排序基准自动吸收新工具），下一波模型原生 tool_calls 直调。
      // 取代"要求弱模型自觉写好检索词调 tool_discover"的两步协议——模型只说
      // 意图，检索层负责终审。每轮最多一次；未命中不续波（下方出口检查兜底）。
      if (
        staticToolArch &&
        !requestCardUsed &&
        toolSearchPrepared.toolSearchActive &&
        toolSearchPrepared.deferredCatalog.entries.length > 0 &&
        wave + 1 < effectiveMaxWaves()
      ) {
        const cardMatch = /<tool_request>([\s\S]{1,300}?)<\/tool_request>/i.exec(fullText);
        if (cardMatch?.[1]?.trim()) {
          requestCardUsed = true;
          const intent = cardMatch[1].trim();
          let matches: Awaited<ReturnType<typeof searchResources>> = [];
          try {
            matches = await searchResources(
              toolSearchPrepared.deferredCatalog,
              intent,
              3,
              { includeSchema: true },
            );
          } catch {
            matches = [];
          }
          const known = new Set(stableApiTools.map(apiToolNameOf));
          const loaded: string[] = [];
          const alreadyVisible: string[] = [];
          // top-1 语义：请求卡表达的是模型当下的意图，加载=top-1（最小 schema 增量）；
          // top-1 已可见（预召回先注入）→ 指回直调；top-1 分数不足 → 不加载（出口检查兜底）。
          const best = matches.find((m) => m.score >= REQUEST_CARD_MIN_SCORE);
          if (best) {
            // 高危拦截（2026-09-19 P1-1）：资金/外发类工具不因请求卡自动转正进
            // chat 车道——引导模型走 task.dispatch 派发后台（人工审批兜底），
            // 防弱模型一句 <tool_request> 就把支付工具拉进可见集直接调用。
            const stage = options?.audit?.stage ?? "";
            if (stage.startsWith("main_chat") && isHighRiskToolName(best.name)) {
              requestCardUsed = true;
              traceRequestCard = { fired: true, loaded: [], blockedRisk: [best.name] };
              messages.push({ role: "assistant", content: fullText || "" });
              messages.push(markTurnScaffold({
                role: "system",
                content:
                  `你请求的能力（${best.name}）涉及资金或对外发送，属于高危操作，系统不会自动加载。` +
                  `如用户明确要求办理，请改用 task.dispatch 把它派发为后台任务（会经人工审批），` +
                  `并先向用户复述将执行的操作内容；不要再次输出请求标记直接索要该工具。`,
              }));
              lastAssistantText = "";
              console.info(
                `[openai-tool-loop] 请求卡高危拦截：${best.name}（stage=${stage}）`,
              );
              continue;
            }
            const entry =
              toolSearchPrepared.deferredCatalog.byName.get(best.name) ??
              toolSearchPrepared.deferredCatalog.byApiName.get(best.name.replace(/\./g, "_"));
            const tool = entry?.tool;
            if (tool) {
              const apiTool = registerApiTool(tool);
              if (!apiTool || known.has(apiToolNameOf(apiTool))) {
                if (entry.registryName) alreadyVisible.push(entry.registryName);
              } else {
                loaded.push(entry.registryName);
                requestCardLoadedNames.add(entry.registryName);
                // 转正 = 显式 grow：lock 模式下这是唯一能把新工具吸收进会话基准的
                // 通道（一次增长 = 一次前缀断点，但之后重新稳定）。union 模式下
                // growNames 被忽略，行为与旧并集等价。
                faceGrowNames.add(entry.registryName);
                stableRegistryTools = stabilizeToolOrderForSession(
                  [...stableRegistryTools, tool],
                  options?.audit?.sessionId,
                  faceOpts,
                );
                if (entry.registryName) apiFormByRegistry.set(entry.registryName, apiTool);
                stableApiTools = stableRegistryTools
                  .map((rt) => apiFormByRegistry.get(apiToolNameOf(rt) ?? ""))
                  .filter((t): t is ChatCompletionTool => Boolean(t));
              }
            }
          }
          traceRequestCard = {
            fired: true,
            loaded,
            ...(alreadyVisible.length > 0 ? { alreadyVisible } : {}),
          };
          console.info(
            `[openai-tool-loop] 请求卡：intent="${intent.slice(0, 60)}" ` +
              `candidates=[${matches
                .map((m) => `${m.name}:${m.score.toFixed(2)}`)
                .join(", ")}] → loaded=[${loaded.join(", ")}]`,
          );
          if (loaded.length > 0) {
            messages.push({ role: "assistant", content: fullText || "" });
            messages.push(markTurnScaffold({
              role: "system",
              content:
                `已根据你的能力请求从延迟工具目录检索并加载：${loaded.join("、")}（完整 schema 已进入本轮工具列表）。` +
                `请立即调用合适的工具完成用户任务；若这些工具仍不匹配，请直接如实向用户说明，不要再次输出请求标记。`,
            }));
            lastAssistantText = "";
            continue;
          }
          if (alreadyVisible.length > 0) {
            messages.push({ role: "assistant", content: fullText || "" });
            messages.push(markTurnScaffold({
              role: "system",
              content:
                `你请求的能力对应的工具（${alreadyVisible.join("、")}）已经在你的可见工具列表中（系统预注入）。` +
                `请直接调用它完成任务，不要再输出请求标记。`,
            }));
            lastAssistantText = "";
            continue;
          }
        }
      }

      // ── 单一出口检查（2026-10-22：静态架构下只保留与服务端事实相关的循环行为）──
      // 判定「这轮要不要工具」的权责划分（去路由化后）：
      //   - 请求层：恒 tool_choice="auto"，不做任何事前预判（2026-10-22 定稿：
      //     不预测，只验证；原指定门与祈使扳机已退役，见 forced-tool.ts）；
      //   - 本出口：只做事实对账——不管措辞像不像「办过」，只看服务端工具
      //     执行结果是否兑现用户明确诉求（宣称未兑现 / 显式动作未执行 → 续波）。
      // 保留的循环行为：
      //   1) 工具全失败 → 换关键词/换工具再试一次；
      //   2) 调了工具但零正文 → 要求补叙述；
      //   3) 只发现不执行 → 按 schema 真正执行；
      //   4) 零实质成功却宣称办过 → required 续波（2026-10-22 新增，兜底
      //     「该调没调」；与 2026-10-06 下线的宣告兜底的区别是多了服务端
      //      事实对账与办事怀疑信号双条件，误判只剩一次可逆 round trip）；
      //   5) 显式动作（打电话/报位置）整轮未执行 → required 续波并指名工具
      //     （2026-10-22，事前指定门的替代：不看措辞，只看执行记录）。
      if (staticToolArch && !exitGateEnforced && stableApiTools.length > 0) {
        let gateReason: string | null = null;
        let gateInstruction = "";
        // 实质尝试：排除元工具/管线支撑工具（obs_recall、tool_discover、query_capabilities）——
        // "只查了能力清单"不是失败，对话面回答"你会什么"这类轮次不该被续波。
        const hasSubstantiveAttempt = allToolExecResults.some(
          (r) => !META_TOOL_NAMES.has(r.toolName) && !SUPPORT_PLUMBING_TOOLS.has(r.toolName),
        );
        // 只发现、不执行（2026-10-21 评估抓到的真实 miss）：模型调了
        // tool_discover 拿到 schema 后直接收尾，业务工具一次都没调。此时
        // 必须再给一波让它按 schema 真正执行，而不是停在发现阶段。
        const discoverSucceeded = allToolExecResults.some(
          (r) =>
            r.ok &&
            (r.toolName === "tool_discover" ||
              r.toolName === "tool_search" ||
              r.toolName === "tool_describe"),
        );
        // 显式外部动作未执行（2026-10-22，事前指定门的替代）：用户明确要求打电话/
        // 报位置，而服务端整轮没有该工具的执行记录——确定性违约事实，不看回复
        // 措辞（沉默幻觉、敷衍推脱也拦得住）。这是「显式请求最终必执行」的保证。
        // 排除两种不该打回的情形：fastProfile（system 已注入定位，直答是正确的）
        // 与最后一波（没有续波预算，continue 只会空转）。
        const explicitActionTool = resolveExplicitActionTool(userText);
        const explicitActionMissing =
          explicitActionTool != null &&
          !allToolExecResults.some((r) => r.toolName === explicitActionTool);
        const explicitActionAnswerableByInjection =
          fastProfile && explicitActionTool === "clock.get_user_location";
        if (
          explicitActionTool &&
          explicitActionMissing &&
          !explicitActionAnswerableByInjection &&
          finalText.trim() &&
          wave + 1 < effectiveMaxWaves()
        ) {
          gateReason = "explicit_action_no_attempt";
          gateInstruction =
            `出口对账：用户明确提出了${explicitActionTool === "phone.call_user" ? "打电话" : "查询位置"}的请求，` +
            `但服务端记录显示本轮还没有调用过 ${explicitActionTool}。请立即调用该工具完成动作（参数按 schema）；` +
            `若确实无法完成（如缺少联系方式/定位权限），如实向用户说明卡点，不要用文字假装已完成。`;
        } else if (!hasSubstantiveAttempt && discoverSucceeded) {
          gateReason = "discover_without_execution";
          gateInstruction =
            "你已经从延迟工具目录加载了工具 schema，但本轮还没有调用任何具体业务工具。" +
            "请立即按用户目标调用刚加载的工具（参数参照 schema），拿到真实结果后再回复；" +
            "不要停在发现阶段，也不要只复述工具清单。";
        } else if (
          // 派发代替执行（2026-10-22 完成度判据，取代原「宣称未兑现」词面闸）：
          // 本轮把活派给了后台，服务端没有任何 content 类结果。只报状态、不下命令，
          // 两条出路都合法：当场查完再答，或如实告诉用户稍后才会有结果。
          finalText.trim() &&
          allToolExecResults.some((r) => r.ok && isQueuedResult(r)) &&
          countSubstantiveOkResults() === 0
        ) {
          gateReason = "queued_without_content";
          const queuedNames = Array.from(
            new Set(allToolExecResults.filter((r) => isQueuedResult(r)).map((r) => r.toolName)),
          );
          gateInstruction =
            `本轮只完成了派发（${queuedNames.join("、")}），还没有拿到能回答用户的内容。用户仍在等。` +
            `如果这件事现在用工具就能查完，就直接查完再答；` +
            `如果确实需要后台长跑，就明确告诉他结果稍后出现——不要说得像已经办好了。`;
        } else if (
          finalText.trim() &&
          hasSubstantiveAttempt &&
          countSubstantiveOkResults() === 0
        ) {
          gateReason = "substantive_tools_attempted_but_none_succeeded";
          const failedSummary = allToolExecResults
            .filter((r) => !r.ok)
            .slice(0, 3)
            .map((r) => `${r.toolName}: ${JSON.stringify(r.result ?? {}).slice(0, 120)}`)
            .join("；");
          gateInstruction =
            `出口检查：本轮尝试过的工具全部失败${failedSummary ? `（${failedSummary}）` : ""}。` +
            `请换一个关键词、换一个工具或换数据源再试一次，拿到真实结果后再回答；` +
            `若所有途径确实都不可用，请如实向用户说明卡点，不要编造结果。`;
        } else if (!finalText.trim() && allToolExecResults.length > 0) {
          gateReason = "tools_ran_without_narration";
          gateInstruction =
            "你刚才调用了工具但还没有向用户输出任何正文。请立即基于以上工具结果用自然口语回复用户，把关键信息讲清楚；" +
            "不要输出 JSON 或原始数据结构（那由前端结构化渲染负责）。若结果为空或失败，请如实向用户说明。";
        }
        if (gateReason) {
          exitGateEnforced = true;
          // 续波不再收紧请求（tool_choice 恒 auto）：靠 gateInstruction 里的
          // 具体信息 + 模型自决。这是 Anthropic 官方给的替代路径
          // （auto + 提示里点名 + 事后检查再重试）。
          traceExitGate = { fired: true, reason: gateReason };
          recordExitGateFire(gateReason, options?.audit?.sessionId);
          console.info(`[openai-tool-loop] 出口检查续波：${gateReason}`);
          messages.push({ role: "assistant", content: finalText || fullText || "" });
          messages.push(markTurnScaffold({ role: "system", content: gateInstruction }));
          lastAssistantText = "";
          continue;
        }
      }
      // ── legacy 收尾兜底链（2026-09-05；AGENT_TOOL_ARCH=legacy 时保留）──
      // 旧链中的「强制联网重试」依赖 FRESH_WEB_LOOKUP_RE 等话题词表判定"需要联网"，
      // 属于关键词打地鼠，已删除——"需不需要外部信息"由路由层语义分类承担，
      // "有没有真的查"由下方出口自检（风格判定）承担，不再需要话题词预判。
      // 行动宣告未兑现兜底（文本正则判承诺）已于 2026-10-06 整体下线（误伤两次，
      // 工具调用质量由语义路由+出口自检承担），不再有该分支。
      // 统一出口自检（2026-09-05 TurnOutcomeGate，不分车道）：「诉求未满足」且预算
      // 还有余量 → 注入一次换路续波指令（换关键词/换工具/换数据源），在原轨迹内纠错。
      // 预算耗尽 → 如实收尾（honest 策略），不再有升级哨兵/整轮重放。
      // 仅当本轮有工具可调时生效——零工具轮（对话面）不在这里空转。
      if (!staticToolArch && stableApiTools.length > 0) {
        const unsatisfiedReason = assessTurnUnsatisfied(finalText);
        if (
          unsatisfiedReason &&
          !outcomeGateEnforced &&
          wave + 1 < effectiveMaxWaves()
        ) {
          outcomeGateEnforced = true;
          recordExitGateFire(unsatisfiedReason, options?.audit?.sessionId);
          console.info(
            `[openai-tool-loop] 出口自检：${unsatisfiedReason}` +
              `（工具尝试 ${allToolExecResults.length} 次，成功实质 ${countSubstantiveOkResults()} 次）→ 换路续波`,
          );
          messages.push({
            role: "assistant",
            content: finalText || fullText || "",
          });
          messages.push({
            role: "system",
            content:
              unsatisfiedReason === "queued_without_content"
                ? "本轮只完成了派发，还没有拿到能回答用户的内容，用户仍在等。" +
                  "如果这件事现在用工具就能查完，就直接查完再答；如果确实需要后台长跑，" +
                  "就明确告诉他结果稍后出现——不要说得像已经办好了。"
                : unsatisfiedReason === "explicit_action_no_attempt"
                  ? `出口对账：用户明确提出了${resolveExplicitActionTool(userText) === "phone.call_user" ? "打电话" : "查询位置"}的请求，` +
                    "但服务端记录显示本轮还没有调用过对应工具。请立即调用该工具完成动作（参数按 schema）；" +
                    "若确实无法完成（如缺少联系方式/定位权限），如实向用户说明卡点，不要用文字假装已完成。"
                  : "出口自检：到目前为止还没有任何一次成功的工具结果能回答用户的问题。" +
                    "请换一个关键词重搜、换一个工具（如 search_web / fetch_web / internet.*）或换数据源再试一次，" +
                    "拿到真实结果后再回答。若所有途径确实都不可用，请如实向用户说明卡点，不要编造结果。",
          });
          // 同宣告闸门：重试轮替换而非拼接，上一轮自语/道歉文本不进最终回复。
          lastAssistantText = "";
          continue;
        }
        if (unsatisfiedReason) {
          console.info(
            `[openai-tool-loop] 出口自检：${unsatisfiedReason}（预算耗尽）→ 如实收尾`,
          );
        }
      }
      // 空正文整合兜底（2026-08-29）：LLM 调用了工具但没输出任何正文时，先注入一次
      // 指令强制模型基于工具结果用自然口语回复（任务完成保障，保留）。
      // wave 预算守卫：fast（maxWaves=1）与最后一波不授予，避免 continue 越过预算。
      if (
        !staticToolArch &&
        !finalText.trim() &&
        allToolExecResults.length > 0 &&
        !narrationEnforced &&
        wave + 1 < maxWaves
      ) {
        narrationEnforced = true;
        messages.push({
          role: "assistant",
          content: fullText || "",
        });
        messages.push({
          role: "system",
          content:
            "你刚才调用了工具但还没有向用户输出任何正文。请立即基于以上工具结果用自然口语回复用户，把关键信息讲清楚；" +
            "不要输出 JSON 或原始数据结构（那由前端结构化渲染负责）。若结果为空或失败，请如实向用户说明。",
        });
        // 同宣告闸门：重试轮替换而非拼接。
        lastAssistantText = "";
        continue;
      }
      // 道歉式兜底已彻底删除（2026-09-08 用户指令）：LLM 输出道歉/空文本时，不再用
      // lastToolOutputFallback（工具输出原文）替换回复——那会把工具原始 JSON 直接糊给
      // 用户，正是「先流式说没搜到、突然变成搜索结果卡」的直接源头。LLM 说没搜到就
      // 如实收尾；任务完成由上方「出口自检 → 换路续波」重试与空正文整合兜底保证，
      // 不靠兜底换货。
      const effectiveFinalText = normalizeTraditionalToSimplified(finalText).text;
      // 流式推送最终内容到 onDelta（→ onAssistantDelta → 前端 chat.assistant_chunk）
      // 根源净化：先把 LLM 混进正文的内部控制标签（[STOP...] / [话题切换...]）剥离，
      // 保证推给前端的气泡不出现这些内部信号（此前在 agent-core finishLlmTurn 后置剥离
      // 太晚——流式早已透出，无法撤回）。
      //
      // 2026-08-29 扩展：再走一次元术语整句过滤，兜底 LLM 把系统元描述（"上一轮转入
      // 规划任务，执行脑已接手处理中"）写成完整句子的场景——这类整句与正常内容混编
      // 时整段丢弃，避免污染前端气泡。
      //
      // 2026-10-11：这里改用**整串版** `stripMetaSentences`（而非 createStreamMetaSentenceFilter
      // 的整串调用）。后者按 chunk 语义设计，未遇句末标点的尾部会留在缓冲里累积——对已
      // 完整的整串来说等于把末尾那句吞掉。同时该函数已加入「元决策自述句」判据
      // （「根据规范必须调用…」「系统已注入…但强制规则要求必须调用工具」），覆盖
      // 「问时间」4 泡事故那一族；流式路径（waveMetaFilter）走同一套判据。
      const sanitizedFinalText = stripRequestCardTags(
        stripInternalControlTags(stripMetaSentences(stripInlineThinkBlocks(effectiveFinalText))),
      );
      // 关闸滞留冲刷（2026-10-11）：最终波正常不关闸（无 tool_call 增量），
      // 此分支承接「流中出现 tool_call 增量但最终 stop」的罕见序——滞留的
      // 后半段正文属于最终回复，冲刷补齐，不丢内容。答案留存轮例外：滞留
      // 文本随返回值交 done（2026-10-13），不再补推到流式通道。
      if (waveHeldText && !answerHeld()) {
        onDelta(waveHeldText);
        waveStreamedText += waveHeldText;
        waveHeldText = "";
      }
      // 本波已直推过（波内直推）→ 不再整段重推；与 sanitizedFinalText 的差异
      // 由 WS 层 streamedText vs reply.text 的残差补推对齐（见 chat-user-message）。
      // 非流式/规划波（waveStreamedText 空）→ 维持收尾整推。
      // 答案留存轮（2026-10-13 根修）→ 整推也关闭：正文只随返回值走 done。
      if (sanitizedFinalText && !waveStreamedText.trim() && !answerHeld()) {
        onDelta(sanitizedFinalText);
      }
      messages.push({
        role: "assistant",
        content: sanitizedFinalText || null,
      });
      logPrefixCacheStats();
      recordTurnFinished();
      recordTurnTrace({
        ts: traceStartTs,
        stage: options?.audit?.stage ?? "main_chat_tools",
        model,
        ...(options?.turnIntent ? { turnIntent: options.turnIntent } : {}),
        ...(options?.turnIntent
          ? { turnEvidenceInjected: options.turnEvidenceInjected === true }
          : {}),
        ...(options?.turnRouteConfidence !== undefined
          ? { routeConfidence: options.turnRouteConfidence }
          : {}),
        visibleTools: registryTools.length,
        deferredActive: toolSearchPrepared.toolSearchActive,
        deferredCount: toolSearchPrepared.deferredToolCount,
        ...(userText ? { query: userText.slice(0, 160) } : {}),
        waves: traceWavesUsed,
        toolCalls: traceToolCalls,
        ...(traceRequestCard ? { requestCard: traceRequestCard } : {}),
        ...(traceExitGate ? { exitGate: traceExitGate } : {}),
        finalTextChars: sanitizedFinalText.length,
        durationMs: Date.now() - traceStartTs,
      });
      return sanitizedFinalText;
    }

    // 把 NormalToolCall[] 物化为 OpenAI SDK 形态（保留 id 兜底 + parsedArgs 预解析）
    const toolCalls: ChatCompletionMessageToolCall[] = materializeOpenAiToolCalls(
      normalizedToolCalls,
      model,
    );

    const assistantWithTools: ChatCompletionMessageParam = {
      role: "assistant",
      content: fullText || null,
      tool_calls: toolCalls,
    };
    // Kimi k2.5 开启 thinking 时，带 tool_calls 的 assistant 须含 reasoning_content；关闭 thinking 时不得携带该字段
    if (!thinkingDisabled) {
      (assistantWithTools as { reasoning_content?: string }).reasoning_content =
        fullReasoning.trim() || " ";
    }
    messages.push(assistantWithTools);

    // 阶段2-3：工具波次的确认语兜底推送（2026-10-11 收紧）。流式波里模型的
    // 确认语已在关闸前经波内直推逐字透出（waveStreamedText 非空 → 跳过）；
    // 这里只承接非流式规划波（planNonStreaming）等整段未直推的场景。推送内容
    // 截为单句确认语（firstAckSentence）——「先回一句话」是展示契约，模型的
    // 多句思考/计划文本不再整段透给前端；完整正文仍按原样进对话上下文。
    if (finishReason === "tool_calls" && normalizedToolCalls.length > 0 && fullText.trim()) {
      const preamble = firstAckSentence(
        normalizeTraditionalToSimplified(
          stripInternalControlTags(stripMetaSentences(stripInlineThinkBlocks(fullText))),
        ).text,
      );
      // 波内已直推过前导话 → 不重复推（同最终收尾的跳过语义）。
      if (preamble && !waveStreamedText.trim()) {
        onDelta(preamble);
      }
    }

    const toolResults: ToolLoopAfterBatchInfo["toolResults"] = [];
    // 本波次是否使用了交互式工具（浏览器/桌面/代码链路）：影响波次终止决策
    let waveUsedInteractiveTool = false;

    type ToolCallWorkItem = {
      tc: (typeof toolCalls)[number];
      registryToolName: string;
      parsedArgs: Record<string, unknown>;
      /** arguments 非合法 JSON 且修复失败：不执行，回填可恢复错误让模型重发 */
      argsMalformed?: boolean;
      /** 原始 arguments 文本（argsMalformed 时用于错误回执里的片段展示） */
      rawArguments?: string;
    };
    const workItems: ToolCallWorkItem[] = [];
    for (const tc of toolCalls) {
      if (tc.type !== "function") continue;
      const fn = tc.function;
      // 阶段0-3：此前 parse 失败静默吞成 {}——工具拿着空参数「成功执行」返回无关
      // 结果，用户视角即「工具随机抽风」。现在：截断先尽力修复；仍失败标记
      // argsMalformed，执行层短路并回填自愈指引。
      let args: Record<string, unknown> = {};
      let argsMalformed = false;
      const rawArguments = (fn.arguments ?? "").trim();
      if (rawArguments) {
        try {
          args = JSON.parse(rawArguments) as Record<string, unknown>;
        } catch {
          const repaired = tryRepairTruncatedJsonObject(rawArguments);
          if (repaired) {
            console.warn(
              `[openai-tool-loop] ${fn.name} arguments 被截断，最小修复成功（${rawArguments.length} → ${JSON.stringify(repaired).length} 字符）`,
            );
            args = repaired;
          } else {
            argsMalformed = true;
            console.warn(
              `[openai-tool-loop] ${fn.name} arguments JSON 解析失败且无法修复，将回填可恢复错误: ${rawArguments.slice(0, 120)}`,
            );
          }
        }
      }
      const registryToolName = resolveRegistryToolName(fn.name);
      const notifyToolName = registryToolName;
      ctx.onToolExecuteStart?.({
        toolName: notifyToolName,
        input: args,
        assistantPreamble: fullText.trim() || undefined,
      });
      workItems.push({
        tc,
        registryToolName,
        parsedArgs: args,
        ...(argsMalformed ? { argsMalformed: true as const, rawArguments } : {}),
      });
    }
    // 执行压力计数（P0-B）：本波真正要执行的工具调用数，供下一波判断是否软提示
    loopToolCallCount += workItems.length;
    if (workItems.length > 0) wavesWithToolCalls += 1;

    const settledResults = await Promise.allSettled(
      workItems.map(async (item) => {
        traceCallStartByCallId.set(item.tc.id, Date.now());
        let targetToolName = item.registryToolName;
        let targetArgs = item.parsedArgs;

        if (isToolSearchBridgeName(item.registryToolName)) {
          // 桥检索执行去重（2026-10-01）：tool_discover/tool_search 同参数轮内只真查
          // 一次（此前桥分支绕过 turnDedupeCache，同波并行重复 query 会重复执行检索）。
          // tool_call 不在此去重——它只做参数解析，真正执行在下方与普通工具共享去重。
          const bridgeKey = `bridge::${item.registryToolName}::${stableArgsKey(item.parsedArgs)}`;
          const inflightBridge = turnDedupeCache.get(bridgeKey) as
            | Promise<Awaited<ReturnType<typeof executeBridgeWithTimeout>>>
            | undefined;
          const bridge = await (inflightBridge ??
            (() => {
              const p = executeBridgeWithTimeout(
                item.registryToolName,
                item.parsedArgs,
                deferredToolCatalog,
                toResidentToolIndex(stableApiTools, resolveRegistryToolName),
              );
              // ToolSearchBridgeResult 运行时含 {ok, result} 超集，可安全复用去重缓存
              turnDedupeCache.set(bridgeKey, p as unknown as Promise<ToolExecOutcome>);
              return p;
            })());
          if (bridge.kind === "search" || bridge.kind === "describe" || bridge.kind === "discover") {
            if (bridge.ok) {
              // L3 观测：把本轮检索结果面出现过的工具名记入 surfaced 集，
              // 供 acquisition 区分「先检索再调用」与「未检索直呼」（幻觉转正）。
              for (const key of ["matches", "tools", "results"]) {
                const arr = (bridge.result as Record<string, unknown>)[key];
                if (!Array.isArray(arr)) continue;
                for (const item of arr) {
                  const raw = (item as { name?: unknown } | null)?.name;
                  if (typeof raw === "string" && raw) {
                    bridgeSurfacedNames.add(raw);
                    bridgeSurfacedNames.add(raw.replace(/\./g, "_"));
                  }
                }
              }
            }
            const compacted = await compactToolOutputForLlm({
              toolName: item.registryToolName,
              ok: bridge.ok,
              result: bridge.result,
              preferredMaxChars: budgetForTool(item.registryToolName),
              stripKeys: getToolResultStripKeys(item.registryToolName),
            });
            return {
              exec: { ok: bridge.ok, result: bridge.result },
              compacted,
              injectFrames: undefined,
              resultForWire: bridge.result,
              wireToolName: item.registryToolName,
              obsHint: "",
            } as const;
          }
          if (bridge.kind === "call") {
            if (!bridge.ok) {
              const compacted = await compactToolOutputForLlm({
                toolName: item.registryToolName,
                ok: false,
                result: bridge.result,
                preferredMaxChars: budgetForTool(item.registryToolName),
                stripKeys: getToolResultStripKeys(item.registryToolName),
              });
              return {
                exec: { ok: false, result: bridge.result },
                compacted,
                injectFrames: undefined,
                resultForWire: bridge.result,
                wireToolName: item.registryToolName,
                obsHint: "",
              } as const;
            }
            targetToolName = bridge.registryToolName;
            targetArgs = bridge.parsedArgs;
          }
        }

        // 阶段0-3：arguments 非法且修复失败 → 不执行，回填自愈指引（模型看到后重发调用）
        if (item.argsMalformed) {
          const malformed = buildArgsMalformedResult(targetToolName, item.rawArguments ?? "");
          const compacted = await compactToolOutputForLlm({
            toolName: targetToolName,
            ok: false,
            result: malformed.result,
            preferredMaxChars: 800,
          });
          return {
            exec: malformed,
            compacted,
            injectFrames: undefined,
            resultForWire: malformed.result,
            wireToolName: targetToolName,
            obsHint: "",
          } as const;
        }

        // ObservationPack（SoL-Pi 借鉴）：obs_recall 在循环层直接服务——纯内存切片，
        // 不进 ToolRegistry、不走超时竞速/确定性重试管线（与 tool_search 桥接同类）。
        if (targetToolName === OBS_RECALL_TOOL_NAME) {
          // WP1.1：带 query 时先取语义向量（端点未配置/失败返回 null → 纯词面打分）
          let recallArgs: Record<string, unknown> = targetArgs;
          const recallQuery = typeof targetArgs?.query === "string" ? targetArgs.query.trim() : "";
          if (recallQuery) {
            try {
              const queryVector = await embedObsQuery(recallQuery);
              if (queryVector) recallArgs = { ...targetArgs, queryVector };
            } catch {
              /* 语义增强失败静默，词面打分兜底 */
            }
          }
          const recall = obsPack.recall(recallArgs);
          const exec: ToolExecOutcome = recall.ok
            ? { ok: true, result: recall.result }
            : { ok: false, result: { error: recall.error, errorCode: UnifiedErrorCode.ToolArgsMalformed } };
          const recallContent = JSON.stringify(exec.result);
          return {
            exec,
            compacted: {
              content: recallContent,
              rawBytes: recallContent.length,
              compactBytes: recallContent.length,
              compacted: false,
            },
            injectFrames: undefined,
            resultForWire: exec.result,
            wireToolName: OBS_RECALL_TOOL_NAME,
            obsHint: "",
          } as const;
        }

        const TOOL_TIMEOUT_MS = resolveToolExecutionTimeoutMs(targetToolName);

        let exec: ToolExecOutcome;

        // 单次执行尝试：重型工具经并发限制器（code.run / image.generate / voice.* 等），
        // 限流等待不占超时预算：只有 acquire 成功后才开始 Promise.race 计时。
        // 阶段0-1 修复：超时 timer 落定即清（此前每次调用泄漏一个 timer，输掉 race 的
        // promise 在工具结束后 reject 变成 unhandled rejection）；超时后底层工具仍在跑，
        // 信号量已随 race 落定而释放 → 登记残留守卫，同工具的后续调用先等它落定再进
        // 限制器，修复 desktop./browser./phone. 单飞域的互斥破坏。
        // 2026-09-19 增强：超时落定同时 abort 单次调用信号并透传给 handler——
        // 子进程/HTTP 类工具可提前退出，不再"不等待但继续占着真实设备"。
        const attemptExec = async (): Promise<ToolExecOutcome> => {
          await awaitOverrunGuardIfAny(targetToolName);
          return executeWithToolLimit(targetToolName, async () => {
            const callAbort = new AbortController();
            // 击杀自证起点（2026-10-12）：真实耗时由守护在后台落定时上报
            const attemptStartedAt = Date.now();
            const toolPromise = ctx.executeTool(targetToolName, targetArgs, { signal: callAbort.signal });
            let timer: ReturnType<typeof setTimeout> | undefined;
            try {
              return await Promise.race([
                toolPromise,
                new Promise<never>((_, reject) => {
                  timer = setTimeout(() => {
                    callAbort.abort(new ToolExecutionTimeoutError(targetToolName, TOOL_TIMEOUT_MS));
                    // 击杀瞬间只能知道「撑满预算」；是不是「预算不够」要等越界任务落定
                    // （见 registerOverrunGuard 的落定日志）。这条 warn 保证击杀不再静默。
                    console.warn(
                      `[tool-budget] 击杀 tool=${targetToolName} 预算=${TOOL_TIMEOUT_MS}ms（越界任务转后台收尾，真实耗时见同工具落定日志）`,
                    );
                    registerOverrunGuard(targetToolName, toolPromise, attemptStartedAt, TOOL_TIMEOUT_MS);
                    reject(new ToolExecutionTimeoutError(targetToolName, TOOL_TIMEOUT_MS));
                  }, TOOL_TIMEOUT_MS);
                }),
              ]);
            } finally {
              if (timer) clearTimeout(timer);
            }
          });
        };

        // 完整执行流程（超时兜底 + 非超时失败确定性重试 1 次），作为共享 Promise 的载荷：
        // 同一波内并发的相同工具调用复用同一次执行，不再各自真实执行。
        const runExecWithRetry = async (): Promise<ToolExecOutcome> => {
          // 执行守卫（2026-10-19 handoff）：可见集已裁掉外部动作族，这里兜住
          // 「模型凭记忆直呼工具名」与 tool_call 桥按名转正两条侧门——
          // 等待用户操作期间，外部动作**一次真执行都不允许发生**（防重复下单）。
          if (isHandoffBlockedTool(targetToolName)) {
            return {
              ok: false,
              result: {
                error:
                  `【已收起】当前有一步在等用户自己操作（${handoffBlocking?.handoff?.instruction ?? ""}），` +
                  "外部动作类工具本轮不允许执行——不要替用户下单/支付/发送。用户回执后系统会继续；" +
                  "用户不做了就把该步置 skipped。",
                errorCode: UnifiedErrorCode.ToolDenied,
                toolName: targetToolName,
              },
            };
          }
          let exec: ToolExecOutcome;
          try {
            exec = await attemptExec();
          } catch (err) {
            if (isToolExecutionTimeoutError(err)) {
              // 真超时：时间预算已烧完，重试只会让前端再等一倍时间 → 不重试
              console.error(`[工具超时] ${targetToolName}: ${err.message}（残留执行已登记守卫）`);
              exec = {
                ok: false,
                result: {
                  error: `工具执行超时，请稍后重试。(${TOOL_TIMEOUT_MS}ms)`,
                  timeout: true,
                  errorCode: UnifiedErrorCode.ToolTimeout,
                  toolName: targetToolName
                }
              };
            } else {
              // 阶段0-2 修复：此前任何异常都被谎报为 timeout:true 且跳过重试；现在
              // 如实透传错误（ToolRegistry 内部已把 handler 异常转 {ok:false}，能走到
              // 这里的是 BodyGateway 等未包装路径的真实故障），交给下方确定性重试。
              const message = err instanceof Error ? err.message : String(err);
              console.error(`[工具执行异常] ${targetToolName}:`, message);
              exec = {
                ok: false,
                result: {
                  error: message,
                  errorCode: UnifiedErrorCode.ToolExecutionFailed,
                  toolName: targetToolName
                }
              };
            }
          }
          // 失败确定性重试：非超时失败（瞬时故障/网络抖动）自动重试至多 2 次，
          // 第二次带指数退避（500ms）——上游限流/瞬断在 500ms 窗口内恢复的概率
          // 显著高于立即重打；超时已烧完整个时间预算，不重试。
          const isTimeoutFailure =
            (exec.result as Record<string, unknown> | undefined)?.timeout === true;
          // 工具名未知是确定性失败（重试 N 次还是未知）：不进重试循环，走下方
          // 「错误即检索」回填候选。防模型幻觉一个名字就白烧 500ms 退避。
          const isUnknownToolFailure =
            (exec.result as Record<string, unknown> | undefined)?.errorCode ===
            UnifiedErrorCode.ToolUnknown;
          if (!exec.ok && !isTimeoutFailure && !isUnknownToolFailure) {
            const retryDelaysMs = [0, 500];
            for (let attempt = 0; attempt < retryDelaysMs.length; attempt++) {
              const delay = retryDelaysMs[attempt];
              if (delay > 0) {
                await new Promise((r) => setTimeout(r, delay));
              }
              if (attempt > 0) {
                console.warn(
                  `[plan-execute] ${targetToolName} 第${attempt + 1}次重试（退避 ${delay}ms）: ` +
                    JSON.stringify(exec.result).slice(0, 200),
                );
              } else {
                console.warn(
                  `[plan-execute] ${targetToolName} 首次执行失败，确定性重试: ` +
                    JSON.stringify(exec.result).slice(0, 200),
                );
              }
              try {
                const retried = await attemptExec();
                if (retried.ok) {
                  exec = retried;
                  break;
                }
              } catch {
                /* 保留上次失败结果 */
              }
            }
          }
          // 错误即检索（2026-10-09 L3）：模型直呼了不存在的工具名——不让它停在
          // 「未知工具」死胡同里盲试或手写答案，错误回执直接携带 BM25 top-3
          // 候选名 + 指引。弱模型只需会读错误消息即可自愈（错误消息即检索结果）。
          if (isUnknownToolFailure && isToolRecallEnabled()) {
            const candidates = topToolMatchesForQuery(
              targetToolName.replace(/[_.]/g, " "),
              recallCorpus,
              3,
              visibleAtStart,
              // 幻觉名候选跳过绝对闸：名字 token 命中即证据（描述先验对英文名无重叠）
              { minScore: 0 },
            ).map((m) => m.name);
            if (candidates.length > 0) {
              exec = {
                ok: false,
                result: {
                  ...exec.result,
                  suggestions: candidates,
                  hint:
                    `工具「${targetToolName}」不存在。最接近的可用工具：${candidates.join("、")}。` +
                    `若其中之一匹配需求：先用 tool_discover 查看它的参数 schema，再正确调用；` +
                    `若都不匹配，请如实告知用户不要编造。`,
                },
              };
              console.info(
                `[openai-tool-loop] 未知名工具 ${targetToolName} → 错误即检索候选 [${candidates.join(", ")}]`,
              );
            }
          }
          return exec;
        };

        // 轮内去重缓存：同工具+同参数 → 共享同一次执行（含确定性重试）。
        // 替代旧 ReAct 循环的"重复搜索制动"——波次有界 + 去重，从源头消除重复执行。
        const dedupeKey = `${targetToolName}::${stableArgsKey(targetArgs)}`;
        // 跨轮 TTL 缓存：查询类工具在 TTL 内相同参数直接返回缓存，跳过安全检查/BodyGateway 等中间层
        const cachedResult = ctx.getCachedToolResult?.(targetToolName, targetArgs);

        const inflight = turnDedupeCache.get(dedupeKey);
        if (inflight) {
          // 命中（进行中或已成功落定）：直接复用同一次执行的结果
          exec = await inflight;
        } else if (cachedResult) {
          exec = cachedResult;
        } else {
          const shared = runExecWithRetry().then((settled) => {
            // 失败结果不驻留缓存：本轮后续 replan 波次仍可重新执行；
            // 同波内已在等待的并发调用持有同一 Promise 引用，不受删除影响。
            if (!settled.ok) turnDedupeCache.delete(dedupeKey);
            return settled;
          });
          turnDedupeCache.set(dedupeKey, shared);
          exec = await shared;
        }
        
        let injectFrames: VisionFrame[] | undefined;
        let resultForWire: Record<string, unknown>;
        if (
          exec.ok &&
          exec.result &&
          Array.isArray((exec.result as Record<string, unknown>)[TOOL_RESULT_VISION_INJECT_KEY])
        ) {
          injectFrames = (exec.result as Record<string, unknown>)[TOOL_RESULT_VISION_INJECT_KEY] as VisionFrame[];
          resultForWire = { ...(exec.result as Record<string, unknown>) };
          delete resultForWire[TOOL_RESULT_VISION_INJECT_KEY];
        } else {
          resultForWire = exec.result;
        }
        // 自动检测工具结果中的图片(imageBase64)。
        // 视觉模型 → 转成多模态 image_url 注入;非视觉模型 → 注明图片未解析（PaddleOCR 已移除）。
        if (
          exec.ok &&
          resultForWire &&
          typeof (resultForWire as Record<string, unknown>).imageBase64 === "string"
        ) {
          const rw = resultForWire as Record<string, unknown>;
          const b64 = rw.imageBase64 as string;
          const mime = typeof rw.mimeType === "string" ? rw.mimeType : "image/png";
          if (modelSupportsVision(model)) {
            // 视觉模型:注入 image_url 让 LLM 直接看图
            const frame: VisionFrame = {
              sourceKind: "agent_attachment",
              sourceId: targetToolName,
              mimeType: mime,
              dataBase64: b64,
            };
            injectFrames = injectFrames ? [...injectFrames, frame] : [frame];
          } else {
            // 非视觉模型:明确告知图片未解析,避免模型误以为自己看过图
            (rw as Record<string, unknown>).imageNote =
              "（图片未解析：当前模型不支持视觉输入，无法读取图片内容）";
          }
          // 移除 base64 数据,避免压缩后以文本形式重复注入
          resultForWire = { ...rw };
          delete resultForWire.imageBase64;
        }
        const compacted = await compactToolOutputForLlm({
          toolName: targetToolName,
          ok: exec.ok,
          result: exec.ok ? resultForWire : { error: exec.result.error ?? exec.result },
          preferredMaxChars: budgetForTool(targetToolName),
          stripKeys: getToolResultStripKeys(targetToolName),
        });
        // ObservationPack（SoL-Pi 借鉴）：压缩确实省了大量字符时归档完整原文为
        // obs_N 句柄，并在 tool 消息尾部附读回提示——模型需要细节时按句柄分页
        // 读回，不必重新执行原工具。
        let archivedObs: ArchivedObservation | null = null;
        if (exec.ok) {
          archivedObs = archiveIfWorthwhile(
            obsPack,
            targetToolName,
            item.tc.id,
            compacted.rawText,
            compacted.content,
          );
        }
        // WP0 压缩遥测：记每工具压缩前/后规模（analyze-token-audit.mjs 按工具聚合节省率）。
        try {
          recordToolCompactionByChars({
            toolName: targetToolName,
            sessionId: options?.audit?.sessionId,
            rawChars: compacted.rawBytes,
            compactChars: compacted.compactBytes,
          });
        } catch {
          /* 遥测失败静默 */
        }
        return {
          exec,
          compacted,
          injectFrames,
          resultForWire,
          wireToolName: targetToolName,
          obsHint: archivedObs ? "\n" + buildObservationRecallHint(archivedObs) : "",
        } as const;
      }),
    );

    // 2026-09-05：escalate 哨兵短路已删除——升级/重放机制退役，
    // 出口自检在 final-text 分支统一处理（见上方 outcomeGateEnforced）。

    // 本波最后一条成功工具消息的下标：充分性提示只追加一次。
    // 此前每条成功消息都重复追加同一段提示（5 个并行工具 = 5 份相同文本）。
    let lastOkToolIndex = -1;
    for (let i = 0; i < settledResults.length; i++) {
      const s = settledResults[i];
      if (s.status === "fulfilled" && s.value.exec.ok) lastOkToolIndex = i;
    }

    for (let i = 0; i < workItems.length; i++) {
      const item = workItems[i];
      const settled = settledResults[i];
      const exec = settled.status === "fulfilled" ? settled.value.exec : { ok: false, result: { error: settled.reason instanceof Error ? settled.reason.message : String(settled.reason) } };
      const compacted = settled.status === "fulfilled" ? settled.value.compacted : { content: JSON.stringify(exec.result), rawBytes: 0, compactBytes: 0, compacted: false };
      const injectFrames = settled.status === "fulfilled" ? settled.value.injectFrames : undefined;
      const wireToolName =
        settled.status === "fulfilled" ? settled.value.wireToolName : item.registryToolName;

      toolResults.push({ name: wireToolName, ok: exec.ok });
      const callStart = traceCallStartByCallId.get(item.tc.id);
      // 参数级失败观测（2026-10-10 L3 盲区）：args 非法 JSON / schema 校验不过
      // 单独标注——名字纠错（错误即检索）管不到参数错，重灾区工具靠此定位。
      const paramError =
        !exec.ok &&
        (() => {
          const code = classifyToolFailure(exec.result);
          return (
            code === UnifiedErrorCode.ToolArgsMalformed || code === UnifiedErrorCode.ValidationError
          );
        })();
      const callElapsed = callStart ? Date.now() - callStart : 0;
      const callBudgetMs = resolveToolExecutionTimeoutMs(wireToolName);
      traceToolCalls.push({
        name: wireToolName,
        ok: exec.ok,
        ms: callElapsed,
        budgetMs: callBudgetMs,
        timedOut: inferToolCallTimedOut(exec.ok, callElapsed, callBudgetMs),
        viaRequestCard: requestCardLoadedNames.has(wireToolName),
        ...(paramError ? { paramError: true } : {}),
        acquisition: isToolSearchBridgeName(wireToolName)
          ? "bridge"
          : visibleAtStart.has(wireToolName)
            ? "visible"
            : bridgeSurfacedNames.has(wireToolName) || requestCardLoadedNames.has(wireToolName)
              ? "deferred"
              : // 未检索/未转正就直呼的不可见名：registry 放行执行（L3 转正语义），
                // 单独标注供「幻觉转正率」观测与晋升闭环对账。
                "hallucination_promoted",
      });
      if (isInteractiveToolName(wireToolName)) {
        waveUsedInteractiveTool = true;
      }
      ctx.onToolExecuted?.({
        toolName: wireToolName,
        input: item.parsedArgs,
        ok: exec.ok,
        result: settled.status === "fulfilled" ? settled.value.resultForWire : exec.result,
      });
      // 累积工具结果供 summary 调用做策略评估（input 供升级继承记录关键入参）。
      // 上下文管线支撑工具（obs_recall）只回读历史归档，不产生新数据，不参与评估，
      // 也不计入出口自检的「尝试过实质工具」判定（见 SUPPORT_PLUMBING_TOOLS）。
      if (!SUPPORT_PLUMBING_TOOLS.has(wireToolName)) {
        allToolExecResults.push({
          toolName: wireToolName,
          ok: exec.ok,
          input: item.parsedArgs,
          result: settled.status === "fulfilled" ? settled.value.resultForWire : exec.result,
        });
      }
      const toolContent = compacted.content;
      // 非视觉模型收到含图工具结果时,附"图片未解析"说明,让 LLM 明确自己看不到画面
      const imageNote = settled.status === "fulfilled"
        ? (settled.value.resultForWire as Record<string, unknown>)?.imageNote
        : undefined;
      const fullToolContent = typeof imageNote === "string" && imageNote.trim()
        ? `${toolContent}\n\n${imageNote}`
        : toolContent;
      // 不可信内容围栏（2026-09-19 P1-1）：外部数据进消息流前统一隔离，
      // 命中注入模式附加警示；元工具/系统回读结果跳过。
      const fencedToolContent = shouldFenceToolContent(wireToolName)
        ? fenceUntrustedToolContent(wireToolName, fullToolContent)
        : fullToolContent;
      // 对成功的工具结果追加信息充分性提示，减少 LLM 不必要的二次调用。
      // 只追加在本波最后一条成功消息上（内容与具体工具无关，逐条重复纯烧 token）。
      // 关键洞察：LLM 重复调用工具的根因是不确定结果是否足够回答。
      // 明确告诉 LLM「结果已完整」，让它直接回答而非重复调用。
      const sufficiencyHint =
        exec.ok && i === lastOkToolIndex && !BOOKKEEPING_TOOL_NAMES.has(wireToolName)
          ? buildToolSufficiencyHint(wireToolName, fullToolContent)
          : "";
      // 对失败的工具结果追加强约束 reminder，防止 LLM 忽略 error 字段后对用户撒谎。
      // 关键场景：desktop.open 派发进程但窗口未起来 → ok=false → LLM 必须如实承认失败。
      const failureReminder = !exec.ok
        ? buildToolFailureReminder(wireToolName, fullToolContent)
        : "";
      // 照片轮回复方式提示：search_images 成功即挂，定住「交图为主、正文一两句」的形态。
      const photoReplyHint =
        exec.ok && wireToolName === "search_images" ? PHOTO_REPLY_HINT : "";
      // ObservationPack：压缩点归档成功时附读回提示（排在最前，紧贴被压缩的结果原文）。
      const obsHint = settled.status === "fulfilled" ? settled.value.obsHint : "";
      const appendedHints = [obsHint, sufficiencyHint, failureReminder, photoReplyHint]
        .filter(Boolean)
        .join("\n");
      messages.push({
        role: "tool",
        tool_call_id: item.tc.id,
        content: appendedHints
          ? `${fencedToolContent}\n${appendedHints}`
          : fencedToolContent,
      });
      if (injectFrames?.length) {
        const frameHint =
          wireToolName === "desktop.visual.screenshot" || wireToolName === "vision.http_pull"
            ? wireToolName === "desktop.visual.screenshot"
              ? "（以下为 desktop.visual.screenshot 截取的当前屏幕画面；请仔细观察画面内容,判断当前屏幕状态和可操作元素,然后决定下一步动作。）"
              : "（以下为 vision.http_pull 抓取的远程图像帧；请客观描述画面并继续完成任务。）"
            : `（以下为 ${wireToolName} 返回的图像；请根据画面内容继续完成任务。）`;
        messages.push({
          role: "user",
          content: openAiUserContentFromTurn({
            text: frameHint,
            visionFrames: injectFrames,
          }),
        });
      }
    }

    options?.onAfterToolBatch?.({
      roundIndex: wave,
      assistantText: fullText,
      toolResults,
    });

    // ── 波次终止决策 ──（与 for 条件共用 effectiveMaxWaves：失败发生后预算 +1）
    const wavesRemaining = wave + 1 < effectiveMaxWaves();
    if (!wavesRemaining) {
      // 预算耗尽仍有未收尾的工具链 → 兜底 SUMMARIZE（失败信息已在 tool 消息中）
      break;
    }

    const allSucceeded = toolResults.length > 0 && toolResults.every((r) => r.ok);
    const hasMetaTool = toolResults.some((r) => META_TOOL_NAMES.has(r.name));
    // 完成语义契约（2026-10-22）：派发型（queued）成功 ≠ 有内容。全部成功但
    // 成功项都是派发时，禁走汇总捷径——捷径会把「已派发」直接收尾成最终回复
    // （模型据 dispatch 的 ack 写「已经让后台去查了」，出口闸被整个绕过，这正是
    // search_movies 病灶）。必须回落正常波次循环：模型带着派发回执继续，要么
    // 真正查询，要么如实说明「稍后给」；若零内容收尾，出口闸 queued_without_content 兜底。
    const allQueued =
      allSucceeded &&
      toolResults.every((r) => QUEUED_PRODUCER_TOOLS.has(r.name.replace(/_/g, ".")));

    if (allSucceeded && !allQueued && !hasMetaTool && !waveUsedInteractiveTool) {
      // 充分性探测（token 最省路径）：不带 schema 的轻量汇总调用。工具结果已完整
      // 存在于上方 tool 消息里（无压缩/折叠），汇总指令不再重复 dump。
      // 首行输出 NEED_MORE_TOOLS → 结果不足，升级一次 replan（带 schema）。
      const probe = await runSchemaLessSummary(true);
      if (!probe.needMore) {
        console.info(
          `[plan-execute] wave=${wave} ${toolResults.length} 个工具全部成功，探测通过 → 无 schema 汇总收尾（工具 schema 不再重发）`,
        );
        logPrefixCacheStats();
        recordTurnFinished();
      recordTurnTrace({
          ts: traceStartTs,
          stage: options?.audit?.stage ?? "main_chat_tools",
          model,
          ...(options?.turnIntent ? { turnIntent: options.turnIntent } : {}),
          ...(options?.turnIntent
            ? { turnEvidenceInjected: options.turnEvidenceInjected === true }
            : {}),
          ...(options?.turnRouteConfidence !== undefined
            ? { routeConfidence: options.turnRouteConfidence }
            : {}),
          visibleTools: registryTools.length,
          deferredActive: toolSearchPrepared.toolSearchActive,
          deferredCount: toolSearchPrepared.deferredToolCount,
          waves: traceWavesUsed,
          toolCalls: traceToolCalls,
          ...(traceRequestCard ? { requestCard: traceRequestCard } : {}),
          ...(traceExitGate ? { exitGate: traceExitGate } : {}),
          finalTextChars: probe.text.length,
          durationMs: Date.now() - traceStartTs,
        });
        // 线程落库契约（2026-10-22 根修·重复回复事故）：schema-less 汇总的答案此前
        // 只随返回值交 done，从不进 messages——回写后线程停在 assistant(tool_calls)
        // → tool*，foldCompletedToolChains 折成「[动作台账]…本轮未生成可见回复」，
        // 下一轮模型看到「问了天气但没回复」就把工具重新调一遍。最终答案必须与
        // 最终波路径（上方 messages.push assistant(content)）同契约落进 messages。
        // holdAnswer 轮 streamedVisible 为空，provider 层兜底也救不回来，只能在这里补。
        if (probe.text.trim()) {
          messages.push({ role: "assistant", content: probe.text });
        }
        return probe.text;
      }
      console.info(`[plan-execute] wave=${wave} 汇总探测报告结果不足，进入 replan 波次`);
      continue;
    }
    // 存在失败 / 元工具（tool_search 桥接）/ 交互式工具 → replan（带 schema，
    // 模型基于已有结果继续规划或直接给出最终回答）
  }

  // ── 兜底 SUMMARIZE：波次耗尽仍未收尾的工具链（无逃生门的最终汇总，流式输出）──
  const finalSummary = await runSchemaLessSummary(false);
  logPrefixCacheStats();
  // 出口自检（summary 路径，2026-09-05 统一）：波次已耗尽、且最终汇总仍未满足诉求
  // → 无预算续波，如实收尾（记录日志供观测；不再返回升级哨兵/整轮重放）。
  {
    const summaryUnsatisfiedReason = assessTurnUnsatisfied(finalSummary.text);
    if (summaryUnsatisfiedReason) {
      console.info(
        `[openai-tool-loop] summary 出口自检：${summaryUnsatisfiedReason}` +
          `（工具尝试 ${allToolExecResults.length} 次，成功实质 ${countSubstantiveOkResults()} 次）→ 预算耗尽，如实收尾`,
      );
    }
  }
  recordTurnFinished();
      recordTurnTrace({
    ts: traceStartTs,
    stage: options?.audit?.stage ?? "main_chat_tools",
    model,
    ...(options?.turnIntent ? { turnIntent: options.turnIntent } : {}),
    ...(options?.turnIntent
      ? { turnEvidenceInjected: options.turnEvidenceInjected === true }
      : {}),
    ...(options?.turnRouteConfidence !== undefined
      ? { routeConfidence: options.turnRouteConfidence }
      : {}),
    visibleTools: registryTools.length,
        deferredActive: toolSearchPrepared.toolSearchActive,
        deferredCount: toolSearchPrepared.deferredToolCount,
        ...(recallInjectedNames.length > 0 ? { recallInjectedNames } : {}),
        ...(userText ? { query: userText.slice(0, 160) } : {}),
    waves: traceWavesUsed,
    toolCalls: traceToolCalls,
    ...(traceRequestCard ? { requestCard: traceRequestCard } : {}),
    ...(traceExitGate ? { exitGate: traceExitGate } : {}),
    finalTextChars: finalSummary.text.length,
    durationMs: Date.now() - traceStartTs,
  });
  // 同上（2026-10-22 根修）：预算耗尽的兜底汇总同样只返回不落 messages，
  // 线程会停在 tool 链上被折成「未生成可见回复」的动作台账 → 下一轮重复调工具。
  if (finalSummary.text.trim()) {
    messages.push({ role: "assistant", content: finalSummary.text });
  }
  return finalSummary.text;

  /**
   * SUMMARIZE 阶段：单次不带工具 schema 的汇总调用（流式）。
   *
   * - 工具结果存在于 messages 的 tool 消息里；旧波工具链折叠为确定性摘要
   *   （SUMMARY_FOLD_DIGEST_CHARS），最近一波完整保留。汇总指令不再重复
   *   dump 工具结果，省一份 token。
   * - escapeAllowed=true 时为「充分性探测」：首行输出 NEED_MORE_TOOLS 表示
   *   结果不足以回答，调用方据此升级一次 replan。为避免标记透出到前端，
   *   首行（或前 48 字符）先缓冲，判定不是标记后才 flush 给 onDelta。
   * - 产出为空/道歉式 → 道歉式兜底已删除（2026-09-08）：探测模式视为结果不足
   *   （needMore=true 升级 replan），最终汇总模式原样返回（如实收尾）。
   * - 调用异常 → 同上：探测模式升级 replan，最终汇总模式返回空串如实收尾。
   */
  async function runSchemaLessSummary(
    escapeAllowed: boolean,
  ): Promise<{ text: string; needMore: boolean }> {
    // summary 输出预算：跟随调用方的 maxOutputTokens；未配置时**不封顶**。
    // 历史上未配置时兜底 2000，多来源汇总/长攻略被 finish_reason=length 硬截半句
    // （该 finish_reason 全链路无人检查，属静默截断），已删除兜底上限。
    const summaryMaxTokens =
      options?.maxOutputTokens && options.maxOutputTokens > 0 ? options.maxOutputTokens : undefined;
    try {
      // 过滤无效 assistant message：OpenAI API 要求 assistant 消息必须有 content 或 tool_calls
      const sanitizedMessages = messages.filter((m) => {
        if (m.role !== "assistant") return true;
        const hasContent = typeof m.content === "string" && m.content.trim().length > 0;
        const hasToolCalls =
          Array.isArray((m as { tool_calls?: unknown }).tool_calls) &&
          ((m as { tool_calls?: unknown[] }).tool_calls?.length ?? 0) > 0;
        return hasContent || hasToolCalls;
      });

      // ① 旧波工具链折叠（2026-09-05）：多波任务此前把全部波次的工具结果原文
      // 完整重发给汇总调用（replan 后甚至重发两次）。现仅保留最近一波完整链，
      // 旧波折叠为 400 字符确定性摘要（工具名+结果要点，URL 安全截断）——
      // 比 replan 折叠（160）更长，保住跨波对比需要的关键数据。
      // 用户文本命中「指代早期对话」措辞时跳过折叠（与条数裁剪同一保护闸）。
      const foldAllowed = !(userText && SUMMARY_TRIM_REFERENCE_CUES.test(userText));
      const summaryBaseMessages = foldAllowed
        ? foldOldWaveToolChains(sanitizedMessages, SUMMARY_FOLD_DIGEST_CHARS)
        : sanitizedMessages;

      // ② summary 历史裁剪：只保留全部 system + 最近 N 个用户回合（含其后的全部工具链），
      // 丢弃更早纯对话。工具结果完整保留，最终回答的真实数据不丢；短对话为无操作。
      // 质量保护：当前用户文本命中指代早期对话的措辞（刚才/上面/继续等）时跳过裁剪。
      const trimmedMessages = trimHistoryForSummary(summaryBaseMessages, SUMMARY_KEEP_USER_TURNS, userText);

      // 数据驱动策略评估：根据工具收集到的真实数据质量选择回复策略
      const strategyDirective = evaluateAndSelectStrategy(allToolExecResults, userText, options?.turnIntent);
      const strategyBlock = strategyDirective.instruction
        ? `\n\n【回复策略】${strategyDirective.instruction}`
        : "";
      console.log(
        `[synthesis] 策略=${strategyDirective.strategy} 等级=${strategyDirective.quality.level} ` +
          `来源=${strategyDirective.quality.sourceCount} 成功=${strategyDirective.quality.successCount} ` +
          `内容=${strategyDirective.quality.totalContentLength}字符 理由=${strategyDirective.quality.reason}`,
      );
      // 零工具结果守卫（2026-08-28）：本轮没有任何工具执行（含搜索）时，
      // 明确告知 LLM 禁止虚构"已查询/已翻阅/公开渠道没查到"——假搜索回复的
      // 最后防线。正则门控（forced-tool）+ 强制联网兜底已在前置层拦住绝大多数，
      // 这里兜住漏网：模型在无任何证据下编造"查过了"的叙述。
      // 元工具兜底守卫（2026-08-29）：本轮只执行了 tool_discover / agent.query_capabilities
      // 这类"查工具目录"的元工具（或全部失败）时，LLM 手里的"工具结果"只有能力描述文本。
      // 若仍按"基于这些结果回答"引导，会产出"工具没返回内容，都是些功能说明"这种
      // 把机制话透给用户的回复（fast maxRounds=1 下是高发路径：发现→执行需两轮，单波必断头）。
      const substantiveToolResults = allToolExecResults.filter(
        (r) => !META_TOOL_NAMES.has(r.toolName) && !BOOKKEEPING_TOOL_NAMES.has(r.toolName) && r.ok,
      );
      const metaOnlyGuard =
        allToolExecResults.length > 0 && substantiveToolResults.length === 0
          ? `\n\n【重要】本轮只查询了工具目录/能力清单（或工具全部执行失败），没有拿到任何真实的外部内容。` +
            `严禁把工具说明、能力描述、参数列表当作查询结果复述给用户；` +
            `严禁说"工具没返回""都是些功能说明"这类暴露机制的话；也不要声称已经查到资料。` +
            `请基于对话上下文自然回应；若用户要的是需要真正查询才能拿到的信息，就照实说你得现查。`
          : "";
      const zeroToolGuard =
        allToolExecResults.length === 0
          ? `\n\n【重要】本轮没有执行任何工具或检索。严禁声称已经查询、搜索、翻阅过任何资料` +
            `（包括"翻了一圈""公开渠道没查到""据我了解最新消息"等说法）；` +
            `也不要编造任何具体信息来源。请直接说明本轮未获取到外部信息。`
          : "";
      // 求简指令只对真正的单一事实求证生效；其余一律要求把信息组织充分（2026-09-03：
      // 检索/任务型回复不再受「口语求简」约束，需按主题分节、可用 Markdown 排版）
      // 纯图轮例外（2026-10-06）：search_images 拿到照片且无文字检索结果时，
      // 交付就是图本身，「按主题分节、信息用足」会教出「已确认的/能说的/没查到的」
      // 盘点正文（真机事故形态）；展开要求由 strategyBlock 的照片轮指令承担。
      const photoDeliveryRound = isPhotoDeliveryRound(allToolExecResults, options?.turnIntent);
      const singleFactClause = isDirectFactQuery(userText)
        ? `这是单一事实求证（是/否、一个数据点）：给「结论 + 1 句依据」即可，最多保留一个简短追问。`
        : `把检索到的信息组织充分：按主题分节，用 Markdown 小标题/加粗/表格排版，保留日期、数字、来源等细节，不要为了简短丢掉用户想看的内容。`;
      const baseDirective =
        (photoDeliveryRound
          ? `刚才的照片搜索已完成，请把图片直接交给用户，回复方式按【回复策略】执行。`
          : substantiveToolResults.length > 0
          ? `刚才调用工具拿到了以下结果，请基于这些结果回答用户的问题：语气自然像朋友，但内容要充分、结构清晰。` +
            `不要重复工具调用过程，直接给出结论。如果结果不完整，就给出能确定的部分。` +
            `同一事实不要换个说法再总结第二遍；${singleFactClause}`
          : `请基于本轮对话上下文，用自然、像朋友一样的语气回答用户的问题。`) +
        strategyBlock +
        zeroToolGuard +
        metaOnlyGuard;
      const escapeDirective = escapeAllowed
        ? `\n\n【重要】如果你认为现有工具结果不足以回答用户的问题（例如还需要抓取某个具体网页、` +
          `还需要换关键词再查一次），第一行只输出 ${NEED_MORE_TOOLS_MARKER}，不要输出任何其他内容。` +
          `能回答时直接回答，禁止输出该标记。`
        : "";
      const summaryMessages: ChatCompletionMessageParam[] = [
        ...trimmedMessages,
        { role: "user", content: baseDirective + escapeDirective },
      ];
      const summaryResp = await client.chat.completions.create({
        model,
        messages: summaryMessages,
        temperature: 0.5,
        // 输出上限跟随调用方配置；未配置时不传 max_tokens（不封顶）。
        // 之前硬编码 800 又改兜底 2000，都会把长汇总硬截半句（主链路设计是
        // 默认不限 max_tokens，见 agent-core chatLaneMaxOutputTokens 注释）。
        ...(summaryMaxTokens ? { max_tokens: summaryMaxTokens } : {}),
        // thinking 开关与循环内请求（见下方 wave 循环 request 的 extraBody spread）
        // 对齐：deepseek-flash 默认带思考链，循环内经 extraBody 关思考，这里此前漏传，
        // 思考 token 挤占输出预算且明显拖慢收尾。同样直接 spread 到顶层（SDK 不识别
        // Python 风格 extra_body 字段）。
        ...(options?.extraBody ?? {}),
        stream: true,
      }, options?.signal ? { signal: options.signal } : undefined);

      let summaryText = "";
      let needMore = false;
      // 答案留存闸（2026-10-13 根修）：工具全成功波的最终答案正是这条 schema-less
      // 汇总通道产出的——它绕过主 consumer 的波内直推，必须独立关闸，否则
      // 「先流式输出答案 → done 弹卡」从这里整段漏出。留存轮 summaryText 照常
      // 累积并随返回值交 done；NEED_MORE 首行探测不受影响（replan 判定仍需）。
      const holdSummary = answerHeld();
      // 逃生模式下先缓冲首行（或前 48 字符）再决定是否推送给前端，防止标记透出
      let headDecided = !escapeAllowed;
      let pendingHead = "";
      const summaryConsumeResult = await consumeNormalizedStream(
        adaptOpenAiChatCompletionStream(
          summaryResp as AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>,
        ),
        {
          onContentDelta: (d) => {
            // 繁→简出口正规化：累计（summaryText）与直推同源归一。
            const nd = normalizeTraditionalToSimplified(d).text;
            summaryText += nd;
            if (headDecided) {
              if (!needMore && !holdSummary) onDelta(nd);
              return;
            }
            pendingHead += nd;
            const nl = pendingHead.indexOf("\n");
            if (nl >= 0 || pendingHead.trim().length >= 48) {
              headDecided = true;
              const firstLine = (nl >= 0 ? pendingHead.slice(0, nl) : pendingHead).trim();
              if (firstLine.startsWith(NEED_MORE_TOOLS_MARKER)) {
                needMore = true;
              } else if (!holdSummary) {
                onDelta(pendingHead);
              }
              pendingHead = "";
            }
          },
          providerId: "openai-compatible",
          model,
        },
      );
      // 汇总调用同样计入前缀缓存统计（该调用无 schema，命中率反映「system+历史前缀」的缓存质量）
      accumulatePrefixCacheUsage(summaryConsumeResult.usage);
      // 流结束仍未触发首行判定（回答极短且无换行）
      if (!headDecided) {
        headDecided = true;
        if (pendingHead.trim().startsWith(NEED_MORE_TOOLS_MARKER)) {
          needMore = true;
        } else if (pendingHead && !holdSummary) {
          onDelta(pendingHead);
        }
        pendingHead = "";
      }
      summaryText = summaryText.trim();
      // Token 用量审计：summary/探测轮跟随调用方 stage（任务面 task_plane_* /
      // 前台 main_chat_tools），与规划轮次同一把尺子。
      // needMore 的探测也是一次真实 LLM 调用，必须计入（否则低估 token 消耗）。
      try {
        recordLlmUsageByChars({
          stage: options?.audit?.stage ?? "main_chat_tools",
          sessionId: options?.audit?.sessionId,
          inputChars: JSON.stringify(summaryMessages).length,
          outputChars: summaryText.length,
          model,
          ...(typeof summaryConsumeResult.usage?.inputTokens === "number"
            ? { apiPromptTokens: summaryConsumeResult.usage.inputTokens }
            : {}),
          ...(typeof summaryConsumeResult.usage?.outputTokens === "number"
            ? { apiCompletionTokens: summaryConsumeResult.usage.outputTokens }
            : {}),
        });
      } catch {
        /* 审计失败静默 */
      }
      if (needMore) {
        return { text: "", needMore: true };
      }
      // 道歉式兜底已彻底删除（2026-09-08 用户指令）：summary 为空/道歉式时不再回退
      // 「工具结果原文拼接」——那会把工具 JSON 直接糊给用户，是「先流式说没搜到、
      // 突然变成搜索结果卡」的直接源头。改向：
      //  - 探测模式（escapeAllowed=true）→ needMore=true，升级 replan 重试（任务完成保障）；
      //  - 最终汇总模式 → 原样返回（含道歉文本，如实收尾），宁可诚实说没结果也不糊工具原文。
      if (summaryText && !isApologyStyleFallback(summaryText)) {
        return { text: summaryText, needMore: false };
      }
      return { text: summaryText, needMore: escapeAllowed };
    } catch (summaryErr) {
      console.log(
        `[plan-execute] summary 调用失败: ${
          summaryErr instanceof Error ? summaryErr.message : String(summaryErr)
        }`,
      );
      // 探测模式失败 → 视为结果不足升级 replan（不再拿工具原文冒充答案）；
      // 最终汇总模式失败 → 返回空串如实收尾（已流式送出的部分文本由前端保留）。
      return { text: "", needMore: escapeAllowed };
    }
  }
}
