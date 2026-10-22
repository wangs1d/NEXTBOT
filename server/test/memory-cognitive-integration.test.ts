/**
 * 记忆认知架构升级 —— 端到端集成测试。
 *
 * 覆盖 MemoryCortex 与 7 个子模块（SalienceFilter / AssociativeGraph /
 * MetacognitionBridge / ForgettingController）的协作路径。
 *
 * 测试风格与 brain-end-to-end.test.ts 一致：node:test + node:assert/strict，
 * 用 mock 对象注入，不依赖真实 HumanLikeMemoryService / MetaCognitionCortex。
 *
 * 场景 A-K 覆盖 salience 守门 / 异步扩散 / 元记忆 / 程序性 / 遗忘控制。
 */
import test from "node:test";
import assert from "node:assert/strict";

import { MemoryCortex } from "../src/brain/memory-cortex.js";
import { MemorySalienceFilter } from "../src/brain/memory-cognitive/memory-salience-filter.js";
import { MemoryAssociativeGraph } from "../src/brain/memory-cognitive/memory-associative-graph.js";
import { MemoryMetacognitionBridge } from "../src/brain/memory-cognitive/memory-metacognition-bridge.js";
import { MemoryForgettingController } from "../src/brain/memory-cognitive/memory-forgetting-controller.js";
import type {
  MemoryItem,
  MemoryRecallResult,
} from "../src/brain/types.js";

// ---- helpers ------------------------------------------------------------

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

/** 构造一个叙事记忆 mock，可选追踪 ingest 调用 */
function makeNarrativeMock(opts: {
  ingestCalledRef?: { count: number; content: string };
  narrativeText?: string;
} = {}) {
  return {
    ingest: async (_actorId: string, text: string) => {
      if (opts.ingestCalledRef) {
        opts.ingestCalledRef.count += 1;
        opts.ingestCalledRef.content = text;
      }
    },
    buildNarrativeRecall: async () => opts.narrativeText ?? "",
    buildCrossContextRecall: async () => "",
    runSleepConsolidation: async () => [],
  };
}

/** 构造一个短期记忆 mock，可选追踪 syncTaskForTurn 调用 */
function makeShortTermMock(opts: {
  syncCalledRef?: { count: number; sessionId: string; input: string };
} = {}) {
  return {
    syncTaskForTurn: (sessionId: string, input: string) => {
      if (opts.syncCalledRef) {
        opts.syncCalledRef.count += 1;
        opts.syncCalledRef.sessionId = sessionId;
        opts.syncCalledRef.input = input;
      }
      return {
        task: {
          taskId: "t1",
          title: "t",
          status: "active" as const,
          contextSummary: "",
          createdAt: "",
          updatedAt: "",
        },
        resumed: false,
      };
    },
    getTaskState: () => ({ activeTaskId: null, tasks: [] }),
  };
}

/** 捕获 console.log 输出（用于断言日志标记） */
async function captureConsole<T>(fn: () => Promise<T>): Promise<{ logs: string[]; result: T }> {
  const logs: string[] = [];
  const origLog = console.log;
  console.log = (...args: unknown[]) => {
    logs.push(args.map((a) => (typeof a === "string" ? a : String(a))).join(" "));
  };
  try {
    const result = await fn();
    return { logs, result };
  } finally {
    console.log = origLog;
  }
}

// ---- 场景 A: salience filter 拒绝写入 -----------------------------------

