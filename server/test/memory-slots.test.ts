import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildLayeredSystemPrompt, sliceMemoryEntriesToPromptContext } from "../src/agent/prompt-builder.js";
import { AgentMemorySyncService } from "../src/services/agent-memory-sync-service.js";
import { dropExpiredCommitmentLines } from "../src/services/memory-record-utils.js";

// 存储文件放进系统临时目录，避免测试数据散落到仓库（见项目记忆：测试文件统一管理）
const storePath = join(mkdtempSync(join(tmpdir(), "memory-slots-")), "test-agent-memory-sync.json");

test("appendMemorySummaryLine populates structured memory slots", async () => {
  const service = new AgentMemorySyncService(storePath);

  service.appendMemorySummaryLine("actor-1", "user prefers concise answers");
  service.appendMemorySummaryLine("actor-1", "I will continue following up on this fix");
  service.appendMemorySummaryLine("actor-1", "my project is a Flutter chat context repair");

  await new Promise((resolve) => setTimeout(resolve, 20));

  const { entries } = service.getSnapshot("actor-1", [
    "memory_preferences",
    "memory_commitments",
    "memory_facts",
    "session_recap",
  ]);

  assert.match(String(entries.memory_preferences ?? ""), /concise answers/);
  assert.match(String(entries.memory_commitments ?? ""), /continue following up/);
  assert.match(String(entries.memory_facts ?? ""), /Flutter chat context repair/);
  assert.match(String(entries.session_recap ?? ""), /concise answers|continue following up|Flutter chat context repair/);
});

test("sliceMemoryEntriesToPromptContext exposes structured slots to prompt builder", () => {
  const memory = sliceMemoryEntriesToPromptContext({
    memory_preferences: "[2026-07-14T00:00:00Z] [topic:chat] user prefers concise answers",
    memory_facts: "[2026-07-14T00:00:00Z] [topic:project] user is working on a Flutter project",
    memory_commitments: `[${new Date().toISOString()}] [topic:project] agent will continue repairing context retention`,
    memory_open_loops: `[${new Date().toISOString()}] [topic:project] need to verify behavior after 100 messages`,
    session_recap: "[2026-07-14T00:00:00Z] [topic:recap] recently focused on fixing chat memory",
  });

  const prompt = buildLayeredSystemPrompt("base", memory);
  assert.match(prompt, /【用户档案】/);
  assert.match(prompt, /偏好：/);
  assert.match(prompt, /事实：/);
  assert.match(prompt, /待兑现承诺/);
  assert.match(prompt, /未完成事项/);
  assert.match(prompt, /会话回顾/);
});

test("reconcileStructuredMemoryAfterTurn only clears resolved commitments and loops", async () => {
  const service = new AgentMemorySyncService(storePath);
  service.appendMemorySummaryLine("actor-2", "I will continue following up on the context fix");
  service.appendMemorySummaryLine("actor-2", "todo: verify continuity after 100 messages");
  service.appendMemorySummaryLine("actor-2", "todo: prepare regression notes for memory rollout");

  await new Promise((resolve) => setTimeout(resolve, 20));

  service.reconcileStructuredMemoryAfterTurn(
    "actor-2",
    "done: the context fix and 100 message continuity verification are finished",
    "fixed and resolved the context retention issue",
  );
  await new Promise((resolve) => setTimeout(resolve, 20));

  const { entries } = service.getSnapshot("actor-2", [
    "memory_commitments",
    "memory_open_loops",
    "session_recap",
  ]);
  const commitments = String(entries.memory_commitments ?? "");
  const openLoops = String(entries.memory_open_loops ?? "");
  const recap = String(entries.session_recap ?? "");

  assert.equal(commitments, "");
  assert.doesNotMatch(openLoops, /100 messages/);
  assert.match(openLoops, /memory rollout/);
  assert.doesNotMatch(recap, /100 messages|context fix/);
  assert.match(recap, /memory rollout/);
});

