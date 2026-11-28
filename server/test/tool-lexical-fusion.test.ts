import assert from "node:assert/strict";
import test from "node:test";

import { Bm25Index } from "../src/tools/tool-search/bm25.js";

const docs = [
  { id: "calendar", text: "日历 日程 待办 提醒 闹钟 创建 删除 查询" },
  { id: "weather.get_local", text: "天气 气温 降雨 预报 本地 位置" },
  { id: "world.link", text: "好友 消息 发送 回复 站内通信" },
  { id: "unrelated", text: "图片 视频 音乐 娱乐 推荐" },
];

const aliases = [
  { registryName: "calendar", searchAliases: ["日历", "日程", "提醒", "闹钟"] },
  { registryName: "weather.get_local", searchAliases: ["天气", "气温", "预报"] },
  { registryName: "world.link", searchAliases: ["好友", "消息", "发消息"] },
  { registryName: "unrelated", searchAliases: ["图片", "视频"] },
];

test("词面通道保留原始证据且统一到 0~1", () => {
  const index = new Bm25Index(docs);
  const hits = index.search("明早七点提醒我开会", 10, aliases);
  assert.ok(hits.length > 0);
  for (const hit of hits) {
    assert.ok(hit.score >= 0 && hit.score <= 1, `${hit.id} score=${hit.score}`);
    for (const [channel, score] of Object.entries(hit.channels)) {
      assert.ok(score >= 0 && score <= 1, `${hit.id}.${channel}=${score}`);
    }
  }
});

test("别名命中不再把 registryName 注入 query 制造名称证据", () => {
  const index = new Bm25Index(docs);
  const hit = index.search("日历", 10, aliases).find((item) => item.id === "calendar");
  assert.ok(hit);
  assert.ok(hit.channels.alias > 0, "直接别名证据应保留");
  assert.equal(hit.channels.name, 0, "别名扩展不得反哺 registryName 通道");
});

test("用户直接说出工具名时名称通道保持高置信", () => {
  const index = new Bm25Index(docs);
  const hit = index.search("weather.get_local", 10, aliases)[0];
  assert.equal(hit?.id, "weather.get_local");
  assert.equal(hit?.channels.name, 1);
});

test("零词面证据工具不会靠排名融合获得噪声分", () => {
  const index = new Bm25Index(docs);
  assert.deepEqual(index.search("量子纠缠实验室", 10, aliases), []);
});

test("词面分数不随返回 limit 或无关候选截断而变化", () => {
  const index = new Bm25Index(docs);
  const short = index.search("给好友发消息", 1, aliases)[0];
  const full = index.search("给好友发消息", 10, aliases)[0];
  assert.equal(short?.id, "world.link");
  assert.equal(short?.score, full?.score);
  assert.deepEqual(short?.channels, full?.channels);
});