test("场景 A: remember → salience 低分降档为低信号写入", async () => {
  const brain = new MemoryCortex();
  const salienceFilter = new MemorySalienceFilter();
  brain.registerSalienceFilter(salienceFilter);

  const ingestRef = { count: 0, content: "" };
  brain.registerNarrative(makeNarrativeMock({ ingestCalledRef: ingestRef }) as never);

  // 构造低 salience item：importance=low(0.3) + emotionValence=-1(→0) + userFeedbackScore=0 + novelty=0
  // score = 0*0.4 + 0.3*0.3 + 0*0.2 + 0*0.1 = 0.09 < 0.2 → 拒绝写入
  const item = makeItem({
    actorId: "user-a",
    importance: "low",
    content: "测试低显著性记忆",
    metadata: { emotionValence: -1, userFeedbackScore: 0, novelty: 0 },
  });

  // 预检：salience score < 0.2
  const salience = salienceFilter.evaluateSalience(item);
  assert.ok(
    salience.score < 0.2,
    `salience score 应 < 0.2（reject 阈值），实际: ${salience.score}`,
  );
  assert.equal(salience.accept, false, "应判定为低分");

  await brain.remember("user-a", item);

  // 统一闸门重构：salience 不再有独立否决权，低分条目下调为低信号档位
  // （走低信号缓冲），是否落库由下游 decideMemoryWrite 最终裁量。
  assert.equal(ingestRef.count, 1, "低信号路径仍应进入 narrative 门面（非高信号）");
});

// ---- 场景 B: salience filter 降级 decay 路径 ----------------------------

test("场景 B: remember → salience filter 降级 decay 路径", async () => {
  const brain = new MemoryCortex();
  const salienceFilter = new MemorySalienceFilter();
  brain.registerSalienceFilter(salienceFilter);

  const ingestRef = { count: 0, content: "" };
  const syncRef = { count: 0, sessionId: "", input: "" };
  brain.registerNarrative(makeNarrativeMock({ ingestCalledRef: ingestRef }) as never);
  brain.registerShortTerm(makeShortTermMock({ syncCalledRef: syncRef }) as never);

  // 构造 score 介于 [0.2, 0.4)：emotionValence=-1(→0) + importance=high(0.8) + userFeedbackScore=0 + novelty=0
  // score = 0*0.4 + 0.8*0.3 + 0*0.2 + 0*0.1 = 0.24 → degraded
  const item = makeItem({
    actorId: "user-b",
    kind: "task",
    domain: "working",
    sessionId: "session-b",
    importance: "high",
    content: "测试降级 decay 记忆",
    metadata: { emotionValence: -1, userFeedbackScore: 0, novelty: 0 },
  });

  const salience = salienceFilter.evaluateSalience(item);
  assert.ok(
    salience.score >= 0.2 && salience.score < 0.4,
    `salience score 应在 [0.2, 0.4)（decay 区间），实际: ${salience.score}`,
  );
  assert.equal(salience.degraded, true, "应为 degraded");
  assert.equal(salience.accept, true, "degraded 时 accept=true");

  await brain.remember("user-b", item);

  assert.equal(syncRef.count, 1, "shortTerm.syncTaskForTurn 应被调用一次");
  assert.equal(syncRef.sessionId, "session-b", "syncTaskForTurn 的 sessionId 应正确");
  assert.equal(ingestRef.count, 0, "narrative.ingest 不应被调用");
});

// ---- 场景 C: salience filter 正常写入路径 -------------------------------

test("场景 C: remember → salience filter 正常写入路径", async () => {
  const brain = new MemoryCortex();
  const salienceFilter = new MemorySalienceFilter();
  brain.registerSalienceFilter(salienceFilter);

  const ingestRef = { count: 0, content: "" };
  brain.registerNarrative(makeNarrativeMock({ ingestCalledRef: ingestRef }) as never);

  // importance=high(0.8) + 默认值（emotionValence/userFeedback/novelty 各 0.5）
  // score = 0.5*0.4 + 0.8*0.3 + 0.5*0.2 + 0.5*0.1 = 0.59 > 0.4 → normal_write
  const item = makeItem({
    actorId: "user-c",
    importance: "high",
    content: "测试正常写入记忆",
  });

  const salience = salienceFilter.evaluateSalience(item);
  assert.ok(
    salience.score >= 0.4,
    `salience score 应 >= 0.4（normal 阈值），实际: ${salience.score}`,
  );
  assert.equal(salience.accept, true, "应接受写入");
  assert.equal(salience.degraded, false, "不应降级");

  await brain.remember("user-c", item);

  assert.equal(ingestRef.count, 1, "narrative.ingest 应被调用一次");
  assert.equal(ingestRef.content, "测试正常写入记忆", "ingest 内容应正确");
});

