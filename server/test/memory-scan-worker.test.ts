/**
 * 记忆扫描 Worker 集成测试：临时 SQLite（vectors 表）→ worker 只读扫描 → 行形状对齐。
 *
 * 只验证 C 方案的「只读扫描进 worker」这一段：不触发任何写操作。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";

test("memory-scan-worker：按 actor 变体过滤 + mem0 行形状对齐", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nb-scan-"));
  const dbPath = join(dir, "vectors-test.db");
  const db = new Database(dbPath);
  db.exec("CREATE TABLE vectors (id TEXT PRIMARY KEY, vector BLOB, payload TEXT)");
  const insert = db.prepare("INSERT INTO vectors (id, vector, payload) VALUES (?, ?, ?)");
  const vec = Buffer.alloc(0);
  insert.run(
    "m1",
    vec,
    JSON.stringify({
      data: "用户喜欢喝咖啡",
      user_id: "actor-a",
      createdAt: "2026-10-01T00:00:00.000Z",
      importance: 0.7,
      hash: "h1",
      textLemmatized: "x",
    }),
  );
  insert.run(
    "m2",
    vec,
    JSON.stringify({
      data: "用户住在杭州",
      user_id: "actor-b",
      createdAt: "2026-10-02T00:00:00.000Z",
    }),
  );
  insert.run(
    "m3",
    vec,
    JSON.stringify({
      data: "camel 形态实体键",
      userId: "actor-a",
      createdAt: "2026-10-03T00:00:00.000Z",
    }),
  );
  db.close();

  const { scanVectorDbInWorker, stopMemoryScanWorker } = await import(
    "../src/services/memory-scan-worker-host.js"
  );
  try {
    const rows = await scanVectorDbInWorker(dbPath, ["actor-a"]);
    assert.equal(rows.length, 2, "只应返回 actor-a 的两条（含 camel userId）");
    const first = rows.find((r) => r.id === "m1");
    assert.ok(first);
    assert.equal(first!.memory, "用户喜欢喝咖啡");
    assert.equal(first!.createdAt, "2026-10-01T00:00:00.000Z");
    assert.equal(first!.metadata.importance, 0.7, "metadata 保留业务字段");
    assert.equal(first!.metadata.hash, undefined, "保留键不进 metadata");
    assert.equal(first!.metadata.data, undefined, "data 映射到 memory，不进 metadata");
    assert.ok(rows.some((r) => r.id === "m3" && r.memory === "camel 形态实体键"));
  } finally {
    await stopMemoryScanWorker();
    rmSync(dir, { recursive: true, force: true });
  }
});
