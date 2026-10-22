// Muse 对齐端到端（2026-10-22）：对话创建盯梢任务 → 入站消息 → 截止×日历缺口 →
// 行动提案 → 现役仲裁器 delivered。全真实链路（真实工具 handler + 真实日程服务）。
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { registerCalendarTools } from "../src/tools/calendar-tools.js";
import { registerWatchTaskTools } from "../src/tools/watch-task-tools.js";
import { ToolRegistry, type ToolContext } from "../src/tools/tool-registry.js";
import { ScheduleConflictService } from "../src/services/schedule-conflict-service.js";
import { ScheduleTaskService } from "../src/services/schedule-task-service.js";
import { WatchTaskStore, WatchTaskWatcher } from "../src/proactivity/branches/watch-tasks.js";
import { arbitrate, type ArbiterContext } from "../src/proactivity/arbiter.js";
import type { ProactiveProposal } from "../src/proactivity/pipeline-types.js";

const NOW = new Date(2026, 9, 22, 12, 0, 0).getTime();
const ctx: ToolContext = { sessionId: "user-a", userId: "user-a" };

function arbCtx(overrides: Partial<ArbiterContext> = {}): ArbiterContext {
  return {
    now: NOW,
    presence: "active",
    inConversation: false,
    isSuppressed: () => ({ suppressed: false, reason: "" }),
    socialCanTrigger: () => ({ allowed: true, reason: "ok" }),
    ...overrides,
  };
}

test("e2e：对话建盯梢任务 → 消息命中 × 截止缺口 → 「设提醒」提案过仲裁 delivered", async () => {
  const dir = await mkdtemp(join(tmpdir(), "watch-e2e-"));
  process.env.SCHEDULE_TASKS_FILE = join(dir, "s.json");
  try {
    const tasks = new ScheduleTaskService();
    const conflicts = new ScheduleConflictService(tasks);
    const watchStore = new WatchTaskStore({ persistPath: join(dir, "w.json"), nowFn: () => NOW });
    const registry = new ToolRegistry();
    registerCalendarTools(registry, tasks, null as never, conflicts);
    registerWatchTaskTools(registry, watchStore);

    // ① 对话：用户说"帮我盯着学校邮件，有选拔信息就告诉我" → LLM 调 watch.manage
    const created = await registry.execute(
      "watch.manage",
      { action: "create", label: "学校邮件里的选拔信息", keywords: ["选拔", "报名", "截止"] },
      ctx,
    );
    assert.equal(created.result.ok, true);

    // ② 消息树枝入站：选拔通知带截止时间，日历没有这一项（Muse 成名案例形态）
    const proposals: ProactiveProposal[] = [];
    const watcher = new WatchTaskWatcher({
      store: watchStore,
      submitProposal: (p) => proposals.push(p),
      now: () => NOW,
      cooldownMs: 0,
      hasRelatedEntry: (_actor, keywords, startMs, endMs) =>
        tasks.listAllTasks().some((t) => {
          if (t.status !== "active") return false;
          const at = Date.parse(t.nextRunAt ?? t.runAt ?? "");
          if (!Number.isFinite(at) || at < startMs || at > endMs) return false;
          const hay = `${t.title ?? ""} ${t.description}`;
          return keywords.some((k) => hay.includes(k));
        }),
    });
    watcher.handleInbound({
      actorId: "user-a",
      text: "校游泳队新生选拔本周五下午5点前报名，逾期不候",
      platform: "wechat",
    });

    // ③ 行动提案 → 仲裁 → delivered
    assert.equal(proposals.length, 1);
    const p = proposals[0]!;
    assert.ok(p.evidence.includes("calendar_gap"));
    assert.equal(p.confirmAction?.label, "设提醒");
    const decision = arbitrate(p, arbCtx());
    assert.equal(decision.verdict, "delivered", "must+high+在场 → 当场投递");

    // ④ 对照：同一消息在任务暂停后不再触发
    const paused = await registry.execute(
      "watch.manage",
      { action: "pause", taskId: (created.result.taskId as string) },
      ctx,
    );
    assert.equal(paused.result.ok, true);
    watcher.handleInbound({ actorId: "user-a", text: "另一场选拔下周截止报名", platform: "wechat" });
    assert.equal(proposals.length, 1, "暂停的任务不触发");
  } finally {
    delete process.env.SCHEDULE_TASKS_FILE;
    await rm(dir, { recursive: true, force: true });
  }
});
