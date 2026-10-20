/**
 * Agent 身份（名字）单测：
 *  1. agent-identity 纯函数——KV 解析宽容性、prompt 自我认知行措辞、建议名池审美约束；
 *  2. 统一改名管道 agent.update_identity——账号/记忆 KV/prefs/叙事记忆/WS 一次同步。
 * prompt 注入（persona 稳定前缀拼名字行）由 prompt-context-builder 装配路径保证，
 * 此处锁数据源与管道行为。账号/prefs 落盘走 env 指向的临时文件，不污染真实数据。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const testTmp = join(
  tmpdir(),
  `agent-identity-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
);
// AgentAccountService 的 persistPath getter 每次读 env，测试内随时指向临时目录
process.env.AGENT_ACCOUNTS_FILE = join(testTmp, "accounts.json");
// user-preferences 模块在加载时读 env，必须先于动态 import 设置
process.env.USER_PREFERENCES_FILE = join(testTmp, "prefs.json");

const { parseAgentIdentityKv, buildIdentityNameLine, AGENT_NAME_SUGGESTIONS, AGENT_NAME_KV_KEY } =
  await import("../src/services/agent-identity.js");

test("identity: parseAgentIdentityKv 宽容解析——合法/缺字段/坏 JSON/非字符串", () => {
  const good = parseAgentIdentityKv(
    JSON.stringify({
      displayName: "晚潮",
      handle: "evening_tide",
      origin: "self",
      updatedAt: "2026-09-19T00:00:00Z",
    }),
  );
  assert.ok(good);
  assert.equal(good.displayName, "晚潮");
  assert.equal(good.handle, "evening_tide");
  assert.equal(good.origin, "self");

  const noHandle = parseAgentIdentityKv(JSON.stringify({ displayName: "残响" }));
  assert.ok(noHandle);
  assert.equal(noHandle.handle, "");
  assert.equal(noHandle.origin, "default");

  assert.equal(parseAgentIdentityKv("not-json"), null);
  assert.equal(parseAgentIdentityKv(JSON.stringify({ handle: "no_name" })), null);
  assert.equal(parseAgentIdentityKv(null), null);
  assert.equal(parseAgentIdentityKv(42), null);
});

test("identity: buildIdentityNameLine 按 origin 出措辞", () => {
  const self = buildIdentityNameLine({
    displayName: "晚潮",
    handle: "evening_tide",
    origin: "self",
    updatedAt: "",
  });
  assert.match(self, /「晚潮」/);
  assert.match(self, /@evening_tide/);
  assert.match(self, /你自己选/);

  const user = buildIdentityNameLine({
    displayName: "过境",
    handle: "",
    origin: "user",
    updatedAt: "",
  });
  assert.match(user, /「过境」/);
  assert.doesNotMatch(user, /@/);
  assert.match(user, /用户为你取/);
});

test("identity: 建议名池审美约束——不带萌宠味", () => {
  assert.ok(AGENT_NAME_SUGGESTIONS.length >= 3);
  assert.ok(AGENT_NAME_SUGGESTIONS.every((s: { reason: string }) => s.reason.trim().length > 0));
  assert.ok(
    AGENT_NAME_SUGGESTIONS.every((s: { displayName: string }) => !/^(小|阿)/.test(s.displayName)),
    "建议名不应走「小X」萌宠路线",
  );
});

test("identity: agent.update_identity 一次调用同步 账号+KV+叙事+WS", async () => {
  const { AgentAccountService } = await import("../src/services/agent-account-service.js");
  const { AgentMemorySyncService } = await import("../src/services/agent-memory-sync-service.js");
  const { registerAgentIdentityTools } = await import("../src/tools/agent-identity-tools.js");

  const accountsSvc = new AgentAccountService();
  const memorySync = new AgentMemorySyncService(join(testTmp, "memory.json"));
  await memorySync.load();

  const actorId = "test-actor-identity";
  await accountsSvc.register(actorId, "旧名");

  const sent: Array<{ type: string }> = [];
  const registry = {
    register: (
      name: string,
      handler: (input: Record<string, unknown>) => Promise<Record<string, unknown>>,
    ) => {
      if (name === "agent.update_identity") registry.update = handler;
    },
    update: null as null | ((input: Record<string, unknown>) => Promise<Record<string, unknown>>),
  };
  registerAgentIdentityTools(registry as never, {
    accounts: accountsSvc,
    memorySync,
    wsRegistry: { trySend: (_actor: string, raw: string) => void sent.push(JSON.parse(raw)) } as never,
  });
  assert.ok(registry.update, "agent.update_identity 未注册");

  const result = (await registry.update!(
    { displayName: "晚潮", handle: "evening_tide", reason: "夜里漫上来的那一部分", origin: "self" },
    { sessionId: actorId },
  )) as { ok: boolean; displayName: string; accountCreated: boolean };
  assert.equal(result.ok, true);
  assert.equal(result.displayName, "晚潮");
  assert.equal(result.accountCreated, false);

  // 1) 账号显示名已改
  assert.equal(accountsSvc.getByActorId(actorId)?.displayName, "晚潮");
  // 2) KV 名字档案已写（prompt 自我认知数据源）
  const identity = parseAgentIdentityKv(memorySync.getSnapshot(actorId, [AGENT_NAME_KV_KEY]).entries[AGENT_NAME_KV_KEY]);
  assert.ok(identity);
  assert.equal(identity.displayName, "晚潮");
  assert.equal(identity.origin, "self");
  // 3) 叙事记忆已落（人生史事件）
  const summary = String(memorySync.getSnapshot(actorId, ["memory_summary"]).entries["memory_summary"] ?? "");
  assert.match(summary, /我为自己取名「晚潮」/);
  // 4) WS 广播已发（客户端即时刷新）
  assert.ok(sent.some((m) => m.type === "identity_renamed"));
});

test("identity: 未注册账号时改名 = 自助注册（给自己取网络名）", async () => {
  const { AgentAccountService } = await import("../src/services/agent-account-service.js");
  const { AgentMemorySyncService } = await import("../src/services/agent-memory-sync-service.js");
  const { registerAgentIdentityTools } = await import("../src/tools/agent-identity-tools.js");

  const accountsSvc = new AgentAccountService();
  const memorySync = new AgentMemorySyncService(join(testTmp, "memory2.json"));
  await memorySync.load();
  const actorId = "test-actor-fresh";

  let update!: (input: Record<string, unknown>, ctx: unknown) => Promise<Record<string, unknown>>;
  registerAgentIdentityTools({
    register: (name: string, handler: typeof update) => {
      if (name === "agent.update_identity") update = handler;
    },
  } as never, {
    accounts: accountsSvc,
    memorySync,
    wsRegistry: null,
  });

  const result = (await update({ displayName: "17赫兹" }, { sessionId: actorId })) as {
    accountCreated: boolean;
  };
  assert.equal(result.accountCreated, true);
  const account = accountsSvc.getByActorId(actorId);
  assert.ok(account);
  assert.equal(account.displayName, "17赫兹");
  assert.equal(account.setupComplete, true);
});

test("identity: prefs 落盘持久化（重启不丢名字）", async () => {
  const prefsModule = await import("../src/routes/http/user-preferences.js");
  // 出厂不预设名字：全新会话的档案是「未命名」态，不带任何自拟名字/handle
  const fresh = prefsModule.getUserPreferences("fresh-unnamed");
  assert.equal(fresh.agentProfile.displayName, "");
  assert.equal(fresh.agentProfile.handle, "");
  assert.equal(fresh.agentProfile.nameOrigin, "default");

  // 身份字段默认被拦，改名管道需显式放行（其余直写入口一律拦掉）
  prefsModule.patchAgentProfile(
    "test-actor-persist",
    {
      displayName: "过境",
      handle: "transit",
      nameOrigin: "self",
    },
    { allowIdentity: true },
  );
  // 落盘是异步链：全量并发跑时 30ms 固定等待会抖，轮询至多 3s
  let parsed: { sessions: Record<string, { agentProfile: { displayName: string } }> } | null = null;
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 50));
    try {
      const raw = await readFile(process.env.USER_PREFERENCES_FILE!, "utf8");
      parsed = JSON.parse(raw) as typeof parsed;
      if (parsed?.sessions?.["test-actor-persist"]?.agentProfile?.displayName === "过境") break;
    } catch {
      /* 文件未落，继续等 */
    }
  }
  assert.ok(parsed, "prefs 文件未在 3s 内落盘");
  assert.equal(parsed!.sessions["test-actor-persist"]?.agentProfile?.displayName, "过境");
});
