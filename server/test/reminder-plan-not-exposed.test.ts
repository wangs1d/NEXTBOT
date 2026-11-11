/**
 * 分级预告计划**不进模型可见回执**（2026-11-05 用户定调）。
 *
 * 历史：2026-10-25 为了让聊天层知道「另有提前提醒」，calendar.create 回执透出了
 * remindPlan（stages 含 label / fireAtLocal），确认轮又要求「把预告段转告用户」。
 * 结果真机出现「系统自己配了三级提醒：今晚 21:00 睡前备忘、明早 9:00 起床闹钟、
 * 10:00 提醒你该出门了」——用户看到的是后台旁白。
 *
 * 现口径：分级计划纯属内部编排，不告诉用户。回执只留 hasAdvanceReminder 布尔
 * （唯一用途：别让模型说「只响一次」），label / 触发时刻一律不出服务端。
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ScheduleIntentService } from "../src/services/schedule-intent-service.js";
import { ScheduleTaskService } from "../src/services/schedule-task-service.js";
import { registerCalendarTools } from "../src/tools/calendar-tools.js";
import { ToolRegistry, type ToolContext } from "../src/tools/tool-registry.js";

const ctx: ToolContext = { sessionId: "tool-session", userId: "tool-user" };

async function withService<T>(fn: (registry: ToolRegistry) => Promise<T>) {
  const dir = await mkdtemp(join(tmpdir(), "reminder-plan-not-exposed-"));
  const prev = process.env.SCHEDULE_TASKS_FILE;
  process.env.SCHEDULE_TASKS_FILE = join(dir, "schedule-tasks.json");
  try {
    const tasks = new ScheduleTaskService();
    const registry = new ToolRegistry();
    const intents = new ScheduleIntentService(null);
    registerCalendarTools(registry, tasks, intents);
    return await fn(registry);
  } finally {
    if (prev == null) delete process.env.SCHEDULE_TASKS_FILE;
    else process.env.SCHEDULE_TASKS_FILE = prev;
    await rm(dir, { recursive: true, force: true });
  }
}

test("牙医提醒：回执不透出分级计划，只留 hasAdvanceReminder", async () => {
  await withService(async (registry) => {
    const reply = await registry.execute(
      "calendar", {
      action: "create",
      text: "明天 10:00 提醒我看牙医", timezone: "Asia/Shanghai" },
      ctx,
    );
    assert.equal(reply.ok, true);
    const result = reply.result as Record<string, unknown>;
    assert.equal(result.matched, true);

    // 分级计划的任何形态都不得进入模型可见回执
    assert.equal(result.remindPlan, undefined, "remindPlan 不得再随回执透出");
    const serialized = JSON.stringify(result);
    for (const leak of ["睡前备忘", "起床闹钟", "该出门了", "fireAtLocal"]) {
      assert.ok(
        !serialized.includes(leak),
        `回执里不得出现分级计划内容：${leak}（模型看见就会念给用户）`,
      );
    }

    // 唯一保留的内部事实：另有提前提醒（防「只响一次」）
    assert.equal(result.hasAdvanceReminder, true, "牙医=高代价事项，应存在提前提醒");
  });
});

test("trivia 琐事提醒不做提前提醒：hasAdvanceReminder 不为 true", async () => {
  await withService(async (registry) => {
    const reply = await registry.execute(
      "calendar", {
      action: "create",
      text: "明天 14:00 提醒我喝水", category: "trivia", timezone: "Asia/Shanghai" },
      ctx,
    );
    assert.equal(reply.ok, true);
    const result = reply.result as Record<string, unknown>;
    assert.equal(result.remindPlan, undefined);
    assert.notEqual(result.hasAdvanceReminder, true);
  });
});

test("回执的时间是口语说法，不是 11/6 11:00（2026-11-05 活人感）", async () => {
  await withService(async (registry) => {
    const reply = await registry.execute(
      "calendar", {
      action: "create",
      text: "明天 10:00 提醒我看牙医", timezone: "Asia/Shanghai" },
      ctx,
    );
    const result = reply.result as Record<string, unknown>;
    // 机器格式不再进回执：模型看到 `11/6 10:00` 只会照抄成「明天 10:00 会提醒你」
    assert.equal(result.nextRunAtLocal, undefined, "nextRunAtLocal 不得再进模型可见回执");
    assert.equal(typeof result.whenSpoken, "string");
    assert.equal(result.whenSpoken, "明天上午十点");
    assert.ok(!String(result.whenSpoken).includes(":"), "口语说法里不该有冒号钟点");
    assert.ok(!String(result.whenSpoken).includes("/"), "口语说法里不该有斜杠日期");
  });
});

test("提前提醒只给枚举事实，不给任何成句台词（2026-11-05 二次定调）", async () => {
  await withService(async (registry) => {
    const reply = await registry.execute(
      "calendar", {
      action: "create",
      text: "明天 10:00 提醒我看牙医", timezone: "Asia/Shanghai" },
      ctx,
    );
    const result = reply.result as Record<string, unknown>;
    // 用户原话：『advanceHint: 到点前还会再提醒你一次』这种也算硬编码——
    // 服务端只说事实（有哪种提前提醒），怎么说是 agent 的事。
    assert.equal(result.advanceHint, undefined, "成句台词不得再下发");
    assert.deepEqual(
      [...((result.advanceReminderKinds as string[]) ?? [])].sort(),
      ["departure", "evening_before"],
      "只报性质枚举：前一晚会有一次、出发前会有一次",
    );
    const kinds = result.advanceReminderKinds as string[];
    for (const k of kinds) {
      assert.match(k, /^[a-z_]+$/, "只能是机器枚举，不能是给人念的句子");
    }
    const dump = JSON.stringify(result.advanceReminderKinds);
    assert.ok(!/[\u4e00-\u9fa5]/.test(dump), "事实字段里不得出现中文成句");
    assert.ok(!/\d/.test(dump), "事实字段里不得含数字（时刻/级数）");
    assert.ok(!dump.includes("闹钟"), "起床闹钟段已停用，不该再出现");
  });
});
