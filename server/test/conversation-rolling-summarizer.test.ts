import assert from "node:assert/strict";
import test from "node:test";

import {
  createLlmRollingRecapSummarizer,
  extractSummarizableText,
  mergeKeyPins,
  parseRecapLinesFromLlmOutput,
  parseRecapSummaryOutput,
} from "../src/services/conversation-rolling-summarizer.js";
import { ChatThreadStore, buildMessageTimestampPrefix } from "../src/external-model/chat-thread-store.js";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";

// ── LLM 输出解析 ─────────────────────────────────────────────

test("parseRecapLinesFromLlmOutput: 兼容 `- 内容` 格式并去重限长限条数", () => {
  const output = [
    "- 用户偏好素食",
    "- 用户下周要出差",
    "- 用户偏好素食", // 重复
    "",
    "用户养了一只猫", // 无前缀
    "- 用户在学吉他",
    "- 这是非常长的一行内容，用来验证超过 120 字时的截断逻辑，aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  ].join("\n");

  const lines = parseRecapLinesFromLlmOutput(output, 3, 120);
  assert.deepEqual(lines, [
    "用户偏好素食",
    "用户下周要出差",
    "用户养了一只猫",
  ]);
  // 限制到 3 条，重复被去重
  assert.equal(lines.length, 3);
});

test("parseRecapLinesFromLlmOutput: 跳过代码块围栏", () => {
  const output = ["```", "- 用户偏好素食", "```"].join("\n");
  const lines = parseRecapLinesFromLlmOutput(output);
  assert.deepEqual(lines, ["用户偏好素食"]);
});

test("parseRecapLinesFromLlmOutput: 空输出返回空数组", () => {
  assert.deepEqual(parseRecapLinesFromLlmOutput(""), []);
  assert.deepEqual(parseRecapLinesFromLlmOutput("   \n  "), []);
});

// ── 关键钉（key pins）：LLM 输出解析 ─────────────────────────

test("parseRecapSummaryOutput: [关键钉] 节拆分摘要行与钉行", () => {
  const output = [
    "- [2026/09/05 周五 09:00] 用户讨论了旅行计划",
    "- [2026/09/05 周五 09:10] 用户下周去杭州出差",
    "[关键钉]",
    "- [2026/09/05 周五 09:00] 用户已确认：周六上午十点机场T3集合",
    "- [2026/09/05 周五 09:02] 用户明确偏好：不吃香菜",
  ].join("\n");
  const { lines, pins } = parseRecapSummaryOutput(output);
  assert.deepEqual(lines, [
    "[2026/09/05 周五 09:00] 用户讨论了旅行计划",
    "[2026/09/05 周五 09:10] 用户下周去杭州出差",
  ]);
  assert.deepEqual(pins, [
    "[2026/09/05 周五 09:00] 用户已确认：周六上午十点机场T3集合",
    "[2026/09/05 周五 09:02] 用户明确偏好：不吃香菜",
  ]);
});

test("parseRecapSummaryOutput: 无标记行时全部为摘要行（优雅降级），兼容 [key-pins] 别名", () => {
  assert.deepEqual(parseRecapSummaryOutput("- 摘要行1\n- 摘要行2"), {
    lines: ["摘要行1", "摘要行2"],
    pins: [],
  });
  const { lines, pins } = parseRecapSummaryOutput("- 摘要行\n[key-pins]\n- 钉行");
  assert.deepEqual(lines, ["摘要行"]);
  assert.deepEqual(pins, ["钉行"]);
});

test("parseRecapSummaryOutput: 钉行受每批上限约束", () => {
  const output = ["[关键钉]", "- 钉1", "- 钉2", "- 钉3", "- 钉4"].join("\n");
  const { pins } = parseRecapSummaryOutput(output, 30, 160, 3);
  assert.equal(pins.length, 3);
});

test("mergeKeyPins: 去重追加，超预算淘汰最旧、保留最新", () => {
  const existing = ["钉1", "钉2"];
  const merged = mergeKeyPins(existing, ["钉2 ", "钉3"], { maxLines: 3, maxChars: 1000 });
  assert.deepEqual(merged, ["钉1", "钉2", "钉3"], "新钉去重后追加在尾部");
  const evicted = mergeKeyPins(["钉1", "钉2", "钉3"], ["钉4"], { maxLines: 3, maxChars: 1000 });
  assert.deepEqual(evicted, ["钉2", "钉3", "钉4"], "超预算淘汰最旧的钉");
  const charCapped = mergeKeyPins(["a".repeat(50)], ["b".repeat(50), "c".repeat(50)], {
    maxLines: 10,
    maxChars: 60,
  });
  assert.deepEqual(charCapped, ["c".repeat(50)], "字符预算超限时同样淘汰最旧");
});

// ── 文本提取 ─────────────────────────────────────────────────

test("extractSummarizableText: 跳过 tool 消息、空内容、recap 自身，剥离时间戳前缀", () => {
  const ts = buildMessageTimestampPrefix(new Date());
  const user = {
    role: "user",
    content: `${ts}\n用户问天气`,
  } as ChatCompletionMessageParam;
  assert.equal(extractSummarizableText(user), "user: 用户问天气");

  assert.equal(extractSummarizableText({ role: "tool", content: "结果" } as ChatCompletionMessageParam), "");
  assert.equal(extractSummarizableText({ role: "user", content: "" } as ChatCompletionMessageParam), "");
  assert.equal(
    extractSummarizableText({ role: "assistant", content: "[session-recap]\n..." } as ChatCompletionMessageParam),
    "",
  );
  // 纯时间戳无内容
  assert.equal(
    extractSummarizableText({ role: "user", content: `${ts}\n  ` } as ChatCompletionMessageParam),
    "",
  );
});

// ── 工厂 ─────────────────────────────────────────────────────

test("createLlmRollingRecapSummarizer: 无 API key 返回 null（仅保留已有 recap 行）", () => {
  const prev = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    assert.equal(createLlmRollingRecapSummarizer(), null);
  } finally {
    if (prev != null) process.env.OPENAI_API_KEY = prev;
  }
});

