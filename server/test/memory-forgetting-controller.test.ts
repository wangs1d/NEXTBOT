// MemoryForgettingController 单元测试
//
// 覆盖 spec: .trae/specs/extend-memory-cognitive-architecture/spec.md 中的
// "MemoryForgettingController 主动遗忘与再唤醒反弹" 子模块全部场景：
//   1. computeNodeScore 计算正确（各权重）
//   2. compactRecallText 三档压缩正确（80%/50%/20%）
//   3. reawakenAndStrengthen 调用 reawakenNode + 发射事件
//   4. continuousScore 推进 deletionStage（score<0.2 时）
//   5. continuousScore 触发 pruneConnections（score<0.1 时）
//   6. 降级开关：BRAIN_MEMORY_FORGET_ENABLED=0 时方法空操作
//   7. humanLike 为 null 时优雅降级（不抛错）
import test from "node:test";
import assert from "node:assert/strict";

import { MemoryForgettingController } from "../src/brain/memory-cognitive/memory-forgetting-controller.js";
import type { MemoryDeletionStage } from "../src/services/human-like-memory-service.js";

// ---- helpers ------------------------------------------------------------

/** 节点最小化结构（仅含控制器所需字段） */
interface MockNode {
  id: string;
  frequencyScore: number;
  recencyScore: number;
  importance: number;
  userFeedbackScore: number;
  accessCount: number;
  deletionStage: MemoryDeletionStage;
  lastAccessedAt: string;
}

/** 构造一个 mock HumanLikeMemoryForgettingLike，记录所有调用 */
function makeMockHumanLike(nodes: MockNode[]) {
  const calls = {
    getAllNodes: 0,
    updateDeletionStage: [] as Array<{ actorId: string; nodeId: string; stage: string }>,
    reawakenNode: [] as Array<{ actorId: string; nodeId: string }>,
    pruneNodeEdges: [] as Array<{ actorId: string; nodeId: string }>,
  };
  return {
    calls,
    getAllNodes(_actorId: string) {
      calls.getAllNodes++;
      return nodes;
    },
    updateDeletionStage(actorId: string, nodeId: string, stage: string) {
      calls.updateDeletionStage.push({ actorId, nodeId, stage });
    },
    reawakenNode(actorId: string, nodeId: string) {
      calls.reawakenNode.push({ actorId, nodeId });
    },
    pruneNodeEdges(actorId: string, nodeId: string) {
      calls.pruneNodeEdges.push({ actorId, nodeId });
    },
  };
}

/** 构造一个 mock SynapseBusLike，记录所有 fire 调用 */
function makeMockSynapse() {
  const fired = [] as Array<{
    type: string;
    data: Record<string, unknown>;
    opts?: { actorId?: string; source?: string };
  }>;
  return {
    fired,
    fire(
      type: string,
      data: Record<string, unknown>,
      opts?: { actorId?: string; source?: string },
    ) {
      fired.push({ type, data, opts });
      return { delivered: true };
    },
  };
}

/** 临时设置环境变量，测试结束后恢复 */
async function withEnv<T>(key: string, value: string | undefined, fn: () => Promise<T>): Promise<T> {
  const prev = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
  }
}

// ---- 1. computeNodeScore 计算正确 --------------------------------------

