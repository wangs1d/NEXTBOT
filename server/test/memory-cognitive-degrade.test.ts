/**
 * 记忆认知架构升级 —— 降级测试。
 *
 * 验证 7 个子模块在主开关 / 单独开关关闭时的优雅降级行为：
 *  - BRAIN_MEMORY_COGNITIVE_ENABLED=0 → MemoryCortex 不注册任何子模块，
 *    各对外方法返回空/默认值
 *  - 各独立开关（SALIENCE / ASSOCIATIVE / METACOGNITION）关闭时，
 *    对应子模块方法返回约定降级值
 *
 * 测试风格与 brain-end-to-end.test.ts 一致：node:test + node:assert/strict，
 * 环境变量测试用 process.env.X = "0" + try/finally 恢复。
 *
 * 场景 M-P 覆盖总开关 + 3 个独立开关的降级路径。
 */
import test from "node:test";
import assert from "node:assert/strict";

import { MemoryCortex } from "../src/brain/memory-cortex.js";
import { MemorySalienceFilter } from "../src/brain/memory-cognitive/memory-salience-filter.js";
import { MemoryAssociativeGraph } from "../src/brain/memory-cognitive/memory-associative-graph.js";
import { MemoryMetacognitionBridge } from "../src/brain/memory-cognitive/memory-metacognition-bridge.js";
import type { MemoryItem } from "../src/brain/types.js";

// ---- helpers ------------------------------------------------------------

/** 临时设置环境变量，测试结束后恢复（与 brain-end-to-end.test.ts 风格一致） */
async function withEnv<T>(
  vars: Record<string, string>,
  fn: () => Promise<T>,
): Promise<T> {
  const prev: Record<string, string | undefined> = {};
  for (const key of Object.keys(vars)) {
    prev[key] = process.env[key];
    process.env[key] = vars[key];
  }
  try {
    return await fn();
  } finally {
    for (const key of Object.keys(vars)) {
      if (prev[key] == null) delete process.env[key];
      else process.env[key] = prev[key];
    }
  }
}

