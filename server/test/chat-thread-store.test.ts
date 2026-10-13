import test from "node:test";
import assert from "node:assert/strict";

import { ChatThreadStore, trimPreservingToolPairs } from "../src/external-model/chat-thread-store.js";

function buildStoreWithTurns(turns: number, maxThreadMessages?: number): ChatThreadStore {
  const store = new ChatThreadStore(null);
  const sessionId = "chat-thread-store-test";
  const systemPrompt = "system";

  for (let i = 1; i <= turns; i++) {
    const marker =
      i === 1
        ? "EARLY_SECRET=alpha-7319"
        : i === 10
          ? "TENTH_KEY=beta-4821"
          : i === 50
            ? "MIDDLE_KEY=gamma-2500"
            : "";

    store.appendTurn(
      sessionId,
      systemPrompt,
      {
        text: `user turn ${i} ${marker}`.trim(),
        clientMessageId: `u-${i}`,
      },
      `assistant turn ${i}`,
      maxThreadMessages,
      // clientMessageId 是 appendTurn 的第 7 个位置参数：只写进 userTurn 对象
      // 不会生效（appendTurn 不从 userTurn 读它），此前这里从未真正打上标记，
      // 导致按 id 定位（编辑/删除）的用例无法覆盖。
      undefined,
      `u-${i}`,
    );
  }

  return store;
}

test("default thread window keeps trimmed context via session recap", () => {
  const store = buildStoreWithTurns(100);
  const thread = store.thread("chat-thread-store-test", "system");
  const serialized = JSON.stringify(thread);

  // 2026-09-05 近期窗口策略：超过「窗口12+折叠批6」后，最旧消息折叠进
  // [session-recap]，原文仅保留最近 12 条（≈6 轮）。
  assert.ok(thread.length >= 13, `thread 应至少 13 条，实际 ${thread.length}`);
  // 裁剪后保留最近的消息（turn 89+ 应在窗口内）
  assert.match(serialized, /user turn 9\d/, "应保留最近的消息");
});

test("recent-window policy: 大 maxThreadMessages 下超窗内容折叠进 recap", () => {
  const store = buildStoreWithTurns(100, 200);
  const thread = store.thread("chat-thread-store-test", "system");
  const serialized = JSON.stringify(thread);

  // 2026-09-05 新契约：原文保留量按「近期窗口」而非 maxThreadMessages——
  // 超过 窗口(12)+折叠批(6) 即把最旧消息折叠进 [session-recap]。
  // 折叠按批触发 → 稳态窗口在 12~20 条间锯齿波动，thread = system + recap + 窗口。
  // maxThreadMessages 退化为兜底上限（token/条数超限时才生效）。
  assert.ok(thread.length <= 22, `thread 应 ≤ 22（system + recap + 窗口峰值20），实际 ${thread.length}`);
  assert.ok(serialized.includes("[session-recap]"), "应有 recap 摘要消息");
  // 折叠进 recap 的内容仍以原文占位行保留（turn 1 是最旧被折叠消息，进 recap 首行）
  assert.equal(serialized.includes("EARLY_SECRET=alpha-7319"), true);
  // 最近一轮原样保留
  assert.ok(serialized.includes("user turn 100"), "最近一轮应原文保留");
});

// ---- 滑动窗口 + 增量摘要（2026-09-05 新契约）----

