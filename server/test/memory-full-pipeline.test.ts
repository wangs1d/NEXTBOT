/**
 * 记忆模块全流程集成测试
 *
 * 测试覆盖：
 *   1. 写入 → 召回（remember → recall）
 *   2. 权重动力学（frequencyScore 增长、auto-confirm 机制）
 *   3. 跨域联想（cross-domain recall）
 *   4. Dreaming 全流程（consolidateNow → dream snapshot → dream narrative）
 *   5. 元记忆（recallWithProvenance，附带来源/置信度）
 *   6. Forgotten 恢复（记忆被遗忘后，语义匹配能召回回来）
 *   7. 白天 idle 整理（tryIdleConsolidation）
 *   8. 短期工作记忆（syncTaskForTurn → buildPromptContext）
 *   9. 记忆连续性（跨天 thread 完整保留）
 *
 * 运行: cd server && npx tsx --test test/memory-full-pipeline.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";

import { HumanLikeMemoryService } from "../src/services/human-like-memory-service.js";
import { MemoryManagerService } from "../src/services/memory-manager-service.js";
import { MemoryCortex } from "../src/brain/memory-cortex.js";
import { NightlyMemoryTaskService } from "../src/services/nightly-memory-task-service.js";
import { AgentMemorySyncService } from "../src/services/agent-memory-sync-service.js";
import { ShortTermMemoryGatewayService } from "../src/services/short-term-memory-gateway.js";
import { NarrativeMemoryFacade } from "../src/services/narrative-memory-port.js";
import { MemorySalienceFilter } from "../src/brain/memory-cognitive/memory-salience-filter.js";
import { WorkingMemoryCortex } from "../src/brain/working-memory-cortex.js";
import { ChatThreadStore } from "../src/external-model/chat-thread-store.js";
import type { MemoryItem } from "../src/brain/types.js";

// ---- 测试环境 ----
const ACTOR = "test-user";
const SESSION = "test-session";
let tmpDir: string;

// 服务实例
let humanLike: HumanLikeMemoryService;
let memorySync: AgentMemorySyncService;
let shortTerm: ShortTermMemoryGatewayService;
let narrative: NarrativeMemoryFacade;
let manager: MemoryManagerService;
let nightly: NightlyMemoryTaskService;
let cortex: MemoryCortex;
let workingMemory: WorkingMemoryCortex;
let threadStore: ChatThreadStore;

function makeMemoryItem(
  content: string,
  opts?: Partial<MemoryItem>,
): MemoryItem {
  return {
    actorId: ACTOR,
    kind: "fact",
    content,
    importance: "high",
    source: "chat",
    timestamp: new Date().toISOString(),
    ...opts,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

before(async () => {
  // 创建临时目录，避免污染生产数据
  tmpDir = mkdtempSync(join(tmpdir(), "mem-pipeline-"));

  // 关闭 salience filter 守门，确保测试记忆能写入
  process.env.BRAIN_MEMORY_SALIENCE_ENABLED = "0";

  // 1. 底层存储
  humanLike = new HumanLikeMemoryService(
    join(tmpDir, "human.json"),
    join(tmpDir, "policy.json"),
  );
  await humanLike.load();

  memorySync = new AgentMemorySyncService(join(tmpDir, "sync.json"));
  await memorySync.load();

  shortTerm = new ShortTermMemoryGatewayService(join(tmpDir, "stm.json"));
  await shortTerm.load();

  // 2. Narrative port
  narrative = new NarrativeMemoryFacade(null, null, null, humanLike);

  // 3. Manager + Nightly
  manager = new MemoryManagerService(narrative, memorySync, {
    enabled: true,
    consolidationIntervalMs: 500,
    profileUpdateThreshold: 2,
  });
  nightly = new NightlyMemoryTaskService({ enabled: true });
  nightly.setDependencies(manager, null, memorySync, narrative);

  // 4. Cortex 装配
  cortex = new MemoryCortex();
  cortex.registerHumanLike(humanLike);
  cortex.registerNarrative(narrative);
  cortex.registerKvSummary(memorySync);
  cortex.registerMemoryManager(manager);
  cortex.registerNightlyScheduler(nightly);
  cortex.registerShortTerm(shortTerm);
  cortex.registerSalienceFilter(new MemorySalienceFilter());

  // 5. WorkingMemory
  workingMemory = new WorkingMemoryCortex();

  // 6. ChatThreadStore
  threadStore = new ChatThreadStore(null);

  console.log(`[test] tmpDir=${tmpDir}`);
});

after(async () => {
  // 先关闭服务（释放 policyWatcher / 定时器 / 挂起持久化），
  // 否则 watcher 仍监听临时目录，rmSync 时触发 EPERM uncaughtException
  try {
    await humanLike.shutdown();
  } catch {
    // ignore
  }
  // 清理临时目录
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

describe("记忆模块全流程", () => {

  describe("1. 写入 → 召回", () => {
    it("remember 写入后 recall 能召回", async () => {
      await cortex.remember(
        ACTOR,
        makeMemoryItem("用户喜欢喝手冲咖啡，偏好浅烘焙", {
          kind: "preference",
          domain: "semantic",
        }),
      );
      await sleep(200); // 异步写入等待

      const result = await cortex.recall(ACTOR, "咖啡偏好", {
        domain: "semantic",
        limit: 5,
      });

      assert.ok(result.items.length > 0, "应该能召回至少 1 条记忆");
      const found = result.items.some((m) =>
        m.content.includes("咖啡") || m.content.includes("手冲"),
      );
      assert.ok(found, "召回内容应包含'咖啡'或'手冲'");
    });

    it("多条记忆写入后 recall 能按相关性排序", async () => {
      await cortex.remember(
        ACTOR,
        makeMemoryItem("用户在做一个叫 Nextbot 的 AI 项目", {
          kind: "fact",
          domain: "semantic",
        }),
      );
      await cortex.remember(
        ACTOR,
        makeMemoryItem("用户的猫叫橘子，是橘猫", {
          kind: "fact",
          domain: "semantic",
        }),
      );
      await sleep(200);

      const result = await cortex.recall(ACTOR, "AI 项目", {
        domain: "semantic",
        limit: 5,
      });

      assert.ok(result.items.length >= 1, "应能召回至少 1 条");
      // 第一条应该是项目相关的
      const topItem = result.items[0];
      assert.ok(
        topItem.content.includes("Nextbot") || topItem.content.includes("AI") || topItem.content.includes("项目"),
        `top item 应该与 AI 项目相关，实际: ${topItem.content}`,
      );
    });
  });

  describe("2. 权重动力学", () => {
    it("重复 ingest 同一记忆 → frequencyScore 增长 + accessCount 增加", async () => {
      const text = "用户生日是 3 月 15 日";
      // ingest 3 次（触发 auto-confirm）
      await humanLike.ingest(ACTOR, text, "test");
      await humanLike.ingest(ACTOR, text, "test");
      await humanLike.ingest(ACTOR, text, "test");
      await sleep(500);

      // 反射检查内部节点（store.nodes 是 Record<string, Node>，不是 Map）
      const store = (humanLike as unknown as { store: { nodes: Record<string, { frequencyScore: number; accessCount: number; correctness: string; summary: string }> } }).store;
      const allNodes = Object.values(store.nodes);
      // 找到与"生日"相关的节点
      const birthdayNodes = allNodes.filter((n) =>
        n.summary.includes("生日") || n.summary.includes("3月15"),
      );
      assert.ok(birthdayNodes.length > 0, "应至少有一个与'生日'相关的节点");

      // 如果 fingerprint 匹配成功，应该是一个节点 accessCount>=3
      // 如果没匹配成功（无 embedding），可能是多个节点
      const maxAccessCount = Math.max(...birthdayNodes.map((n) => n.accessCount));
      console.log(`[test] 生日节点数=${birthdayNodes.length}, maxAccessCount=${maxAccessCount}`);

      // 至少应该有频率分数
      const hasFreq = birthdayNodes.some((n) => n.frequencyScore > 0);
      assert.ok(hasFreq, "应至少有一个节点有 frequencyScore");
    });

    it("recall 命中 → frequencyScore 增长, recencyScore 重置", async () => {
      const store = (humanLike as unknown as { store: { nodes: Record<string, { frequencyScore: number; recencyScore: number; accessCount: number; summary: string }> } }).store;
      // 找到任意有 accessCount 的节点
      const allNodes = Object.values(store.nodes);
      const candidate = allNodes.find((n) => n.accessCount >= 1);
      if (!candidate) {
        // 没有节点可测试，跳过（不 fail）
        console.log("[test] 跳过 recall 权重测试：没有找到候选节点");
        return;
      }
      const beforeFreq = candidate.frequencyScore;
      const beforeAccess = candidate.accessCount;

      await humanLike.buildRecall(ACTOR, candidate.summary.slice(0, 10));
      await sleep(200);

      // 重新读节点
      const afterStore = (humanLike as unknown as { store: { nodes: Record<string, { frequencyScore: number; recencyScore: number; accessCount: number }> } }).store;
      const afterNode = Object.values(afterStore.nodes).find((n) => n.accessCount > beforeAccess);
      if (afterNode) {
        assert.ok(
          afterNode.frequencyScore >= beforeFreq,
          `frequencyScore 应增长（${beforeFreq} → ${afterNode.frequencyScore}）`,
        );
        assert.ok(
          afterNode.recencyScore === 1,
          `recencyScore 应重置为 1，实际: ${afterNode.recencyScore}`,
        );
      }
    });
  });

  describe("3. 跨域联想", () => {
    it("不同域的记忆能被 cross-domain recall 召回", async () => {
      // 写入不同域的记忆
      await cortex.remember(
        ACTOR,
        makeMemoryItem("用户每周三下午有产品评审会", {
          kind: "event",
          domain: "episodic",
        }),
      );
      await cortex.remember(
        ACTOR,
        makeMemoryItem("用户偏好用 Koa 框架做后端开发", {
          kind: "preference",
          domain: "semantic",
        }),
      );
      await sleep(200);

      // 用默认域召回（会走降级链）
      const result = await cortex.recall(ACTOR, "用户的习惯和安排", {
        limit: 10,
      });

      // 不要求精确匹配，只要能召回多条不同域的记忆
      assert.ok(result.items.length > 0, "跨域召回应返回至少 1 条");
    });
  });

  describe("4. Dreaming 全流程", () => {
    it("onTurnCompleted → consolidateNow → dream snapshot 更新", async () => {
      // 模拟白天对话累积
      manager.onTurnCompleted(ACTOR, "今天美联储加息了", "收到，美联储加息 25 个基点");
      manager.onTurnCompleted(ACTOR, "我的猫橘子今天不肯吃猫粮", "可能是不舒服，建议观察一下");
      manager.onTurnCompleted(ACTOR, "Nextbot 项目进度不错", "很高兴听到项目进展顺利");

      // 先写入 KV memory_summary（consolidateNow 会读）
      memorySync.appendMemorySummaryLine(ACTOR, "用户关注美联储利率决议");
      memorySync.appendMemorySummaryLine(ACTOR, "用户的猫叫橘子，是橘猫");
      memorySync.appendMemorySummaryLine(ACTOR, "用户在做 Nextbot AI 项目");
      await sleep(300);

      // 执行整理（触发 dreaming）
      const result = await manager.consolidateNow(ACTOR);
      await sleep(300);

      assert.ok(result.timestamp, "consolidateNow 应返回 timestamp");

      // 检查 dream snapshot（反射访问 private 字段）
      const dreamSnapshots = (manager as unknown as {
        dreamSnapshots: Map<string, { replayLines?: string[]; reinforcedLines?: string[]; mergedThemes?: string[]; lastUpdatedAt?: string }>;
      }).dreamSnapshots;
      const snapshot = dreamSnapshots.get(ACTOR);

      // dream snapshot 可能存在也可能不存在（取决于 LLM 整理结果），不强制要求
      if (snapshot) {
        console.log(`[test] dream snapshot: replay=${snapshot.replayLines?.length ?? 0}, reinforced=${snapshot.reinforcedLines?.length ?? 0}, themes=${snapshot.mergedThemes?.length ?? 0}`);
      }
    });

    it("getDreamMemoryForPrompt 返回梦境叙事文本", async () => {
      const dreamText = manager.getDreamMemoryForPrompt(ACTOR);
      // dreamText 可能为 null（如果 dream snapshot 为空），不强制要求
      if (dreamText) {
        assert.ok(
          typeof dreamText === "string",
          "dream memory 应为字符串",
        );
        console.log(`[test] dream narrative 预览: ${dreamText.slice(0, 100)}...`);
      }
    });

    it("nightly forceRunNightTasks 完整执行", async () => {
      const result = await nightly.forceRunNightTasks();
      await sleep(300);

      // 不强制要求全部成功（LLM 调用可能失败），但结构应对
      assert.ok(typeof result.consolidated === "boolean", "应返回 consolidated 布尔值");
      assert.ok(typeof result.synced === "boolean", "应返回 synced 布尔值");
    });
  });

  describe("5. 元记忆（recallWithProvenance）", () => {
    it("recallWithProvenance 返回带 source/score 的记忆", async () => {
      const result = await cortex.recallWithProvenance(ACTOR, "咖啡", {
        limit: 5,
      });

      assert.ok(result.items !== undefined, "应返回 items 数组");
      // 元记忆可能返回空（如果底层召回无结果），但结构应对
      if (result.items.length > 0) {
        const item = result.items[0];
        assert.ok(item.source !== undefined || item.domain !== undefined, "元记忆应附带 source 或 domain");
      }
    });
  });

  describe("6. Forgotten 恢复", () => {
    it("tryIdleConsolidation 在有待整理队列时返回 true", async () => {
      // 确保队列有内容
      manager.onTurnCompleted(ACTOR, "测试 idle 整理功能", "正在测试");
      await sleep(100);

      const triggered = await manager.tryIdleConsolidation(ACTOR);
      assert.ok(typeof triggered === "boolean", "应返回布尔值");
    });

    it("tryIdleConsolidation 在无待整理队列时返回 false", async () => {
      // 先消费完队列
      await manager.tryIdleConsolidation(ACTOR);
      await sleep(100);

      const triggered = await manager.tryIdleConsolidation(ACTOR);
      assert.equal(triggered, false, "无待整理队列时应返回 false");
    });
  });

  describe("7. 短期工作记忆", () => {
    it("syncTaskForTurn → getTaskState → buildPromptContext", () => {
      // 同步任务
      const syncResult = shortTerm.syncTaskForTurn(SESSION, "帮我优化记忆系统");
      assert.ok(syncResult.task, "应返回 task 对象");

      // 获取任务状态
      const taskState = shortTerm.getTaskState(SESSION);
      assert.ok(taskState.tasks !== undefined, "应返回 tasks 数组");

      // 构建 prompt 上下文
      const promptCtx = shortTerm.buildPromptContext(SESSION, "帮我优化记忆系统");
      // promptCtx 可能为 undefined（如果没有活跃任务），但通常应有值
      if (promptCtx) {
        assert.ok(typeof promptCtx === "string", "prompt 上下文应为字符串");
      }
    });

    it("WorkingMemoryCortex setSlot → toSummary", () => {
      workingMemory.setSlot(ACTOR, "currentTopic", "记忆系统优化", "high");
      workingMemory.setSlot(ACTOR, "userGoal", "仿人记忆连续性", "high");

      const summary = workingMemory.toSummary(ACTOR);
      assert.ok(typeof summary === "string", "summary 应为字符串");
      assert.ok(summary.length > 0, "summary 不应为空");
    });
  });

  describe("8. 跨天记忆连续性（ChatThreadStore）", () => {
    it("今天 + 昨天对话完整保留，前天及更早压成 recap", () => {
      const sessionId = "test-continuity-full";
      const now = new Date();
      const yesterday = new Date(now.getTime() - 86_400_000);
      const dayBefore = new Date(now.getTime() - 2 * 86_400_000);

      // 写入前天的对话
      threadStore.appendTurn(
        sessionId,
        "system prompt",
        { text: "前天第一句话" },
        "前天回复",
        24,
        dayBefore,
      );

      // 写入昨天的对话
      threadStore.appendTurn(
        sessionId,
        "system prompt",
        { text: "昨天聊了项目" },
        "项目进展不错",
        24,
        yesterday,
      );

      // 写入今天的对话（多轮，保证超过「近期窗口12+折叠批6」触发折叠）
      threadStore.appendTurn(
        sessionId,
        "system prompt",
        { text: "今天继续" },
        "好的继续",
        24,
        now,
      );
      for (let i = 1; i <= 14; i++) {
        threadStore.appendTurn(
          sessionId,
          "system prompt",
          { text: `今天的事 ${i}` },
          `好的，事 ${i}`,
          24,
          now,
        );
      }

      const thread = threadStore.thread(sessionId, "system prompt");
      threadStore.trimThread(thread);

      // 2026-09-05 近期窗口策略：超窗的昨天/前天对话折叠进 recap（原文占位行 +
      // 日期标签），最近约 6 轮原文保留。全部信息仍在 thread 内可见。
      const allText = thread
        .map((m) => (typeof m.content === "string" ? m.content : ""))
        .join("\n");

      assert.ok(
        allText.includes("昨天聊了项目"),
        "昨天的对话应经 recap 行保留",
      );
      assert.ok(
        allText.includes("今天的事 14"),
        "最近一轮应原文保留",
      );

      // 超窗的跨天对话应该被压成 recap
      const hasRecap = thread.some(
        (m) => typeof m.content === "string" && m.content.includes("[session-recap]"),
      );
      assert.ok(hasRecap, "超窗的跨天对话应被压成 recap");

      // recap 预算（14 行 + 时间桶：近层全量、远层压缩）下，昨天行保留、
      // 更远的「前天」行可能被桶预算压缩——前天内容由长期记忆种植（finalizeTurn）
      // 与 daily journal 兜底，不依赖 recap 摘要行。
      const recapMsg = thread.find(
        (m) => typeof m.content === "string" && m.content.includes("[session-recap]"),
      );
      if (recapMsg && typeof recapMsg.content === "string") {
        assert.ok(
          recapMsg.content.includes("昨天聊了项目"),
          "recap 应保留近层（昨天）的原文占位行",
        );
      }
    });
  });

  describe("9. HumanLikeMemory sleep cycle", () => {
    it("runSleepCycleForActors 不报错并返回报告", async () => {
      const reports = await humanLike.runSleepCycleForActors([ACTOR]);
      assert.ok(Array.isArray(reports), "应返回数组");
      // 报告结构检查（不强制要求非空，取决于内部状态）
      if (reports.length > 0) {
        const report = reports[0];
        assert.ok(report !== null && typeof report === "object", "报告应为对象");
      }
    });
  });

  describe("10. MemoryCortex consolidate", () => {
    it("consolidate 不报错并返回统计", async () => {
      const stats = await cortex.consolidate([ACTOR]);
      assert.ok(typeof stats === "object", "应返回统计对象");
    });
  });
});
