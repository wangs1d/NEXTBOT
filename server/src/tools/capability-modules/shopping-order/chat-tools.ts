import type { ChatCompletionTool } from "openai/resources/chat/completions";

import { listSupportedPlatforms } from "../../../services/shopping-platforms/index.js";
import { BROWSER_SESSION_SITES, type BrowserSessionSiteId } from "../../../services/browser-session-sites.js";

/**
 * 购物/下单能力 —— ChatCompletionTool schema。
 *
 * 工具族（点号命名空间 `shopping.order.*` / `shopping.pay.*`）：
 *   - shopping.order.search  后台无头浏览器搜索商品
 *   - shopping.order.place   两阶段确认下单
 *   - shopping.order.track   查询订单状态/物流（支持本地单号 so_*）
 *   - shopping.order.cancel  两阶段确认取消订单
 *   - shopping.order.list    本地订单列表（零副作用）
 *   - shopping.pay.submit    支付宝收银台代付（仅限拿到 alipay 收银台链接的订单）
 *   - shopping.pay.check     订单支付状态查询 + 本地状态同步
 *
 * 核心定位：**优先在用户可见的客户端内置浏览器（WebView2）里执行**——登录态即
 * 用户自身，免 Cookie 导入；客户端不在线时回退服务端无头浏览器 + 已导入授权
 * Cookie；遇到登录页会自动截图二维码推送聊天并等待扫码（最长
 * SHOPPING_LOGIN_WAIT_MS，默认 120s）后自动继续，无需用户手动重试。
 * 登录态持久化：扫码成功 / 用户本人在内置浏览器登录后，平台 Cookie 自动加密
 * 落库且授权只升不降——一次登录长期有效，运行期平台刷新的 Cookie 也会回写更新。
 *
 * 与现有能力的边界：
 *   - shopping.compare.*：只读比价/降价监控，不下单；买前比价 → 本工具族下单
 *   - browser.fetch_page：只读抓页读价，明文禁止下单；本工具突破此边界
 *   - shopping.suggest：仅比价建议，不执行下单
 *   - wallet.purchase：纯内存记账；本工具真实下单后经消费管家自动入账
 *   - meituan.create_order：调平台开放 API；本工具走浏览器，不依赖开放 API
 *
 * 支付边界：**只点提交订单，不点支付**。订单落本地表（so_* 单号）；
 * 拿到支付宝收银台链接（cashier/qr.alipay.com）的订单可用 shopping.pay.submit
 * 经用户本人支付宝钱包代付（用户在支付宝 App 内确认扣款）；其余平台订单
 * 引导用户去平台 App 支付，shopping.pay.check 同步状态。
 *
 * 走 deferred（BM25 索引），不进 CORE_TOOL_LIBRARY：
 *   1. 用户不会每轮都下单，进核心会浪费 token
 *   2. 关键词触发（"下单" / "帮我买" / "在淘宝买"）时由 tool_discover 拉出
 *
 * 安全护栏（不依赖访问模式，沙箱下也可用）：
 *   - 须先导入平台 Cookie 并授权 agentAllowed=true
 *   - 单笔上限 SHOPPING_ORDER_MAX_AMOUNT_CNY（默认 5000，可按平台覆盖）
 *   - 单日预算 SHOPPING_ORDER_DAILY_BUDGET_CNY（默认 10000）
 *   - place / cancel 两阶段确认（5 分钟 TTL token）
 *   - 平台白名单 + 审计日志 + 本地订单落库
 */
/**
 * 平台能力清单从 adapter 注册表**派生**（单一事实源）：新增/删除 adapter 时
 * 工具 schema 的 enum 自动跟随；没有 adapter 的平台（如 dianping）不会出现在
 * enum 里——从 schema 层杜绝「模型调了必返回暂不支持」的幻觉调用。
 */
export const SHOPPING_PLATFORM_ENUM: string[] = listSupportedPlatforms();

/** 平台语义对照（id=中文名）：label 取自 browser-session-sites，未收录回退 id。 */
export function shoppingPlatformGlossary(): string {
  return SHOPPING_PLATFORM_ENUM.map(
    (p) => `${p}=${BROWSER_SESSION_SITES[p as BrowserSessionSiteId]?.label ?? p}`,
  ).join(", ");
}

