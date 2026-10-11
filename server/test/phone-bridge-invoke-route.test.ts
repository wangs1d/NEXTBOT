/**
 * 手机桥接客户端调用端点（POST /phone-bridge/invoke）单测。
 *
 * 覆盖：身份解析、动作白名单、号码安全校验（紧急号码拒绝）、离线 409、
 * 以及各动作的参数整形（只透传白名单字段）。桩 coordinator，不启 WS、不连真机。
 */
import assert from "node:assert/strict";
import test from "node:test";

import Fastify from "fastify";

import { registerPhoneBridgeRoutes } from "../src/routes/http/phone-bridge.js";
import type { PhoneBridgeCoordinator } from "../src/services/phone-bridge-coordinator.js";

type InvokeCall = {
  actorId: string;
  action: string;
  params: Record<string, unknown>;
};

function makeApp(opts: { online?: boolean } = {}) {
  const online = opts.online !== false;
  const calls: InvokeCall[] = [];
  const stub = {
    hasExecutor: (actorId: string) => online && actorId.length > 0,
    getDeviceInfo: () => (online ? { brand: "NEXTBOT", model: "Test-1" } : undefined),
    getSyncPayload: () => ({ phoneBridgeOnline: online, updatedAt: "2026-01-01T00:00:00Z" }),
    invoke: async (actorId: string, action: string, params: Record<string, unknown> = {}) => {
      calls.push({ actorId, action, params });
      if (action === "dial") return { ok: true, state: "dialing" };
      if (action === "battery") return { ok: true, level: 88, charging: false };
      return { ok: true };
    },
  } as unknown as PhoneBridgeCoordinator;

  const app = Fastify();
  registerPhoneBridgeRoutes(app, { phoneBridgeCoordinator: stub });
  return { app, calls };
}

test("invoke: 白名单外动作一律 400（含摄像头/录屏）", async () => {
  const { app, calls } = makeApp();
  for (const action of ["camera_capture", "screen_record", "notifications", "rm_rf"]) {
    const res = await app.inject({
      method: "POST",
      url: "/phone-bridge/invoke",
      payload: { sessionId: "user-a", action },
    });
    assert.equal(res.statusCode, 400, `action=${action}`);
  }
  assert.equal(calls.length, 0);
  await app.close();
});

test("invoke: 缺身份 400", async () => {
  const { app } = makeApp();
  const res = await app.inject({
    method: "POST",
    url: "/phone-bridge/invoke",
    payload: { action: "dial", params: { number: "13800138000" } },
  });
  assert.equal(res.statusCode, 400);
  await app.close();
});

test("invoke: 手机离线 409", async () => {
  const { app, calls } = makeApp({ online: false });
  const res = await app.inject({
    method: "POST",
    url: "/phone-bridge/invoke",
    payload: { sessionId: "user-a", action: "battery" },
  });
  assert.equal(res.statusCode, 409);
  assert.equal(calls.length, 0);
  await app.close();
});

test("invoke: 紧急号码/非法号码拒绝 400", async () => {
  const { app, calls } = makeApp();
  for (const number of ["110", "119", "911", "12", "abcdef"]) {
    const res = await app.inject({
      method: "POST",
      url: "/phone-bridge/invoke",
      payload: { sessionId: "user-a", action: "dial", params: { number } },
    });
    assert.equal(res.statusCode, 400, `number=${number}`);
  }
  assert.equal(calls.length, 0);
  await app.close();
});

test("invoke: dial 正常——号码归一、参数整形、透传回执", async () => {
  const { app, calls } = makeApp();
  const res = await app.inject({
    method: "POST",
    url: "/phone-bridge/invoke",
    payload: {
      sessionId: "user-a",
      action: "dial",
      params: {
        number: "138 0013-8000",
        contactName: "小王",
        reason: "回个电话",
        mode: "weird", // 非 draft → 归一为 direct
        hacked: "drop-me", // 未知字段必须被丢弃
      },
    },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.ok, true);
  assert.equal(body.state, "dialing");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].actorId, "user-a");
  assert.deepEqual(calls[0].params, {
    number: "13800138000",
    contactName: "小王",
    reason: "回个电话",
    mode: "direct",
  });
  await app.close();
});

test("invoke: send_sms 缺内容 400，正常时参数整形", async () => {
  const { app, calls } = makeApp();
  const bad = await app.inject({
    method: "POST",
    url: "/phone-bridge/invoke",
    payload: { sessionId: "user-a", action: "send_sms", params: { number: "10086" } },
  });
  assert.equal(bad.statusCode, 400);

  const good = await app.inject({
    method: "POST",
    url: "/phone-bridge/invoke",
    payload: {
      sessionId: "user-a",
      action: "send_sms",
      params: { number: "10086", text: "查话费" },
    },
  });
  assert.equal(good.statusCode, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].action, "send_sms");
  assert.equal(calls[0].params.number, "10086");
  assert.equal(calls[0].params.text, "查话费");
  await app.close();
});

test("invoke: limit 收敛 + userId 身份优先", async () => {
  const { app, calls } = makeApp();
  const res = await app.inject({
    method: "POST",
    url: "/phone-bridge/invoke",
    payload: {
      userId: "phone-user",
      sessionId: "ignored-when-userId",
      action: "sms_list",
      params: { limit: 9999 },
    },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(calls[0].actorId, "phone-user");
  assert.deepEqual(calls[0].params, { limit: 100 });
  await app.close();
});

test("status: 回在线状态与设备信息，兼容 actorId 直传", async () => {
  const { app } = makeApp();
  const res = await app.inject({
    method: "GET",
    url: "/phone-bridge/status?actorId=user-a",
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.ok, true);
  assert.equal(body.phoneBridgeOnline, true);
  assert.equal(body.deviceInfo.brand, "NEXTBOT");
  await app.close();
});
