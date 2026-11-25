// 共享上下文（接缝 2）：pulse 与情报判断吃同一份事实。
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildSharedContext,
  collectOpenLoops,
  contextVersion,
  placeText,
  presenceText,
  sharedContextPromptLines,
} from "../src/proactivity/context-snapshot.js";
import { buildPulsePrompt } from "../src/proactivity/agent-pulse.js";

const T0 = Date.UTC(2026, 10, 25, 2, 0, 0);

test("快照：在场带持续时长，位置超 2h 丢弃，内容稳定时才复用版号", () => {
  const ctx = buildSharedContext({
    actorId: "u1",
    at: T0,
    presence: { state: "active", since: T0 - 8 * 60_000 },
    screenFocus: { kind: "coding", since: T0 - 52 * 60_000 },
    place: { kind: "home", label: "家", updatedMinutesAgo: 180 },
    activity: "still",
    mood: "stressed",
    idleMinutes: 125,
    openLoops: ["还在办：装修", "还在办：装修", "还没聊到：面试", "", "a", "b", "c"],
    interests: ["网球", "网球", "  "],
  });
  assert.equal(presenceText(ctx), "active（已持续 8 分钟）");
  assert.equal(ctx.screenFocus?.kind, "coding");
  assert.equal(ctx.place, null, "位置超过 2h 是旧数据，不能拿来当『你在哪』");
  assert.equal(ctx.openLoops.length, 5, "openLoops 去重且最多 5 条");
  assert.equal(ctx.openLoops[0], "还在办：装修");
  assert.deepEqual(ctx.interests, ["网球"], "空行与重复都被清掉");

  const same = buildSharedContext({
    actorId: "u1",
    at: T0 + 10 * 60_000,
    presence: { state: "active", since: T0 - 8 * 60_000 },
    screenFocus: { kind: "coding", since: T0 - 52 * 60_000 },
    place: { kind: "home", label: "家", updatedMinutesAgo: 190 },
    activity: "still",
    mood: "stressed",
    idleMinutes: 125,
    openLoops: ["还在办：装修", "还没聊到：面试", "a", "b", "c"],
    interests: ["网球"],
  });
  assert.equal(same.version, ctx.version, "只有时间前进、事实没变 → 版号不变");

  const changed = buildSharedContext({
    actorId: "u1",
    at: T0,
    interests: ["网球", "爬山"],
  });
  assert.notEqual(changed.version, ctx.version, "事实变了 → 版号必须变");
  assert.equal(contextVersion(ctx), ctx.version);
});

test("没聊完的事：目标 / 过点日程 / 待跟进承诺统一收口，不重复不超量", () => {
  const loops = collectOpenLoops({
    activeGoal: "装修",
    overdueTasks: [{ title: "交方案" }, { title: "交方案" }, { title: "" }],
    followUps: [{ event: "下午面试" }],
  });
  assert.deepEqual(loops, ["还在办：装修", "还没弄完：交方案", "还没聊到：下午面试"]);
});

test("人格与长期记忆进 pulse 材料：不是一套独立的推送 prompt", () => {
  const prompt = buildPulsePrompt(
    new Date(T0),
    {
      tasks: [],
      unread: [],
      goals: [],
      interests: [],
      persona: "我是老王，说话直，不客套。",
      memories: ["上次聊到他想去三亚"],
    },
    { socialPath: true },
  );
  assert.ok(prompt.includes("【你是谁（人格正文，说话按这个来）】"));
  assert.ok(prompt.includes("说话直，不客套"));
  assert.ok(prompt.includes("【长期记忆里跟今天有关的"));
  assert.ok(prompt.includes("上次聊到他想去三亚"));
});

test("共享块：情报判断与 pulse 看到的是同一套人话", () => {
  const ctx = buildSharedContext({
    actorId: "u1",
    at: T0,
    presence: { state: "active", since: T0 - 8 * 60_000 },
    place: { kind: "work", label: "公司", updatedMinutesAgo: 3 },
    activity: "walking",
    mood: "negative",
    idleMinutes: 125,
    openLoops: ["还没聊到：下午面试"],
    interests: ["网球"],
    recentTurns: ["我明天有个面试"],
  });
  assert.equal(placeText(ctx), "公司 · 3 分钟前的位置");
  const lines = sharedContextPromptLines(ctx).join("\n");
  for (const expected of ["【他此刻状态】在线：active（已持续 8 分钟）", "【他此刻在哪】公司", "【他在动吗】在走路", "【没聊完的事】", "【他关注的话题】网球", "【距上次对话】2 小时 5 分钟前"]) {
    assert.ok(lines.includes(expected), `共享块缺：${expected}\n实际：${lines}`);
  }

  // pulse 复用它喂 prompt（接话素材真的进了材料，而不是只在 fixture 里有）
  const prompt = buildPulsePrompt(
    new Date(T0),
    {
      tasks: [],
      unread: [],
      goals: [],
      interests: ["网球"],
      findings: [],
      openLoops: ["还没聊到：下午面试"],
      idleMinutes: 125,
      presence: presenceText(ctx),
    },
    { socialPath: true },
  );
  assert.ok(prompt.includes("【没聊完的事】"), "pulse prompt 必须有接话素材");
  assert.ok(prompt.includes("还没聊到：下午面试"));
});
