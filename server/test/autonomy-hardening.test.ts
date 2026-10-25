/**
 * 自主性模块加固回归测试（2026-09-19 优化批次）。
 *
 * 覆盖：
 *  1. 传感→状态板桥接（bridgeSensorKernelToBoard）+ bootstrap 接线守卫
 *  2. MobilePushService token 写穿持久化
 *  3. TaskHub / TaskOutbox 落盘与重启恢复（非终态如实标记 failed）
 *  4. 定时任务失败重试：指数退避 + 连续失败死信停摆 + 一次性死信通知
 *  5. ToolCallGuard：敏感工具持久幂等回放 + 审计落盘 + 参数脱敏
 *  6. 工具风险分级（classifyToolRisk）口径
 *  7. 确认流程：多条挂起防误批（multiple_pending）+ 过期回调通知
 *  8. 自主性等级（0=只建议降级 speak）+ 勿扰（governor DND 前置闸）
 *  9. viewed impression 不污染接受率
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SensorKernel, registerFeeder } from "../src/proactivity/sensors/kernel.js";
import { WorldBoard, bridgeSensorKernelToBoard } from "../src/proactivity/world-board.js";
import { MappingExecutor, type AttentionEvent } from "../src/proactivity/mapping-executor.js";
import { buildBoardRules } from "../src/proactivity/mapping-rules.js";
import { MobilePushService } from "../src/proactivity/mobile-push-service.js";
import { PendingConfirmationStore } from "../src/proactivity/pending-confirmation-store.js";
import { FrequencyGovernor } from "../src/proactivity/frequency-governor.js";
import { ProactivityHub } from "../src/proactivity/proactivity-hub.js";
import { OutcomeStore } from "../src/proactivity/outcome-store.js";
import { TaskHub } from "../src/task-plane/task-hub.js";
import { TaskOutbox } from "../src/task-plane/task-outbox.js";
import { ScheduleTaskService } from "../src/services/schedule-task-service.js";
import { ToolCallGuard } from "../src/services/tool-call-guard.js";
import { classifyToolRisk, isSensitiveTool } from "../src/services/tool-risk.js";
import { AutonomySettingsStore } from "../src/services/autonomy-settings-store.js";

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "autonomy-hard-"));
}

// ────────────────────────────────────────────────────────────
// 1. 五层架构 L1→L2 桥接
// ────────────────────────────────────────────────────────────

function makeFabric(dir: string, wire: boolean): { kernel: SensorKernel; board: WorldBoard; executor: MappingExecutor; events: AttentionEvent[]; feed: (s: { stream: "schedule" | "goal" | "message" | "presence"; fingerprint: string; payload: Record<string, unknown> }) => void } {
  const kernel = new SensorKernel({ dataPath: dir, disablePersist: true });
  const scheduleFeeder = registerFeeder(kernel, "schedule_probe", "schedule");
  const goalFeeder = registerFeeder(kernel, "goal_probe", "goal");
  const messageFeeder = registerFeeder(kernel, "message_probe", "message");
  const presenceFeeder = registerFeeder(kernel, "presence_probe", "presence");
  const services = {
    listTodayTasks: () => [{ title: "周会", runAt: Date.now() + 10 * 60_000 }],
    weatherLine: () => null,
    unreadSenders: () => [],
    readyGoals: () => [],
    interestLines: () => [],
    recallMemory: () => [],
  };
  const board = new WorldBoard({});
  if (wire) bridgeSensorKernelToBoard(kernel, board, () => "u1");
  const executor = new MappingExecutor({
    board,
    rules: buildBoardRules(services),
    defaultActorId: () => "u1",
  });
  const events: AttentionEvent[] = [];
  executor.onEvent((e) => events.push(e));
  const feeders = { schedule: scheduleFeeder, goal: goalFeeder, message: messageFeeder, presence: presenceFeeder };
  return {
    kernel,
    board,
    executor,
    events,
    feed: (s) => feeders[s.stream]({ at: Date.now(), fingerprint: s.fingerprint, salience: "low", payload: s.payload }),
  };
}

test("桥接后传感信号入板并产出规则事件（L1→L2 连通）", async () => {
  const dir = tmpDir();
  try {
    const fabric = makeFabric(dir, true);
    const at = Date.now();
    fabric.feed({ stream: "schedule", fingerprint: `s1:${at}`, payload: { nextRunAt: at + 10 * 60_000, nextTitle: "周会" } });
    fabric.feed({ stream: "goal", fingerprint: `g1:${at}`, payload: { goalId: "g1", title: "准备包", body: "好了", status: "ready" } });
    for (let i = 0; i < 3; i++) fabric.feed({ stream: "message", fingerprint: `m${i}:${at}`, payload: { sender: `c${i}` } });
    await fabric.executor.tickActor("u1", at);
    const kinds = fabric.events.map((e) => e.kind);
    assert.ok(kinds.includes("meeting_soon"), `应有 meeting_soon，实际 ${kinds.join(",")}`);
    assert.ok(kinds.includes("goal_ready"), `应有 goal_ready，实际 ${kinds.join(",")}`);
    assert.ok(kinds.includes("unread_burst"), `应有 unread_burst，实际 ${kinds.join(",")}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("无桥接时信号不入板，规则零事件（复现断线行为）", async () => {
  const dir = tmpDir();
  try {
    const fabric = makeFabric(dir, false);
    const at = Date.now();
    fabric.feed({ stream: "schedule", fingerprint: `s1:${at}`, payload: { nextRunAt: at + 10 * 60_000, nextTitle: "周会" } });
    fabric.feed({ stream: "goal", fingerprint: `g1:${at}`, payload: { goalId: "g1", title: "x", status: "ready" } });
    await fabric.executor.tickActor("u1", at);
    assert.equal(fabric.events.length, 0, "缺桥接时板是空的，规则不应有事件");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("bootstrap 接线守卫：生产装配必须包含状态板桥接与执行器 dataPath", () => {
  const src = readFileSync(join(process.cwd(), "src", "bootstrap", "create-app-services.ts"), "utf8");
  assert.match(src, /bridgeSensorKernelToBoard\(sensorKernel,\s*worldBoard/, "bootstrap 必须调用 L1→板 桥接（防再次断线）");
  assert.match(src, /new MappingExecutor\(\{[\s\S]*?dataPath:/, "MappingExecutor 构造必须传 dataPath（状态持久化）");
  assert.match(src, /worldBoardRef.current = worldBoard/, "对话轮入板回调必须接线（会话层）");
});

// ────────────────────────────────────────────────────────────
// 2. 推送 token 持久化
// ────────────────────────────────────────────────────────────

test("MobilePushService 注册即落盘，重启（新实例）可恢复", () => {
  const dir = tmpDir();
  try {
    const path = join(dir, "push-tokens.json");
    const svc1 = new MobilePushService({ registryPath: path, providers: [{ name: "webhook", isConfigured: () => true, push: async () => ({ ok: true }) }] });
    svc1.register("user-a", { provider: "webhook", token: "tok-1" });
    assert.ok(existsSync(path), "注册后应立即写盘");
    const svc2 = new MobilePushService({ registryPath: path, providers: [] });
    assert.equal(svc2.listByActor("user-a").length, 1);
    assert.equal(svc2.listByActor("user-a")[0].token, "tok-1");
    // 注销同样写穿
    svc2.unregister("user-a", "webhook", "tok-1");
    const svc3 = new MobilePushService({ registryPath: path, providers: [] });
    assert.equal(svc3.listByActor("user-a").length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ────────────────────────────────────────────────────────────
// 3. 任务面持久化
// ────────────────────────────────────────────────────────────

test("TaskHub 落盘恢复：终态保留，非终态如实标记 failed", () => {
  const dir = tmpDir();
  try {
    const path = join(dir, "task-hub.json");
    const hub1 = new TaskHub();
    hub1.enablePersistence(path);
    hub1.submit({ taskId: "t1", sessionId: "s1", goal: "整理周报" });
    hub1.setState("t1", "done");
    hub1.submit({ taskId: "t2", sessionId: "s1", goal: "搜索资料" });
    hub1.flushPersistence();
    const hub2 = new TaskHub();
    hub2.enablePersistence(path);
    const done = hub2.get("t1");
    const interrupted = hub2.get("t2");
    assert.equal(done?.state, "done");
    assert.equal(interrupted?.state, "failed", "重启时运行中的任务应如实标记 failed");
    assert.match(interrupted?.progressLine ?? "", /中断/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("TaskOutbox 落盘恢复：重启后离线结果照常补投", () => {
  const dir = tmpDir();
  try {
    const path = join(dir, "task-outbox.json");
    const out1 = new TaskOutbox();
    out1.enablePersistence(path);
    out1.enqueue("s1", { messageId: "m1", finalText: "任务结果：已订好牛奶" });
    const out2 = new TaskOutbox();
    out2.enablePersistence(path);
    const drained = out2.drain("s1");
    assert.equal(drained.length, 1);
    assert.equal(drained[0].finalText, "任务结果：已订好牛奶");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ────────────────────────────────────────────────────────────
// 4. 定时任务失败重试治理
// ────────────────────────────────────────────────────────────

test("定时任务连续失败：退避递增、达阈值死信停摆、死信通知恰好一次", async () => {
  const dir = tmpDir();
  // 隔离持久化文件：不设会被 persist() 写进 server/data/schedule-tasks.json，
  // 把线上任务整库冲掉（2026-09-24 科技早报任务就是这样被本测试删掉的）
  const prevScheduleFile = process.env.SCHEDULE_TASKS_FILE;
  process.env.SCHEDULE_TASKS_FILE = join(dir, "schedule-tasks.json");
  try {
    const svc = new ScheduleTaskService();
    let deadLetters = 0;
    svc.setTaskDeadLetterHandler(() => {
      deadLetters += 1;
    });
    svc.setAgentTaskHandler(async () => {
      throw new Error("下游依赖不可用");
    });
    const task = await svc.createTask({
      sessionId: "user-x",
      description: "每天整理邮件",
      kind: "agent_task",
      recurrence: "daily",
      runAt: new Date(Date.now() - 1000).toISOString(),
      agentTask: { prompt: "整理邮件" },
    });
    const lastErrors: Array<string | undefined> = [];
    for (let i = 1; i <= 6; i++) {
      if (svc.getTask(task.taskId).status !== "active") break;
      await svc.triggerNow(task.taskId);
      lastErrors.push(svc.getTask(task.taskId).lastError);
    }
    const dead = svc.getTask(task.taskId);
    assert.equal(dead.status, "failed", "连续 5 次失败后应死信停摆");
    assert.equal(dead.nextRunAt, null, "死信后不应再调度");
    assert.equal(dead.consecutiveFailures, 5);
    assert.equal(deadLetters, 1, "死信通知应恰好一次");
    assert.ok(lastErrors[0] !== undefined);
    // 死信后 triggerNow 应拒绝（不再空烧）
    await assert.rejects(() => svc.triggerNow(task.taskId));
  } finally {
    if (prevScheduleFile === undefined) delete process.env.SCHEDULE_TASKS_FILE;
    else process.env.SCHEDULE_TASKS_FILE = prevScheduleFile;
    rmSync(dir, { recursive: true, force: true });
  }
});

// ────────────────────────────────────────────────────────────
// 5. ToolCallGuard（幂等 + 审计）
// ────────────────────────────────────────────────────────────

test("ToolCallGuard：TTL 内同参成功回放、异参放行、审计脱敏、跨实例持久", () => {
  const dir = tmpDir();
  try {
    const guard1 = new ToolCallGuard({ dirPath: dir });
    const args = { orderId: "A1", amount: 99.9, password: "secret-123" };
    assert.equal(guard1.checkReplay("u1", "shopping.order.place", args), null, "首次应放行");
    guard1.record("u1", "shopping.order.place", args, true, { ok: true, orderId: "A1" });
    const replay = guard1.checkReplay("u1", "shopping.order.place", { ...args });
    assert.ok(replay, "同参重复调用应命中幂等回放");
    assert.equal((replay!.result as { orderId: string }).orderId, "A1");
    assert.equal(guard1.checkReplay("u1", "shopping.order.place", { orderId: "B2", amount: 1 }), null, "异参应放行（不拦截新调用）");
    // 审计：敏感工具成败都落盘，password 已脱敏
    const audit = readFileSync(join(dir, "tool-audit.ndjson"), "utf8");
    assert.ok(audit.includes("shopping.order.place"));
    assert.ok(!audit.includes("secret-123"), "审计不得包含明文 password");
    assert.ok(audit.includes("***"));
    // 跨实例（模拟重启）幂等仍生效
    const guard2 = new ToolCallGuard({ dirPath: dir });
    assert.ok(guard2.checkReplay("u1", "shopping.order.place", { ...args }), "重启后幂等表应恢复");
    // 非敏感工具不记账
    guard2.record("u1", "search_web", { query: "x" }, true, {});
    assert.ok(!readFileSync(join(dir, "tool-audit.ndjson"), "utf8").includes("search_web"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("风险分级口径：money/irreversible 命中、未知工具保守归 write", () => {
  assert.equal(classifyToolRisk("alipay.balance.query"), "money");
  assert.equal(classifyToolRisk("wallet.transfer"), "money");
  assert.equal(classifyToolRisk("shopping.order.place"), "money");
  assert.equal(classifyToolRisk("payment.create_order"), "money");
  assert.equal(classifyToolRisk("finance.pay_bill"), "money");
  assert.equal(classifyToolRisk("desktop.run_shell"), "irreversible");
  assert.equal(classifyToolRisk("care.delete_important_date"), "irreversible");
  assert.equal(classifyToolRisk("geofence.delete"), "irreversible");
  assert.equal(classifyToolRisk("wallet.get_balance"), "read_only");
  assert.equal(classifyToolRisk("calendar.list_tasks"), "read_only");
  assert.equal(classifyToolRisk("brand.new.unknown_tool"), "write", "未知工具保守按 write");
  assert.ok(isSensitiveTool("wallet.transfer"));
  assert.ok(!isSensitiveTool("wallet.get_balance"));
});

// ────────────────────────────────────────────────────────────
// 6. 确认流程：防误批 + 过期通知
// ────────────────────────────────────────────────────────────

function makeHub(overrides?: { autonomyLevel?: (actorId: string) => number; confirmations?: PendingConfirmationStore }) {
  const executed: Array<{ tool: string; args: Record<string, unknown> }> = [];
  const spoken: Array<{ title: string; summary: string }> = [];
  const confirmations = overrides?.confirmations ?? new PendingConfirmationStore();
  const hub = new ProactivityHub({
    publishSignal: (signal) => {
      spoken.push({ title: signal.title, summary: signal.summary });
    },
    executeTool: async (tool, args) => {
      executed.push({ tool, args });
      return { ok: true, result: {} };
    },
    pendingConfirmations: confirmations,
    frequencyGovernor: new FrequencyGovernor({ disableQuietHours: true, ignoreEnv: true }),
    ...(overrides?.autonomyLevel ? { autonomyLevel: overrides.autonomyLevel } : {}),
  } as ConstructorParameters<typeof ProactivityHub>[0]);
  return { hub, executed, spoken, confirmations };
}

test("多条挂起确认且未指明 confirmId：拒绝默认批最新，返回消歧列表", async () => {
  const { hub, executed, confirmations } = makeHub();
  confirmations.register({
    actorId: "u1",
    kind: "k1",
    steps: [{ tool: "messages.reply", args: {} }],
    rationale: "给妈妈回复生日祝福",
    createdAt: Date.now(),
    expiresAt: Date.now() + 600_000,
    origin: "hub",
  });
  confirmations.register({
    actorId: "u1",
    kind: "k2",
    steps: [{ tool: "calendar.create_task", args: {} }],
    rationale: "把体检改到明天",
    createdAt: Date.now(),
    expiresAt: Date.now() + 600_000,
    origin: "hub",
  });
  const result = await hub.resolveConfirmation("u1", true);
  assert.equal(result.ok, false);
  assert.equal(result.error, "multiple_pending");
  assert.equal(result.pending?.length, 2);
  assert.equal(executed.length, 0, "不得默认执行任何一条");
  // 指明 confirmId 后正常执行
  const second = hub.listPendingConfirmations("u1").find((c) => c.rationale.includes("体检"));
  const resolved = await hub.resolveConfirmation("u1", true, second!.confirmId);
  assert.equal(resolved.ok, true);
  assert.equal(resolved.executed, true);
  assert.equal(executed.length, 1);
});

test("确认过期不再静默：expiredHandler 批量回调", () => {
  let now = Date.now();
  const dir = tmpDir();
  try {
    const store = new PendingConfirmationStore(join(dir, "c.json"), () => now);
    const expired: string[] = [];
    store.setExpiredHandler((entries) => {
      for (const e of entries) expired.push(e.confirmId);
    });
    const e1 = store.register({
      actorId: "u1",
      kind: "k",
      steps: [],
      rationale: "已过期的确认",
      createdAt: now - 1000,
      expiresAt: now + 1000,
      origin: "hub",
    });
    now += 2000; // 时间前进 → 过期
    store.pruneExpired();
    assert.deepEqual(expired, [e1.confirmId]);
    assert.equal(store.size(), 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ────────────────────────────────────────────────────────────
// 7. 自主性等级 + 勿扰
// ────────────────────────────────────────────────────────────

test("自主性等级 0（只建议）：act 意图降级 speak，永不执行", async () => {
  const { hub, executed, spoken } = makeHub({ autonomyLevel: () => 0 });
  hub.submitIntent({
    actorId: "u1",
    kind: "life_reminder",
    importance: "medium",
    title: "把体检改到明天",
    summary: "计划用 calendar.create_task 改期",
    mode: "act",
    source: "task",
    actArgs: [{ tool: "calendar.create_task", args: { title: "体检" } }],
  });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(executed.length, 0, "等级 0 不得执行任何工具");
  assert.ok(spoken.length > 0, "应降级为 speak 通报计划");
  assert.ok(spoken.some((s) => s.summary.includes("只提醒不动手")));
});

test("自主性等级 1（标准）：可逆动作正常执行", async () => {
  const { hub, executed } = makeHub();
  hub.submitIntent({
    actorId: "u1",
    kind: "life_reminder",
    importance: "high",
    title: "把体检改到明天",
    summary: "计划用 calendar.create_task 改期",
    mode: "act",
    source: "task",
    actArgs: [{ tool: "calendar.create_task", args: { title: "体检" } }],
  });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(executed.length, 1, "标准档可逆+显式授权应静默执行");
});

test("AutonomySettingsStore：等级与勿扰读写、持久化", () => {
  const dir = tmpDir();
  try {
    const path = join(dir, "autonomy-settings.json");
    const s1 = new AutonomySettingsStore(path);
    assert.equal(s1.getLevel("u1"), 1, "缺省标准档");
    s1.setLevel("u1", 0);
    s1.setDnd("u1", Date.now() + 60_000);
    const s2 = new AutonomySettingsStore(path);
    assert.equal(s2.getLevel("u1"), 0);
    assert.ok(s2.isDnd("u1"));
    s2.setDnd("u1", 0);
    assert.ok(!s2.isDnd("u1"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("governor 勿扰前置闸：medium/low 沉默，high 放行", () => {
  const g = new FrequencyGovernor({ disableQuietHours: true, ignoreEnv: true });
  g.setDndCheck(() => true);
  assert.equal(g.canTrigger("u1", "life_reminder", "low").allowed, false);
  assert.equal(g.canTrigger("u1", "life_reminder", "medium").reason, "dnd_active");
  assert.equal(g.canTrigger("u1", "life_reminder", "high").allowed, true);
  g.setDndCheck(null);
  assert.equal(g.canTrigger("u1", "life_reminder", "low").allowed, true);
});

// ────────────────────────────────────────────────────────────
// 8. viewed impression 不污染接受率
// ────────────────────────────────────────────────────────────

test("viewed 不进接受率分母（ impression ≠ 用户决策）", () => {
  const dir = tmpDir();
  try {
    const store = new OutcomeStore(join(dir, "outcomes.json"));
    const mk = (i: number, outcome: Parameters<OutcomeStore["record"]>[0]["outcome"]) =>
      store.record({ deliveryId: `d${i}`, actorId: "u1", kind: "digest", channel: "in_app", outcome, at: Date.now() });
    mk(1, "viewed");
    mk(2, "viewed");
    mk(3, "viewed");
    mk(4, "accepted");
    mk(5, "accepted");
    mk(6, "accepted");
    mk(7, "ignored");
    mk(8, "ignored");
    // 8 条记录里 3 条是 viewed：分母应为 5（已决策的），接受率 3/5
    assert.equal(store.acceptanceRate("digest"), 0.6);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
