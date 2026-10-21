import type { DeferredToolCatalog } from "./catalog.js";
import { describeDeferredTool, resolveCatalogToolName, searchDeferredTools } from "./catalog.js";
import {
  adaptiveSearchDeferredTools,
  recordAdaptiveResourceFeedback,
  reinforceAdaptiveGraphEdges,
  reinforceAdaptiveTopPForQuery,
  type AdaptiveDeferredToolSearchMatch,
} from "./adaptive-catalog.js";
import { slimJsonSchema, firstSentence } from "./schema-slim.js";
import { domainsForTool, resolveDomainDef } from "./tool-category.js";
import { getAdaptiveSearchRouting } from "./adaptive-catalog.js";
import { getToolSearchConfig } from "./env.js";
import { getQueryEmbedding, getQueryEmbeddingBounded, peekQueryEmbedding } from "./tool-embedding.js";
import { sharedHistoryStore, type HistoryScoreStore } from "./retrieval/history-score.js";
import { ResourceType } from "./registry/models.js";
import { toolSearchMetrics } from "./observability/metrics.js";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { loadFeedbackState, saveFeedbackState } from "./feedback-state-persistence.js";
import { isRegisteredSkillChatToolName } from "../../skills/skill-openai-bridge.js";

const historyStore: HistoryScoreStore = sharedHistoryStore;

/**
 * 常驻（车道可见）工具的描述信息，供 discover/describe 回退查询。
 * 由工具循环在每轮从当轮可见 apiTools 构建：registry 名 + LLM 名双字段，
 * 两种写法都能命中（模型有时混用点号/下划线）。
 */
export type ResidentToolInfo = {
  /** 注册表名（点号形态，如 world.link.send_message） */
  name: string;
  /** LLM 可见名（下划线形态），无别名时与 name 相同 */
  alias: string;
  description: string;
  parameters?: Record<string, unknown>;
};

const RESIDENT_HINT = "常驻工具：schema 已在可见工具列表中，直接调用即可执行";

const ADAPTIVE_AGENT_SEARCH_PATH = [
  "intent_router",
  "hierarchical_router",
  "hybrid_retrieval",
  "adaptive_top_p",
  "knowledge_graph_expansion",
  "tool_reranking",
] as const;

export type ToolSearchBridgeResult =
  | {
      kind: "search" | "describe" | "discover";
      ok: boolean;
      result: Record<string, unknown>;
    }
  | {
      kind: "call";
      ok: true;
      registryToolName: string;
      parsedArgs: Record<string, unknown>;
    }
  | {
      kind: "call";
      ok: false;
      result: Record<string, unknown>;
    };

/**
 * Agent 延迟工具桥接入口。
 *
 * tool_search / tool_discover 的主搜索路径统一迁移到 adaptive pipeline：
 * Intent Router → Hierarchical Router → Hybrid Retrieval → Adaptive Top-P →
 * Knowledge Graph Expansion → Tool Reranking。
 *
 * Legacy BM25 只在 adaptive pipeline 异常时兜底。
 */
export async function executeToolSearchBridge(
  bridgeName: string,
  args: Record<string, unknown>,
  catalog: DeferredToolCatalog,
  residentTools?: ResidentToolInfo[],
): Promise<ToolSearchBridgeResult> {
  const normalized = normalizeBridgeName(bridgeName);
  const cfg = getToolSearchConfig();

  if (normalized === "tool_discover") {
    return executeToolDiscover(args, catalog, cfg, residentTools);
  }

  if (normalized === "tool_search") {
    const query = String(args.query ?? "").trim();
    if (!query) {
      return { kind: "search", ok: false, result: { error: "query 不能为空", matches: [] } };
    }
    const limit = resolveSearchLimit(args.limit, cfg);
    const includeSchema = args.include_schema === true;
    const matches = await searchAdaptiveAgentPath(catalog, query, limit, {
      includeSchema,
      tenantId: resolveTenantArg(args),
      agentContextHash: resolveContextHashArg(args),
    });
    return {
      kind: "search",
      ok: true,
      result: {
        matches,
        query,
        count: matches.length,
        search_path: ADAPTIVE_AGENT_SEARCH_PATH,
      },
    };
  }

  if (normalized === "tool_describe") {
    const name = String(args.name ?? "").trim();
    if (!name) {
      return { kind: "describe", ok: false, result: { error: "name 不能为空" } };
    }
    const schema = describeDeferredTool(catalog, name);
    if (!schema) {
      const resident = describeResidentTool(residentTools, name);
      if (resident) {
        return { kind: "describe", ok: true, result: { ...resident, resident: true, hint: RESIDENT_HINT } };
      }
      return { kind: "describe", ok: false, result: { error: `未找到延迟工具: ${name}` } };
    }
    return { kind: "describe", ok: true, result: schema };
  }

  // 2026-10-21 单一通道：延迟工具的调用只走「discover 加载 schema → 模型原生
  // tool_calls」；`tool_call` 自由 JSON 执行通道已删除，不再有第二条入口。
  return { kind: "search", ok: false, result: { error: `未知桥接工具: ${bridgeName}` } };
}

