import type { ChatCompletionTool } from "openai/resources/chat/completions";

import type { ToolRegistry } from "./tool-registry.js";

/**
 * suggest_next_steps —— 接续建议的结构化出口（2026-11-17 根修）。
 *
 * 背景：接续建议此前靠模型在正文末尾手写 `[NEXT_UP_START] … [NEXT_UP_END]`
 * 文本协议。生成侧没有强约束，模型会漏方括号、漏下划线、自造前缀；两端正则
 * 只能不断枚举变体，于是反复漏标记到气泡（09-22 / 10-24 / 11-02 / 11-12 /
 * 11-17 截图事故同一根因）。这里改成工具调用：参数由 API 的 function calling
 * 解析，服务端拿到的是结构化数组，正文里不再出现任何标记。
 *
 * 旧文本协议继续保留解析兜底（兼容历史会话与模型自发沿用），但不再是生成侧
 * 的推荐路径。
 */

export const SUGGEST_NEXT_STEPS_TOOL_NAME = "suggest_next_steps";

const MAX_ITEMS = 3;
const MAX_ITEM_LENGTH = 40;

export const SUGGEST_NEXT_STEPS_TOOL_DEFINITION: ChatCompletionTool = {
  type: "function",
  function: {
    name: SUGGEST_NEXT_STEPS_TOOL_NAME,
    description:
      "本轮回答完成、且用户很可能有自然的下一步时，提交 1-3 条可点击的接续建议。" +
      "请在写最终回答之前调用；调用后不要把建议写进正文，也不要向用户提及本工具，" +
      "正文里禁止输出任何 NEXT_UP 标记。纯闲聊或没有自然下一步时不要调用。每轮最多一次。",
    parameters: {
      type: "object",
      properties: {
        items: {
          type: "array",
          description:
            "1-3 条接续建议。用用户口吻写成可直接执行的短句（如「看看深圳这几天的交通管制」），" +
            "每条不超过 20 个字，不要编号、不要引号、不要标点结尾。",
          items: { type: "string" },
          minItems: 1,
          maxItems: MAX_ITEMS,
        },
      },
      required: ["items"],
    },
  },
};

/** 规范化模型提交的建议：去编号/引号/空白，去重，限长限量。 */
export function normalizeNextStepItems(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const cleaned = item
      .trim()
      .replace(/^\s*(?:[-*•]|\d+[.、)])\s*/, "")
      .replace(/^["'「『“”‘’]+|["'」』“”‘’]+$/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/[。！!？?；;，,]+$/g, "")
      .trim();
    if (!cleaned || cleaned.length > MAX_ITEM_LENGTH) continue;
    if (out.includes(cleaned)) continue;
    out.push(cleaned);
    if (out.length >= MAX_ITEMS) break;
  }
  return out;
}

/** 从工具结果里读回建议（供各调用面统一取值）。 */
export function readSuggestedNextSteps(result: unknown): string[] {
  if (!result || typeof result !== "object") return [];
  const items = (result as Record<string, unknown>).items;
  return normalizeNextStepItems(items);
}

export function registerSuggestNextStepsTool(registry: ToolRegistry): void {
  registry.register(SUGGEST_NEXT_STEPS_TOOL_NAME, async (input) => {
    const items = normalizeNextStepItems(input.items);
    if (items.length === 0) {
      return {
        ok: false,
        error: "EMPTY_ITEMS",
        hint:
          `items 需要 1-${MAX_ITEMS} 条不超过 ${MAX_ITEM_LENGTH} 字的建议短句；` +
          "若没有自然下一步就不要调用本工具。",
      };
    }
    return {
      ok: true,
      items,
      summary: `已记录 ${items.length} 条接续建议（内部记账，界面会渲染；无需向用户复述，继续写正文）`,
    };
  });
}
