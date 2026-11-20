/**
 * 长尾事实 ↔ 认知图联动（联想能力的地基）
 *
 * 联想扩散的种子与激活目标都是图节点；长尾事实只活在 structured_facts 里时，
 * 「提到骑行想起用户喜欢骑行」这类走不通。本测试锁住三件事：
 *   1. 写长尾事实即在图上落一个节点（写后钩子，生产接线同款条件）；
 *   2. 同一条事实被重复确认时只 touch，图上不多一个节点；
 *   3. 档案字段不入图（它们每轮都确定性注入，不需要联想）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openAgenticSqlite } from "../src/agentic-memory/sqlite-store.js";
import {
  StructuredFactStore,
  isTailCategory,
  tailCategoryFor,
  tailKindOf,
} from "../src/agentic-memory/structured-fact-store.js";
import { HumanLikeMemoryService } from "../src/services/human-like-memory-service.js";

const ACTOR = "tail-graph-link@test.local";

/** 建图会异步向量化（内置引擎加载模型要几十秒）；本测试只验结构性契约，先关掉。 */
const EMBED_ENV_KEYS = [
  "AGENT_LOCAL_EMBEDDING_DISABLED",
  "AGENT_EMBEDDING_BASE_URL",
  "AGENT_EMBEDDING_API_KEY",
  "OPENAI_API_KEY",
] as const;

async function withWired(
  fn: (ctx: {
    store: StructuredFactStore;
    graph: HumanLikeMemoryService;
    tailNodes: () => Array<{ id: string; summary: string; metadata?: Record<string, unknown> }>;
  }) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "tail-graph-"));
  const savedEnv = new Map(EMBED_ENV_KEYS.map((k) => [k, process.env[k]] as const));
  process.env.AGENT_LOCAL_EMBEDDING_DISABLED = "1";
  delete process.env.AGENT_EMBEDDING_BASE_URL;
  delete process.env.AGENT_EMBEDDING_API_KEY;
  delete process.env.OPENAI_API_KEY;
  const db = openAgenticSqlite(join(dir, "agentic-memory.db"));
  const store = new StructuredFactStore(db);
  const graph = new HumanLikeMemoryService(join(dir, "graph.json"), join(dir, "policy.json"));
  await graph.load();

  // 与 create-app-services 的写后钩子同一条件：只有新增的长尾类目入图
  store.setFactObserver((fact, _input, changed) => {
    if (!changed || !isTailCategory(fact.category)) return;
    void graph.linkTailFactNodes(fact.actorId, [
      {
        id: fact.id,
        value: fact.value,
        field: fact.field,
        kind: tailKindOf(fact.category),
        confidence: fact.confidence,
      },
    ]);
  });

  const tailNodes = () =>
    graph
      .getAllNodes(ACTOR)
      .filter((n) => typeof n.metadata?.tailFactId === "string")
      .map((n) => ({ id: n.id, summary: n.summary, metadata: n.metadata }));

  try {
    await fn({ store, graph, tailNodes });
  } finally {
    db.close();
    await graph.shutdown();
    for (const [k, v] of savedEnv) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await rm(dir, { recursive: true, force: true });
  }
}

test("写长尾事实即在认知图建节点（metadata 回指事实 id）", () =>
  withWired(async ({ store, tailNodes }) => {
    const written = store.applyFact({
      actorId: ACTOR,
      field: "周末活动",
      value: "用户喜欢周末去万峰林骑行",
      confidence: 0.7,
      sourceRef: "test:sediment",
      category: tailCategoryFor("preference"),
    });
    assert.ok(written?.changed, "长尾事实应落库");
    await new Promise((r) => setTimeout(r, 30));

    const nodes = tailNodes();
    assert.equal(nodes.length, 1, "一条长尾事实对应一个图节点");
    assert.equal(nodes[0]!.summary, "用户喜欢周末去万峰林骑行");
    assert.equal(nodes[0]!.metadata?.tailFactId, written!.fact.id);
  }));

test("同一条事实重复沉淀只 touch 已有行，图上不多一个节点", () =>
  withWired(async ({ store, tailNodes }) => {
    const input = {
      actorId: ACTOR,
      field: "周末活动",
      value: "用户喜欢周末去万峰林骑行",
      confidence: 0.7,
      category: tailCategoryFor("preference"),
    };
    store.applyFact(input);
    const second = store.applyFact({ ...input, sourceRef: "test:sediment-2" });
    assert.equal(second!.changed, false, "同值重复只确认");
    await new Promise((r) => setTimeout(r, 30));

    assert.equal(store.getTailFacts(ACTOR).length, 1);
    assert.equal(tailNodes().length, 1, "同一条事实只对应一个图节点");
  }));

test("档案字段不入图（每轮确定性注入，无需联想）", () =>
  withWired(async ({ store, tailNodes }) => {
    store.applyFact({
      actorId: ACTOR,
      field: "居住地",
      value: "兴义",
      confidence: 0.9,
    });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(tailNodes().length, 0);
  }));

test("夜间存量补节点幂等：已建过的按 tailFactId 跳过", () =>
  withWired(async ({ store, graph, tailNodes }) => {
    const fact = store.applyFact({
      actorId: ACTOR,
      field: "饮品",
      value: "用户喜欢喝美式咖啡",
      confidence: 0.7,
      category: tailCategoryFor("preference"),
    });
    assert.ok(fact?.changed);
    await new Promise((r) => setTimeout(r, 30));
    const before = tailNodes().length;

    const tails = store.getTailFacts(ACTOR);
    const again = await graph.linkTailFactNodes(
      ACTOR,
      tails.map((f) => ({
        id: f.id,
        value: f.value,
        field: f.field,
        kind: tailKindOf(f.category),
        confidence: f.confidence,
      })),
    );
    assert.equal(again.linked, 0, "存量收敛不应重复建节点");
    assert.equal(again.alreadyLinked, before);
    assert.equal(tailNodes().length, before);
  }));