// ---- 场景 D: recall 异步触发 spreading activation -----------------------

test("场景 D: recall → 异步触发 spreading activation", async () => {
  const brain = new MemoryCortex();

  // 注册 narrative mock 让 recall 返回非空 items
  brain.registerNarrative(
    makeNarrativeMock({ narrativeText: "餐厅点餐流程：进门→点餐→吃饭→结账" }) as never,
  );

  // 注册 AssociativeGraph（注入 mock humanLike，追踪 getAllEdges 调用）
  const getAllEdgesCalls: string[] = [];
  const humanLikeMock = {
    getAllNodes: () => [
      { id: "n1", summary: "餐厅", keywords: ["餐厅"], confidence: 0.8 },
    ],
    getAllEdges: (actorId: string) => {
      getAllEdgesCalls.push(actorId);
      return [];
    },
  };
  const associativeGraph = new MemoryAssociativeGraph({ humanLike: humanLikeMock });
  brain.registerAssociativeGraph(associativeGraph);

  const result = await brain.recall("user-d", "餐厅");

  // 断言召回非空（recall 命中才触发 spread）
  assert.ok(result.items.length > 0, "recall 应返回非空 items 以触发 spread");

  // 等待异步 spread 完成（fire-and-forget 在 microtask 队列）
  await new Promise((resolve) => setImmediate(resolve));

  // 断言 spread 被触发：spread 内部会调用 humanLike.getAllEdges
  assert.ok(
    getAllEdgesCalls.length > 0,
    `associativeGraph.spread 应被触发并调用 humanLike.getAllEdges，实际调用次数: ${getAllEdgesCalls.length}`,
  );
  assert.equal(getAllEdgesCalls[0], "user-d", "getAllEdges 的 actorId 应正确");
});

// ---- 场景 E: recallWithProvenance 委托 MetacognitionBridge --------------

test("场景 E: recallWithProvenance 委托 MetacognitionBridge", async () => {
  const brain = new MemoryCortex();

  // mock memoryCortex 给 bridge 用（返回带内容的非空召回）
  const mockMemoryCortexForBridge = {
    recall: async (): Promise<MemoryRecallResult> => ({
      actorId: "user-e",
      query: "天气",
      items: [
        {
          content: "今天北京晴朗",
          domain: "semantic",
          source: "chat",
          timestamp: new Date().toISOString(),
        },
      ],
      domain: "semantic",
      mode: "single_domain",
      recalledAt: new Date().toISOString(),
    }),
  };

  const bridge = new MemoryMetacognitionBridge({
    memoryCortex: mockMemoryCortexForBridge as never,
  });
  brain.registerMetacognitionBridge(bridge);

  const result = await brain.recallWithProvenance("user-e", "天气");

  assert.ok(result.items.length > 0, "应返回非空 items");
  const item = result.items[0];
  assert.ok(item.provenance, "items 应包含 provenance 字段");
  assert.ok(item.confidenceTier, "items 应包含 confidenceTier 字段");
  assert.ok(
    item.confidenceTier === "known" || item.confidenceTier === "uncertain" || item.confidenceTier === "unknown",
    `confidenceTier 应为合法值，实际: ${item.confidenceTier}`,
  );
  assert.ok(item.provenance?.sourceType, "provenance 应含 sourceType");
  assert.ok(item.provenance?.capturedAt, "provenance 应含 capturedAt");
});

// ---- 场景 G: evaluateSalience 委托 SalienceFilter ----------------------

test("场景 G: evaluateSalience 委托 SalienceFilter", () => {
  const brain = new MemoryCortex();
  const salienceFilter = new MemorySalienceFilter();
  brain.registerSalienceFilter(salienceFilter);

  const item = makeItem({ actorId: "user-g", importance: "low" });

  const decision = brain.evaluateSalience(item);

  // 断言返回 SalienceDecision 结构
  assert.equal(typeof decision.accept, "boolean", "SalienceDecision.accept 应为 boolean");
  assert.equal(typeof decision.score, "number", "SalienceDecision.score 应为 number");
  assert.equal(typeof decision.reason, "string", "SalienceDecision.reason 应为 string");
  assert.equal(typeof decision.degraded, "boolean", "SalienceDecision.degraded 应为 boolean");
  assert.ok(decision.score >= 0 && decision.score <= 1, "score 应在 [0, 1] 区间");
});

