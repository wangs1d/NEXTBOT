/**
 * realtime 轮搜索词确定性构造器的回归测试（2026-09-13 根修配套）。
 *
 * 契约：模型缺省 search_query 时，程序必须自己造出可执行的查询词——
 * 指代消解靠停用词剥离 + 最近对话实体回溯（纯代码），不靠提示词恳求。
 * 构造质量只影响召回；「是否真搜」由 agent-core 前置检索门禁按
 * 「searchQuery 非空」确定性执行，与本构造器质量无关。
 */
import test from "node:test";
import assert from "node:assert/strict";

import { composeRealtimeSearchQuery, claimsWebSearch } from "../src/agent/realtime-search-query.js";
import {
  resolveTurnReferent,
  parseReferentPairs,
} from "../src/agent/realtime-search-query.js";

test("纯指代消息：从最近对话（最新优先）解析实体并拼接", () => {
  // 顺序为最旧在前，实体取自最新一条含人名的消息
  const query = composeRealtimeSearchQuery("她最近在那", [
    "哈哈",
    "我老婆是刘浩存啊",
    "刘浩存最近的消息",
  ]);
  assert.match(query, /^刘浩存 /);
  assert.ok(query.includes("她最近在那"));
});

test("当前消息自带实体：原话即查询词，不重复拼接", () => {
  assert.equal(composeRealtimeSearchQuery("王哥最近在哪", []), "王哥最近在哪");
  assert.equal(composeRealtimeSearchQuery("刘浩存在哪", []), "刘浩存在哪");
});

test("上下文也没有实体：兜底用户原话（仍是可执行查询词）", () => {
  assert.equal(composeRealtimeSearchQuery("怎么样了", ["怎么样了", "好的"]), "怎么样了");
});

test("模型查询词含代词未消解：代码强制并入上下文实体（真实测试「我老婆 最近 在哪」轮的回归）", () => {
  // 真实测试发现模型会输出合规但未消解的查询词——剥掉代词/角色词后无实体，
  // 必须从最近对话回溯实体并入，而不是拿「我老婆」去搜
  const query = composeRealtimeSearchQuery("我老婆 最近 在哪", ["刘浩存最近的消息"]);
  assert.match(query, /^刘浩存 /);
  assert.ok(query.includes("最近 在哪"));
});

test("模型查询词已含实体：原样保留（代码消解不多事）", () => {
  const query = composeRealtimeSearchQuery("刘浩存 最近 行程", ["我老婆是刘浩存啊"]);
  assert.equal(query, "刘浩存 最近 行程");
});

test("记忆档案行选实体：profile 高频人名胜出（真实 memory 快照形态回归）", () => {
  // 真实 userProfile 行：「关注演员刘浩存（称「老婆」）…并关心刘浩存近期动态与活动」
  // 刘浩存出现 2 次，频次压过单次出现的其他候选
  const query = composeRealtimeSearchQuery("她最近在那", [
    "- 关注演员刘浩存（称「老婆」）、景甜及鞠婧祎，会主动要求查看其照片，并关心刘浩存近期动态与活动。",
    "- 高频关注兴义当地每日天气。",
  ]);
  assert.match(query, /^刘浩存 /);
});

test("真实污染环境回归：角色同现行 + 长度加权让真名胜过称呼词/泛词/英文标签", () => {
  // 复刻真实测试中打满噪声的语料：profile 以「用户」开头、assistant 回复以
  // 「王哥」开头、recap 混英文——只有「称『老婆』」的映射行里藏着所指实体
  const query = composeRealtimeSearchQuery("她最近在那", [
    "[session-recap] the assistant session user said",
    "用户习惯深夜对话，作息偏晚。",
    "王哥，这回有料了——换成她名字搜，就出来了。",
    "- 关注演员刘浩存（称「老婆」）、景甜及鞠婧祎，会主动要求查看其照片，并关心刘浩存近期动态与活动。",
    "王哥，又扑空了——这轮出来的全是陈妍希综艺，跟她一条不沾。",
  ]);
  assert.match(query, /^刘浩存 /);
});

test("行首称呼语不参与实体（「王哥，」是受话人不是所指实体）", () => {
  // assistant 回复恒以「王哥，」开头，词频极高；真名只在角色映射行里出现
  const query = composeRealtimeSearchQuery("她最近在那", [
    "王哥，这回有料了——换成她名字搜，就出来了。",
    "王哥，又扑空了——这轮出来的全是陈妍希综艺，跟她一条不沾。",
    "王哥，还是空手——刚搜的全是同名电影，没一条是她的行踪。",
    "- 关注演员刘浩存（称「老婆」）、景甜及鞠婧祎，并关心刘浩存近期动态与活动。",
  ]);
  assert.match(query, /^刘浩存 /);
});