/**
 * 解析 tool_call 的 arguments。
 *
 * LLM 偶尔会把 arguments 序列化成 JSON 字符串回传（而非按 schema 传对象），
 * 若直接丢弃会导致工具以空参数执行——比报错更隐蔽。因此对字符串做 JSON.parse 兜底：
 *  - 对象（非数组）→ 直接使用
 *  - JSON 字符串且解析后为对象 → 使用解析结果
 *  - 其余（数组/数字/布尔/null/非法 JSON）→ 保持空参数，不抛错
 */
function resolveCallArguments(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  if (typeof raw === "string") {
    const text = raw.trim();
    if (!text) return {};
    try {
      const parsed = JSON.parse(text) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // 非法 JSON 字符串：保持空参数，不抛错
    }
  }
  return {};
}

function normalizeBridgeName(name: string): string {
  if (name === "tool_resolve") return "tool_discover";
  return name;
}

function resolveSearchLimit(
  raw: unknown,
  cfg: ReturnType<typeof getToolSearchConfig>,
): number {
  const requested = Number(raw);
  return Number.isFinite(requested) && requested > 0
    ? Math.min(Math.floor(requested), cfg.maxSearchLimit)
    : cfg.searchDefaultLimit;
}

/** 域拉取：单次返回的族规模上限（族内注册表序+目录序确定性排列）。 */
const DOMAIN_PULL_LIMIT = 12;
const DISCOVER_DOMAIN_DESC_CHARS = 90;
const DISCOVER_SCHEMA_TOP_N = 3;

function resolveTenantArg(args: Record<string, unknown>): string {
  return String(args.tenant_id ?? args.tenantId ?? "default");
}

function resolveContextHashArg(args: Record<string, unknown>): string {
  return String(args.agent_context_hash ?? args.context_hash ?? "tool-search-bridge");
}

/**
 * 常驻工具描述回退：延迟目录查不到时，按注册名/LLM 名双口径匹配当轮可见工具。
 * 未传入 residentTools（理论不会发生）或未命中返回 null。
 */
function describeResidentTool(
  residentTools: ResidentToolInfo[] | undefined,
  name: string,
): { name: string; description: string; parameters: Record<string, unknown> } | null {
  if (!residentTools?.length) return null;
  const target = name.trim();
  if (!target) return null;
  const hit = residentTools.find((t) => t.name === target || t.alias === target);
  if (!hit) return null;
  return {
    name: hit.name,
    description: hit.description,
    parameters: hit.parameters ?? { type: "object", properties: {} },
  };
}

function executeToolDiscover(
  args: Record<string, unknown>,
  catalog: DeferredToolCatalog,
  cfg: ReturnType<typeof getToolSearchConfig>,
  residentTools?: ResidentToolInfo[],
): Promise<ToolSearchBridgeResult> {
  const name = String(args.name ?? "").trim();
  const query = String(args.query ?? "").trim();
  const domain = String(args.domain ?? "").trim();

  if (domain) {
    return executeToolDiscoverByDomain(catalog, domain);
  }
  if (name) {
    return executeToolDiscoverByName(args, catalog, cfg, name, query, residentTools);
  }
  if (!query) {
    return Promise.resolve({
      kind: "discover",
      ok: false,
      result: { error: "请提供 domain（按域拉取）、query（搜索）或 name（直接加载 schema）" },
    });
  }
  return executeToolDiscoverByQuery(args, catalog, cfg, query);
}

