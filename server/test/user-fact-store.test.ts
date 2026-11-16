/**
 * 用户事实主库（UserFactStore）测试：
 * - subject 归一与 latest-wins 冲突替换（同身份新旧值互替、不同 subject 共存）；
 * - provenance（sources / seenCount / confidence）；
 * - per-actor JSON 持久化（跨实例读取）；
 * - 档案字段拒收（写入侧）与存量清扫（加载侧）——档案字段的唯一权威是
 *   structured_facts，本库只装长尾事实（2026-11-13 词表统一）。
 *
 * KV `memory_facts` / `memory_preferences` 槽位与派生视图同步（syncDerivedSlots）
 * 已随旧架构删除，不再有对应测试。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  UserFactStore,
  extractFactSubject,
  isLegacyProfileFact,
} from "../src/services/user-fact-store.js";

async function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "user-fact-store-"));
}

/** 清理前先等待事实库写盘链排空，避免 Windows 上 rm 与 rename 竞态（ENOTEMPTY）。 */
async function cleanup(
  dir: string,
  store: UserFactStore | null,
  actorId?: string,
): Promise<void> {
  if (store && actorId) await store.flush(actorId).catch(() => {});
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

test("upsertFact: 档案字段被拒收，长尾事实不同 subject 共存", async () => {
  const dir = await makeTempDir();
  const store = new UserFactStore(dir);
  const actorId = "actor-coexist";
  try {
    // 档案字段（居住地）→ 拒收：权威归 structured_facts，本库不存第二份
    const rejected = await store.upsertFact(actorId, { kind: "fact", value: "我住在杭州" });
    assert.equal(rejected, null, "档案字段不应进长尾事实库");

    await store.upsertFact(actorId, { kind: "fact", value: "我在做一个 Flutter 项目" });
    await store.upsertFact(actorId, { kind: "preference", value: "我喜欢简洁的回答" });

    const stats = await store.stats(actorId);
    assert.equal(stats.total, 2);
    assert.equal(stats.byKind.fact, 1);
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
      value: "我在做一个 Flutter 项目",
      source: "nightly-extract",
    });
    await store1.flush("actor-persist");

    const store2 = new UserFactStore(dir);
    const facts = await store2.getFacts("actor-persist");
    assert.equal(facts.length, 1);
    assert.equal(facts[0]!.value, "我在做一个 Flutter 项目");
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

test("isLegacyProfileFact: 旧词表 subject 与档案句式识别", () => {
  assert.equal(isLegacyProfileFact({ subject: "身份", value: "我是王哥" }), true);
  assert.equal(isLegacyProfileFact({ subject: "居住地", value: "我住在兴义" }), true);
  assert.equal(isLegacyProfileFact({ subject: "配偶/伴侣", value: "用户已婚，妻子是刘浩存" }), true);
  assert.equal(isLegacyProfileFact({ subject: "我的好友23787097", value: "我的好友 2378709729@qq.com 的身份短号是 17464274" }), false);
  assert.equal(isLegacyProfileFact({ subject: "刘浩存", value: "我喜欢刘浩存，把她当老婆" }), false);
  assert.equal(isLegacyProfileFact({ subject: "项目", value: "我在做一个 Flutter 项目" }), false);
});

test("加载即清扫：存量档案字段副本自动退场并写回，长尾事实保留", async () => {
  const dir = await makeTempDir();
  const actorId = "actor-sweep";
  const legacy = [
    {
      id: "legacy-1",
      kind: "fact",
      subject: "身份",
      value: "我是王哥",
      confidence: 0.7,
      seenCount: 3,
      sources: ["nightly-extract"],
      createdAt: "2026-08-29T15:00:23.724Z",
      updatedAt: "2026-09-10T17:36:19.466Z",
    },
    {
      id: "legacy-2",
      kind: "fact",
      subject: "配偶/伴侣",
      value: "用户已婚，妻子是刘浩存",
      confidence: 0.7,
      seenCount: 1,
      sources: ["nightly-extract"],
      createdAt: "2026-09-03T15:00:36.527Z",
      updatedAt: "2026-09-09T18:32:46.758Z",
    },
  ];
  const longtail = {
    id: "tail-1",
    kind: "preference",
    subject: "游泳",
    value: "我喜欢游泳，天热时想去游泳",
    confidence: 0.7,
    seenCount: 1,
    sources: ["nightly-extract"],
    createdAt: "2026-08-29T15:00:23.724Z",
    updatedAt: "2026-08-29T15:00:23.724Z",
  };
  const path = join(dir, `${actorId}.json`);
  await writeFile(
    path,
    JSON.stringify({ version: 1, updatedAt: "2026-10-01T00:00:00.000Z", facts: [...legacy, longtail] }),
    "utf-8",
  );

  const store = new UserFactStore(dir);
  try {
    const facts = await store.getFacts(actorId);
    assert.equal(facts.length, 1, "档案字段副本应在加载时清扫");
    assert.equal(facts[0]!.value, "我喜欢游泳，天热时想去游泳");
    await store.flush(actorId);

    const raw = JSON.parse(await readFile(path, "utf-8")) as { facts: Array<{ id: string }> };
    assert.deepEqual(
      raw.facts.map((f) => f.id),
      ["tail-1"],
      "清扫结果应写回磁盘（幂等，之后每次加载都干净）",
    );
  } finally {
    await cleanup(dir, store, actorId);
  }
});
