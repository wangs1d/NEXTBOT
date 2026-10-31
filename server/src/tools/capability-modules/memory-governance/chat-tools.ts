import type { ChatCompletionTool } from "openai/resources/chat/completions";

/**
 * 记忆治理能力 —— ChatCompletionTool schema。
 *
 * memory.forget：用户侧「定向遗忘」统一入口（对标 Muse forget 指令）。
 * 幂等、按关键词联动清除兴趣池/降价监控/承诺/计划/长期记忆五处可见台账。
 * activity.timeline：行为审计只读视图（对标 Muse 全量审计轨迹）。
 * memory.recall：事件记忆（L0）检索口——按时间/对象/结果回忆真实做过的事。
 */
export const MEMORY_GOVERNANCE_CHAT_TOOLS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "memory.forget",
      description:
        "定向遗忘：用户明确要求忘掉/删除/不再关注某个具体人或事时调用" +
        "（如「把前公司的事忘了」「别再帮我盯着 XX 的价格了」「删除关于 XX 的记忆」）。" +
        "联动清除：兴趣关注、降价监控、相关承诺、相关计划、长期记忆条目（按关键词匹配，逐项报告清了什么）。" +
        "约束：仅在用户点名具体对象时调用，且调用前向用户复述要清的范围；" +
        "用户只是随口说「我忘了」/「忘了」不是遗忘指令，不要调用。",
      parameters: {
        type: "object",
        properties: {
          target: {
            type: "string",
            description: "要遗忘的对象关键词（人名/商品名/事项，2 字以上，如「前公司」「戴森吹风机」）",
          },
          scope: {
            type: "string",
            enum: ["auto", "interest", "watch", "plan", "memory"],
            description:
              "清理范围：auto=全部台账联动（默认）；" +
              "interest=仅兴趣关注；watch=仅降价监控；plan=仅计划/盯梢目标；memory=仅长期记忆",
          },
          reason: { type: "string", description: "可选：用户给的原因（记录用）" },
        },
        required: ["target"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "activity.timeline",
      description:
        "行为审计时间线：你替用户办过的事、正在办/在盯的事、等用户确认的事，按时间倒序。" +
        "用户问「你最近都帮我干了什么」「你在忙什么」「有什么在等我确认」「你都做了哪些事」时调用，" +
        "以返回的真实台账回答，不要凭印象编造。",
      parameters: {
        type: "object",
        properties: {
          limit: { type: "number", description: "可选返回条数上限（默认 30，最大 60）" },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "memory.recall",
      description:
        "回忆你替用户真实做过的事：按时间、对象、结果查历史事件（比过什么价、查过什么天气、" +
        "建过什么日程、办过什么任务、搜过什么）。\n" +
        "适用：用户问「上次/之前/什么时候/那天/上个月」+ 做过什么、结果如何；" +
        "或需要确认自己是否真的做过某件事时。\n" +
        "不要凭印象编造经历——查不到就如实说没查到。回答时直接说结果，" +
        "不要提及检索、数据库或任何内部查询过程。",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "关键词（商品名/地点/主题，如「小米18 Pro」「兴义」「保险」）；可省略，纯按时间/类型过滤",
          },
          days: {
            type: "number",
            description: "回看天数（默认 30，最大 3650）；给了 from 时忽略",
          },
          from: { type: "string", description: "起始时间，YYYY-MM-DD 或 ISO 时间" },
          to: { type: "string", description: "结束时间，YYYY-MM-DD 或 ISO 时间（默认现在）" },
          kinds: {
            type: "array",
            items: {
              type: "string",
              enum: [
                "price_compare",
                "weather_query",
                "schedule_write",
                "schedule_query",
                "travel_plan",
                "travel_query",
                "web_search",
                "order",
                "task_write",
                "media",
                "chat_turn",
              ],
            },
            description: "事件类型过滤（可多选）；省略则所有类型",
          },
          status: {
            type: "string",
            enum: ["ok", "empty", "failed", "partial", "invalid"],
            description: "结果状态过滤（如只查没办成的用 failed/empty）",
          },
          limit: { type: "number", description: "返回条数上限（默认 20，最大 50）" },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "profile.update",
      description:
        "更新你的用户画像档案（说话算话的「记」）：用户明确表达关于自身的稳定事实并期待你记住时调用" +
        "（如「记一下我叫 X」「我喜欢 Y」「我换工作了，现在做 Z」「我猫不吃鱼，记着」）。" +
        "这是后台记账动作，静默执行：回复里自然带过（如「记上了」），不复述档案字段、分区或写入过程。" +
        "规则：只记稳定事实（身份/关系/职业/长期偏好/宠物/重要日期），一次性情绪和临时安排不记；" +
        "用户纠正旧信息时用 UPDATE 并给 match 定位旧行，别 ADD 出重复条目；" +
        "敏感类目（疾病病史/心理健康/恋爱婚姻矛盾/收入负债/身份证件）必须先在对话里向用户复述并得到明确同意，" +
        "才能带 confirmed=true 调用；未确认就调用会被拒绝。",
      parameters: {
        type: "object",
        properties: {
          op: {
            type: "string",
            enum: ["ADD", "UPDATE", "DELETE"],
            description: "ADD=新增一条；UPDATE=改写旧行（给 match 定位）；DELETE=删除旧行（用户要求忘掉某条画像时）",
          },
          section: {
            type: "string",
            enum: ["basic", "interest", "communication", "note"],
            description: "目标分区：basic=基本信息（称呼/所在地/职业/重要日期）；interest=兴趣与习惯；communication=沟通偏好；note=备注（宠物/关系等其他长期事项）",
          },
          line: {
            type: "string",
            description: "ADD/UPDATE 的新内容，一行，不带「- 」前缀；字段式写法更稳（如「称呼：林晚秋」「妈妈的生日：5月20日」）",
          },
          match: {
            type: "string",
            description: "UPDATE/DELETE 定位旧行的关键词（旧行里出现过的词，如「UI设计师」）",
          },
          confirmed: {
            type: "boolean",
            description: "敏感类目（健康/婚恋矛盾/财务/证件）必须在对话中获得用户明确同意后才置 true；普通事实直接省略",
          },
        },
        required: ["op", "section"],
        additionalProperties: false,
      },
    },
  },
];
