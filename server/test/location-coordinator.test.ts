/**
 * LocationCoordinator 按需定位单测（2026-10-09 手机端「agent 不知道用户地址」修复配套）。
 *
 * 背景：服务端把 `agent.location_request` 发给该 actor 绑定的 socket；手机端
 * 聊天 WS 与桌面根 WS 同 actor 竞绑（后 session.init 者胜）。此前聊天 WS 不应答
 * 时恒超时。本套测试锁定协调器核心语义，锁死客户端修复所依赖的服务端行为：
 *   1. 绑定 socket 回包（带 jobId）→ 挂起请求 resolve 坐标
 *   2. 任意 socket 回包 → actor 缓存必写入（缓存不挑 socket）
 *   3. 非绑定 socket 回带 jobId 的包 → 挂起请求不被 resolve（归属校验），走超时
 *   4. 新鲜缓存命中 → 不再向客户端发起请求
 *   5. 无 jobId 纯上报 → 只写缓存
 *   6. 连接断开 → 挂起请求立即按失败结算（不悬空）
 *   7. 无绑定 socket → requestLocation 立即 resolve null
 *   8. getLastKnown 取最近一次已知位置：内存缓存优先，缺失时回退落盘历史，
 *      超龄一律 null，返回值必带 ageMs（调用方据此如实标注龄期）
 */

import assert from "node:assert/strict";
import test from "node:test";

import { LocationCoordinator } from "../src/services/location-coordinator.js";
import type { WsSendLike } from "../src/services/location-coordinator.js";

class FakeSocket implements WsSendLike {
  readyState = 1;
  sent: string[] = [];

  send(data: string): void {
    this.sent.push(data);
  }

  lastLocationRequestJobId(): string {
    for (let i = this.sent.length - 1; i >= 0; i--) {
      const msg = JSON.parse(this.sent[i]) as {
        type?: string;
        payload?: { jobId?: string };
      };
      if (msg.type === "agent.location_request" && msg.payload?.jobId) {
        return msg.payload.jobId;
      }
    }
    return "";
  }
}

const COORDS = { latitude: 27.7255, longitude: 106.9291, timezone: "Asia/Shanghai" };

test("绑定 socket 回包（带 jobId）→ 挂起请求 resolve 坐标", async () => {
  const coordinator = new LocationCoordinator({ requestTimeoutMs: 200 });
  const socket = new FakeSocket();
  coordinator.bindSocket("actor-1", socket);

  const pending = coordinator.requestLocation("actor-1", "weather.get_local");
  const jobId = socket.lastLocationRequestJobId();
  assert.ok(jobId, "应已下发 agent.location_request 携 jobId");

  const consumed = coordinator.completeFromSocket(socket, "actor-1", {
    jobId,
    ...COORDS,
  });
  assert.equal(consumed, true);
  const resolved = await pending;
  assert.equal(resolved?.latitude, COORDS.latitude);
  assert.equal(resolved?.longitude, COORDS.longitude);
  // 回包同时写缓存
  assert.equal(coordinator.getCached("actor-1")?.latitude, COORDS.latitude);
});

test("任意 socket 回包 → actor 缓存必写入（缓存不挑 socket）", async () => {
  const coordinator = new LocationCoordinator({ requestTimeoutMs: 5_000 });
  const bound = new FakeSocket();
  coordinator.bindSocket("actor-2", bound);

  // 请求发给绑定的 bound；另一条连接（如桌面根 WS）主动上报坐标
  void coordinator.requestLocation("actor-2", "prompt:chat-context");
  const other = new FakeSocket();
  coordinator.completeFromSocket(other, "actor-2", { ...COORDS });

  assert.equal(coordinator.getCached("actor-2")?.latitude, COORDS.latitude);
  assert.equal(coordinator.getCached("actor-2")?.longitude, COORDS.longitude);
});

test("非绑定 socket 回 jobId 包 → 挂起请求不被 resolve，走超时（归属校验）", async () => {
  const coordinator = new LocationCoordinator({ requestTimeoutMs: 60 });
  const bound = new FakeSocket();
  coordinator.bindSocket("actor-3", bound);

  const pending = coordinator.requestLocation("actor-3", "tool:weather.get_local");
  const jobId = bound.lastLocationRequestJobId();

  // 挂起期间，别的 socket 拿着同 jobId 回包：不 resolve 本请求
  const other = new FakeSocket();
  const consumed = coordinator.completeFromSocket(other, "actor-3", {
    jobId,
    ...COORDS,
  });
  assert.equal(consumed, false, "jobId 不属于该 socket 的挂起请求");

  const resolved = await pending;
  assert.equal(resolved, null, "超时侧应返回 null，由工具自行兜底");
});

