// 外部信源收编 + 跨源统一采集库单测（2026-10-10 扫描架构 P0）。
// 覆盖：适配器形状转换 / 内核收编与健康上报 / SourceStore 分区落盘与跨源实体检索。
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { SensorKernel } from "../src/proactivity/sensors/kernel.js";
import { MailSensor } from "../src/proactivity/sensors/mail-sensor.js";
import { IcsSensor } from "../src/proactivity/sensors/ics-sensor.js";
import { FinanceSensor } from "../src/proactivity/sensors/finance-sensor.js";
import { SourceStore, dateKey, extractEntities, readPartition } from "../src/proactivity/source-store.js";
import type { Signal } from "../src/proactivity/sensors/types.js";

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "sensor-fabric-"));
}

// ─── 适配器形状转换 ───

test("MailSensor: 新邮件 → mail 流 Signal（含跨源实体候选）", () => {
  const clock = 1_700_000_000_000;
  const sensor = new MailSensor({
    fetchNewSince: (since) =>
      [
        { uid: 101, importance: "high", mail: { actorId: "u1", from: "张总 <boss@corp.com>", subject: "合同确认", date: new Date(clock + 1000).toISOString() } },
        { uid: 99, importance: "low", mail: { actorId: "u1", from: "old@x.com", subject: "旧信", date: new Date(clock - 5000).toISOString() } },
      ].filter((m) => (m.mail.date ? Date.parse(m.mail.date) : 0) > since),
  });
  const signals = sensor.collect(clock);
  assert.equal(signals.length, 1, "只取 since 之后的");
  const s = signals[0];
  assert.equal(s.stream, "mail");
  assert.equal(s.salience, "high", "high 分级 → high 显著度");
  assert.equal(s.fingerprint, "mail:101", "uid 稳定指纹");
  assert.equal(s.actorId, "u1");
  assert.match(s.delta ?? "", /合同确认/);
  const entities = s.payload?.entities as string[];
  assert.ok(entities.includes("张总"), `发件人入实体候选: ${entities}`);
  assert.ok(entities.some((e) => e.includes("corp")), `域名入实体候选: ${entities}`);
});

test("MailSensor: 无 uid 时退 from|subject|date 指纹（不撞键）", () => {
  const sensor = new MailSensor({
    fetchNewSince: () => [
      { uid: -1, importance: "medium", mail: { actorId: "u1", from: "a@b.com", subject: "S", date: "2026-10-01T00:00:00.000Z" } },
    ],
  });
  const s = sensor.collect(0)[0];
  assert.equal(s.salience, "medium");
  assert.match(s.fingerprint, /^mail:a@b\.com\|S\|/);
});

test("IcsSensor: 事件 → schedule 流 Signal（地点入实体，临会显著度升高）", () => {
  const soon = Date.now() + 30 * 60_000;
  const sensor = new IcsSensor({
    fetchEventsSince: () => [
      { feed: "work", key: "e1", summary: "三亚出差", location: "三亚", startMs: soon, allDay: false },
      { feed: "work", key: "e2", summary: "周会", startMs: soon + 10 * 86_400_000, allDay: false },
    ],
  });
  const signals = sensor.collect(0);
  assert.equal(signals.length, 2);
  assert.equal(signals[0].stream, "schedule");
  assert.equal(signals[0].salience, "high", "1h 内 → high");
  assert.equal(signals[1].salience, "low", "远期 → low");
  assert.equal(signals[0].fingerprint, "ics:work:e1");
  assert.deepEqual(signals[0].payload?.entities, ["三亚", "三亚出差"]);
});

test("FinanceSensor: 账本条目 → finance 流 Signal（商户入实体）", () => {
  const t = Date.now() - 60_000;
  const sensor = new FinanceSensor(
    {
      getTransactions: () => [
        { id: "tx1", date: new Date(t).toISOString(), amount: 1234.5, type: "expense", merchant: "携程", category: "旅行" },
        { id: "tx2", date: new Date(t - 5 * 86_400_000).toISOString(), amount: 5, type: "expense" },
      ],
    },
    () => "u1",
  );
  const signals = sensor.collect(t - 86_400_000);
  // 512*... 只取 at > since 的；tx1 在窗口内
  const tx1 = signals.find((s) => s.fingerprint === "finance:tx1");
  assert.ok(tx1, "tx1 在窗口内");
  assert.equal(tx1.stream, "finance");
  assert.equal(tx1.salience, "medium", "≥500 → medium");
  assert.match(tx1.delta ?? "", /支出 ¥1234\.50（携程）/);
  assert.deepEqual(tx1.payload?.entities, ["携程", "旅行"]);
});

