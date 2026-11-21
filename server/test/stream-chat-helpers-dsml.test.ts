import assert from "node:assert/strict";
import test from "node:test";

import {
  consumeNormalizedStream,
  createStreamDsmlSanitizer,
  extractAllTextualToolCalls,
  extractDsmlToolCalls,
  extractHeuristicToolCalls,
  extractTextualToolCalls,
  pickVisibleText,
  stripDsmlToolCallMarkup,
  ToolIntentWithoutToolsError,
  type NormalChatChunk,
} from "../src/external-model/stream-chat-helpers.js";

const dsmlFetchWeb =
  "I will fetch the weather page.\n\n" +
  '< | | DSML | | tool_calls>\n' +
  '< | | DSML | | invoke name="fetch_web">\n' +
  '< | | DSML | | parameter name="url" string="true">https://www.weather.com.cn/weather/101010100.shtml</ | | DSML | | parameter>\n' +
  '</ | | DSML | | invoke>\n' +
  '</ | | DSML | | tool_calls>';

// 2026-09-11 01:34 用户截图原文：外层是 calls（非 tool_calls），invoke name="tool_call"，
// 真实工具名在 name 参数里（延迟目录桥 tool_call 的调用形态）。
const dsmlCallsVariant =
  '< | | DSML | | calls>\n' +
  '< | | DSML | | invoke name="tool_call">\n' +
  '< | | DSML | | parameter name="arguments" string="false">{"mode": "full"}</ | | DSML | | parameter>\n' +
  '< | | DSML | | parameter name="name" string="true">camera.take_photo</ | | DSML | | parameter>\n' +
  '</ | | DSML | | invoke>\n' +
  '</ | | DSML | | calls>';

test("extractDsmlToolCalls parses spaced Kimi DSML tool call markup", () => {
  const calls = extractDsmlToolCalls(dsmlFetchWeb);

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.name, "fetch_web");
  assert.deepEqual(JSON.parse(calls[0]?.argumentsChunk ?? "{}"), {
    url: "https://www.weather.com.cn/weather/101010100.shtml",
  });
});

test("extractDsmlToolCalls parses calls-wrapper bridge variant (2026-09-11 leak)", () => {
  const calls = extractDsmlToolCalls(dsmlCallsVariant);

  assert.equal(calls.length, 1);
  // 桥接形态：invoke name="tool_call"，真实工具名在 name 参数里
  assert.equal(calls[0]?.name, "tool_call");
  assert.deepEqual(JSON.parse(calls[0]?.argumentsChunk ?? "{}"), {
    arguments: '{"mode": "full"}',
    name: "camera.take_photo",
  });
});

test("stripDsmlToolCallMarkup removes spaced DSML blocks from visible text", () => {
  const cleaned = stripDsmlToolCallMarkup(dsmlFetchWeb);

  assert.equal(cleaned.includes("DSML"), false);
  assert.equal(cleaned.includes("fetch_web"), false);
  assert.equal(cleaned, "I will fetch the weather page.");
});

test("stripDsmlToolCallMarkup removes calls-wrapper variant completely", () => {
  const cleaned = stripDsmlToolCallMarkup(dsmlCallsVariant);

  assert.equal(cleaned, "");
});

test("consumeNormalizedStream turns DSML content into real tool calls", async () => {
  async function* source(): AsyncIterable<NormalChatChunk> {
    yield { content: dsmlFetchWeb, finishReason: "stop" };
  }

  const result = await consumeNormalizedStream(source());

  assert.equal(result.finishReason, "tool_calls");
  assert.equal(result.content, "I will fetch the weather page.");
  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0]?.name, "fetch_web");
});

test("consumeNormalizedStream recovers bridge calls from calls-wrapper variant", async () => {
  async function* source(): AsyncIterable<NormalChatChunk> {
    yield { content: dsmlCallsVariant, finishReason: "stop" };
  }

  const result = await consumeNormalizedStream(source());

  assert.equal(result.finishReason, "tool_calls");
  assert.equal(result.content, "");
  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0]?.name, "tool_call");
});

