// 主动性架构单测：传感内核 / 屏幕分类 / 状态板+映射规则 / 仲裁 V2 / 模板 / 直达车道。
// 全部零 LLM 断言——LLM 不参与其中任何决策（2026-09-24 架构定稿）。
import assert from "node:assert/strict";
import { test, beforeEach } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SensorKernel, registerFeeder } from "../src/proactivity/sensors/kernel.js";
import { ScreenSensor, classifyWindow, screenFocusLabel } from "../src/proactivity/sensors/screen-sensor.js";
import { ScheduleSensor } from "../src/proactivity/sensors/schedule-sensor.js";
import { WorldBoard } from "../src/proactivity/world-board.js";
import { MappingExecutor, type AttentionEvent } from "../src/proactivity/mapping-executor.js";
import { buildBoardRules } from "../src/proactivity/mapping-rules.js";
import { ArbiterV2, interruptCost } from "../src/proactivity/arbiter-v2.js";
import { GoalBoard } from "../src/proactivity/goal-board.js";
import { renderProactiveText, renderDigestCard } from "../src/proactivity/voice-templates.js";
import { ProactivityHub } from "../src/proactivity/proactivity-hub.js";
import { FrequencyGovernor } from "../src/proactivity/frequency-governor.js";
import type { Signal } from "../src/proactivity/sensors/types.js";

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "fabric-test-"));
}

class MockClock {
  t: number;
  constructor(t = Date.UTC(2026, 8, 14, 8, 0, 0)) {
    this.t = t;
  }
  now(): number {
    return this.t;
  }
  advance(ms: number): void {
    this.t += ms;
  }
  /** 本地时区的今天某时刻 */
  static localAt(h: number, m = 0): number {
    const d = new Date();
    d.setHours(h, m, 0, 0);
    return d.getTime();
  }
}

// ─── L1 传感内核 ───

test("SensorKernel: 指纹去重 + 健康记账 + feeder", () => {
  const kernel = new SensorKernel({ dataPath: tmpDir(), disablePersist: true });
  const emit = registerFeeder(kernel, "test_feeder", "goal");
  const got: Signal[] = [];
  kernel.onSignal((s) => got.push(s));
  const base = { at: 1, fingerprint: "fp1", salience: "low" as const };
  emit({ ...base });
  emit({ ...base }); // 同指纹：去重
  emit({ at: 2, fingerprint: "fp2", salience: "medium" });
  assert.equal(got.length, 2);
  const health = kernel.health();
  assert.equal(health.length, 1);
  assert.equal(health[0].mode, "feeder");
  assert.equal(health[0].emitted, 2);
  assert.equal(health[0].tripped, false);
});

test("SensorKernel: 连续失败熔断 + 半开恢复", async () => {
  const kernel = new SensorKernel({ dataPath: tmpDir(), disablePersist: true });
  let fails = true;
  kernel.register({
    id: "flaky",
    stream: "device",
    pollIntervalMs: 1000,
    collect: () => {
      if (fails) throw new Error("device offline");
      return [];
    },
  });
  await kernel.pollOnce();
  await kernel.pollOnce();
  await kernel.pollOnce();
  const h = kernel.health()[0];
  assert.equal(h.tripped, true);
  assert.equal(h.consecutiveFails, 3);
  fails = false;
  await kernel.pollOnce(); // 冷却期内不重试
  assert.equal(kernel.health()[0].tripped, true);
});

test("ScreenSensor: 零 LLM app 分类", () => {
  assert.equal(classifyWindow({ processName: "Code.exe", title: "main.ts - VS Code" }), "coding");
  assert.equal(classifyWindow({ processName: "Weixin.exe", title: "微信" }), "chat");
  assert.equal(classifyWindow({ processName: "msedge", title: "Bilibili - 搜索" }), "video");
  assert.equal(classifyWindow({ processName: "unknown.exe", title: "" }), "idle");
  assert.equal(screenFocusLabel("coding"), "写代码");
});

