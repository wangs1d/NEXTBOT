/**
 * 召回时效因子（2026-10-19 时间认知）。
 *
 * 只锁纯函数契约：软调制、有下限、极端值不失控。
 * 接线点（buildRecallWithContext）已有 AI 侧集成测试覆盖，这里不重复起 Mem0。
 */

import assert from "node:assert/strict";
import test from "node:test";

import { recencyFactor } from "../src/agentic-memory/retrieval.js";

const HALF_LIFE = 72; // AGENT_MEMORY_TIME_DECAY_HALF_LIFE_H 默认值

test("recencyFactor：半衰期处约为 0.875，永不跌破 0.75 地板", () => {
  const atHalf = recencyFactor(HALF_LIFE, HALF_LIFE);
  assert.ok(Math.abs(atHalf - 0.875) < 1e-6, `半衰期应约为 0.875，实际 ${atHalf}`);

  const veryOld = recencyFactor(24 * 365 * 5, HALF_LIFE); // 五年前
  assert.ok(veryOld >= 0.75, `不得跌破下限，实际 ${veryOld}`);
  assert.ok(veryOld < 0.7501, `久远条目应贴近下限，实际 ${veryOld}`);
});

test("recencyFactor：新鲜度顺序单调，刚写下不扣分", () => {
  assert.equal(recencyFactor(0, HALF_LIFE), 1);
  const h1 = recencyFactor(1, HALF_LIFE);
  const d3 = recencyFactor(72, HALF_LIFE);
  const d30 = recencyFactor(24 * 30, HALF_LIFE);
  assert.ok(h1 > d3 && d3 > d30, "越旧分数越低");
});

test("recencyFactor：关闭/非法半衰期时不衰减（kill switch 与旧行为一致）", () => {
  assert.equal(recencyFactor(24 * 30, 0), 1);
  assert.equal(recencyFactor(24 * 30, Number.NaN), 1);
  assert.equal(recencyFactor(-5, HALF_LIFE), 1); // 未来时间戳不奖励
});
