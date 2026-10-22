// Agent Brain Center — ToolPlanningCortex（工具规划皮层）
//
// 职责：根据任务动态规划工具链、预估 token/成本、生成 fallback。
//   人类大脑无此需求（人类不调工具），但 agent 必需——区别于 PlannerCortex
//   的"任务分解"，本皮层专注"用哪些工具 + 什么顺序 + 多少成本"。
//
// 核心机制：
//   1. planTools(task, capabilities, route)：根据任务和已有能力规划工具链
//   2. estimateCost(tools)：预估总 token、预计耗时、预计调用次数
//   3. optimizeToolOrder：基于依赖关系重排工具顺序
//   4. getFallback：高成本工具失败时的降级方案
//   5. capability gap 检测：任务要求但能力缺失 → 报告 gap
//
// 深度链接：
//   - complex 时 DecisionHub 调用 planTools
//   - ToolPlan 附加到 BrainDecision.toolPlan，传给子 agent 作为 directive
//   - 子 agent 收到 directive 后按 plan 顺序调工具，避免乱试
//
// 设计要点：
//   - 纯规则匹配，不调 LLM（避免幻觉）
//   - 工具依赖图：硬编码常见组合（如 search→fetch→summarize）
//   - 成本预估基于历史均值（首次用经验值）

import type { RuleRouteDecision } from "./rule-router.js";
import type { CapabilityDescriptor } from "./types.js";

/** 工具规划结果 */
export interface ToolPlan {
  /** 任务摘要 */
  task: string;
  /** 规划的工具链（按执行顺序） */
  toolChain: PlannedTool[];
  /** 预估总 token */
  estimatedTokens: number;
  /** 预估总耗时（ms） */
  estimatedDurationMs: number;
  /** 预估调用次数 */
  estimatedCalls: number;
  /** Fallback 方案（高成本工具失败时） */
  fallback?: { tool: string; reason: string };
  /** 能力缺口（任务要求但能力缺失） */
  capabilityGaps: string[];
  /** 规划依据 */
  reasoning: string;
  /** 规划时间 */
  plannedAt: string;
}

/** 单个规划的工具 */
export interface PlannedTool {
  name: string;
  /** 调用目的 */
  purpose: string;
  /** 预估 token */
  estimatedTokens: number;
  /** 是否关键路径（失败则整个任务失败） */
  critical: boolean;
  /** 依赖的前置工具名 */
  dependsOn?: string;
}

/** 工具元数据（能力注册表快照） */
export interface ToolMetadata {
  name: string;
  category: "search" | "fetch" | "compute" | "io" | "ui" | "communication" | "other";
  avgTokens: number;
  avgDurationMs: number;
  criticality: "low" | "medium" | "high";
}

// 工具元数据默认值（无历史数据时用）
const DEFAULT_TOOL_META: Record<string, ToolMetadata> = {
  search_web: { name: "search_web", category: "search", avgTokens: 800, avgDurationMs: 2000, criticality: "medium" },
  fetch_page: { name: "fetch_page", category: "fetch", avgTokens: 2000, avgDurationMs: 3000, criticality: "medium" },
  weather_query: { name: "weather_query", category: "compute", avgTokens: 300, avgDurationMs: 800, criticality: "low" },
  clock_now: { name: "clock_now", category: "compute", avgTokens: 100, avgDurationMs: 50, criticality: "low" },
  calendar_query: { name: "calendar_query", category: "compute", avgTokens: 500, avgDurationMs: 500, criticality: "low" },
  desktop_uia_query: { name: "desktop_uia_query", category: "ui", avgTokens: 1500, avgDurationMs: 1500, criticality: "high" },
  desktop_run_input: { name: "desktop_run_input", category: "ui", avgTokens: 500, avgDurationMs: 1000, criticality: "high" },
  desktop_open: { name: "desktop_open", category: "ui", avgTokens: 400, avgDurationMs: 800, criticality: "high" },
  desktop_run_shell: { name: "desktop_run_shell", category: "io", avgTokens: 800, avgDurationMs: 2000, criticality: "high" },
  notes_create: { name: "notes_create", category: "io", avgTokens: 300, avgDurationMs: 200, criticality: "low" },
  browser_navigate: { name: "browser_navigate", category: "ui", avgTokens: 600, avgDurationMs: 2000, criticality: "medium" },
};

// 2026-10-22 架构定稿：任务关键词 → 工具链映射整表退役。
// 原因：①硬编码映射会随工具增长漂移——它曾产出 weather_query/clock_now/
// calendar_query/fetch_page/desktop_open 五个注册表里根本不存在的名字，并被
// 写进 prompt 的【建议工具链】；②它把「该用哪个工具」的判断从模型手里抢走，
// 表外场景只能掉兜底。工具选择权归模型：本表恒空，planTools 返回空链。
const TASK_TOOL_PATTERNS: Array<{
  pattern: RegExp;
  tools: Array<{ name: string; purpose: string; critical?: boolean; dependsOn?: string }>;
  reasoning: string;
}> = [];

