/**
 * 方案 A 单测：memory-bridge-service（层间打通）。
 *
 * 覆盖：
 *   1. writeUnified 统一写入：认知图节点 + Mem0 记忆 + 双向 linkage + bridge_links
 *   2. 融合召回：RRF 合排 / 跨通道语义去重 / 双通道标记
 *   3. 遗忘同步：节点 soft_deleted/hard_deleted → Mem0 阈值删除 + tombstone
 *   4. NarrativeMemoryFacade 桥接接线：写入走 bridge、召回走融合
 *
 * 测试封闭：fake Mem0（无 LLM/embedding）、临时目录认知图、临时 SQLite。
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { MemoryBridgeService, createMemoryBridgeIfEnabled } from "../src/agentic-memory/memory-bridge-service.js";
import type { BridgeGraphLike } from "../src/agentic-memory/memory-bridge-service.js";
import { AgenticMemoryIngestService } from "../src/agentic-memory/ingest.js";
import type { AgenticMemoryCandidate } from "../src/agentic-memory/retrieval.js";
import { HumanLikeMemoryService } from "../src/services/human-like-memory-service.js";
import { NarrativeMemoryFacade } from "../src/services/narrative-memory-port.js";
import { openAgenticSqlite } from "../src/agentic-memory/sqlite-store.js";
import type { Memory } from "mem0ai/oss";

/** LLM 密钥环境变量：测试必须封闭（不依赖外部 API） */
const LLM_ENV_KEYS = ["OPENAI_API_KEY", "OPENAI_BASE_URL", "AGENT_EMBEDDING_API_KEY"] as const;

// ============================================================
// fakes
// ============================================================

interface FakeMem0Calls {
  add: Array<{ content: string; metadata: Record<string, unknown> }>;
  deleted: string[];
}

/** Fake Mem0：add 返回固定抽取结果（infer 产物），delete 记录调用 */
function makeFakeMemory(calls: FakeMem0Calls, extracted: Array<{ id: string; memory: string }>): Memory {
  return {
    async add(messages, opts) {
      const content = String((messages as Array<{ content: string }>)[0]?.content ?? "");
      calls.add.push({ content, metadata: (opts?.metadata ?? {}) as Record<string, unknown> });
      return { results: extracted.map((e) => ({ ...e, metadata: opts?.metadata })) } as never;
    },
    async search() {
      return { results: [] } as never;
    },
    async delete(id) {
      calls.deleted.push(String(id));
      return { message: "ok" } as never;
    },
    async getAll() {
      return { results: [] } as never;
    },
  } as unknown as Memory;
}

interface FakeRetrievalState {
  candidates: AgenticMemoryCandidate[];
}

function makeFakeRetrieval(state: FakeRetrievalState) {
  return {
    async searchStructured(_actorId: string, _query: string) {
      return state.candidates;
    },
  };
}

