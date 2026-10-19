/**
 * 订单信号链路测试（2026-10-19，handoff probe 数据源半边）。
 *
 * 覆盖：
 *   - deriveOrderSignal：订单词命中派生 / 非订单词拒绝 / fingerprint 稳定
 *   - 全链路集成：MessageHub 入站 → 派生 → SourceStore（经 shopping 流）→
 *     order.status 工具查到 → probe expect 可匹配
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { SourceStore } = await import("../src/proactivity/source-store.js");
const { deriveOrderSignal } = await import("../src/proactivity/shopping-signal.js");
const { createOrderStatusHandler } = await import("../src/tools/shopping-tools.js");

test("deriveOrderSignal：订单词命中，产出 shopping 流信号", () => {
  const s = deriveOrderSignal({
    actorId: "a1",
    platform: "meituan",
    title: "美团外卖",
    text: "您的订单已送达，请及时取餐",
  });
  assert.ok(s, "订单通知应派生信号");
  if (!s) return;
  assert.equal(s.stream, "shopping");
  assert.equal(s.actorId, "a1");
  assert.ok(/已送达/.test(s.delta ?? ""));
  assert.equal(s.payload?.source, "phone_capture");
  assert.equal(s.salience, "medium");
});

test("deriveOrderSignal：非订单通知一律拒绝（宁漏勿滥）", () => {
  for (const text of ["妈妈：明天记得回家吃饭", "验证码 4821，10 分钟内有效", ""] ) {
    assert.equal(deriveOrderSignal({ actorId: "a1", platform: "wechat", text }), null, `不应派生：${text}`);
  }
});

test("fingerprint 稳定：同内容同指纹（跨窗口不重复分发）", () => {
  const a = deriveOrderSignal({ actorId: "a", platform: "meituan", title: "美团", text: "订单已送达" });
  const b = deriveOrderSignal({ actorId: "a", platform: "meituan", title: "美团", text: "订单已送达" });
  assert.ok(a && b);
  assert.equal(a!.fingerprint, b!.fingerprint);
});

test("全链路：入站派生 → 跨源库 → order.status 查到，expect 可匹配", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pa-order-"));
  try {
    const store = new SourceStore({ dataPath: dir, disablePersist: true });
    const signal = deriveOrderSignal({
      actorId: "a1",
      platform: "meituan",
      title: "美团外卖",
      text: "您的订单已送达，请及时取餐",
    });
    assert.ok(signal);
    store.feed(signal!); // bootstrap 里 = sensorKernel.onSignal → sourceStore.feed

    const handler = createOrderStatusHandler({ sourceStore: store });
    const out = (await handler({}, { sessionId: "s", userId: "a1" } as never)) as {
      ok: boolean;
      hasSignals: boolean;
      signals: Array<{ delta: string }>;
      summary: string;
    };
    assert.equal(out.ok, true);
    assert.equal(out.hasSignals, true);
    assert.ok(out.signals.length >= 1);
    assert.ok(/已送达/.test(out.summary));

    // probe 判定口径：结果序列化后包含 expect
    const serialized = JSON.stringify(out);
    assert.ok(serialized.includes("已送达"), "probe expect='已送达' 应命中");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("库空时如实说没有，不编造", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pa-order-empty-"));
  try {
    const store = new SourceStore({ dataPath: dir, disablePersist: true });
    const handler = createOrderStatusHandler({ sourceStore: store });
    const out = (await handler({}, { sessionId: "s", userId: "a1" } as never)) as {
      ok: boolean;
      hasSignals: boolean;
    };
    assert.equal(out.ok, true);
    assert.equal(out.hasSignals, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
