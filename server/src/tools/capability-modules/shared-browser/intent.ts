/**
 * shared_browser.* 工具意图元数据 + 关键词分类映射。
 *
 * 边界区分（negativeAliases / negativeExamples）：
 *   - agent_browser.*（服务端无头会话池，用户不可见、需 sessionId）
 *   - browser.fetch_page（只读单页抓取，无状态）
 *   - desktop.visual.run_task（操控桌面软件，非浏览器）
 */
import type { ToolIntentRule } from "../../tool-search/intent-metadata.js";

export const SHARED_BROWSER_INTENT_RULES: ToolIntentRule[] = [
  {
    prefix: "shared_browser.",
    metadata: {
      aliases: [
        "shared browser", "my browser", "user browser", "visible browser",
        "共用浏览器", "我的浏览器", "当前浏览器", "浏览器里", "帮我看网页",
        "打开网页", "打开网址", "打开链接", "去这个网站", "在浏览器里操作",
        "导航", "导航到", "浏览器导航", "跳到网页", "前往网页",
      ],
      negativeAliases: [
        "virtual browser", "headless", "session id",
        "search web", "fetch page", "shopping", "order",
        "desktop", "computer use", "screen control",
        "搜索", "读价", "比价", "下单", "购物",
        "操控电脑", "桌面", "屏幕控制", "无头",
      ],
      examples: [
        "在我打开的浏览器里帮我看一下这个页面",
        "用浏览器帮我查一下我刚登录的网站里的订单",
        "帮我在浏览器里打开这个链接并填写表单",
        "在我正看着的页面上点一下登录按钮",
      ],
      negativeExamples: [
        "帮我搜一下今天的新闻",
        "在后台打开一个无头浏览器抓取页面",
        "帮我操控电脑打开微信",
      ],
    },
  },
  {
    exact: "shared_browser.navigate",
    metadata: {
      aliases: [
        "open in my browser", "navigate", "navigate to", "open url", "打开网页", "打开网址",
        "打开链接", "去网站", "访问网页", "导航", "导航到", "浏览器导航", "跳到这个网站",
        "前往这个页面",
      ],
      examples: [
        "帮我在浏览器里打开 https://example.com",
        "去这个网站看看",
      ],
      negativeExamples: ["后台开个无头浏览器会话"],
    },
  },
  {
    exact: "shared_browser.control",
    metadata: {
      aliases: [
        "browser back", "browser forward", "reload page", "go home",
        "后退", "前进", "刷新", "刷新页面", "回到首页", "翻到上一页",
        "导航控制", "浏览器控制",
      ],
      examples: [
        "帮我后退一页",
        "把当前页面刷新一下",
      ],
      negativeExamples: ["打开一个新网页"],
    },
  },
  {
    exact: "shared_browser.read_page",
    metadata: {
      aliases: [
        "read page", "page content", "extract text", "读页面", "看看页面",
        "页面内容", "提取文本", "这个页面写的什么", "继续读",
      ],
      examples: [
        "看看我浏览器里这个页面写了什么",
        "读一下当前页面的内容",
        "这一页太长，接着往下读",
      ],
      negativeExamples: ["截个图"],
    },
  },
  {
    exact: "shared_browser.export_state",
    metadata: {
      aliases: [
        "export login state", "export cookies", "导出登录态", "导出 Cookie",
        "带去后台继续办", "用我的账号在后台跑",
      ],
      examples: [
        "把这个网站的登录态导出，去后台帮我慢慢比对价格",
        "用我现在的登录身份在无头浏览器里继续这个任务",
      ],
      negativeExamples: ["看看页面内容"],
    },
  },
  {
    exact: "shared_browser.trusted",
    metadata: {
      aliases: [
        "trusted click", "real click", "可信点击", "真实点击",
        "过验证的点击", "风控严的网站点一下", "真实键入",
      ],
      examples: [
        "在这个风控严的购票网站上用真实点击帮我选座",
        "用可信输入帮我在淘宝页面里搜索这个商品",
      ],
      negativeExamples: [
        "在我打开的浏览器里随便看看页面",
        "后台开个无头浏览器会话",
      ],
    },
  },
];

export const SHARED_BROWSER_CATEGORY_MAPPING: { name: string; keywords: string[] } = {
  name: "shared_browser",
  keywords: [
    "shared browser", "my browser", "current page", "visible browser",
    "共用浏览器", "我的浏览器", "当前浏览器", "浏览器里", "帮我看网页",
    "打开网页", "打开网址", "页面内容", "读页面",
    "导航", "导航到", "浏览器导航", "后退", "前进", "刷新页面",
  ],
};