test("consumeNormalizedStream never streams DSML markup through onContentDelta", async () => {
  // 端到端不变量（2026-09-11 根修）：正文含 DSML 协议块时，流式 delta 不得出现
  // 任何协议标记/协议参数，而流末提取仍能拿到完整工具调用。
  async function* source(): AsyncIterable<NormalChatChunk> {
    // 按小切片喂入，模拟真实逐 token 流式（标记必然跨 chunk 断开）
    for (const piece of dsmlCallsVariant.match(/[\s\S]{1,7}/g) ?? []) {
      yield { content: piece, finishReason: null };
    }
    yield { content: "", finishReason: "stop" };
  }

  const deltas: string[] = [];
  const result = await consumeNormalizedStream(source(), {
    onContentDelta: (d) => deltas.push(d),
  });

  const streamed = deltas.join("");
  assert.equal(streamed.includes("DSML"), false, `delta 泄漏协议标记: ${streamed}`);
  assert.equal(
    streamed.includes("camera.take_photo"),
    false,
    `delta 泄漏工具名: ${streamed}`,
  );
  assert.equal(result.content.includes("DSML"), false);
  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.finishReason, "tool_calls");
});

test("createStreamDsmlSanitizer keeps prose around a closed DSML block", () => {
  const guard = createStreamDsmlSanitizer();
  const before = "好的，我先截个屏看看当前画面。";
  const after = "\n已经看到你的桌面了，稍等。";

  const out =
    guard.feed(before) +
    guard.feed(dsmlCallsVariant) +
    guard.feed(after) +
    guard.flush();

  assert.equal(out.includes(before), true, `丢失块前正文: ${out}`);
  assert.equal(out.includes(after.trim()), true, `丢失块后正文: ${out}`);
  assert.equal(out.includes("DSML"), false);
  assert.equal(out.includes("camera.take_photo"), false);
});

test("createStreamDsmlSanitizer drops unclosed protocol block to end of stream", () => {
  const guard = createStreamDsmlSanitizer();
  const lead = "让我看看。";
  const out =
    guard.feed(lead) +
    guard.feed('< | | DSML | | invoke name="tool_call">\n') +
    guard.feed('< | | DSML | | parameter name="name" string="true">camera.take_photo');

  assert.equal(out, lead);
  // 未闭合块：flush 丢弃残段，不吐协议
  assert.equal(guard.flush(), "");
});

test("createStreamDsmlSanitizer handles fullwidth pipe variant", () => {
  const guard = createStreamDsmlSanitizer();
  const fullwidth =
    '<｜｜DSML｜｜calls><｜｜DSML｜｜invoke name="tool_call">' +
    '<｜｜DSML｜｜parameter name="name" string="true">camera.take_photo' +
    '</｜｜DSML｜｜parameter></｜｜DSML｜｜invoke></｜｜DSML｜｜calls>';

  const out = guard.feed(fullwidth) + guard.flush();

  assert.equal(out.includes("DSML"), false);
  assert.equal(out.includes("camera.take_photo"), false);
});

test("createStreamDsmlSanitizer passes comparison prose through", () => {
  const guard = createStreamDsmlSanitizer();
  const prose = "如果 a < b 且 x > y，输出 5 < 3 的结果。";

  const out = guard.feed(prose) + guard.flush();

  assert.equal(out, prose);
});

test("ToolIntentWithoutToolsError carries extracted calls for escalation", () => {
  const calls = extractDsmlToolCalls(dsmlCallsVariant);
  const err = new ToolIntentWithoutToolsError({
    providerId: "openai-compatible",
    model: "test-model",
    toolCalls: calls,
  });

  assert.equal(err.name, "ToolIntentWithoutToolsError");
  assert.equal(err.toolCalls.length, 1);
  assert.equal(err.message.includes("desktop"), false);
  assert.equal(err.message.includes("tool_call"), true);
});

