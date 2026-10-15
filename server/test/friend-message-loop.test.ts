/**
 * 站内好友消息闭环（2026-10-15）端到端单测。
 *
 * 覆盖「agent 给好友发消息」全环：
 *   1. agent.send_to_peer 工具 → 接收方 hub 持久入站（platform=friend）+
 *      发送方 hub 留档（outbound）+ WS 直推（含 fromName）+ lastMessageAt 双向
 *   2. 对方离线（trySend=false）→ 消息仍持久落库；hub 重建（模拟重启）后不丢
 *   3. 重连补投 replayUnread：未读会话重推最新一条；标读后不再推
 *   4. messages.reply 在 friend 平台会话上真实回信（经同一投递内核）
 *   5. 入口闸豁免：friend 平台带强模板词（验证码/中奖）的好友消息不被吞
 *
 * 测试封闭：临时目录 SQLite/JSON，无外部依赖；AGENT_TOOL_PROMOTION_STATE_PATH
 * 无关本测试（未触 preload 链路）。
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AgentAccountService } from "../src/services/agent-account-service.js";
import { AgentRelayService } from "../src/services/agent-relay-service.js";
import { FriendMessageService } from "../src/services/friend-message-service.js";
import { FriendService } from "../src/services/friend-service.js";
import { MessageHubService } from "../src/services/message-hub-service.js";
import { gateInboundMessage } from "../src/services/message-gate.js";
import { registerAgentRelayTools } from "../src/tools/agent-relay-tools.js";
import { registerMessageHubTools } from "../src/tools/message-hub-tools.js";
import { ToolRegistry, type ToolContext } from "../src/tools/tool-registry.js";

type PushRecord = { targetId: string; envelope: Record<string, unknown> };

function makeWsRegistry() {
  const pushed: PushRecord[] = [];
  return {
    pushed,
    trySend(targetId: string, data: string): boolean {
      pushed.push({ targetId, envelope: JSON.parse(data) as Record<string, unknown> });
      return true;
    },
    /** 离线模拟开关 */
    online: true,
  };
}

interface Harness {
  dir: string;
  accounts: AgentAccountService;
  friends: FriendService;
  relay: AgentRelayService;
  hub: MessageHubService;
  friendMessages: FriendMessageService;
  ws: ReturnType<typeof makeWsRegistry>;
  registry: ToolRegistry;
  dbPath: string;
  hubDbPath: string;
  savedAccountsFile?: string;
}

async function buildHarness(): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), "friend-msg-loop-"));
  const hubDbPath = join(dir, "message-hub", "hub.db");

  // AgentAccountService 缺省写 cwd/data/agent-accounts.json（生产文件）——
  // 测试必须用临时路径隔离，teardown 恢复
  const savedAccountsFile = process.env.AGENT_ACCOUNTS_FILE;
  process.env.AGENT_ACCOUNTS_FILE = join(dir, "agent-accounts.json");

  const accounts = new AgentAccountService();
  await accounts.load();
  await accounts.register("alice@test.local", "爱丽丝");
  await accounts.register("bob@test.local", "鲍勃");

  const friends = new FriendService({
    dbPath: join(dir, "friends.db"),
    legacyJsonPath: join(dir, "friends-legacy.json"),
  });
  await friends.load();

  const relay = new AgentRelayService();
  const ws = makeWsRegistry();

  const hub = new MessageHubService(join(dir, "message-hub-legacy.json"), hubDbPath);
  await hub.load();

  const friendMessages = new FriendMessageService({
    hub,
    relay,
    wsRegistry: { trySend: (id, data) => (ws.online ? ws.trySend(id, data) : false) },
    accounts,
    friends,
  });

  const registry = new ToolRegistry();
  registerAgentRelayTools(registry, friendMessages, {
    arePaired: () => true,
  } as never, accounts);
  registerMessageHubTools(registry, {
    hub,
    gateway: { send: async () => ({ ok: false, delivered: false, message: "unused" }) } as never,
    runtime: {} as never,
    friendMessages,
  });

  return {
    dir, accounts, friends, relay, hub, friendMessages, ws, registry,
    dbPath: dir, hubDbPath, savedAccountsFile,
  };
}