test("增量摘要：LLM 合并成功后吸收待归纳区并清空 [unsummarized]", async () => {
  const store = new ChatThreadStore(null);
  const sessionId = "incremental-summary-test";
  let capturedExisting: string[] = [];
  let capturedPending: string[] = [];
  let sawPendingInInput = false;
  store.setRecapSummarizer(async (ctx) => {
    capturedExisting = [...ctx.existingLines];
    capturedPending = [...(ctx.pendingLines ?? [])];
    // 已有摘要行与待归纳原文行分字段传递（漂移修复契约）：待归纳原文是必须被吸收的素材
    sawPendingInInput = capturedPending.some((l) => l.includes("user turn 1"));
    return ["[2026/09/05 10:00] 合并后的关键事实"];
  });

  for (let i = 1; i <= 20; i++) {
    store.appendTurn(sessionId, "system", { text: `user turn ${i}` }, `assistant turn ${i}`, 200);
  }
  // enhanceRecap 为 fire-and-forget，等待微任务链完成
  await new Promise((resolve) => setImmediate(() => setImmediate(() => resolve(null))));

  const thread = store.thread(sessionId, "system");
  const recap = thread.find((m) => typeof m.content === "string" && m.content.includes("[session-recap]"));
  assert.ok(recap, "应存在摘要消息");
  const content = String(recap!.content);
  assert.ok(content.includes("合并后的关键事实"), `摘要区应替换为 LLM 合并结果，实际: ${content}`);
  assert.ok(!content.includes("[unsummarized]"), "待归纳区应被增量摘要吸收清空");
  assert.ok(sawPendingInInput, "合并输入应包含待归纳的原文占位行（不静默丢内容）");
  assert.ok(capturedExisting.length === 0, "已有摘要行不应混入待归纳素材（禁止 LLM 复述）");
  assert.ok(capturedPending.length > 0);
});

test("无摘要器降级：滑出窗口的内容以原文占位行保留在待归纳区，不静默丢失", () => {
  const store = new ChatThreadStore(null);
  const sessionId = "pending-fallback-test";
  for (let i = 1; i <= 20; i++) {
    store.appendTurn(sessionId, "system", { text: `FALLBACK_KEY_${i} 事件${i}` }, `assistant ${i}`, 200);
  }
  const serialized = JSON.stringify(store.thread(sessionId, "system"));
  assert.ok(serialized.includes("[unsummarized]"), "应存在待归纳区");
  assert.ok(serialized.includes("FALLBACK_KEY_1"), "最旧的滑出内容应以原文占位保留");
});

test("跨天恢复：recap 摘要块不被重打「刚刚」时间戳（时间感知）", () => {
  const recapContent =
    "[session-recap]\nEarlier conversation recap:\n- [2026/09/01 10:00] 用户提到计划A";
  const persisted = [
    { role: "user", content: "[ts:2026-09-01 09:58:00|周二|4d ago]\n你好" },
    { role: "assistant", content: recapContent },
  ];
  const store = new ChatThreadStore({
    loadRestoredMessages: () => persisted,
    scheduleSave: () => {},
    deleteSession: () => {},
  } as never);
  const thread = store.thread("restore-time-test", "system");
  const recap = thread.find((m) => typeof m.content === "string" && m.content.includes("[session-recap]"));
  assert.ok(recap, "恢复后应存在摘要消息");
  const content = String(recap!.content);
  assert.ok(!content.startsWith("[ts:"), `摘要块恢复时不应被打上当前时间戳（会被模型当「刚刚」），实际: ${content.slice(0, 60)}`);
  assert.ok(content.includes("[2026/09/01 10:00]"), "摘要行绝对时间标签应原样保留");
});

test("跨天恢复：存量 recap 的相对标签按旧 ts 帧锚点迁移为绝对日期（时间感知）", () => {
  // 旧版数据：折叠日 2026-09-03 落盘的相对标签行 + 旧版恢复时打的 [ts:] 帧
  const recapContent =
    "[session-recap]\nEarlier conversation recap:\n- [今天] 用户要出差杭州\n- [昨天] 完成V1交付";
  const persisted = [
    {
      role: "assistant",
      content: `[ts:2026-09-03 18:00:00|周四|2d ago]\n${recapContent}`,
    },
  ];
  const store = new ChatThreadStore({
    loadRestoredMessages: () => persisted,
    scheduleSave: () => {},
    deleteSession: () => {},
  } as never);
  const thread = store.thread("legacy-label-migrate-test", "system");
  const recap = thread.find((m) => typeof m.content === "string" && m.content.includes("[session-recap]"));
  assert.ok(recap, "恢复后应存在摘要消息");
  const content = String(recap!.content);
  assert.ok(
    content.includes("[2026/09/03 周四] 用户要出差杭州"),
    `「今天」应按锚点(09-03)换算为绝对日期，实际: ${content}`
  );
  assert.ok(
    content.includes("[2026/09/02 周三] 完成V1交付"),
    `「昨天」应按锚点(09-03)换算为绝对日期，实际: ${content}`
  );
  assert.ok(!content.includes("[今天]") && !content.includes("[昨天]"), "不应残留相对标签");
});

