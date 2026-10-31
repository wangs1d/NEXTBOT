/**
 * 「删除这一轮」跨进程重启的可靠性回归（2026-10-04）。
 *
 * 事故：clientMessageId 反向索引只活在进程内 WeakMap 里，服务端重启后旧消息定位不到
 * → 客户端点了删除，服务端那轮仍留在上下文里（deleteTurn 返回 message_not_found），
 * 用户侧表现为「删不掉对话历史」。本文件锁定三条契约：
 *   1) clientMessageId 随线程落盘（`__clientMessageId`），且不改线程里在用的对象；
 *   2) 新进程（新 store，线程未驻留内存）里 deleteTurn 仍能按 id 精准摘除该轮，
 *      并把结果落回磁盘；
 *   3) 落盘字段不进内存线程、也不进发往 LLM 的视图（兜底剥离）。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";

import { PERSISTED_CLIENT_ID_FIELD, readUserMessageClientId } from "../src/external-model/chat-thread-client-id.js";
import {
  ChatThreadPersistence,
  isChatThreadPersistenceEnabled,
  threadShardDirFor,
  threadShardPathFor,
  type PersistedSession,
} from "../src/external-model/chat-thread-persist.js";
import {
  buildTimestampFreeLlmView,
  ChatThreadStore,
} from "../src/external-model/chat-thread-store.js";

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const SESSION = "actor-2378709729@qq.com";
const SYSTEM = "system prompt";

const skipReason = isChatThreadPersistenceEnabled()
  ? false
  : "AGENT_CHAT_THREAD_PERSIST 被显式关闭，持久化用例无意义";

/**
 * 轮询等待该会话的分片落盘到期望状态（debounce 250ms + 原子写排队，固定 sleep 不稳）。
 * 落盘是「每会话一个分片」，所以按 sessionId 定位文件；旧单文件只在首次迁移前兜底。
 */
async function waitForSessionRow(
  file: string,
  predicate: (row: PersistedSession) => boolean,
  timeoutMs = 8000,
): Promise<PersistedSession> {
  const shard = threadShardPathFor(threadShardDirFor(file), SESSION);
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    try {
      last = readFileSync(shard, "utf8");
      const row = JSON.parse(last) as PersistedSession;
      if (predicate(row)) return row;
    } catch {
      try {
        last = readFileSync(file, "utf8");
        const row = (JSON.parse(last).sessions ?? {})[SESSION] as PersistedSession | undefined;
        if (row && predicate(row)) return row;
      } catch {
        /* 还没落盘 */
      }
    }
    await delay(50);
  }
  throw new Error(`等待落盘超时（${shard}）。最后内容：${last.slice(0, 400)}`);
}

function seedTurns(store: ChatThreadStore, turns: number): void {
  for (let i = 1; i <= turns; i++) {
    store.appendTurn(
      SESSION,
      SYSTEM,
      { text: `user turn ${i}`, clientMessageId: `u-${i}` },
      `assistant turn ${i}`,
      undefined,
      new Date(),
      `u-${i}`,
    );
  }
}

