import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { HumanLikeMemoryService } from "../src/services/human-like-memory-service.js";
import { AgentMemorySyncService } from "../src/services/agent-memory-sync-service.js";
import { MemoryManagerService } from "../src/services/memory-manager-service.js";
import { NarrativeMemoryFacade } from "../src/services/narrative-memory-port.js";
import { NightlyMemoryTaskService } from "../src/services/nightly-memory-task-service.js";
import { initDailyJournalService } from "../src/services/daily-journal-service.js";

const ACTOR = "e2e-truth-user";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 跨天端到端：白天一轮对话 → turns 落库 → 夜间固化 → 次日长期记忆可召回。
 * 关键回归点：事实出现在「第二句」也必须进入长期记忆（旧实现只写首句）。
 */
test("跨天固化：第二句里的关键事实也能进入长期记忆", async () => {
  const dir = await mkdtemp(join(tmpdir(), "memory-e2e-"));
  process.env.USER_FACT_STORE_DIR = join(dir, "facts");
  const journal = initDailyJournalService(join(dir, "journal"));

  const humanLike = new HumanLikeMemoryService(
    join(dir, "human.json"),
    join(dir, "policy.json"),
  );
  await humanLike.load();
  const sync = new AgentMemorySyncService(join(dir, "sync.json"));
  await sync.load();
  const narrative = new NarrativeMemoryFacade(null, null, null, humanLike);
  const manager = new MemoryManagerService(
    narrative,
    sync,
    { enabled: true, consolidationIntervalMs: 60_000, profileUpdateThreshold: 99 },
    journal,
  );
  const nightly = new NightlyMemoryTaskService({ enabled: true });
  nightly.setDependencies(manager, sync, narrative);

  try {
    // 关键信息在第二句：旧实现 firstSentence() 会把它截掉
    journal.appendTurn(
      ACTOR,
      "sess-e2e",
      "我住在杭州。另外，我的项目叫 Private-Agent，正在做长期记忆重构。",
      "记住了，你在杭州做 Private-Agent。",
    );
    await sleep(120);

    // 夜间固化（只跑 journal→长期图 这一段，避免测试写生产归档目录）
    await (nightly as unknown as {
      consolidateDailyJournals(actorIds?: string[]): Promise<void>;
    }).consolidateDailyJournals([ACTOR]);

    const nodes = Object.values(
      (humanLike as unknown as { store: { nodes: Record<string, { summary: string }> } }).store.nodes,
    );
    assert.ok(nodes.length > 0, "固化后长期图应有节点");
    assert.ok(
      nodes.some((n) => n.summary.includes("Private-Agent")),
      "第二句中的项目名必须进入长期记忆（旧实现只保留首句，会丢）",
    );

    const pending = await journal.getUnconsolidatedLines(ACTOR);
    assert.equal(pending.length, 0, "固化成功后不应再有 pending 轮次");
  } finally {
    journal.close();
    await humanLike.shutdown();
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});
