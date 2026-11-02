/**
 * 按 actor 的并发配额契约。
 *
 * 现场问题：全局 turn 闸（默认 8）与后台任务闸（默认 4）只认机器容量，不认人。
 * 云端一台机器服务多个用户时，同一个人多开几个会话就能把全局槽位占满，
 * 别的用户只能排队吃 429——本机单用户时看不出来，一上云就是主要故障模式。
 * 本文件锁定的契约：
 *   A. 单 actor 的名额用完时，只堵自己，别人照走；
 *   B. 堵住的请求不占全局名额（不但漏槽位）；
 *   C. 排队超时后已占的名额回滚、空闲的闸被回收（不随历史用户涨内存）；
 *   D. 释放是两级的：全局与 actor 名额一起归还；
 *   E. 空/匿名身份共用一个桶，快照给出各类上限。
 * 另加重型工具（出图/跑代码/语音）一层：
 *   F. 同 actor 的第二路排在自己的重型队列里，不预先占全局限流位；
 *   G. 具身分域与普通工具不加这层闸（它们是互斥，不是可分享的容量）；
 *   H. 生产工具上下文把 actorId 带进循环（漏透传会让这层静默失效）。
 */
import assert from "node:assert/strict";
import test from "node:test";

process.env.MAX_CONCURRENT_TURNS_PER_ACTOR = "2";
process.env.MAX_BG_TASKS_PER_ACTOR = "1";
process.env.MAX_CONCURRENT_HEAVY_TOOLS_PER_ACTOR = "1";

const {
  acquireTurnSlots,
  acquireBgTaskSlots,
  executeWithinActorHeavyToolLimit,
  actorQuotaSnapshot,
  resetActorQuotaForTests,
} = await import("../src/services/actor-quota.js");
const { globalTurnLimiter, backgroundTaskLimiter, getConcurrencyStats, executeWithToolLimit } =
  await import("../src/services/concurrency-limiter.js");

/** 工具循环里的真实组合：先占本 actor 的重型位，再进全局按名限流器。 */
function runHeavyTool<T>(toolName: string, actorId: string, fn: () => Promise<T>): Promise<T> {
  return executeWithinActorHeavyToolLimit(toolName, actorId, () =>
    executeWithToolLimit(toolName, fn),
  );
}

/** 全局闸固定到可控上限（模块导入时按本机容量算过，测试不依赖真实机器）。 */
function pinGlobalGates(turnMax: number, bgMax: number): void {
  globalTurnLimiter.updateMax(turnMax);
  backgroundTaskLimiter.updateMax(bgMax);
}

async function tick(): Promise<void> {
  await new Promise((r) => setTimeout(r, 10));
}

test("A 单 actor 名额用满只堵自己：另一个 actor 立即拿到 turn 名额", async () => {
  resetActorQuotaForTests();
  pinGlobalGates(8, 8);

  const a1 = await acquireTurnSlots("a@corp.com", 1000);
  const a2 = await acquireTurnSlots("a@corp.com", 1000);
  assert.equal(globalTurnLimiter.activeCount, 2);

  // 第三人（同 actor）排到本 actor 队列里 → 30ms 内不会拿到（超时即证明被挡）
  let a3Settled = false;
  const a3 = acquireTurnSlots("a@corp.com", 30).then(
    () => (a3Settled = true),
    () => (a3Settled = false),
  );

  // 别的 actor 不受影响：立即成功
  const b1 = await acquireTurnSlots("b@corp.com", 1000);
  assert.equal(globalTurnLimiter.activeCount, 3, "b 的名额应来自全局余量，不是排队后被唤醒");

  await a3;
  assert.equal(a3Settled, false, "同 actor 的第 3 轮应被本 actor 名额挡住");

  a1();
  a2();
  b1();
  assert.equal(globalTurnLimiter.activeCount, 0);
});

test("B 被 actor 名额挡住的请求不占全局槽位", async () => {
  resetActorQuotaForTests();
  pinGlobalGates(4, 4);

  const a1 = await acquireTurnSlots("a@corp.com", 1000);
  const a2 = await acquireTurnSlots("a@corp.com", 1000);

  await assert.rejects(() => acquireTurnSlots("a@corp.com", 20));
  assert.equal(globalTurnLimiter.activeCount, 2, "挡在 actor 层的请求不得预先占住全局名额");

  a1();
  a2();
});

