import test from "node:test";
import assert from "node:assert/strict";
import { INITIAL_AFFECT, type AffectState, type Percept } from "../protocol/affect.ts";
import { BASE_TUNING } from "../protocol/directive.ts";
import { createMind } from "../mind/tick.ts";
import { tuningFromAffect } from "../mind/emotion-physics.ts";
import { ENERGY, INTENT_COST, REFRACTORY_MS } from "../mind/drives.ts";
import { allocateAttention, decayAttention } from "../mind/attention.ts";

const ev = (kind: Percept["kind"], atMs: number, extra: Partial<Percept> = {}): Percept => ({
  kind,
  atMs,
  ...extra,
});

function run(mind: ReturnType<typeof createMind>, fromMs: number, toMs: number, stepMs = 1000): number[] {
  const times: number[] = [];
  for (let t = fromMs; t <= toMs; t += stepMs) {
    for (const d of mind.tick(t)) times.push(d.issuedAtMs);
  }
  return times;
}

function affectWith(patch: Partial<AffectState>): AffectState {
  return structuredClone({ ...INITIAL_AFFECT, ...patch });
}

test("判据①：无事发生就不动——没有输入就没有动作", () => {
  const mind = createMind();
  assert.deepEqual(run(mind, 0, 600_000), []);
  assert.equal(mind.lastDirective(), null);
});

test("判据①：动了就一定有因，cause 可回溯到具体驱力", () => {
  const mind = createMind(affectWith({}));
  mind.perceive(ev("app.focus.new", 1000));
  const out: string[] = [];
  for (let t = 1000; t <= 12_000; t += 1000) for (const d of mind.tick(t)) out.push(`${d.intent}|${d.cause.id}`);
  assert.ok(out.length >= 1, "新窗口出现后应当产生好奇行为");
  for (const line of out) assert.match(line, /curiosity>threshold|attention|drive/);
});

test("判据④：注意力互斥，低显著性事件抢不走", () => {
  const held = { target: "focus", strength: 0.9 };
  const weak = allocateAttention(held, { anchor: "user", salience: 0.3 }, 0.3);
  assert.equal(weak.taken, false);
  assert.equal(weak.attention.target, "focus");

  const strong = allocateAttention(held, { anchor: "user", salience: 0.95 }, 0.9);
  assert.equal(strong.taken, true);
  assert.equal(strong.attention.target, "user");
});

test("判据④：注意力衰减后回到环境，不会永远盯着一个地方", () => {
  let a = { target: "focus", strength: 0.9 } as ReturnType<typeof decayAttention>;
  for (let s = 0; s < 40; s++) a = decayAttention(a, 1);
  assert.equal(a.target, "ambient");
});

test("判据③：动作耗精力，精力压低强度上限——连做会软", () => {
  const fresh = affectWith({ energy: 0.95 });
  const tired = affectWith({ energy: 0.18 });
  assert.ok(tuningFromAffect(tired).intensityCap < tuningFromAffect(fresh).intensityCap);
  assert.ok(tuningFromAffect(tired).maxSpeed < tuningFromAffect(fresh).maxSpeed);
  assert.ok(ENERGY.exhaustion > 0.2);
});

test("判据③：发射一条 directive 精确扣掉对应精力", () => {
  const mind = createMind(
    affectWith({ drives: { curiosity: 0.9, caution: 0.1, sociability: 0.2 }, energy: 0.8, dominance: 1 }),
    7,
  );
  let fired = 0;
  for (let t = 1000; t <= 120_000 && fired < 3; t += 1000) {
    if (t % 8000 === 0) mind.perceive(ev("app.focus.new", t));
    const before = mind.state().energy;
    for (const d of mind.tick(t)) {
      fired += 1;
      const cost = INTENT_COST[d.intent] * d.intensity;
      const after = mind.state().energy;
      const restored = Math.min(1, Math.max(ENERGY.floor, before + ENERGY.restorePerSec));
      assert.ok(after < restored + 1e-9, `${d.intent} 之后精力没有下降`);
      assert.ok(
        Math.abs(restored - cost - after) < 1e-9,
        `${d.intent} 精力账目不平：${restored}-${cost} != ${after}`,
      );
    }
  }
  assert.ok(fired >= 3, `120 秒内只发射了 ${fired} 条`);
});

