/**
 * 事实时态与置信度闸（2026-10-19 时间锚定）。
 *
 * 背景：此前结构化事实只有 created_at / updated_at（登记时间），没有
 * 「事情发生在什么时候」的维度，于是「我以前住浙江」和「我现在住兴义」
 * 在存储里是同一种东西——谁最后被说出来谁赢。用户谈过去时会直接把现状改错。
 *
 * 本文件锁死四条契约：
 *   1. 历史陈述（temporal=past）只登记，永不覆盖现状；
 *   2. 同字段可同时存在 current 与 past，渲染时合并进「此前」，现状单独一行；
 *   3. 低置信值不得推翻已确认（≥0.8）的现状；
 *   4. 老库（无 temporal/event_time/observed_at 列）可原地迁移，历史行不丢。
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { StructuredFactStore } from "../src/agentic-memory/structured-fact-store.js";
import { openAgenticSqlite } from "../src/agentic-memory/sqlite-store.js";
import { normalize, parseJsonObject } from "../src/agentic-memory/unified-extractor.js";

async function withStore(fn: (store: StructuredFactStore) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "structured-facts-temporal-"));
  const store = new StructuredFactStore(openAgenticSqlite(join(dir, "facts.db")));
  try {
    await fn(store);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
}

test("历史陈述不覆盖现状：先住兴义，再说'我以前住浙江'，现状仍是兴义", async () => {
  await withStore(async (store) => {
    store.applyFact({ actorId: "u1", field: "居住地", value: "兴义", confidence: 0.9 });

    const past = store.applyFact({
      actorId: "u1",
      field: "居住地",
      value: "浙江",
      temporal: "past",
      eventTime: "2019-2023",
      confidence: 0.9,
    });

    assert.equal(past?.changed, false);
    assert.equal(past?.ignored, "past");

    // 现状未被污染
    assert.equal(store.getFact("u1", "居住地")?.value, "兴义");
    // 历史陈述单独可查
    const pastFacts = store.getPastFacts("u1", "居住地");
    assert.equal(pastFacts.length, 1);
    assert.equal(pastFacts[0]!.value, "浙江");
    assert.equal(pastFacts[0]!.eventTime, "2019-2023");
    assert.equal(pastFacts[0]!.temporal, "past");
  });
});

test("真搬家仍按 latest-wins 覆盖（过去时态闸不挡住正常更新）", async () => {
  await withStore(async (store) => {
    store.applyFact({ actorId: "u1", field: "居住地", value: "浙江", confidence: 0.9 });
    const moved = store.applyFact({
      actorId: "u1",
      field: "居住地",
      value: "兴义",
      confidence: 0.9,
    });

    assert.equal(moved?.changed, true);
    assert.equal(moved?.previous[0]?.value, "浙江");
    assert.equal(store.getFact("u1", "居住地")?.value, "兴义");
    // 旧值进 superseded 链，仍可追溯
    assert.equal(store.getHistoryFor("u1", moved!.fact.id, 1)[0]?.value, "浙江");
  });
});

test("渲染：现状一行 + 「此前」合并 superseded 与历史陈述，两件事不混淆", async () => {
  await withStore(async (store) => {
    store.applyFact({ actorId: "u1", field: "居住地", value: "杭州", confidence: 0.9 });
    store.applyFact({ actorId: "u1", field: "居住地", value: "上海", confidence: 0.9 });
    store.applyFact({
      actorId: "u1",
      field: "居住地",
      value: "浙江",
      temporal: "past",
      eventTime: "2018",
      confidence: 0.9,
    });

    const block = store.renderForPrompt("u1");
    assert.ok(block);
    assert.ok(block!.includes("- 居住地：上海"));
    assert.ok(block!.includes("（此前：杭州"));
    assert.ok(block!.includes("浙江，2018"));
    // 现状行不能被历史值顶替
    assert.ok(!block!.includes("- 居住地：浙江"));
    // 三类时间语义写进块头，模型有据可依
    assert.ok(block!.includes("「记录」是这条信息的登记时间"));
    assert.ok(block!.includes("「事发」是事情本身发生的时间"));
  });
});

test("只有历史陈述的字段：不冒充现状，标〔历史〕并注明当前未知", async () => {
  await withStore(async (store) => {
    store.applyFact({
      actorId: "u1",
      field: "居住地",
      value: "浙江",
      temporal: "past",
      eventTime: "2019",
    });

    assert.equal(store.getFact("u1", "居住地"), null);
    const block = store.renderForPrompt("u1");
    assert.ok(block);
    assert.ok(block!.includes("〔历史〕浙江"));
    assert.ok(block!.includes("当前未知"));
  });
});

test("置信度闸：低置信新值不推翻已确认的现状", async () => {
  await withStore(async (store) => {
    store.applyFact({ actorId: "u1", field: "职业", value: "全栈开发", confidence: 0.95 });
    const weak = store.applyFact({
      actorId: "u1",
      field: "职业",
      value: "产品经理",
      confidence: 0.45,
    });

    assert.equal(weak?.changed, false);
    assert.equal(weak?.ignored, "low_confidence");
    assert.equal(store.getFact("u1", "职业")?.value, "全栈开发");

    // 同量级的更正仍然生效（闸只挡"明显更弱"，不挡正常改口）
    const strong = store.applyFact({
      actorId: "u1",
      field: "职业",
      value: "产品经理",
      confidence: 0.85,
    });
    assert.equal(strong?.changed, true);
    assert.equal(store.getFact("u1", "职业")?.value, "产品经理");
  });
});

test("观察时间：observedAt 可注入，事件时间与登记时间分开存", async () => {
  await withStore(async (store) => {
    const observed = "2026-03-02T10:00:00.000Z";
    const applied = store.applyFact({
      actorId: "u1",
      field: "公司",
      value: "某厂",
      temporal: "past",
      eventTime: "2021-2024",
      observedAt: observed,
      confidence: 0.9,
    });

    assert.equal(applied?.fact.observedAt, observed);
    assert.equal(applied?.fact.eventTime, "2021-2024");
  });
});

test("老库迁移：无 temporal/event_time/observed_at 列的存量库可原地升级", async () => {
  const dir = await mkdtemp(join(tmpdir(), "structured-facts-migrate-"));
  const dbPath = join(dir, "legacy.db");
  try {
    // 造一个"老版本"表结构（只有最初六列 + status/superseded_*）
    const legacy = openAgenticSqlite(dbPath);
    legacy.exec(`
      CREATE TABLE structured_facts (
        id TEXT PRIMARY KEY,
        actor_id TEXT NOT NULL,
        entity TEXT NOT NULL DEFAULT 'user',
        field TEXT NOT NULL,
        value TEXT NOT NULL,
        confidence REAL,
        source_ref TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        superseded_at TEXT,
        superseded_by TEXT
      );
      INSERT INTO structured_facts (id, actor_id, entity, field, value, status, created_at, updated_at)
      VALUES ('legacy-1', 'u1', 'user', '居住地', '杭州', 'active',
              '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    `);
    legacy.close();

    const store = new StructuredFactStore(openAgenticSqlite(dbPath));
    try {
      const fact = store.getFact("u1", "居住地");
      assert.equal(fact?.value, "杭州");
      assert.equal(fact?.temporal, "current"); // 老数据默认按现状
      assert.equal(fact?.eventTime, null);
      assert.equal(fact?.observedAt, "2026-01-01T00:00:00.000Z"); // 回填 = created_at
    } finally {
      store.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

test("抽取协议：temporal/eventTime 解析，缺失按现状，脏值不误判历史", () => {
  const parsed = normalize(
    parseJsonObject(
      JSON.stringify({
        decision: "remember",
        memories: ["用户提到自己以前住浙江，现在搬来兴义"],
        facts: [
          { field: "居住地", value: "浙江", temporal: "past", eventTime: "2019-2023", confidence: 0.9 },
          { field: "居住地", value: "兴义", confidence: 0.9 },
          { field: "职业", value: "后端开发", temporal: "PAST", eventTime: "null", confidence: 0.8 },
          { field: "技术栈", value: "TS/Python", temporal: "whatever", confidence: 0.7 },
        ],
      }),
    )!,
  )!;

  assert.equal(parsed.facts[0]!.temporal, "past");
  assert.equal(parsed.facts[0]!.eventTime, "2019-2023");
  assert.equal(parsed.facts[1]!.temporal, "current"); // 缺省现状
  assert.equal(parsed.facts[2]!.temporal, "past"); // 大小写归一
  assert.equal(parsed.facts[2]!.eventTime, undefined); // "null" 字面值不当时间
  assert.equal(parsed.facts[3]!.temporal, "current"); // 非法值按现状，不误判历史
});