test("latest preference replaces older preference for the same subject", async () => {
  const service = new AgentMemorySyncService(storePath);

  service.appendMemorySummaryLine("actor-3", "user prefers concise answers");
  service.appendMemorySummaryLine("actor-3", "user dislikes concise answers");

  await new Promise((resolve) => setTimeout(resolve, 20));

  const { entries } = service.getSnapshot("actor-3", ["memory_preferences"]);
  const preferences = String(entries.memory_preferences ?? "");

  assert.doesNotMatch(preferences, /prefers concise answers/);
  assert.match(preferences, /dislikes concise answers/);
});

test("latest fact replaces older fact for the same slot", async () => {
  const service = new AgentMemorySyncService(storePath);

  service.appendMemorySummaryLine("actor-4", "I live in Shanghai");
  service.appendMemorySummaryLine("actor-4", "I live in Beijing");

  await new Promise((resolve) => setTimeout(resolve, 20));

  const { entries } = service.getSnapshot("actor-4", ["memory_facts"]);
  const facts = String(entries.memory_facts ?? "");

  assert.doesNotMatch(facts, /live in Shanghai/);
  assert.match(facts, /live in Beijing/);
});

test("current mission can be updated and cleared", async () => {
  const service = new AgentMemorySyncService(storePath);

  service.setCurrentMission("actor-5", "continue fixing memory continuity across long chats");
  await new Promise((resolve) => setTimeout(resolve, 20));

  let snapshot = service.getSnapshot("actor-5", ["memory_current_mission"]);
  assert.match(String(snapshot.entries.memory_current_mission ?? ""), /memory continuity across long chats/);

  service.setCurrentMission("actor-5", null);
  await new Promise((resolve) => setTimeout(resolve, 20));

  snapshot = service.getSnapshot("actor-5", ["memory_current_mission"]);
  assert.equal(String(snapshot.entries.memory_current_mission ?? ""), "");
});

test("dropExpiredCommitmentLines drops only stale-dated lines, keeps undated ones", () => {
  const now = Date.parse("2026-09-24T12:00:00Z");
  const lines = [
    "[2026-09-24T10:00:00Z] [topic:chat] 承诺：明早八点送早报",
    "[2026-09-07T17:43:38Z] [topic:consolidate] 承诺：我会在00:50睡觉",
    "无时间戳的行不冤枉",
    "[not-a-date] [topic:chat] 解析失败也不冤枉",
  ];
  const kept = dropExpiredCommitmentLines(lines, now);
  assert.deepEqual(kept, [
    "[2026-09-24T10:00:00Z] [topic:chat] 承诺：明早八点送早报",
    "无时间戳的行不冤枉",
    "[not-a-date] [topic:chat] 解析失败也不冤枉",
  ]);
});

test("sliceMemoryEntriesToPromptContext filters zombie commitments before injection", () => {
  const now = Date.now();
  const iso = (agoMs: number) => new Date(now - agoMs).toISOString();
  const memory = sliceMemoryEntriesToPromptContext({
    memory_commitments: [
      `[${iso(1 * 60 * 60 * 1000)}] [topic:chat] 承诺：我会在明早八点送早报`,
      `[${iso(30 * 24 * 60 * 60 * 1000)}] [topic:chat] 承诺：我会在00:50睡觉`,
    ].join("\n"),
  });
  const prompt = buildLayeredSystemPrompt("base", memory);
  assert.match(prompt, /明早八点送早报/);
  assert.doesNotMatch(prompt, /00:50睡觉/);
});

test("appendMemorySummaryLine sweeps expired commitments from the slot on write", async () => {
  const service = new AgentMemorySyncService(storePath);
  const stale = "[2026-09-01T00:00:00Z] [topic:consolidate] 承诺：我会在00:50睡觉";
  const seed = service.getSnapshot("actor-zombie");
  await service.applyPatch("actor-zombie", seed.revision, [
    { key: "memory_commitments", op: "put", value: stale },
  ]);

  // 新承诺入槽时顺带清扫同槽僵尸
  service.appendMemorySummaryLine("actor-zombie", "I will send the morning briefing at 8am");
  await new Promise((resolve) => setTimeout(resolve, 20));

  const { entries } = service.getSnapshot("actor-zombie", ["memory_commitments"]);
  const commitments = String(entries.memory_commitments ?? "");
  assert.doesNotMatch(commitments, /00:50睡觉/);
  assert.match(commitments, /morning briefing/);
});
