/**
 * 复合工具 action 覆盖回归（2026-11-11）。
 *
 * 工具面收敛成 11 个复合入口后，风险从「工具选不中」变成「选中了但 action 分错」。
 * 本文件锁三件事：
 *  1. schema 完整：每个 action 都在 enum 与描述里，模型看得到全部分支；
 *  2. 召回可达：每个 action 的用户口语都能把所属复合工具拉进 topK，
 *     否则模型根本看不到这个入口（历史坑：细分名删除后词面信号一起消失）；
 *  3. 转发正确：action → 执行器一一对应，且 action 字段不透传给底层；
 *     模型漏填 action 时只按参数签名/只读默认分支落位（不再按措辞猜），不抛未知分支。
 */
process.env.AGENT_TOOL_SEARCH_ENABLED = "on";
process.env.AGENT_NEURAL_EMBED_ENABLED = "off";
process.env.AGENT_NEURAL_RERANK_ENABLED = "off";
process.env.AGENT_NEURAL_INTENT_ENABLED = "off";

import assert from "node:assert/strict";
import test from "node:test";

const { getBuiltinAgentChatTools } = await import(
  "../src/external-model/openai-compatible-tool-loop.js"
);
const { prepareToolsWithToolSearch, executeToolSearchBridge } = await import(
  "../src/tools/tool-search/index.js"
);
const {
  COMPOSITE_ACTION_SPECS,
  COMPOSITE_CHAT_TOOLS,
  registerCompositeTools,
  resolveCompositeAction,
} = await import("../src/external-model/composite-chat-tools.js");

type Case = {
  tool: string;
  action: string;
  query: string;
  args?: Record<string, unknown>;
  /** 漏填 action 时的期望落位；缺省 = 本 action（靠参数签名或默认分支命中）。 */
  fallback?: string;
  /** 参数里没有任何可区分证据时，必须显式给 action，不参与兜底断言。 */
  infer?: boolean;
};