// 2026-09-12 回归锁：全角竖线版泄漏原文（「我桌面的抖音」任务实测，
// dist 未重建时旧代码整段透出）。extract + sanitize 必须双兜底。
const dsmlFullwidthLeak =
  '<｜｜DSML｜｜ calls>\n' +
  '<｜｜DSML｜｜ invoke name="tool_call">\n' +
  '<｜｜DSML｜｜ parameter name="arguments" string="false">{"mode": "full"}</｜｜DSML｜｜ parameter>\n' +
  '<｜｜DSML｜｜ parameter name="name" string="true">camera.take_photo</｜｜DSML｜｜ parameter>\n' +
  '</｜｜DSML｜｜ invoke>\n' +
  '</｜｜DSML｜｜ calls>';

test("extractDsmlToolCalls parses fullwidth-pipe calls variant (2026-09-12 task leak)", () => {
  const calls = extractDsmlToolCalls(dsmlFullwidthLeak);

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.name, "tool_call");
  assert.equal(
    JSON.parse(calls[0]?.argumentsChunk ?? "{}").name,
    "camera.take_photo",
  );
});

test("pickVisibleText reasoning fallback strips DSML markup (reasoner draft leak)", () => {
  // 思考模型把工具调用草稿写进 reasoning、content 为空：回退路径此前只剥 think，
  // 协议原文会整段泄漏进正式回复。
  const reasoning =
    "<think>用户想截图，我需要调用工具</think>\n" + dsmlFullwidthLeak;
  const visible = pickVisibleText("", reasoning);

  assert.equal(visible.includes("DSML"), false);
  assert.equal(visible.includes("camera.take_photo"), false);
  assert.equal(visible.includes("invoke"), false);
});

test("pickVisibleText still prefers non-empty content untouched", () => {
  const visible = pickVisibleText("正式回答", dsmlFullwidthLeak);
  assert.equal(visible, "正式回答");
});

/* ------------------------------------------------------------------ *
 * 通用 XML 文本形态（MiniMax M3 / Qwen 系，2026-10-07 线上泄漏扩面）    *
 * ------------------------------------------------------------------ */

// MiniMax-M3 2026-10-07 线上泄漏（「1分钟后提醒我吃饭」对话面轮次）：
// 模型幻觉出 reminder_plan/whenOffsetSeconds（注意与真实工具 reminder.plan 不同），
// 按 <tool_call><invoke><parameter> 训练格式写进 content，工具从未执行。
const minimaxXmlLeak =
  "王哥，1分钟后我叫你。我现在再帮你重新设一条。\n" +
  "<tool_call>\n" +
  '<invoke name="reminder_plan">\n' +
  '<parameter name="title">"王哥，吃饭啦"</parameter>\n' +
  '<parameter name="whenOffsetSeconds">60</parameter>\n' +
  "</invoke>\n" +
  "</tool_call>";

const minimaxWrappedVariant =
  "好的，马上设。\n" +
  "<minimax:tool_call>\n" +
  '<invoke name="reminder.plan">\n' +
  '<parameter name="text">1分钟后提醒我吃饭</parameter>\n' +
  "</invoke>\n" +
  "</minimax:tool_call>";

const qwenJsonVariant =
  "稍等。\n" +
  '<tool_call>\n{"name": "search_web", "arguments": {"query": "明天天气"}}\n</tool_call>';

test("extractTextualToolCalls parses MiniMax XML tool call (2026-10-07 leak)", () => {
  const calls = extractTextualToolCalls(minimaxXmlLeak);

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.name, "reminder_plan");
  assert.deepEqual(JSON.parse(calls[0]?.argumentsChunk ?? "{}"), {
    title: "王哥，吃饭啦",
    whenOffsetSeconds: 60,
  });
});

test("extractTextualToolCalls parses minimax:tool_call wrapped variant", () => {
  const calls = extractTextualToolCalls(minimaxWrappedVariant);

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.name, "reminder.plan");
  assert.deepEqual(JSON.parse(calls[0]?.argumentsChunk ?? "{}"), {
    text: "1分钟后提醒我吃饭",
  });
});