/**
 * 工具规划皮层。
 *
 * 根据任务文本和已有能力，规划工具链、预估成本、生成 fallback。
 * 不调 LLM，纯规则匹配。
 */
export class ToolPlanningCortex {
  /** 统计 */
  private planCount = 0;
  private gapDetectedCount = 0;
  /** actorId → 最近 ToolPlan（用于 fallback 决策） */
  private readonly lastPlans = new Map<string, ToolPlan>();

  /**
   * 规划工具链。
   *
   * 输入任务文本 + 能力快照 + 路由决策，输出 ToolPlan。
   */
  planTools(actorId: string, task: string, capabilities: CapabilityDescriptor[], _route: RuleRouteDecision): ToolPlan {
    this.planCount++;

    // 从 CapabilityDescriptor 收集所有可用工具名（每个 capability 有 tools 数组）
    const capabilityTools = new Set<string>();
    for (const cap of capabilities) {
      for (const toolName of cap.tools ?? []) capabilityTools.add(toolName);
    }
    const capabilityGaps: string[] = [];

    // 1. 匹配任务模式
    let matchedPattern: (typeof TASK_TOOL_PATTERNS)[number] | undefined;
    for (const p of TASK_TOOL_PATTERNS) {
      if (p.pattern.test(task)) {
        matchedPattern = p;
        break;
      }
    }

    // 2. 构建工具链
    const toolChain: PlannedTool[] = [];
    let reasoning: string;

    if (matchedPattern) {
      reasoning = matchedPattern.reasoning;
      for (const t of matchedPattern.tools) {
        const meta = DEFAULT_TOOL_META[t.name];
        // 检测能力缺口
        if (!capabilityTools.has(t.name)) {
          capabilityGaps.push(t.name);
        }
        toolChain.push({
          name: t.name,
          purpose: t.purpose,
          estimatedTokens: meta?.avgTokens ?? 500,
          critical: t.critical ?? false,
          dependsOn: t.dependsOn,
        });
      }
    } else {
      // 2026-10-22 架构定稿：不再用 search_web 做「未匹配兜底」——那等于把
      // 「要不要搜」写死在代码里。空链 = 不给建议，模型按工具 schema 与域目录
      // 自行决定。下游 prompt-context-builder 以 toolChain.length>0 为渲染条件，
      // 空链时【建议工具链】块自然消失。
      reasoning = "不预设工具链：由模型按工具目录与 schema 自行决定";
    }

    // 3. 预估成本
    let estimatedTokens = 0;
    let estimatedDurationMs = 0;
    for (const t of toolChain) {
      estimatedTokens += t.estimatedTokens;
      estimatedDurationMs += DEFAULT_TOOL_META[t.name]?.avgDurationMs ?? 1000;
    }
    const estimatedCalls = toolChain.length;

    // 4. 生成 fallback（关键工具失败时）
    let fallback: ToolPlan["fallback"];
    const criticalTool = toolChain.find((t) => t.critical);
    if (criticalTool) {
      switch (criticalTool.name) {
        case "search_web":
          fallback = { tool: "fetch_page", reason: "search_web 失败时直接 fetch_page 抓取目标 URL" };
          break;
        case "desktop_open":
        case "desktop_uia_query":
        case "desktop_run_input":
          fallback = { tool: "desktop_run_shell", reason: "UIA 失败时降级到 shell 执行" };
          break;
        default:
          fallback = undefined;
      }
    }

    if (capabilityGaps.length > 0) this.gapDetectedCount++;

    const plan: ToolPlan = {
      task: task.slice(0, 200),
      toolChain,
      estimatedTokens,
      estimatedDurationMs,
      estimatedCalls,
      fallback,
      capabilityGaps,
      reasoning,
      plannedAt: new Date().toISOString(),
    };

    this.lastPlans.set(actorId, plan);
    return plan;
  }

  /** 获取最近的 ToolPlan */
  getLastPlan(actorId: string): ToolPlan | null {
    return this.lastPlans.get(actorId) ?? null;
  }

  /** 优化工具顺序：基于依赖关系重排 */
  optimizeToolOrder(tools: PlannedTool[]): PlannedTool[] {
    const sorted: PlannedTool[] = [];
    const visited = new Set<string>();
    const visit = (tool: PlannedTool) => {
      if (visited.has(tool.name)) return;
      if (tool.dependsOn) {
        const dep = tools.find((t) => t.name === tool.dependsOn);
        if (dep) visit(dep);
      }
      visited.add(tool.name);
      sorted.push(tool);
    };
    for (const t of tools) visit(t);
    return sorted;
  }

  getStats(): {
    planCount: number;
    gapDetectedCount: number;
    activeActors: number;
  } {
    return {
      planCount: this.planCount,
      gapDetectedCount: this.gapDetectedCount,
      activeActors: this.lastPlans.size,
    };
  }

  async start(): Promise<void> {
    console.log("[ToolPlanningCortex] 启动完成（内置 %d 任务模式）", TASK_TOOL_PATTERNS.length);
  }
  async stop(): Promise<void> {
    this.lastPlans.clear();
    console.log("[ToolPlanningCortex] 已停止");
  }
}
