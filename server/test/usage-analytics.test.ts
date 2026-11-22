import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import test from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";

/**
 * 跨端使用习惯埋点：接收白名单 / 追加写 / 主流口径聚合。
 * 全部走注入时钟 + 临时 DB，测试确定性，不依赖真实时间。
 * 运行：npx tsx --test test/usage-analytics.test.ts
 */
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "usage-analytics-test-"));
const DB_PATH = path.join(tmpDir, "usage.db");

// 固定“现在”为 2026-11-21 12:00:00 UTC（东八区 20:00，同一自然日）
const NOW = Date.parse("2026-11-21T12:00:00.000Z");
function dayMs(n: number): number {
  return NOW - n * 86_400_000;
}
function iso(ms: number): string {
  return new Date(ms).toISOString();
}

const mod = await import("../src/routes/http/usage-analytics.js");
const { UsageAnalyticsStore, EVENT_TYPES } = mod;

function makeEvent(over: Partial<Parameters<UsageAnalyticsStore["ingest"]>[0][number]> = {}) {
  return {
    event: "session_start",
    ts: NOW,
    installId: "install_abcd1234",
    actorId: "acc_alice" as string | null,
    platform: "mobile",
    appVersion: "1.8.3",
    sessionId: "s_001",
    props: {} as Record<string, string | number | boolean>,
    ...over,
  };
}

test("接线锁：埋点上报路径必须在周界鉴权公开面（否则端侧全部 401）", async () => {
  const { isPublicAccessPath } = await import("../src/routes/http/auth.js");
  assert.equal(isPublicAccessPath("/api/telemetry/events"), true);
  assert.equal(isPublicAccessPath("/api/telemetry/client-boot"), true);
});

test("事件登记白名单：标准事件齐全，未知事件不在其中", () => {
  for (const e of ["session_start", "session_end", "heartbeat", "feature_use", "screen_view", "client_boot"]) {
    assert.equal(EVENT_TYPES.has(e), true, e);
  }
  assert.equal(EVENT_TYPES.has("unknown_event"), false);
});

test("接收：未知事件与非法端被拒收，合法事件落库", () => {
  const store = new UsageAnalyticsStore({ now: () => NOW, dbPath: DB_PATH });
  const r = store.ingest([
    makeEvent(),
    makeEvent({ event: "hack_event" }),
    makeEvent({ platform: "iot" }),
  ]);
  assert.equal(r.accepted, 1);
  assert.equal(r.rejected, 2);
  assert.equal(store.raw().length, 1);
});

test("DAU / 上线率 / 黏性：按去重用户与注册数计算，上限封顶口径正确", () => {
  const store = new UsageAnalyticsStore({ now: () => NOW, dbPath: path.join(tmpDir, "dau.db") });
  // 今日：三个不同用户各一条活跃；同一用户重复不计
  store.ingest([
    makeEvent({ actorId: "u1", sessionId: "a1" }),
    makeEvent({ actorId: "u1", sessionId: "a2" }),
    makeEvent({ actorId: "u2", sessionId: "b1" }),
    makeEvent({ actorId: "u3", sessionId: "c1", platform: "desktop" }),
  ]);
  const s = store.summary({ registeredCount: 10 });
  assert.equal(s.ready, true);
  assert.equal(s.kpi.dau, 3); // 去重：u1/u2/u3
  assert.equal(s.kpi.onlineRate, 30); // 3/10
  assert.equal(s.kpi.mau, 3);
  assert.equal(s.kpi.stickiness, 100); // 3/3
});

test("时长：人均=总时长/去重用户，次均会话数按 session 去重，单次封顶 4h", () => {
  const store = new UsageAnalyticsStore({ now: () => NOW, dbPath: path.join(tmpDir, "dur.db") });
  store.ingest([
    makeEvent({ event: "session_end", actorId: "u1", sessionId: "a1", props: { durationMs: 600_000 } }), // 10min
    makeEvent({ event: "session_end", actorId: "u1", sessionId: "a2", props: { durationMs: 1_200_000 } }), // 20min
    makeEvent({ event: "session_end", actorId: "u2", sessionId: "b1", props: { durationMs: 5 * 3600_000 } }), // 5h -> 封顶4h
  ]);
  const s = store.summary();
  assert.equal(s.kpi.sessions, 3);
  // 总 30min + 240min = 270min，2 个去重用户 -> 135min/人
  assert.equal(s.kpi.avgDurationMin, 135);
  // 时长序列 [600000, 1200000, 14400000] 排序取中间 1200000 = 20min
  assert.equal(s.kpi.medianDurationMin, 20);
});

