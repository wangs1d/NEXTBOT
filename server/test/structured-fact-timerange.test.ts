/**
 * 结构化有效区间与 as-of 查询（2026-10-19）。
 *
 * 背景：event_time 之前是自由文本（"2019-2023"），存得下但比不了、过滤不了，
 * 于是「2024 年 6 月他住哪」这种点位查询做不了。现在拆成 valid_from/valid_to
 * 两个可比较的日期列，并提供两种语义的 as-of 查询：
 *   - getFactsAsOf      = valid time，"那时他世界里是什么"
 *   - getKnownFactsAsOf = knowledge time，"那时系统以为是什么"
 * 两者不等价：用户 2024 年才说"我 2019 年住杭州"，问 2021 年的 valid time
 * 应该是杭州，但问 2021 年的 knowledge time 应该是"不知道"。
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  StructuredFactStore,
  inferValidRange,
  normalizeValidPoint,
} from "../src/agentic-memory/structured-fact-store.js";
import { openAgenticSqlite } from "../src/agentic-memory/sqlite-store.js";

async function withStore(fn: (store: StructuredFactStore) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "structured-facts-range-"));
  const store = new StructuredFactStore(openAgenticSqlite(join(dir, "facts.db")));
  try {
    await fn(store);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
}

test("normalizeValidPoint：粒度决定首末日，字符串比较即时间比较", () => {
  assert.equal(normalizeValidPoint("2023", "start"), "2023-01-01");
  assert.equal(normalizeValidPoint("2023", "end"), "2023-12-31");
  assert.equal(normalizeValidPoint("2023-06", "start"), "2023-06-01");
  assert.equal(normalizeValidPoint("2023-06", "end"), "2023-06-30");
  assert.equal(normalizeValidPoint("2023年6月", "start"), "2023-06-01");
  assert.equal(normalizeValidPoint("2024-02", "end"), "2024-02-29"); // 闰年
  assert.equal(normalizeValidPoint("2023-02", "end"), "2023-02-28");
  assert.equal(normalizeValidPoint("大学毕业前", "start"), null);
  assert.equal(normalizeValidPoint("", "start"), null);
});

test("inferValidRange：区间/单点/至今 三种形态，含糊表达不瞎猜", () => {
  assert.deepEqual(inferValidRange("2019-2023"), { from: "2019-01-01", to: "2023-12-31" });
  assert.deepEqual(inferValidRange("2019年到2023年"), { from: "2019-01-01", to: "2023-12-31" });
  assert.deepEqual(inferValidRange("2023年6月"), { from: "2023-06-01", to: "2023-06-30" });
  assert.deepEqual(inferValidRange("2023年5月至今"), { from: "2023-05-01", to: null });
  assert.equal(inferValidRange("大学毕业前"), null);
  assert.equal(inferValidRange("很久以前"), null);
});

test("applyFact：eventTime 自动解析成区间，显式 validFrom 优先", async () => {
  await withStore(async (store) => {
    store.applyFact({
      actorId: "u1",
      field: "居住地",
      value: "杭州",
      temporal: "past",
      eventTime: "2019-2023",
    });
    const [hz] = store.getPastFacts("u1", "居住地");
    assert.equal(hz?.validFrom, "2019-01-01");
    assert.equal(hz?.validTo, "2023-12-31");

    store.applyFact({
      actorId: "u1",
      field: "职业",
      value: "后端开发",
      temporal: "past",
      eventTime: "2019-2023",
      validFrom: "2020-07",
    });
    const [job] = store.getPastFacts("u1", "职业");
    assert.equal(job?.validFrom, "2020-07-01"); // 显式值优先
    assert.equal(job?.validTo, "2023-12-31");
  });
});

test("getFactsAsOf：'2024 年 6 月他住哪' 这类点位查询", async () => {
  await withStore(async (store) => {
    store.applyFact({
      actorId: "u1",
      field: "居住地",
      value: "杭州",
      temporal: "past",
      eventTime: "2019-2023",
    });
    store.applyFact({
      actorId: "u1",
      field: "居住地",
      value: "兴义",
      temporal: "current",
      validFrom: "2024-01-01",
      confidence: 0.9,
    });

    assert.equal(store.getFactsAsOf("u1", "2021-06-15")[0]?.value, "杭州");
    assert.equal(store.getFactsAsOf("u1", "2023-12-31")[0]?.value, "杭州");
    assert.equal(store.getFactsAsOf("u1", "2024-06-15")[0]?.value, "兴义");
    assert.equal(store.getFactsAsOf("u1", "2026-10-19")[0]?.value, "兴义");
    // 早于任何记录 → 没有结论（不猜）
    assert.equal(store.getFactsAsOf("u1", "2010-01-01").length, 0);
  });
});

test("被覆盖时自动补区间终点：换值那天就是旧值的 valid_to", async () => {
  await withStore(async (store) => {
    store.applyFact({
      actorId: "u1",
      field: "居住地",
      value: "杭州",
      observedAt: "2021-01-01T00:00:00.000Z",
      confidence: 0.9,
    });
    store.applyFact({
      actorId: "u1",
      field: "居住地",
      value: "兴义",
      observedAt: "2024-03-01T00:00:00.000Z",
      confidence: 0.9,
    });

    assert.equal(store.getFactsAsOf("u1", "2023-06-01")[0]?.value, "杭州");
    assert.equal(store.getFactsAsOf("u1", "2024-06-01")[0]?.value, "兴义");
  });
});

test("getKnownFactsAsOf：2019 年的事 2024 年才说，2021 年系统应该'不知道'", async () => {
  await withStore(async (store) => {
    // 用户 2024-03-01 才告诉系统"我 2019-2023 住杭州"
    store.applyFact({
      actorId: "u1",
      field: "居住地",
      value: "杭州",
      temporal: "past",
      eventTime: "2019-2023",
      observedAt: "2024-03-01T00:00:00.000Z",
    });
    store.applyFact({
      actorId: "u1",
      field: "居住地",
      value: "兴义",
      temporal: "current",
      validFrom: "2024-01-01",
      observedAt: "2024-03-01T00:00:00.000Z",
      confidence: 0.9,
    });

    // valid time：2021 年他确实住杭州
    assert.equal(store.getFactsAsOf("u1", "2021-06-01")[0]?.value, "杭州");
    // knowledge time：2021 年系统还什么都不知道
    assert.equal(store.getKnownFactsAsOf("u1", "2021-06-01").length, 0);
    // 2024 年之后系统知道了
    assert.equal(store.getKnownFactsAsOf("u1", "2024-06-01")[0]?.value, "兴义");
  });
});

test("存量库迁移：event_time 能解析的回填区间，解析不了的留空", async () => {
  const dir = await mkdtemp(join(tmpdir(), "structured-facts-range-migrate-"));
  const dbPath = join(dir, "legacy.db");
  try {
    const legacy = openAgenticSqlite(dbPath);
    legacy.exec(`
      CREATE TABLE structured_facts (
        id TEXT PRIMARY KEY, actor_id TEXT NOT NULL, entity TEXT NOT NULL DEFAULT 'user',
        field TEXT NOT NULL, value TEXT NOT NULL, confidence REAL, source_ref TEXT,
        status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        superseded_at TEXT, superseded_by TEXT, temporal TEXT NOT NULL DEFAULT 'current',
        event_time TEXT, observed_at TEXT
      );
      INSERT INTO structured_facts (id, actor_id, entity, field, value, status, created_at, updated_at, temporal, event_time, observed_at)
      VALUES ('a', 'u1', 'user', '居住地', '杭州', 'historical',
              '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 'past', '2019-2023', '2026-01-01T00:00:00.000Z');
      INSERT INTO structured_facts (id, actor_id, entity, field, value, status, created_at, updated_at, temporal, event_time, observed_at)
      VALUES ('b', 'u1', 'user', '学历', '本科', 'historical',
              '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 'past', '大学毕业前', '2026-01-01T00:00:00.000Z');
    `);
    legacy.close();

    const store = new StructuredFactStore(openAgenticSqlite(dbPath));
    try {
      const [hz] = store.getPastFacts("u1", "居住地");
      assert.equal(hz?.validFrom, "2019-01-01");
      assert.equal(hz?.validTo, "2023-12-31");
      const [edu] = store.getPastFacts("u1", "学历");
      assert.equal(edu?.validFrom, null, "解析不了就留空，不编日期");
    } finally {
      store.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});