test("C 排队超时回滚已占名额，空闲的 actor 闸即时回收", async () => {
  resetActorQuotaForTests();
  pinGlobalGates(4, 4);

  // bg 每 actor 只有 1 个名额：先占住，再让第二个超时
  const held = await acquireBgTaskSlots("solo@corp.com", 500);
  await assert.rejects(() => acquireBgTaskSlots("solo@corp.com", 20));
  assert.equal(backgroundTaskLimiter.activeCount, 1, "超时的一路不能留下全局 bg 名额");

  // 还占着名额 → 闸仍在表里（供在跑的那一路释放）
  assert.ok(
    actorQuotaSnapshot().gates.some((g) => g.actorId === "solo@corp.com" && g.active === 1),
    "在忙名额应出现在快照里",
  );
  held();
  await tick();
  assert.equal(
    actorQuotaSnapshot().gates.filter((g) => g.actorId === "solo@corp.com").length,
    0,
    "释放后闸应被删除（不随历史用户累积）",
  );
});

test("D 释放同时归还两级名额", async () => {
  resetActorQuotaForTests();
  pinGlobalGates(4, 4);

  const release = await acquireTurnSlots("pair@corp.com", 500);
  assert.equal(globalTurnLimiter.activeCount, 1);
  release();
  release(); // 幂等：重复释放不会把 active 打成负数
  assert.equal(globalTurnLimiter.activeCount, 0);
  await tick();
  assert.equal(actorQuotaSnapshot().gates.length, 0);
});

test("E 空 actor 归一个桶 + 快照给出上限", async () => {
  resetActorQuotaForTests();
  pinGlobalGates(8, 8);

  const r1 = await acquireTurnSlots("", 500);
  const r2 = await acquireTurnSlots("   ", 500);
  await assert.rejects(() => acquireTurnSlots(undefined as unknown as string, 20));

  const snap = actorQuotaSnapshot();
  assert.equal(snap.limits.turn, 2);
  assert.equal(snap.limits.bg, 1);
  assert.equal(snap.limits.heavyTool, 1);
  const anon = snap.gates.find((g) => g.actorId === "anonymous");
  assert.ok(anon, "空/匿名应共用同一个桶");
  assert.equal(anon!.active, 2);

  r1();
  r2();
  await tick();
});

test("F 重型工具按 actor 收口：同 actor 第二路排自己队列，不预占全局位", async () => {
  resetActorQuotaForTests();

  let finishFirst: () => void = () => {};
  const first = runHeavyTool("image.generate", "a@corp.com", () =>
    new Promise<void>((r) => {
      finishFirst = r;
    }),
  );
  await tick();
  assert.equal(getConcurrencyStats().tools["image.generate"]?.active, 1, "第一路应已进入全局限流器");

  let secondDone = false;
  const second = runHeavyTool("image.generate", "a@corp.com", async () => {
    secondDone = true;
  });
  await tick();
  assert.equal(secondDone, false, "同 actor 的第二路应排在重型名额队列里");
  assert.equal(
    getConcurrencyStats().tools["image.generate"]?.active,
    1,
    "挡在 actor 层的重型请求不得预占全局位",
  );
  const gateA = actorQuotaSnapshot().gates.find(
    (g) => g.kind === "heavyTool" && g.actorId === "a@corp.com",
  );
  assert.deepEqual(
    { active: gateA?.active, queued: gateA?.queued, max: gateA?.max },
    { active: 1, queued: 1, max: 1 },
    "快照要按 actor 分出重型队列深度",
  );

  finishFirst();
  await first;
  await second;
  assert.equal(secondDone, true, "本 actor 名额归还后排队的一路应继续跑完");
  await tick();
  assert.equal(
    actorQuotaSnapshot().gates.filter((g) => g.kind === "heavyTool").length,
    0,
    "重型闸空闲后应被回收",
  );
});

test("G 非重型工具不加 actor 闸：具身单飞域按原样直接执行", async () => {
  resetActorQuotaForTests();

  // 连发两路 desktop.*：本层不设名额（互斥由全局分域单飞闸负责），都要立即返回
  const out = await Promise.all([
    executeWithinActorHeavyToolLimit("desktop.click", "a@corp.com", async () => "one"),
    executeWithinActorHeavyToolLimit("code.unknown_variant", "a@corp.com", async () => "two"),
  ]);
  assert.deepEqual(out, ["one", "two"]);
  assert.equal(actorQuotaSnapshot().gates.length, 0, "不在重型清单里的工具不得建闸");
});

test("H 生产工具上下文自带 actorId：漏透传=按 actor 收口静默失效", async () => {
  const { ToolContextFactory } = await import("../src/agent/execution/tool-context-factory.js");
  const registry = {
    getCachedResult: () => null,
    execute: async () => ({ ok: true, result: {} }),
  };
  const factory = new ToolContextFactory({
    toolRegistry: registry as never,
    getBrainCenter: () => null,
  });
  const ctx = factory.create({
    actorId: "a@corp.com",
    sessionId: "s-1",
    source: "test",
  });
  assert.equal(ctx.actorId, "a@corp.com", "工具循环读的是 ctx.actorId");
});