test("createLlmRollingRecapSummarizer: 有 API key 返回可调用函数", () => {
  const prev = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "sk-test";
  try {
    const fn = createLlmRollingRecapSummarizer();
    assert.equal(typeof fn, "function");
  } finally {
    if (prev != null) process.env.OPENAI_API_KEY = prev;
  }
});

// ── ChatThreadStore 增强回写 ─────────────────────────────────

function makeTsMsg(role: "user" | "assistant", date: Date, text: string): ChatCompletionMessageParam {
  return { role, content: `${buildMessageTimestampPrefix(date)}\n${text}` } as ChatCompletionMessageParam;
}

/**
 * 构造一个触发近期窗口折叠的 thread（2026-09-05 策略）：
 * body > RECENT_WINDOW_MESSAGES(12) + RECAP_BATCH_MESSAGES(6) 才会折叠最旧一批进 recap。
 */
function buildFoldingThread(pairCount = 12): ChatCompletionMessageParam[] {
  const msgs: ChatCompletionMessageParam[] = [{ role: "system", content: "sys" }];
  const base = Date.now() - 3 * 86_400_000;
  for (let i = 0; i < pairCount; i++) {
    const at = new Date(base + i * 60_000);
    msgs.push(makeTsMsg("user", at, `第${i}轮用户消息`));
    msgs.push(makeTsMsg("assistant", at, `第${i}轮助手回复`));
  }
  return msgs;
}

/** 通过 thread(sessionId) 把数组登记进 store.history，模拟真实调用链（trimThread 回写依赖 history）。 */
function registeredThread(store: ChatThreadStore, sessionId: string): ChatCompletionMessageParam[] {
  const msgs = store.thread(sessionId, "");
  msgs.length = 0;
  msgs.push(...buildFoldingThread());
  return msgs;
}

/**
 * 再触发一次折叠：追加一批溢出消息后 trimThread。
 *
 * 2026-10-22 前缀缓存根修之后，LLM 增量摘要增强**不在完成时回写线程**，只暂存，
 * 等下一次折叠（前缀本来就要断的时机）才合入 recap。断言增强产物必须先进一次折叠。
 */
