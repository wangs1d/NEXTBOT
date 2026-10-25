import type { ChatCompletionTool } from "openai/resources/chat/completions";

/**
 * memory.invalidate 工具的 LLM 声明。
 * 原在 commitment-tools.ts 内定义；承诺板下线后独立成文件继续服务
 * 记忆溯源作废（来源级/断言级级联见 memory.invalidate handler）。
 */
export const MEMORY_INVALIDATION_CHAT_TOOLS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "memory.invalidate",
      description: [
        "作废一条记忆的来源（用户撤回消息/否认说过）或单条断言（被证伪）。",
        "级联清理：语义账本标记 void、Mem0 记忆删除、认知图节点标记 overridden。",
        "用户说「我从来没说过这话」「那条信息是错的，删掉」时调用。",
      ].join(" "),
      parameters: {
        type: "object",
        properties: {
          sourceRef: {
            type: "string",
            description: "来源引用（如 chat:turn-123）；与 claimId 二选一，来源级作废优先",
          },
          claimId: { type: "string", description: "账本断言 id（断言级作废）" },
          reason: { type: "string", description: "作废原因" },
        },
        required: ["reason"],
        additionalProperties: false,
      },
    },
  },
];
