/**
 * 用户生活模型（Life Model）测试 —— 记忆四层金字塔第 ④ 层。
 *
 * 覆盖 P0 / P1 / P2 验收点：
 *   P0：图式 / 经历 / 信念落盘（跨重启 hydrate）；实体物化（structured_facts.entity → life_entities）
 *   P1：life_edges + self_agent 边收敛；lifeModel 召回通道进仲裁；【用户关系一览】注入；life.manage 工具
 *   P2：关系跳变 → changeLog 追加（零 LLM）；敏感实体默认不进注入块；「忘掉这个人」实体+边+事实三清
 *
 * 测试封闭：临时 SQLite，无外部依赖。
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { LifeModelStore } from "../src/agentic-memory/life-model-store.js";
import { StructuredFactStore } from "../src/agentic-memory/structured-fact-store.js";
import { openAgenticSqlite } from "../src/agentic-memory/sqlite-store.js";
import { arbitrateMemories, DEFAULT_ARBITRATOR_CONFIG } from "../src/brain/memory-arbitrator.js";
import { MemorySchemaFormation } from "../src/brain/memory-cognitive/memory-schema-formation.js";
import { MemoryExperienceLearningLoop } from "../src/brain/memory-cognitive/memory-experience-learning-loop.js";
import { RelationshipGraphService } from "../src/services/relationship-graph-service.js";
import { registerLifeManageTools } from "../src/tools/life-manage-tools.js";
import { ToolRegistry } from "../src/tools/tool-registry.js";

const ACTOR = "user-life-1";

async function withStore(
  fn: (ctx: { store: LifeModelStore; db: ReturnType<typeof openAgenticSqlite>; dir: string }) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "life-model-"));
  const db = openAgenticSqlite(join(dir, "life.db"));
  const store = new LifeModelStore(db);
  try {
    await fn({ store, db, dir });
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
}

// ============================================================
// P0：实体 upsert + 跨重启存活
// ============================================================

test("P0：实体 upsert 幂等、别名合并；重开库后仍在", async () => {
  const dir = await mkdtemp(join(tmpdir(), "life-model-"));
  const path = join(dir, "life.db");
  try {
    const db1 = openAgenticSqlite(path);
    const s1 = new LifeModelStore(db1);
    const a = s1.upsertEntity({ actorId: ACTOR, kind: "person", canonicalName: "小满", aliases: ["满满"] });
    const b = s1.upsertEntity({ actorId: ACTOR, kind: "person", canonicalName: "小满", aliases: ["阿满"] });
    assert.ok(a && b);
    assert.equal(a!.id, b!.id, "同 (actor,name) 幂等，返回同一实体");
    assert.ok(b!.aliases.includes("满满") && b!.aliases.includes("阿满"), "别名合并");
    s1.close();

    // 重启：新 store 读同一库
    const db2 = openAgenticSqlite(path);
    const s2 = new LifeModelStore(db2);
    assert.ok(s2.findEntityByName(ACTOR, "小满"), "重启后实体仍在");
    assert.ok(s2.findEntityByName(ACTOR, "满满"), "别名仍可寻址");
    s2.close();
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

test("P0：实体物化 —— structured_facts 写非 user 主体 → life_entities 长出节点", async () => {
  const dir = await mkdtemp(join(tmpdir(), "life-model-"));
  const db = openAgenticSqlite(join(dir, "life.db"));
  const store = new LifeModelStore(db);
  const factStore = new StructuredFactStore(db);
  // 复刻 create-app-services 的观察者接线
  factStore.setEntityObserver((actorId, entity, seenAt, sourceRef) => {
    store.upsertEntity({ actorId, kind: "person", canonicalName: entity, seenAt, confidence: 0.6, sourceRef: sourceRef ?? "structured_fact" });
  });
  try {
    assert.equal(store.listEntities(ACTOR).length, 0, "写入前无实体");
    factStore.applyFact({ actorId: ACTOR, entity: "妈妈", field: "生日", value: "5月1日", sourceRef: "chat:t1" });
    const entities = store.listEntities(ACTOR);
    assert.equal(entities.length, 1, "非 user 主体物化出 1 个实体");
    assert.equal(entities[0]!.canonicalName, "妈妈");
    assert.equal(entities[0]!.kind, "person");
    // user 主体不物化
    factStore.applyFact({ actorId: ACTOR, field: "称呼", value: "张三" });
    assert.equal(store.listEntities(ACTOR).length, 1, "user 主体不物化");
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

// ============================================================
// P1：life.manage 工具（答「我妹妹叫什么」）
// ============================================================

test("P1：life.manage add 记人+建关系边，query 答「我妹妹叫什么」", async () => {
  await withStore(async ({ store }) => {
    const registry = new ToolRegistry();
    registerLifeManageTools(registry, store);
    const ctx = { sessionId: ACTOR };

    const add = await registry.execute("life.manage", { action: "add", name: "小满", relation: "family", subKind: "妹妹", kind: "person" }, ctx);
    assert.equal(add.ok, true);
    assert.equal((add.result.entity as { name: string }).name, "小满");
    assert.equal(add.result.relation, "family");

    const q = await registry.execute("life.manage", { action: "query", name: "小满" }, ctx);
    assert.equal(q.result.found, true);
    assert.equal((q.result.relation as { subKind: string }).subKind, "妹妹");

    // 无名 query：从问句文本命中实体（「我妹妹小满最近怎么样」）
    const q2 = await registry.execute("life.manage", { action: "query", query: "我妹妹小满最近怎么样" }, ctx);
    assert.ok((q2.result.count as number) >= 1, "问句文本命中实体");
  });
});

// ============================================================
// P1：self_agent 边收敛 + lifeModel 召回通道进仲裁
// ============================================================

test("P1：relationship-graph 里程碑 → self_agent 边 + changeLog", async () => {
  await withStore(async ({ store }) => {
    const graph = new RelationshipGraphService({
      async ingest() {
        return null;
      },
      async buildRecall() {
        return { domainId: "relationship", mode: "single_domain" as const, recalledNodeIds: [], confidence: 0.5, text: "" };
      },
    });
    graph.setLifeModelStore(store);

    // 基线段：先以低 warmth 建立基线（默认 0.3 不算「< 0.3」）
    await graph.detectAndRecordMilestone(ACTOR, { warmth: 0.2, rapport: 0.2 });
    // 跳高：warmth 0.2 → 0.62（信任建立，规则化，零 LLM）
    const t1 = await graph.detectAndRecordMilestone(ACTOR, { warmth: 0.62, rapport: 0.4 });
    assert.ok(t1.some((m) => m.type === "trust_established"), "触发信任建立里程碑");

    const edge = store.getSelfAgentEdge(ACTOR);
    assert.ok(edge, "self_agent 边已建立");
    assert.equal(edge!.kind, "self_agent");
    assert.ok(Math.abs(edge!.intimacy - 0.62) < 1e-6, "intimacy ← warmth");
    const log = store.getEdgeChangeLog(ACTOR, edge!.id);
    assert.ok(log.length >= 1, "changeLog 追加轨迹点");
    assert.ok(log.some((p) => p.note === "信任建立"), "轨迹点记里程碑标题");

    // 结构化摘要（旧 text blob 旁路被结构化边取代）
    const summary = await graph.getRelationshipSummary(ACTOR);
    assert.ok(summary.includes("生活模型边"), `摘要走结构化边: ${summary}`);
  });
});

test("P2：关系跳变序列 → changeLog 规则化追加（零 LLM）", async () => {
  await withStore(async ({ store }) => {
    const graph = new RelationshipGraphService({
      async ingest() {
        return null;
      },
      async buildRecall() {
        return { domainId: "relationship", mode: "single_domain" as const, recalledNodeIds: [], confidence: 0.5, text: "" };
      },
    });
    graph.setLifeModelStore(store);

    await graph.detectAndRecordMilestone(ACTOR, { warmth: 0.6, rapport: 0.6 });
    const e1 = store.getSelfAgentEdge(ACTOR)!;
    const baseLen = store.getEdgeChangeLog(ACTOR, e1.id).length;

    // warmth 骤降 > 0.2 → 情感转折
    const t = await graph.detectAndRecordMilestone(ACTOR, { warmth: 0.3, rapport: 0.6 });
    assert.ok(t.some((m) => m.type === "emotional_shift"), "触发情感转折");
    const after = store.getEdgeChangeLog(ACTOR, e1.id);
    assert.equal(after.length, baseLen + 1, "changeLog 追加一个跳变点");
    assert.equal(after[after.length - 1]!.note, "关系降温");
  });
});

test("P1：lifeModel 通道并入仲裁（命中实体作为一条通道参与融合）", async () => {
  await withStore(async ({ store }) => {
    store.upsertEntity({ actorId: ACTOR, kind: "pet", canonicalName: "团子" });
    const item = {
      content: "生活模型：团子（关系：宠物）",
      domain: "semantic" as const,
      source: "life_model",
      importance: "high" as const,
      score: 0.68,
      timestamp: new Date().toISOString(),
    };
    const out = arbitrateMemories([{ channel: "lifeModel", items: [item] }], DEFAULT_ARBITRATOR_CONFIG, { query: "团子最近怎么样" });
    assert.equal(out.length, 1, "lifeModel 通道条目进入仲裁输出");
    assert.ok(out[0]!.source?.includes("lifeModel"));
  });
});

test("P1：【用户关系一览】块命中；敏感实体默认不进块", async () => {
  await withStore(async ({ store }) => {
    store.upsertEntity({ actorId: ACTOR, kind: "person", canonicalName: "小满" });
    const selfId = store.ensureSelfEntity(ACTOR)!;
    const zhang = store.upsertEntity({ actorId: ACTOR, kind: "person", canonicalName: "张伟" })!;
    store.upsertEdge({ actorId: ACTOR, fromEntityId: selfId, toEntityId: zhang.id, kind: "colleague", subKind: "上司", intimacy: 0.3 });
    store.upsertEntity({ actorId: ACTOR, kind: "person", canonicalName: "前女友", sensitivity: "sensitive" });

    const block = store.renderRelationsForPrompt(ACTOR);
    assert.ok(block && block.includes("【用户关系一览】"), "块存在");
    assert.ok(block!.includes("张伟") && block!.includes("上司"), `含关系标签 + 名字: ${block}`);
    assert.ok(!block!.includes("前女友"), "敏感实体默认不进块");
    assert.equal(store.renderRelationsForPrompt("no-such-actor"), null, "无实体不注入（宁缺毋滥）");
  });
});

// ============================================================
// P0：图式 / 经历 落盘（跨重启 hydrate）
// ============================================================

test("P0：SchemaNode 落盘后，新实例 getAllSchemas 仍非空（hydrate）", async () => {
  const dir = await mkdtemp(join(tmpdir(), "life-model-"));
  const path = join(dir, "life.db");
  const schema = {
    id: "schema-1",
    name: "餐厅图式",
    steps: ["进门", "点餐", "结账"],
    preconditions: ["饿"],
    expectedOutcomes: ["吃饱"],
    instances: ["ep-1", "ep-2"],
    stereotypeWarningCount: 0,
    sceneTag: "restaurant",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  try {
    const db1 = openAgenticSqlite(path);
    const store1 = new LifeModelStore(db1);
    const f1 = new MemorySchemaFormation({});
    f1.setPersistence(store1);
    store1.savePattern(ACTOR, schema as never); // 模拟前次落盘
    store1.close();

    const db2 = openAgenticSqlite(path);
    const store2 = new LifeModelStore(db2);
    const f2 = new MemorySchemaFormation({});
    f2.setPersistence(store2);
    const all = f2.getAllSchemas(ACTOR);
    assert.equal(all.length, 1, "重启后图式仍在");
    assert.equal(all[0]!.sceneTag, "restaurant");
    store2.close();
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

test("P0：ExperienceLearning episodes 落盘后，新实例 hydrate 出经历", async () => {
  const dir = await mkdtemp(join(tmpdir(), "life-model-"));
  const path = join(dir, "life.db");
  try {
    const db1 = openAgenticSqlite(path);
    const store1 = new LifeModelStore(db1);
    const l1 = new MemoryExperienceLearningLoop();
    l1.setPersistence(store1);
    const ep = l1.observeMemoryItem(ACTOR, {
      kind: "experience",
      content: "用户点外卖时总选少辣",
      source: "chat",
      timestamp: new Date().toISOString(),
      importance: "high",
      metadata: { outcome: "success" },
    } as never);
    assert.ok(ep, "产生经历");
    assert.equal(l1.getSnapshot(ACTOR).episodes.length, 1);
    store1.close();

    const db2 = openAgenticSqlite(path);
    const store2 = new LifeModelStore(db2);
    const l2 = new MemoryExperienceLearningLoop();
    l2.setPersistence(store2);
    assert.equal(l2.getSnapshot(ACTOR).episodes.length, 1, "重启后经历仍在");
    store2.close();
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

// ============================================================
// P2：隐私三清（实体 + 边 + 事实）
// ============================================================

test("P2：忘掉这个人 —— 实体 + 边 + 名下事实三清", async () => {
  const dir = await mkdtemp(join(tmpdir(), "life-model-"));
  const db = openAgenticSqlite(join(dir, "life.db"));
  const store = new LifeModelStore(db);
  const factStore = new StructuredFactStore(db);
  try {
    const selfId = store.ensureSelfEntity(ACTOR)!;
    const mei = store.upsertEntity({ actorId: ACTOR, kind: "person", canonicalName: "小满" })!;
    store.upsertEdge({ actorId: ACTOR, fromEntityId: selfId, toEntityId: mei.id, kind: "family", subKind: "妹妹" });
    factStore.applyFact({ actorId: ACTOR, entity: "小满", field: "生日", value: "5月1日" });
    assert.equal(factStore.listFactEntities(ACTOR).length, 1);

    const removed = store.deleteEntity(ACTOR, mei.id);
    const factsRemoved = factStore.deleteFactsByEntity(ACTOR, "小满");
    assert.equal(removed.entities, 1, "实体删除");
    assert.equal(removed.edges, 1, "边删除");
    assert.equal(factsRemoved, 1, "名下事实删除");
    assert.equal(store.findEntityByName(ACTOR, "小满"), null, "实体不再可寻址");
    assert.equal(factStore.listFactEntities(ACTOR).length, 0);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

test("P2：purgeActor 级联清空生活模型全部表", async () => {
  await withStore(async ({ store }) => {
    const selfId = store.ensureSelfEntity(ACTOR)!;
    const e = store.upsertEntity({ actorId: ACTOR, kind: "person", canonicalName: "老王" })!;
    store.upsertEdge({ actorId: ACTOR, fromEntityId: selfId, toEntityId: e.id, kind: "friend", subKind: "大学同学" });
    store.saveBeliefs(ACTOR, []);
    const n = store.purgeActor(ACTOR);
    assert.ok(n >= 3, "清理实体+边（含 self）");
    assert.equal(store.stats(ACTOR).entities, 0);
    assert.equal(store.stats(ACTOR).edges, 0);
  });
});