/**
 * 按域确定性拉取（2026-10-01 S1 主通道）：域全族瘦身视图，注册表序+目录序
 * （同目录恒同输出字节）。前 3 名附瘦身参数 schema（与 query 通道同口径），
 * 其余 name+描述+参数名——模型按名直呼或继续 name 模式拉单个 schema。
 * 未知域名返回可用域清单（自纠错，不静默失败）。
 */
function executeToolDiscoverByDomain(
  catalog: DeferredToolCatalog,
  domain: string,
): Promise<ToolSearchBridgeResult> {
  // 2026-10-10 根修：域可用性由「目录里是否有该域成员」裁定，而非「是否登记在
  // DOMAIN_REGISTRY」。派生域（技能族 habit/booking/picture/finance/virtual-phone/
  // agentworld 等自动成域）因此与显式域同等可达；不存在的域名仍走自纠错分支。
  const members = catalog.entries
    .map((e) => e.registryName)
    .filter((n) => domainsForTool(n).includes(domain));
  if (members.length === 0) {
    const available = [...new Set(catalog.entries.flatMap((e) => domainsForTool(e.registryName)))]
      .filter((d) => d !== "misc")
      .sort()
      .join("、");
    return Promise.resolve({
      kind: "discover",
      ok: false,
      result: { error: `未知能力域: ${domain}`, available_domains: available },
    });
  }
  const def = resolveDomainDef(domain);
  const wire = members.slice(0, DOMAIN_PULL_LIMIT).map((memberName, rank) => {
    const entry = catalog.byName.get(memberName);
    const fn = entry && entry.tool.type === "function" ? entry.tool.function : undefined;
    const match: Record<string, unknown> = {
      name: memberName,
      description: firstSentence(fn?.description ?? "", DISCOVER_DOMAIN_DESC_CHARS),
      parameterNames: entry?.parameterNames ?? [],
      requiredParameters: entry?.requiredParameters ?? [],
    };
    if (rank < DISCOVER_SCHEMA_TOP_N && fn?.parameters) {
      match.parameters = slimJsonSchema(fn.parameters);
    }
    return match;
  });
  return Promise.resolve({
    kind: "discover",
    ok: true,
    result: {
      mode: "domain",
      domain,
      summary: def.summary,
      count: members.length,
      matches: wire,
      ...(members.length > DOMAIN_PULL_LIMIT
        ? {
            // 2026-10-10 根修：截断仅限「详细视图」，被截工具的【名字】必须随行下发——
            // 否则域卡标了 (+N) 告诉模型「还有更多」，模型按域来拉却既看不到名、也无法
            // name 模式补拉（提示不可执行）→ 大域尾部工具对模型事实不可枚举。仅补名字，
            // 不附描述/schema，提示词零膨胀。
            more: members.length - DOMAIN_PULL_LIMIT,
            more_names: members.slice(DOMAIN_PULL_LIMIT),
            hint_more: "未展开的工具名见 more_names，需要时用 name 模式拉取其参数 schema",
          }
        : {}),
      hint: "matches 内工具可直接 tool_call 按名调用；前 3 名已附参数 schema，其余需要时用 name 模式补拉。",
    },
  });
}

