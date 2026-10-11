/**
 * 顺嘴搭车队列单测（2026-10-01 P1）。
 *
 * 覆盖：挂起/取货、同 kind 去重、织入间隔、TTL 过期、每轮一条、
 * 回滚开关、旁注形态（P2）指令文本。
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  TurnAsideQueue,
  formatTurnAsidePrompt,
  isTurnAsideEnabled,
  isTurnAsideMediumEnabled,
} from "../src/proactivity/turn-aside-queue.js";

const T0 = 1_790_000_000_000;
const HOUR = 60 * 60_000;

function queue(now: number): TurnAsideQueue {
  return new TurnAsideQueue({ nowFn: () => now });
}

test("挂起 → 下一轮取走（每轮至多一条，先到期优先级按队列序）", () => {
  const q = queue(T0);
  assert.equal(
    q.tryEnqueue({ actorId: "u1", kind: "rhythm_insight", title: "节律观察", summary: "最近三天入睡偏晚" }),
    true,
  );
  const item = q.takeForTurn("u1");
  assert.ok(item);
  assert.equal(item.kind, "rhythm_insight");
  assert.equal(item.hint, "最近三天入睡偏晚");
  assert.equal(q.takeForTurn("u1"), null, "取走即交付，本轮不再有第二条");
});

test("同 kind 挂起中去重：拒绝并回退即时路径", () => {
  const q = queue(T0);
  assert.equal(q.tryEnqueue({ actorId: "u1", kind: "care", title: "a" }), true);
  assert.equal(q.tryEnqueue({ actorId: "u1", kind: "care", title: "b" }), false);
  // 不同 kind 可并存
  assert.equal(q.tryEnqueue({ actorId: "u1", kind: "interest_share", title: "c" }), true);
  assert.equal(q.pending("u1").length, 2);
});

test("织入间隔：同 kind 4 小时内新挂起被拒", () => {
  let now = T0;
  const q = new TurnAsideQueue({ nowFn: () => now });
  q.tryEnqueue({ actorId: "u1", kind: "care", title: "a" });
  assert.ok(q.takeForTurn("u1"));
  now = T0 + 3 * HOUR;
  assert.equal(q.tryEnqueue({ actorId: "u1", kind: "care", title: "b" }), false, "间隔内拒绝");
  now = T0 + 4 * HOUR + 1;
  assert.equal(q.tryEnqueue({ actorId: "u1", kind: "care", title: "c" }), true, "过间隔放行");
});

test("TTL：挂起超 2 小时无人接话即作废", () => {
  let now = T0;
  const q = new TurnAsideQueue({ nowFn: () => now });
  q.tryEnqueue({ actorId: "u1", kind: "care", title: "过期件" });
  now = T0 + 2 * HOUR + 60_000;
  assert.equal(q.takeForTurn("u1"), null);
  assert.equal(q.pending("u1").length, 0, "过期条目就地作废");
});

test("不同 actor 互不干扰；队列上限 3 条", () => {
  const q = queue(T0);
  for (const kind of ["a", "b", "c", "d"]) {
    q.tryEnqueue({ actorId: "u1", kind, title: kind });
  }
  assert.equal(q.pending("u1").length, 3, "上限裁剪");
  assert.equal(q.tryEnqueue({ actorId: "u2", kind: "a", title: "x" }), true, "他不受影响");
  assert.ok(q.takeForTurn("u2"));
});

test("回滚开关：PROACTIVITY_TURN_ASIDE=0 关闭", () => {
  const prev = process.env.PROACTIVITY_TURN_ASIDE;
  try {
    process.env.PROACTIVITY_TURN_ASIDE = "0";
    assert.equal(isTurnAsideEnabled(), false);
    process.env.PROACTIVITY_TURN_ASIDE = "1";
    assert.equal(isTurnAsideEnabled(), true);
    delete process.env.PROACTIVITY_TURN_ASIDE;
    assert.equal(isTurnAsideEnabled(), true, "默认开");
  } finally {
    if (prev === undefined) delete process.env.PROACTIVITY_TURN_ASIDE;
    else process.env.PROACTIVITY_TURN_ASIDE = prev;
  }
});

test("P2 旁注形态：织入指令含括号旁注形态与不搭不提约束", () => {
  const q = queue(T0);
  q.tryEnqueue({ actorId: "u1", kind: "care", title: "t", summary: "最近入睡偏晚" });
  const item = q.takeForTurn("u1")!;
  const block = formatTurnAsidePrompt(item);
  assert.match(block, /【顺嘴机会】/);
  assert.match(block, /（顺嘴一句：…）/);
  assert.match(block, /不搭就别提|绝不硬塞/);
  assert.match(block, /最近入睡偏晚/);
});

// ─── medium 扩面 + 超时升级（2026-10-01）───

test("medium 扩面开关：默认开，PROACTIVITY_TURN_ASIDE_MEDIUM=0 收窄", () => {
  const prev = process.env.PROACTIVITY_TURN_ASIDE_MEDIUM;
  try {
    delete process.env.PROACTIVITY_TURN_ASIDE_MEDIUM;
    assert.equal(isTurnAsideMediumEnabled(), true, "默认开");
    process.env.PROACTIVITY_TURN_ASIDE_MEDIUM = "0";
    assert.equal(isTurnAsideMediumEnabled(), false);
  } finally {
    if (prev === undefined) delete process.env.PROACTIVITY_TURN_ASIDE_MEDIUM;
    else process.env.PROACTIVITY_TURN_ASIDE_MEDIUM = prev;
  }
});

test("medium 过期升级：2h 没搭上车走 onExpire 回调，low 仍静默作废", () => {
  let now = T0;
  const q = new TurnAsideQueue({ nowFn: () => now });
  const expired: string[] = [];
  q.setOnExpire((item) => expired.push(`${item.importance}:${item.kind}`));
  q.tryEnqueue({ actorId: "u1", kind: "interest_alert", title: "中优", importance: "medium" });
  q.tryEnqueue({ actorId: "u1", kind: "care", title: "低优", importance: "low" });
  now = T0 + 2 * HOUR + 60_000;
  // take 触发的过期：medium 升级、low 丢弃
  const got = q.takeForTurn("u1");
  assert.ok(got === null || got.kind !== "interest_alert");
  assert.deepEqual(expired, ["medium:interest_alert"], "只有 medium 条目走升级回调");
});

test("prune 触发的过期同样升级 medium（不依赖用户聊天）", () => {
  let now = T0;
  const q = new TurnAsideQueue({ nowFn: () => now });
  const expired: string[] = [];
  q.setOnExpire((item) => expired.push(item.kind));
  q.tryEnqueue({ actorId: "u1", kind: "monthly_report", title: "月报", importance: "medium" });
  now = T0 + 7 * HOUR;
  assert.equal(q.prune(), 1);
  assert.deepEqual(expired, ["monthly_report"]);
  assert.equal(q.pending("u1").length, 0);
});

test("升级回调抛异常不外溢（吞掉并继续）", () => {
  let now = T0;
  const q = new TurnAsideQueue({ nowFn: () => now });
  q.setOnExpire(() => {
    throw new Error("boom");
  });
  q.tryEnqueue({ actorId: "u1", kind: "digest", title: "t", importance: "medium" });
  now = T0 + 7 * HOUR;
  assert.doesNotThrow(() => q.prune());
});
