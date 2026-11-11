/**
 * Loop Orchestrator - 工具元数据层
 *
 * 收敛现有分散在 5 处的工具元数据（TOOL_CATEGORY_MAPPINGS / resolveToolExecutionTimeoutMs /
 * STATE_MACHINE_TOOL_ALLOWLIST / ALWAYS_INCLUDED_TOOLS / TOOL_RESULT_PRESET_MAX_CHARS），
 * 并新增 `alternatives` 字段声明同类替代关系，供 RecoveryPolicy 做"确定性换工具"决策。
 *
 * P2 阶段：alternatives 覆盖高频失败工具（desktop/web/shopping），
 * 其余工具 fallthrough 到原 prompt 路径（buildToolFailureReminder 返回空）。
 *
 * 详见 docs/loop-orchestrator-architecture.md §5 Phase 2
 */

/** 工具分类（与 TOOL_CATEGORY_MAPPINGS 对齐） */
export type ToolCategory =
  | "web"
  | "calendar"
  | "wallet"
  | "social"
  | "phone"
  | "voice"
  | "clock"
  | "life"
  | "capability"
  | "desktop"
  | "programming"
  | "world"
  | "aip"
  | "smart_home"
  | "mcp"
  | "image"
  | string;

/** 单个工具的恢复元数据 */
export interface ToolMetadata {
  name: string;
  category: ToolCategory;
  /** Logical toolset/domain used for filtering, ranking, and diagnostics. */
  toolset?: string;
  /** Whether the tool mutates external state. */
  sideEffect?: "none" | "read" | "write" | "external";
  /** Operational risk tier, used by routing/safety/approval policy. */
  riskLevel?: "low" | "medium" | "high";
  /** Preferred execution timeout for this tool. */
  timeoutMs?: number;
  /** Cache behavior for read-only tools. */
  cachePolicy?: {
    enabled: boolean;
    ttlMs?: number;
  };
  /** 同类替代工具（按优先级排序，失败时依次尝试） */
  alternatives: string[];
  /** 是否需要"禁止假成功"强约束（用户易感知成败的工具） */
  requireHonestFailure?: boolean;
}

// ────────────────────────────────────────────────────────────
// 工具 → 分类 反向映射（从 TOOL_CATEGORY_MAPPINGS 提取）
// ────────────────────────────────────────────────────────────

const TOOL_TO_CATEGORY: Record<string, ToolCategory> = {
  // web（复合：web/deep/images/videos/hot/weather/quote）
  web_search: "web",
  // web（复合：read/inspect/navigate/raw）
  web_fetch: "web",
  "info.search": "web",
  // calendar
  "calendar": "calendar",
  // phone（复合：number/call）
  phone: "phone",
  // voice（复合：speak/message）
  voice: "voice",
  // clock
  "clock.get_user_location": "clock",
  // life
  "budget.calculate": "life",
  "shopping.suggest": "life",
  // desktop
  "desktop.visual.screenshot": "desktop",
  "desktop.visual.run_task": "desktop",
  "desktop.open": "desktop",
  "desktop.run_preset": "desktop",
  "desktop.run_shell": "desktop",
  "desktop.uia_query": "desktop",
  "desktop.run_input": "desktop",
  "desktop.run_automation": "desktop",
  "desktop.http_get": "desktop",
  "desktop.web_search": "desktop",
  "desktop.web_fetch": "desktop",
  "desktop.window": "desktop",
  "desktop.clipboard": "desktop",
  // agent_browser（Playwright 无头浏览器，复合工具 action 分流）
  "agent_browser": "web",
  // shared_browser（用户与 Agent 共用客户端浏览器，WS 桥转发）
  "shared_browser.navigate": "web",
  "shared_browser.control": "web",
  "shared_browser.click": "web",
  "shared_browser.type": "web",
  "shared_browser.scroll": "web",
  "shared_browser.read_page": "web",
  // shopping
  "shopping.order.search": "life",
  "shopping.order.place": "life",
  "shopping.order.track": "life",
  "shopping.order.cancel": "life",
  // smart_home
  "smart_home": "smart_home",
  // 复合工具（细分入口已收编进各自 action）
  agent: "agent",
  "world.link": "world",
  world: "world",
  proactivity: "proactivity",
  care: "care",
  device: "device",
  aip: "aip",
};