test("extractTextualToolCalls parses Qwen/Hermes JSON variant", () => {
  const calls = extractTextualToolCalls(qwenJsonVariant);

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.name, "search_web");
  assert.deepEqual(JSON.parse(calls[0]?.argumentsChunk ?? "{}"), {
    query: "明天天气",
  });
});

test("extractTextualToolCalls ignores prose with stray angle brackets", () => {
  const calls = extractTextualToolCalls("如果 a<b 且 x>y，就没问题。");
  assert.equal(calls.length, 0);
});

test("stripDsmlToolCallMarkup removes MiniMax XML block and keeps prose", () => {
  const cleaned = stripDsmlToolCallMarkup(minimaxXmlLeak);

  assert.equal(cleaned.includes("tool_call"), false);
  assert.equal(cleaned.includes("reminder_plan"), false);
  assert.equal(cleaned.includes("王哥，吃饭啦"), false);
  assert.equal(
    cleaned,
    "王哥，1分钟后我叫你。我现在再帮你重新设一条。",
  );
});

test("stripDsmlToolCallMarkup removes unclosed MiniMax block (truncated stream)", () => {
  const cleaned = stripDsmlToolCallMarkup(
    "马上设。<tool_call><invoke name=\"reminder_plan\"><parameter name=\"title\">王哥，吃饭啦",
  );

  assert.equal(cleaned, "马上设。");
});

test("consumeNormalizedStream turns MiniMax XML content into real tool calls", async () => {
  async function* source(): AsyncIterable<NormalChatChunk> {
    yield { content: minimaxXmlLeak, finishReason: "stop" };
  }

  const result = await consumeNormalizedStream(source());

  assert.equal(result.finishReason, "tool_calls");
  assert.equal(result.content, "王哥，1分钟后我叫你。我现在再帮你重新设一条。");
  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0]?.name, "reminder_plan");
});

test("consumeNormalizedStream never streams MiniMax XML markup through onContentDelta", async () => {
  // 端到端不变量：正文含通用 XML 协议块时，流式 delta 不得出现协议标记/参数，
  // 流末提取仍能拿到完整工具调用（与 DSML 同款锁）。
  async function* source(): AsyncIterable<NormalChatChunk> {
    for (const piece of minimaxXmlLeak.match(/[\s\S]{1,5}/g) ?? []) {
      yield { content: piece, finishReason: null };
    }
    yield { content: "", finishReason: "stop" };
  }

  const deltas: string[] = [];
  const result = await consumeNormalizedStream(source(), {
    onContentDelta: (d) => deltas.push(d),
  });

  const streamed = deltas.join("");
  assert.equal(streamed.includes("tool_call"), false, `delta 泄漏协议标记: ${streamed}`);
  assert.equal(streamed.includes("reminder_plan"), false, `delta 泄漏工具名: ${streamed}`);
  assert.equal(streamed.includes("吃饭啦"), false, `delta 泄漏参数值: ${streamed}`);
  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.finishReason, "tool_calls");
  assert.equal(result.content.includes("tool_call"), false);
});

test("createStreamDsmlSanitizer swallows MiniMax XML block between prose", () => {
  const guard = createStreamDsmlSanitizer();
  const before = "王哥，1分钟后我叫你。";
  const after = "\n设好了叫你。";

  const out =
    guard.feed(before) +
    guard.feed(minimaxXmlLeak.slice(before.length)) +
    guard.feed(after) +
    guard.flush();

  assert.equal(out.includes(before), true, `丢失块前正文: ${out}`);
  assert.equal(out.includes("设好了叫你"), true, `丢失块后正文: ${out}`);
  assert.equal(out.includes("tool_call"), false);
  assert.equal(out.includes("reminder_plan"), false);
});

/* ------------------------------------------------------------------ *
 * 根因方案（2026-10-08）：声明式注册表 + 结构启发式兜底                 *
 * —— 换模型不再人工适配：未注册格式同样能提取升级 / 净化剥离            *
 * ------------------------------------------------------------------ */

