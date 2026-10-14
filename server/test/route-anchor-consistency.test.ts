/**
 * 路由标签审计（证据锚定 + understanding 一致性）+ 宣称-一致性闸
 * 回归测试（2026-10-12 架构收敛配套）。
 *
 * 架构契约（取代已删除的 media 词面词表 / reminder 词表两个补丁）：
 *   1. 概率性标签不允许被确定性放大，除非它能被当前消息文本证实
 *      （evidence 锚定：L1 从当前消息逐字摘片段，代码校验 contains）；
 *   2. L1 同体输出的 understanding 标记与 intent 自相矛盾时，信任理解标记
 *      （media/realtime + personal_fact = 自相矛盾 → chat）；
 *   3. 写侧漏调工具的统一兜底 = 宣称-一致性闸（宣称完成 ∧ 零副作用工具执行
 *      = 结构性违约），与意图标签解耦——任何工具被嘴上糊弄都走这一条。
 *
 * 事故句回放（黄金用例，路由改动必须全过）：
 *   - 「真名叫王铭川 以后喊我川哥王哥都行」→ 任何路径不得产出媒体搜索
 *   - 「明早7点提醒我加外套」→ 提交 action_write 时不被 understanding 误降级
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  claimsSideEffectCompletion,
  promisesSideEffectCompletion,
  messageHasWriteRequestSignal,
} from "../src/agent/claim-consistency.js";
import { parseEvidenceJson, buildRoutePrompt } from "../src/agent/route-llm-call.js";
import { dialogStateStore } from "../src/agent/dialog-state.js";

const { routeTurnByLlm } = await import("../src/agent/llm-task-router.js");

/** 假 L1 分类器：返回完整 JSON（intent + understanding + evidence）。 */
function fakeProvider(payload: Record<string, unknown>) {
  const provider = {
    isEnabled: () => true,
    streamCompletion: async () => JSON.stringify(payload),
  };
  return provider as never;
}

const WANG_INTRO = "真名叫王铭川 以后喊我川哥王哥都行";

// ── 纯函数：证据锚定解析 ──

test("parseEvidenceJson：数组/单串/缺字段/坏 JSON", () => {
  assert.deepEqual(parseEvidenceJson('{"intent":"media_retrieval","evidence":["搜","照片"]}'), [
    "搜",
    "照片",
  ]);
  assert.deepEqual(parseEvidenceJson('{"intent":"media_retrieval","evidence":"搜照片"}'), ["搜照片"]);
  assert.deepEqual(parseEvidenceJson('{"intent":"chat"}'), []);
  assert.deepEqual(parseEvidenceJson("not json"), []);
  assert.deepEqual(parseEvidenceJson(undefined), []);
});

// ── L2 集成：证据锚定审计 ──

test("黄金回放：media 标签 + 造假证据（摘自别处）→ 标签作废降级 chat，不产查询词", async () => {
  const decision = await routeTurnByLlm(
    fakeProvider({
      intent: "media_retrieval",
      confidence: 0.9,
      evidence: ["刘亦菲的红毯照"],
    }),
    "sess-anchor-1",
    "我叫王铭川，平时朋友都喊我老王",
  );
  assert.equal(decision.intent, "chat");
  assert.equal(decision.searchQuery, undefined, "未锚定的 media 标签不得产出搜索查询词");
  assert.ok(decision.reasons.includes("evidence_anchor:invalid"));
  assert.ok(decision.reasons.includes("route_downgrade:evidence_not_anchored_in_message"));
});

test("黄金回放：media 标签 + 证据逐字出自当前消息 → 放行并构造查询词", async () => {
  const decision = await routeTurnByLlm(
    fakeProvider({
      intent: "media_retrieval",
      confidence: 0.9,
      evidence: ["搜几张", "照片"],
    }),
    "sess-anchor-2",
    "搜几张刘亦菲的照片",
  );
  assert.equal(decision.intent, "media_retrieval");
  assert.equal(decision.plane, "task");
  assert.equal(decision.searchQuery, "刘亦菲");
  assert.ok(decision.reasons.includes("evidence_anchor:ok"));
});

test("证据缺失（schema 兼容）宽容放行：不因输出格式问题误伤正常轮", async () => {
  const decision = await routeTurnByLlm(
    fakeProvider({ intent: "media_retrieval", confidence: 0.9 }),
    "sess-anchor-3",
    "来几张景甜的近照",
  );
  assert.equal(decision.intent, "media_retrieval", "evidence 缺字段 = 宽容路径（标签保留）");
  assert.ok(decision.reasons.includes("evidence_anchor:missing"));
  // 2026-10-12 架构收敛：预执行是加速路径不是正确性来源——锚定缺失不预执行，
  // 查询词收权（执行模型在 search+media 全模态束里自选工具）。
  assert.equal(decision.searchQuery, undefined, "anchor=missing 不得产出预执行查询词");
  assert.ok(decision.reasons.includes("media_query:withheld_unanchored"));
});

