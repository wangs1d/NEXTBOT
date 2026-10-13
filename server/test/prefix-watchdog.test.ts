/**
 * 前缀看门狗归因契约测试（2026-10-12 P0 根修配套埋点）。
 *
 * 锁定：tools/system 变化必须被归因告警；history 正常增长不算分叉；
 * 冷启动计数；车道各自独立基线（sessionId|stage）。
 */
import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";

import {
  fingerprintRequestHead,
  reportPrefixWatchOutcome,
  getPrefixWatchdogSummary,
  resetPrefixWatchdogForTest,
} from "../src/external-model/prefix-watchdog.js";
import type { ChatCompletionTool } from "openai/resources/chat/completions";

function fnTool(name: string): ChatCompletionTool {
  return {
    type: "function",
    function: { name, description: `d-${name}`, parameters: { type: "object", properties: {} } },
  };
}

function msgs(toolNames: string[], turn: number) {
  const sys = { role: "system" as const, content: `stable-prompt-v1` };
  const history = Array.from({ length: turn }, (_, i) => ({
    role: "user" as const,
    content: `turn ${i + 1}`,
  }));
  return [sys, ...history, { role: "user" as const, content: "当前问题" }];
}

function fp(toolNames: string[], turn: number) {
  return fingerprintRequestHead({ tools: toolNames.map(fnTool), messages: msgs(toolNames, turn) });
}

describe("prefix-watchdog 分段归因", () => {
  beforeEach(() => resetPrefixWatchdogForTest());

  it("冷启动：会话首请求计 cold", () => {
    reportPrefixWatchOutcome({ sessionId: "s1", stage: "main_chat_tools", fingerprint: fp(["a", "b"], 1) });
    const s = getPrefixWatchdogSummary();
    assert.equal(s.cold, 1);
    assert.equal(s.ok, 0);
  });

  it("history 正常增长：计 ok，不告警", () => {
    reportPrefixWatchOutcome({ sessionId: "s2", stage: "main_chat_tools", fingerprint: fp(["a", "b"], 1) });
    reportPrefixWatchOutcome({ sessionId: "s2", stage: "main_chat_tools", fingerprint: fp(["a", "b"], 2) });
    const s = getPrefixWatchdogSummary();
    assert.equal(s.cold, 1);
    assert.equal(s.ok, 1);
    assert.equal(s.toolsChurn, 0);
    assert.equal(s.systemDrift, 0);
  });

  it("tools 落选位移：必须归因 tools-churn（本次根修对应症状）", () => {
    reportPrefixWatchOutcome({ sessionId: "s3", stage: "main_chat_tools", fingerprint: fp(["a", "b", "c"], 1) });
    // 第二轮 b 落选 → [a,c]：修复前 c 前移 → tools 段哈希变化
    reportPrefixWatchOutcome({ sessionId: "s3", stage: "main_chat_tools", fingerprint: fp(["a", "c"], 2) });
    const s = getPrefixWatchdogSummary();
    assert.equal(s.toolsChurn, 1, "tools 段变化必须被归因告警");
  });

  it("system 漂移（冻结失效/variant 翻转）：必须归因 system-drift", () => {
    reportPrefixWatchOutcome({ sessionId: "s4", stage: "main_chat", fingerprint: fp(["a"], 1) });
    // 伪造 system 变化：直接构造不同 system 的指纹
    const bad = fingerprintRequestHead({
      tools: [fnTool("a")],
      messages: [
        { role: "system", content: "stable-prompt-v1-CHANGED" },
        { role: "user", content: "当前问题" },
      ],
    });
    reportPrefixWatchOutcome({ sessionId: "s4", stage: "main_chat", fingerprint: bad });
    const s = getPrefixWatchdogSummary();
    assert.equal(s.systemDrift, 1);
  });

  it("车道各自独立基线：同 session 不同 stage 交替不误报", () => {
    reportPrefixWatchOutcome({ sessionId: "s5", stage: "main_chat_tools", fingerprint: fp(["a", "b"], 1) });
    reportPrefixWatchOutcome({ sessionId: "s5", stage: "task_plane_light", fingerprint: fp(["a", "b", "c"], 1) });
    reportPrefixWatchOutcome({ sessionId: "s5", stage: "main_chat_tools", fingerprint: fp(["a", "b"], 2) });
    const s = getPrefixWatchdogSummary();
    assert.equal(s.cold, 2, "main_chat_tools 与 task_plane_light 各自冷启一次");
    assert.equal(s.toolsChurn, 0, "车道交替不应被误报为 tools 抖动");
  });

  it("指纹分段：tail 变化不影响 history 哈希（动态沉底处天然逐轮变）", () => {
    const f1 = fingerprintRequestHead({
      tools: [fnTool("a")],
      messages: [
        { role: "system", content: "s" },
        { role: "user", content: "旧消息" },
        { role: "user", content: "新问题1" },
      ],
    });
    const f2 = fingerprintRequestHead({
      tools: [fnTool("a")],
      messages: [
        { role: "system", content: "s" },
        { role: "user", content: "旧消息" },
        { role: "user", content: "新问题2（动态注入不同）" },
      ],
    });
    assert.equal(f1.historyHash, f2.historyHash, "history 哈希不含末条 user");
    assert.notEqual(f1.tailHash, f2.tailHash, "tail 哈希捕获动态层变化");
    assert.equal(f1.toolsHash, f2.toolsHash);
    assert.equal(f1.systemHash, f2.systemHash);
  });
});
