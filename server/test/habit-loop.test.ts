import assert from "node:assert/strict";
import test from "node:test";

import type { ProactiveOutboundMessageService } from "../src/services/proactive-outbound-message-service.js";
import { HabitMiner } from "../src/services/habit-loop/habit-miner.js";
import { HabitLoopService } from "../src/services/habit-loop/habit-loop-service.js";

/** 捕获型 outbound 桩。 */
function fakeOutbound(sent: Array<Record<string, unknown>>): ProactiveOutboundMessageService {
  return {
    send: async (message: unknown) => {
      sent.push(message as Record<string, unknown>);
      return true;
    },
  } as unknown as ProactiveOutboundMessageService;
}

function hhmm(d: Date): string {
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

test("习惯挖掘：同地点同时段重复到访产出 location_enter 候选", () => {
  const miner = new HabitMiner();
  const base = new Date("2026-08-25T09:05:00").getTime();
  const samples = [0, 1, 2, 3].map((i) => ({
    at: base + i * 3 * 86_400_000,
    latitude: 31.23,
    longitude: 121.47,
    label: "公司",
  }));
  const candidates = miner.mineFromLocation(samples, new Date("2026-09-06T12:00:00"));
  assert.ok(candidates.length >= 1);
  const top = candidates[0];
  assert.equal(top.trigger.kind, "location_enter");
  if (top.trigger.kind === "location_enter") {
    assert.equal(top.trigger.placeLabel, "公司");
  }
  assert.ok(top.confidence > 0.3);
});

test("习惯挖掘：同工具同时段重复使用产出候选，低风险只读工具被跳过", () => {
  const miner = new HabitMiner();
  // 2026-08-21 / 08-28 / 09-04 都是周五 10 点档
  const at = (iso: string) => new Date(iso).getTime();
  const observations = [
    { actorId: "u1", tool: "restaurant.book", at: at("2026-08-21T10:05:00") },
    { actorId: "u1", tool: "restaurant.book", at: at("2026-08-28T10:10:00") },
    { actorId: "u1", tool: "restaurant.book", at: at("2026-09-04T10:15:00") },
    { actorId: "u1", tool: "weather.get_local", at: at("2026-08-21T08:00:00") },
    { actorId: "u1", tool: "weather.get_local", at: at("2026-08-28T08:00:00") },
    { actorId: "u1", tool: "weather.get_local", at: at("2026-09-04T08:00:00") },
  ];
  const candidates = miner.mineFromTools(observations, "u1", new Date("2026-09-06T12:00:00"));
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].trigger.kind, "tool_pattern");
  if (candidates[0].trigger.kind === "tool_pattern") {
    assert.equal(candidates[0].trigger.toolName, "restaurant.book");
  }
});

test("习惯闭环：daily 触发时间窗内提案一次，同日不重复；确认后执行并累计置信度", async () => {
  const sent: Array<Record<string, unknown>> = [];
  const now = new Date("2026-09-06T10:00:00");
  const service = new HabitLoopService({
    outbound: fakeOutbound(sent),
    storeFile: null,
    observationsFile: null,
    now: () => now,
  });
  const rule = await service.createRule({
    actorId: "u1",
    name: "上午喝水提醒",
    trigger: { kind: "daily", time: hhmm(now) },
    action: { kind: "message", text: "该喝水了" },
  });
  assert.equal(rule.authorization, "confirm_each");

  await service.tick();
  assert.equal(sent.length, 1, "时间窗内应提案一次");
  const proposal = sent[0] as { meta?: Record<string, unknown> };
  assert.equal(proposal.meta?.habitRuleId, rule.id);

  // 3 分钟后再次 tick（仍在窗口内）：同日去重，不重复提案
  const later = new Date(now.getTime() + 3 * 60_000);
  (service as unknown as { deps: { now: () => Date } }).deps.now = () => later;
  await service.tick();
  assert.equal(sent.length, 1, "同一天不应重复提案");

  // 用户确认 → 执行 message 动作（第二次外发），置信度上升
  const token = String(proposal.meta?.token ?? "");
  const confirmed = await service.confirmRun("u1", rule.id, token);
  assert.equal(confirmed.ok, true);
  assert.equal(sent.length, 2);
  const rules = await service.listRules("u1");
  assert.equal(rules[0].stats.confirmedCount, 1);
  assert.ok(rules[0].confidence > rule.confidence);
});

test("习惯闭环：auto 授权连续失败 2 次自动降回 confirm_each", async () => {
  const sent: Array<Record<string, unknown>> = [];
  const now = new Date("2026-09-06T10:00:00");
  const service = new HabitLoopService({
    outbound: fakeOutbound(sent),
    storeFile: null,
    observationsFile: null,
    now: () => now,
    toolExecutor: async () => ({ ok: false, result: { error: "模拟失败" } }),
  });
  const rule = await service.createRule({
    actorId: "u1",
    name: "自动任务",
    trigger: { kind: "daily", time: "23:59" }, // 不让 tick 命中，全部走 runNow
    action: { kind: "tool", tool: "clock.now", input: {} },
    authorization: "auto",
    confidence: 0.9,
  });
  const first = await service.runNow("u1", rule.id);
  assert.equal(first.ok, false);
  const second = await service.runNow("u1", rule.id);
  assert.equal(second.ok, false);
  const rules = await service.listRules("u1");
  assert.equal(rules[0].authorization, "confirm_each", "连续失败应降权");
  assert.ok(sent.some((m) => m.title === "习惯「自动任务」已暂停自动执行"));
});

test("习惯闭环：挖掘一键落库默认 confirm_each 且按名称去重", async () => {
  const now = new Date("2026-09-06T12:00:00");
  const service = new HabitLoopService({
    outbound: fakeOutbound([]),
    storeFile: null,
    observationsFile: null,
    now: () => now,
  });
  (service as unknown as { toolObservations: Array<{ actorId: string; tool: string; at: number }> }).toolObservations.push(
    { actorId: "u2", tool: "restaurant.book", at: new Date("2026-08-21T19:05:00").getTime() },
    { actorId: "u2", tool: "restaurant.book", at: new Date("2026-08-28T19:05:00").getTime() },
    { actorId: "u2", tool: "restaurant.book", at: new Date("2026-09-04T19:05:00").getTime() },
  );
  const first = await service.mine("u2", true);
  assert.ok(first.created.length >= 1);
  const second = await service.mine("u2", true);
  assert.equal(second.created.length, 0, "同名同触发不应重复建规则");
  for (const rule of first.created) {
    assert.equal(rule.authorization, "confirm_each");
    assert.equal(rule.source, "mined");
  }
});
