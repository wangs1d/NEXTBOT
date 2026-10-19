import type { ToolIntentRule } from "../../tool-search/intent-metadata.js";

/**
 * plan.* 的 BM25 召回声学。
 *
 * 与 goal.plan.* 的 negativeAliases 相互排斥：长期目标走 goal.plan.*，
 * 本轮/本会话多步走 plan.*。两边都写清否定项，避免同一个「拆解」词
 * 把模型推到错误的表上（goal 会带来每日预算和后台自推进，语义重得多）。
 */
export const TASK_PLAN_INTENT_RULES: ToolIntentRule[] = [
  {
    prefix: "plan.",
    metadata: {
      aliases: [
        "plan", "steps", "break down", "todo", "task steps", "current task",
        "步骤", "步骤表", "拆一下", "分几步", "下一步", "做到哪了", "进行到哪",
        "改步骤", "重排步骤", "任务进度",
      ],
      negativeAliases: [
        "long term goal", "monthly plan", "milestone", "长期目标", "三个月", "下个月计划",
        "里程碑", "长期计划",
      ],
      examples: [
        "订下周去三亚的行程，酒店和接机一起排了",
        "帮我比一下这三款显示器，选一个下单",
        "这个任务分几步做",
        "做到哪一步了",
        "先不订酒店了，改一下后面的步骤",
      ],
      negativeExamples: [
        "我想三个月内搬到东站附近，帮我规划一下",
        "我的备考计划进展怎么样了",
      ],
    },
  },
];

export const TASK_PLAN_CATEGORY_MAPPING: { name: string; keywords: string[] } = {
  name: "task_plan",
  keywords: [
    "plan", "steps", "todo", "breakdown",
    "步骤", "拆解", "分步", "下一步", "任务进度", "做到哪",
  ],
};
