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

// ─── 多设备并发绑定（2026-11-13 修 socket 模型冲突） ──────────────────────
//
// 病根：此前协调器内部是 actor → **单 socket**。手机聊天 WS 与桌面根 WS 对同一
// actorId 竞绑时后连者覆盖先连者；先连者断开时按 socket 匹配摘除——但 map 里
// 已经没有它，于是手机端被桌面端"带下线"，位置通道静默失效。
// 现在每个 actor 保留全部连接：逐条摘除、fan-out 发送、任一端在线即算在线。

test("多设备：桌面端断开后手机端仍在线 → 位置请求仍能送达手机", async () => {
  const coordinator = new LocationCoordinator();
  const mobile = new FakeSocket();
  const desktop = new FakeSocket();
  coordinator.bindSocket("actor-x", mobile);
  coordinator.bindSocket("actor-x", desktop);

  // 桌面端断开：只摘它自己，手机端不受影响
  coordinator.unbindSocket(desktop);
  assert.equal(coordinator.hasSocket("actor-x"), true, "手机端仍在线");

  const pending = coordinator.requestLocation("actor-x", "test");
  const jobId = mobile.lastLocationRequestJobId();
  assert.ok(jobId, "位置请求应送达手机端");

  coordinator.completeFromSocket(mobile, "actor-x", {
    jobId,
    latitude: COORDS.latitude,
    longitude: COORDS.longitude,
  });
  const loc = await pending;
  assert.equal(loc?.latitude, COORDS.latitude);
});

test("多设备：位置请求 fan-out 到全部在线端（桌面无 GPS 时手机才能应答）", async () => {
  const coordinator = new LocationCoordinator();
  const mobile = new FakeSocket();
  const desktop = new FakeSocket();
  coordinator.bindSocket("actor-y", mobile);
  coordinator.bindSocket("actor-y", desktop);

  const pending = coordinator.requestLocation("actor-y", "test");
  assert.ok(mobile.lastLocationRequestJobId(), "手机端应收到请求");
  assert.ok(desktop.lastLocationRequestJobId(), "桌面端也应收到（谁先回包用谁的）");

  const jobId = mobile.lastLocationRequestJobId();
  coordinator.completeFromSocket(mobile, "actor-y", {
    jobId,
    latitude: COORDS.latitude,
    longitude: COORDS.longitude,
  });
  assert.equal((await pending)?.latitude, COORDS.latitude);
});

test("多设备：围栏同步事件 fan-out 到全部在线端", () => {
  const coordinator = new LocationCoordinator();
  const mobile = new FakeSocket();
  const desktop = new FakeSocket();
  coordinator.bindSocket("actor-z", mobile);
  coordinator.bindSocket("actor-z", desktop);

  assert.equal(coordinator.sendEventToActor("actor-z", "agent.geofence_sync", { fences: [] }), true);
  assert.equal(mobile.sent.length, 1);
  assert.equal(desktop.sent.length, 1, "围栏同步必须两端都收到（手机端要注册系统围栏）");
});

test("多设备：非本 actor 的连接回包带 jobId → 不 resolve（归属校验仍生效）", async () => {
  const coordinator = new LocationCoordinator();
  const mine = new FakeSocket();
  const stranger = new FakeSocket();
  coordinator.bindSocket("actor-m", mine);
  coordinator.bindSocket("actor-n", stranger);

  const pending = coordinator.requestLocation("actor-m", "test");
  const jobId = mine.lastLocationRequestJobId();
  // 外人拿别人的 jobId 回包 → 必须被拒
  const accepted = coordinator.completeFromSocket(stranger, "actor-n", {
    jobId,
    latitude: 1,
    longitude: 2,
  });
  assert.equal(accepted, false);
});

// ─── 精确定位（2026-11-14）：定位源优选 + 旧缓存/粗 fix 绕过 ─────────────

test("定位源优选：手机端在线时只问手机，不同时打扰桌面端", async () => {
  const coordinator = new LocationCoordinator({ requestTimeoutMs: 200 });
  const mobile = new FakeSocket();
  const desktop = new FakeSocket();
  coordinator.bindSocket("actor-p", mobile, "mobile");
  coordinator.bindSocket("actor-p", desktop, "desktop");

  const pending = coordinator.requestLocation("actor-p", "clock.get_user_location");
  assert.ok(mobile.lastLocationRequestJobId(), "应优先请求手机端 GPS");
  assert.equal(desktop.lastLocationRequestJobId(), "", "有手机端时不再问桌面端（PC 定位常是网络推断）");

  coordinator.completeFromSocket(mobile, "actor-p", {
    jobId: mobile.lastLocationRequestJobId(),
    ...COORDS,
    accuracyMeters: 8,
  });
  assert.equal((await pending)?.accuracyMeters, 8);
});

test("精度要求：缓存来自桌面端且手机在线时，绕过缓存改问手机 GPS", async () => {
  const coordinator = new LocationCoordinator({ requestTimeoutMs: 200 });
  const mobile = new FakeSocket();
  const desktop = new FakeSocket();
  coordinator.bindSocket("actor-r", mobile, "mobile");
  coordinator.bindSocket("actor-r", desktop, "desktop");

  // 桌面端主动上报写缓存（PC 定位常来自 WiFi 推断，精度 20m 看着不错也不如手机）
  coordinator.completeFromSocket(desktop, "actor-r", { ...COORDS, accuracyMeters: 20 });
  assert.equal((await coordinator.requestLocation("actor-r", "weather"))?.accuracyMeters, 20);

  const sentBefore = mobile.sent.length;
  const pending = coordinator.requestLocation("actor-r", "clock.get_user_location", {
    maxAgeMs: 60_000,
    maxAccuracyMeters: 50,
  });
  assert.equal(mobile.sent.length, sentBefore + 1, "精度敏感场景不复用桌面端来源的 fix");
  coordinator.completeFromSocket(mobile, "actor-r", {
    jobId: mobile.lastLocationRequestJobId(),
    ...COORDS,
    accuracyMeters: 6,
  });
  assert.equal((await pending)?.accuracyMeters, 6);
});

test("精度要求：缓存 fix 精度不达标时绕过缓存，现场重新拉 GPS", async () => {
  const coordinator = new LocationCoordinator({ requestTimeoutMs: 200 });
  const socket = new FakeSocket();
  coordinator.bindSocket("actor-q", socket);

  // 先灌入一条 ±500m 的粗 fix（模拟后台常驻定位/PC 网络推断）
  const first = coordinator.requestLocation("actor-q", "report");
  coordinator.completeFromSocket(socket, "actor-q", {
    jobId: socket.lastLocationRequestJobId(),
    ...COORDS,
    accuracyMeters: 500,
  });
  await first;

  // 普通场景（天气）复用缓存：不新增请求
  const cached = await coordinator.requestLocation("actor-q", "weather");
  assert.equal(cached?.accuracyMeters, 500, "无精度要求时沿用缓存");

  // 问「我在哪」：500m 的 fix 不可接受 → 必须重新下发定位请求
  const sentBefore = socket.sent.length;
  const pending = coordinator.requestLocation("actor-q", "clock.get_user_location", {
    maxAgeMs: 60_000,
    maxAccuracyMeters: 50,
  });
  assert.equal(socket.sent.length, sentBefore + 1, "精度不达标应重新请求客户端");
  coordinator.completeFromSocket(socket, "actor-q", {
    jobId: socket.lastLocationRequestJobId(),
    ...COORDS,
    accuracyMeters: 9,
  });
  assert.equal((await pending)?.accuracyMeters, 9);
});
