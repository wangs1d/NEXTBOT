import test from "node:test";
import assert from "node:assert/strict";

import { extractPreferences, paceForParty } from "../src/skills/travel-planning/intent-parser.js";

/**
 * 同行人决定默认节奏（「这次带女朋友、下次和朋友、再下次和家人」）：
 * 用户没明说节奏时按同行人给默认档，明说「紧凑/休闲」时以用户为准。
 *
 * 运行：npx tsx --test test/travel-party-pace.test.ts
 */

test("paceForParty 映射：情侣/家人松弛，朋友紧凑，独自均衡", () => {
  assert.equal(paceForParty("couple"), "relaxed");
  assert.equal(paceForParty("family"), "relaxed");
  assert.equal(paceForParty("friends"), "intensive");
  assert.equal(paceForParty("solo"), "balanced");
  assert.equal(paceForParty("solo_female"), "balanced");
  assert.equal(paceForParty(undefined), undefined);
});

test("原文带同行人时套用对应节奏", () => {
  assert.equal(extractPreferences("和女朋友去成都玩4天", [], "成都").pace, "relaxed");
  assert.equal(extractPreferences("和朋友去成都玩4天", [], "成都").pace, "intensive");
  assert.equal(extractPreferences("带爸妈去成都玩4天", [], "成都").pace, "relaxed");
});

test("用户明说节奏时覆盖同行人默认值", () => {
  const prefs = extractPreferences("和女朋友去成都玩4天，想紧凑一点多跑几个地方", [], "成都");
  assert.equal(prefs.pace, "intensive");
  assert.equal(prefs.party, "couple");
});

test("显式 party 入参同样生效，家人带娃标记亲子", () => {
  const prefs = extractPreferences("去西安玩5天", [], "西安", undefined, {
    explicit: { party: "friends" },
  });
  assert.equal(prefs.pace, "intensive");
  assert.equal(prefs.sources.party, "user");

  const family = extractPreferences("带孩子去西安玩5天", [], "西安");
  assert.equal(family.party, "family");
  assert.equal(family.kids, true);
  assert.equal(family.pace, "relaxed");
});

test("同行人卡回传的「和伴侣、均衡」三档词都读得出来", () => {
  // 卡片上点「改」后回传 `${同行人}、${节奏}`：改过的那档必须压过同行人的默认档
  const balanced = extractPreferences("和谁一起：和伴侣、均衡", [], "成都");
  assert.equal(balanced.party, "couple");
  assert.equal(balanced.pace, "balanced");
  assert.equal(balanced.sources.pace, "user");
  assert.equal(extractPreferences("和谁一起：和伴侣、紧凑", [], "成都").pace, "intensive");
  assert.equal(extractPreferences("和谁一起：和朋友、松弛", [], "成都").pace, "relaxed");
});
