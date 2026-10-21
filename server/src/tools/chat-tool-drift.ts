/**
 * 工具 schema ↔ 执行器 注册漂移检测（阶段1 单一事实源守卫）。
 *
 * 背景：LLM schema（builtin-chat-tools / capability-modules / MCP / Brain / Body 注入）
 * 与执行器（ToolRegistry.register）此前是两套手工维护的清单，漂移只能等运行期暴露：
 *  - schema 有、执行器无 → 模型一调用就报「未知工具」（2026-08-30 self.list_custom_skills 事故）；
 *  - 执行器有、schema 无 → 工具对 LLM 永久不可见（延迟目录里也无 schema 可加载）。
 *
 * 本模块在 bootstrap 完成「全部注册 + schema 注入」后做一次双向 diff，漂移以
 * warn 级别输出（不阻断启动——部分缺位是有意为之，见豁免表）。
 */
import type { ChatCompletionTool } from "openai/resources/chat/completions";

import { resolveRegistryToolName } from "./tool-registry.js";

export interface ChatToolDriftReport {
  /** 有 LLM schema 但注册表无执行器（模型一调用就报未知工具的故障类） */
  schemaOnly: string[];
  /** 有执行器但无任何 LLM schema（对 LLM 永久不可见） */
  executorOnly: string[];
}

/**
 * schema-only 豁免：别名归一后仍不在注册表的 schema 名。
 * tool_search 桥接元工具的执行在 executeToolSearchBridge（不进 ToolRegistry）。
 */
const SCHEMA_ONLY_ALLOWLIST = new Set<string>([
  "tool_search",
  "tool_discover",
  "tool_describe",
  // obs_recall 在 openai-compatible-tool-loop 循环层直接服务（ObservationPack 读回），不进 ToolRegistry
  "obs_recall",
]);

/**
 * executor-only 豁免前缀：由运行时动态获得 schema 的执行器
 * （SkillManager 按会话合并 function 列表、BodyGateway 预路由等）。
 */
const EXECUTOR_ONLY_ALLOWLIST_PREFIXES = ["skill.", "self.", "world."];

function apiSideName(schemaName: string): string {
  return schemaName.replace(/\./g, "_");
}

export function reportChatToolDrift(opts: {
  /** 全量 builtin LLM schema（getBuiltinAgentChatTools 的产出） */
  schemas: ChatCompletionTool[];
  /** ToolRegistry.list() 的执行器名（含 skill 动态注入时调用方自行附加） */
  registeredToolNames: string[];
}): ChatToolDriftReport {
  const registryNames = new Set(opts.registeredToolNames);

  const schemaNames = new Set<string>();
  for (const tool of opts.schemas) {
    if (tool.type !== "function" || !tool.function?.name) continue;
    schemaNames.add(tool.function.name);
  }

  const schemaOnly: string[] = [];
  for (const name of schemaNames) {
    if (SCHEMA_ONLY_ALLOWLIST.has(name)) continue;
    if (registryNames.has(name)) continue;
    // 别名归一后命中（如 self.list_custom_skills → skill.list）
    if (registryNames.has(resolveRegistryToolName(name))) continue;
    // API 侧下划线名注册的场景（历史路径）
    if (registryNames.has(apiSideName(name))) continue;
    schemaOnly.push(name);
  }

  const executorOnly: string[] = [];
  for (const name of registryNames) {
    if (schemaNames.has(name)) continue;
    // 注册名换算成 API 下划线名后命中（等价可见）
    if (schemaNames.has(name.replace(/\./g, "_"))) continue;
    if (EXECUTOR_ONLY_ALLOWLIST_PREFIXES.some((p) => name.startsWith(p))) continue;
    executorOnly.push(name);
  }

  return { schemaOnly: schemaOnly.sort(), executorOnly: executorOnly.sort() };
}

/** bootstrap 调用：执行 diff 并输出告警日志。 */
export function warnOnChatToolDrift(opts: {
  schemas: ChatCompletionTool[];
  registeredToolNames: string[];
}): ChatToolDriftReport {
  const report = reportChatToolDrift(opts);
  if (report.schemaOnly.length > 0) {
    console.warn(
      `[chat-tool-drift] ${report.schemaOnly.length} 个 schema 无对应执行器（模型调用将报"未知工具"，请补注册或删除 schema）:\n  ` +
        report.schemaOnly.join("\n  "),
    );
  }
  if (report.executorOnly.length > 0) {
    console.warn(
      `[chat-tool-drift] ${report.executorOnly.length} 个执行器无任何 LLM schema（对模型不可见，请补 schema 或确认豁免）:\n  ` +
        report.executorOnly.join("\n  "),
    );
  }
  if (report.schemaOnly.length === 0 && report.executorOnly.length === 0) {
    console.info("[chat-tool-drift] schema ↔ 执行器 双向对齐，无漂移");
  }
  return report;
}