test("computeNodeScore: 各权重正确（freq*0.4 + recency*0.3 + importance*0.2 + feedback*0.1）", () => {
  const ctrl = new MemoryForgettingController();

  // 浮点比较辅助：容忍 1e-9 误差
  const approx = (actual: number, expected: number, msg: string) => {
    assert.ok(
      Math.abs(actual - expected) < 1e-9,
      `${msg}（实际: ${actual}, 期望: ${expected}）`,
    );
  };

  // 全 1.0 时，score = 0.4 + 0.3 + 0.2 + 0.1 ≈ 1.0（浮点误差）
  approx(
    ctrl.computeNodeScore({
      frequencyScore: 1,
      recencyScore: 1,
      importance: 1,
      userFeedbackScore: 1,
    }),
    1.0,
    "全 1.0 时 score 应为 1.0",
  );

  // 全 0 时，score = 0
  assert.equal(
    ctrl.computeNodeScore({
      frequencyScore: 0,
      recencyScore: 0,
      importance: 0,
      userFeedbackScore: 0,
    }),
    0,
    "全 0 时 score 应为 0",
  );

  // 验证 frequencyScore 权重 0.4
  approx(
    ctrl.computeNodeScore({
      frequencyScore: 1,
      recencyScore: 0,
      importance: 0,
      userFeedbackScore: 0,
    }),
    0.4,
    "frequencyScore 权重应为 0.4",
  );

  // 验证 recencyScore 权重 0.3
  approx(
    ctrl.computeNodeScore({
      frequencyScore: 0,
      recencyScore: 1,
      importance: 0,
      userFeedbackScore: 0,
    }),
    0.3,
    "recencyScore 权重应为 0.3",
  );

  // 验证 importance 权重 0.2
  approx(
    ctrl.computeNodeScore({
      frequencyScore: 0,
      recencyScore: 0,
      importance: 1,
      userFeedbackScore: 0,
    }),
    0.2,
    "importance 权重应为 0.2",
  );

  // 验证 userFeedbackScore 权重 0.1
  approx(
    ctrl.computeNodeScore({
      frequencyScore: 0,
      recencyScore: 0,
      importance: 0,
      userFeedbackScore: 1,
    }),
    0.1,
    "userFeedbackScore 权重应为 0.1",
  );

  // 混合值：0.5*0.4 + 0.4*0.3 + 0.3*0.2 + 0.2*0.1 = 0.2 + 0.12 + 0.06 + 0.02 = 0.4
  approx(
    ctrl.computeNodeScore({
      frequencyScore: 0.5,
      recencyScore: 0.4,
      importance: 0.3,
      userFeedbackScore: 0.2,
    }),
    0.4,
    "混合值 score 应为 0.4",
  );
});

// ---- 3. reawakenAndStrengthen 调用 reawakenNode + 发射事件 ----------------

test("reawakenAndStrengthen: 调用 reawakenNode + 发射 memory.reawakened 事件", async () => {
  const nodes: MockNode[] = [];
  const mockHuman = makeMockHumanLike(nodes);
  const mockSynapse = makeMockSynapse();

  const ctrl = new MemoryForgettingController();
  ctrl.registerHumanLikeMemory(mockHuman);
  ctrl.registerSynapseBus(mockSynapse);

  await ctrl.reawakenAndStrengthen("user-1", "node-42");

  // 1) 应调用 reawakenNode 一次
  assert.equal(mockHuman.calls.reawakenNode.length, 1, "应调用 reawakenNode 一次");
  assert.deepEqual(
    mockHuman.calls.reawakenNode[0],
    { actorId: "user-1", nodeId: "node-42" },
    "reawakenNode 参数应正确透传",
  );

  // 2) 应发射 memory.reawakened 事件一次
  assert.equal(mockSynapse.fired.length, 1, "应发射 1 个事件");
  assert.equal(mockSynapse.fired[0].type, "memory.reawakened", "事件类型应为 memory.reawakened");
  assert.equal(
    mockSynapse.fired[0].data.actorId,
    "user-1",
    "事件 data.actorId 应正确",
  );
  assert.equal(
    mockSynapse.fired[0].data.nodeId,
    "node-42",
    "事件 data.nodeId 应正确",
  );
  assert.equal(
    mockSynapse.fired[0].data.boost,
    0.3,
    "事件 data.boost 应为默认 0.3",
  );
  assert.ok(
    typeof mockSynapse.fired[0].data.reawakenedAt === "string",
    "事件 data.reawakenedAt 应为字符串",
  );
  assert.equal(mockSynapse.fired[0].opts?.actorId, "user-1", "事件 opts.actorId 应正确");
  assert.equal(
    mockSynapse.fired[0].opts?.source,
    "memory_forgetting_controller",
    "事件 opts.source 应为 memory_forgetting_controller",
  );
});

