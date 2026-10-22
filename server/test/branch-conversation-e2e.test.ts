// 端到端对话验证（2026-10-22 树状架构）：「实际对话中是否会得到消息」。
//
// 全真实链路（零 mock 服务，仅外部模型缺省=模板直投）：
//   ① 用户对助手说"帮我导入课表" → LLM 调 calendar.batch_create（真实工具 handler）
//      → 上传树枝挂点：事实主张版本链入库（≥3 条或显式 sourceName）
//   ② 消息树枝入站："老师说明天高数的课取消了" → MessageHub 回调链
//      → AssertionConflictWatcher（零 LLM 冲突检测）→ 主动提案
//   ③ 提案过现役仲裁器（arbiter）→ delivered = 真实开口
//   ④ 对照组：没有上传过课表时，同样的话不触发（宁漏不误）
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { registerCalendarTools } from "../src/tools/calendar-tools.js";
import { ToolRegistry, type ToolContext } from "../src/tools/tool-registry.js";
import { ScheduleConflictService } from "../src/services/schedule-conflict-service.js";
import { ScheduleTaskService } from "../src/services/schedule-task-service.js";
import { ScheduleAssertionStore } from "../src/proactivity/branches/schedule-assertion-store.js";
import { AssertionConflictWatcher } from "../src/proactivity/branches/assertion-conflict-watcher.js";
import { arbitrate, type ArbiterContext } from "../src/proactivity/arbiter.js";
import type { ProactiveProposal } from "../src/proactivity/pipeline-types.js";

const NOW = new Date(2026, 9, 22, 12, 0, 0).getTime(); // 2026-10-22 正午
const DAY = 24 * 3600_000;
const iso = (ms: number) => new Date(ms).toISOString();
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

test("e2e：上传课表 → 对话消息撞出冲突 → 主动提案过仲裁 delivered", async () => {
  const dir = await mkdtemp(join(tmpdir(), "branch-e2e-"));
  process.env.SCHEDULE_TASKS_FILE = join(dir, "schedule-tasks.json");
  try {
    const tasks = new ScheduleTaskService();
    const conflicts = new ScheduleConflictService(tasks);
    const assertionStore = new ScheduleAssertionStore({
      persistPath: join(dir, "assertions.json"),
      nowFn: () => NOW,
    });
    const registry = new ToolRegistry();
    registerCalendarTools(registry, tasks, null as never, conflicts, undefined, assertionStore);

    // ① 用户上传课表（对话内 LLM 已解析成结构化条目——此处直接走真实工具）
    const upload = await registry.execute(
      "calendar.batch_create",
      {
        sourceName: "我的课表",
        timezone: "Asia/Shanghai",
        items: [
          { description: "高等数学", runAt: iso(NOW + 2 * DAY), durationMinutes: 90 },
          { description: "大学英语", runAt: iso(NOW + 3 * DAY), durationMinutes: 60 },
          { description: "数据结构", runAt: iso(NOW + 4 * DAY), durationMinutes: 90 },
        ],
      },
      ctx,
    );
    assert.equal(upload.result.ok, true);
    const rows = upload.result.results as Array<Record<string, unknown>>;
    const assertionRow = rows.find((r) => r.assertionDocument);
    assert.ok(assertionRow, "上传树枝挂点应产出主张入库回执");
    assert.equal(assertionRow?.assertionVersion, 1);

    // ② 消息树枝入站（MessageHub 落库后的 onInbound 回调输入）
    const proposals: ProactiveProposal[] = [];
    const watcher = new AssertionConflictWatcher({
      store: assertionStore,
      submitProposal: (p) => proposals.push(p),
      now: () => NOW,
      cooldownMs: 0, // e2e 不测冷却
    });
    watcher.handleInbound({
      actorId: "user-a",
      text: "老师说明天高等数学的课取消了，具体补课时间另行通知",
      platform: "wechat",
    });

    // ③ 冲突提案 → 现役仲裁器 → delivered（真实开口）
    assert.equal(proposals.length, 1);
    const p = proposals[0]!;
    assert.equal(p.kind, "action.schedule_conflict");
    assert.equal(p.subject, "高等数学");
    assert.ok(p.directText?.includes("高等数学"), "直投文案点名课程");
    assert.ok(p.directText?.includes("要我帮你改日程或撤掉提醒吗"), "带行动问句");
    const decision = arbitrate(p, arbCtx());
    assert.equal(decision.verdict, "delivered", "high+must+在场 → 当场投递");
  } finally {
    delete process.env.SCHEDULE_TASKS_FILE;
    await rm(dir, { recursive: true, force: true });
  }
});

