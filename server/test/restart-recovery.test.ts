/**
 * restart-recovery（2026-09-23 重启恢复）行为测试。
 *
 * 契约：
 *   - 被打断任务沿原结果通道收口：messageId=assistant-task-<原 taskId> 的
 *     chat.assistant_done（source=task_plane）——客户端凭同一 messageId 落
 *     说明消息并把「N 个任务后台进行中」状态带收口，零客户端改动；
 *   - 在线直推成功；离线即丢弃这一路通知，不重连补投（2026-11-24 用户拍板：
 *     任务结果已 appendTaskRecord 落盘，重开 App 拉历史可见）；
 *   - 自动重派 restartCount+1，达 MAX_TASK_AUTO_RESTARTS 只收口不重派；
 *   - 静默任务（quiet）跳过收口与重派；
 *   - 派发端口缺失/返回 null/抛异常：照常收口，文案如实转为"没能自动重跑"。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { getTaskHub } = await import("../src/task-plane/task-hub.js");
const {
  recoverInterruptedTasks,
  scheduleInterruptedTaskRecovery,
  MAX_TASK_AUTO_RESTARTS,
} = await import("../src/task-plane/restart-recovery.js");

type SentFrame = { type: string; payload: Record<string, unknown> };

function makeRegistry(opts?: { deliver?: boolean; fail?: boolean }) {
  const sent: SentFrame[] = [];
  return {
    sent,
    port: {
      trySend(actorId: string, data: string): boolean {
        if (opts?.fail) throw new Error("socket closed");
        sent.push(JSON.parse(data) as SentFrame);
        return opts?.deliver ?? false;
      },
    },
  };
}

function makeAgentCore(opts?: { ret?: string | null; throws?: boolean }) {
  const dispatches: Array<{ actorId: string; input: Record<string, unknown> }> = [];
  return {
    dispatches,
    port: {
      dispatchBackgroundTask(actorId: string, input: Record<string, unknown>): string | null {
        if (opts?.throws) throw new Error("provider not ready");
        dispatches.push({ actorId, input });
        return opts?.ret ?? "task-new-1";
      },
    },
  };
}

/** 写一个仅含给定非终态记录的台账 fixture，并让 TaskHub 单例走一遍启动清扫。 */
async function seedInterrupted(records: Array<Record<string, unknown>>) {
  const hub = getTaskHub();
  hub.reset();
  const dir = await mkdtemp(join(tmpdir(), "task-recovery-test-"));
  const path = join(dir, "task-hub.json");
  await writeFile(
    path,
    JSON.stringify({
      seq: records.length,
      records: records.map((r, i) => ({
        sessionId: "s1",
        state: "running",
        startedAt: 1,
        updatedAt: 2,
        startedSeq: i + 1,
        ...r,
      })),
    }),
  );
  hub.enablePersistence(path);
}

test("离线被打断任务：收口通知直推一次 + 自动重派 restartCount+1", async () => {
  await seedInterrupted([
    { taskId: "t1", replyAnchorId: "m1", goal: "帮我比比价，选台性价比高的空气炸锅" },
  ]);
  const registry = makeRegistry({ deliver: false });
  const core = makeAgentCore({ ret: "task-new-9" });

  const r = recoverInterruptedTasks({ agentCore: core.port, registry: registry.port });

  assert.deepEqual(r, { interrupted: 1, restarted: 1, notified: 1 });
  assert.equal(core.dispatches.length, 1);
  assert.equal(core.dispatches[0]?.actorId, "s1");
  assert.deepEqual(core.dispatches[0]?.input, {
    sessionId: "s1",
    chatUserMessageId: "m1",
    goal: "帮我比比价，选台性价比高的空气炸锅",
    source: "task.restart",
    restartCount: 1,
  });
  // 离线：收口通知只直推一次，不入箱等重连；messageId 沿用原任务的结果通道
  assert.equal(registry.sent.length, 1, "通知直推一次，不重连补投");
  const frame = registry.sent[0] as SentFrame;
  assert.equal(frame.payload.messageId, "assistant-task-t1");
  const text = String(frame.payload.finalText ?? "");
  assert.ok(text.includes("帮我比比价"), "收口文案应含任务目标");
  assert.ok(text.includes("重新开始办"), "重派成功文案应如实说明已重跑");
});