test("搜索宣称一致性闸的词面半边：宣称搜索的表述命中，普通陈述不误伤", () => {
  // 真实违约样本（路由超时保守降级轮，模型编造搜索见闻）
  assert.equal(claimsWebSearch("王哥，还是老结果——刚又搜一遍，出来的全是同名电影、播客。"), true);
  assert.equal(claimsWebSearch("公开渠道翻了一遍，没一条是她的行踪。"), true);
  assert.equal(claimsWebSearch("这轮出来的全是旧报道、杂志封面那一挂。"), false);
  // 普通闲聊/知识直答不宣称搜索 → 不触发闸
  assert.equal(claimsWebSearch("哈哈笑死我了"), false);
  assert.equal(claimsWebSearch("北京今天挺冷的，多穿点"), false);
  assert.equal(claimsWebSearch(""), false);
});

test("拉丁词实体（币价/代号类）可被提取", () => {
  const query = composeRealtimeSearchQuery("它现在什么价", ["BTC今天涨了吗"]);
  assert.match(query, /^BTC /);
});

test("停用词剥离不产生伪实体：疑问词/时间词/泛话题词全剥空", () => {
  // 「她最近在那」剥完为空 → 才会回溯最近对话；不得把「最近/在那」当实体
  const query = composeRealtimeSearchQuery("她最近在那", []);
  assert.equal(query, "她最近在那");
});

test("构造结果恒非空且全量透传（不截断，长度对齐主流交模型/后端自限）", () => {
  const longTurn = "刘浩存近期行程动态汇总以及所有公开活动安排和杂志拍摄通告明细列表";
  const longText = "她最近在那呢在哪个城市是不是还在剧组拍戏顺便说一下她接下来的所有公开行程安排细节";
  const query = composeRealtimeSearchQuery(
    longText,
    Array.from({ length: 10 }, () => longTurn),
  );
  assert.ok(query.length > 0);
  assert.ok(query.includes(longText), "用户原话必须完整保留在查询词中，不得截断");
});

// ── 代词指代锚定（2026-11-19 真机事故回归）──────────────────────────────
// 事故：前几轮反复搜过成龙 → 中间聊定位 → 「我老婆美不美」→「刘浩存那张脸」
// →「看看他的照片」。模型沿用了三轮前的成龙，没认最近的老婆=刘浩存。

const INCIDENT_REFERENTS = ["老婆是刘浩存"];
const INCIDENT_RECENT_NEWEST_FIRST = [
  '可惜啥，喜欢一个人又不犯法。而且你这"老婆"当得挺认真，一问美不美眼睛都亮了。',
  "可惜只是想象中的老婆",
  "美，这个不用问。刘浩存那张脸，你眼光确实不差。",
  "我老婆美不美",
  "最新这批给你翻出来了，多是他近年公开露面的照片，还有《尖峰时刻》那阵的对比图。",
  "最新的",
];

test("代词锚定：近因优先，取最近刚聊到的『老婆』=刘浩存，而不是更早的旧话题", () => {
  const ref = resolveTurnReferent("看看他的照片", INCIDENT_RECENT_NEWEST_FIRST, INCIDENT_REFERENTS);
  assert.deepEqual(ref, { entity: "刘浩存", role: "老婆" });
});

test("代词锚定：当前消息没有代词 / 没有映射 / 映射最近未被提及时不做猜测", () => {
  assert.equal(resolveTurnReferent("看看刘浩存的照片", INCIDENT_RECENT_NEWEST_FIRST, INCIDENT_REFERENTS), null);
  assert.equal(resolveTurnReferent("看看他的照片", INCIDENT_RECENT_NEWEST_FIRST, []), null);
  assert.deepEqual(
    resolveTurnReferent("看看他的照片", ["今天天气不错", "刘浩存那张脸真好看"], ["老婆是刘浩存"]),
    { entity: "刘浩存", role: "老婆" },
  );
  assert.equal(
    resolveTurnReferent("看看他的照片", ["其他就没什么了"], ["老婆是刘浩存"]),
    null,
    "「其他」里的他不是代词，且对话里没出现映射对象",
  );
});

test("指代映射解析：容忍括号注释与语气词", () => {
  assert.deepEqual(parseReferentPairs(["老婆是刘浩存（演员）啊"]), [
    { role: "老婆", entity: "刘浩存" },
  ]);
});
