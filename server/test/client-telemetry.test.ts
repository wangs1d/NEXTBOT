/**
 * 装机埋点路由单测：一次安装一行状态，重复启动累加 boots/failures，
 * 管理端列表要凭证，bootStatus 白名单外的值一律拒收。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Fastify from "fastify";
import type { FastifyInstance } from "fastify";

// 数据目录钉到临时目录：埋点落库不碰真实数据（store 懒打开，首次写在请求期）
process.env.NEXTBOT_DATA_DIR = mkdtempSync(join(tmpdir(), "client-telemetry-"));
process.env.ADMIN_UPLOAD_TOKEN = "test-admin-token";

import { registerClientTelemetryRoutes } from "../src/routes/http/client-telemetry.js";

const ADMIN = { "x-admin-token": "test-admin-token" };

type ClientItem = {
  installId: string;
  appVersion: string | null;
  channel: string | null;
  bootStatus: string;
  bootMs: number | null;
  boots: number;
  failures: number;
};

function makeApp(): FastifyInstance {
  const app = Fastify();
  registerClientTelemetryRoutes(app);
  return app;
}

async function boot(app: FastifyInstance, payload: Record<string, unknown>) {
  return app.inject({ method: "POST", url: "/api/telemetry/client-boot", payload });
}

async function findRow(app: FastifyInstance, installId: string): Promise<ClientItem> {
  const list = await app.inject({ method: "GET", url: "/api/admin/clients", headers: ADMIN });
  assert.equal(list.statusCode, 200);
  const items = list.json().items as ClientItem[];
  const row = items.find((c) => c.installId === installId);
  assert.ok(row, `台账里缺少 ${installId}`);
  return row;
}

test("冷启动成功：落一条 bundledStarted，耗时与版本进台账", async () => {
  const app = makeApp();
  const res = await boot(app, {
    installId: "inst_ok_cold",
    actorId: "user@example.com",
    appVersion: "0.1.6",
    edition: "internal",
    channel: "byok",
    bootStatus: "bundledStarted",
    bootMs: 8200,
    platform: "Windows 11 (10.0.26200)",
  });
  assert.equal(res.statusCode, 200);
  const row = await findRow(app, "inst_ok_cold");
  assert.equal(row.bootStatus, "bundledStarted");
  assert.equal(row.bootMs, 8200);
  assert.equal(row.boots, 1);
  assert.equal(row.failures, 0);
});

test("同一安装重复上报：boots 累加、失败只记失败那次、版本取最新", async () => {
  const app = makeApp();
  await boot(app, { installId: "inst_repeat", bootStatus: "bundledStarted", bootMs: 6000 });
  await boot(app, { installId: "inst_repeat", bootStatus: "bundledNotReady", appVersion: "0.1.7" });
  await boot(app, { installId: "inst_repeat", bootStatus: "bundledAlreadyRunning", appVersion: "0.1.8" });

  const row = await findRow(app, "inst_repeat");
  assert.equal(row.boots, 3);
  assert.equal(row.failures, 1);
  assert.equal(row.appVersion, "0.1.8");
  assert.equal(row.bootStatus, "bundledAlreadyRunning");
  assert.equal(row.bootMs, null);

  const failing = await app.inject({
    method: "GET",
    url: "/api/admin/clients?failing=true",
    headers: ADMIN,
  });
  const ids = (failing.json().items as ClientItem[]).map((c) => c.installId);
  assert.ok(ids.includes("inst_repeat"));
  assert.ok(!ids.includes("inst_ok_cold"), "成功启动的安装不该进失败筛选");
});

test("channel 收回后不再拉起：skippedByChannel 不算失败", async () => {
  const app = makeApp();
  await boot(app, { installId: "inst_platform", bootStatus: "skippedByChannel", channel: "platform" });
  const row = await findRow(app, "inst_platform");
  assert.equal(row.channel, "platform");
  assert.equal(row.failures, 0);
});

test("白名单外的 bootStatus 与非法 installId 一律 400，且不落库", async () => {
  const app = makeApp();
  const badStatus = await boot(app, { installId: "inst_bad_status", bootStatus: "whatever" });
  assert.equal(badStatus.statusCode, 400);
  const badId = await boot(app, { installId: "带中文的id", bootStatus: "bundledStarted" });
  assert.equal(badId.statusCode, 400);
  const list = await app.inject({ method: "GET", url: "/api/admin/clients", headers: ADMIN });
  const ids = (list.json().items as ClientItem[]).map((c) => c.installId);
  assert.ok(!ids.includes("inst_bad_status"));
});

test("管理端列表要凭证：无 token 401，提交通道保持开放", async () => {
  const app = makeApp();
  const anon = await app.inject({ method: "GET", url: "/api/admin/clients" });
  assert.equal(anon.statusCode, 401);
  const submitted = await boot(app, { installId: "inst_open_post", bootStatus: "notBundled" });
  assert.equal(submitted.statusCode, 200);
});
