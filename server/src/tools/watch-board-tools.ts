// 统一盯梢工具（watch.track）—— 用户说「帮我盯着/跟踪 XXX」的单一入口。
// LLM 只需判断 kind：话题/消息/动态类 → topic（附 keywords）；商品价格类 → price（附 targetPrice）。
// 底层路由见 services/watch-board.ts（门面，不新增存储）。
import { resolveActorId } from "../agent/actor-id.js";
import { resolveBaseActorId } from "../agent/master-chat-session.js";
import type { ToolRegistry, ToolContext } from "./tool-registry.js";
import type { ChatCompletionTool } from "openai/resources/chat/completions";
import type { WatchBoard } from "../services/watch-board.js";

export function registerWatchBoardTools(registry: ToolRegistry, board: WatchBoard): void {
  registry.register("watch.track", async (input, context: ToolContext) => {
    const sessionId = resolveActorId(context);
    const actorId = resolveBaseActorId(sessionId);
    const action = String(input.action ?? "create").trim();

    if (action === "create") {
      const kind = String(input.kind ?? "").trim() === "price" ? "price" : "topic";
      try {
        const w = await board.create(actorId, {
          kind,
          target: String(input.target ?? "").trim(),
          ...(Array.isArray(input.keywords) ? { keywords: input.keywords.map((k) => String(k)) } : {}),
          ...(input.platform ? { platform: String(input.platform) } : {}),
          ...(input.targetPrice != null ? { targetPrice: Number(input.targetPrice) } : {}),
        });
        const detail =
          w.kind === "topic"
            ? `关键词 ${((w.detail.keywords as string[]) ?? []).join("、")}，相关消息一到就会主动告诉你`
            : `平台 ${w.detail.platform}，降到 ¥${w.detail.targetPrice} 就提醒你`;
        return {
          ok: true,
          summary: `盯梢已建档：「${w.target}」（${w.kind}）。${detail}。请向用户复述盯梢内容。`,
          watchId: w.watchId,
          kind: w.kind,
        };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    }

    if (action === "list") {
      const items = await board.list(actorId);
      return {
        ok: true,
        summary:
          items.length === 0
            ? "当前没有盯梢任务。"
            : `共 ${items.length} 个盯梢任务：${items
                .map((w) => `「${w.target}」(${w.kind}/${w.status === "active" ? "盯" : "停"})`)
                .join("；")}。请逐条转述。`,
        watches: items,
      };
    }

    if (action === "pause" || action === "resume") {
      const watchId = String(input.watchId ?? "").trim();
      try {
        const ok = await board.setStatus(actorId, watchId, action === "resume");
        return ok
          ? { ok: true, summary: action === "pause" ? "盯梢已暂停。" : "盯梢已恢复。" }
          : {
              ok: false,
              error:
                "该类型暂不支持暂停/恢复（价格监控只支持关闭后重建），可用 action=close 关闭再重开。",
            };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    }

    if (action === "close") {
      const watchId = String(input.watchId ?? "").trim();
      try {
        const ok = await board.close(actorId, watchId);
        return ok
          ? { ok: true, summary: "盯梢已关闭，不再打扰。" }
          : { ok: false, error: "没找到这条盯梢（可能已被删除），用 action=list 看看现存列表。" };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    }

    return { ok: false, error: `未知 action：${action}（支持 create/list/pause/resume/close）` };
  });
}

/** watch.track 工具的 LLM 声明（并入 builtin chat tools）。 */
export const WATCH_TRACK_CHAT_TOOLS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "watch.track",
      description: [
        "统一盯梢建档：用户想长期盯着某件事并在有进展时被主动告知。",
        "两类：kind=topic 盯话题/消息/通知/动态（如「盯着学校官网有没有保研通知」「帮我盯着XX的回归消息」），需从用户原话提炼 2-6 个 keywords；",
        "kind=price 盯商品降价（如「这个耳机降到 800 以内叫我」），需 platform 与 targetPrice（用户没给目标价先问）。",
        "action=list 查看；pause/resume 暂停恢复；close 关闭。",
      ].join(" "),
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["create", "list", "pause", "resume", "close"],
            description: "操作（缺省 create）",
          },
          kind: {
            type: "string",
            enum: ["topic", "price"],
            description: "盯梢类型：topic=话题/消息类；price=商品降价类",
          },
          target: {
            type: "string",
            description: "盯什么（人话短语，如「保研通知」「索尼 WH-1000XM6」）",
          },
          keywords: {
            type: "array",
            items: { type: "string" },
            description: "kind=topic 必填：2-6 个会出现在相关消息里的关键词（每词 2-8 字）",
          },
          platform: {
            type: "string",
            description: "kind=price 必填：电商平台（taobao/jd/pdd…）",
          },
          targetPrice: {
            type: "number",
            description: "kind=price 必填：降价目标（CNY）",
          },
          watchId: {
            type: "string",
            description: "pause/resume/close 必填：list 返回的 watchId",
          },
        },
        required: ["action"],
        additionalProperties: false,
      },
    },
  },
];
