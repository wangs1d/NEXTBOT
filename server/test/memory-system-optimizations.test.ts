/**
 * 记忆系统整体优化批次单测（2026-09-04）。
 *
 * 覆盖：
 *   1. 统一抽取器纯函数（P1-6）：JSON 剥壳 / 决策校验 / 承诺+纠正规范化
 *      / 五维评分植入闸门（无用消息 reject、临时内容 decay）
 *   2. ledger FTS5 检索 + 保留策略 + purgeActor（P1-10 / P0-2）
 *   3. bridge 删除调和 / 删除失败封顶 / 存量回填 / purgeActor（P0-3 / P2-15 / P0-2）
 *   5. 认知图 SQLite 行级持久化 round-trip 与 JSON 迁移（P1-9）
 *
 * 全部封闭：fake Mem0、临时目录、无外部 LLM。
 */

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  normalize as normalizeUnified,
  parseJsonObject,
} from "../src/agentic-memory/unified-extractor.js";
import { AgenticLedger } from "../src/agentic-memory/ledger.js";
import { MemoryBridgeService } from "../src/agentic-memory/memory-bridge-service.js";
import type { BridgeGraphLike } from "../src/agentic-memory/memory-bridge-service.js";
import { GraphSqlitePersistence } from "../src/services/graph-sqlite-store.js";
import { openAgenticSqlite } from "../src/agentic-memory/sqlite-store.js";

// ============================================================
// 1. 统一抽取器纯函数（P1-6）
// ============================================================

test("parseJsonObject：容忍围栏与杂文，坏 JSON 返回 null", () => {
  assert.deepEqual(parseJsonObject('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parseJsonObject('前置说明 {"decision":"remember"} 后缀'), {
    decision: "remember",
  });
  assert.equal(parseJsonObject("不是 json"), null);
  assert.equal(parseJsonObject('{"broken": '), null);
});

test("normalizeUnified：决策校验 / 纠正项 / 无效决策拒绝", () => {
  const ok = normalizeUnified({
    decision: "remember",
    semanticClass: "承诺",
    memories: ["用户周五前转账给供应商", "", "x"],
    corrections: [
      { oldClaim: "9月去北京出差", newClaim: "行程取消" },
      { oldClaim: "", newClaim: "x" },
    ],
  });
  assert.ok(ok);
  assert.equal(ok.decision, "remember");
  assert.deepEqual(ok.memories, ["用户周五前转账给供应商"]);
  assert.deepEqual(ok.corrections, [{ oldClaim: "9月去北京出差", newClaim: "行程取消" }]);

  assert.equal(normalizeUnified({ decision: "maybe" }), null);
  assert.equal(normalizeUnified({ decision: "reject", memories: ["不应带出"] })!.memories.length, 0);
});

test("normalizeUnified：referents 角色指代映射规范化（写时结构化，realtime 消解数据源）", () => {
  const ok = normalizeUnified({
    decision: "remember",
    memories: ["用户半开玩笑地自称'老婆'是明星刘浩存（粉丝式称呼）"],
    referents: [
      { role: "老婆", name: "刘浩存", confidence: 0.9 },
      { role: "", name: "无名丢弃" },
      { role: "超长称谓字段超过十二个字以上被丢弃", name: "x" },
      { role: "偶像", name: "", confidence: 0.8 },
    ],
  });
  assert.ok(ok);
  assert.deepEqual(ok.referents, [{ role: "老婆", name: "刘浩存", confidence: 0.9 }]);
  // 旧输出无 referents 字段 → 空数组兜底（不破坏既有调用方）
  const legacy = normalizeUnified({ decision: "remember", memories: ["普通记忆"] });
  assert.deepEqual(legacy!.referents, []);
});

// ── 五维评分植入闸门（持久性/频率/情感强度/影响范围/确定性 → 加权综合分裁决） ──

test("评分闸门：无用消息（低持久+低影响）即使 LLM 误标 remember 也被 reject", () => {
  const gated = normalizeUnified({
    decision: "remember",
    semanticClass: "事件",
    memories: ["用户说今天天气很好"],
    scores: { persistence: 0.05, frequency: 0.1, emotion: 0.3, impact: 0.05, certainty: 0.8 },
  });
  assert.ok(gated);
  assert.equal(gated.decision, "reject");
  assert.equal(gated.memories.length, 0, "无用消息不携带 memories 落库");
  // 综合分 = 0.3*0.05+0.25*0.05+0.2*0.8+0.15*0.3+0.1*0.1 ≈ 0.24 < 无用线 0.3
  assert.ok(gated.importance !== undefined && gated.importance < 0.3);
});