test("ScheduleSensor: 只在 24h 日程集变化时产出，nextEventMin 可读", () => {
  const clock = new MockClock();
  const task = { title: "牙医复诊", runAt: clock.t + 30 * 60_000, status: "scheduled" };
  const sensor = new ScheduleSensor({
    listTasks: () => [task] as never[],
    nowFn: () => clock.t,
  });
  const first = sensor.collect(0);
  assert.equal(first.length, 1);
  assert.equal(sensor.latest()?.min, 30);
  // 日程没变：不产出
  assert.equal(sensor.collect(0).length, 0);
  // 日程变了：产出
  task.runAt += 3600_000;
  assert.equal(sensor.collect(0).length, 1);
});

// ─── L2 状态板 + 映射规则 ───

function makeExecutor(clock: MockClock, services: Record<string, unknown> = {}, ruleId?: string) {
  const board = new WorldBoard({ nowFn: () => clock.t });
  const executor = new MappingExecutor({
    board,
    rules: buildBoardRules(services).filter((r) => !ruleId || r.id === ruleId),
    defaultActorId: () => "user-1",
    nowFn: () => clock.t,
    tickIntervalMs: 60_000,
  });
  const events: AttentionEvent[] = [];
  executor.onEvent((e) => events.push(e));
  const feed = (stream: Signal["stream"], payload: Record<string, unknown>): void => {
    board.ingestSignal(
      { stream, at: clock.t, fingerprint: `${stream}:${clock.t}:${JSON.stringify(payload)}`, salience: "low", payload },
      "user-1",
    );
  };
  const tick = () => executor.tickActor("user-1", clock.t);
  return { board, executor, events, feed, tick };
}

test("映射规则: away_return —— 离开4h后回归才问候", async () => {
  const clock = new MockClock(MockClock.localAt(15, 0));
  const { feed, tick, events } = makeExecutor(clock, {}, "away_return");
  feed("presence", { state: "idle" });
  await tick();
  assert.equal(events.length, 0); // 刚离开不问候
  clock.advance(4 * 3600_000); // 4h 后回归（19:00，仍在白天窗口）
  feed("presence", { state: "active" });
  await tick();
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "away_return");
  assert.ok(events[0].body.length > 0, "模板正文非空");
});

test("映射规则: work_marathon —— 连续编码3h 触发休息干预", async () => {
  const clock = new MockClock(MockClock.localAt(10, 0));
  const { feed, tick, events } = makeExecutor(clock, {}, "work_marathon");
  feed("screen", { kind: "coding" });
  await tick();
  assert.equal(events.length, 0);
  clock.advance(181 * 60_000);
  feed("screen", { kind: "coding" }); // 新心跳：since 不变、lastSeenAt 刷新
  await tick();
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "work_marathon");
  assert.ok(events[0].body.includes("小时"), `正文含时长: ${events[0].body}`);
});

test("映射规则: work_marathon 陈旧快照不计时长（防休眠唤醒误报）", async () => {
  const clock = new MockClock(MockClock.localAt(10, 0));
  const { feed, tick, events } = makeExecutor(clock, {}, "work_marathon");
  feed("screen", { kind: "coding" });
  await tick();
  clock.advance(6 * 3600_000); // 长时间无屏幕心跳（关机/离开）
  await tick();
  assert.equal(events.length, 0, "lastSeenAt 超过 20min 的陈旧焦点不得触发");
});

test("映射规则: morning_brief + digest 数据拼接，全缺数据也非空", async () => {
  const clock = new MockClock(MockClock.localAt(7, 30));
  const services = {
    listTodayTasks: () => [{ title: "10点站会" }, { title: "14点评审" }],
    weatherLine: () => "小雨，18-24°C",
    commitmentsDue: () => [{ id: "c1", title: "给小李发报价", dueAt: clock.t + 3600_000 }],
  };
  const { feed, tick, events } = makeExecutor(clock, services, "morning_brief");
  feed("presence", { state: "active" });
  await tick();
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "morning_brief");
  const body = events[0].body;
  assert.ok(body.includes("10点站会"), `简报含日程: ${body}`);
  assert.ok(body.includes("给小李发报价"), `简报含承诺: ${body}`);
  assert.ok(body.includes("小雨"), `简报含天气: ${body}`);
});

