import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { StructuredFactStore } from "../src/agentic-memory/structured-fact-store.js";
import { UserUnderstandingStore } from "../src/agentic-memory/user-understanding-store.js";
import { MemorySuppressionStore } from "../src/agentic-memory/memory-suppression.js";
import { AgenticMemoryFtsStore } from "../src/agentic-memory/fts-store.js";
import { ProvenanceService } from "../src/agentic-memory/provenance.js";
import { AgenticMemoryIngestService } from "../src/agentic-memory/ingest.js";
import { setMemorySuppressionStoreForTests } from "../src/agentic-memory/memory-suppression.js";
import { openAgenticSqlite } from "../src/agentic-memory/sqlite-store.js";

test("关键词遗忘：事实与理解下线，历史保留，撤销词阻断再次抽取", async () => {
  const dir = await mkdtemp(join(tmpdir(), "memory-forget-"));
  const db = openAgenticSqlite(join(dir, "memory.db"));
  const facts = new StructuredFactStore(db);
  const understanding = new UserUnderstandingStore(db);
  const suppression = new MemorySuppressionStore(db);
  try {
    facts.applyFact({ actorId: "u1", field: "居住地", value: "望京科技园" });
    facts.applyFact({ actorId: "u1", field: "职业", value: "程序员" });
    understanding.applyUnderstanding({ actorId: "u1", topic: "居住地", note: "用户住在望京科技园" });
    understanding.applyUnderstanding({ actorId: "u1", topic: "职业", note: "用户是程序员" });

    assert.equal(facts.clearMatching("u1", "望京"), 1);
    assert.equal(facts.getFact("u1", "居住地"), null);
    assert.equal(facts.getFact("u1", "职业")?.value, "程序员");
    assert.equal(understanding.clearMatching("u1", "望京"), 1);
    assert.deepEqual(understanding.getActiveUnderstandings("u1").map((n) => n.topic), ["职业"]);

    suppression.rememberForgotten("u1", "望京");
    assert.equal(suppression.isForgotten("u1", "用户住在望京科技园"), true);
    assert.equal(suppression.isForgotten("u1", "用户是程序员"), false);
    assert.equal(suppression.isForgotten("u2", "用户住在望京科技园"), false);
    assert.equal(suppression.textKeys("u1").length, 0, "显式遗忘不能混入软抑制语义");
  } finally {
    facts.close();
    understanding.close();
    suppression.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

test("显式遗忘词阻断统一抽取再次写入 Mem0、事实与理解", async () => {
  const dir = await mkdtemp(join(tmpdir(), "memory-forget-ingest-"));
  const db = openAgenticSqlite(join(dir, "memory.db"));
  const suppression = new MemorySuppressionStore(db);
  setMemorySuppressionStoreForTests(suppression);
  let addCalls = 0;
  const ingest = new AgenticMemoryIngestService({
    add: async () => { addCalls += 1; return { results: [] }; },
  } as never);
  let hookedFacts = 0;
  let hookedUnderstandings = 0;
  ingest.addWriteHook((event) => {
    hookedFacts += event.facts?.length ?? 0;
    hookedUnderstandings += event.understandings?.length ?? 0;
  });
  try {
    suppression.rememberForgotten("u1", "望京");
    await ingest.persistUnifiedExtraction("u1", "chat:2", {
      decision: "remember",
      memories: ["用户住在望京科技园"],
      commitments: [],
      corrections: [],
      facts: [{ field: "居住地", value: "望京科技园" }],
      understandings: [{ topic: "居住地", note: "用户住在望京科技园" }],
    }, "main", false, "用户住在望京科技园");
    assert.equal(addCalls, 0);
    assert.equal(hookedFacts, 0);
    assert.equal(hookedUnderstandings, 0);
  } finally {
    setMemorySuppressionStoreForTests(null);
    suppression.close();
    db.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

test("来源作废：Mem0 删除成功后同步移除 FTS 索引", async () => {
  const dir = await mkdtemp(join(tmpdir(), "provenance-fts-"));
  const db = openAgenticSqlite(join(dir, "memory.db"));
  const fts = new AgenticMemoryFtsStore(db);
  const deleted: string[] = [];
  const provenance = new ProvenanceService(
    { delete: async (id: string) => { deleted.push(id); } },
    null,
    null,
    db,
    fts,
  );
  try {
    fts.indexMemories("u1", [{ id: "m1", memory: "用户住在望京科技园", metadata: { actorId: "u1" } }]);
    assert.equal(fts.search("u1", "望京").length, 1);
    provenance.recordDerivations("chat:1", "u1", { mem0Ids: ["m1"] });
    const report = await provenance.invalidateSource("chat:1", "用户撤回");
    assert.equal(report.mem0Deleted, 1);
    assert.deepEqual(deleted, ["m1"]);
    assert.equal(fts.search("u1", "望京").length, 0);
  } finally {
    fts.purgeActor("u1");
    db.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});
