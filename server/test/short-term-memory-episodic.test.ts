import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { ShortTermMemoryGatewayService, initShortTermMemoryGatewayService } from "../src/services/short-term-memory-gateway.js";
import { MemoryManagerService } from "../src/services/memory-manager-service.js";
import type { NarrativeMemoryPort } from "../src/services/narrative-memory-port.js";

function createService(): ShortTermMemoryGatewayService {
  const dir = mkdtempSync(join(tmpdir(), "stm-episodic-"));
  return new ShortTermMemoryGatewayService(join(dir, "short-term-task-stack.json"));
}

// ===== 会话情景记忆：留档 + 会话内检索 + 指代锚点解析 =====

test("reconcileTaskAfterTurn records faithfulness original turns into episodic ledger", () => {
  const service = createService();
  const sessionId = "epi-record";

  service.reconcileTaskAfterTurn(sessionId, "帮我找刘浩存的照片", "为你找到刘浩存的写真和剧照了。");
  service.reconcileTaskAfterTurn(sessionId, "再找几张高清的", "已补充3张高清剧照给你。");

  const hits = service.searchEpisodic(sessionId, "刘浩存 照片");
  assert.ok(hits.length >= 1, "关键词应命中对应轮次");
  assert.match(hits[0].user, /刘浩存/);
  assert.match(hits[0].assistant, /刘浩存/);
});

test("referent short prompt retrieves the earlier discussed subject by anchor", () => {
  const service = createService();
  const sessionId = "epi-anchor";

  // 早前讨论过"刘浩存"，用户随后发"好想他"（纯指代，无任务锚点）
  service.reconcileTaskAfterTurn(sessionId, "帮我搜刘浩存的照片和写真", "为你整理刘浩存的高清写真集。");
  service.reconcileTaskAfterTurn(sessionId, "还有他的最新动态", "补充了刘浩存最近的新剧动态。");

  const context = service.buildPromptContext(sessionId, "好想他") ?? "";
  assert.match(context, /episodic-memory/);
  assert.match(context, /刘浩存/);
});

test("明确回忆问句只回灌用户原话，不回灌助手整段回答（2026-11-18 回音根修）", () => {
  const service = createService();
  const sessionId = "epi-no-echo";

  // 历史里问过一次，助手回了全量档案（姓名+称呼+年龄+住址）
  service.reconcileTaskAfterTurn(
    sessionId,
    "还记得我叫什么吗",
    "王铭川，大哥，二十岁，家在兴义下午屯九华苑。这还能忘？",
  );

  const context = service.buildPromptContext(sessionId, "记得我叫什么吗") ?? "";
  assert.match(context, /episodic-memory/, "同款问句应命中历史轮次");
  assert.match(context, /U:还记得我叫什么吗/, "用户原话可回灌");
  assert.doesNotMatch(context, /二十岁/, "助手整段回答不得回灌——否则模型会原样复述全量清单");
  assert.match(context, /不要整段复述历史回复/, "回灌纪律应显式告知模型");
});

test("clean topic switch does NOT inject episodic memory (串台保护 + 省 token)", () => {
  const service = createService();
  const sessionId = "epi-switch";

  service.reconcileTaskAfterTurn(sessionId, "帮我找刘浩存的照片", "为你找到刘浩存的写真。");
  service.reconcileTaskAfterTurn(sessionId, "帮我安排下周五去上海的航班", "已为你预订航班信息。");

  const context = service.buildPromptContext(sessionId, "推荐一家北京好吃的火锅") ?? "";
  assert.doesNotMatch(context, /episodic-memory/);
});

test("searchEpisodic returns empty when no lexical hit (零命中零成本)", () => {
  const service = createService();
  const sessionId = "epi-miss";

  service.reconcileTaskAfterTurn(sessionId, "讲讲如何优化MySQL查询", "从索引和慢查询日志讲起。");

  const hits = service.searchEpisodic(sessionId, "量子纠缠");
  assert.equal(hits.length, 0);
});

// ===== 情景记忆 → 长期记忆固化回喂 =====

test("daytime turns are NOT pushed into long-term graph at turn time (白天只写 journal，实时回喂已移除)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "stm-consolidate-"));
  const gateway = await initShortTermMemoryGatewayService(join(dir, "stack.json"));

  const ingested: Array<{ actorId: string; text: string; source: string }> = [];
  const fakeNarrative: Pick<NarrativeMemoryPort, "ingest"> = {
    ingest: async (actorId, text, source) => {
      ingested.push({ actorId, text, source });
    },
  };

  const memoryManager = new MemoryManagerService(fakeNarrative as NarrativeMemoryPort, null, {
    enabled: true,
    onlineConsolidationThreshold: 1,
  });

  const sessionId = "epi-consolidate-session";
  gateway.reconcileTaskAfterTurn(sessionId, "帮我找刘浩存的照片和写真", "为你整理刘浩存的高清写真集。");
  gateway.reconcileTaskAfterTurn(sessionId, "我的项目是用TypeScript做的", "了解，你的项目基于TypeScript。");

  // 记忆架构重构后：白天不再实时回喂长期记忆图（原 ingestEpisodicFactsToLongTerm 已移除，
  // 由当日 journal 承担白天记忆，消除"白天回喂 + 夜晚固化"双写同批事实的串台源）。
  memoryManager.onTurnCompleted(sessionId, sessionId, "", "");
  await new Promise((r) => setTimeout(r, 60));

  const episodicWrites = ingested.filter((w) => w.source === "episodic:consolidate");
  assert.equal(episodicWrites.length, 0, "白天轮末不应再向长期记忆图回喂情景事实");
});