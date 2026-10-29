import type { ChatCompletionTool } from "openai/resources/chat/completions";

/**
 * 餐厅预订能力 —— ChatCompletionTool schema（方案 D）。
 *
 * 工具族（点号命名空间 `restaurant.*`）：
 *   - restaurant.search   搜餐厅（位置联动：附近推荐；偏好联动：结合记忆里的饮食偏好过滤）
 *   - restaurant.book     两阶段确认订座
 *   - restaurant.status   订单状态
 *   - restaurant.cancel   两阶段确认取消
 *
 * 走统一预订抽象层 services/booking/（方案 A）。Provider 现状：
 *   - amap：高德真实门店检索（配了 AMAP_WEB_KEY 即生效，与 BOOKING_MODE 无关），
 *     只有读能力——高德侧没有占座通道，book 返回明确错误并给出门店电话
 *   - simulated：BOOKING_MODE=mock 时注册的 4 家样例餐厅（simulated=true，须如实
 *     告知），支持 search → book → status → cancel 全流程演练
 *
 * 与相近能力的边界：
 *   - meituan.create_order / shopping.order.place：外卖/生鲜购物，非到店订座
 *   - travel.search-poi：旅行目的地餐饮探索（POI），非可订座时段
 */
export const RESTAURANT_BOOKING_CHAT_TOOLS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "restaurant.search",
      description:
        "搜索餐厅（关键词/菜系/人数/时段），供选店。\n" +
        "默认走高德真实门店检索：有定位时按距离升序返回附近门店，只给 city 则按城市检索；" +
        "每条含距离/评分/人均/地址/电话，平台没给的字段就是空——留空转述，不要估算补齐。\n" +
        "适用场景：「帮我订今晚 7 点 4 个人的位子」「附近有什么好吃的江浙菜」「推荐附近的美食：自助餐」。\n" +
        "偏好联动：可结合用户记忆中的饮食偏好（忌口/喜好菜系）在 query/cuisine 里过滤。\n" +
        "provider=simulated 时返回模拟样例（simulated=true，须如实告知），且只有该 provider 支持 book。",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "餐厅名或品类关键词（可选），如「外婆家」「自助餐」「适合商务宴请」。" },
          cuisine: { type: "string", description: "菜系（可选），如「江浙菜」「火锅」「日料」。" },
          covers: { type: "integer", description: "用餐人数（可选，默认 2）。" },
          dineAt: { type: "string", description: "用餐时间（可选，ISO 时间），如「2026-09-05T19:00:00+08:00」。" },
          city: { type: "string", description: "城市（可选）：拿不到定位时按城市检索，如「兴义」。" },
          provider: { type: "string", description: "指定 provider key（可选）：amap=真实门店，simulated=模拟样例。" },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "restaurant.book",
      description:
        "预订餐厅座位。**两阶段确认**：\n" +
        "① confirm=false（默认）：按 optionId 校验，返回订单摘要（餐厅/人数/时间/预估消费）+ 确认 token。LLM 须向用户复述摘要。\n" +
        "② confirm=true + confirmationToken：执行订座，返回本地订单号。\n" +
        "餐厅多为到店消费（payAtStore），预估消费为参考值；Agent 不代付。\n" +
        "真实门店（optionId 以 amap- 开头）没有占座通道，本工具会返回明确错误——" +
        "此时把该店 extra.tel 电话给用户致电订座（无电话就建议到店/导航），不要声称已订到位。\n" +
        "provider=simulated 为模拟订座（simulated=true），必须如实告知用户。\n" +
        "订座前必须先返回确认摘要让用户确认，得到明确同意后再带 confirm=true+token 执行。",
      parameters: {
        type: "object",
        properties: {
          optionId: { type: "string", description: "餐厅选项 id（来自 restaurant.search）。" },
          covers: { type: "integer", description: "用餐人数。" },
          dineAt: { type: "string", description: "用餐时间（ISO 时间）。" },
          query: { type: "string", description: "餐厅名/关键词（须与搜索时一致）。" },
          cuisine: { type: "string", description: "菜系（须与搜索时一致，可选）。" },
          city: { type: "string", description: "城市（可选）。" },
          contactPhone: { type: "string", description: "联系电话（可选，餐厅确认用；须用户明确提供）。" },
          provider: { type: "string", description: "provider key（可选）。" },
          confirm: {
            type: "boolean",
            description: "false/缺省=阶段一（返回摘要+token）；true=阶段二（带 confirmationToken 执行）。",
          },
          confirmationToken: { type: "string", description: "阶段一返回的确认 token。仅在 confirm=true 时必填。" },
        },
        required: ["optionId", "covers", "dineAt"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "restaurant.status",
      description:
        "查询餐厅预订状态。传 orderId 查指定订单；不传返回最近 10 笔。\n" +
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
      name: "restaurant.cancel",
      description:
        "取消餐厅订座。**两阶段确认**：\n" +
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