/** 每个 action 一条真实用户措辞（召回用），args 为模型常见参数（兜底用）。 */
const CASES: Case[] = [
  // web_search
  { tool: "web_search", action: "web", query: "帮我搜一下刘浩存最近的消息", args: { query: "帮我搜一下刘浩存最近的消息" } },
  { tool: "web_search", action: "deep", query: "帮我深度调研一下这个行业的现状", args: { query: "帮我深度调研一下这个行业的现状" }, fallback: "web" },
  { tool: "web_search", action: "images", query: "找几张猫的照片", args: { query: "找几张猫的照片" }, fallback: "web" },
  { tool: "web_search", action: "images_batch", query: "帮我批量找几组图片，一组猫一组狗", args: { queries: ["猫", "狗"] } },
  { tool: "web_search", action: "videos", query: "找个教做红烧肉的视频", args: { query: "找个教做红烧肉的视频" }, fallback: "web" },
  { tool: "web_search", action: "find_video", query: "在视频结果里定位第二个视频", args: { query: "在视频结果里定位第二个视频" }, fallback: "web" },
  { tool: "web_search", action: "parse_video", query: "帮我下载视频并保存下来", args: { url: "https://v.example.com/1" } },
  { tool: "web_search", action: "hot", query: "今天有什么热搜", args: { query: "今天有什么热搜" }, fallback: "web" },
  { tool: "web_search", action: "weather", query: "北京今天天气怎么样", args: { location: "北京", query: "北京今天天气怎么样" } },
  { tool: "web_search", action: "quote", query: "比特币现在什么价", args: { symbol: "BTC", query: "比特币现在什么价" } },
  // web_fetch
  { tool: "web_fetch", action: "read", query: "读一下这个网页 https://example.com 的内容", args: { url: "https://example.com" } },
  { tool: "web_fetch", action: "inspect", query: "这个网页说了什么 https://example.com", args: { url: "https://example.com", question: "报名时间" } },
  { tool: "web_fetch", action: "navigate", query: "在这个网站里找一下报名入口 https://example.com", args: { url: "https://example.com", goal: "报名" } },
  { tool: "web_fetch", action: "raw", query: "调用这个接口拿数据 https://api.example.com", args: { url: "https://api.example.com", method: "POST", body: { a: 1 } } },
  // world.link
  { tool: "world.link", action: "list_friends", query: "看看我有哪些好友", args: {} },
  { tool: "world.link", action: "list_requests", query: "看看待处理的好友申请", args: {}, infer: false },
  { tool: "world.link", action: "send_request", query: "帮我加个好友", args: { targetName: "小满" } },
  { tool: "world.link", action: "respond_request", query: "同意这个人的好友申请", args: { requestId: "r1", accept: true } },
  { tool: "world.link", action: "send_message", query: "给好友发消息", args: { targetId: "u1", content: "在吗" } },
  // voice
  { tool: "voice", action: "speak", query: "把这段话念给我听", args: { text: "晚安" } },
  { tool: "voice", action: "message", query: "发一条语音消息给他", args: { action: "message", text: "晚安", targetId: "u1" }, infer: false },
  // phone
  { tool: "phone", action: "number", query: "我的虚拟号码是多少", args: {} },
  { tool: "phone", action: "call", query: "给我打个电话", args: { reason: "提醒开会" } },
  // agent
  { tool: "agent", action: "capabilities", query: "你能做什么", args: {} },
  { tool: "agent", action: "tasks", query: "我之前让你办的事到哪了", args: { status: "all" } },
  { tool: "agent", action: "update_identity", query: "把你的名字改成小满", args: { name: "小满" } },
  { tool: "agent", action: "update_homepage", query: "改一下你的主页简介", args: { bio: "你的私人助手" } },
  { tool: "agent", action: "profile", query: "你还记得我的资料吗", args: { keys: ["city"] } },
  // proactivity
  { tool: "proactivity", action: "confirm", query: "这个提议我批准了", args: { proposalId: "p1", decision: "accept" } },
  { tool: "proactivity", action: "feedback", query: "提醒太频繁了，别发了", args: { signal: "too_frequent" } },
  { tool: "proactivity", action: "why_silent", query: "你最近怎么没提醒我", args: { topic: "喝水" } },
  // care
  { tool: "care", action: "add", query: "记住我妈生日是5月20号", args: { name: "妈妈生日", date: "05-20" } },
  { tool: "care", action: "list", query: "我记了哪些重要日期", args: {} },
  { tool: "care", action: "delete", query: "把那个纪念日删掉", args: { id: "d1" } },
  // device
  { tool: "device", action: "list", query: "我有哪些绑定的设备", args: {} },
  { tool: "device", action: "use", query: "打开客厅摄像头", args: { deviceId: "cam1", command: "on" } },
  { tool: "device", action: "stream", query: "看一下家里的实时画面", args: { deviceId: "cam1" } },
  // aip
  { tool: "aip", action: "dispatch", query: "把这个任务派给配对的助手", args: { targetId: "peer1", content: "帮我查下快递" } },
  { tool: "aip", action: "state", query: "我的协作状态怎么样", args: {} },
  { tool: "aip", action: "proposal", query: "看一下对方的提案", args: { proposalId: "p2" } },
  // world
  { tool: "world", action: "status", query: "我在 Agent 世界的在线状态怎么样", args: {} },
  { tool: "world", action: "room_create", query: "给我开个房间", args: { name: "自习室" } },
  { tool: "world", action: "registry_challenge", query: "帮我拿一下开放注册的挑战题", args: {}, infer: false },
  { tool: "world", action: "registry_submit", query: "提交答案：42", args: { answer: "42" } },
];

const catalog = (() => {
  const prepared = prepareToolsWithToolSearch([], getBuiltinAgentChatTools());
  assert.equal(prepared.toolSearchActive, true, "内置工具集应激活 tool search");
  return prepared.deferredCatalog;
})();

async function discover(query: string, limit = 5): Promise<string[]> {
  const res = await executeToolSearchBridge("tool_discover", { query, limit }, catalog);
  assert.equal(res.ok, true, `tool_discover 应成功：${query}`);
  return ((res.result as { matches?: Array<{ name: string }> }).matches ?? []).map((m) => m.name);
}

test("schema 完整：每个 action 都出现在 enum 与描述里，且描述带触发语", () => {
  assert.equal(COMPOSITE_CHAT_TOOLS.length, COMPOSITE_ACTION_SPECS.length);
  for (const spec of COMPOSITE_ACTION_SPECS) {
    const schema = COMPOSITE_CHAT_TOOLS.find(
      (t) => (t.type === "function" ? t.function?.name : "") === spec.name,
    );
    assert.ok(schema, `缺少复合 schema: ${spec.name}`);
    const params = (schema!.function.parameters ?? {}) as {
      properties?: Record<string, { enum?: string[] }>;
    };
    const actionEnum = params.properties?.action?.enum ?? [];
    assert.deepEqual(
      [...actionEnum].sort(),
      spec.actions.map((a) => a.action).sort(),
      `${spec.name} 的 action enum 与实现不一致`,
    );
    const description = schema!.function.description ?? "";
    for (const { action, tool } of spec.actions) {
      assert.ok(description.includes(`${action}（`), `${spec.name} 描述缺少分支说明: ${action}`);
      // 检索以 schema 文本为索引：收编后的原工具名必须留在描述里，
      // 否则按旧名/英文名检索的入口会凭空消失（不再有代码别名表兜底）。
      assert.ok(
        description.includes(`原工具 ${tool}`),
        `${spec.name}.${action} 描述缺少原工具名 ${tool}`,
      );
    }
    assert.ok(spec.actions.some((a) => a.action === spec.defaultAction), `${spec.name} 兜底分支不存在`);
  }
});

