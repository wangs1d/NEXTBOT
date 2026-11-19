import type { ChatCompletionTool } from "openai/resources/chat/completions";

/**
 * 打车/网约车能力 —— ChatCompletionTool schema（方案 B）。
 *
 * 工具族（点号命名空间 `ride_hailing.*`，LLM 侧见 ride_hailing_quote 等）：
 *   - ride_hailing.quote   车型 + 价格预估（位置联动：起点缺省自动取当前位置）
 *   - ride_hailing.book    两阶段确认下单（金额上限 + 单日限额）
 *   - ride_hailing.status  订单追踪（含司机/车牌等动态信息）
 *   - ride_hailing.cancel  两阶段确认取消
 *
 * 走统一预订抽象层 services/booking/（方案 A），安全护栏：
 *   - 两阶段确认 token（5 分钟 TTL），下单前必须向用户复述摘要并确认
 *   - 单笔上限 BOOKING_MAX_AMOUNT_CNY（默认 1000）
 *   - 单日累计上限 BOOKING_DAILY_BUDGET_CNY（默认 500）
 *   - Agent 不代付：返回 paymentUrl 时由用户手动支付
 *   - BOOKING_MODE=mock（默认）为模拟 Provider，结果带 simulated=true，须如实告知
 *
 * 与相近能力的边界：
 *   - meituan.create_order：跑腿/代买，非网约车
 *   - travel.departure-advice：出发时间建议，不下单
 *   - travel.compute-route：路线距离查询
 *   - wallet.purchase：仅记账
 *
 * 走 deferred（BM25 索引），关键词「打车/叫车/网约车」触发 tool_discover 拉出。
 */