// ────────────────────────────────────────────────────────────
// 工具替代关系（RecoveryPolicy 的核心数据）
// ────────────────────────────────────────────────────────────

/**
 * 高频失败工具的确定性替代链。
 * 来源：buildToolFailureReminder 现有 desktop.open 建议 + TOOL_CATEGORY_MAPPINGS 同类工具。
 * P2 初期只覆盖 desktop/web/shopping，其余靠同类 category 自动兜底。
 */
const TOOL_ALTERNATIVES: Record<string, string[]> = {
  // desktop.open 失败 → 截图确认状态 / run_preset 查找 / run_shell 直接启动
  // （对齐 buildToolFailureReminder L427-428 现有建议）
  "desktop.open": ["desktop.visual.screenshot", "desktop.run_preset", "desktop.run_shell"],
  // web_search 失败 → web_fetch 直接抓取 / info.search 换引擎
  web_search: ["web_fetch", "info.search"],
  // web_fetch 失败 → web_search 先搜再抓（复合内 action=read/inspect 可换方式）
  web_fetch: ["web_search", "info.search"],
  // shopping.order.place 失败 → search 先确认商品再重试
  "shopping.order.place": ["shopping.order.search"],
  // 统一预订层（方案 A）：book 失败 → 先 quote/search 确认选项再重试
  "ride_hailing.book": ["ride_hailing.quote"],
  "home_service.book": ["home_service.search"],
  "restaurant.book": ["restaurant.search"],
  // desktop.uia_query 失败（selector 找不到）→ 截图切视觉策略
  // （对齐状态机 prompt "uia_query count:0 时切视觉策略"）
  "desktop.uia_query": ["desktop.visual.screenshot"],
  // desktop.run_automation 失败（Electron 等读不到控件）→ 坐标路径兜底
  "desktop.run_automation": ["desktop.uia_query", "desktop.run_input", "desktop.visual.screenshot"],
};

// 需要"禁止假成功"强约束的工具（用户易感知成败）
const HONEST_FAILURE_TOOLS = new Set<string>([
  "desktop.open",
  "desktop.run_preset",
  "desktop.run_shell",
  "shopping.order.place",
  // 提醒/日程创建（2026-10-12）：matched=false（时间解析不出/周期需确认）时
  // 严禁转述成「已设置」——用户据此以为到点会提醒，实际什么都没创建
  //（真实事故：提醒轮无落库、日程页无数据、到点无通知）。
  "calendar",
  // 统一预订层（方案 A）：下单工具禁止假成功（模拟模式必须如实标注 simulated）
  "ride_hailing.book",
  "home_service.book",
  "restaurant.book",
]);

// ────────────────────────────────────────────────────────────
// 对外 API
// ────────────────────────────────────────────────────────────

/** 获取工具的分类；未知工具返回 "misc"。 */
export function getToolCategory(toolName: string): ToolCategory {
  return TOOL_TO_CATEGORY[toolName] ?? "misc";
}

/** 获取工具的显式替代链；无显式声明时返回空数组（调用方可回退到同类工具）。 */
export function getToolAlternatives(toolName: string): string[] {
  return TOOL_ALTERNATIVES[toolName] ?? [];
}

/** 获取同类其他工具（从 TOOL_TO_CATEGORY 反向查找）。 */
export function getSameCategoryTools(toolName: string): string[] {
  const category = getToolCategory(toolName);
  if (category === "misc") return [];
  return Object.entries(TOOL_TO_CATEGORY)
    .filter(([name, cat]) => cat === category && name !== toolName)
    .map(([name]) => name);
}

