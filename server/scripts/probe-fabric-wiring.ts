/**
 * 主动性接线探针（probe-fabric-wiring.ts）。
 *
 * 复现生产装配（SensorKernel + WorldBoard 状态板 + MappingExecutor 同款桥接），
 * 验证 L1 传感信号真的能入板并被映射规则消费产出 AttentionEvent。
 *
 *   npx tsx scripts/probe-fabric-wiring.ts            # 修复后行为（应产出事件）
 *   npx tsx scripts/probe-fabric-wiring.ts --legacy   # 复现缺桥接（信号不入板，事件=0）
 *
 * 背景：生产装配曾漏掉 sensorKernel.onSignal → 评估层 一行，
 * events.ndjson 里只有 digest_beat——流式规则全部空转。本探针把"接线是否在"变成可断言。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SensorKernel, registerFeeder } from "../src/proactivity/sensors/kernel.js";
import { WorldBoard, bridgeSensorKernelToBoard } from "../src/proactivity/world-board.js";
import { MappingExecutor, type AttentionEvent } from "../src/proactivity/mapping-executor.js";
import { buildBoardRules } from "../src/proactivity/mapping-rules.js";

const legacy = process.argv.includes("--legacy");
const dir = mkdtempSync(join(tmpdir(), "fabric-probe-"));

const services = {
  listTodayTasks: () => [{ title: "周会", runAt: Date.now() + 10 * 60_000 }],
  commitmentsDue: () => [],
  weatherLine: () => null,
  unreadSenders: () => ["妈妈", "老板"],
  readyGoals: () => [],
  interestLines: () => [],
  recallMemory: () => [],
};

const kernel = new SensorKernel({ dataPath: dir, disablePersist: true });
const scheduleFeeder = registerFeeder(kernel, "schedule_probe", "schedule");
const goalFeeder = registerFeeder(kernel, "goal_probe", "goal");
const messageFeeder = registerFeeder(kernel, "message_probe", "message");
const presenceFeeder = registerFeeder(kernel, "presence_probe", "presence");

const board = new WorldBoard({});
bridgeSensorKernelToBoard(kernel, board, () => "probe_user");
const executor = new MappingExecutor({
  board,
  rules: buildBoardRules(services),
  defaultActorId: () => "probe_user",
  tickIntervalMs: 60_000,
});

const received: AttentionEvent[] = [];
executor.onEvent((e) => received.push(e));

// 缺这行桥接 = 信号永远不入板（--legacy 复现）
if (legacy) board.ingest("probe_user", "current", "presence", { state: "unknown", since: Date.now() });

const at = Date.now();
scheduleFeeder({ at, fingerprint: `probe:schedule:${at}`, salience: "high", payload: { nextRunAt: at + 10 * 60_000, nextTitle: "周会" } });
goalFeeder({ at, fingerprint: `probe:goal:${at}`, salience: "medium", payload: { goalId: "g1", title: "晨间简报", body: "已备好", status: "ready" } });
for (let i = 0; i < 3; i++) {
  messageFeeder({ at: at + i, fingerprint: `probe:msg:${at}:${i}`, salience: "low", payload: { sender: `联系人${i}` } });
}
presenceFeeder({ at, fingerprint: `probe:presence:${at}`, salience: "low", payload: { state: "active" } });

void (async () => {
  await executor.tickActor("probe_user");
  const kinds = received.map((e) => e.kind);
  console.log(`\n[probe] 模式=${legacy ? "legacy（无桥接，复现缺线）" : "wired（生产桥接）"}`);
  console.log(`[probe] 信号入板 → 规则产出事件 ${received.length} 个: ${kinds.join(", ") || "（无）"}`);
  const expect = legacy ? 0 : 3; // meeting_soon(brief) + goal_ready + unread_burst
  const ok = legacy
    ? received.length === 0
    : received.length >= 3 &&
      kinds.includes("meeting_soon") &&
      kinds.includes("goal_ready") &&
      kinds.includes("unread_burst");
  console.log(`[probe] 结论: ${ok ? "PASS" : "FAIL"}`);
  rmSync(dir, { recursive: true, force: true });
  process.exit(ok ? 0 : 1);
})();
