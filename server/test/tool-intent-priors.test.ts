import assert from "node:assert/strict";
import test from "node:test";

import type { ResourceRecord } from "../src/tools/tool-search/registry/models.js";
import { resolveRetrievalIntent } from "../src/tools/tool-search/intent-priors.js";

function leader(id: string, score: number, domains: string[]) {
  return {
    score,
    record: { level1: { resource_id: id, domain: domains } } as ResourceRecord,
  };
}

test("意图先验：位置触发优先于通用日程提醒", () => {
  const intent = resolveRetrievalIntent("我到公司的时候提醒我", []);
  assert.equal(intent.intent, "位置围栏触发");
  assert.ok(intent.domain_scores.geofence! > 0.7);
  assert.ok(intent.domain_candidates.includes("geofence"));
});

test("意图先验：附近搜索与联网搜索分开", () => {
  const intent = resolveRetrievalIntent("帮我搜一下附近的星巴克", []);
  assert.equal(intent.intent, "附近地点搜索");
  assert.equal(intent.primary_capability, "geo.place_search");
});

test("意图先验：语音播报与语音消息使用不同能力", () => {
  const speak = resolveRetrievalIntent("用语音跟我说晚安", []);
  const message = resolveRetrievalIntent("发一条语音消息", []);
  assert.equal(speak.primary_capability, "voice.speak");
  assert.equal(message.primary_capability, "voice.send_message");
});

test("域后验按证据加权而不是候选数量投票", () => {
  const intent = resolveRetrievalIntent("没有规则命中的查询", [
    leader("strong", 0.9, ["clock"]),
    leader("weak-1", 0.01, ["place"]),
    leader("weak-2", 0.01, ["place"]),
    leader("weak-3", 0.01, ["place"]),
    leader("weak-4", 0.01, ["place"]),
  ]);
  assert.ok(intent.domain_scores.clock! > intent.domain_scores.place! * 10);
});

test("多域工具的词面证据不会重复计入每个域", () => {
  const intent = resolveRetrievalIntent("没有规则命中的查询", [
    leader("multi", 1, ["search", "weather"]),
  ]);
  assert.equal(intent.domain_scores.search, 0.5);
  assert.equal(intent.domain_scores.weather, 0.5);
});

test("弱词面证据不会产生高置信短路", () => {
  const intent = resolveRetrievalIntent("没有规则命中的查询", [
    leader("a", 0.01, ["clock"]),
    leader("b", 0.009, ["place"]),
  ]);
  assert.ok(intent.confidence < 0.6);
});
