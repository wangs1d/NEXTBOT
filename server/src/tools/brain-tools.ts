// Brain Center agent 工具：让 LLM 通过工具调用认识自己的能力与用户状态。
//
// 设计原则：
// - 工具描述仅说明用途与调用时机，不写 prompt 引导 LLM 自我反思
// - brainCenter 为 null 时：registerBrainTools 不注册任何工具（避免运行时报错），
//   BRAIN_TOOLS schema 数组仍可导出，但是否暴露给 LLM 由 setBrainChatTools 控制
// - 全部通过 BrainCenter 公开方法访问，不触及私有字段

import type { ChatCompletionTool } from "openai/resources/chat/completions";

import { resolveActorId } from "../agent/actor-id.js";
import type { RuntimeKernelPromptMode, RuntimeKernelState } from "../agent/runtime-kernel.js";
import type { ToolRegistry } from "./tool-registry.js";
import type { ToolContext } from "./tool-registry.js";
import type { BrainCenter } from "../brain/brain-center.js";
import type {
  AudioBufferRef,
  CapabilityDescriptor,
  EvolutionProposal,
  EvolutionProposalType,
  MemoryDomainKind,
  MemoryItem,
  MemoryItemKind,
  UserActivityKind,
  UserActivityState,
  BugSignal,
  BugSignalSource,
  RepairStatus,
} from "../brain/types.js";

// ---- 工具 schema ------------------------------------------------------

/** brain.list_capabilities —— 查询自己拥有的能力域 */
export const BRAIN_LIST_CAPABILITIES_TOOL: ChatCompletionTool = {
  type: "function",
  function: {
    name: "brain.list_capabilities",
    description:
      "查询自己当前已注册的能力域清单。当你需要知道自己有哪些能力、可调用哪些工具时调用，例如用户问「你能做什么」、或需要判断某任务是否在自己能力范围内时。设置 include_schema=true 可一并返回每个工具的 parameters schema（仅在需要直接构造工具调用参数时使用，避免 token 浪费）。",
    parameters: {
      type: "object",
      properties: {
        actorId: {
          type: "string",
          description: "用户/会话标识，用于按 actor 过滤能力；不传则使用当前上下文 actor。",
        },
        include_schema: {
          type: "boolean",
          description:
            "是否返回每个工具的完整 parameters schema。默认 false 只返回工具名；设为 true 时会显著增加返回体积，仅在你需要立即构造工具调用参数且不想再单独 tool_discover 时使用。",
          default: false,
        },
      },
      additionalProperties: false,
    },
  },
};

/** brain.identify_gap —— 描述一个场景，返回可能缺失的能力 */
export const BRAIN_IDENTIFY_GAP_TOOL: ChatCompletionTool = {
  type: "function",
  function: {
    name: "brain.identify_gap",
    description:
      "基于一段场景描述识别可能缺失的能力域。当用户提出新需求但现有工具难以覆盖、或需要判断是否要走 self-programming 扩展时调用。返回缺失能力、已就绪可复用的相邻能力、是否可走 self-programming 扩展。",
    parameters: {
      type: "object",
      properties: {
        scenario: {
          type: "string",
          description: "场景描述，自然语言，例如「帮用户规划一次出国旅游行程」。",
        },
      },
      required: ["scenario"],
      additionalProperties: false,
    },
  },
};

/** brain.propose_capability —— 提议新增能力 / 优化现有能力 */
export const BRAIN_PROPOSE_CAPABILITY_TOOL: ChatCompletionTool = {
  type: "function",
  function: {
    name: "brain.propose_capability",
    description:
      "向 Brain Center 提交一个能力进化提案（新增能力 / 优化现有能力 / 增加工具 / 更新 prompt）。当你判断需要扩展自身能力、或识别到反复失败的能力缺口时调用。提案进入 pending 状态，由后续流程审批与执行。",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "提案标题，简短一句话。" },
        description: { type: "string", description: "提案详细描述：要新增/优化什么能力。" },
        rationale: { type: "string", description: "提出该提案的理由：为什么需要它。" },
        type: {
          type: "string",
          enum: ["new_capability", "optimize_existing", "add_tool", "update_prompt"],
          description:
            "提案类型：new_capability=新增能力域，optimize_existing=优化现有能力，add_tool=为现有能力新增工具，update_prompt=更新 prompt 策略。默认 new_capability。",
        },
      },
      required: ["title", "description", "rationale"],
      additionalProperties: false,
    },
  },
};

/** brain.execute_proposal —— 显式按 id 触发单个进化提案执行 */
export const BRAIN_EXECUTE_PROPOSAL_TOOL: ChatCompletionTool = {
  type: "function",
  function: {
    name: "brain.execute_proposal",
    description:
      "显式按 id 触发单个进化提案的执行（approved → 生成 Skill / 装载）。当你或用户已确认一个进化提案需要真正落地时调用。返回执行结果与提案最新状态；若提案不存在、已是终态或未处于 approved 状态则返回 error。",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "进化提案 id（evolve 创建或 listPending 返回的 id）。" },
      },
      required: ["id"],
      additionalProperties: false,
    },
  },
};

/** brain.observe_user —— 查询当前用户活动状态 */
export const BRAIN_OBSERVE_USER_TOOL: ChatCompletionTool = {
  type: "function",
  function: {
    name: "brain.observe_user",
    description:
      "查询当前用户的活动状态推断（刚下班 / 准备出行 / 忙碌 / 空闲 / 休息 / 未知）。当你需要判断用户当前是否在忙、是否下班、是否在出行时调用，用于决定是否主动打扰、用什么口吻回应。",
    parameters: {
      type: "object",
      properties: {
        actorId: {
          type: "string",
          description: "用户/会话标识；不传则使用当前上下文 actor。",
        },
      },
      additionalProperties: false,
    },
  },
};

