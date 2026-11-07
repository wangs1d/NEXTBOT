/**
 * ActorContextService / 时区四源择优单测（2026-11-05 时间感知重构配套）。
 *
 * 锁死的语义（这些是「手机端时间注入有问题」的根因，回归必须挡住）：
 *   1. 设备 IANA 时区优先于定位时区与服务器时区，且不因「旧」而降级；
 *      例外（2026-11-06）：与定位时区偏移冲突时改信定位（模拟器 GMT 事故）；
 *   2. 定位时区只作兜底，非法/缺失才轮到它；
 *   3. 四源全不可用才回落服务器时区，并显式标记 source="server"（告警信号）；
 *   4. 垃圾时区（"UTC+8" / 空串 / 脏值）不得让 Intl 抛错击穿 prompt 装配；
 *   5. 位置更新不得覆盖已有的设备直报时区（逆地理 tz 是城市级推断，会错）；
 *   6. 旧客户端只随位置带时区时仍可用（标记 legacy-location）；
 *   7. 快照落盘后可恢复（冷启动不得退回服务器时区）。
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ActorContextService,
  clockSkewMs,
  describeLocationAge,
  isValidIanaTimezone,
  resolveUserClock,
  zoneOffsetMinutes,
} from "../src/services/actor-context-service.js";

test("时区四源择优：设备时区优先于定位与服务器（偏移一致时）", () => {
  // 2026-11-06 冲突防御上线后，「设备优先」只在设备与定位偏移一致时成立；
  // 用同时区（纽约/多伦多，恒同偏移）锁原语义。
  const clock = resolveUserClock({
    clientTimezone: "America/New_York",
    clientUtcOffsetMinutes: -300,
    clientSource: "snapshot",
    geoTimezone: "America/Toronto",
    serverTimezone: "Asia/Shanghai",
    nowMs: Date.UTC(2026, 10, 6, 4, 0, 0),
  });
  assert.equal(clock.timezone, "America/New_York");
  assert.equal(clock.source, "client-snapshot");
  assert.equal(clock.utcOffsetMinutes, -300);
});

test("时区四源择优：设备与定位时区偏移冲突时改信定位（模拟器 GMT 事故防御）", () => {
  // 事故形态：Android 模拟器默认 GMT（设备直报），人在中国（定位 Asia/Shanghai）。
  // 旧语义盲信设备直报 → 模型整轮活在「凌晨 4 点」。冲突时坐标反解更可信。
  const clock = resolveUserClock({
    clientTimezone: "GMT",
    clientUtcOffsetMinutes: 0,
    clientSource: "snapshot",
    geoTimezone: "Asia/Shanghai",
    serverTimezone: "Asia/Shanghai",
    nowMs: Date.UTC(2026, 10, 6, 4, 21, 0),
  });
  assert.equal(clock.timezone, "Asia/Shanghai");
  assert.equal(clock.source, "geo");
});

test("时区四源择优：设备上报 event 来源单独标记", () => {
  const clock = resolveUserClock({
    clientTimezone: "Europe/Berlin",
    clientSource: "event",
    serverTimezone: "Asia/Shanghai",
  });
  assert.equal(clock.source, "client-event");
});

test("时区四源择优：设备时区非法时退到定位时区", () => {
  const clock = resolveUserClock({
    clientTimezone: "UTC+8",
    geoTimezone: "America/Los_Angeles",
    serverTimezone: "Asia/Shanghai",
  });
  assert.equal(clock.timezone, "America/Los_Angeles");
  // 未带 clientSource 的 geo 分支不冒领 client 来源
  assert.notEqual(clock.source, "client-snapshot");
});

test("时区四源择优：全缺失时回落服务器时区并标记 server", () => {
  const clock = resolveUserClock({ serverTimezone: "UTC" });
  assert.equal(clock.timezone, "UTC");
  assert.equal(clock.source, "server");
});

test("时区四源择优：用户档案是服务器之前的最后一层", () => {
  const clock = resolveUserClock({
    profileTimezone: "Asia/Tokyo",
    serverTimezone: "Asia/Shanghai",
  });
  assert.equal(clock.timezone, "Asia/Tokyo");
  assert.equal(clock.source, "profile");
});

test("IANA 时区校验：垃圾值一律 false，不抛异常", () => {
  assert.equal(isValidIanaTimezone("Asia/Shanghai"), true);
  assert.equal(isValidIanaTimezone("America/Argentina/Buenos_Aires"), true);
  assert.equal(isValidIanaTimezone(""), false);
  assert.equal(isValidIanaTimezone(undefined), false);
  assert.equal(isValidIanaTimezone("UTC+8"), false);
  assert.equal(isValidIanaTimezone("Mars/Olympus"), false);
});

test("时区偏移计算与夏令时：纽约冬夏相差一小时", () => {
  const winter = zoneOffsetMinutes("America/New_York", Date.UTC(2026, 0, 15, 12, 0, 0));
  const summer = zoneOffsetMinutes("America/New_York", Date.UTC(2026, 6, 15, 12, 0, 0));
  assert.equal(winter, -300);
  assert.equal(summer, -240);
  assert.equal(zoneOffsetMinutes("Asia/Shanghai", Date.UTC(2026, 6, 15, 12, 0, 0)), 480);
  assert.equal(zoneOffsetMinutes("Not/AZone", Date.UTC(2026, 6, 15, 12, 0, 0)), undefined);
});

test("位置龄期分档：绝不把旧位置说成实时", () => {
  assert.equal(describeLocationAge(30_000), "实时");
  assert.equal(describeLocationAge(4 * 60_000), "实时");
  assert.equal(describeLocationAge(12 * 60_000), "12 分钟前");
  assert.equal(describeLocationAge(3 * 3600_000), "3 小时前");
  assert.equal(describeLocationAge(50 * 3600_000), "2 天前");
});

test("时钟偏差：裸本地时间不参与诊断（避免运行环境时区造成假偏差）", () => {
  const now = Date.UTC(2026, 10, 5, 9, 0, 0);
  assert.equal(clockSkewMs("2026-11-05T17:00:00", now), undefined);
  assert.equal(clockSkewMs(undefined, now), undefined);
  assert.equal(clockSkewMs("2026-11-05T09:00:30Z", now), 30_000);
  assert.equal(clockSkewMs("2026-11-05T17:00:30+08:00", now), 30_000);
});

test("快照：位置更新不得覆盖存储的设备直报时区（存储层语义）", () => {
  const svc = new ActorContextService({
    persistPath: join(tmpdir(), `actor-ctx-unit-${process.pid}.json`),
    persistThrottleMs: 0,
    serverTimezone: "Asia/Shanghai",
    now: () => 1_700_000_000_000,
  });

  svc.updateClock("u1", { timezone: "America/New_York", utcOffsetMinutes: -300, source: "snapshot" });
  // 位置更新只写 location 块，不得篡改 ctx.clock 的存储值
  svc.updateLocation(
    "u1",
    { latitude: 40.7, longitude: -74.0, city: "纽约", timezone: "Asia/Shanghai" },
    "ondemand",
  );

  const ctx = svc.get("u1");
  assert.equal(ctx?.clock?.timezone, "America/New_York");
  assert.equal(ctx?.location?.city, "纽约");
  // 位置的时区字段保留原值（供观测/诊断），但不参与时钟解析的存储侧
  assert.equal(ctx?.location?.timezone, "Asia/Shanghai");
  // 解析侧：设备与定位偏移冲突 → 改信定位（2026-11-06 冲突防御，见上方专项用例）
  const clock = svc.resolveClock("u1");
  assert.equal(clock.timezone, "Asia/Shanghai");
  assert.equal(clock.source, "geo");
});

test("快照：旧客户端只随位置带时区时仍可用", () => {
  const svc = new ActorContextService({
    persistPath: join(tmpdir(), `actor-ctx-legacy-${process.pid}.json`),
    persistThrottleMs: 0,
    serverTimezone: "Asia/Shanghai",
  });
  svc.updateLocation(
    "u2",
    { latitude: 51.5, longitude: -0.12, city: "伦敦", timezone: "Europe/London" },
    "report",
  );
  assert.equal(svc.get("u2")?.clock?.source, "legacy-location");
  assert.equal(svc.resolveClock("u2").timezone, "Europe/London");
});

test("快照：无任何上报时明确标记服务器时区来源", () => {
  const svc = new ActorContextService({
    persistPath: join(tmpdir(), `actor-ctx-empty-${process.pid}.json`),
    persistThrottleMs: 0,
    serverTimezone: "Asia/Shanghai",
  });
  const clock = svc.resolveClock("nobody");
  assert.equal(clock.timezone, "Asia/Shanghai");
  assert.equal(clock.source, "server");
});

test("快照：落盘后可恢复（冷启动不退回服务器时区）", async () => {
  const dir = await mkdtemp(join(tmpdir(), "actor-ctx-persist-"));
  const file = join(dir, "actor-context.json");
  try {
    const first = new ActorContextService({
      persistPath: file,
      persistThrottleMs: 0,
      serverTimezone: "Asia/Shanghai",
    });
    first.updateClock("u3", { timezone: "America/Los_Angeles", utcOffsetMinutes: -420 });
    first.updateLocation("u3", { latitude: 34.05, longitude: -118.24, city: "洛杉矶" }, "ondemand");
    await first.flush();

    const second = new ActorContextService({
      persistPath: file,
      persistThrottleMs: 0,
      serverTimezone: "Asia/Shanghai",
    });
    const clock = second.resolveClock("u3");
    assert.equal(clock.timezone, "America/Los_Angeles");
    assert.equal(second.get("u3")?.location?.city, "洛杉矶");
    await second.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("快照：clear 后不再残留（隐私清除必须彻底）", () => {
  const svc = new ActorContextService({
    persistPath: join(tmpdir(), `actor-ctx-clear-${process.pid}.json`),
    persistThrottleMs: 0,
    serverTimezone: "Asia/Shanghai",
  });
  svc.updateClock("u4", { timezone: "Europe/Paris" });
  svc.updateLocation("u4", { latitude: 48.85, longitude: 2.35, city: "巴黎" }, "report");
  svc.clear("u4");
  assert.equal(svc.get("u4"), undefined);
  assert.equal(svc.resolveClock("u4").source, "server");
});

test("快照：只清位置时保留时钟", () => {
  const svc = new ActorContextService({
    persistPath: join(tmpdir(), `actor-ctx-clearloc-${process.pid}.json`),
    persistThrottleMs: 0,
    serverTimezone: "Asia/Shanghai",
  });
  svc.updateClock("u5", { timezone: "Europe/Paris" });
  svc.updateLocation("u5", { latitude: 48.85, longitude: 2.35 }, "report");
  svc.clearLocation("u5");
  assert.equal(svc.get("u5")?.location, undefined);
  assert.equal(svc.resolveClock("u5").timezone, "Europe/Paris");
});
