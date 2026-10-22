import type { ChatCompletionTool } from "openai/resources/chat/completions";

import { resolveActorId } from "../agent/actor-id.js";
import type { ToolRegistry } from "./tool-registry.js";

/**
 * task.dispatch —— 前后台架构的前台派任务原语（2026-09-05）。
 *
 * 设计契约：
 *   - 前台（对话面）只保留两个动作：search_web（必须立刻知道答案的快查）和
 *     本工具（把要真正「办」的事派到后台）。dispatch 立即返回 taskId，前台继续
 *     与用户对话；后台完成后结果以独立消息回灌对话流（agent-core 投递）。
 *   - 这是「前台永不阻塞、后台真办事」的结构保证：写动作不再依赖路由判对，
 *     前台模型自己决定派发；出口诚实闸（commitment-gate）兜底漏派。
 *   - 工具本体零副作用：只调 launch 回调登记任务并立即返回，不等待执行。
 *
 * launch 由 bootstrap 在 AgentCore 创建后晚绑定注入（agentCore.dispatchBackgroundTask）。
 */

export type TaskDispatchInput = {
  actorId: string;
  sessionId?: string;
  chatUserMessageId?: string;
  goal: string;
  note?: string;
};

export type TaskDispatchLauncher = (input: TaskDispatchInput) => string | null;

/** 注入给前台对话的工具 schema（与工具实现同文件，防漂移）。 */
export const TASK_DISPATCH_TOOL_DEFINITION: ChatCompletionTool = {
  type: "function",
  function: {
    name: "task.dispatch",
    description:
      "把**确实需要后台长时间跑**的复杂任务派出去：多步串联、需要轮询等待外部状态、" +
      "用户明确要求「慢慢办、办完告诉我」的代办事项。\n" +
      "只在一种情况下用它：这一次调用拿不到结果，而且用户能接受稍后才拿到。\n" +
      "不要用于：一次工具调用就能当场回答的问题（新闻、价格、比分、天气、位置、" +
      "日程查询、找张图）——直接调对应的专用工具，本轮就把答案给用户。" +
      "不要用于：任何有专用工具可用的单步动作。" +
      "不要用于：只是为了显得在办事而把活转手。\n" +
      "注意：调用后任务只是排进队列，用户要的答案此刻并不存在，" +
      "不要把它当成已经办完。",
    parameters: {
      type: "object",
      properties: {
        goal: {
          type: "string",
          description:
            "用一句完整、自包含的话描述要达成的结果（后台执行者看不到当前聊天上下文之外的补充说明时，靠这句话理解任务）",
        },
        note: {
          type: "string",
          description: "可选补充信息：时间、对象、偏好等执行时需要的细节",
        },
      },
      required: ["goal"],
    },
  },
};

export function registerTaskDispatchTool(
  registry: ToolRegistry,
  deps: {
    /** 晚绑定：bootstrap 在 AgentCore 就绪后注入；未注入时返回拒绝结果 */
    launch: TaskDispatchLauncher;
  },
): void {
  registry.register("task.dispatch", async (input, context) => {
    const actorId = resolveActorId(context);
    const goal = String(input.goal ?? input.task ?? "").trim();
    if (!goal) {
      return { ok: false, error: "缺少 goal（用一句话描述要办成的事）" };
    }
    if (goal.length > 4000) {
      return { ok: false, error: "goal 过长（上限 4000 字符），请提炼成一句话任务" };
    }
    const note = typeof input.note === "string" ? input.note.trim() : undefined;

    const taskId = deps.launch({
      actorId,
      ...(context.sessionId ? { sessionId: context.sessionId } : {}),
      ...(context.chatUserMessageId ? { chatUserMessageId: context.chatUserMessageId } : {}),
      goal,
      ...(note ? { note } : {}),
    });
    if (!taskId) {
      return {
        ok: false,
        error:
          "后台任务通道不可用（未就绪或本会话 token 预算已达上限），" +
          "请如实告知用户暂时无法代办，不要编造执行结果",
      };
    }

    return {
      ok: true,
      // 完成语义标记（2026-10-22）：派发只代表已排队，**不是完成**。
      // 出口闸按 produces 判定「本轮有没有拿到能回答用户的内容」，不看措辞；
      // queued 的轮次不会因为 ok:true 被误判为已办完。
      produces: "queued",
      taskId,
      summary:
        "任务已排进后台队列，此刻还没有结果内容。用户要的答案要等任务执行完才会出现。",
    };
  });
}
