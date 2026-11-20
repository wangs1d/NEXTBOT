import type { ChatCompletionTool } from "openai/resources/chat/completions";
import { toolInCapabilityDomains } from "../tools/tool-search/tool-category.js";
import { isMediaOnlyRequest } from "../agent/realtime-search-query.js";
import { filterTextSearchTools, filterMediaModalityTools } from "../agent/web-search-consent.js";

import {
  mergeChatToolsForAccessMode,
  parseAgentAccessMode,
  type ChatToolsAccessContext,
} from "../agent/agent-access-mode.js";
import { getBuiltinAgentChatTools } from "./openai-compatible-tool-loop.js";
import type { AgentStreamOptions, ToolExposureProfile } from "./types.js";
// 从 tool-search/catalog 具体模块导入而非 gateway/index 大桶——本模块被 abstract-chat-provider 引用，经桶文件会回连 providers/* 形成循环
import { applyVisibleToolBudget } from "./visible-tool-stabilizer.js";
import { residentNamesForLane } from "../tools/exposure/residency.js";

export type ResolvedChatToolPlan = {
  visibleTools: ChatCompletionTool[];
  searchableTools: ChatCompletionTool[];
};

const _resolvedToolsCache = new Map<string, ChatCompletionTool[]>();
const MAX_RESOLVED_TOOLS_CACHE = 32;

function resolvedToolsCacheKey(userText?: string, streamOpts?: AgentStreamOptions): string {
  const builtinNames = (streamOpts?.chatToolsBuiltin ?? getBuiltinAgentChatTools())
    .map((t) => (t.type === "function" ? t.function?.name ?? "" : t.type))
    .filter(Boolean)
    .sort()
    .join(",");
  const extraNames = (streamOpts?.chatToolsExtra ?? [])
    .map((t) => (t.type === "function" ? t.function?.name ?? "" : t.type))
    .filter(Boolean)
    .sort()
    .join(",");
  const mode = parseAgentAccessMode(streamOpts?.agentAccessMode);
  const phoneBridge = streamOpts?.phoneBridgeOnline === true ? "1" : "0";
  const profile = resolveToolExposureProfile(streamOpts);
  const textKey = contextualTextKey(userText, profile);
  const rankingKey = [
    (streamOpts?.toolRankingHint?.preferredNamespaces ?? []).join(","),
    (streamOpts?.toolRankingHint?.cautiousNamespaces ?? []).join(","),
  ].join("|");
  const pinnedKey = (streamOpts?.pinnedToolNames ?? []).slice().sort().join(",");
  const capsKey = (streamOpts?.toolCapabilities ?? []).slice().sort().join(",");
  return `${builtinNames}|${extraNames}|${mode}|${phoneBridge}|${profile}|${textKey}|${rankingKey}|${pinnedKey}|${capsKey}`;
}

