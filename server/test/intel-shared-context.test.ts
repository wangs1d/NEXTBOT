// 情报判断共享上下文 + 投递层级（接缝 2 / 3）。
import assert from "node:assert/strict";
import { test } from "node:test";

import { buildJudgeUserPrompt } from "../src/proactivity/intel/intel-judge.js";
import { intelTierFor, INTEL_MUST_WINDOW_MS } from "../src/proactivity/intel/intel-tier.js";
import { buildSharedContext } from "../src/proactivity/context-snapshot.js";
import type { IntelJudgeInput } from "../src/proactivity/intel/intel-types.js";

const T0 = Date.UTC(2026, 10, 25, 2, 0, 0);

test("判断提示词：共享上下文与 AgentPulse 同源（位置/情绪/没聊完的事都进 Prompt）", () => {
  const shared = buildSharedContext({
    actorId: "u1",
    at: T0,
    presence: { state: "active", since: T0 - 5 * 60_000 },
    place: { kind: "work", label: "公司", updatedMinutesAgo: 4 },
    mood: "stressed",
    idleMinutes: 370,
    openLoops: ["还没聊到：下午面试"],
    interests: ["网球"],
    recentTurns: ["我明天有个面试"],
  });
  const input: IntelJudgeInput = {
    now: T0,
    timezone: "Asia/Shanghai",
    presence: "active",
    inConversation: false,
    lines: [{ id: "e1", source: "mail", at: T0, brief: "面试通知", state: "new" }],
    feedback: { recentSpoken: [], recentOutcomes: [] },
    styleBrief: "称呼：老王",
    shared,
  };
  const prompt = buildJudgeUserPrompt(input);
  for (const expected of ["共享上下文（与另一个主动性入口同一份事实）", "【他此刻在哪】公司", "【他最近的状态】压力大/有点累", "还没聊到：下午面试", "【距上次对话】6 小时 10 分钟前"]) {
    assert.ok(prompt.includes(expected), `判断提示词缺：${expected}\n实际：${prompt}`);
  }
});

test("投递层级：要拍板 / 4h 内失效走 must，其余降为 social 进触点槽", () => {
  assert.deepEqual(
    intelTierFor({ judgment: { verdict: "now", reason: "", needsConfirm: true } }, T0, {}),
    { tier: "must", reason: "needs_confirm" },
  );
  assert.deepEqual(
    intelTierFor(
      { judgment: { verdict: "now", reason: "" }, expiresAt: T0 + INTEL_MUST_WINDOW_MS - 1 },
      T0,
      {},
    ),
    { tier: "must", reason: "expiring_soon" },
  );
  assert.deepEqual(
    intelTierFor(
      { judgment: { verdict: "now", reason: "" }, expiresAt: T0 + INTEL_MUST_WINDOW_MS + 1 },
      T0,
      {},
    ),
    { tier: "social", reason: "can_slot" },
  );
  assert.deepEqual(
    intelTierFor({ judgment: { verdict: "now", reason: "" } }, T0, {}),
    { tier: "social", reason: "can_slot" },
    "没有期限也没有拍板 → 不抢社交预算",
  );
  assert.deepEqual(
    intelTierFor({ judgment: { verdict: "now", reason: "", needsConfirm: true } }, T0, {
      INTEL_TIER_SPLIT: "0",
    }),
    { tier: "must", reason: "split_disabled" },
    "一键回退旧行为",
  );
});
