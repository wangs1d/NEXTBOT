import type { ChatCompletionTool } from "openai/resources/chat/completions";

/**
 * 家政/本地生活预订能力 —— ChatCompletionTool schema（方案 C）。
 *
 * 工具族（点号命名空间 `home_service.*`）：
 *   - home_service.search      按类型搜套餐（保洁/维修/搬家/美容/宠物照料）
 *   - home_service.book        两阶段确认下单
 *   - home_service.status      订单状态
 *   - home_service.reschedule  改期
 *   - home_service.cancel      两阶段确认取消
 *
 * 走统一预订抽象层 services/booking/（方案 A）。Provider 现状：
 *   - BOOKING_MODE=mock（默认）：模拟 Provider（simulated=true，须如实告知）
 *   - live：真实 Provider（美团家政 / 58 同城 / 天鹅到家 API）尚未接入——
 *     实现 BookingProvider 接口后在 services/booking/providers/index.ts 注册即可，
 *     工具层无需改动
 *
 * 与相近能力的边界：
 *   - shopping.order.place：电商实物购物
 *   - smart_home.*：自有智能设备控制，非上门服务
 */
export const HOME_SERVICES_CHAT_TOOLS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "home_service.search",
      description:
        "按服务类型搜索家政/本地生活套餐（价格/时长/内容），供后续预订选择。\n" +
        "服务类型：cleaning=保洁，repair=维修，moving=搬家，beauty=美容美发，pet=宠物照料。\n" +
        "适用场景：用户说「找个小时工做深度保洁」「周末搬家的车约一下」「上门给猫喂食」。\n" +
        "BOOKING_MODE=mock（默认）返回模拟套餐（simulated=true，须如实告知用户）。",
      parameters: {
        type: "object",
        properties: {
          serviceType: {
            type: "string",
            enum: ["cleaning", "repair", "moving", "beauty", "pet"],
            description: "服务类型：cleaning=保洁，repair=维修，moving=搬家，beauty=美容美发，pet=宠物照料。",
          },
          address: {
            type: "string",
            description: "上门地址（可选，展示在摘要里供用户核对）。",
          },
          city: { type: "string", description: "城市（可选）。" },
          scheduleAt: {
            type: "string",
            description: "期望上门时间（可选，ISO 时间），如「2026-09-10T14:00:00+08:00」。",
          },
          provider: { type: "string", description: "指定 provider key（可选）。缺省自动选择。" },
        },
        required: ["serviceType"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "home_service.book",
      description:
        "预订家政/本地生活服务。**两阶段确认**：\n" +
        "① confirm=false（默认）：按 optionId 校验限额，返回订单摘要（套餐/价格/上门时间/地址）+ 确认 token。LLM 须向用户复述摘要。\n" +
        "② confirm=true + confirmationToken：执行预订，返回本地订单号。\n" +
        "安全：单笔上限 BOOKING_MAX_AMOUNT_CNY（默认 1000）、单日累计上限（默认 500）；token 5 分钟过期；Agent 不代付。\n" +
        "mock 模式（默认）为模拟下单（simulated=true），必须如实告知用户。\n" +
        "下单前必须先返回确认摘要让用户确认，得到明确同意后再带 confirm=true+token 执行。",
      parameters: {
        type: "object",
        properties: {
          serviceType: {
            type: "string",
            enum: ["cleaning", "repair", "moving", "beauty", "pet"],
            description: "服务类型（须与搜索时一致）。",
          },
          optionId: { type: "string", description: "选择的套餐 id（来自 home_service.search）。" },
          address: { type: "string", description: "上门地址（强烈建议提供，摘要供用户核对）。" },
          city: { type: "string", description: "城市（可选）。" },
          scheduleAt: { type: "string", description: "上门时间（ISO 时间）。" },
          provider: { type: "string", description: "provider key（可选）。" },
          confirm: {
            type: "boolean",
            description: "false/缺省=阶段一（返回摘要+token）；true=阶段二（带 confirmationToken 执行）。",
          },
          confirmationToken: { type: "string", description: "阶段一返回的确认 token。仅在 confirm=true 时必填。" },
        },
        required: ["serviceType", "optionId"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "home_service.status",
      description:
        "查询家政订单状态。传 orderId 查指定订单；不传返回最近 10 笔订单列表。\n" +
        "mock 模式订单为模拟数据（simulated=true）。",
      parameters: {
        type: "object",
        properties: {
          orderId: { type: "string", description: "本地订单号（bkg_ 开头）。可选。" },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "home_service.reschedule",
      description:
        "修改家政订单的上门时间（改期）。必须先向用户确认新的时间，再调用本工具（scheduleAt 为用户明确给出的新时间）。\n" +
        "已完成/已取消的订单无法改期。",
      parameters: {
        type: "object",
        properties: {
          orderId: { type: "string", description: "本地订单号（bkg_ 开头）。" },
          scheduleAt: { type: "string", description: "新的上门时间（ISO 时间），必须来自用户明确确认。" },
        },
        required: ["orderId", "scheduleAt"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "home_service.cancel",
      description:
        "取消家政订单。**两阶段确认**：\n" +
        "① confirm=false（默认）：返回待取消订单摘要 + 确认 token。\n" +
        "② confirm=true + confirmationToken：执行取消。\n" +
        "取消前必须先向用户复述订单摘要，得到明确同意后再带 confirm=true+token 执行。",
      parameters: {
        type: "object",
        properties: {
          orderId: { type: "string", description: "要取消的本地订单号。" },
          reason: { type: "string", description: "取消原因（可选）。" },
          confirm: { type: "boolean", description: "false/缺省=阶段一；true=阶段二（执行取消）。" },
          confirmationToken: { type: "string", description: "阶段一返回的确认 token。仅在 confirm=true 时必填。" },
        },
        required: ["orderId"],
        additionalProperties: false,
      },
    },
  },
];
