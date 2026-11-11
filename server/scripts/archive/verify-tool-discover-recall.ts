/**
 * tool_discover 召回实测：验证中文 query 能否召回对应工具。
 * 用法: npx tsx scripts/verify-tool-discover-recall.ts
 */
import { buildDeferredCatalog, searchDeferredTools } from "../src/tools/tool-search/catalog.js";

// 模拟真实 catalog 的工具 schema（描述与线上一致的关键词）
const FAKE_TOOLS = [
  {
    type: "function",
    function: {
      name: "voice.speak",
      description:
        "【语音播报·即时模式】合成语音并立即对用户播报（无来电 UI、无振铃，客户端后台一次性播放）。适用于：状态告知、提醒、即时反馈、不需要用户回应的简短播报。",
      parameters: { type: "object", properties: { text: { type: "string", description: "要朗读的文字内容" } }, required: ["text"] },
    },
  },
  {
    type: "function",
    function: {
      name: "voice.send_message",
      description:
        "【语音消息·微信式】合成语音并落地为可重播的语音消息（客户端渲染为微信式语音气泡，可多次点击重播）。适用于：用户明确要求发语音、长文本回复用语音更自然。",
      parameters: { type: "object", properties: { text: { type: "string", description: "语音消息要朗读的内容" } }, required: ["text"] },
    },
  },
  {
    type: "function",
    function: {
      name: "voice.transcribe",
      description:
        "【ASR 主动识别】把已落地的语音消息文件转写为文本，让 Agent 能听用户发来的语音。",
      parameters: { type: "object", properties: { mediaUrl: { type: "string", description: "语音消息 URL" } }, required: ["mediaUrl"] },
    },
  },
  {
    type: "function",
    function: {
      name: "reminder.plan",
      description:
        "【智能提醒】为用户规划一条提醒：解析时间表达式、生成提醒文案并写入日程。适用于：设定时提醒、闹钟、到点叫我。",
      parameters: { type: "object", properties: { text: { type: "string" }, time: { type: "string" } } },
    },
  },
  {
    type: "function",
    function: {
      name: "calendar.create_task",
      description:
        "创建日程任务。适用于：添加日历事项、安排会议、记录待办。",
      parameters: { type: "object", properties: { title: { type: "string" } } },
    },
  },
  {
    type: "function",
    function: {
      name: "search_web",
      description:
        "联网搜索：用关键词检索网页，返回标题/摘要/链接。适用于：查新闻、股价、排片、价格等实时信息。",
      parameters: { type: "object", properties: { query: { type: "string" } } },
    },
  },
  {
    type: "function",
    function: {
      name: "desktop.visual.screenshot",
      description: "截取当前屏幕画面，用于桌面视觉理解。",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "shopping.order.search",
      description: "搜索外卖/购物订单。",
      parameters: { type: "object", properties: { keyword: { type: "string" } } },
    },
  },
] as const;

const catalog = buildDeferredCatalog(FAKE_TOOLS as never);

const CASES: Array<{ query: string; expect: string[]; negative: string[] }> = [
  {
    query: "语音合成 配音 音频 generation tts 生成语音",
    expect: ["voice.speak", "voice.send_message"],
    negative: [],
  },
  {
    query: "帮我把这句话播报出来",
    expect: ["voice.speak"],
    negative: [],
  },
  {
    query: "发一条语音消息",
    expect: ["voice.send_message"],
    negative: [],
  },
  {
    query: "设定时提醒",
    expect: ["reminder.plan"],
    negative: [],
  },
  {
    query: "查一下今天的新闻",
    expect: ["search_web"],
    negative: [],
  },
  {
    query: "截个屏",
    expect: ["desktop.visual.screenshot"],
    negative: [],
  },
];

let pass = 0;
let fail = 0;
for (const c of CASES) {
  const matches = searchDeferredTools(catalog, c.query, 5);
  const names = matches.map((m) => m.name);
  const hit = c.expect.every((n) => names.includes(n));
  const noLeak = c.negative.every((n) => !names.includes(n));
  const ok = hit && noLeak;
  if (ok) pass++;
  else fail++;
  console.log(
    `${ok ? "✅" : "❌"} "${c.query}"\n    top5: ${names.join(", ") || "(empty)"}${hit ? "" : `\n    ❌ 缺少: ${c.expect.filter((n) => !names.includes(n)).join(", ")}`}${noLeak ? "" : `\n    ❌ 不应出现: ${c.negative.filter((n) => names.includes(n)).join(", ")}`}`,
  );
}
console.log(`\n通过 ${pass}/${CASES.length}`);
process.exit(fail > 0 ? 1 : 0);
