import type { ChatCompletionTool } from "openai/resources/chat/completions";

function bridgeTools(deferredCount: number): ChatCompletionTool[] {
  const countHint =
    deferredCount > 0
      ? `当前有 ${deferredCount} 个非核心工具在延迟目录中。`
      : "当前无延迟加载工具。";

  return [
    {
      type: "function",
      function: {
        name: "tool_discover",
        description:
          `发现并加载延迟工具（合并 search+describe）。${countHint} 用法：① 仅 domain — 确定性拉取该能力域全部工具（见系统提示【能力域目录】）；② 仅 query — 语义检索；③ 仅 name — 直接拉取该工具 schema；④ query+name — 先搜索再校验 name。命中后工具 schema 会加载进本轮可见工具列表，下一轮直接调用即可。`,
        parameters: {
          type: "object",
          properties: {
            domain: { type: "string", description: "能力域名或能力包名（skill，如 ride/travel/local_life/web_ops），拉取该域/该能力包全部工具" },
            query: { type: "string", description: "自然语言或关键词" },
            name: { type: "string", description: "已知注册名时直接加载 schema，可省略 query" },
            limit: { type: "integer", description: "搜索条数上限，默认 5" },
            include_schema: {
              type: "boolean",
              description: "为 true 时为所有匹配附带完整 parameters（更占 token）",
            },
          },
          additionalProperties: false,
        },
      },
    },
  ];
}

/**
 * 核心库之外的工具通过桥接按需披露：唯一入口 `tool_discover`
 * （发现 + 加载 schema）→ 工具转正进本轮可见集 → 模型原生 tool_calls 调用。
 */
export function buildToolSearchBridgeTools(deferredCount: number): ChatCompletionTool[] {
  return bridgeTools(deferredCount);
}