/** brain.listen —— 语音识别 */
export const BRAIN_LISTEN_TOOL: ChatCompletionTool = {
  type: "function",
  function: {
    name: "brain.listen",
    description:
      "语音识别：将音频转为文本。当用户发送语音消息、或需要将录音转为文字时调用。",
    parameters: {
      type: "object",
      properties: {
        audioData: {
          type: "string",
          description: "base64 编码的音频数据。",
        },
        audioFormat: {
          type: "string",
          enum: ["mp3", "wav", "pcm", "ogg"],
          description: "音频格式，默认 mp3。",
        },
        language: {
          type: "string",
          description: "识别语言代码（如 zh-CN / en-US），不传则自动检测。",
        },
      },
      required: ["audioData"],
      additionalProperties: false,
    },
  },
};

/** brain.look —— 截屏查看 */
export const BRAIN_LOOK_TOOL: ChatCompletionTool = {
  type: "function",
  function: {
    name: "brain.look",
    description:
      "截屏查看：截取屏幕画面并可选生成文字描述。当需要看到用户屏幕内容、或进行视觉操控前的环境感知时调用。",
    parameters: {
      type: "object",
      properties: {
        regionX: { type: "number", description: "截屏区域左上角 x 坐标。" },
        regionY: { type: "number", description: "截屏区域左上角 y 坐标。" },
        regionWidth: { type: "number", description: "截屏区域宽度。" },
        regionHeight: { type: "number", description: "截屏区域高度。" },
      },
      additionalProperties: false,
    },
  },
};

/** brain.speak —— 语音合成 */
export const BRAIN_SPEAK_TOOL: ChatCompletionTool = {
  type: "function",
  function: {
    name: "brain.speak",
    description:
      "语音合成：将文本转为语音并推送给用户。当需要用语音回复用户、或进行端到端语音对话时调用。",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: "要合成语音的文本内容。" },
        voiceId: { type: "string", description: "发音人 ID，不传则使用默认音色。" },
        channel: { type: "string", description: "投递通道（如 ws / phone），不传则使用默认通道。" },
      },
      required: ["text"],
      additionalProperties: false,
    },
  },
};

/** brain.remember —— 写入记忆 */
export const BRAIN_REMEMBER_TOOL: ChatCompletionTool = {
  type: "function",
  function: {
    name: "brain.remember",
    description:
      "写入记忆：把一条信息存入记忆系统。当用户提到重要信息（偏好、事实、计划等）、或需要记住某件事时调用。",
    parameters: {
      type: "object",
      properties: {
        actorId: { type: "string", description: "用户/会话标识；不传则使用当前上下文 actor。" },
        content: { type: "string", description: "记忆内容，自然语言。" },
        kind: {
          type: "string",
          enum: ["task", "fact", "preference", "event", "commitment", "knowledge", "experience", "procedure"],
          description: "记忆种类，默认 fact。",
        },
        domain: {
          type: "string",
          enum: ["working", "episodic", "semantic", "procedural", "emotional", "narrative"],
          description: "记忆域，不传则由系统自动归类。",
        },
        importance: {
          type: "string",
          enum: ["critical", "high", "medium", "low"],
          description: "重要程度。",
        },
        source: {
          type: "string",
          enum: ["chat", "tool", "digest", "world", "system"],
          description: "记忆来源。",
        },
        sessionId: { type: "string", description: "会话 ID（工作记忆用）。" },
      },
      required: ["content"],
      additionalProperties: false,
    },
  },
};