test("映射规则: commitment_chain —— 承诺2h内到期产出 ask_first 代催事件", async () => {
  const clock = new MockClock(MockClock.localAt(12, 0));
  const { tick, events } = makeExecutor(
    clock,
    { commitmentsDue: () => [{ id: "c9", title: "回复张总邮件", dueAt: clock.t + 90 * 60_000 }] },
    "commitment_chain",
  );
  await tick();
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "commitment_chain");
  assert.equal(events[0].confirmLabel, "帮我催一下");
  assert.equal(events[0].urgency, "alert");
});

test("映射规则: 传感信号入板（桥接映射）——meeting/unread/goal 三场景", async () => {
  const clock = new MockClock(MockClock.localAt(14, 0));
  const board = new WorldBoard({ nowFn: () => clock.t });
  const executor = new MappingExecutor({
    board,
    rules: buildBoardRules({
      listTodayTasks: () => [{ title: "周会", runAt: clock.t + 10 * 60_000 }],
    }),
    defaultActorId: () => "user-1",
    nowFn: () => clock.t,
  });
  const events: AttentionEvent[] = [];
  executor.onEvent((e) => events.push(e));
  // 走与生产相同的信号→板桥接
  const sig = (stream: Signal["stream"], payload: Record<string, unknown>): Signal => ({
    stream,
    at: clock.t,
    fingerprint: `${stream}:${clock.t}:${Math.random()}`,
    salience: "low",
    payload,
  });
  board.ingestSignal(sig("schedule", { nextRunAt: clock.t + 10 * 60_000, nextTitle: "周会" }), "user-1");
  board.ingestSignal(sig("goal", { goalId: "g1", title: "会前准备包", body: "已备好" }), "user-1");
  for (let i = 0; i < 3; i++) {
    board.ingestSignal(sig("message", { sender: `联系人${i}` }), "user-1");
  }
  await executor.tickActor("user-1", clock.t);
  const kinds = events.map((e) => e.kind);
  assert.ok(kinds.includes("meeting_soon"), `临会提醒: ${kinds}`);
  assert.ok(kinds.includes("goal_ready"), `目标就绪: ${kinds}`);
  assert.ok(kinds.includes("unread_burst"), `消息爆发: ${kinds}`);
});

// ─── L3 仲裁 ───

test("仲裁: 挂起项 TTL 过期 → onParkExpire 降级投递（不再静默消失）", () => {
  const clock = new MockClock();
  const expired: Array<{ label: string; urgency: string }> = [];
  const arbiter = new ArbiterV2({
    presence: { getPresence: () => "active", listOnline: () => ["user-1"], lastActivityAt: () => clock.t } as never,
    lastConversationAt: () => clock.t - 10_000, // 一直"对话中"→ 永不 pause
    screenFocus: () => "meeting",
    nextEventMin: () => 5,
    receptivity: () => 0.5,
    primaryActorId: () => "user-1",
    nowFn: () => clock.t,
    onParkExpire: (e) => expired.push({ label: e.label, urgency: e.urgency }),
  });
  const r = arbiter.admit({ actorId: "user-1", urgency: "alert", label: "t-exp", deliver: () => {} });
  assert.equal(r.action, "wait_for_pause");
  assert.equal(arbiter.parkedEntries().length, 1, "先挂起");
  // 推进到 TTL 过期之后（环境始终无 pause 跃迁）
  clock.advance(9 * 60 * 60_000);
  arbiter.forceTick();
  assert.equal(arbiter.parkedEntries().length, 0, "过期出队");
  assert.equal(expired.length, 1, "过期回调触发降级投递");
  assert.equal(expired[0].label, "t-exp");
  assert.equal(expired[0].urgency, "alert");
});

test("仲裁: 未注入 onParkExpire 时保持原静默丢弃语义（回退兼容）", () => {
  const clock = new MockClock();
  const arbiter = new ArbiterV2({
    presence: { getPresence: () => "active", listOnline: () => ["user-1"], lastActivityAt: () => clock.t } as never,
    lastConversationAt: () => clock.t - 10_000,
    screenFocus: () => "meeting",
    nextEventMin: () => 5,
    receptivity: () => 0.5,
    primaryActorId: () => "user-1",
    nowFn: () => clock.t,
  });
  arbiter.admit({ actorId: "user-1", urgency: "alert", label: "t-noop", deliver: () => {} });
  clock.advance(9 * 60 * 60_000);
  arbiter.forceTick();
  assert.equal(arbiter.parkedEntries().length, 0, "过期出队（无回调，行为不变）");
});