async function executeToolDiscoverByName(
  args: Record<string, unknown>,
  catalog: DeferredToolCatalog,
  cfg: ReturnType<typeof getToolSearchConfig>,
  name: string,
  query: string,
  residentTools?: ResidentToolInfo[],
): Promise<ToolSearchBridgeResult> {
  const schema = describeDeferredTool(catalog, name);
  if (!schema) {
    // 延迟目录未命中时回退查常驻工具：车道常驻（chat/task core）本就直接可调，
    // 不给 schema 描述会把模型逼进「搜不到=不存在」的死胡同（真机实证）。
    const resident = describeResidentTool(residentTools, name);
    if (resident) {
      const result: Record<string, unknown> = { mode: "describe", tool: resident, resident: true, hint: RESIDENT_HINT };
      if (query) {
        const limit = resolveSearchLimit(args.limit, cfg);
        result.search = await searchAdaptiveAgentPath(catalog, query, limit, {
          tenantId: resolveTenantArg(args),
          agentContextHash: resolveContextHashArg(args),
        });
      }
      return { kind: "discover", ok: true, result };
    }
    return { kind: "discover", ok: false, result: { error: `未找到延迟工具: ${name}` } };
  }
  const result: Record<string, unknown> = { mode: "describe", tool: schema };
  if (query) {
    const limit = resolveSearchLimit(args.limit, cfg);
    result.search = await searchAdaptiveAgentPath(catalog, query, limit, {
      tenantId: resolveTenantArg(args),
      agentContextHash: resolveContextHashArg(args),
    });
  }
  return { kind: "discover", ok: true, result };
}

async function executeToolDiscoverByQuery(
  args: Record<string, unknown>,
  catalog: DeferredToolCatalog,
  cfg: ReturnType<typeof getToolSearchConfig>,
  query: string,
): Promise<ToolSearchBridgeResult> {
  const limit = resolveSearchLimit(args.limit, cfg);
  const includeAllSchema = args.include_schema === true;
  let matches = await searchAdaptiveAgentPath(catalog, query, limit, {
    includeSchema: includeAllSchema,
    tenantId: resolveTenantArg(args),
    agentContextHash: resolveContextHashArg(args),
  });

  if (
    cfg.discoverAutoSchemaTop1 &&
    !includeAllSchema &&
    matches.length > 0 &&
    matches[0].parameters == null
  ) {
    const topSchema = describeDeferredTool(catalog, matches[0].name);
    if (topSchema) {
      matches = [
        {
          ...matches[0],
          parameters: (slimJsonSchema(topSchema.parameters) as Record<string, unknown>) ?? {
            type: "object",
            properties: {},
          },
        },
        ...matches.slice(1),
      ];
    }
  }

  // 高置信只读 top-1 预执行标记：省 1 轮 tool_call round trip
  // 条件：top-1 置信度 >= 0.85、无必需参数、工具名不涉写操作
  const routing = getAdaptiveSearchRouting(catalog);
  const preExecution =
    matches.length > 0 &&
    (routing?.confidence ?? 0) >= 0.85 &&
    matches[0].requiredParameters.length === 0 &&
    !isWriteToolName(matches[0].name)
      ? { tool_name: matches[0].name, inferred_args: {} as Record<string, unknown>, status: "ready" as const }
      : undefined;
  // LLM 视图剥离：resource_type/domain/capability 是内部诊断字段（每条重复展开
  // 数十至数百字符），模型选择工具用不到——name/description/score/参数骨架已足够。
  const wireMatches = matches.map((m) => ({
    name: m.name,
    description: m.description,
    score: m.score,
    ...(m.parameterNames.length > 0 ? { parameterNames: m.parameterNames } : {}),
    ...(m.requiredParameters.length > 0 ? { requiredParameters: m.requiredParameters } : {}),
    ...(m.parameters != null ? { parameters: m.parameters } : {}),
  }));
  return {
    kind: "discover",
    ok: true,
    result: {
      mode: "search",
      query,
      count: matches.length,
      // hint/routing 前置：载荷超压缩预算时截断从尾部发生，先保指导语与评分视图
      hint: "前 3 名已附瘦身参数 schema：对比后选最贴合用户诉求的一个直接 tool_call；若都不贴合，换更具体的 query 再 discover。",
      ...(routing
        ? {
            routing: {
              confidence: routing.confidence,
              top_p: routing.top_p,
              primary_capability: routing.primary_capability,
            },
          }
        : {}),
      search_path: ADAPTIVE_AGENT_SEARCH_PATH,
      matches: wireMatches,
      ...(preExecution ? { pre_execution: preExecution } : {}),
    },
  };
}

