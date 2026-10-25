// WorldBoard 状态板 + 映射规则补充场景单测。
// 核心九场景的主体断言在 proactivity-fabric.test.ts；本文件覆盖：
// 状态板单元行为（分层/幂等/列表上限/指纹/落盘恢复/信号映射）+ 其余规则场景。
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { WorldBoard, bridgeSensorKernelToBoard } from "../src/proactivity/world-board.js";
import { MappingExecutor, type AttentionEvent } from "../src/proactivity/mapping-executor.js";
import { buildBoardRules } from "../src/proactivity/mapping-rules.js";

class MockClock {
  t: number;
  constructor(t = Date.now()) {
    this.t = t;
  }
  advance(ms: number): void {
    this.t += ms;
  }
}

function mkExecutor(clock: MockClock, ruleId: string, services: Parameters<typeof buildBoardRules>[0] = {}) {
  const board = new WorldBoard({ nowFn: () => clock.t });
  const executor = new MappingExecutor({
    board,
    rules: buildBoardRules(services).filter((r) => r.id === ruleId),
    defaultActorId: () => "u1",
    nowFn: () => clock.t,
  });
  const events: AttentionEvent[] = [];
  executor.onEvent((e) => events.push(e));
  const feed = (stream: Parameters<WorldBoard["ingestSignal"]>[0]["stream"], payload: Record<string, unknown>) =>
    board.ingestSignal(
      { stream, at: clock.t, fingerprint: `${stream}:${clock.t}:${Math.random()}`, salience: "low", payload },
      "u1",
    );
  const tick = () => executor.tickActor("u1", clock.t);
  return { board, executor, events, feed, tick };
}

// ── 状态板单元行为 ──

test("状态板: ingest 幂等覆盖 + append 上限裁剪", () => {
  const board = new WorldBoard({});
  board.ingest("u1", "current", "presence", { state: "idle", since: 1 });
  board.ingest("u1", "current", "presence", { state: "active", since: 2 });
  assert.deepEqual(board.read("u1", "current", "presence"), { state: "active", since: 2 });
  for (let i = 0; i < 60; i++) board.append("u1", "current", "unreadRecent", { at: i, sender: `s${i}` });
  const list = board.read<Array<unknown>>("u1", "current", "unreadRecent")!;
  assert.equal(list.length, 50, "默认上限 50");
  assert.equal((list[0] as { at: number }).at, 59, "新值在前");
});

test("状态板: 内容指纹——同内容同指纹，变更即变", () => {
  const board = new WorldBoard({});
  assert.equal(board.fingerprint("u1"), "", "未知 actor 指纹为空串");
  board.ingest("u1", "current", "k", "v");
  const fp2 = board.fingerprint("u1");
  assert.notEqual(fp2, "");
  assert.equal(board.fingerprint("u1"), fp2, "未变更时指纹稳定");
  board.ingest("u1", "current", "k", "v2");
  assert.notEqual(board.fingerprint("u1"), fp2);
});

