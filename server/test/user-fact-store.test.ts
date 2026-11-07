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
  isHabitClaim,
} from "../src/services/user-fact-store.js";

/** 本地日历日（YYYY-MM-DD），offsetDays 负数=过去 */
function dayStr(offsetDays: number): string {
  const d = new Date(Date.now() - offsetDays * 86_400_000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;
}

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

test("习惯画像门槛：单日观察不进槽位，第二观察日晋级并带 as-of", async () => {
  const dir = await makeTempDir();
  const store = new UserFactStore(join(dir, "facts"));
  const actorId = "actor-habit";
  try {
    const memorySync = new AgentMemorySyncService(join(dir, "memory-sync.json"));
    await memorySync.load();

    // 第一晚观察：入库但不进派生槽位（2026-11-07 定稿：单日观察不得固化为习惯）
    const first = await store.upsertFact(actorId, {
      kind: "preference",
      value: "用户习惯在凌晨0:40左右睡觉",
      source: "nightly-extract",
      observedOn: dayStr(1),
    });
    assert.ok(first);
    assert.deepEqual(first.evidenceDays, [dayStr(1)]);

    const sync1 = await store.syncDerivedSlots(actorId, memorySync);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(sync1.preferences, 0, "单日观察的习惯不得进入槽位");
    const { entries: e1 } = memorySync.getSnapshot(actorId, ["memory_preferences"]);
    assert.doesNotMatch(String(e1.memory_preferences ?? ""), /凌晨0:40/);

    // 第二晚不同观察日：晋级进槽位，行尾带证据锚（截至 MM-DD，N 天观察）
    const second = await store.upsertFact(actorId, {
      kind: "preference",
      value: "用户习惯在凌晨0:40左右睡觉",
      source: "nightly-extract",
      observedOn: dayStr(0),
    });
    assert.ok(second);
    assert.deepEqual(second.evidenceDays, [dayStr(1), dayStr(0)]);

    const sync2 = await store.syncDerivedSlots(actorId, memorySync);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(sync2.preferences, 1, "两个观察日后习惯应晋级进槽位");
    const { entries: e2 } = memorySync.getSnapshot(actorId, ["memory_preferences"]);
    const slot = String(e2.memory_preferences ?? "");
    assert.match(slot, /凌晨0:40/);
    assert.match(
      slot,
      new RegExp(`（截至${dayStr(0).slice(5)}，2天观察）`),
      "习惯行必须带 as-of 与观察天数",
    );
  } finally {
    await cleanup(dir, store, actorId, 60);
  }
});

test("习惯画像动态更新：新观察替换旧值，过保鲜期退出画像", async () => {
  const dir = await makeTempDir();
  const store = new UserFactStore(join(dir, "facts"));
  const actorId = "actor-habit-fresh";
  try {
    const memorySync = new AgentMemorySyncService(join(dir, "memory-sync.json"));
    await memorySync.load();

    // 两个观察日都在 15 天前：证据够但过保鲜期 → 不进槽位
    // （同一 subject：normalizeSubject 取前 12 字「用户习惯晚睡常到凌晨一点」）
    await store.upsertFact(actorId, {
      kind: "fact",
      value: "用户习惯晚睡常到凌晨一点",
      source: "nightly-extract",
      observedOn: dayStr(16),
    });
    await store.upsertFact(actorId, {
      kind: "fact",
      value: "用户习惯晚睡常到凌晨一点",
      source: "nightly-extract",
      observedOn: dayStr(15),
    });
    const sync = await store.syncDerivedSlots(actorId, memorySync);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(sync.facts, 0, "超过保鲜期的习惯不得进入槽位");

    // 最近重新观察到（动态更新）：值刷新 + 进槽位
    const fresh = await store.upsertFact(actorId, {
      kind: "fact",
      value: "用户习惯晚睡常到凌晨一点半",
      source: "nightly-extract",
      observedOn: dayStr(0),
    });
    assert.ok(fresh);
    await store.syncDerivedSlots(actorId, memorySync);
    await new Promise((resolve) => setTimeout(resolve, 30));
    const { entries } = memorySync.getSnapshot(actorId, ["memory_facts"]);
    const slot = String(entries.memory_facts ?? "");
    assert.match(slot, /凌晨一点半/, "新观察应刷新画像值");
    assert.doesNotMatch(slot, /凌晨一点（/, "旧值的渲染行应被替换");
  } finally {
    await cleanup(dir, store, actorId, 60);
  }
});

test("习惯画像压制：旧数据（无观察日）与单日捕获的残行应被清除", async () => {
  const dir = await makeTempDir();
  const store = new UserFactStore(join(dir, "facts"));
  const actorId = "actor-habit-legacy";
  try {
    const memorySync = new AgentMemorySyncService(join(dir, "memory-sync.json"));
    await memorySync.load();
    // 模拟历史上单日提取固化进槽位的残行
    memorySync.appendMemorySummaryLine(actorId, "用户习惯在凌晨0:40左右睡觉");
    await new Promise((resolve) => setTimeout(resolve, 30));

    // 旧数据：夜间提取落库但无 observedOn（无证据日）→ 被压制
    await store.upsertFact(actorId, {
      kind: "fact",
      value: "用户习惯在凌晨0:40左右睡觉",
      source: "nightly-extract",
    });
    const sync = await store.syncDerivedSlots(actorId, memorySync);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(sync.facts, 0, "无观察日证据的习惯不得进槽位");
    const { entries } = memorySync.getSnapshot(actorId, ["memory_facts"]);
    assert.doesNotMatch(
      String(entries.memory_facts ?? ""),
      /凌晨0:40/,
      "被压制习惯的旧槽位残行必须清除",
    );
  } finally {
    await cleanup(dir, store, actorId, 60);
  }
});

test("称呼类偏好与普通事实不受习惯门槛影响", async () => {
  const dir = await makeTempDir();
  const store = new UserFactStore(join(dir, "facts"));
  const actorId = "actor-naming";
  try {
    const memorySync = new AgentMemorySyncService(join(dir, "memory-sync.json"));
    await memorySync.load();
    // 用户明说的称呼偏好：虽含「习惯」字样但不是行为观察，单日即可进画像
    assert.equal(isHabitClaim({ kind: "fact", value: "用户真名王铭川，习惯被称呼为川哥" }), false);
    assert.equal(isHabitClaim({ kind: "fact", value: "用户习惯用「小弟」称呼助手" }), false);
    assert.equal(isHabitClaim({ kind: "fact", value: "用户习惯在凌晨0:40左右睡觉" }), true);
    assert.equal(isHabitClaim({ kind: "fact", value: "用户有游泳的习惯" }), true);
    assert.equal(isHabitClaim({ kind: "fact", value: "用户住在杭州" }), false);

    await store.upsertFact(actorId, {
      kind: "fact",
      value: "用户真名王铭川，习惯被称呼为川哥",
      source: "nightly-extract",
      observedOn: dayStr(0),
    });
    await store.syncDerivedSlots(actorId, memorySync);
    await new Promise((resolve) => setTimeout(resolve, 30));
    const { entries } = memorySync.getSnapshot(actorId, ["memory_facts"]);
    assert.match(
      String(entries.memory_facts ?? ""),
      /川哥/,
      "称呼类偏好单日即可进画像（不受多日门槛约束）",
    );
  } finally {
    await cleanup(dir, store, actorId, 60);
  }
});