// ---- pin 回填（滑动窗口驱逐 → 优先级驱逐）----

test("trimPreservingToolPairs: 显式记忆轮被 pin 保留，驱逐发生在最旧的非 pin 组", () => {
  const msgs: Array<{ role: string; content: string }> = [];
  // 早期用户显式记忆轮（pin 目标）
  msgs.push({ role: "user", content: "请记住我的部署密钥是 PIN_TOKEN_XYZ" });
  // 20 条新闲聊（填充窗口）
  for (let i = 1; i <= 20; i++) {
    msgs.push({ role: "user", content: `filler question ${i}` });
    msgs.push({ role: "assistant", content: `ack ${i}` });
  }

  // 预算 11：尾部贪心装 11 条（index 10..20），pin 组（1 条）需要驱逐最旧已选组腾位
  const { kept, dropped } = trimPreservingToolPairs(
    msgs as never[],
    11,
  );
  const serialized = JSON.stringify(kept);
  assert.ok(serialized.includes("PIN_TOKEN_XYZ"), "显式记忆轮应被 pin 保留");
  assert.ok(dropped.length > 0, "应发生驱逐");
  // 被驱逐的是最旧的已选非 pin 组（index 10），而非 pin 组本身或最近尾部
  assert.ok(!serialized.includes("filler question 10"), "最旧已选非 pin 组应被驱逐腾位");
  assert.ok(serialized.includes("filler question 20"), "最近尾部应完整保留");
  // 时序保持：保留消息按原顺序
  const indexes = kept.map((m) => msgs.indexOf(m as never));
  assert.deepEqual(indexes, [...indexes].sort((a, b) => a - b));
  // 预算不超
  assert.ok(kept.length <= 11, `kept 应 ≤ maxMessages，实际 ${kept.length}`);
});

test("trimPreservingToolPairs: 无 pin 时保持原尾部截断行为", () => {
  const msgs: Array<{ role: string; content: string }> = [];
  for (let i = 1; i <= 10; i++) {
    msgs.push({ role: "user", content: `plain user ${i}` });
    msgs.push({ role: "assistant", content: `plain ack ${i}` });
  }
  const { kept, dropped } = trimPreservingToolPairs(msgs as never[], 8);
  assert.equal(kept.length, 8);
  assert.equal(dropped.length, 12);
  const serialized = JSON.stringify(kept);
  assert.ok(serialized.includes("plain user 10"), "最近内容保留");
  assert.ok(!serialized.includes("plain user 1 "), "最旧内容被截断");
});

// ---- 条内压缩防过度压缩护栏 ----

import { compressAssistantTextForWindow } from "../src/external-model/chat-thread-store.js";

function padText(prefix: string, totalChars: number): string {
  let t = prefix;
  const filler = "这是一个普通的陈述句。";
  while (t.length < totalChars) t += filler;
  return t.slice(0, totalChars);
}

test("compressAssistantTextForWindow: 句子边界对齐 + 标记前缀 + 幂等兼容", () => {
  // 头窗口在句中截断 → 应回退到上一个句末标点
  const headSentence = "开头结论句子，说明处理结果。";
  const text = padText(headSentence + "后面这半句没有标点结尾会被回退掉", 600)
    + "中段填充内容，" .repeat(40)
    + "结尾句子完整收束。补充的尾巴内容没有标点也无所谓";
  const result = compressAssistantTextForWindow(text, 200);
  assert.ok(result, "超长文本应被压缩");
  assert.ok(result!.startsWith("[已压缩·"), "应带压缩标记（幂等检查依赖此前缀）");
  assert.ok(result!.includes(" … "), "应保留头尾结构");
  // 头段应以句末标点收束（边界对齐生效）
  const headPart = result!.split(" … ")[0]!;
  assert.ok(/[。！？!?…]$/.test(headPart.replace(/^\[已压缩·\d+字符→\d+\]\s*/, "")), `头段应对齐句末标点，实际尾字符: ${headPart.slice(-4)}`);
  assert.ok(result!.length < text.length, "压缩应有收益");
});

