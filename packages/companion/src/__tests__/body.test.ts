import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { BASE_TUNING, type Directive, type IntentKind } from "../protocol/directive.ts";
import { DG2_STANDING_CAPABILITY, LED_BAR_CAPABILITY, DOM_EMBED_CAPABILITY } from "../protocol/capability.ts";
import { restY } from "../protocol/world.ts";
import { PoseSchema, type Pose } from "../protocol/pose.ts";
import { AffectStateSchema, INITIAL_AFFECT } from "../protocol/affect.ts";
import { createEngine, FIXED_DT } from "../body/index.ts";
import { tuningFromAffect } from "../mind/emotion-physics.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

function directive(over: Partial<Directive> = {}): Directive {
  return {
    version: 1,
    intent: "jump",
    intensity: 0.8,
    valence: 0.3,
    arousal: 0.6,
    attend: "user",
    holdMs: 600,
    cause: { kind: "drive", id: "arousal>threshold", driveKey: "arousal", driveLevel: 0.7 },
    tuning: { ...BASE_TUNING },
    issuedAtMs: 0,
    ...over,
  };
}

function simulate(
  cap: typeof DG2_STANDING_CAPABILITY,
  script: Array<{ atMs: number; d: Directive }>,
  untilMs: number,
  frameMs: number,
): Pose[] {
  const engine = createEngine(cap);
  const out: Pose[] = engine.advance(0);
  let t = 0;
  let n = 0;
  while (t < untilMs) {
    while (n < script.length && script[n].atMs <= t) {
      engine.applyDirective(script[n].d);
      n += 1;
    }
    out.push(...engine.advance(frameMs));
    t += frameMs;
  }
  return out;
}

const hash = (poses: Pose[]): string => {
  let h = 2166136261;
  const s = JSON.stringify(poses.map((p) => [p.tMs, p.pos.x, p.pos.y, p.pos.z, p.deform, p.glow]));
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
};

