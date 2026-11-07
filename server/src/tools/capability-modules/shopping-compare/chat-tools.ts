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
 * 购物比价能力 —— ChatCompletionTool schema。
 *
 * 工具族（点号命名空间 `shopping.compare.*`）：
 *   - shopping.compare.prices   跨平台商品同款比价（淘宝/京东/拼多多…聚合）
 *   - shopping.compare.research 保险/服务类调研比价（web 检索 + LLM 汇总对比表）
 *   - shopping.compare.watch    降价监控（到价主动提醒）
 *
 * 定位：**只读零副作用**（不下单、不支付），与 shopping.order.*（真实下单）、
 * shopping.suggest（单平台建议）形成梯度。买前比价 → 确认 → shopping.order.place。
 *
 * 走 deferred（BM25 索引），关键词（"比价"/"哪个便宜"/"降价提醒"）触发时由
 * tool_discover 拉出，不占核心工具库 token。
 */
export const SHOPPING_COMPARE_CHAT_TOOLS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "shopping.compare.prices",
      description:
        "跨购物平台同款商品比价：并行搜索多个平台（平台由服务端按可用通道自动选择），" +
        "同款归一聚合后按价格升序返回分组报价（平台/标题/价格/店铺/主图/链接）。\n" +
        "适用场景：用户说「帮我比价 XX」「XX 哪个平台便宜」「买之前帮我看看价格」等。\n" +
        "前置条件：已导入并授权目标平台 Cookie 时自动注入；未导入也可先匿名查询，遇登录墙/验证码会把二维码推到聊天，用户扫码后继续补价。\n" +
        "**交接只在 human-required 时发生**：回执带 handoff / loginRequired / humanRequired 表示该平台被登录墙或验证码拦住，" +
        "用户需要在内置浏览器里自己扫码登录/过验证（桌面端在内置浏览器里操作；手机端/无头模式二维码已推到聊天，扫码即可），" +
        "回复里要明确写出这句交接指引；" +
        "unavailablePlatforms 里的普通「无匹配 / 读取失败」如实说明即可，不要写成需要登录，也不要把「价格未知」当成结论收工。\n" +
        "本工具只读零副作用，不下单；比完价用户确认后用 shopping.order.place 下单。\n" +
        "同款判定基于标题归一化 + 规格匹配，低置信分组会标注「疑似同款」，展示时须向用户说明。",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "比价关键词，尽量带品牌+规格（如「伊利纯牛奶 250ml*24盒」），提高同款归一准确度。",
          },
          platforms: {
            type: "array",
            items: {
              type: "string",
              enum: SUPPORTED_PLATFORMS,
            },
            description:
              "要参与比价的平台。**一般留空**——服务端按可用通道自动决定：匿名可读真实价的平台优先，" +
              "用户已有登录态的平台自动带上（手机端是云端浏览器取价，没有可视窗口，一上来全塞需要登录的平台只会卡在登录墙）。\n" +
              "只有两种情况才显式传：\n" +
              "- 用户明确指定「只在某几家比」；\n" +
              "- 非商品比价：外卖/闪购 → meituan，演出票务 → damai/maoyan（这两类不在缺省集合里）。\n" +
              `缺省集合当前为 ${DEFAULT_COMPARE_TEXT}。`,
          },
          maxPrice: {
            type: "number",
            description: "价格上限（CNY），过滤超预算商品。",
          },
          sort: {
            type: "string",
            enum: ["default", "price_asc", "price_desc", "sales"],
            description: "平台内排序方式，默认 price_asc（价格升序）。",
          },
          limit: {
            type: "integer",
            description: "每平台取的商品条数上限，默认 5，最大 10。",
          },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "shopping.compare.research",
      description:
        "保险/服务类调研比价：对无法结构化抓价的领域（保险产品、宽带、手机卡、会员服务、家政套餐等），" +
        "web 检索权威来源（官方条款/测评/比价文章），返回资料清单（标题/摘要/链接）供你汇总，" +
        "调用方须把资料汇总成对比表（方案/价格/核心保障或服务内容/注意事项）呈现给用户；" +
        "资料清单只作你的素材，不要把标题/链接清单复述给用户。\n" +
        "适用场景：用户说「帮我对比一下百万医疗险」「哪家宽带性价比高」等。\n" +
        "零副作用只读。回复时必须注明「信息为网页调研结果，以官方条款/渠道为准」。",
      parameters: {
        type: "object",
        properties: {
          topic: {
            type: "string",
            description: "调研主题，写具体（如「平安 e 生保 vs 好医保 长期医疗 保费 对比」）。",
          },
          limit: {
            type: "integer",
            description: "检索资料条数上限，默认 8，最大 12。",
          },
        },
        required: ["topic"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "shopping.compare.watch",
      description:
        "商品降价监控管理：关注某平台某商品关键词，设置目标价；后台定时复查价格，" +
        "降到目标价以内时主动推送提醒（同一价位不重复推，新低价才会再推）。\n" +
        "适用场景：用户说「XX 降到 500 以内告诉我」「提醒我这台手机降价」等。\n" +
        "action=add 需要 query + platform + targetPrice；action=remove 需要 watchId 或监控关键词；action=list 查看列表。",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["add", "remove", "list"],
            description: "操作类型：add 新增监控、remove 移除、list 查看。",
          },
          query: {
            type: "string",
            description: "监控关键词（action=add 必填），尽量带品牌+规格。",
          },
          platform: {
            type: "string",
            enum: SUPPORTED_PLATFORMS,
            description: "监控平台（action=add 必填）。",
          },
          targetPrice: {
            type: "number",
            description: "降价目标（CNY，action=add 必填）。当前价 ≤ 目标价时提醒。",
          },
          watchId: {
            type: "string",
            description: "监控 id 或监控关键词（action=remove 时提供）。",
          },
        },
        required: ["action"],
        additionalProperties: false,
      },
    },
  },
];
