// §3.10 频率与用户控制：三档预算、连续忽略降频、可解释文案、频率档读写
import test from "node:test";
import assert from "node:assert/strict";
import { FrequencyGovernor } from "../src/proactivity/frequency-governor.js";
import { explainTiming } from "../src/proactivity/explain.js";
import { TouchpointPlanner } from "../src/proactivity/touchpoint-planner.js";
import { applyFrequencyTier, frequencyTierOf } from "../src/routes/http/user-preferences.js";
import type { ProactiveProposal } from "../src/proactivity/pipeline-types.js";

const NOON = new Date("2026-11-23T12:00:00+08:00").getTime();
const at = (min: number) => new Date(NOON + min * 60_000);

const gov = (tier: "quiet" | "normal" | "chatty") =>
  new FrequencyGovernor({ ignoreEnv: true, tierOf: () => tier });

const socialOk = (g: FrequencyGovernor) =>
  g.canTrigger("u1", "greeting", "low", at(0), { awake: true, tier: "social" });

test("governor: 三档社交预算（只在有事时 0 / 正常 2 / 多聊点 4）", () => {
  assert.equal(gov("quiet").socialBudgetOf("u1"), 0);
  assert.equal(gov("normal").socialBudgetOf("u1"), 2);
  assert.equal(gov("chatty").socialBudgetOf("u1"), 4);
  // 只在有事时：第一条社交话都不给过，事务类不受这一档影响
  const quiet = gov("quiet");
  assert.equal(socialOk(quiet).allowed, false);
  assert.match(String(quiet.usageSnapshot()[0]?.socialBudget ?? quiet.socialBudgetOf("u1")), /0/);
  const must = quiet.canTrigger("u1", "schedule_reminder", "high", at(0), { tier: "must" });
  assert.equal(must.allowed, true);
});

test("governor: 正常档第 3 条社交被拦，多聊点第 3、4 条仍放行", () => {
  const normal = gov("normal");
  for (let i = 0; i < 2; i++) normal.record("u1", `greeting${i}`, at(i), "social");
  const blocked = normal.canTrigger("u1", "greeting", "low", at(10), { awake: true, tier: "social" });
  assert.equal(blocked.allowed, false);
  assert.match(String(blocked.reason), /social_budget_exhausted\(2\/2,tier=normal\)/);

  const chatty = gov("chatty");
  for (let i = 0; i < 3; i++) chatty.record("u1", `greeting${i}`, at(i), "social");
  assert.equal(
    chatty.canTrigger("u1", "greeting", "low", at(10), { awake: true, tier: "social" }).allowed,
    true,
  );
});

test("governor: 同一 kind 连续 3 次被忽略 → 冷却再翻一档，被回应即清零", () => {
  const g = new FrequencyGovernor({ ignoreEnv: true });
  const base = g.snapshot().cooldowns.care ?? 0;
  g.noteOutcome("care", false);
  const after1 = g.snapshot().cooldowns.care ?? 0;
  assert.equal(after1, Math.round(base * 1.5));
  g.noteOutcome("care", false);
  const after2 = g.snapshot().cooldowns.care ?? 0;
  assert.equal(after2, Math.round(after1 * 1.5));
  assert.equal(g.ignoreStreakOf("care"), 2);
  // 第 3 次：×1.5 之上再 ×2，连击清零
  g.noteOutcome("care", false);
  assert.equal(g.snapshot().cooldowns.care, Math.min(Math.round(after2 * 1.5 * 2), 48 * 3600_000));
  assert.equal(g.ignoreStreakOf("care"), 0);
  // 正反馈把连击打回原点：再来两次忽略不该触发翻倍
  g.noteOutcome("care", false);
  g.noteOutcome("care", true);
  assert.equal(g.ignoreStreakOf("care"), 0);
});

test("governor: 连击数随快照落盘（重启不把「他连着没看」的账清零）", () => {
  const g1 = new FrequencyGovernor({ ignoreEnv: true });
  g1.noteOutcome("care", false);
  g1.noteOutcome("care", false);
  const snap = g1.snapshot();
  assert.equal(snap.streaks?.care, 2);
  const g2 = new FrequencyGovernor({ ignoreEnv: true });
  g2.restore(snap);
  assert.equal(g2.ignoreStreakOf("care"), 2);
  g2.noteOutcome("care", false);
  assert.equal(g2.ignoreStreakOf("care"), 0, "第 3 次触发翻倍后清零");
});