/** 构造一个最小可用的 MemoryItem */
function makeItem(overrides: Partial<MemoryItem> = {}): MemoryItem {
  return {
    actorId: "test-user",
    kind: "fact",
    content: "测试记忆内容",
    importance: "medium",
    source: "chat",
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

// ---- 场景 M: BRAIN_MEMORY_COGNITIVE_ENABLED=0 → 子模块不实例化 --------

test("场景 M: BRAIN_MEMORY_COGNITIVE_ENABLED=0 → 子模块不实例化", async () => {
  await withEnv({ BRAIN_MEMORY_COGNITIVE_ENABLED: "0" }, async () => {
    // 不注册任何子模块（等价于 7 子模块不实例化）
    const brain = new MemoryCortex();

    // recallWithProvenance → 降级到 recall（未注册 metacognitionBridge）
    // recall 本身也未注册任何子系统 → 返回空 items
    const r1 = await brain.recallWithProvenance("user-m", "query");
    assert.equal(r1.items.length, 0, "recallWithProvenance 应降级到 recall 并返回空 items");

    // predictAssociation → 未注册 associativeGraph → 返回空结果
    const r2 = await brain.predictAssociation("user-m", "query");
    assert.equal(r2.activatedNodes.length, 0, "predictAssociation 应返回空 activatedNodes");
    assert.equal(r2.confidence, 0, "predictAssociation 应返回 confidence=0");
    assert.equal(r2.predictedOutcome, "", "predictAssociation 应返回空 predictedOutcome");

    // evaluateSalience → 未注册 salienceFilter → 返回默认接受
    const r4 = brain.evaluateSalience(makeItem({ actorId: "user-m" }));
    assert.equal(r4.accept, true, "evaluateSalience 应返回默认接受");
    assert.equal(r4.reason, "no_salience_filter", "reason 应为 no_salience_filter");
  });
});

// ---- 场景 N: BRAIN_MEMORY_SALIENCE_ENABLED=0 → 默认接受 ----------------

test("场景 N: 单个独立开关关闭（BRAIN_MEMORY_SALIENCE_ENABLED=0）", async () => {
  const brain = new MemoryCortex();
  const salienceFilter = new MemorySalienceFilter();
  brain.registerSalienceFilter(salienceFilter);

  // 临时关闭 salience 开关
  await withEnv({ BRAIN_MEMORY_SALIENCE_ENABLED: "0" }, async () => {
    // 即使 item 显式低显著性，关闭后也应默认接受
    const item = makeItem({
      actorId: "user-n",
      importance: "low",
      metadata: { emotionValence: -1, userFeedbackScore: 0, novelty: 0 },
    });

    const decision = brain.evaluateSalience(item);

    assert.equal(decision.accept, true, "关闭 salience 后应默认接受");
    assert.equal(decision.reason, "salience_filter_disabled", "reason 应为 salience_filter_disabled");
    assert.equal(decision.degraded, false, "degraded 应为 false");
    assert.equal(decision.score, 1.0, "score 应为 1.0（默认接受）");
  });
});

// ---- 场景 O: BRAIN_MEMORY_ASSOCIATIVE_ENABLED=0 时 spread 返回空 --------

test("场景 O: BRAIN_MEMORY_ASSOCIATIVE_ENABLED=0 时 spread 返回空", async () => {
  await withEnv({ BRAIN_MEMORY_ASSOCIATIVE_ENABLED: "0" }, async () => {
    // mock humanLike（即使有数据，关闭后 spread 也应直接返回空）
    const getAllEdgesCalls: string[] = [];
    const humanLikeMock = {
      getAllNodes: () => [
        { id: "n1", summary: "x", keywords: ["x"], confidence: 0.5 },
      ],
      getAllEdges: (actorId: string) => {
        getAllEdgesCalls.push(actorId);
        return [
          { id: "e1", from: "seed-1", to: "n1", relation: "r", weight: 1.0, decayFactor: 0.5, hopCost: 1 },
        ];
      },
    };
    const graph = new MemoryAssociativeGraph({ humanLike: humanLikeMock });

    const result = await graph.spread("user-o", ["seed-1"]);

    assert.equal(result.activatedNodes.length, 0, "关闭后 spread 应返回空 activatedNodes");
    assert.equal(result.maxHopsReached, 0, "maxHopsReached 应为 0");
    assert.deepEqual(result.seedNodeIds, ["seed-1"], "seedNodeIds 应原样返回");
    // 关键：关闭后不应调用 humanLike.getAllEdges（早返回）
    assert.equal(
      getAllEdgesCalls.length,
      0,
      "关闭后 spread 不应调用 humanLike.getAllEdges（应早返回）",
    );
  });
});

// ---- 场景 P: BRAIN_MEMORY_METACOGNITION_ENABLED=0 时 recallWithProvenance 返回空

test("场景 P: BRAIN_MEMORY_METACOGNITION_ENABLED=0 时 recallWithProvenance 返回空", async () => {
  await withEnv({ BRAIN_MEMORY_METACOGNITION_ENABLED: "0" }, async () => {
    // mock memoryCortex（即使能返回数据，关闭后 bridge 也应返回空）
    const mockMemoryCortex = {
      recall: async () => ({
        actorId: "user-p",
        query: "test",
        items: [
          { content: "应该不出现", domain: "semantic" },
        ],
        domain: "semantic",
        mode: "single_domain" as const,
        recalledAt: new Date().toISOString(),
      }),
    };
    const bridge = new MemoryMetacognitionBridge({
      memoryCortex: mockMemoryCortex as never,
    });

    const result = await bridge.recallWithProvenance("user-p", "test");

    assert.equal(result.items.length, 0, "关闭后 recallWithProvenance 应返回空 items");
    assert.equal(result.actorId, "user-p", "actorId 应正确");
    assert.equal(result.query, "test", "query 应正确");
  });
});
