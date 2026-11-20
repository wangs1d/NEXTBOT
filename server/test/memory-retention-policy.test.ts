/**
 * 统一遗忘与恢复策略（memory/retention-policy）回归测试（2026-11-13）
 *
 * 锁定的三件事：
 *   1. 档位阶梯与阈值只有一份：KV 三档与认知图五档共用同一组边界；
 *   2. 恢复动作只有一份：升一档 + 加频次分 + 刷新时间戳；
 *   3. 两个存储的映射互相对齐（同一档在两边语义一致）。
 *
 * KV 摘要槽已下线（2026-11-20），恢复不再落 KV——涉及 KV 读写链路的用例随之退场。
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  HM_STAGE_BY_TIER,
  KV_BUCKET_BY_TIER,
  MEMORY_DECAY_HALF_LIFE_DAYS,
  RETENTION_RESTORE_BOOST,
  RETENTION_THRESHOLDS,
  TIER_BY_HM_STAGE,
  TIER_BY_KV_BUCKET,
  forgettingVerdict,
  hmStageAfterRestore,
  kvBucketAfterRestore,
  lowerTier,
  memoryDecayFactor,
  refreshMemoryLineTimestamp,
  restoreAction,
  retentionThresholds,
  tierForScore,
} from "../src/memory/retention-policy.js";

test("R1 档位阶梯：分数边界唯一且可预测", () => {
  const t = retentionThresholds();
  assert.equal(tierForScore(t.hot), "hot");
  assert.equal(tierForScore(t.hot - 0.001), "warm");
  assert.equal(tierForScore(t.warm), "warm");
  assert.equal(tierForScore(t.warm - 0.001), "cold");
  assert.equal(tierForScore(t.cold), "cold");
  assert.equal(tierForScore(t.cold - 0.001), "archived");
  assert.equal(tierForScore(t.archived), "archived");
  assert.equal(tierForScore(t.archived - 0.001), "purged");
  assert.equal(tierForScore(Number.NaN), "purged", "非法分数按最冷处理");
});

test("R2 遗忘侧判定只看两条边界（不受留存分桶影响）", () => {
  const t = retentionThresholds();
  assert.equal(forgettingVerdict(t.hot), "keep");
  assert.equal(forgettingVerdict(t.warm), "keep");
  assert.equal(forgettingVerdict(t.cold), "keep", "恰好在 cold 边界不降档");
  assert.equal(forgettingVerdict(t.cold - 0.001), "archive");
  assert.equal(forgettingVerdict(t.archived), "archive");
  assert.equal(forgettingVerdict(t.archived - 0.001), "purge");
});

test("R3 恢复动作：升一档 + 加频次分 + 刷新时间戳", () => {
  assert.equal(restoreAction("hot"), null, "hot 不需要恢复");
  assert.equal(restoreAction("warm")?.tier, "hot");
  assert.equal(restoreAction("cold")?.tier, "warm");
  assert.equal(restoreAction("archived")?.tier, "cold");
  assert.equal(restoreAction("purged")?.tier, "archived");
  for (const tier of ["warm", "cold", "archived", "purged"] as const) {
    const action = restoreAction(tier)!;
    assert.equal(action.boost, RETENTION_RESTORE_BOOST);
    assert.equal(action.refreshTimestamp, true, "不刷新时间戳 = 恢复下一次整理就失效");
  }
});

test("R4 阶梯方向：降一档 / 升一档互为逆运算", () => {
  assert.equal(lowerTier("hot"), "warm");
  assert.equal(lowerTier("warm"), "cold");
  assert.equal(lowerTier("cold"), "archived");
  assert.equal(lowerTier("archived"), "purged");
  assert.equal(lowerTier("purged"), null);
});

test("R5 两个存储的档位映射互相对齐", () => {
  // KV 三桶 ↔ 认知图五档：同一档在两边指向同一语义层级
  assert.equal(KV_BUCKET_BY_TIER.hot, "remembered");
  assert.equal(KV_BUCKET_BY_TIER.warm, "faded");
  assert.equal(KV_BUCKET_BY_TIER.cold, "forgotten");
  assert.equal(KV_BUCKET_BY_TIER.archived, "forgotten");
  assert.equal(KV_BUCKET_BY_TIER.purged, "forgotten");

  assert.equal(HM_STAGE_BY_TIER.hot, "active");
  assert.equal(HM_STAGE_BY_TIER.warm, "downranked");
  assert.equal(HM_STAGE_BY_TIER.cold, "cold");
  assert.equal(HM_STAGE_BY_TIER.archived, "soft_deleted");
  assert.equal(HM_STAGE_BY_TIER.purged, "hard_deleted");

  // 反查一致（不留孤儿映射）
  for (const [tier, stage] of Object.entries(HM_STAGE_BY_TIER)) {
    assert.equal(TIER_BY_HM_STAGE[stage], tier);
  }
  for (const [bucket, tier] of Object.entries(TIER_BY_KV_BUCKET)) {
    assert.equal(KV_BUCKET_BY_TIER[tier], bucket);
  }
});

test("R6 恢复落点：KV 回到 summary 桶，认知图回退一级（终态不复活）", () => {
  assert.equal(kvBucketAfterRestore("forgotten"), "faded", "恢复到 summary 桶（可召回）");
  assert.equal(kvBucketAfterRestore("faded"), "remembered");
  assert.equal(hmStageAfterRestore("cold"), "downranked");
  assert.equal(hmStageAfterRestore("soft_deleted"), "cold");
  assert.equal(hmStageAfterRestore("downranked"), "active");
  assert.equal(hmStageAfterRestore("active"), "active");
  assert.equal(hmStageAfterRestore("hard_deleted"), "hard_deleted", "终态不复活");
});

test("R7 衰减曲线：7 天半衰期唯一，且不再接受自定义半衰期", () => {
  assert.equal(MEMORY_DECAY_HALF_LIFE_DAYS, 7);
  const half = memoryDecayFactor({ ageDays: 7 });
  assert.ok(Math.abs(half - 0.5) < 1e-9, "7 天后应衰减到一半");
  assert.ok(memoryDecayFactor({ ageDays: 0 }) > memoryDecayFactor({ ageDays: 30 }));
  // 频次与情绪加成仍在（衰减更慢）
  assert.ok(memoryDecayFactor({ ageDays: 30, accessCount: 5 }) > memoryDecayFactor({ ageDays: 30 }));
  assert.ok(
    memoryDecayFactor({ ageDays: 30, emotionalSalience: 0.9 }) > memoryDecayFactor({ ageDays: 30 }),
  );
});

test("R8 时间戳刷新：只换首部时间戳，正文与话题标签不动", () => {
  const line = "[2026-01-01T00:00:00.000Z] [topic:phone] 用户在兴义比价小米 18 Pro";
  const out = refreshMemoryLineTimestamp(line, "2026-11-13T12:00:00.000Z");
  assert.match(out, /^\[2026-11-13T12:00:00\.000Z\]/);
  assert.match(out, /\[topic:phone\] 用户在兴义比价小米 18 Pro$/);
  // 无时间戳的行原样返回
  assert.equal(refreshMemoryLineTimestamp("没有时间戳的一行", "2026-11-13T12:00:00.000Z"), "没有时间戳的一行");
});