export const SHOPPING_ORDER_CHAT_TOOLS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "shopping.order.search",
      description:
        "在服务端后台启动 Playwright 无头浏览器，注入用户预先导入并授权的 Cookie，" +
        "打开指定购物平台的搜索页，读取商品列表（名称/价格/链接）。\n" +
        "适用场景：用户说「在淘宝搜 iPhone 15」「帮我在京东找一下卫生纸」「美团搜肯德基」等。\n" +
        "前置条件：用户须先导入目标平台 Cookie 并授权 agentAllowed=true" +
        "（POST /integrations/browser-sessions/import + /consent）。沙箱模式下也可用。\n" +
        "**空结果不等于需要登录**：只有回执带 humanRequired / loginRequired 时才是需要用户本人扫码登录或过验证" +
        "（已在内置浏览器打开页面，告诉用户去登录/验证并点「我已完成」）；普通没搜到或超时如实说明、可换关键词重试。\n" +
        "与 browser.fetch_page（只读读价）/ shopping.suggest（仅比价建议）的区别：" +
        "本工具为后续下单做准备，返回的商品列表可直接传给 shopping.order.place。\n" +
        `已实现 adapter 的平台：${SHOPPING_PLATFORM_ENUM.join("/")}；枚举外的平台没有实现，调用会返回「暂不支持」。\n` +
        "品类建议：杂货/日用品/外卖用 meituan（或 jd 超市）；演唱会/话剧/演出票用 damai 或 maoyan" +
        "（实名制演出须用户先在其账号内添加观演人）。",
      parameters: {
        type: "object",
        properties: {
          platform: {
            type: "string",
            enum: SHOPPING_PLATFORM_ENUM,
            description: `目标购物平台。${shoppingPlatformGlossary()}。`,
          },
          query: {
            type: "string",
            description: "搜索关键词，例如「iPhone 15」「卫生纸」「肯德基」。",
          },
          filters: {
            type: "object",
            properties: {
              maxPrice: {
                type: "number",
                description: "价格上限（CNY）。超出此价格的商品会被过滤掉。",
              },
              sort: {
                type: "string",
                enum: ["default", "price_asc", "price_desc", "sales"],
                description: "排序方式：default=默认, price_asc=价格升序, price_desc=价格降序, sales=销量优先。",
              },
              limit: {
                type: "integer",
                description: "返回结果条数上限，默认 5，最大 10。",
              },
            },
            additionalProperties: false,
          },
        },
        required: ["platform", "query"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "shopping.order.place",
      description:
        "在服务端后台无头浏览器中代用户下单。**两阶段确认**：\n" +
        "① confirm=false（默认）：走到结算页（不点提交订单按钮），返回订单摘要" +
        "（商品名/数量/单价/总价/收货地址）+ 确认 token + 结算页截图。LLM 须向用户复述摘要。\n" +
        "② confirm=true + confirmationToken：校验 token 后点击提交订单按钮，返回订单号 + 本地单号 localOrderId。\n" +
        "前置条件：用户须先导入平台 Cookie 并授权 agentAllowed=true。沙箱模式下也可用。\n" +
        "安全：单笔上限 SHOPPING_ORDER_MAX_AMOUNT_CNY（默认 5000，可按平台覆盖），" +
        "单日预算 SHOPPING_ORDER_DAILY_BUDGET_CNY（默认 10000），超限拒绝提交；" +
        "确认 token 5 分钟过期；**只提交订单、不支付**。\n" +
        "提交成功后订单落本地表（状态 pending_payment）：拿到支付宝收银台链接的订单可用 " +
        "shopping.pay.submit 代付（用户本人支付宝确认扣款），其余引导用户去平台 App 支付。\n" +
        "与 wallet.purchase（仅记账）/ shopping.suggest（仅建议）/ shopping.compare.prices（只读比价）的区别：本工具真实提交订单。\n" +
        "下单前必须先返回确认摘要让用户确认，得到用户明确同意后再带 confirm=true+token 执行。",
      parameters: {
        type: "object",
        properties: {
          platform: {
            type: "string",
            enum: SHOPPING_PLATFORM_ENUM,
            description: "目标购物平台。",
          },
          item: {
            type: "string",
            description:
              "商品描述或商品详情页 URL。若是 URL 则直接打开该商品页；" +
              "若是关键词描述则先调 shopping.order.search 找到第一个匹配商品。",
          },
          quantity: {
            type: "integer",
            description: "购买数量，默认 1，上限 99。",
          },
          confirm: {
            type: "boolean",
            description:
              "是否执行阶段二（确认下单）。false 或缺省=阶段一（走到结算页返回摘要+token）；" +
              "true=阶段二（带 confirmationToken 完成提交订单）。",
          },
          confirmationToken: {
            type: "string",
            description: "阶段一返回的确认 token。仅在 confirm=true 时必填。",
          },
        },
        required: ["platform", "item"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "shopping.order.track",
      description:
        "查询订单状态/物流：优先在用户可见的客户端内置浏览器打开平台订单页实时刷新（登录态即用户自身），客户端不在线时回退无头浏览器+Cookie；传本地单号（so_*）或平台订单号均可。\n" +
        "适用场景：用户说「帮我查一下淘宝订单」「京东那个订单到哪了」等。\n" +
        "遇到登录页会自动把二维码推送给用户并等待扫码后继续；平台查询失败且无本地记录时回退本地订单快照（标注非实时）。\n" +
        "未传 orderId 时返回平台最近订单列表；查本地订单列表请用 shopping.order.list（零副作用）。",
      parameters: {
        type: "object",
        properties: {
          platform: {
            type: "string",
            enum: SHOPPING_PLATFORM_ENUM,
            description: "目标购物平台。",
          },
          orderId: {
            type: "string",
            description: "订单号（可选）。不传则返回最近订单列表。",
          },
        },
        required: ["platform"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "shopping.order.cancel",
      description:
        "在服务端后台无头浏览器中取消指定订单。**两阶段确认**：\n" +
        "① confirm=false（默认）：生成确认 token，返回待取消订单摘要。\n" +
        "② confirm=true + confirmationToken：执行取消操作，返回结果。\n" +
        "前置条件：用户须先导入平台 Cookie 并授权 agentAllowed=true。沙箱模式下也可用。\n" +
        "取消前必须先返回确认摘要让用户确认，得到用户明确同意后再带 confirm=true+token 执行。",
      parameters: {
        type: "object",
        properties: {
          platform: {
            type: "string",
            enum: SHOPPING_PLATFORM_ENUM,
            description: "目标购物平台。",
          },
          orderId: {
            type: "string",
            description: "要取消的订单号。",
          },
          confirm: {
            type: "boolean",
            description:
              "是否执行阶段二（确认取消）。false 或缺省=阶段一（返回确认 token）；" +
              "true=阶段二（带 confirmationToken 执行取消）。",
          },
          confirmationToken: {
            type: "string",
            description: "阶段一返回的确认 token。仅在 confirm=true 时必填。",
          },
        },
        required: ["platform", "orderId"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "shopping.order.list",
      description:
        "查询本地订单列表（零副作用，纯本地读取，不访问平台）。\n" +
        "返回 agent 代用户提交过的全部订单：本地单号（so_*）/平台/平台单号/商品/金额/状态/支付链接。\n" +
        "适用场景：用户说「我买过什么」「之前下的单有哪些」「查一下订单」。\n" +
        "需要某订单的实时物流/支付状态时，再用 shopping.order.track（传 localOrderId）或 shopping.pay.check。",
      parameters: {
        type: "object",
        properties: {
          platform: {
            type: "string",
            enum: SHOPPING_PLATFORM_ENUM,
            description: "按平台过滤（可选）。",
          },
          includeFinished: {
            type: "boolean",
            description: "是否包含已完成/已取消/已失败的终态订单，默认 true。",
          },
          limit: {
            type: "integer",
            description: "返回条数上限，默认 10，最大 50。",
          },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "shopping.pay.submit",
      description:
        "对本地订单发起支付宝收银台代付。**仅当订单捕获到支付宝收银台链接**（cashier/qr.alipay.com）时可用：" +
        "内置浏览器在线时直接在用户可见浏览器打开收银台（用户在浏览器内或支付宝 App 完成支付），" +
        "并自动附「支付确认」按钮卡；否则经用户本人支付宝钱包拉起收银台，收银台二维码实时推送到聊天，" +
        "实际扣款由用户在支付宝 App 内确认，agent 不持有支付凭据。\n" +
        "订单没有收银台链接或平台使用自有收银台（淘宝/京东/美团等大多数情况）时返回明确指引，" +
        "此时应提示用户去平台 App 完成支付。orderId 使用本地单号（so_*，shopping.order.place 返回的 localOrderId）。\n" +
        "调用前必须向用户复述订单摘要并获得明确同意。",
      parameters: {
        type: "object",
        properties: {
          orderId: {
            type: "string",
            description: "本地订单号（so_*）。",
          },
        },
        required: ["orderId"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "shopping.pay.check",
      description:
        "查询订单支付状态并同步本地订单表：优先查支付宝钱包收银台支付状态（若有收银台链接），" +
        "再经浏览器刷新平台侧订单状态（若有平台单号），回写本地状态。\n" +
        "适用场景：用户说「付了没」「订单什么状态」；shopping.pay.submit 之后的确认也用它。\n" +
        "orderId 支持本地单号（so_*）或平台订单号。",
      parameters: {
        type: "object",
        properties: {
          orderId: {
            type: "string",
            description: "本地订单号（so_*）或平台订单号。",
          },
        },
        required: ["orderId"],
        additionalProperties: false,
      },
    },
  },
];