async function searchAdaptiveAgentPath(
  catalog: DeferredToolCatalog,
  query: string,
  limit: number,
  options: {
    includeSchema?: boolean;
    tenantId?: string;
    agentContextHash?: string;
  },
): Promise<AdaptiveDeferredToolSearchMatch[]> {
  // 首查有界等待（N1 冷启动）：sidecar 本地毫秒级，等 400ms 换「首查即语义」；
  // 超时/慢 provider 转入后台继续（下次同 query 命中 LRU），搜索不被阻塞
  let queryVector = peekQueryEmbedding(query) ?? undefined;
  if (!queryVector && catalog.embeddingIndex.size > 0) {
    const warmed = await getQueryEmbeddingBounded(query).catch(() => null);
    queryVector = warmed ?? undefined;
    if (!warmed) {
      safeQueryEmbedding(query, catalog).catch(() => {
        // 静默失败，不影响主搜索
      });
    }
  }
  const matches = await searchWithAdaptiveFallback(catalog, query, limit, {
    includeSchema: options.includeSchema,
    queryVector: queryVector ?? undefined,
    tenantId: options.tenantId,
    agentContextHash: options.agentContextHash,
  });
  recordSearchContext(catalog, query, matches);
  return matches;
}

function recordSearchContext(
  catalog: DeferredToolCatalog,
  query: string,
  matches: Array<{ name: string }>,
): void {
  const ctx = catalog as DeferredToolCatalog & {
    lastSearchQuery?: string;
    lastSearchMatches?: string[];
  };
  ctx.lastSearchQuery = query;
  ctx.lastSearchMatches = matches.slice(0, 5).map((m) => m.name);
}

function recordToolCallFeedback(catalog: DeferredToolCatalog, chosen: string): void {
  const ctx = catalog as DeferredToolCatalog & {
    lastSearchQuery?: string;
    lastSearchMatches?: string[];
  };
  if (!ctx.lastSearchQuery || !ctx.lastSearchMatches || !ctx.lastSearchMatches.includes(chosen)) {
    return;
  }
  const now = new Date().toISOString();
  // 召回质量观测（阶段优化⑤）：模型实际选中的工具在召回列表中的排名
  // （0 = top-1；-1 = 选了召回列表之外的工具，检索漏报）
  const chosenRank = ctx.lastSearchMatches.indexOf(chosen);
  toolSearchMetrics.recordRecall(chosenRank);
  if (chosenRank < 0) recordRecallMissSample(ctx.lastSearchQuery, chosen, ctx.lastSearchMatches);
  // 阶段收口：调用成功同步驱动 rate_limited 复位 + 图边权重强化（Python
  // feedback.py 语义的进程内收敛实现）
  recordAdaptiveResourceFeedback(chosen, true);
  void reinforceAdaptiveGraphEdges(catalog, chosen).catch(() => {});
  void historyStore.record({
    resource_id: chosen,
    success: true,
    latency_ms: 0,
    result_quality_score: 0.8,
    call_timestamp: now,
  });
  const top1 = ctx.lastSearchMatches[0];
  if (top1 && top1 !== chosen) {
    // 实际选中的工具不是检索 top-1：记 top-1 一次失败反馈——连续失败触发
    // rate_limited 旁路，并抬升该意图的 top-p 阈值（下次召回扩候选面）。
    recordAdaptiveResourceFeedback(top1, false);
    void reinforceAdaptiveTopPForQuery(ctx.lastSearchQuery).catch(() => {});
    void historyStore.record({
      resource_id: top1,
      success: false,
      latency_ms: 0,
      result_quality_score: 0,
      call_timestamp: now,
    });
  }
}

// ---- 检索漏报样本采集（改写语料回流）：chosen 不在召回列表 = 检索面真实盲区 ----

const MISS_SAMPLE_MAX_BYTES = 5 * 1024 * 1024;