test("realtime + 锚定缺失：预执行同样收权（误标轮不再烧网页搜索）", async () => {
  const decision = await routeTurnByLlm(
    fakeProvider({
      intent: "realtime_lookup",
      confidence: 0.3,
      search_query: "刘亦菲 照片 高清",
    }),
    "sess-anchor-5",
    "再来点",
  );
  assert.equal(decision.intent, "realtime_lookup");
  assert.equal(
    decision.searchQuery,
    undefined,
    "真机实证：承接语被误标 realtime 时，媒体形状查询词不得进网页预执行",
  );
  assert.ok(decision.reasons.includes("search_query:withheld_unanchored"));
});

test("realtime 标签 + 证据造假 → 同样作废降级（机制与 media 对称）", async () => {
  const decision = await routeTurnByLlm(
    fakeProvider({
      intent: "realtime_lookup",
      confidence: 0.9,
      evidence: ["比特币"],
    }),
    "sess-anchor-4",
    "今天天气真不错啊",
  );
  assert.equal(decision.intent, "chat");
  assert.ok(decision.reasons.includes("route_downgrade:evidence_not_anchored_in_message"));
});

// ── L2 集成：understanding 一致性校验 ──

test("黄金回放：media 标签 + personal_fact=true 自相矛盾 → 信任理解标记降级 chat", async () => {
  const decision = await routeTurnByLlm(
    fakeProvider({
      intent: "media_retrieval",
      confidence: 0.85,
      understanding: { personal_fact: true },
    }),
    "sess-conflict-1",
    WANG_INTRO,
  );
  assert.equal(decision.intent, "chat");
  assert.ok(decision.reasons.includes("understanding_conflict:personal_fact_vs_action_intent"));
  assert.ok(decision.reasons.includes("route_downgrade:understanding_conflict"));
});

test("realtime 标签 + memory_instruction=true 自相矛盾 → 降级 chat", async () => {
  const decision = await routeTurnByLlm(
    fakeProvider({
      intent: "realtime_lookup",
      confidence: 0.8,
      understanding: { memory_instruction: true },
    }),
    "sess-conflict-2",
    "帮我记住以后别给我推新闻",
  );
  assert.equal(decision.intent, "chat");
});

test("action_write + personal_fact 合法共存不降级（「我叫王铭川，明天9点提醒我开会」）", async () => {
  const decision = await routeTurnByLlm(
    fakeProvider({
      intent: "action_write",
      confidence: 0.9,
      understanding: { personal_fact: true },
    }),
    "sess-conflict-3",
    "我叫王铭川，明天9点提醒我开会",
  );
  assert.equal(decision.intent, "action_write", "两句话轮 personal_fact 与写诉求共存，不得降级");
});

// ── 纯函数：宣称-一致性判定 ──

test("完成宣称：零工具语境下即违约（已设置/创建好了/订好了）", () => {
  assert.ok(claimsSideEffectCompletion("好嘞，已设置好明早7点的提醒啦"));
  assert.ok(claimsSideEffectCompletion("已经帮你创建好日程了"));
  assert.ok(claimsSideEffectCompletion("已经下单成功，等收货就行"));
  assert.ok(claimsSideEffectCompletion("闹钟已经定好，明天六点半叫你"));
});

test("完成宣称：诚实失败/否定形态不算违约", () => {
  assert.equal(claimsSideEffectCompletion("抱歉，提醒设置失败了，你再说一次时间？"), false);
  assert.equal(claimsSideEffectCompletion("我现在还无法帮你下单，需要你先确认地址"), false);
  assert.equal(claimsSideEffectCompletion("还没有创建，你确定要定在周一吗？"), false);
});

test("未来承诺：仅当用户消息带写请求信号时才视为违约素材", () => {
  assert.ok(promisesSideEffectCompletion("放心，到点我会准时提醒你"));
  assert.ok(messageHasWriteRequestSignal("明早7点提醒我加外套"));
  assert.ok(messageHasWriteRequestSignal("帮我订明天中午的餐厅"));
  assert.equal(messageHasWriteRequestSignal("你会提醒我吗"), false, "纯确认轮不含写请求信号");
});

