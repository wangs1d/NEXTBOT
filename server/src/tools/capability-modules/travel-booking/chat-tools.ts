import type { ChatCompletionTool } from "openai/resources/chat/completions";

/**
 * 旅行票务预订能力 —— ChatCompletionTool schema。
 *
 * 工具族（点号命名空间 `travel_booking.*`）：
 *   - travel_booking.search    机票/火车票/酒店实时报价比价（多源聚合）
 *   - travel_booking.book      两阶段确认下单（创建待支付订单）
 *   - travel_booking.status    订单状态查询
 *   - travel_booking.cancel    两阶段确认取消（未出票订单）
 *   - travel_booking.refund    两阶段确认退改工单（已支付/已出票订单，真实退改在原平台办理）
 *
 * 报价来源（QuoteAggregator 多源聚合，价格如实标注 priceSource）：
 *   - 本地价格库（保底，estimated/database/list）
 *   - 飞猪 FlyAI CLI（酒店+机票实时 api 价；安装 flyai CLI 后自动挂载，
 *     报价选项 extra.bookingUrl 为飞猪预订链接，可直接作 book 的 cashierUrl）
 *   - 浏览器代查·携程机票（Playwright 可用时 scraped）
 *   - 飞猪·内置浏览器代查（flyai 体验模式价格脱敏时，用用户登录过的可见
 *     浏览器开飞猪酒店详情页读实价，scraped；未登录/面板不在线则如实报错）
 *
 * 下单后闭环（不在本模块，由内置 skill 接力）：
 *   booking.travel-pay（支付宝真实扣款）→ booking.travel-pay-check →
 *   booking.travel-issue（出票入票夹）→ travel.arrival-monitor（到站管家）
 *
 * 与相近能力的边界：
 *   - ride_hailing.*：市内打车，非城际交通票务
 *   - travel.plan-itinerary：行程规划（POI/路线），不报价不下单
 *   - travel.departure-advice：出发时间建议
 */
