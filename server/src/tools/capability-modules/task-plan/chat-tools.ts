import type { ChatCompletionTool } from "openai/resources/chat/completions";

/**
 * 会话级任务计划 —— ChatCompletionTool schema（plan.*，deferred/BM25 召回）。
 *
 * 与 goal.plan.*（长期目标）的分工写在描述里，避免模型选错：
 *  - 跨天 / 有达成判据 / 要后台推进 → goal.plan.create
 *  - 本轮或本会话内多步、几轮就能办完 → plan.write
 *
 * 这三个工具是「执行中的写操作」，不是前置规划请求：不写也不影响执行，
 * 写了就能被用户看见、可修订、跨轮续跑。
 */
export const TASK_PLAN_CHAT_TOOLS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "plan.write",
      description:
        "把当前这项多步任务拆成 2-8 步记下来（覆盖本会话旧计划）。" +
        "用于：一件事需要连续几步、跨几轮才能办完（如「订下周去三亚的行程，酒店和接机一起排了」）。" +
        "写完步骤会直接显示给用户，后续每完成一步用 plan.set_status 更新。" +
        "**steps 可以不传**——出行/搬家/备考/装修/求职会按模板自动生成，比你现拆更稳更快。" +
        "闲聊、单点查询、一次工具调用能办完的事不要用本工具；" +
        "要跨天/跨月的长期目标把 scope 设为 goal（会带每日预算和自主推进）。",
      parameters: {
        type: "object",
        properties: {
          goal: { type: "string", description: "任务一句话（如「订下周去三亚的行程」）" },
          scope: {
            type: "string",
            enum: ["session", "goal"],
            description:
              "session=本会话内几步办完（默认）；goal=跨会话长期目标（三个月内搬家、备考到考完）",
          },
          steps: {
            type: "array",
            items: { type: "string" },
            description: "有序步骤，每步一句可执行的话；不传则按同类目标模板生成",
          },
          successCriteria: {
            type: "string",
            description: "达成判据一句话（scope=goal 时推荐给；不传则用模板自带的）",
          },
          mode: {
            type: "string",
            enum: ["new", "replace"],
            description:
              "new（默认）：已有未完成计划时不覆盖，会报错提示用 plan.replan；" +
              "replace：用户明确要「这事重新规划」时才用，会清空现有步骤",
          },
        },
        required: ["goal"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "plan.set_status",
      description:
        "更新步骤状态。开始做某步时置 running，办完置 done（可带结果），办不成置 failed（必须带原因）。" +
        "**需要用户自己动手的步骤（点外卖/购物付款/登录授权/到店取货/给人打电话）置 awaiting_confirm，" +
        "并必须带 handoff.instruction 说清「要他在哪儿做什么」**——系统会把外部动作类工具收起来、" +
        "把这一步显给用户点，用户做完后自动继续。不要在等待期间自己下单/支付/发送（会被拒绝）。" +
        "用户明确不做了，置 skipped 再继续后面的步骤。",
      parameters: {
        type: "object",
        properties: {
          stepId: { type: "string", description: "步骤 id（plan.read 获取，如 s1）" },
          status: {
            type: "string",
            enum: ["pending", "running", "done", "failed", "skipped", "awaiting_confirm"],
          },
          note: { type: "string", description: "结果摘要 / 失败原因 / 跳过理由" },
          handoff: {
            type: "object",
            description: "status=awaiting_confirm 时必填：把执行权交给用户的交接说明",
            properties: {
              instruction: {
                type: "string",
                description: "一句人话：要用户在哪儿做什么（如「在美团点一份麻辣烫送到公司」）",
              },
              actions: {
                type: "array",
                description: "给用户点的按钮（可选）",
                items: {
                  type: "object",
                  properties: {
                    id: { type: "string" },
                    label: { type: "string", description: "按钮文案（如「打开美团」「我已完成」）" },
                    url: { type: "string", description: "深链（可选）" },
                  },
                  required: ["label"],
                },
              },
              checkMode: {
                type: "string",
                enum: ["user_confirm", "probe"],
                description:
                  "user_confirm（默认）：用户点「我已完成」；probe：由系统查客观事实（订单/日历/文件）确认",
              },
              probe: {
                type: "object",
                description: "checkMode=probe 时的确定性探测",
                properties: {
                  tool: { type: "string", description: "查询类工具名（如 order.list）" },
                  args: { type: "object" },
                  expect: { type: "string", description: "判定条件一句话" },
                },
                required: ["tool"],
              },
              idempotencyKey: {
                type: "string",
                description: "外部动作幂等键（同一动作续跑不允许第二次真实执行）",
              },
            },
            required: ["instruction"],
          },
        },
        required: ["stepId", "status"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "plan.replan",
      description:
        "情况变了要改步骤时调用：只重排还没完成的步骤，已完成/失败/进行中的保留存档。" +
        "用户改主意、发现原计划走不通、有新信息时用。",
      parameters: {
        type: "object",
        properties: {
          steps: {
            type: "array",
            items: { type: "string" },
            description: "新的待办步骤列表（不含已完成的）",
          },
          reason: { type: "string", description: "为什么改（一句话）" },
        },
        required: ["steps"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "plan.read",
      description: "读当前会话的任务计划与各步状态（用户问「进行到哪了」「下一步是什么」时调用）。",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
];
