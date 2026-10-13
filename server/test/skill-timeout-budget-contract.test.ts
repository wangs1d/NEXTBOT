/**
 * 技能声明超时预算契约回归（2026-10-12 贵阳轮「行程卡整轮缺席」根因固化）。
 *
 * 事故链：`SkillMetadata.timeoutMs` 是工具作者对「这活要跑多久」的权威陈述，但
 * 此前**只被 skill-sandbox 消费**；工具循环走自己那张硬编码超时表 → 实盘量出
 * **10 个技能声明 30~120s，全部被 30s 默认值钳住**，其中 `travel.plan-itinerary`
 * 声明 120s、冷启动实测 20~57s，被 30s 击杀（ok=false）→ 行程回执缺失 → 行程卡
 * 整轮缺席 + 出口闸判「工具全败」→ 模型手写逐日行程直穿气泡（无卡、裸 markdown）。
 *
 * 本测试把「技能声明」与「工具循环实取超时」**逐技能**锁死：任一侧漂移即红。
 * 语料走**真实注册链**（SkillManager + 生产同款 register*BuiltinSkills），不手搓
 * manifest —— 手搓会构造生产不存在的描述，回归测不到真实装配 bug（见
 * lane-tool-travel-promotion.test.ts 的同类教训）。
 *
 * 关键点：注入器用生产的 `declaredSkillTimeoutFromManager`（单一事实源），不是
 * 测试自己复制的 lambda —— 否则有人把 `list(true)` 改成 `list()` 测试照样绿。
 */
process.env.AGENT_TOOL_SEARCH_ENABLED = "on";

import assert from "node:assert/strict";
import test, { after } from "node:test";

import { SkillManager } from "../src/skills/skill-manager.js";
import { registerTravelPlanningBuiltinSkills } from "../src/skills/travel-planning/travel-planning-skills.js";
import { registerTravelCommuteBuiltinSkills } from "../src/skills/travel-planning/travel-commute-skills.js";
import { registerPictureBuiltinSkills } from "../src/skills/builtin/picture-skills.js";
import { registerBookingTravelBuiltinSkills } from "../src/skills/builtin/booking-travel-skills.js";
import { registerFinanceIngestBuiltinSkills } from "../src/skills/builtin/finance-ingest-skills.js";
import { registerHabitLoopBuiltinSkills } from "../src/skills/builtin/habit-loop-skills.js";
import { registerMerchantOrderBuiltinSkills } from "../src/skills/builtin/merchant-order-skills.js";
import { registerAlipayPaymentBuiltinSkills } from "../src/skills/builtin/alipay-payment-skills.js";
import { registerArrivalConciergeBuiltinSkills } from "../src/skills/builtin/arrival-concierge-skills.js";
import { registerVirtualPhoneBuiltinSkills } from "../src/skills/builtin/virtual-phone-skills.js";
import { registerAgentWorldIdentityBuiltinSkills } from "../src/skills/builtin/agent-world-identity-skills.js";
import {
  resolveToolExecutionTimeoutMs,
  setDeclaredSkillTimeoutResolver,
  declaredSkillTimeoutFromManager,
} from "../src/external-model/openai-compatible-tool-loop.js";

/** 任意属性访问/调用都返回自身的兜底代理——register* 只读 manifest，handler 的
 * deps 在注册期不被真正调用（若未来某注册函数在注册期就访问 deps，这里会立刻暴露）。 */
const stubDeps = new Proxy(function () {} as unknown as object, {
  get: (_t, prop) => {
    if (prop === "then") return undefined;
    if (prop === Symbol.toPrimitive || prop === "toString") return () => "[stub]";
    return stubDeps;
  },
  apply: () => stubDeps,
  construct: () => stubDeps,
});

const skillManager = new SkillManager();
const register = (fn: (cb: (s: never) => void, deps: never) => void): void => {
  fn(((s: unknown) => skillManager.register(s as never)) as never, stubDeps as never);
};

register(registerTravelPlanningBuiltinSkills as never);
register(registerTravelCommuteBuiltinSkills as never);
register(registerPictureBuiltinSkills as never);
register(registerBookingTravelBuiltinSkills as never);
register(registerFinanceIngestBuiltinSkills as never);
register(registerHabitLoopBuiltinSkills as never);
register(registerMerchantOrderBuiltinSkills as never);
register(registerAlipayPaymentBuiltinSkills as never);
register(registerArrivalConciergeBuiltinSkills as never);
register(registerVirtualPhoneBuiltinSkills as never);
register(registerAgentWorldIdentityBuiltinSkills as never);

// 生产同款注入（单一事实源）
setDeclaredSkillTimeoutResolver(declaredSkillTimeoutFromManager(skillManager));
after(() => setDeclaredSkillTimeoutResolver(null));

const manifests = skillManager.list(true);
const slow = manifests.filter((m) => (m.timeoutMs ?? 0) > 30_000);

test("真实注册链产出技能 manifest（语料非手搓）", () => {
  assert.ok(manifests.length >= 30, `技能数异常偏少: ${manifests.length}`);
});

test("存在声明 >30s 的慢技能（声明机制本身存在，未被整体移除）", () => {
  assert.ok(
    slow.length >= 8,
    `声明 >30s 的技能仅 ${slow.length} 个——声明机制疑似被移除，回归失去意义`,
  );
});

test("逐技能：工具循环实取超时 ≥ 技能声明（不得被 30s 默认值钳制）", () => {
  const violations: string[] = [];
  for (const m of slow) {
    const declared = m.timeoutMs!;
    const effective = resolveToolExecutionTimeoutMs(m.name);
    if (effective < declared) {
      violations.push(`${m.name}: 声明 ${declared}ms 但实取 ${effective}ms`);
    }
  }
  assert.equal(
    violations.length,
    0,
    `以下技能声明未被采纳（会被 30s 默认值击杀）:\n  ${violations.join("\n  ")}`,
  );
});

test("关键慢技能（实盘事故面）逐一断言", () => {
  // 事故主角：声明 120s，冷启动实测 20~57s
  assert.equal(
    resolveToolExecutionTimeoutMs("travel.plan-itinerary"),
    120_000,
    "travel.plan-itinerary 实取超时应为 120s",
  );
  // 其余实盘量出被钳制的技能，逐一锁死
  for (const [name, ms] of [
    ["picture.generate", 120_000],
    ["picture.evaluate", 60_000],
    ["picture.stylize", 60_000],
    ["picture.housekeeping", 60_000],
    ["booking.travel-pay", 60_000],
    ["finance.ingest-text", 60_000],
    ["habit.run-now", 60_000],
    ["habit.confirm-run", 60_000],
    ["travel.edit-itinerary", 60_000],
  ] as const) {
    assert.ok(
      resolveToolExecutionTimeoutMs(name) >= ms,
      `${name} 实取超时 ${resolveToolExecutionTimeoutMs(name)}ms < 声明 ${ms}ms`,
    );
  }
});

test("钳制语义未被破坏：未声明/快工具仍走兜底档，不因声明层被放大", () => {
  assert.equal(resolveToolExecutionTimeoutMs("search_web"), 6_500);
  assert.equal(resolveToolExecutionTimeoutMs("some_unknown_tool"), 30_000);
  // 声明值小于兜底档时不降级（声明是下界，取大）
  assert.ok(resolveToolExecutionTimeoutMs("travel.plan-itinerary") >= 30_000);
});
