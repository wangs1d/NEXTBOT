/**
 * 检索层时序基准（2026-10-19 P2-11）。
 *
 * 此前的时序基准只测结构化事实库的存储语义，测不到检索——而"时间意图加权 /
 * 状态标签 / 实体加分 / 软抑制标注"全部发生在检索层，恰恰是最容易在重构时
 * 被改坏的地方。本文件用 fake Mem0（固定返回候选）+ 真实结构化事实库，
 * 端到端跑 `buildRecallWithContext`，锁四条契约：
 *
 *   ① 点位时序：问"2021 年"，区间重叠的旧事排到现状前面（createdAt 不再骗人）；
 *   ② 现状优先：问"现在"，当前值条目排前且标 [当前]，旧值标 [已失效]；
 *   ③ 实体加分：query 命中档案实体时，含该实体的条目前移；
 *   ④ 软抑制：命中「别再提」的条目仍在结果里，但带 [勿主动提] 标注。
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

process.env.AGENT_MEMORY_REINFORCEMENT_ENABLED = "0"; // 不建强化侧表
process.env.AGENT_MEMORY_RERANK_MODE = "off"; // 基准只测融合排序，不引入 LLM

const { AgenticMemoryRetrievalService } = await import(
  "../src/agentic-memory/retrieval.js"
);
const { StructuredFactStore } = await import(
  "../src/agentic-memory/structured-fact-store.js"
);
const { openAgenticSqlite } = await import("../src/agentic-memory/sqlite-store.js");
const { registerMemoryComponents } = await import("../src/agentic-memory/index.js");
const {
  MemorySuppressionStore,
  setMemorySuppressionStoreForTests,
} = await import("../src/agentic-memory/memory-suppression.js");

interface Hit {
  id: string;
  memory: string;
  score: number;
  metadata?: Record<string, unknown>;
  createdAt?: string;
}

function fakeMemory(hits: Hit[]): { search: () => Promise<{ results: Hit[] }> } {
  return { search: async () => ({ results: hits }) };
}

/** 从召回输出里按出现顺序取出条目文本 */
function orderOf(output: string): string[] {
  return output
    .split("\n\n")
    .map((block) => block.split("\n").slice(1).join("\n").trim())
    .filter(Boolean);
}

async function withBench(
  fn: (ctx: {
    retrieval: InstanceType<typeof AgenticMemoryRetrievalService>;
    facts: InstanceType<typeof StructuredFactStore>;
  }) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "retrieval-temporal-bench-"));
  const facts = new StructuredFactStore(openAgenticSqlite(join(dir, "facts.db")));
  registerMemoryComponents({ factStore: facts });
  try {
    await fn({ retrieval: new AgenticMemoryRetrievalService(fakeMemory([]) as never), facts });
  } finally {
    registerMemoryComponents({ factStore: null });
    setMemorySuppressionStoreForTests(null);
    facts.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
}

function makeRetrieval(hits: Hit[]): InstanceType<typeof AgenticMemoryRetrievalService> {
  return new AgenticMemoryRetrievalService(fakeMemory(hits) as never);
}

test("点位时序：问 2021 年，区间重叠的旧事排到现状前面（createdAt 不再骗人）", async () => {
  await withBench(async ({ facts }) => {
    facts.applyFact({
      actorId: "u1",
      field: "居住地",
      value: "杭州",
      temporal: "past",
      eventTime: "2019-2023",
      confidence: 0.9,
    });
    facts.applyFact({
      actorId: "u1",
      field: "居住地",
      value: "兴义",
      validFrom: "2024-01-01",
      confidence: 0.9,
    });
    // 两条候选基线分：兴义更高（0.8 > 0.75），若不看时间区间它会排第一
    const hits: Hit[] = [
      {
        id: "new",
        memory: "用户住在兴义",
        score: 0.8,
        createdAt: "2026-10-18T00:00:00Z",
        metadata: { factFields: "居住地", factValidFrom: "2024-01-01" },
      },
      {
        id: "old",
        memory: "用户住在杭州",
        score: 0.75,
        createdAt: "2026-10-18T00:00:00Z",
        metadata: { factFields: "居住地", factValidFrom: "2019-01-01", factValidTo: "2023-12-31" },
      },
    ];
    const out = await makeRetrieval(hits).buildRecallWithContext("u1", "2021年我住哪", {
      context: "main",
    });
    const order = orderOf(out);
    assert.match(order[0]!, /杭州/);
    assert.match(order[1]!, /兴义/);
    assert.match(order[0]!, /\[已失效\]/, "旧状态必须带标签");
    assert.match(order[1]!, /\[当前\]/, "现状必须带标签");
  });
});

