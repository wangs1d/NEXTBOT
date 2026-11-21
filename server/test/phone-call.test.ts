import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { PHONE_BRIDGE_TOOL_NAMES } from "../src/agent/agent-access-mode.js";
import type { AuditService } from "../src/services/audit-service.js";
import {
  PhoneCallCoordinator,
  maskPhoneNumber,
  type PhoneCallSession,
} from "../src/services/phone-call-coordinator.js";
import { buildPhoneCallModule } from "../src/tools/capability-modules/phone-call/index.js";
import { PHONE_CALL_CHAT_TOOLS } from "../src/tools/capability-modules/phone-call/chat-tools.js";
import { registerPhoneCallTools } from "../src/tools/capability-modules/phone-call/handlers.js";
import { reportChatToolDrift } from "../src/tools/chat-tool-drift.js";
import { ToolRegistry } from "../src/tools/tool-registry.js";

/**
 * 电话代办（phone_call.*）P0 全链路回归：
 *   prepare（校验+确认卡）→ 确认门（卡片点击/文本兜底）→ start（桥接拨出）
 *   → finish（结果回填 + 收件箱必达）。
 * 同时锁死安全硬约束：未经确认拒绝、紧急号码/虚拟号拒绝、频控、
 * 同轮去重、禁用即不可见、与虚拟电话/phone.dial 的命名与路由边界。
 */

// ── 测试脚手架 ────────────────────────────────────────────────────────

type BridgeCall = { actorId: string; action: string; params: Record<string, unknown> };