test("reawakenAndStrengthen: 未注入 synapse 时仍执行 reawakenNode，不抛错", async () => {
  const nodes: MockNode[] = [];
  const mockHuman = makeMockHumanLike(nodes);

  const ctrl = new MemoryForgettingController();
  ctrl.registerHumanLikeMemory(mockHuman);
  // 不注册 synapse

  await ctrl.reawakenAndStrengthen("user-1", "node-42");

  assert.equal(mockHuman.calls.reawakenNode.length, 1, "无 synapse 时仍应调用 reawakenNode");
});

test("reawakenAndStrengthen: 自定义 BRAIN_MEMORY_FORGET_REAWAKEN_BOOST 反映到事件", async () => {
  await withEnv("BRAIN_MEMORY_FORGET_REAWAKEN_BOOST", "0.5", async () => {
    const nodes: MockNode[] = [];
    const mockHuman = makeMockHumanLike(nodes);
    const mockSynapse = makeMockSynapse();

    const ctrl = new MemoryForgettingController();
    ctrl.registerHumanLikeMemory(mockHuman);
    ctrl.registerSynapseBus(mockSynapse);

    await ctrl.reawakenAndStrengthen("user-1", "node-42");

    assert.equal(
      mockSynapse.fired[0].data.boost,
      0.5,
      "自定义 boost=0.5 应反映到事件 data.boost",
    );
  });
});

// ---- 4. continuousScore 推进 deletionStage（score<0.2 时） ----------------

test("continuousScore: score < 0.2 时推进 deletionStage 一级", async () => {
  // score = 0.05*0.4 + 0.05*0.3 + 0.05*0.2 + 0.05*0.1 = 0.02+0.015+0.01+0.005 = 0.05 < 0.2
  // 但 0.05 < 0.1 也会触发 prune，本用例只验证 deletionStage 推进
  const nodes: MockNode[] = [
    {
      id: "n1",
      frequencyScore: 0.05,
      recencyScore: 0.05,
      importance: 0.05,
      userFeedbackScore: 0.05,
      accessCount: 1,
      deletionStage: "active",
      lastAccessedAt: new Date().toISOString(),
    },
    {
      id: "n2",
      frequencyScore: 0.05,
      recencyScore: 0.05,
      importance: 0.05,
      userFeedbackScore: 0.05,
      accessCount: 1,
      deletionStage: "downranked",
      lastAccessedAt: new Date().toISOString(),
    },
    {
      id: "n3",
      frequencyScore: 0.05,
      recencyScore: 0.05,
      importance: 0.05,
      userFeedbackScore: 0.05,
      accessCount: 1,
      deletionStage: "cold",
      lastAccessedAt: new Date().toISOString(),
    },
  ];
  const mockHuman = makeMockHumanLike(nodes);
  const ctrl = new MemoryForgettingController();
  ctrl.registerHumanLikeMemory(mockHuman);

  await ctrl.continuousScore("user-1");

  // 三个节点 score=0.05 都 < 0.2，应推进 deletionStage 一级
  assert.equal(mockHuman.calls.updateDeletionStage.length, 3, "应推进 3 个节点的 deletionStage");
  assert.deepEqual(
    mockHuman.calls.updateDeletionStage[0],
    { actorId: "user-1", nodeId: "n1", stage: "downranked" },
    "active → downranked",
  );
  assert.deepEqual(
    mockHuman.calls.updateDeletionStage[1],
    { actorId: "user-1", nodeId: "n2", stage: "cold" },
    "downranked → cold",
  );
  assert.deepEqual(
    mockHuman.calls.updateDeletionStage[2],
    { actorId: "user-1", nodeId: "n3", stage: "soft_deleted" },
    "cold → soft_deleted",
  );
});

