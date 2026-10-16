/**
 * e2e：Agent World 身份门禁 × 好友/站内信全链路（2026-10-16）。
 *
 * 验证目标（用户拍板语义）：
 *   1. agent 只要完成 Agent World 注册（world.open_registry.agent_quick）即可加好友；
 *      未注册 → WORLD_REGISTRATION_REQUIRED 结构化拦截 + fix 引导注册
 *   2. 加好友目标也须有世界身份（对方未注册 → 拦截）
 *   3. 站内信后台专用：不需要任何注册，仅好友关系门禁（非好友 → NOT_FRIENDS）
 *   4. 注册 → 加好友（双方）→ 对方接受 → 发消息送达（hub 落库 + WS 直推）
 *
 * 全部使用真实类与生产同款工具注册函数（ToolRegistry 进程内执行，不起 HTTP/WS），
 * 数据落临时目录（AGENT_ACCOUNTS_FILE / WORLD_STATE_FILE / hub 构造参数），无外部依赖。
 * 占位注册需 AGENT_WORLD_PLACEHOLDER_REGISTER=1（开发环境开关，agent_quick 工具自身校验）。
 */

process.env.AGENT_WORLD_PLACEHOLDER_REGISTER = "1";

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import assert from "node:assert/strict";

// 临时目录隔离（必须在 import 服务类之前设好 env）
const dir = await mkdtemp(join(tmpdir(), "world-identity-e2e-"));
process.env.AGENT_ACCOUNTS_FILE = join(dir, "agent-accounts.json");
process.env.WORLD_STATE_FILE = join(dir, "world-state.json");

const { WorldService } = await import("@private-ai-agent/agent-world");
const { AgentAccountService } = await import("../src/services/agent-account-service.js");
const { AgentRelayService } = await import("../src/services/agent-relay-service.js");
const { FriendService } = await import("../src/services/friend-service.js");
const { FriendMessageService } = await import("../src/services/friend-message-service.js");
const { MessageHubService } = await import("../src/services/message-hub-service.js");
const { registerWorldOpenRegistryTools } = await import(
  "../../agent-world/tools/world-open-registry-tools.js"
);
const { registerAgentLinkTools } = await import("../src/tools/agent-link-tools.js");
const { registerAgentRelayTools } = await import("../src/tools/agent-relay-tools.js");
const { registerMessageHubTools } = await import("../src/tools/message-hub-tools.js");
const { ToolRegistry } = await import("../src/tools/tool-registry.js");

type Step = { name: string; fn: () => Promise<void> | void };
const steps: Step[] = [];
let passed = 0;
function step(name: string, fn: Step["fn"]): void {
  steps.push({ name, fn });
}

// ── 装配（与 create-app-services 同款组件，数据全隔离）──
const accounts = new AgentAccountService();
await accounts.load();

const worldService = new WorldService();
await worldService.load();

const friends = new FriendService({
  dbPath: join(dir, "friends.db"),
  legacyJsonPath: join(dir, "friends-legacy.json"),
});
await friends.load();

const relay = new AgentRelayService();
const pushed: Array<{ targetId: string; envelope: Record<string, unknown> }> = [];
const hub = new MessageHubService(join(dir, "hub-legacy.json"), join(dir, "hub", "hub.db"));
await hub.load();

const friendMessages = new FriendMessageService({
  hub,
  relay,
  wsRegistry: { trySend: (targetId: string, data: string) => {
    pushed.push({ targetId, envelope: JSON.parse(data) as Record<string, unknown> });
    return true;
  } },
  accounts,
  friends,
});

const registry = new ToolRegistry();
registerWorldOpenRegistryTools(registry as never, worldService);
registerAgentRelayTools(registry, friendMessages, { arePaired: () => true } as never, accounts);
registerAgentLinkTools(registry, friends, accounts, worldService);
registerMessageHubTools(registry, {
  hub,
  gateway: { send: async () => ({ ok: false, delivered: false, message: "unused" }) } as never,
  runtime: {} as never,
  friendMessages,
});

const ctx = (sessionId: string) => ({ sessionId });

// ── 场景步骤 ──

step("① dave 未注册世界身份 → 加好友被 WORLD_REGISTRATION_REQUIRED 拦截 + fix 引导注册", async () => {
  const r = await registry.execute(
    "world.link.send_friend_request",
    { toActorId: "alice@test.local", message: "交个朋友" },
    ctx("dave@test.local"),
  );
  assert.ok(r.ok, `工具执行应成功（结构化失败在 result 内）：${JSON.stringify(r.result)}`);
  const payload = r.result as { ok: boolean; reason?: string; fix?: { tool?: string } };
  assert.equal(payload.ok, false);
  assert.equal(payload.reason, "WORLD_REGISTRATION_REQUIRED");
  assert.equal(payload.fix?.tool, "world.open_registry.agent_quick");
});

