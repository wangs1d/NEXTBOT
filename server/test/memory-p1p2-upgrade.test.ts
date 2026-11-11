/**
 * P1/P2 记忆架构升级回归（2026-11-11）。
 *
 * 覆盖：
 *   P1-1 统一信号规则：fact/prefer/commit 判定只有一个来源（memory-signal-rules）
 *   P1-2 近重复合并：措辞微调的重述合并到旧节点；不同实体不被误并
 *   P1-3 召回注入预算：按字符预算截断，避免长记忆吃光 prompt
 *   P2-1 双时态：新节点有 validFrom；被新断言覆盖的旧值写入 validTo
 *
 * 全部离线：临时目录 + 摘除 embedding 环境变量（向量通道不可用时走指纹/词面通道）。
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  HumanLikeMemoryService,
  type MemoryNodeRecord,
  type HumanLikeMemoryStoreShape,
} from "../src/services/human-like-memory-service.js";
import { classifyMemorySentence } from "../src/services/memory-signal-rules.js";

const LLM_ENV_KEYS = [
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "OPENAI_MODEL",
  "OPENAI_EMBEDDINGS_MODEL",
  "AGENT_EMBEDDING_API_KEY",
  "AGENT_EMBEDDING_BASE_URL",
  "OPENAI_EMBEDDINGS_URL",
  "MOONSHOT_API_KEY",
  "EXTERNAL_MODEL_PROVIDER",
  "EXTERNAL_MODEL_FAILOVER_CHAIN",
] as const;

async function withMemoryService(
  fn: (service: HumanLikeMemoryService, store: () => HumanLikeMemoryStoreShape) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "memory-p1p2-"));
  const savedEnv = new Map(LLM_ENV_KEYS.map((key) => [key, process.env[key]] as const));
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

test("P1-1 统一信号规则：事实/偏好/承诺判定同源", () => {
  // 旧 STM 规则缺「我叫 / 我在X工作」，与 journal 判定漂移；统一后两者一致
  assert.equal(classifyMemorySentence("我叫张三", "user"), "fact");
  assert.equal(classifyMemorySentence("我在字节上班工作", "user"), "fact");
  assert.equal(classifyMemorySentence("我喜欢喝美式", "user"), "prefer");
  assert.equal(classifyMemorySentence("我会在周五前给你答复", "assistant"), "commit");
  assert.equal(classifyMemorySentence("今天天气不错", "user"), null);
});

test("P1-2 近重复合并：措辞微调合并，不同实体不合并", async () => {
  await withMemoryService(async (service, store) => {
    const actor = "p1p2-near-dup";
    const id = (await service.ingest(actor, "我在杭州一家互联网公司做后端开发", "chat:user"))!;
    const node = store().nodes[id]!;
    // 模拟已向量化节点（离线环境没有 embedding 端点）
    node.vectorFingerprint = JSON.stringify([1, 0, 0]);

    const find = (
      service as unknown as {
        findNearDuplicateNode: (
          actorId: string,
          domainId: string,
          kind: MemoryNodeRecord["kind"],
          summary: string,
          vector: number[],
        ) => MemoryNodeRecord | undefined;
      }
    ).findNearDuplicateNode.bind(service);

    assert.equal(
      find(actor, node.domainId, node.kind, "我在杭州一家互联网公司做后端开发工程师", [1, 0, 0])?.id,
      id,
      "措辞微调（多了“工程师”）应合并到旧节点",
    );
    assert.equal(
      find(actor, node.domainId, node.kind, "我对花生过敏，吃了会起疹子", [1, 0, 0]),
      undefined,
      "不同事实（花生 vs 芒果/职业）不得被向量相似度误并",
    );
  });
});

test("P1-3 召回注入预算：超预算候选被截断", async () => {
  await withMemoryService(async (service, store) => {
    const actor = "p1p3-budget";
    await service.ingest(actor, "我的项目用React做前端界面并且部署在云服务器上", "chat:user");
    await service.ingest(actor, "我的项目用Go写后端接口并且连接了PostgreSQL数据库", "chat:user");
    await service.ingest(actor, "我的项目用Python做数据分析并且每周生成报表文件", "chat:user");

    process.env.AGENT_RECALL_CHAR_BUDGET = "150";
    try {
      const result = await service.buildRecall(actor, "我的项目", { crossDomain: true });
      assert.ok(result.recalledNodeIds.length >= 1, "至少注入 1 条（最高分不能被预算自我淘汰）");
      const total = result.recalledNodeIds.reduce(
        (sum, id) => sum + (store().nodes[id]?.summary.length ?? 0),
        0,
      );
      assert.ok(total <= 150, `预算外的候选不应注入，实际注入 ${total} 字`);
    } finally {
      delete process.env.AGENT_RECALL_CHAR_BUDGET;
    }
  });
});

test("P2-1 双时态：新节点写入 validFrom，被覆盖的旧值关闭 validTo", async () => {
  await withMemoryService(async (service, store) => {
    const actor = "p2-1-bitemporal";
    const oldId = (await service.ingest(actor, "[日志固化 2026-11-11 ·用户] 我的老婆是景甜", "chat:user"))!;
    const oldNode = store().nodes[oldId]!;
    assert.ok(oldNode.validFrom, "新节点必须有 effective-from");
    assert.equal(oldNode.validTo, null, "当前有效的事实不应有 validTo");

    await service.ingest(actor, "[日志固化 2026-11-11 ·用户] 我的老婆是刘浩存", "chat:user");
    const superseded = store().nodes[oldId]!;
    assert.ok(superseded.validTo, "被新断言覆盖的旧值必须写入 validTo");
    assert.ok(
      Date.parse(superseded.validTo!) <= Date.now(),
      "validTo 必须是已经过去的失效时刻",
    );
  });
});
