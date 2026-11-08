/**
 * 2026-09-06 P1/P2/P3 根源修复回归测试。
 *
 * 背景（turn-wal 2026-09-06 实录）：
 *  - "今天天气怎么样" → 前台零工具，模型闪避"没实时数据/让系统去查"，无任何工具调用；
 *  - "小弟"（两字称呼）→ 模型把悬空天气旧话题当最新消息重新回答（串台）。
 * 本文件锁定三类修复的行为契约：
 *  - P1 渠道会话隔离（master-chat-session）；
 *  - P2 短期记忆卫生（TTL/结清/承诺收紧/使命失效/短 ping 防带跑）；
 *  - P3 主会话线程持久化（chat-thread-persist.shouldPersistChatThread）。
 * 原 P0 闪避闸（commitment-gate.isDeflectionStyleFallback）随该模块删除而移除
 * （2026-09-13：「要不要工具」收敛到 L1 语义前置路由 + 程序化前置检索，
 *  词面闪避闸退出历史；「她最近在那」类轮次由 routeSearchQuery 先搜后答承接）。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const {
  isChannelScopedSessionId,
  isChannelSessionIsolationEnabled,
  resolveChannelScopedSessionId,
} = await import("../src/agent/master-chat-session.js");
const { shouldPersistChatThread } = await import("../src/external-model/chat-thread-persist.js");
const { ShortTermMemoryGatewayService } = await import(
  "../src/services/short-term-memory-gateway.js"
);

function tempFile(name: string): string {
  return join(mkdtempSync(join(tmpdir(), "stm-hygiene-")), name);
}

/* ── P1：渠道会话隔离 ───────────────────────────────────────────── */

test("P1 渠道隔离：渠道归一化且同渠道稳定、异渠道必然不同", () => {
  const a = resolveChannelScopedSessionId("session-mvp-001", "wechat");
  const b = resolveChannelScopedSessionId("session-mvp-001", "WeChat");
  const c = resolveChannelScopedSessionId("session-mvp-001", "飞书 群");
  assert.equal(a, "session-mvp-001@wechat");
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.match(c, /@[\w-]+$/);
});

test("P1 渠道隔离：形态判定与开关", () => {
  assert.equal(isChannelScopedSessionId("session-mvp-001@wechat"), true);
  assert.equal(isChannelScopedSessionId("session-mvp-001"), false);
  const prev = process.env.AGENT_CHANNEL_SESSION_ISOLATION;
  try {
    delete process.env.AGENT_CHANNEL_SESSION_ISOLATION;
    assert.equal(isChannelSessionIsolationEnabled(), true, "默认开启");
    process.env.AGENT_CHANNEL_SESSION_ISOLATION = "0";
    assert.equal(isChannelSessionIsolationEnabled(), false, "可回退");
  } finally {
    if (prev === undefined) delete process.env.AGENT_CHANNEL_SESSION_ISOLATION;
    else process.env.AGENT_CHANNEL_SESSION_ISOLATION = prev;
  }
});

/* ── P3：主会话线程持久化 ───────────────────────────────────────── */

test("P3 持久化：裸 actorId 主会话线程必须落盘（chat-threads.json 空洞的根因）", () => {
  // 2026-08-29 起 resolvePrimaryChatSessionId 返回裸 actorId；
  // 旧过滤在 masterDelegation.enabled（配了外部模型密钥即默认 true）时把
  // 唯一的主会话线程判为不持久化 → 重启丢全部对话历史。
  assert.equal(shouldPersistChatThread("session-mvp-001"), true);
  assert.equal(shouldPersistChatThread("session-mvp-001@wechat"), true);
  assert.equal(shouldPersistChatThread("master:session-mvp-001"), true);
  assert.equal(shouldPersistChatThread("notes:session-mvp-001"), true);
});

test("P3 持久化：子 Agent / Plan-Execute 临时线程仍然排除", () => {
  assert.equal(shouldPersistChatThread("subagent-tech-1"), false);
  assert.equal(shouldPersistChatThread("session-mvp-001\u007fpe\u007fabc"), false);
  assert.equal(shouldPersistChatThread("master-delegate:session-mvp-001"), false);
  assert.equal(shouldPersistChatThread(""), false);
});

/* ── P2：短期记忆卫生 ───────────────────────────────────────────── */