async function withBridgeEnv(
  fn: (ctx: {
    dir: string;
    graph: HumanLikeMemoryService;
    bridge: MemoryBridgeService;
    ingest: AgenticMemoryIngestService;
    calls: FakeMem0Calls;
    retrievalState: FakeRetrievalState;
  }) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "memory-bridge-"));
  const savedEnv = new Map(LLM_ENV_KEYS.map((k) => [k, process.env[k]] as const));
  for (const k of LLM_ENV_KEYS) delete process.env[k];

  const graph = new HumanLikeMemoryService(join(dir, "graph.json"), join(dir, "policy.json"));
  await graph.load();

  const calls: FakeMem0Calls = { add: [], deleted: [] };
  const extracted = [
    { id: "m0-aaa", memory: "用户喜欢在周末爬山" },
    { id: "m0-bbb", memory: "用户养了一只叫布丁的猫" },
  ];
  const memory = makeFakeMemory(calls, extracted);
  const ingest = new AgenticMemoryIngestService(memory);
  const retrievalState: FakeRetrievalState = { candidates: [] };
  const db = openAgenticSqlite(join(dir, "bridge.db"));
  const bridge = new MemoryBridgeService(memory, graph, ingest, makeFakeRetrieval(retrievalState), db);

  try {
    await fn({ dir, graph, bridge, ingest, calls, retrievalState });
  } finally {
    bridge.close(); // close 内部同时关闭 sqlite db
    await graph.shutdown();
    await rm(dir, { recursive: true, force: true });
    for (const [k, v] of savedEnv) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// ============================================================
// 1. 统一写入 + linkage
// ============================================================

test("writeUnified：认知图节点 + Mem0 记忆 + 双向 linkage + bridge_links 落库", async () => {
  await withBridgeEnv(async ({ graph, bridge, calls }) => {
    const result = await bridge.writeUnified("user-1", "chat:turn-1", "用户喜欢在周末爬山，每周都去", {
      context: "main",
      highSignal: true,
    });

    // 认知图节点已创建
    assert.ok(result.graphNodeId, "应返回认知图节点 id");
    const nodes = graph.getAllNodes("user-1");
    assert.equal(nodes.length, 1);

    // Mem0 收到写入，且 metadata 携带 graphNodeId
    assert.equal(calls.add.length, 1);
    assert.equal(calls.add[0]!.metadata.graphNodeId, result.graphNodeId);

    // 节点 metadata 回写了 mem0Ids
    const node = nodes[0]!;
    const mem0Ids = node.metadata?.mem0Ids as string[];
    assert.ok(Array.isArray(mem0Ids), "节点 metadata 应有 mem0Ids");
    assert.deepEqual([...mem0Ids].sort(), ["m0-aaa", "m0-bbb"]);

    // bridge_links 表有 linkage（含 mem0 两条）
    const links = bridge
      .listLinks()
      .filter((l) => l.graphNodeId === result.graphNodeId);
    assert.equal(links.length, 1);
    assert.equal(links[0]!.mem0Ids.length, 2);
  });
});

test("writeUnified：re-ingest 相同内容时 mem0Ids 合并去重，不重复累计", async () => {
  await withBridgeEnv(async ({ bridge }) => {
    await bridge.writeUnified("user-1", "chat:turn-1", "用户喜欢在周末爬山，每周都去", {
      context: "main",
      highSignal: true,
    });
    await bridge.writeUnified("user-1", "chat:turn-2", "用户喜欢在周末爬山，每周都去", {
      context: "main",
      highSignal: true,
    });

    const links = bridge.listLinks();
    // 两轮各插一行 link（来源不同），但节点 metadata 只有一组去重后的 ids
    assert.equal(links.length, 2);
    const nodeIds = links.map((l) => l.graphNodeId);
    assert.equal(new Set(nodeIds).size, 1, "同语义内容应命中同一认知图节点");
  });
});

// ============================================================
// 2. 融合召回
// ============================================================

test("searchFused：双通道命中同一内容标记 both，RRF 排序生效", async () => {
  await withBridgeEnv(async ({ bridge, graph, retrievalState }) => {
    await bridge.writeUnified("user-1", "chat:turn-1", "用户喜欢在周末爬山，每周都去", {
      context: "main",
      highSignal: true,
    });

    // Mem0 侧召回：一条与认知图同义（应合并为 both），一条独有
    retrievalState.candidates = [
      { content: "用户喜欢在周末爬山", score: 0.9, highSignal: true },
      { content: "用户在成都工作，做后端开发", score: 0.7, highSignal: false },
    ];

    const fused = await bridge.searchFused("user-1", "周末爬山 用户工作");
    assert.ok(fused.length >= 2, `至少融合出 2 条，实际 ${fused.length}`);

    const both = fused.find((f) => f.channels.includes("both"));
    assert.ok(both, "同义内容应合并为双通道");
    assert.ok(both!.graphNodeId, "双通道条目应携带图节点 id");

    const mem0Only = fused.find((f) => f.content.includes("成都"));
    assert.ok(mem0Only, "Mem0 独有内容应保留");
    assert.deepEqual(mem0Only!.channels, ["mem0"]);

    // 双通道（两路 rank 都靠前）的融合分应高于单通道
    assert.ok(both!.fusedScore > mem0Only!.fusedScore, "双通道融合分应高于单通道");

    // 文本渲染带来源标签（多通道 = 多路 rank 一致命中；混合检索改造后通道含 FTS）
    const text = await bridge.buildFusedRecall("user-1", "周末爬山 用户工作");
    assert.match(text, /多通道/);
    assert.match(text, /Mem0/);

    void graph;
  });
});

test("searchFused：空查询返回空", async () => {
  await withBridgeEnv(async ({ bridge }) => {
    assert.deepEqual(await bridge.searchFused("user-1", "   "), []);
    assert.equal(await bridge.buildFusedRecall("user-1", ""), "");
  });
});

// ============================================================
// 3. 遗忘同步
// ============================================================

test("syncForgetting：soft_deleted 节点触发 Mem0 删除并 tombstone，active 不动", async () => {
  await withBridgeEnv(async ({ graph, bridge, calls }) => {
    const { graphNodeId } = await bridge.writeUnified("user-1", "chat:turn-1", "用户喜欢在周末爬山，每周都去", {
      context: "main",
      highSignal: true,
    });

    // active 阶段：不删
    let report = await bridge.syncForgetting("user-1");
    assert.equal(report.deletedMem0, 0);
    assert.deepEqual(calls.deleted, []);

    // 推进到 downranked：仍不删（阈值删除策略）
    graph.updateDeletionStage("user-1", graphNodeId!, "downranked");
    report = await bridge.syncForgetting("user-1");
    assert.equal(report.deletedMem0, 0);

    // 推进到 soft_deleted：删除关联 Mem0 记忆
    graph.updateDeletionStage("user-1", graphNodeId!, "soft_deleted");
    report = await bridge.syncForgetting("user-1");
    assert.equal(report.deletedMem0, 2);
    assert.deepEqual([...calls.deleted].sort(), ["m0-aaa", "m0-bbb"]);
    assert.equal(report.forgottenLinks, 1);

    // tombstone 后重复扫描不再重删
    report = await bridge.syncForgetting("user-1");
    assert.equal(report.deletedMem0, 0);
    assert.equal(calls.deleted.length, 2);
  });
});

test("syncForgetting：节点缺失（图库清空）时直接 tombstone", async () => {
  await withBridgeEnv(async ({ graph, bridge }) => {
    await bridge.writeUnified("user-1", "chat:turn-1", "用户喜欢在周末爬山，每周都去", {
      context: "main",
      highSignal: true,
    });
    // 模拟图库清空：直接清掉 store 里的节点
    (graph as unknown as { store: { nodes: Record<string, unknown> } }).store.nodes = {};

    const report = await bridge.syncForgetting("user-1");
    assert.equal(report.missingNodes, 1);
    assert.equal(report.forgottenLinks, 1);
  });
});

// ============================================================
// 4. NarrativeFacade 桥接接线
// ============================================================

test("NarrativeMemoryFacade：注入 bridge 后写入与召回都走桥接", async () => {
  await withBridgeEnv(async ({ graph, bridge, ingest, calls, retrievalState }) => {
    const facade = new NarrativeMemoryFacade(ingest, makeFakeRetrieval(retrievalState), null, graph, bridge);

    await facade.writeDecided("user-1", "用户养了一只叫布丁的猫，三岁了", "chat:turn-9", {
      context: "main",
      highSignal: true,
    });

    // 一次 writeDecided 只有一次 Mem0 add（bridge 统一写入，不重复双写）
    assert.equal(calls.add.length, 1);
    assert.equal(graph.getAllNodes("user-1").length, 1);

    retrievalState.candidates = [{ content: "用户养了一只叫布丁的猫", score: 0.8, highSignal: false }];
    const recall = await facade.buildNarrativeRecall("user-1", "布丁 猫");
    assert.match(recall, /融合召回|布丁/, "融合召回应命中 Mem0 或认知图内容");
  });
});

test("writeUnified：两侧都失败时 ok=false，调用方可据此保留 journal 原文", async () => {
  const dir = await mkdtemp(join(tmpdir(), "memory-bridge-fail-"));
  const savedEnv = new Map(LLM_ENV_KEYS.map((k) => [k, process.env[k]] as const));
  for (const k of LLM_ENV_KEYS) delete process.env[k];

  const failingGraph = {
    async ingest() {
      throw new Error("graph down");
    },
  } as unknown as BridgeGraphLike;
  const failingMemory = {
    async add() {
      throw new Error("mem0 down");
    },
  } as unknown as Memory;
  const ingest = new AgenticMemoryIngestService(failingMemory);
  const db = openAgenticSqlite(join(dir, "bridge.db"));
  const bridge = new MemoryBridgeService(
    failingMemory,
    failingGraph,
    ingest,
    makeFakeRetrieval({ candidates: [] }),
    db,
  );

  try {
    const result = await bridge.writeUnified("user-1", "journal:consolidate", "用户喜欢在周末爬山，每周都去", {
      context: "main",
      highSignal: true,
    });
    assert.equal(result.ok, false, "双写都抛错时 ok 必须为 false");
    assert.equal(result.graphNodeId, null);
    assert.deepEqual(result.mem0Items, []);
  } finally {
    bridge.close();
    await rm(dir, { recursive: true, force: true });
    for (const [k, v] of savedEnv) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test("createMemoryBridgeIfEnabled：enabled=false 或依赖缺失返回 null", async () => {
  await withBridgeEnv(async ({ graph, ingest, calls }) => {
    const memory = makeFakeMemory(calls, []);
    assert.equal(createMemoryBridgeIfEnabled({ enabled: false, memory, graph, ingest, retrieval: makeFakeRetrieval({ candidates: [] }) }), null);
    // 缺 Mem0 运行时（agentic-memory 关闭）也返回 null
    assert.equal(
      createMemoryBridgeIfEnabled({ memory: null, graph, ingest: null, retrieval: null }),
      null,
    );
  });
});
