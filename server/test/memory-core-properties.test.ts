/**
 * 记忆系统三性质验收测试（2026-10-22 记忆优化方案落地验证）。
 *
 * 目标（唯一目标的三条可测性质）：
 *   1. 该记住的留得住 —— 写入成功即落入长期库；新鲜且高重要度的记忆召回时完整保留；
 *   2. 该忘的退得掉 —— 低遗忘分记忆召回时按梯度截断（褪色而非消失）；
 *      容量治理由遗忘控制器 deletionStage 五级推进承担；
 *   3. 被问起时想得起 —— query 召回命中；同场景经验 ≥3 条形成图式，
 *      后续提问命中图式时返回 schemaHint（记忆建立联系）。
 *
 * 测试风格与 memory-cognitive-integration.test.ts 一致：node:test + node:assert/strict，
 * mock 注入、不依赖真实存储；finalizeRecallItems / attachSchemaHint 为私有方法，
 * 以 (cortex as never) 结构化调用（与 mock 注入风格一致）。
 */
import test from "node:test";
import assert from "node:assert/strict";

import { MemoryCortex } from "../src/brain/memory-cortex.js";
import { MemorySchemaFormation } from "../src/brain/memory-cognitive/memory-schema-formation.js";
import { MemoryForgettingController } from "../src/brain/memory-cognitive/memory-forgetting-controller.js";
import type { MemoryItem, MemoryRecallItem, MemoryRecallResult } from "../src/brain/types.js";

const ACTOR = "user-mem-props-1";

function makeItem(overrides: Partial<MemoryItem> = {}): MemoryItem {
  return {
    actorId: ACTOR,
    kind: "fact",
    content: "测试记忆内容",
    importance: "high",
    source: "chat",
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

function makeRecallItem(overrides: Partial<MemoryRecallItem> = {}): MemoryRecallItem {
  return {
    content: "测试召回条目内容，长度足够参与遗忘梯度计算",
    domain: "semantic",
    ...overrides,
  };
};

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 10));

// ============================================================
// 性质一：该记住的留得住
// ============================================================

test("留得住：写入走通长期链路，召回能取回原文（公共 API 闭环）", async () => {
  const ingested: string[] = [];
  const cortex = new MemoryCortex();
  cortex.registerNarrative({
    ingest: async (_actorId, text) => {
      ingested.push(text);
    },
    buildNarrativeRecall: async () => ingested.join("\n"),
    buildCrossContextRecall: async () => "",
    runSleepConsolidation: async () => [],
  } as never);

  const longText =
    "用户在北京做后端开发，主要技术栈是 Go 和 PostgreSQL，最近在折腾自建的 agent 框架。";
  await cortex.remember(ACTOR, makeItem({ content: longText, importance: "high" }));
  assert.equal(ingested.length, 1, "高信号写入应进入长期记忆链路");

  const recalled = await cortex.recall(ACTOR, "用户的技术栈", { domain: "narrative" });
  assert.ok(recalled.items.length > 0, "写入后应能召回");
  const joined = recalled.items.map((it) => it.content).join("\n");
  assert.ok(joined.includes("Go 和 PostgreSQL"), `召回应含原文关键内容，实际: ${joined}`);
});

test("留得住：新鲜且高重要度的记忆召回时不被遗忘梯度截断", async () => {
  const cortex = new MemoryCortex();
  cortex.registerForgettingController(new MemoryForgettingController());
  const fresh = makeRecallItem({
    content: "这是一条新鲜的高重要度记忆，内容很长很长很长很长很长很长很长很长很长很长很长很长，应完整保留不被截断。",
    importance: "high",
    timestamp: new Date().toISOString(),
  });
  const items = await (cortex as never as {
    finalizeRecallItems(a: string, q: string, items: MemoryRecallItem[]): Promise<MemoryRecallItem[]>;
  }).finalizeRecallItems(ACTOR, "查询", [fresh]);
  assert.equal(items.length, 1);
  assert.equal(items[0]!.content, fresh.content, "新鲜高重要度记忆应原样保留");
  assert.ok(!items[0]!.content.endsWith("…"), "不应出现截断标记");
});

// ============================================================
// 性质二：该忘的退得掉
// ============================================================

