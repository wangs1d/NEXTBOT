/**
 * 记忆时间意图（2026-10-19 P1）：检索不再"时间盲"。
 *
 * 三条契约：
 *   ① 解析：去年/上个月/2024年6月/2021-2023/以前 都要变成可比区间；
 *   ② 加权：区间内 ×1.2、区间外 ×0.85，软调制不硬过滤；
 *   ③ 定位：时间问句命中档案字段时，直接给"那个时间点有效的值"。
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildTemporalFactAddressing,
  extractTemporalIntent,
  temporalIntentFactor,
} from "../src/agent/memory-temporal-intent.js";
import { StructuredFactStore } from "../src/agentic-memory/structured-fact-store.js";
import { openAgenticSqlite } from "../src/agentic-memory/sqlite-store.js";

const NOW = new Date(2026, 9, 19, 12, 0, 0); // 2026-10-19

test("时间词解析：绝对/相对/区间/开放过去", () => {
  const m = extractTemporalIntent("2024年6月我住哪", NOW);
  assert.equal(m?.kind, "month");
  assert.equal(m?.from, "2024-06-01");
  assert.equal(m?.to, "2024-06-30");
  assert.equal(extractTemporalIntent("2021-2023 那几年", NOW)?.from, "2021-01-01");
  assert.equal(extractTemporalIntent("2021-2023 那几年", NOW)?.to, "2023-12-31");
  assert.equal(extractTemporalIntent("去年我在哪", NOW)?.from, "2025-01-01");
  assert.equal(extractTemporalIntent("上个月的事", NOW)?.from, "2026-09-01");
  assert.equal(extractTemporalIntent("上个月的事", NOW)?.to, "2026-09-30");
  assert.equal(extractTemporalIntent("前几天说过", NOW)?.kind, "recent");
  const open = extractTemporalIntent("我以前住哪", NOW);
  assert.equal(open?.kind, "past_open");
  assert.equal(open?.from, null);
  // 没有时间词 → 不介入
  assert.equal(extractTemporalIntent("我住在哪", NOW), null);
});

test("区间外的说法不误判：'今年' 就是今年", () => {
  const y = extractTemporalIntent("今年换的工作", NOW);
  assert.equal(y?.from, "2026-01-01");
  assert.equal(y?.to, "2026-12-31");
});

test("检索加权：区间内加分、区间外降权、无意图不介入", () => {
  const intent = extractTemporalIntent("2024年6月", NOW);
  assert.equal(temporalIntentFactor(intent, "2024-06-15T00:00:00Z", NOW), 1.2);
  assert.equal(temporalIntentFactor(intent, "2026-10-01T00:00:00Z", NOW), 0.85);
  assert.equal(temporalIntentFactor(null, "2024-06-15T00:00:00Z", NOW), 1);
  // 时间戳缺失不惩罚
  assert.equal(temporalIntentFactor(intent, undefined, NOW), 1);
  // 开放过去：早于今年加分
  const open = extractTemporalIntent("我以前住哪", NOW);
  assert.equal(temporalIntentFactor(open, "2020-01-01T00:00:00Z", NOW), 1.1);
  assert.equal(temporalIntentFactor(open, "2026-10-01T00:00:00Z", NOW), 0.95);
});

test("时间问句定位：'2024年6月我住哪' 给出当时有效的值", async () => {
  const dir = await mkdtemp(join(tmpdir(), "temporal-intent-"));
  const store = new StructuredFactStore(openAgenticSqlite(join(dir, "facts.db")));
  try {
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
      validFrom: "2024-01-01",
      confidence: 0.9,
    });

    const block = buildTemporalFactAddressing(store, "u1", "2024年6月我住哪", NOW);
    assert.ok(block);
    assert.ok(block!.includes("居住地：兴义"));
    assert.ok(block!.includes("2024年6月"));

    const older = buildTemporalFactAddressing(store, "u1", "2021年我住哪", NOW);
    assert.ok(older!.includes("居住地：杭州"));
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

test("时间问句定位：没有记录时如实说没有，不拿现在冒充当时", async () => {
  const dir = await mkdtemp(join(tmpdir(), "temporal-intent-empty-"));
  const store = new StructuredFactStore(openAgenticSqlite(join(dir, "facts.db")));
  try {
    store.applyFact({ actorId: "u1", field: "居住地", value: "兴义", validFrom: "2024-01-01" });
    const block = buildTemporalFactAddressing(store, "u1", "2015年我住哪", NOW);
    assert.ok(block);
    assert.ok(block!.includes("没有记录"));
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

test("没有时间词时不生成定位块（不做无根据的 as-of 查询）", async () => {
  const dir = await mkdtemp(join(tmpdir(), "temporal-intent-none-"));
  const store = new StructuredFactStore(openAgenticSqlite(join(dir, "facts.db")));
  try {
    store.applyFact({ actorId: "u1", field: "居住地", value: "兴义" });
    assert.equal(buildTemporalFactAddressing(store, "u1", "我住哪", NOW), undefined);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});