test("召回可达：44 个 action 的代表性措辞都把所属复合工具排到第 1", async () => {
  const failures: string[] = [];
  for (const testCase of CASES) {
    const names = await discover(testCase.query);
    if (names[0] !== testCase.tool) {
      failures.push(
        `${testCase.tool}.${testCase.action}「${testCase.query}」→ #${names.indexOf(testCase.tool) + 1} ${names.slice(0, 4).join(",")}`,
      );
    }
  }
  assert.deepEqual(failures, [], `以下 action 召回未排第 1:\n${failures.join("\n")}`);
});

test("兜底路由：漏填 action 时只按参数签名或只读默认分支落位", () => {
  const failures: string[] = [];
  for (const testCase of CASES) {
    if (testCase.infer === false) continue;
    const { action: _omit, ...args } = testCase.args ?? {};
    const resolved = resolveCompositeAction(testCase.tool, args);
    const expected = testCase.fallback ?? testCase.action;
    if (resolved !== expected) {
      failures.push(`${testCase.tool}「${testCase.query}」期望 ${expected} 实得 ${resolved}`);
    }
  }
  assert.deepEqual(failures, [], `兜底路由错位:\n${failures.join("\n")}`);
});

test("转发正确：44 个 action 全部落到对应执行器，且 action 字段不透传", async () => {
  const executed: Array<{ tool: string; input: Record<string, unknown> }> = [];
  const handlers = new Map<string, (input: Record<string, unknown>, ctx: unknown) => Promise<unknown>>();
  const fakeRegistry = {
    register(name: string, handler: (input: Record<string, unknown>, ctx: unknown) => Promise<unknown>) {
      handlers.set(name, handler);
    },
    async execute(tool: string, input: Record<string, unknown>) {
      executed.push({ tool, input });
      return { result: { ok: true, tool } };
    },
  };
  registerCompositeTools(fakeRegistry as never);
  assert.equal(handlers.size, COMPOSITE_ACTION_SPECS.length, "复合 handler 数量应与声明一致");

  const expectedTool = new Map<string, string>();
  for (const spec of COMPOSITE_ACTION_SPECS) {
    for (const { action, tool } of spec.actions) expectedTool.set(`${spec.name}.${action}`, tool);
  }

  for (const testCase of CASES) {
    executed.length = 0;
    const handler = handlers.get(testCase.tool);
    assert.ok(handler, `缺少复合 handler: ${testCase.tool}`);
    const out = (await handler!({ action: testCase.action, ...(testCase.args ?? {}) }, {})) as {
      ok?: boolean;
    };
    assert.equal(executed.length, 1, `${testCase.tool}.${testCase.action} 应恰好转发一次`);
    assert.equal(
      executed[0]!.tool,
      expectedTool.get(`${testCase.tool}.${testCase.action}`),
      `${testCase.tool}.${testCase.action} 转发到错误执行器`,
    );
    assert.ok(
      !("action" in executed[0]!.input),
      `${testCase.tool}.${testCase.action} 不应把 action 透传给底层执行器`,
    );
    assert.equal(out.ok, true);
  }
});

test("非法 action：软降级到只读默认分支，不中断也不误触写操作", async () => {
  const executed: string[] = [];
  const handlers = new Map<string, (input: Record<string, unknown>, ctx: unknown) => Promise<unknown>>();
  const fakeRegistry = {
    register(name: string, handler: (input: Record<string, unknown>, ctx: unknown) => Promise<unknown>) {
      handlers.set(name, handler);
    },
    async execute(tool: string) {
      executed.push(tool);
      return { result: { ok: true } };
    },
  };
  registerCompositeTools(fakeRegistry as never);
  for (const spec of COMPOSITE_ACTION_SPECS) {
    const out = (await handlers.get(spec.name)!({ action: "nonsense" }, {})) as { ok?: boolean };
    assert.equal(out.ok, true, `${spec.name} 非法 action 应软降级`);
    const defaultTool = spec.actions.find((a) => a.action === spec.defaultAction)!.tool;
    assert.equal(executed.pop(), defaultTool, `${spec.name} 应降级到只读默认分支`);
  }
});
