/**
 * 会话级任务计划能力模块（capability-module）。
 *
 * 导出 plan.write / plan.set_status / plan.replan / plan.read 四工具。
 * 状态与落盘在 TaskPlanStore（agent/task-plan-store.ts），本模块只挂 schema + 注册。
 *
 * 为什么独立于 goal-planning：两者是不同时间尺度（docs/goal-hybrid-architecture.md）。
 * goal 跨会话、带预算与自主推进；plan 只在会话内、完成即归档。
 */
import { TASK_PLAN_CHAT_TOOLS } from "./chat-tools.js";
import { registerTaskPlanTools, type TaskPlanModuleDeps } from "./handlers.js";
import { TASK_PLAN_INTENT_RULES, TASK_PLAN_CATEGORY_MAPPING } from "./intent.js";

export { TASK_PLAN_CHAT_TOOLS } from "./chat-tools.js";
export { TASK_PLAN_INTENT_RULES, TASK_PLAN_CATEGORY_MAPPING } from "./intent.js";
export { registerTaskPlanTools, type TaskPlanModuleDeps } from "./handlers.js";

/** CapabilityModule 描述符组装（goalPlanner 晚绑定；store 走进程级单例） */
export function buildTaskPlanModule(deps: TaskPlanModuleDeps = {}) {
  return {
    domain: "task_plan",
    label: "任务计划（会话内多步 + 长期目标统一入口）",
    chatTools: TASK_PLAN_CHAT_TOOLS,
    intentRules: TASK_PLAN_INTENT_RULES,
    register: (registry: Parameters<typeof registerTaskPlanTools>[0]) =>
      registerTaskPlanTools(registry, deps),
    category: TASK_PLAN_CATEGORY_MAPPING,
  };
}