function createHarness(opts: {
  enabled?: boolean;
  now?: Date;
  perNumber24hLimit?: number;
  dialResult?: { ok: boolean; state?: string; error?: string };
} = {}) {
  const currentTime = opts.now ? new Date(opts.now) : new Date("2026-09-18T10:00:00");
  const bridgeCalls: BridgeCall[] = [];
  const pushed: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const auditEvents: Record<string, unknown>[] = [];
  const inboxMessages: Array<Record<string, unknown>> = [];

  const dataDir = join(tmpdir(), `phone-call-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const coordinator = new PhoneCallCoordinator({
    bridge: {
      hasExecutor: () => true,
      invoke: async (actorId, action, params) => {
        bridgeCalls.push({ actorId, action, params });
        return opts.dialResult ?? { ok: true, state: "dialing" };
      },
    },
    pushPort: {
      trySend: (_actorId, data) => {
        pushed.push(JSON.parse(data));
        return true;
      },
    },
    audit: { record: async (event) => void auditEvents.push(event) } as unknown as AuditService,
    inbox: { send: async (input) => void inboxMessages.push(input) },
    dataDir,
    env: {},
    config: {
      enabled: opts.enabled ?? true,
      perNumber24hLimit: opts.perNumber24hLimit ?? 2,
    },
    now: () => new Date(currentTime),
  });

  const tick = (ms: number) => currentTime.setTime(currentTime.getTime() + ms);

  return { coordinator, bridgeCalls, pushed, auditEvents, inboxMessages, tick, currentTime, dataDir };
}

async function prepareAndConfirm(
  coordinator: PhoneCallCoordinator,
  actorId: string,
  input: { number: string; goal: string },
): Promise<Record<string, unknown>> {
  const prepared = await coordinator.prepare(actorId, {
    ...input,
    facts: { 人数: "4", 时间: "周六 19:00" },
    mustAsk: ["是否有包间"],
  });
  assert.equal(prepared.ok, true);
  const callId = String(prepared.callId);
  coordinator.observeCardAction(actorId, {
    cardId: `phone_call_${callId}`,
    actionId: "phone_call_confirm",
    payload: { callId },
  });
  return prepared;
}

// ── 全链路 ────────────────────────────────────────────────────────────

test("P0 全链路：prepare → 卡片点击确认 → start 拨出 → finish 回填（收件箱必达 + 落盘）", async () => {
  const { coordinator, bridgeCalls, pushed, inboxMessages, dataDir } = createHarness();
  const actorId = "user-a";

  // 1. prepare：校验通过，返回确认卡
  const prepared = await coordinator.prepare(actorId, {
    number: "13812345678",
    contactName: "海底捞望京店",
    goal: "预订周六晚 7 点 4 人桌",
    facts: { 人数: "4", 时间: "周六 19:00" },
    mustAsk: ["是否有包间", "是否需要押金"],
  });
  assert.equal(prepared.ok, true);
  const callId = String(prepared.callId);
  assert.equal(prepared.state, "awaiting_confirm");
  assert.equal(prepared.numberMasked, "138****5678");
  const cardMarker = String(prepared.cardMarker);
  assert.match(cardMarker, /\[AGENT_RESULT_CARD_START\]/);
  assert.match(cardMarker, /"phone_call_confirm"/);
  assert.match(cardMarker, /"phone_call_cancel"/);
  assert.match(cardMarker, new RegExp(callId));
  // 确认卡是真实电话明示（话费/真人），不得含明文号码
  assert.match(cardMarker, /真实电话/);
  assert.ok(!cardMarker.includes("13812345678"), "确认卡不得透出明文号码");
  assert.ok(!JSON.stringify(prepared).includes("13812345678"), "工具出参不得透出明文号码");

  // 2. 未确认时 start 被硬拒（确认门）
  const earlyStart = await coordinator.start(actorId, callId, {
    phoneBridgeOnline: true,
    chatUserMessageId: "m1",
  });
  assert.equal(earlyStart.ok, false);
  assert.match(String(earlyStart.reason), /尚未确认/);
  assert.equal(bridgeCalls.length, 0, "未确认不得触达手机桥");

  // 3. 用户点击确认卡（connection.ts 原点调用）
  coordinator.observeCardAction(actorId, {
    cardId: `phone_call_${callId}`,
    actionId: "phone_call_confirm",
    payload: { callId },
  });

  // 4. start：经手机桥拨出（手机端再二次确认）
  const started = await coordinator.start(actorId, callId, {
    phoneBridgeOnline: true,
    chatUserMessageId: "m1",
  });
  assert.equal(started.ok, true);
  assert.equal(started.state, "active");
  assert.equal(started.dialState, "dialing");
  assert.equal(bridgeCalls.length, 1);
  assert.equal(bridgeCalls[0].action, "dial");
  assert.equal(bridgeCalls[0].params.number, "13812345678");
  assert.equal(bridgeCalls[0].params.mode, "direct");

  // 5. status：通话中快照（号码脱敏）
  const status = await coordinator.status(actorId, callId);
  assert.equal(status.state, "active");
  assert.equal(status.confirmed, true);
  assert.equal(status.numberMasked, "138****5678");

  // 6. finish：结果回填（预约成功 + 时间 + 预约号）
  const finished = await coordinator.finish(actorId, {
    callId,
    outcome: "booked",
    detail: "接受电话预订",
    appointmentTime: "2026-09-19 19:00",
    bookingRef: "A1024",
    followUps: ["提前 2 小时确认"],
  });
  assert.equal(finished.ok, true);
  assert.equal(finished.state, "summarized");
  assert.match(String(finished.resultSummary), /预约成功/);
  assert.match(String(finished.resultSummary), /A1024/);
  assert.ok(!String(finished.resultSummary).includes("13812345678"), "结果摘要脱敏");

  // 7. 收件箱必达回执（幂等键 = callId）
  assert.equal(inboxMessages.length, 1);
  assert.match(String(inboxMessages[0].title), /通话回执/);
  assert.equal(inboxMessages[0].messageId, `phone_call_${callId}`);

  // 8. 状态推送（phone_call.* 事件族）
  const types = pushed.map((p) => p.type);
  assert.ok(types.includes("phone_call.status_update"), `应推送 status_update，实际: ${types.join(",")}`);

  // 9. 持久化：会话文件 + 索引
  const saved = JSON.parse(
    await readFile(join(dataDir, "sessions", `${callId}.json`), "utf8"),
  ) as PhoneCallSession;
  assert.equal(saved.state, "summarized");
  assert.equal(saved.outcome, "booked");
  assert.equal(saved.bookingRef, "A1024");
  const index = JSON.parse(await readFile(join(dataDir, "index.json"), "utf8")) as Array<{ callId: string }>;
  assert.ok(index.some((e) => e.callId === callId));
});

test("文本兜底确认：确认卡渲染失败时，严格短语「确认拨打」可解锁 start", async () => {
  const { coordinator, bridgeCalls } = createHarness();
  const actorId = "user-b";
  const prepared = await coordinator.prepare(actorId, { number: "13900001111", goal: "确认明天的订单" });
  const callId = String(prepared.callId);

  await coordinator.start(actorId, callId, { phoneBridgeOnline: true });
  const status = await coordinator.status(actorId, callId);
  assert.equal(status.confirmed, false, "无关文本不产生确认");

  coordinator.observeUserText(actorId, "嗯嗯好的知道了");
  const stillDenied = await coordinator.start(actorId, callId, { phoneBridgeOnline: true });
  assert.equal(stillDenied.ok, false, "非确认短语不得解锁");

  coordinator.observeUserText(actorId, "确认拨打");
  const started = await coordinator.start(actorId, callId, { phoneBridgeOnline: true });
  assert.equal(started.ok, true);
  assert.equal(bridgeCalls.length, 1);
});

test("取消路径：卡片「取消」点击后 start 拒绝，会话收口为 cancelled", async () => {
  const { coordinator } = createHarness();
  const actorId = "user-c";
  const prepared = await coordinator.prepare(actorId, { number: "13711112222", goal: "订座" });
  const callId = String(prepared.callId);

  coordinator.observeCardAction(actorId, {
    cardId: `phone_call_${callId}`,
    actionId: "phone_call_cancel",
    payload: { callId },
  });
  const started = await coordinator.start(actorId, callId, { phoneBridgeOnline: true });
  assert.equal(started.ok, false);
  const status = await coordinator.status(actorId, callId);
  assert.equal(status.state, "cancelled");
});

test("拒绝矩阵：紧急号码 / 6 位虚拟号 / 空号码 / 跨他人会话", async () => {
  const { coordinator, tick } = createHarness();
  const actorId = "user-d";

  const emergency = await coordinator.prepare(actorId, { number: "110", goal: "x" });
  assert.equal(emergency.ok, false);
  assert.match(String(emergency.reason), /紧急/);

  const virtual = await coordinator.prepare(actorId, { number: "123456", goal: "x" });
  assert.equal(virtual.ok, false);
  assert.match(String(virtual.reason), /虚拟/);

  const empty = await coordinator.prepare(actorId, { number: "  ", goal: "x" });
  assert.equal(empty.ok, false);

  // 跨身份访问：A 的会话对 B 不可见（静默时段限制已移除，深夜外呼不再拦截）
  const prepared = await coordinator.prepare(actorId, { number: "13655556666", goal: "x" });
  assert.equal(prepared.ok, true);
  const foreign = await coordinator.status("user-e", String(prepared.callId));
  assert.equal(foreign.ok, false);
});

test("频控：同号码 24h 上限；未拨出的会话不计数", async () => {
  const { coordinator } = createHarness({ perNumber24hLimit: 1 });
  const actorId = "user-f";

  // 第一通：prepare+confirm+start 成功，随后 finish 归档（已拨出，计入频控）
  const first = await prepareAndConfirm(coordinator, actorId, { number: "13511113333", goal: "第一通" });
  const s1 = await coordinator.start(actorId, String(first.callId), { phoneBridgeOnline: true });
  assert.equal(s1.ok, true);
  await coordinator.finish(actorId, { callId: String(first.callId), outcome: "no_answer" });

  // 同号码第二通：被 24h 上限拦截
  const second = await prepareAndConfirm(coordinator, actorId, { number: "13511113333", goal: "第二通" });
  const s2 = await coordinator.start(actorId, String(second.callId), { phoneBridgeOnline: true });
  assert.equal(s2.ok, false);
  assert.match(String(s2.reason), /24 小时|上限/);

  // 未拨出过的号码不受频控限制——换号码可正常走完整链路
  const other = await prepareAndConfirm(coordinator, actorId, { number: "13522224444", goal: "换号码" });
  assert.equal(other.ok, true);
});

test("手机端取消 / 拨号失败如实收口；桥接离线不消费会话", async () => {
  const cancelled = createHarness({ dialResult: { ok: true, state: "cancelled" } });
  {
    const { coordinator } = cancelled;
    const prepared = await prepareAndConfirm(coordinator, "user-g", { number: "13411115555", goal: "x" });
    const started = await coordinator.start("user-g", String(prepared.callId), { phoneBridgeOnline: true });
    assert.equal(started.ok, false);
    assert.match(String(started.error), /手机端确认被取消/);
    const status = await coordinator.status("user-g", String(prepared.callId));
    assert.equal(status.state, "cancelled");
  }

  const failed = createHarness({ dialResult: { ok: false, error: "no_dialer" } });
  {
    const { coordinator } = failed;
    const prepared = await prepareAndConfirm(coordinator, "user-h", { number: "13422226666", goal: "x" });
    const started = await coordinator.start("user-h", String(prepared.callId), { phoneBridgeOnline: true });
    assert.equal(started.ok, false);
    const status = await coordinator.status("user-h", String(prepared.callId));
    assert.equal(status.state, "failed");
  }

  const offline = createHarness();
  {
    const { coordinator } = offline;
    const prepared = await prepareAndConfirm(coordinator, "user-i", { number: "13433337777", goal: "x" });
    const started = await coordinator.start("user-i", String(prepared.callId), { phoneBridgeOnline: false });
    assert.equal(started.ok, false);
    assert.equal(started.retryable, true, "桥接离线应可重试");
    const status = await coordinator.status("user-i", String(prepared.callId));
    assert.equal(status.state, "awaiting_confirm", "离线失败不得消费会话");
  }
});

test("同轮去重：同一 chatUserMessageId 内重复 start 只拨一次", async () => {
  const { coordinator, bridgeCalls } = createHarness();
  const actorId = "user-j";
  const prepared = await prepareAndConfirm(coordinator, actorId, { number: "13311118888", goal: "x" });
  const callId = String(prepared.callId);

  const first = await coordinator.start(actorId, callId, {
    phoneBridgeOnline: true,
    chatUserMessageId: "round-1",
  });
  assert.equal(first.ok, true);
  const second = await coordinator.start(actorId, callId, {
    phoneBridgeOnline: true,
    chatUserMessageId: "round-1",
  });
  assert.equal(second.deduped, true);
  assert.equal(bridgeCalls.length, 1);
});

test("确认 TTL：超时后确认与 start 均被拒，会话作废为 expired", async () => {
  const { coordinator, tick } = createHarness();
  const actorId = "user-k";
  const prepared = await coordinator.prepare(actorId, { number: "13211119999", goal: "x" });
  const callId = String(prepared.callId);

  tick(11 * 60_000); // 越过 10 分钟 TTL
  coordinator.observeCardAction(actorId, {
    cardId: `phone_call_${callId}`,
    actionId: "phone_call_confirm",
    payload: { callId },
  });
  // 迟到的确认点击不被采信，且会把过期会话直接收口为 expired
  const status = await coordinator.status(actorId, callId);
  assert.equal(status.state, "expired");

  const started = await coordinator.start(actorId, callId, { phoneBridgeOnline: true });
  assert.equal(started.ok, false);
  assert.match(String(started.reason ?? started.error), /超时|confirm_timeout/);
  const status2 = await coordinator.status(actorId, callId);
  assert.equal(status2.state, "expired");
});

test("禁用开关：PHONE_CALL_ENABLED=false 时工具不可见、无执行器、无漂移", async () => {
  const disabled = createHarness({ enabled: false });
  const { coordinator } = disabled;
  const mod = buildPhoneCallModule({ phoneCallCoordinator: coordinator });
  assert.equal(mod.chatTools.length, 0);
  assert.equal(mod.intentRules.length, 0);

  const registry = new ToolRegistry();
  mod.register(registry);
  const drift = reportChatToolDrift({
    schemas: mod.chatTools,
    registeredToolNames: registry.list(),
  });
  assert.equal(drift.schemaOnly.length, 0);
  assert.equal(drift.executorOnly.filter((n) => n.startsWith("phone_call.")).length, 0);

  const handler = await coordinator.prepare("user-l", { number: "13111112222", goal: "x" });
  assert.equal(handler.ok, false);
});

test("启用态 schema↔执行器对齐 + 与既有电话命名空间零冲突（两体系分界护栏）", () => {
  const { coordinator } = createHarness();
  const mod = buildPhoneCallModule({ phoneCallCoordinator: coordinator });
  assert.equal(mod.chatTools.length, 6);

  const registry = new ToolRegistry();
  registerPhoneCallTools(registry, { phoneCallCoordinator: coordinator });
  const drift = reportChatToolDrift({
    schemas: mod.chatTools,
    registeredToolNames: registry.list(),
  });
  assert.deepEqual(drift.schemaOnly, [], "schema 有、执行器无");
  assert.deepEqual(
    drift.executorOnly.filter((n) => n.startsWith("phone_call.")),
    [],
    "执行器有、schema 无",
  );

  // 命名即语义：phone_call.* 不得与虚拟电话（agent.phone.* / phone.call_user /
  // phone.ensure_my_number）或设备桥工具（phone.*）共享任何名字
  const names = mod.chatTools.map((t) => (t.type === "function" ? t.function?.name : "")).filter(Boolean) as string[];
  for (const name of names) {
    assert.ok(name.startsWith("phone_call."), `工具名必须落在 phone_call.* 命名空间: ${name}`);
    assert.ok(!PHONE_BRIDGE_TOOL_NAMES.has(name), `与设备桥工具重名: ${name}`);
    assert.ok(!name.startsWith("agent.phone."), `与虚拟电话事件族重名: ${name}`);
    assert.ok(!["phone.call_user", "phone.ensure_my_number", "phone.dial"].includes(name));
  }
  assert.equal(names.length, new Set(names).size, "无内部重名");

  // 路由边界写进 schema：每个工具 description 都点名与虚拟电话/phone.dial 的分界词
  const descriptions = mod.chatTools.map((t) => (t.type === "function" ? t.function?.description ?? "" : "")).join("\n");
  assert.match(descriptions, /虚拟电话/);
  assert.match(descriptions, /phone\.dial/);
  assert.match(descriptions, /phone\.call_user/);
});

test("maskPhoneNumber：常规 11 位 / 带区号 / 短号", () => {
  assert.equal(maskPhoneNumber("13812345678"), "138****5678");
  assert.equal(maskPhoneNumber("+8613812345678"), "861****5678");
  assert.equal(maskPhoneNumber("01088886666"), "010****6666");
  assert.equal(maskPhoneNumber("10086"), "10**86");
});

// ── 通过 ToolRegistry 全链路（handler 层接线校验）─────────────────────

test("注册表接线：registry.execute 走通 prepare→status（ctx 正确解析 actorId）", async () => {
  const { coordinator } = createHarness();
  const registry = new ToolRegistry();
  registerPhoneCallTools(registry, { phoneCallCoordinator: coordinator });

  const ctx = { sessionId: "sess-1", phoneBridgeOnline: true, chatUserMessageId: "m9" };
  const prepared = await registry.execute("phone_call.prepare", {
    number: "13011114444",
    goal: "订花",
  }, ctx);
  assert.equal(prepared.ok, true);
  const callId = (prepared.result as Record<string, unknown>).callId;

  const status = await registry.execute("phone_call.status", { callId }, ctx);
  assert.equal(status.ok, true);
  assert.equal((status.result as Record<string, unknown>).goal, "订花");
});