test("仲裁: 设备离线 → 不 park，直接直通管道（重连补投由管道 arbitrate 承担）", () => {
  // 离线成本恒满分 → 必然 wait_for_pause；原行为 park 8h 后过期重投、
  // 管道还是判 offline → 退避放弃（真实数据 digest_beat 连续 4 次丢弃）。
  // 直通语义：deliver 被立即调用、不进挂起队列，挂起/补投交给管道。
  const clock = new MockClock();
  const delivered: string[] = [];
  const arbiter = new ArbiterV2({
    presence: { getPresence: () => "offline", listOnline: () => [], lastActivityAt: () => null } as never,
    lastConversationAt: () => null,
    screenFocus: () => null,
    nextEventMin: () => null,
    receptivity: () => 0.5,
    primaryActorId: () => "user-1",
    nowFn: () => clock.t,
  });
  const r = arbiter.admit({
    actorId: "user-1",
    urgency: "normal",
    label: "t-offline",
    deliver: () => delivered.push("t-offline"),
  });
  assert.equal(r.action, "wait_for_pause");
  assert.equal(r.reason, "offline_passthrough_pipeline");
  assert.equal(delivered.length, 1, "离线直通：deliver 已被调用（进管道挂起待重连）");
  assert.equal(arbiter.parkedEntries().length, 0, "不进 park 队列");
  // alert 档离线同样直通（must/interrupt 本来就直投，不在此断言范围）
  const r2 = arbiter.admit({
    actorId: "user-1",
    urgency: "alert",
    label: "t-offline-alert",
    deliver: () => delivered.push("t-offline-alert"),
  });
  assert.equal(r2.reason, "offline_passthrough_pipeline");
  assert.equal(delivered.length, 2);
});

test("仲裁: parkCostCeil 可放宽稳定高成本死区（默认 4.5 饿死 → 放宽后放行）", () => {
  // 稳定态成本 5（terminal 3 + 低接受度 2）：>4.5 饿死、≤6 放行，
  // 复现「用户一直在写代码/用终端 → 挂起项饿到 8h TTL」的死区
  const makeArb = (ceil: number) => {
    const clock = new MockClock();
    const delivered: string[] = [];
    let focus = "meeting"; // 挂起时 snapshot 的 prev 基线
    const a = new ArbiterV2({
      presence: { getPresence: () => "active", listOnline: () => ["user-1"], lastActivityAt: () => null } as never,
      lastConversationAt: () => null,
      screenFocus: () => focus,
      nextEventMin: () => null,
      receptivity: () => 0, // 低接受度 → +2，把稳定态成本抬到 5
      primaryActorId: () => "user-1",
      nowFn: () => clock.t,
      parkCostCeil: () => ceil,
    });
    a.admit({ actorId: "user-1", urgency: "normal", label: "t-ceil", deliver: () => delivered.push("x") });
    assert.equal(a.parkedEntries().length, 1, `ceil=${ceil} 先挂起`);
    focus = "terminal"; // 稳定高成本：无 meeting 散场跃迁、不在对话中
    clock.advance(50 * 60_000); // 超过 45min 稳态兜底窗口
    a.forceTick();
    return delivered;
  };
  assert.equal(makeArb(4.5).length, 0, "默认阈值下稳定高成本饿死（复现 26 条 wait_for_pause 静默作废）");
  assert.equal(makeArb(6).length, 1, "放宽阈值后兜底放行积压消息");
});

function baseSnapshot(over: Partial<Parameters<typeof interruptCost>[0]> = {}) {
  return {
    now: new Date(MockClock.localAt(15, 0)),
    presence: "active" as const,
    inConversation: false,
    screenFocus: null,
    nextEventMin: null,
    quietHours: false,
    receptivity: 0.5,
    recentBurst: 0,
    ...over,
  };
}