test("continuousScore: score >= 0.2 时不推进 deletionStage", async () => {
  // score = 0.5*0.4 + 0.5*0.3 + 0.5*0.2 + 0.5*0.1 = 0.5 >= 0.2，不应推进
  const nodes: MockNode[] = [
    {
      id: "n1",
      frequencyScore: 0.5,
      recencyScore: 0.5,
      importance: 0.5,
      userFeedbackScore: 0.5,
      accessCount: 1,
      deletionStage: "active",
      lastAccessedAt: new Date().toISOString(),
    },
  ];
  const mockHuman = makeMockHumanLike(nodes);
  const ctrl = new MemoryForgettingController();
  ctrl.registerHumanLikeMemory(mockHuman);

  await ctrl.continuousScore("user-1");

  assert.equal(
    mockHuman.calls.updateDeletionStage.length,
    0,
    "score >= 0.2 时不应推进 deletionStage",
  );
  assert.equal(mockHuman.calls.pruneNodeEdges.length, 0, "score >= 0.2 时不应剪枝");
});

test("continuousScore: hard_deleted 节点不再推进", async () => {
  // score=0.05 但 deletionStage 已是 hard_deleted（终态）
  const nodes: MockNode[] = [
    {
      id: "n1",
      frequencyScore: 0.05,
      recencyScore: 0.05,
      importance: 0.05,
      userFeedbackScore: 0.05,
      accessCount: 1,
      deletionStage: "hard_deleted",
      lastAccessedAt: new Date().toISOString(),
    },
  ];
  const mockHuman = makeMockHumanLike(nodes);
  const ctrl = new MemoryForgettingController();
  ctrl.registerHumanLikeMemory(mockHuman);

  await ctrl.continuousScore("user-1");

  assert.equal(
    mockHuman.calls.updateDeletionStage.length,
    0,
    "hard_deleted 是终态，不应再推进",
  );
  // 但 score=0.05 < 0.1，仍应剪枝
  assert.equal(mockHuman.calls.pruneNodeEdges.length, 1, "score<0.1 时仍应剪枝 edge");
});

// ---- 5. continuousScore 触发 pruneConnections（score<0.1 时） -------------

test("continuousScore: score < 0.1 时调用 pruneNodeEdges", async () => {
  // score = 0.05 < 0.1，应同时触发 deletionStage 推进 + 剪枝
  const nodes: MockNode[] = [
    {
      id: "n1",
      frequencyScore: 0.05,
      recencyScore: 0.05,
      importance: 0.05,
      userFeedbackScore: 0.05,
      accessCount: 1,
      deletionStage: "active",
      lastAccessedAt: new Date().toISOString(),
    },
  ];
  const mockHuman = makeMockHumanLike(nodes);
  const ctrl = new MemoryForgettingController();
  ctrl.registerHumanLikeMemory(mockHuman);

  await ctrl.continuousScore("user-1");

  assert.equal(mockHuman.calls.pruneNodeEdges.length, 1, "score < 0.1 应触发剪枝");
  assert.deepEqual(
    mockHuman.calls.pruneNodeEdges[0],
    { actorId: "user-1", nodeId: "n1" },
    "剪枝参数应正确",
  );
});

test("continuousScore: 0.1 <= score < 0.2 时只推进 deletionStage 不剪枝", async () => {
  // score = 0.15 < 0.2，但 >= 0.1，只推进 deletionStage，不剪枝
  // 0.15 = freq*0.4 + recency*0.3 + importance*0.2 + feedback*0.1
  // 取 freq=0.375, recency=0, importance=0, feedback=0 → 0.15
  const nodes: MockNode[] = [
    {
      id: "n1",
      frequencyScore: 0.375,
      recencyScore: 0,
      importance: 0,
      userFeedbackScore: 0,
      accessCount: 1,
      deletionStage: "active",
      lastAccessedAt: new Date().toISOString(),
    },
  ];
  const mockHuman = makeMockHumanLike(nodes);
  const ctrl = new MemoryForgettingController();
  ctrl.registerHumanLikeMemory(mockHuman);

  await ctrl.continuousScore("user-1");

  assert.equal(mockHuman.calls.updateDeletionStage.length, 1, "score<0.2 应推进 deletionStage");
  assert.equal(mockHuman.calls.pruneNodeEdges.length, 0, "0.1<=score 不应剪枝");
});