function foldOnceAgain(
  store: ChatThreadStore,
  msgs: ChatCompletionMessageParam[],
  sessionId: string,
  tag: string,
  pairs = 10,
): void {
  const at = new Date(Date.now() - 4 * 86_400_000);
  for (let i = 0; i < pairs; i++) {
    msgs.push(makeTsMsg("user", at, `${tag}-${i}号用户消息`));
    msgs.push(makeTsMsg("assistant", at, `${tag}-${i}号助手回复`));
  }
  store.trimThread(msgs, undefined, sessionId);
}

function findRecap(msgs: ChatCompletionMessageParam[]): ChatCompletionMessageParam | undefined {
  return msgs.find((m) => typeof m.content === "string" && m.content.includes("[session-recap]"));
}

test("ChatThreadStore: 折叠触发后同步兜底 recap + LLM 增强延后到下次折叠回写", async () => {
  const store = new ChatThreadStore(null);
  let enhanced: string[] | null = null;
  store.setRecapSummarizer(async (ctx) => {
    enhanced = ctx.droppedMessages.map((m) => extractSummarizableText(m)).filter(Boolean);
    return ["[3天前] 用户前天计划爬山（LLM增强）"];
  });

  const msgs = registeredThread(store, "session-a");
  store.trimThread(msgs, undefined, "session-a");

  // 同步路径：被折叠消息先生成原文兜底 recap（占位，防增强缺失时断层）
  const sys = msgs[0];
  const syncRecap = findRecap(msgs);
  assert.ok(sys && sys.role === "system");
  assert.ok(syncRecap, "折叠触发时应同步生成兜底 recap");
  assert.ok(
    typeof syncRecap?.content === "string" && syncRecap.content.includes("第0轮用户消息"),
    "兜底 recap 应包含被折叠消息原文",
  );

  // 异步增强完成：等待微任务
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(enhanced && enhanced.length > 0, "summarizer 应收到被丢弃的历史消息");
  assert.ok(enhanced!.some((l) => l.includes("第0轮")), "丢弃消息应包含最旧的对话");

  // 延后契约（前缀缓存根修）：两次折叠之间绝不改线程里的 recap，否则那轮对话白断一次全段缓存
  const recapDeferred = findRecap(msgs);
  assert.ok(
    typeof recapDeferred?.content === "string" && !recapDeferred.content.includes("LLM增强"),
    "增强完成后不得立即回写 recap（只暂存，等下一次折叠）",
  );

  // 下一次折叠 = 前缀本来就要断的时刻：暂存的增强在这里合入
  foldOnceAgain(store, msgs, "session-a", "延后落地");
  const recapAfter = findRecap(msgs);
  assert.ok(recapAfter, "折叠后应保留 recap 消息");
  assert.ok(
    typeof recapAfter?.content === "string" && recapAfter.content.includes("LLM增强"),
    "LLM 新行应在下一次折叠写入 recap 消息",
  );
});

test("ChatThreadStore: 增量合并——已有 recap 行原文保留，LLM 改写变体被事件级去重拒绝（漂移回归）", async () => {
  const store = new ChatThreadStore(null);
  store.setRecapSummarizer(async () => ["[今天] 用户要求晚上七点半提醒开线上会议（LLM改写）"]);

  const msgs = registeredThread(store, "session-drift");
  // 注入上一轮已生成的 recap 行（原文事实：七点）
  msgs.splice(1, 0, {
    role: "assistant",
    content:
      "[session-recap]\nEarlier conversation recap:\n- [今天] 用户要求晚上七点提醒开线上会议",
  } as ChatCompletionMessageParam);

  store.trimThread(msgs, undefined, "session-drift");
  await new Promise((r) => setTimeout(r, 10));

  const recap = msgs.find((m) => typeof m.content === "string" && m.content.includes("[session-recap]"));
  assert.ok(recap && typeof recap.content === "string");
  // 已有行必须原文保留——即使 LLM 返回了改写版
  assert.ok(
    recap.content.includes("用户要求晚上七点提醒开线上会议"),
    "已有 recap 行应原文保留，不被 LLM 重写漂移",
  );
  // 2026-09-08 收紧：LLM 的改写变体（七点→七点半）与已有行是同一事件，
  // 事件级去重直接拒绝——漂移连「追加变体行」的机会都没有（实测变体行
  // 逐轮繁殖会诱导 agent 反复重问已办成的事）。
  assert.ok(
    !recap.content.includes("七点半提醒开线上会议（LLM改写）"),
    "LLM 同一事件的改写变体应被事件级去重拒绝",
  );
});

