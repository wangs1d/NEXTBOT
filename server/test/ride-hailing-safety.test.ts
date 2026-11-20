/**
 * ride_hailing 复合入口的安全语义回归（2026-11-20）。
 *
 * 复合名 `ride_hailing` 本身不含 action 语义：按名硬匹配的安全闸若只看族名，
 * 要么把 quote/status 也拦成高危，要么把 book 放过去。这里锁三件事：
 *  1. checkToolCall 按 action 解析真实执行器名：book → require_approval，quote/status → allow；
 *  2. 两阶段确认白名单能通过复合名命中（limbic 放行依据）；
 *  3. 敏感动作分档：book/cancel → act_external，quote/status → read。
 */
import assert from "node:assert/strict";
import test from "node:test";

const { AgentTaskSafety, TWO_PHASE_CONFIRM_TOOLS } = await import(
  "../src/services/agent-task-safety.js"
);
const { resolveEffectiveToolName } = await import(
  "../src/external-model/composite-chat-tools.js"
);
const { classifyToolSensitivity } = await import("../src/security/sensitive-action.js");

const safety = new AgentTaskSafety();

test("安全闸：ride_hailing 按 action 分档，不按族名连坐", () => {
  assert.equal(safety.checkToolCall("ride_hailing", { action: "book" }).action, "require_approval");
  assert.equal(safety.checkToolCall("ride_hailing", { action: "quote" }).action, "allow");
  assert.equal(safety.checkToolCall("ride_hailing", { action: "status" }).action, "allow");
  assert.equal(safety.checkToolCall("ride_hailing", { action: "cancel" }).action, "allow");

  // 未填 action 的签名兜底同样要能识别下单意图
  assert.equal(
    safety.checkToolCall("ride_hailing", { optionId: "eco", confirm: true, confirmationToken: "t" }).action,
    "require_approval",
  );
  // 历史细分名行为不变
  assert.equal(safety.checkToolCall("ride_hailing.book", {}).action, "require_approval");
});

test("两阶段白名单：复合名归一后命中 ride_hailing.book", () => {
  assert.equal(resolveEffectiveToolName("ride_hailing", { action: "book" }), "ride_hailing.book");
  assert.equal(
    TWO_PHASE_CONFIRM_TOOLS.has(resolveEffectiveToolName("ride_hailing", { action: "book" })),
    true,
  );
  assert.equal(
    TWO_PHASE_CONFIRM_TOOLS.has(resolveEffectiveToolName("ride_hailing", { action: "quote" })),
    false,
  );
});

test("敏感动作分档：ride 下单/取消是外部副作用，报价/查询是只读", () => {
  assert.equal(classifyToolSensitivity("ride_hailing", { action: "book" }), "act_external");
  assert.equal(classifyToolSensitivity("ride_hailing", { action: "cancel" }), "act_external");
  assert.equal(classifyToolSensitivity("ride_hailing", { action: "quote" }), "read");
  assert.equal(classifyToolSensitivity("ride_hailing", { action: "status" }), "read");
});