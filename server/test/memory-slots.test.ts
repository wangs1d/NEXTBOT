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

test("appendMemorySummaryLine 只写 memory_summary，不再镜像进四个结构槽", async () => {
  const service = new AgentMemorySyncService(storePath);

  service.appendMemorySummaryLine("actor-1", "user prefers concise answers");
  service.appendMemorySummaryLine("actor-1", "I will continue following up on this fix");
  service.appendMemorySummaryLine("actor-1", "my project is a Flutter chat context repair");

  await new Promise((resolve) => setTimeout(resolve, 20));

  const { entries } = service.getSnapshot("actor-1", [
    "memory_summary",
    "memory_preferences",
    "memory_commitments",
    "memory_facts",
    "session_recap",
  ]);

  // 2026-11-12 单一写者：长期记忆只由 memory_summary 承载。
  // 偏好/事实/承诺/未闭环各有权威源（structured_facts / commitments），
  // 由关键词正则镜像写一份，正是「比价这类任务内容进画像槽后每轮常驻」的根因。
  assert.match(String(entries.memory_summary ?? ""), /concise answers/);
  for (const key of ["memory_preferences", "memory_commitments", "memory_facts"]) {
    assert.equal(entries[key], undefined, `${key} 不应再有写入者`);
  }
  // 长期记忆行不镜像进 session_recap（短期槽唯一写入者是 appendSessionRecapLine）
  assert.doesNotMatch(String(entries.session_recap ?? ""), /concise answers|continue following up|Flutter/);
});

test("sliceMemoryEntriesToPromptContext：档案槽位不再进 prompt，其余槽位照常", () => {
  const memory = sliceMemoryEntriesToPromptContext({
    memory_preferences: "[2026-07-14T00:00:00Z] [topic:chat] user prefers concise answers",
    memory_facts: "[2026-07-14T00:00:00Z] [topic:project] user is working on a Flutter project",
    memory_commitments: `[${new Date().toISOString()}] [topic:project] agent will continue repairing context retention`,
    memory_open_loops: `[${new Date().toISOString()}] [topic:project] need to verify behavior after 100 messages`,
    session_recap: "[2026-07-14T00:00:00Z] [topic:recap] recently focused on fixing chat memory",
  });

  const prompt = buildLayeredSystemPrompt("base", memory);
  // 2026-11-13：memory_preferences / memory_facts 的读路径下线——它们是档案字段
  // 的**旧副本位**，写入侧 2026-11-12 起已停写。档案字段现在只从权威库
  // structured_facts 经【用户档案·结构化事实】块进上下文（按需注入 +
  // 称呼恒带）。留着读路径等于保留一条「从旧备份复活第二份档案」的通道。
  assert.doesNotMatch(prompt, /偏好：/, "档案副本槽位不应再进 prompt");
  assert.doesNotMatch(prompt, /事实：/, "档案副本槽位不应再进 prompt");
  assert.doesNotMatch(prompt, /user prefers concise answers/);
  assert.doesNotMatch(prompt, /Flutter project/);
  // 其余槽位不受影响
  assert.match(prompt, /待兑现承诺/);
  assert.match(prompt, /未完成事项/);
  assert.match(prompt, /会话回顾/);
});

test("同一 subject 的新旧陈述在 summary 内不产生重复行（替换语义由权威库承担）", async () => {
  const service = new AgentMemorySyncService(storePath);

  service.appendMemorySummaryLine("actor-3", "user prefers concise answers");
  service.appendMemorySummaryLine("actor-3", "user dislikes concise answers");

  await new Promise((resolve) => setTimeout(resolve, 20));

  const summary = String(service.getSnapshot("actor-3", ["memory_summary"]).entries.memory_summary ?? "");
  // 两条都保留在长期记忆里（它们是不同时间的真实陈述）；
  // "偏好以最新为准"由结构化事实库（structured_facts 字段级 supersede）承担，
  // 不再由 KV 槽位做词面替换——那正是跨槽漂移的来源。
  assert.match(summary, /prefers concise answers/);
  assert.match(summary, /dislikes concise answers/);
});

test("档案字段不再写入 memory_facts 槽（唯一权威是 structured_facts）", async () => {
  const service = new AgentMemorySyncService(storePath);

  service.appendMemorySummaryLine("actor-4", "I live in Shanghai");
  service.appendMemorySummaryLine("actor-4", "I live in Beijing");

  await new Promise((resolve) => setTimeout(resolve, 20));

  const { entries } = service.getSnapshot("actor-4", ["memory_summary", "memory_facts"]);
  assert.equal(entries.memory_facts, undefined);
  assert.match(String(entries.memory_summary ?? ""), /Beijing/);
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

test("僵尸承诺在注入前被过滤（槽位已停写，保留读取侧兜底）", () => {
  const now = Date.now();
  const iso = (agoMs: number) => new Date(now - agoMs).toISOString();
  const stale = `[${iso(30 * 24 * 60 * 60 * 1000)}] [topic:consolidate] 承诺：我会在00:50睡觉`;
  const fresh = `[${iso(60 * 60 * 1000)}] [topic:chat] 承诺：明早八点送早报`;
  const kept = dropExpiredCommitmentLines([stale, fresh], now);
  assert.deepEqual(kept, [fresh]);
});