test("评分闸门：转瞬即逝（高情感低持久）remember 降级 decay", () => {
  const gated = normalizeUnified({
    decision: "remember",
    memories: ["用户今天特别开心"],
    scores: { persistence: 0.1, frequency: 0.1, emotion: 0.9, impact: 0.2, certainty: 0.8 },
  });
  assert.ok(gated);
  assert.equal(gated.decision, "decay", "今天的心情无论多强烈都不植入长期库");
});

test("评分闸门：中间带（临时安排）remember 降级 decay", () => {
  const gated = normalizeUnified({
    decision: "remember",
    memories: ["用户明天下午三点开会"],
    scores: { persistence: 0.2, frequency: 0.2, emotion: 0.3, impact: 0.5, certainty: 0.9 },
  });
  assert.ok(gated);
  assert.equal(gated.decision, "decay");
});

test("评分闸门：达标的长期事实保持 remember，importance 取五维综合分而非 LLM 自报值", () => {
  const gated = normalizeUnified({
    decision: "remember",
    memories: ["用户是全栈开发，项目用 React"],
    importance: 0.99,
    scores: { persistence: 0.9, frequency: 0.6, emotion: 0.3, impact: 0.8, certainty: 0.9 },
  });
  assert.ok(gated);
  assert.equal(gated.decision, "remember");
  // 综合分 = 0.3*0.9+0.25*0.8+0.2*0.9+0.15*0.3+0.1*0.6 = 0.755
  assert.ok(gated.importance !== undefined && Math.abs(gated.importance - 0.755) < 0.005);
});

test("评分闸门：decay 候选综合分低于无用线升级 reject（纯噪声不落库）", () => {
  const gated = normalizeUnified({
    decision: "decay",
    memories: ["用户打了个招呼"],
    scores: { persistence: 0.05, frequency: 0.1, emotion: 0.2, impact: 0.05, certainty: 0.7 },
  });
  assert.ok(gated);
  assert.equal(gated.decision, "reject");
  assert.equal(gated.memories.length, 0);
});

test("评分闸门：reject 不因高分翻案（敏感/重复维持拒存），仅校准分数", () => {
  const gated = normalizeUnified({
    decision: "reject",
    memories: [],
    scores: { persistence: 0.9, frequency: 0.8, emotion: 0.7, impact: 0.9, certainty: 0.9 },
  });
  assert.ok(gated);
  assert.equal(gated.decision, "reject");
});

test("评分闸门：五维缺任一维视为整体缺失，回退旧单分行为", () => {
  const partial = normalizeUnified({
    decision: "remember",
    memories: ["用户喜欢喝拿铁"],
    importance: 0.6,
    scores: { persistence: 0.8, frequency: 0.5, emotion: 0.3, impact: 0.9 },
  });
  assert.ok(partial);
  assert.equal(partial.decision, "remember");
  assert.equal(partial.importance, 0.6);
  assert.equal(partial.scores, undefined);
});

// ============================================================
// 2. ledger：FTS5 检索 / 保留策略 / purgeActor
// ============================================================