test("compressAssistantTextForWindow: 短文本/无收益时不压缩", () => {
  assert.equal(compressAssistantTextForWindow("短文本", 800), null, "不超阈值不压缩");
  // maxChars < 200 直接拒绝（防误配过度压缩）
  assert.equal(compressAssistantTextForWindow(padText("内容。", 500), 100), null);
});

test("compressOversizedAssistantMessages: 承诺轮与代码块消息不压缩，普通长回复压缩", () => {
  const store = new ChatThreadStore(null);
  const compress = (store as unknown as {
    compressOversizedAssistantMessages: (msgs: never[], maxChars: number) => void;
  }).compressOversizedAssistantMessages.bind(store);

  const commitment = padText("我会帮你每天早上八点提醒你喝水，这是承诺内容的一部分。", 1200);
  const codeMsg = "这是你要的代码：\n```js\n" + padText("const x = 1;", 1200) + "\n```";
  const ordinary = padText("这是一段普通的超长分析陈述。", 1200);
  const shortAck = "好的。";

  const msgs: Array<{ role: string; content: string }> = [
    { role: "system", content: "sys" },
    { role: "assistant", content: commitment },
    { role: "assistant", content: codeMsg },
    { role: "assistant", content: ordinary },
    { role: "user", content: "追问" },
    { role: "assistant", content: shortAck },
    { role: "user", content: "再问" },
    { role: "assistant", content: shortAck },
  ];
  compress(msgs as never[], 800);

  assert.ok(msgs[1]!.content === commitment, "承诺/结论轮不应被压缩");
  assert.ok(msgs[2]!.content === codeMsg, "含代码围栏的消息不应被压缩");
  assert.ok(String(msgs[3]!.content).startsWith("[已压缩·"), "普通超长回复应被压缩");
  // 最近 2 轮（preserveRecentTurns=2 → 末 4 条）全量保留：末尾短消息天然不受影响
  assert.ok(msgs[7]!.content === shortAck);
});

test("compressOversizedAssistantMessages: 最近 N 轮全量保留，幂等不二次压缩", () => {
  const store = new ChatThreadStore(null);
  const compress = (store as unknown as {
    compressOversizedAssistantMessages: (msgs: never[], maxChars: number) => void;
  }).compressOversizedAssistantMessages.bind(store);

  const long = padText("普通长回复内容。", 1200);
  const msgs: Array<{ role: string; content: string }> = [
    { role: "system", content: "sys" },
    { role: "assistant", content: long },
    { role: "user", content: "u2" },
    { role: "assistant", content: long },
    { role: "user", content: "u3" },
    { role: "assistant", content: long },
    { role: "user", content: "u4" },
    { role: "assistant", content: long },
  ];
  // msgs.length=8, recentStart = 8 - 2*2 = 4 → 压缩范围 index 1..3（老轮），
  // 最近 2 轮 = 末 4 条（index 4..7）全量保留
  compress(msgs as never[], 800);
  assert.ok(String(msgs[1]!.content).startsWith("[已压缩·"), "老轮应被压缩");
  assert.ok(String(msgs[3]!.content).startsWith("[已压缩·"), "老轮应被压缩（recentStart 之前）");
  assert.ok(msgs[5]!.content === long && msgs[7]!.content === long, "最近轮全量保留");

  // 幂等：再跑一遍不再变化
  const snapshot = JSON.stringify(msgs);
  compress(msgs as never[], 800);
  assert.equal(JSON.stringify(msgs), snapshot, "已压缩内容不应二次压缩");
});

