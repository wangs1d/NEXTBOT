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
  | "vision"
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
  // web
  search_web: "web",
  search_images: "web",
  search_videos: "web",
  fetch_web: "web",
  "internet.research": "web",
  "internet.live_check": "web",
  "internet.verify": "web",
  "info.inspect_webpage": "web",
  "info.navigate_site": "web",
  "info.search": "web",
  "weather.get_local": "web",
  // calendar
  "reminder.plan": "calendar",
  "calendar.create_from_text": "calendar",
  "calendar.create_task": "calendar",
  "calendar.list_tasks": "calendar",
  // wallet
  "wallet.get_balance": "wallet",
  "wallet.get_transactions": "wallet",
  "wallet.transfer": "wallet",
  "wallet.recharge": "wallet",
  "wallet.purchase": "wallet",
  // phone
  "phone.ensure_my_number": "phone",
  "phone.call_user": "phone",
  // vision
  "vision.http_pull": "vision",
  "vision.periodic_start": "vision",
  "vision.periodic_stop": "vision",
  "vision.periodic_stop_all": "vision",
  "vision.periodic_list": "vision",
  // voice
  "voice.speak": "voice",
  "voice.send_message": "voice",
  // clock
  "clock.get_current_time": "clock",
  "clock.get_user_location": "clock",
  "clock.get_date": "clock",
  "clock.format_timestamp": "clock",
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
  // agent_browser (Playwright 无头浏览器)
  "agent_browser.open": "web",
  "agent_browser.click": "web",
  "agent_browser.type": "web",
  "agent_browser.scroll": "web",
  "agent_browser.screenshot": "web",
  "agent_browser.extract_text": "web",
  "agent_browser.wait_for": "web",
  "agent_browser.close": "web",
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
  "smart_home.list_devices": "smart_home",
  "smart_home.control_device": "smart_home",
  "smart_home.scene": "smart_home",
  // capability
  "agent.query_capabilities": "capability",
  // social / messages（消息聚合中心：两级获取，reply 为短信代发写操作）
  "messages.overview": "social",
  "messages.list_conversations": "social",
  "messages.read_conversation": "social",
  "messages.reply": "social",
  "messages.mark_read": "social",
  "messages.suggest_reply": "social",
  "messages.search": "social",
  "messages.capture_status": "social",
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
  "internet.research": ["search_web", "fetch_web"],
  "internet.live_check": ["weather.get_local", "search_web"],
  "internet.verify": ["search_web"],
  // desktop.open 失败 → 截图确认状态 / run_preset 查找 / run_shell 直接启动
  // （对齐 buildToolFailureReminder L427-428 现有建议）
  "desktop.open": ["desktop.visual.screenshot", "desktop.run_preset", "desktop.run_shell"],
  // search_web 失败 → fetch_web 直接抓取 / info.search 换引擎
  search_web: ["fetch_web", "info.search"],
  search_images: ["search_web", "info.search"],
  search_videos: ["search_web", "info.search"],
  // fetch_web 失败 → search_web 先搜再抓 / info.inspect_webpage 换抓取器
  fetch_web: ["search_web", "info.inspect_webpage"],
  // info.navigate_site 失败 → info.inspect_webpage 换方式
  "info.navigate_site": ["info.inspect_webpage", "fetch_web"],
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
  "wallet.transfer",
  "wallet.purchase",
  // 提醒/日程创建（2026-10-12）：matched=false（时间解析不出/周期需确认）时
  // 严禁转述成「已设置」——用户据此以为到点会提醒，实际什么都没创建
  //（真实事故：提醒轮无落库、日程页无数据、到点无通知）。
  "reminder.plan",
  "calendar.create_from_text",
  "calendar.create_task",
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
  if (/wallet\.transfer|wallet\.purchase|shopping\.order\.place|ride_hailing\.book|home_service\.book|restaurant\.book|desktop\.run_shell|desktop\.run_input|desktop\.run_automation|phone\.call/.test(toolName)) {
    return "high";
  }
  if (/desktop\.open|desktop\.run_preset|agent_browser\.click|agent_browser\.type|smart_home\.control/.test(toolName)) {
    return "medium";
  }
  return "low";
}

function inferCachePolicy(toolName: string): ToolMetadata["cachePolicy"] | undefined {
  if (/^(weather\.get_local|search_web|search_images|search_videos|fetch_web|internet\.research|internet\.live_check|internet\.verify|info\.inspect_webpage|info\.navigate_site|info\.search)$/.test(toolName)) {
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
