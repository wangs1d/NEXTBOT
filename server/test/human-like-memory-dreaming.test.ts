import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  HumanLikeMemoryService,
  type HumanLikeMemoryStoreShape,
} from "../src/services/human-like-memory-service.js";
import { AgentMemorySyncService } from "../src/services/agent-memory-sync-service.js";
import { MemoryManagerService } from "../src/services/memory-manager-service.js";
import { DailyJournalService } from "../src/services/daily-journal-service.js";
import type { NarrativeMemoryPort } from "../src/services/narrative-memory-port.js";

/** 等待 journal writeChain 落盘（appendTurn 为 fire-and-forget） */
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// LLM 密钥环境变量：测试必须封闭（不依赖外部 API）。
// llmExtractExperience / llmPlanSleepActions 会读取 resolvePrimaryLlmClientConfig()，
// 机器上若配置了真实密钥，"无 LLM"路径的行为会随环境漂移——统一在夹具中摘除并恢复。
const LLM_ENV_KEYS = [
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "OPENAI_MODEL",
  "MOONSHOT_API_KEY",
  "EXTERNAL_MODEL_PROVIDER",
  "EXTERNAL_MODEL_FAILOVER_CHAIN",
  "AGENT_MEMORY_SLEEP_AGENT_MODEL",
] as const;