test("P2 承诺收紧：过去式闲聊不入承诺栈，未来动作入栈", () => {
  const service = new ShortTermMemoryGatewayService(tempFile("hygiene.json"));
  const sessionId = "session-commitment-test";

  service.reconcileTaskAfterTurn(sessionId, "哈哈你被我将了一军", "哎哟，被我将了一军。你这招真狠。");
  service.reconcileTaskAfterTurn(sessionId, "大哥，你这一开问就是俩瓜啊", "这瓜保熟。");
  const state: any = (service as any).data.sessions[sessionId];
  assert.equal(state.conversationMemory.agentCommitments.length, 0, "闲聊句不得入承诺栈");

  service.reconcileTaskAfterTurn(sessionId, "那个材料什么时候给我", "明天发你。");
  assert.ok(
    state.conversationMemory.agentCommitments.some((line: string) => line.includes("明天发你")),
    "第一人称未来动作必须入承诺栈",
  );
});

test("P2 结清：助手回复正面完成的事项从挂起栈移除", () => {
  const service = new ShortTermMemoryGatewayService(tempFile("hygiene.json"));
  const sessionId = "session-settle-test";

  service.reconcileTaskAfterTurn(sessionId, "帮我搜索刘浩存最近的照片", "行，我这就去搜。");
  const state: any = (service as any).data.sessions[sessionId];
  assert.ok(
    state.conversationMemory.openLoops.some((line: string) => line.includes("刘浩存")),
    "请求未处理前进 openLoops",
  );

  service.reconcileTaskAfterTurn(
    sessionId,
    "搜到了吗",
    "刘浩存最近的照片帮你搜好了，这都是她这周的公开活动图。",
  );
  assert.equal(
    state.conversationMemory.openLoops.filter((line: string) => line.includes("刘浩存")).length,
    0,
    "助手正面完成该请求后 openLoop 应结清",
  );
});

test("P2 TTL：过期挂起项不再注入 prompt", async () => {
  const prev = process.env.AGENT_STM_LOOP_TTL_MS;
  process.env.AGENT_STM_LOOP_TTL_MS = "30";
  try {
    const service = new ShortTermMemoryGatewayService(tempFile("hygiene.json"));
    const sessionId = "session-ttl-test";
    service.reconcileTaskAfterTurn(sessionId, "帮我规划一下去马尔代夫 待格五天", "行，我这就去安排。");
    await new Promise((resolve) => setTimeout(resolve, 60));
    const prompt = service.buildPromptContext(sessionId, "帮我规划一下去马尔代夫 待格五天");
    if (prompt) {
      assert.doesNotMatch(prompt, /四分钟后提醒|马尔代夫行程安排/, "过期挂起项不得注入");
    }
    // 无异常即通过（过期项被 TTL 清掉后注入块可能整体为空）
    assert.ok(true);
  } finally {
    if (prev === undefined) delete process.env.AGENT_STM_LOOP_TTL_MS;
    else process.env.AGENT_STM_LOOP_TTL_MS = prev;
  }
});

test("P2 使命失效：连续切换话题后陈年 currentMission 置空", () => {
  const service = new ShortTermMemoryGatewayService(tempFile("hygiene.json"));
  const sessionId = "session-mission-test";

  service.reconcileTaskAfterTurn(sessionId, "帮我规划一下去马尔代夫 待格五天", "好嘞，这就去排行程。");
  let state: any = (service as any).data.sessions[sessionId];
  assert.ok(state.conversationMemory.currentMission, "新请求应成为 currentMission");

  service.reconcileTaskAfterTurn(sessionId, "abc def", "嗯嗯。");
  service.reconcileTaskAfterTurn(sessionId, "xyz uvw", "好的。");
  state = (service as any).data.sessions[sessionId];
  assert.equal(
    state.conversationMemory.currentMission,
    null,
    "连续两轮话题切换且无活动任务 → 使命置空",
  );
});

test("P2 短 ping 防带跑：称呼式短消息注入『只回应本条』指令", () => {
  const service = new ShortTermMemoryGatewayService(tempFile("hygiene.json"));
  const sessionId = "session-ping-test";

  service.reconcileTaskAfterTurn(sessionId, "今天天气怎么样", "兴义这天气，我手头没实时数据。");
  const prompt = service.buildPromptContext(sessionId, "小弟");
  assert.ok(prompt, "短 ping 轮应有 STM 块");
  assert.match(prompt!, /本条无新指令/, "必须注入防带跑指令");
  assert.doesNotMatch(prompt!, /open-loops:/, "短 ping 轮不得注入陈年挂起栈");
});

