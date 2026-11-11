/**
 * agent_browser 工具意图元数据 + 关键词分类映射。
 *
 * 工具已合并为单个复合函数 `agent_browser`（action 分流 open/click/type/scroll/
 * extract_text/screenshot/wait_for/close/handoff），因此这里只需一条规则：
 * 把 9 个动作的别名/例句合并到同一份元数据，任意动作的口语表述都能召回到这个函数，
 * 具体动作由模型填 `action` 决定。
 *
 * `AGENT_BROWSER_INTENT_RULES` 与 `intent-metadata.ts` 中 `DEFAULT_TOOL_INTENT_RULES`
 * 同结构（`ToolIntentRule`），通过 `setExtraIntentRules` 在启动时合并到全局规则表，
 * 供 tool-search BM25 排序调权。
 *
 * `AGENT_BROWSER_CATEGORY_MAPPING` 供 `openai-compatible-tool-loop.ts` 的
 * `TOOL_CATEGORY_MAPPINGS` 合并：命中关键词时把本模块全部工具名注入到候选分类。
 *
 * 边界区分（negativeAliases / negativeExamples）：
 *   - browser.fetch_page（只读单页抓取，无状态）
 *   - shopping.order.*（仅购物平台业务流程）
 *   - desktop.visual.run_task（操控用户桌面软件，非浏览器）
 *   - search_web / fetch_web（通用搜索/抓取，非交互式浏览器操作）
 */
import type { ToolIntentRule } from "../../tool-search/intent-metadata.js";

export const AGENT_BROWSER_INTENT_RULES: ToolIntentRule[] = [
  {
    exact: "agent_browser",
    metadata: {
      aliases: [
        // 族级：浏览器 / 网页操作
        "browser", "web browser", "open page", "open url", "navigate to",
        "click button", "fill form", "type in", "scroll page", "web automation",
        "virtual browser", "agent browser", "web page operation",
        "浏览器", "打开网页", "打开网址", "打开链接", "去这个网站",
        "网页操作", "帮我操作", "在网页上", "填表单", "填表格",
        "点按钮", "点击按钮", "输入框", "网页上点", "滚动页面",
        "虚拟浏览器", "帮我浏览", "去网页",
        // 动作级：open / click / type / scroll
        "visit website", "访问网页", "去这个网址", "点链接", "按下", "点一下",
        "输入文本", "填入", "打字", "往下拉", "往上拉", "滚到", "翻页",
        // 动作级：extract_text / screenshot / wait_for / close
        "extract text", "read page", "read content", "page text", "get content",
        "提取文本", "读取页面", "获取内容", "页面内容", "读取网页",
        "screenshot", "capture", "snapshot", "截图", "截屏", "截个图", "抓图",
        "wait for selector", "等待元素", "等元素出现", "等加载",
        "close browser", "关闭浏览器", "关闭会话", "关掉网页", "结束浏览",
        // 动作级：handoff（人工接管）
        "扫码登录", "扫码支付", "验证码", "登录验证", "人工接管", "需要我操作",
        "handoff", "take over",
      ],
      negativeAliases: [
        "search web", "web search", "fetch page", "fetch url", "read price",
        "shopping", "order", "place order", "buy", "checkout",
        "desktop", "computer use", "screen control", "run task",
        "搜索", "读价", "比价", "下单", "买东西", "购物",
        "操控电脑", "桌面", "屏幕控制",
      ],
      examples: [
        "帮我打开这个网址 https://example.com 看看",
        "去这个网站帮我填一下表单",
        "在网页上点一下登录按钮",
        "帮我操作一下这个网页",
        "open this url and click the submit button",
        "帮我在浏览器里查一下这个页面的内容",
        "帮我截个当前页面的图",
        "帮我在搜索框里输入 iPhone 15 然后点搜索",
        "往下滚动加载更多",
        "扫码登录后告诉我要点哪里",
      ],
      negativeExamples: [
        "帮我搜一下今天的新闻",
        "在淘宝下单这个商品",
        "帮我操控电脑打开微信",
        "读一下这个商品的价格",
      ],
    },
  },
];

export const AGENT_BROWSER_CATEGORY_MAPPING: { name: string; keywords: string[] } = {
  name: "agent_browser",
  keywords: [
    // 中英关键词，覆盖用户口语
    "browser", "web page", "open url", "open page", "navigate", "visit",
    "click", "type in", "fill form", "scroll", "screenshot", "web automation",
    "virtual browser", "agent browser",
    "浏览器", "打开网页", "打开网址", "打开链接", "网页操作",
    "帮我操作", "在网页上", "填表单", "填表格", "点按钮", "点击",
    "输入框", "滚动页面", "截图", "虚拟浏览器", "去网站", "访问网页",
  ],
};
