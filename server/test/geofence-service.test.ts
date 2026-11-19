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
import { haversineMeters } from "../src/services/geo-utils.js";
import { wgs84ToGcj02 } from "../src/services/reverse-geocode-service.js";
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
  // observe：只观察进出、不执行动作，不需要任何 actionConfig
  assert.equal(
    validateGeofenceInput(validInput({ actionType: "observe", actionConfig: {} })),
    null,
  );
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
    // 2026-11-18：create 必须声明坐标系（否则坐标可能整体偏移 50~500m）
    const missingDatum = (await registry.execute(
      "geofence",
      { ...validInput(), action: "create" },
      ctx,
    )) as { result: { ok: boolean; error: string } };
    assert.equal(missingDatum.result.ok, false);
    assert.match(String(missingDatum.result.error), /coordSystem/);

    const createdRes = (await registry.execute(
      "geofence",
      { ...validInput(), action: "create", coordSystem: "wgs84" },
      ctx,
    )) as {
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

// ─── 2026-11-13 精度裁决 ────────────────────────────────────────────────
// 室内 WiFi fix 常有 100~500m 精度半径，若照单全收会把人判到隔壁街区，
// 进而误报「到家/到公司」。精度差到连围栏边界都定不了时（accuracy > 半径），
// 本次判定不可信：推进基线但不产生事件，等下一个高精度 fix 纠正。
test("精度裁决：accuracy > 半径时不产生围栏事件（低精度 fix 不误触发）", async () => {
  await withGeofence(async ({ svc, events, setNow }) => {
    svc.create("u1", validInput({ event: "both", radiusMeters: 200 }));
    // 基线：栏外，精度良好
    svc.processLocationReport("u1", FAR_HOME);
    assert.equal(events.length, 0);

    // 进入栏内，但 fix 精度 500m（> 半径 200m）：边界定不了 → 不应触发 enter
    setNow("2026-09-04T10:06:00Z");
    const imprecise = svc.processLocationReport("u1", {
      ...NEAR_HOME,
      accuracyMeters: 500,
    });
    assert.equal(imprecise.length, 0, "精度不足时不得误报 enter");
    assert.equal(events.length, 0);

    // 同一位置，高精度 fix（10m）→ 正常触发 enter
    setNow("2026-09-04T10:12:00Z");
    const precise = svc.processLocationReport("u1", {
      ...NEAR_HOME,
      accuracyMeters: 10,
    });
    assert.equal(precise.length, 1, "高精度 fix 应正常触发");
    assert.equal(precise[0].kind, "enter");
    assert.equal(events.length, 1);
  });
});

test("精度裁决：accuracy 缺失（未提供）时按老行为判定，不阻塞主链路", async () => {
  await withGeofence(async ({ svc, events }) => {
    svc.create("u1", validInput({ event: "both" }));
    svc.processLocationReport("u1", FAR_HOME);
    const entered = svc.processLocationReport("u1", NEAR_HOME); // 无 accuracy 字段
    assert.equal(entered.length, 1, "精度未知时不应阻塞判定");
    assert.equal(events.length, 1);
  });
});

test("精度裁决：accuracy <= 半径时正常触发（边界内的高精度 fix）", async () => {
  await withGeofence(async ({ svc, events }) => {
    svc.create("u1", validInput({ event: "both", radiusMeters: 200 }));
    svc.processLocationReport("u1", FAR_HOME);
    const entered = svc.processLocationReport("u1", { ...NEAR_HOME, accuracyMeters: 150 });
    assert.equal(entered.length, 1);
    assert.equal(events.length, 1);
  });
});

// ─── 2026-11-18 坐标系归一 ──────────────────────────────────────────────
test("坐标系归一：coordSystem=gcj02 的入参在落库前转成 WGS-84", async () => {
  await withGeofence(async ({ svc }) => {
    // 高德 POI 的 GCJ-02 坐标（兴义附近）
    const gcj = { latitude: 25.062506, longitude: 104.892552 };
    const created = svc.create(
      "u1",
      validInput({ ...gcj, coordSystem: "gcj02" }),
    );
    assert.ok(!("error" in created), "合法 gcj02 入参不应被拒");
    if ("error" in created) throw new Error(created.error);

    const stored = { latitude: created.latitude, longitude: created.longitude };
    // 与输入存在坐标系固有偏移（国内 50~500m）
    assert.ok(haversineMeters(stored, gcj) > 50, "应发生坐标转换而不是原样落库");
    // 转回 GCJ 应与原输入重合（<1m）：证明存的确实是同一地点的 WGS-84
    const back = wgs84ToGcj02(stored.latitude, stored.longitude);
    assert.ok(haversineMeters(back, gcj) < 1, "逆向转换应回到原 POI 坐标");
  });
});

test("坐标系归一：coordSystem 非法时校验拒绝", async () => {
  await withGeofence(async ({ svc }) => {
    const bad = svc.create("u1", validInput({ coordSystem: "bd09" }));
    assert.ok("error" in bad);
    assert.match(String(bad.error), /coordSystem/);
  });
});

// ─── 2026-11-18 客户端注册回执 ──────────────────────────────────────────
test("客户端回执：recordClientSync 只保留最新一条，getClientSync 可读", async () => {
  await withGeofence(async ({ svc }) => {
    assert.equal(svc.getClientSync("u1"), null);

    svc.recordClientSync("u1", {
      ok: false,
      requested: 1,
      registered: 0,
      failures: [{ fenceId: "gf_1", reason: "missing_location_permission" }],
      permission: { fine: false, background: false },
    });
    svc.recordClientSync("u1", {
      ok: true,
      requested: 1,
      registered: 1,
      permission: { fine: true, background: true },
    });

    const status = svc.getClientSync("u1");
    assert.ok(status);
    assert.equal(status?.ok, true);
    assert.equal(status?.registered, 1);
    // 后写入覆盖前一条（只留最新状态）
    assert.equal(status?.report.ok, true);
    assert.equal("failures" in (status?.report ?? {}), false);
  });
});
