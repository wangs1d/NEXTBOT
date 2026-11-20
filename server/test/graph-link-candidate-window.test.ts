/**
 * 联想建边候选窗口回归。
 *
 * 建边曾经只看「最近 200 个候选」，于是老记忆永远拿不到新边：实测主账号
 * 103/647 节点零边，联想扩散对这些记忆结构性不可达。本测试锁两件事：
 *   1. 写入位置在第 1 位的老节点，在第 212 个节点旁边仍能被连上；
 *   2. relinkIsolatedNodes 按 limit 分批、可重复调用。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HumanLikeMemoryService, type MemoryNodeRecord } from "../src/services/human-like-memory-service.js";

const ACTOR = "graph-window@test.local";

function makeNode(id: string, keywords: string[], entityTags: string[], ageMs = 0): MemoryNodeRecord {
  const iso = new Date(Date.now() - 1000 - ageMs).toISOString();
  return {
    id,
    actorId: ACTOR,
    domainId: "general",
    parentDomainId: null,
    kind: "episodic",
    source: `test:${id}`,
    sourceType: "chat",
    context: "main",
    summary: keywords.join(" "),
    keywords,
    sceneTags: [],
    emotionTags: [],
    entityTags,
    semanticFingerprint: `fp-${id}`,
    vectorFingerprint: "",
    timestamp: iso,
    lastAccessedAt: iso,
    accessCount: 1,
    importance: 0.5,
    confidence: 0.8,
    frequencyScore: 0,
    recencyScore: 1,
    domainScore: 1,
    userFeedbackScore: 1,
    correctness: "unknown",
    deletionStage: "active",
    isArchived: false,
  } as MemoryNodeRecord;
}

async function withGraph(fn: (graph: HumanLikeMemoryService) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "graph-window-"));
  const graph = new HumanLikeMemoryService(join(dir, "human-memory.json"));
  process.env.AGENT_LOCAL_EMBEDDING_DISABLED = "1";
  try {
    await graph.load();
    await fn(graph);
  } finally {
    await graph.shutdown();
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
}

function linked(store: { edges: Record<string, { from: string; to: string }> }, a: string, b: string): boolean {
  return Object.values(store.edges).some(
    (e) => (e.from === a && e.to === b) || (e.from === b && e.to === a),
  );
}

test("建边候选不截断：两端相隔 400 个节点的边仍然建得出", async () => {
  await withGraph(async (graph) => {
    const store = graph["store"];
    store.nodes = {};
    store.edges = {};
    store.nodes["old"] = makeNode("old", ["骑行", "变速"], ["用户"], 600_000);
    for (let i = 0; i < 400; i++) {
      store.nodes[`filler-${i}`] = makeNode(`filler-${i}`, [`杂项${i}`], [], 100_000 + i);
    }
    // new 是最新访问的节点：limit=1 时只有它被重连，边能不能建全看候选池。
    store.nodes["new"] = makeNode("new", ["骑行", "变速"], ["用户"]);

    await graph.relinkIsolatedNodes(ACTOR, 1);

    assert.ok(linked(store, "old", "new"), "两端都在彼此窗口外的节点必须能建边");
    assert.equal(
      Object.values(store.edges).filter((e) => e.from === "filler-7" || e.to === "filler-7").length,
      0,
      "无重叠内容的节点不该被硬连上",
    );
  });
});

test("relinkIsolatedNodes 按 limit 分批且可重复收敛", async () => {
  await withGraph(async (graph) => {
    const store = graph["store"];
    store.nodes = {};
    store.edges = {};
    store.nodes["a"] = makeNode("a", ["露营", "炊具"], ["用户"]);
    store.nodes["b"] = makeNode("b", ["露营", "炊具"], ["用户"]);
    for (let i = 0; i < 30; i++) {
      store.nodes[`filler-${i}`] = makeNode(`filler-${i}`, [`无关${i}`], []);
    }

    const first = await graph.relinkIsolatedNodes(ACTOR, 2);
    assert.equal(first.relinked, 2);
    assert.ok(first.remaining > 0, "首批应留下待收敛数量");

    const second = await graph.relinkIsolatedNodes(ACTOR, 500);
    assert.ok(linked(store, "a", "b"), "两轮之内 a-b 必须连上");
    const third = await graph.relinkIsolatedNodes(ACTOR, 500);
    assert.equal(third.remaining, 0, "收敛后不该再有待重连节点");
    const edgeCount = Object.keys(store.edges).length;
    await graph.relinkIsolatedNodes(ACTOR, 500);
    assert.equal(Object.keys(store.edges).length, edgeCount, "重连必须幂等，不多建边");
  });
});