test("FinanceSensor: 无 actor 时返回空（不误采）", () => {
  const sensor = new FinanceSensor({ getTransactions: () => [{ id: "x", date: "", amount: 1, type: "expense" }] }, () => null);
  assert.deepEqual(sensor.collect(0), []);
});

// ─── 内核收编 + 健康上报 ───

test("内核: 外部信源注册后出现在 health() 面板（与内线同权）", async () => {
  const dir = tmpDir();
  try {
    const kernel = new SensorKernel({ dataPath: dir, disablePersist: true });
    let calls = 0;
    kernel.register({
      id: "mail_watch",
      stream: "mail",
      pollIntervalMs: 1000,
      collect: () => {
        calls += 1;
        return [
          { stream: "mail" as const, at: 1700, fingerprint: `mail:${calls}`, salience: "high" as const, delta: "新邮件：X", payload: { entities: ["X"] } },
        ];
      },
    });
    kernel.register({ id: "ics_subscription", stream: "schedule", pollIntervalMs: 1000, collect: () => [] });
    const health = kernel.health();
    const ids = health.map((h) => h.sensorId);
    assert.ok(ids.includes("mail_watch"), `邮件信源进健康面板: ${ids}`);
    assert.ok(ids.includes("ics_subscription"));
    assert.equal(health.find((h) => h.sensorId === "mail_watch")?.mode, "poll");
    // 轮询一次 → emitted 记账
    await kernel.pollOnce();
    assert.equal(kernel.health().find((h) => h.sensorId === "mail_watch")?.emitted, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("内核: 外部信源连续失败 → 熔断（与内线同一套退避）", async () => {
  const dir = tmpDir();
  try {
    const kernel = new SensorKernel({ dataPath: dir, disablePersist: true });
    kernel.register({
      id: "mail_watch",
      stream: "mail",
      pollIntervalMs: 1000,
      collect: () => {
        throw new Error("IMAP 连接失败");
      },
    });
    for (let i = 0; i < 3; i++) await kernel.pollOnce();
    const h = kernel.health().find((x) => x.sensorId === "mail_watch")!;
    assert.equal(h.consecutiveFails, 3);
    assert.equal(h.tripped, true, "3 次失败熔断");
    assert.match(h.lastError ?? "", /IMAP/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── SourceStore：自己的数据库 ───

test("SourceStore: 信号按天分区落盘（streams/<stream>/<YYYY-MM-DD>.ndjson）", () => {
  const dir = tmpDir();
  try {
    const store = new SourceStore({ dataPath: dir });
    const atMail = Date.parse("2026-10-05T09:00:00");
    const atSched = Date.parse("2026-10-05T10:00:00");
    store.feed({ stream: "mail", at: atMail, fingerprint: "m1", salience: "high", delta: "新邮件：三亚机票" });
    store.feed({ stream: "schedule", at: atSched, fingerprint: "s1", salience: "low", delta: "日历事件：三亚出差" });
    const mailPath = join(dir, "sensor-fabric", "streams", "mail", `${dateKey(atMail)}.ndjson`);
    const schedPath = join(dir, "sensor-fabric", "streams", "schedule", `${dateKey(atSched)}.ndjson`);
    assert.ok(existsSync(mailPath), `mail 按天分区落盘: ${mailPath}`);
    assert.ok(existsSync(schedPath), "schedule 按天分区落盘");
    assert.match(readFileSync(mailPath, "utf8"), /三亚机票/);
    // 读回
    assert.equal(readPartition(dir, "mail").length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("SourceStore: 跨源实体检索——「三亚」一次命中邮件+日历（Muse 汇聚的核心价值）", () => {
  const dir = tmpDir();
  try {
    const store = new SourceStore({ dataPath: dir, disablePersist: true });
    store.feed({ stream: "mail", at: 1700, fingerprint: "m1", salience: "high", delta: "新邮件：三亚机票确认", payload: { entities: ["三亚"] } });
    store.feed({ stream: "schedule", at: 1701, fingerprint: "s1", salience: "low", delta: "日历事件：三亚出差", payload: { entities: ["三亚"] } });
    store.feed({ stream: "finance", at: 1702, fingerprint: "f1", salience: "medium", delta: "支出 ¥2880.00（三亚酒店）", payload: { entities: ["三亚"] } });
    const hits = store.findByEntity("三亚");
    assert.equal(hits.length, 3, "三个来源都命中");
    assert.deepEqual(
      [...new Set(hits.map((h) => h.stream))].sort(),
      ["finance", "mail", "schedule"],
      "跨源汇聚（不再各扫各的）",
    );
    // 可按 stream 过滤
    assert.equal(store.findByEntity("三亚", { streams: ["mail"] }).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("SourceStore: 显式实体优先 + 文本 tokenize（中文 2-4 字 / 英文 3+）", () => {
  const sig: Signal = {
    stream: "message",
    at: 1,
    fingerprint: "x",
    salience: "low",
    delta: "张总 发来合同 review 邮件",
    payload: { entities: ["客户A"] },
  };
  const entities = extractEntities(sig);
  assert.ok(entities.includes("客户a"), `显式实体小写化: ${entities}`);
  assert.ok(entities.includes("张总"), `中文 2 字: ${entities}`);
  assert.ok(
    entities.some((e) => e.includes("合同")),
    `中文连续段（贪心 2-4 字）保留: ${entities}`,
  );
  assert.ok(entities.includes("review"), `英文 3+ 保留: ${entities}`);
});

test("SourceStore: stats() 反映各 stream 计数（健康面板数据源）", () => {
  const dir = tmpDir();
  try {
    const store = new SourceStore({ dataPath: dir, disablePersist: true });
    store.feed({ stream: "mail", at: 1, fingerprint: "a", salience: "low" });
    store.feed({ stream: "mail", at: 2, fingerprint: "b", salience: "low" });
    store.feed({ stream: "schedule", at: 3, fingerprint: "c", salience: "low" });
    const st = store.stats();
    assert.equal(st.streams.mail, 2);
    assert.equal(st.streams.schedule, 1);
    assert.ok(st.entityKeys >= 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("SourceStore: SENSOR_SOURCE_STORE=0 整体关闭（回退）", () => {
  const dir = tmpDir();
  try {
    const store = new SourceStore({ dataPath: dir, env: { SENSOR_SOURCE_STORE: "0" } });
    assert.equal(store.enabled(), false);
    store.feed({ stream: "mail", at: 1, fingerprint: "a", salience: "low" });
    assert.equal(store.stats().windowSize, 0, "关闭后不汇聚");
    assert.ok(!existsSync(join(dir, "sensor-fabric", "streams", "mail")), "不落盘");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("SourceStore: 端到端——内核 emit 的信号自动汇聚进库（onSignal 桥）", () => {
  const dir = tmpDir();
  try {
    const kernel = new SensorKernel({ dataPath: dir, disablePersist: true });
    const store = new SourceStore({ dataPath: dir, disablePersist: true });
    kernel.onSignal((sig) => store.feed(sig));
    kernel.register({ id: "mail_watch", stream: "mail", pollIntervalMs: 0, collect: () => [] });
    kernel.emit("mail_watch", {
      stream: "mail",
      at: 1700,
      fingerprint: "m1",
      salience: "high",
      delta: "新邮件：三亚机票",
      payload: { entities: ["三亚"] },
    });
    assert.equal(store.stats().streams.mail, 1, "内核信号已汇聚进库");
    assert.equal(store.findByEntity("三亚").length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── 持久分段库：按天分区 / 保留清理 / 启动加载 / LRU 淘汰（Muse 做法）───

test("SourceStore: 跨天信号落到不同日分区（按天切分，不再单代轮转）", () => {
  const dir = tmpDir();
  try {
    const store = new SourceStore({ dataPath: dir });
    const d1 = Date.parse("2026-10-01T12:00:00");
    const d2 = Date.parse("2026-10-02T12:00:00");
    store.feed({ stream: "mail", at: d1, fingerprint: "a", salience: "low", delta: "三亚" });
    store.feed({ stream: "mail", at: d2, fingerprint: "b", salience: "low", delta: "三亚" });
    const dirMail = join(dir, "sensor-fabric", "streams", "mail");
    assert.ok(existsSync(join(dirMail, `${dateKey(d1)}.ndjson`)), "第一天分区");
    assert.ok(existsSync(join(dirMail, `${dateKey(d2)}.ndjson`)), "第二天分区");
    const all = readPartition(dir, "mail");
    assert.equal(all.length, 2, "跨日期聚合读回");
    assert.ok(all[0].at <= all[1].at, "按日期升序拼接");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("SourceStore: 保留 N 天——超期日分区被清理（pruneExpired）", () => {
  const dir = tmpDir();
  try {
    const now = Date.parse("2026-10-10T12:00:00");
    const store = new SourceStore({
      dataPath: dir,
      nowFn: () => now,
      env: { SENSOR_SOURCE_RETENTION_DAYS: "7" },
    });
    const fresh = now - 3 * 86_400_000;
    const stale = now - 40 * 86_400_000;
    // 先写保留期内（触发的惰性清理此时无可删），再写超期项
    store.feed({ stream: "mail", at: fresh, fingerprint: "fresh", salience: "low", delta: "三亚" });
    store.feed({ stream: "mail", at: stale, fingerprint: "stale", salience: "low", delta: "旧信" });
    const dirMail = join(dir, "sensor-fabric", "streams", "mail");
    assert.ok(existsSync(join(dirMail, `${dateKey(stale)}.ndjson`)), "超期项先落盘");
    const removed = store.pruneExpired(now);
    assert.equal(removed, 1, "只删超期那一个");
    assert.ok(!existsSync(join(dirMail, `${dateKey(stale)}.ndjson`)), "超期日分区已删");
    assert.ok(existsSync(join(dirMail, `${dateKey(fresh)}.ndjson`)), "保留期内保留");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("SourceStore: 保留 0 天 = 永久保留（pruneExpired 不动手）", () => {
  const dir = tmpDir();
  try {
    const now = Date.parse("2026-10-10T12:00:00");
    const store = new SourceStore({
      dataPath: dir,
      nowFn: () => now,
      env: { SENSOR_SOURCE_RETENTION_DAYS: "0" },
    });
    const ancient = now - 400 * 86_400_000;
    store.feed({ stream: "mail", at: ancient, fingerprint: "x", salience: "low", delta: "很旧的信" });
    assert.equal(store.pruneExpired(now), 0, "永久保留不清理");
    assert.ok(existsSync(join(dir, "sensor-fabric", "streams", "mail", `${dateKey(ancient)}.ndjson`)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("SourceStore: 启动分段加载——重启后历史仍可跨源检索（不再重启即失忆）", () => {
  const dir = tmpDir();
  try {
    const now = Date.parse("2026-10-10T12:00:00");
    const store1 = new SourceStore({ dataPath: dir, nowFn: () => now });
    store1.feed({ stream: "mail", at: now - 60_000, fingerprint: "m1", salience: "high", delta: "新邮件：三亚机票", payload: { entities: ["三亚"] } });
    store1.feed({ stream: "finance", at: now - 30_000, fingerprint: "f1", salience: "medium", delta: "支出（三亚酒店）", payload: { entities: ["三亚"] } });
    // 新实例 = 模拟进程重启（内存空）
    const store2 = new SourceStore({ dataPath: dir, nowFn: () => now });
    assert.equal(store2.findByEntity("三亚").length, 0, "重启后内存空");
    const loaded = store2.loadRecent();
    assert.equal(loaded, 2, "加载最近窗口内信号");
    assert.equal(store2.findByEntity("三亚").length, 2, "历史跨源可查");
    assert.deepEqual(
      [...new Set(store2.findByEntity("三亚").map((h) => h.stream))].sort(),
      ["finance", "mail"],
    );
    assert.equal(store2.stats().loaded, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("SourceStore: 启动加载兼容旧扁平分区文件（迁移期不丢数据）", () => {
  const dir = tmpDir();
  try {
    const now = Date.parse("2026-10-10T12:00:00");
    const legacyDir = join(dir, "sensor-fabric", "streams");
    mkdirSync(legacyDir, { recursive: true });
    const legacy = {
      stream: "mail",
      at: now - 1000,
      fingerprint: "legacy1",
      salience: "high",
      delta: "旧格式：三亚",
      payload: { entities: ["三亚"] },
    };
    writeFileSync(join(legacyDir, "mail.ndjson"), `${JSON.stringify(legacy)}\n`);
    const store = new SourceStore({ dataPath: dir, nowFn: () => now });
    assert.ok(store.loadRecent() >= 1, "旧文件也纳入加载");
    assert.equal(store.findByEntity("三亚").length, 1, "旧数据可查");
    assert.equal(readPartition(dir, "mail").length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("SourceStore: 实体索引满按 LRU 淘汰最旧（不再拒新）", () => {
  const dir = tmpDir();
  try {
    const store = new SourceStore({ dataPath: dir, disablePersist: true });
    const N = 5005;
    for (let i = 0; i < N; i++) {
      store.feed({ stream: "message", at: i, fingerprint: `fp${i}`, salience: "low", delta: `ent${String(i).padStart(5, "0")}` });
    }
    const st = store.stats();
    assert.equal(st.entityKeys, 5000, "索引键数封顶");
    assert.ok(st.evicted >= 5, `淘汰计数增长: ${st.evicted}`);
    assert.equal(store.findByEntity("ent05004").length, 1, "最新实体进得来（未被拒）");
    assert.equal(store.findByEntity("ent00000").length, 0, "最旧实体已被淘汰");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