export const RIDE_HAILING_CHAT_TOOLS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "ride_hailing.pickup",
      description:
        "弹出「选上车点」地图卡：用滴图 MCP 解析目的地坐标、逆地理当前位置，并取周边公交站/地铁站作为上车点参考。\n" +
        "使用顺序：用户要打车且还没确认上车点时，先调用本工具；用户在地图上确认后（客户端卡内动作会自动接着报价），不要再重复弹卡。\n" +
        "拿到回执后用你自己的话简短说明下一步即可，不要复述固定话术。\n" +
        "若回执里 dest 为空，说明目的地坐标没解析出来，如实告诉用户可在车上再和司机确认目的地。",
      parameters: {
        type: "object",
        properties: {
          dropoff: {
            type: "string",
            description: "目的地地址，如「街心花园」「北京南站北广场」。",
          },
          city: {
            type: "string",
            description: "城市（可选，提升目的地解析准确度），如「兴义」「北京」。",
          },
        },
        required: ["dropoff"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "ride_hailing.quote",
      description:
        "查询网约车车型与价格预估（经济/舒适/商务），供后续下单选择。\n" +
        "适用场景：用户说「帮我叫个车去机场」「打车去公司多少钱」「晚上八点叫车」。\n" +
        "若用户还没确认上车点，先调用 ride_hailing.pickup 弹地图卡让用户选；不要直接假设上车点报价。\n" +
        "起点联动：pickup 缺省时自动取用户当前 GPS 定位（需客户端授权定位），也可传地址文本。\n" +
        "Provider：BOOKING_MODE=mock（默认）返回模拟报价（simulated=true，须如实告知用户）；" +
        "live 模式走滴滴官方 MCP（生产端点实时报价，需 DIDI_MCP_KEY）。\n" +
        "与 travel.compute-route（纯路线查询）/ meituan.create_order（跑腿）的区别：本工具为叫车报价。",
      parameters: {
        type: "object",
        properties: {
          pickup: {
            type: "string",
            description:
              "上车点。缺省=自动取用户当前位置（GPS）；也可传地址文本，如「首都机场T3」「国贸地铁站B口」。",
          },
          dropoff: {
            type: "string",
            description: "目的地地址，如「北京南站北广场」「朝阳区望京SOHO T1」。",
          },
          city: {
            type: "string",
            description: "城市（可选，地址地理编码时提高准确度），如「北京」。",
          },
          scheduleAt: {
            type: "string",
            description: "用车时间（可选，ISO 时间）。缺省=立即叫车。预约用车时传入。",
          },
          provider: {
            type: "string",
            description: "指定 provider key（可选）。缺省自动选择：mock 模式=simulated；live=didi。",
          },
        },
        required: ["dropoff"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "ride_hailing.book",
      description:
        "下单叫车。**两阶段确认**：\n" +
        "① confirm=false（默认）：按 optionId 重新报价定位车型，返回订单摘要（车型/起点/终点/预估价）+ 确认 token。LLM 须向用户复述摘要。\n" +
        "② confirm=true + confirmationToken：真实（或模拟）下单，返回本地订单号与司机信息。\n" +
        "安全：所有下单必须用户在确认卡上明确同意（两阶段确认）；" +
        "token 5 分钟过期；Agent 不代付（返回 paymentUrl 时由用户手动支付）。\n" +
        "mock 模式（BOOKING_MODE=mock，默认）为模拟下单（simulated=true），必须如实告知用户非真实订单。\n" +
        "下单前必须先返回确认摘要让用户确认，得到明确同意后再带 confirm=true+token 执行。",
      parameters: {
        type: "object",
        properties: {
          dropoff: {
            type: "string",
            description: "目的地地址（须与报价时一致）。",
          },
          optionId: {
            type: "string",
            description: "选择的车型选项 id（来自 ride_hailing.quote 返回，如 eco/comfort/business）。",
          },
          pickup: {
            type: "string",
            description: "上车点。缺省=自动取用户当前位置。",
          },
          city: { type: "string", description: "城市（可选，提高地理编码准确度）。" },
          scheduleAt: { type: "string", description: "用车时间（可选，ISO 时间）。缺省=立即。" },
          passengerPhone: {
            type: "string",
            description: "乘客联系电话（可选，live 模式下单需要；须用户明确提供后才可使用）。",
          },
          provider: { type: "string", description: "provider key（可选，同报价）。" },
          confirm: {
            type: "boolean",
            description:
              "是否执行阶段二（确认下单）。false/缺省=阶段一（返回摘要+token）；true=阶段二（带 confirmationToken 执行）。",
          },
          confirmationToken: {
            type: "string",
            description: "阶段一返回的确认 token。仅在 confirm=true 时必填。",
          },
        },
        required: ["dropoff", "optionId"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "ride_hailing.status",
      description:
        "查询网约车订单状态：司机接单/行程中/已完成，含司机姓名、车牌、预计到达等动态信息。\n" +
        "传 orderId 查指定订单；不传返回最近 10 笔订单列表。\n" +
        "mock 模式订单为模拟数据（simulated=true）。",
      parameters: {
        type: "object",
        properties: {
          orderId: {
            type: "string",
            description: "本地订单号（bkg_ 开头，来自 ride_hailing.book 返回）。可选。",
          },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "ride_hailing.cancel",
      description:
        "取消网约车订单。**两阶段确认**：\n" +
        "① confirm=false（默认）：返回待取消订单摘要 + 确认 token。\n" +
        "② confirm=true + confirmationToken：执行取消。\n" +
        "取消前必须先向用户复述订单摘要，得到明确同意后再带 confirm=true+token 执行。",
      parameters: {
        type: "object",
        properties: {
          orderId: { type: "string", description: "要取消的本地订单号（bkg_ 开头）。" },
          reason: { type: "string", description: "取消原因（可选，透传给平台）。" },
          confirm: {
            type: "boolean",
            description: "是否执行阶段二。false/缺省=阶段一（返回 token）；true=阶段二（执行取消）。",
          },
          confirmationToken: { type: "string", description: "阶段一返回的确认 token。仅在 confirm=true 时必填。" },
        },
        required: ["orderId"],
        additionalProperties: false,
      },
    },
  },
];
