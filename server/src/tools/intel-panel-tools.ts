// 工具：panel.query / panel.read —— Agent 按需查看情报面板。
//
// 用户问「邮箱里谁给我发了消息」「今天有什么要处理的」时，先看目录（一条一行），
// 需要时才读某条详情；不把整个面板注入上下文。时间在读取时渲染成「今天 10:32」，
// 存储里始终是绝对时刻。
import type { ChatCompletionTool } from "openai/resources/chat/completions";

import { resolveActorId } from "../agent/actor-id.js";
import type { IntelService } from "../proactivity/intel/intel-service.js";
import type { ToolRegistry } from "./tool-registry.js";

export const INTEL_PANEL_CHAT_TOOLS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "panel.query",
      description: [
        "查看情报面板目录（聚合消息的简要清单，按来源分组：邮件/微信等）。",
        "用户问「邮箱里谁给我发了消息」「有什么新消息」「今天要处理什么」时先调用它，",
        "每条只返回一行摘要与时间；需要正文再用 panel.read 读某一条。",
      ].join(" "),
      parameters: {
        type: "object",
        properties: {
          source: { type: "string", description: "只看某个来源（如 email；不传=全部）" },
          limit: { type: "number", description: "最多返回条数（默认 30，最大 100）" },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "panel.read",
      description: [
        "读取面板中某条消息的详情（panel.query 返回的 id）。",
        "已说出的消息只能读到当时说的那句话；未确认的高风险事项可传 ack=true 表示用户已回应。",
      ].join(" "),
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "panel.query 返回的条目 id" },
          ack: { type: "boolean", description: "用户已回应这条「已发未确认」事项时传 true" },
        },
        required: ["id"],
        additionalProperties: false,
      },
    },
  },
];

export function registerIntelPanelTools(toolRegistry: ToolRegistry, intel: IntelService): void {
  toolRegistry.register(
    "panel.query",
    async (input, context) => {
      const actorId = resolveActorId(context);
      const source = typeof input.source === "string" && input.source.trim() ? input.source.trim() : undefined;
      const limit = Math.max(1, Math.min(100, Number(input.limit ?? 30) || 30));
      const groups = intel.query(actorId, { ...(source ? { source } : {}), limit });
      const count = groups.reduce((n, g) => n + g.items.length, 0);
      return {
        ok: true,
        now: new Date().toISOString(),
        count,
        groups,
        ...(count === 0 ? { note: "面板里暂时没有待处理的消息" } : {}),
      };
    },
    {
      category: "proactivity",
      sideEffect: "read",
      riskLevel: "low",
      cachePolicy: { enabled: false },
    },
  );

  toolRegistry.register(
    "panel.read",
    async (input, context) => {
      const actorId = resolveActorId(context);
      const id = String(input.id ?? "").trim();
      if (!id) return { ok: false, error: "id 必填（来自 panel.query）" };
      const found = intel.read(actorId, id);
      if (!found) return { ok: false, error: "面板里没有这条（可能已说出或不属于当前用户）" };
      let acknowledged: boolean | undefined;
      if (input.ack === true) acknowledged = intel.acknowledge(id);
      return {
        ok: true,
        ...found,
        ...(acknowledged !== undefined ? { acknowledged } : {}),
      };
    },
    {
      category: "proactivity",
      sideEffect: "read",
      riskLevel: "low",
      cachePolicy: { enabled: false },
    },
  );
}
