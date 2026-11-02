// Body Center agent 工具：让 LLM 通过工具调用感知身体状态与器官能力。
//
// 设计原则：
// - 工具描述仅说明用途与调用时机，不写 prompt 引导 LLM 自我反思
// - bodyCenter 为 null 时：registerBodyTools 不注册任何工具（避免运行时报错），
//   BODY_CHAT_TOOLS schema 数组仍可导出，但是否暴露给 LLM 由装配阶段控制
// - 全部通过 BodyCenter 公开方法访问，不触及私有字段

import type { ChatCompletionTool } from "openai/resources/chat/completions";

import { resolveActorId } from "../agent/actor-id.js";
import type { ToolRegistry } from "./tool-registry.js";
import type { BodyCenter } from "../body/body-center.js";
import type { BodyModuleKind } from "../body/types.js";

// ---- 工具 schema ------------------------------------------------------

/** body.where_am_i —— 查询当前具身位置 */
export const BODY_WHERE_AM_I_TOOL: ChatCompletionTool = {
  type: "function",
  function: {
    name: "body.where_am_i",
    description:
      "查询自己当前在哪台设备渲染、3D 位置、mood、caption。当你需要知道自己身体当前在哪里显示、什么姿态时调用。",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
};

/** body.state —— 查询身体内部状态 */
export const BODY_STATE_TOOL: ChatCompletionTool = {
  type: "function",
  function: {
    name: "body.state",
    description:
      "查询身体内部状态（电量/位置/算力配额/负载/疲劳度）。当你需要知道用户设备电量、当前是否负载过高、当前地理位置时调用。",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
};

/** body.list_modules —— 列出所有 BodyModule */
export const BODY_LIST_MODULES_TOOL: ChatCompletionTool = {
  type: "function",
  function: {
    name: "body.list_modules",
    description:
      "列出所有身体模块（视觉/听觉/体感/前庭/稳态/反射）及其工具清单。当你需要知道自己有哪些身体能力、可调用哪些身体器官时调用。",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
};

/** body.calibrate —— 触发器官重新校准 */
export const BODY_CALIBRATE_TOOL: ChatCompletionTool = {
  type: "function",
  function: {
    name: "body.calibrate",
    description:
      "触发某个身体器官重新校准（如重新截屏、重新拉取设备列表）。当你判断某个器官状态过期或异常时调用。",
    parameters: {
      type: "object",
      properties: {
        module: {
          type: "string",
          description: "模块名",
          enum: ["eye", "ear", "skin", "vestibular", "homeostasis"],
        },
      },
      required: ["module"],
      additionalProperties: false,
    },
  },
};

/** body 工具的 schema 数组（供装配阶段注入到 getBuiltinAgentChatTools） */
export const BODY_CHAT_TOOLS: ChatCompletionTool[] = [
  BODY_WHERE_AM_I_TOOL,
  BODY_STATE_TOOL,
  BODY_LIST_MODULES_TOOL,
  BODY_CALIBRATE_TOOL,
];

// ---- 内部辅助 --------------------------------------------------------

/** body.calibrate 工具允许的模块名（不含 reflex，反射弧不需要校准） */
const VALID_CALIBRATE_MODULES: ReadonlySet<BodyModuleKind> = new Set<BodyModuleKind>([
  "eye",
  "ear",
  "skin",
  "vestibular",
  "homeostasis",
]);

// ---- 工具 handler 注册 ------------------------------------------------

/**
 * 注册 body.* 工具到 ToolRegistry。
 *
 * - bodyCenter 为 null 时：不注册任何工具，避免运行时调用时报错。
 * - schema 暴露与否由装配阶段（Task 14）控制，与 register 解耦。
 */
export function registerBodyTools(
  registry: ToolRegistry,
  bodyCenter: BodyCenter | null,
): void {
  if (!bodyCenter) {
    // body 未启用：不注册 handler，避免运行时 KeyError
    return;
  }

  // ---- body.where_am_i ----
  registry.register("body.where_am_i", async (input, context) => {
    try {
      const actorId = resolveActorId(context);
      const result = await bodyCenter.sense({ kind: "where_am_i", actorId });
      return {
        ok: result.ok,
        actorId,
        ...result.data,
        errorMessage: result.errorMessage,
      };
    } catch (err) {
      return {
        ok: false,
        error: `body.where_am_i 失败：${err instanceof Error ? err.message : String(err)}`,
      };
    }
  });

  // ---- body.state ----
  registry.register("body.state", async (input, context) => {
    try {
      const actorId = resolveActorId(context);
      const state = bodyCenter.state(actorId);
      return {
        ok: true,
        actorId,
        state,
      };
    } catch (err) {
      return {
        ok: false,
        error: `body.state 失败：${err instanceof Error ? err.message : String(err)}`,
      };
    }
  });

  // ---- body.list_modules ----
  registry.register("body.list_modules", async () => {
    try {
      const snap = bodyCenter.snapshot();
      return {
        ok: true,
        count: snap.modules.length,
        modules: snap.modules,
      };
    } catch (err) {
      return {
        ok: false,
        error: `body.list_modules 失败：${err instanceof Error ? err.message : String(err)}`,
      };
    }
  });

  // ---- body.calibrate ----
  registry.register("body.calibrate", async (input) => {
    try {
      const moduleRaw = typeof input.module === "string" ? input.module.trim() : "";
      if (!moduleRaw || !VALID_CALIBRATE_MODULES.has(moduleRaw as BodyModuleKind)) {
        return { ok: false, error: "缺少或无效的必填字段：module" };
      }
      const module = moduleRaw as BodyModuleKind;
      const result = await bodyCenter.sense({ kind: "calibrate", module });
      return {
        ok: result.ok,
        module,
        ...result.data,
        errorMessage: result.errorMessage,
      };
    } catch (err) {
      return {
        ok: false,
        error: `body.calibrate 失败：${err instanceof Error ? err.message : String(err)}`,
      };
    }
  });
}