test("退得掉：7 天前的低重要度记忆召回时按梯度截断（褪色而非消失）", async () => {
  const cortex = new MemoryCortex();
  cortex.registerForgettingController(new MemoryForgettingController());
  const body = "一".repeat(200);
  const stale = makeRecallItem({
    content: body,
    importance: "low",
    // 8 天前：recency = 2^(-192/72) ≈ 0.157 → score = 0.5*0.157 + 0.5*0.2 ≈ 0.18 → 保留 50%
    timestamp: new Date(Date.now() - 8 * 24 * 3600 * 1000).toISOString(),
  });
  const items = await (cortex as never as {
    finalizeRecallItems(a: string, q: string, items: MemoryRecallItem[]): Promise<MemoryRecallItem[]>;
  }).finalizeRecallItems(ACTOR, "查询", [stale]);
  assert.equal(items.length, 1, "褪色记忆仍被召回（不是直接消失）");
  assert.ok(items[0]!.content.endsWith("…"), `低分记忆应被梯度截断，实际尾部: ${items[0]!.content.slice(-6)}`);
  assert.ok(items[0]!.content.length < body.length, "截断后应短于原文");
  assert.ok(items[0]!.content.length >= 100, "50% 档应保留约一半内容");
});

test("退得掉：compactRecallText 三档梯度边界正确（80%/50%/20%）", () => {
  const ctrl = new MemoryForgettingController();
  const text = "0123456789";
  assert.equal(ctrl.compactRecallText(text, 0.5), text, "score=0.5 原样返回");
  assert.equal(ctrl.compactRecallText(text, 0.4), "01234567…", "0.3≤score<0.5 保留 80%");
  assert.equal(ctrl.compactRecallText(text, 0.2), "01234…", "0.1≤score<0.3 保留 50%");
  assert.equal(ctrl.compactRecallText(text, 0.05), "01…", "score<0.1 保留 20%");
});

test("退得掉：遗忘控制器对长期不用的低分记忆推进 deletionStage（容量退场）", async () => {
  const progressed: Array<{ nodeId: string; stage: string }> = [];
  const mockHuman = {
    getAllNodes: () => [
      {
        id: "node-stale",
        frequencyScore: 0,
        recencyScore: 0,
        importance: 0.1,
        userFeedbackScore: 0,
        accessCount: 0,
        deletionStage: "active" as const,
        lastAccessedAt: new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString(),
      },
    ],
    updateDeletionStage: (_actorId: string, nodeId: string, stage: string) => {
      progressed.push({ nodeId, stage });
    },
    reawakenNode: () => {},
    pruneNodeEdges: () => {},
  };
  const ctrl = new MemoryForgettingController();
  ctrl.registerHumanLikeMemory(mockHuman as never);
  await ctrl.continuousScore(ACTOR);
  assert.ok(
    progressed.some((p) => p.nodeId === "node-stale" && p.stage !== "active"),
    `四因子全零的节点应推进遗忘阶段，实际: ${JSON.stringify(progressed)}`,
  );
});

// ============================================================
// 性质三：被问起时想得起
// ============================================================

function makeSceneHumanLike() {
  const nodes = [
    {
      id: "n1",
      summary: "进门→点餐→吃饭→结账",
      keywords: ["餐厅"],
      sceneTags: ["餐厅"],
      entityTags: ["座位"],
      emotionTags: ["满意"],
      metadata: { outcomes: ["吃饱"] },
    },
    {
      id: "n2",
      summary: "进门→点餐→结账",
      keywords: ["餐厅"],
      sceneTags: ["餐厅"],
      entityTags: ["菜单"],
      emotionTags: ["满意"],
      metadata: { outcomes: ["吃饱"] },
    },
    {
      id: "n3",
      summary: "进门→点餐→买单",
      keywords: ["餐厅"],
      sceneTags: ["餐厅"],
      entityTags: ["座位"],
      emotionTags: ["满意"],
      metadata: { outcomes: ["吃饱"] },
    },
  ];
  return {
    nodes,
    getNodesBySceneTag: (_actorId: string, sceneTag: string) =>
      nodes.filter((n) => n.sceneTags.includes(sceneTag)),
  };
}

test("想得起：同场景 3 条经验形成图式（公共步骤抽取）", async () => {
  const formation = new MemorySchemaFormation({ humanLike: makeSceneHumanLike() as never });
  const schema = await formation.extractSchema(ACTOR, "餐厅");
  assert.ok(schema, "3 条同场景经验应抽出图式");
  for (const step of ["进门", "点餐"]) {
    assert.ok(
      schema!.steps.includes(step),
      `图式应包含公共步骤「${step}」，实际: ${JSON.stringify(schema!.steps)}`,
    );
  }
  assert.equal(schema!.sceneTag, "餐厅");
});

