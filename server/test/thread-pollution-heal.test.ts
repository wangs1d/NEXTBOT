/**
 * 「重复设置 / 重复回复」根因回归（2026-10-23）。
 *
 * 现场：真实用户线程（`Nextbot-dev/data/chat-threads.json`）里躺着
 *
 *   user:      你是提醒文案助手。用户让助手到点提醒自己做一件事…（整段内部提示词）
 *   assistant: {"shortTitle":"去游泳","reminderMessage":"到点了，快去游泳吧"}
 *
 * 来源：`ScheduleIntentService` 的两个内部 LLM 调用（解析器 / 文案转写）把**主聊天
 * sessionId** 直接交给 provider，且没置 `ephemeralTurn` → 内部提示词被当用户发言
 * push 进主线程、内部 JSON 被当助手发言落库。于是下一轮主模型：
 *   - 看到「用户要我转写提醒文案」→ 再走一遍提醒流程（重复设置）；
 *   - 或对着那段 JSON 再回应一遍（重复回复）。
 *
 * 本文件锁定三件事：
 *   A. 内部子调用必须 ephemeral + 独立会话键（不再写主线程）；
 *   B. 存量污染的结构性治愈（内部提示词轮剔除 / 相邻重复用户消息合并）；
 *   C. 治愈是幂等的、且不误伤正常对话。
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  countThreadPollution,
  isInternalSubCallPrompt,
  sanitizeThreadPollution,
} from "../src/external-model/chat-thread-pollution.js";
import { ScheduleIntentService } from "../src/services/schedule-intent-service.js";
import type { ExternalChatProvider } from "../src/external-model/types.js";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";

const INTERNAL_PROMPT = [
  "你是提醒文案助手。用户让助手到点提醒自己做一件事，下面是用户原句。",
  "请把它转写成到点时展示的两条文案，用助手（agent）主动提醒用户的口吻：",
  "1. reminderMessage：到点推送文案…",
  "只返回 JSON，不要输出 markdown 或解释：{\"shortTitle\":\"...\",\"reminderMessage\":\"...\"}",
  "用户原句：4分钟后提醒我去游泳",
].join("\n");

function user(text: string, ts?: string): ChatCompletionMessageParam {
  const m = { role: "user", content: text } as ChatCompletionMessageParam;
  if (ts) (m as unknown as Record<string, unknown>)["__ts"] = ts;
  return m;
}
function assistant(text: string): ChatCompletionMessageParam {
  return { role: "assistant", content: text } as ChatCompletionMessageParam;
}

/* ── A. 内部子调用不得落主线程 ─────────────────────────────────── */

test("A1 提醒文案转写走 ephemeral + 独立会话键（不写主聊天线程）", async () => {
  const calls: Array<{ sessionId: string; opts?: Record<string, unknown> }> = [];
  const fake = {
    isEnabled: () => true,
    streamCompletion: async (
      sessionId: string,
      _turn: unknown,
      onDelta?: (d: string) => void,
      _tools?: unknown,
      opts?: Record<string, unknown>,
    ) => {
      calls.push({ sessionId, opts });
      const json = '{"shortTitle":"去游泳","reminderMessage":"到点了，快去游泳吧"}';
      onDelta?.(json);
      return json;
    },
  } as unknown as ExternalChatProvider;

  const svc = new ScheduleIntentService(fake);
  const out = await svc.parse("2378709729@qq.com", "4分钟后提醒我去游泳");
  assert.ok(out, "规则路径应解析出草案");

  assert.ok(calls.length > 0, "应有内部子调用");
  for (const call of calls) {
    assert.equal(call.opts?.ephemeralTurn, true, `内部调用必须 ephemeral：${JSON.stringify(call)}`);
    assert.notEqual(
      call.sessionId,
      "2378709729@qq.com",
      "内部调用不得复用主聊天 sessionId（否则提示词+JSON 会落进用户线程）",
    );
    assert.ok(call.sessionId.startsWith("schedule_"), `应为独立内部会话键，实际 ${call.sessionId}`);
  }
});

/* ── B. 存量污染治愈 ──────────────────────────────────────────── */

