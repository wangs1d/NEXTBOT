import type { ChatCompletionTool } from "openai/resources/chat/completions";

/**
 * 共用浏览器能力 —— ChatCompletionTool schema。
 *
 * 工具族（`shared_browser.*`）：用户与 Agent 共用同一个客户端内嵌浏览器
 * （Flutter Windows 端 WebView2）。用户在「常用工具 → 浏览器」里正常浏览，
 * Agent 的操作用户实时可见，也可随时手动接管；用户已登录的站点 Agent
 * 直接以登录态操作，无需 Cookie 导入。高风险动作（提交/支付类）下发前
 * 经风险分级附 gate，客户端弹确认条由用户放行。
 *
 * 与 agent_browser.*（服务端 Playwright 无头会话池）的边界：
 *   - agent_browser.*：服务端后台无头浏览器，用户不可见，适合批量/后台任务
 *   - shared_browser.*：用户眼前的浏览器，适合需要用户登录态或用户在看的操作
 *     （如帮用户在已登录的电商/订票站查订单、填表），页面即时可见可接管
 *
 * 走 deferred（延迟目录）：。
 */
export const SHARED_BROWSER_CHAT_TOOLS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "shared_browser.navigate",
      description:
        "在用户正在使用的浏览器（客户端内嵌浏览器，用户可见）中打开指定 URL。\n" +
        "适用场景：帮用户打开网页并接续操作、用户说「帮我在浏览器里打开…」。\n" +
        "返回页面标题与最终 URL（等待加载完成）。浏览器未打开时返回明确错误。",
      parameters: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "要打开的 URL（http/https）。缺 scheme 时自动补 https://。",
          },
        },
        required: ["url"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "shared_browser.control",
      description:
        "控制用户浏览器的基础导航：后退（back）/前进（forward）/刷新（reload）/" +
        "停止加载（stop）/回到主页（home）。",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["back", "forward", "reload", "stop", "home"],
            description: "导航动作。",
          },
        },
        required: ["action"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "shared_browser.click",
      description:
        "点击用户浏览器当前页面中的元素。定位方式三选一：\n" +
        "  1. selector：CSS 选择器（#id / .class / tag[attr=v]）\n" +
        "  2. text：可见文本（精确或包含匹配，如「登录」「提交订单」）\n" +
        "  3. index：shared_browser.read_page 返回的可交互元素序号\n" +
        "点击用户浏览器当前页面中的元素。定位方式优先级：\n" +
        "  1. ref：shared_browser.read_page 返回的元素引用（稳定，页面局部刷新不错位，推荐）\n" +
        "  2. selector：CSS 选择器（#id / .class / tag[attr=v]）\n" +
        "  3. text：可见文本（精确或包含匹配，如「登录」「提交订单」）\n" +
        "  4. index：read_page 返回的可交互元素序号（页面一变即失效，兜底用）\n" +
        "点击前自动滚动到元素并等待其渲染/可用（SPA 异步渲染无需盲重试）。\n" +
        "提交/支付类操作会先请用户在浏览器里确认。建议先 read_page 拿到元素列表再操作。",
      parameters: {
        type: "object",
        properties: {
          ref: { type: "string", description: "read_page 返回的元素引用（推荐）。" },
          selector: { type: "string", description: "CSS 选择器。" },
          text: { type: "string", description: "元素可见文本。" },
          index: { type: "integer", description: "read_page 返回的可交互元素序号（兜底）。" },
          waitTimeoutMs: { type: "integer", description: "元素出现/可用的等待上限（毫秒），默认 8000。" },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "shared_browser.type",
      description:
        "在用户浏览器当前页面的输入框中输入文本。默认清空后填入；submit=true 时" +
        "输入后回车提交（适用于搜索框）。ref/selector 省略时自动定位第一个可见输入框。" +
        "输入后会回读校验（页面吞输入时明确报错而不是静默失败）。",
      parameters: {
        type: "object",
        properties: {
          ref: { type: "string", description: "read_page 返回的输入框元素引用（推荐）。" },
          selector: { type: "string", description: "目标输入框的 CSS 选择器，省略则自动定位。" },
          text: { type: "string", description: "要输入的文本。" },
          submit: { type: "boolean", description: "输入后是否回车提交，默认 false。" },
          clear: { type: "boolean", description: "输入前是否清空输入框，默认 true。" },
        },
        required: ["text"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "shared_browser.scroll",
      description:
        "滚动用户浏览器当前页面：传 deltaY 相对滚动（正数向下），或 to=top/bottom 直达顶部/底部。",
      parameters: {
        type: "object",
        properties: {
          deltaY: { type: "integer", description: "相对滚动量（像素），正数向下。" },
          to: { type: "string", enum: ["top", "bottom"], description: "直达顶部/底部。" },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "shared_browser.read_page",
      description:
        "读取用户浏览器当前页面：URL、标题、正文文本 + 可交互元素列表" +
        "（ref/tag/text/href/placeholder 等，ref 供 shared_browser.click/type 定位，稳定不错位）。\n" +
        "正文为主内容启发式提取（自动剥离导航/页脚噪声）；长页用 offset 分页续读" +
        "（返回 hasMore/total 提示）。这是操作用户浏览器时的主要信息获取工具，操作前先调用它。",
      parameters: {
        type: "object",
        properties: {
          selector: { type: "string", description: "只提取某元素的文本（CSS 选择器）。" },
          includeInteractive: { type: "boolean", description: "是否附带可交互元素列表，默认 true。" },
          maxChars: { type: "integer", description: "本次返回正文字符上限，默认 4000。" },
          offset: { type: "integer", description: "正文续读起始偏移（上一次返回 hasMore 时递增 maxChars）。" },
          elementLimit: { type: "integer", description: "可交互元素列表上限，默认 30。" },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "shared_browser.export_state",
      description:
        "导出用户浏览器当前站点的登录态（Cookie/localStorage/sessionStorage，" +
        "Playwright storageState 兼容形状），供服务端无头浏览器池以同一身份继续执行长任务。\n" +
        "注意：HttpOnly Cookie 不可见（结果 limited=true）；调用前应向用户说明用途。仅导出当前页 origin。",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "shared_browser.trusted",
      description:
        "在用户浏览器里执行「可信输入」（CDP 桥直连，isTrusted=true 真实事件，抗风控），\n" +
        "适合电商/票务等风控严格站点的点击与输入。客户端未开启调试端口时自动回退为" +
        "普通注入点击（结果 trusted=false 并注明）。action=click 用 text/selector 定位；" +
        "action=type 输入文本（可选 submit 回车提交）。",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["click", "type"], description: "可信动作类型。" },
          text: { type: "string", description: "click：目标可见文本；type：要输入的文本。" },
          selector: { type: "string", description: "CSS 选择器（click/type 通用定位）。" },
          submit: { type: "boolean", description: "type 时是否回车提交，默认 false。" },
          timeoutMs: { type: "integer", description: "操作超时（毫秒），默认 8000。" },
        },
        required: ["action"],
        additionalProperties: false,
      },
    },
  },
];
