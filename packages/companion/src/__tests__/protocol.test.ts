import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import {
  AffectStateSchema,
  BASE_TUNING,
  CapabilityDescriptorSchema,
  DirectiveSchema,
  DG2_OVERLAY_CAPABILITY,
  DOM_EMBED_CAPABILITY,
  LED_BAR_CAPABILITY,
  MIND_FACING_SCHEMAS,
  PoseSchema,
  collectKeys,
  findPixelLeak,
  volumePreservingScale,
  volumeOf,
  INTENT_KINDS,
  canResolve,
  supports,
} from "../protocol/index.ts";
import {
  pixelsPerUnit,
  wallAt,
  windowEdges,
  WorldDescriptorSchema,
} from "../protocol/world.ts";

test("契约层不出现任何屏幕坐标字段", () => {
  assert.deepEqual(findPixelLeak(MIND_FACING_SCHEMAS), []);
});

test("心智状态被 zod 钳制在闭区间内", () => {
  const base = structuredClone(AffectStateSchema.parse({
    version: 1,
    drives: { curiosity: 0.5, caution: 0.5, sociability: 0.5 },
    energy: 0.5,
    valence: 0,
    arousal: 0.5,
    dominance: 0.5,
    attention: { target: "user", strength: 0.5 },
    lastAversiveAtMs: 0,
    lastPleasantAtMs: 0,
    clockMs: 0,
  }));
  assert.throws(() => AffectStateSchema.parse({ ...base, energy: 1.4 }));
  assert.throws(() => AffectStateSchema.parse({ ...base, valence: -2 }));
  assert.throws(() => AffectStateSchema.parse({ ...base, drives: { ...base.drives, curiosity: -0.1 } }));
});

test("Directive 缺 cause 直接不合法（判据①由类型系统兜住）", () => {
  const ok = {
    version: 1 as const,
    intent: "jump" as const,
    intensity: 0.6,
    valence: 0.2,
    arousal: 0.5,
    attend: "user",
    holdMs: 500,
    tuning: BASE_TUNING,
    issuedAtMs: 1000,
  };
  assert.throws(() => DirectiveSchema.parse(ok));
  assert.doesNotThrow(() =>
    DirectiveSchema.parse({
      ...ok,
      cause: { kind: "drive", id: "curiosity>threshold", driveKey: "curiosity", driveLevel: 0.7 },
    }),
  );
});

test("12 条 intent 全部有配方，且没有一条指向动画资产", () => {
  assert.equal(INTENT_KINDS.length, 12);
  for (const k of INTENT_KINDS) assert.match(k, /^[a-z_]+$/);
});

test("世界的边界由相机反解，不是手填的数字", () => {
  const w = DG2_OVERLAY_CAPABILITY.world;
  const e = windowEdges(w.view);
  assert.ok(Math.abs(wallAt(w, "x", 1)! - e.rightX) < 1e-9, "右墙应等于视口右边");
  assert.ok(Math.abs(wallAt(w, "y", 1)! - e.topY) < 1e-9, "天花板应等于视口顶边");
  assert.ok(w.floor === null, "现场桌宠没有地面：重力 0，落地接触本就不该发生");
  // 现场 248×309 窗口 + fov34 + 相机 z=4.15 → 1 场景单位 ≈ 121.8 CSS 像素
  assert.ok(Math.abs(pixelsPerUnit(w.view) - 121.77) < 0.5, `实得 ${pixelsPerUnit(w.view).toFixed(2)}`);
});

test("像素只活在壳侧的 world.view 里，心智可读的契约一格都没有", () => {
  assert.deepEqual(findPixelLeak(MIND_FACING_SCHEMAS), []);
  const keys = collectKeys(WorldDescriptorSchema);
  const pxPaths = keys.filter((k) => /viewportPx|(^|\.)dpr($|\.)/.test(k));
  assert.ok(pxPaths.length > 0, "世界必须自带像素标尺，否则接线无从验证");
  for (const k of pxPaths) assert.ok(k.startsWith("view."), `像素字段 ${k} 跑到了 view 之外`);
});

test("负对照：扫描器真能抓到泄漏，不是永远返回空的假测试", () => {
  const dirty = { LeakSchema: z.object({ intent: z.string(), screenX: z.number(), nested: z.object({ dpi: z.number() }) }) };
  const leaks = findPixelLeak(dirty);
  assert.deepEqual(leaks.sort(), ["LeakSchema.nested.dpi", "LeakSchema.screenX"]);
});

test("体积守恒形变：任意 deform 下行列式恒为 1", () => {
  for (const d of [-0.7, -0.3, 0, 0.12, 0.5, 0.74]) {
    assert.ok(Math.abs(volumeOf(volumePreservingScale(d)) - 1) < 1e-9, `deform ${d}`);
  }
  assert.ok(volumePreservingScale(0.5).y < 1);
  assert.ok(volumePreservingScale(0.5).x > 1);
});

test("窄带宽壳只声明 glow，锚点解算能力独立于通道", () => {
  assert.equal(supports(LED_BAR_CAPABILITY, "deform"), false);
  assert.equal(supports(LED_BAR_CAPABILITY, "glow"), true);
  assert.equal(canResolve(LED_BAR_CAPABILITY, "focus"), false);
  assert.equal(canResolve(DOM_EMBED_CAPABILITY, "focus"), true);
  assert.equal(supports(DOM_EMBED_CAPABILITY, "gaze"), false);
});

test("Pose 是解算层唯一输出，且必须有限", () => {
  const pose = {
    tMs: 0,
    pos: { x: 0, y: 1.4, z: 0 },
    vel: { x: 0, y: 0, z: 0 },
    rot: { x: 0, y: 0, z: 0 },
    deform: 0,
    scale: volumePreservingScale(0),
    glow: 0.35,
    gaze: { yaw: 0, pitch: 0 },
    airborne: false,
    driver: "reflex",
  };
  assert.doesNotThrow(() => PoseSchema.parse(pose));
  assert.throws(() => PoseSchema.parse({ ...pose, pos: { x: NaN, y: 0, z: 0 } }));
});