test("B1 识别内部子调用提示词，且不误伤正常用户消息", () => {
  assert.equal(isInternalSubCallPrompt(INTERNAL_PROMPT), true);
  assert.equal(
    isInternalSubCallPrompt("你是任务解析器。请把用户句子解析为定时任务 JSON。只返回 JSON，不要输出 markdown 或解释。"),
    true,
  );
  assert.equal(isInternalSubCallPrompt("你是提醒文案助手吗？"), false, "口语提问不是内部指令");
  assert.equal(isInternalSubCallPrompt("4分钟后提醒我去游泳"), false);
  assert.equal(
    isInternalSubCallPrompt("你是AI吗，只返回JSON那种？"),
    false,
    "短句/对话式提问不命中（缺指令体特征）",
  );
});

test("B2 剔除内部子调用轮（用户提示词 + 其后的 JSON 回复），保留正常对话", () => {
  const msgs: ChatCompletionMessageParam[] = [
    user("四分分钟后提醒我去游泳吧", "2026-10-21T09:36:18.311Z"),
    user(INTERNAL_PROMPT),
    assistant('{"shortTitle":"去游泳","reminderMessage":"到点了，快去游泳吧"}'),
    user("今天天气", "2026-10-23T05:58:59.397Z"),
    assistant("今天阴，穿件薄外套就够。"),
  ];
  const r = sanitizeThreadPollution(msgs);
  assert.equal(r.removedInternalCalls, 1);
  assert.equal(r.messages.length, 3);
  assert.ok(
    !r.messages.some((m) => String((m as { content?: string }).content ?? "").includes("提醒文案助手")),
    "内部提示词必须剔除",
  );
  assert.ok(
    !r.messages.some((m) => String((m as { content?: string }).content ?? "").includes("shortTitle")),
    "内部 JSON 回复必须一并剔除",
  );
  assert.equal(String((r.messages[1] as { content?: string }).content), "今天天气");
  assert.equal(String((r.messages[2] as { content?: string }).content), "今天阴，穿件薄外套就够。");
});

test("B3 相邻重复用户消息合并：保留带时间锚的那条", () => {
  const msgs: ChatCompletionMessageParam[] = [
    user("四分分钟后提醒我去游泳吧"), // 旧版重复 push 的无锚副本
    user("四分分钟后提醒我去游泳吧", "2026-10-21T09:36:18.311Z"),
    assistant("好，给你设好了"),
  ];
  const r = sanitizeThreadPollution(msgs);
  assert.equal(r.removedDuplicateUserTurns, 1);
  assert.equal(r.messages.length, 2);
  const kept = r.messages[0] as Record<string, unknown>;
  assert.equal(kept.role, "user");
  assert.equal(kept["__ts"], "2026-10-21T09:36:18.311Z", "应保留带时间锚的那条");
});

test("B4 幂等：二次清洗字节不变、计数为 0", () => {
  const once = sanitizeThreadPollution([
    user(INTERNAL_PROMPT),
    assistant('{"shortTitle":"x","reminderMessage":"y"}'),
    user("a", "2026-10-23T01:00:00.000Z"),
    user("a", "2026-10-23T01:00:00.000Z"),
    assistant("b"),
  ]);
  const twice = sanitizeThreadPollution(once.messages);
  assert.equal(twice.removedInternalCalls, 0);
  assert.equal(twice.removedDuplicateUserTurns, 0);
  assert.deepEqual(twice.messages, once.messages);
});

test("B5 干净线程原引用返回（调用方可据此跳过写回）", () => {
  const msgs = [user("你好", "2026-10-23T01:00:00.000Z"), assistant("你好呀")];
  const r = sanitizeThreadPollution(msgs);
  assert.equal(r.messages, msgs, "无污染时应返回同一数组引用");
  assert.equal(r.removedInternalCalls, 0);
  assert.equal(r.removedDuplicateUserTurns, 0);
});

test("B6 countThreadPollution 与修复结果一致（诊断口径）", () => {
  const msgs = [
    user("x", "2026-10-21T09:36:18.311Z"),
    user(INTERNAL_PROMPT),
    assistant('{"a":1}'),
    user("重复", "2026-10-23T01:00:00.000Z"),
    user("重复", "2026-10-23T01:00:01.000Z"),
  ];
  const counted = countThreadPollution(msgs);
  assert.equal(counted.internalCalls, 1);
  assert.equal(counted.duplicateUserTurns, 1);
});
