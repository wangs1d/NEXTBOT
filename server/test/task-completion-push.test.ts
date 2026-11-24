import { test } from "node:test";
import assert from "node:assert/strict";

import type { PushInput } from "../src/proactivity/mobile-push-service.js";
import {
  createTaskCompletionPush,
  taskCompletionPushSummary,
  type MobilePushPort,
} from "../src/services/task-completion-push.js";

function makePush(ok = true): { port: MobilePushPort; inputs: PushInput[] } {
  const inputs: PushInput[] = [];
  const port: MobilePushPort = {
    hasChannel: (actorId) => actorId === "has-push",
    push: async (input) => {
      inputs.push(input);
      return {
        ok,
        provider: "test",
        ...(ok ? {} : { reason: "mock_failure" }),
      };
    },
  };
  return { port, inputs };
}

test("摘要：去代码块 / NEXT_UP 协议块 / Markdown，超长截断", () => {
  const raw = [
    "已帮你订好了。",
    "```json",
    '{"secret": "should-not-leak"}',
    "```",
    "[NEXT_UP_START] 要不要顺带订晚餐？ [NEXT_UP_END]",
    "**明细**：共 #3 项，见 |表格|。",
  ].join("\n");
  const summary = taskCompletionPushSummary(raw);
  assert.match(summary, /已帮你订好了/);
  assert.doesNotMatch(summary, /secret/);
  assert.doesNotMatch(summary, /NEXT_UP/);
  assert.doesNotMatch(summary, /[`#*|]/);
  const long = "很长的任务结果".repeat(40);
  assert.ok(taskCompletionPushSummary(long).length <= 111);
  assert.equal(taskCompletionPushSummary("   "), "点开看看结果");
});

test("在线已 WS 送达 → 不推厂商通知（避免同一结果弹两遍）", () => {
  const { port, inputs } = makePush();
  const push = createTaskCompletionPush(() => port);
  push({
    actorId: "has-push",
    text: "任务结果",
    onlineDelivered: true,
  });
  assert.equal(inputs.length, 0);
});

test("离线且有通道 → 推一次，标题+摘要+kind 正确", () => {
  const { port, inputs } = makePush();
  const push = createTaskCompletionPush(() => port);
  push({
    actorId: "has-push",
    text: "已订好明早 9 点的会议室",
    onlineDelivered: false,
  });
  assert.equal(inputs.length, 1);
  assert.equal(inputs[0]!.title, "任务跑完了");
  assert.equal(inputs[0]!.body, "已订好明早 9 点的会议室");
  assert.equal(inputs[0]!.kind, "task");
  assert.ok(inputs[0]!.deliveryId.startsWith("taskdone_"));
});

test("任务没跑成 → 通知标题区分", () => {
  const { port, inputs } = makePush();
  const push = createTaskCompletionPush(() => port);
  push({
    actorId: "has-push",
    text: "没查到符合条件的航班",
    ok: false,
    onlineDelivered: false,
  });
  assert.equal(inputs[0]!.title, "任务没跑成");
});

test("无推送通道 → 空操作，不影响任务主链路", () => {
  const { port, inputs } = makePush();
  const push = createTaskCompletionPush(() => port);
  assert.doesNotThrow(() =>
    push({ actorId: "no-channel", text: "结果", onlineDelivered: false }),
  );
  assert.equal(inputs.length, 0);
});

test("未配置推送服务 → 空操作", () => {
  const push = createTaskCompletionPush(() => null);
  assert.doesNotThrow(() =>
    push({ actorId: "has-push", text: "结果", onlineDelivered: false }),
  );
});

test("推送失败 → 只调一次，不重试、不入队", async () => {
  const { port, inputs } = makePush(false);
  const push = createTaskCompletionPush(() => port);
  push({
    actorId: "has-push",
    text: "结果",
    onlineDelivered: false,
  });
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.equal(inputs.length, 1, "失败不重试");
});