test("e2e 对照：没上传过课表，同样的消息不触发（宁漏不误）", async () => {
  const dir = await mkdtemp(join(tmpdir(), "branch-e2e-ctl-"));
  const assertionStore = new ScheduleAssertionStore({
    persistPath: join(dir, "assertions.json"),
    nowFn: () => NOW,
  });
  const proposals: ProactiveProposal[] = [];
  const watcher = new AssertionConflictWatcher({
    store: assertionStore,
    submitProposal: (p) => proposals.push(p),
    now: () => NOW,
  });
  watcher.handleInbound({ actorId: "user-a", text: "老师说明天高等数学的课取消了" });
  watcher.handleInbound({ actorId: "user-a", text: "你的验证码是 882311，请勿泄露" });
  assert.equal(proposals.length, 0);
  await rm(dir, { recursive: true, force: true });
});

test("e2e 版本链：重传改过的课表 → 新主张入库，冲突匹配只认新版时段", async () => {
  const dir = await mkdtemp(join(tmpdir(), "branch-e2e-v2-"));
  process.env.SCHEDULE_TASKS_FILE = join(dir, "schedule-tasks.json");
  try {
    const tasks = new ScheduleTaskService();
    const conflicts = new ScheduleConflictService(tasks);
    const assertionStore = new ScheduleAssertionStore({
      persistPath: join(dir, "assertions.json"),
      nowFn: () => NOW,
    });
    const registry = new ToolRegistry();
    registerCalendarTools(registry, tasks, null as never, conflicts, undefined, assertionStore);

    const v1Items = [
      { description: "高等数学", runAt: iso(NOW + 2 * DAY), durationMinutes: 90 },
      { description: "大学英语", runAt: iso(NOW + 3 * DAY), durationMinutes: 60 },
      { description: "数据结构", runAt: iso(NOW + 4 * DAY), durationMinutes: 90 },
    ];
    // v2：高数挪到 +8d，数据结构删掉，英语保留
    const v2Items = [
      { description: "高等数学", runAt: iso(NOW + 8 * DAY), durationMinutes: 90 },
      { description: "大学英语", runAt: iso(NOW + 3 * DAY), durationMinutes: 60 },
    ];
    await registry.execute("calendar.batch_create", { sourceName: "我的课表", timezone: "Asia/Shanghai", items: v1Items }, ctx);
    const v2 = await registry.execute("calendar.batch_create", { sourceName: "我的课表", timezone: "Asia/Shanghai", items: v2Items }, ctx);
    const rows = v2.result.results as Array<Record<string, unknown>>;
    assert.equal(rows.find((r) => r.assertionVersion)?.assertionVersion, 2, "重传推进版本链");

    // 被删科目的旧主张已 superseded：消息再提它不命中（退出冲突匹配，不删除）
    const proposals: ProactiveProposal[] = [];
    const watcher = new AssertionConflictWatcher({
      store: assertionStore,
      submitProposal: (p) => proposals.push(p),
      now: () => NOW,
      cooldownMs: 0,
    });
    watcher.handleInbound({ actorId: "user-a", text: "老师说明天数据结构的课取消了" });
    assert.equal(proposals.length, 0, "被新版快照取代的科目不再触发");
    // 新版高数时段（+8d，窗内）→ 命中（语境词「课」是日程变动信号的必要条件）
    watcher.handleInbound({ actorId: "user-a", text: "下周的高等数学课取消了，老师有事", platform: "wechat" });
    assert.equal(proposals.length, 1, "新时段主张在窗内 → 命中");
    assert.equal(proposals[0]?.subject, "高等数学");
  } finally {
    delete process.env.SCHEDULE_TASKS_FILE;
    await rm(dir, { recursive: true, force: true });
  }
});