// 虚构厂商格式（未注册）：词根标签 + name 属性 + 自定义子标签参数
const unknownXmlVariant =
  "先查天气。<function_call name=\"weather.lookup\">\n" +
  '<arg name="city">北京</arg>\n' +
  "</function_call>";

// 虚构厂商 JSON 容器（无 name 属性，载荷含 name 键）
const unknownJsonVariant =
  "稍等。\n" +
  '<function_call>\n{"name": "hot_rankings", "arguments": {"scope": "weibo"}}\n</function_call>';

test("extractHeuristicToolCalls parses unregistered vendor XML format", () => {
  const calls = extractHeuristicToolCalls(unknownXmlVariant);

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.name, "weather.lookup");
  assert.deepEqual(JSON.parse(calls[0]?.argumentsChunk ?? "{}"), { city: "北京" });
});

test("extractHeuristicToolCalls parses unregistered vendor JSON payload", () => {
  const calls = extractHeuristicToolCalls(unknownJsonVariant);

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.name, "hot_rankings");
  assert.deepEqual(JSON.parse(calls[0]?.argumentsChunk ?? "{}"), { scope: "weibo" });
});

test("extractAllTextualToolCalls dedupes registered engine and heuristic hits", () => {
  const calls = extractAllTextualToolCalls(minimaxXmlLeak);

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.name, "reminder_plan");
  assert.deepEqual(JSON.parse(calls[0]?.argumentsChunk ?? "{}"), {
    title: "王哥，吃饭啦",
    whenOffsetSeconds: 60,
  });
});

test("extractAllTextualToolCalls recovers unregistered format end to end", () => {
  const calls = extractAllTextualToolCalls(unknownXmlVariant);

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.name, "weather.lookup");
});

test("consumeNormalizedStream never streams unregistered format markup through onContentDelta", async () => {
  // 端到端不变量（未注册格式）：流式 delta 不得出现协议标记/参数，流末提取
  // 仍能拿到完整工具调用——启发式流式识别（词根标签 + name 属性）生效。
  async function* source(): AsyncIterable<NormalChatChunk> {
    for (const piece of unknownXmlVariant.match(/[\s\S]{1,5}/g) ?? []) {
      yield { content: piece, finishReason: null };
    }
    yield { content: "", finishReason: "stop" };
  }

  const deltas: string[] = [];
  const result = await consumeNormalizedStream(source(), {
    onContentDelta: (d) => deltas.push(d),
  });

  const streamed = deltas.join("");
  assert.equal(streamed.includes("function_call"), false, `delta 泄漏协议标记: ${streamed}`);
  assert.equal(streamed.includes("weather.lookup"), false, `delta 泄漏工具名: ${streamed}`);
  assert.equal(streamed.includes("北京"), false, `delta 泄漏参数值: ${streamed}`);
  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0]?.name, "weather.lookup");
  assert.equal(result.finishReason, "tool_calls");
  assert.equal(result.content, "先查天气。");
});

test("stripDsmlToolCallMarkup removes unregistered format block and keeps prose", () => {
  const cleaned = stripDsmlToolCallMarkup(unknownXmlVariant);

  assert.equal(cleaned.includes("weather.lookup"), false);
  assert.equal(cleaned.includes("北京"), false);
  assert.equal(cleaned, "先查天气。");
});

test("stripDsmlToolCallMarkup removes unregistered JSON container", () => {
  const cleaned = stripDsmlToolCallMarkup(unknownJsonVariant);

  assert.equal(cleaned.includes("hot_rankings"), false);
  assert.equal(cleaned, "稍等。");
});

test("stripDsmlToolCallMarkup removes unclosed unregistered container (truncated stream)", () => {
  const cleaned = stripDsmlToolCallMarkup(
    '马上查。<function_call name="weather.lookup"><arg name="city">北京',
  );

  assert.equal(cleaned, "马上查。");
});

