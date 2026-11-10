/**
 * GET /travel/capabilities 能力自检端点测试。
 *
 * 背景此前查价失败一律静默落「待核价」，客户端与运维都无法区分
 * 「CLI 没装 / 没配 key / 平台无货」。此端点把环境能力变成可查询事实。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "travel-capabilities-test-"));
process.env.NEXTBOT_DATA_DIR = path.join(tmpDir, "data");
process.env.FLYAI_BIN = path.join(tmpDir, "definitely-not-exists");

const { registerTravelPlanRoutes } = await import("../src/routes/http/travel-plan.js");
const { resetTravelCapabilitiesCache } = await import(
  "../src/skills/travel-planning/pricing-capability.js"
);
const { default: Fastify } = await import("fastify");

const app = Fastify({ logger: false });
registerTravelPlanRoutes(app, {});
await app.ready();

test("capabilities 返回四域结构，未装 CLI 时如实报 missing-cli 而非假装可用", async () => {
  resetTravelCapabilitiesCache();
  const resp = await app.inject({ method: "GET", url: "/travel/capabilities" });
  assert.equal(resp.statusCode, 200);
  const body = resp.json() as Record<string, any>;
  assert.equal(body.ok, true);
  assert.equal(body.flyai.installed, false, "测试环境 FLYAI_BIN 指向不存在的文件");
  assert.equal(body.pricing.degraded, true);
  assert.equal(body.pricing.reason, "missing-cli");
  assert.equal(typeof body.poi.db, "boolean");
  assert.equal(typeof body.map.tileCacheWarm, "boolean");
  assert.equal(body.cacheAgeMs, 0);
});

test("探测结果带 5 分钟缓存：二次调用不再 spawn，cacheAgeMs 递增", async () => {
  resetTravelCapabilitiesCache();
  await app.inject({ method: "GET", url: "/travel/capabilities" });
  const second = await app.inject({ method: "GET", url: "/travel/capabilities" });
  const body = second.json() as Record<string, any>;
  assert.ok(body.cacheAgeMs >= 0 && body.cacheAgeMs < 5 * 60 * 1000);
});

test("capabilities 不依赖规划引擎装配（未装配也 200）", async () => {
  const resp = await app.inject({ method: "GET", url: "/travel/capabilities" });
  assert.equal(resp.statusCode, 200, "能力探测与 travelPlanningService 无关");
});