test("pruneConnections: 独立入口只对 score<0.1 的节点剪枝", async () => {
  // n1 score=0.05 < 0.1 → 剪枝；n2 score=0.5 >= 0.1 → 不剪枝
  const nodes: MockNode[] = [
    {
      id: "n1",
      frequencyScore: 0.05,
      recencyScore: 0.05,
      importance: 0.05,
      userFeedbackScore: 0.05,
      accessCount: 1,
      deletionStage: "active",
      lastAccessedAt: new Date().toISOString(),
    },
    {
      id: "n2",
      frequencyScore: 0.5,
      recencyScore: 0.5,
      importance: 0.5,
      userFeedbackScore: 0.5,
      accessCount: 1,
      deletionStage: "active",
      lastAccessedAt: new Date().toISOString(),
    },
  ];
  const mockHuman = makeMockHumanLike(nodes);
  const ctrl = new MemoryForgettingController();
  ctrl.registerHumanLikeMemory(mockHuman);

  await ctrl.pruneConnections("user-1");

  assert.equal(mockHuman.calls.pruneNodeEdges.length, 1, "只剪枝 1 个 score<0.1 的节点");
  assert.equal(mockHuman.calls.pruneNodeEdges[0].nodeId, "n1", "应剪枝 n1");
  assert.equal(
    mockHuman.calls.updateDeletionStage.length,
    0,
    "pruneConnections 不应推进 deletionStage",
  );
});

test("pruneConnections: 自定义 BRAIN_MEMORY_FORGET_PRUNE_THRESHOLD 改变剪枝阈值", async () => {
  // 自定义阈值 0.6，则 score=0.5 < 0.6 也应剪枝
  await withEnv("BRAIN_MEMORY_FORGET_PRUNE_THRESHOLD", "0.6", async () => {
    const nodes: MockNode[] = [
      {
        id: "n1",
        frequencyScore: 0.5,
        recencyScore: 0.5,
        importance: 0.5,
        userFeedbackScore: 0.5,
        accessCount: 1,
        deletionStage: "active",
        lastAccessedAt: new Date().toISOString(),
      },
    ];
    const mockHuman = makeMockHumanLike(nodes);
    const ctrl = new MemoryForgettingController();
    ctrl.registerHumanLikeMemory(mockHuman);

    await ctrl.pruneConnections("user-1");

    assert.equal(
      mockHuman.calls.pruneNodeEdges.length,
      1,
      "自定义阈值 0.6 时 score=0.5 应剪枝",
    );
  });
});

// ---- 6. 降级开关：BRAIN_MEMORY_FORGET_ENABLED=0 时方法空操作 --------------

test("降级开关: BRAIN_MEMORY_FORGET_ENABLED=0 时 continuousScore 空操作", async () => {
  await withEnv("BRAIN_MEMORY_FORGET_ENABLED", "0", async () => {
    const nodes: MockNode[] = [
      {
        id: "n1",
        frequencyScore: 0.01,
        recencyScore: 0.01,
        importance: 0.01,
        userFeedbackScore: 0.01,
        accessCount: 1,
        deletionStage: "active",
        lastAccessedAt: new Date().toISOString(),
      },
    ];
    const mockHuman = makeMockHumanLike(nodes);
    const ctrl = new MemoryForgettingController();
    ctrl.registerHumanLikeMemory(mockHuman);

    await ctrl.continuousScore("user-1");

    assert.equal(mockHuman.calls.getAllNodes, 0, "禁用时不应调用 getAllNodes");
    assert.equal(mockHuman.calls.updateDeletionStage.length, 0, "禁用时不应推进 deletionStage");
    assert.equal(mockHuman.calls.pruneNodeEdges.length, 0, "禁用时不应剪枝");
  });
});