test("状态板: 落盘 + 新实例恢复", async () => {
  const dir = mkdtempSync(join(tmpdir(), "board-test-"));
  try {
    const path = join(dir, "world-board.json");
    const b1 = new WorldBoard({ dataPath: dir });
    b1.ingest("u1", "obligations", "nextEvent", { title: "周会", runAt: 123 });
    b1.flush();
    assert.ok(existsSync(path));
    const b2 = new WorldBoard({ dataPath: dir });
    assert.deepEqual(b2.read("u1", "obligations", "nextEvent"), { title: "周会", runAt: 123 });
    assert.ok(readFileSync(path, "utf8").includes("周会"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("状态板: 信号映射——屏幕焦点同 kind 保留 since（连续工作时长跨信号累计）", () => {
  const clock = new MockClock(1_000_000);
  const board = new WorldBoard({ nowFn: () => clock.t });
  board.ingestSignal({ stream: "screen", at: clock.t, fingerprint: "a", salience: "low", payload: { kind: "coding" } }, "u1");
  const first = board.read<{ kind: string; since: number }>("u1", "current", "screenFocus")!;
  clock.advance(30 * 60_000);
  board.ingestSignal({ stream: "screen", at: clock.t, fingerprint: "b", salience: "low", payload: { kind: "coding" } }, "u1");
  const second = board.read<{ kind: string; since: number; lastSeenAt: number }>("u1", "current", "screenFocus")!;
  assert.equal(second.since, first.since, "同 kind：since 不变");
  assert.equal(second.lastSeenAt, clock.t, "lastSeenAt 刷新");
  clock.advance(60_000);
  board.ingestSignal({ stream: "screen", at: clock.t, fingerprint: "c", salience: "low", payload: { kind: "browsing" } }, "u1");
  const third = board.read<{ kind: string; since: number }>("u1", "current", "screenFocus")!;
  assert.equal(third.kind, "browsing");
  assert.notEqual(third.since, first.since, "换 kind：since 重置");
});

test("状态板: 桥接——无 actorId 信号落 defaultActorId；onChange 回调触发", () => {
  const kernelEmits: Array<(s: never) => void> = [];
  const kernel = { onSignal: (l: never) => (kernelEmits.push(l), () => {}) };
  const board = new WorldBoard({});
  const changes: string[] = [];
  board.onChange((actorId, layer, key) => changes.push(`${actorId}:${layer}:${key}`));
  const unbridge = bridgeSensorKernelToBoard(kernel, board, () => "local_user");
  (kernelEmits[0] as unknown as (s: { stream: string; at: number; fingerprint: string; salience: string; payload: Record<string, unknown> }) => void)({
    stream: "schedule",
    at: 123,
    fingerprint: "f1",
    salience: "high",
    payload: { nextRunAt: 456, nextTitle: "评审" },
  });
  assert.deepEqual(board.read("local_user", "obligations", "nextEvent"), { title: "评审", runAt: 456, updatedAt: 123 });
  assert.ok(changes.includes("local_user:obligations:nextEvent"));
  unbridge();
});

// ── 规则补充场景 ──

test("映射规则: meeting_soon 60min 预告（social 档）与 15min alert 分档", async () => {
  const clock = new MockClock(Date.now());
  const services = { listTodayTasks: () => [{ title: "评审会", runAt: clock.t + 50 * 60_000 }] };
  const { board, events, tick } = mkExecutor(clock, "meeting_soon", services);
  board.ingest("u1", "obligations", "nextEvent", { title: "评审会", runAt: clock.t + 50 * 60_000, updatedAt: clock.t });
  await tick();
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "meeting_soon_early", "50min → 提前量档");
  assert.equal(events[0].tier, "social");
  // 60s 内重复 tick 不重发（规则内 announced 状态）
  clock.advance(60_000);
  await tick();
  assert.equal(events.length, 1);
});

test("映射规则: sleep_boundary —— 23 点屏幕活跃触发一次且带过期", async () => {
  const d = new Date();
  d.setHours(23, 10, 0, 0);
  const clock = new MockClock(d.getTime());
  const { feed, tick, events } = mkExecutor(clock, "sleep_boundary");
  feed("screen", { kind: "coding" });
  await tick();
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "sleep_boundary");
  assert.ok(events[0].expiresAt !== undefined && events[0].expiresAt! > clock.t, "带保质期");
  clock.advance(16 * 60_000); // 越过规则 tick 周期（15min）
  await tick();
  assert.equal(events.length, 1, "同日只发一次");
});

test("映射规则: goal_ready —— 同 goalId 只投一次", async () => {
  const clock = new MockClock(Date.now());
  const { board, events, tick } = mkExecutor(clock, "goal_ready");
  board.append("u1", "obligations", "recentGoals", { at: clock.t, goalId: "g1", title: "比价完成", body: "已备好" });
  await tick();
  clock.advance(2 * 60_000);
  await tick();
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "goal_ready");
  assert.equal(events[0].dedupKey, "goal_ready:g1");
});

test("映射规则: unread_burst —— 30min 窗口外消息不计入", async () => {
  const clock = new MockClock(Date.now());
  const { board, events, tick } = mkExecutor(clock, "unread_burst");
  for (let i = 0; i < 3; i++) {
    board.append("u1", "current", "unreadRecent", { at: clock.t - 60 * 60_000, sender: `旧消息${i}` });
  }
  await tick();
  assert.equal(events.length, 0, "1 小时前的消息不构成爆发");
  for (let i = 0; i < 3; i++) {
    board.append("u1", "current", "unreadRecent", { at: clock.t - i, sender: `新消息${i}` });
  }
  clock.advance(60_000); // 越过规则 tick 节流（60s）
  await tick();
  assert.equal(events.length, 1);
  assert.ok(events[0].body.includes("3 条新消息"));
});
