import type { ChatCompletionTool } from "openai/resources/chat/completions";

/**
 * 计划推进能力 —— ChatCompletionTool schema（goal.plan.*，deferred/BM25 召回）。
 *
 * 对标 Muse 大目标模式：长期目标拆步 → 逐步派后台任务推进 → 动态重排 →
 * 完成摘要主动投递。外部副作用步骤（下单/发送/支付类）不自动执行，
 * 推进到该步会转「等你确认」，用户点头后 confirmExternal=true 放行。
 */
export const GOAL_PLANNING_CHAT_TOOLS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "goal.plan.create",
      description:
        "创建计划推进型目标：用户表达一个需要多步、跨时间推进的长期目标时调用" +
        "（如「我想三个月内搬到东站附近」「帮我准备转岗答辩」「这学期把雅思刷到 7」）。" +
        "把目标拆成 2-8 个一句话主干步骤；创建后我会逐步派后台任务推进，" +
        "完成一步自动推进下一步；涉及外部操作的步骤会先征求用户同意。" +
        "一次性小任务（今天订个蛋糕）不要用本工具，直接 task.dispatch。",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "目标一句话（如「三个月内搬到东站附近」）" },
          steps: {
            type: "array",
            items: { type: "string" },
            description:
              "有序步骤列表，每步一句完整可执行的话。**不传则按同类目标模板自动生成**" +
              "（出行/搬家/备考/装修/求职已有模板，省一次拆解）；目标形态明显不同时才自己拆",
          },
          successCriteria: {
            type: "string",
            description:
              "达成判据一句话（如「日期、交通、住宿都定下来且在预算内」）。有它验收才严格；不传则用模板自带的",
          },
          note: { type: "string", description: "可选补充背景（预算/偏好/期限等）" },
        },
        required: ["title"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "goal.plan.list",
      description: "查看用户当前的推进型计划列表与各计划进度（用户问「我有哪些计划/目标」「搬家计划怎么样了」时调用）。",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "goal.plan.advance",
      description:
        "推进计划：把下一步派到后台执行。用户说「继续推进」「下一步」「办吧」时调用；" +
        "若上一次推进停在某步「等你确认」（外部操作类），用户明确同意后须带 confirmExternal=true 再调一次。",
      parameters: {
        type: "object",
        properties: {
          goalId: { type: "string", description: "计划 id（goal.plan.list 获取）" },
          confirmExternal: {
            type: "boolean",
            description: "用户明确同意执行外部操作步骤（下单/发送/支付类）时置 true；仅凭「继续」不要置 true",
          },
        },
        required: ["goalId"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "goal.plan.step",
      description:
        "更新单个步骤状态：某步用户说已自己办完（done）/办不成了（failed）/不用了（skipped）时调用。" +
        "done/skipped 后自动推进下一步。",
      parameters: {
        type: "object",
        properties: {
          goalId: { type: "string", description: "计划 id" },
          stepId: { type: "string", description: "步骤 id（goal.plan.list 获取）" },
          status: { type: "string", enum: ["done", "failed", "skipped"], description: "新状态" },
          note: { type: "string", description: "可选结果备注（如已完成方式/失败原因）" },
        },
        required: ["goalId", "stepId", "status"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "goal.plan.replan",
      description:
        "动态重排计划：情况有变（出差/生病/预算变化/用户改主意）时替换尚未完成的步骤，" +
        "已完成步骤保留存档。用户说「计划变了/改一下计划/先不搬家了改为明年」时调用。",
      parameters: {
        type: "object",
        properties: {
          goalId: { type: "string", description: "计划 id" },
          steps: { type: "array", items: { type: "string" }, description: "新的待办步骤列表（整体替换剩余步骤）" },
          reason: { type: "string", description: "重排原因（会记入计划档案）" },
        },
        required: ["goalId", "steps"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "goal.plan.abandon",
      description: "放弃整个计划（用户明确说不要了这个目标/不推进了时调用），需给出原因。",
      parameters: {
        type: "object",
        properties: {
          goalId: { type: "string", description: "计划 id" },
          reason: { type: "string", description: "放弃原因" },
        },
        required: ["goalId", "reason"],
        additionalProperties: false,
      },
    },
  },
];
