/**
 * FTS 关键词第三路单测（混合检索 P0）。
 *
 * 覆盖：中文 bigram/英文词检索、AND→OR 兜底、actor 隔离、context 过滤
 * （notes 下推 + 缺省视为 main 的旧数据兼容）、同 id upsert 覆盖、
 * remove/purgeActor、存量回填。测试封闭：临时 SQLite，无外部依赖。
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AgenticMemoryFtsStore } from "../src/agentic-memory/fts-store.js";
import { openAgenticSqlite } from "../src/agentic-memory/sqlite-store.js";

/** 同步资源助手：断言同步抛出即测试失败，不泄漏到 test 结束之后 */
function withStore(
  fn: (ctx: { store: AgenticMemoryFtsStore; dir: string }) => void | Promise<void>,
): void {
  const dir = mkdtempSync(join(tmpdir(), "memory-fts-"));
  const db = openAgenticSqlite(join(dir, "fts.db"));
  const store = new AgenticMemoryFtsStore(db);
  try {
    const result = fn({ store, dir });
    if (result && typeof (result as Promise<void>).then === "function") {
      // 异步用例（backfill）：同步场景下不会走到这里
      throw new Error("withStore 不支持异步 fn，请用 withStoreAsync");
    }
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

async function withStoreAsync(
  fn: (ctx: { store: AgenticMemoryFtsStore; dir: string }) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "memory-fts-"));
  const db = openAgenticSqlite(join(dir, "fts.db"));
  const store = new AgenticMemoryFtsStore(db);
  try {
    await fn({ store, dir });
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

const CORPUS = [
  { id: "m1", memory: "用户的前端技术栈是 TypeScript 和 React" },
  { id: "m2", memory: "用户住在杭州，去年从上海搬来" },
  { id: "m3", memory: "用户的猫叫布丁，是一只英短" },
  { id: "m4", memory: "用户正在开发私人助理项目，后端用 Node.js" },
  { id: "m11", memory: "用户使用 Qdrant 做向量检索，Mem0 管理记忆" },
];

function indexAll(store: AgenticMemoryFtsStore, items = CORPUS): void {
  store.indexMemories(
    "user-1",
    items.map((m) => ({ id: m.id, memory: m.memory, metadata: { context: "main" } })),
  );
}

test("FTS：中文 bigram 精确命中，bm25 排序把高覆盖记忆排前", () => {
  withStore((ctx) => {
    const { store } = ctx;
    indexAll(store);
    const hits = store.search("user-1", "猫叫什么名字");
    assert.ok(hits.length > 0, "应命中含「猫」的记忆");
    assert.equal(hits[0]!.memoryId, "m3");
    assert.ok(hits[0]!.score > 0.5 && hits[0]!.score <= 1, "分数映射到 (0.5, 1]");
  });
});

test("FTS：英文词与混合文本命中", () => {
  withStore((ctx) => {
    const { store } = ctx;
    indexAll(store);
    const ts = store.search("user-1", "TypeScript");
    assert.equal(ts[0]?.memoryId, "m1");
    const qdrant = store.search("user-1", "qdrant 向量检索");
    assert.equal(qdrant[0]?.memoryId, "m11");
  });
});

test("FTS：AND 无结果时 OR + 稀有 token 兜底可捞回部分命中", () => {
  withStore((ctx) => {
    const { store } = ctx;
    indexAll(store);
    // 「英短」「上海」两词不同时出现在任何一条里：AND 空，OR 应捞回两条
    const hits = store.search("user-1", "英短 上海");
    const ids = new Set(hits.map((h) => h.memoryId));
    assert.ok(ids.has("m2"), "部分命中（上海）应被 OR 兜底捞回");
    assert.ok(ids.has("m3"), "部分命中（英短）应被 OR 兜底捞回");
  });
});

test("FTS：长自然语言 query 只靠稀有 bigram 也能命中，通用 bigram 不刷榜", () => {
  withStore((ctx) => {
    const { store } = ctx;
    indexAll(store);
    // 「用户」等通用 bigram 人人都有；「技术栈」是稀有信号，只有 m1 命中
    const hits = store.search("user-1", "用户的技术栈是什么");
    assert.equal(hits[0]?.memoryId, "m1");
    assert.ok(hits.length <= 2, "只含通用 bigram 的记忆不应大量涌入");
  });
});

test("FTS：完全不相关的 query 不返回结果", () => {
  withStore((ctx) => {
    const { store } = ctx;
    indexAll(store);
    assert.equal(store.search("user-1", "火星移民计划").length, 0);
  });
});

test("FTS：actor 隔离——跨用户记忆不可见", () => {
  withStore((ctx) => {
    const { store } = ctx;
    indexAll(store);
    store.indexMemories("user-2", [{ id: "m2x", memory: "用户住在北京朝阳区" }]);
    const hitsOther = store.search("user-2", "朝阳区在哪");
    assert.equal(hitsOther[0]?.memoryId, "m2x");
    // user-1 语料无「朝阳」词面（住在杭州会被「住在」部分命中属正常兜底行为），
    // 用 user-2 独有词断言隔离
    const hitsOne = store.search("user-1", "朝阳区");
    assert.equal(hitsOne.length, 0, "user-1 不得看到 user-2 的记忆");
  });
});

test("FTS：context 过滤——notes 下推，缺省视为 main（旧数据兼容）", () => {
  withStore((ctx) => {
    const { store } = ctx;
    store.indexMemories("user-1", [
      { id: "mm1", memory: "会议纪要：下周三评审", metadata: { context: "notes" } },
      { id: "mm2", memory: "用户喜欢在周末爬山", metadata: { context: "main" } },
      { id: "mm3", memory: "爬山前要检查天气", metadata: {} }, // 旧数据：无 context
    ]);
    // main：notes 行排除，无 context 行按 main 保留
    const mainHits = store.search("user-1", "爬山", { context: "main" });
    const mainIds = new Set(mainHits.map((h) => h.memoryId));
    assert.ok(mainIds.has("mm2") && mainIds.has("mm3"), "main 应含显式 main 与缺省行");
    assert.ok(!mainIds.has("mm1"));
    // notes：只返回 notes
    const notesHits = store.search("user-1", "评审", { context: "notes" });
    assert.deepEqual(notesHits.map((h) => h.memoryId), ["mm1"]);
    // any：全量
    const anyHits = store.search("user-1", "爬山", { context: "any" });
    assert.equal(anyHits.length, 2);
  });
});

test("FTS：同 memory_id upsert 覆盖旧内容", () => {
  withStore((ctx) => {
    const { store } = ctx;
    indexAll(store);
    store.indexMemories("user-1", [
      { id: "m3", memory: "用户的猫改名了，现在叫年糕", metadata: { context: "main" } },
    ]);
    const oldHits = store.search("user-1", "布丁");
    assert.equal(oldHits.length, 0, "旧内容应被覆盖");
    const newHits = store.search("user-1", "猫 年糕");
    assert.equal(newHits[0]?.memoryId, "m3");
  });
});

test("FTS：metadata.sourceRole 优先，助手时间线不占用户召回位", () => {
  withStore(({ store }) => {
    store.indexMemories("user-1", [
      {
        id: "assistant-neutral",
        memory: "周末去公园散步",
        metadata: { context: "main", sourceRole: "assistant" },
      },
      { id: "legacy-neutral", memory: "周末去河边钓鱼", metadata: { context: "main" } },
    ]);

    const hits = store.search("user-1", "周末 公园 河边", { context: "main" });
    assert.deepEqual(hits.map((hit) => hit.memoryId), ["legacy-neutral"]);
  });
});

test("FTS：remove 与 purgeActor", () => {
  withStore((ctx) => {
    const { store } = ctx;
    indexAll(store);
    store.remove(["m1", "m11"]);
    assert.equal(store.search("user-1", "TypeScript").length, 0);
    store.purgeActor("user-1");
    assert.equal(store.search("user-1", "杭州").length, 0);
    assert.equal(store.stats().rows, 0);
  });
});

test("FTS：backfillFromMem0 存量回填（按 filters.user_id 逐 actor 过滤）", async () => {
  await withStoreAsync(async (ctx) => {
    const { store } = ctx;
    const seenFilters: Array<{ user_id?: string } | undefined> = [];
    const fakeMem0 = {
      async getAll(config?: { topK?: number; filters?: { user_id?: string } }) {
        seenFilters.push(config?.filters);
        const uid = config?.filters?.user_id;
        return {
          results: [
            ...(uid === "user-1"
              ? [{ id: "b1", memory: "用户的女儿五岁了", metadata: { actorId: "user-1" } }]
              : []),
            ...(uid === "user-2"
              ? [{ id: "b2", memory: "用户会说日语", metadata: { actorId: "user-2" } }]
              : []),
            { id: "b3", memory: "无主记忆不回填", metadata: {} },
          ],
        };
      },
    };
    const { indexed } = await store.backfillFromMem0(fakeMem0, ["user-1", "user-2"]);
    assert.deepEqual(seenFilters, [{ user_id: "user-1" }, { user_id: "user-2" }], "必须带 filters.user_id 逐 actor 扫（mem0ai v3 裸 topK 必抛）");
    assert.equal(indexed, 2);
    assert.equal(store.search("user-1", "女儿 几岁")[0]?.memoryId, "b1");
    assert.equal(store.search("user-1", "日语").length, 0, "user-2 的记忆不串到 user-1");
  });
});