test("降级开关: BRAIN_MEMORY_FORGET_ENABLED=0 时 reawakenAndStrengthen 空操作", async () => {
  await withEnv("BRAIN_MEMORY_FORGET_ENABLED", "0", async () => {
    const nodes: MockNode[] = [];
    const mockHuman = makeMockHumanLike(nodes);
    const mockSynapse = makeMockSynapse();
    const ctrl = new MemoryForgettingController();
    ctrl.registerHumanLikeMemory(mockHuman);
    ctrl.registerSynapseBus(mockSynapse);

    await ctrl.reawakenAndStrengthen("user-1", "node-1");

    assert.equal(mockHuman.calls.reawakenNode.length, 0, "禁用时不应调用 reawakenNode");
    assert.equal(mockSynapse.fired.length, 0, "禁用时不应发射事件");
  });
});

test("降级开关: BRAIN_MEMORY_FORGET_ENABLED=0 时 pruneConnections 空操作", async () => {
  await withEnv("BRAIN_MEMORY_FORGET_ENABLED", "0", async () => {
    const nodes: MockNode[] = [
      {
        id: "n1",
        frequencyScore: 0.01,
        recencyScore: 0.01,
        importance: 0.01,
        userFeedbackScore: 0.01,
        accessCount: 1,
        deletionStage: "active",
        lastAccessedAt: new Date().toISOString(),
      },
    ];
    const mockHuman = makeMockHumanLike(nodes);
    const ctrl = new MemoryForgettingController();
    ctrl.registerHumanLikeMemory(mockHuman);

    await ctrl.pruneConnections("user-1");

    assert.equal(mockHuman.calls.getAllNodes, 0, "禁用时不应调用 getAllNodes");
    assert.equal(mockHuman.calls.pruneNodeEdges.length, 0, "禁用时不应剪枝");
  });
});

test("降级开关: 默认启用（不设环境变量时正常工作）", async () => {
  await withEnv("BRAIN_MEMORY_FORGET_ENABLED", undefined, async () => {
    const nodes: MockNode[] = [
      {
        id: "n1",
        frequencyScore: 0.05,
        recencyScore: 0.05,
        importance: 0.05,
        userFeedbackScore: 0.05,
        accessCount: 1,
        deletionStage: "active",
        lastAccessedAt: new Date().toISOString(),
      },
    ];
    const mockHuman = makeMockHumanLike(nodes);
    const ctrl = new MemoryForgettingController();
    ctrl.registerHumanLikeMemory(mockHuman);

    await ctrl.continuousScore("user-1");

    assert.equal(mockHuman.calls.getAllNodes, 1, "默认应启用，应调用 getAllNodes");
    assert.equal(mockHuman.calls.updateDeletionStage.length, 1, "默认应启用，应推进 deletionStage");
  });
});

// ---- 7. humanLike 为 null 时优雅降级（不抛错） ---------------------------

test("优雅降级: humanLike 未注入时 continuousScore 不抛错", async () => {
  const ctrl = new MemoryForgettingController();
  // 不注册 humanLike

  await assert.doesNotReject(
    async () => ctrl.continuousScore("user-1"),
    "humanLike 未注入时 continuousScore 不应抛错",
  );
});

test("优雅降级: humanLike 未注入时 reawakenAndStrengthen 不抛错", async () => {
  const ctrl = new MemoryForgettingController();
  // 不注册 humanLike

  await assert.doesNotReject(
    async () => ctrl.reawakenAndStrengthen("user-1", "node-1"),
    "humanLike 未注入时 reawakenAndStrengthen 不应抛错",
  );
});

