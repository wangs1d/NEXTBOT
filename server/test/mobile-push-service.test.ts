// 移动端推送通道单测：token 注册表持久化 / provider 请求契约 / 管道离线升级链路
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  BarkProvider,
  JPushProvider,
  MobilePushService,
  WebhookPushProvider,
} from "../src/proactivity/mobile-push-service.js";
import { DELIVERY_RETRY_MS } from "../src/proactivity/arbiter.js";
import { ProactiveDeliveryService } from "../src/proactivity/delivery-service.js";
import { FrequencyGovernor } from "../src/proactivity/frequency-governor.js";
import { OutcomeStore } from "../src/proactivity/outcome-store.js";
import { PresenceService } from "../src/proactivity/presence-service.js";
import { ProactivePipeline } from "../src/proactivity/proactive-pipeline.js";
import type { ProactiveProposal } from "../src/proactivity/pipeline-types.js";

const NOON = new Date(2026, 7, 30, 12, 0, 0).getTime();

function proposal(overrides: Partial<ProactiveProposal> = {}): ProactiveProposal {
  return {
    proposalId: "p_test",
    actorId: "user-a",
    kind: "schedule_reminder",
    tier: "must",
    importance: "high",
    dedupKey: "k1",
    title: "评审",
    summary: "马上评审",
    evidence: [],
    directText: "15分钟后评审",
    createdAt: NOON,
    source: "schedule",
    ...overrides,
  };
}

// ─── fetch 桩（provider HTTP 契约验证） ───

type FetchCall = { url: string; init: RequestInit };

