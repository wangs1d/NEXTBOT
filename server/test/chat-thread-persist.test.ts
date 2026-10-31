/**
 * chat-thread-persist 启动竞态 + 分片落盘回归测试。
 *
 * 锁定的契约：
 *  1. 初始 load 完成前，任何写入/删除必须等待；load 期间到达的写入不得丢失；
 *     删除必须作用在已加载的数据上（2026-09-08 事故）。
 *  2. 旧单文件（chat-threads.json）在首次 load 时迁为「每会话一个分片」，
 *     旧文件改名留档而不是删除；此后每次保存只写变化的那一个会话。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFile } from "node:fs/promises";

const { ChatThreadPersistence } = await import("../src/external-model/chat-thread-persist.js");

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** debounce 250ms < 慢读取 400ms：保证「落盘触发时 load 尚未完成」的窗口确定复现。 */
const SLOW_READ_MS = 400;

function slowReader(): (path: string) => Promise<string> {
  return async (path) => {
    await delay(SLOW_READ_MS);
    return readFile(path, "utf8");
  };
}

/** 分片目录：`<file 去 .json>.shards`；读回 sessionId → messages 文本。 */
function readShards(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    const row = JSON.parse(readFileSync(join(dir, name), "utf8"));
    out[decodeURIComponent(name.slice(0, -".json".length))] = JSON.stringify(row.messages);
  }
  return out;
}

function legacyBackupExists(dir: string): boolean {
  return readdirSync(dir).some((n) => n.startsWith("chat-threads.json.migrated-"));
}

/**
 * 轮询分片目录直到满足条件：debounce 250ms 之后还要排队原子写，
 * 全套 3500+ 用例并发跑时固定 sleep 会假失败。
 */
async function waitForShards(
  dir: string,
  ok: (shards: Record<string, string>) => boolean,
  what: string,
  timeoutMs = 8000,
): Promise<Record<string, string>> {
  const deadline = Date.now() + timeoutMs;
  let shards: Record<string, string> = {};
  while (Date.now() < deadline) {
    shards = readShards(dir);
    if (ok(shards)) return shards;
    await delay(50);
  }
  throw new Error(`等待「${what}」超时，现有分片：${Object.keys(shards).join(", ") || "(空)"}`);
}

test("启动竞态守卫：load 完成前到达的落盘必须等待，既有会话不得被空骨架覆盖", async () => {
  const dir = mkdtempSync(join(tmpdir(), "thread-persist-race-"));
  const file = join(dir, "chat-threads.json");
  const notes = join(dir, "chat-threads-notes.json");
  writeFileSync(
    file,
    JSON.stringify({
      sessions: {
        "session-existing": {
          updatedAt: new Date().toISOString(),
          messages: [{ role: "user", content: "既有上下文" }],
        },
      },
    }),
  );

  const persist = new ChatThreadPersistence(file, notes, slowReader());
  const loading = persist.load();
  // load 未完成时，另一会话的写入到达（真实场景：boot 期间的首次对话/后台会话）
  persist.scheduleSave("session-new", [{ role: "user", content: "新会话消息" }]);
  await loading;

  const shards = await waitForShards(
    join(dir, "chat-threads.shards"),
    (s) => Boolean(s["session-new"] && s["session-existing"]),
    "新会话落盘且既有会话仍在",
  );
  assert.ok(shards["session-existing"], "既有会话必须存活（竞态修复前会被空数据覆盖）");
  assert.ok(shards["session-new"], "load 期间到达的新会话写入不得丢失");
  assert.match(shards["session-existing"], /既有上下文/, "既有会话内容必须完整保留");
  assert.ok(legacyBackupExists(dir), "旧单文件应改名留档而不是删除");
});

test("启动竞态守卫：load 完成前到达的删除，作用在已加载的数据上", async () => {
  const dir = mkdtempSync(join(tmpdir(), "thread-persist-del-"));
  const file = join(dir, "chat-threads.json");
  writeFileSync(
    file,
    JSON.stringify({
      sessions: {
        "session-to-remove": {
          updatedAt: new Date().toISOString(),
          messages: [{ role: "user", content: "待删除" }],
        },
        "session-keep": {
          updatedAt: new Date().toISOString(),
          messages: [{ role: "user", content: "保留" }],
        },
      },
    }),
  );

  const persist = new ChatThreadPersistence(
    file,
    join(dir, "chat-threads-notes.json"),
    slowReader(),
  );
  const loading = persist.load();
  persist.deleteSession("session-to-remove");
  await loading;

  const shards = await waitForShards(
    join(dir, "chat-threads.shards"),
    (s) => !s["session-to-remove"] && Boolean(s["session-keep"]),
    "待删分片消失且保留会话仍在盘上",
  );
  assert.ok(!shards["session-to-remove"], "删除意图必须生效（分片已 unlink）");
  assert.ok(shards["session-keep"], "其他会话不受影响");
});

test("保存只写变化的那一个会话：其他用户的分片文件不被整体重写", async () => {
  const dir = mkdtempSync(join(tmpdir(), "thread-persist-shard-"));
  const file = join(dir, "chat-threads.json");
  writeFileSync(
    file,
    JSON.stringify({
      sessions: {
        "session-a": { updatedAt: new Date().toISOString(), messages: [{ role: "user", content: "A" }] },
        "session-b": { updatedAt: new Date().toISOString(), messages: [{ role: "user", content: "B" }] },
      },
    }),
  );
  const persist = new ChatThreadPersistence(file, join(dir, "chat-threads-notes.json"));
  await persist.load();

  const shardDir = join(dir, "chat-threads.shards");
  const before = readFileSync(join(shardDir, "session-b.json"), "utf8");

  persist.scheduleSave("session-a", [{ role: "user", content: "A2" }]);
  const shards = await waitForShards(shardDir, (s) => /A2/.test(s["session-a"] ?? ""), "session-a 的新内容落盘");

  assert.equal(readFileSync(join(shardDir, "session-b.json"), "utf8"), before, "未涉及的会话分片不得被重写");
  assert.match(shards["session-a"], /A2/);
});

test("二次启动直接读分片，不再依赖旧单文件", async () => {
  const dir = mkdtempSync(join(tmpdir(), "thread-persist-boot-"));
  const file = join(dir, "chat-threads.json");
  const notes = join(dir, "chat-threads-notes.json");
  writeFileSync(
    file,
    JSON.stringify({
      sessions: { "session-x": { updatedAt: new Date().toISOString(), messages: [{ role: "user", content: "X" }] } },
    }),
  );
  const first = new ChatThreadPersistence(file, notes);
  await first.load();
  await first.flushPendingForTests();

  const second = new ChatThreadPersistence(file, notes);
  await second.load();
  assert.deepEqual(
    second.getActorThreads("session-x").map((t) => t.sessionId),
    ["session-x"],
    "重启后应从分片恢复会话",
  );
});
