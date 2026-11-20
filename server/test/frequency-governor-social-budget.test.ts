// 社交类独立日预算（2026-11-19）：事务提醒与闲聊分账。
//
// 根因：原来所有主动触达共用一个 15 条池子。事务多的日子闲聊被挤光（主动性消失），
// 闲聊多的日子提醒被挤掉（更要命）。分开之后各走各的上限——社交类默认 4 条/天。
import assert from "node:assert/strict";
import { test } from "node:test";

import { FrequencyGovernor } from "../src/proactivity/frequency-governor.js";

const NOON = new Date(2026, 10, 19, 12, 0, 0);

function mkGov(opts: { daily?: number; social?: number } = {}): FrequencyGovernor {
  return new FrequencyGovernor({
    ignoreEnv: true,
    disableQuietHours: true,
    dailyBudget: opts.daily ?? 15,
    socialDailyBudget: opts.social ?? 4,
  });
}

test("社交预算：第 4 条后拒绝，第 5 条给出 social_budget_exhausted", () => {
  const g = mkGov();
  // 每次换 kind：同 kind 会先被 2h 冷却挡住，掩盖预算本身的判定
  for (let i = 0; i < 4; i++) {
    const kind = `social_${i}`;
    const v = g.canTrigger("u1", kind, "low", NOON, { tier: "social" });
    assert.equal(v.allowed, true, `第 ${i + 1} 条应放行`);
    g.record("u1", kind, NOON, "social");
  }
  const blocked = g.canTrigger("u1", "social_5", "low", NOON, { tier: "social" });
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.reason.includes("social_budget_exhausted"));
});

test("社交预算：闲聊满了不影响事务提醒（分账的关键）", () => {
  const g = mkGov();
  for (let i = 0; i < 4; i++) {
    g.canTrigger("u1", "agent_pulse", "low", NOON, { tier: "social" });
    g.record("u1", "agent_pulse", NOON, "social");
  }
  // 事务类（不带 tier）不受社交预算限制
  const must = g.canTrigger("u1", "schedule_upcoming", "high", NOON);
  assert.equal(must.allowed, true);
  // 社交类仍被拦
  assert.equal(g.canTrigger("u1", "agent_pulse", "low", NOON, { tier: "social" }).allowed, false);
});

test("社交预算：事务打满总预算后，社交也被拦（总闸仍在）", () => {
  const g = mkGov({ daily: 3, social: 4 });
  for (let i = 0; i < 3; i++) {
    g.canTrigger("u1", "schedule_upcoming", "high", NOON);
    g.record("u1", "schedule_upcoming", NOON);
  }
  const v = g.canTrigger("u1", "agent_pulse", "low", NOON, { tier: "social" });
  assert.equal(v.allowed, false);
  assert.ok(v.reason.includes("daily_budget_exhausted"));
});

test("社交预算：跨天自动重置（闲聊不该带昨天的账）", () => {
  const g = mkGov({ social: 2 });
  const d1 = new Date(2026, 10, 19, 20, 0, 0);
  const d2 = new Date(2026, 10, 20, 9, 0, 0);
  for (let i = 0; i < 2; i++) {
    g.canTrigger("u1", "agent_pulse", "low", d1, { tier: "social" });
    g.record("u1", "agent_pulse", d1, "social");
  }
  assert.equal(g.canTrigger("u1", "agent_pulse", "low", d1, { tier: "social" }).allowed, false);
  assert.equal(g.canTrigger("u1", "agent_pulse", "low", d2, { tier: "social" }).allowed, true);
});

test("社交预算：快照与恢复保留 socialCount（重启不吃掉额度）", () => {
  const g = mkGov({ social: 2 });
  g.record("u1", "agent_pulse", NOON, "social");
  const snap = g.snapshot();
  assert.equal(snap.actors[0]?.socialCount, 1);

  const g2 = mkGov({ social: 2 });
  g2.restore(snap);
  g2.record("u1", "agent_pulse", NOON, "social");
  assert.equal(g2.canTrigger("u1", "agent_pulse", "low", NOON, { tier: "social" }).allowed, false);
});

test("社交预算：旧快照（无 socialCount）按 0 恢复，不炸", () => {
  const g = mkGov();
  g.restore({
    actors: [{ actorId: "u1", dateKey: "2026-11-19", dailyCount: 2, kindLastAt: [] }],
    cooldowns: {},
  });
  assert.equal(g.canTrigger("u1", "agent_pulse", "low", NOON, { tier: "social" }).allowed, true);
});

test("预算快照：usageSnapshot 同时暴露两类用量", () => {
  const g = mkGov({ social: 4 });
  g.record("u1", "agent_pulse", NOON, "social");
  g.record("u1", "schedule_upcoming", NOON);
  const [u] = g.usageSnapshot();
  assert.equal(u.dailyCount, 2);
  assert.equal(u.socialCount, 1);
  assert.equal(u.socialBudget, 4);
});
