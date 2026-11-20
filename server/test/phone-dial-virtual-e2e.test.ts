/**
 * phone.dial 全链路虚拟联调（无真机、无 LLM）。
 *
 * 思路：起真实 Fastify + 真实 WS 协议层（registerWebSocketRoute）+ 真实
 * PhoneBridgeCoordinator，用一个进程内 WebSocket 客户端扮演「手机执行器」，
 * 走与 Flutter 客户端完全相同的线上协议：
 *   session.init { phoneBridge: true } → phone.bridge.register
 *   → 收 phone.bridge.invoke(action=dial) → 回 phone.bridge.result
 * Agent 侧则通过真实 ToolRegistry 调 phone.dial 工具（ctx.phoneBridgeOnline
 * 取自 coordinator 的真实 sync payload，模拟线上 chat 车道的取值方式）。
 *
 * 覆盖场景：正常拨打 / 手机端取消 / 紧急号码拦截 / 同轮去重 / 手机离线。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.PA_DATA_DIR = mkdtempSync(join(tmpdir(), "phone-dial-e2e-"));
process.env.PHONE_BRIDGE_ENABLED = "1";
process.env.AGENT_TOKENJUICE_ENABLED = "0";
process.env.AGENT_MEMORY_SYNC_ENABLED = "0";

import Fastify from "fastify";
import websocket from "@fastify/websocket";
import WebSocket from "ws";

const USER_ID = "virtual-user-1";

const { registerWebSocketRoute } = await import("../src/ws/connection.js");
const { PhoneBridgeCoordinator } = await import(
  "../src/services/phone-bridge-coordinator.js"
);
const { LocationCoordinator } = await import(
  "../src/services/location-coordinator.js"
);
const { ToolRegistry } = await import("../src/tools/tool-registry.js");
const { registerPhoneBridgeTools } = await import(
  "../src/tools/phone-bridge-tools.js"
);
type ToolContext = import("../src/tools/tool-registry.js").ToolContext;

// ---------------------------------------------------------------------------
// 环境搭建：真实协议层 + 桩化业务依赖
// ---------------------------------------------------------------------------

type InvokeRecord = {
  jobId: string;
  action: string;
  params: Record<string, unknown>;
};

const syncEvents: Array<{ online: boolean; at: number }> = [];

/** 扮演用户手机的 WS 客户端；reply 决定手机端如何回执（确认/取消/超时…） */
class VirtualPhone {
  ws!: WebSocket;
  received: InvokeRecord[] = [];
  private pending: Array<(rec: InvokeRecord) => void> = [];

  constructor(
    private readonly port: number,
    private readonly reply: (
      rec: InvokeRecord,
    ) => Record<string, unknown> | Promise<Record<string, unknown>>,
    private readonly actorId: string = USER_ID,
  ) {}

  async connect(): Promise<void> {
    this.ws = new WebSocket(`ws://127.0.0.1:${this.port}/ws`);
    await new Promise<void>((resolve, reject) => {
      this.ws.once("open", resolve);
      this.ws.once("error", reject);
    });
    this.ws.on("message", (raw) => {
      const event = JSON.parse(raw.toString()) as {
        type: string;
        payload: Record<string, unknown>;
      };
      if (event.type === "phone.bridge.invoke") {
        const rec: InvokeRecord = {
          jobId: String(event.payload.jobId ?? ""),
          action: String(event.payload.action ?? ""),
          params: (event.payload.params ?? {}) as Record<string, unknown>,
        };
        this.received.push(rec);
        void (async () => {
          const result = await this.reply(rec);
          this.send("phone.bridge.result", { jobId: rec.jobId, ...result });
        })();
      }
    });
    this.send("session.init", {
      sessionId: `virtual-phone-${this.actorId}`,
      userId: this.actorId,
      phoneBridge: true,
      deviceId: "virtual-phone",
      model: "Virtual Pixel 9",
      manufacturer: "ZCode",
      brand: "ZCode",
      systemVersion: "virtual-test",
    });
    const ack = await this.expect("phone.bridge.register_ack");
    assert.equal(ack.payload.ok, true, "手机端注册应成功");
    assert.equal(ack.payload.mode, "userId", "无口令模式应自动绑定");
  }