// ---- 场景 J: ForgettingController reawakenAndStrengthen ----------------

test("场景 J: ForgettingController reawakenAndStrengthen", async () => {
  const reawakenCalls: Array<{ actorId: string; nodeId: string }> = [];
  const fireCalls: Array<{ type: string; data: Record<string, unknown> }> = [];

  // mock humanLike（含 getAllNodes / reawakenNode / updateDeletionStage / pruneNodeEdges）
  const humanLikeMock = {
    getAllNodes: () => [
      {
        id: "node-cold-1",
        frequencyScore: 0.1,
        recencyScore: 0.1,
        importance: 0.2,
        userFeedbackScore: 0.1,
        accessCount: 1,
        deletionStage: "cold" as const,
        lastAccessedAt: new Date().toISOString(),
      },
    ],
    updateDeletionStage: () => {},
    reawakenNode: (actorId: string, nodeId: string) => {
      reawakenCalls.push({ actorId, nodeId });
    },
    pruneNodeEdges: () => {},
  };

  // mock synapse
  const synapseMock = {
    fire: (type: string, data: Record<string, unknown>) => {
      fireCalls.push({ type, data });
    },
  };

  const controller = new MemoryForgettingController();
  controller.registerHumanLikeMemory(humanLikeMock);
  controller.registerSynapseBus(synapseMock);

  await controller.reawakenAndStrengthen("user-j", "node-cold-1");

  // 断言 reawakenNode 被调用
  assert.equal(reawakenCalls.length, 1, "reawakenNode 应被调用一次");
  assert.equal(reawakenCalls[0].actorId, "user-j", "actorId 应正确");
  assert.equal(reawakenCalls[0].nodeId, "node-cold-1", "nodeId 应正确");

  // 断言 synapse.fire("memory.reawakened", ...) 被调用
  const reawakenEvent = fireCalls.find((c) => c.type === "memory.reawakened");
  assert.ok(reawakenEvent, "应发射 memory.reawakened 事件");
  assert.equal(reawakenEvent!.data.actorId, "user-j", "事件 data.actorId 应正确");
  assert.equal(reawakenEvent!.data.nodeId, "node-cold-1", "事件 data.nodeId 应正确");
  assert.equal(reawakenEvent!.data.source, undefined, "source 在 opts 中而非 data");
});

// ---- 场景 K: consolidate 触发 connection pruning -----------------------

test("场景 K: consolidate 触发 connection pruning", async () => {
  const brain = new MemoryCortex();

  // 必须注册 narrative，否则 consolidate 在 narrative 缺失时直接返回 empty，
  // 不会触发 forgettingController.pruneConnections 钩子
  brain.registerNarrative(makeNarrativeMock() as never);

  // 注册 ForgettingController + mock humanLike
  const getAllNodesCalls: string[] = [];
  const pruneNodeEdgesCalls: string[] = [];
  const humanLikeMock = {
    getAllNodes: (actorId: string) => {
      getAllNodesCalls.push(actorId);
      return []; // 返回空，pruneConnections 内部会调 getAllNodes
    },
    updateDeletionStage: () => {},
    reawakenNode: () => {},
    pruneNodeEdges: (actorId: string, nodeId: string) => {
      pruneNodeEdgesCalls.push(`${actorId}:${nodeId}`);
    },
  };
  const forgettingController = new MemoryForgettingController();
  forgettingController.registerHumanLikeMemory(humanLikeMock);
  brain.registerForgettingController(forgettingController);

  await brain.consolidate(["user-k"]);

  // forgettingController.pruneConnections 会被调用，内部调 humanLike.getAllNodes
  assert.ok(
    getAllNodesCalls.includes("user-k"),
    `consolidate 应触发 forgettingController.pruneConnections → getAllNodes，实际调用: ${JSON.stringify(getAllNodesCalls)}`,
  );
});
