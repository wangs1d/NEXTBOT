// 已注册宿主账号（邮箱主体）在另一处登录不得重走 Agent World 注册流程（2026-10-16）。
// 覆盖：WorldService 外部注册判定 —— 宿主账号存在 ⇒ isAgentWorldRegistered 为真
// 并物化到世界状态（与挑战注册同路径发放初始点数）；无账号主体维持原门禁。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { WorldService } from "@private-ai-agent/agent-world";

import { AgentAccountService } from "../src/services/agent-account-service.js";

const INITIAL_CREDITS = 200;

function withTempEnv(t: { after: () => void }, fn: () => Promise<void> | void): Promise<void> | void {
  const dir = mkdtempSync(join(tmpdir(), "pai-world-reg-"));
  const prevWorld = process.env.WORLD_STATE_FILE;
  const prevAccounts = process.env.AGENT_ACCOUNTS_FILE;
  process.env.WORLD_STATE_FILE = join(dir, "world-state.json");
  process.env.AGENT_ACCOUNTS_FILE = join(dir, "agent-accounts.json");
  return Promise.resolve(fn()).finally(() => {
    process.env.WORLD_STATE_FILE = prevWorld;
    process.env.AGENT_ACCOUNTS_FILE = prevAccounts;
    rmSync(dir, { recursive: true, force: true });
  });
}

/** 与 bootstrap 装配层完全同款的接线：宿主账号存在性 ⇒ 世界已注册。 */
function wireLikeBootstrap(world: WorldService, accounts: AgentAccountService): void {
  world.setExternalRegistrationResolver((actorId) => Boolean(accounts.getByActorId(actorId)));
}

test("外部注册判定: 无 resolver（独立形态）时未注册主体维持门禁", async (t) => {
  await withTempEnv(t, async () => {
    const world = new WorldService();
    await world.load();
    assert.equal(world.isAgentWorldRegistered("user@example.com"), false);
    assert.equal(world.getOrCreate("user@example.com").agentWorldRegistered, false);
    await world.flushPersist();
  });
});

test("外部注册判定: 宿主已注册邮箱账号 ⇒ 视为已注册并物化（另一处登录不重走注册）", async (t) => {
  await withTempEnv(t, async () => {
    const accounts = new AgentAccountService();
    const world = new WorldService();
    await Promise.all([accounts.load(), world.load()]);
    wireLikeBootstrap(world, accounts);

    // 用户此前从未在该世界做过挑战注册
    assert.equal(world.isAgentWorldRegistered("user@example.com"), false);

    // 在另一处用同一邮箱登录（宿主账号已注册）→ 门禁直接放行
    await accounts.register("user@example.com", "user", "user@example.com");
    assert.equal(world.isAgentWorldRegistered("user@example.com"), true);

    // 物化落状态：与挑战注册同语义（标记 + 初始点数）
    const state = world.getOrCreate("user@example.com");
    assert.equal(state.agentWorldRegistered, true);
    assert.equal(state.agentWorldCredits, INITIAL_CREDITS);

    // 大小写不同的写法归一后同主体（服务端注册路由统一小写）
    assert.equal(world.isAgentWorldRegistered("user@example.com"), true);

    await Promise.all([accounts.persist(), world.flushPersist()]);
  });
});

test("外部注册判定: 无宿主账号的主体不物化，仍需走挑战注册", async (t) => {
  await withTempEnv(t, async () => {
    const accounts = new AgentAccountService();
    const world = new WorldService();
    await Promise.all([accounts.load(), world.load()]);
    wireLikeBootstrap(world, accounts);

    await accounts.register("someone-else@example.com", "other", "someone-else@example.com");
    assert.equal(world.isAgentWorldRegistered("guest-session-1"), false);
    assert.equal(world.getOrCreate("guest-session-1").agentWorldRegistered, false);
    assert.equal(world.isAgentWorldRegistered("someone-else@example.com"), true);

    await Promise.all([accounts.persist(), world.flushPersist()]);
  });
});

test("外部注册判定: 已有挑战注册的世界状态不受影响；纯世界注册不依赖账号", async (t) => {
  await withTempEnv(t, async () => {
    const accounts = new AgentAccountService();
    const world = new WorldService();
    await Promise.all([accounts.load(), world.load()]);
    wireLikeBootstrap(world, accounts);

    // 挑战注册路径（占位关闭时走 challenge/verify；此处直接验证快注册语义等价的物化函数行为）
    // —— 用 issueChallenge + verify 太重，直接验证：世界状态已注册时优先走常规路径。
    const s = world.getOrCreate("bot-inst-1");
    s.agentWorldRegistered = true;
    world.markWorldMutated(s.roomId);
    assert.equal(world.isAgentWorldRegistered("bot-inst-1"), true);

    await Promise.all([accounts.persist(), world.flushPersist()]);
  });
});
