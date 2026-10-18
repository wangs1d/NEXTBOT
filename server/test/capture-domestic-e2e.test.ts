// 国内生态通知捕捉 → 聚合 → agent 检索 端到端 mock 测试（2026-10-18）。
//
// 完整链路（与 simulate-phone-bridge.ts 同构，起真实 WS 协议层）：
//   Android 通知监听（Kotlin，mock 为构造批次）→ phone.msg.report（WS）
//   → reportablePlatforms 门禁 → MessageHub.ingestInbound（SQLite 落库/判重）
//   → messages.search / messages.capture_status / messages.overview 工具可查
//
// 覆盖场景：
//   1. email 平台（QQ邮箱/网易邮箱通知，国内生态扩展）入站；
//   2. generic 平台（淘宝/菜鸟/银行等"其他应用"兜底归类）入站；
//   3. 群聊 MessagingStyle 多条消息（Kotlin 端全量遍历的产物）聚合进同一会话；
//   4. 重复上报 externalMessageId 判重；未识别平台被门禁拒绝（invalid）；
//   5. messages.search 关键词检索 + LIKE 通配符转义；
//   6. messages.capture_status 覆盖面清单 + 24h 条数 + 断流判定字段。
//
// mock 边界：不装 Android 模拟器、不发真通知——通知监听产物按其输出契约
// （platform/channelId/text/externalMessageId/capturedAt）直接构造 WS 批次。
process.env.PHONE_BRIDGE_ENABLED = "1";
process.env.AGENT_TOKENJUICE_ENABLED = "0";
process.env.AGENT_MEMORY_SYNC_ENABLED = "0";

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import Fastify from "fastify";
import websocket from "@fastify/websocket";
import WebSocket from "ws";

const { registerWebSocketRoute } = await import("../src/ws/connection.js");
const { PhoneBridgeCoordinator } = await import("../src/services/phone-bridge-coordinator.js");
const { MessageHubService } = await import("../src/services/message-hub-service.js");
const { MessagePlatformGateway } = await import("../src/services/message-platform-gateway.js");
const { ToolRegistry } = await import("../src/tools/tool-registry.js");
const { registerMessageHubTools } = await import("../src/tools/message-hub-tools.js");
type ToolContext = import("../src/tools/tool-registry.js").ToolContext;

const ACTOR = "sim-capture-user";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 扮演手机桥接的 WS 客户端：只收 report_ack、发 report 批次 */
class MockPhone {
  ws!: WebSocket;
  acks: Array<Record<string, unknown>> = [];

  constructor(private readonly port: number) {}

  async connect(): Promise<void> {
    this.ws = new WebSocket(`ws://127.0.0.1:${this.port}/ws`);
    await new Promise<void>((resolve, reject) => {
      this.ws.once("open", resolve);
      this.ws.once("error", reject);
    });
    this.ws.on("message", (raw: WebSocket.RawData) => {
      const event = JSON.parse(String(raw)) as { type: string; payload: Record<string, unknown> };
      if (event.type === "phone.msg.report_ack") this.acks.push(event.payload);
    });
    this.send("session.init", {
      sessionId: `sim-capture-${ACTOR}`,
      userId: ACTOR,
      phoneBridge: true,
      deviceId: "sim-phone",
      model: "Sim Android 15",
      // 模拟端侧已授予通知使用权（真实客户端注册前经 isListenerEnabled 查询后上报）
      notificationListenerEnabled: true,
    });
    const ack = await this.expect("phone.bridge.register_ack");
    assert.equal(ack.payload.ok, true, "手机桥接注册应成功");
  }

  expect(type: string, timeoutMs = 3000): Promise<{ type: string; payload: Record<string, unknown> }> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`等待 ${type} 超时`)), timeoutMs);
      const onMessage = (raw: WebSocket.RawData) => {
        const event = JSON.parse(String(raw)) as { type: string; payload: Record<string, unknown> };
        if (event.type === type) {
          clearTimeout(timer);
          this.ws.off("message", onMessage);
          resolve(event);
        }
      };
      this.ws.on("message", onMessage);
    });
  }

  send(type: string, payload: Record<string, unknown>): void {
    this.ws.send(JSON.stringify({ type, payload }));
  }

  /** 轮询等待指定 batchId 的 ack（模拟真实网络往返） */
  async waitForAck(batchId: string, timeoutMs = 3000): Promise<Record<string, unknown>> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const hit = this.acks.find((a) => a.batchId === batchId);
      if (hit) return hit;
      await sleep(50);
    }
    throw new Error(`等待 batch ${batchId} 的 ack 超时`);
  }
}