test("功能偏好：按 feature 计数降序 Top，未登记 feature 名为空不计数", () => {
  const store = new UsageAnalyticsStore({ now: () => NOW, dbPath: path.join(tmpDir, "feat.db") });
  store.ingest([
    makeEvent({ event: "feature_use", props: { feature: "weather" } }),
    makeEvent({ event: "feature_use", props: { feature: "weather" } }),
    makeEvent({ event: "feature_use", props: { feature: "search" } }),
    makeEvent({ event: "feature_use", props: {} }),
  ]);
  const s = store.summary();
  assert.equal(s.kpi.featureUses, 3); // 空 feature 不计
  assert.deepEqual(s.featurePrefs, [
    { name: "weather", count: 2 },
    { name: "search", count: 1 },
  ]);
});

test("留存：严格 Classic，第 N 日活跃才计入，未到观察日返回 null 而非伪造", () => {
  const cohortDay = dayMs(8); // 8 天前
  // 用可变时钟模拟历史写入：cohort 2 人首活，1 人次日回访，另 1 人第 3 日回访
  let clock = cohortDay;
  const store2 = new UsageAnalyticsStore({ now: () => clock, dbPath: path.join(tmpDir, "ret2.db") });
  store2.ingest([
    makeEvent({ actorId: "u1", sessionId: "s1" }),
    makeEvent({ actorId: "u2", sessionId: "s2" }),
  ]);
  clock = cohortDay + 86_400_000; // 次日
  store2.ingest([makeEvent({ actorId: "u1", sessionId: "s3" })]); // u1 次日回访
  clock = cohortDay + 3 * 86_400_000; // 第3日
  store2.ingest([makeEvent({ actorId: "u2", sessionId: "s4" })]); // u2 第3日回访
  clock = NOW;

  const s = store2.summary();
  const row = s.retention.find((r) => r.cohort === iso(cohortDay).slice(0, 10));
  assert.ok(row, "应存在 8 天前的 cohort");
  assert.equal(row.size, 2);
  assert.equal(row.d1, 50); // u1 次日回访：1/2
  assert.equal(row.d3, 50); // u2 第3日回访：1/2
  assert.equal(row.d7, 0); // 无第7日回访
  assert.equal(row.d30, null); // 第30日尚未到观察日
});

test("时段热力与端分布：按东八区 weekday×hour 分桶、按 session_start 计端", () => {
  const store = new UsageAnalyticsStore({ now: () => NOW, dbPath: path.join(tmpDir, "heat.db") });
  store.ingest([
    makeEvent({ platform: "mobile" }),
    makeEvent({ platform: "mobile", sessionId: "s2" }),
    makeEvent({ platform: "desktop", sessionId: "s3" }),
  ]);
  const s = store.summary();
  assert.equal(s.platform.mobile, 2);
  assert.equal(s.platform.desktop, 1);
  assert.equal(s.heatmap.length, 7);
  assert.equal(s.heatmap[0].length, 24);
  assert.equal(s.heatmap.flat().reduce((a, b) => a + b, 0), 3);
});

test("HTTP 接收：批量上报返回 accepted，未登记事件不落库", async () => {
  const { default: Fastify } = await import("fastify");
  const app: FastifyInstance = Fastify({ logger: false });
  mod.registerUsageAnalyticsRoutes(app);
  await app.ready();

  const res = await app.inject({
    method: "POST",
    url: "/api/telemetry/events",
    payload: {
      events: [
        makeEvent({ event: "feature_use", props: { feature: "clock" } }),
        makeEvent({ event: "nope" }),
      ],
    },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.ok, true);
  assert.equal(body.accepted, 1);
  assert.equal(body.rejected, 1);

  const bad = await app.inject({ method: "POST", url: "/api/telemetry/events", payload: { events: [] } });
  assert.equal(bad.statusCode, 400);
  await app.close();
});
