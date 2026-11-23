// 常驻通知「完成」按钮的凭据（需求 §5.2）：看板反复重算时 token 要稳定，事项变了才换。
import assert from "node:assert/strict";
import { test } from "node:test";

import { ActionIntentService } from "../src/proactivity/action-intent-service.js";
import { ActionIntentStore } from "../src/proactivity/action-intent-store.js";
import { BoardCompleteActions } from "../src/proactivity/board-complete-actions.js";
import { NOTIFY_ACTION } from "../src/proactivity/notification-actions.js";

const SECRET = "test-secret-board-action";

function harness(now: { value: number }) {
  const svc = new ActionIntentService({
    store: new ActionIntentStore(), // 不落盘：只验签发与缓存
    secret: SECRET,
    nowFn: () => now.value,
  });
  return { svc, issuer: new BoardCompleteActions(svc, () => now.value) };
}

test("同一件下一件事复用同一枚 token：看板重算不产生新意图", () => {
  const now = { value: Date.UTC(2026, 10, 23, 1, 0, 0) };
  const { issuer } = harness(now);
  const first = issuer.completeAction("u1", { taskId: "t1", title: "牙医" });
  const second = issuer.completeAction("u1", { taskId: "t1", title: "牙医" });
  assert.ok(first);
  // token 里编的是 intentId + actionId + 过期时刻：两枚 token 全等 ⇔ 背后是同一条意图，
  // 看板反复重算不会往 action-intents.json 里堆重复条目。
  assert.deepEqual(second, first, "有效期内复用同一枚 token");
  assert.equal(first!.actionId, NOTIFY_ACTION.scheduleComplete);
});

test("事项换了立刻重签：换日程 / 换账号各自一枚", () => {
  const now = { value: Date.UTC(2026, 10, 23, 1, 0, 0) };
  const { issuer } = harness(now);
  const t1 = issuer.completeAction("u1", { taskId: "t1", title: "牙医" });
  const t2 = issuer.completeAction("u1", { taskId: "t2", title: "接孩子" });
  const otherUser = issuer.completeAction("u2", { taskId: "t1", title: "牙医" });
  assert.notEqual(t1!.token, t2!.token);
  assert.notEqual(t1!.token, otherUser!.token);
  assert.equal(issuer.peek("u1")!.label, t2!.label);
});

test("临近过期提前换签，空入参不签", () => {
  const now = { value: Date.UTC(2026, 10, 23, 1, 0, 0) };
  const { issuer } = harness(now);
  const first = issuer.completeAction("u1", { taskId: "t1", title: "牙医" });
  // L0 有效期 24h：推到剩 20 分钟（< 30 分钟提前量）时必须重签，
  // 否则用户按下去拿到的是一枚已过期的 token。
  now.value += 23 * 60 * 60_000 + 40 * 60_000;
  const after = issuer.completeAction("u1", { taskId: "t1", title: "牙医" });
  assert.notEqual(after!.token, first!.token);
  assert.equal(issuer.completeAction("", { taskId: "t1", title: "x" }), null);
  assert.equal(issuer.completeAction("u1", { taskId: "", title: "x" }), null);
});