test("在线被打断任务：直推收口（assistant_done + source=task_plane）", async () => {
  await seedInterrupted([{ taskId: "t2", goal: "查个东西" }]);
  const registry = makeRegistry({ deliver: true });
  const core = makeAgentCore();

  const r = recoverInterruptedTasks({ agentCore: core.port, registry: registry.port });

  assert.deepEqual(r, { interrupted: 1, restarted: 1, notified: 1 });
  assert.equal(registry.sent.length, 1);
  const frame = registry.sent[0] as SentFrame;
  assert.equal(frame.type, "chat.assistant_done");
  assert.equal(frame.payload.messageId, "assistant-task-t2");
  assert.equal(frame.payload.source, "task_plane");
  assert.deepEqual(frame.payload.toolCalls, []);
});

test("达重跑上限：只收口不重派，文案如实转为没能重跑", async () => {
  await seedInterrupted([
    { taskId: "t3", goal: "反复被打断的任务", restartCount: MAX_TASK_AUTO_RESTARTS },
  ]);
  const registry = makeRegistry({ deliver: false });
  const core = makeAgentCore();

  const r = recoverInterruptedTasks({ agentCore: core.port, registry: registry.port });

  assert.deepEqual(r, { interrupted: 1, restarted: 0, notified: 1 });
  assert.equal(core.dispatches.length, 0, "达上限不得再重派");
  const frame = registry.sent[0] as SentFrame;
  assert.ok(String(frame.payload.finalText ?? "").includes("没能自动重跑"));
});

test("静默任务：跳过收口与重派（宿主对话轮已随旧进程结束）", async () => {
  await seedInterrupted([{ taskId: "t4", goal: "静默轻任务", quiet: true }]);
  const registry = makeRegistry({ deliver: false });
  const core = makeAgentCore();

  const r = recoverInterruptedTasks({ agentCore: core.port, registry: registry.port });

  assert.deepEqual(r, { interrupted: 0, restarted: 0, notified: 0 });
  assert.equal(core.dispatches.length, 0);
  assert.equal(registry.sent.length, 0);
});

test("派发端口缺失/抛异常：照常收口，文案不撒谎", async () => {
  const registry = makeRegistry({ deliver: false });

  await seedInterrupted([{ taskId: "t5", goal: "任务甲" }]);
  const r1 = recoverInterruptedTasks({ agentCore: null, registry: registry.port });
  assert.deepEqual(r1, { interrupted: 1, restarted: 0, notified: 1 });
  const f1 = registry.sent.at(-1) as SentFrame;
  assert.ok(String(f1.payload.finalText ?? "").includes("没能自动重跑"));

  await seedInterrupted([{ taskId: "t6", goal: "任务乙" }]);
  const core = makeAgentCore({ throws: true });
  const r2 = recoverInterruptedTasks({ agentCore: core.port, registry: registry.port });
  assert.deepEqual(r2, { interrupted: 1, restarted: 0, notified: 1 });
  const f2 = registry.sent.at(-1) as SentFrame;
  assert.ok(String(f2.payload.finalText ?? "").includes("没能自动重跑"));
});

test("通知幂等：二次 recover 无名单即无操作", async () => {
  await seedInterrupted([{ taskId: "t7", goal: "一次性收口" }]);
  const registry = makeRegistry({ deliver: false });
  const core = makeAgentCore();
  recoverInterruptedTasks({ agentCore: core.port, registry: registry.port });
  const r2 = recoverInterruptedTasks({ agentCore: core.port, registry: registry.port });
  assert.deepEqual(r2, { interrupted: 0, restarted: 0, notified: 0 });
});

test("scheduleInterruptedTaskRecovery：延迟后统一收口且异常不外抛", async () => {
  await seedInterrupted([{ taskId: "t8", goal: "定时收口任务" }]);
  const registry = makeRegistry({ deliver: false });
  scheduleInterruptedTaskRecovery({ agentCore: null, registry: registry.port }, 10);
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(registry.sent.length, 1, "延迟到期后应完成收口直推");
});