test("零预制动画：解算层没有任何媒体资产引用", () => {
  const dirs = ["body", "protocol", "mind"];
  const offenders: string[] = [];
  for (const dir of dirs) {
    for (const f of readdirSync(join(HERE, "..", dir)).filter((x) => x.endsWith(".ts"))) {
      const src = readFileSync(join(HERE, "..", dir, f), "utf8");
      if (/\.(glb|gltf|fbx|mp4|webm|png|jpg|webp|svg)\b/.test(src)) offenders.push(`${dir}/${f}:资产`);
      if (/AnimationClip|SkinnedMesh|morphTarget|spriteSheet|\.play\(/.test(src)) offenders.push(`${dir}/${f}:动画系统`);
    }
  }
  assert.deepEqual(offenders, []);
});

test("确定性：同样的输入序列必须逐帧复现同一条轨迹", () => {
  const script = [{ atMs: 0, d: directive() }];
  const a = simulate(DG2_STANDING_CAPABILITY, script, 3000, 16.7);
  const b = simulate(DG2_STANDING_CAPABILITY, script, 3000, 16.7);
  assert.equal(hash(a), hash(b));
  assert.ok(a.length > 200);
});

test("帧率无关：30/60/144Hz 下轨迹终点收敛", () => {
  const script = [{ atMs: 0, d: directive() }];
  const ends = [33.4, 16.7, 6.94].map((f) => {
    const p = simulate(DG2_STANDING_CAPABILITY, script, 4000, f);
    return p[p.length - 1];
  });
  for (const e of ends) assert.ok(e.pos.y > restY(DG2_STANDING_CAPABILITY.world) - 0.35, "应回到锚点附近");
  const spread = Math.max(...ends.map((e) => e.pos.y)) - Math.min(...ends.map((e) => e.pos.y));
  assert.ok(spread < 0.08, `不同帧率终点差 ${spread.toFixed(4)} 过大`);
});

test("判据②：任意相邻帧位移有界，不存在瞬移", () => {
  const script = [
    { atMs: 0, d: directive({ intent: "retreat", intensity: 1 }) },
    { atMs: 900, d: directive({ intent: "cower", intensity: 1 }) },
    { atMs: 1800, d: directive({ intent: "jump", intensity: 1 }) },
  ];
  const poses = simulate(DG2_STANDING_CAPABILITY, script, 4000, 16.7);
  let maxStep = 0;
  for (let i = 1; i < poses.length; i++) {
    const d = Math.hypot(
      poses[i].pos.x - poses[i - 1].pos.x,
      poses[i].pos.y - poses[i - 1].pos.y,
      poses[i].pos.z - poses[i - 1].pos.z,
    );
    maxStep = Math.max(maxStep, d);
  }
  assert.ok(maxStep < 0.12, `单帧位移 ${maxStep.toFixed(4)} 说明有瞬移`);
});

test("跳跃不是播放出来的：起跳→腾空→接触→挤压→回弹，且回弹逐次衰减", () => {
  const engine = createEngine(DG2_STANDING_CAPABILITY);
  engine.applyDirective(directive({ intensity: 0.9 }));
  const poses: Pose[] = [];
  for (let t = 0; t < 3000; t += 16.7) poses.push(...engine.advance(16.7));

  assert.ok(poses.some((p) => p.airborne), "应进入腾空段");
  assert.ok(engine.stats().contacts >= 1, "应发生接触");

  const apex = Math.max(...poses.map((p) => p.pos.y));
  assert.ok(apex > restY(DG2_STANDING_CAPABILITY.world) + 0.5, `腾空高度仅 ${(apex - 1.4).toFixed(2)}`);

  const squash = Math.max(...poses.map((p) => p.deform));
  assert.ok(squash > 0.08, "接触应触发可见挤压");

  const afterFirstContact = poses.slice(poses.findIndex((p) => p.airborne === false && p.tMs > 300));
  const bounces = peaks(afterFirstContact.map((p) => p.pos.y));
  if (bounces.length >= 2) {
    for (let i = 1; i < bounces.length; i++) assert.ok(bounces[i] <= bounces[i - 1] + 1e-6, "回弹不该越弹越高");
  }
});

function peaks(series: number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < series.length - 1; i++) {
    if (series[i] > series[i - 1] && series[i] >= series[i + 1] && series[i] > 1.45) out.push(series[i]);
  }
  return out;
}

test("判据⑤：同一条 jump 配方，被凶过的身体跳得不一样", () => {
  const calm = tuningFromAffect(structuredClone(INITIAL_AFFECT));
  const scared = tuningFromAffect(
    { ...structuredClone(INITIAL_AFFECT), drives: { curiosity: 0.3, caution: 0.88, sociability: 0.2 }, arousal: 0.5, energy: 0.6 },
  );
  const apexOf = (tuning: typeof calm): number => {
    const engine = createEngine(DG2_STANDING_CAPABILITY);
    engine.applyDirective(directive({ intensity: 0.85, tuning: { ...tuning } }));
    let max = -Infinity;
    for (let t = 0; t < 3000; t += 16.7) for (const p of engine.advance(16.7)) max = Math.max(max, p.pos.y);
    return max;
  };
  const a = apexOf(calm);
  const b = apexOf(scared);
  assert.ok(b < a, `受惊后 apex ${b.toFixed(3)} 应低于常态 ${a.toFixed(3)}`);
  assert.notEqual(a, b, "同一 intent 必须因身体常数不同而不同");
});

test("体积守恒：整条轨迹上行列式恒为 1", () => {
  const poses = simulate(DG2_STANDING_CAPABILITY, [{ atMs: 0, d: directive({ intensity: 1 }) }], 3000, 16.7);
  for (const p of poses) {
    assert.ok(Math.abs(p.scale.x * p.scale.y * p.scale.z - 1) < 1e-9, `t=${p.tMs} 体积不守恒`);
  }
});