test("ChatThreadStore: seq 防覆盖——期间有新 trim 时丢弃旧增强结果", async () => {
  const store = new ChatThreadStore(null);
  // 第一次调用返回受控 deferred（模拟慢 LLM），第二次立即返回
  let resolveFirst: (lines: string[]) => void = () => {};
  const firstCall = new Promise<string[]>((r) => {
    resolveFirst = r;
  });
  let callCount = 0;
  store.setRecapSummarizer(async () => {
    callCount += 1;
    if (callCount === 1) return firstCall; // 第一次慢
    return ["第二版增强"]; // 第二次快
  });

  const msgs = registeredThread(store, "session-b");
  store.trimThread(msgs, undefined, "session-b"); // 触发第一次增强（慢）

  // 期间又产生一批新历史消息并再次 trim → 触发第二次增强（快）
  const older = new Date(Date.now() - 4 * 86_400_000);
  for (let i = 0; i < 7; i++) {
    msgs.push(makeTsMsg("user", older, `追加第${i}轮用户消息`));
    msgs.push(makeTsMsg("assistant", older, `追加第${i}轮助手回复`));
  }
  store.trimThread(msgs, undefined, "session-b");

  // 等待第二次增强完成（结果暂存，尚未回写线程）
  await new Promise((r) => setTimeout(r, 20));
  foldOnceAgain(store, msgs, "session-b", "落地第二次增强");
  const recapAfterSecond = findRecap(msgs);
  assert.ok(
    typeof recapAfterSecond?.content === "string" && recapAfterSecond.content.includes("第二版增强"),
    "第二次增强应在下一次折叠回写",
  );

  // 现在放行第一次增强（慢的那个）——seq 已过期，必须被丢弃，不得覆盖第二版
  resolveFirst(["第一版增强"]);
  await new Promise((r) => setTimeout(r, 20));
  // 再折叠一次：过期结果若被误暂存/误回写，这一步就会暴露
  foldOnceAgain(store, msgs, "session-b", "过期增强复放");
  const recapFinal = findRecap(msgs);
  assert.ok(
    typeof recapFinal?.content === "string" && recapFinal.content.includes("第二版增强"),
    "旧增强结果（第一版）不得覆盖新增强结果",
  );
  assert.ok(
    !(typeof recapFinal?.content === "string" && recapFinal.content.includes("第一版增强")),
    "第一版增强应被丢弃",
  );
});

test("ChatThreadStore: summarizer 返回 null 时保留已有 recap 行", async () => {
  const store = new ChatThreadStore(null);
  store.setRecapSummarizer(async () => null); // 降级
  const msgs = registeredThread(store, "session-c");
  // 注入已有 recap 消息（模拟历史压缩），验证降级时保留
  msgs.splice(1, 0, {
    role: "assistant",
    content: "[session-recap]\nEarlier conversation recap:\n- [昨天] 用户查过天气",
  } as ChatCompletionMessageParam);

  store.trimThread(msgs, undefined, "session-c");
  await new Promise((r) => setTimeout(r, 10));

  const recap = msgs.find((m) => typeof m.content === "string" && m.content.includes("[session-recap]"));
  assert.ok(recap, "降级时保留已有 recap 行");
  assert.ok(
    typeof recap!.content === "string" && recap!.content.includes("查过天气"),
    "已有 recap 行内容应保留",
  );
});