test("P2 短 ping 防带跑：正常诉求不受影响", () => {
  const service = new ShortTermMemoryGatewayService(tempFile("hygiene.json"));
  const sessionId = "session-normal-test";

  service.reconcileTaskAfterTurn(sessionId, "帮我规划一下去马尔代夫 待格五天", "好嘞，这就去排行程。");
  const prompt = service.buildPromptContext(sessionId, "帮我规划一下去马尔代夫 待格五天");
  assert.ok(prompt);
  assert.doesNotMatch(prompt!, /本条无新指令/, "正常诉求不注入 ping 指令");
});

/* ── 2026-11-08 P1/P2：agent 问句账本（四点半复读事故回归） ───────── */

test("P2 问句账本：问句入槽 → 改述一次 → 下一轮自然消失", () => {
  const service = new ShortTermMemoryGatewayService(tempFile("question-ledger.json"));
  const sessionId = "session-question-test";

  // 轮1：agent 抛出问句（原文同时进入①原文窗口/情景日志）
  service.reconcileTaskAfterTurn(sessionId, "我还在弄工作", "都四点半了，你还不睡吗？");
  const built1 = service.buildPromptContext(sessionId, "再弄一会儿") ?? "";
  assert.match(built1, /pending-question: .*还不睡吗/, "上一轮问句应作为待回应项注入");
  assert.doesNotMatch(built1, /pending-question-settled/, "首次不应被当成已改述");

  // 轮2：agent 换个说法再问同一件事 → 标记已改述
  service.reconcileTaskAfterTurn(sessionId, "再弄一会儿", "这个点还打算继续熬吗？");
  const built2 = service.buildPromptContext(sessionId, "马上") ?? "";
  assert.match(built2, /pending-question-settled/, "同一问句第二次只允许注入抑制行");
  assert.doesNotMatch(built2, /pending-question: /, "不得再次注入追问指令");

  // 轮3：agent 不再问 → 状态槽清空，问句自然消失（原文仍留在情景日志）
  service.reconcileTaskAfterTurn(sessionId, "马上", "那我不催了，忙完早点休息。");
  const built3 = service.buildPromptContext(sessionId, "好") ?? "";
  assert.doesNotMatch(built3, /pending-question/, "问句应在 1-2 轮后自然消失");
});

test("P2 问句账本：话题切换时的新问句不得误判为改述", () => {
  const service = new ShortTermMemoryGatewayService(tempFile("question-topic.json"));
  const sessionId = "session-question-topic-test";

  service.reconcileTaskAfterTurn(sessionId, "我还在弄工作", "都四点半了，你还不睡吗？");
  service.reconcileTaskAfterTurn(sessionId, "帮我订明天去上海的机票", "几点出发？");
  const built = service.buildPromptContext(sessionId, "早上八点") ?? "";
  assert.match(built, /pending-question: .*几点出发/, "新话题问句应重新计为首次追问");
  assert.doesNotMatch(built, /pending-question-settled/);
});

test("P1/P3 摘要卫生：问句保真、摘要仅作背景、日终回顾不挤掉问句", async () => {
  const prevFile = process.env.AGENT_DAILY_DIGEST_FILE;
  const prevEnabled = process.env.AGENT_DAILY_DIGEST_ENABLED;
  process.env.AGENT_DAILY_DIGEST_FILE = tempFile("digest-hygiene.json");
  process.env.AGENT_DAILY_DIGEST_ENABLED = "1";
  try {
    const { DailyDigestService } = await import("../src/services/daily-digest-service.js");
    const digest = new DailyDigestService();
    digest.observeTurn("actor-question", "我还在弄工作", "都四点半了，你还不睡吗？");

    const prompt = digest.getPromptDigest("actor-question") ?? "";
    assert.match(prompt, /仅作背景/, "摘要必须显式标注为背景而非待办");
    assert.match(prompt, /还不睡吗？/, "agent 问句必须原样保留，不得截成半句");

    const recap = digest.consolidateDayRecap("actor-question");
    assert.ok(recap?.startsWith("- recap|"), "夜间巩固应生成一句话回顾");
    assert.doesNotMatch(recap ?? "", /还不睡/, "agent 自己的问句不进入日终回顾");
    const after = digest.getPromptDigest("actor-question") ?? "";
    assert.match(after, /recap\|/, "回顾行应进入摘要");
    assert.match(after, /还不睡吗？/, "回顾只追加，不得挤掉问句原文");
  } finally {
    if (prevFile === undefined) delete process.env.AGENT_DAILY_DIGEST_FILE;
    else process.env.AGENT_DAILY_DIGEST_FILE = prevFile;
    if (prevEnabled === undefined) delete process.env.AGENT_DAILY_DIGEST_ENABLED;
    else process.env.AGENT_DAILY_DIGEST_ENABLED = prevEnabled;
  }
});