test("窄带宽壳：只声明 glow 的壳不会收到位移，且不报错", () => {
  const engine = createEngine(LED_BAR_CAPABILITY);
  engine.applyDirective(directive({ intensity: 1 }));
  const poses: Pose[] = [];
  for (let t = 0; t < 2000; t += 33) poses.push(...engine.advance(33));
  for (const p of poses) {
    assert.equal(p.pos.x, 0);
    assert.equal(p.pos.y, 0);
  }
  assert.ok(engine.stats().dropped > 0, "不支持的通道应被裁掉并计数");
  assert.ok(poses.some((p) => p.glow !== 0.35), "glow 通道应当仍然工作");
});

test("无脸壳解算不了锚点时，动作照做、朝向收敛", () => {
  const engine = createEngine(DOM_EMBED_CAPABILITY);
  engine.applyDirective(directive({ intent: "peek", attend: "clock", intensity: 0.8 }));
  for (let t = 0; t < 2000; t += 16.7) engine.advance(16.7);
  const p = engine.pose();
  assert.ok(Number.isFinite(p.rot.y));
  assert.ok(Math.abs(p.rot.y) < 0.6);
});

test("脏输入不产生 NaN：负 dt、超大 dt、非有限值", () => {
  const engine = createEngine(DG2_STANDING_CAPABILITY);
  engine.applyDirective(directive());
  engine.advance(Number.NaN);
  engine.advance(-100);
  engine.advance(50_000);
  engine.applyDirective(directive({ intensity: Number.NaN as unknown as number }));
  const poses = engine.advance(16.7);
  for (const p of poses) {
    assert.doesNotThrow(() => PoseSchema.parse(p), `t=${p.tMs} 非法 pose`);
  }
});

test("静止不等于死：没有 directive 时仍有呼吸与微噪，但幅度极小", () => {
  const engine = createEngine(DG2_STANDING_CAPABILITY);
  const poses: Pose[] = [];
  for (let t = 0; t < 6000; t += 16.7) poses.push(...engine.advance(16.7));
  const span = Math.max(...poses.map((p) => p.deform)) - Math.min(...poses.map((p) => p.deform));
  assert.ok(span > 1e-4, "完全静止说明反身层没跑");
  assert.ok(span < 0.08, `静置形变幅度 ${span.toFixed(3)} 过大`);
  assert.ok(Math.max(...poses.map((p) => Math.abs(p.pos.y - restY(DG2_STANDING_CAPABILITY.world)))) < 0.05);
});

test("FIXED_DT 是解算层的唯一时间单位，引擎不信任外部 dt", () => {
  assert.ok(Math.abs(FIXED_DT - 1 / 120) < 1e-9);
  const engine = createEngine(DG2_STANDING_CAPABILITY);
  engine.applyDirective(directive({ intent: "doze", intensity: 0.5, holdMs: 4000 }));
  const one = engine.advance(1000).length;
  assert.ok(Math.abs(one - 120) <= 1, `1 秒应产出约 120 帧，实得 ${one}`);
});

test("12 条 intent 全部可解算且收敛回锚点", () => {
  const intents = ["jump", "retreat", "lean_in", "cower", "bounce_gait", "sink", "peek", "nudge", "doze", "perk", "sulk", "tremor"] as IntentKind[];
  for (const intent of intents) {
    const engine = createEngine(DG2_STANDING_CAPABILITY);
    engine.applyDirective(directive({ intent, intensity: 0.7 }));
    let last: Pose | null = null;
    for (let t = 0; t < 9000; t += 16.7) for (const p of engine.advance(16.7)) last = p;
    assert.ok(last, `${intent} 没有产出 pose`);
    assert.ok(Number.isFinite(last.pos.x + last.pos.y + last.pos.z + last.deform), `${intent} 发散`);
    assert.ok(Math.hypot(last.pos.x, last.pos.y - restY(DG2_STANDING_CAPABILITY.world), last.pos.z) < 0.35, `${intent} 未收敛`);
  }
});