test("governor: 跟进类冷却按「这件事」计——不同事件互不阻挡，同一事件仍在冷却里（§3.5 限制）", () => {
  const g = new FrequencyGovernor({ ignoreEnv: true });
  const fu = (id: string) => `commitment:followup:${id}`;
  // 事件 A 的跟进在下班触点说过一遍
  g.record("u1", "commitment", at(0), "social", fu("a"));
  // 同一件事再说第二遍 → 拦（§3.5「同一事件最多跟进 1 次」）
  const repeat = g.canTrigger("u1", "commitment", "low", at(60), { tier: "social", identity: fu("a") });
  assert.equal(repeat.allowed, false);
  // 理由串仍报 kind 名（explain.ts 按 /^kind_cooldown\(([^,]+),/ 解析，带复合键就翻不出人话）
  assert.match(String(repeat.reason), /^kind_cooldown\(commitment,\d+m<\d+m\)$/);
  // 另一件**不同的事**（聚会）到点该说：A 的冷却不该把 B 吞成 throttled。
  // §3.5 的三条限制是「同一事件 1 次 / 点过别跟进则同类 30 天 / 计入社交日预算」，
  // 没有「同类话一天只说一件」；跨事件的合并与顺延归 §3.4 的 slot 容量管。
  assert.equal(
    g.canTrigger("u1", "commitment", "low", at(61), { tier: "social", identity: fu("b") }).allowed,
    true,
    "不同事件不共用冷却，总量由社交日预算与触点容量兜",
  );
  // 非跟进类不受身份影响：greeting 仍是 kind 级「每天一次」
  const greet = new FrequencyGovernor({ ignoreEnv: true });
  greet.record("u1", "greeting", at(0));
  assert.equal(greet.canTrigger("u1", "greeting", "low", at(61), { identity: "anything" }).allowed, false);
  // 没带身份的调用（hub 快路径 / 旧调用点）退回按 kind 计——既有语义一字未改
  const legacy = new FrequencyGovernor({ ignoreEnv: true });
  legacy.record("u1", "followup", at(0), "social");
  assert.equal(legacy.canTrigger("u1", "followup", "low", at(10)).allowed, false);
});

test("governor: tierAllows——只在有事时关跟进与「了解你」，其余两档放行", () => {
  assert.equal(gov("quiet").tierAllows("u1", "followup"), false);
  assert.equal(gov("quiet").tierAllows("u1", "ask_you"), false);
  assert.equal(gov("normal").tierAllows("u1", "followup"), true);
  assert.equal(gov("chatty").tierAllows("u1", "ask_you"), true);
});

test("explain: 裁决链翻成人话（排期/合并/必达各归其位）", () => {
  const iso = new Date(NOON + 60 * 60_000).toISOString();
  const slot = explainTiming({ kind: "agent_pulse", tier: "social" }, [`wait_until:${iso}`]);
  assert.match(slot, /排到 13:00/);
  assert.match(
    explainTiming({ kind: "life_reminder" }, ["slot:tp:u1:2026-11-23:midday 同触点合并 → k1"]),
    /并成一条/,
  );
  assert.match(explainTiming({ kind: "alarm_wake", tier: "must" }, ["tier=must_bypass"]), /到点必须/);
  assert.match(explainTiming({ kind: "schedule_reminder", tier: "must" }, ["deliver_now"]), /提醒时间到了/);
  // 没认出来的链也要有话说（点了「为什么」不能空着）
  assert.ok(explainTiming({ kind: "brand_new_kind" }, ["something_else"]).length > 0);
});

test("planner: 多聊点档的 Pulse 即时豁免（其余类型仍排槽）", () => {
  const proposal = (kind: string): ProactiveProposal => ({
    proposalId: `p_${kind}`,
    actorId: "u1",
    kind,
    tier: "social",
    importance: "low",
    dedupKey: `k_${kind}`,
    title: "t",
    summary: "s",
    evidence: [],
    createdAt: NOON,
    source: "test",
  });
  const planner = new TouchpointPlanner({
    timing: { postWakeMinutes: () => 480 },
    previewMinutesOf: () => 21 * 60,
    nowFn: () => NOON,
  });
  const pulse = planner.assign("u1", proposal("agent_pulse"), NOON, {
    immediate: true,
    reason: "tier_chatty_pulse",
  });
  assert.equal(pulse.kind, "immediate");
  if (pulse.kind === "immediate") assert.equal(pulse.reason, "tier_chatty_pulse");
  const other = planner.assign("u1", proposal("agent_pulse"), NOON);
  assert.equal(other.kind, "slot");
});

test("prefs: 频率档读写（非法值拒绝，档位同步给频控读取）", () => {
  assert.equal(frequencyTierOf("u_tier"), "normal", "未设定 = 正常档");
  assert.equal(applyFrequencyTier("u_tier", "quiet"), "quiet");
  assert.equal(frequencyTierOf("u_tier"), "quiet");
  assert.equal(applyFrequencyTier("u_tier", "chatty"), "chatty");
  assert.equal(frequencyTierOf("u_tier"), "chatty");
  assert.equal(applyFrequencyTier("u_tier", "loud"), null, "非法档位不写入");
  assert.equal(frequencyTierOf("u_tier"), "chatty");
});
