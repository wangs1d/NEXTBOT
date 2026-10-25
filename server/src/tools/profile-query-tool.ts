// 画像按类查询工具（profile.query）——画像 v2 P2：agent 的主动取用口。
// "用户作息是什么/他咖啡喝什么"这类需要画像某个面的时刻，LLM 按类查询，
// 只取该类的确定性字段行，不全量翻记忆。只读，零副作用。
import { resolveActorId } from "../agent/actor-id.js";
import { resolveBaseActorId } from "../agent/master-chat-session.js";
import type { ToolRegistry, ToolContext } from "./tool-registry.js";
import type { ChatCompletionTool } from "openai/resources/chat/completions";
import {
  getProfileRouter,
} from "../brain/profile-router.js";
import {
  PROFILE_TAGS,
  TAG_LABELS,
  type ProfileTag,
} from "../agentic-memory/field-taxonomy.js";

const QUERYABLE_TAGS = PROFILE_TAGS.filter((t) => t !== "note") as readonly ProfileTag[];

export function registerProfileQueryTool(registry: ToolRegistry): void {
  registry.register("profile.query", async (input, context: ToolContext) => {
    const sessionId = resolveActorId(context);
    const actorId = resolveBaseActorId(sessionId);
    const router = getProfileRouter();
    if (!router) return { ok: false, error: "画像路由未装配（当前环境无画像存储）" };
    const tag = String(input.tag ?? "").trim() as ProfileTag;
    if (!QUERYABLE_TAGS.includes(tag)) {
      return { ok: false, error: `tag 必须是：${QUERYABLE_TAGS.join("/")}` };
    }
    const keyword = String(input.keyword ?? "").trim();
    const rows = router.query(actorId, tag, { limit: 20 });
    const matched =
      keyword.length > 0 ? rows.filter((r) => r.field.includes(keyword) || r.value.includes(keyword)) : rows;
    if (matched.length === 0) {
      return {
        ok: true,
        summary: `画像里暂时没有「${TAG_LABELS[tag]}」类的记录。不要编造——如实告知还不了解这一面。`,
        facts: [],
      };
    }
    return {
      ok: true,
      summary:
        `「${TAG_LABELS[tag]}」类画像 ${matched.length} 条：` +
        matched.map((r) => `${r.field}=${r.value}`).join("；") +
        "。回答时自然运用，不要暴露记忆系统存在。",
      facts: matched,
    };
  });
}

export const PROFILE_QUERY_CHAT_TOOLS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "profile.query",
      description: [
        "按类查询用户画像（只读）：需要了解用户某一面的确定信息时调用，如作息（rhythm）、"
          + "偏好（preference）、禁忌（aversion）、关系（relations）、身份（identity）、消费（spending）。",
        "返回该类的字段行（field=value）。画像里没有就如实说不了解，禁止编造。",
      ].join(" "),
      parameters: {
        type: "object",
        properties: {
          tag: {
            type: "string",
            enum: QUERYABLE_TAGS as unknown as string[],
            description: "要查的画像类目",
          },
          keyword: {
            type: "string",
            description: "可选：字段/值包含的关键词（如查 rhythm 类时 keyword=出门）",
          },
        },
        required: ["tag"],
        additionalProperties: false,
      },
    },
  },
];