  /** 等待下一条指定类型的服务端消息（register_ack 等） */
  expect(type: string, timeoutMs = 5000): Promise<{ type: string; payload: Record<string, unknown> }> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`等待 ${type} 超时`)),
        timeoutMs,
      );
      const onMessage = (raw: WebSocket.RawData) => {
        const event = JSON.parse(raw.toString()) as {
          type: string;
          payload: Record<string, unknown>;
        };
        if (event.type === type) {
          clearTimeout(timer);
          this.ws.off("message", onMessage);
          resolve(event);
        }
      };
      this.ws.on("message", onMessage);
    });
  }

  nextInvoke(timeoutMs = 5000): Promise<InvokeRecord> {
    const existing = this.pending.shift();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("等待 dial invoke 超时")),
        timeoutMs,
      );
      const poll = () => {
        const rec = this.received.shift();
        if (rec) {
          clearTimeout(timer);
          resolve(rec);
        } else {
          this.pending.push(poll);
        }
      };
      void existing;
      poll();
    });
  }

  send(type: string, payload: Record<string, unknown>): void {
    this.ws.send(JSON.stringify({ type, payload }));
  }

  close(): void {
    this.ws.close();
  }
}

const stubs = {
  sessionService: { upsert: () => {} },
  realFundsWallet: { bootstrap: () => {} },
  worldService: { getOrCreate: () => ({}) },
  auditService: { record: async () => {} },
  wsConnectionRegistry: {
    register: () => {},
    unregister: () => {},
    trySend: () => true,
    // 设备活跃度刷新（闹钟全链路提交新增）：业务消息到达即调，stub 仅需不抛错
    touchActivity: () => {},
  },
  agentPairingService: {},
  aipService: {},
  worldPartitionWsRegistry: {
    uniqueWatcherSessionIds: () => [],
    broadcastToPartition: () => {},
    detachSocket: () => false,
  },
  runtime: new Proxy(
    {},
    { get: (_t, prop) => () => { throw new Error(`runtime.${String(prop)} 不应被桥接路径调用`); } },
  ),
  socialFeedService: { unsubscribe: () => {} },
  computeQuotaService: {},
  agentMemorySyncService: {},
  unifiedIdempotencyService: {},
  // 共用浏览器桥（connection.ts 关闭/重绑路径必调）：虚拟拨号轮不触发 browserBridge，
  // mock 仅需保证清理路径不抛错
  sharedBrowserCoordinator: {
    unbindIfSocket: () => false,
    bindExecutor: () => {},
    completeFromSocket: () => false,
  },
  locationIngest: null,
  virtualPhoneService: {},
  virtualPhoneIncomingCoordinator: {},
  userPersonalizationService: {},
  deviceRegistry: {},
  devicePairingService: {},
};

async function setup() {
  const phoneBridgeCoordinator = new PhoneBridgeCoordinator({
    onSync: (actorId, payload) => {
      syncEvents.push({ online: payload.phoneBridgeOnline, at: Date.now() });
    },
  });
  const locationCoordinator = new LocationCoordinator();

  const app = Fastify({ logger: false });
  await app.register(websocket);
  registerWebSocketRoute(app, {
    ...stubs,
    phoneBridgeCoordinator,
    locationCoordinator,
  } as never);
  await app.ready();
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  const registry = new ToolRegistry();
  registerPhoneBridgeTools(registry, { bridge: phoneBridgeCoordinator });

  /** 线上 chat 车道的取值方式：桥接在线性来自 coordinator 真实 sync payload */
  const makeCtx = (roundId: string, overrides: Partial<ToolContext> = {}): ToolContext => ({
    sessionId: "virtual-chat-session",
    userId: USER_ID,
    chatUserMessageId: roundId,
    phoneBridgeOnline: phoneBridgeCoordinator.getSyncPayload(USER_ID).phoneBridgeOnline,
    ...overrides,
  });

  return {
    app,
    registry,
    phoneBridgeCoordinator,
    makeCtx,
    shutdown: async () => {
      await app.close();
    },
  };
}

// ---------------------------------------------------------------------------
// 场景
// ---------------------------------------------------------------------------

