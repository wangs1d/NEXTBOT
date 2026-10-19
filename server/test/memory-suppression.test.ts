/**
 * 软抑制「别再提这个」（2026-10-19 P2）。
 *
 * 与"忘掉"的区别必须锁死：软抑制**不删数据**，只在注入/召回时标注，
 * 用户问起仍能回答；忘掉是把事实下线。
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { MemorySuppressionStore } from "../src/agentic-memory/memory-suppression.js";
import { StructuredFactStore } from "../src/agentic-memory/structured-fact-store.js";
import { openAgenticSqlite } from "../src/agentic-memory/sqlite-store.js";

test("软抑制：字段幂等写入、可查可解、按类型分开", async () => {
  const dir = await mkdtemp(join(tmpdir(), "memory-suppression-"));
  const store = new MemorySuppressionStore(openAgenticSqlite(join(dir, "m.db")));
  try {
    store.add("u1", "field", "体检", "用户不想被主动关心");
    store.add("u1", "field", "体检", "重复写入覆盖 reason");
    store.add("u1", "text", "体检报告");

    assert.equal(store.list("u1").length, 2, "同 kind+key 幂等，不重复");
    assert.deepEqual([...store.suppressedFields("u1")], ["体检"]);
    assert.deepEqual(store.textKeys("u1"), ["体检报告"]);

    assert.equal(store.remove("u1", "field", "体检"), true);
    assert.deepEqual([...store.suppressedFields("u1")], []);
    assert.equal(store.remove("u1", "field", "不存在"), false);

    store.add("u1", "text", "旧事");
    // 此时剩两条 text 抑制（体检报告 + 旧事），字段那条已被 remove
    assert.equal(store.purgeActor("u1"), 2);
    assert.equal(store.list("u1").length, 0);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

test("软抑制只加标注不删内容：档案照常注入，但写「别再主动提」", async () => {
  const dir = await mkdtemp(join(tmpdir(), "memory-suppression-render-"));
  const facts = new StructuredFactStore(openAgenticSqlite(join(dir, "facts.db")));
  try {
    facts.applyFact({ actorId: "u1", field: "体检", value: "甲状腺结节随访", confidence: 0.9 });

    const before = facts.renderForPrompt("u1");
    assert.ok(before!.includes("甲状腺结节随访"));
    assert.ok(!before!.includes("别再主动提"));

    const after = facts.renderForPrompt("u1", undefined, "user", {
      suppressedFields: new Set(["体检"]),
    });
    assert.ok(after!.includes("甲状腺结节随访"), "内容不能被移除");
    assert.ok(after!.includes("别再主动提"));
    assert.ok(after!.includes("问起时才回答"));
  } finally {
    facts.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});