// ── 2026-09-13 回归：无时间戳的历史消息恢复时不得兜底打「当前时间」帧 ──
// 背景：客户端桥灌入/极旧的存量消息没有 [ts:] 帧，旧逻辑用 `?? now` 兜底，
// 把整段历史盖成「just now」，模型把昨天的错误回答当成刚发生的对话事实复读。
test("restore: 无时间戳的历史消息保持无帧，不得伪装成 just now", () => {
  const legacy = [
    { role: "user", content: "我老婆最近在那" },
    { role: "assistant", content: "刘浩存今天在成都——她今天在成都有品牌活动。" },
  ];
  const persistence = {
    loadRestoredMessages: (sessionId: string) => legacy.map((m) => ({ ...m })),
    scheduleSave: () => {},
  };
  const store = new ChatThreadStore(persistence as never);
  const thread = store.thread("restore-ts-frame-test", "system");
  const body = thread.filter((m) => m.role === "user" || m.role === "assistant");
  assert.ok(body.length >= 2, "恢复的消息应保留");
  for (const m of body) {
    const text = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
    assert.doesNotMatch(
      text,
      /\[ts:[^\]]*just now\]/,
      "无时间戳的历史消息不能被打上 just now 帧",
    );
    assert.doesNotMatch(
      String(text).split("\n")[0] ?? "",
      /^\[ts:/,
      "无时间戳的历史消息恢复时不应被补当前时间帧",
    );
  }
});

// ── 2026-10-04：按轮次删除（客户端「删除这一轮对话」按钮的服务侧契约）──
// 背景：该按钮此前只能发 chat.clear_history（= clearAllMemoryForActor），
// 删一条消息会把整个会话线程 + 全部 Agent 记忆清空。deleteTurn 只摘掉这一轮，
// 其余历史上下文与记忆必须原样保留。
test("deleteTurn: 只摘掉指定轮次，前后轮次上下文原样保留", () => {
  const store = buildStoreWithTurns(3);
  const sessionId = "chat-thread-store-test";

  const result = store.deleteTurn(sessionId, "u-2");
  assert.equal(result.ok, true, "已知 clientMessageId 应命中");
  assert.equal(result.removed, 2, "一轮 = user 消息 + 该轮 assistant 回复");

  const serialized = JSON.stringify(store.thread(sessionId, "system"));
  assert.doesNotMatch(serialized, /user turn 2/, "被删的这一轮不应残留");
  assert.doesNotMatch(serialized, /assistant turn 2/, "被删的这一轮回复不应残留");
  assert.match(serialized, /user turn 1/, "更早的轮次必须保留");
  assert.match(serialized, /user turn 3/, "更晚的轮次必须保留");
});

test("deleteTurn: 一轮含多条 assistant 气泡时整轮一起摘除", () => {
  const store = buildStoreWithTurns(2);
  const sessionId = "chat-thread-store-test";
  // 同一轮追加一条后续气泡（分泡/卡片回执等场景）
  store.appendAssistantFollowup(sessionId, "u-1", "assistant turn 1 的补充气泡");

  const result = store.deleteTurn(sessionId, "u-1");
  assert.equal(result.ok, true);
  assert.equal(result.removed, 3, "user + 主回复 + 补充气泡应整轮摘除");

  const serialized = JSON.stringify(store.thread(sessionId, "system"));
  assert.doesNotMatch(serialized, /assistant turn 1/, "该轮所有回复气泡都应消失");
  assert.match(serialized, /user turn 2/, "后续轮次不受影响");
});

test("deleteTurn: 未知 messageId / 空 id 不误删，返回原因码", () => {
  const store = buildStoreWithTurns(2);
  const sessionId = "chat-thread-store-test";

  assert.deepEqual(
    store.deleteTurn(sessionId, "u-999"),
    { ok: false, reason: "message_not_found" },
  );
  assert.deepEqual(
    store.deleteTurn(sessionId, ""),
    { ok: false, reason: "missing_message_id" },
  );
  assert.deepEqual(
    store.deleteTurn("no-such-session", "u-1"),
    { ok: false, reason: "session_not_found" },
  );

  const serialized = JSON.stringify(store.thread(sessionId, "system"));
  assert.match(serialized, /user turn 1/, "未命中时不得动任何历史");
  assert.match(serialized, /user turn 2/, "未命中时不得动任何历史");
});

// ── 迁移兜底（2026-10-04）：clientMessageId 落盘之前的历史轮次，只能按原文定位 ──
// 场景：本功能上线前落盘的线程没有 __clientMessageId 字段，服务端重启后按 id 找不到该轮，
// 客户端同时带上被删消息原文 → 按纯文本唯一命中兜底，否则存量历史在服务端永远删不掉。