test("P4 统一排序：相关度优先、同相关度新者优先、跨来源共用同一函数", async () => {
  const { unifiedMemoryScore } = await import("../src/services/memory-record-utils.js");
  const now = Date.now();
  const freshHigh = unifiedMemoryScore(
    { relevance: 0.9, updatedAt: now, confidence: 0.8 },
    now,
  );
  const staleHigh = unifiedMemoryScore(
    { relevance: 0.9, updatedAt: now - 30 * 86_400_000, confidence: 0.8 },
    now,
  );
  const freshLow = unifiedMemoryScore(
    { relevance: 0.3, updatedAt: now, confidence: 0.8 },
    now,
  );
  assert.ok(freshHigh > staleHigh, "同相关度下新条目应排前");
  assert.ok(freshHigh > freshLow, "相关度应先于时效/置信度");
});

/* ── 2026-11-08 闭环：写入 → 召回 → 注入 → 巩固 → 再回读 ─────────── */

test("闭环：一轮对话写进摘要/问句账本，轮内可注入，夜间一次巩固后可回读", async () => {
  const prevFile = process.env.AGENT_DAILY_DIGEST_FILE;
  const prevEnabled = process.env.AGENT_DAILY_DIGEST_ENABLED;
  process.env.AGENT_DAILY_DIGEST_FILE = tempFile("digest-loop.json");
  process.env.AGENT_DAILY_DIGEST_ENABLED = "1";
  try {
    const { DailyDigestService } = await import("../src/services/daily-digest-service.js");
    const gateway = new ShortTermMemoryGatewayService(tempFile("gateway-loop.json"));
    const digest = new DailyDigestService();
    const sessionId = "session-loop-test";
    const actorId = "actor-loop-test";

    // ①原文窗口/情景日志 + ③日结摘要 + ②问句账本：同一轮双写
    const userTurn = "下周三我要去北京出差";
    const agentTurn = "好的，记下了。要我提前帮你订酒店吗？";
    gateway.reconcileTaskAfterTurn(sessionId, userTurn, agentTurn);
    digest.observeTurn(actorId, userTurn, agentTurn, {
      priorityLines: ["[用户要求记住] 下周三去北京出差"],
    });

    // 轮内注入：②问句账本 + ③摘要命中都能被读到
    const stmPrompt = gateway.buildPromptContext(sessionId, "先不用订") ?? "";
    assert.match(stmPrompt, /pending-question: .*订酒店/, "问句账本应在此轮注入");
    const digestPrompt = digest.getRelevantPromptDigest(actorId, "下周去北京出差要准备什么") ?? "";
    assert.match(digestPrompt, /北京出差/, "日结摘要应按相关性注入");

    // ⑥ 夜间巩固：关闭悬空问句 + 生成一句话回顾（一次跑完）
    assert.equal(gateway.closePendingQuestions(), 1, "悬空问句应被关闭");
    const recap = digest.consolidateDayRecap(actorId);
    assert.ok(recap?.includes("北京出差"), "日终回顾应包含当天主题");

    // 巩固后回读：状态槽清空，但①/③里的问句原文与事实保留
    const afterNight = gateway.buildPromptContext(sessionId, "先不用订") ?? "";
    assert.doesNotMatch(afterNight, /pending-question/, "夜间巩固后不再跨轮追问");
    const digestAfter = digest.getPromptDigest(actorId) ?? "";
    assert.match(digestAfter, /北京出差/, "巩固不得丢事实");
    assert.match(digestAfter, /订酒店吗？/, "巩固不得删掉 agent 问句原文");
  } finally {
    if (prevFile === undefined) delete process.env.AGENT_DAILY_DIGEST_FILE;
    else process.env.AGENT_DAILY_DIGEST_FILE = prevFile;
    if (prevEnabled === undefined) delete process.env.AGENT_DAILY_DIGEST_ENABLED;
    else process.env.AGENT_DAILY_DIGEST_ENABLED = prevEnabled;
  }
});