test("新鲜缓存命中 → 不再向客户端发起请求", async () => {
  const coordinator = new LocationCoordinator({ requestTimeoutMs: 200 });
  const socket = new FakeSocket();
  coordinator.bindSocket("actor-4", socket);

  coordinator.completeFromSocket(socket, "actor-4", { ...COORDS });
  const resolved = await coordinator.requestLocation("actor-4", "weather.get_local");
  assert.equal(resolved?.latitude, COORDS.latitude);
  assert.equal(socket.sent.length, 0, "缓存新鲜期内不得下发 location_request");
});

test("无 jobId 纯上报 → 只写缓存（天气面板/启动上报路径）", () => {
  const coordinator = new LocationCoordinator();
  const socket = new FakeSocket();
  coordinator.bindSocket("actor-5", socket);

  const consumed = coordinator.completeFromSocket(socket, "actor-5", { ...COORDS });
  assert.equal(consumed, true);
  assert.equal(coordinator.getCached("actor-5")?.latitude, COORDS.latitude);
  assert.equal(socket.sent.length, 0);
});

test("连接断开 → 挂起请求立即按失败结算（不悬空）", async () => {
  const coordinator = new LocationCoordinator({ requestTimeoutMs: 5_000 });
  const socket = new FakeSocket();
  coordinator.bindSocket("actor-6", socket);

  const pending = coordinator.requestLocation("actor-6", "tool:clock.now");
  coordinator.unbindSocket(socket);

  const resolved = await pending;
  assert.equal(resolved, null);
});

test("无绑定 socket → requestLocation 立即 resolve null", async () => {
  const coordinator = new LocationCoordinator();
  const resolved = await coordinator.requestLocation("actor-none", "tool:weather.get_local");
  assert.equal(resolved, null);
});

test("getLastKnown：内存缓存命中 → 不读落盘历史，龄期按写入时间", () => {
  const coordinator = new LocationCoordinator();
  let providerCalls = 0;
  coordinator.setLastKnownProvider(() => {
    providerCalls++;
    return { payload: { latitude: 1, longitude: 1 }, at: Date.now() };
  });

  const socket = new FakeSocket();
  coordinator.bindSocket("actor-8", socket);
  coordinator.completeFromSocket(socket, "actor-8", { ...COORDS });

  const known = coordinator.getLastKnown("actor-8");
  assert.equal(known?.latitude, COORDS.latitude);
  assert.ok(known && known.ageMs >= 0, "必须带 ageMs 供调用方标注龄期");
  assert.equal(providerCalls, 0, "内存命中时不该去读历史库");
});

test("getLastKnown：内存为空 → 回退落盘历史（服务重启后仍能出天气）", () => {
  const coordinator = new LocationCoordinator();
  coordinator.setLastKnownProvider((actorId) =>
    actorId === "actor-9"
      ? { payload: { ...COORDS, city: "兴义市" }, at: Date.now() - 5 * 60_000 }
      : null,
  );

  const known = coordinator.getLastKnown("actor-9");
  assert.equal(known?.latitude, COORDS.latitude);
  assert.equal(known?.city, "兴义市");
  assert.ok(known && known.ageMs >= 5 * 60_000, "龄期应含历史样本距今时间");
  assert.equal(coordinator.getLastKnown("actor-other"), null, "无样本 actor 应返回 null");
});

test("getLastKnown：超过 maxAgeMs → null（不把陈旧位置当实时）", () => {
  const coordinator = new LocationCoordinator();
  coordinator.setLastKnownProvider(() => ({
    payload: { ...COORDS },
    at: Date.now() - 3 * 60 * 60_000,
  }));

  assert.equal(coordinator.getLastKnown("actor-10", 2 * 60 * 60_000), null);
  assert.ok(coordinator.getLastKnown("actor-10", 4 * 60 * 60_000));
});

test("getLastKnown：未注入历史读取器 → 只认内存缓存", () => {
  const coordinator = new LocationCoordinator();
  assert.equal(coordinator.getLastKnown("actor-11"), null);
});