test("deleteTurn: 按 id 定位不到时，按原文唯一命中兜底（旧线程）", () => {
  const store = new ChatThreadStore(null);
  const sessionId = "chat-thread-store-test";
  // 不传 clientMessageId —— 等价于「重启后从磁盘恢复、旧消息没有 id 标记」
  store.appendTurn(sessionId, "system", { text: "user turn 1" }, "assistant turn 1");
  store.appendTurn(sessionId, "system", { text: "user turn 2" }, "assistant turn 2");

  const result = store.deleteTurn(sessionId, "msg-from-old-build", "user turn 2");
  assert.equal(result.ok, true, "原文唯一命中时应兜底删除");
  assert.equal(result.removed, 2);

  const serialized = JSON.stringify(store.thread(sessionId, "system"));
  assert.doesNotMatch(serialized, /user turn 2/, "兜底也应整轮摘除");
  assert.match(serialized, /user turn 1/, "其余轮次必须保留");
});

test("deleteTurn: 原文命中多条时拒绝兜底（宁可不删也不删错轮次）", () => {
  const store = new ChatThreadStore(null);
  const sessionId = "chat-thread-store-test";
  store.appendTurn(sessionId, "system", { text: "帮我看下天气" }, "assistant A");
  store.appendTurn(sessionId, "system", { text: "帮我看下天气" }, "assistant B");

  const result = store.deleteTurn(sessionId, "msg-from-old-build", "帮我看下天气");
  assert.deepEqual(result, { ok: false, reason: "ambiguous_text_match" });

  const serialized = JSON.stringify(store.thread(sessionId, "system"));
  assert.match(serialized, /assistant A/, "歧义时任何一轮都不得被删");
  assert.match(serialized, /assistant B/, "歧义时任何一轮都不得被删");
});

test("deleteTurn: 原文兜底不覆盖按 id 命中的精确语义", () => {
  const store = buildStoreWithTurns(2);
  const sessionId = "chat-thread-store-test";

  // 原文给了「user turn 1」（另一轮），id 指向 u-2 → 必须按 id 删 u-2
  const result = store.deleteTurn(sessionId, "u-2", "user turn 1");
  assert.equal(result.ok, true);
  assert.equal(result.removed, 2);

  const serialized = JSON.stringify(store.thread(sessionId, "system"));
  assert.doesNotMatch(serialized, /assistant turn 2/, "被 id 指向的轮次应被删除");
  assert.match(serialized, /user turn 1/, "原文指向的轮次不得被误删");
});

// ── 2026-10-11：中断占位帧的摘录脱敏（无括号/单行，保证可被整行剥离）─────
test("foldCompletedToolChains：占位帧摘录展平 JSON 括号，帧保持单行", async () => {
  const { foldCompletedToolChains } = await import("../src/external-model/chat-thread-store.js");
  const msgs = [
    { role: "user", content: "帮我查一下" },
    {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "t1", type: "function", function: { name: "search_web", arguments: "{}" } }],
    },
    {
      role: "tool",
      tool_call_id: "t1",
      content: '[不可信内容围栏 source=tool:search_web]{"ok":true,"results":[{"title":"a","url":"https://x.com/[a]"}]}\n第二行噪音',
    },
  ] as unknown as Parameters<typeof foldCompletedToolChains>[0];
  const changed = foldCompletedToolChains(msgs);
  assert.equal(changed, true);
  const last = msgs[msgs.length - 1];
  const content = String(last?.content ?? "");
  assert.ok(content.startsWith("[上一轮回复中断"), "应折叠为占位帧");
  assert.ok(!content.includes("\n"), "占位帧必须单行（多行会让帧剥离器只删首行）");
  assert.ok(!content.includes("{"), "摘录不得携带原始 JSON 花括号");
  assert.ok(!content.slice(1).includes("["), "除帧头外不得再出现方括号（JSON 数组括号会让帧剥离器提前截断）");
  assert.ok(!content.includes("不可信内容围栏"), "围栏标签不得进入摘录");
  assert.ok(content.includes("search_web"), "工具名事实保留");
});
