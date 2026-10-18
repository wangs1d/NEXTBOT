/**
 * 手机桥接端到端模拟（无真机、无 LLM、无完整装配）。
 *
 * 思路同 test/phone-dial-virtual-e2e.test.ts：真实 Fastify + 真实 WS 协议层
 * （registerWebSocketRoute）+ 真实 PhoneBridgeCoordinator + 真实 MessageHubService
 * （SQLite）+ 真实位置管线（LocationHistoryService/IngestPipeline）+ 真实
 * MessagePlatformGateway（sms 路由），一个进程内 WS 客户端扮演手机执行器。
 *
 * 验证链路：
 *   1. 消息自动抓取：phone.msg.report → ack → 聚合中心落库 → messages.overview /
 *      read_conversation 工具可查 → 重复上报判重 → 重要关键词触发 MessageWatchTrigger；
 *   2. 定位实时回传：phone.loc.report → location.db 落库可查；
 *   3. 按需定位：phone.locate 工具 → 服务端下发 invoke → 虚拟手机回 GPS；
 *   4. 短信代发：messages.reply（sms 会话）→ gateway sms 路由 → invoke(send_sms)
 *      → 虚拟手机确认 → delivered:true。
 *
 * 运行：npx tsx scripts/simulate-phone-bridge.ts
 */
process.env.PHONE_BRIDGE_ENABLED = "1";
process.env.AGENT_TOKENJUICE_ENABLED = "0";
process.env.AGENT_MEMORY_SYNC_ENABLED = "0";

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DATA_DIR = mkdtempSync(join(tmpdir(), "phone-sim-"));

import Fastify from "fastify";
import websocket from "@fastify/websocket";
import WebSocket from "ws";
import Database from "better-sqlite3";

const { registerWebSocketRoute } = await import("../src/ws/connection.js");
const { PhoneBridgeCoordinator } = await import("../src/services/phone-bridge-coordinator.js");
const { LocationCoordinator } = await import("../src/services/location-coordinator.js");
const { MessageHubService } = await import("../src/services/message-hub-service.js");
const { LocationHistoryService } = await import("../src/services/location-history-service.js");
const { LocationIngestPipeline } = await import("../src/services/location-ingest-pipeline.js");
const { MessagePlatformGateway } = await import("../src/services/message-platform-gateway.js");
const { ToolRegistry } = await import("../src/tools/tool-registry.js");
const { registerPhoneBridgeTools } = await import("../src/tools/phone-bridge-tools.js");
const { registerMessageHubTools } = await import("../src/tools/message-hub-tools.js");
const { MessageWatchTrigger } = await import("../src/proactivity/triggers/message-watch-trigger.js");
type ToolContext = import("../src/tools/tool-registry.js").ToolContext;

const USER_ID = "sim-user-01";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function section(title: string, data: unknown) {
  console.log(`\n===== ${title} =====`);
  console.log(typeof data === "string" ? data : JSON.stringify(data, null, 2));
}

type InvokeRecord = { jobId: string; action: string; params: Record<string, unknown> };

/** 扮演用户手机的 WS 客户端：自动应答 locate / send_sms / dial 指令 */
class VirtualPhone {
  ws!: WebSocket;
  acks: Array<Record<string, unknown>> = [];
  invokes: InvokeRecord[] = [];

  constructor(private readonly port: number) {}

  async connect(): Promise<void> {
    this.ws = new WebSocket(`ws://127.0.0.1:${this.port}/ws`);
    await new Promise<void>((resolve, reject) => {
      this.ws.once("open", resolve);
      this.ws.once("error", reject);
    });
    this.ws.on("message", (raw: WebSocket.RawData) => {
      const event = JSON.parse(raw.toString()) as { type: string; payload: Record<string, unknown> };
      if (event.type === "phone.msg.report_ack") {
        this.acks.push(event.payload);
        return;
      }
      if (event.type === "phone.bridge.invoke") {
        const rec: InvokeRecord = {
          jobId: String(event.payload.jobId ?? ""),
          action: String(event.payload.action ?? ""),
          params: (event.payload.params ?? {}) as Record<string, unknown>,
        };
        this.invokes.push(rec);
        // 模拟 Dart 侧行为：确认窗用户直接同意；locate 回一组 GPS
        const reply =
          rec.action === "locate"
            ? { ok: true, latitude: 31.2304, longitude: 121.4737, accuracy: 18.5, timestamp: new Date().toISOString() }
            : rec.action === "send_sms"
              ? { ok: true, state: "sent", number: rec.params.number }
              : rec.action === "dial"
                ? { ok: true, state: "dialing", number: rec.params.number }
                : { ok: false, error: `sim_not_implemented:${rec.action}` };
        setTimeout(() => {
          this.send("phone.bridge.result", { jobId: rec.jobId, ...reply });
        }, 200);
      }
    });
    this.send("session.init", {
      sessionId: `sim-phone-${USER_ID}`,
      userId: USER_ID,
      phoneBridge: true,
      deviceId: "sim-phone",
      model: "Sim Android 15",
    });
    const ack = await this.expect("phone.bridge.register_ack");
    if (ack.payload.ok !== true) throw new Error("手机注册失败");
  }