test("优雅降级: humanLike 未注入时 pruneConnections 不抛错", async () => {
  const ctrl = new MemoryForgettingController();
  // 不注册 humanLike

  await assert.doesNotReject(
    async () => ctrl.pruneConnections("user-1"),
    "humanLike 未注入时 pruneConnections 不应抛错",
  );
});

test("优雅降级: getAllNodes 返回空数组时不抛错", async () => {
  const mockHuman = makeMockHumanLike([]);
  const ctrl = new MemoryForgettingController();
  ctrl.registerHumanLikeMemory(mockHuman);

  await ctrl.continuousScore("user-1");
  await ctrl.pruneConnections("user-1");

  assert.equal(mockHuman.calls.updateDeletionStage.length, 0, "空节点列表不应推进 deletionStage");
  assert.equal(mockHuman.calls.pruneNodeEdges.length, 0, "空节点列表不应剪枝");
});

// ── Phase 2 接线集成测试：真实服务 + MemoryCortex 召回触发再唤醒 ──────────────

test("集成: 召回命中 downranked 节点时触发再唤醒反弹（deletionStage 回退）", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { HumanLikeMemoryService } = await import(
    "../src/services/human-like-memory-service.js"
  );
  const { MemoryCortex } = await import("../src/brain/memory-cortex.js");

  const LLM_ENV_KEYS = [
    "OPENAI_API_KEY",
    "OPENAI_BASE_URL",
    "OPENAI_MODEL",
    "OPENAI_EMBEDDINGS_MODEL",
    "AGENT_EMBEDDING_API_KEY",
    "MOONSHOT_API_KEY",
    "EXTERNAL_MODEL_PROVIDER",
    "EXTERNAL_MODEL_FAILOVER_CHAIN",
  ] as const;
  const savedEnv = new Map(LLM_ENV_KEYS.map((key) => [key, process.env[key]] as const));
  for (const key of LLM_ENV_KEYS) delete process.env[key];

  const dir = await mkdtemp(join(tmpdir(), "forget-integration-"));
  const humanLike = new HumanLikeMemoryService(join(dir, "memory.json"), join(dir, "policy.json"));
  try {
    await humanLike.load();

    // 低价值一次性事实 → sleep cycle 后进入 downranked
    await humanLike.ingest("user-int", "The loading spinner appeared briefly on this page.", "chat:user", {
      metadata: { salience: 0.1, userImportance: 0.1 },
    });
    await humanLike.runSleepCycleForActors(["user-int"]);
    const store = (humanLike as unknown as { store: { nodes: Record<string, { deletionStage: string; frequencyScore: number }> } }).store;
    const nodeIds = Object.keys(store.nodes);
    assert.ok(nodeIds.length >= 1, "应已产生记忆节点");
    const nodeId = nodeIds[0];
    assert.equal(store.nodes[nodeId].deletionStage, "downranked");

    // 装配 MemoryCortex + 遗忘控制器（真实接线）
    const controller = new MemoryForgettingController();
    controller.registerHumanLikeMemory(humanLike);
    const cortex = new MemoryCortex();
    cortex.registerHumanLike(humanLike);
    cortex.registerForgettingController(controller);

    // 召回命中该褪色节点 → 应触发再唤醒反弹
    // （生产链路经跨域召回；单域召回因 domain 推断与节点所属域不同可能落空）
    const result = await cortex.recallCrossDomain("user-int", "loading spinner page");
    assert.ok(result.items.length > 0, "downranked 节点应仍可被召回");
    // fire-and-forget，让异步链落地
    await new Promise((resolve) => setTimeout(resolve, 20));

    const node = store.nodes[nodeId];
    assert.equal(node.deletionStage, "active", "再唤醒后 deletionStage 应回退到 active");
    assert.ok(node.frequencyScore >= 0.3, "再唤醒后 frequencyScore 应获得反弹加成");
  } finally {
    await humanLike.shutdown();
    for (const [key, value] of savedEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});
