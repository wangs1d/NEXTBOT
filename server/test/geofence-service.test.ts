/**
 * 位置方案 C 单测：geofence-service（地理围栏引擎）。
 *
 * 覆盖：
 *   1. CRUD + 输入校验（经纬度/半径/事件方向/动作参数口径）
 *   2. enter/leave 检测：Haversine 判定、event 方向过滤（enter-only 不报 leave）
 *   3. 首报建基线不触发（用户创建围栏时人已在栏内不应立刻触发）
 *   4. 同方向防抖冷却（边界抖动不刷事件）
 *   5. 状态持久化：重开库后 inside/outside 基线仍在，不重复触发
 *   6. geofence.* 工具（ToolRegistry round trip：create/list/delete）
 *
 * 测试封闭：临时 SQLite、注入时钟，无外部依赖。
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  GeofenceService,
  isPublicHttpUrl,
  validateGeofenceInput,
  type GeofenceTriggeredEvent,
} from "../src/services/geofence-service.js";
import { GEOFENCE_CHAT_TOOLS, registerGeofenceTools } from "../src/tools/geofence-tools.js";
import { ToolRegistry } from "../src/tools/tool-registry.js";

const BASE_AT = Date.parse("2026-09-04T10:00:00Z");
const HOME = { latitude: 39.9000, longitude: 116.4000 };
const NEAR_HOME = { latitude: 39.9005, longitude: 116.4000 }; // ≈ 55m，栏内
const FAR_HOME = { latitude: 39.9100, longitude: 116.4000 }; // ≈ 1.1km，栏外

function validInput(overrides?: Record<string, unknown>) {
  return {
    name: "家",
    latitude: HOME.latitude,
    longitude: HOME.longitude,
    radiusMeters: 200,
    event: "both",
    actionType: "reminder",
    actionConfig: { title: "到家了" },
    ...overrides,
  };
}

interface Ctx {
  svc: GeofenceService;
  events: GeofenceTriggeredEvent[];
  setNow: (iso: string) => void;
  dir: string;
  dbPath: string;
}

async function withGeofence(
  fn: (ctx: Ctx) => Promise<void>,
  opts?: { minTriggerGapMs?: number },
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "geofence-"));
  const dbPath = join(dir, "geofence.db");
  let nowMs = BASE_AT;
  const svc = new GeofenceService({
    dbPath,
    now: () => new Date(nowMs),
    ...(opts?.minTriggerGapMs !== undefined ? { minTriggerGapMs: opts.minTriggerGapMs } : {}),
  });
  const events: GeofenceTriggeredEvent[] = [];
  svc.setNotifier((e) => {
    events.push(e);
  });
  const setNow = (iso: string) => {
    nowMs = Date.parse(iso);
  };
  try {
    await fn({ svc, events, setNow, dir, dbPath });
  } finally {
    svc.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test("校验：非法输入被拒绝（口径与工具层共用）", () => {
  assert.ok(validateGeofenceInput(validInput()) === null);
  assert.match(String(validateGeofenceInput(validInput({ name: "" }))), /名称/);
  assert.match(String(validateGeofenceInput(validInput({ latitude: 120 }))), /纬度/);
  assert.match(String(validateGeofenceInput(validInput({ longitude: 250 }))), /经度/);
  assert.match(String(validateGeofenceInput(validInput({ radiusMeters: 5 }))), /radiusMeters/);
  assert.match(String(validateGeofenceInput(validInput({ event: "cross" }))), /event/);
  assert.match(String(validateGeofenceInput(validInput({ actionType: "sms" }))), /actionType/);
  // 各动作参数口径
  assert.match(
    String(validateGeofenceInput(validInput({ actionType: "reminder", actionConfig: {} }))),
    /title/,
  );
  assert.match(
    String(validateGeofenceInput(validInput({ actionType: "agent_task", actionConfig: {} }))),
    /goal/,
  );
  assert.match(
    String(validateGeofenceInput(validInput({ actionType: "webhook", actionConfig: { url: "ftp://x" } }))),
    /url/,
  );
});

test("isPublicHttpUrl：内网/环回/链路本地地址被拒绝，公网地址放行", () => {
  // 拒绝：环回 / 私网 / 云元数据 / IPv6 本地 / 伪协议
  for (const url of [
    "http://127.0.0.1:8080/hook",
    "http://localhost/hook",
    "http://10.1.2.3/hook",
    "http://172.16.0.9/hook",
    "http://172.31.255.1/hook",
    "http://192.168.1.5/hook",
    "http://169.254.169.254/latest/meta-data/",
    "http://0.0.0.0/hook",
    "http://100.64.0.1/hook",
    "http://[::1]/hook",
    "http://[::ffff:127.0.0.1]/hook",
    "http://[fd00::1]/hook",
    "http://[fe80::1]/hook",
    "http://my-service.internal/hook",
    "http://box.local/hook",
    "ftp://example.com/hook",
    "not a url",
  ]) {
    assert.equal(isPublicHttpUrl(url), false, `应拒绝: ${url}`);
  }
  // 放行：公网 http/https、全局 IPv6
  for (const url of [
    "https://example.com/hook",
    "http://example.com/hook",
    "https://hooks.example.com/x/y?z=1",
    "http://8.8.8.8/hook",
    "http://[2606:4c00::a]/hook",
  ]) {
    assert.equal(isPublicHttpUrl(url), true, `应放行: ${url}`);
  }
  // 校验口径已并入 validateGeofenceInput
  assert.match(
    String(
      validateGeofenceInput(
        validInput({ actionType: "webhook", actionConfig: { url: "http://192.168.1.5/hook" } }),
      ),
    ),
    /url/,
  );
  assert.equal(
    validateGeofenceInput(
      validInput({ actionType: "webhook", actionConfig: { url: "https://example.com/hook" } }),
    ),
    null,
  );
});

test("enter/leave 检测：首报建基线 → leave 静默 → enter 触发（both 围栏）", async () => {
  await withGeofence(async ({ svc, events, setNow }) => {
    const created = svc.create("u1", validInput());
    assert.ok(!("error" in created));

    // 首报（栏外）：只建基线，不触发
    assert.equal(svc.processLocationReport("u1", FAR_HOME).length, 0);
    assert.equal(events.length, 0);

    // 进入栏内：enter 事件
    setNow("2026-09-04T10:06:00Z");
    const entered = svc.processLocationReport("u1", NEAR_HOME);
    assert.equal(entered.length, 1);
    assert.equal(entered[0].kind, "enter");
    assert.ok(entered[0].distanceMeters <= 200);
    assert.equal(events.length, 1);

    // 栏内徘徊：无新事件
    setNow("2026-09-04T10:12:00Z");
    assert.equal(svc.processLocationReport("u1", HOME).length, 0);

    // 离开：leave 事件（与 enter 间隔已过默认 5min 冷却）
    setNow("2026-09-04T10:20:00Z");
    const left = svc.processLocationReport("u1", FAR_HOME);
    assert.equal(left.length, 1);
    assert.equal(left[0].kind, "leave");
    assert.equal(events.length, 2);
  });
});

test("event 方向过滤：enter-only 围栏不报 leave", async () => {
  await withGeofence(async ({ svc, events }) => {
    svc.create("u1", validInput({ event: "enter" }));
    svc.processLocationReport("u1", FAR_HOME); // 基线：栏外
    svc.processLocationReport("u1", NEAR_HOME); // enter ✓
    svc.processLocationReport("u1", FAR_HOME); // leave 被 event=enter 过滤
    assert.equal(events.length, 1);
    assert.equal(events[0].kind, "enter");
  });
});

test("防抖：冷却期内 enter/leave 快速交替只触发一次（边界抖动）", async () => {
  await withGeofence(
    async ({ svc, events, setNow }) => {
      svc.create("u1", validInput({ event: "both" }));
      svc.processLocationReport("u1", FAR_HOME); // 基线：栏外
      svc.processLocationReport("u1", NEAR_HOME); // enter（10:00）✓ 触发
      // 10:02 快速离开又 10:04 回来（冷却 10min 内）：换向推进基线但不刷事件
      setNow("2026-09-04T10:02:00Z");
      const leave1 = svc.processLocationReport("u1", FAR_HOME);
      assert.equal(leave1.length, 0, "冷却期内的 leave 被抑制");
      setNow("2026-09-04T10:04:00Z");
      const enter2 = svc.processLocationReport("u1", NEAR_HOME);
      assert.equal(enter2.length, 0, "冷却期内的 enter 被抑制");
      assert.equal(events.length, 1, "只有 10:00 的 enter 一次");

      // 10:15 离开：距上次触发 15min > 10min，正常触发
      setNow("2026-09-04T10:15:00Z");
      const left = svc.processLocationReport("u1", FAR_HOME);
      assert.equal(left.length, 1);
      assert.equal(left[0].kind, "leave");
      assert.equal(events.length, 2);
    },
    { minTriggerGapMs: 10 * 60_000 },
  );
});

test("状态持久化：重开库后基线仍在，enter 不重复触发", async () => {
  await withGeofence(async ({ svc, events, dbPath, setNow }) => {
    svc.create("u1", validInput());
    svc.processLocationReport("u1", NEAR_HOME); // 基线：栏内（无事件）
    assert.equal(events.length, 0);

    // 模拟重启：同一路径重开第二个连接，栏内基线应从库里恢复
    const revived = new GeofenceService({ dbPath, now: () => new Date(Date.parse("2026-09-04T11:00:00Z")) });
    const events2: GeofenceTriggeredEvent[] = [];
    revived.setNotifier((e) => events2.push(e));
    assert.equal(revived.processLocationReport("u1", HOME).length, 0, "重启后仍在栏内，不触发 enter");

    setNow("2026-09-04T12:00:00Z");
    const left = revived.processLocationReport("u1", FAR_HOME);
    assert.equal(left.length, 1, "重启后离开仍能触发 leave");
    assert.equal(left[0].kind, "leave");
    revived.close();
  });
});

test("enabled=false 的围栏不参与判定；delete 后状态清理", async () => {
  await withGeofence(async ({ svc, events }) => {
    const created = svc.create("u1", validInput());
    assert.ok(!("error" in created));
    const fenceId = (created as { id: string }).id;

    svc.setEnabled("u1", fenceId, false);
    svc.processLocationReport("u1", FAR_HOME);
    svc.processLocationReport("u1", NEAR_HOME);
    assert.equal(events.length, 0, "禁用围栏不触发");

    svc.setEnabled("u1", fenceId, true);
    svc.processLocationReport("u1", FAR_HOME); // 基线已在栏内（禁用期间仍记录？——禁用不判定，状态未更新）
    // 删除
    assert.equal(svc.delete("u1", fenceId), true);
    assert.equal(svc.delete("u1", fenceId), false);
    assert.equal(svc.list("u1").length, 0);
  });
});

test("geofence.* 工具：create/list/delete round trip", async () => {
  await withGeofence(async ({ svc, dbPath }) => {
    void dbPath;
    const registry = new ToolRegistry();
    registerGeofenceTools(registry, { service: svc });
    // 工具 schema 并入 LLM 清单的形态校验
    assert.deepEqual(
      GEOFENCE_CHAT_TOOLS.map((t) => t.function.name),
      ["geofence"],
    );

    const ctx = { sessionId: "u1", userId: "u1" };
    const createdRes = (await registry.execute("geofence", { ...validInput(), action: "create" }, ctx)) as {
      ok: boolean;
      result: { ok: boolean; geofence: { id: string; name: string } };
    };
    assert.equal(createdRes.ok, true);
    assert.equal(createdRes.result.ok, true);
    assert.equal(createdRes.result.geofence.name, "家");

    const bad = (await registry.execute("geofence", { ...validInput({ latitude: 999 }), action: "create" }, ctx)) as {
      ok: boolean;
      result: { ok: boolean; error: string };
    };
    assert.equal(bad.ok, true);
    assert.equal(bad.result.ok, false);

    const listed = (await registry.execute("geofence", { action: "list" }, ctx)) as {
      result: { count: number };
    };
    assert.equal(listed.result.count, 1);

    const removed = (await registry.execute(
      "geofence",
      { action: "delete", id: createdRes.result.geofence.id },
      ctx,
    )) as { result: { ok: boolean } };
    assert.equal(removed.result.ok, true);
  });
});