// ── 路由 prompt：状态注入与旧带偏指令删除 ──

test("buildRoutePrompt：注入对话状态块；旧「短追问按继承话题判」指令已删除", () => {
  const prompt = buildRoutePrompt(
    "再来点",
    ["搜几张刘亦菲的照片"],
    undefined,
    ["- 用户：「搜几张刘亦菲的照片」→ 意图 media_retrieval｜已执行工具：search_images"],
  );
  assert.ok(prompt.includes("上一轮对话状态"), "应包含结构化状态块标题");
  assert.ok(prompt.includes("已执行工具：search_images"));
  assert.ok(prompt.includes("evidence"), "应包含证据锚定契约");
  assert.ok(!prompt.includes("短追问（如「娱乐圈的」「新鲜的」）按它继承的话题判"), "旧带偏指令必须删除");
});

test("buildRoutePrompt：无状态行时回退旧 user 轮注入（行为兼容）", () => {
  const prompt = buildRoutePrompt("再来点", ["搜几张刘亦菲的照片"], undefined, []);
  assert.ok(prompt.includes("最近对话"));
  assert.ok(prompt.includes("搜几张刘亦菲的照片"));
});

// ── 对话状态账本 ──

test("dialogStateStore：record → promptLines 渲染意图与工具；容量封顶", () => {
  dialogStateStore.resetForTest();
  dialogStateStore.recordTurn("sess-ds", {
    userText: "搜几张刘亦菲的照片",
    intent: "media_retrieval",
    tools: ["search_images", "search_images", "search_web"],
  });
  const lines = dialogStateStore.promptLines("sess-ds", 3);
  assert.equal(lines.length, 1);
  assert.ok(lines[0]!.includes("media_retrieval"));
  assert.ok(lines[0]!.includes("search_images"));
  assert.ok(lines[0]!.includes("search_web"));
  assert.equal(dialogStateStore.lastIntent("sess-ds"), "media_retrieval");
  assert.equal(dialogStateStore.promptLines("sess-其他", 3).length, 0);
});

// ── weather_query 一等意图（2026-10-13）：天气归对话面前台直办 ──

test("黄金回放：天气问句 → weather_query，路由到对话面（不进任务面），search_query 剥离", async () => {
  const decision = await routeTurnByLlm(
    fakeProvider({
      intent: "weather_query",
      confidence: 0.97,
      evidence: ["天气怎么样"],
      search_query: "兴义 今天 天气", // 模型照 realtime 习惯给了搜索词 → 代码剥离
    }),
    "sess-weather-1",
    "现在天气怎么样？",
  );
  assert.equal(decision.intent, "weather_query");
  assert.equal(decision.plane, "chat", "天气必须落在对话面前台直办（专属工具，不进任务面）");
  assert.equal(decision.searchQuery, undefined, "天气由专属工具直查，search_query 必须被剥离");
  assert.ok(decision.reasons.includes("search_query:weather_dedicated_tool_no_web_search"));
  assert.ok(decision.reasons.includes("evidence_anchor:ok"));
});

test("黄金回放：weather_query + 造假证据（摘自别处）→ 标签作废降级 chat", async () => {
  const decision = await routeTurnByLlm(
    fakeProvider({
      intent: "weather_query",
      confidence: 0.9,
      evidence: ["刘浩存最近"],
    }),
    "sess-weather-2",
    "我叫王铭川，平时朋友都喊我老王",
  );
  assert.equal(decision.intent, "chat");
  assert.ok(decision.reasons.includes("evidence_anchor:invalid"));
});

test("黄金回放：weather_query + personal_fact 自相矛盾 → 降级 chat", async () => {
  const decision = await routeTurnByLlm(
    fakeProvider({
      intent: "weather_query",
      confidence: 0.9,
      evidence: ["天气"],
      understanding: { personal_fact: true },
    }),
    "sess-weather-3",
    "我昨天淋雨了，今天天气怎么样都无所谓吧",
  );
  assert.equal(decision.intent, "chat");
  assert.ok(decision.reasons.includes("route_downgrade:understanding_conflict"));
});

test("buildRoutePrompt：weather_query 标签定义与专属工具契约在 prompt 中", () => {
  const prompt = buildRoutePrompt("现在天气怎么样？", [], undefined, []);
  assert.ok(prompt.includes("weather_query"), "封闭标签集应包含 weather_query");
  assert.ok(prompt.includes("专属天气工具"), "应声明天气走专属工具直办");
  assert.ok(prompt.includes("search_query 恒为空字符串（天气由系统专属工具按自动定位直查"));
});