type Harness = {
  app: ReturnType<typeof Fastify>;
  hub: InstanceType<typeof MessageHubService>;
  phone: MockPhone;
  registry: ToolRegistry;
  makeCtx: () => ToolContext;
  phoneBridgeCoordinator: InstanceType<typeof PhoneBridgeCoordinator>;
  dataDir: string;
};

async function unwrap(name: string, input: Record<string, unknown>, ctx: ToolContext, registry: ToolRegistry) {
  const wrapped = (await registry.execute(name, input, ctx)) as { ok: boolean; result?: Record<string, unknown> };
  return (wrapped.result ?? wrapped) as Record<string, unknown>;
}

const harness = await (async (): Promise<Harness> => {
  const dataDir = mkdtempSync(join(tmpdir(), "capture-e2e-"));
  const hub = new MessageHubService(join(dataDir, "legacy.json"), join(dataDir, "message-hub.db"));
  await hub.load();

  const phoneBridgeCoordinator = new PhoneBridgeCoordinator({ onSync: () => {} });
  const gateway = new MessagePlatformGateway(process.env);

  const app = Fastify({ logger: false });
  await app.register(websocket);
  registerWebSocketRoute(app, {
    sessionService: { upsert: () => {} },
    realFundsWallet: { bootstrap: () => {} },
    worldService: { getOrCreate: () => ({}) },
    auditService: { record: async () => {} },
    wsConnectionRegistry: {
      register: () => {},
      unregister: () => {},
      trySend: () => true,
      // 每条业务消息都会刷新设备活跃度（connection.ts 消息入口）；桩为空操作
      touchActivity: () => {},
      deviceClassOf: () => "desktop",
    },
    agentPairingService: {},
    aipService: {},
    worldPartitionWsRegistry: { uniqueWatcherSessionIds: () => [], broadcastToPartition: () => {}, detachSocket: () => false },
    runtime: new Proxy({}, { get: (_t, prop) => () => { throw new Error(`runtime.${String(prop)} 不应被调用`); } }),
    socialFeedService: { unsubscribe: () => {} },
    computeQuotaService: {},
    agentMemorySyncService: {},
    unifiedIdempotencyService: {},
    desktopBridgeCoordinator: { unbindIfSocket: () => false, cancelPendingForSocket: () => {} },
    // 共用浏览器桥：close/重绑路径会调 unbindIfSocket（本测试不启用 browserBridge）
    sharedBrowserCoordinator: { unbindIfSocket: () => false, bindExecutor: () => {} },
    virtualPhoneService: {},
    virtualPhoneIncomingCoordinator: {},
    userPersonalizationService: {},
    deviceRegistry: {},
    devicePairingService: {},
    phoneBridgeCoordinator,
    // 按需位置协调器：手机桥接不启用定位，但 close 路径无条件调 unbindSocket
    locationCoordinator: {
      unbindSocket: () => {},
      bindSocket: () => {},
      sendTrackingConfig: () => {},
      completeFromSocket: () => {},
    },
    messageHubService: hub,
  } as never);
  await app.ready();
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  const phone = new MockPhone(port);
  await phone.connect();

  const registry = new ToolRegistry();
  registerMessageHubTools(registry, {
    hub,
    gateway,
    runtime: undefined as never,
    phoneBridgeCoordinator,
  });
  const makeCtx = (): ToolContext => ({
    sessionId: "sim-capture-session",
    userId: ACTOR,
    chatUserMessageId: "sim-round-1",
    phoneBridgeOnline: true,
  });

  return { app, hub, phone, registry, makeCtx, phoneBridgeCoordinator, dataDir };
})();

