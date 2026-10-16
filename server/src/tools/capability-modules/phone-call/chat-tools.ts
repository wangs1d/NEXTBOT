import type { ChatCompletionTool } from "openai/resources/chat/completions";

/**
 * 电话代办能力 —— ChatCompletionTool schema（`phone_call.*` 工具族）。
 *
 * 语义：agent 代用户向「第三方真人」发起真实 PSTN 通话（预约/确认/咨询等）。
 * P0 为脚本托管：agent 负责拨前准备（要素/话术/确认卡）与挂断后结果回填，
 * 通话本身由用户手机拨出、用户亲自进行；P1 起在同一状态机上叠加实时语音。
 *
 * ── 路由边界（写进每个工具 description，防 LLM 误选，详见 docs/phone-call-architecture.md §〇）──
 *   - 对端是用户本人（站内 App 内来电）→ 虚拟电话 `phone.call_user`（Agent 之间不打电话，走 world.link.send_message 文本）
 *   - 只需打开拨号盘、用户自己讲、无需确认卡与回填 → `phone.dial`
 *   - 对端是外部真实号码、需要拨前确认门 + 拨后结果回填闭环 → `phone_call.*`（本族）
 *
 * 走 deferred（BM25 索引），不进 CORE_TOOL_LIBRARY。
 */
export const PHONE_CALL_CHAT_TOOLS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "phone_call.prepare",
      description:
        "电话代办第一步：为「拨打第三方真实电话」生成拨号确认卡（校验号码 + 频控 + 静默时段 + 确认门）。\n" +
        "适用：帮用户打电话给商户/机构/真人完成预约、订座、确认订单、咨询等。\n" +
        "路由边界：对端是用户本人（站内 App 来电）用虚拟电话 phone.call_user，Agent 之间不打电话；" +
        "只是打开拨号盘由用户自己讲用 phone.dial；不要用本工具给用户自己的 agent 打电话。\n" +
        "返回确认卡 cardMarker：必须【原样】放在回复最前面，等待用户点击「确认拨打」。" +
        "用户未确认前严禁调用 phone_call.start。这是真实电话：对方是真人、将产生话费，须向用户如实说明。",
      parameters: {
        type: "object",
        properties: {
          number: {
            type: "string",
            description: "被叫真实号码（手机号/固话，支持 +86 等国际区号）。紧急号码（110/119/120 等）永拒；6 位纯数字是站内虚拟号，将被拒绝。",
          },
          contactName: { type: "string", description: "对方名称（如「海底捞XX店」「王医生」），用于确认卡与手机端确认弹窗展示。" },
          goal: { type: "string", description: "一句话通话目标（如「预订周六晚 7 点 4 人桌」）。" },
          facts: {
            type: "object",
            description: "已知要素键值对（人数/日期时间/联系人姓名/订单号/特殊需求等），将展示在确认卡上供用户核对。",
            additionalProperties: true,
          },
          mustAsk: { type: "array", items: { type: "string" }, description: "必须在电话里问清的事项清单。" },
          fallback: { type: "string", description: "对方无法满足首选诉求时的底线方案（如「时间不行就订周日」）。" },
          script: { type: "string", description: "给用户的话术要点（P0 通话由用户亲自进行）。" },
          maxDurationSec: { type: "integer", description: "单通时长上限（秒），默认 300。" },
        },
        required: ["number", "goal"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "phone_call.start",
      description:
        "电话代办第二步：在用户已点击确认卡的「确认拨打」后，经用户手机真实拨出（手机端还有一次全屏二次确认）。\n" +
        "硬约束：用户未在确认卡上确认（或未明确文本确认）时本工具一律拒绝——不得绕过、不得代用户确认。\n" +
        "立即返回拨出状态，不会阻塞等待通话结束。拨出后提示用户通话结束后告知结果，再调用 phone_call.finish 回填。\n" +
        "通话期间不要轮询本工具族等待挂断（P0 无通话内事件）。",
      parameters: {
        type: "object",
        properties: {
          callId: { type: "string", description: "phone_call.prepare 返回的会话 id。" },
        },
        required: ["callId"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "phone_call.status",
      description:
        "查询一个电话代办会话的当前状态：状态机位置、确认情况、拨出回执、已回填的结果等。\n" +
        "用途：用户问「电话打得怎么样了」/继续被打断的预约任务时找回上下文。",
      parameters: {
        type: "object",
        properties: {
          callId: { type: "string", description: "会话 id。" },
        },
        required: ["callId"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "phone_call.finish",
      description:
        "电话代办第三步：通话结束（用户挂断）后回填结构化结果。会话归档并向用户收件箱投递必达回执。\n" +
        "在用户告知通话结果（如「订到了，晚上7点，预约号A1024」/「没人接」）后调用；" +
        "含预约时间时结果摘要会建议用户写入日程。返回结果摘要供你组织结果卡。",
      parameters: {
        type: "object",
        properties: {
          callId: { type: "string", description: "会话 id。" },
          outcome: {
            type: "string",
            enum: ["booked", "confirmed", "info_got", "callback_later", "no_answer", "failed", "other"],
            description: "通话结果：booked=预约成功；confirmed=对方确认既有安排；info_got=拿到信息；callback_later=稍后回电；no_answer=无人接听；failed=未能达成；other=其他。",
          },
          detail: { type: "string", description: "结果详情（outcome=other 时必填）。" },
          appointmentTime: { type: "string", description: "预约/约定时间（如「2026-09-20 19:00」），有则必填。" },
          bookingRef: { type: "string", description: "预约号/取件码/凭据。" },
          followUps: { type: "array", items: { type: "string" }, description: "待办跟进项（如「提前 2 小时确认」）。" },
        },
        required: ["callId", "outcome"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "phone_call.list",
      description: "列出当前用户最近的电话代办会话（状态/结果，号码脱敏）。用户问「之前帮你打的电话怎么样了」时使用。",
      parameters: {
        type: "object",
        properties: {
          limit: { type: "integer", description: "返回条数上限，默认 10。" },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "phone_call.cancel",
      description: "取消一个尚未拨出/拨出中的电话代办会话（用户说「别打了」时使用）。已 summarized/failed 的会话无需取消。",
      parameters: {
        type: "object",
        properties: {
          callId: { type: "string", description: "会话 id。" },
          reason: { type: "string", description: "取消原因（审计用）。" },
        },
        required: ["callId"],
        additionalProperties: false,
      },
    },
  },
];