async function teardown(h: Harness): Promise<void> {
  h.hub.close();
  h.friends.close();
  if (h.savedAccountsFile === undefined) {
    delete process.env.AGENT_ACCOUNTS_FILE;
  } else {
    process.env.AGENT_ACCOUNTS_FILE = h.savedAccountsFile;
  }
  await rm(h.dir, { recursive: true, force: true });
}

const ALICE_CTX: ToolContext = { sessionId: "alice@test.local" };
const BOB_CTX: ToolContext = { sessionId: "bob@test.local" };

async function makeFriends(h: Harness): Promise<void> {
  const req = await h.friends.sendFriendRequest("alice@test.local", "bob@test.local");
  assert.ok(req.ok);
  const responded = await h.friends.respondToRequest(req.request.requestId, "bob@test.local", true);
  assert.ok(responded.ok);
}

test("agent.send_to_peer 全环：接收方 hub 入站 + 发送方留档 + WS 直推 + lastMessageAt", async () => {
  const h = await buildHarness();
  try {
    await makeFriends(h);
    const result = await h.registry.execute(
      "agent.send_to_peer",
      { targetSessionId: "bob@test.local", body: "今晚一起吃饭吗？" },
      ALICE_CTX,
    );
    assert.ok(result.ok, `工具应成功：${JSON.stringify(result.result)}`);
    assert.equal(result.result.pushedToPeer, true);

    // 接收方 hub：持久入站 + 未读 + 友好标题/发送者名
    const bobConv = h.hub
      .listConversations("bob@test.local", { platform: "friend" })
      .find((c) => c.channelId === "alice@test.local");
    assert.ok(bobConv, "接收方应有 friend 会话");
    assert.equal(bobConv.unreadCount, 1);
    assert.equal(bobConv.participantName, "爱丽丝");
    const bobMessages = h.hub.listMessages("bob@test.local", bobConv.conversationId);
    assert.equal(bobMessages.length, 1);
    assert.equal(bobMessages[0].direction, "inbound");
    assert.equal(bobMessages[0].text, "今晚一起吃饭吗？");

    // 发送方 hub：outbound 留档
    const aliceConv = h.hub
      .listConversations("alice@test.local", { platform: "friend" })
      .find((c) => c.channelId === "bob@test.local");
    assert.ok(aliceConv, "发送方应有 friend 会话留档");
    const aliceMessages = h.hub.listMessages("alice@test.local", aliceConv.conversationId);
    assert.equal(aliceMessages.length, 1);
    assert.equal(aliceMessages[0].direction, "outbound");
    assert.equal(aliceConv.unreadCount, 0, "自己发出的消息不计未读");

    // WS 直推载荷：fromName 用显示名（客户端 toast/通知直接可读）
    assert.equal(h.ws.pushed.length, 1);
    const payload = h.ws.pushed[0].envelope.payload as Record<string, unknown>;
    assert.equal(payload.fromName, "爱丽丝");
    assert.equal(payload.text, "今晚一起吃饭吗？");

    // lastMessageAt 双向刷新
    const aliceFriend = h.friends.getFriends("alice@test.local").find((f) => f.friendActorId === "bob@test.local");
    const bobFriend = h.friends.getFriends("bob@test.local").find((f) => f.friendActorId === "alice@test.local");
    assert.ok(aliceFriend?.lastMessageAt, "发送方 lastMessageAt 应刷新");
    assert.ok(bobFriend?.lastMessageAt, "接收方 lastMessageAt 应刷新");

    // 内存中继收件箱（/agent/inbox 兼容面）照常
    assert.equal(h.relay.listInbox("bob@test.local").length, 1);
  } finally {
    await teardown(h);
  }
});