export const TRAVEL_BOOKING_CHAT_TOOLS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "travel_booking.search",
      description:
        "搜索机票/火车票/酒店的实时报价并比价（多来源聚合，价格按来源如实标注）。\n" +
        "适用场景：「查明天北京到上海的机票」「对比一下成都春熙路附近的酒店价格」「G1027 高铁还有票吗多少钱」。\n" +
        "返回选项列表（optionId 供 travel_booking.book 使用；实时来源选项的 extra.bookingUrl 为商家预订链接，可直接作 book 的 cashierUrl；飞猪酒店选项另带 extra.mainPicUrl 平台真实主图与 extra.rating 平台评分，可在回复中自然引用，未带就是不造假的留空），每条带 priceSource：\n" +
        "  api=实时接口 / scraped=页面代查 / database|list=本地价格库 / estimated=估算。\n" +
        "必须向用户如实转述价格来源与「以平台实价为准」提示；估算价不得当作实价汇报。\n" +
        "酒店必填 city（或 hotelName+city）；机票/火车票必填 from/to（城市），有 departTime 更准。\n" +
        "酒店筛选参数（keywords/poiName/hotelStars/hotelTypes/maxPrice/sort）必须从用户本次原话动态提取：" +
        "「靠海的」→ keywords=靠海，「大东海那边」→ poiName=大东海，「四五星」→ hotelStars=4,5，「民宿」→ hotelTypes=homestay，" +
        "「300 以内」→ maxPrice=300，「便宜点」→ sort=price_asc，「评分高的」→ sort=rate_desc。" +
        "用户没提的条件一律不填（不要替用户假设档次或价格），什么都不提就是无筛选的自然搜索。",
      parameters: {
        type: "object",
        properties: {
          type: { type: "string", description: "票务类型：flight（机票）/ train（火车票）/ hotel（酒店）。" },
          from: { type: "string", description: "出发城市（flight/train），如「北京」。" },
          to: { type: "string", description: "到达城市（flight/train）；酒店=目的地城市。" },
          city: { type: "string", description: "城市（酒店必填），如「成都」。" },
          code: { type: "string", description: "航班号（如 MU5107）/ 车次（如 G1027），可选；有则定向报价。" },
          departTime: { type: "string", description: "出发日期时间（flight/train），如「2026-10-01 08:30」或「2026-10-01」。" },
          checkInDate: { type: "string", description: "入住日期（酒店），YYYY-MM-DD。" },
          checkOutDate: { type: "string", description: "退房日期（酒店），YYYY-MM-DD。" },
          hotelName: { type: "string", description: "酒店名（可选，有则定向查询）。" },
          tier: { type: "string", description: "酒店档次（可选）：budget / mid / luxury。仅用户明确表达档次时填。" },
          keywords: { type: "string", description: "酒店位置/特色关键词（可选）：用户原话里的要求原样提取，如「靠海」「海景」「近地铁」。" },
          poiName: { type: "string", description: "酒店商圈/地标（可选）：用户指定具体区域时填，如「大东海」「亚龙湾」「凤凰岛」。" },
          hotelStars: { type: "string", description: "酒店星级（可选）：1-5 逗号分隔，如「4,5」。用户提星级/高档时填。" },
          hotelTypes: { type: "string", description: "住宿类型（可选）：hotel / homestay（民宿）/ inn（客栈），逗号分隔。用户点名民宿/客栈时填。" },
          maxPrice: { type: "number", description: "每晚最高价（可选，CNY）。用户给预算上限/价格区间时填。" },
          sort: { type: "string", description: "酒店排序（可选）：price_asc（要便宜）/ price_desc / rate_desc（要好评分）/ distance_asc / no_rank（默认）。仅在用户表达出偏好时填。" },
          seat: { type: "string", description: "舱位/席别偏好（可选），如「经济舱」「二等座」。" },
          basePriceCny: { type: "number", description: "基准价（可选，仅当用户主动提供价格时用于兜底估算；有实时源时忽略）。" },
        },
        required: ["type"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "travel_booking.book",
      description:
        "预订机票/火车票/酒店选项。**两阶段确认**：\n" +
        "① confirm=false（默认）：重新比价定位 option → 限额校验 → 返回订单摘要 + 确认 token。LLM 须向用户复述摘要（含价格来源）。\n" +
        "② confirm=true + confirmationToken：创建「待支付」订单（本地订单号 bkg_*）。\n" +
        "下单成功后引导支付闭环：booking.travel-pay（用户本人支付宝真实扣款）→ booking.travel-issue（出票入票夹）。\n" +
        "安全：单笔/单日限额（BOOKING_MAX_AMOUNT_CNY/BOOKING_DAILY_BUDGET_CNY）；token 5 分钟过期；Agent 不代付、不持有支付凭证。",
      parameters: {
        type: "object",
        properties: {
          optionId: { type: "string", description: "选项 id（来自 travel_booking.search 返回的 options[].id）。" },
          type: { type: "string", description: "票务类型（与 search 一致）：flight / train / hotel。" },
          from: { type: "string", description: "出发城市（flight/train）。" },
          to: { type: "string", description: "到达城市（flight/train）。" },
          city: { type: "string", description: "城市（酒店）。" },
          code: { type: "string", description: "航班号/车次（flight/train）。" },
          departTime: { type: "string", description: "出发日期时间（flight/train）。" },
          checkInDate: { type: "string", description: "入住日期（酒店）。" },
          checkOutDate: { type: "string", description: "退房日期（酒店）。" },
          hotelName: { type: "string", description: "酒店名（酒店）。" },
          tier: { type: "string", description: "酒店档次（酒店）。" },
          seat: { type: "string", description: "舱位/席别（flight/train）。" },
          basePriceCny: { type: "number", description: "基准价（估算兜底用，与 search 保持一致）。" },
          cashierUrl: { type: "string", description: "商家收银台链接/订单串（可选；用户提供，或用 agent_browser 在商家站点走完下单流程后从支付页提取；飞猪 FlyAI 报价选项的 extra.bookingUrl 也是现成预订链接可直接传入；两阶段确认的 params 会随订单保存，booking.travel-pay 直接取用）。" },
          confirm: { type: "boolean", description: "阶段二确认（默认 false=出摘要与 token）。" },
          confirmationToken: { type: "string", description: "阶段一返回的确认 token（confirm=true 时必填）。" },
        },
        required: ["optionId", "type"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "travel_booking.status",
      description:
        "查询旅行票务订单状态（待支付/已支付/已出票/已完成/已取消）。用户问「机票订单怎么样了」「付了没」时调用；支付状态细节用 booking.travel-pay-check。",
      parameters: {
        type: "object",
        properties: {
          orderId: { type: "string", description: "本地订单号（bkg_*，来自 travel_booking.book）。缺省=最近一笔旅行订单。" },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "travel_booking.cancel",
      description:
        "取消旅行票务订单。**两阶段确认**（同 book）。仅限未出票订单（pending_payment/confirmed）；已支付/已出票订单的退票、改签请用 travel_booking.refund 创建退改工单（真实退改在原平台办理）。",
      parameters: {
        type: "object",
        properties: {
          orderId: { type: "string", description: "本地订单号（bkg_*）。" },
          reason: { type: "string", description: "取消原因（可选）。" },
          confirm: { type: "boolean", description: "阶段二确认（默认 false）。" },
          confirmationToken: { type: "string", description: "阶段一返回的确认 token（confirm=true 时必填）。" },
        },
        required: ["orderId"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "travel_booking.refund",
      description:
        "已支付/已出票订单的退票/改签**工单**。**两阶段确认**（同 book）。\n" +
        "边界：真实退改只能在原下单平台办理且涉及资金退回，Agent 不代办最终提交——本工具创建退改工单并返回平台导航指引；" +
        "经用户批准后用 agent_browser 打开原平台订单页引导到退改签入口，页面上的「提交」必须由用户本人点击。\n" +
        "未支付订单请直接 travel_booking.cancel；费用与时效以平台规则为准，须如实转告用户。",
      parameters: {
        type: "object",
        properties: {
          orderId: { type: "string", description: "本地订单号（bkg_*）。" },
          kind: { type: "string", description: "退改类型：refund（退票）/ change（改签）。" },
          reason: { type: "string", description: "退改原因（可选，写入工单）。" },
          confirm: { type: "boolean", description: "阶段二确认（默认 false=出摘要与 token）。" },
          confirmationToken: { type: "string", description: "阶段一返回的确认 token（confirm=true 时必填）。" },
        },
        required: ["orderId", "kind"],
        additionalProperties: false,
      },
    },
  },
];
