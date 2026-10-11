/**
 * turn 级幂等单测（2026-10-09 重复回复根源修复，不变量 I5）。
 *
 * 覆盖两道闸：
 *   1. 入口闸 MessageBatchProcessor.submit —— 同一客户端 messageId 只受理一次
 *      （本处理器对处理中到达的新消息是排队各跑一轮的，不拦就会跑两轮回复）；
 *   2. 落库闸 ChatThreadStore.appendTurn —— 同 clientMessageId 的轮次已落库则不再追加。
 */
import test from "node:test";
import assert from "node:assert/strict";

import { MessageBatchProcessor, type BatchedMessage } from "../src/ws/message-batch-processor.js";
import { ChatThreadStore } from "../src/external-model/chat-thread-store.js";

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 10));
}

test("入口闸：同一 messageId 重复投递只受理一次", async () => {
  const processor = new MessageBatchProcessor({ enabled: true });
  const seen: string[] = [];
  const session = "actor-idem-1";
  const msg: Omit<BatchedMessage, "timestamp"> = {
    text: "以后叫我王爷",
    originalMessageId: "client-msg-001",
    userId: session,
  };

  processor.submit(session, msg, async (merged) => {
    seen.push(merged.originalMessageId);
  });
  // 重传：同一条消息再投一次（ack 丢失 / 重连重投形态）
  processor.submit(session, msg, async (merged) => {
    seen.push(merged.originalMessageId);
  });

  await flushMicrotasks();
  assert.deepEqual(seen, ["client-msg-001"]);
});

test("入口闸：不同 messageId 不受影响，各自成轮", async () => {
  const processor = new MessageBatchProcessor({ enabled: true });
  const seen: string[] = [];
  const session = "actor-idem-2";

  processor.submit(
    session,
    { text: "第一条", originalMessageId: "client-msg-A", userId: session },
    async (merged) => {
      seen.push(merged.originalMessageId);
    },
  );
  await flushMicrotasks();
  processor.submit(
    session,
    { text: "第二条", originalMessageId: "client-msg-B", userId: session },
    async (merged) => {
      seen.push(merged.originalMessageId);
    },
  );
  await flushMicrotasks();

  assert.deepEqual(seen, ["client-msg-A", "client-msg-B"]);
});

test("入口闸：批处理关闭（直跑）路径同样幂等", async () => {
  const processor = new MessageBatchProcessor({ enabled: false });
  let calls = 0;
  const session = "actor-idem-3";
  const msg = { text: "在", originalMessageId: "client-msg-C", userId: session };

  processor.submit(session, msg, async () => {
    calls += 1;
  });
  processor.submit(session, msg, async () => {
    calls += 1;
  });

  await flushMicrotasks();
  assert.equal(calls, 1);
});

test("落库闸：同 clientMessageId 的轮次不重复追加", () => {
  const store = new ChatThreadStore(null);
  const session = "actor-idem-persist";
  const systemPrompt = "system";
  const clientMessageId = "client-msg-dup";

  store.appendTurn(
    session,
    systemPrompt,
    { text: "以后叫我王爷" },
    "好的王爷，已经记上啦。",
    undefined,
    undefined,
    clientMessageId,
  );
  store.appendTurn(
    session,
    systemPrompt,
    { text: "以后叫我王爷" },
    "好的王爷，记下了。",
    undefined,
    undefined,
    clientMessageId,
  );

  const thread = store.thread(session, systemPrompt);
  const assistants = thread.filter((m) => m.role === "assistant");
  assert.equal(assistants.length, 1);
  // 落库文本带 [ts:] 时间帧，断言包含关系即可（帧不进用户可见内容）
  assert.match(String(assistants[0]?.content), /好的王爷，已经记上啦。/);
  assert.doesNotMatch(String(assistants[0]?.content), /记下了/);
});

test("落库闸：不同 clientMessageId 正常各落一轮", () => {
  const store = new ChatThreadStore(null);
  const session = "actor-idem-persist-2";
  const systemPrompt = "system";

  store.appendTurn(session, systemPrompt, { text: "第一句" }, "回一", undefined, undefined, "c-1");
  store.appendTurn(session, systemPrompt, { text: "第二句" }, "回二", undefined, undefined, "c-2");

  const thread = store.thread(session, systemPrompt);
  assert.equal(thread.filter((m) => m.role === "assistant").length, 2);
});

test("落库闸：未带 clientMessageId 时保持原行为（老客户端兼容）", () => {
  const store = new ChatThreadStore(null);
  const session = "actor-idem-persist-3";
  const systemPrompt = "system";

  store.appendTurn(session, systemPrompt, { text: "同一句话" }, "回一");
  store.appendTurn(session, systemPrompt, { text: "同一句话" }, "回二");

  const thread = store.thread(session, systemPrompt);
  assert.equal(thread.filter((m) => m.role === "assistant").length, 2);
});