test("时钟只由 tick 推进：事件不吞掉那一 tick 的衰减", () => {
  const mind = createMind(affectWith({}), 1);
  mind.perceive(ev("app.focus.new", 5000));
  mind.tick(5000);
  const a = mind.state();
  assert.equal(a.clockMs, 5000);
  mind.tick(6000);
  const b = mind.state();
  assert.equal(b.clockMs - a.clockMs, 1000);
});

test("判据⑤：一次斥责之后，身体常数整体变软变黏", () => {
  const calm = tuningFromAffect(affectWith({}));
  const scared = tuningFromAffect(
    affectWith({ drives: { curiosity: 0.3, caution: 0.85, sociability: 0.3 }, arousal: 0.6 }),
  );
  assert.ok(scared.springK < calm.springK, "弹簧该更弱");
  assert.ok(scared.damping > calm.damping, "该更拖泥带水");
  assert.ok(scared.restitution < calm.restitution, "该弹不起来");
  assert.ok(scared.intensityCap < calm.intensityCap, "强度上限该被压住");
  assert.ok(scared.noiseAmp > calm.noiseAmp, "该发抖");
});

test("判据⑤：情绪冲量衰减完，基线残留仍然改变身体", () => {
  const calmAffect = affectWith({});
  const calm = tuningFromAffect(calmAffect);

  const mind = createMind(affectWith({}), 11);
  mind.perceive(ev("user.scold", 1000));
  for (let t = 1000; t <= 4000; t += 1000) mind.tick(t);
  const rightAfter = tuningFromAffect(mind.state());

  // 推进 60 秒：caution 的冲量早已衰减完，只剩 aversive 基线残留
  for (let t = 5000; t <= 61_000; t += 1000) mind.tick(t);
  const laterAffect = mind.state();
  const later = tuningFromAffect(laterAffect);

  assert.ok(laterAffect.drives.caution > calmAffect.drives.caution, "caution 基线应被残留抬高");
  assert.ok(later.restitution < calm.restitution, "60 秒后落地仍该更实、弹不起来");
  assert.ok(later.damping > calm.damping, "60 秒后动作仍该更黏");
  assert.ok(rightAfter.restitution < later.restitution, "刚被凶完最明显");
});

test("不应期：两条 directive 之间必有最小间隔", () => {
  const mind = createMind(affectWith({}), 3);
  const stamps: number[] = [];
  for (let t = 0; t <= 300_000; t += 1000) {
    if (t % 20_000 === 0) mind.perceive(ev("app.focus.new", t));
    if (t % 35_000 === 0) mind.perceive(ev("user.tap", t));
    for (const d of mind.tick(t)) stamps.push(d.issuedAtMs);
  }
  assert.ok(stamps.length >= 2, "5 分钟里该有几次自发行为");
  for (let n = 1; n < stamps.length; n++) {
    assert.ok(stamps[n] - stamps[n - 1] >= REFRACTORY_MS, `间隔 ${stamps[n] - stamps[n - 1]}ms 过短`);
  }
});

test("tuning 永远落在契约闭区间内，不产生 NaN", () => {
  const mind = createMind(affectWith({}), 5);
  const kinds: Percept["kind"][] = ["user.scold", "user.praise", "alert.error", "app.focus.new", "user.tap"];
  let t = 0;
  for (let n = 0; n < 400; n++) {
    t += 1000;
    if (n % 3 === 0) mind.perceive(ev(kinds[n % kinds.length], t));
    for (const d of mind.tick(t)) {
      for (const [k, val] of Object.entries({ ...BASE_TUNING, ...d.tuning })) {
        assert.ok(Number.isFinite(val), `${k} 非有限`);
      }
      assert.ok(d.intensity >= 0 && d.intensity <= 1);
    }
  }
});