test("ChatThreadStore: 未注入 summarizer 时保留已有 recap 行且不生成新摘要", () => {
  const store = new ChatThreadStore(null);
  const msgs = registeredThread(store, "session-d");
  msgs.splice(1, 0, {
    role: "assistant",
    content: "[session-recap]\nEarlier conversation recap:\n- [昨天] 用户出差",
  } as ChatCompletionMessageParam);
  store.trimThread(msgs, undefined, "session-d");
  const recap = msgs.find((m) => typeof m.content === "string" && m.content.includes("[session-recap]"));
  assert.ok(recap, "无 summarizer 时保留已有 recap 行");
  assert.ok(
    typeof recap!.content === "string" && recap!.content.includes("出差"),
    "已有 recap 行内容应保留",
  );
});

test("ChatThreadStore: 无已有 recap 行时 LLM 增强在下一次折叠插入到 system 之后", async () => {
  const store = new ChatThreadStore(null);
  store.setRecapSummarizer(async () => ["[3天前] 用户前天计划爬山（LLM摘要）"]);
  // 无已有 recap 的折叠线程：同步先生成兜底 recap，增强延后到下次折叠原位更新
  const msgs = registeredThread(store, "session-e");
  store.trimThread(msgs, undefined, "session-e");

  const syncRecap = findRecap(msgs);
  assert.ok(syncRecap, "折叠时应有同步兜底 recap");

  await new Promise((r) => setTimeout(r, 20));
  foldOnceAgain(store, msgs, "session-e", "增强落地");
  const after = findRecap(msgs);
  assert.ok(after, "LLM 增强落地后应保留 recap 消息");
  assert.ok(
    typeof after!.content === "string" && after!.content.includes("LLM摘要"),
    "增强后的 recap 应包含 LLM 摘要内容",
  );
  assert.equal(msgs.indexOf(after!), 1, "recap 应保持在 system 之后");
});

// ── 关键钉（key pins）：[关键钉] 区的写入与逐字保留 ──────────

const KEY_PINS_HEADER = "[关键钉] 不可忘的事实（逐字保留，禁止改写或遗忘）：";

test("ChatThreadStore: LLM 关键钉增量并入 [关键钉] 区，已有钉逐字保留（混合式布局）", async () => {
  const store = new ChatThreadStore(null);
  let capturedPins: string[] | undefined;
  store.setRecapSummarizer(async (ctx) => {
    capturedPins = [...(ctx.pinLines ?? [])];
    return {
      lines: ["[3天前] 用户前天计划爬山（LLM摘要）"],
      pins: ["[2026/09/05 周五 09:00] 用户已确认：周六上午十点机场T3集合"],
    };
  });

  const msgs = registeredThread(store, "session-pins");
  msgs.splice(1, 0, {
    role: "assistant",
    content: [
      "[session-recap]",
      "Earlier conversation recap:",
      "- [今天] 用户要求晚上七点提醒开线上会议",
      KEY_PINS_HEADER,
      "- [2026/09/04 周四 10:00] 用户明确偏好：素食",
    ].join("\n"),
  } as ChatCompletionMessageParam);

  store.trimThread(msgs, undefined, "session-pins");
  await new Promise((r) => setTimeout(r, 10));

  assert.ok(
    capturedPins?.some((l) => l.includes("素食")),
    "summarizer 应收到已有关键钉（去重参考）",
  );
  // 增强结果延后：下一次折叠才合入
  foldOnceAgain(store, msgs, "session-pins", "钉落地");
  const recap = findRecap(msgs);
  assert.ok(recap && typeof recap.content === "string");
  const content = recap.content;
  assert.ok(content.includes("用户明确偏好：素食"), "已有钉应逐字保留，不被 LLM 重写");
  assert.ok(content.includes("周六上午十点机场T3集合"), "LLM 新钉应增量并入");
  // 精确移除：只删本次增强吸收掉的那批待归纳原文，其后新折叠进来的行保留
  assert.ok(
    !content.includes("第0轮用户消息"),
    "增强已吸收的待归纳行应在折叠时移除（否则原文与摘要重复占位）",
  );
  assert.ok(
    content.includes("[unsummarized]"),
    "本次新滑出的窗口仍应有待归纳区（不被上一次增强误清）",
  );
  // 混合式布局：摘要区 → [关键钉] → 待归纳区
  const summaryIdx = content.indexOf("用户要求晚上七点提醒开线上会议");
  const pinIdx = content.indexOf("[关键钉]");
  const newPinIdx = content.indexOf("周六上午十点机场T3集合");
  assert.ok(summaryIdx >= 0 && pinIdx > summaryIdx && newPinIdx > pinIdx, "布局应为 摘要 → [关键钉] 钉行");
});