test("仲裁: 打断成本公式 —— 会议/对话/深夜叠加", () => {
  assert.equal(interruptCost(baseSnapshot()), 1); // receptivity 0.5 → +1
  assert.ok(interruptCost(baseSnapshot({ screenFocus: "meeting" })) >= 5);
  assert.ok(interruptCost(baseSnapshot({ inConversation: true, screenFocus: "coding" })) >= 7);
  assert.equal(interruptCost(baseSnapshot({ presence: "offline" })), 10);
  assert.ok(interruptCost(baseSnapshot({ quietHours: true })) >= 4);
});

test("仲裁: 低成本直投 / 高成本挂起 / pause 后放行", () => {
  const clock = new MockClock();
  const delivered: string[] = [];
  const arbiter = new ArbiterV2({
    presence: { getPresence: () => "active", listOnline: () => ["user-1"], lastActivityAt: () => null } as never,
    lastConversationAt: () => null,
    screenFocus: () => null,
    nextEventMin: () => null,
    receptivity: () => 0.9,
    primaryActorId: () => "user-1",
    nowFn: () => clock.t,
  });
  // 空闲 + 高接受度 → 立即投递
  let r = arbiter.admit({ actorId: "user-1", urgency: "normal", label: "t1", deliver: () => delivered.push("t1") });
  assert.equal(r.action, "deliver_now");
  // 屏幕会议 + 对话中 → 挂起
  const deps = {
    presence: { getPresence: () => "active", listOnline: () => ["user-1"], lastActivityAt: () => clock.t } as never,
    lastConversationAt: (): number | null => clock.t - 10_000, // 对话中
    screenFocus: (): string => "meeting",
    nextEventMin: (): number | null => 5,
    receptivity: () => 0.5,
    primaryActorId: () => "user-1",
    nowFn: () => clock.t,
  };
  const busy = new ArbiterV2(deps as never);
  r = busy.admit({ actorId: "user-1", urgency: "alert", label: "t2", deliver: () => delivered.push("t2") });
  assert.equal(r.action, "wait_for_pause");
  assert.equal(delivered.length, 1);
  // 用户从会议中走出来（会议散场 + 无临近日程）→ pause 检测放行队首
  deps.screenFocus = () => "idle";
  deps.nextEventMin = () => null;
  clock.advance(31_000);
  busy.forceTick();
  assert.equal(delivered.length, 2);
  assert.equal(busy.parkedEntries().length, 0);
});

// ─── L4 目标板 ───

test("GoalBoard: 会前准备包预执行 → ready 进托盘 → goal 信号", async () => {
  const clock = new MockClock();
  const dir = tmpDir();
  const goalSignals: string[] = [];
  const board = new GoalBoard({
    dataPath: dir,
    nowFn: () => clock.t,
    emitGoal: (g) => goalSignals.push(`${g.goalId}:${g.status}`),
    recallMemory: () => ["上周和小王对过需求范围"],
  });
  const goal = board.maybeStartMeetingPrep("user-1", { title: "项目周会", runAtMin: 30 });
  assert.ok(goal, "25-40min 窗口内启动");
  await new Promise((r) => setTimeout(r, 20)); // 异步准备
  assert.equal(goal.status, "ready");
  assert.ok(String(goal.payload?.body).includes("小王"), "预执行材料含召回内容");
  assert.equal(board.readyTray().length, 1);
  assert.ok(goalSignals.includes(`${goal.goalId}:ready`));
  // 幂等：同会议不重复备
  assert.equal(board.maybeStartMeetingPrep("user-1", { title: "项目周会", runAtMin: 30 }), null);
  rmSync(dir, { recursive: true, force: true });
});

// ─── L5 表达层 ───

test("模板: 各 kind 渲染非空且带上下文", () => {
  const now = new Date(MockClock.localAt(8, 0));
  assert.ok(renderProactiveText("away_return", { now }).length > 0);
  assert.ok(renderProactiveText("interest_alert", { name: "刘浩存", excerpt: "新电影开机" }).includes("刘浩存"));
  assert.ok(renderProactiveText("overwork_care", { hours: 4 }).includes("4"));
  assert.ok(renderProactiveText("unknown_kind_xyz", { title: "测试" }).length > 0, "未知 kind 有兜底");
  assert.ok(renderProactiveText("anything", { body: "自定义正文" }) === "自定义正文");
  const card = renderDigestCard({ slot: "morning", tasks: ["站会"], weather: "晴" });
  assert.ok(card.includes("站会") && card.includes("晴"));
  assert.ok(renderDigestCard({ slot: "evening" }).length > 0, "空数据也非空");
});