test("想得起：query 命中图式时召回结果附带 schemaHint（记忆建立联系）", async () => {
  const formation = new MemorySchemaFormation({ humanLike: makeSceneHumanLike() as never });
  await formation.extractSchema(ACTOR, "餐厅");

  const cortex = new MemoryCortex();
  cortex.registerSchemaFormation(formation);
  const base: MemoryRecallResult = {
    actorId: ACTOR,
    query: "带爸妈去餐厅吃饭一般是什么流程",
    items: [],
    domain: "semantic",
    mode: "single_domain",
    recalledAt: new Date().toISOString(),
  };
  const hinted = (cortex as never as {
    attachSchemaHint(a: string, q: string, r: MemoryRecallResult): MemoryRecallResult;
  }).attachSchemaHint(ACTOR, base.query, base);
  assert.ok(hinted.schemaHint, "命中图式时应返回 schemaHint");
  assert.ok(hinted.schemaHint!.steps.includes("点餐"), "hint 应含图式步骤");
  assert.equal(hinted.schemaHint!.hasStereotypeWarning, false, "无刻板印象记录时不告警");

  // 刻板印象追踪：套用失败 4 次后，hint 应透出警告
  formation.recordStereotypeFailure((await formation.getAllSchemas(ACTOR))[0]!.id);
  formation.recordStereotypeFailure((await formation.getAllSchemas(ACTOR))[0]!.id);
  formation.recordStereotypeFailure((await formation.getAllSchemas(ACTOR))[0]!.id);
  formation.recordStereotypeFailure((await formation.getAllSchemas(ACTOR))[0]!.id);
  const warned = (cortex as never as {
    attachSchemaHint(a: string, q: string, r: MemoryRecallResult): MemoryRecallResult;
  }).attachSchemaHint(ACTOR, base.query, { ...base, schemaHint: undefined });
  assert.equal(warned.schemaHint!.hasStereotypeWarning, true, "刻板印象超阈值应告警");
});

test("想得起：写入联动——第 3 条同场景记忆落库后图式自动形成", async () => {
  // 预置 2 条餐厅经验（模拟已入图的历史），第 3 条经 remember 写入后达标
  const humanLike = makeSceneHumanLike();
  humanLike.nodes.length = 2;
  const formation = new MemorySchemaFormation({ humanLike: humanLike as never });

  const cortex = new MemoryCortex();
  cortex.registerSchemaFormation(formation);
  cortex.registerAgentic({
    ingest: {
      // 模拟真实链路：写入长期库的同时进入 humanLike 记忆图（带 sceneTag）
      ingestText: async (_actorId, _sourceId, text) => {
        humanLike.nodes.push({
          id: `n-written-${humanLike.nodes.length + 1}`,
          summary: text,
          keywords: ["餐厅"],
          sceneTags: ["餐厅"],
          entityTags: [],
          emotionTags: [],
          metadata: {},
        });
      },
    },
    retrieval: {
      buildRecall: async () => "",
      buildCrossContextRecall: async () => "",
      searchStructured: async () => [],
    },
  } as never);

  // 第 3 条同场景经验写入（metadata.sceneTags 为图式抽取取数口）
  await cortex.remember(
    ACTOR,
    makeItem({
      content: "周六全家去餐厅给妈妈过生日，进门→点餐→吃饭→结账",
      importance: "medium",
      metadata: { sceneTags: ["餐厅"] },
    }),
  );
  await flush();

  const schemas = formation.getAllSchemas(ACTOR);
  assert.ok(schemas.length > 0, "达标写入后应自动形成图式");
  assert.equal(schemas[0]!.sceneTag, "餐厅");

  // 且后续提问能想起
  const hinted = (cortex as never as {
    attachSchemaHint(a: string, q: string, r: MemoryRecallResult): MemoryRecallResult;
  }).attachSchemaHint(ACTOR, "下次去餐厅吃饭", {
    actorId: ACTOR,
    query: "下次去餐厅吃饭",
    items: [],
    domain: "semantic",
    mode: "single_domain",
    recalledAt: new Date().toISOString(),
  });
  assert.ok(hinted.schemaHint, "写入后问起应命中图式提示");
});