function recordRecallMissSample(
  query: string,
  chosen: string,
  matches: string[],
): void {
  const base = process.env.PA_DATA_DIR?.trim() || "data";
  const path = join(base, "tool-recall-miss-samples.ndjson");
  const line =
    JSON.stringify({
      ts: new Date().toISOString(),
      query,
      chosen,
      returned_top5: matches.slice(0, 5),
    }) + "\n";
  // fire-and-forget：样本采集任何失败都不影响检索主链路
  void (async () => {
    try {
      await mkdir(dirname(path), { recursive: true });
      await appendFile(path, line, "utf8");
    } catch {
      /* 静默 */
    }
  })();
  void enforceMissSampleCap(path);
}

/** 粗放容量上限：超 5MB 截掉最旧一半（低频触发， miss 本身是稀事件）。 */
async function enforceMissSampleCap(path: string): Promise<void> {
  try {
    const { stat, truncate, readFile } = await import("node:fs/promises");
    const info = await stat(path);
    if (info.size <= MISS_SAMPLE_MAX_BYTES) return;
    const text = await readFile(path, "utf8");
    const lines = text.split("\n");
    const keep = lines.slice(Math.floor(lines.length / 2)).join("\n");
    await truncate(path, 0);
    if (keep) await appendFile(path, keep, "utf8");
  } catch {
    /* 静默 */
  }
}

function inferFallbackResourceType(name: string): ResourceType {
  if (name.startsWith("mcp.")) return ResourceType.McpServer;
  if (isRegisteredSkillChatToolName(name)) return ResourceType.Skill;
  return ResourceType.Tool;
}

async function searchWithAdaptiveFallback(
  catalog: DeferredToolCatalog,
  query: string,
  limit: number,
  options: {
    includeSchema?: boolean;
    queryVector?: number[] | Float32Array;
    tenantId?: string;
    agentContextHash?: string;
  },
): Promise<AdaptiveDeferredToolSearchMatch[]> {
  // 2026-09-11 检索收口：Python tool-router 已删除，进程内 adaptive 是唯一检索管线
  //（意图路由 → 分层路由 → 混合召回 → 自适应 top-p → 图扩展 → 重排），异常时降级纯 BM25。
  try {
    return await adaptiveSearchDeferredTools(catalog, query, limit, options);
  } catch (e) {
    console.warn("[tool-search:bridge] adaptive search failed, fallback to legacy BM25", e);
    const fallback = searchDeferredTools(catalog, query, limit, {
      includeSchema: options.includeSchema,
      queryVector: options.queryVector,
    });
    return fallback.map((match) => {
      const resourceType = inferFallbackResourceType(match.name);
      const domain = inferFallbackDomain(match.name, resourceType);
      return {
        ...match,
        resource_type: resourceType,
        domain,
        capability: domain.map((item) => `${item}.general`),
      } satisfies AdaptiveDeferredToolSearchMatch;
    });
  }
}

function inferFallbackDomain(name: string, resourceType: ResourceType): string[] {
  if (resourceType === ResourceType.McpServer) return ["mcp"];
  if (resourceType === ResourceType.Skill) return ["self"];
  if (name === "search_web" || name === "fetch_web") return ["search"];
  return [name.split(/[._-]/)[0]?.toLowerCase() || "misc"];
}

function isWriteToolName(name: string): boolean {
  return /(?:^|[._-])(?:accept|call|comment|create|delete|deliver|dispatch|execute|like|pay|post|purchase|reject|remove|respond|run|send|submit|transfer|update|upload|write)(?:[._-]|$)/.test(name);
}

/**
 * 安全拉取 query embedding：超时 / 失败 / 工具集过小 → 返回 null（静默降级）。
 *
 * 性能：缓存命中 0 RTT；未命中 + 走 API 通常 80~200ms，所以仅在 catalog 有
 * embedding 索引时尝试拉，避免无意义开销。
 */
async function safeQueryEmbedding(
  query: string,
  catalog: DeferredToolCatalog,
): Promise<Float32Array | null> {
  // 没有 embedding 索引就别白跑 API（catalog 一定 fallback 到纯 BM25）
  if (catalog.embeddingIndex.size === 0) return null;
  try {
    return await getQueryEmbedding(query);
  } catch {
    return null;
  }
}
