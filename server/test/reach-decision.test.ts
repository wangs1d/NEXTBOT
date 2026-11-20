// 期望效用触达决策引擎单测：U=p·B−(1−p)·C / 价值挣得通道 / 反馈学习 / 规则优先级
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  BATCH_MIN_UTILITY,
  BURST_BREAKER,
  CHANNEL_POLICY,
  CONTEXT_COST_DIVISOR,
  DEFER_CONTEXT_COST,
  estimateAcceptance,
  evaluateReach,
  computeCost,
  computeValue,
  DEFAULT_BENEFICIARY,
  DEFAULT_URGENCY,
  IMPORTANCE_STAKES,
  reachValueFromImportance,
  REACH_CHANNELS,
  type ReachDecisionInput,
} from "../src/proactivity/reach-decision.js";

const CLEAN_CTX = { contextCost: 0, quietHours: false, online: true, recentBurst: 0 };

function input(overrides: Partial<ReachDecisionInput> = {}): ReachDecisionInput {
  // importance 被覆盖时，value 同步派生——否则 fixture 会出现"importance=low 但 stakes=medium"
  // 的自相矛盾状态（真实调用方不会这样，reachValueFromImportance 保证口径一致）。
  const importance = overrides.importance ?? "medium";
  const value = overrides.value ?? reachValueFromImportance(importance);
  return {
    actorId: "a1",
    kind: "interest_share",
    importance,
    value,
    context: { ...CLEAN_CTX },
    acceptance: 0.5,
    now: new Date("2026-11-19T10:00:00Z"),
    ...overrides,
  };
}

// ─── 反馈学习：Beta 后验 ───

test("estimateAcceptance: 无样本 = 均匀先验 0.5", () => {
  assert.equal(estimateAcceptance(0, 0), 0.5);
});

test("estimateAcceptance: 全正反馈靠近 1，全负反馈靠近 0", () => {
  assert.ok(estimateAcceptance(9, 0) > 0.9);
  assert.ok(estimateAcceptance(0, 9) < 0.1);
});

test("estimateAcceptance: 忽略是强负样本——正4负4 拉回 0.5", () => {
  assert.equal(estimateAcceptance(4, 4), 0.5);
  assert.ok(estimateAcceptance(4, 6) < 0.5);
});

// ─── 价值 / 成本计算 ───

test("computeValue: stakes 权重最大，beneficiary 平台受益打折", () => {
  const userBenefit = computeValue({ stakes: 1, urgency: 1, beneficiary: 1 });
  const platformBenefit = computeValue({ stakes: 1, urgency: 1, beneficiary: 0.5 });
  assert.equal(userBenefit, 1);
  assert.ok(platformBenefit < userBenefit);
  const lowStakes = computeValue({ stakes: 0.2, urgency: 1, beneficiary: 1 });
  assert.ok(lowStakes < userBenefit);
});

test("computeValue: stakes 主导，urgency/beneficiary 缺省走乘性基线", () => {
  assert.equal(DEFAULT_URGENCY, 0.4);
  assert.equal(DEFAULT_BENEFICIARY, 1);
  // stakes=0.7, urgency=0.4→0.85, beneficiary=1→1.0 ⇒ 0.7×0.85×1.0 ≈ 0.595
  const v = computeValue({ stakes: 0.7 });
  assert.ok(v > 0.5 && v < 0.7);
  // stakes=0 无论调制因子多高都得 0（加性模型会白送底分的 bug 已根修）
  assert.equal(computeValue({ stakes: 0, urgency: 1, beneficiary: 1 }), 0);
});

test("computeCost: 通道越重成本越高，上下文成本线性叠加", () => {
  const chat = computeCost("chat", CLEAN_CTX);
  const voiceMsg = computeCost("voice.message", CLEAN_CTX);
  const speak = computeCost("voice.speak", CLEAN_CTX);
  const phone = computeCost("phone", CLEAN_CTX);
  assert.ok(chat < voiceMsg && voiceMsg < speak && speak < phone);
  const busy = computeCost("chat", { ...CLEAN_CTX, contextCost: CONTEXT_COST_DIVISOR });
  assert.ok(busy > chat);
});

// ─── 规则优先级（先命中先出）───