/** 获取工具完整元数据。 */
export function getToolMetadata(toolName: string): ToolMetadata {
  const category = getToolCategory(toolName);
  return {
    name: toolName,
    category,
    toolset: category,
    sideEffect: inferSideEffect(toolName),
    riskLevel: inferRiskLevel(toolName),
    cachePolicy: inferCachePolicy(toolName),
    alternatives: getToolAlternatives(toolName),
    requireHonestFailure: HONEST_FAILURE_TOOLS.has(toolName),
  };
}

function inferSideEffect(toolName: string): ToolMetadata["sideEffect"] {
  if (/transfer|purchase|place|cancel|create|send|call|control|run_|open|automation|input|book|reminder|update|delete|write|profile|forget/.test(toolName)) {
    return "external";
  }
  if (/search|fetch|inspect|get|list|screenshot|query|extract|weather|clock/.test(toolName)) {
    return "read";
  }
  return "read";
}

/**
 * 工具是否有外部副作用（2026-10-12 出口宣称-一致性闸消费）。
 * 闸的通用判据：回复宣称完成写操作 ∧ 本轮零个副作用工具执行 = 结构性违约。
 */
export function hasExternalSideEffect(toolName: string): boolean {
  return inferSideEffect(toolName) === "external";
}

function inferRiskLevel(toolName: string): ToolMetadata["riskLevel"] {
  if (/shopping\.order\.place|ride_hailing\.book|home_service\.book|restaurant\.book|desktop\.run_shell|desktop\.run_input|desktop\.run_automation|phone\.call/.test(toolName)) {
    return "high";
  }
  if (/desktop\.open|desktop\.run_preset|agent_browser|smart_home\.control/.test(toolName)) {
    return "medium";
  }
  return "low";
}

function inferCachePolicy(toolName: string): ToolMetadata["cachePolicy"] | undefined {
  // search_images 故意不给缓存（2026-11-09 用户真机反馈：「再来几张」会返回前面
  // 已经返回过的照片）。图片结果天生是「要给下一批」的语义，而缓存键只有
  // name+input、TTL 60s，同 query 追轮会直接命中上一轮结果，把同一批图再发一遍。
  // 图片搜索必须每次重跑 + 会话级去重（services/media-shown-ledger.ts）。
  if (/^(weather\.get_local|search_web|search_videos|fetch_web|info\.inspect_webpage|info\.navigate_site|info\.search)$/.test(toolName)) {
    return { enabled: true, ttlMs: 60_000 };
  }
  return undefined;
}

/**
 * 构建失败恢复提示（替代/增强 buildToolFailureReminder）。
 *
 * 对有 alternatives 的工具生成"建议换用 X"提示；
 * 对 requireHonestFailure 的工具追加"禁止宣称成功"强约束。
 * 无 alternatives 且非 honest 的工具返回空（fallthrough 到原行为）。
 */
export function buildRecoveryHint(toolName: string, errorSnippet: string): string {
  const meta = getToolMetadata(toolName);
  const parts: string[] = [];

  // 禁止假成功强约束
  if (meta.requireHonestFailure) {
    parts.push(
      `禁止向用户宣称"已成功/已完成/已就绪"等任何成功暗示。本次失败原因：${errorSnippet}。` +
        `必须在回复中明确告知用户"操作失败"并附上原因。`,
    );
  }

  // 确定性替代建议
  const alts = meta.alternatives;
  if (alts.length > 0) {
    const altList = alts.map((a) => `\`${a}\``).join(" / ");
    parts.push(`建议换用替代工具：${altList}。不要用相同参数重复调用 \`${toolName}\`。`);
  }

  if (parts.length === 0) return "";
  return `\n[失败恢复] ${parts.join(" ")}`;
}
