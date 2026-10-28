/**
 * 采集节奏契约：自适应轮询 + 外部唤醒。
 *
 * 远程订阅类信源（邮箱/购物…）不再固定间隔空转：
 *   - 收件箱安静 → 间隔逐级翻倍，封顶 idleMaxSec（默认 5 分钟）
 *   - 拉到新邮件 → 60s 快节奏跟进两轮（同批/补发），随后回到退避
 *   - 外部提示（手动刷新/手机重连）→ wake() 立即拉，5s 内连点只算一次
 *   - 失败退避与成功恢复互不干扰（诚实失败，不 crash）
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { adaptiveMailDelayMs, MailWatchService, readMailWatchConfig } from "../src/services/mail-watch-service.js";
import { SensorKernel } from "../src/proactivity/sensors/kernel.js";
import type { ProactiveSensor, Signal, SignalStream } from "../src/proactivity/sensors/types.js";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timeout");
    await sleep(10);
  }
}

// ───────────────────────── 间隔计算（纯函数） ─────────────────────────

test("自适应间隔：空轮翻倍、封顶 idleMaxSec；新邮件后 60s 快节奏", () => {
  assert.equal(adaptiveMailDelayMs(120, 0, 300, 0), 120_000, "从基础间隔起");
  assert.equal(adaptiveMailDelayMs(120, 1, 300, 0), 240_000);
  assert.equal(adaptiveMailDelayMs(120, 2, 300, 0), 300_000, "封顶 5 分钟");
  assert.equal(adaptiveMailDelayMs(120, 9, 300, 0), 300_000, "再多空轮也不超过上限");
  assert.equal(adaptiveMailDelayMs(120, 0, 300, 2), 60_000, "新邮件后 60s 跟进");
  assert.equal(adaptiveMailDelayMs(30, 0, 300, 2), 30_000, "快节奏不短于基础间隔");
  assert.equal(adaptiveMailDelayMs(120, 0, 120, 2), 60_000, "快节奏可以短于基础间隔");
});

test("配置边界：基础间隔下限 30s（防拉黑）、安静上限不低于基础间隔", () => {
  const low = readMailWatchConfig({ MAIL_WATCH_POLL_SEC: "1" } as NodeJS.ProcessEnv);
  assert.equal(low.pollSec, 30);
  const high = readMailWatchConfig({ MAIL_WATCH_POLL_SEC: "600", MAIL_WATCH_IDLE_MAX_SEC: "60" } as NodeJS.ProcessEnv);
  assert.equal(high.pollSec, 600);
  assert.equal(high.idleMaxSec, 600, "安静上限被抬到基础间隔");
  const def = readMailWatchConfig({} as NodeJS.ProcessEnv);
  assert.equal(def.pollSec, 120);
  assert.equal(def.idleMaxSec, 300);
});

// ───────────────────────── 邮箱服务：空轮退避 + 唤醒节流 ─────────────────────────

function fakeClient(state: { connects: number }) {
  return {
    connect: async () => {
      state.connects += 1;
    },
    logout: async () => {},
    mailboxOpen: async () => ({ uidValidity: 1n, exists: 0 }),
    fetchRecentMessages: async () => [],
    markSeen: async () => {},
  };
}

test("邮箱节奏：首轮空手 → 退避到 2× 基础间隔；停止后 wake 不再拉取", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mail-rhythm-"));
  const state = { connects: 0 };
  const service = new MailWatchService({
    clientFactory: () => fakeClient(state),
    env: {
      MAIL_WATCH_ENABLED: "1",
      MAIL_WATCH_HOST: "imap.example.com",
      MAIL_WATCH_USER: "me@example.com",
      MAIL_WATCH_PASS: "secret",
      MAIL_WATCH_POLL_SEC: "30",
    },
    persistPath: join(dir, "uids.json"),
  });
  try {
    service.wake("before-start");
    assert.equal(state.connects, 0, "未启动时 wake 不碰网络");

    service.start();
    await waitFor(() => state.connects === 1);
    await waitFor(() => service.status().retryDelaySec !== null);
    const s = service.status();
    assert.equal(s.idleRounds, 1, "首轮空手 → 安静 1 轮");
    assert.equal(s.burstRounds, 0);
    assert.equal(s.retryDelaySec, 60, "30s 基础 → 60s 后再看");

    // 5s 内连点唤醒只算一次（这里直接验证节流：刚拉过就不再拉）
    service.wake("manual");
    await sleep(150);
    assert.equal(state.connects, 1, "刚拉过的 5s 内唤醒被节流");
  } finally {
    service.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ───────────────────────── 传感内核：adaptive 调度 + wake ─────────────────────────

function signal(stream: SignalStream, fp: string, at: number): Signal {
  return { stream, at, fingerprint: fp, salience: "medium" };
}

test("内核 adaptive：60s → 120s → 240s → 300s 封顶；来信号立刻回到 60s", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kernel-rhythm-"));
  const now = new Date(2026, 9, 28, 9, 0, 0, 0).getTime();
  const kernel = new SensorKernel({ dataPath: dir, nowFn: () => now, disablePersist: true });
  const outbox: Signal[] = [];
  const sensor: ProactiveSensor = {
    id: "mail",
    stream: "mail",
    pollIntervalMs: 60_000,
    transport: "adaptive",
    collect: async () => outbox.splice(0, outbox.length),
  };
  kernel.register(sensor);
  try {
    const interval = () => kernel.health().find((h) => h.sensorId === "mail")!.pollIntervalMs;
    assert.equal(kernel.health().find((h) => h.sensorId === "mail")!.mode, "adaptive");

    await kernel.pollOnce();
    assert.equal(interval(), 120_000, "空手 1 轮 → 2× 基础");
    await kernel.pollOnce();
    assert.equal(interval(), 240_000);
    await kernel.pollOnce();
    assert.equal(interval(), 300_000, "封顶 5× 基础（5 分钟）");
    await kernel.pollOnce();
    assert.equal(interval(), 300_000, "继续空手不无限拉长");

    outbox.push(signal("mail", "fp-1", now));
    await kernel.pollOnce();
    assert.equal(interval(), 60_000, "来了信号立刻回到快节奏");
  } finally {
    kernel.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("内核 wake：只唤醒轮询型，push 型不入队；返回值如实计数", () => {
  const dir = mkdtempSync(join(tmpdir(), "kernel-wake-"));
  const kernel = new SensorKernel({ dataPath: dir, nowFn: () => Date.now(), disablePersist: true });
  kernel.register({ id: "mail", stream: "mail", pollIntervalMs: 60_000, transport: "adaptive", collect: () => [] });
  kernel.register({ id: "presence", stream: "presence", pollIntervalMs: 0, collect: () => [] });
  try {
    assert.equal(kernel.wake(), 1, "push 型不需要唤醒");
    assert.equal(kernel.wake("mail"), 1);
    assert.equal(kernel.wake("presence"), 0, "push 型无轮询可唤醒");
  } finally {
    kernel.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
