import assert from "node:assert/strict";
import test from "node:test";

import {
  createMemoryRecord,
  isMemoryRecord,
  memoryRecordFromMetadata,
  memoryRecordMetadata,
} from "../src/agentic-memory/memory-record.js";

test("MemoryRecord：在写入边界固定角色、权威与来源", () => {
  const record = createMemoryRecord({
    actorId: " actor@example.com ",
    sourceRef: " event:evt-1 ",
    text: "我住在兴义",
    sourceRole: "user",
    kind: "fact",
    createdAt: "2026-11-27T10:00:00.000Z",
    sourceEventId: "evt-1",
    supersedes: ["mem-old", "mem-old"],
  });

  assert.equal(record.actorId, "actor@example.com");
  assert.equal(record.sourceRef, "event:evt-1");
  assert.equal(record.sourceRole, "user");
  assert.equal(record.authority, "user");
  assert.equal(record.validity, "active");
  assert.deepEqual(record.supersedes, ["mem-old"]);
  assert.equal(Object.isFrozen(record), true);
  assert.equal(Object.isFrozen(record.supersedes), true);
  assert.throws(() => {
    (record as { sourceRole: string }).sourceRole = "assistant";
  }, TypeError);
});

test("MemoryRecord：只在缺少显式角色时按文本兜底", () => {
  const record = createMemoryRecord({
    actorId: "actor",
    sourceRef: "chat:fast_path",
    text: "[用户事实] 我住在兴义",
  });
  assert.equal(record.sourceRole, "user");
  assert.equal(record.authority, "user");

  const assistant = createMemoryRecord({
    actorId: "actor",
    sourceRef: "chat:fast_path",
    text: "我住在兴义",
    sourceRole: "assistant",
  });
  assert.equal(assistant.sourceRole, "assistant");
  assert.equal(assistant.authority, "assistant");
});

test("MemoryRecord：metadata 投影可无损恢复且拒绝残缺信封", () => {
  const record = createMemoryRecord({
    actorId: "actor",
    sourceRef: "event:evt-2",
    text: "用户事件",
    sourceRole: "mixed",
    authority: "derived",
    kind: "event",
    sourceEventId: "evt-2",
    eventTime: "2026-11-27T09:00:00.000Z",
  });
  const metadata = memoryRecordMetadata(record);
  assert.deepEqual(memoryRecordFromMetadata(metadata), record);
  assert.equal(isMemoryRecord(metadata.memoryRecord), true);
  assert.equal(memoryRecordFromMetadata({ memoryRecord: { actorId: "actor" } }), null);
  assert.equal(memoryRecordFromMetadata(undefined), null);
});
