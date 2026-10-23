import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ShortTermMemoryGatewayService } from "../src/services/short-term-memory-gateway.js";

// 存储文件放进系统临时目录，避免测试数据散落到仓库（见项目记忆：测试文件统一管理）
const storePath = join(mkdtempSync(join(tmpdir(), "short-term-memory-")), "test-short-term-memory.json");

test("buildPromptContext carries mission, preferences, open loops, and recent context across turns", () => {
  const service = new ShortTermMemoryGatewayService(storePath);
  const sessionId = "session-memory-test";

  service.syncTaskForTurn(sessionId, "continue fixing the Flutter chat context continuity issue");
  service.reconcileTaskAfterTurn(
    sessionId,
    "I prefer concise replies, but please keep fixing the Flutter chat context continuity issue",
    "I will inspect the short-term memory and trimming flow, then continue the fix",
  );

  const promptContext = service.buildPromptContext(sessionId, "continue that fix");
  assert.ok(promptContext);
  assert.match(promptContext!, /current-mission:/);
  assert.match(promptContext!, /session-preferences:/);
  assert.match(promptContext!, /open-loops:/);
  assert.match(promptContext!, /agent-commitments:/);
  assert.match(promptContext!, /recent-context:/);
});

// buildRecallQuery 已在记忆架构重构中删除：长期检索改由 agent/recall-gate.ts
// 白名单门控，query 只用用户原文，不再拼接任务/使命上下文。

test("casual follow-up does not inject stale task context", () => {
  const service = new ShortTermMemoryGatewayService(storePath);
  const sessionId = "session-casual-test";

  service.syncTaskForTurn(sessionId, "continue fixing the memory continuity issue in the agent");
  service.reconcileTaskAfterTurn(
    sessionId,
    "please continue fixing the memory continuity issue in the agent",
    "I will keep working on the memory continuity repair",
  );

  const promptContext = service.buildPromptContext(sessionId, "你在哪");
  // 2026-09-05：incoming-turn 行（当前输入抄送）已删除——无任务延续的闲聊轮
  // 可能没有任何可注入行而返回 undefined，语义上即「零过期上下文注入」。
  if (promptContext) {
    assert.doesNotMatch(promptContext, /current-focus:/);
    assert.doesNotMatch(promptContext, /current-mission:/);
    assert.doesNotMatch(promptContext, /open-loops:/);
  }
});
