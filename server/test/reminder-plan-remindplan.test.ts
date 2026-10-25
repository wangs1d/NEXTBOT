/**
 * reminder.plan 回执透出分级预告计划（remindPlan，2026-10-25）。
 *
 * 服务端分级提醒策略（schedule-reminder-policy）在 createTask 层统一生效，
 * reminder.plan 创建的任务同样会被排上 睡前备忘/起床闹钟/出发预留；
 * 但回执此前不带 remindPlan（calendar.* 带），聊天层模型不知道系统已排好
 * 出发预告，才会说「只响一次」并自创「把提醒挪到 9:20」。根修：回执透出
 * remindPlan，确认轮按 CONFIRM_RECEIPT_INSTRUCTION 一句话转告。
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ScheduleIntentService } from "../src/services/schedule-intent-service.js";
import { ScheduleTaskService } from "../src/services/schedule-task-service.js";
import { registerLifeTools } from "../src/tools/life-tools.js";
import { ToolRegistry, type ToolContext } from "../src/tools/tool-registry.js";

const ctx: ToolContext = { sessionId: "tool-session", userId: "tool-user" };

async function withService<T>(fn: (registry: ToolRegistry) => Promise<T>) {
  const dir = await mkdtemp(join(tmpdir(), "reminder-plan-remindplan-"));
  const prev = process.env.SCHEDULE_TASKS_FILE;
  process.env.SCHEDULE_TASKS_FILE = join(dir, "schedule-tasks.json");
  try {
    const tasks = new ScheduleTaskService();
    const registry = new ToolRegistry();
    // 确定性解析器可脱离 LLM 构造（externalChat=null，parseByRule 先行）
    const intents = new ScheduleIntentService(null);
    registerLifeTools(registry, tasks, intents);
    return await fn(registry);
  } finally {
    if (prev == null) delete process.env.SCHEDULE_TASKS_FILE;
    else process.env.SCHEDULE_TASKS_FILE = prev;
    await rm(dir, { recursive: true, force: true });
  }
}

test("牙医提醒：回执带 remindPlan，出发预告段在列", async () => {
  await withService(async (registry) => {
    const reply = await registry.execute(
      "reminder.plan",
      {
        text: "明天 10:00 提醒我看牙医",
        timezone: "Asia/Shanghai",
      },
      ctx,
    );
    assert.equal(reply.ok, true);
    assert.equal((reply.result as Record<string, unknown>).matched, true);
    const plan = (reply.result as Record<string, unknown>).remindPlan as
      | { summary: string; stages: Array<{ label: string; stage: string }> }
      | undefined;
    assert.ok(plan, "remindPlan 应随回执透出（分级提醒策略对 reminder.plan 同样生效）");
    assert.ok(
      plan.stages.some((s) => s.stage === "depart"),
      "牙医=高代价事项，出发预留段必须已排",
    );
    assert.ok(plan.summary.length > 0);
  });
});

test("trivia 琐事提醒不做分级：回执 remindPlan 为空", async () => {
  await withService(async (registry) => {
    const reply = await registry.execute(
      "reminder.plan",
      {
        text: "明天 14:00 提醒我喝水",
        category: "trivia",
        timezone: "Asia/Shanghai",
      },
      ctx,
    );
    assert.equal(reply.ok, true);
    const plan = (reply.result as Record<string, unknown>).remindPlan;
    assert.equal(plan, undefined);
  });
});
