/**
 * 敏感动作分级（2026-09-24，对标 Muse「敏感操作前确认 + Shopify 默认 handoff」的本地定轴）。
 *
 * 三档：
 *   read          只读（搜索/查询/盯梢），零外部副作用，可自主执行
 *   act_internal  改内部状态（建日程/记账/写笔记），可撤销、不触外部世界，可自主执行
 *   act_external  触达外部世界（下单/支付/发消息/外呼/代改外部账户）——默认 handoff：
 *                 自主推进（如计划步骤自动跑）遇到这类动作必须先过用户确认
 *
 * 两个入口：
 *   - classifyToolSensitivity：按工具名分档（已知外部副作用工具表）
 *   - classifyTextSensitivity：按自然语言步骤描述分档（计划步骤自动推进前的判定）
 *
 * 分级是策略声明，不是硬闸本身；强制点在调用方（当前消费方：GoalPlanner 的
 * 步骤自动推进——external 档不自动派发，转「待确认」等用户点头）。
 */
export type ActionSensitivity = "read" | "act_internal" | "act_external";

/** 已知外部副作用工具前缀（act_external）。表外工具不默认升档，由调用方自行从严。 */
const EXTERNAL_TOOL_PREFIXES: string[] = [
  "shopping.order.", // 下单/支付（阶段二提交）
  "email_sms.", // 邮件/短信外发（旧族）
  "email.send", // 邮件外发
  "phone_call.", // 真实外呼（旧族）
  "phone.dial", // 真实拨号外呼
  "phone.call_user", // 代拨电话给用户联系人
  "message.send", // 代发消息（旧族）
  "messages.send", // 代发消息（旧族）
  "messages.reply", // 代发短信/好友消息（触达真实收件人）
  "world.link.send_message", // 站内消息直达他人
  "commitment.nudge", // 代发催促
  "smart_home.execute", // 物理世界设备（旧族）
  "smart_home.control_device", // 物理设备控制
  "smart_home.scene", // 场景一键执行（触发设备动作）
  "wallet.pay", // 资金支出
  "payment.", // 支付族
  // alipay 支付/绑卡族（query-payment / check-wallet / merchant-list 是只读，不列）
  "alipay.submit-payment",
  "alipay.proxy-trade",
  "alipay.merchant-order",
  "alipay.apply-wallet",
  "alipay.bind-wallet",
  "alipay.pay-402",
];

/** 只读工具前缀（声明性，供审计展示；未命中任何表的工具按调用方语义处理） */
const READ_TOOL_PREFIXES: string[] = [
  "shopping.compare.",
  "order.status", // 订单状态查询（只读跨源采集库；probe 判定用）
  "search.",
  "web.",
  "weather.",
  "memory.recall",
  "commitment.list",
  "finance.list",
  "activity.timeline",
];

export function classifyToolSensitivity(toolName: string): ActionSensitivity {
  const name = String(toolName ?? "").trim().toLowerCase();
  if (EXTERNAL_TOOL_PREFIXES.some((p) => name.startsWith(p))) return "act_external";
  if (READ_TOOL_PREFIXES.some((p) => name.startsWith(p))) return "read";
  return "act_internal";
}

/** 外部动作词（命中即整步升 external） */
const EXTERNAL_TEXT_RE =
  /(下单|提交订单|购买|买下|结算|支付|付款|付定金|定金|押金|转账|汇款|打款|发消息|发送给|代发|发邮件|发短信|打电话|外呼|预约下单|取消订单|退货|退款|删除账户|授权|登录|发布|回复对方|砍价|联系卖家|签约)/;
/** 内部动作词（未命中 external 时降档用） */
const INTERNAL_TEXT_RE =
  /(创建日程|加日程|建提醒|设提醒|改日程|记一笔|记个账|记笔记|写笔记|加入清单|收藏|建监控|设监控|定个闹钟)/;
/** 只读词 */
const READ_TEXT_RE =
  /^(查|搜|看|找|盯|监控|比价|了解|调研|整理|汇总|检查|列出|读)/;

/**
 * 按自然语言描述分档（计划步骤/后台任务 goal 用）：
 *   命中外部动作词 → act_external（先确认）
 *   否则命中只读词开头或内部动作词 → read / act_internal
 *   兜底 act_internal（未知描述按可撤销内部动作对待，但不自动触外部）
 */
export function classifyTextSensitivity(text: string): ActionSensitivity {
  const t = String(text ?? "");
  if (EXTERNAL_TEXT_RE.test(t)) return "act_external";
  if (READ_TEXT_RE.test(t.trim())) return "read";
  if (INTERNAL_TEXT_RE.test(t)) return "act_internal";
  return "act_internal";
}
