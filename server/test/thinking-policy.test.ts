/**
 * 思考档位策略层（thinking-policy）行为测试。
 *
 * 契约（2026-11-12 通用化）：
 * - 无历史样本时给保守默认档（high），**永不返回 undefined**；
 * - 显式 env 覆盖优先于一切学习结果；
 * - 历史样本显示 high 明显超预算、而 low 能进预算 → 自动降 low；
 * - 样本不足或介于两者之间 → 维持默认档（宁可慢也不悄悄降质量）；
 * - 统计键只认模型名，跨调用路径（provider 直连 / tool-loop）共享同一张曲线。
 */
import assert from "node:assert/strict";
import test from "node:test";

const {
  resolveThinkingEffort,
  recordThinkingLatency,
  resetThinkingStatsForTest,
  effortSentFrom,
  diagnoseImplicitEffortTrap,
  snapshotThinkingStats,
  buildThinkingBudgetHealth,
  describeThinkingBudgetForStartup,
} = await import("../src/external-model/thinking-policy.js");

const MODEL = "test-model-effort";

function feed(effort: "low" | "high" | "none", ttft: number, times = 3): void {
  for (let i = 0; i < times; i += 1) {
    recordThinkingLatency({ providerId: "test", model: MODEL, effortSent: effort, ttftMs: ttft });
  }
}

test("无样本：返回默认 high，source=default", () => {
  resetThinkingStatsForTest();
  const r = resolveThinkingEffort("test", MODEL, { budgetMs: 4000 });
  assert.equal(r.effort, "high");
  assert.equal(r.source, "default");
});

test("env 覆盖优先于学习结果，且非法值不生效", () => {
  resetThinkingStatsForTest();
  feed("high", 12000);
  feed("low", 800);
  const prev = process.env.TEST_THINKING_EFFORT;
  try {
    process.env.TEST_THINKING_EFFORT = "max";
    const r = resolveThinkingEffort("test", MODEL, {
      envOverride: "TEST_THINKING_EFFORT",
      budgetMs: 4000,
    });
    assert.equal(r.effort, "max");
    assert.equal(r.source, "env");

    process.env.TEST_THINKING_EFFORT = "turbo";
    const r2 = resolveThinkingEffort("test", MODEL, {
      envOverride: "TEST_THINKING_EFFORT",
      budgetMs: 4000,
    });
    assert.notEqual(r2.source, "env");
  } finally {
    if (prev === undefined) delete process.env.TEST_THINKING_EFFORT;
    else process.env.TEST_THINKING_EFFORT = prev;
  }
});

test("high 在预算内：保留 high（不轻易降质量）", () => {
  resetThinkingStatsForTest();
  feed("high", 2000);
  const r = resolveThinkingEffort("test", MODEL, { budgetMs: 4000 });
  assert.equal(r.effort, "high");
  assert.equal(r.source, "learned");
});

test("high 明显超预算且 low 能进预算：自动降 low", () => {
  resetThinkingStatsForTest();
  feed("high", 12000);
  feed("low", 800);
  const r = resolveThinkingEffort("test", MODEL, { budgetMs: 4000 });
  assert.equal(r.effort, "low");
  assert.equal(r.source, "learned");
});

test("high 超预算但 low 也进不去：维持 high（不瞎降）", () => {
  resetThinkingStatsForTest();
  feed("high", 12000);
  feed("low", 9000);
  const r = resolveThinkingEffort("test", MODEL, { budgetMs: 4000 });
  assert.equal(r.effort, "high");
});

test("样本不足（<3）不参与决策", () => {
  resetThinkingStatsForTest();
  feed("high", 20000, 1);
  const r = resolveThinkingEffort("test", MODEL, { budgetMs: 4000 });
  assert.equal(r.effort, "high");
  assert.equal(r.source, "default");
});

test("跨调用路径共享曲线：不同 providerId 写同一模型的样本", () => {
  resetThinkingStatsForTest();
  for (let i = 0; i < 3; i += 1) {
    recordThinkingLatency({ providerId: "openai-compatible", model: MODEL, effortSent: "high", ttftMs: 1500 });
  }
  const r = resolveThinkingEffort("zhipu", MODEL, { budgetMs: 4000 });
  assert.equal(r.source, "learned");
  assert.equal(r.effort, "high");
});

test("effortSentFrom：从 extraBody 反推档位，缺省为 none", () => {
  assert.equal(effortSentFrom({ reasoning_effort: "high" }), "high");
  assert.equal(effortSentFrom({ reasoning_effort: "MAX" }), "max");
  assert.equal(effortSentFrom({ reasoning_effort: "turbo" }), "none");
  assert.equal(effortSentFrom({}), "none");
  assert.equal(effortSentFrom(undefined), "none");
});

test("诊断：不下发档位显著更慢时给出证据", () => {
  resetThinkingStatsForTest();
  feed("none", 15000);
  feed("high", 2000);
  const diag = diagnoseImplicitEffortTrap("zhipu", MODEL);
  assert.ok(diag);
  assert.ok(diag!.ratio >= 1.5);
});

test("snapshot 输出 P50/P90 与样本数", () => {
  resetThinkingStatsForTest();
  feed("high", 1000);
  feed("high", 2000);
  feed("high", 3000);
  const snap = snapshotThinkingStats();
  const key = Object.keys(snap).find((k) => k.includes(MODEL));
  assert.ok(key);
  // 每档默认喂 3 次样本 = 9 条
  assert.equal(snap[key!].high.n, 9);
  assert.ok(snap[key!].high.p50 >= 1000);
});

test("健康快照：返回各模型档位曲线与诊断，空表时不抛错", () => {
  resetThinkingStatsForTest();
  const empty = buildThinkingBudgetHealth();
  assert.equal(empty.totalModels, 0);
  assert.deepEqual(empty.models, []);

  feed("high", 1800);
  feed("low", 700);
  const health = buildThinkingBudgetHealth();
  assert.equal(health.totalModels, 1);
  assert.equal(health.models[0].model, MODEL);
  assert.ok(health.models[0].efforts.high.p50 > 0);
  assert.equal(health.models[0].efforts.high.n, 3);
});

test("健康快照：limit 只截断返回条数，不改变总数", () => {
  resetThinkingStatsForTest();
  feed("high", 1500);
  for (let i = 0; i < 5; i += 1) {
    for (let j = 0; j < 3; j += 1) {
      recordThinkingLatency({ providerId: "test", model: `other-${i}`, effortSent: "high", ttftMs: 1200 });
    }
  }
  const health = buildThinkingBudgetHealth(2);
  assert.equal(health.totalModels, 6);
  assert.equal(health.models.length, 2);
});

test("启动摘要：空表给可读提示，有样本给出曲线，陷阱进 traps", () => {
  resetThinkingStatsForTest();
  const empty = describeThinkingBudgetForStartup();
  assert.match(empty.line, /暂无历史延迟样本/);
  assert.equal(empty.traps.length, 0);

  feed("high", 2000);
  const withData = describeThinkingBudgetForStartup();
  assert.match(withData.line, /已加载 1 个模型的档位曲线/);
  assert.match(withData.line, new RegExp(MODEL));
  assert.match(withData.line, /p50=2000ms/);

  resetThinkingStatsForTest();
  feed("none", 15000);
  feed("high", 2000);
  const trap = describeThinkingBudgetForStartup();
  assert.equal(trap.traps.length, 1);
  assert.equal(trap.traps[0].model, MODEL);
  assert.ok(trap.traps[0].ratio >= 1.5);
});
