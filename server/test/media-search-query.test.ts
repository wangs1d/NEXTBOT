// media 轮查询词确定性构造器单测（2026-10-10 搜图轮根治的查询半边）。
//
// 契约：路由器判 media_retrieval 后，查询词由纯代码构造、必非空——
// 「判 media → 查询词可用 → agent-core 确定性预执行」全程不依赖模型自觉。
import assert from "node:assert/strict";
import test from "node:test";

const { composeMediaSearchQuery, mediaToolNameForText } = await import(
  "../src/agent/realtime-search-query.js"
);

test("命令词+载体词剥离：『搜索几张马尔代夫的照片』→『马尔代夫』", () => {
  assert.equal(composeMediaSearchQuery("搜索几张马尔代夫的照片"), "马尔代夫");
});

test("口语变体：『帮我找一下青海湖的图片』→『青海湖』", () => {
  assert.equal(composeMediaSearchQuery("帮我找一下青海湖的图片"), "青海湖");
});

test("数量词不粘连实体：『找几个马尔代夫的视频』→『马尔代夫』", () => {
  assert.equal(composeMediaSearchQuery("找几个马尔代夫的视频"), "马尔代夫");
});

test("图片类型词保留（是有效检索词）：『星空壁纸』『可爱表情包』", () => {
  assert.equal(composeMediaSearchQuery("来几张星空壁纸"), "星空壁纸");
  assert.equal(composeMediaSearchQuery("可爱表情包"), "可爱表情包");
});

test("视频诉求判定：视频词命中 → search_videos，否则 search_images", () => {
  assert.equal(mediaToolNameForText("找几个马尔代夫的视频"), "search_videos");
  assert.equal(mediaToolNameForText("来段猫咪影片"), "search_videos");
  assert.equal(mediaToolNameForText("搜索几张马尔代夫的照片"), "search_images");
});

test("命令词吃光主体（『来点图』）→ 实体消解兜底，恒非空", () => {
  const q = composeMediaSearchQuery("来点图", ["昨天聊到马尔代夫旅行"]);
  assert.ok(q.length > 0, `查询词不得为空，实际: "${q}"`);
});

test("纯指代消息 → 退回 realtime 实体消解，契约：查询词恒非空", () => {
  // 实体质量由 composeRealtimeSearchQuery 的既有启发式承担（滑窗选词，有自己的
  // 行为基线）；media 层的契约只有一条——兜底结果必非空，预执行链路可跑。
  const q = composeMediaSearchQuery("她的照片", ["用户提到关注演员刘浩存"]);
  assert.ok(q.trim().length > 0, `查询词不得为空，实际: "${q}"`);
  assert.equal(mediaToolNameForText("她的照片"), "search_images");
});