step("② dave 调 world.open_registry.agent_quick 完成真实世界注册", async () => {
  const r = await registry.execute("world.open_registry.agent_quick", {}, ctx("dave@test.local"));
  const payload = r.result as { ok: boolean; agentWorldRegistered?: boolean };
  assert.equal(payload.ok, true, `agent_quick 应成功：${JSON.stringify(r.result)}`);
  assert.equal(payload.agentWorldRegistered, true);
  assert.equal(
    worldService.isAgentWorldRegistered("dave@test.local"),
    true,
    "WorldService 应已标记 dave 已注册",
  );
});

step("③ alice 也完成世界注册（作为加好友目标）", async () => {
  const r = await registry.execute("world.open_registry.agent_quick", {}, ctx("alice@test.local"));
  const payload = r.result as { ok: boolean; agentWorldRegistered?: boolean };
  assert.equal(payload.ok, true);
  assert.equal(payload.agentWorldRegistered, true);
});

step("④ 注册后 dave → alice 发好友请求成功（无需 Agent 账号）", async () => {
  // dave / alice 均未注册 AgentAccountService 账号——验证门禁只看世界身份
  const r = await registry.execute(
    "world.link.send_friend_request",
    { toActorId: "alice@test.local", message: "交个朋友" },
    ctx("dave@test.local"),
  );
  assert.ok(r.ok, `发好友请求应成功：${JSON.stringify(r.result)}`);
  const payload = r.result as { ok: boolean; request?: { requestId: string } };
  assert.equal(payload.ok, true);
  assert.ok(payload.request?.requestId, "应返回 requestId");
});

step("⑤ alice 接受请求 → 双方成为好友", async () => {
  const requests = await registry.execute(
    "world.link.list_friend_requests",
    { scope: "incoming" },
    ctx("alice@test.local"),
  );
  const payload = requests.result as { requests?: Array<{ requestId: string; fromActorId: string }> };
  const req = payload.requests?.find((x) => x.fromActorId === "dave@test.local");
  assert.ok(req, "alice 应收到 dave 的好友请求");
  const r = await registry.execute(
    "world.link.respond_friend_request",
    { requestId: req.requestId, accept: true },
    ctx("alice@test.local"),
  );
  assert.ok(r.ok, `接受应成功：${JSON.stringify(r.result)}`);
  assert.ok(
    friends.areFriends("dave@test.local", "alice@test.local"),
    "FriendService 应确认好友关系",
  );
});

step("⑥ dave 给好友 alice 发站内消息 → WS 直推 + hub 落库（无注册前提）", async () => {
  const r = await registry.execute(
    "world.link.send_message",
    { targetSessionId: "alice@test.local", body: "注册完就能加好友发消息了" },
    ctx("dave@test.local"),
  );
  assert.ok(r.ok, `发消息应成功：${JSON.stringify(r.result)}`);
  const payload = r.result as { ok: boolean; pushedToPeer?: boolean };
  assert.equal(payload.ok, true);
  assert.equal(payload.pushedToPeer, true, "alice 在线应直推");
  assert.equal(pushed.length, 1);
  assert.equal(pushed[0].targetId, "alice@test.local");
  const conv = hub
    .listConversations("alice@test.local", { platform: "friend" })
    .find((c) => c.channelId === "dave@test.local");
  assert.ok(conv, "alice 应有 friend 会话");
  assert.equal(conv.unreadCount, 1);
});

step("⑦ eve（未注册）直接发消息给 dave → NOT_FRIENDS（站内信仅好友门禁）", async () => {
  const r = await registry.execute(
    "world.link.send_message",
    { targetSessionId: "dave@test.local", body: "我是路人" },
    ctx("eve@test.local"),
  );
  assert.ok(r.ok);
  const payload = r.result as { ok?: boolean; reason?: string; message?: string };
  assert.equal(payload.ok, false);
  assert.equal(payload.reason, "NOT_FRIENDS", "失败原因是好友关系而非身份");
  assert.match(payload.message ?? "", /world\.link\.send_friend_request/);
});

step("⑧ dave 请求未注册的 eve → 目标校验拦截", async () => {
  const r = await registry.execute(
    "world.link.send_friend_request",
    { toActorId: "eve@test.local" },
    ctx("dave@test.local"),
  );
  assert.equal(r.ok, false, "目标未注册应失败");
  assert.match(JSON.stringify(r.result), /Agent World 注册/);
});

// ── 执行 ──
let failed = 0;
for (const s of steps) {
  try {
    await s.fn();
    passed += 1;
    console.log(`✔ ${s.name}`);
  } catch (err) {
    failed += 1;
    console.error(`✖ ${s.name}\n  ${err instanceof Error ? err.message : String(err)}`);
  }
}

await hub.close();
await friends.close();
await rm(dir, { recursive: true, force: true });

console.log(`\n${failed === 0 ? "✅ 全链路验证通过" : "❌ 存在失败"}：pass ${passed} / fail ${failed}`);
if (failed > 0) process.exitCode = 1;