test("现状优先：问'现在'，当前值排前且标 [当前]", async () => {
  await withBench(async ({ facts }) => {
    facts.applyFact({
      actorId: "u1",
      field: "居住地",
      value: "杭州",
      temporal: "past",
      eventTime: "2019-2023",
      confidence: 0.9,
    });
    facts.applyFact({ actorId: "u1", field: "居住地", value: "兴义", confidence: 0.9 });
    const hits: Hit[] = [
      {
        id: "old",
        memory: "用户住在杭州",
        score: 0.82,
        createdAt: "2026-10-18T00:00:00Z",
        metadata: { factFields: "居住地", factValidFrom: "2019-01-01", factValidTo: "2023-12-31" },
      },
      {
        id: "new",
        memory: "用户住在兴义",
        score: 0.78,
        createdAt: "2026-10-18T00:00:00Z",
        metadata: { factFields: "居住地", factValidFrom: "2024-01-01" },
      },
    ];
    const out = await makeRetrieval(hits).buildRecallWithContext("u1", "我现在住哪", {
      context: "main",
    });
    const order = orderOf(out);
    assert.match(order[0]!, /兴义/);
    assert.match(order[0]!, /\[当前\]/);
    assert.match(order[1]!, /\[已失效\]/);
  });
});

test("实体加分：query 命中档案实体时，含该实体的条目前移", async () => {
  await withBench(async ({ facts }) => {
    facts.applyFact({ actorId: "u1", field: "称呼", value: "王哥", confidence: 0.9 });
    const hits: Hit[] = [
      { id: "plain", memory: "有个用户在群里问了路由问题", score: 0.8, createdAt: "2026-10-18T00:00:00Z" },
      { id: "entity", memory: "王哥的项目用了 React", score: 0.76, createdAt: "2026-10-18T00:00:00Z" },
    ];
    const out = await makeRetrieval(hits).buildRecallWithContext("u1", "王哥在做什么项目", {
      context: "main",
    });
    const order = orderOf(out);
    assert.match(order[0]!, /王哥/);
  });
});

test("软抑制：命中「别再提」的条目仍在结果里，但带 [勿主动提]", async () => {
  await withBench(async () => {
    const suppression = new MemorySuppressionStore();
    suppression.add("u1", "text", "体检报告");
    setMemorySuppressionStoreForTests(suppression);
    const hits: Hit[] = [
      { id: "m1", memory: "用户的体检报告显示甲状腺结节", score: 0.85, createdAt: "2026-10-18T00:00:00Z" },
      { id: "m2", memory: "用户喜欢喝咖啡", score: 0.7, createdAt: "2026-10-18T00:00:00Z" },
    ];
    const out = await makeRetrieval(hits).buildRecallWithContext("u1", "最近健康方面怎么样", {
      context: "main",
    });
    assert.ok(out.includes("勿主动提"), "软抑制是标注不是删除");
    assert.ok(out.includes("甲状腺结节"), "内容仍在，用户问起还要能答");
  });
});

test("无时间词且无实体：排序只由基础分决定（时间因子两侧相同）", async () => {
  await withBench(async () => {
    const hits: Hit[] = [
      { id: "a", memory: "用户喜欢喝咖啡", score: 0.8, createdAt: "2026-10-18T00:00:00Z" },
      { id: "b", memory: "用户养了一只猫", score: 0.7, createdAt: "2026-10-18T00:00:00Z" },
    ];
    const out = await makeRetrieval(hits).buildRecallWithContext("u1", "我喜欢喝什么", {
      context: "main",
    });
    const order = orderOf(out);
    assert.match(order[0]!, /咖啡/);
    assert.ok(!out.includes("[当前]"), "无 factFields 标签时不打状态标");
  });
});
