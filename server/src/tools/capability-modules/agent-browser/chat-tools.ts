import type { ChatCompletionTool } from "openai/resources/chat/completions";

/**
 * Agent 虚拟浏览器能力 —— ChatCompletionTool schema。
 *
 * 工具族（点号命名空间 `agent_browser.*`）：
 *   - agent_browser.open          打开 URL，返回 sessionId
 *   - agent_browser.click         点击元素
 *   - agent_browser.type          在输入框输入文本
 *   - agent_browser.scroll        滚动页面
 *   - agent_browser.screenshot    截图（返回 base64）
 *   - agent_browser.extract_text  提取页面文本 + 可交互元素列表
 *   - agent_browser.wait_for      等待元素出现
 *   - agent_browser.close         关闭会话
 *
 * 核心定位：在服务端后台启动 Playwright 无头浏览器，维持有状态会话（sessionId），
 * 让 Agent 能在浏览器中完成多步操作流程（如查信息、填表单、点按钮、提取结果）。
 *
 * 与现有能力的边界：
 *   - browser.fetch_page：只读抓单页 + 价格正则，无状态；本工具支持多步交互
 *   - shopping.order.*：仅限购物平台业务流程；本工具是通用网页操作
 *   - desktop.visual.run_task：操控用户桌面软件；本工具在服务端无头浏览器
 *
 * 安全护栏（不依赖访问模式，沙箱下也可用）：
 *   - 任意 https URL 允许 open（http 仅限 localhost），所有操作走审计日志
 *   - 对白名单站点（淘宝/京东/携程等 10 个）自动注入用户已授权 Cookie
 *   - 会话绑定 actorId 跨用户隔离；TTL 10 分钟 + LRU 上限 8 个自动清理
 *
 * 走 deferred（BM25 索引），不进 CORE_TOOL_LIBRARY：
 *   1. 用户不会每轮都操作浏览器，进核心会浪费 token
 *   2. 关键词触发（"打开网页" / "帮我操作" / "填表单"）时由 tool_discover 拉出
 */