/** brain.recall —— 记忆召回 */
export const BRAIN_RECALL_TOOL: ChatCompletionTool = {
  type: "function",
  function: {
    name: "brain.recall",
    description:
      "记忆召回：从用户长期记忆中检索与查询相关的历史信息（偏好、事实、承诺、经历）。" +
      "何时用：用户让你回忆「我之前说过/提过/喜欢过什么」、或回答需要用户个人历史信息而当前对话里没有时调用。" +
      "何时不用：当前对话上下文里刚说过的内容不用召回（直接看对话）；公开世界的实时事实用 search_web 而不是本工具。" +
      "检索为空时照实说没找到相关记忆，禁止编造。",
    parameters: {
      type: "object",
      properties: {
        actorId: { type: "string", description: "用户/会话标识；不传则使用当前上下文 actor。" },
        query: { type: "string", description: "检索查询，自然语言。" },
        domain: {
          type: "string",
          enum: ["working", "episodic", "semantic", "procedural", "emotional", "narrative"],
          description: "限定记忆域，不传则跨域召回。",
        },
        limit: { type: "number", description: "返回条目上限。" },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
};

/** brain.check_safety —— 安全检查 */
export const BRAIN_CHECK_SAFETY_TOOL: ChatCompletionTool = {
  type: "function",
  function: {
    name: "brain.check_safety",
    description:
      "安全检查：在执行高危操作前检查是否安全。当需要判断一个工具调用是否触碰安全红线、是否需要人工审批时调用。",
    parameters: {
      type: "object",
      properties: {
        tool: { type: "string", description: "要检查的工具名。" },
        args: { type: "object", description: "工具调用的参数对象。" },
        ctx: { type: "object", description: "上下文信息（可选），用于辅助安全判断。" },
      },
      required: ["tool", "args"],
      additionalProperties: false,
    },
  },
};

/** brain.plan —— 任务规划 */
export const BRAIN_PLAN_TOOL: ChatCompletionTool = {
  type: "function",
  function: {
    name: "brain.plan",
    description:
      "任务规划：将复杂目标拆解为可执行的子步骤序列。当用户提出复杂需求（如规划旅行、安排日程）、或需要多步骤任务分解时调用。",
    parameters: {
      type: "object",
      properties: {
        goal: { type: "string", description: "目标描述，自然语言。" },
        actorId: { type: "string", description: "用户/会话标识；不传则使用当前上下文 actor。" },
        maxSteps: { type: "number", description: "最大步骤数上限。" },
      },
      required: ["goal"],
      additionalProperties: false,
    },
  },
};

/** brain.route_system —— 系统路由 */
export const BRAIN_ROUTE_SYSTEM_TOOL: ChatCompletionTool = {
  type: "function",
  function: {
    name: "brain.route_system",
    description:
      "系统路由：根据用户消息决定走快思考（即时响应）还是慢思考（深度推理）。当需要判断消息复杂度、选择处理路径时调用。",
    parameters: {
      type: "object",
      properties: {
        userMessage: { type: "string", description: "用户消息原文。" },
        actorId: { type: "string", description: "用户/会话标识；不传则使用当前上下文 actor。" },
      },
      required: ["userMessage"],
      additionalProperties: false,
    },
  },
};

/** brain.delegate —— 委派子 Agent 执行专项任务 */
export const BRAIN_DELEGATE_TOOL: ChatCompletionTool = {
  type: "function",
  function: {
    name: "brain.delegate",
    description:
      "把专项任务委派给子 Agent 执行。当你判断任务超出自己直接处理范围、或需要专项能力（如深度搜索、技术开发、生活操作）时调用。可委派的子 Agent 类型包括：life（生活全能：钱包写+视觉操控）、tech（技术开发与运维）、info（信息检索与调研）。",
    parameters: {
      type: "object",
      properties: {
        subAgentType: {
          type: "string",
          description: "子 Agent 类型：life（生活全能）、tech（技术开发）、info（信息检索）。",
        },
        goal: {
          type: "string",
          description: "委派给子 Agent 的任务目标描述。",
        },
        input: {
          type: "string",
          description: "可选的前置上下文或输入数据，传给子 Agent 作为先验信息。",
        },
        actorId: {
          type: "string",
          description: "用户/会话标识；不传则使用当前上下文 actor。",
        },
      },
      required: ["subAgentType", "goal"],
      additionalProperties: false,
    },
  },
};

/** brain.runtime_kernel_get —— 读取当前 Agent 常驻运行时内核状态 */
export const BRAIN_RUNTIME_KERNEL_GET_TOOL: ChatCompletionTool = {
  type: "function",
  function: {
    name: "brain.runtime_kernel_get",
    description:
      "读取当前 Agent 的独立运行时内核状态。用于查看当前是否启用运行时内核、prompt 裁剪模式、身份风格、安全规则与全局配置，而不是从对话 prompt 里猜测。",
    parameters: {
      type: "object",
      properties: {
        actorId: {
          type: "string",
          description: "可选：指定目标 actor（多用户场景下隔离）。不传则使用当前调用 actor。",
        },
      },
      additionalProperties: false,
    },
  },
};

/** brain.runtime_kernel_update —— 热更新当前 Agent 常驻运行时内核状态 */
export const BRAIN_RUNTIME_KERNEL_UPDATE_TOOL: ChatCompletionTool = {
  type: "function",
  function: {
    name: "brain.runtime_kernel_update",
    description:
      "热更新当前 Agent 的独立运行时内核状态。适合中途切换 prompt 模式、调整身份风格、修改回复详略和安全规则；修改后立即生效，无需重建会话。多用户场景下每 actor 独立 state，互不污染。",
    parameters: {
      type: "object",
      properties: {
        actorId: {
          type: "string",
          description: "可选：指定目标 actor（多用户场景下隔离）。不传则使用当前调用 actor。",
        },
        enabled: {
          type: "boolean",
          description: "是否启用运行时内核。",
        },
        promptMode: {
          type: "string",
          enum: ["legacy", "dynamic", "conversation_only", "minimal"],
          description:
            "prompt 模式：legacy=保持旧式完整 prompt；dynamic=保留动态上下文并剥离稳定设定；conversation_only=仅保留对话级最小注入；minimal=层 A 不进 prompt，身份/工具说明下沉到会话首条 system + 程序层强制。",
        },
        identity: {
          type: "object",
          properties: {
            persona: {
              type: "array",
              items: { type: "string" },
              description: "身份标签列表，如 companion / butler / planner。",
            },
            values: {
              type: "array",
              items: { type: "string" },
              description: "价值观标签列表，如 safe / privacy-first / honest。",
            },
            style: {
              type: "array",
              items: { type: "string" },
              description: "风格标签列表，如 brief / natural / same-language。",
            },
          },
          additionalProperties: false,
        },
        postValidation: {
          type: "object",
          description: "后置校验规则。当前策略仅记录日志，不阻断输出。",
          properties: {
            bannedPatterns: {
              type: "array",
              items: { type: "string" },
              description: "正则字符串列表，命中即标记违规。非法正则退化为字符串包含匹配。",
            },
          },
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    },
  },
};

/** brain 工具的 schema 数组（供 setBrainChatTools 注入到 getBuiltinAgentChatTools） */
// 注：放在所有 *_TOOL schema 之后，避免 const 引用顺序问题。

// ---- 自我修复工具 schema -----------------------------------------------

/** brain.report_bug —— 报告一个 bug，触发自动修复闭环 */
export const BRAIN_REPORT_BUG_TOOL: ChatCompletionTool = {
  type: "function",
  function: {
    name: "brain.report_bug",
    description:
      "向 CodeRepairCortex 报告一个 bug（运行时异常/兜底频发/编译失败/用户报告等）。会自动触发隔离→分析→patch→测试→应用闭环。修复成功后源码会被实际修改，失败会自动回滚。",
    parameters: {
      type: "object",
      properties: {
        source: {
          type: "string",
          description: "bug 来源",
          enum: [
            "unhandled_rejection",
            "uncaught_exception",
            "tool_loop_max_rounds",
            "apology_fallback_burst",
            "compile_error",
            "user_report",
            "runtime_error",
          ] as BugSignalSource[],
        },
        title: {
          type: "string",
          description: "简短标题，例如 'chat-user-message.ts 状态行重复推送'",
        },
        errorMessage: {
          type: "string",
          description: "错误消息/堆栈/关键日志（多行字符串，可选）",
        },
        suspectFiles: {
          type: "array",
          items: { type: "string" },
          description: "嫌疑文件路径列表（相对 server/ 根，如 src/ws/handlers/foo.ts）",
        },
        userReport: {
          type: "string",
          description: "用户原始报告内容（source=user_report 时必填）",
        },
      },
      required: ["source", "title"],
      additionalProperties: false,
    },
  },
};

/** brain.list_repairs —— 列出修复提案 */
export const BRAIN_LIST_REPAIRS_TOOL: ChatCompletionTool = {
  type: "function",
  function: {
    name: "brain.list_repairs",
    description:
      "列出 CodeRepairCortex 中的修复提案（可按状态过滤）。返回最近修复历史与状态。",
    parameters: {
      type: "object",
      properties: {
        status: {
          type: "string",
          description: "按状态过滤（不传则返回全部）",
          enum: [
            "pending",
            "isolating",
            "analyzing",
            "patching",
            "testing",
            "applying",
            "fixed",
            "failed",
            "rejected",
          ] as RepairStatus[],
        },
      },
      additionalProperties: false,
    },
  },
};

/** brain.retry_repair —— 强制重试一个 failed 的修复提案 */
export const BRAIN_RETRY_REPAIR_TOOL: ChatCompletionTool = {
  type: "function",
  function: {
    name: "brain.retry_repair",
    description:
      "强制重试一个 failed 状态的修复提案。重置状态为 pending 并触发新一轮修复闭环。",
    parameters: {
      type: "object",
      properties: {
        repairId: {
          type: "string",
          description: "修复提案 id（reportBug 返回的 id）",
        },
      },
      required: ["repairId"],
      additionalProperties: false,
    },
  },
};

export const BRAIN_TOOLS: ChatCompletionTool[] = [
  BRAIN_LIST_CAPABILITIES_TOOL,
  BRAIN_IDENTIFY_GAP_TOOL,
  BRAIN_PROPOSE_CAPABILITY_TOOL,
  BRAIN_EXECUTE_PROPOSAL_TOOL,
  BRAIN_OBSERVE_USER_TOOL,
  BRAIN_LISTEN_TOOL,
  BRAIN_LOOK_TOOL,
  BRAIN_SPEAK_TOOL,
  BRAIN_REMEMBER_TOOL,
  BRAIN_RECALL_TOOL,
  BRAIN_CHECK_SAFETY_TOOL,
  BRAIN_PLAN_TOOL,
  BRAIN_ROUTE_SYSTEM_TOOL,
  BRAIN_DELEGATE_TOOL,
  BRAIN_RUNTIME_KERNEL_GET_TOOL,
  BRAIN_RUNTIME_KERNEL_UPDATE_TOOL,
  // 自我修复（CodeRepairCortex）：3 个工具
  BRAIN_REPORT_BUG_TOOL,
  BRAIN_LIST_REPAIRS_TOOL,
  BRAIN_RETRY_REPAIR_TOOL,
];

// ---- 内部常量与辅助 ----------------------------------------------------

const DEFAULT_ACTOR_ID = "default";

const VALID_PROPOSAL_TYPES: ReadonlySet<EvolutionProposalType> = new Set([
  "new_capability",
  "optimize_existing",
  "add_tool",
  "update_prompt",
]);

const VALID_RUNTIME_KERNEL_PROMPT_MODES: ReadonlySet<RuntimeKernelPromptMode> = new Set([
  "legacy",
  "dynamic",
  "conversation_only",
  "minimal",
]);

function asStringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter(Boolean);
  return items.length > 0 ? items : [];
}

function buildRuntimeKernelPatch(input: Record<string, unknown>): Partial<RuntimeKernelState> {
  const patch: Partial<RuntimeKernelState> = {};

  if (typeof input.enabled === "boolean") {
    patch.enabled = input.enabled;
  }

  if (typeof input.promptMode === "string") {
    const mode = input.promptMode.trim() as RuntimeKernelPromptMode;
    if (!VALID_RUNTIME_KERNEL_PROMPT_MODES.has(mode)) {
      throw new Error("promptMode 仅允许 legacy / dynamic / conversation_only / minimal");
    }
    patch.promptMode = mode;
  }

  if (typeof input.identity === "object" && input.identity !== null && !Array.isArray(input.identity)) {
    const identityInput = input.identity as Record<string, unknown>;
    const identityPatch: Partial<RuntimeKernelState["identity"]> = {};
    if ("persona" in identityInput) identityPatch.persona = asStringList(identityInput.persona) ?? [];
    if ("values" in identityInput) identityPatch.values = asStringList(identityInput.values) ?? [];
    if ("style" in identityInput) identityPatch.style = asStringList(identityInput.style) ?? [];
    if (Object.keys(identityPatch).length > 0) {
      patch.identity = identityPatch as RuntimeKernelState["identity"];
    }
  }

  if (
    typeof input.postValidation === "object" &&
    input.postValidation !== null &&
    !Array.isArray(input.postValidation)
  ) {
    const postValidationInput = input.postValidation as Record<string, unknown>;
    const postValidationPatch: Partial<RuntimeKernelState["postValidation"]> = {};
    if (Array.isArray(postValidationInput.bannedPatterns)) {
      const patterns = asStringList(postValidationInput.bannedPatterns);
      postValidationPatch.bannedPatterns = patterns ?? [];
    }
    if (Object.keys(postValidationPatch).length > 0) {
      patch.postValidation = postValidationPatch as RuntimeKernelState["postValidation"];
    }
  }

  return patch;
}

const ACTIVITY_LABELS: Record<UserActivityKind, string> = {
  just_off_work: "刚下班",
  going_out: "准备出行",
  meeting: "会议中",
  in_focus: "深度专注",
  idle: "空闲",
  busy: "忙碌",
  sleeping: "休息/睡眠",
  unknown: "未知",
};

/** 解析 actorId：优先使用入参，其次从 context 解析，最后回退 "default" */
function pickActorId(
  raw: unknown,
  context: ToolContext,
  fallback: string = DEFAULT_ACTOR_ID,
): string {
  if (typeof raw === "string" && raw.trim()) return raw.trim();
  const resolved = resolveActorId(context);
  return resolved || fallback;
}

/** 把能力清单格式化为紧凑文本：每行 `{domain} - {label} - tools: [...]` */
function formatCapabilityList(capabilities: CapabilityDescriptor[]): string {
  if (capabilities.length === 0) return "(无已注册能力域)";
  return capabilities
    .map((c) => {
      const toolList = c.tools.length > 0
        ? c.tools.join(", ")
        : "(无工具)";
      return `${c.domain} - ${c.label} [${c.status}] (${c.tools.length} tools)\n  ↳ ${toolList}`;
    })
    .join("\n");
}

/** 把 UserActivityState 格式化为面向 LLM 的紧凑文本 */
function formatUserActivity(state: UserActivityState | null): string {
  if (!state) return "未推断出用户活动状态（awareness 皮层未就绪或无信号）";
  const label = ACTIVITY_LABELS[state.activity] ?? state.activity;
  const evidence = state.evidence.length > 0 ? state.evidence.join("；") : "无证据";
  const meta = state.metadata && Object.keys(state.metadata).length > 0
    ? ` metadata=${JSON.stringify(state.metadata)}`
    : "";
  return `用户${label}（置信度 ${state.confidence}） | 证据：${evidence}${meta} | occurredAt=${state.occurredAt}`;
}

/** 把 EvolutionProposal 摘要为返回给 LLM 的对象 */
function formatProposalResult(proposal: EvolutionProposal) {
  return {
    ok: true,
    proposalId: proposal.id,
    status: proposal.status,
    type: proposal.type,
    title: proposal.title,
    createdAt: proposal.createdAt,
    message: `提案已提交，id=${proposal.id}，状态=${proposal.status}。后续可由审批流程推进至 reviewing / approved / executed。`,
  };
}

// ---- 工具 handler 注册 ------------------------------------------------

/**
 * 注册 brain.* 工具到 ToolRegistry。
 *
 * - brainCenter 为 null 时：不注册任何工具，避免运行时调用时报错。
 * - schema 暴露与否由 setBrainChatTools（在 openai-compatible-tool-loop.ts 中）
 *   控制，与 register 解耦。
 */
export function registerBrainTools(
  registry: ToolRegistry,
  brainCenter: BrainCenter | null,
  getToolSchema?: (name: string) => ChatCompletionTool | null,
): void {
  if (!brainCenter) {
    // brain 未启用：不注册 handler，避免运行时 KeyError
    return;
  }

  // ---- brain.list_capabilities ----
  registry.register("brain.list_capabilities", async (input, context) => {
    try {
      const actorId = pickActorId(input.actorId, context);
      // 动态刷新：MCP / self-programming 新增工具后让 capabilityCortex 可见
      // 内部有 60s 节流，避免每次调用都全量重算
      brainCenter.refreshCapabilityTools(registry.list());
      const capabilities = brainCenter.introspect(actorId);
      const includeSchema = input.include_schema === true && typeof getToolSchema === "function";
      const summary = formatCapabilityList(capabilities);
      const capabilitiesOut = capabilities.map((c) => {
        const base = {
          domain: c.domain,
          label: c.label,
          status: c.status,
          source: c.source,
          toolCount: c.tools.length,
          tools: c.tools,
        };
        if (!includeSchema) return base;
        // include_schema=true：附带每个工具的 parameters schema
        const toolSchemas: Array<{ name: string; description: string; parameters: unknown }> = [];
        for (const name of c.tools) {
          const tool = getToolSchema(name);
          if (!tool || tool.type !== "function" || !tool.function) continue;
          toolSchemas.push({
            name,
            description: tool.function.description ?? "",
            parameters: tool.function.parameters ?? { type: "object", properties: {} },
          });
        }
        return { ...base, toolSchemas };
      });
      return {
        ok: true,
        actorId,
        count: capabilities.length,
        includeSchema,
        summary,
        capabilities: capabilitiesOut,
      };
    } catch (err) {
      return {
        ok: false,
        error: `brain.list_capabilities 失败：${err instanceof Error ? err.message : String(err)}`,
      };
    }
  });

  // ---- brain.identify_gap ----
  registry.register("brain.identify_gap", async (input) => {
    try {
      const scenario = String(input.scenario ?? "").trim();
      if (!scenario) {
        return { ok: false, error: "缺少必填字段：scenario（场景描述）" };
      }

      const report = await brainCenter.identifyGap(scenario);
      if (!report) {
        return {
          ok: false,
          error:
            "CapabilityCortex.identifyGap 不可用（皮层未注册或内部结构变化），无法识别能力缺口。",
        };
      }

      const summaryParts: string[] = [];
      summaryParts.push(`场景：${report.scenario}`);
      if (report.missingDomains.length > 0) {
        summaryParts.push(`缺失能力域：${report.missingDomains.join("、")}`);
      } else {
        summaryParts.push("缺失能力域：（无）");
      }
      if (report.relatedExisting.length > 0) {
        summaryParts.push(`已有相邻能力：${report.relatedExisting.join("、")}`);
      }
      summaryParts.push(`可走 self-programming 扩展：${report.expandable ? "是" : "否"}`);
      summaryParts.push(`判定理由：${report.rationale}`);

      return {
        ok: true,
        summary: summaryParts.join("\n"),
        missingDomains: report.missingDomains,
        relatedExisting: report.relatedExisting,
        expandable: report.expandable,
        rationale: report.rationale,
        detectedAt: report.detectedAt,
      };
    } catch (err) {
      return {
        ok: false,
        error: `brain.identify_gap 失败：${err instanceof Error ? err.message : String(err)}`,
      };
    }
  });

  // ---- brain.propose_capability ----
  registry.register("brain.propose_capability", async (input) => {
    try {
      const title = String(input.title ?? "").trim();
      const description = String(input.description ?? "").trim();
      const rationale = String(input.rationale ?? "").trim();
      const rawType = String(input.type ?? "new_capability").trim() as EvolutionProposalType;

      if (!title || !description || !rationale) {
        return {
          ok: false,
          error: "缺少必填字段：title, description, rationale",
        };
      }
      if (!VALID_PROPOSAL_TYPES.has(rawType)) {
        return {
          ok: false,
          error: `无效的 type：${rawType}（允许：new_capability / optimize_existing / add_tool / update_prompt）`,
        };
      }

      const proposal = brainCenter.evolve({
        type: rawType,
        title,
        description,
        rationale,
      });
      return formatProposalResult(proposal);
    } catch (err) {
      return {
        ok: false,
        error: `brain.propose_capability 失败：${err instanceof Error ? err.message : String(err)}`,
      };
    }
  });

  // ---- brain.execute_proposal ----
  registry.register("brain.execute_proposal", async (input) => {
    try {
      const rawInput =
        typeof input === "object" && input !== null && !Array.isArray(input)
          ? (input as Record<string, unknown>)
          : {};
      const id = typeof rawInput.id === "string" ? rawInput.id.trim() : "";
      if (!id) {
        return { ok: false, error: "缺少必填字段：id（进化提案 id）" };
      }
      const result = await brainCenter.executeEvolution(id);
      if (!result.ok) {
        return {
          ok: false,
          error: result.error ?? `提案 ${id} 执行未成功`,
        };
      }
      return {
        ok: true,
        proposalId: id,
        status: result.proposal?.status,
        message: `提案 ${id} 执行完成，状态=${result.proposal?.status}`,
      };
    } catch (err) {
      return {
        ok: false,
        error: `brain.execute_proposal 失败：${err instanceof Error ? err.message : String(err)}`,
      };
    }
  });

  // ---- brain.observe_user ----
  registry.register("brain.observe_user", async (input, context) => {
    try {
      const actorId = pickActorId(input.actorId, context);
      const state = brainCenter.observe(actorId);
      const summary = formatUserActivity(state);
      return {
        ok: true,
        actorId,
        summary,
        activity: state?.activity ?? "unknown",
        confidence: state?.confidence ?? 0,
        evidence: state?.evidence ?? [],
        metadata: state?.metadata,
        occurredAt: state?.occurredAt,
      };
    } catch (err) {
      return {
        ok: false,
        error: `brain.observe_user 失败：${err instanceof Error ? err.message : String(err)}`,
      };
    }
  });

  // ---- brain.listen ----
  registry.register("brain.listen", async (input) => {
    try {
      const audioData = String(input.audioData ?? "").trim();
      if (!audioData) {
        return { ok: false, error: "缺少必填字段：audioData（base64 编码的音频）" };
      }
      const audioFormat = typeof input.audioFormat === "string" ? input.audioFormat.trim() : undefined;
      const language = typeof input.language === "string" ? input.language.trim() : undefined;

      const audio: AudioBufferRef = {
        data: Buffer.from(audioData, "base64"),
        format: (audioFormat ?? "mp3") as AudioBufferRef["format"],
      };
      const result = await brainCenter.listen(audio, { language });
      return {
        ok: true,
        text: result.text,
        confidence: result.confidence,
        language: result.language,
        isFinal: result.isFinal,
        processedAt: result.processedAt,
      };
    } catch (err) {
      return {
        ok: false,
        error: `brain.listen 失败：${err instanceof Error ? err.message : String(err)}`,
      };
    }
  });

  // ---- brain.look ----
  registry.register("brain.look", async (input) => {
    try {
      const regionX = typeof input.regionX === "number" ? input.regionX : null;
      const regionY = typeof input.regionY === "number" ? input.regionY : null;
      const regionWidth = typeof input.regionWidth === "number" ? input.regionWidth : null;
      const regionHeight = typeof input.regionHeight === "number" ? input.regionHeight : null;

      const result = await brainCenter.look(
        regionX != null
          ? {
              source: "screenshot" as const,
              region: {
                x: regionX,
                y: regionY ?? 0,
                width: regionWidth ?? 0,
                height: regionHeight ?? 0,
              },
            }
          : undefined,
      );
      return {
        ok: true,
        screenshot: result.screenshot,
        description: result.description,
        processedAt: result.processedAt,
      };
    } catch (err) {
      return {
        ok: false,
        error: `brain.look 失败：${err instanceof Error ? err.message : String(err)}`,
      };
    }
  });

  // ---- brain.speak ----
  registry.register("brain.speak", async (input) => {
    try {
      const text = String(input.text ?? "").trim();
      if (!text) {
        return { ok: false, error: "缺少必填字段：text（要合成的文本）" };
      }
      const voiceId = typeof input.voiceId === "string" ? input.voiceId.trim() : undefined;
      const channel = typeof input.channel === "string" ? input.channel.trim() : undefined;

      const result = await brainCenter.speak(text, { voiceId, channel });
      return {
        ok: true,
        delivered: result.delivered,
        channel: result.channel,
        audio: result.audio,
        processedAt: result.processedAt,
      };
    } catch (err) {
      return {
        ok: false,
        error: `brain.speak 失败：${err instanceof Error ? err.message : String(err)}`,
      };
    }
  });

  // ---- brain.remember ----
  registry.register("brain.remember", async (input, context) => {
    try {
      const content = String(input.content ?? "").trim();
      if (!content) {
        return { ok: false, error: "缺少必填字段：content（记忆内容）" };
      }
      const actorId = pickActorId(input.actorId, context);
      const kind = typeof input.kind === "string" ? input.kind.trim() : "";
      const domain =
        typeof input.domain === "string" && input.domain.trim() ? input.domain.trim() : undefined;
      const importance =
        typeof input.importance === "string" && input.importance.trim()
          ? input.importance.trim()
          : undefined;
      const source =
        typeof input.source === "string" && input.source.trim() ? input.source.trim() : undefined;
      const sessionId =
        typeof input.sessionId === "string" ? input.sessionId.trim() : undefined;

      const item: MemoryItem = {
        actorId,
        kind: (kind || "fact") as MemoryItemKind,
        content,
        domain: domain as MemoryDomainKind | undefined,
        importance: importance as MemoryItem["importance"],
        source: source as MemoryItem["source"],
        sessionId,
        timestamp: new Date().toISOString(),
      };

      await brainCenter.remember(actorId, item);
      return { ok: true, message: "记忆已写入" };
    } catch (err) {
      return {
        ok: false,
        error: `brain.remember 失败：${err instanceof Error ? err.message : String(err)}`,
      };
    }
  });

  // ---- brain.recall ----
  registry.register("brain.recall", async (input, context) => {
    try {
      const query = String(input.query ?? "").trim();
      if (!query) {
        return { ok: false, error: "缺少必填字段：query（检索查询）" };
      }
      const actorId = pickActorId(input.actorId, context);
      const domain =
        typeof input.domain === "string" && input.domain.trim() ? input.domain.trim() : undefined;
      const limit = typeof input.limit === "number" ? input.limit : undefined;

      const result = await brainCenter.recall(actorId, query, {
        domain: domain as MemoryDomainKind | undefined,
        limit,
      });
      return {
        ok: true,
        actorId: result.actorId,
        query: result.query,
        items: result.items,
        domain: result.domain,
        mode: result.mode,
        // 记忆免责声明（与【记忆图联想检索】注入块同款）：tool 消息进上下文时
        // 明确身份隔离，防止历史记忆被当成当前轮语境（串台防线）。
        note:
          "历史记忆检索结果，可能来自较早的对话，并非用户本轮陈述；" +
          "与当前对话冲突时，以用户最新消息为准。",
      };
    } catch (err) {
      return {
        ok: false,
        error: `brain.recall 失败：${err instanceof Error ? err.message : String(err)}`,
      };
    }
  });

  // ---- brain.check_safety ----
  registry.register("brain.check_safety", async (input) => {
    try {
      const tool = String(input.tool ?? "").trim();
      if (!tool) {
        return { ok: false, error: "缺少必填字段：tool（要检查的工具名）" };
      }
      const args =
        typeof input.args === "object" && input.args !== null && !Array.isArray(input.args)
          ? (input.args as Record<string, unknown>)
          : {};
      const ctx =
        typeof input.ctx === "object" && input.ctx !== null && !Array.isArray(input.ctx)
          ? (input.ctx as Record<string, unknown>)
          : undefined;

      const result = brainCenter.checkSafety({ tool, args }, ctx);
      return {
        ok: true,
        allowed: result.allowed,
        severity: result.severity,
        reason: result.reason,
        checkedAt: result.checkedAt,
      };
    } catch (err) {
      return {
        ok: false,
        error: `brain.check_safety 失败：${err instanceof Error ? err.message : String(err)}`,
      };
    }
  });

  // ---- brain.plan ----
  registry.register("brain.plan", async (input, context) => {
    try {
      const goal = String(input.goal ?? "").trim();
      if (!goal) {
        return { ok: false, error: "缺少必填字段：goal（目标描述）" };
      }
      const actorId = pickActorId(input.actorId, context);
      const maxSteps = typeof input.maxSteps === "number" ? input.maxSteps : undefined;

      const result = await brainCenter.plan(goal, { actorId, maxSteps });
      return {
        ok: true,
        goal: result.goal,
        steps: result.steps,
        rationale: result.rationale,
        createdAt: result.createdAt,
      };
    } catch (err) {
      return {
        ok: false,
        error: `brain.plan 失败：${err instanceof Error ? err.message : String(err)}`,
      };
    }
  });

  // ---- brain.route_system ----
  registry.register("brain.route_system", async (input, context) => {
    try {
      const userMessage = String(input.userMessage ?? "").trim();
      if (!userMessage) {
        return { ok: false, error: "缺少必填字段：userMessage（用户消息）" };
      }
      const actorId = pickActorId(input.actorId, context);

      const result = brainCenter.routeSystem(userMessage, { actorId });
      return {
        ok: true,
        userMessage: result.userMessage,
        system: result.system,
        mode: result.mode,
        rationale: result.rationale,
        decidedAt: result.decidedAt,
      };
    } catch (err) {
      return {
        ok: false,
        error: `brain.route_system 失败：${err instanceof Error ? err.message : String(err)}`,
      };
    }
  });

  // ---- brain.delegate ----
  registry.register("brain.delegate", async (input, context) => {
    try {
      const subAgentType = String(input.subAgentType ?? "").trim();
      const goal = String(input.goal ?? "").trim();
      if (!subAgentType) {
        return { ok: false, error: "缺少必填字段：subAgentType（子 Agent 类型）" };
      }
      if (!goal) {
        return { ok: false, error: "缺少必填字段：goal（任务目标）" };
      }
      const actorId = pickActorId(input.actorId, context);
      const taskInput = input.input != null ? String(input.input) : undefined;

      const result = await brainCenter.delegate(
        subAgentType,
        { goal, input: taskInput },
        { actorId },
      );
      return {
        ok: true,
        subAgentType,
        goal,
        result,
      };
    } catch (err) {
      return {
        ok: false,
        error: `brain.delegate 失败：${err instanceof Error ? err.message : String(err)}`,
      };
    }
  });

  // ---- brain.runtime_kernel_get ----
  registry.register("brain.runtime_kernel_get", async (input, context) => {
    try {
      const actorId = pickActorId(
        typeof input === "object" && input !== null && !Array.isArray(input)
          ? (input as Record<string, unknown>).actorId
          : undefined,
        context,
      );
      const kernel = brainCenter.getRuntimeKernelSnapshot(actorId);
      if (!kernel) {
        return {
          ok: false,
          error: "RuntimeKernel 未注册到 BrainCenter",
        };
      }
      return {
        ok: true,
        runtimeKernel: kernel,
      };
    } catch (err) {
      return {
        ok: false,
        error: `brain.runtime_kernel_get 失败：${err instanceof Error ? err.message : String(err)}`,
      };
    }
  });

  // ---- brain.runtime_kernel_update ----
  registry.register("brain.runtime_kernel_update", async (input, context) => {
    try {
      const rawInput =
        typeof input === "object" && input !== null && !Array.isArray(input)
          ? (input as Record<string, unknown>)
          : {};
      const actorId = pickActorId(rawInput.actorId, context);
      const patch = buildRuntimeKernelPatch(rawInput);
      if (Object.keys(patch).length === 0) {
        return {
          ok: false,
          error: "未检测到可更新字段",
        };
      }

      const kernel = brainCenter.updateRuntimeKernel(patch, actorId);
      if (!kernel) {
        return {
          ok: false,
          error: "RuntimeKernel 未注册到 BrainCenter",
        };
      }

      return {
        ok: true,
        runtimeKernel: kernel,
        updatedFields: Object.keys(patch),
      };
    } catch (err) {
      return {
        ok: false,
        error: `brain.runtime_kernel_update 失败：${err instanceof Error ? err.message : String(err)}`,
      };
    }
  });

  // ---- 自我修复（CodeRepairCortex）工具 handler ----

  registry.register("brain.report_bug", async (input) => {
    try {
      const rawInput =
        typeof input === "object" && input !== null && !Array.isArray(input)
          ? (input as Record<string, unknown>)
          : {};
      const source = rawInput.source as BugSignalSource | undefined;
      const title = typeof rawInput.title === "string" ? rawInput.title : "";
      if (!source || !title) {
        return { ok: false, error: "source 和 title 为必填" };
      }
      const signal: BugSignal = {
        source,
        title,
        errorMessage: typeof rawInput.errorMessage === "string" ? rawInput.errorMessage : undefined,
        suspectFiles: Array.isArray(rawInput.suspectFiles)
          ? (rawInput.suspectFiles as unknown[]).filter((s): s is string => typeof s === "string")
          : undefined,
        userReport:
          typeof rawInput.userReport === "string" ? rawInput.userReport : undefined,
      };
      const proposal = await brainCenter.reportBug(signal);
      if (!proposal) {
        return {
          ok: false,
          error: "CodeRepairCortex 未注册或 reportBug 不可用",
        };
      }
      return {
        ok: true,
        repairId: proposal.id,
        status: proposal.status,
        message: `已收到 bug 信号，正在自动修复。可调用 brain.list_repairs 查看进度，brain.retry_repair 强制重试。`,
      };
    } catch (err) {
      return {
        ok: false,
        error: `brain.report_bug 失败：${err instanceof Error ? err.message : String(err)}`,
      };
    }
  });

  registry.register("brain.list_repairs", async (input) => {
    try {
      const rawInput =
        typeof input === "object" && input !== null && !Array.isArray(input)
          ? (input as Record<string, unknown>)
          : {};
      const status = typeof rawInput.status === "string" ? (rawInput.status as RepairStatus) : undefined;
      const repairs = brainCenter.listRepairs(status);
      return {
        ok: true,
        total: repairs.length,
        repairs: repairs.map((r) => ({
          id: r.id,
          title: r.title,
          source: r.source,
          status: r.status,
          retryCount: r.retryCount,
          lastError: r.lastError,
          rootCause: r.rootCause,
          explanation: r.explanation,
          testPassed: r.testPassed,
          createdAt: r.createdAt,
          updatedAt: r.updatedAt,
        })),
      };
    } catch (err) {
      return {
        ok: false,
        error: `brain.list_repairs 失败：${err instanceof Error ? err.message : String(err)}`,
      };
    }
  });

  registry.register("brain.retry_repair", async (input) => {
    try {
      const rawInput =
        typeof input === "object" && input !== null && !Array.isArray(input)
          ? (input as Record<string, unknown>)
          : {};
      const repairId = typeof rawInput.repairId === "string" ? rawInput.repairId : "";
      if (!repairId) {
        return { ok: false, error: "repairId 为必填" };
      }
      const proposal = await brainCenter.retryRepair(repairId);
      if (!proposal) {
        return { ok: false, error: "CodeRepairCortex 未注册或修复提案不存在" };
      }
      return {
        ok: true,
        repairId: proposal.id,
        status: proposal.status,
        retryCount: proposal.retryCount,
        message: `已重置为 pending，正在重新触发修复闭环。`,
      };
    } catch (err) {
      return {
        ok: false,
        error: `brain.retry_repair 失败：${err instanceof Error ? err.message : String(err)}`,
      };
    }
  });
}