test("规则1: explicit 绕过闸门——低价值也直通语音条", () => {
  const d = evaluateReach(input({ explicit: true, importance: "low", acceptance: 0.1 }));
  assert.equal(d.action, "send_now");
  assert.equal(d.channel, "voice.message");
  assert.match(d.reason, /explicit_request_bypass/);
});

test("规则1: must / critical 旁路，用请求通道或 chat", () => {
  const must = evaluateReach(input({ tier: "must", importance: "medium" }));
  assert.equal(must.action, "send_now");
  assert.match(must.reason, /must_bypass/);
  const critical = evaluateReach(input({ importance: "critical" }));
  assert.equal(critical.action, "send_now");
  const explicitChannel = evaluateReach(
    input({ explicit: true, requestedChannel: "phone" }),
  );
  assert.equal(explicitChannel.channel, "phone");
});

test("规则2: 离线 → defer，交管道挂起", () => {
  const d = evaluateReach(input({ context: { ...CLEAN_CTX, online: false } }));
  assert.equal(d.action, "defer");
  assert.match(d.reason, /offline_defer/);
});

test("规则3: 静默时段 → defer", () => {
  const d = evaluateReach(input({ context: { ...CLEAN_CTX, quietHours: true } }));
  assert.equal(d.action, "defer");
  assert.match(d.reason, /quiet_hours_defer/);
});

test("规则4: 高上下文成本 → defer 等 pause", () => {
  const d = evaluateReach(
    input({ context: { ...CLEAN_CTX, contextCost: DEFER_CONTEXT_COST * CONTEXT_COST_DIVISOR } }),
  );
  assert.equal(d.action, "defer");
  assert.match(d.reason, /high_context_cost/);
});

test("规则5: 突发熔断 → batch", () => {
  const d = evaluateReach(input({ context: { ...CLEAN_CTX, recentBurst: BURST_BREAKER } }));
  assert.equal(d.action, "batch");
  assert.match(d.reason, /burst_breaker/);
});

// ─── 价值挣得通道 ───

test("通道准入: 低价值 + 低接受 → drop（净效用为负）", () => {
  const d = evaluateReach(input({ importance: "low", acceptance: 0.2 }));
  assert.equal(d.action, "drop");
  assert.match(d.reason, /net_utility_negative/);
});

test("通道准入: 高价值 + 高接受 → 挣得重通道（播报或来电）", () => {
  // 用 importance=high（非 critical），避免 must 旁路——专门测"价值挣得通道"这条规则
  const d = evaluateReach(
    input({
      importance: "high",
      value: { stakes: 0.95, urgency: 0.9, beneficiary: 1 },
      acceptance: 0.95,
    }),
  );
  assert.equal(d.action, "send_now");
  assert.ok(
    d.channel === "voice.speak" || d.channel === "phone",
    `期望重通道，实际=${d.channel}`,
  );
});

test("通道准入: 中等价值 → chat 或 voice.message，不会误打电话", () => {
  const d = evaluateReach(input({ importance: "medium", acceptance: 0.6 }));
  assert.equal(d.action, "send_now");
  assert.ok(
    d.channel === "chat" || d.channel === "voice.message",
    `期望轻通道，实际=${d.channel}`,
  );
  assert.notEqual(d.channel, "phone");
});

test("负反馈抑制: 同一提案接受率从 0.9 降到 0.1 → 从 send_now 变 drop", () => {
  const hi = evaluateReach(input({ importance: "medium", acceptance: 0.9 }));
  const lo = evaluateReach(input({ importance: "medium", acceptance: 0.1 }));
  assert.equal(hi.action, "send_now");
  assert.equal(lo.action, "drop");
  assert.ok(lo.utility < hi.utility);
});

// ─── 诊断输出完整性 ───

test("诊断字段: perChannel 覆盖全部通道且 utility 排序合理", () => {
  const d = evaluateReach(input());
  assert.equal(d.perChannel.length, REACH_CHANNELS.length);
  assert.deepEqual(
    d.perChannel.map((c) => c.channel),
    [...REACH_CHANNELS],
  );
  // 同上下文下通道越重 utility 越低
  for (let i = 1; i < d.perChannel.length; i++) {
    assert.ok(d.perChannel[i].utility <= d.perChannel[i - 1].utility);
  }
  assert.equal(CHANNEL_POLICY.chat.intrusion < CHANNEL_POLICY.phone.intrusion, true);
  assert.ok(d.p >= 0 && d.p <= 1);
  assert.ok(d.value >= 0 && d.value <= 1);
});