after(async () => {
  harness.phone.ws.close();
  await harness.app.close();
  // Windows 下 better-sqlite3 句柄未释放时 rmSync 会 EPERM——尽力清理
  try {
    rmSync(harness.dataDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

test("国内生态通知捕捉：邮箱/电商物流入站 + 群聊多条聚合 + 判重 + 未识别平台拒绝", async () => {
  // ① email 平台（QQ邮箱通知，模拟 Kotlin 端 com.tencent.androidqqmail → email 映射产物）
  const emailBatch = [
    {
      platform: "email",
      channelId: "顺丰速运",
      title: "QQ邮箱",
      senderName: "顺丰速运",
      text: "您的快递已存放至丰巢柜，取件码 8-3-2001，请及时领取",
      externalMessageId: "mail-001",
    },
  ];
  harness.phone.send("phone.msg.report", { batchId: "b-email", messages: emailBatch });
  const emailAck = await harness.phone.waitForAck("b-email");
  assert.equal(emailAck.accepted, 1, "email 平台应被服务端接受");

  // ② generic 平台（淘宝物流通知，"其他应用"兜底归类）
  const genericBatch = [
    {
      platform: "generic",
      channelId: "淘宝",
      title: "手机淘宝",
      senderName: "菜鸟裹裹",
      text: "包裹已发出，预计明天 18:00 前送达",
      externalMessageId: "tb-001",
    },
  ];
  harness.phone.send("phone.msg.report", { batchId: "b-generic", messages: genericBatch });
  const genericAck = await harness.phone.waitForAck("b-generic");
  assert.equal(genericAck.accepted, 1, "generic 平台应被服务端接受");

  // ③ 群聊 MessagingStyle 多条消息（Kotlin 全量遍历后一次上报多条，同群同 channelId）
  const groupBatch = [
    {
      platform: "wechat",
      channelId: "周末爬山群",
      title: "周末爬山群",
      senderName: "张三",
      text: "周六早上七点山门口集合，别迟到",
      externalMessageId: "wx-g-1",
    },
    {
      platform: "wechat",
      channelId: "周末爬山群",
      title: "周末爬山群",
      senderName: "李四",
      text: "收到，我负责带水和干粮",
      externalMessageId: "wx-g-2",
    },
  ];
  harness.phone.send("phone.msg.report", { batchId: "b-group", messages: groupBatch });
  const groupAck = await harness.phone.waitForAck("b-group");
  assert.equal(groupAck.accepted, 2, "群聊两条消息都应入库");

  // 群聊两条进同一会话（channelId 聚合）
  const conversations = harness.hub.listConversations(ACTOR);
  const groupConv = conversations.find((c) => c.channelId === "周末爬山群");
  assert.ok(groupConv, "应有「周末爬山群」会话");
  const groupMessages = harness.hub.listMessages(ACTOR, groupConv!.conversationId);
  assert.equal(groupMessages.length, 2, "群会话应有 2 条消息");
  assert.deepEqual(
    groupMessages.map((m) => m.senderName).sort(),
    ["张三", "李四"],
  );

  // ④ 重复上报（同 externalMessageId）判重
  harness.phone.send("phone.msg.report", { batchId: "b-dup", messages: [...emailBatch, ...genericBatch] });
  const dupAck = await harness.phone.waitForAck("b-dup");
  assert.equal(dupAck.duplicates, 2, "重复上报应全部判重");
  assert.equal(dupAck.accepted, 0);

  // ⑤ 未识别平台（未开 captureAll 时客户端根本不会上报；这里验证服务端门禁）
  harness.phone.send("phone.msg.report", {
    batchId: "b-invalid",
    messages: [{ platform: "telegram", channelId: "x", text: "hello", externalMessageId: "tg-1" }],
  });
  const invalidAck = await harness.phone.waitForAck("b-invalid");
  assert.equal(invalidAck.invalid, 1, "未识别平台应被门禁拒绝");

  // ⑥ messages.overview 全平台可见
  const overview = await unwrap("messages.overview", {}, harness.makeCtx(), harness.registry);
  const platformNames = (overview.platforms as Array<{ platform: string }>).map((p) => p.platform);
  assert.ok(platformNames.includes("email"), "overview 应含 email 平台");
  assert.ok(platformNames.includes("generic"), "overview 应含 generic 平台");
  assert.equal(overview.totalUnread, 4, "4 条新消息均未读");
});

test("messages.search：关键词检索命中 + LIKE 通配符按字面转义", async () => {
  // ① 关键词命中邮箱通知
  const hit = await unwrap("messages.search", { query: "取件码" }, harness.makeCtx(), harness.registry);
  assert.equal(hit.count, 1, "「取件码」应命中 1 条");
  const first = (hit.messages as Array<{ platform: string; text: string }>)[0];
  assert.equal(first.platform, "email");
  assert.ok(first.text.includes("取件码"));

  // ② LIKE 通配符按字面匹配（% 不应变成全匹配）
  const wildcard = await unwrap("messages.search", { query: "%" }, harness.makeCtx(), harness.registry);
  assert.equal(wildcard.count, 0, "「%」按字面匹配，不应命中任何消息");

  // ③ 平台过滤
  const filtered = await unwrap(
    "messages.search",
    { query: "包裹", platform: "generic" },
    harness.makeCtx(),
    harness.registry,
  );
  assert.equal(filtered.count, 1, "generic 平台「包裹」应命中淘宝物流通知");

  // ④ 缺关键词报错
  const missing = await unwrap("messages.search", {}, harness.makeCtx(), harness.registry);
  assert.equal(missing.ok, false);
});

test("messages.capture_status：覆盖面清单 + 24h 条数 + 断流判定", async () => {
  const status = await unwrap("messages.capture_status", {}, harness.makeCtx(), harness.registry);
  assert.equal(status.ok, true);
  // 授权状态透传：桥接在线 + 注册时上报 notificationListenerEnabled=true
  assert.equal(status.bridgeOnline, true, "手机桥接应在线");
  assert.equal(status.listenerEnabled, true, "注册上报的通知使用权状态应可被读取");

  const platforms = status.platforms as Array<{
    platform: string;
    hoursSinceLastCapture: number;
    countLast24h: number;
    stale: boolean;
  }>;
  assert.ok(platforms.length >= 3, "应有 email/generic/wechat 三个捕捉平台");

  const emailStat = platforms.find((p) => p.platform === "email");
  assert.ok(emailStat, "email 平台应有统计");
  assert.equal(emailStat!.countLast24h, 1, "email 24h 内 1 条");
  assert.equal(emailStat!.stale, false, "刚捕获不应判断流");
  assert.ok(emailStat!.hoursSinceLastCapture <= 1, "最近捕获时间应是 1 小时内");

  const covered = status.coveredApps as string[];
  assert.ok(covered.includes("微信") && covered.includes("QQ邮箱") && covered.includes("淘宝"));
  assert.ok(!covered.includes("Gmail") && !covered.includes("Outlook"), "国外源暂不接入");

  const summary = String(status.summary);
  assert.ok(summary.includes("通知捕捉覆盖"), "summary 应说明覆盖情况");
  assert.ok(!summary.includes("已超过 6 小时无捕捉"), "无断流时不应出现断流文案");
});

test("capture_status：未授权时引导 agent 发 permission_request 卡片", async () => {
  // 把注册上报的授权状态改写为 false（模拟用户未授予通知使用权）
  harness.phoneBridgeCoordinator.updateDeviceInfo(ACTOR, { notificationListenerEnabled: false });
  try {
    const status = await unwrap("messages.capture_status", {}, harness.makeCtx(), harness.registry);
    assert.equal(status.ok, true);
    assert.equal(status.listenerEnabled, false);
    const summary = String(status.summary);
    assert.ok(
      summary.includes("permission_request") && summary.includes("open_notification_listener_settings"),
      "未授权时 summary 应引导 agent 发授权卡",
    );
  } finally {
    // 还原，避免影响其他测试的授权状态读取
    harness.phoneBridgeCoordinator.updateDeviceInfo(ACTOR, { notificationListenerEnabled: true });
  }
});