test("ChatThreadStore: 用户显式「要求记住」轮折叠时确定性自动钉入，且跨折叠轮保留", () => {
  const store = new ChatThreadStore(null);
  const sessionId = "session-autopin";
  const msgs = store.thread(sessionId, "system");
  msgs.length = 0;
  const base = Date.now() - 3 * 86_400_000;
  const at = (i: number) => new Date(base + i * 60_000);
  msgs.push({ role: "system", content: "sys" } as ChatCompletionMessageParam);
  msgs.push(makeTsMsg("user", at(0), "请记住我的部署密钥是 PIN_TOKEN_XYZ"));
  msgs.push(makeTsMsg("assistant", at(0), "好的，已记住。"));
  for (let i = 1; i <= 12; i++) {
    msgs.push(makeTsMsg("user", at(i), `普通消息${i}`));
    msgs.push(makeTsMsg("assistant", at(i), `好的${i}`));
  }
  store.trimThread(msgs, undefined, sessionId);

  const recap = msgs.find((m) => typeof m.content === "string" && m.content.includes("[session-recap]"));
  assert.ok(recap && typeof recap.content === "string", "折叠触发应生成 recap");
  const content = recap.content;
  assert.ok(content.includes(KEY_PINS_HEADER), "应有关键钉区");
  assert.ok(
    content.includes("请记住我的部署密钥是 PIN_TOKEN_XYZ"),
    "显式「要求记住」的轮次应逐字自动钉入（无 LLM 也不丢）",
  );
  const pinIdx = content.indexOf("[关键钉]");
  const unsumIdx = content.indexOf("[unsummarized]");
  assert.ok(pinIdx >= 0 && unsumIdx > pinIdx, "关键钉区应在摘要区之后、待归纳区之前");

  // 再折叠一批：关键钉应从旧 recap 提取→重渲染 round-trip 保留
  const older = new Date(Date.now() - 4 * 86_400_000);
  for (let i = 0; i < 7; i++) {
    msgs.push(makeTsMsg("user", older, `追加第${i}轮`));
    msgs.push(makeTsMsg("assistant", older, `收到${i}`));
  }
  store.trimThread(msgs, undefined, sessionId);
  const recap2 = msgs.find((m) => typeof m.content === "string" && m.content.includes("[session-recap]"));
  assert.ok(recap2 && typeof recap2.content === "string");
  assert.ok(
    recap2.content.includes("请记住我的部署密钥是 PIN_TOKEN_XYZ"),
    "关键钉应跨折叠轮保留",
  );
});

test("ChatThreadStore: 回忆性「记得」不触发自动钉（避免噪声）", () => {
  const store = new ChatThreadStore(null);
  const sessionId = "session-autopin-negative";
  const msgs = store.thread(sessionId, "system");
  msgs.length = 0;
  const base = Date.now() - 3 * 86_400_000;
  const at = (i: number) => new Date(base + i * 60_000);
  msgs.push({ role: "system", content: "sys" } as ChatCompletionMessageParam);
  msgs.push(makeTsMsg("user", at(0), "我记得上周好像说过这个事"));
  msgs.push(makeTsMsg("assistant", at(0), "嗯嗯。"));
  for (let i = 1; i <= 12; i++) {
    msgs.push(makeTsMsg("user", at(i), `闲聊${i}`));
    msgs.push(makeTsMsg("assistant", at(i), `哦${i}`));
  }
  store.trimThread(msgs, undefined, sessionId);
  const recap = msgs.find((m) => typeof m.content === "string" && m.content.includes("[session-recap]"));
  assert.ok(recap && typeof recap.content === "string");
  assert.ok(
    !recap.content.includes(KEY_PINS_HEADER),
    "回忆性「记得」不应钉入关键钉区",
  );
});