function stubFetch(handler: (url: string, init: RequestInit) => { status: number; body?: string }): { calls: FetchCall[]; restore: () => void } {
  const calls: FetchCall[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: unknown, init?: unknown) => {
    const u = String(url);
    const i = (init ?? {}) as RequestInit;
    calls.push({ url: u, init: i });
    const r = handler(u, i);
    return new Response(r.body ?? "{}", { status: r.status });
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

// ─── token 注册表 ───

test("push registry: 注册/注销 + 落盘重启恢复", () => {
  const dir = mkdtempSync(join(tmpdir(), "mobile-push-"));
  try {
    const path = join(dir, "push-tokens.json");
    const service = new MobilePushService({ registryPath: path, providers: [new JPushProvider("ak", "sk")] });
    service.register("user-a", { provider: "jpush", token: "reg-1", deviceId: "phone" });
    service.register("user-a", { provider: "bark" });
    service.register("user-a", { provider: "jpush", token: "reg-1" }); // 同 provider+token 去重
    assert.equal(service.listByActor("user-a").length, 2);
    service.flush();

    const restored = new MobilePushService({ registryPath: path, providers: [new JPushProvider("ak", "sk")] });
    assert.equal(restored.listByActor("user-a").length, 2);
    assert.equal(restored.unregister("user-a", "jpush").length, 1, "注销 provider 清掉其条目");
    assert.equal(restored.hasChannel("user-a"), false, "仅剩未配置的 bark 条目时无通道");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── provider HTTP 契约 ───

test("jpush provider: REST v3 请求契约（Basic 鉴权 + registration_id + 双端通知体）", async () => {
  const provider = new JPushProvider("my-appkey", "my-secret");
  const { calls, restore } = stubFetch(() => ({ status: 200, body: '{"sendno":"0","msg_id":"1"}' }));
  try {
    const result = await provider.push({ provider: "jpush", token: "reg-9" }, {
      actorId: "u", title: "评审", body: "15分钟后评审", importance: "high", kind: "schedule_reminder", deliveryId: "d1",
    });
    assert.equal(result.ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, "https://api.jpush.cn/v3/push");
    const headers = calls[0]!.init.headers as Record<string, string>;
    assert.equal(headers.Authorization, `Basic ${Buffer.from("my-appkey:my-secret").toString("base64")}`);
    const body = JSON.parse(String(calls[0]!.init.body));
    assert.deepEqual(body.audience, { registration_id: ["reg-9"] });
    assert.match(body.notification.android.alert, /评审/);
    assert.ok(body.options.time_to_live > 0);
  } finally {
    restore();
  }
});

test("jpush provider: HTTP 500 → 失败带原因", async () => {
  const provider = new JPushProvider("ak", "sk");
  const { restore } = stubFetch(() => ({ status: 500, body: "internal" }));
  try {
    const result = await provider.push({ provider: "jpush", token: "t" }, {
      actorId: "u", title: "t", body: "b", importance: "high", kind: "k", deliveryId: "d",
    });
    assert.equal(result.ok, false);
    assert.match(result.reason ?? "", /HTTP 500/);
  } finally {
    restore();
  }
});

test("bark/webhook provider: 请求契约", async () => {
  const bark = new BarkProvider("https://api.day.app/dev-key");
  const hook = new WebhookPushProvider("https://relay.example.com/push", "tok-1");
  const { calls, restore } = stubFetch(() => ({ status: 200 }));
  try {
    const input = { actorId: "u", title: "站会", body: "10分钟后", importance: "critical", kind: "schedule_reminder", deliveryId: "d2" };
    assert.equal((await bark.push({ provider: "bark" }, input)).ok, true);
    assert.equal((await hook.push({ provider: "webhook" }, input)).ok, true);
    assert.equal(calls[0]!.url, "https://api.day.app/dev-key");
    assert.equal((calls[1]!.init.headers as Record<string, string>).Authorization, "Bearer tok-1");
    const hookBody = JSON.parse(String(calls[1]!.init.body));
    assert.equal(hookBody.actorId, "u");
    assert.equal(hookBody.deliveryId, "d2");
  } finally {
    restore();
  }
});

// ─── MobilePushService 聚合 ───

test("push service: hasChannel 按已配置 provider 判定；push 任一成功即止", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mobile-push-"));
  try {
    const service = new MobilePushService({
      registryPath: join(dir, "tokens.json"),
      providers: [new JPushProvider("ak", "sk")],
    });
    assert.equal(service.hasChannel("user-a"), false, "未注册 token");
    service.register("user-a", { provider: "jpush", token: "reg-1" });
    assert.equal(service.hasChannel("user-a"), true);
    assert.deepEqual(service.configuredProviders(), ["jpush"]);

    const { restore } = stubFetch(() => ({ status: 200 }));
    try {
      const result = await service.push({ actorId: "user-a", title: "t", body: "b", importance: "high", kind: "k", deliveryId: "d" });
      assert.equal(result.ok, true);
      assert.equal(result.provider, "jpush");
    } finally {
      restore();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("push service: 全部失败返回最后一个原因", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mobile-push-"));
  try {
    const service = new MobilePushService({
      registryPath: join(dir, "tokens.json"),
      providers: [new JPushProvider("ak", "sk")],
    });
    service.register("user-a", { provider: "jpush", token: "reg-1" });
    const { restore } = stubFetch(() => ({ status: 503 }));
    try {
      const result = await service.push({ actorId: "user-a", title: "t", body: "b", importance: "high", kind: "k", deliveryId: "d" });
      assert.equal(result.ok, false);
      assert.match(result.reason ?? "", /HTTP 503/);
    } finally {
      restore();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── 管道离线升级链路 ───

type Harness = {
  pipeline: ProactivePipeline;
  presence: PresenceService;
  delivered: Array<{ actorId: string; json: string }>;
  pushes: Array<{ actorId: string; title: string }>;
  flags: { pushEnabled: boolean; pushOk: boolean };
  dir: string;
};

function makeHarness(opts: { pushOk?: boolean } = {}): Harness {
  const dir = mkdtempSync(join(tmpdir(), "proactive-push-"));
  const presence = new PresenceService();
  const delivered: Array<{ actorId: string; json: string }> = [];
  const pushes: Array<{ actorId: string; title: string }> = [];
  const flags = { pushEnabled: true, pushOk: opts.pushOk ?? true };
  const pipeline = new ProactivePipeline({
    dataPath: dir,
    governor: new FrequencyGovernor({ ignoreEnv: true, }),
    suppression: { isSuppressed: () => ({ suppressed: false, reason: "" }) },
    presence,
    delivery: new ProactiveDeliveryService({
      trySend: (actorId, json) => {
        delivered.push({ actorId, json });
        return true;
      },
    }),
    outcomes: new OutcomeStore(join(dir, "outcomes.json")),
    nowFn: () => NOON,
    mobilePush: {
      hasChannel: () => flags.pushEnabled,
      push: async (input) => {
        pushes.push({ actorId: input.actorId, title: input.title });
        return flags.pushOk
          ? { ok: true, provider: "stub" }
          : { ok: false, provider: "stub", reason: "stub_down" };
      },
    },
  });
  return { pipeline, presence, delivered, pushes, flags, dir };
}

test("pipeline: 两端离线 + 推送通道 → must 提案自动升级系统推送并出队", async () => {
  const h = makeHarness();
  try {
    const d = h.pipeline.submitProposal(proposal());
    assert.equal(d.verdict, "deferred", "离线先按挂起仲裁");
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.equal(h.pushes.length, 1, "推送通道触发一次");
    assert.equal(h.pipeline.diagnostics().pending.length, 0, "推送成功即出队（重连后不重复投递）");
    await new Promise((r) => setImmediate(r));
    const outcome = h.pipeline.diagnostics().recentOutcomes.at(-1);
    assert.equal(outcome?.channel, "mobile_push");
    assert.equal(outcome?.outcome, "delivered");
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test("pipeline: social 层离线不推送（分寸：只有必达和 critical 走手机推送）", async () => {
  const h = makeHarness();
  try {
    h.pipeline.submitProposal(proposal({ tier: "social", importance: "medium", kind: "greeting", dedupKey: "g1" }));
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.equal(h.pushes.length, 0);
    assert.equal(h.pipeline.diagnostics().pending.length, 1, "挂起待重连");
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test("pipeline: 推送失败保留待发区并退避重试", async () => {
  const h = makeHarness({ pushOk: false });
  try {
    h.pipeline.submitProposal(proposal());
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.equal(h.pushes.length, 1);
    assert.equal(h.pipeline.diagnostics().pending.length, 1, "推送失败不出队");
    const pending = h.pipeline.diagnostics().pending[0]!;
    assert.ok(pending.deliverAfter !== undefined && pending.deliverAfter > NOON, "退避重排");
    // 退避到期 → 重试
    h.flags.pushOk = true;
    h.pipeline.flushDue(NOON + 5 * 60_000 + 1);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.equal(h.pushes.length, 2, "重试触发");
    assert.equal(h.pipeline.diagnostics().pending.length, 0, "重试成功出队");
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test("pipeline: 未注入推送通道时离线一律挂起（原行为不变）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "proactive-nopush-"));
  try {
    const pipeline = new ProactivePipeline({
      dataPath: dir,
      governor: new FrequencyGovernor({ ignoreEnv: true, }),
      suppression: { isSuppressed: () => ({ suppressed: false, reason: "" }) },
      presence: new PresenceService(),
      delivery: new ProactiveDeliveryService({ trySend: () => false }),
      outcomes: new OutcomeStore(join(dir, "outcomes.json")),
      nowFn: () => NOON,
    });
    const d = pipeline.submitProposal(proposal({ dedupKey: "k-x" }));
    assert.equal(d.verdict, "deferred");
    await new Promise((r) => setImmediate(r));
    assert.equal(pipeline.diagnostics().pending.length, 1);
    assert.equal(pipeline.diagnostics().offlinePush.enabled, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pipeline: WS 竞态失败也触发离线推送升级", async () => {
  const dir = mkdtempSync(join(tmpdir(), "proactive-race-"));
  try {
    const presence = new PresenceService();
    const pushes: unknown[] = [];
    const pipeline = new ProactivePipeline({
      dataPath: dir,
      governor: new FrequencyGovernor({ ignoreEnv: true, }),
      suppression: { isSuppressed: () => ({ suppressed: false, reason: "" }) },
      presence,
      delivery: new ProactiveDeliveryService({ trySend: () => false }), // 恒失败=竞态
      outcomes: new OutcomeStore(join(dir, "outcomes.json")),
      nowFn: () => NOON,
      mobilePush: {
        hasChannel: () => true,
        push: async () => {
          pushes.push(1);
          return { ok: true, provider: "stub" };
        },
      },
    });
    presence.markConnected("user-a", NOON - 5 * 60_000);
    pipeline.submitProposal(proposal({ dedupKey: "k-race" }));
    assert.equal(pipeline.diagnostics().pending.length, 1, "竞态失败保留待发区");
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.equal(pushes.length, 1, "竞态失败升级推送");
    // 竞态退避（DELIVERY_RETRY_MS）到期重试时已出队 → 不重复投递
    assert.equal(pipeline.diagnostics().pending.length, 0);
    void DELIVERY_RETRY_MS;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
