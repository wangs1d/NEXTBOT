/**
 * 画像 query 相关性召回评测（2026-11-12 按需注入根修）。
 *
 * 核心验收：问「我现在多少岁」这类与画像行**字面零重叠**的自然问句，能通过
 * 语义向量命中「生日」字段——这是意图词表（/多大|年龄|几岁/）做不到的事，
 * 也是「问年龄连带报名字」根修的关键路径。
 *
 * embed 用注入式 fake（确定性向量，不依赖本地 ONNX 引擎）。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  semanticRecallFactFields,
  __resetProfileSemanticRecallForTest,
} from "../src/brain/profile-semantic-recall.js";
import type { StructuredFact } from "../src/agentic-memory/structured-fact-store.js";

function fact(field: string, value: string, category = "identity"): StructuredFact {
  return {
    id: `f-${field}`,
    actorId: "u1",
    entity: "user",
    field,
    value,
    category,
    confidence: 0.9,
    sourceRef: null,
    createdAt: "2026-11-01T00:00:00Z",
    updatedAt: "2026-11-01T00:00:00Z",
    temporal: "current",
    eventTime: null,
    validFrom: null,
    validTo: null,
    observedAt: "2026-11-01T00:00:00Z",
    confirmCount: 1,
    planState: undefined,
  } as unknown as StructuredFact;
}

/**
 * 确定性 fake embedder：语义空间手工设计——
 *   「岁/年龄/多大」类问句与「生日」同族；「住/哪」与「居住地」同族；
 *   名字/称呼与两者都不同族（验收「问年龄不连带称呼」的结构保证）。
 * 同族向量夹角小（余弦高），跨族接近正交（余弦 ~0.3 以下）。
 */
function fakeEmbed(texts: string[]): Promise<number[][] | null> {
  const axes: Record<string, number[]> = {
    age: [1, 0, 0, 0],
    place: [0, 1, 0, 0],
    name: [0, 0, 1, 0],
    job: [0, 0, 0, 1],
  };
  const familyOf = (text: string): number[] => {
    if (/岁|年龄|多大|生日|出生|几年|年龄/.test(text)) return axes.age;
    if (/住|城市|地址|家|居住/.test(text)) return axes.place;
    if (/名|称呼|叫/.test(text)) return axes.name;
    if (/职业|工作|上班|公司/.test(text)) return axes.job;
    return [0.3, 0.3, 0.3, 0.3]; // 无关词 → 各轴低投影
  };
  return Promise.resolve(texts.map((t) => familyOf(t)));
}

const POOL = [
  fact("称呼", "老铁"),
  fact("生日", "1995-03-12"),
  fact("居住地", "贵州兴义"),
  fact("职业", "后端开发", "identity"),
];

test("核心场景：问「我现在多少岁」语义命中生日，不连带称呼", async () => {
  __resetProfileSemanticRecallForTest();
  const hits = await semanticRecallFactFields(POOL, "我现在多少岁", fakeEmbed);
  assert.ok(hits.length > 0, "应至少命中一个字段");
  assert.equal(hits[0].field, "生日", `最相关字段应为生日（实际 ${hits[0].field}）`);
  assert.ok(!hits.some((h) => h.field === "称呼"), "称呼不得连带召回——按需注入的结构保证");
});

test("问「我住哪」命中居住地；问「我叫什么」命中称呼", async () => {
  __resetProfileSemanticRecallForTest();
  const place = await semanticRecallFactFields(POOL, "我现在住在哪来着", fakeEmbed);
  assert.equal(place[0]?.field, "居住地");
  const name = await semanticRecallFactFields(POOL, "你还记得我叫什么吗", fakeEmbed);
  assert.equal(name[0]?.field, "称呼");
});

test("阈值截断：无关 query 零命中（未命中零注入）", async () => {
  __resetProfileSemanticRecallForTest();
  const hits = await semanticRecallFactFields(POOL, "今天天气怎么样", fakeEmbed);
  assert.equal(hits.length, 0, "无关问句不得带出任何画像字段");
});

test("health 敏感类结构性排除（不进语义自动注入）", async () => {
  __resetProfileSemanticRecallForTest();
  const pool = [...POOL, fact("过敏原", "花粉", "health")];
  const hits = await semanticRecallFactFields(pool, "我现在多少岁", fakeEmbed);
  assert.ok(!hits.some((h) => h.field === "过敏原"), "health 类只能用户直提或 profile.query 显式取");
});

test("空 query / 空事实池 / embed 失败：诚实降级为零命中", async () => {
  __resetProfileSemanticRecallForTest();
  assert.deepEqual(await semanticRecallFactFields(POOL, "", fakeEmbed), []);
  assert.deepEqual(await semanticRecallFactFields([], "我现在多少岁", fakeEmbed), []);
  const fail = async () => null;
  assert.deepEqual(await semanticRecallFactFields(POOL, "我现在多少岁", fail), []);
});

test("top-k 截断：命中再多只取最相关的前几个字段", async () => {
  __resetProfileSemanticRecallForTest();
  const wide = [
    fact("生日", "1995-03-12"),
    fact("属相", "猪"),
    fact("星座", "双鱼"),
    fact("居住地", "贵州兴义"),
  ];
  const hits = await semanticRecallFactFields(wide, "我现在多少岁", fakeEmbed, { topK: 2 });
  assert.ok(hits.length <= 2, `top-k 截断生效（实际 ${hits.length}）`);
  assert.equal(hits[0].field, "生日");
});