test("重启后 deleteTurn 仍能按 clientMessageId 精准摘除该轮", { skip: skipReason }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "thread-clientid-"));
  const file = join(dir, "chat-threads.json");
  const notes = join(dir, "chat-threads-notes.json");

  // ── 进程 A：聊 3 轮并落盘 ────────────────────────────────────────────
  const persistA = new ChatThreadPersistence(file, notes);
  await persistA.load();
  const storeA = new ChatThreadStore(persistA);
  seedTurns(storeA, 3);

  const row = await waitForSessionRow(file, (r) => JSON.stringify(r.messages).includes("user turn 3"));
  const messages = row.messages as Array<Record<string, unknown>>;
  assert.ok(
    messages.some((m) => typeof m[PERSISTED_CLIENT_ID_FIELD] === "string"),
    "clientMessageId 必须随线程落盘（否则重启后无法按 id 定位）",
  );

  // 落盘是克隆式的：线程里正在用的对象不得被加上该字段（它同时是 LLM 上下文源头）
  const liveThread = storeA.thread(SESSION, SYSTEM);
  assert.equal(
    liveThread.some((m) => PERSISTED_CLIENT_ID_FIELD in (m as object)),
    false,
    "落盘不得就地修改线程对象",
  );

  // ── 进程 B（模拟服务端重启）：新持久化实例 + 新 store，线程未驻留内存 ──
  const persistB = new ChatThreadPersistence(file, notes);
  await persistB.load();
  const storeB = new ChatThreadStore(persistB);

  const result = storeB.deleteTurn(SESSION, "u-2");
  assert.equal(result.ok, true, "重启后按 id 删除必须命中（不再 message_not_found）");
  assert.equal(result.removed, 2, "一轮 = user 消息 + 该轮 assistant 回复");

  const serialized = JSON.stringify(storeB.thread(SESSION, SYSTEM));
  assert.doesNotMatch(serialized, /user turn 2/, "被删轮次不得残留");
  assert.doesNotMatch(serialized, /assistant turn 2/, "被删轮次的回复不得残留");
  assert.match(serialized, /user turn 1/, "更早轮次必须保留");
  assert.match(serialized, /user turn 3/, "更晚轮次必须保留");

  // 删除结果必须落回磁盘：否则再下一次重启（进程 C）会把删掉的一轮又读回来
  const deletedRow = await waitForSessionRow(
    file,
    (r) => !JSON.stringify(r.messages).includes("user turn 2"),
  );
  const afterDelete = JSON.stringify(deletedRow.messages);
  assert.doesNotMatch(afterDelete, /user turn 2/, "磁盘上也不得残留被删轮次");
  assert.match(afterDelete, /user turn 3/, "磁盘上更晚轮次必须保留");

  // 删除后同步一个「进程 C」：从磁盘恢复的线程里同样没有这一轮
  const persistC = new ChatThreadPersistence(file, notes);
  await persistC.load();
  const storeC = new ChatThreadStore(persistC);
  assert.doesNotMatch(
    JSON.stringify(storeC.thread(SESSION, SYSTEM)),
    /user turn 2/,
    "再下一次重启不得把已删轮次读回来",
  );
});

test("恢复后的线程对象不带落盘字段（内部元数据不驻留内存）", { skip: skipReason }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "thread-clientid-absorb-"));
  const file = join(dir, "chat-threads.json");
  const notes = join(dir, "chat-threads-notes.json");

  const persistA = new ChatThreadPersistence(file, notes);
  await persistA.load();
  const storeA = new ChatThreadStore(persistA);
  seedTurns(storeA, 2);
  await waitForSessionRow(file, (r) => JSON.stringify(r).includes("__clientMessageId"));

  const persistB = new ChatThreadPersistence(file, notes);
  await persistB.load();
  const storeB = new ChatThreadStore(persistB);
  const restored = storeB.thread(SESSION, SYSTEM);

  const userMsgs = restored.filter((m) => m.role === "user");
  assert.ok(userMsgs.length >= 2, "两轮 user 消息都应恢复出来");
  assert.equal(
    restored.some((m) => PERSISTED_CLIENT_ID_FIELD in (m as object)),
    false,
    "恢复后就地剥离字段（避免随上下文发给模型，也避免被后续序列化放大）",
  );
  // 剥掉字段的同时，id 必须已回灌进反向索引——否则「恢复后能读出来但删不掉」
  for (const msg of userMsgs) {
    assert.ok(
      readUserMessageClientId(msg),
      "恢复出的 user 消息必须仍可按 clientMessageId 定位",
    );
  }
});

test("发往 LLM 的视图兜底剥离 __clientMessageId，且不改线程原对象", () => {
  const raw = [
    { role: "user", content: "hello", [PERSISTED_CLIENT_ID_FIELD]: "u-9" },
    { role: "assistant", content: "hi" },
  ] as unknown as ChatCompletionMessageParam[];

  const view = buildTimestampFreeLlmView(raw).messages;

  assert.doesNotMatch(
    JSON.stringify(view),
    /__clientMessageId/,
    "内部元数据不得出现在发往 LLM 的载荷里",
  );
  assert.equal(
    (raw[0] as unknown as Record<string, unknown>)[PERSISTED_CLIENT_ID_FIELD],
    "u-9",
    "视图剥离是克隆式的，不得就地改线程对象",
  );
  assert.equal(
    readUserMessageClientId(view[0]!),
    "u-9",
    "剥离产生的克隆必须继承 clientMessageId 绑定（否则后续按 id 定位会断链）",
  );
});