  expect(type: string, timeoutMs = 5000): Promise<{ type: string; payload: Record<string, unknown> }> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`等待 ${type} 超时`)), timeoutMs);
      const onMessage = (raw: WebSocket.RawData) => {
        const event = JSON.parse(raw.toString()) as { type: string; payload: Record<string, unknown> };
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
}

async function main() {
  // ─── 真实服务组件 ───
  const hub = new MessageHubService(
    join(DATA_DIR, "legacy-message-hub.json"), // 不存在 → 不迁移
    join(DATA_DIR, "message-hub.db"),
  );
  await hub.load();

  const locationHistory = new LocationHistoryService({ dbPath: join(DATA_DIR, "location.db") });
  const locationIngest = new LocationIngestPipeline({
    history: locationHistory,
    geofence: null,
    minIntervalMs: 0, // 模拟不频控
  });

  // 重要消息主动提醒：真实 MessageWatchTrigger 挂到真实 hub.onInbound
  const proposals: Array<Record<string, unknown>> = [];
  const messageWatchTrigger = new MessageWatchTrigger({
    submitProposal: (p) => proposals.push(p as unknown as Record<string, unknown>),
  });
  hub.onInbound = (input) => messageWatchTrigger.handleInbound(input);

  const phoneBridgeCoordinator = new PhoneBridgeCoordinator({ onSync: () => {} });
  const locationCoordinator = new LocationCoordinator();

  // 真实消息外发网关 + 真实手机桥发送端口（sms → send_sms invoke）
  const gateway = new MessagePlatformGateway(process.env);
  gateway.setPhoneBridgeSender({
    hasExecutor: (actorId) => phoneBridgeCoordinator.hasExecutor(actorId),
    invoke: (actorId, action, params) => phoneBridgeCoordinator.invoke(actorId, action, params),
  });

  // ─── 真实 WS 协议层（业务无关依赖桩化） ───
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
    sharedBrowserCoordinator: { unbindIfSocket: () => false, bindExecutor: () => {} },
    locationIngest,
    virtualPhoneService: {},
    virtualPhoneIncomingCoordinator: {},
    userPersonalizationService: {},
    deviceRegistry: {},
    devicePairingService: {},
    phoneBridgeCoordinator,
    locationCoordinator,
    messageHubService: hub,
  } as never);
  await app.ready();
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  console.log(`server listening on 127.0.0.1:${port}`);

  // ─── 真实 ToolRegistry（agent 的真实调用面） ───
  const registry = new ToolRegistry();
  registerPhoneBridgeTools(registry, { bridge: phoneBridgeCoordinator });
  registerMessageHubTools(registry, { hub, gateway, runtime: undefined as never });
  const makeCtx = (overrides: Partial<ToolContext> = {}): ToolContext => ({
    sessionId: "sim-chat-session",
    userId: USER_ID,
    chatUserMessageId: "sim-round-1",
    phoneBridgeOnline: phoneBridgeCoordinator.getSyncPayload(USER_ID).phoneBridgeOnline,
    ...overrides,
  });

  // ─── 手机上线 ───
  const phone = new VirtualPhone(port);
  await phone.connect();
  console.log("virtual phone registered");

  // ═══ 链路 1：消息自动抓取 ═══
  const batch1 = [
    { platform: "wechat", channelId: "zhangsan", title: "张三", senderName: "张三", text: "今天下午的会议推迟到周五下午2点，请尽快回复", externalMessageId: "wx-001" },
    { platform: "wechat", channelId: "zhangsan", title: "张三", senderName: "张三", text: "收到了吗？", externalMessageId: "wx-002" },
    { platform: "qq", channelId: "lisi", title: "李四", senderName: "李四", text: "晚上一起吃饭吗？", externalMessageId: "qq-001" },
    { platform: "feishu", channelId: "proj-group", title: "项目群", senderName: "王五", text: "周五团建改到下周三了，大家注意时间", externalMessageId: "fs-001" },
    { platform: "sms", channelId: "10086", title: "10086", senderName: "10086", text: "您的话费余额不足，请及时充值", externalMessageId: "sms-001" },
  ];
  phone.send("phone.msg.report", { batchId: "batch-1", messages: batch1 });
  await sleep(800);
  section("1a. 首次上报 ack（期望 accepted=5）", phone.acks.filter((a) => a.batchId === "batch-1"));

  phone.send("phone.msg.report", { batchId: "batch-1-dup", messages: batch1 });
  await sleep(800);
  section("1b. 重复上报 ack（期望 duplicates=5）", phone.acks.filter((a) => a.batchId === "batch-1-dup"));

  const unwrap = async (name: string, input: Record<string, unknown>, ctx: ToolContext) => {
    const wrapped = (await registry.execute(name, input, ctx)) as { ok: boolean; result?: Record<string, unknown> };
    return (wrapped.result ?? wrapped) as Record<string, unknown>;
  };
  const overview = await unwrap("messages.overview", {}, makeCtx());
  section("1c. agent 查收：messages.overview", {
    totalUnread: overview.totalUnread,
    platforms: (overview.platforms as Array<{ platform: string; unreadCount: number; conversationCount: number }>).map(
      (p) => `${p.platform} 未读${p.unreadCount} / ${p.conversationCount} 会话`,
    ),
    summary: overview.summary,
  });

  const conversations = hub.listConversations(USER_ID);
  const wechatConvId = conversations.find((c) => c.platform === "wechat")?.conversationId ?? "";
  const detail = await unwrap("messages.read_conversation", { conversationId: wechatConvId }, makeCtx());
  section("1d. agent 查看完整消息：messages.read_conversation（微信/张三）", {
    messages: (detail.messages as Array<{ senderName?: string; text: string; meta?: { importance?: string } }>).map(
      (m) => ({ from: m.senderName, text: m.text, importance: m.meta?.importance }),
    ),
  });

  section("1e. 重要消息主动提案（MessageWatchTrigger；团建改期无日程语境词被防误报规则正确过滤，期望 1 条）", proposals.map((p) => ({
    proposalId: p.proposalId,
    kind: p.kind,
    tier: p.tier,
    importance: p.importance,
    summary: p.summary,
  })));

  // ═══ 链路 2：定位实时回传 ═══
  phone.send("phone.loc.report", { latitude: 39.9042, longitude: 116.4074, accuracy: 25.0, source: "continuous" });
  await sleep(800);
  const locDb = new Database(join(DATA_DIR, "location.db"), { readonly: true });
  const locRows = locDb.prepare("SELECT actor_id, latitude, longitude, source, recorded_at FROM location_samples ORDER BY id DESC LIMIT 3").all();
  locDb.close();
  section("2. 定位回传落库（location.db location_samples）", locRows);

  // ═══ 链路 3：按需定位（phone.locate 工具 → 下发 invoke → 虚拟手机回 GPS） ═══
  const locateStart = Date.now();
  const locate = await unwrap("phone.locate", {}, makeCtx());
  section("3. 按需定位：phone.locate 工具结果", { ...locate, 耗时ms: Date.now() - locateStart });

  // ═══ 链路 4：短信代发（messages.reply → gateway sms 路由 → 手机确认） ═══
  const smsConvId = conversations.find((c) => c.platform === "sms")?.conversationId ?? "";
  const replyStart = Date.now();
  const replyResult = await unwrap(
    "messages.reply",
    { conversationId: smsConvId, text: "好的，收到，今天下午会准时到。", to: "10086" },
    makeCtx(),
  );
  section("4. 短信代发：messages.reply 工具结果", {
    ok: replyResult.ok,
    delivered: replyResult.delivered,
    summary: replyResult.summary,
    耗时ms: Date.now() - replyStart,
    手机收到的指令: phone.invokes.filter((i) => i.action === "send_sms").map((i) => ({ number: i.params.number, text: i.params.text })),
  });

  // 已读闭环
  await unwrap("messages.mark_read", { conversationId: wechatConvId }, makeCtx());
  const afterReadWrapped = (await registry.execute("messages.overview", {}, makeCtx())) as { ok: boolean; result?: Record<string, unknown> };
  const afterRead = (afterReadWrapped.result ?? afterReadWrapped) as Record<string, unknown>;
  section("5. 标已读后：messages.overview（微信未读应清零）", {
    totalUnread: afterRead.totalUnread,
    platforms: (afterRead.platforms as Array<{ platform: string; unreadCount: number }>),
  });

  phone.ws.close();
  await app.close();
  console.log("\n=== SIMULATION ALL DONE ===");
  process.exit(0);
}

main().catch((err) => {
  console.error("SIMULATION FAILED:", err);
  process.exit(1);
});
