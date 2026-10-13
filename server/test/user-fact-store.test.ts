/**
 * 用户事实主库（UserFactStore）测试：
 * - subject 归一与 latest-wins 冲突替换（同身份新旧值互替、不同 subject 共存）；
 * - provenance（sources / seenCount / confidence）；
 * - per-actor JSON 持久化（跨实例读取）；
 * - 派生视图同步：事实行替换 KV 槽位中同 subject 的旧行，未冲突的近期捕获行保留。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AgentMemorySyncService } from "../src/services/agent-memory-sync-service.js";
import {
  UserFactStore,
  extractFactSubject,
} from "../src/services/user-fact-store.js";

async function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "user-fact-store-"));
}

/** 清理前先等待事实库写盘链排空，避免 Windows 上 rm 与 rename 竞态（ENOTEMPTY）。 */
async function cleanup(
  dir: string,
  store: UserFactStore | null,
  actorId?: string,
  extraWaitMs = 0,
): Promise<void> {
  if (store && actorId) await store.flush(actorId).catch(() => {});
  if (extraWaitMs > 0) await new Promise((resolve) => setTimeout(resolve, extraWaitMs));
  await rm(dir, { recursive: true, force: true }).catch(() => {});
}

test("extractFactSubject: 偏好取宾语、身份归类、居住地/项目归类", () => {
  assert.equal(extractFactSubject("preference", "我喜欢简洁的回答"), "简洁的回答");
  assert.equal(extractFactSubject("preference", "习惯用深色主题"), "用深色主题");
  assert.equal(extractFactSubject("fact", "我是前端工程师"), "身份");
  assert.equal(extractFactSubject("fact", "我住在杭州"), "居住地");
  assert.equal(extractFactSubject("fact", "我在做一个 Flutter 项目"), "项目");
  assert.equal(extractFactSubject("identity", "我是产品经理"), "身份");
});

test("upsertFact: 同 subject 新值替换旧值并累积 seenCount/sources", async () => {
  const dir = await makeTempDir();
  const store = new UserFactStore(dir);
  const actorId = "actor-replace";
  try {
    const first = await store.upsertFact(actorId, {
      kind: "identity",
      value: "我是设计师",
      source: "nightly-extract",
    });
    assert.ok(first);
    assert.equal(first.subject, "身份");

    const second = await store.upsertFact(actorId, {
      kind: "identity",
      value: "我是前端工程师",
      source: "kv-slot",
      confidence: 0.9,
    });
    assert.ok(second);
    assert.equal(second.id, first.id, "同 subject 应命中同一条事实");
    assert.equal(second.value, "我是前端工程师", "新值应替换旧值（值原样入库，规范格式由抽取侧保证）");
    assert.equal(second.seenCount, 2);
    assert.equal(second.confidence, 0.9);
    assert.deepEqual(second.sources, ["nightly-extract", "kv-slot"]);

    const facts = await store.getFacts(actorId, { kind: "identity" });
    assert.equal(facts.length, 1, "同 subject 不应产生第二条事实");
  } finally {
    await cleanup(dir, store, actorId);
  }
});

test("upsertFact: 不同 subject 共存", async () => {
  const dir = await makeTempDir();
  const store = new UserFactStore(dir);
  const actorId = "actor-coexist";
  try {
    await store.upsertFact(actorId, { kind: "fact", value: "我住在杭州" });
    await store.upsertFact(actorId, { kind: "fact", value: "我在做一个 Flutter 项目" });
    await store.upsertFact(actorId, { kind: "preference", value: "我喜欢简洁的回答" });

    const stats = await store.stats(actorId);
    assert.equal(stats.total, 3);
    assert.equal(stats.byKind.fact, 2);
    assert.equal(stats.byKind.preference, 1);
  } finally {
    await cleanup(dir, store, actorId);
  }
});

test("持久化：跨实例读取同一 per-actor 文件", async () => {
  const dir = await makeTempDir();
  const store1 = new UserFactStore(dir);
  try {
    await store1.upsertFact("actor-persist", {
      kind: "fact",
      value: "我住在上海",
      source: "nightly-extract",
    });
    await store1.flush("actor-persist");

    const store2 = new UserFactStore(dir);
    const facts = await store2.getFacts("actor-persist");
    assert.equal(facts.length, 1);
    assert.equal(facts[0]!.value, "我住在上海");
    assert.deepEqual(facts[0]!.sources, ["nightly-extract"]);

    const raw = JSON.parse(await readFile(join(dir, "actor-persist.json"), "utf-8")) as {
      version: number;
      facts: unknown[];
    };
    assert.equal(raw.version, 1);
    assert.equal(raw.facts.length, 1);
  } finally {
    await cleanup(dir, store1, "actor-persist");
  }
});

test("syncDerivedSlots: 事实行替换同 subject 旧行，未冲突的近期捕获行保留", async () => {
  const dir = await makeTempDir();
  const store = new UserFactStore(join(dir, "facts"));
  const actorId = "actor-sync";
  try {
    const memorySync = new AgentMemorySyncService(join(dir, "memory-sync.json"));
    await memorySync.load();

    // 当天 per-turn 快速路径写入：一条与事实冲突（居住地），一条无关（项目）
    memorySync.appendMemorySummaryLine(actorId, "我住在北京");
    memorySync.appendMemorySummaryLine(actorId, "my project is a Flutter chat app");
    await new Promise((resolve) => setTimeout(resolve, 30));

    // 夜间提炼：新事实（杭州）写入主库并同步派生视图
    await store.upsertFact(actorId, { kind: "fact", value: "我住在杭州" });
    const sync = await store.syncDerivedSlots(actorId, memorySync);
    await new Promise((resolve) => setTimeout(resolve, 30));

    assert.equal(sync.facts, 1);

    const { entries } = memorySync.getSnapshot(actorId, ["memory_facts"]);
    const slot = String(entries.memory_facts ?? "");
    assert.match(slot, /我住在杭州/, "事实行的最新值应进入槽位");
    assert.doesNotMatch(slot, /我住在北京/, "同 subject 的旧行应被事实替换");
    assert.match(slot, /Flutter chat app/, "未冲突的近期捕获行应保留");
  } finally {
    await cleanup(dir, store, actorId, 60);
  }
});