test("ledger：FTS5 检索命中与活跃过滤，purgeActor 清库", () => {
  const dir = mkdtempSync(join(tmpdir(), "ledger-fts-"));
  try {
    const ledger = new AgenticLedger(openAgenticSqlite(join(dir, "l.db")));
    const r1 = ledger.append({ actorId: "u1", claim: "用户承诺周五前转账给供应商", sourceRef: "chat:1" })!;
    ledger.append({ actorId: "u1", claim: "用户喜欢在周末爬山", sourceRef: "chat:2" });
    ledger.append({ actorId: "u2", claim: "用户承诺下周交付样品", sourceRef: "chat:3" });

    const hits = ledger.searchByClaim("u1", "转账");
    assert.equal(hits.length, 1);
    assert.equal(hits[0]!.id, r1.id);
    assert.equal(ledger.searchByClaim("u2", "转账").length, 0, "actor 隔离");

    ledger.supersede(r1.id, "led_new", "测试");
    assert.equal(ledger.searchByClaim("u1", "转账").length, 0, "被替代断言不入检索");

    const purged = ledger.purgeActor("u1");
    assert.ok(purged >= 2);
    assert.equal(ledger.listActiveByActor("u1").length, 0);
    assert.equal(ledger.listActiveByActor("u2").length, 1);
    ledger.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ledger：pruneSuperseded 只物理删除超期被替代记录", () => {
  const dir = mkdtempSync(join(tmpdir(), "ledger-prune-"));
  try {
    const db = openAgenticSqlite(join(dir, "l.db"));
    const ledger = new AgenticLedger(db);
    const old = ledger.append({ actorId: "u1", claim: "旧断言被替代", sourceRef: "chat:1" })!;
    ledger.append({ actorId: "u1", claim: "活跃断言保留", sourceRef: "chat:2" });
    ledger.supersede(old.id, "led_replacement", "替代");
    // 手工把 superseded_at 拨老（31 天前）
    db
      .prepare(`UPDATE ledger_records SET superseded_at = ? WHERE id = ?`)
      .run(new Date(Date.now() - 31 * 86_400_000).toISOString(), old.id);

    assert.equal(ledger.pruneSuperseded(30), 1, "超期被替代记录删除");
    assert.equal(ledger.pruneSuperseded(30), 0, "幂等");
    assert.equal(ledger.getById(old.id), null);
    assert.ok(ledger.listActiveByActor("u1").length === 1, "活跃记录不受影响");
    assert.equal(ledger.pruneSuperseded(0), 0, "0=关闭");
    ledger.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ============================================================
// 3. bridge：删除调和 / 失败封顶 / 回填 / purgeActor
// ============================================================

function makeGraphFixture() {
  const nodes = new Map<
    string,
    { id: string; actorId: string; summary: string; deletionStage: string; metadata: Record<string, unknown> }
  >();
  const graph: BridgeGraphLike = {
    async ingest(actorId, text, source) {
      const id = `n_${nodes.size + 1}`;
      nodes.set(id, {
        id,
        actorId,
        summary: text.trim().replace(/\s+/g, " "),
        deletionStage: "active",
        metadata: {},
      });
      void source;
      return id;
    },
    getAllNodes(actorId) {
      return [...nodes.values()].filter((n) => n.actorId === actorId);
    },
    attachNodeMetadata(_actorId, nodeId, patch) {
      const n = nodes.get(nodeId);
      if (!n) return false;
      n.metadata = { ...n.metadata, ...patch };
      return true;
    },
    async buildRecall() {
      return { recalledNodeIds: [], confidence: 0, text: "" };
    },
    getNodeSummariesByIds() {
      return [];
    },
  };
  return { graph, nodes };
}

async function withOptBridge(
  fn: (ctx: {
    bridge: MemoryBridgeService;
    graph: ReturnType<typeof makeGraphFixture>["graph"];
    nodes: ReturnType<typeof makeGraphFixture>["nodes"];
  }) => Promise<void>,
  opts?: {
    memory?: { delete(id: string): Promise<unknown>; getAll?(): Promise<unknown> };
    extracted?: Array<{ id: string; memory: string }>;
  },
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "bridge-opt-"));
  try {
    const { graph, nodes } = makeGraphFixture();
    const memory = opts?.memory ?? { async delete() {} };
    const bridge = new MemoryBridgeService(
      memory,
      graph,
      { async writeDecidedDetailed() { return opts?.extracted ?? []; } },
      { async searchStructured() { return []; } },
      openAgenticSqlite(join(dir, "b.db")),
    );
    try {
      await fn({ bridge, graph, nodes });
    } finally {
      bridge.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("bridge：handleMem0Deleted 修剪 mem0Ids，摘空 tombstone；purgeActor 清理", async () => {
  const deleted: string[] = [];
  await withOptBridge(
    async ({ bridge }) => {
      await bridge.writeUnified("u1", "chat:1", "内容文本", { context: "main", highSignal: true });
      assert.equal(bridge.listLinks({ activeOnly: true }).length, 1);

      bridge.handleMem0Deleted(["m0-1"]);
      let links = bridge.listLinks({ activeOnly: true });
      assert.equal(links.length, 1, "部分删除 → 修剪不 tombstone");
      assert.deepEqual(links[0]!.mem0Ids, ["m0-2"]);

      bridge.handleMem0Deleted(["m0-2"]);
      links = bridge.listLinks({ activeOnly: true });
      assert.equal(links.length, 0, "摘空 → tombstone");
      assert.equal(bridge.listLinks().length, 1);
      assert.equal(bridge.listLinks()[0]!.lastStage, "mem0_pruned");

      bridge.handleMem0Deleted(["m0-1", "m0-2"]); // 幂等
      assert.equal(bridge.listLinks({ activeOnly: true }).length, 0);

      await bridge.writeUnified("u2", "chat:9", "另一用户内容", { context: "main", highSignal: true });
      assert.equal(bridge.purgeActor("u1"), 1);
      assert.equal(bridge.listLinks().filter((l) => l.actorId === "u1").length, 0);
      assert.equal(bridge.listLinks({ activeOnly: true }).length, 1, "u2 不受影响");
    },
    {
      memory: {
        async delete(id: string) {
          deleted.push(id);
        },
      },
      extracted: [
        { id: "m0-1", memory: "断言一" },
        { id: "m0-2", memory: "断言二" },
      ],
    },
  );
  void deleted;
});

test("bridge：writeUnified 的 ingest fake 产出两条 mem0（配合调和用）", async () => {
  await withOptBridge(
    async ({ bridge }) => {
      const result = await bridge.writeUnified("u1", "chat:1", "内容文本", {
        context: "main",
        highSignal: true,
      });
      assert.equal(result.mem0Items.length, 2);
    },
    {
      memory: { async delete() {} },
      extracted: [
        { id: "m0-1", memory: "断言一" },
        { id: "m0-2", memory: "断言二" },
      ],
    },
  );
});

test("bridge：syncForgetting 删除连续失败 3 轮后 tombstone（delete_failed）", async () => {
  await withOptBridge(
    async ({ bridge, graph }) => {
      await bridge.writeUnified("u1", "chat:1", "内容文本内容", { context: "main", highSignal: true });
      const node = graph.getAllNodes("u1")[0]!;
      node.deletionStage = "soft_deleted";

      await bridge.syncForgetting("u1");
      await bridge.syncForgetting("u1");
      const report = await bridge.syncForgetting("u1");
      assert.equal(report.forgottenLinks, 1, "第 3 轮失败后 tombstone");
      assert.equal(bridge.listLinks()[0]!.lastStage, "delete_failed");

      const after = await bridge.syncForgetting("u1");
      assert.equal(after.scannedLinks, 0, "tombstone 后不再重扫");
    },
    {
      memory: {
        async delete() {
          throw new Error("qdrant down");
        },
      },
      extracted: [{ id: "m0-stuck", memory: "删不掉的记忆" }],
    },
  );
});

test("bridge：backfillLinks 用文本相似度回填存量 linkage（零 LLM）", async () => {
  await withOptBridge(
    async ({ bridge, nodes }) => {
      nodes.set("n_legacy", {
        id: "n_legacy",
        actorId: "u1",
        summary: "用户喜欢在周末爬山，每周都去",
        deletionStage: "active",
        metadata: {},
      });

      const report = await bridge.backfillLinks("u1");
      assert.equal(report.nodesMatched, 1);
      const node = nodes.get("n_legacy")!;
      assert.deepEqual(node.metadata.mem0Ids, ["m0-old"]);
      assert.equal(node.metadata.backfilled, true);

      const again = await bridge.backfillLinks("u1");
      assert.equal(again.nodesMatched, 0, "幂等：已有 linkage 跳过");
    },
    {
      memory: {
        async delete() {},
        async getAll() {
          return {
            results: [
              { id: "m0-old", memory: "用户喜欢在周末爬山，每周都去", metadata: { actorId: "u1" } },
              { id: "m0-other", memory: "完全无关的另一条记忆内容", metadata: { actorId: "u1" } },
            ],
          };
        },
      },
    },
  );
});

// ============================================================
// 5. 认知图 SQLite 行级持久化（P1-9）
// ============================================================

test("graph-sqlite：save/load round-trip + hash-diff 增量 + JSON 迁移种子", async () => {
  const dir = await mkdtemp(join(tmpdir(), "graph-sqlite-"));
  try {
    const path = join(dir, "human-memory.json"); // 仿真实命名 → 生成 human-memory.sqlite
    const store = {
      version: 1,
      domains: { profile: { id: "profile" } },
      nodes: {
        n1: { id: "n1", summary: "节点一" },
        n2: { id: "n2", summary: "节点二" },
      },
      edges: { e1: { id: "e1", from: "n1", to: "n2" } },
      versions: {},
      communities: {},
    };

    const p1 = new GraphSqlitePersistence(path);
    await p1.load();
    p1.save(store);
    p1.close();

    const p2 = new GraphSqlitePersistence(path);
    const { data } = await p2.load();
    assert.deepEqual(data!.nodes, store.nodes);
    assert.deepEqual(data!.edges, store.edges);

    // 增量：改 n1、删 n2、加 n3
    const next = structuredClone(store) as typeof store;
    (next.nodes.n1 as { summary: string }).summary = "节点一（改）";
    delete next.nodes.n2;
    next.nodes.n3 = { id: "n3", summary: "节点三" };
    p2.save(next);
    p2.close();

    const p3 = new GraphSqlitePersistence(path);
    const { data: reloaded } = await p3.load();
    assert.equal((reloaded!.nodes!.n1 as { summary: string }).summary, "节点一（改）");
    assert.equal(reloaded!.nodes!.n2, undefined);
    assert.ok(reloaded!.nodes!.n3);
    p3.close();

    // JSON 迁移种子：删库后仅存 json → 自动导入
    await rm(join(dir, "human-memory.sqlite"), { force: true });
    await writeFile(path, JSON.stringify({ version: 1, nodes: { j1: { id: "j1" } } }), "utf8");
    const p4 = new GraphSqlitePersistence(path);
    const { data: migrated } = await p4.load();
    assert.ok(migrated!.nodes!.j1, "旧 JSON 自动种子迁移");
    p4.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