test("prose with HTML-like tags is not treated as tool calls", () => {
  // 防误伤：无词根命中的普通 HTML 标签（input 等）不进协议通道——提取零命中、
  // 流式原样透传、剥离原样返回。
  const prose = '参考：<input name="user">填这里</input>，谢谢。';

  assert.equal(extractHeuristicToolCalls(prose).length, 0);
  assert.equal(extractAllTextualToolCalls(prose).length, 0);
  const guard = createStreamDsmlSanitizer();
  assert.equal(guard.feed(prose) + guard.flush(), prose);
  assert.equal(stripDsmlToolCallMarkup(prose), prose);
});

/* ------------------------------------------------------------------ *
 * 留观机制（2026-10-08）：未注册「裸词根容器」的流式全防                 *
 * —— 无 name 属性的未知容器扣住待判：JSON 载荷/同名成对/带 name 子标签   *
 *    确认即转协议态吞掉；正文证据立即放行（宁可透出不吞正文）。           *
 * ------------------------------------------------------------------ */

test("createStreamDsmlSanitizer swallows unregistered no-attr JSON container (probation confirm)", async () => {
  // 端到端不变量：Qwen 式 JSON 载荷容器换任何标签名（未注册）都不透出 delta
  const leak =
    '<function_call>\n{"name": "hot_rankings", "arguments": {"scope": "weibo"}}\n</function_call>';
  async function* source(): AsyncIterable<NormalChatChunk> {
    for (const piece of leak.match(/[\s\S]{1,5}/g) ?? []) {
      yield { content: piece, finishReason: null };
    }
    yield { content: "", finishReason: "stop" };
  }

  const deltas: string[] = [];
  const result = await consumeNormalizedStream(source(), {
    onContentDelta: (d) => deltas.push(d),
  });

  const streamed = deltas.join("");
  assert.equal(streamed.includes("function_call"), false, `delta 泄漏协议标记: ${streamed}`);
  assert.equal(streamed.includes("hot_rankings"), false, `delta 泄漏工具名: ${streamed}`);
  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0]?.name, "hot_rankings");
  assert.equal(result.content, "");
});

test("createStreamDsmlSanitizer confirms probation via named child wrapper", () => {
  // 未注册外层包裹 + 已知形态子标签：整块吞掉
  const leak =
    '<wrap_call><invoke name="weather.lookup"><parameter name="city">北京</parameter></invoke></wrap_call>';
  const guard = createStreamDsmlSanitizer();
  const out =
    leak
      .match(/[\s\S]{1,7}/g)!
      .map((p) => guard.feed(p))
      .join("") + guard.flush();

  assert.equal(out, "");
  assert.equal(extractAllTextualToolCalls(leak).length, 1);
});

test("createStreamDsmlSanitizer releases prose following a bare toolish tag", () => {
  // 防误伤：正文里教学式提及裸词根标签，后续是正文文本 → 立即放行，原样透传
  const prose = "用 <function> 标签定义函数，然后 <call> 发起请求。";
  const guard = createStreamDsmlSanitizer();
  const out =
    prose
      .match(/[\s\S]{1,5}/g)!
      .map((p) => guard.feed(p))
      .join("") + guard.flush();

  assert.equal(out, prose);
});

test("createStreamDsmlSanitizer flush drops truncated JSON probation residue", () => {
  // 流在留观确认前被截断：已现 JSON 形态 → 按协议残渣丢弃
  const guard = createStreamDsmlSanitizer();
  let out = "";
  for (const piece of '<function_call>\n{"name": "hot_ra'.match(/[\s\S]{1,5}/g) ?? []) {
    out += guard.feed(piece);
  }
  out += guard.flush();
  assert.equal(out, "");
});

test("createStreamDsmlSanitizer flush releases lone bare tag prose", () => {
  // 流在裸标签后结束、无证据：按正文放行
  const guard = createStreamDsmlSanitizer();
  const out = guard.feed("正文提到 <function>") + guard.flush();
  assert.equal(out, "正文提到 <function>");
});