test("通道准入阈值生效: admission 高于该值才 admitted", () => {
  const d = evaluateReach(input({ importance: "low", acceptance: 0.9 }));
  for (const c of d.perChannel) {
    assert.equal(c.admitted, c.utility >= CHANNEL_POLICY[c.channel].admission);
  }
});

test("batch 下限常量与规则8衔接（maxUtility < 下限 → drop）", () => {
  assert.equal(BATCH_MIN_UTILITY, 0);
  const d = evaluateReach(input({ importance: "low", acceptance: 0.05 }));
  assert.equal(d.action, "drop");
  assert.ok(d.utility < BATCH_MIN_UTILITY);
});

// ─── 关系价值（2026-11-19 主动性重构 P0）────────────────────────────
// 旧模型只有 stakes：社交型主动（打招呼/接话/关心）信息量低 → low stakes →
// 被忽略两次后 p 下降 → U 转负被 drop。关系价值给这类开口单独计价。

test("computeValue: 关系价值抬升下限，但不改变信息价值主导", () => {
  const pureLow = computeValue({ stakes: 0.2 });
  const withRelation = computeValue({ stakes: 0.2, relationship: 0.5 });
  const pureCritical = computeValue({ stakes: 0.95 });
  assert.ok(withRelation > pureLow, "关系价值必须真的抬高价值分");
  assert.ok(withRelation < pureCritical, "但抬不过 critical——紧急事务仍排前面");
  // 关系价值拉满 = 0.75 stakes，介于 high(0.7) 与 critical(0.95) 之间
  const maxRelation = computeValue({ stakes: 0, relationship: 1 });
  assert.ok(maxRelation > computeValue({ stakes: 0.7 }) * 0.95);
  assert.ok(maxRelation < pureCritical);
});

test("computeValue: 缺省 relationship 不影响既有调用方（向后兼容）", () => {
  assert.equal(computeValue({ stakes: 0.45 }), computeValue({ stakes: 0.45, relationship: 0 }));
  assert.equal(
    computeValue({ stakes: 0.45 }),
    computeValue({ stakes: 0.45, urgency: 0.4, beneficiary: 1 }),
  );
});

test("关系价值关键回归: 低接受率下社交话从 drop 翻成 send_now（聊天通道）", () => {
  // p=0.2（被忽略过几次的社交类），low 提案：旧模型净效用为负 → drop
  const without = evaluateReach(
    input({
      importance: "low",
      acceptance: 0.2,
      value: reachValueFromImportance("low"),
    }),
  );
  assert.equal(without.action, "drop", "只有 stakes 时社交话被丢掉");

  const withRel = evaluateReach(
    input({
      importance: "low",
      acceptance: 0.2,
      value: reachValueFromImportance("low", { relationship: 0.5 }),
    }),
  );
  assert.equal(withRel.action, "send_now", "有关系价值后这句话活下来");
  assert.equal(withRel.channel, "chat", "且只配用最轻的通道");
});

test("关系价值不会让社交话升级成重通道（不能假借关心打电话）", () => {
  const d = evaluateReach(
    input({
      importance: "low",
      tier: "social",
      acceptance: 0.9,
      value: reachValueFromImportance("low", { relationship: 1 }),
    }),
  );
  assert.equal(d.action, "send_now");
  assert.notEqual(d.channel, "phone", "social 层永远不许响铃");
  assert.notEqual(d.channel, "voice.speak", "social 层永远不许即时播报");
  assert.ok(["chat", "voice.message"].includes(String(d.channel)));
});

test("social 层通道上限也挡住显式请求的 phone", () => {
  const d = evaluateReach(
    input({
      importance: "low",
      tier: "social",
      explicit: false,
      respectRequestedChannel: true,
      requestedChannel: "phone",
      acceptance: 0.95,
      value: reachValueFromImportance("low", { relationship: 1 }),
    }),
  );
  assert.notEqual(d.channel, "phone", "respectRequestedChannel 不能绕过 social 通道上限");
});