test("对方离线也必达：hub 持久落库，模拟重启后消息仍在且可补投", async () => {
  const h = await buildHarness();
  try {
    await makeFriends(h);
    h.ws.online = false; // 对方离线
    const result = await h.registry.execute(
      "agent.send_to_peer",
      { targetSessionId: "bob@test.local", body: "离线也要送达" },
      ALICE_CTX,
    );
    assert.ok(result.ok);
    assert.equal(result.result.pushedToPeer, false);

    // 模拟服务端重启：关库重建
    h.hub.close();
    h.friends.close();
    const hub2 = new MessageHubService(join(h.dir, "legacy2.json"), h.hubDbPath);
    await hub2.load();
    const friends2 = new FriendService({
      dbPath: join(h.dir, "friends.db"),
      legacyJsonPath: join(h.dir, "friends-legacy.json"),
    });
    await friends2.load();

    const conv = hub2
      .listConversations("bob@test.local", { platform: "friend" })
      .find((c) => c.channelId === "alice@test.local");
    assert.ok(conv, "重启后接收方 friend 会话仍在");
    assert.equal(conv.unreadCount, 1);
    const messages = hub2.listMessages("bob@test.local", conv.conversationId);
    assert.equal(messages.length, 1);
    assert.equal(messages[0].text, "离线也要送达");

    // 重连补投：未读 → 重推最新一条
    const ws2 = makeWsRegistry();
    const svc2 = new FriendMessageService({
      hub: hub2,
      relay: h.relay,
      wsRegistry: { trySend: (id, data) => ws2.trySend(id, data) },
      accounts: h.accounts,
      friends: friends2,
    });
    const replayed = await svc2.replayUnread("bob@test.local");
    assert.equal(replayed, 1);
    assert.equal(ws2.pushed.length, 1);
    const payload = ws2.pushed[0].envelope.payload as Record<string, unknown>;
    assert.equal(payload.replayed, true);
    assert.equal(payload.text, "离线也要送达");

    // 标读后不再补投
    await svc2.markRead("bob@test.local", "alice@test.local");
    assert.equal(await svc2.replayUnread("bob@test.local"), 0);

    hub2.close();
    friends2.close();
  } finally {
    await teardown(h);
  }
});

test("messages.reply 在 friend 会话上真实回信", async () => {
  const h = await buildHarness();
  try {
    await makeFriends(h);
    // 鲍勃的爱丽丝会话（由 alice 先发一条建立）
    await h.registry.execute(
      "agent.send_to_peer",
      { targetSessionId: "bob@test.local", body: "在吗" },
      ALICE_CTX,
    );
    const bobConv = h.hub
      .listConversations("bob@test.local", { platform: "friend" })
      .find((c) => c.channelId === "alice@test.local");
    assert.ok(bobConv);

    const before = h.ws.pushed.length;
    const result = await h.registry.execute(
      "messages.reply",
      { conversationId: bobConv.conversationId, text: "在的，怎么了" },
      BOB_CTX,
    );
    assert.ok(result.ok, `messages.reply 应成功：${JSON.stringify(result.result)}`);
    assert.equal(result.result.delivered, true);

    // 爱丽丝侧收到入站
    const aliceConv = h.hub
      .listConversations("alice@test.local", { platform: "friend" })
      .find((c) => c.channelId === "bob@test.local");
    assert.ok(aliceConv);
    assert.equal(aliceConv.unreadCount, 1);
    const aliceMessages = h.hub.listMessages("alice@test.local", aliceConv.conversationId);
    const last = aliceMessages[aliceMessages.length - 1];
    assert.equal(last.direction, "inbound");
    assert.equal(last.text, "在的，怎么了");
    assert.equal(last.senderName, "鲍勃");

    // WS 又推了一条（直推爱丽丝在线连接）
    assert.equal(h.ws.pushed.length, before + 1);
    assert.equal(h.ws.pushed[h.ws.pushed.length - 1].targetId, "alice@test.local");
  } finally {
    await teardown(h);
  }
});

test("入口闸豁免 friend 平台：强模板词的好友消息不被吞", () => {
  const verdict = gateInboundMessage({
    actorId: "bob@test.local",
    platform: "friend",
    channelId: "alice@test.local",
    text: "我中奖了哈哈，请你吃饭",
  });
  assert.equal(verdict.gated, false, "好友消息是产品内建人际通道，绝不能被模板特征静默吞掉");
  // 对照组：同样文本走非豁免平台仍被强模板拦截
  const smsVerdict = gateInboundMessage({
    actorId: "bob@test.local",
    platform: "sms",
    channelId: "10086",
    text: "我中奖了哈哈，请你吃饭",
  });
  assert.equal(smsVerdict.gated, true);
});