function contextualTextKey(userText: string | undefined, profile: ToolExposureProfile): string {
  if (profile === "full" || profile === "delegate" || profile === "scoped" || profile === "none") {
    return "-";
  }
  const normalized = (userText ?? "")
    .toLowerCase()
    .replace(/[^\u4e00-\u9fa5a-z0-9\s]/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return normalized.slice(0, 96) || "-";
}

function resolveToolExposureProfile(streamOpts?: AgentStreamOptions): ToolExposureProfile {
  return streamOpts?.toolExposureProfile ?? "contextual";
}

function filterScopedTools(
  tools: ChatCompletionTool[],
  streamOpts?: AgentStreamOptions,
): ChatCompletionTool[] {
  const pinned = new Set((streamOpts?.pinnedToolNames ?? []).filter(Boolean));
  if (pinned.size === 0) return tools;
  const scoped = tools.filter((tool) => {
    const name = tool.type === "function" ? tool.function?.name : undefined;
    return Boolean(name && pinned.has(name));
  });
  return scoped.length > 0 ? scoped : tools;
}

function pickNamespace(toolName: string): string {
  const idx = toolName.indexOf(".");
  if (idx > 0) return toolName.slice(0, idx);
  const underscoreIdx = toolName.indexOf("_");
  if (underscoreIdx > 0) return toolName.slice(0, underscoreIdx);
  return "misc";
}

/**
 * 强制保留 streamOpts.pinnedToolNames 指定的工具(绕过 contextual 筛选)。
 * 从 builtin + extra 中查找缺失的工具并补入。
 */
function pinSpecifiedTools(
  tools: ChatCompletionTool[],
  streamOpts?: AgentStreamOptions,
): ChatCompletionTool[] {
  const names = streamOpts?.pinnedToolNames;
  if (!names || names.length === 0) return tools;

  const present = new Set(
    tools
      .map((t) => (t.type === "function" ? t.function?.name : undefined))
      .filter((n): n is string => Boolean(n)),
  );
  const allBuiltin = streamOpts?.chatToolsBuiltin ?? getBuiltinAgentChatTools();
  const extras = [...allBuiltin, ...(streamOpts?.chatToolsExtra ?? [])];
  const toAdd: ChatCompletionTool[] = [];
  for (const name of names) {
    if (present.has(name)) continue;
    const found = extras.find((t) => t.type === "function" && t.function?.name === name);
    if (found) toAdd.push(found);
  }
  if (toAdd.length === 0) return tools;
  return [...tools, ...toAdd];
}

/** 计算当前请求中应被视作 pinned 的工具名集合（用于 token 预算核算）。 */
function resolvePinnedToolNames(streamOpts?: AgentStreamOptions): Set<string> {
  const pinned = new Set<string>();
  const names = streamOpts?.pinnedToolNames;
  if (names && names.length > 0) {
    for (const name of names) pinned.add(name);
  }
  return pinned;
}

function applyToolRankingHint(
  tools: ChatCompletionTool[],
  streamOpts?: AgentStreamOptions,
): ChatCompletionTool[] {
  const preferred = streamOpts?.toolRankingHint?.preferredNamespaces?.filter(Boolean) ?? [];
  const cautious = streamOpts?.toolRankingHint?.cautiousNamespaces?.filter(Boolean) ?? [];
  if (preferred.length === 0 && cautious.length === 0) return tools;
  const rank = new Map(preferred.map((ns, index) => [ns, index]));
  const cautiousSet = new Set(cautious);
  return [...tools].sort((a, b) => {
    const nameA = a.type === "function" ? a.function?.name ?? "" : "";
    const nameB = b.type === "function" ? b.function?.name ?? "" : "";
    const nsA = pickNamespace(nameA);
    const nsB = pickNamespace(nameB);
    const scoreA =
      (rank.get(nsA) ?? 1000) * 10 +
      (cautiousSet.has(nsA) ? 5 : 0);
    const scoreB =
      (rank.get(nsB) ?? 1000) * 10 +
      (cautiousSet.has(nsB) ? 5 : 0);
    if (scoreA !== scoreB) return scoreA - scoreB;
    return nameA.localeCompare(nameB);
  });
}

/** 能力束 → 域投影判定统一走域注册表（2026-10-01 S0：删本地重复前缀表）。 */

/** 元工具/能力查询桥：任何裁剪集合都保留，保证延迟目录（tool_discover 加载 schema）可达。 */
const CAPABILITY_BRIDGE_TOOLS = new Set([
  "tool_discover",
  "agent",
]);

function filterToolsByCapabilities(
  tools: ChatCompletionTool[],
  capabilities: string[],
): ChatCompletionTool[] {
  return tools.filter((tool) => {
    const name = tool.type === "function" ? tool.function?.name ?? "" : "";
    if (!name) return true;
    if (CAPABILITY_BRIDGE_TOOLS.has(name)) return true;
    return toolInCapabilityDomains(name, capabilities);
  });
}

/** 可视面装配：resident（chat 车道）∩ 候选集，注册表缺失的工具自动跳过。 */
function residencyFaceForTools(tools: ChatCompletionTool[]): ChatCompletionTool[] {
  const wanted = new Set(residentNamesForLane("chat"));
  return tools.filter((t) => t.type === "function" && wanted.has(t.function?.name ?? ""));
}

function applyToolExposureProfile(
  tools: ChatCompletionTool[],
  userText: string | undefined,
  profile: ToolExposureProfile,
  streamOpts?: AgentStreamOptions,
): ChatCompletionTool[] {
  if (profile === "none") return [];
  // explicit（2026-09-05 前后台架构）：调用方已给出精确白名单（chatToolsBuiltin），
  // 任何筛选/合并/pin 都是污染——原样返回。
  if (profile === "explicit") return tools;
  // delegate（任务面默认 profile）：2026-09-05 起按路由层能力束（toolCapabilities）
  // 裁剪——查天气/搜新闻这类轻任务不再全量注入 ~220 个工具 schema（~150k 字符），
  // 未注入工具经 searchableTools 全集进 BM25 延迟目录，LLM 用 tool_discover 桥
  // 按需召回；路由判错由出口自检（TurnOutcomeGate）兜底。
  if (profile === "delegate") {
    const caps = streamOpts?.toolCapabilities?.map((c) => c?.trim()).filter(Boolean) ?? [];
    if (caps.length === 0 || caps.includes("full")) return tools;
    const filtered = filterToolsByCapabilities(tools, caps);
    if (filtered.length === 0) return tools;
    return pinSpecifiedTools(filtered, streamOpts);
  }
  if (profile === "full") return tools;
  if (profile === "scoped") return filterScopedTools(tools, streamOpts);
  // ─── 2026-11-20 归一（P2）：contextual/light 关键词裁剪已删除 ───
  // 旧的 selectRelevantTools 按用户文本关键词挑分类（打车/天气/记账…），
  // 命中率依赖关键词表且与可视面两套语义并存（ride 事故即源于此）。
  // 现在统一为「可视面装配」：resident（residency.ts 单一声明源）∩ 候选 ∪ pinned，
  // 其余工具由 prepareTools 拆进延迟目录（skill/域/query 三条发现通道）。
  const face = residencyFaceForTools(tools);
  return pinSpecifiedTools(face, streamOpts);
}
export function resolveChatToolsForStream(
  userText?: string,
  streamOpts?: AgentStreamOptions,
): ChatCompletionTool[] {
  return resolveChatToolPlanForStream(userText, streamOpts).visibleTools;
}

function resolveChatToolPlanForStreamInner(
  userText?: string,
  streamOpts?: AgentStreamOptions,
): ResolvedChatToolPlan {  // 2026-08-01 性能优化：轻量档小工具集短路。
  // 当调用方显式传入 chatToolsBuiltin 且总工具数 ≤ 12 时，调用方明确声明
  // "我只要这 N 个工具"，跳过 access-mode 合并 + contextual 过滤 + ranking。
  // 这些步骤是给任务面（几十上百工具）准备的，轻量档套用反而会：
  //   1. 把 visual/self-programming 工具合并进来污染 LLM 视野
  //   2. contextual 过滤误裁 weather/calendar 等对话面重要的工具
  //   3. 跑一遍关键词提取 + 分类匹配 ≈ 2-5ms × 每请求
  const rawBuiltin = streamOpts?.chatToolsBuiltin ?? getBuiltinAgentChatTools();
  const rawExtra = streamOpts?.chatToolsExtra ?? [];
  // 纯媒体请求（2026-10-21 根修）：无论走对话面还是任务面，文字检索族都不该
  // 出现在工具面里。用户只索图时，模型连 search_web 的名字都看不到，更谈不上
  // 「顺手查一下近况」把新闻表格贴到照片下面。
  const mediaOnly = isMediaOnlyRequest(userText ?? "");
  // 文字检索族剥离 + 媒体模态收敛（要照片就不给视频检索，反之亦然）。
  const scopeMedia = (tools: ChatCompletionTool[]): ChatCompletionTool[] =>
    mediaOnly
      ? filterMediaModalityTools(filterTextSearchTools(tools), userText ?? "")
      : tools;
  const builtin = scopeMedia(rawBuiltin);
  const extra = scopeMedia(rawExtra);
  const merged = [...builtin, ...extra];
  // explicit（2026-09-05 前后台架构）：chatToolsBuiltin 即最终可见工具集（精确
  // 白名单，可能是前台的 dispatch+快查，也可能是任务面 plan 点名的工具），跳过
  // 全部筛选/缓存；chatToolsExtra 只进延迟目录语料，白名单外工具仍可被
  // tool_discover BM25 召回（plan 漏选工具的执行期自救通道）。
  if (streamOpts?.toolExposureProfile === "explicit") {
    return { visibleTools: builtin, searchableTools: merged };
  }
  // 轻量档：不全暴露，只选相关工具，其余走 tool search 延迟召回。
  // 可视面装配（residency 名单 ∩ 候选）是 O(n) 过滤，微秒级。
  // 未选中的工具通过 prepareToolsWithToolSearch 进入 deferred catalog，
  // LLM 可通过 bridge tool（tool_discover）BM25 搜索即时召回。
  const explicitSmallToolset =
    streamOpts?.chatToolsBuiltin !== undefined && merged.length <= 12;
  if (explicitSmallToolset) {
    // 2026-11-20 归一（P2）：轻量档不再按关键词挑选，统一走可视面装配；
    // 未在可视面的工具仍经 prepareTools 进延迟目录（skill/域/query 可达）。
    const face = residencyFaceForTools(merged);
    const hasRankingHint =
      (streamOpts?.toolRankingHint?.preferredNamespaces?.filter(Boolean).length ?? 0) > 0 ||
      (streamOpts?.toolRankingHint?.cautiousNamespaces?.filter(Boolean).length ?? 0) > 0;
    return {
      visibleTools: hasRankingHint ? applyToolRankingHint(face, streamOpts) : face,
      searchableTools: merged,
    };
  }
  const key = resolvedToolsCacheKey(userText, streamOpts);
  const hit = _resolvedToolsCache.get(key);
  if (hit) {
    const accessCtx: ChatToolsAccessContext = {
      phoneBridgeOnline: streamOpts?.phoneBridgeOnline,
    };
    const searchableTools = mergeChatToolsForAccessMode(
      merged,
      parseAgentAccessMode(streamOpts?.agentAccessMode),
      accessCtx,
    );
    return { visibleTools: hit, searchableTools };
  }

  const accessCtx: ChatToolsAccessContext = {
    phoneBridgeOnline: streamOpts?.phoneBridgeOnline,
  };
  const accessFiltered = mergeChatToolsForAccessMode(
    merged,
    parseAgentAccessMode(streamOpts?.agentAccessMode),
    accessCtx,
  );
  const result = applyToolExposureProfile(
    accessFiltered,
    userText,
    resolveToolExposureProfile(streamOpts),
    streamOpts,
  );
  if (resolveToolExposureProfile(streamOpts) === "scoped") {
    if (_resolvedToolsCache.size >= MAX_RESOLVED_TOOLS_CACHE) {
      const firstKey = _resolvedToolsCache.keys().next().value;
      if (firstKey !== undefined) _resolvedToolsCache.delete(firstKey);
    }
    _resolvedToolsCache.set(key, result);
    return {
      visibleTools: result,
      searchableTools: accessFiltered,
    };
  }
  const ranked = pinSpecifiedTools(applyToolRankingHint(result, streamOpts), streamOpts);

  if (_resolvedToolsCache.size >= MAX_RESOLVED_TOOLS_CACHE) {
    const firstKey = _resolvedToolsCache.keys().next().value;
    if (firstKey !== undefined) _resolvedToolsCache.delete(firstKey);
  }
  _resolvedToolsCache.set(key, ranked);

  return {
    visibleTools: ranked,
    searchableTools: accessFiltered,
  };
}

/**
 * visible 工具集收口（2026-11-05 首字延迟治理）。
 *
 * 所有暴露档位（light / contextual / scoped / delegate / explicit）的出口都汇聚到
 * 这里，统一过一次**数量预算**。
 *
 * 与 `stabilizeToolOrderForSession` 的分工：那层负责「顺序逐字节稳定」（会话冻结，
 * 只增不减），本层负责「数量不失控」。两层缺一不可——只有顺序稳定，25 个工具的
 * prefill 依然要 5-7s；只压数量不保顺序，缓存又会因为顺序抖动打不中。
 *
 * 放在最外层而不是各分支里改，是为了「换 provider / 加档位」不再需要逐个分支适配
 * ——与 provider-profiles 同一条设计原则：规则集中一处，调用点只消费。
 */
export function resolveChatToolPlanForStream(
  userText?: string,
  streamOpts?: AgentStreamOptions,
): ResolvedChatToolPlan {
  const plan = resolveChatToolPlanForStreamInner(userText, streamOpts);
  const visibleTools = applyVisibleToolBudget(plan.visibleTools);
  if (visibleTools === plan.visibleTools) return plan;
  return { ...plan, visibleTools };
}
