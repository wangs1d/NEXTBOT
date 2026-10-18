/**
 * 站内好友消息闭环（2026-10-15）端到端单测。
 *
 * 覆盖「agent 给好友发消息」全环：
 *   1. world.link.send_message 工具 → 接收方 hub 持久入站（platform=friend）+
 *      发送方 hub 留档（outbound）+ WS 直推（含 fromName）+ lastMessageAt 双向
 *   2. 对方离线（trySend=false）→ 消息仍持久落库；hub 重建（模拟重启）后不丢
 *   3. 重连补投 replayUnread：未读会话重推最新一条；标读后不再推
 *   4. messages.reply 在 friend 平台会话上真实回信（经同一投递内核）
 *   5. 入口闸豁免：friend 平台带强模板词（验证码/中奖）的好友消息不被吞
 *   6. seq 单调递增 + sinceSeq 增量拉取（2026-10-17 断线补拉游标）
 *   7. 已读回执：标读后对端收到 agent.peer_read_receipt，lastReadSeq
 *      经 externalMessageId 翻译到对端会话空间（2026-10-17）
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
import { registerAgentLinkTools } from "../src/tools/agent-link-tools.js";
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
  /** fake 世界身份注册表：好友请求门禁用（world.open_registry 语义） */
  worldRegistered: Set<string>;
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

  const worldRegistered = new Set(["alice@test.local", "bob@test.local"]);
  const worldService = { isAgentWorldRegistered: (id: string) => worldRegistered.has(id) };

  const registry = new ToolRegistry();
  registerAgentRelayTools(registry, friendMessages, {
    arePaired: () => true,
  } as never, accounts);
  registerAgentLinkTools(registry, friends, accounts, worldService as never);
  registerMessageHubTools(registry, {
    hub,
    gateway: { send: async () => ({ ok: false, delivered: false, message: "unused" }) } as never,
    runtime: {} as never,
    friendMessages,
  });

  return {
    dir, accounts, friends, relay, hub, friendMessages, ws, registry,
    dbPath: dir, hubDbPath, savedAccountsFile, worldRegistered,
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

test("world.link.send_message 全环：接收方 hub 入站 + 发送方留档 + WS 直推 + lastMessageAt", async () => {
  const h = await buildHarness();
  try {
    await makeFriends(h);
    const result = await h.registry.execute(
      "world.link.send_message",
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
      "world.link.send_message",
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
      "world.link.send_message",
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

test("门禁：无世界身份发起方调 world.link.send_friend_request → WORLD_REGISTRATION_REQUIRED 引导注册", async () => {
  const h = await buildHarness();
  try {
    // dave 无 Agent World 身份（harness 默认只有 alice/bob 有）
    const ctx: ToolContext = { sessionId: "dave@test.local" };
    const result = await h.registry.execute(
      "world.link.send_friend_request",
      { toActorId: "bob@test.local", message: "交个朋友" },
      ctx,
    );
    assert.ok(result.ok, `工具本身应执行成功（结构化返回而非 throw）：${JSON.stringify(result.result)}`);
    const payload = result.result as { ok: boolean; reason?: string; message?: string; fix?: { tool?: string } };
    assert.equal(payload.ok, false);
    assert.equal(payload.reason, "WORLD_REGISTRATION_REQUIRED");
    assert.match(payload.message ?? "", /world\.open_registry/);
    assert.equal(payload.fix?.tool, "world.open_registry.agent_quick");

    // 目标无世界身份：发起方有身份但对方没有 → 目标校验拦截
    h.worldRegistered.add("dave@test.local");
    const eveResult = await h.registry.execute(
      "world.link.send_friend_request",
      { toActorId: "eve@test.local", message: "交个朋友" },
      ctx,
    );
    assert.equal(eveResult.ok, false, "目标未完成世界注册应失败");
    assert.match(JSON.stringify(eveResult), /Agent World 注册/);

    // 站内信无注册前提：无身份的 dave 发消息只按好友关系判定（非好友 → NOT_FRIENDS）
    const sendResult = await h.registry.execute(
      "world.link.send_message",
      { targetSessionId: "bob@test.local", body: "在吗" },
      ctx,
    );
    assert.ok(sendResult.ok, "execute 层应成功（结构化失败放在 result 内）");
    const sendFailure = sendResult.result as { ok?: boolean; message?: string; reason?: string };
    assert.equal(sendFailure.ok, false, "非好友发送应失败");
    assert.equal(sendFailure.reason, "NOT_FRIENDS", "失败原因是好友关系而非身份（站内信无注册前提）");
    // 无落库、无推送、无收件
    assert.equal(h.ws.pushed.length, 0);
    assert.equal(h.relay.listInbox("bob@test.local").length, 0);
  } finally {
    await teardown(h);
  }
});

test("门禁：非好友（未注册）调 world.link.send_message → NOT_FRIENDS 且五处落点全无", async () => {
  const h = await buildHarness();
  try {
    // carol 未注册任何身份（站内信不设注册前提，仅好友关系门禁）
    const result = await h.registry.execute(
      "world.link.send_message",
      { targetSessionId: "carol@test.local", body: "我还没加你好友" },
      ALICE_CTX,
    );
    assert.ok(result.ok, "execute 层应成功（结构化失败放在 result 内）");
    const failure = result.result as { ok?: boolean; message?: string; reason?: string };
    assert.equal(failure.ok, false, "非好友发送应失败");
    assert.match(failure.message ?? "", /world\.link\.send_friend_request/);
    assert.equal(failure.reason, "NOT_FRIENDS");

    // 五处落点全无：hub 对方无入站、发送方无留档、WS 无推送、relay 无收件、无 lastMessageAt
    const carolConv = h.hub
      .listConversations("carol@test.local", { platform: "friend" })
      .find((c) => c.channelId === "alice@test.local");
    assert.equal(carolConv, undefined, "接收方不应有 friend 会话");
    assert.equal(h.ws.pushed.length, 0);
    assert.equal(h.relay.listInbox("carol@test.local").length, 0);
  } finally {
    await teardown(h);
  }
});

test("门禁：messages.reply 对非好友 friend 会话返回 NOT_FRIENDS 结构", async () => {
  const h = await buildHarness();
  try {
    // 模拟「曾是好友后被删」的残留会话：carol 给 bob 灌一条 friend 入站建立会话
    await h.hub.ingestInbound({
      actorId: "bob@test.local",
      platform: "friend",
      channelId: "carol@test.local",
      text: "还加我好友吗",
      participantId: "carol@test.local",
      participantName: "卡罗尔",
      senderId: "carol@test.local",
      senderName: "卡罗尔",
    });
    const bobConv = h.hub
      .listConversations("bob@test.local", { platform: "friend" })
      .find((c) => c.channelId === "carol@test.local");
    assert.ok(bobConv, "前置：残留 friend 会话已建立");

    const result = await h.registry.execute(
      "messages.reply",
      { conversationId: bobConv.conversationId, text: "不加" },
      BOB_CTX,
    );
    assert.ok(result.ok, "execute 层应成功（结构化失败放在 result 内）");
    const failure = result.result as { ok?: boolean; error?: string; reason?: string };
    assert.equal(failure.ok, false, "非好友回信应失败");
    assert.equal(failure.reason, "NOT_FRIENDS");
    assert.match(failure.error ?? "", /world\.link\.send_friend_request/);
    // 对方未收到任何东西
    assert.equal(h.ws.pushed.length, 0);
    assert.equal(h.relay.listInbox("carol@test.local").length, 0);
  } finally {
    await teardown(h);
  }
});

test("seq 会话内单调递增；sinceSeq 游标只回增量（hub + listTranscript 同口径）", async () => {
  const h = await buildHarness();
  try {
    await makeFriends(h);
    for (const text of ["第1条", "第2条", "第3条"]) {
      const r = await h.registry.execute(
        "world.link.send_message",
        { targetSessionId: "bob@test.local", body: text },
        ALICE_CTX,
      );
      assert.ok(r.ok);
    }

    const bobConv = h.hub
      .listConversations("bob@test.local", { platform: "friend" })
      .find((c) => c.channelId === "alice@test.local");
    assert.ok(bobConv);
    const all = h.hub.listMessages("bob@test.local", bobConv.conversationId);
    assert.deepEqual(
      all.map((m) => m.seq),
      [1, 2, 3],
      "会话内 seq 应从 1 单调递增",
    );
    // 发送方 outbound 副本同规则独立编号
    const aliceConv = h.hub
      .listConversations("alice@test.local", { platform: "friend" })
      .find((c) => c.channelId === "bob@test.local");
    assert.ok(aliceConv);
    assert.deepEqual(
      h.hub.listMessages("alice@test.local", aliceConv.conversationId).map((m) => m.seq),
      [1, 2, 3],
    );

    // sinceSeq=1 → 只回 2、3；sinceSeq=2 → 只回 3
    const delta1 = h.hub.listMessages("bob@test.local", bobConv.conversationId, { sinceSeq: 1 });
    assert.deepEqual(delta1.map((m) => m.seq), [2, 3]);
    assert.deepEqual(delta1.map((m) => m.text), ["第2条", "第3条"]);
    const delta2 = h.friendMessages.listTranscript("bob@test.local", "alice@test.local", 100, 2);
    assert.deepEqual(delta2.map((m) => m.seq), [3]);
  } finally {
    await teardown(h);
  }
});

test("已读回执：标读后对端收到 agent.peer_read_receipt，lastReadSeq 翻译到对端会话空间", async () => {
  const h = await buildHarness();
  try {
    await makeFriends(h);
    // alice → bob 两条：alice 会话 outbound seq=1,2；bob 会话 inbound seq=1,2（同 externalMessageId 配对）
    await h.registry.execute(
      "world.link.send_message",
      { targetSessionId: "bob@test.local", body: "你好" },
      ALICE_CTX,
    );
    await h.registry.execute(
      "world.link.send_message",
      { targetSessionId: "bob@test.local", body: "在吗" },
      ALICE_CTX,
    );
    const pushesBefore = h.ws.pushed.length;

    const ok = await h.friendMessages.markRead("bob@test.local", "alice@test.local");
    assert.equal(ok, true);

    const receipt = h.ws.pushed
      .slice(pushesBefore)
      .find((p) => p.targetId === "alice@test.local" && p.envelope.type === "agent.peer_read_receipt");
    assert.ok(receipt, "alice 应收到 bob 的已读回执");
    const payload = receipt.envelope.payload as Record<string, unknown>;
    assert.equal(payload.readerActorId, "bob@test.local");
    // bob 会话最新 seq=2（R2）；R2 在 alice 会话空间的 outbound 副本 seq 同为 2
    assert.equal(payload.lastReadSeq, 2);
    assert.ok(typeof payload.readAt === "string");

    // 标读幂等重放：再标读一次仍可产生回执（尽力而为语义），但 lastReadSeq 不回退
    await h.friendMessages.markRead("bob@test.local", "alice@test.local");
    const receipts = h.ws.pushed
      .slice(pushesBefore)
      .filter((p) => p.envelope.type === "agent.peer_read_receipt");
    for (const r of receipts) {
      assert.equal((r.envelope.payload as Record<string, unknown>).lastReadSeq, 2);
    }
  } finally {
    await teardown(h);
  }
});
