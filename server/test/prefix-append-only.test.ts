/**
 * 消息头 append-only 契约（2026-10-22 prefix cache 根治）。
 *
 * 病根（实测）：`tailDynamicContext` 原先拼在**最后一条 user 消息尾部**——本轮请求里
 * 那条 user 带尾巴，落库却是干净版，于是下一轮它作为历史出现时字节已变，隐式前缀
 * 缓存从这条 user 起整段作废（DeepSeek 实测命中量 ≈ system+tools，历史段 0 命中）。
 *
 * 本文件把「上一轮的请求（除尾块外）必须是本轮请求的字节前缀」固化成断言，防止
 * 任何人再把动态内容写回历史消息里。
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  applyPromptCacheMessages,
  applyTailDynamicContext,
} from "../src/external-model/prefix-cache.js";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";

const SYSTEM: ChatCompletionMessageParam = { role: "system", content: "你是私人管家。" };
const TAIL_1 = "【当前时间】2026-10-22 01:30 周四\n【记忆】用户在做 token 治理";
const TAIL_2 = "【当前时间】2026-10-22 01:32 周四\n【记忆】用户在做 token 治理";

function msgJSON(messages: ChatCompletionMessageParam[]): string[] {
  return messages.map((m) => JSON.stringify(m));
}

/** 尾块 = 独立 system 消息（append 形态的最后一条）。 */
function withoutTail(messages: ChatCompletionMessageParam[]): ChatCompletionMessageParam[] {
  const last = messages[messages.length - 1];
  if (last?.role === "system" && String(last.content).startsWith("[system-context]")) {
    return messages.slice(0, -1);
  }
  return messages;
}

test("append 形态：尾块是末尾独立 system 消息，历史消息一个字节都不动", () => {
  const thread: ChatCompletionMessageParam[] = [
    SYSTEM,
    { role: "user", content: "第一问" },
    { role: "assistant", content: "第一答" },
    { role: "user", content: "第二问" },
  ];
  const before = msgJSON(thread);

  const out = applyTailDynamicContext(thread, TAIL_1);

  assert.equal(out.length, thread.length + 1);
  assert.equal(out[out.length - 1]?.role, "system");
  assert.match(String(out[out.length - 1]?.content), /\[system-context\]/);
  assert.match(String(out[out.length - 1]?.content), /用户在做 token 治理/);
  // 历史消息逐字节不变，且原数组未被改写
  assert.deepEqual(msgJSON(out.slice(0, -1)), before);
  assert.deepEqual(msgJSON(thread), before);
});

test("append 形态：多模态 user 消息的 content parts 不被克隆改写", () => {
  const thread: ChatCompletionMessageParam[] = [
    SYSTEM,
    {
      role: "user",
      content: [
        { type: "text", text: "这张图是什么" },
        { type: "image_url", image_url: { url: "https://example.com/a.png" } },
      ],
    } as ChatCompletionMessageParam,
  ];
  const out = applyTailDynamicContext(thread, TAIL_1);
  assert.deepEqual(msgJSON(out.slice(0, -1)), msgJSON(thread));
});

test("跨轮前缀性质：上一轮请求（去掉尾块）是本轮请求的严格前缀", () => {
  // 第 1 轮：线程 [sys, u1]
  const r1 = applyPromptCacheMessages(
    [SYSTEM, { role: "user", content: "第一问" }],
    [SYSTEM],
    TAIL_1,
  );
  // 第 2 轮：线程追加了 a1 与 u2（模拟落库后的干净历史）
  const r2 = applyPromptCacheMessages(
    [
      SYSTEM,
      { role: "user", content: "第一问" },
      { role: "assistant", content: "第一答" },
      { role: "user", content: "第二问" },
    ],
    [SYSTEM],
    TAIL_2,
  );

  const prev = withoutTail(r1);
  const prevJSON = msgJSON(prev);
  const curJSON = msgJSON(r2);
  assert.ok(
    curJSON.length > prevJSON.length,
    `本轮应更长：prev=${prevJSON.length} cur=${curJSON.length}`,
  );
  assert.deepEqual(
    curJSON.slice(0, prevJSON.length),
    prevJSON,
    "上一轮请求必须逐字节成为本轮前缀，否则前缀缓存从分叉处全废",
  );
  // 尾块内容每轮不同，但不影响上面的前缀（它恒在末尾）
  assert.notEqual(r1[r1.length - 1]?.content, r2[r2.length - 1]?.content);
});

test("inline 回滚通道：AGENT_TAIL_CONTEXT_MODE=inline 时仍拼回 user 尾部", () => {
  const prev = process.env.AGENT_TAIL_CONTEXT_MODE;
  process.env.AGENT_TAIL_CONTEXT_MODE = "inline";
  try {
    const thread: ChatCompletionMessageParam[] = [
      SYSTEM,
      { role: "user", content: "第一问" },
    ];
    const out = applyTailDynamicContext(thread, TAIL_1);
    assert.equal(out.length, thread.length, "inline 形态不新增消息");
    assert.match(String(out[1]?.content), /第一问[\s\S]*\[system-context\]/);
  } finally {
    if (prev === undefined) delete process.env.AGENT_TAIL_CONTEXT_MODE;
    else process.env.AGENT_TAIL_CONTEXT_MODE = prev;
  }
});