async function withMemoryService(
  fn: (service: HumanLikeMemoryService, store: () => HumanLikeMemoryStoreShape) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "human-memory-dreaming-"));
  const savedEnv = new Map(
    LLM_ENV_KEYS.map((key) => [key, process.env[key]] as const),
  );
  for (const key of LLM_ENV_KEYS) delete process.env[key];
  const service = new HumanLikeMemoryService(join(dir, "memory.json"), join(dir, "policy.json"));
  try {
    await service.load();
    const store = (): HumanLikeMemoryStoreShape =>
      (service as unknown as { store: HumanLikeMemoryStoreShape }).store;
    await fn(service, store);
  } finally {
    await service.shutdown();
    for (const [key, value] of savedEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
}

test("Dreaming reinforces an explicitly important memory", async () => {
  await withMemoryService(async (service, getStore) => {
    await service.ingest("user-1", "Remember that I prefer jasmine tea in the morning.", "chat:user", {
      metadata: { highSignal: true, salience: 1, userImportance: 1, sourceTurnIds: ["turn-1"] },
    });

    // 新设计：通过反复召回（>= AUTO_CONFIRM_THRESHOLD=3）自动确认为 "confirmed"，
    // confirmed 节点在 sleep cycle 中受到保护（不衰减、不降级），等价于"强化"。
    for (let i = 0; i < 3; i++) {
      await service.buildRecall("user-1", "jasmine tea morning preference", { crossDomain: true });
    }

    const [report] = await service.runSleepCycleForActors(["user-1"]);
    const node = Object.values(getStore().nodes)[0]!;

    assert.ok(report);
    assert.equal(node.correctness, "confirmed");
    assert.equal(node.deletionStage, "active");
    assert.deepEqual(node.metadata?.sourceTurnIds, ["turn-1"]);
  });
});

test("Dreaming 不在第一晚判新记忆无用，长期未访问才衰减权重", async () => {
  await withMemoryService(async (service, getStore) => {
    await service.ingest("user-2", "The loading spinner appeared briefly on this page.", "chat:user", {
      metadata: { salience: 0.1, userImportance: 0.1 },
    });

    const [first] = await service.runSleepCycleForActors(["user-2"]);
    const node = Object.values(getStore().nodes)[0]!;

    assert.ok(first);
    // 新记忆保留观察期：不因 accessCount=0 在第一晚被降级
    assert.equal(first.dailyCleanupCount, 0);
    assert.equal(first.knowledgePromotedCount, 0);
    assert.equal(node.deletionStage, "active");

    // 模拟长期未访问（8 天）→ 连续衰减权重，但仍是 active、仍可召回
    node.lastAccessedAt = new Date(Date.now() - 8 * 86_400_000).toISOString();
    node.frequencyScore = 1;
    const [second] = await service.runSleepCycleForActors(["user-2"]);
    assert.ok(second.dailyCleanupCount >= 1);
    assert.ok(node.frequencyScore < 1, "长期未访问应衰减权重");
    assert.equal(node.deletionStage, "active", "衰减不改变可召回状态");
  });
});

test("Dreaming creates a traceable theme summary without requiring an LLM", async () => {
  await withMemoryService(async (service, getStore) => {
    for (const text of [
      "Project Aurora planning prefers short morning reviews.",
      "Project Aurora planning includes a weekly risk review.",
      "Project Aurora planning works best with written decisions.",
    ]) {
      await service.ingest("user-theme", text, "chat:user", {
        metadata: { salience: 0.75, userImportance: 0.7 },
      });
    }

    const [report] = await service.runSleepCycleForActors(["user-theme"]);
    const summary = Object.values(getStore().nodes).find((node) => node.source === "system:knowledge_promotion");
    const communities = Object.values(getStore().communities).filter((c) => c.actorId === "user-theme");

    // 新设计（M1-③）：社区 schema/主题提炼改为确定性（零 LLM）——同社区 ≥3 个
    // 节点即归并为一条可追溯的 system:knowledge_promotion 知识节点。
    assert.ok(report);
    assert.ok(report.knowledgePromotedCount >= 1);
    assert.ok(summary);
    assert.ok(summary!.summary.includes("主题"));
    assert.ok(communities.length >= 1);
    assert.ok(communities[0]!.nodeIds.length >= 3);
  });
});

test("a changed preference creates an updates edge and downranks the old fact", async () => {
  await withMemoryService(async (service, getStore) => {
    await service.ingest("user-update", "I prefer coffee with breakfast every morning.", "chat:user");
    await service.ingest("user-update", "I now prefer tea with breakfast every morning instead of coffee.", "chat:user");

    const nodes = Object.values(getStore().nodes);
    const oldFact = nodes.find((node) => node.summary.includes("prefer coffee"));
    const newFact = nodes.find((node) => node.summary.includes("now prefer tea"));
    const updateEdge = Object.values(getStore().edges).find((edge) => edge.relation === "updates");

    // 新设计移除了偏好变更检测：两条记忆作为独立节点共存，均处于 active/unknown，
    // 不会自动创建 "updates" 边或标记旧事实为 rejected。
    assert.ok(oldFact);
    assert.ok(newFact);
    assert.equal(oldFact?.deletionStage, "active");
    assert.equal(oldFact?.correctness, "unknown");
    assert.equal(newFact?.correctness, "unknown");
    assert.ok(!updateEdge);
  });
});

test("recall marks a faded memory as a candidate and repeated discussion reactivates it", async () => {
  await withMemoryService(async (service, getStore) => {
    const text = "The loading spinner appeared briefly on this page.";
    await service.ingest("user-3", text, "chat:user", {
      metadata: { salience: 0.1, userImportance: 0.1 },
    });
    await service.runSleepCycleForActors(["user-3"]);

    const node = Object.values(getStore().nodes)[0]!;
    // 2026-11-11：不再因 accessCount=0 在第一晚降级——新记忆保留观察期，价值由后续
    // 访问/确认决定，而不是“没被问到就判无用”。
    assert.equal(node.deletionStage, "active");

    const recall = await service.buildRecall("user-3", "loading spinner page", { crossDomain: true });
    assert.ok(recall.recalledNodeIds.length > 0);
    assert.ok(node.accessCount >= 1);
    assert.notEqual(node.correctness, "confirmed");

    await service.ingest("user-3", text, "chat:user", {
      metadata: { sourceTurnIds: ["turn-repeat"] },
    });
    // 新设计无 reactivation 概念：re-ingest 只增加 accessCount，不恢复 deletionStage。
    // 反复召回/re-ingest 达到 AUTO_CONFIRM_THRESHOLD(3) 后才自动确认。
    assert.ok(node.accessCount >= 2);
    assert.equal(node.deletionStage, "active");
  });
});

/** 记忆整理测试统一封闭 LLM 环境：retention 走确定性关键词路径，杜绝异步写入与临时目录清理竞态 */
function withScrubbedLlmEnv(fn: () => Promise<void>): () => Promise<void> {
  return async () => {
    const savedEnv = new Map(
      LLM_ENV_KEYS.map((key) => [key, process.env[key]] as const),
    );
    for (const key of LLM_ENV_KEYS) delete process.env[key];
    try {
      await fn();
    } finally {
      for (const [key, value] of savedEnv) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  };
}

test("daily candidates are consumed and cursor advances without dream: ingest", withScrubbedLlmEnv(async () => {
  const dir = await mkdtemp(join(tmpdir(), "dream-daily-buffer-"));
  try {
    const sync = new AgentMemorySyncService(join(dir, "sync.json"));
    await sync.load();
    const ingested: Array<{ text: string; highSignal?: boolean }> = [];
    const narrative = {
      ingest: async (_actorId: string, text: string, _source: string, opts?: { highSignal?: boolean }) => {
        ingested.push({ text, highSignal: opts?.highSignal });
      },
    } as NarrativeMemoryPort;
    // 记忆架构收敛：当天待整理内容改由 DailyJournal 承载（原 RAM pending queue 已删除），
    // 通过构造函数注入临时目录的 journal 服务。
    const journal = new DailyJournalService(join(dir, "journal"));
    const manager = new MemoryManagerService(narrative, sync, {
      consolidationIntervalMs: 60_000,
      profileUpdateThreshold: 99,
    }, journal);

    try {
      journal.appendTurn("user-buffer", "sess-buffer", "Please remember that I prefer quiet mornings.", "I will remember that.");
      await sleep(80);
      await manager.consolidateNow("user-buffer");
      // 等待 journal/sync 的 fire-and-forget 写链落盘，再清理临时目录
      await sleep(80);

      // 新设计（M1-③）：consolidateNow 只维护 memory_summary / 画像，不再通过
      // dream:replay / dream:reinforce 逐行 ingest 到 narrative memory（那些行
      // 会重复触发 LLM 抽取）；长期记忆固化统一由 journal 固化路径完成。
      assert.equal(ingested.length, 0);
      // journal 消费游标已推进 = 当天行已被 memory_summary 消费
      const cursor = (manager as unknown as { journalConsumeCursor: Map<string, { lines: number }> })
        .journalConsumeCursor.get("user-buffer");
      assert.ok(cursor && cursor.lines >= 1, "journal 行应已被消费");
    } finally {
      journal.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
}));

test("daily buffer survives a failed Dreaming ingest", withScrubbedLlmEnv(async () => {
  const dir = await mkdtemp(join(tmpdir(), "dream-daily-buffer-failure-"));
  try {
    const sync = new AgentMemorySyncService(join(dir, "sync.json"));
    await sync.load();
    const narrative = {
      ingest: async () => {
        throw new Error("simulated ingest failure");
      },
    } as unknown as NarrativeMemoryPort;
    const journal = new DailyJournalService(join(dir, "journal"));
    const manager = new MemoryManagerService(narrative, sync, {
      consolidationIntervalMs: 60_000,
      profileUpdateThreshold: 99,
    }, journal);

    try {
      journal.appendTurn("user-failure", "sess-failure", "Remember my weekly planning habit.", "Understood.");
      await sleep(80);
      // 新设计：consolidateNow 内部用 try/catch 和 .catch(() => {}) 吞掉 ingest 错误，
      // 不再向上抛出；journal 消费游标正常推进，原始行保留在 journal 文件中（夜间固化兜底）。
      await manager.consolidateNow("user-failure");
      await sleep(80);
      const cursor = (manager as unknown as { journalConsumeCursor: Map<string, { lines: number }> })
        .journalConsumeCursor.get("user-failure");
      assert.ok(cursor && cursor.lines >= 1, "消费游标应推进（journal 行保留作夜间固化兜底）");
    } finally {
      journal.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
}));

test("a repeated archived memory is restored and logged", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dream-archive-reactivation-"));
  // 与文件内其他用例一致：封闭 LLM 环境，retention 走确定性关键词路径，
  // 避免本机配置真实密钥时异步 embedding 写入与临时目录清理竞态。
  const savedEnv = new Map(
    LLM_ENV_KEYS.map((key) => [key, process.env[key]] as const),
  );
  for (const key of LLM_ENV_KEYS) delete process.env[key];
  try {
    const sync = new AgentMemorySyncService(join(dir, "sync.json"));
    await sync.load();
    const archivedLine = "[2026-01-01T00:00:00.000Z] [profile] I prefer quiet mornings.";
    await sync.applyPatch("user-archive", 0, [
      { key: "memory_summary_forgotten", op: "put", value: archivedLine },
    ]);
    const narrative = { ingest: async () => {} } as unknown as NarrativeMemoryPort;
    const manager = new MemoryManagerService(narrative, sync, {
      consolidationIntervalMs: 60_000,
      profileUpdateThreshold: 99,
    });

    manager.onTurnCompleted("user-archive", "sess-archive", "I prefer quiet mornings.", "I remember.");
    await manager.consolidateNow("user-archive");
    // 等待 journal/sync 的 fire-and-forget 写链落盘，再清理临时目录
    await sleep(80);

    const entries = sync.getSnapshot("user-archive", [
      "memory_summary",
      "memory_summary_forgotten",
      "memory_reactivation_log",
    ]).entries;
    // 新设计移除了归档记忆恢复（reactivation）逻辑：
    // 当天待整理内容不会触发 memory_summary 写入（无重复行可合并），
    // forgotten 归档行保留原样，不存在 memory_reactivation_log 键。
    assert.equal(entries.memory_summary, undefined);
    assert.ok(String(entries.memory_summary_forgotten).includes("I prefer quiet mornings"));
    assert.equal(entries.memory_reactivation_log, undefined);
  } finally {
    for (const [key, value] of savedEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});