test("虚拟联调①：正常拨打 —— 工具→桥接→手机 全链路直通", async () => {
  const env = await setup();
  try {
    const phone = new VirtualPhone(env.app.server.address().port as number, (rec) => {
      assert.equal(rec.action, "dial");
      return { ok: true, state: "dialing", number: rec.params.number };
    });
    await phone.connect();

    // 桥接在线性经由真实 sync payload：注册成功后应为 true
    assert.equal(env.phoneBridgeCoordinator.getSyncPayload(USER_ID).phoneBridgeOnline, true);

    const r = await env.registry.execute(
      "phone.dial",
      { number: "+86 138 0013 8000", contactName: "老王", reason: "虚拟联调", mode: "direct" },
      env.makeCtx("round-1"),
    );
    assert.equal(r.ok, true, `工具执行应成功：${JSON.stringify(r.result)}`);
    assert.equal(r.result.ok, true);
    assert.equal(r.result.state, "dialing");
    assert.match(String(r.result.summary), /拨出/);

    const invoke = await phone.nextInvoke();
    assert.equal(invoke.action, "dial");
    assert.equal(invoke.params.number, "+8613800138000", "号码应被归一化");
    assert.equal(invoke.params.contactName, "老王");
    assert.equal(invoke.params.reason, "虚拟联调");
    assert.equal(invoke.params.mode, "direct");

    phone.close();
    await new Promise((r2) => setTimeout(r2, 100));
  } finally {
    await env.shutdown();
  }
});

test("虚拟联调②：用户在手机端取消 —— 回执 cancelled 且不拨出", async () => {
  const env = await setup();
  try {
    const phone = new VirtualPhone(env.app.server.address().port as number, () => ({
      ok: false,
      state: "cancelled",
      reason: "user_cancel",
    }));
    await phone.connect();

    const r = await env.registry.execute(
      "phone.dial",
      { number: "13911112222", contactName: "小李" },
      env.makeCtx("round-2"),
    );
    assert.equal(r.result.ok, false);
    assert.equal(r.result.state, "cancelled");
    assert.match(String(r.result.summary), /取消/);

    const invoke = await phone.nextInvoke();
    assert.equal(invoke.action, "dial");

    phone.close();
    await new Promise((r2) => setTimeout(r2, 100));
  } finally {
    await env.shutdown();
  }
});

test("虚拟联调③：紧急号码 —— 服务端拦截，指令不下发到手机", async () => {
  const env = await setup();
  try {
    const phone = new VirtualPhone(env.app.server.address().port as number, () => ({
      ok: true,
      state: "dialing",
    }));
    await phone.connect();

    const before = phone.received.length;
    const r = await env.registry.execute(
      "phone.dial",
      { number: "120" },
      env.makeCtx("round-3"),
    );
    assert.equal(r.result.ok, false);
    assert.match(String(r.result.error), /紧急号码/);
    assert.equal(phone.received.length, before, "紧急号码不应触达手机端");

    phone.close();
    await new Promise((r2) => setTimeout(r2, 100));
  } finally {
    await env.shutdown();
  }
});

test("虚拟联调④：同轮去重 —— 第二次调用拦截在服务端", async () => {
  const env = await setup();
  try {
    const phone = new VirtualPhone(env.app.server.address().port as number, () => ({
      ok: true,
      state: "dialing",
    }));
    await phone.connect();

    const input = { number: "13855556666" };
    const r1 = await env.registry.execute("phone.dial", input, env.makeCtx("round-4"));
    assert.equal(r1.result.ok, true);
    await phone.nextInvoke();

    const r2 = await env.registry.execute("phone.dial", input, env.makeCtx("round-4"));
    assert.equal(r2.result.deduped, true);
    assert.equal(phone.received.length, 0, "同轮重复调用不应再次下发到手机");

    phone.close();
    await new Promise((r2) => setTimeout(r2, 100));
  } finally {
    await env.shutdown();
  }
});

test("虚拟联调⑤：手机离线 —— 工具快速失败", async () => {
  const env = await setup();
  try {
    const phone = new VirtualPhone(env.app.server.address().port as number, () => ({
      ok: true,
      state: "dialing",
    }));
    await phone.connect();
    assert.equal(env.phoneBridgeCoordinator.getSyncPayload(USER_ID).phoneBridgeOnline, true);
    phone.close();

    // 等 coordinator 感知断开（unbindIfSocket → sync offline）
    for (let i = 0; i < 50 && env.phoneBridgeCoordinator.hasExecutor(USER_ID); i++) {
      await new Promise((r2) => setTimeout(r2, 100));
    }
    assert.equal(env.phoneBridgeCoordinator.hasExecutor(USER_ID), false, "断开后执行器应解绑");
    assert.deepEqual(
      syncEvents.filter((e) => !e.online).length >= 1,
      true,
      "应产生 offline sync 事件",
    );

    const r = await env.registry.execute(
      "phone.dial",
      { number: "13877778888" },
      env.makeCtx("round-5"),
    );
    assert.equal(r.result.ok, false);
    assert.match(String(r.result.error), /phone bridge is not online/);
  } finally {
    await env.shutdown();
  }
});
