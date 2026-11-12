import type { ChatCompletionTool } from "openai/resources/chat/completions";

/**
 * Agent 虚拟浏览器能力 —— ChatCompletionTool schema（复合工具，单入口）。
 *
 * 对外只暴露一个函数 `agent_browser`，用 `action` 分流到 9 个内部动作：
 *   open / click / type / scroll / screenshot / extract_text / wait_for / close / handoff
 *
 * 为什么合并：延迟目录的可见面按「函数名」占槽位（会话工具面 48 上限），
 * 9 个名字 = 9 个槽位；合并后只占 1 个，召回与转正只需命中一个函数，
 * 前缀缓存也更稳定。动作语义、参数、回执形状与合并前完全一致。
 *
 * 核心定位：通用浏览器层（客户端在线时优先在**用户可见的内置浏览器**里操作，
 * 登录态即用户本人、全程可见可接管；不在线时回退服务端无头浏览器），维持有状态
 * 会话（sessionId），让 Agent 能完成多步操作流程（如查信息、填表单、点按钮、提取结果）。
 *
 * 人工接管对齐主流 Browser Agent：只有撞到登录墙/验证码（human-required）才停下
 * 交给用户，页面留在可见浏览器里，用户点「我已完成」后继续；普通失败不交人。
 *
 * 与现有能力的边界：
 *   - browser.fetch_page：只读抓单页 + 价格正则，无状态；本工具支持多步交互
 *   - shopping.order.*：仅限购物平台业务流程；本工具是通用网页操作
 *   - desktop.visual.run_task：操控用户桌面软件；本工具在服务端无头浏览器
 *
 * 安全护栏：
 *   - 任意 https URL 允许 open（http 仅限 localhost），所有操作走审计日志
 *   - 对白名单站点（淘宝/京东/携程等 10 个）自动注入用户已授权 Cookie
 *   - 会话绑定 actorId 跨用户隔离；TTL 10 分钟 + LRU 上限 8 个自动清理
 */
export const AGENT_BROWSER_CHAT_TOOLS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "agent_browser",
      description:
        "云端/内置浏览器操作（有状态多步）。先 action=open 打开网址拿到 sessionId，" +
        "之后 click/type/scroll/extract_text/screenshot/wait_for/handoff/close 都要带同一个 sessionId。\n" +
        "客户端在线且支持可视浏览器时优先在用户可见的内置浏览器里操作（登录态即用户本人）；手机端或无客户端时自动回退服务端无头浏览器，结果与截图回到聊天。\n" +
        "**open/click/type/wait_for 的回执自带当前页面可交互元素表（pageState.interactive，带 ref 编号）**：成功时直接从中选 ref 继续下一步；失败时也附了最新元素表，从中挑正确的 ref 重试（页面已变化，原 ref 可能失效），都不要单独再调 extract_text。需要页面正文文本时才用 extract_text；只有需要视觉确认时才 screenshot。\n" +
        "**撞到登录墙/验证码/支付确认等只有用户本人能做的步骤**：open/click 回执会带 humanRequired 并自动推图；也可主动用 action=handoff 把截图+指引推到聊天（手机端也能收到），然后等用户回复再继续，别把这种情况当普通失败。\n" +
        "安全：https 任意 URL；http 仅限 localhost。沙箱下也可用。会话空闲 10 分钟过期，用完请 action=close。\n" +
        "与 browser.fetch_page（只读单页无状态）/ shopping.order.*（仅购物业务）的区别：本工具是通用多步浏览器操作。\n" +
        "action 说明：" +
        "open=打开网址；click=点击元素；type=输入文本；scroll=滚动；extract_text=提取页面文本与可交互元素；" +
        "screenshot=截图（base64 较大，>2000 字符会被截断，慎用）；wait_for=等待元素出现；close=关闭会话；" +
        "handoff=把截图和操作指引推给用户并等待其完成。",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: [
              "open",
              "click",
              "type",
              "scroll",
              "extract_text",
              "screenshot",
              "wait_for",
              "close",
              "handoff",
            ],
            description: "要执行的浏览器动作。",
          },
          url: {
            type: "string",
            description: "action=open 必填：要打开的 https URL（http 仅限 localhost/127.0.0.1）。",
          },
          viewport: {
            type: "object",
            properties: {
              width: { type: "integer", description: "视口宽度（像素），默认 1280。" },
              height: { type: "integer", description: "视口高度（像素），默认 720。" },
            },
            additionalProperties: false,
            description: "action=open：浏览器视口尺寸，影响页面渲染布局。",
          },
          waitUntil: {
            type: "string",
            enum: ["load", "domcontentloaded", "networkidle"],
            description:
              "action=open：页面加载完成判定。load=完全加载, domcontentloaded=DOM 就绪（默认）, networkidle=网络空闲。",
          },
          sessionId: {
            type: "string",
            description: "除 open 外全部必填：action=open 返回的会话 ID。",
          },
          ref: {
            type: "string",
            description:
              "click/type/wait_for 定位用：元素引用（如 \"e5\"），来自最近一次回执的 pageState.interactive 或 extract_text 返回的元素表，优先于 selector。",
          },
          selector: {
            type: "string",
            description:
              "click/type/wait_for/scroll/screenshot/extract_text 的 Playwright 选择器；未传 ref 时 click/type/wait_for 必填。",
          },
          button: {
            type: "string",
            enum: ["left", "right"],
            description: "action=click：鼠标按键，默认 left。",
          },
          doubleClick: {
            type: "boolean",
            description: "action=click：是否双击，默认 false。",
          },
          text: {
            type: "string",
            description: "action=type 必填：要输入的文本内容。",
          },
          append: {
            type: "boolean",
            description:
              "action=type：是否追加模式（在现有内容后输入）。默认 false（替换整个输入框内容）。",
          },
          delay: {
            type: "integer",
            description: "action=type：追加模式下逐字符输入的延迟（毫秒），默认 0。50-100 可模拟真人打字。",
          },
          clear: {
            type: "boolean",
            description: "action=type：追加模式下是否先清空输入框。默认 false。",
          },
          deltaY: {
            type: "integer",
            description: "action=scroll：相对滚动量（像素），正数向下负数向上；传此参数时忽略 x/y/selector。",
          },
          x: {
            type: "integer",
            description: "action=scroll：滚动到的水平坐标（像素），与 y 配合使用。",
          },
          y: {
            type: "integer",
            description: "action=scroll：滚动到的垂直坐标（像素），与 x 配合使用。",
          },
          fullPage: {
            type: "boolean",
            description: "action=screenshot：是否截取整个页面（含滚动区域），默认 false（仅当前视口）。",
          },
          quality: {
            type: "integer",
            description: "action=screenshot：JPEG 质量（20-90），默认 70。",
          },
          includeInteractive: {
            type: "boolean",
            description: "action=extract_text：是否附带可交互元素列表，默认 true。设 false 可减少返回体积。",
          },
          timeout: {
            type: "integer",
            description:
              "open/click/wait_for 的操作超时（毫秒）。open 默认 30000；click 默认 15000；wait_for 默认 15000、上限 60000。",
          },
          instruction: {
            type: "string",
            description:
              "action=handoff 必填：告诉用户这一步具体要做什么，例如「请用微信扫描二维码登录，完成后回复我」。",
          },
          title: {
            type: "string",
            description: "action=handoff：卡片标题（可选），缺省「需要你操作」，例如「扫码支付」「选择房型」。",
          },
        },
        required: ["action"],
        additionalProperties: false,
      },
    },
  },
];
