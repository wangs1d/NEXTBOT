import type { ChatCompletionTool } from "openai/resources/chat/completions";

import { listDefaultComparePlatforms, listSupportedPlatforms } from "../../../services/shopping-platforms/index.js";

/**
 * 平台 enum 从 adapter 注册表**派生**（单一事实源）：新增/删除 adapter 自动跟随，
 * 没有 adapter 的平台不进 enum。缺省比价平台（general 类目）也由注册表派生，
 * 此处仅用于 description 文案。
 */
const SUPPORTED_PLATFORMS: string[] = listSupportedPlatforms();
const DEFAULT_COMPARE_TEXT = listDefaultComparePlatforms().join("/");

/**
 * 购物比价能力 —— ChatCompletionTool schema（复合工具，单入口）。
 *
 * 对外只暴露一个函数 `shopping.compare`，用 `action` 分流：
 *   - prices    跨平台商品同款比价（淘宝/京东/拼多多…聚合）
 *   - research  保险/服务类调研比价（web 检索 + LLM 汇总对比表）
 *   - watch_add / watch_remove / watch_list  降价监控（到价主动提醒）
 *
 * 为什么合并：可见工具面按函数名占槽位（会话工具面 48 上限），3 个名字 = 3 个槽位，
 * 合并后只占 1 个；动作语义与回执形状不变。
 *
 * 定位：**只读零副作用**（不下单、不支付），与 shopping.order.*（真实下单）、
 * shopping.suggest（单平台建议）形成梯度。买前比价 → 确认 → shopping.order.place。
 */
export const SHOPPING_COMPARE_CHAT_TOOLS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "shopping.compare",
      description:
        "购物比价与降价监控（只读零副作用，不下单不支付）。按 action 分流：\n" +
        "- action=prices（最常用）：跨平台同款商品比价，并行搜索多个平台，按价格升序返回分组报价（平台/标题/价格/店铺/主图/链接）。" +
        "适用「帮我比价 XX」「XX 哪个平台便宜」「买之前帮我看看价格」。前置：已授权 Cookie 自动注入；未授权可匿名先查，" +
        "遇登录墙/验证码会把二维码推到聊天，用户扫码后继续补价。**交接只在 human-required 时发生**：" +
        "回执带 handoff / loginRequired / humanRequired 表示该平台被登录墙或验证码拦住，用户需自己扫码登录/过验证" +
        "（桌面端在内置浏览器操作；手机端/无头模式二维码已推到聊天），回复里要明确写出这句交接指引；" +
        "unavailablePlatforms 里的普通「无匹配 / 读取失败」如实说明，不要写成需要登录，也不要把「价格未知」当结论收工。" +
        "同款判定基于标题归一化 + 规格匹配，低置信分组标注「疑似同款」，展示时须说明。" +
        "回执带 retryHint 时按其指引改用通用多步浏览器操作自主补齐报价，不要把「没抓到」当结论收工。" +
        "比完价用户确认后用 shopping.order.place 下单。\n" +
        "- action=research：保险/服务类调研比价（保险产品、宽带、手机卡、会员服务、家政套餐等无法结构化抓价的领域），" +
        "返回权威资料清单（标题/摘要/链接），你要汇总成对比表（方案/价格/核心保障或服务内容/注意事项）；" +
        "资料清单只作素材，不要把标题/链接清单复述给用户。回复必须注明「信息为网页调研结果，以官方条款/渠道为准」。\n" +
        "- action=watch_add / watch_remove / watch_list：降价监控管理。watch_add 需要 query + platform + targetPrice，" +
        "后台定时复查，降到目标价以内主动提醒（同一价位不重复推，新低价才推）；watch_remove 需要 watchId 或监控关键词；" +
        "watch_list 查看列表。适用「XX 降到 500 以内告诉我」「提醒我这台手机降价」。",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["prices", "research", "watch_add", "watch_remove", "watch_list"],
            description:
              "操作类型：prices=跨平台比价；research=保险/服务类调研；watch_add/watch_remove/watch_list=降价监控增删查。",
          },
          query: {
            type: "string",
            description:
              "比价/监控关键词（prices、watch_add 必填），尽量带品牌+规格（如「伊利纯牛奶 250ml*24盒」），提高同款归一准确度。",
          },
          platforms: {
            type: "array",
            items: {
              type: "string",
              enum: SUPPORTED_PLATFORMS,
            },
            description:
              "action=prices：要参与比价的平台。**一般留空**——服务端自动组池：免登录平台（直接读到真实价）+ " +
              "用户已有登录态的平台 + 还没有登录态的主流登录平台（如淘宝/京东/拼多多）：撞上登录墙会把登录二维码推到聊天，" +
              "**一轮只推一张**，用户扫码后该平台 Cookie 落库、以后每轮比价自动带上它的实时价；" +
              "其余待登录平台在后续轮次逐个推码接入，不会一轮刷多张码；免登录平台照常保底出价。\n" +
              "只有两种情况才显式传：\n" +
              "- 用户明确指定「只在某几家比」：哪怕全都要登录也照常尝试（同样一次只推一张码），同时免登录平台保底出价；\n" +
              "- 非商品比价：外卖/闪购 → meituan，演出票务 → damai/maoyan（这两类不在缺省集合里）。\n" +
              `免登录缺省集合当前为 ${DEFAULT_COMPARE_TEXT}。`,
          },
          maxPrice: {
            type: "number",
            description: "action=prices：价格上限（CNY），过滤超预算商品。",
          },
          sort: {
            type: "string",
            enum: ["default", "price_asc", "price_desc", "sales"],
            description: "action=prices：平台内排序方式，默认 price_asc（价格升序）。",
          },
          limit: {
            type: "integer",
            description: "action=prices 每平台取的商品条数上限，默认 5、最大 10；action=research 检索资料条数，默认 8、最大 12。",
          },
          topic: {
            type: "string",
            description:
              "action=research 必填：调研主题，写具体（如「平安 e 生保 vs 好医保 长期医疗 保费 对比」）。",
          },
          platform: {
            type: "string",
            enum: SUPPORTED_PLATFORMS,
            description: "action=watch_add 必填：要监控的平台。",
          },
          targetPrice: {
            type: "number",
            description: "action=watch_add 必填：降价目标（CNY）。当前价 ≤ 目标价时提醒。",
          },
          watchId: {
            type: "string",
            description: "action=watch_remove：监控 id 或监控关键词。",
          },
        },
        required: ["action"],
        additionalProperties: false,
      },
    },
  },
];