// ─── 直达车道（hub → 管道，全程零 LLM）────

test("映射规则状态持久化: 去重指纹跨实例恢复（重启不重发回归）", async () => {
  const clock = new MockClock(MockClock.localAt(10, 0));
  const dir = tmpDir();
  const services = {
    listTodayTasks: () => [{ title: "周会", runAt: clock.t + 10 * 60_000 }],
  };
  const mk = () => {
    const board = new WorldBoard({ dataPath: dir, nowFn: () => clock.t });
    board.ingestSignal(
      { stream: "schedule", at: clock.t, fingerprint: "s1", salience: "high", payload: { nextRunAt: clock.t + 10 * 60_000, nextTitle: "周会" } },
      "user-1",
    );
    const executor = new MappingExecutor({
      board,
      rules: buildBoardRules(services).filter((r) => r.id === "meeting_soon"),
      defaultActorId: () => "user-1",
      dataPath: dir,
      nowFn: () => clock.t,
    });
    return { board, executor };
  };
  // 实例 1：触发一次 meeting_soon，stop 强制落盘
  const first = mk();
  const got1: AttentionEvent[] = [];
  first.executor.onEvent((e) => got1.push(e));
  await first.executor.tickActor("user-1", clock.t);
  assert.equal(got1.length, 1);
  first.executor.stop(); // 强制落盘（去重指纹 + 规则状态）
  // 实例 2：同数据目录恢复 → 同 dedupKey 同日不得重发
  const second = mk();
  const got2: AttentionEvent[] = [];
  second.executor.onEvent((e) => got2.push(e));
  await second.executor.tickActor("user-1", clock.t);
  assert.equal(got2.length, 0, "恢复的去重指纹必须拦住同日同键重发");
  rmSync(dir, { recursive: true, force: true });
});

// ─── 直达车道（hub → 管道，全程零 LLM）────

test("直达车道: hub.submitIntent → 模板直投管道（带 directText，不触 LLM）", async () => {
  const delivered: Array<{ kind: string; text: string; hasDeliveryId: boolean }> = [];
  const hub = new ProactivityHub({
    publishSignal: () => assert.fail("直达车道开启时 speak 不应再走 LifeSignal 路径"),
    executeTool: async () => ({ ok: true, result: {} }),
    // 测试确定性：禁用静默时段（否则 23-7 点 importance<high 全被频控拦截）
    frequencyGovernor: new FrequencyGovernor({ disableQuietHours: true, ignoreEnv: true }),
  });
  hub.setDirectLane((p) => {
    assert.ok(p.directText && p.directText.length > 0, "提案带模板文案");
    // 模拟管道投递（真实 ProactiveDeliveryService 的 payload 契约）
    delivered.push({ kind: p.kind, text: p.directText ?? "", hasDeliveryId: true });
  });
  hub.submitIntent({
    actorId: "user-1",
    kind: "interest_alert",
    importance: "medium",
    title: "你关注的「刘浩存」有新动态",
    summary: "热搜：新电影开机",
    mode: "speak",
    source: "interest_watch",
    templateData: { name: "刘浩存", excerpt: "新电影开机" },
  });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(delivered.length, 1);
  assert.ok(delivered[0].text.includes("刘浩存"));
  assert.equal(hub.isDirectLaneEnabled(), true);
});

test("直达车道关闭时回退 LifeSignal 路径（向后兼容）", async () => {
  process.env.PROACTIVITY_DIRECT_LANE = "0";
  let published = 0;
  const hub = new ProactivityHub({
    publishSignal: () => {
      published += 1;
    },
    executeTool: async () => ({ ok: true, result: {} }),
    frequencyGovernor: new FrequencyGovernor({ disableQuietHours: true, ignoreEnv: true }),
  });
  hub.submitIntent({
    actorId: "user-1",
    kind: "interest_share",
    importance: "low",
    title: "t",
    summary: "s",
    mode: "speak",
    source: "profile",
  });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(published, 1);
  delete process.env.PROACTIVITY_DIRECT_LANE;
});