export const AGENT_BROWSER_CHAT_TOOLS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "agent_browser.open",
      description:
        "在服务端后台启动 Playwright 无头浏览器并打开指定 URL，返回 sessionId。\n" +
        "后续所有操作（click/type/scroll/screenshot/extract_text/wait_for/close）都须传此 sessionId。\n" +
        "适用场景：用户说「帮我打开某网站」「去这个链接看看」「帮我在网页上操作」等。\n" +
        "安全：https 任意 URL 允许；http 仅限 localhost。对已授权站点（淘宝/京东/携程等）自动注入用户 Cookie。\n" +
        "沙箱模式下也可用。会话空闲 10 分钟自动过期。\n" +
        "与 browser.fetch_page（只读单页无状态）/ shopping.order.*（仅购物业务）的区别：本工具是通用多步浏览器操作。",
      parameters: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "要打开的 https URL（http 仅限 localhost/127.0.0.1）。",
          },
          viewport: {
            type: "object",
            properties: {
              width: { type: "integer", description: "视口宽度（像素），默认 1280。" },
              height: { type: "integer", description: "视口高度（像素），默认 720。" },
            },
            additionalProperties: false,
            description: "浏览器视口尺寸，影响页面渲染布局。",
          },
          waitUntil: {
            type: "string",
            enum: ["load", "domcontentloaded", "networkidle"],
            description: "页面加载完成判定：load=完全加载, domcontentloaded=DOM 就绪（默认）, networkidle=网络空闲。",
          },
          timeout: {
            type: "integer",
            description: "导航超时（毫秒），默认 30000。",
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
      name: "agent_browser.click",
      description:
        "在指定会话的浏览器页面中点击元素。\n" +
        "定位二选一：优先传 ref（extract_text 返回的元素引用，如 \"e5\"）；否则传 selector（CSS / text=登录 / xpath=）。\n" +
        "适用场景：点击按钮、链接、复选框等。元素不在视口内会自动滚动。",
      parameters: {
        type: "object",
        properties: {
          sessionId: { type: "string", description: "agent_browser.open 返回的会话 ID。" },
          ref: {
            type: "string",
            description: "元素引用（extract_text 返回列表中的 ref 值）。优先于 selector。",
          },
          selector: {
            type: "string",
            description: "Playwright 选择器（未传 ref 时必填）。例如 '#submit-btn' / 'text=登录'。",
          },
          button: {
            type: "string",
            enum: ["left", "right"],
            description: "鼠标按键，默认 left。",
          },
          doubleClick: {
            type: "boolean",
            description: "是否双击，默认 false。",
          },
          timeout: {
            type: "integer",
            description: "操作超时（毫秒），默认 15000。",
          },
        },
        required: ["sessionId"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "agent_browser.type",
      description:
        "在指定会话的浏览器页面输入框中输入文本。\n" +
        "定位二选一：优先传 ref（extract_text 返回的元素引用）；否则传 selector。\n" +
        "默认替换模式（append=false）：清空后填入。追加模式（append=true）可设 delay 模拟真人打字。\n" +
        "适用场景：填写表单、搜索框输入、登录凭证输入等。",
      parameters: {
        type: "object",
        properties: {
          sessionId: { type: "string", description: "agent_browser.open 返回的会话 ID。" },
          ref: {
            type: "string",
            description: "元素引用（extract_text 返回列表中的 ref 值）。优先于 selector。",
          },
          selector: {
            type: "string",
            description: "目标输入框的 Playwright 选择器（未传 ref 时必填）。例如 '#search-input' / 'input[name=\"q\"]'。",
          },
          text: { type: "string", description: "要输入的文本内容。" },
          append: {
            type: "boolean",
            description: "是否追加模式（在现有内容后输入）。默认 false（替换整个输入框内容）。",
          },
          delay: {
            type: "integer",
            description: "追加模式下逐字符输入的延迟（毫秒），默认 0。设 50-100 可模拟真人打字。",
          },
          clear: {
            type: "boolean",
            description: "追加模式下是否先清空输入框。默认 false。",
          },
        },
        required: ["sessionId", "text"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "agent_browser.scroll",
      description:
        "在指定会话的浏览器页面中滚动。\n" +
        "支持三种模式：\n" +
        "  1. 滚动到指定元素（传 selector）\n" +
        "  2. 相对滚动（传 deltaY，正数向下负数向上）\n" +
        "  3. 滚动到绝对坐标（传 x/y）\n" +
        "适用场景：加载更多内容、查看页脚、定位屏幕外的元素。",
      parameters: {
        type: "object",
        properties: {
          sessionId: { type: "string", description: "agent_browser.open 返回的会话 ID。" },
          selector: {
            type: "string",
            description: "滚动到指定元素（Playwright 选择器）。传此参数时忽略 x/y/deltaY。",
          },
          deltaY: {
            type: "integer",
            description: "相对滚动量（像素）。正数向下，负数向上。传此参数时忽略 x/y/selector。",
          },
          x: {
            type: "integer",
            description: "滚动到的水平坐标（像素）。与 y 配合使用。",
          },
          y: {
            type: "integer",
            description: "滚动到的垂直坐标（像素）。与 x 配合使用。",
          },
        },
        required: ["sessionId"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "agent_browser.screenshot",
      description:
        "对指定会话的当前页面截图，返回 JPEG base64。\n" +
        "⚠️ token 消耗提示：截图 base64 较大（>2000 字符会被截断），优先用 agent_browser.extract_text 获取页面结构。\n" +
        "仅在复杂页面需要视觉定位时使用截图。\n" +
        "可截整页（fullPage=true）、指定元素（selector）或当前视口。",
      parameters: {
        type: "object",
        properties: {
          sessionId: { type: "string", description: "agent_browser.open 返回的会话 ID。" },
          fullPage: {
            type: "boolean",
            description: "是否截取整个页面（含滚动区域），默认 false（仅当前视口）。",
          },
          selector: {
            type: "string",
            description: "截取指定元素（Playwright 选择器）。传此参数时忽略 fullPage。",
          },
          quality: {
            type: "integer",
            description: "JPEG 质量（20-90），默认 70。越低文件越小但越模糊。",
          },
        },
        required: ["sessionId"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "agent_browser.extract_text",
      description:
        "提取指定会话当前页面的文本内容，并附带可交互元素列表。\n" +
        "这是 Agent 浏览网页的**主要信息获取工具**，比 screenshot 更省 token 且信息更结构化。\n" +
        "返回：页面 URL、标题、正文文本（截断 4000 字）、可交互元素列表（每行 `ref role \"名称\" [状态]`，如 `e5 button \"领券购买\"`）。\n" +
        "拿到 ref 后传给 click/type/wait_for 的 ref 参数即可精确定位操作；列表最多 300 行。\n" +
        "可用 selector 只提取某元素的文本（如 '.article-content'）。",
      parameters: {
        type: "object",
        properties: {
          sessionId: { type: "string", description: "agent_browser.open 返回的会话 ID。" },
          selector: {
            type: "string",
            description: "只提取指定元素的文本（Playwright 选择器）。省略则提取整页 body 文本。",
          },
          includeInteractive: {
            type: "boolean",
            description: "是否附带可交互元素列表，默认 true。设 false 可减少返回体积。",
          },
        },
        required: ["sessionId"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "agent_browser.wait_for",
      description:
        "等待指定会话页面中某元素出现并可见。\n" +
        "定位二选一：优先传 ref（extract_text 返回的元素引用）；否则传 selector。\n" +
        "适用场景：点击后等待弹窗、提交后等待结果加载。超时返回错误（retryable=true）。",
      parameters: {
        type: "object",
        properties: {
          sessionId: { type: "string", description: "agent_browser.open 返回的会话 ID。" },
          ref: {
            type: "string",
            description: "元素引用（extract_text 返回列表中的 ref 值）。优先于 selector。",
          },
          selector: {
            type: "string",
            description: "等待出现的元素选择器（未传 ref 时必填）。",
          },
          timeout: {
            type: "integer",
            description: "等待超时（毫秒），默认 15000，上限 60000。",
          },
        },
        required: ["sessionId"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "agent_browser.close",
      description:
        "关闭指定浏览器会话，释放服务端资源。\n" +
        "完成操作后应主动调用此工具关闭会话；空闲 10 分钟的会话也会被自动清理。\n" +
        "关闭后 sessionId 失效，不可再用。",
      parameters: {
        type: "object",
        properties: {
          sessionId: { type: "string", description: "要关闭的会话 ID。" },
        },
        required: ["sessionId"],
        additionalProperties: false,
      },
    },
  },
];
